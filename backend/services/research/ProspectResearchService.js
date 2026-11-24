/**
 * services/research/ProspectResearchService.js
 *
 * Two-step AI research for one prospect: company first (cached on the account
 * for 30 days), then the person. Moved out of POST /api/prospects/:id/research
 * (step 1.1b) so the manual "Research" button and the background sweeper run
 * exactly the same code.
 *
 * Behaviour changes vs the old route — each one fixes a real problem:
 *
 *   1. Company research no longer REPLACES accounts.research_meta. That column
 *      also holds enrichment-provider data ({ <provider>: { status, normalized }})
 *      which the outreach skill and FitGate read for industry, size, tech stack
 *      and funding. Research now merges under research_meta.ai_research.
 *
 *   2. Person research no longer REPLACES prospects.research_meta, which held
 *      the reviewer's hook note and approval stamp. It merges instead: the
 *      structured result lives under research_meta.ai_research, and the old
 *      top-level keys (model, provider, generated_at, …) are still written
 *      because the prospect panel shows them.
 *
 *   3. Both AI calls now resolve under the 'prospecting_research' task type,
 *      so the per-task model an admin sets for "Prospect research" is the model
 *      that actually runs (the old 'research_account' / 'research_person'
 *      types matched no setting and silently used the org default). Usage is
 *      logged as prospecting_research_account / prospecting_research so it
 *      lands under Research on the usage screen.
 *
 *   4. Research never moves the stage. Every result goes to "ready for review"
 *      and a person approves it (target → research) or rejects it. The old
 *      route advanced target → research on its own.
 *
 *   5. When the Chrome extension has captured the person's LinkedIn profile,
 *      the headline, about, recent roles and their OWN recent posts go into
 *      the person prompt. This is the no-enrichment-provider path: what the
 *      extension captured plus AI research, inside each person's budget.
 *      Comments and reactions are not included (splitLinkedInActivity drops
 *      them) and the prompt is told to describe post themes, not quote them.
 *
 *   6. A non-empty tags array no longer crashes research (the old code ran
 *      JSON.parse on an already-parsed jsonb array).
 *
 *   8. (Fix after 1.4 testing) Cut-off replies. The old limits (1,000 tokens
 *      for the company step, 900 for the person step) came from the original
 *      route; Haiku 5.5 writes past them, so the JSON was cut mid-sentence,
 *      couldn't be parsed, and the raw text was saved as "research" — and the
 *      cut-off company reply was cached on the account for 30 days. Now:
 *        - both steps get STAGE_MAX_TOKENS, and a reply that hits the limit
 *          is retried once with double (capped at RETRY_MAX_TOKENS);
 *        - a JSON reply is never saved raw: complete pieces (finished bullets,
 *          pitch angle…) are salvaged, otherwise the run fails with
 *          RESEARCH_UNREADABLE so the sweeper retries and the button shows an
 *          error instead of a broken "ready for review";
 *        - company research is cached only when it was read cleanly, and a
 *          cached reply that is broken JSON is ignored (regenerated).
 *      Plain-text replies (a custom prompt that doesn't ask for JSON) are
 *      still saved as before, unless they were cut off.
 *
 *   7. (Step 1.2) When the extension captured comments or reactions in the
 *      last 90 days, one small extra call distils them into at most 5 short
 *      topics ("sales hiring"). They're saved with the research (so the
 *      reviewer signs off on them and the writer gets exactly what was
 *      approved) and cached on the LinkedIn profile, keyed by a hash of the
 *      activity, so unchanged activity is never re-sent to the model. The
 *      writer receives topics only — never the comment/reaction text — and
 *      OutreachValidator blocks any draft repeating 5+ words of it. A failed
 *      themes call never fails the research.
 *
 * Errors: throws with statusCode 404 when the prospect isn't found, and lets
 * resolver gate errors (402 / 403 / 429, see utils/aiGateErrors.js) through
 * untouched so callers can tell "paused" from "broken".
 */

const crypto = require('crypto');
const db = require('../../config/database');
const AI_PROMPTS = require('../../config/aiPrompts');
const AIClientResolver = require('../ai/AIClientResolver');
const TokenTrackingService = require('../TokenTrackingService');
const {
  splitLinkedInActivity, pickCurrentRole, engagementActivityItems,
} = require('../SkillContextService');

const ROUTING_CALL_TYPE = 'prospecting_research';          // what the admin configures
const LOG_CALL_TYPE_ACCOUNT = 'prospecting_research_account';
const LOG_CALL_TYPE_PERSON  = 'prospecting_research';
const LOG_CALL_TYPE_THEMES  = 'prospecting_research_themes';
const ACCOUNT_CACHE_DAYS = 30;
// Output limits per step. 2,000 leaves room for the system prompts' five
// detailed bullets + pitch + subject on verbose models; a reply that still
// hits the limit gets one retry at double (never above RETRY_MAX_TOKENS).
const STAGE_MAX_TOKENS = 2000;
const RETRY_MAX_TOKENS = 4000;

// Size limits keep one verbose profile from blowing up the prompt (and the
// person's budget). Roughly: about ≤ 1,200 chars, 3 roles, 3 posts × 400.
const MAX_ABOUT_CHARS = 1200;
const MAX_ROLES       = 3;
const MAX_POSTS       = 3;
const MAX_POST_CHARS  = 400;
// Themes input: at most 15 recent comments/reactions, 300 chars each.
const MAX_THEME_ITEMS      = 15;
const MAX_THEME_ITEM_CHARS = 300;
const MAX_TOPICS           = 5;
const MAX_TOPIC_WORDS      = 4;

const THEMES_PROMPT = `You are labelling what a B2B buyer pays attention to on LinkedIn. Below are posts they commented on or reacted to, and their comments.

Return up to ${MAX_TOPICS} short TOPICS they seem to care about professionally.
Rules:
- Each topic is 1 to ${MAX_TOPIC_WORDS} words: a generic noun phrase such as "sales hiring", "forecast accuracy", "AI in customer support".
- No names of people or companies. No quotes, no copied phrases, no opinions.
- Skip social items (congratulations, birthdays, job-change cheers, condolences) — they are not topics.
- If nothing professional stands out, return an empty list.

Return ONLY valid JSON, no markdown fences: {"topics": ["...", "..."]}

ACTIVITY:
{{activity}}`;

const STAGE2_SYSTEM_DEFAULT = `You are an expert B2B sales researcher. Based on the prospect and account info below, generate research bullets and a crisp pitch.

PERSON:
{{prospectInfo}}

ACCOUNT RESEARCH:
{{accountResearch}}

WHAT WE SELL:
{{productContext}}

Return ONLY valid JSON:
{
  "researchBullets": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "pitchAngle": "Single strongest angle for this person",
  "crispPitch": "3-5 sentence pitch written directly to them",
  "subjectLine": "Email subject line",
  "confidence": 0.8
}`;

function notFound() {
  const e = new Error('Prospect not found');
  e.statusCode = 404;
  e.code = 'NOT_FOUND';
  return e;
}

/** Replace every {{key}} (templates may repeat a placeholder). */
function fill(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

function parseJsonBlock(raw) {
  const cleaned = String(raw || '').replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object');
  return JSON.parse(cleaned.substring(start, end + 1));
}

/** Does this reply look like the JSON the system prompts ask for? */
function looksLikeJson(raw) {
  const t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '');
  return t.startsWith('{');
}

/** JSON that parses as a whole, or null. */
function tryParseJson(raw) {
  try { return parseJsonBlock(raw); } catch { return null; }
}

function decodeJsonString(body) {
  try { return JSON.parse(`"${body}"`); } catch { return null; }
}

/**
 * Pull the complete pieces out of a person-research reply that was cut off
 * mid-JSON: every bullet whose closing quote arrived, and pitchAngle /
 * crispPitch / subjectLine / confidence if they're whole. A half-written
 * string is never used. Returns null when nothing usable survived.
 */
function salvagePersonJson(raw) {
  const text = String(raw || '');
  const STR = '"((?:[^"\\\\]|\\\\.)*)"';   // a CLOSED JSON string
  const out = { researchBullets: [], pitchAngle: null, crispPitch: null, subjectLine: null, confidence: null };

  const arr = text.match(/"researchBullets"\s*:\s*\[/);
  if (arr) {
    // Walk the array one element at a time: skip separators, take a CLOSED
    // string, stop at "]" or wherever the reply was cut. (Searching for "]"
    // instead would stop early on a bullet whose text contains "], ".)
    const item = new RegExp(`\\s*,?\\s*${STR}`, 'y');
    item.lastIndex = arr.index + arr[0].length;
    let m;
    while ((m = item.exec(text)) !== null) {
      const v = decodeJsonString(m[1]);
      if (v && v.trim()) out.researchBullets.push(v.trim());
    }
  }
  for (const key of ['pitchAngle', 'crispPitch', 'subjectLine']) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*${STR}`));
    if (m) out[key] = decodeJsonString(m[1]);
  }
  const c = text.match(/"confidence"\s*:\s*([0-9]*\.?[0-9]+)/);
  if (c) out.confidence = Number(c[1]);

  if (!out.researchBullets.length && !out.pitchAngle) return null;
  return out;
}

function tagsList(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    try { const t = JSON.parse(tags); return Array.isArray(t) ? t : []; } catch { return []; }
  }
  return [];
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The LinkedIn block for the person prompt, from the extension's capture.
 * Returns { text, used: { headline, about, roles, posts } } — `used` goes
 * into research_meta so a reviewer can see what the research was based on.
 */
function buildLinkedInBlock(lp) {
  const used = { headline: false, about: false, roles: 0, posts: 0 };
  if (!lp) return { text: '', used };

  const lines = [];
  if (lp.headline) { lines.push(`Headline: ${clip(lp.headline, 300)}`); used.headline = true; }
  if (lp.about)    { lines.push(`About: ${clip(lp.about, MAX_ABOUT_CHARS)}`); used.about = true; }

  const exp = Array.isArray(lp.experience) ? lp.experience : [];
  if (exp.length) {
    const current = pickCurrentRole(exp);
    const ordered = current ? [current, ...exp.filter(e => e !== current)] : exp;
    const roles = ordered.slice(0, MAX_ROLES).map((e, i) => {
      const span = [e.start_date, e.end_date || (i === 0 && e === current ? 'present' : null)]
        .filter(Boolean).join(' – ');
      return `  - ${[e.title, e.company].filter(Boolean).join(' at ')}${span ? ` (${span})` : ''}`;
    }).filter(r => r.trim() !== '-');
    if (roles.length) {
      lines.push(`Recent roles:\n${roles.join('\n')}`);
      used.roles = roles.length;
    }
  }

  // Own posts only (splitLinkedInActivity drops comments, reactions, plain
  // reposts and stale posts). For quoted reposts we use THEIR commentary —
  // the embedded original isn't their words.
  const { posts } = splitLinkedInActivity(lp.activity);
  const picked = posts.slice(0, MAX_POSTS).map(p => {
    const words = p.action === 'quoted_repost' ? (p.commentary || '') : (p.text || '');
    const when  = p.posted_at ? String(p.posted_at).slice(0, 10) : 'recent';
    return words.trim() ? `  - (${when}) ${clip(words, MAX_POST_CHARS)}` : null;
  }).filter(Boolean);
  if (picked.length) {
    lines.push(
      `Their own recent LinkedIn posts (use for themes and priorities; ` +
      `describe them in your own words, never quote them):\n${picked.join('\n')}`
    );
    used.posts = picked.length;
  }

  if (!lines.length) return { text: '', used };
  return { text: `\nLINKEDIN (captured by the GoWarm extension):\n${lines.join('\n')}`, used };
}

/** Keep only short, clean topic labels; drop anything that isn't one. */
function sanitizeTopics(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.replace(/["“”'‘’`]/g, '').replace(/\s+/g, ' ').replace(/^[\s\-–—•.,;:]+|[\s\-–—•.,;:]+$/g, '').trim();
    if (!t || t.length > 40) continue;
    if (t.split(' ').length > MAX_TOPIC_WORDS) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

/**
 * Topics from the prospect's recent comments and reactions (step 1.2).
 * Returns { topics, item_count, generated_at, model, reused } or null when
 * there's no recent comment/reaction activity or the call fails.
 */
async function buildThemes({ orgId, linkedinUrl, lp, callAI, currentModel }) {
  const items = engagementActivityItems(lp?.activity).slice(0, MAX_THEME_ITEMS);
  if (!items.length) return null;

  const sourceHash = crypto.createHash('sha1')
    .update(items.map(i => `${i.id}|${i.text}`).sort().join('\n'))
    .digest('hex');
  const cached = lp?.enrichment_meta?.engagement_themes;
  if (cached && cached.source_hash === sourceHash && Array.isArray(cached.topics)) {
    return {
      topics: cached.topics, item_count: cached.item_count ?? items.length,
      generated_at: cached.generated_at || null, model: cached.model || null, reused: true,
    };
  }

  try {
    const activity = items
      .map(i => `- (${i.kind}) ${clip(i.text, MAX_THEME_ITEM_CHARS)}`)
      .join('\n');
    const raw = await callAI(fill(THEMES_PROMPT, { activity }), 200, LOG_CALL_TYPE_THEMES);
    let topics = [];
    try { topics = sanitizeTopics(parseJsonBlock(raw).topics); } catch { topics = []; }

    const themes = {
      topics,
      item_count:   items.length,
      generated_at: new Date().toISOString(),
      model:        currentModel(),
    };
    // Cache on the profile so other prospects/re-runs with the same activity
    // reuse it. Merge — enrichment_meta holds other capture metadata.
    try {
      await db.query(
        `UPDATE linkedin_profiles
            SET enrichment_meta = COALESCE(enrichment_meta, '{}'::jsonb)
                                  || jsonb_build_object('engagement_themes', $3::jsonb)
          WHERE org_id = $1 AND deleted_at IS NULL
            AND linkedin_slug = LOWER(SUBSTRING($2::text FROM '/in/([^/?#]+)'))`,
        [orgId, linkedinUrl, JSON.stringify({ ...themes, source_hash: sourceHash })]
      );
    } catch (err) {
      console.warn('engagement themes cache save failed:', err.message);
    }
    return { ...themes, reused: false };
  } catch (err) {
    // Includes budget/kill-switch refusals: the person research that follows
    // will hit the same gate and pause the whole run properly.
    console.warn(`engagement themes skipped (org ${orgId}):`, err.message);
    return null;
  }
}

/**
 * Research one prospect.
 *
 * @param {object}  args
 * @param {number}  args.orgId
 * @param {number}  args.prospectId
 * @param {number}  args.actorUserId  whose model settings, keys and daily
 *                                    budget pay for this (manual: the clicker;
 *                                    background: the prospect owner)
 * @param {'manual'|'pipeline'} [args.trigger]
 */
async function researchProspect({ orgId, prospectId, actorUserId, trigger = 'manual' }) {
  const prospectResult = await db.query(
    `SELECT p.*, acc.name AS account_name, acc.industry AS account_industry
       FROM prospects p
       LEFT JOIN accounts acc ON p.account_id = acc.id
      WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
    [prospectId, orgId]
  );
  if (prospectResult.rows.length === 0) throw notFound();
  const p = prospectResult.rows[0];

  const tags = tagsList(p.tags);
  const prospectInfoBase = [
    `Name: ${p.first_name} ${p.last_name}`,
    p.title            ? `Title: ${p.title}`                          : null,
    p.email            ? `Email: ${p.email}`                          : null,
    p.linkedin_url     ? `LinkedIn: ${p.linkedin_url}`                : null,
    p.company_name     ? `Company: ${p.company_name}`                 : null,
    p.company_domain   ? `Company domain: ${p.company_domain}`        : null,
    p.company_industry ? `Industry: ${p.company_industry}`            : null,
    p.company_size     ? `Company size: ${p.company_size}`            : null,
    p.location         ? `Location: ${p.location}`                    : null,
    p.account_name     ? `Account: ${p.account_name}`                 : null,
    p.account_industry ? `Account industry: ${p.account_industry}`    : null,
    tags.length        ? `Tags: ${tags.join(', ')}`                   : null,
  ].filter(Boolean).join('\n');

  const companyInfo = [
    p.company_name     ? `Company: ${p.company_name}`                 : null,
    p.company_domain   ? `Domain: ${p.company_domain}`                : null,
    p.company_industry ? `Industry: ${p.company_industry}`            : null,
    p.company_size     ? `Size: ${p.company_size}`                    : null,
    p.location         ? `HQ location: ${p.location}`                 : null,
    p.account_name     ? `Account name: ${p.account_name}`            : null,
  ].filter(Boolean).join('\n');

  const [userPrefRes, orgIntRes, userStage1Res, orgStage1Res, userStage2Res, orgStage2Res, liRes] = await Promise.all([
    db.query(`SELECT preferences FROM user_preferences WHERE user_id = $1 AND org_id = $2`, [actorUserId, orgId]),
    db.query(`SELECT config FROM org_integrations WHERE org_id = $1 AND integration_type = 'prospecting'`, [orgId]),
    db.query(
      `SELECT template_data FROM user_prompts
        WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_research_account'`,
      [actorUserId, orgId]),
    db.query(
      `SELECT id, template FROM prompts
        WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_research_account'`,
      [orgId]),
    db.query(
      `SELECT template_data FROM user_prompts
        WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_research'`,
      [actorUserId, orgId]),
    db.query(
      `SELECT id, template FROM prompts
        WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_research'`,
      [orgId]),
    // Same slug join the research queue and skill context use.
    p.linkedin_url
      ? db.query(
          `SELECT headline, about, experience, activity, enrichment_meta
             FROM linkedin_profiles
            WHERE org_id = $1 AND deleted_at IS NULL
              AND linkedin_slug = LOWER(SUBSTRING($2::text FROM '/in/([^/?#]+)'))
            LIMIT 1`,
          [orgId, p.linkedin_url])
      : Promise.resolve({ rows: [] }),
  ]);

  const userPrefs  = userPrefRes.rows[0]?.preferences || {};
  const orgConfig  = orgIntRes.rows[0]?.config || {};
  const prospPrefs = userPrefs.prospecting || {};
  const productCtx = prospPrefs.product_context !== undefined
    ? prospPrefs.product_context
    : (orgConfig.product_context || '');

  const linkedIn = buildLinkedInBlock(liRes.rows[0] || null);
  const prospectInfo = prospectInfoBase + linkedIn.text;

  // Track what actually ran (the last resolve wins; both use the same routing).
  let ranProvider = null;
  let ranModel    = null;

  // One model call → { text, truncated }. `truncated` = the reply used the
  // whole output budget, i.e. it was cut off (adapters don't all expose a
  // stop reason, but all report output tokens).
  async function callModel(prompt, maxTokens, logCallType) {
    const { adapter, model, provider, keySource } =
      await AIClientResolver.resolve(orgId, actorUserId, ROUTING_CALL_TYPE);
    ranProvider = provider;
    ranModel    = model;

    const { text, usage } = await adapter.complete({ model, prompt, maxTokens });

    // Awaited (log() never throws) so the spend guard's running total is
    // current before the next call in this same research run.
    await TokenTrackingService.log({
      orgId, userId: actorUserId, callType: logCallType, provider, keySource, model, usage,
    });
    const out = Number(usage?.output_tokens) || 0;
    return { text: text || '', truncated: out >= maxTokens };
  }

  // A cut-off reply is retried once with double the budget. Both calls are
  // logged and count toward the budget — the first one was really spent.
  async function callModelWithRetry(prompt, maxTokens, logCallType) {
    const first = await callModel(prompt, maxTokens, logCallType);
    if (!first.truncated || maxTokens >= RETRY_MAX_TOKENS) return first;
    return callModel(prompt, Math.min(maxTokens * 2, RETRY_MAX_TOKENS), logCallType);
  }

  // Themes only needs the text (its limit of 200 is far above a 5-topic list).
  async function callAI(prompt, maxTokens, logCallType) {
    return (await callModel(prompt, maxTokens, logCallType)).text;
  }

  // ── Stage 1: company (cached on the account) ───────────────────────────
  let accountResearchText = '';
  let accountResearchJson = null;
  let accountCached = false;

  if (p.account_id) {
    const accountRes = await db.query(
      `SELECT research_notes, research_updated_at FROM accounts WHERE id = $1 AND org_id = $2`,
      [p.account_id, orgId]
    );
    const acct = accountRes.rows[0];
    const isStale = !acct?.research_updated_at ||
      (Date.now() - new Date(acct.research_updated_at).getTime()) > ACCOUNT_CACHE_DAYS * 86400000;

    // A cached reply that is broken JSON (saved before the cut-off fix) is
    // worthless as context — regenerate it instead of reusing it for 30 days.
    const cachedBroken = typeof acct?.research_notes === 'string'
      && looksLikeJson(acct.research_notes) && !tryParseJson(acct.research_notes);

    if (acct?.research_notes && !isStale && !cachedBroken) {
      accountResearchText = typeof acct.research_notes === 'string'
        ? acct.research_notes
        : JSON.stringify(acct.research_notes, null, 2);
      accountCached = true;
    } else {
      const stage1Template = userStage1Res.rows[0]?.template_data
        || orgStage1Res.rows[0]?.template
        || AI_PROMPTS.prospecting_research_account
        || '';

      if (stage1Template) {
        const stage1 = await callModelWithRetry(
          fill(stage1Template, { companyInfo, productContext: productCtx || 'Not specified' }),
          STAGE_MAX_TOKENS, LOG_CALL_TYPE_ACCOUNT
        );
        // Cache only research that was read cleanly. A cut-off JSON reply is
        // still passed to the person step as context (partial facts help),
        // but never cached for other prospects at this company.
        let cacheable;
        accountResearchJson = tryParseJson(stage1.text);
        if (accountResearchJson) {
          accountResearchText = JSON.stringify(accountResearchJson, null, 2);
          cacheable = true;
        } else {
          accountResearchText = stage1.text;
          cacheable = !looksLikeJson(stage1.text) && !stage1.truncated && !!stage1.text.trim();
          console.warn(`[research] company research for account ${p.account_id} not cached ` +
            `(${stage1.truncated ? 'cut off' : 'unreadable'})`);
        }

        const accountMeta = {
          provider:             ranProvider,
          model:                ranModel,
          stage1_prompt_id:     orgStage1Res.rows[0]?.id || null,
          stage1_prompt_key:    'prospecting_research_account',
          stage1_prompt_source: userStage1Res.rows[0] ? 'user_override'
                              : orgStage1Res.rows[0] ? 'org_default' : 'system_default',
          generated_by_user_id: actorUserId,
          generated_at:         new Date().toISOString(),
        };

        // MERGE under ai_research — never replace research_meta (fix 1).
        if (cacheable) try {
          await db.query(
            `UPDATE accounts
                SET research_notes      = $1,
                    research_updated_at = CURRENT_TIMESTAMP,
                    research_meta       = COALESCE(research_meta, '{}'::jsonb)
                                          || jsonb_build_object('ai_research', $2::jsonb),
                    updated_at          = CURRENT_TIMESTAMP
              WHERE id = $3 AND org_id = $4`,
            [accountResearchText, JSON.stringify(accountMeta), p.account_id, orgId]
          );
        } catch (err) {
          console.warn('Account research cache save failed:', err.message);
        }
      }
    }
  }

  // ── Comment/reaction themes (step 1.2) ─────────────────────────────────
  // Before stage 2 so ranModel/ranProvider end up describing the person call.
  const engagementThemes = await buildThemes({
    orgId,
    linkedinUrl: p.linkedin_url,
    lp: liRes.rows[0] || null,
    callAI,
    currentModel: () => ranModel,
  });

  // ── Stage 2: the person ────────────────────────────────────────────────
  const stage2Template = userStage2Res.rows[0]?.template_data
    || orgStage2Res.rows[0]?.template
    || AI_PROMPTS.prospecting_research
    || STAGE2_SYSTEM_DEFAULT;

  const stage2 = await callModelWithRetry(
    fill(stage2Template, {
      prospectInfo,
      accountResearch: accountResearchText || 'No account research available.',
      productContext:  productCtx || 'Not specified',
    }),
    STAGE_MAX_TOKENS, LOG_CALL_TYPE_PERSON
  );
  const stage2Raw = stage2.text;

  let parsed = tryParseJson(stage2Raw);
  let partial = false;
  let researchNotes = '';
  if (!parsed && looksLikeJson(stage2Raw)) {
    // JSON that didn't parse (cut off even after the retry, or malformed).
    // Keep only complete pieces; never save the raw JSON as "research".
    parsed = salvagePersonJson(stage2Raw);
    partial = true;
    if (!parsed) {
      const e = new Error(stage2.truncated
        ? 'Research reply was cut off before it could be read — try again'
        : 'Research reply could not be read — try again');
      e.code = 'RESEARCH_UNREADABLE';
      throw e;
    }
  }
  if (parsed) {
    const bullets = Array.isArray(parsed.researchBullets) ? parsed.researchBullets : [];
    researchNotes = bullets.map(b => `• ${b}`).join('\n');
    if (parsed.pitchAngle)  researchNotes += `\n\n💡 Pitch angle: ${parsed.pitchAngle}`;
    if (parsed.crispPitch)  researchNotes += `\n\n✉️ Crisp pitch:\n${parsed.crispPitch}`;
    if (parsed.subjectLine) researchNotes += `\n\n📧 Subject: ${parsed.subjectLine}`;
    researchNotes = researchNotes.trim();
  } else {
    // Plain text from a custom prompt that doesn't ask for JSON — kept as
    // before, unless it was cut off.
    if (stage2.truncated) {
      const e = new Error('Research reply was cut off before it finished — try again');
      e.code = 'RESEARCH_UNREADABLE';
      throw e;
    }
    researchNotes = String(stage2Raw || '').trim();
  }
  if (!researchNotes) {
    const e = new Error('Research came back empty');
    e.code = 'RESEARCH_EMPTY';
    throw e;
  }

  const generatedAt = new Date().toISOString();
  const stage2Source = userStage2Res.rows[0] ? 'user_override'
                     : orgStage2Res.rows[0] ? 'org_default' : 'system_default';
  const stage1Source = userStage1Res.rows[0] ? 'user_override'
                     : orgStage1Res.rows[0] ? 'org_default' : 'system_default';

  const metaPatch = {
    // Top-level keys the prospect panel already reads.
    provider:                ranProvider,
    model:                   ranModel,
    stage2_prompt_id:        orgStage2Res.rows[0]?.id || null,
    stage2_prompt_key:       'prospecting_research',
    stage2_prompt_source:    stage2Source,
    account_research_used:   !!accountResearchText,
    account_research_cached: accountCached,
    generated_by_user_id:    actorUserId,
    generated_at:            generatedAt,
    confidence:              parsed?.confidence ?? null,
    // The structured result, kept even after a reviewer replaces
    // research_notes with their own hook note.
    ai_research: {
      bullets:      Array.isArray(parsed?.researchBullets) ? parsed.researchBullets : null,
      pitch_angle:  parsed?.pitchAngle  || null,
      crisp_pitch:  parsed?.crispPitch  || null,
      subject_line: parsed?.subjectLine || null,
      confidence:   parsed?.confidence ?? null,
      notes_text:   researchNotes,
      provider:     ranProvider,
      model:        ranModel,
      trigger,
      generated_by_user_id: actorUserId,
      generated_at: generatedAt,
      account_research_used: !!accountResearchText,
      linkedin_used: linkedIn.used,
      // true when the reply was cut off and only its complete pieces were kept.
      partial,
      // Topics only; the reviewer sees these and the writer gets them once
      // approved. null when there was no recent comment/reaction activity.
      engagement_themes: engagementThemes,
    },
  };

  // Research never moves the stage (fix 4). Pre-outreach prospects go to
  // ready_for_review and any earlier review is cleared — it reviewed older
  // research. A prospect already past research just gets fresh notes; if a
  // sweeper had claimed it (researching) we clear that, since nobody will
  // review research for someone already in outreach.
  const flagSource = trigger === 'pipeline' ? null : 'manual';
  const upd = await db.query(
    `UPDATE prospects
        SET research_notes = $1,
            research_meta  = COALESCE(research_meta, '{}'::jsonb) || $2::jsonb,
            research_status = CASE
              WHEN stage IN ('target','research') THEN 'ready_for_review'
              WHEN research_status = 'researching' THEN NULL
              ELSE research_status END,
            research_review_outcome = CASE WHEN stage IN ('target','research') THEN NULL ELSE research_review_outcome END,
            research_review_reason  = CASE WHEN stage IN ('target','research') THEN NULL ELSE research_review_reason  END,
            research_reviewed_by    = CASE WHEN stage IN ('target','research') THEN NULL ELSE research_reviewed_by    END,
            research_reviewed_at    = CASE WHEN stage IN ('target','research') THEN NULL ELSE research_reviewed_at    END,
            research_flag_source    = COALESCE(research_flag_source, $5::varchar),
            research_flagged_by     = COALESCE(research_flagged_by, $6::int),
            research_flagged_at     = COALESCE(research_flagged_at, CURRENT_TIMESTAMP),
            research_completed_at   = CURRENT_TIMESTAMP,
            research_next_attempt_at = NULL,
            research_last_error     = NULL,
            updated_at              = CURRENT_TIMESTAMP
      WHERE id = $3 AND org_id = $4
      RETURNING stage, research_status`,
    [researchNotes, JSON.stringify(metaPatch), prospectId, orgId, flagSource, actorUserId]
  );
  if (upd.rows.length === 0) throw notFound();   // deleted mid-run
  const after = upd.rows[0];

  try {
    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, 'research_completed', $4, $5)`,
      [
        orgId, prospectId, actorUserId,
        trigger === 'pipeline'
          ? 'AI research generated in the background — waiting for review'
          : 'AI research notes generated — waiting for review',
        JSON.stringify({
          trigger, model: ranModel, provider: ranProvider,
          research_status: after.research_status, linkedin_used: linkedIn.used,
        }),
      ]
    );
  } catch (err) {
    console.warn('research activity log failed:', err.message);
  }

  return {
    researchNotes,
    stageAdvanced:         false,
    newStage:              after.stage,
    researchStatus:        after.research_status,
    researchBullets:       parsed?.researchBullets || null,
    pitchAngle:            parsed?.pitchAngle      || null,
    crispPitch:            parsed?.crispPitch      || null,
    suggestedSubject:      parsed?.subjectLine     || null,
    confidence:            parsed?.confidence      ?? null,
    accountResearchCached: accountCached,
    accountResearch:       accountResearchJson,
    linkedinUsed:          linkedIn.used,
    engagementThemes:      engagementThemes ? engagementThemes.topics : null,
    meta: {
      provider: ranProvider,
      model:    ranModel,
      promptSources: { account: stage1Source, person: stage2Source },
    },
  };
}

module.exports = {
  researchProspect, buildLinkedInBlock, sanitizeTopics, salvagePersonJson, looksLikeJson,
  _fill: fill,
};
