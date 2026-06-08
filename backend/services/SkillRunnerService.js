// ============================================================================
// services/SkillRunnerService.js
//
// Internal skill-execution service. Runs disk-based skills (backend/skills/*)
// against canonical context payloads, using GoWarmCRM's own AI infrastructure.
//
// This replaces the standalone Skills Runner PoC. The PoC's skill-loading and
// JSON-parsing logic is ported here verbatim; its Anthropic-SDK and telemetry
// code is dropped in favour of:
//   • AIClientResolver   — per-org/user model + key resolution
//   • TokenTrackingService — cost logging into ai_token_usage
//   • SkillContextService  — in-process context building (no HTTP hop)
//   • direct skill_runs INSERT — instrumentation
//
// Public API:
//   runProspectSkill({ orgId, userId, prospectId, skillName, hookPreferences? })
//   runDealSkill({ orgId, userId, dealId, skillName, methodology? })
//   validateSkillRegistry()    — boot-time sanity check; throws on misconfig
//
// Both run-functions return { ok, output, runId, status, usage }.
// ============================================================================

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const { pool }            = require('../config/database');
const AIClientResolver    = require('./ai/AIClientResolver');
const TokenTrackingService = require('./TokenTrackingService');
const OutreachValidator    = require('./OutreachValidator');
const {
  buildProspectSkillContext,
  buildDealSkillContext,
} = require('./SkillContextService');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

// Methodologies the discovery-call-prep skill accepts.
const ALLOWED_METHODOLOGIES = new Set(['meddic', 'challenger']);

// Per-skill metadata: which callType to resolve a model with, max output
// tokens, and which context builder + id field applies.
//
// Slice 3: The retired 'outreach-personalization' skill is kept in the
// registry so /api/skill-runs queries with skill_name=outreach-personalization
// keep working for old rows. No live code path creates new runs of the
// retired skill — the dispatcher routes everything through
// outreach-email + outreach-linkedin.
const SKILL_REGISTRY = {
  'outreach-personalization': {
    callType:   'prospecting_draft',
    maxTokens:  2000,
    entity:     'prospect',
    retired:    true,    // Slice 3 — no new runs created via dispatcher
  },
  'outreach-email': {
    callType:   'prospecting_draft',
    maxTokens:  1500,
    entity:     'prospect',
  },
  'outreach-linkedin': {
    callType:   'prospecting_draft',
    maxTokens:  1200,
    entity:     'prospect',
  },
  'discovery-call-prep': {
    callType:   'discovery_call_prep',
    maxTokens:  4000,
    entity:     'deal',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// validateSkillRegistry — boot-time sanity check.
//
// Catches the class of bug where a skill is registered in code but its on-disk
// bundle is missing, incomplete, or mis-named. Intended to run once at app
// boot (see server.js / app.js).
//
// Checks performed for every non-retired skill in SKILL_REGISTRY:
//   1. <skill>/SKILL.md exists on disk
//   2. <skill>/SKILL.md frontmatter declares `name: <skill>` (catches the
//      copy-paste-and-forget-to-rename failure mode that produced the
//      original "Skill not found: outreach-linkedin" preview errors)
//
// Throws on any failure, with a message that names every offending skill and
// the specific check that failed. App refuses to boot until fixed — preferred
// over silently allowing every preview to error at runtime.
//
// Retired skills are skipped: they may still be on disk for back-compat
// queries against historical skill_runs rows, but no live code path dispatches
// against them so their bundle state is not safety-critical.
// ─────────────────────────────────────────────────────────────────────────────
function validateSkillRegistry() {
  const failures = [];
  const activeSkills = Object.entries(SKILL_REGISTRY).filter(([, m]) => !m.retired);

  for (const [skillName] of activeSkills) {
    const skillMdPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      failures.push(
        `[${skillName}] SKILL.md not found at ${skillMdPath}`
      );
      continue;
    }

    // Parse the frontmatter `name:` field. The file starts with `---\n`,
    // then YAML keys, then `---\n`. We only need `name`, so a cheap regex
    // beats pulling in a YAML dep.
    const skillMd = fs.readFileSync(skillMdPath, 'utf8');
    const fmMatch = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) {
      failures.push(
        `[${skillName}] SKILL.md has no frontmatter block (expected leading '---' / '---')`
      );
      continue;
    }
    const nameMatch = fmMatch[1].match(/^name:\s*(\S+)\s*$/m);
    if (!nameMatch) {
      failures.push(
        `[${skillName}] SKILL.md frontmatter is missing 'name:' field`
      );
      continue;
    }
    const declaredName = nameMatch[1];
    if (declaredName !== skillName) {
      failures.push(
        `[${skillName}] SKILL.md frontmatter declares name='${declaredName}' ` +
        `but registry key is '${skillName}'. ` +
        `This usually means a SKILL.md was copy-pasted from another skill ` +
        `without updating the name field.`
      );
    }
  }

  if (failures.length > 0) {
    const msg =
      `Skill registry validation failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):\n` +
      failures.map(f => `  • ${f}`).join('\n') +
      `\n\nFix the offending skill bundle(s) under backend/skills/ before booting.`;
    throw new Error(msg);
  }

  console.log(
    `[skill-runner] Validated ${activeSkills.length} active skill(s) on disk: ` +
    `${activeSkills.map(([n]) => n).join(', ')}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill loader — reads a skill folder from disk into a bundle.
// Ported from the PoC's loadSkill(). Reads SKILL.md plus every file under
// templates/, reference/, schema/, and (for methodology-aware skills) the
// single requested methodologies/<name>.md file.
// ─────────────────────────────────────────────────────────────────────────────
function loadSkill(skillName, methodology) {
  const skillRoot = path.join(SKILLS_DIR, skillName);
  if (!fs.existsSync(path.join(skillRoot, 'SKILL.md'))) {
    const e = new Error(`Skill not found: ${skillName}`);
    e.statusCode = 404;
    throw e;
  }
  const skillMd = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const bundle = { skillMd, methodology: methodology || null, files: {} };

  for (const sub of ['templates', 'reference', 'schema']) {
    const subPath = path.join(skillRoot, sub);
    if (!fs.existsSync(subPath)) continue;
    for (const file of fs.readdirSync(subPath)) {
      const rel = path.join(sub, file);
      bundle.files[rel] = fs.readFileSync(path.join(skillRoot, sub, file), 'utf8');
    }
  }

  if (methodology && ALLOWED_METHODOLOGIES.has(methodology)) {
    const mPath = path.join(skillRoot, 'methodologies', `${methodology}.md`);
    if (fs.existsSync(mPath)) {
      bundle.files[path.join('methodologies', `${methodology}.md`)] =
        fs.readFileSync(mPath, 'utf8');
    } else {
      console.warn(`[skill-runner] methodology file not found: ${mPath}`);
    }
  }
  return bundle;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPrompt — assembles SKILL.md + bundled files into one system
// prompt. Ported verbatim from the PoC.
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(bundle) {
  let prompt = bundle.skillMd + '\n\n## Bundled skill files\n\n';
  prompt += 'The following files are referenced by SKILL.md. Use them as instructed.\n\n';

  if (bundle.methodology) {
    prompt += `## Active methodology: ${bundle.methodology.toUpperCase()}\n\n`;
    prompt += `A methodology file is included below at \`methodologies/${bundle.methodology}.md\`. `
            + `Its guidance shapes the tone, question selection, email framing, close, and next-step `
            + `recommendation for this run. Base guardrails (no hallucination, placeholder usage in `
            + `emails, no leaking system context) still apply universally.\n\n`;
  }
  for (const [rel, contents] of Object.entries(bundle.files)) {
    prompt += `### FILE: ${rel}\n\n\`\`\`\n${contents}\n\`\`\`\n\n`;
  }
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON extraction — ported verbatim from the PoC's extractJsonObject /
// repairUnescapedQuotes. Models occasionally wrap output in fences or emit
// unescaped quotes inside string values; this recovers the cheap cases.
// Returns { ok: true, value } or { ok: false, error, attempted }.
// ─────────────────────────────────────────────────────────────────────────────
function extractJsonObject(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { ok: false, error: 'empty_response', attempted: '' };
  }
  let s = rawText.trim();
  s = s.replace(/^```(?:json|JSON)?\s*\n?/i, '');
  s = s.replace(/\n?```[^\n]*$/i, '').trim();

  const firstBrace = s.indexOf('{');
  const lastBrace  = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (_) { /* fall through */ }

  const repaired = repairUnescapedQuotes(s);
  if (repaired !== s) {
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch (_) { /* fall through */ }
  }
  return { ok: false, error: 'unparseable_after_repair', attempted: s };
}

function repairUnescapedQuotes(s) {
  let out = '';
  let inString = false;
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && prev !== '\\') {
      if (!inString) {
        inString = true;
        out += ch;
      } else {
        let j = i + 1;
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        const next = j < s.length ? s[j] : '';
        const terminators = [',', '}', ']', ':', '\n', '\r', ''];
        if (terminators.includes(next)) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      }
    } else {
      out += ch;
    }
    prev = ch;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// hashPrompt — sha256 of the assembled system prompt. Used to dedup
// skill_prompt_versions rows (the prompt text is large and rarely changes).
// ─────────────────────────────────────────────────────────────────────────────
function hashPrompt(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// persistSkillRun — INSERT a skill_runs row + upsert skill_prompt_versions.
// Replaces the PoC's HTTP POST to /api/skill-runs. Called directly with a DB
// connection that already has RLS scoped to the org.
// ─────────────────────────────────────────────────────────────────────────────
async function persistSkillRun(client, {
  orgId, userId, skillName, prospectId, dealId,
  inputPayload, systemPrompt, output, rawOutput,
  methodology, model, usage, latencyMs, status, errorDetail,
}) {
  // Upsert the prompt version (hash → text). ON CONFLICT keeps it idempotent.
  const promptHash = hashPrompt(systemPrompt);
  try {
    await client.query(
      `INSERT INTO skill_prompt_versions (hash, skill_name, prompt_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (hash) DO NOTHING`,
      [promptHash, skillName, systemPrompt]
    );
  } catch (err) {
    console.warn('[skill-runner] prompt-version upsert failed:', err.message);
  }

  // Denormalized hook fields — outreach-personalization emits {hook:{...}}.
  let hookCategory = null;
  let hookSignalId = null;
  if (output && typeof output === 'object' && output.hook) {
    hookCategory = output.hook.category ?? null;
    hookSignalId = output.hook.primary_signal_id ?? null;
  }

  // Cost attribution.
  //
  // The historical pattern was to keep skill_runs.cost_usd = 0 and let
  // TokenTrackingService own all cost reporting via ai_token_usage. That
  // works for org-wide / call-type rollups, but breaks attribution: token
  // usage rows don't carry prospect_id or deal_id, so "what did Adam Boucher's
  // drafts cost?" can't be answered without fragile time-window joins.
  //
  // We now populate cost_usd here as well — duplicating the value across
  // ai_token_usage and skill_runs intentionally. ai_token_usage remains the
  // org-wide source of truth (it covers AI calls that don't go through the
  // skill runner). skill_runs.cost_usd enables per-prospect / per-deal cost
  // queries against skill_runs alone.
  //
  // Single source of pricing data: TokenTrackingService.estimateCost. If the
  // model isn't recognized (returns null) we store 0 — matching what
  // ai_token_usage does in the same case.
  const promptTokens     = usage?.input_tokens  || 0;
  const completionTokens = usage?.output_tokens || 0;
  const estimatedCost    = TokenTrackingService.estimateCost(
    model, promptTokens, completionTokens
  ) || 0;

  const ins = await client.query(
    `INSERT INTO skill_runs (
       org_id, user_id, skill_name, prospect_id, deal_id,
       input_payload, prompt_hash, methodology,
       output, raw_output,
       hook_category, hook_signal_id,
       model, input_tokens, output_tokens, cost_usd, latency_ms,
       status, error_detail
     ) VALUES (
       $1,$2,$3,$4,$5,
       $6::jsonb,$7,$8,
       $9::jsonb,$10,
       $11,$12,
       $13,$14,$15,$16,$17,
       $18,$19
     ) RETURNING id`,
    [
      orgId, userId, skillName, prospectId || null, dealId || null,
      JSON.stringify(inputPayload), promptHash, methodology || null,
      output != null ? JSON.stringify(output) : null, rawOutput || null,
      hookCategory, hookSignalId,
      model || 'unknown',
      promptTokens,
      completionTokens,
      estimatedCost,
      latencyMs != null ? latencyMs : null,
      status, errorDetail || null,
    ]
  );
  return ins.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// runSkill — the shared execution core. Given an already-built context
// payload, resolves a model, calls the AI, parses the output, persists the
// run, and logs token usage.
// ─────────────────────────────────────────────────────────────────────────────
async function runSkill({
  orgId, userId, skillName, methodology,
  contextPayload, prospectId, dealId,
}) {
  const meta = SKILL_REGISTRY[skillName];
  if (!meta) {
    const e = new Error(`Unknown skill: ${skillName}`);
    e.statusCode = 400;
    throw e;
  }

  // Org-scope guard. The assembled payload carries its org in _meta.org_id.
  // If it doesn't match the org this run was invoked for, refuse — a cross-org
  // rep/signature (e.g. org 112 leaking into an org 111 run) must never reach
  // the model or a prospect. This is org-provenance only; it does NOT inspect
  // who the signer is, so a campaign run on someone's behalf is unaffected.
  if (contextPayload && contextPayload._meta &&
      contextPayload._meta.org_id != null &&
      String(contextPayload._meta.org_id) !== String(orgId)) {
    const e = new Error(
      `Org scope mismatch: payload _meta.org_id=${contextPayload._meta.org_id} ` +
      `but run invoked for org ${orgId}. Refusing to run.`);
    e.statusCode = 409;
    throw e;
  }

  const bundle = loadSkill(skillName, methodology);
  const system = buildSystemPrompt(bundle);

  // The user message: the context payload + strict output instructions.
  // The assistant turn is prefilled with '{' so the model is mechanically
  // forced to start with a JSON object — same trick as the PoC.
  const userMessage = [
    `Execute the ${skillName} skill on the following payload.`,
    methodology
      ? `Apply the ${methodology.toUpperCase()} methodology lens as described in methodologies/${methodology}.md.`
      : 'No methodology specified — run in default mode.',
    "Return ONLY the JSON object specified in the skill's Output format section.",
    'No prose, no markdown fences, no commentary.',
    'Inside JSON string values, every double-quote character must be escaped as \\".',
    '',
    'Payload:',
    '```json',
    JSON.stringify(contextPayload, null, 2),
    '```',
  ].join('\n');

  // Resolve provider/model/key via the org+user AI config.
  const { adapter, model, provider, keySource } =
    await AIClientResolver.resolve(orgId, userId, meta.callType);

  const startTs = Date.now();
  let client;
  try {
    client = await pool.connect();
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    let aiResult, latencyMs, completeText, parseResult;

    try {
      aiResult = await adapter.complete({
        model,
        system,
        messages: [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: '{' },   // prefill — forces JSON
        ],
        maxTokens: meta.maxTokens,
      });
      latencyMs = Date.now() - startTs;
    } catch (err) {
      // AI call itself failed — record execution_failed and rethrow.
      const runId = await persistSkillRun(client, {
        orgId, userId, skillName, prospectId, dealId,
        inputPayload: contextPayload, systemPrompt: system,
        output: null, rawOutput: null, methodology,
        model, usage: { input_tokens: 0, output_tokens: 0 },
        latencyMs: Date.now() - startTs,
        status: 'execution_failed', errorDetail: err.message,
      });
      const e = new Error('Skill execution failed: ' + err.message);
      e.statusCode = 502;
      e.runId = runId;
      throw e;
    }

    // Re-prepend the prefilled '{' before parsing.
    completeText = '{' + (aiResult.text || '');
    parseResult = extractJsonObject(completeText);

    // Log token usage regardless of parse success.
    await TokenTrackingService.log({
      orgId, userId, callType: meta.callType,
      model, provider, keySource,
      usage: aiResult.usage,
      dealId: dealId || null,
    });

    if (!parseResult.ok) {
      const runId = await persistSkillRun(client, {
        orgId, userId, skillName, prospectId, dealId,
        inputPayload: contextPayload, systemPrompt: system,
        output: null, rawOutput: completeText, methodology,
        model, usage: aiResult.usage, latencyMs,
        status: 'parse_failed', errorDetail: parseResult.error,
      });
      return {
        ok: false, status: 'parse_failed', runId,
        error: parseResult.error,
        raw: completeText.slice(0, 2000),
        usage: aiResult.usage,
      };
    }

    const runId = await persistSkillRun(client, {
      orgId, userId, skillName, prospectId, dealId,
      inputPayload: contextPayload, systemPrompt: system,
      output: parseResult.value, rawOutput: completeText, methodology,
      model, usage: aiResult.usage, latencyMs,
      status: 'ok', errorDetail: null,
    });

    // Deterministic post-validation: length caps, banned phrasings, and
    // fit/skip routing the model can't be trusted to self-enforce. The caller
    // (dispatcher / step firer) gates auto-send on validation.route:
    //   'send'   -> ok to send
    //   'review' -> recommend_skip / disqualified -> manual lane
    //   'reject' -> a hard cap or banned phrasing was hit -> regenerate
    const validation = OutreachValidator.validateForSkill(
      skillName, parseResult.value, contextPayload.org_context || {}
    );

    return {
      ok: true, status: 'ok', runId,
      output: parseResult.value,
      validation,
      methodology: methodology || 'default',
      usage: aiResult.usage,
    };
  } finally {
    if (client) client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public — runProspectSkill
//
// Builds prospect context in-process, optionally injects per-run hook
// preferences, then runs the skill.
// ─────────────────────────────────────────────────────────────────────────────
async function runProspectSkill({ orgId, userId, prospectId, skillName, hookPreferences, stepIntent, dryRun }) {
  if (!orgId || !userId || !prospectId) {
    const e = new Error('orgId, userId and prospectId are required');
    e.statusCode = 400;
    throw e;
  }

  const contextPayload = await buildProspectSkillContext({
    prospectId, orgId, asUserId: userId,
  });

  // Per-run hook picker: the frontend passes preferred categories; the skill
  // reads org_context.hook_preferences.preferred_categories (see SKILL.md).
  if (Array.isArray(hookPreferences) && hookPreferences.length > 0) {
    contextPayload.org_context = contextPayload.org_context || {};
    contextPayload.org_context.hook_preferences = {
      ...(contextPayload.org_context.hook_preferences || {}),
      preferred_categories: hookPreferences,
    };
  }

  // Slice 3: per-run step intent — required by outreach-email and
  // outreach-linkedin to pick the right template. The dispatcher injects it.
  // The skill reads org_context.step_intent.
  //
  // For back-compat with the on-demand path that just calls runProspectSkill
  // without an intent (e.g. early Slice 3 OutreachSkillPanel before the UI
  // is updated), an absent intent is left null and the skill defaults to
  // first_touch / connection_request, flagging in confidence_notes.
  if (stepIntent && typeof stepIntent === 'string') {
    contextPayload.org_context = contextPayload.org_context || {};
    contextPayload.org_context.step_intent = stepIntent;
  }

  if (dryRun) {
    // Inspect-before-send: return the EXACT payload the model would receive
    // (rep, signature, org_context, _meta.org_id) without calling the AI.
    // Wire a 'Preview payload' button to this so org-context errors are
    // ruled out before a single send.
    return { ok: true, dryRun: true, status: 'dry_run', payload: contextPayload };
  }

  return runSkill({
    orgId, userId, skillName, methodology: null,
    contextPayload, prospectId, dealId: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public — runDealSkill
// ─────────────────────────────────────────────────────────────────────────────
async function runDealSkill({ orgId, userId, dealId, skillName, methodology }) {
  if (!orgId || !userId || !dealId) {
    const e = new Error('orgId, userId and dealId are required');
    e.statusCode = 400;
    throw e;
  }
  if (methodology && !ALLOWED_METHODOLOGIES.has(methodology)) {
    const e = new Error(`Invalid methodology. Allowed: ${[...ALLOWED_METHODOLOGIES].join(', ')}`);
    e.statusCode = 400;
    throw e;
  }

  const contextPayload = await buildDealSkillContext({ dealId });

  // The deal-context _meta has no rep; attribute the run to the caller.
  contextPayload._meta = { ...(contextPayload._meta || {}), rep_user_id: userId };

  return runSkill({
    orgId, userId, skillName, methodology: methodology || null,
    contextPayload, prospectId: null, dealId,
  });
}

module.exports = {
  runProspectSkill,
  runDealSkill,
  validateSkillRegistry,
  // exported for unit testing
  loadSkill,
  buildSystemPrompt,
  extractJsonObject,
  SKILL_REGISTRY,
};
