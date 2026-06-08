// ============================================================================
// services/SkillContextService.js
//
// Builds the canonical prospect payload for the Skills Runner PoC.
// One file, one responsibility: turn (prospectId, orgId, asUserId?) into the
// shape defined by skills/outreach-personalization/schema/gowarm-prospect.json.
//
// Called from routes/skill-context.routes.js.
//
// ─── Canonical sources (no fallbacks, no dual-writes) ────────────────────────
//
//   prospect.name       ← prospects.first_name + last_name
//   prospect.title      ← linkedin_profiles current role; prospects.title only
//                          if no profile capture exists yet
//   prospect.company    ← linkedin_profiles current role; accounts.name only
//                          if no profile capture exists yet
//   prospect.headline   ← linkedin_profiles.headline
//   prospect.about      ← linkedin_profiles.about
//   prospect.experience ← linkedin_profiles.experience
//   prospect.education  ← linkedin_profiles.education
//   prospect.email      ← prospects.email (set on import / extension)
//   prospect.linkedin_url ← prospects.linkedin_url
//   prospect.tenure_in_role_months ← computed from experience[current].start_date
//
//   account.industry/size/website/one_line_description
//                       ← accounts row (filled by enrichmentService apply rules)
//   account.tech_stack  ← accounts.research_meta.<provider>.normalized.tech_stack
//   account.growth_stage ← derived from research_meta.<provider>.normalized
//                           (last_round.type and founded_year)
//
//   signals.account_events
//                       ← synthesized from
//                          accounts.research_meta.<provider>.normalized.last_round
//   signals.linkedin_activity
//                       ← linkedin_profiles.activity, split by kind
// ============================================================================

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// safeQuery — only for queries against tables that may legitimately be absent
// for a given prospect (specifically: linkedin_profiles, sequence_enrollments,
// prospecting_activities). For required tables (prospects, accounts, users,
// organizations) errors propagate.
// ─────────────────────────────────────────────────────────────────────────────
async function safeQuery(client, sql, params) {
  try {
    const r = await client.query(sql, params);
    return r.rows;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[skill-context] Optional query skipped:', err.message);
      return [];
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Title-based seniority and function inference.
// Naïve but stable — runs against the captured LinkedIn current-role title.
// ─────────────────────────────────────────────────────────────────────────────
function inferSeniority(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(founder|co-founder|ceo|coo|cfo|cto|cmo|cro|cpo|cio|chief)\b/.test(t)) return 'c_level';
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return 'vp';
  if (/\b(director|head of)\b/.test(t)) return 'director';
  if (/\b(manager|lead)\b/.test(t)) return 'manager';
  return 'ic';
}

function inferFunction(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(sales|account exec|ae|sdr|bdr|revenue)\b/.test(t)) return 'sales';
  if (/\b(revops|rev ops|sales ops|sales operations)\b/.test(t)) return 'revops';
  if (/\b(marketing|growth|demand gen|brand)\b/.test(t)) return 'marketing';
  if (/\b(engineer|developer|architect|cto|technical)\b/.test(t)) return 'engineering';
  if (/\b(product|pm|product manager)\b/.test(t)) return 'product';
  if (/\b(finance|cfo|controller)\b/.test(t)) return 'finance';
  if (/\b(people|hr|talent|recruiting)\b/.test(t)) return 'people';
  if (/\b(operations|coo|ops)\b/.test(t)) return 'operations';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pick the prospect's current role from the captured experience array.
//
// "Current" = end_date is null/empty/"present" (case-insensitive). LinkedIn
// lists current roles at the top, so the first match is reliable. Falls back
// to experience[0] if nothing matches; returns null on an empty array.
// ─────────────────────────────────────────────────────────────────────────────
function pickCurrentRole(experience) {
  if (!Array.isArray(experience) || experience.length === 0) return null;
  const isCurrent = (e) => {
    const ed = e?.end_date;
    if (ed == null) return true;
    const s = String(ed).trim().toLowerCase();
    return s === '' || s === 'present';
  };
  return experience.find(isCurrent) || experience[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute tenure-in-role months from the current role's start_date.
//
// LinkedIn-captured start_date can be 'YYYY-MM-DD', 'YYYY-MM', or 'YYYY';
// the JS Date constructor handles the first two; 'YYYY' alone parses to Jan 1.
// Returns null if we can't get a positive integer answer.
// ─────────────────────────────────────────────────────────────────────────────
function computeTenureMonths(currentRole) {
  if (!currentRole?.start_date) return null;
  const start = new Date(currentRole.start_date);
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  const months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12
               + (now.getUTCMonth() - start.getUTCMonth());
  return months >= 0 ? months : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility for a post to be used as a personalization hook.
//
// Outreach must anchor on what the PROSPECT THEMSELVES recently said — not on
// things they commented on or merely reacted to, and not on stale activity.
// Two rules, both enforced here at the source so the skill physically cannot
// reach for ineligible activity regardless of prompt wording:
//
//   1. Authorship — only the prospect's own posts. action='posted' (original)
//      and action='quoted_repost' (their own commentary on someone else's post)
//      both contain the prospect's words and qualify. action='reposted' (a
//      plain share with no commentary) is someone else's content and is
//      EXCLUDED. action=null is a legacy capture (pre extension v2) where
//      authorship cannot be confirmed, so it is also EXCLUDED — we require an
//      explicit own-post action rather than assuming originality.
//
//   2. Recency — posted within the last POST_RECENCY_DAYS. A post whose
//      occurred_at is missing or unparseable cannot be proven recent, so it is
//      EXCLUDED (strict: when in doubt, leave it out).
// ─────────────────────────────────────────────────────────────────────────────
const POST_RECENCY_DAYS  = 14;
const OWN_POST_ACTIONS   = new Set(['posted', 'quoted_repost']);

function isOwnAuthoredPost(action) {
  return OWN_POST_ACTIONS.has(action);
}

function isRecentPost(occurredAt) {
  if (!occurredAt) return false;
  const t = new Date(occurredAt).getTime();
  if (!Number.isFinite(t)) return false;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return true;   // future-dated (clock skew) — treat as recent
  return ageMs <= POST_RECENCY_DAYS * 24 * 60 * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the prospect's LinkedIn activity for hook selection.
//
// Each raw item is {id, kind, occurred_at, text, ...}. We surface ONLY the
// prospect's own recent posts. comments and reactions are deliberately dropped
// (returned empty) — they are never valid hook material. The keys are kept for
// schema stability (gowarm-prospect.json still lists comments/reactions).
// ─────────────────────────────────────────────────────────────────────────────
function splitLinkedInActivity(activity) {
  const out = { posts: [], comments: [], reactions: [] };
  if (!Array.isArray(activity)) return out;

  for (const item of activity) {
    if (!item || item.kind !== 'post') continue;       // drop comments + reactions
    if (!isOwnAuthoredPost(item.action)) continue;     // drop plain reposts
    if (!isRecentPost(item.occurred_at)) continue;     // drop posts older than 14 days

    out.posts.push({
      id: item.id,
      posted_at: item.occurred_at,
      text: item.text,
      engagement_count: item.engagement_count ?? null,
      topic_tags: item.topic_tags || [],
      // action is one of 'posted' | 'quoted_repost' after filtering.
      action: item.action ?? null,
      // For quoted reposts: the prospect's own commentary above the embedded
      // original. Use this as the personalization hook — their actual words.
      commentary: item.commentary ?? null,
      // The body of the embedded original post being amplified. Do NOT cite
      // this as the prospect's own words.
      quoted_text: item.quoted_text ?? null,
      // The author of the embedded original post, for correct attribution
      // ("saw you share Satyajeet's take on...").
      quoted_author: item.quoted_author ?? null,
    });
  }

  out.posts.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Org-config + user-config merge. Union with explicit exclusion across
// products, value props, target personas, case studies, and competitors.
// User additions can never re-add what user exclusions removed.
// ─────────────────────────────────────────────────────────────────────────────
function mergeAndExclude({ orgItems, userAdditions, userExclusions, keyFn }) {
  const orgArr = Array.isArray(orgItems) ? orgItems : [];
  const addArr = Array.isArray(userAdditions) ? userAdditions : [];
  const exclArr = Array.isArray(userExclusions) ? userExclusions : [];

  const normKey = (item) => {
    const k = keyFn(item);
    if (k == null) return { primary: null, all: [] };
    if (typeof k === 'string') return { primary: k, all: [k] };
    return { primary: k.primary, all: k.all || (k.primary ? [k.primary] : []) };
  };

  const excludedKeys = new Set();
  for (const e of exclArr) {
    const wrapped = typeof e === 'string' ? { _str: e } : e;
    const { all } = normKey(wrapped);
    for (const k of all) excludedKeys.add(k);
  }
  const isExcluded = (allKeys) => allKeys.some(k => excludedKeys.has(k));

  const merged = [];
  const seenPrimary = new Set();

  for (const item of orgArr) {
    const { primary, all } = normKey(item);
    if (!primary || seenPrimary.has(primary) || isExcluded(all)) continue;
    merged.push(item);
    seenPrimary.add(primary);
  }
  for (const item of addArr) {
    const { primary, all } = normKey(item);
    if (!primary || seenPrimary.has(primary) || isExcluded(all)) continue;
    merged.push(item);
    seenPrimary.add(primary);
  }
  return merged;
}

// Key functions — all normalize to lowercased trimmed strings.
const stringKey = (item) => {
  if (typeof item === 'string') return item.trim().toLowerCase();
  if (item?._str)               return String(item._str).trim().toLowerCase();
  if (item?.name)               return String(item.name).trim().toLowerCase();
  return null;
};
const productKey = stringKey;
// Case studies can be excluded by id OR by customer name.
const caseKey = (item) => {
  if (!item) return null;
  if (typeof item === 'string') {
    const s = item.trim().toLowerCase();
    return { primary: s, all: [s] };
  }
  if (item._str) {
    const s = String(item._str).trim().toLowerCase();
    return { primary: s, all: [s] };
  }
  const id  = item.id       ? String(item.id).trim().toLowerCase() : null;
  const cus = item.customer ? String(item.customer).trim().toLowerCase() : null;
  if (!id && !cus) return null;
  return { primary: id || cus, all: [id, cus].filter(Boolean) };
};

// ─────────────────────────────────────────────────────────────────────────────
// buildOrgContext — assembles the rep-side context block.
//
// Resolution cascade (Slice 1):
//   org_baseline → campaign_override → user_layer (add/exclude)
//
// Per-field rules:
//   products         : campaign REPLACES org (if non-empty) → + user add/exclude
//   value_props      : campaign REPLACES org (if non-empty) → + user add/exclude
//   target_personas  : campaign REPLACES org (if non-empty) → + user add/exclude
//   case_studies     : campaign REPLACES org (if non-empty) → + user add/exclude
//   hook_preferences : user > campaign > org   (user is per-rep standing pref;
//                      per-run picker in runProspectSkill still wins above all)
//   competitors      : competitors-table ∪ user.custom_competitors − user.excluded_competitors
//                      (campaign layer not applied — competitor list is org-wide)
//   rep              : user prospecting_config + users-table fallback
//   voice            : user only
//   guardrails       : org ∪ campaign ∪ user (additive — campaigns can ADD
//                      restrictions, never loosen them)
// ─────────────────────────────────────────────────────────────────────────────
// Slice 1: campaign override layer. For products / value_props /
// target_personas / case_studies / hook_preferences, a non-empty array on the
// campaign override REPLACES the org array. For banned_phrasings and
// required_disclaimers, the campaign array is UNIONED with org — campaigns
// can add restrictions, never loosen them.
//
// Semantics rationale: when a rep configures a campaign with its own value
// props, they mean "use these *instead of* the org defaults" — a merge would
// mix old and new pitches and defeat the point. Guardrails differ because
// loosening them is never desired; campaigns are additive there.
//
// "Empty array on campaign override = inherit from org" is the rule. To
// explicitly clear a field for a campaign (e.g. no products at all), delete
// the entire campaign override via the DELETE endpoint — a deliberate
// simplicity tradeoff for Slice 1.
function resolveCampaignReplacement(orgItems, campaignItems) {
  const c = Array.isArray(campaignItems) ? campaignItems : [];
  if (c.length > 0) return c;
  return Array.isArray(orgItems) ? orgItems : [];
}

function buildOrgContext({ orgConfig, campaignConfig, userConfig, repUser, competitors }) {
  const oc = orgConfig      || {};
  const cc = campaignConfig || {};
  const uc = userConfig     || {};

  // ── Replacement layer: campaign overrides org for these fields ────────────
  const effectiveProducts        = resolveCampaignReplacement(oc.products, cc.products);
  const effectiveValueProps      = resolveCampaignReplacement(oc.default_value_props,          cc.default_value_props);
  const effectivePersonas        = resolveCampaignReplacement(oc.default_target_personas,      cc.default_target_personas);
  const effectiveCaseStudies     = resolveCampaignReplacement(oc.default_case_study_summaries, cc.default_case_study_summaries);

  // Hook preferences: campaign array replaces org array when non-empty. We
  // pass the resolved categories into the returned context — the skill reads
  // org_context.hook_preferences.preferred_categories at run time.
  const orgHookCats      = Array.isArray(oc.hook_preferences?.preferred_categories) ? oc.hook_preferences.preferred_categories : [];
  const campaignHookCats = Array.isArray(cc.hook_preferences?.preferred_categories) ? cc.hook_preferences.preferred_categories : [];
  const effectiveHookCats = campaignHookCats.length > 0 ? campaignHookCats : orgHookCats;

  // ── User add/exclude applies AFTER campaign replacement ───────────────────
  const products = mergeAndExclude({
    orgItems:       effectiveProducts,
    userAdditions:  uc.custom_products,
    userExclusions: uc.excluded_products,
    keyFn:          productKey,
  });

  const valueProps = mergeAndExclude({
    orgItems:       effectiveValueProps,
    userAdditions:  uc.custom_value_props,
    userExclusions: uc.excluded_value_props,
    keyFn:          stringKey,
  });

  const targetPersonas = mergeAndExclude({
    orgItems:       effectivePersonas,
    userAdditions:  uc.custom_target_personas,
    userExclusions: uc.excluded_target_personas,
    keyFn:          stringKey,
  });

  const caseStudies = mergeAndExclude({
    orgItems:       effectiveCaseStudies,
    userAdditions:  uc.custom_case_studies,
    userExclusions: uc.excluded_case_studies,
    keyFn:          caseKey,
  });

  const competitorObjs = mergeAndExclude({
    orgItems:       competitors,
    userAdditions:  (uc.custom_competitors || []).map(s =>
      typeof s === 'string' ? { name: s } : s
    ),
    userExclusions: uc.excluded_competitors,
    keyFn:          stringKey,
  });
  const competitorNames = competitorObjs.map(c => c.name).filter(Boolean);

  const repFromUser = uc.rep || {};
  const fallbackName = repUser
    ? [repUser.first_name, repUser.last_name].filter(Boolean).join(' ')
    : '';
  const rep = {
    name: fallbackName || 'Sales rep',
    title: repFromUser.title_for_signature || null,
    email_signature: repFromUser.email_signature_block || null,
  };

  // ── Guardrails: additive across org, campaign, and user ───────────────────
  const orgBanned      = Array.isArray(oc.guardrails?.banned_phrasings) ? oc.guardrails.banned_phrasings : [];
  const campaignBanned = Array.isArray(cc.guardrails?.banned_phrasings) ? cc.guardrails.banned_phrasings : [];
  const userAvoid      = Array.isArray(uc.voice?.avoid_phrases)         ? uc.voice.avoid_phrases         : [];

  const orgDisc      = Array.isArray(oc.guardrails?.required_disclaimers) ? oc.guardrails.required_disclaimers : [];
  const campaignDisc = Array.isArray(cc.guardrails?.required_disclaimers) ? cc.guardrails.required_disclaimers : [];

  const guardrailsExtra = {
    banned_phrasings:     [...new Set([...orgBanned, ...campaignBanned, ...userAvoid])],
    required_disclaimers: [...new Set([...orgDisc,   ...campaignDisc])],
  };

  // hook_preferences: prefer user's per-rep override when present, else the
  // effective (campaign-or-org) categories. The skill's per-run picker
  // (passed via runProspectSkill's hookPreferences arg) still wins over this
  // — that path injects directly into org_context.hook_preferences.
  const userHookCats = Array.isArray(uc.hook_preferences?.preferred_categories) ? uc.hook_preferences.preferred_categories : [];
  const resolvedHookPrefs = userHookCats.length > 0
    ? { preferred_categories: userHookCats }
    : (effectiveHookCats.length > 0 ? { preferred_categories: effectiveHookCats } : null);

  return {
    rep,
    products,
    value_props: valueProps,
    target_personas: targetPersonas,
    case_study_summaries: caseStudies,
    competitors: competitorNames,
    voice: uc.voice || null,
    hook_preferences: resolvedHookPrefs,
    guardrails_extra: guardrailsExtra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// pickEnrichmentNormalized — provider-agnostic reader of accounts.research_meta.
//
// research_meta is shaped like:
//   { coresignal: { status: 'ok', enriched_at, normalized: {...}, raw: {...} },
//     <other_provider>: { ... } }
//
// We pick the first entry with status='ok' and a normalized object. When
// ENRICHMENT_PROVIDER changes in env, this reader keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────────────
function pickEnrichmentNormalized(researchMeta) {
  if (!researchMeta || typeof researchMeta !== 'object') return null;
  for (const key of Object.keys(researchMeta)) {
    const block = researchMeta[key];
    if (
      block &&
      typeof block === 'object' &&
      block.status === 'ok' &&
      block.normalized &&
      typeof block.normalized === 'object'
    ) {
      return { provider: key, normalized: block.normalized };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// deriveGrowthStage — only emit a value when the signal is strong.
//
// Rules:
//   - Series C+ or growth/late-stage/pre-IPO → 'mature'
//   - Pre-seed / Seed / Series A / B → 'growth'
//   - founded_year < 7 years ago AND no funding info → 'early'
//   - otherwise → null  (the schema allows null and a guess is worse than absence)
//
// We do NOT infer 'public' — CoreSignal's normalized shape doesn't reliably
// expose a public-company flag, and other inferences are too noisy.
// ─────────────────────────────────────────────────────────────────────────────
function deriveGrowthStage(normalized) {
  if (!normalized) return null;

  const round = normalized.last_round;
  const roundType = round?.type ? String(round.type).toLowerCase() : null;

  if (roundType) {
    if (/series\s+(c|d|e|f|g|h)\b/.test(roundType) ||
        /\b(growth|late stage|pre[- ]?ipo)\b/.test(roundType)) {
      return 'mature';
    }
    if (/\b(pre[- ]?seed|seed|series\s+(a|b))\b/.test(roundType)) {
      return 'growth';
    }
  }

  const foundedYear = parseInt(normalized.founded_year, 10);
  if (Number.isInteger(foundedYear)) {
    const ageYears = new Date().getUTCFullYear() - foundedYear;
    if (ageYears >= 0 && ageYears < 7 && !roundType) {
      return 'early';
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// mapTechStack — flat string array → schema-required [{tool, category, source}]
//
// The skill's signal-use rule says: "Only reference tools that are IN the
// tech_stack array with a source." Source is the load-bearing field.
// Category isn't in the normalized shape; null is fine.
// ─────────────────────────────────────────────────────────────────────────────
function mapTechStack(normalized, providerName) {
  if (!normalized || !Array.isArray(normalized.tech_stack)) return [];
  return normalized.tech_stack
    .map(t => (typeof t === 'string' ? t.trim() : null))
    .filter(t => t && t.length > 0)
    .map(tool => ({
      tool,
      category: null,
      source: providerName || 'enrichment',
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// synthesizeFundingEvent — turn last_round into a schema-shaped account_event.
//
// The schema requires a real timestamp (date-time format). The skill ages
// events ("events older than 90 days are stale"), so a fabricated date would
// poison hook selection. If the round date is missing or unparseable we
// return null rather than emit a half-event.
// ─────────────────────────────────────────────────────────────────────────────
function synthesizeFundingEvent(normalized, providerName) {
  if (!normalized) return null;
  const round = normalized.last_round;
  if (!round || typeof round !== 'object') return null;

  const dateRaw = round.date;
  if (!dateRaw) return null;
  const parsed = new Date(dateRaw);
  if (Number.isNaN(parsed.getTime())) return null;
  const timestamp = parsed.toISOString();

  const type = round.type ? String(round.type).trim() : null;
  const amount = round.amount;
  const currency = round.currency || 'USD';

  let amountStr = null;
  if (typeof amount === 'number' && amount > 0) {
    const isUsd = !currency || currency === 'USD';
    const prefix = isUsd ? '$' : '';
    let core;
    if (amount >= 1_000_000_000) core = `${(amount / 1_000_000_000).toFixed(1)}B`;
    else if (amount >= 1_000_000) core = `${Math.round(amount / 1_000_000)}M`;
    else if (amount >= 1_000)     core = `${Math.round(amount / 1_000)}K`;
    else                          core = String(amount);
    amountStr = `${prefix}${core}${isUsd ? '' : ` ${currency}`}`;
  }

  let description;
  if (type && amountStr)      description = `${type} raised (${amountStr})`;
  else if (type)              description = `${type} round`;
  else if (amountStr)         description = `Funding round (${amountStr})`;
  else                        return null;  // date alone is too thin

  return {
    type: 'funding',
    description,
    source: providerName || 'enrichment',
    source_url: null,
    timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAccountEvents — currently sourced exclusively from enrichment.
//
// In the future we'll layer additional sources (news APIs, manual notes from
// the rep). When we add them, this function is the integration point — every
// source converts to the canonical shape and merges into `events` here.
// ─────────────────────────────────────────────────────────────────────────────
function buildAccountEvents(account) {
  const events = [];
  const enrichment = pickEnrichmentNormalized(account?.research_meta);
  if (enrichment) {
    const fundingEvent = synthesizeFundingEvent(enrichment.normalized, enrichment.provider);
    if (fundingEvent) events.push(fundingEvent);
  }
  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events.slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildEngagementHistory — emails + prospecting activities, newest-first.
// ─────────────────────────────────────────────────────────────────────────────
async function buildEngagementHistory(client, prospect, orgId) {
  if (!prospect) return [];
  const events = [];

  if (prospect.email) {
    const emails = await safeQuery(client,
      `SELECT id, subject, direction, sent_at
         FROM emails
        WHERE org_id = $1
          AND (LOWER(to_address) = LOWER($2) OR LOWER(from_address) = LOWER($2))
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 30`,
      [orgId, prospect.email]
    );
    for (const e of emails) {
      events.push({
        type: e.direction === 'sent' ? 'email_sent' : 'email_received',
        timestamp: e.sent_at,
        summary: e.subject || '(no subject)',
        direction: e.direction === 'sent' ? 'outbound' : 'inbound',
      });
    }
  }

  const activities = await safeQuery(client,
    `SELECT activity_type, description, metadata, created_at
       FROM prospecting_activities
      WHERE prospect_id = $1
      ORDER BY created_at DESC
      LIMIT 30`,
    [prospect.id]
  );
  // Non-LinkedIn activity types that flow straight into the engagement feed.
  const typeMap = {
    meeting_booked:               'meeting_booked',
    meeting_held:                 'meeting_held',
    meeting_no_show:              'meeting_no_show',
  };
  // LinkedIn touches are stored as a single bucket activity_type='linkedin_event'
  // with the granular event in metadata->>'event'. Normalise those granular
  // events into the canonical 'linkedin_*' type names that downstream consumers
  // (and the prior version of this map) expect. Without this, the LinkedIn
  // branch of the engagement feed is silently empty — no row ever had
  // activity_type='linkedin_connection_sent' etc.
  const LINKEDIN_EVENT_TYPE_MAP = {
    connection_request_sent: 'linkedin_connection_sent',
    connection_accepted:     'linkedin_connection_accepted',
    message_sent:            'linkedin_message_sent',
    inmail_sent:             'linkedin_message_sent',
    reply_received:          'linkedin_message_replied',
  };
  for (const a of activities) {
    let type = typeMap[a.activity_type];
    if (!type && a.activity_type === 'linkedin_event') {
      const meta = a.metadata || {};
      const ev = typeof meta === 'string' ? (JSON.parse(meta).event) : meta.event;
      type = LINKEDIN_EVENT_TYPE_MAP[ev];
    }
    if (!type) continue;
    events.push({
      type,
      timestamp: a.created_at,
      summary: a.description || null,
      direction: null,
    });
  }

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return events.slice(0, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSequenceState — current sequence enrollment, if any.
// ─────────────────────────────────────────────────────────────────────────────
async function buildSequenceState(client, prospect) {
  if (!prospect) return null;

  const rows = await safeQuery(client,
    `SELECT se.sequence_id, se.current_step, se.next_step_due,
            se.enrolled_at, s.name AS sequence_name,
            (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = se.sequence_id) AS total_steps
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
      WHERE se.prospect_id = $1
        AND se.status = 'active'
      ORDER BY se.enrolled_at DESC
      LIMIT 1`,
    [prospect.id]
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  const channelRows = await safeQuery(client,
    `SELECT DISTINCT ss.channel
       FROM sequence_steps ss
      WHERE ss.sequence_id = $1
        AND ss.step_order < $2`,
    [r.sequence_id, r.current_step]
  );

  return {
    sequence_id: String(r.sequence_id),
    sequence_name: r.sequence_name,
    current_step: r.current_step,
    total_steps: parseInt(r.total_steps, 10) || 0,
    last_touched_at: prospect.last_outreach_at || null,
    next_scheduled_at: r.next_step_due || null,
    channels_used: channelRows.map(c => c.channel).filter(Boolean),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildProspectSkillContext — main entry.
// ─────────────────────────────────────────────────────────────────────────────
async function buildProspectSkillContext({ prospectId, orgId, asUserId }) {
  let client;
  try {
    client = await pool.connect();

    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // ── Prospect ────────────────────────────────────────────────────────
    const prospectRes = await client.query(
      `SELECT * FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, orgId]
    );
    if (prospectRes.rows.length === 0) {
      const e = new Error('Prospect not found');
      e.statusCode = 404;
      throw e;
    }
    const prospect = prospectRes.rows[0];

    // ── Account (optional) ──────────────────────────────────────────────
    let account = null;
    if (prospect.account_id) {
      const accountRes = await client.query(
        `SELECT * FROM accounts WHERE id = $1 AND org_id = $2`,
        [prospect.account_id, orgId]
      );
      account = accountRes.rows[0] || null;
    }

    // ── LinkedIn profile (canonical source for headline/about/exp/edu/activity) ──
    //
    // Joined by slug, parsed from prospect.linkedin_url with the same regex
    // the writer (linkedin-profiles.routes.js) uses.
    const liProfileRows = await safeQuery(client,
      `SELECT headline, about, experience, education, activity
         FROM linkedin_profiles
        WHERE org_id = $1
          AND linkedin_slug = lower(substring($2 from '/in/([^/?#]+)'))
        LIMIT 1`,
      [orgId, prospect.linkedin_url || '']
    );
    const liProfile = liProfileRows[0] || null;
    const liExperience = Array.isArray(liProfile?.experience) ? liProfile.experience : [];
    const liEducation  = Array.isArray(liProfile?.education)  ? liProfile.education  : [];
    const liActivity   = Array.isArray(liProfile?.activity)   ? liProfile.activity   : [];

    // ── Org settings → prospecting_config ───────────────────────────────
    const orgRes = await client.query(
      `SELECT settings FROM organizations WHERE id = $1`,
      [orgId]
    );
    const orgConfig = orgRes.rows[0]?.settings?.prospecting_config || null;

    // ── Campaign override → prospecting_config_override (Slice 1) ───────
    // Loaded via safeQuery so environments where the migration hasn't run
    // yet (column missing → 42703) silently fall back to "no override".
    let campaignConfig = null;
    if (prospect.campaign_id) {
      const ccRes = await safeQuery(client,
        `SELECT prospecting_config_override
           FROM prospecting_campaigns
          WHERE id = $1 AND org_id = $2`,
        [prospect.campaign_id, orgId]
      );
      campaignConfig = ccRes[0]?.prospecting_config_override || null;
    }

    // ── User preferences → prospecting_config (only if asUserId provided) ──
    let userConfig = null;
    let repUser = null;
    if (asUserId) {
      const upRes = await safeQuery(client,
        `SELECT preferences FROM user_preferences
          WHERE user_id = $1 AND org_id = $2`,
        [asUserId, orgId]
      );
      userConfig = upRes[0]?.preferences?.prospecting_config || null;

      const userRes = await client.query(
        `SELECT id, first_name, last_name, email, department
           FROM users WHERE id = $1`,
        [asUserId]
      );
      repUser = userRes.rows[0] || null;
    } else if (prospect.owner_id) {
      const userRes = await client.query(
        `SELECT id, first_name, last_name, email, department
           FROM users WHERE id = $1`,
        [prospect.owner_id]
      );
      repUser = userRes.rows[0] || null;
    }

    // ── Competitors (org-scoped) ────────────────────────────────────────
    const competitors = await safeQuery(client,
      `SELECT name FROM competitors WHERE org_id = $1 ORDER BY name`,
      [orgId]
    );

    // ── ICP signals from prospect.icp_signals JSONB ─────────────────────
    const icpSignals = prospect.icp_signals || {};

    // ── Derive prospect title / company from LinkedIn current role ─────
    //
    // LinkedIn profile is the source of truth when captured. Without a
    // capture (no row in linkedin_profiles), fall back to the prospect-row
    // values that came from CSV import or manual creation. The headline
    // column is intentionally NOT a fallback for title — senior-role
    // headlines are usually positioning copy ("Head of X | Future-Focused
    // CMO | PE Growth Operator") and don't parse cleanly into a role label.
    const currentRole = pickCurrentRole(liExperience);
    const title = currentRole?.title
                  || (prospect.title?.trim() ? prospect.title.trim() : null);
    const company = currentRole?.company
                    || (prospect.company_name?.trim() ? prospect.company_name.trim() : null)
                    || account?.name
                    || null;
    const tenureMonths = computeTenureMonths(currentRole);

    // ── Account enrichment (provider-agnostic) ──────────────────────────
    const accountEnrichment = pickEnrichmentNormalized(account?.research_meta);
    const enrichedNormalized = accountEnrichment?.normalized || null;
    const enrichmentProvider = accountEnrichment?.provider || null;

    // ── Engagement + sequence state ─────────────────────────────────────
    const engagementHistory = await buildEngagementHistory(client, prospect, orgId);
    const sequenceState = await buildSequenceState(client, prospect);

    // ── Org context ─────────────────────────────────────────────────────
    const orgContext = buildOrgContext({
      orgConfig,
      campaignConfig,
      userConfig,
      repUser,
      competitors,
    });

    // ── Researcher note (from prospects.research_meta) ──────────────────
    //
    // The Research Queue lets the researcher type an optional note about
    // the prospect. There are three modes:
    //
    //   1. No note   — researcher_note is null. Skill picks its own hook
    //                  from signals.linkedin_activity and account_events
    //                  per org_context.hook_preferences.preferred_categories.
    //
    //   2. Hint mode — researcher_note is populated but signal_override
    //                  is false. The skill receives the note as additional
    //                  context (under signals.researcher_note) and may use,
    //                  ignore, or partially incorporate it — model's call.
    //
    //   3. Override  — researcher_note populated AND signal_override is true.
    //                  The skill MUST use the note as the hook anchor.
    //                  We enforce this by prepending 'researcher_override'
    //                  to preferred_categories so it wins the priority pass.
    //
    // Mode is derived from research_meta written by approve-research. We
    // also surface the source URL and category alongside the note text so
    // the skill's Pattern 7 (researcher_override) can do the right citation.
    const researchMeta = (prospect.research_meta && typeof prospect.research_meta === 'object')
      ? prospect.research_meta : {};
    const researcherNoteText = (typeof researchMeta.signal_summary === 'string' && researchMeta.signal_summary.trim())
      ? researchMeta.signal_summary.trim() : null;
    const researcherNoteOverride = researchMeta.signal_override === true && !!researcherNoteText;
    const researcherNote = researcherNoteText
      ? {
          text:       researcherNoteText,
          category:   researchMeta.signal_category || 'researcher_override',
          source_url: researchMeta.signal_source_url || null,
          override:   researcherNoteOverride,
        }
      : null;

    // When override is on, prepend 'researcher_override' to the hook
    // priority list so the skill picks it first. We mutate a copy of
    // org_context here rather than buildOrgContext so this stays a
    // per-prospect transformation, not an org-wide config change.
    const finalOrgContext = researcherNoteOverride
      ? {
          ...orgContext,
          hook_preferences: {
            ...(orgContext.hook_preferences || {}),
            preferred_categories: [
              'researcher_override',
              ...((orgContext.hook_preferences?.preferred_categories) || [])
                .filter(c => c !== 'researcher_override'),
            ],
          },
        }
      : orgContext;

    // ── Compose ─────────────────────────────────────────────────────────
    const payload = {
      prospect: {
        name: [prospect.first_name, prospect.last_name].filter(Boolean).join(' '),
        title,
        company,
        linkedin_url: prospect.linkedin_url || null,
        email: prospect.email || null,
        seniority_level: inferSeniority(title),
        function: inferFunction(title),
        tenure_in_role_months: tenureMonths,
        headline: liProfile?.headline || null,
        about: liProfile?.about || null,
        experience: liExperience,
        education: liEducation,
      },
      account: {
        name: company,
        industry: account?.industry || null,
        size: account?.size || null,
        growth_stage: deriveGrowthStage(enrichedNormalized),
        tech_stack: mapTechStack(enrichedNormalized, enrichmentProvider),
        website: account?.domain ? `https://${account.domain}` : null,
        one_line_description: account?.description || null,
      },
      icp: {
        fit_score: prospect.icp_score || 0,
        matched_criteria: Array.isArray(icpSignals.matched_criteria)
          ? icpSignals.matched_criteria : [],
        missed_criteria: Array.isArray(icpSignals.missed_criteria)
          ? icpSignals.missed_criteria : [],
        persona_match: icpSignals.persona_match || null,
      },
      signals: {
        account_events: buildAccountEvents(account),
        linkedin_activity: splitLinkedInActivity(liActivity),
        // null when the researcher left the queue note blank. The skill
        // checks for non-null and acts per the rules in
        // reference/hook-patterns.md → Pattern 7.
        researcher_note: researcherNote,
      },
      engagement_history: engagementHistory,
      sequence_state: sequenceState,
      reply_payload: null,  // populated only by reply-event-triggered skills
      org_context: finalOrgContext,

      // Out-of-band metadata for the runner. The leading underscore marks this
      // as not part of the skill contract — skills MUST ignore it. Used by the
      // runner to attribute skill_runs records back to the right org/prospect
      // without re-querying.
      _meta: {
        org_id: orgId,
        prospect_id: prospect.id,
        rep_user_id: asUserId || prospect.owner_id || null,
      },
    };

    return payload;
  } finally {
    if (client) client.release();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// buildDealSkillContext — canonical deal payload for the discovery-call-prep
// skill. Extracted verbatim from the retired routes/skill-context.routes.js
// GET /deals/:dealId handler during the 2026 skills integration. The HTTP
// wrapper is gone; this is now called in-process by SkillRunnerService.
//
// Returns the gowarm-deal.json-shaped payload. Throws an Error with
// statusCode=404 when the deal does not exist.
// ─────────────────────────────────────────────────────────────────────────────
async function buildDealSkillContext({ dealId }) {
  let client;
  try {
    client = await pool.connect();
    // ── Step 1: lookup the deal's org_id (pre-RLS) ──
    const dealCoreRes = await client.query(
      `SELECT id, org_id FROM deals WHERE id = $1`,
      [dealId]
    );

    if (dealCoreRes.rows.length === 0) {
      const e = new Error('Deal not found');
      e.statusCode = 404;
      throw e;
    }
    const orgId = dealCoreRes.rows[0].org_id;

    // ── Step 2: set RLS session variable for this connection ──
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // ── Deal (full details) ────────────────────────────────
    const dealRes = await client.query(
      `SELECT id, name, stage, stage_type, playbook_id, created_at,
              value, account_id, economic_buyer_contact_id,
              stage_changed_at, expected_close_date, health, health_score,
              external_crm_type, competitive_competitors,
              buyer_event_description, legal_engaged_user, security_review_user,
              EXTRACT(DAY FROM (NOW() - COALESCE(stage_changed_at, created_at)))::int AS days_in_stage
         FROM deals WHERE id = $1`,
      [dealId]
    );
    const deal = dealRes.rows[0];

    // ── Primary contact: prefer deal_contacts; fall back to economic buyer ──
    let prospectContact = null;
    const dealContacts = await safeQuery(client,
      `SELECT c.id, c.first_name, c.last_name, c.title, c.email,
              c.linkedin_url, c.role_type, c.engagement_level
         FROM deal_contacts dc
         JOIN contacts c ON c.id = dc.contact_id
        WHERE dc.deal_id = $1
        ORDER BY CASE
                   WHEN c.role_type = 'economic_buyer' THEN 1
                   WHEN c.role_type = 'champion'       THEN 2
                   WHEN c.role_type = 'decision_maker' THEN 3
                   ELSE 4
                 END
        LIMIT 1`,
      [dealId]);

    if (dealContacts.length > 0) {
      prospectContact = dealContacts[0];
    } else if (deal.economic_buyer_contact_id) {
      const ebRows = await safeQuery(client,
        `SELECT id, first_name, last_name, title, email, linkedin_url
           FROM contacts WHERE id = $1`,
        [deal.economic_buyer_contact_id]);
      prospectContact = ebRows[0] || null;
    }

    // ── Account ────────────────────────────────────────────
    const accountRows = await safeQuery(client,
      `SELECT id, name, industry, size, location, description, domain
         FROM accounts WHERE id = $1`,
      [deal.account_id]);
    const account = accountRows[0] || {};

    // ── Economic buyer name ───────────────────────────────
    let economicBuyerName = null;
    if (deal.economic_buyer_contact_id) {
      const ebRows = await safeQuery(client,
        `SELECT first_name, last_name, title FROM contacts WHERE id = $1`,
        [deal.economic_buyer_contact_id]);
      if (ebRows[0]) {
        const eb = ebRows[0];
        economicBuyerName = `${eb.first_name} ${eb.last_name}${eb.title ? ' (' + eb.title + ')' : ''}`;
      }
    }

    // ── Champion name ─────────────────────────────────────
    let championName = null;
    const champRows = await safeQuery(client,
      `SELECT c.first_name, c.last_name, c.title
         FROM deal_contacts dc
         JOIN contacts c ON c.id = dc.contact_id
        WHERE dc.deal_id = $1 AND c.role_type = 'champion'
        LIMIT 1`,
      [dealId]);
    if (champRows[0]) {
      const ch = champRows[0];
      championName = `${ch.first_name} ${ch.last_name}${ch.title ? ' (' + ch.title + ')' : ''}`;
    }

    // ── Interaction history — 3 queries (safer than one UNION) ──
    // Emails
    const emails = await safeQuery(client,
      `SELECT 'email' AS type,
              COALESCE(created_at) AS ts,
              COALESCE(subject, '(no subject)') AS summary,
              NULL::text AS direction
         FROM emails
        WHERE deal_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10`,
      [dealId]);

    // Meetings
    const meetings = await safeQuery(client,
      `SELECT 'meeting' AS type,
              COALESCE(created_at) AS ts,
              COALESCE(title, '(meeting)') AS summary,
              NULL::text AS direction
         FROM meetings
        WHERE deal_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10`,
      [dealId]);

    // Actions
    const actions = await safeQuery(client,
      `SELECT COALESCE(type, 'note') AS type,
              COALESCE(created_at) AS ts,
              COALESCE(description, title, '(action)') AS summary,
              NULL::text AS direction
         FROM actions
        WHERE deal_id = $1
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10`,
      [dealId]);

    const allInteractions = [...emails, ...meetings, ...actions]
      .filter(r => r.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 10);

    // ── MEDDPICC composed from deals + deal_contacts ──────
    const meddpicc = {
      metrics: null,
      economic_buyer: economicBuyerName,
      decision_criteria: null,
      decision_process: (deal.legal_engaged_user || deal.security_review_user)
        ? `Legal engaged: ${deal.legal_engaged_user ? 'yes' : 'no'}; Security review: ${deal.security_review_user ? 'yes' : 'no'}`
        : null,
      paper_process: null,
      identified_pain: deal.buyer_event_description || null,
      champion: championName,
      competition: deal.competitive_competitors
        ? JSON.stringify(deal.competitive_competitors)
        : null,
    };

    // ── Compose final canonical payload ────────────────────
    const payload = {
      prospect: prospectContact ? {
        name: [prospectContact.first_name, prospectContact.last_name].filter(Boolean).join(' '),
        title: prospectContact.title || '',
        company: account.name || '',
        linkedin_url: prospectContact.linkedin_url || undefined,
        email: prospectContact.email || undefined,
      } : {
        name: 'Unknown',
        title: '',
        company: account.name || '',
      },
      account: {
        industry: account.industry || '',
        size: account.size || '',
        revenue_band: undefined,
        recent_signals: [],
      },
      deal: {
        stage: deal.stage,
        source: deal.external_crm_type ? `external_${deal.external_crm_type}` : 'unknown',
        playbook_id: deal.playbook_id,
        created_at: deal.created_at,
        amount: deal.value ? Number(deal.value) : undefined,
        days_in_stage: deal.days_in_stage || 0,
      },
      interaction_history: allInteractions.map(r => ({
        type: r.type,
        timestamp: r.ts,
        summary: r.summary,
        direction: r.direction || undefined,
      })),
      meddpicc,
    };

    payload._meta = {
      org_id: orgId,
      deal_id: deal.id,
      rep_user_id: null,
    };

    return payload;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  buildProspectSkillContext,
  buildDealSkillContext,
  // Exported for unit tests of the resolution cascade. Not used by route code.
  buildOrgContext,
};
