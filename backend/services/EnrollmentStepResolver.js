/**
 * EnrollmentStepResolver.js
 *
 * DROP-IN LOCATION: backend/services/EnrollmentStepResolver.js
 *
 * Single source of truth for "which step is this enrollment on, and what is
 * the next step" — replacing the fragile `step_order === current_step`
 * arithmetic scattered through SequenceStepFirer and SequenceStepAdvanceService.
 *
 * Resolution source:
 *   - steps_snapshot present  → resolve against the frozen ordered plan
 *                               (org opted into 'freeze' propagation).
 *   - steps_snapshot null     → resolve against live sequence_steps
 *                               ('live' / default: edits to not-yet-reached
 *                               steps take effect, position held by identity).
 *
 * Position is held by identity (current_step_id), NOT by ordinal, so a reorder
 * never re-points a live prospect at the wrong step. current_step (ordinal) is
 * used only as a re-anchor fallback when the current step was deleted.
 *
 * Every method takes a pg `client` (may be a pool or an in-transaction client)
 * so callers control the transaction boundary.
 */

// Accept either shape the callers use: enrollment.sequence_id (routes/advance)
// or enrollment.seq_id (firer due-query alias).
function seqIdOf(enrollment) {
  return enrollment.sequence_id != null ? enrollment.sequence_id : enrollment.seq_id;
}

/** Ordered [{ id, step_order, channel, ... }] from snapshot or live table. */
async function orderedSteps(client, enrollment) {
  const snap = enrollment.steps_snapshot;
  if (Array.isArray(snap) && snap.length) {
    return [...snap].sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
  }
  const { rows } = await client.query(
    `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
    [seqIdOf(enrollment)]
  );
  return rows;
}

/** Pick the current step from an already-ordered list. Pure. */
function pickCurrent(steps, enrollment) {
  // 1. Identity (authoritative once backfilled).
  if (enrollment.current_step_id != null) {
    const byId = steps.find((s) => s.id === enrollment.current_step_id);
    if (byId) return byId;
  }
  // 2. Legacy ordinal (pre-backfill or NULL identity).
  const ord = enrollment.current_step;
  if (ord != null) {
    const byOrd = steps.find((s) => s.step_order === ord);
    if (byOrd) return byOrd;
  }
  // 3. Re-anchor: current step was deleted. Take the next surviving step at or
  //    after the last known ordinal; null => the enrollment is past the end.
  const anchor = ord != null ? ord : 1;
  const atOrAfter = steps
    .filter((s) => s.step_order >= anchor)
    .sort((a, b) => a.step_order - b.step_order);
  return atOrAfter[0] || null;
}

async function currentStep(client, enrollment) {
  return pickCurrent(await orderedSteps(client, enrollment), enrollment);
}

/** Next step by ordering (identity-safe). null => sequence complete. */
async function nextStep(client, enrollment) {
  const steps = await orderedSteps(client, enrollment);
  const cur = pickCurrent(steps, enrollment);
  if (!cur) return null;
  return steps.find((s) => s.step_order > cur.step_order) || null;
}

/**
 * Advance the enrollment cursor to a resolved next step (or complete it).
 * Writes current_step (ordinal, kept in sync), current_step_id, and
 * current_step_channel. The next_step_due is derived from the *resolved* next
 * step via the caller-supplied `computeDue(step)` callback (may be async), so
 * the caller doesn't have to know the next step ahead of time — that's exactly
 * the chicken-and-egg the old `current_step + 1` code sidestepped by arithmetic.
 * Returns { completed: bool, step }.
 *
 * NOTE: does not COMMIT — runs on the caller's client/transaction.
 */
async function applyAdvance(client, enrollment, { computeDue } = {}) {
  const ns = await nextStep(client, enrollment);
  if (!ns) {
    await client.query(
      `UPDATE sequence_enrollments
          SET status='completed', completed_at=NOW()
        WHERE id=$1`,
      [enrollment.id]
    );
    return { completed: true, step: null };
  }
  const due = computeDue ? await computeDue(ns) : null;
  await client.query(
    `UPDATE sequence_enrollments
        SET current_step        = $1,
            current_step_id      = $2,
            current_step_channel = $3,
            next_step_due        = $4
      WHERE id = $5`,
    [ns.step_order, ns.id, ns.channel, due ?? null, enrollment.id]
  );
  return { completed: false, step: ns };
}

/**
 * Stamp the identity cursor for a freshly-created enrollment (first step).
 * Call right after INSERT ... RETURNING id. Idempotent-ish: only sets when the
 * identity cursor is still NULL.
 */
async function stampInitialCursor(client, enrollmentId, sequenceId) {
  await client.query(
    `UPDATE sequence_enrollments se
        SET current_step_id      = ss.id,
            current_step_channel = ss.channel
       FROM (
         SELECT id, channel FROM sequence_steps
          WHERE sequence_id = $2 ORDER BY step_order ASC LIMIT 1
       ) ss
      WHERE se.id = $1 AND se.current_step_id IS NULL`,
    [enrollmentId, sequenceId]
  );
}

// ── Freeze propagation (copy-on-write) ────────────────────────────────────────

/** 'freeze' | 'live'. Default 'live'. */
async function editPropagationMode(client, orgId) {
  const { rows } = await client.query(
    `SELECT settings->'prospecting_config'->>'sequence_edit_propagation' AS mode
       FROM organizations WHERE id = $1`,
    [orgId]
  );
  return rows[0]?.mode === 'freeze' ? 'freeze' : 'live';
}

/**
 * Copy-on-write. Call BEFORE mutating a sequence's steps (reorder/edit/add/
 * delete). For orgs on 'freeze', snapshots the current live plan onto every
 * active enrollment of that sequence that doesn't already have one — pinning
 * in-flight prospects to the pre-edit version. No-op for 'live' orgs.
 *
 * Returns the number of enrollments frozen (0 for live orgs / none active).
 */
async function freezeIfConfigured(client, orgId, sequenceId) {
  const mode = await editPropagationMode(client, orgId);
  if (mode !== 'freeze') return 0;

  const { rows: steps } = await client.query(
    `SELECT id, step_order, channel, delay_days, delay_hours,
            subject_template, body_template, task_note,
            require_approval, step_intent, personalize_config
       FROM sequence_steps
      WHERE sequence_id = $1
      ORDER BY step_order ASC`,
    [sequenceId]
  );
  if (!steps.length) return 0;

  const r = await client.query(
    `UPDATE sequence_enrollments
        SET steps_snapshot = $1::jsonb
      WHERE sequence_id = $2
        AND org_id       = $3
        AND status       = 'active'
        AND steps_snapshot IS NULL`,
    [JSON.stringify(steps), sequenceId, orgId]
  );
  return r.rowCount;
}

module.exports = {
  orderedSteps,
  currentStep,
  nextStep,
  applyAdvance,
  stampInitialCursor,
  editPropagationMode,
  freezeIfConfigured,
  // exported for unit tests
  pickCurrent,
};
