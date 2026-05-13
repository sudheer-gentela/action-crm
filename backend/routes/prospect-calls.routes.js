/**
 * /api/prospect-calls
 *
 * Phase 1 endpoints for the call-logging capability.
 *
 *   POST   /                  Create a new call log
 *   GET    /?prospect_id=N    List calls for a prospect (newest first)
 *   GET    /:id               Fetch a single call by id
 *   PATCH  /:id               Edit fields (within the org's edit window)
 *
 * No DELETE endpoint in Phase 1 — soft-delete is a Phase 2 concern (the
 * mirror service has a cleanup function ready when we add it).
 *
 * Phase 2 will add the ability to POST with a sequence_step_log_id so a
 * sequence step task can flow into a call log + auto-advance the step.
 * Phase 3 will add a webhook endpoint for provider integrations.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');
const CallSettingsService     = require('../services/callSettings.service');
const CallOutcomeMirrorService = require('../services/callOutcomeMirror.service');
const SequenceStepAdvanceService = require('../services/sequenceStepAdvance.service');
const StaleCallsNotificationService = require('../services/staleCallsNotification.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── Helpers ─────────────────────────────────────────────────────────────────

// Hard caps on text fields to prevent runaway payloads.
const MAX_NOTES_LEN  = 8000;
const MAX_PHONE_LEN  = 64;

function clampStr(s, max) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) : str;
}

// Resolve the outcome label for a list of calls in one round-trip. Returns
// a map { outcome_key: label } so callers can decorate response payloads.
async function resolveOutcomeLabels(orgId, outcomeKeys) {
  const settings = await CallSettingsService.getForOrg(orgId);
  const map = {};
  for (const o of settings.outcomes) map[o.key] = o.label;
  // Calls in the DB MAY reference outcomes that have since been renamed or
  // removed. We surface a fallback ("(legacy: my_old_key)") so the UI still
  // shows something rather than a blank cell.
  for (const k of outcomeKeys) {
    if (!map[k]) map[k] = `(legacy: ${k})`;
  }
  return map;
}

// Validate POST body. Throws a 400-shaped error on failure.
async function validateCreatePayload(orgId, body) {
  const prospectId = parseInt(body.prospect_id, 10);
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    const e = new Error('prospect_id is required');     e.status = 400; throw e;
  }

  // resolveOutcome throws with code='INVALID_OUTCOME' for unknown keys.
  let outcome;
  try {
    outcome = await CallSettingsService.resolveOutcome(orgId, body.outcome);
  } catch (err) {
    err.status = 400;
    throw err;
  }

  // Direction defaults to outbound.
  const direction = body.direction || 'outbound';
  if (direction !== 'outbound' && direction !== 'inbound') {
    const e = new Error("direction must be 'outbound' or 'inbound'"); e.status = 400; throw e;
  }

  // Duration validation. For no_answer/wrong_number/gatekeeper outcomes we
  // reject duration since the call never connected. For other outcomes,
  // duration is optional but must be a positive integer if present.
  let durationSeconds = null;
  if (body.duration_seconds !== undefined && body.duration_seconds !== null) {
    const d = Number(body.duration_seconds);
    if (!Number.isInteger(d) || d < 0) {
      const e = new Error('duration_seconds must be a non-negative integer'); e.status = 400; throw e;
    }
    if (d > 0 && !CallSettingsService.outcomeAllowsDuration(outcome.key)) {
      const e = new Error(`duration_seconds is not allowed for outcome '${outcome.key}'`); e.status = 400; throw e;
    }
    durationSeconds = d || null;  // 0 is treated as null
  }

  // occurred_at defaults to now; we let the DB default fire when null.
  let occurredAt = null;
  if (body.occurred_at !== undefined && body.occurred_at !== null && body.occurred_at !== '') {
    const ts = new Date(body.occurred_at);
    if (isNaN(ts.getTime())) {
      const e = new Error('occurred_at must be a valid timestamp'); e.status = 400; throw e;
    }
    if (ts.getTime() > Date.now() + 60_000) {
      const e = new Error('occurred_at cannot be in the future'); e.status = 400; throw e;
    }
    occurredAt = ts.toISOString();
  }

  // callback_requested_at: only meaningful for outcome='callback_requested'.
  // Must be in the future (the prospect asked us to call back AT a future
  // time). For other outcomes, callback_requested_at is silently dropped
  // rather than rejected — the modal may include it accidentally if the
  // rep changes outcome mid-form.
  let callbackRequestedAt = null;
  if (outcome.key === 'callback_requested' &&
      body.callback_requested_at !== undefined &&
      body.callback_requested_at !== null &&
      body.callback_requested_at !== '') {
    const ts = new Date(body.callback_requested_at);
    if (isNaN(ts.getTime())) {
      const e = new Error('callback_requested_at must be a valid timestamp'); e.status = 400; throw e;
    }
    if (ts.getTime() < Date.now() - 60_000) {
      const e = new Error('callback_requested_at should be in the future'); e.status = 400; throw e;
    }
    callbackRequestedAt = ts.toISOString();
  }

  return {
    prospectId,
    outcome,
    direction,
    durationSeconds,
    occurredAt,
    callbackRequestedAt,
    notes:           clampStr(body.notes,      MAX_NOTES_LEN),
    phoneUsed:       clampStr(body.phone_used, MAX_PHONE_LEN),
    sequenceStepLogId: body.sequence_step_log_id ? parseInt(body.sequence_step_log_id, 10) : null,
  };
}


// ── POST / — create a new call log ──────────────────────────────────────────
router.post('/', async (req, res) => {
  let v;
  try {
    v = await validateCreatePayload(req.orgId, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: { message: err.message } });
  }

  // Verify the prospect exists and belongs to this org. We do this OUTSIDE
  // the transaction below so we can return a clean 404 before any writes.
  const pCheck = await db.query(
    `SELECT id, phone FROM prospects
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [v.prospectId, req.orgId]
  );
  if (pCheck.rows.length === 0) {
    return res.status(404).json({ error: { message: 'Prospect not found' } });
  }
  const prospectRow = pCheck.rows[0];

  // If phone_used wasn't provided, fall back to the prospect's current phone.
  // If neither is available, we still allow the call to be logged (some reps
  // may have called from their own records and only logged after the fact),
  // but phone_used will be null.
  const phoneUsed = v.phoneUsed || prospectRow.phone || null;

  // Run the insert + mirror writes in a single transaction.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO calls
         (org_id, prospect_id, user_id,
          occurred_at, direction, outcome,
          duration_seconds, notes, phone_used,
          sequence_step_log_id, callback_requested_at)
       VALUES ($1, $2, $3,
               COALESCE($4, CURRENT_TIMESTAMP), $5, $6,
               $7, $8, $9,
               $10, $11)
       RETURNING *`,
      [
        req.orgId,
        v.prospectId,
        req.user.userId,
        v.occurredAt,
        v.direction,
        v.outcome.key,
        v.durationSeconds,
        v.notes,
        phoneUsed,
        v.sequenceStepLogId,
        v.callbackRequestedAt,
      ]
    );
    const call = insertRes.rows[0];

    // Mirror writes (activity row, channel_data, counts).
    await CallOutcomeMirrorService.mirrorNewCall(client, call, v.outcome);

    // Phase 2: if this call was logged against a sequence step, advance
    // the step now (in the same transaction). Per product decision,
    // do_not_call outcome STILL advances the step — the sequence continues
    // to the next step regardless of outcome.
    let stepAdvanceResult = null;
    if (v.sequenceStepLogId) {
      try {
        stepAdvanceResult = await SequenceStepAdvanceService.advanceStep(
          client,
          v.sequenceStepLogId,
          req.orgId,
          req.user.userId,
        );
      } catch (advErr) {
        // STEP_LOG_NOT_FOUND is non-fatal — the rep may have logged a call
        // referencing a step that was deleted, or a typo on the client side.
        // We log it but don't fail the call insert; the call itself is valid.
        if (advErr.code === 'STEP_LOG_NOT_FOUND') {
          console.warn(`prospect-calls POST: step_log ${v.sequenceStepLogId} not found, call still saved`);
        } else {
          throw advErr;
        }
      }
    }

    await client.query('COMMIT');

    // Decorate response with the resolved label so the UI doesn't need a
    // second roundtrip to render the freshly-created row.
    return res.status(201).json({
      call: {
        ...call,
        outcome_label: v.outcome.label,
        outcome_group: v.outcome.group,
      },
      sequence_advanced: stepAdvanceResult?.advanced || false,
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    console.error('prospect-calls POST error:', err);
    return res.status(500).json({ error: { message: 'Failed to log call' } });
  } finally {
    try { client.release(); } catch (_) { /* swallow */ }
  }
});


// ── GET / — list calls for a prospect ───────────────────────────────────────
// Required query param: prospect_id. Newest first. Decorated with outcome
// labels resolved from the current org settings.
router.get('/', async (req, res) => {
  const prospectId = parseInt(req.query.prospect_id, 10);
  if (!Number.isInteger(prospectId) || prospectId <= 0) {
    return res.status(400).json({ error: { message: 'prospect_id query param is required' } });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  try {
    const r = await db.query(
      `SELECT pc.*,
              u.first_name || ' ' || u.last_name AS logged_by_name,
              u.email                            AS logged_by_email
         FROM calls pc
         LEFT JOIN users u ON u.id = pc.user_id
        WHERE pc.org_id = $1
          AND pc.prospect_id = $2
        ORDER BY pc.occurred_at DESC, pc.id DESC
        LIMIT $3`,
      [req.orgId, prospectId, limit]
    );

    const calls = r.rows;
    const outcomeKeys = [...new Set(calls.map(c => c.outcome))];
    const labelMap = await resolveOutcomeLabels(req.orgId, outcomeKeys);

    return res.json({
      calls: calls.map(c => ({
        ...c,
        outcome_label: labelMap[c.outcome],
      })),
    });
  } catch (err) {
    console.error('prospect-calls GET list error:', err);
    return res.status(500).json({ error: { message: 'Failed to fetch calls' } });
  }
});


// ── GET /scan-stale — trigger stale-call notification for current user ───────
// Frontend calls this on app load so reps get a heads-up if call tasks have
// piled up. Idempotent for the day (won't create a duplicate notification).
// Returns the stale count so the UI can also display it inline if useful.
router.get('/scan-stale', async (req, res) => {
  try {
    const result = await StaleCallsNotificationService.scanForUser(
      req.orgId,
      req.user.userId
    );
    return res.json(result);
  } catch (err) {
    console.error('prospect-calls GET /scan-stale error:', err);
    // Non-fatal — return empty but successful so the UI doesn't error out
    return res.json({ stale_count: 0, notification_created: false });
  }
});


// ── GET /inbox — unified calls inbox stream ─────────────────────────────────
// Phase 2. Returns three streams unified into one list:
//   1. Completed calls (status implicitly 'completed') — all logged calls
//   2. Pending sequence call tasks (sequence_step_logs WHERE channel='call'
//      AND status='draft')
//   3. Pending callback requests (calls WHERE outcome='callback_requested')
//      — surfaces as pending until either (a) callback_requested_at is past
//      and we want to flag it, or (b) a follow-up call to the same prospect
//      has occurred after this one
//
// Query params:
//   scope     = mine | team | org    (default: mine)
//   filter    = all | pending | overdue | completed (default: all)
//   from      = ISO date string      (optional)
//   to        = ISO date string      (optional)
//   limit     = integer              (default: 100, max: 200)
//   offset    = integer              (default: 0)
//
// Response shape:
//   {
//     items: [
//       {
//         kind: 'completed' | 'pending_sequence' | 'pending_callback',
//         id: <int>,                          // for completed/callback: calls.id; for pending_sequence: sequence_step_logs.id
//         prospect_id, prospect_first_name, prospect_last_name, prospect_company,
//         user_id, logged_by_name,
//         occurred_at | scheduled_at,         // depends on kind
//         outcome, outcome_label, outcome_group, // completed/callback only
//         duration_seconds, notes,             // completed/callback only
//         phone_used,
//         sequence_id, sequence_name, sequence_step_order,  // pending_sequence only
//         task_note,                                          // pending_sequence only
//         is_overdue: bool,                    // for pending kinds
//         stale_days: int                      // days past scheduled when > 5
//       },
//       ...
//     ],
//     counts: { all, pending, overdue, completed }
//   }
router.get('/inbox', async (req, res) => {
  const {
    scope  = 'mine',
    filter = 'all',
    from,
    to,
    limit  = 100,
    offset = 0,
  } = req.query;

  const lim = Math.min(parseInt(limit, 10) || 100, 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  // ── Scope filter ─────────────────────────────────────────────────────────
  // Mirrors prospecting-inbox pattern. team scope requires req.subordinateIds.
  let userClause = '';
  const baseParams = [req.orgId];
  if (scope === 'team' && req.subordinateIds?.length > 0) {
    const teamIds = [req.user.userId, ...req.subordinateIds];
    userClause = `AND user_id = ANY($${baseParams.length + 1}::int[])`;
    baseParams.push(teamIds);
  } else if (scope === 'org') {
    userClause = '';  // no extra filter
  } else {
    userClause = `AND user_id = $${baseParams.length + 1}`;
    baseParams.push(req.user.userId);
  }

  // Date filters apply to occurred_at (completed) or scheduled_send_at
  // (pending sequence) or callback_requested_at (pending callback). To keep
  // SQL simple we apply the same date range to each stream separately.
  // Build helpers.
  const dateClause = (col, params) => {
    const parts = [];
    if (from) {
      params.push(from);
      parts.push(`${col} >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      parts.push(`${col} <= $${params.length}`);
    }
    return parts.length ? ' AND ' + parts.join(' AND ') : '';
  };

  try {
    // ── Stream 1: completed calls ─────────────────────────────────────────
    // Uses the calls table directly. `kind='completed'`.
    const completedParams = [...baseParams];
    const completedScopeClause = userClause.replace(/user_id/g, 'c.user_id');
    const completedDateClause = dateClause('c.occurred_at', completedParams);

    const completedQuery = `
      SELECT
        'completed'::text AS kind,
        c.id              AS id,
        c.prospect_id,
        c.user_id,
        c.occurred_at     AS event_at,
        c.outcome,
        c.duration_seconds,
        c.notes,
        c.phone_used,
        c.callback_requested_at,
        c.sequence_step_log_id,
        c.created_at,
        u.first_name || ' ' || u.last_name AS logged_by_name,
        p.first_name      AS prospect_first_name,
        p.last_name       AS prospect_last_name,
        p.company_name    AS prospect_company,
        NULL::int         AS sequence_id,
        NULL::text        AS sequence_name,
        NULL::int         AS sequence_step_order,
        NULL::text        AS task_note,
        false             AS is_overdue,
        0                 AS stale_days
      FROM calls c
      LEFT JOIN users u    ON u.id = c.user_id
      LEFT JOIN prospects p ON p.id = c.prospect_id
      WHERE c.org_id = $1 ${completedScopeClause} ${completedDateClause}
    `;

    // ── Stream 2: pending sequence call tasks ─────────────────────────────
    // sequence_step_logs.scheduled_send_at is when the task became due.
    const pendingSeqParams = [...baseParams];
    const pendingSeqScopeClause = userClause.replace(/user_id/g, 'se.enrolled_by');
    const pendingSeqDateClause = dateClause('ssl.scheduled_send_at', pendingSeqParams);

    const pendingSequenceQuery = `
      SELECT
        'pending_sequence'::text AS kind,
        ssl.id                   AS id,
        ssl.prospect_id,
        se.enrolled_by           AS user_id,
        ssl.scheduled_send_at    AS event_at,
        NULL::varchar             AS outcome,
        NULL::int                 AS duration_seconds,
        ssl.body                  AS notes,
        p.phone                   AS phone_used,
        NULL::timestamptz         AS callback_requested_at,
        ssl.id                    AS sequence_step_log_id,
        ssl.scheduled_send_at     AS created_at,
        u.first_name || ' ' || u.last_name AS logged_by_name,
        p.first_name              AS prospect_first_name,
        p.last_name               AS prospect_last_name,
        p.company_name            AS prospect_company,
        s.id                      AS sequence_id,
        s.name                    AS sequence_name,
        ss.step_order             AS sequence_step_order,
        ss.task_note              AS task_note,
        (ssl.scheduled_send_at < NOW()) AS is_overdue,
        GREATEST(0,
          EXTRACT(DAY FROM (NOW() - ssl.scheduled_send_at))::int
        )                          AS stale_days
      FROM sequence_step_logs ssl
      JOIN sequence_steps ss        ON ss.id = ssl.sequence_step_id
      JOIN sequence_enrollments se  ON se.id = ssl.enrollment_id
      JOIN sequences s              ON s.id  = se.sequence_id
      JOIN prospects p              ON p.id  = ssl.prospect_id
      LEFT JOIN users u             ON u.id  = se.enrolled_by
      WHERE ssl.org_id = $1
        AND ssl.channel = 'call'
        AND ssl.status  = 'draft'
        ${pendingSeqScopeClause} ${pendingSeqDateClause}
    `;

    // ── Stream 3: pending callback requests ───────────────────────────────
    // A call with outcome='callback_requested' is "pending" until a newer
    // call to the same prospect has occurred. We surface them all and let
    // the UI dedupe; alternatively, a NOT EXISTS could filter at DB layer.
    // For Phase 2 we accept that surfacing them all is fine — reps see the
    // most-recent state via the prospect drawer's Calls tab.
    const pendingCbParams = [...baseParams];
    const pendingCbScopeClause = userClause.replace(/user_id/g, 'c.user_id');
    const pendingCbDateClause = dateClause('c.callback_requested_at', pendingCbParams);

    const pendingCallbackQuery = `
      SELECT
        'pending_callback'::text AS kind,
        c.id                     AS id,
        c.prospect_id,
        c.user_id,
        c.callback_requested_at  AS event_at,
        c.outcome,
        c.duration_seconds,
        c.notes,
        c.phone_used,
        c.callback_requested_at,
        c.sequence_step_log_id,
        c.created_at,
        u.first_name || ' ' || u.last_name AS logged_by_name,
        p.first_name             AS prospect_first_name,
        p.last_name              AS prospect_last_name,
        p.company_name           AS prospect_company,
        NULL::int                AS sequence_id,
        NULL::text               AS sequence_name,
        NULL::int                AS sequence_step_order,
        NULL::text               AS task_note,
        (c.callback_requested_at < NOW()) AS is_overdue,
        GREATEST(0,
          EXTRACT(DAY FROM (NOW() - c.callback_requested_at))::int
        )                         AS stale_days
      FROM calls c
      LEFT JOIN users u    ON u.id = c.user_id
      LEFT JOIN prospects p ON p.id = c.prospect_id
      WHERE c.org_id = $1
        AND c.outcome = 'callback_requested'
        AND c.callback_requested_at IS NOT NULL
        ${pendingCbScopeClause} ${pendingCbDateClause}
        AND NOT EXISTS (
          SELECT 1 FROM calls c2
          WHERE c2.prospect_id = c.prospect_id
            AND c2.org_id = c.org_id
            AND c2.occurred_at > c.occurred_at
            AND c2.id != c.id
        )
    `;

    // ── Apply filter to streams ──────────────────────────────────────────
    // 'all'       → all three streams
    // 'pending'   → streams 2 + 3
    // 'overdue'   → streams 2 + 3 where is_overdue=true (filtered in app)
    // 'completed' → stream 1 only
    let unionParts = [];
    let unionParams = [];
    let paramOffset = 0;

    // Helper: re-number $N placeholders so streams can be concatenated.
    const renumber = (sql, params) => {
      let s = sql;
      for (let i = params.length; i >= 1; i--) {
        s = s.split(`$${i}`).join(`$${i + paramOffset}`);
      }
      paramOffset += params.length;
      return s;
    };

    if (filter === 'all' || filter === 'completed') {
      const renumbered = renumber(completedQuery, completedParams);
      unionParts.push(renumbered);
      unionParams.push(...completedParams);
    }
    if (filter === 'all' || filter === 'pending' || filter === 'overdue') {
      const renumbered = renumber(pendingSequenceQuery, pendingSeqParams);
      unionParts.push(renumbered);
      unionParams.push(...pendingSeqParams);
    }
    if (filter === 'all' || filter === 'pending' || filter === 'overdue') {
      const renumbered = renumber(pendingCallbackQuery, pendingCbParams);
      unionParts.push(renumbered);
      unionParams.push(...pendingCbParams);
    }

    if (unionParts.length === 0) {
      return res.json({ items: [], counts: { all: 0, pending: 0, overdue: 0, completed: 0 } });
    }

    const orderClause = `ORDER BY event_at DESC NULLS LAST`;
    const finalQuery = `
      SELECT * FROM (
        ${unionParts.join('\n        UNION ALL\n        ')}
      ) AS inbox
      ${filter === 'overdue' ? 'WHERE is_overdue = true' : ''}
      ${orderClause}
      LIMIT ${lim} OFFSET ${off}
    `;

    const itemsRes = await db.query(finalQuery, unionParams);
    let items = itemsRes.rows;

    // Resolve outcome labels for completed/callback rows.
    const outcomeKeys = [...new Set(items.map(r => r.outcome).filter(Boolean))];
    const labelMap = await resolveOutcomeLabels(req.orgId, outcomeKeys);
    items = items.map(r => ({
      ...r,
      outcome_label: r.outcome ? labelMap[r.outcome] : null,
    }));

    // Counts: a simpler count query for the UI tab badges. We don't need
    // exact pagination counts; we need bucket counts.
    const countsParams = [req.orgId];
    let countsScope = '';
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      countsScope = ` AND user_id = ANY($2::int[])`;
      countsParams.push(teamIds);
    } else if (scope === 'org') {
      countsScope = '';
    } else {
      countsScope = ` AND user_id = $2`;
      countsParams.push(req.user.userId);
    }

    const countsQuery = `
      SELECT
        (SELECT COUNT(*) FROM calls WHERE org_id = $1 ${countsScope}) AS completed,
        (SELECT COUNT(*) FROM sequence_step_logs
            WHERE org_id = $1 AND channel = 'call' AND status = 'draft'
              ${countsScope.replace('user_id', '(SELECT enrolled_by FROM sequence_enrollments WHERE id = sequence_step_logs.enrollment_id)')}
        ) AS pending_sequence,
        (SELECT COUNT(*) FROM calls
            WHERE org_id = $1
              AND outcome = 'callback_requested'
              AND callback_requested_at IS NOT NULL
              ${countsScope}
        ) AS pending_callback
    `;
    const countsRes = await db.query(countsQuery, countsParams);
    const c = countsRes.rows[0] || {};

    const pendingTotal = parseInt(c.pending_sequence || 0, 10) + parseInt(c.pending_callback || 0, 10);
    const completedTotal = parseInt(c.completed || 0, 10);
    const overdueCount = items.filter(r => r.is_overdue).length; // approximate; precise count needs separate query

    return res.json({
      items,
      counts: {
        all:       pendingTotal + completedTotal,
        pending:   pendingTotal,
        overdue:   overdueCount,
        completed: completedTotal,
      },
    });

  } catch (err) {
    console.error('prospect-calls GET /inbox error:', err);
    return res.status(500).json({ error: { message: 'Failed to fetch calls inbox' } });
  }
});


// ── GET /:id — fetch a single call ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { message: 'Invalid id' } });
  }
  try {
    const r = await db.query(
      `SELECT pc.*,
              u.first_name || ' ' || u.last_name AS logged_by_name,
              u.email                            AS logged_by_email
         FROM calls pc
         LEFT JOIN users u ON u.id = pc.user_id
        WHERE pc.id = $1 AND pc.org_id = $2`,
      [id, req.orgId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Call not found' } });
    }
    const call = r.rows[0];
    const labelMap = await resolveOutcomeLabels(req.orgId, [call.outcome]);
    return res.json({ call: { ...call, outcome_label: labelMap[call.outcome] } });
  } catch (err) {
    console.error('prospect-calls GET :id error:', err);
    return res.status(500).json({ error: { message: 'Failed to fetch call' } });
  }
});


// ── PATCH /:id — edit a call within the org's edit window ───────────────────
// Editable fields: outcome, duration_seconds, notes, phone_used, occurred_at.
// Direction is NOT editable post-create (changing outbound→inbound would
// invalidate all the count bumps and channel_data we mirrored).
//
// Editor must be the original logger, AND the call must be within the org's
// edit window (default 24h). Admins are NOT given an override in Phase 1 —
// add that in Phase 2 if needed.
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { message: 'Invalid id' } });
  }

  try {
    // Load the existing call.
    const existRes = await db.query(
      'SELECT * FROM calls WHERE id = $1 AND org_id = $2',
      [id, req.orgId]
    );
    if (existRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Call not found' } });
    }
    const existing = existRes.rows[0];

    // Authorization: only the logger can edit their own call.
    if (existing.user_id !== req.user.userId) {
      return res.status(403).json({ error: { message: 'Only the user who logged this call can edit it' } });
    }

    // Edit window check.
    const inWindow = await CallSettingsService.isWithinEditWindow(req.orgId, existing.logged_at);
    if (!inWindow) {
      return res.status(403).json({ error: { message: 'Edit window has expired for this call' } });
    }

    // Build the patch. Only set fields that were explicitly provided.
    const patch = {};
    let resolvedOutcome = null;

    if (req.body.outcome !== undefined) {
      try {
        resolvedOutcome = await CallSettingsService.resolveOutcome(req.orgId, req.body.outcome);
      } catch (err) {
        return res.status(400).json({ error: { message: err.message } });
      }
      patch.outcome = resolvedOutcome.key;
    }

    if (req.body.duration_seconds !== undefined) {
      if (req.body.duration_seconds === null) {
        patch.duration_seconds = null;
      } else {
        const d = Number(req.body.duration_seconds);
        if (!Number.isInteger(d) || d < 0) {
          return res.status(400).json({ error: { message: 'duration_seconds must be a non-negative integer' } });
        }
        // Cross-check with the resolved outcome (or existing outcome if none in patch).
        const outcomeKey = patch.outcome || existing.outcome;
        if (d > 0 && !CallSettingsService.outcomeAllowsDuration(outcomeKey)) {
          return res.status(400).json({ error: { message: `duration_seconds is not allowed for outcome '${outcomeKey}'` } });
        }
        patch.duration_seconds = d || null;
      }
    }

    if (req.body.notes !== undefined) {
      patch.notes = clampStr(req.body.notes, MAX_NOTES_LEN);
    }
    if (req.body.phone_used !== undefined) {
      patch.phone_used = clampStr(req.body.phone_used, MAX_PHONE_LEN);
    }
    if (req.body.occurred_at !== undefined) {
      if (req.body.occurred_at === null) {
        return res.status(400).json({ error: { message: 'occurred_at cannot be cleared' } });
      }
      const ts = new Date(req.body.occurred_at);
      if (isNaN(ts.getTime())) {
        return res.status(400).json({ error: { message: 'occurred_at must be a valid timestamp' } });
      }
      patch.occurred_at = ts.toISOString();
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'No editable fields in request' } });
    }

    // Build a dynamic UPDATE.
    //
    // Parameter numbering: SET-clause params occupy $1..$N (where N is the
    // number of patched columns), then the WHERE params (id, org_id) follow
    // as $(N+1) and $(N+2).
    //
    // (Phase 3 bugfix: an earlier version computed the WHERE placeholders as
    // $(length) and $(length+1) AFTER pushing id+orgId, which made the second
    // placeholder refer to a non-existent param and triggered Postgres 42P18
    // "could not determine data type" when the patch had a specific field
    // count. The corrected math below uses array indices consistently.)
    const setClauses = [];
    const values     = [];
    Object.entries(patch).forEach(([col, val]) => {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    });
    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    const idPlaceholder    = values.length + 1;
    const orgIdPlaceholder = values.length + 2;
    values.push(id, req.orgId);

    // Transaction: update the row, then mirror the change in prospecting_activities.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const updRes = await client.query(
        `UPDATE calls
            SET ${setClauses.join(', ')}
          WHERE id = $${idPlaceholder} AND org_id = $${orgIdPlaceholder}
          RETURNING *`,
        values
      );
      const updated = updRes.rows[0];

      // Resolve outcome for the mirror (might have changed in the patch).
      const outcomeForMirror = resolvedOutcome ||
        (await CallSettingsService.resolveOutcome(req.orgId, updated.outcome));

      await CallOutcomeMirrorService.mirrorEditedCall(client, updated, outcomeForMirror);
      await client.query('COMMIT');

      return res.json({
        call: {
          ...updated,
          outcome_label: outcomeForMirror.label,
          outcome_group: outcomeForMirror.group,
        },
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
      throw err;
    } finally {
      try { client.release(); } catch (_) { /* swallow */ }
    }
  } catch (err) {
    console.error('prospect-calls PATCH error:', err);
    return res.status(500).json({ error: { message: 'Failed to update call' } });
  }
});


module.exports = router;
