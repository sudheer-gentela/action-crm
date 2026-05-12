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

  return {
    prospectId,
    outcome,
    direction,
    durationSeconds,
    occurredAt,
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
      `INSERT INTO prospect_calls
         (org_id, prospect_id, user_id,
          occurred_at, direction, outcome,
          duration_seconds, notes, phone_used,
          sequence_step_log_id)
       VALUES ($1, $2, $3,
               COALESCE($4, CURRENT_TIMESTAMP), $5, $6,
               $7, $8, $9,
               $10)
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
      ]
    );
    const call = insertRes.rows[0];

    // Mirror writes (activity row, channel_data, counts).
    await CallOutcomeMirrorService.mirrorNewCall(client, call, v.outcome);

    await client.query('COMMIT');

    // Decorate response with the resolved label so the UI doesn't need a
    // second roundtrip to render the freshly-created row.
    return res.status(201).json({
      call: {
        ...call,
        outcome_label: v.outcome.label,
        outcome_group: v.outcome.group,
      },
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
         FROM prospect_calls pc
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
         FROM prospect_calls pc
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
      'SELECT * FROM prospect_calls WHERE id = $1 AND org_id = $2',
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
    const setClauses = [];
    const values     = [];
    Object.entries(patch).forEach(([col, val]) => {
      values.push(val);
      setClauses.push(`${col} = $${values.length}`);
    });
    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id, req.orgId);
    const idIdx    = values.length - 1;  // 1-based: $(idIdx+1)
    const orgIdx   = values.length;

    // Transaction: update the row, then mirror the change in prospecting_activities.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const updRes = await client.query(
        `UPDATE prospect_calls
            SET ${setClauses.join(', ')}
          WHERE id = $${idIdx + 1} AND org_id = $${orgIdx + 1}
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
