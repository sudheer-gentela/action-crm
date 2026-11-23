/**
 * services/research/ResearchPipelineService.js
 *
 * Phase 1, step 1.1b — which prospects get researched, the background run,
 * and a person's sign-off. Columns: migration 2026_147 (see its header for the
 * research_status lifecycle).
 *
 * HOW A PROSPECT GETS FLAGGED
 *   - At intake (manual create, CSV, HubSpot forms): a fit check runs —
 *     ProspectClassifier + FitGate with the org/user/campaign rules, the same
 *     code the outreach skill uses. Anything not 'disqualified' is flagged.
 *     At intake most results are 'weak' (company size/industry usually
 *     unknown yet) and weak still passes; the result is stored either way so
 *     a person sees why a prospect wasn't flagged and can flag it anyway.
 *   - Extension captures: flagged without a fit check — someone chose them.
 *   - CRM sync and the network job-change play do NOT call onIntake: they can
 *     create hundreds of prospects at once.
 *   - By hand (list selection bar, prospect panel) and by the agent (MCP,
 *     step 1.5). The agent may have at most `agent_pending_cap` (default 25)
 *     prospects per user waiting on a person.
 *   - The org switch research_auto_flag (default on) turns intake and
 *     extension flagging off; manual and agent flagging still work.
 *
 * BACKGROUND RUN (jobs/researchSweeper.js, every minute)
 *   - Waits FLAG_DELAY_MINUTES after flagging, so the extension's LinkedIn
 *     upsert (sent just after it creates the prospect) lands first.
 *   - Claims up to `limit` due rows, at most PER_OWNER_PER_RUN per owner so
 *     one person's 500-row import can't starve everyone else, with
 *     FOR UPDATE SKIP LOCKED so two processes never take the same row.
 *   - Runs research as the prospect OWNER (their model settings, keys and
 *     daily budget).
 *   - Budget reached  → back to queued until the owner's budget resets; the
 *                       owner's other queued rows move to the same time.
 *     Kill switch off → back to queued, all of the org's rows retry in 30 min.
 *     No AI on plan   → failed (flagging can't help until the plan changes).
 *     Other errors    → retry with backoff, failed after MAX_ATTEMPTS.
 *     Pauses don't count as attempts.
 *   - A run that died mid-research (process restart) is put back after
 *     STUCK_MINUTES.
 *   - Owners get "N prospects ready for review" at most once an hour.
 *
 * SIGN-OFF
 *   Approve = the existing POST /:id/approve-research (target → research),
 *   which now also records research_review_outcome='approved'.
 *   Reject  = rejectResearch(): reason required; stage unchanged; stored in
 *   the research_review_* fields only — never disqualified_reason_code or
 *   revisit_disposition (see migration header for why).
 */

const db = require('../../config/database');
const ProspectClassifier = require('../ProspectClassifier');
const FitGate = require('../FitGate');
const {
  resolveTitleClassifierConfig,
  resolveFitRulesConfig,
} = require('../SkillContextService');

const FLAG_DELAY_MINUTES   = 2;
const MAX_ATTEMPTS         = 3;
const RETRY_BASE_MINUTES   = 5;       // 5, 10 … between failed attempts
const KILL_SWITCH_RETRY_MIN = 30;
const STUCK_MINUTES        = 15;
const PER_OWNER_PER_RUN    = 2;
const READY_NOTIFY_MINUTES = 60;

const DEFAULT_AGENT_PENDING_CAP = 25;
const MAX_AGENT_PENDING_CAP     = 500;
const MAX_FLAG_BATCH            = 500;
const PRE_OUTREACH_STAGES       = ['target', 'research'];
const PENDING_STATUSES          = ['queued', 'researching', 'ready_for_review'];

// Sources the Chrome extension sends on POST /api/prospects.
const EXTENSION_SOURCES = new Set([
  'linkedin_extension', 'sales_navigator_extension', 'sales_navigator_list',
]);

function svcError(statusCode, code, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

function toIdList(ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  return [...new Set(arr.map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0))];
}

// ── Settings ───────────────────────────────────────────────────────────────

async function getSettings(orgId) {
  const r = await db.query(`SELECT ai_settings FROM org_action_config WHERE org_id = $1`, [orgId]);
  const ai = r.rows[0]?.ai_settings || {};
  const cap = parseInt(ai.agent_pending_cap, 10);
  return {
    research_auto_flag: ai.research_auto_flag !== false,                     // default on
    agent_pending_cap:  Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_AGENT_PENDING_CAP,
  };
}

async function saveSettings(orgId, input, updatedBy) {
  const patch = {};
  if (input && 'research_auto_flag' in input) {
    if (typeof input.research_auto_flag !== 'boolean') {
      throw svcError(400, 'INVALID_INPUT', 'research_auto_flag must be true or false.');
    }
    patch.research_auto_flag = input.research_auto_flag;
  }
  if (input && 'agent_pending_cap' in input) {
    const n = Number(input.agent_pending_cap);
    if (!Number.isInteger(n) || n < 0 || n > MAX_AGENT_PENDING_CAP) {
      throw svcError(400, 'INVALID_INPUT', `Agent cap must be a whole number from 0 to ${MAX_AGENT_PENDING_CAP}.`);
    }
    patch.agent_pending_cap = n;
  }
  if (!Object.keys(patch).length) throw svcError(400, 'INVALID_INPUT', 'Nothing to save.');

  await db.query(
    `INSERT INTO org_action_config (org_id, ai_settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (org_id) DO UPDATE
       SET ai_settings = org_action_config.ai_settings || $2::jsonb,
           updated_by  = $3,
           updated_at  = NOW()`,
    [orgId, JSON.stringify(patch), updatedBy]
  );
  return getSettings(orgId);
}

// ── Fit check ──────────────────────────────────────────────────────────────

/**
 * Same inputs the outreach skill's fit gate uses: classifier + fit rules
 * layered org → user (owner) → campaign; industry/size/location from the
 * linked account, falling back to the prospect's own company_* columns
 * (at intake the account is often brand new and empty).
 */
async function checkFit(orgId, prospectId) {
  const r = await db.query(
    `SELECT p.id, p.title, p.owner_id, p.campaign_id,
            p.company_industry, p.company_size, p.location,
            a.industry AS account_industry, a.size AS account_size, a.location AS account_location,
            o.settings->'prospecting_config'                       AS org_cfg,
            up.preferences->'prospecting_config'                   AS user_cfg,
            c.prospecting_config_override                          AS camp_cfg
       FROM prospects p
       LEFT JOIN accounts a              ON a.id = p.account_id
       LEFT JOIN organizations o         ON o.id = p.org_id
       LEFT JOIN user_preferences up     ON up.user_id = p.owner_id AND up.org_id = p.org_id
       LEFT JOIN prospecting_campaigns c ON c.id = p.campaign_id AND c.org_id = p.org_id
      WHERE p.id = $1 AND p.org_id = $2 AND p.deleted_at IS NULL`,
    [prospectId, orgId]
  );
  const row = r.rows[0];
  if (!row) return null;

  const classifierCfg = resolveTitleClassifierConfig(row.org_cfg, row.user_cfg, row.camp_cfg);
  const fitRules      = resolveFitRulesConfig(row.org_cfg, row.user_cfg, row.camp_cfg);
  const cls = ProspectClassifier.classifyTitle(row.title, classifierCfg);
  const facts = {
    title:          row.title || null,
    function:       cls.function,
    seniority:      cls.seniority,
    decision_maker: cls.decision_maker,
    industry:       row.account_industry || row.company_industry || null,
    size:           row.account_size     || row.company_size     || null,
    location:       row.account_location || row.location         || null,
  };
  const fit = FitGate.assessFit(facts, fitRules);
  return {
    verdict:    fit.verdict,
    reasons:    fit.reasons || [],
    unknown:    fit.unknown || [],
    function:   cls.function,
    seniority:  cls.seniority,
    checked_at: new Date().toISOString(),
  };
}

// ── Flagging ───────────────────────────────────────────────────────────────

// One place that sets a row to queued, so every path clears the same fields.
const QUEUE_SET_SQL = `
  research_status          = 'queued',
  research_flag_source     = $3::varchar,
  research_flagged_by      = $4::int,
  research_flagged_at      = LOCALTIMESTAMP,
  research_attempts        = 0,
  research_next_attempt_at = LOCALTIMESTAMP + make_interval(mins => ${FLAG_DELAY_MINUTES}),
  research_started_at      = NULL,
  research_completed_at    = NULL,
  research_last_error      = NULL,
  research_review_outcome  = NULL,
  research_review_reason   = NULL,
  research_reviewed_by     = NULL,
  research_reviewed_at     = NULL,
  updated_at               = CURRENT_TIMESTAMP`;

/**
 * Called after a NEW prospect is inserted by an intake path. Never throws —
 * flagging is best-effort and must not fail the create.
 * Returns { flagged, reason, fit }.
 */
async function onIntake({ orgId, prospectId, source, userId }) {
  try {
    const settings = await getSettings(orgId);
    if (!settings.research_auto_flag) return { flagged: false, reason: 'auto_flag_off' };

    if (EXTENSION_SOURCES.has(String(source || ''))) {
      const r = await db.query(
        `UPDATE prospects SET ${QUEUE_SET_SQL}
          WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL AND research_status IS NULL
          RETURNING id`,
        [prospectId, orgId, 'extension', userId || null]
      );
      return { flagged: r.rows.length > 0, reason: 'extension' };
    }

    const fit = await checkFit(orgId, prospectId);
    if (!fit) return { flagged: false, reason: 'not_found' };

    if (fit.verdict === 'disqualified') {
      await db.query(
        `UPDATE prospects SET research_fit = $3::jsonb WHERE id = $1 AND org_id = $2`,
        [prospectId, orgId, JSON.stringify(fit)]
      );
      return { flagged: false, reason: 'fit_failed', fit };
    }
    const r = await db.query(
      `UPDATE prospects SET ${QUEUE_SET_SQL}, research_fit = $5::jsonb
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL AND research_status IS NULL
        RETURNING id`,
      [prospectId, orgId, 'intake', userId || null, JSON.stringify(fit)]
    );
    return { flagged: r.rows.length > 0, reason: 'fit_passed', fit };
  } catch (err) {
    console.warn(`[research] intake flag failed for prospect ${prospectId}:`, err.message);
    return { flagged: false, reason: 'error' };
  }
}

/** Sequential on purpose: a 500-row import shouldn't fan out 2,500 queries at once. */
async function onIntakeMany({ orgId, prospectIds, source, userId }) {
  const out = { flagged: 0, notFlagged: 0 };
  for (const id of toIdList(prospectIds)) {
    const r = await onIntake({ orgId, prospectId: id, source, userId });
    if (r.flagged) out.flagged++; else out.notFlagged++;
  }
  return out;
}

/** The agent's open work for one user: queued, researching or awaiting review. */
async function agentRoom(orgId, userId) {
  const settings = await getSettings(orgId);
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM prospects
      WHERE org_id = $1 AND owner_id = $2 AND deleted_at IS NULL
        AND research_status = ANY($3::text[])
        AND (created_via = 'agent' OR research_flag_source = 'agent')`,
    [orgId, userId, PENDING_STATUSES]
  );
  const pending = r.rows[0].n;
  return { cap: settings.agent_pending_cap, pending, room: Math.max(settings.agent_pending_cap - pending, 0) };
}

/**
 * Flag prospects for research by hand or by the agent.
 * Returns { flagged: [ids], skipped: [{ id, reason }], agent?: {cap,pending,room} }.
 *
 * Skips (with a reason) rather than failing the batch: not found, past the
 * research stages, already queued/researching, already waiting for review,
 * or — for the agent — over its cap.
 */
async function flagForResearch({ orgId, prospectIds, userId, source = 'manual' }) {
  if (!['manual', 'agent'].includes(source)) throw svcError(400, 'INVALID_INPUT', 'Invalid flag source.');
  const ids = toIdList(prospectIds);
  if (!ids.length) throw svcError(400, 'INVALID_INPUT', 'Choose at least one prospect.');
  if (ids.length > MAX_FLAG_BATCH) throw svcError(400, 'INVALID_INPUT', `At most ${MAX_FLAG_BATCH} at a time.`);

  const rows = (await db.query(
    `SELECT id, stage, research_status, owner_id FROM prospects
      WHERE org_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
    [orgId, ids]
  )).rows;
  const byId = new Map(rows.map(r => [r.id, r]));

  const skipped = [];
  let eligible = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r)                                              skipped.push({ id, reason: 'not_found' });
    else if (!PRE_OUTREACH_STAGES.includes(r.stage))     skipped.push({ id, reason: 'past_research_stage' });
    else if (['queued', 'researching'].includes(r.research_status)) skipped.push({ id, reason: 'already_queued' });
    else if (r.research_status === 'ready_for_review')   skipped.push({ id, reason: 'awaiting_review' });
    else eligible.push(id);
  }

  let agent;
  if (source === 'agent') {
    // The cap is per user (the agent acts as `userId`) and counts only the
    // agent's open work on prospects that user owns.
    agent = await agentRoom(orgId, userId);
    const notOwned = eligible.filter(id => byId.get(id).owner_id !== userId);
    for (const id of notOwned) skipped.push({ id, reason: 'not_owner' });
    eligible = eligible.filter(id => byId.get(id).owner_id === userId);
    if (eligible.length > agent.room) {
      for (const id of eligible.slice(agent.room)) skipped.push({ id, reason: 'agent_cap_reached' });
      eligible = eligible.slice(0, agent.room);
    }
  }

  let flagged = [];
  if (eligible.length) {
    // Status re-checked in the WHERE so a row claimed between the read and
    // this write isn't re-queued.
    const r = await db.query(
      `UPDATE prospects SET ${QUEUE_SET_SQL}
        WHERE org_id = $2 AND id = ANY($1::int[]) AND deleted_at IS NULL
          AND stage = ANY($5::text[])
          AND (research_status IS NULL OR research_status IN ('failed','reviewed'))
        RETURNING id`,
      [eligible, orgId, source, userId, PRE_OUTREACH_STAGES]
    );
    flagged = r.rows.map(x => x.id);
    for (const id of eligible) if (!flagged.includes(id)) skipped.push({ id, reason: 'changed_meanwhile' });
  }

  if (flagged.length) {
    await logActivities(orgId, flagged, userId, 'research_flagged',
      source === 'agent' ? 'Flagged for research by the agent' : 'Flagged for research', { source });
  }
  if (agent) agent = await agentRoom(orgId, userId);
  return { flagged, skipped, ...(agent ? { agent } : {}) };
}

/** Un-flag: only while still waiting to run, or after it failed. */
async function unflagResearch({ orgId, prospectIds, userId }) {
  const ids = toIdList(prospectIds);
  if (!ids.length) throw svcError(400, 'INVALID_INPUT', 'Choose at least one prospect.');
  const r = await db.query(
    `UPDATE prospects
        SET research_status = NULL, research_flag_source = NULL, research_flagged_by = NULL,
            research_flagged_at = NULL, research_next_attempt_at = NULL, research_attempts = 0,
            research_last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE org_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL
        AND research_status IN ('queued','failed')
      RETURNING id`,
    [orgId, ids]
  );
  const done = r.rows.map(x => x.id);
  if (done.length) await logActivities(orgId, done, userId, 'research_unflagged', 'Research flag removed', {});
  return { unflagged: done, skipped: ids.filter(id => !done.includes(id)) };
}

// ── Review ─────────────────────────────────────────────────────────────────

/**
 * Reject the research (not the prospect). Stage stays where it is; the
 * prospect leaves the review queue and can be flagged again later.
 */
async function rejectResearch({ orgId, prospectId, userId, reason }) {
  const why = typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';
  if (!why) throw svcError(400, 'REASON_REQUIRED', 'Say briefly what was wrong with the research.');

  const r = await db.query(
    `UPDATE prospects
        SET research_status = 'reviewed',
            research_review_outcome = 'rejected',
            research_review_reason  = $3,
            research_reviewed_by    = $4,
            research_reviewed_at    = LOCALTIMESTAMP,
            updated_at              = CURRENT_TIMESTAMP
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
        AND research_status IN ('ready_for_review','failed')
      RETURNING id, stage, research_flag_source, created_via`,
    [prospectId, orgId, why, userId]
  );
  if (!r.rows.length) {
    const exists = await db.query(
      `SELECT research_status FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, orgId]
    );
    if (!exists.rows.length) throw svcError(404, 'NOT_FOUND', 'Prospect not found');
    throw svcError(409, 'NOT_AWAITING_REVIEW', 'This prospect has no research waiting for review.');
  }
  const row = r.rows[0];
  await logActivities(orgId, [prospectId], userId, 'research_rejected', 'Research rejected by reviewer', {
    reason: why, flag_source: row.research_flag_source, created_via: row.created_via,
  });
  return { prospectId, stage: row.stage, researchStatus: 'reviewed', outcome: 'rejected', reason: why };
}

// ── Review list ────────────────────────────────────────────────────────────

/**
 * Prospects waiting on a person, newest research first, plus counts per
 * status for the same scope. scope 'mine' = owned by userId; 'all' = org.
 */
async function listForReview({ orgId, userId, scope = 'mine', campaignId = null, limit = 20, offset = 0 }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const params = [orgId];
  let where = `p.org_id = $1 AND p.deleted_at IS NULL`;
  if (scope !== 'all') { params.push(userId); where += ` AND p.owner_id = $${params.length}`; }
  if (campaignId)      { params.push(parseInt(campaignId, 10)); where += ` AND p.campaign_id = $${params.length}`; }

  const countsRes = await db.query(
    `SELECT research_status AS status, COUNT(*)::int AS n
       FROM prospects p
      WHERE ${where} AND p.research_status IN ('queued','researching','ready_for_review','failed')
      GROUP BY 1`,
    params
  );
  const counts = { queued: 0, researching: 0, ready_for_review: 0, failed: 0 };
  for (const c of countsRes.rows) counts[c.status] = c.n;

  const listParams = [...params, lim, off];
  const rows = (await db.query(
    `SELECT p.id, p.first_name, p.last_name, p.email, p.linkedin_url, p.title,
            p.company_name, p.company_industry, p.stage, p.stage_changed_at,
            p.campaign_id, p.owner_id, p.created_at, p.created_via,
            p.research_notes, p.research_meta, p.research_status, p.research_flag_source,
            p.research_flagged_at, p.research_completed_at, p.research_fit,
            c.name AS campaign_name,
            a.research_notes AS account_research,
            lp.last_captured_at          AS linkedin_captured_at,
            lp.last_activity_captured_at AS linkedin_activity_captured_at
       FROM prospects p
  LEFT JOIN prospecting_campaigns c ON c.id = p.campaign_id
  LEFT JOIN accounts a              ON a.id = p.account_id
  LEFT JOIN linkedin_profiles lp
         ON lp.org_id = p.org_id AND lp.deleted_at IS NULL
        AND lp.linkedin_slug = LOWER(SUBSTRING(p.linkedin_url FROM '/in/([^/?#]+)'))
      WHERE ${where} AND p.research_status = 'ready_for_review'
   ORDER BY p.research_completed_at DESC NULLS LAST, p.id DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  )).rows;

  return {
    scope: scope === 'all' ? 'all' : 'mine',
    counts,
    total: counts.ready_for_review,
    limit: lim,
    offset: off,
    prospects: rows.map(r => ({
      id:              r.id,
      firstName:       r.first_name,
      lastName:        r.last_name,
      email:           r.email,
      linkedinUrl:     r.linkedin_url,
      title:           r.title,
      companyName:     r.company_name,
      companyIndustry: r.company_industry,
      stage:           r.stage,
      stageChangedAt:  r.stage_changed_at,
      campaignId:      r.campaign_id,
      campaignName:    r.campaign_name,
      ownerId:         r.owner_id,
      createdAt:       r.created_at,
      createdVia:      r.created_via,
      researchNotes:   r.research_notes,
      researchMeta:    r.research_meta,
      researchStatus:  r.research_status,
      researchFlagSource:  r.research_flag_source,
      researchFlaggedAt:   r.research_flagged_at,
      researchCompletedAt: r.research_completed_at,
      researchFit:     r.research_fit,
      accountResearch: r.account_research,
      linkedinCapturedAt:         r.linkedin_captured_at,
      linkedinActivityCapturedAt: r.linkedin_activity_captured_at,
    })),
  };
}

// ── Background run ─────────────────────────────────────────────────────────

/** Put back rows whose run died mid-research (restart, crash). */
async function recoverStuck() {
  const r = await db.query(
    `UPDATE prospects
        SET research_status = CASE WHEN research_attempts >= $1 THEN 'failed' ELSE 'queued' END,
            research_last_error = CASE WHEN research_attempts >= $1
                                       THEN 'Research was interrupted too many times'
                                       ELSE research_last_error END,
            research_next_attempt_at = LOCALTIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE research_status = 'researching' AND deleted_at IS NULL
        AND research_started_at < LOCALTIMESTAMP - make_interval(mins => $2)
      RETURNING id`,
    [MAX_ATTEMPTS, STUCK_MINUTES]
  );
  return r.rows.length;
}

/** Queued rows whose prospect has moved past research no longer need it. */
async function dropOutdated() {
  const r = await db.query(
    `UPDATE prospects
        SET research_status = NULL, research_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE research_status = 'queued' AND deleted_at IS NULL
        AND NOT (stage = ANY($1::text[]))
      RETURNING id`,
    [PRE_OUTREACH_STAGES]
  );
  return r.rows.length;
}

/**
 * Claim up to `limit` due rows (at most PER_OWNER_PER_RUN per owner).
 * Two steps because Postgres won't combine FOR UPDATE with window functions:
 * pick fair candidates, then lock whichever of them nobody else holds.
 */
async function claimDue(limit = 5) {
  const r = await db.query(
    `WITH candidates AS (
       SELECT id FROM (
         SELECT id, research_next_attempt_at,
                ROW_NUMBER() OVER (PARTITION BY org_id, owner_id
                                   ORDER BY research_next_attempt_at, id) AS rn
           FROM prospects
          WHERE research_status = 'queued' AND deleted_at IS NULL
            AND research_next_attempt_at <= LOCALTIMESTAMP
            AND stage = ANY($3::text[])
       ) x
       WHERE rn <= $2
       ORDER BY research_next_attempt_at, id
       LIMIT $1 * 4
     ),
     locked AS (
       SELECT p.id FROM prospects p
        WHERE p.id IN (SELECT id FROM candidates)
          AND p.research_status = 'queued'
        ORDER BY p.research_next_attempt_at, p.id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE prospects p
        SET research_status = 'researching',
            research_started_at = LOCALTIMESTAMP,
            research_attempts = research_attempts + 1,
            updated_at = CURRENT_TIMESTAMP
       FROM locked
      WHERE p.id = locked.id
  RETURNING p.id, p.org_id, p.owner_id, p.research_attempts`,
    [limit, PER_OWNER_PER_RUN, PRE_OUTREACH_STAGES]
  );
  return r.rows;
}

async function _requeue(id, { at = null, inMinutes = null, error = null, countAttempt = true }) {
  await db.query(
    `UPDATE prospects
        SET research_status = 'queued',
            research_next_attempt_at = CASE
              WHEN $2::timestamptz IS NOT NULL THEN ($2::timestamptz AT TIME ZONE 'UTC')
              ELSE LOCALTIMESTAMP + make_interval(mins => $3::int) END,
            research_attempts = CASE WHEN $5 THEN research_attempts ELSE GREATEST(research_attempts - 1, 0) END,
            research_last_error = $4,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND research_status = 'researching'`,
    [id, at, inMinutes ?? 0, error, countAttempt]
  );
}

/** Process one claimed row. Returns 'ready' | 'paused' | 'retry' | 'failed' | 'gone'. */
async function processClaimed(row, researchFn) {
  try {
    await researchFn({ orgId: row.org_id, prospectId: row.id, actorUserId: row.owner_id, trigger: 'pipeline' });
    return 'ready';
  } catch (err) {
    const msg = String(err.message || err).slice(0, 500);

    if (err.code === 'AI_DAILY_BUDGET_REACHED') {
      const at = err.resetsAt || null;
      await _requeue(row.id, { at, inMinutes: at ? null : 60, error: msg, countAttempt: false });
      // Park the owner's other due rows too, so each sweep doesn't claim and
      // bounce them one by one until midnight.
      if (at) {
        await db.query(
          `UPDATE prospects
              SET research_next_attempt_at = ($3::timestamptz AT TIME ZONE 'UTC')
            WHERE org_id = $1 AND owner_id = $2 AND research_status = 'queued' AND deleted_at IS NULL
              AND research_next_attempt_at < ($3::timestamptz AT TIME ZONE 'UTC')`,
          [row.org_id, row.owner_id, at]
        );
      }
      return 'paused';
    }
    if (err.code === 'AI_DISABLED_BY_ORG') {
      await _requeue(row.id, { inMinutes: KILL_SWITCH_RETRY_MIN, error: msg, countAttempt: false });
      await db.query(
        `UPDATE prospects
            SET research_next_attempt_at = LOCALTIMESTAMP + make_interval(mins => $2)
          WHERE org_id = $1 AND research_status = 'queued' AND deleted_at IS NULL
            AND research_next_attempt_at < LOCALTIMESTAMP + make_interval(mins => $2)`,
        [row.org_id, KILL_SWITCH_RETRY_MIN]
      );
      return 'paused';
    }
    if (err.statusCode === 404) {
      await db.query(
        `UPDATE prospects SET research_status = NULL WHERE id = $1 AND research_status = 'researching'`,
        [row.id]
      );
      return 'gone';
    }
    if (err.code === 'ENTITLEMENT_REQUIRED' || row.research_attempts >= MAX_ATTEMPTS) {
      await db.query(
        `UPDATE prospects
            SET research_status = 'failed', research_last_error = $2,
                research_next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND research_status = 'researching'`,
        [row.id, msg]
      );
      return 'failed';
    }
    await _requeue(row.id, { inMinutes: RETRY_BASE_MINUTES * row.research_attempts, error: msg, countAttempt: true });
    return 'retry';
  }
}

/**
 * Tell owners research is ready — once an hour at most, with the count
 * waiting for them right now (not just this run's).
 */
async function notifyReady(orgOwnerPairs) {
  if (!orgOwnerPairs.length) return 0;
  const { createNotification } = require('../notificationService');
  let sent = 0;
  for (const { orgId, ownerId } of orgOwnerPairs) {
    try {
      const recent = await db.query(
        `SELECT 1 FROM notifications
          WHERE org_id = $1 AND user_id = $2 AND type = 'research_ready'
            AND created_at > NOW() - make_interval(mins => $3)
          LIMIT 1`,
        [orgId, ownerId, READY_NOTIFY_MINUTES]
      );
      if (recent.rows.length) continue;
      const c = await db.query(
        `SELECT COUNT(*)::int AS n FROM prospects
          WHERE org_id = $1 AND owner_id = $2 AND deleted_at IS NULL
            AND research_status = 'ready_for_review'`,
        [orgId, ownerId]
      );
      const n = c.rows[0].n;
      if (!n) continue;
      await createNotification(
        orgId, ownerId, 'research_ready',
        `${n} prospect${n === 1 ? '' : 's'} ready for research review`,
        'Background research has finished. Approve or reject it in Prospecting → Research → Ready for review.',
        null, null, { count: n }
      );
      sent++;
    } catch (err) {
      console.warn(`[research] ready notification failed (org ${orgId}, user ${ownerId}):`, err.message);
    }
  }
  return sent;
}

/**
 * One sweep. researchFn is injectable for tests; defaults to the real
 * ProspectResearchService (lazy so this file loads without the AI stack).
 */
async function runSweep({ limit = 5, researchFn = null } = {}) {
  const fn = researchFn || require('./ProspectResearchService').researchProspect;
  const recovered = await recoverStuck();
  const dropped   = await dropOutdated();
  const claimed   = await claimDue(limit);

  const tally = { claimed: claimed.length, ready: 0, paused: 0, retry: 0, failed: 0, gone: 0, recovered, dropped };
  const readyOwners = new Map();
  // Sequential: research is a handful of seconds per prospect and spreading
  // load over the minute is kinder to provider rate limits than a burst.
  for (const row of claimed) {
    const outcome = await processClaimed(row, fn);
    tally[outcome]++;
    if (outcome === 'ready') readyOwners.set(`${row.org_id}:${row.owner_id}`, { orgId: row.org_id, ownerId: row.owner_id });
  }
  tally.notified = await notifyReady([...readyOwners.values()]);
  return tally;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function logActivities(orgId, prospectIds, userId, type, description, metadata) {
  try {
    await db.query(
      `INSERT INTO prospecting_activities (org_id, prospect_id, user_id, activity_type, description, metadata)
       SELECT $1, x, $3, $4, $5, $6::jsonb FROM unnest($2::int[]) AS x`,
      [orgId, prospectIds, userId, type, description, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.warn(`[research] activity log (${type}) failed:`, err.message);
  }
}

module.exports = {
  FLAG_DELAY_MINUTES,
  MAX_ATTEMPTS,
  DEFAULT_AGENT_PENDING_CAP,
  EXTENSION_SOURCES,
  getSettings,
  saveSettings,
  checkFit,
  onIntake,
  onIntakeMany,
  agentRoom,
  flagForResearch,
  unflagResearch,
  rejectResearch,
  listForReview,
  recoverStuck,
  dropOutdated,
  claimDue,
  processClaimed,
  notifyReady,
  runSweep,
};
