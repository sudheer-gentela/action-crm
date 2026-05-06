// ============================================================================
// routes/skill-runs.routes.js
//
// Instrumentation endpoints for the Skills Runner PoC.
//
//   POST /api/skill-runs                  - runner posts a record after each
//                                            skill execution. Token-authed.
//   GET  /api/skill-runs?org_id=&skill=   - list recent runs (paginated)
//   GET  /api/skill-runs/summary?org_id=  - hook category distribution + counts
//   GET  /api/skill-runs/:id?org_id=      - single run with full payload+output
//
// All four endpoints are token-authenticated using SKILL_RUNNER_TOKEN — same
// trust model as /api/skill-context. The runner's UI calls the GETs through
// the runner server (which proxies with the token), so we don't need a
// parallel user-JWT auth path.
//
// Trust-model note: The runner has no user JWT, only the shared token. So the
// POST takes org_id from the input_payload's prospect/account context (which
// was itself produced by an org-scoped /api/skill-context call earlier in
// the same request flow). A malicious caller with the runner token could
// log a run claiming any org_id — this is acceptable in the PoC because
// possession of the token already grants full-tenant read on /api/skill-context
// (the bigger blast radius). When skills move into GoWarmCRM proper, the
// org_id will come from the caller's user JWT.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware — shared secret (same as skill-context.routes.js)
// ─────────────────────────────────────────────────────────────────────────────
function requireSkillRunnerToken(req, res, next) {
  const provided = req.headers['x-skill-runner-token'];
  const expected = process.env.SKILL_RUNNER_TOKEN;

  if (!expected) {
    console.error('SKILL_RUNNER_TOKEN env var is not set on the backend');
    return res.status(500).json({ error: { message: 'Server misconfigured' } });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: { message: 'Invalid skill runner token' } });
  }
  next();
}

router.use(requireSkillRunnerToken);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate and parse a numeric query/body parameter.
// Returns the parsed int, or throws an Error with statusCode=400 on failure.
// ─────────────────────────────────────────────────────────────────────────────
function requireInt(value, name) {
  if (value == null || value === '') {
    const e = new Error(`${name} is required`);
    e.statusCode = 400;
    throw e;
  }
  const s = String(value);
  if (!/^\d+$/.test(s)) {
    const e = new Error(`${name} must be a positive integer`);
    e.statusCode = 400;
    throw e;
  }
  return parseInt(s, 10);
}

function optionalInt(value, name) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!/^\d+$/.test(s)) {
    const e = new Error(`${name} must be a positive integer`);
    e.statusCode = 400;
    throw e;
  }
  return parseInt(s, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/skill-runs
//
// Body:
//   {
//     org_id, user_id?, skill_name, prospect_id?, deal_id?,
//     input_payload,                 // jsonb
//     output?,                       // jsonb (null when status != 'ok')
//     raw_output?,                   // text (full model output, for debugging)
//     prompt_text?, prompt_hash?,    // see /api/skill-prompt-versions instead
//                                    // — pass the hash, NOT the text, on
//                                    // every run; upsert prompt text only
//                                    // when first seen
//     methodology?, model, methodology?,
//     input_tokens, output_tokens, cost_usd, latency_ms?,
//     status,                         // 'ok' | 'parse_failed' | 'execution_failed'
//     error_detail?
//   }
//
// Response: { id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  let client;
  try {
    const b = req.body || {};

    const orgId      = requireInt(b.org_id, 'org_id');
    const skillName  = String(b.skill_name || '').trim();
    if (!skillName) {
      return res.status(400).json({ error: { message: 'skill_name is required' } });
    }
    const status = String(b.status || '').trim();
    if (!['ok', 'parse_failed', 'execution_failed'].includes(status)) {
      return res.status(400).json({ error: { message: 'invalid status' } });
    }
    if (b.input_payload == null || typeof b.input_payload !== 'object') {
      return res.status(400).json({ error: { message: 'input_payload (object) is required' } });
    }

    const userId     = optionalInt(b.user_id, 'user_id');
    const prospectId = optionalInt(b.prospect_id, 'prospect_id');
    const dealId     = optionalInt(b.deal_id, 'deal_id');

    // Pull denormalized hook fields out of the output for cheap GROUP BY.
    // Tolerate any output shape — different skills emit different hook
    // structures. outreach-personalization uses {hook: {category, primary_signal_id}}.
    let hookCategory = null;
    let hookSignalId = null;
    if (b.output && typeof b.output === 'object') {
      hookCategory = b.output.hook?.category ?? null;
      hookSignalId = b.output.hook?.primary_signal_id ?? null;
    }

    client = await pool.connect();

    // RLS scope
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // Upsert the prompt version if both hash and text were sent. The runner
    // sends the text only on first encounter (it caches the hash locally);
    // subsequent runs send hash-only.
    let promptHash = b.prompt_hash || null;
    if (promptHash && b.prompt_text) {
      await client.query(
        `INSERT INTO skill_prompt_versions (hash, skill_name, prompt_text)
         VALUES ($1, $2, $3)
         ON CONFLICT (hash) DO NOTHING`,
        [promptHash, skillName, String(b.prompt_text)]
      );
    }
    // If hash given but text not, verify the row exists. If it doesn't,
    // null out the FK so the insert doesn't fail; the runner can re-send
    // the prompt on a later run.
    if (promptHash && !b.prompt_text) {
      const exists = await client.query(
        `SELECT 1 FROM skill_prompt_versions WHERE hash = $1`,
        [promptHash]
      );
      if (exists.rows.length === 0) promptHash = null;
    }

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
       )
       RETURNING id`,
      [
        orgId, userId, skillName, prospectId, dealId,
        JSON.stringify(b.input_payload), promptHash, b.methodology || null,
        b.output != null ? JSON.stringify(b.output) : null, b.raw_output || null,
        hookCategory, hookSignalId,
        String(b.model || 'unknown'),
        parseInt(b.input_tokens, 10) || 0,
        parseInt(b.output_tokens, 10) || 0,
        Number(b.cost_usd) || 0,
        b.latency_ms != null ? parseInt(b.latency_ms, 10) : null,
        status, b.error_detail || null,
      ]
    );

    res.json({ id: ins.rows[0].id });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: { message: err.message } });
    console.error('skill-runs POST failed:', err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    if (client) client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/skill-runs?org_id=&skill_name=&hook=&limit=&before_id=
//
// Lists runs, newest-first. `before_id` enables keyset pagination — pass
// the smallest id from the previous page to fetch the next page.
//
// Response: { runs: [...], next_before_id: number|null }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  let client;
  try {
    const orgId    = requireInt(req.query.org_id, 'org_id');
    const skill    = req.query.skill_name ? String(req.query.skill_name).trim() : null;
    const hook     = req.query.hook ? String(req.query.hook).trim() : null;
    const beforeId = optionalInt(req.query.before_id, 'before_id');
    let   limit    = parseInt(req.query.limit, 10) || 50;
    if (limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    client = await pool.connect();
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // Build the WHERE clause dynamically. RLS already enforces org_id, but
    // including it explicitly makes the index choice obvious to the planner.
    const where = ['org_id = $1'];
    const params = [orgId];
    let p = 2;
    if (skill)    { where.push(`skill_name = $${p}`);    params.push(skill);    p++; }
    if (hook)     { where.push(`hook_category = $${p}`); params.push(hook);     p++; }
    if (beforeId) { where.push(`id < $${p}`);            params.push(beforeId); p++; }

    const sql = `
      SELECT id, org_id, user_id, skill_name, prospect_id, deal_id,
             methodology, hook_category, hook_signal_id,
             model, input_tokens, output_tokens, cost_usd, latency_ms,
             status, error_detail, created_at,
             -- Lightweight summary fields pulled from the JSONB. Keeping
             -- the heavy payload out of list responses; detail endpoint
             -- returns the full thing.
             input_payload->'prospect'->>'name'    AS prospect_name,
             input_payload->'prospect'->>'title'   AS prospect_title,
             input_payload->'prospect'->>'company' AS prospect_company,
             jsonb_array_length(COALESCE(input_payload->'signals'->'linkedin_activity'->'posts', '[]'::jsonb))   AS posts_n,
             jsonb_array_length(COALESCE(input_payload->'signals'->'linkedin_activity'->'comments', '[]'::jsonb)) AS comments_n,
             jsonb_array_length(COALESCE(input_payload->'signals'->'account_events', '[]'::jsonb))                AS account_events_n,
             jsonb_array_length(COALESCE(input_payload->'account'->'tech_stack', '[]'::jsonb))                    AS tech_stack_n
        FROM skill_runs
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    const r = await client.query(sql, params);

    const next_before_id = r.rows.length === limit
      ? r.rows[r.rows.length - 1].id
      : null;

    res.json({ runs: r.rows, next_before_id });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: { message: err.message } });
    console.error('skill-runs GET failed:', err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    if (client) client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/skill-runs/summary?org_id=&skill_name=&since_days=
//
// Aggregate stats for the runs UI's summary card.
//
// Returns:
//   {
//     total_runs,
//     hook_distribution: { prospect_post: N, account_event: M, ... },
//     // Conditional: rows where the named hook category WAS available
//     // in the input but the model picked something else.
//     bypassed_when_available: {
//       account_event_present: { picked: { ... } },
//       tech_stack_present:    { picked: { ... } },
//       recent_post_only:      { picked: { ... } }
//     },
//     status_distribution: { ok: N, parse_failed: M, execution_failed: K },
//     total_cost_usd, total_input_tokens, total_output_tokens
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  let client;
  try {
    const orgId = requireInt(req.query.org_id, 'org_id');
    const skill = req.query.skill_name ? String(req.query.skill_name).trim() : null;
    const sinceDays = parseInt(req.query.since_days, 10);

    const where = ['org_id = $1'];
    const params = [orgId];
    let p = 2;
    if (skill)               { where.push(`skill_name = $${p}`);                                      params.push(skill);     p++; }
    if (Number.isInteger(sinceDays) && sinceDays > 0) {
      where.push(`created_at > now() - ($${p} || ' days')::interval`);
      params.push(String(sinceDays));
      p++;
    }
    const W = where.join(' AND ');

    client = await pool.connect();
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    // 1. Top-line totals + hook + status distributions
    const totalsSql = `
      SELECT
        COUNT(*)                              AS total_runs,
        COALESCE(SUM(input_tokens), 0)        AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)       AS total_output_tokens,
        COALESCE(SUM(cost_usd), 0)            AS total_cost_usd
        FROM skill_runs WHERE ${W}
    `;
    const totalsRes = await client.query(totalsSql, params);

    const hookSql = `
      SELECT COALESCE(hook_category, '__null__') AS hook_category, COUNT(*) AS n
        FROM skill_runs WHERE ${W}
       GROUP BY hook_category
    `;
    const hookRes = await client.query(hookSql, params);
    const hook_distribution = {};
    for (const r of hookRes.rows) hook_distribution[r.hook_category] = parseInt(r.n, 10);

    const statusSql = `
      SELECT status, COUNT(*) AS n
        FROM skill_runs WHERE ${W}
       GROUP BY status
    `;
    const statusRes = await client.query(statusSql, params);
    const status_distribution = {};
    for (const r of statusRes.rows) status_distribution[r.status] = parseInt(r.n, 10);

    // 2. Conditional distributions — the diagnostic view.
    //
    // For each "what hook was picked when category X was available" question,
    // we need a per-row test for availability and then a GROUP BY hook_category.
    //
    // Three conditions, each producing one breakdown:
    //   A. account_event was available → picked what?
    //   B. tech_stack was available    → picked what?
    //   C. ONLY a post was available   → confirms the post-bias baseline
    //                                     (sanity check; should overwhelmingly
    //                                     show prospect_post)
    const condSql = `
      SELECT 'account_event_present' AS cond, COALESCE(hook_category,'__null__') AS picked, COUNT(*) AS n
        FROM skill_runs
       WHERE ${W}
         AND jsonb_array_length(COALESCE(input_payload->'signals'->'account_events','[]'::jsonb)) > 0
       GROUP BY hook_category
      UNION ALL
      SELECT 'tech_stack_present', COALESCE(hook_category,'__null__'), COUNT(*)
        FROM skill_runs
       WHERE ${W}
         AND jsonb_array_length(COALESCE(input_payload->'account'->'tech_stack','[]'::jsonb)) > 0
       GROUP BY hook_category
      UNION ALL
      SELECT 'recent_post_only', COALESCE(hook_category,'__null__'), COUNT(*)
        FROM skill_runs
       WHERE ${W}
         AND jsonb_array_length(COALESCE(input_payload->'signals'->'linkedin_activity'->'posts','[]'::jsonb)) > 0
         AND jsonb_array_length(COALESCE(input_payload->'signals'->'account_events','[]'::jsonb)) = 0
         AND jsonb_array_length(COALESCE(input_payload->'account'->'tech_stack','[]'::jsonb)) = 0
       GROUP BY hook_category
    `;
    const condRes = await client.query(condSql, params);
    const bypassed_when_available = {
      account_event_present: { picked: {} },
      tech_stack_present:    { picked: {} },
      recent_post_only:      { picked: {} },
    };
    for (const r of condRes.rows) {
      bypassed_when_available[r.cond].picked[r.picked] = parseInt(r.n, 10);
    }

    res.json({
      total_runs:          parseInt(totalsRes.rows[0].total_runs, 10),
      total_input_tokens:  parseInt(totalsRes.rows[0].total_input_tokens, 10),
      total_output_tokens: parseInt(totalsRes.rows[0].total_output_tokens, 10),
      total_cost_usd:      Number(totalsRes.rows[0].total_cost_usd),
      hook_distribution,
      status_distribution,
      bypassed_when_available,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: { message: err.message } });
    console.error('skill-runs summary failed:', err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    if (client) client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/skill-runs/:id?org_id=&include_prompt=1
//
// Single run, full payload + output. include_prompt=1 also joins the
// assembled system prompt text (potentially large).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  let client;
  try {
    const id    = requireInt(req.params.id, 'id');
    const orgId = requireInt(req.query.org_id, 'org_id');
    const includePrompt = req.query.include_prompt === '1';

    client = await pool.connect();
    await client.query(
      `SELECT set_config('app.current_org_id', $1::text, true)`,
      [String(orgId)]
    );

    const sql = includePrompt
      ? `SELECT r.*, v.prompt_text
           FROM skill_runs r
           LEFT JOIN skill_prompt_versions v ON v.hash = r.prompt_hash
          WHERE r.id = $1`
      : `SELECT * FROM skill_runs WHERE id = $1`;
    const r = await client.query(sql, [id]);

    if (r.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Run not found' } });
    }
    res.json(r.rows[0]);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: { message: err.message } });
    console.error('skill-runs detail failed:', err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
