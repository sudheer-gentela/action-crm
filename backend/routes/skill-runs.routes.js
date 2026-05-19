// ============================================================================
// routes/skill-runs.routes.js
//
// Skill-run analytics endpoints (read-only). As of the 2026 skills
// integration, skill execution lives inside GoWarmCRM (SkillRunnerService
// writes skill_runs directly), so the old token-authed POST ingest endpoint
// is gone. These three GETs power the future "Skill runs" admin/analytics UI.
//
//   GET /api/skill-runs                  - list recent runs (keyset paginated)
//   GET /api/skill-runs/summary          - hook + status distributions
//   GET /api/skill-runs/:id              - single run, full payload + output
//
// Auth: normal user JWT + orgContext. org_id is taken from the authenticated
// session (req.orgId) — NOT a query param, and NOT the retired
// SKILL_RUNNER_TOKEN shared secret.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

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

function requireIntParam(value, name) {
  if (value == null || value === '' || !/^\d+$/.test(String(value))) {
    const e = new Error(`${name} must be a positive integer`);
    e.statusCode = 400;
    throw e;
  }
  return parseInt(String(value), 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/skill-runs?skill_name=&hook=&limit=&before_id=
// Lists runs for the caller's org, newest-first. `before_id` enables keyset
// pagination — pass the smallest id from the previous page.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  let client;
  try {
    const orgId    = req.orgId;
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
// GET /api/skill-runs/summary?skill_name=&since_days=
// Aggregate stats for the runs UI summary card: hook distribution, status
// distribution, and the "hook bypassed when available" diagnostic.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  let client;
  try {
    const orgId = req.orgId;
    const skill = req.query.skill_name ? String(req.query.skill_name).trim() : null;
    const sinceDays = parseInt(req.query.since_days, 10);

    const where = ['org_id = $1'];
    const params = [orgId];
    let p = 2;
    if (skill) { where.push(`skill_name = $${p}`); params.push(skill); p++; }
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

    const totalsRes = await client.query(`
      SELECT
        COUNT(*)                       AS total_runs,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cost_usd), 0)     AS total_cost_usd
        FROM skill_runs WHERE ${W}
    `, params);

    const hookRes = await client.query(`
      SELECT COALESCE(hook_category, '__null__') AS hook_category, COUNT(*) AS n
        FROM skill_runs WHERE ${W}
       GROUP BY hook_category
    `, params);
    const hook_distribution = {};
    for (const r of hookRes.rows) hook_distribution[r.hook_category] = parseInt(r.n, 10);

    const statusRes = await client.query(`
      SELECT status, COUNT(*) AS n
        FROM skill_runs WHERE ${W}
       GROUP BY status
    `, params);
    const status_distribution = {};
    for (const r of statusRes.rows) status_distribution[r.status] = parseInt(r.n, 10);

    const condRes = await client.query(`
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
    `, params);
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
// GET /api/skill-runs/:id?include_prompt=1
// Single run, full payload + output. Scoped to the caller's org so a run from
// another tenant can't be read by guessing its id.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  let client;
  try {
    const id    = requireIntParam(req.params.id, 'id');
    const orgId = req.orgId;
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
          WHERE r.id = $1 AND r.org_id = $2`
      : `SELECT * FROM skill_runs WHERE id = $1 AND org_id = $2`;
    const r = await client.query(sql, [id, orgId]);

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
