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
 * ── A/B variants (2026_46) ───────────────────────────────────────────────────
 * orderedSteps() now overlays the enrollment's arm copy onto the resolved plan.
 * This is THE seam: currentStep, nextStep, applyAdvance, the firer's manual /
 * draft path and sequenceStepAdvance.service all inherit it for free.
 *
 * Precedence at send time (unchanged for non-variant sequences):
 *   personalised_steps  →  steps_snapshot  →  variant  →  base sequence_steps
 *
 * The auto-send due query in SequenceStepFirer bypasses this module (it joins
 * sequence_steps directly) — patch it separately.
 *
 * Overlay only fires for steps that are actually VARIED (>= 2 active variant
 * rows). A step with 0 or 1 variant rows keeps its base templates, so the
 * transient state while a rep builds a test never changes what ships.
 *
 * Cost: when enrollment.variant_key is NULL — every enrollment in every org
 * that has never touched A/B — the overlay query is skipped entirely and this
 * module issues exactly the same SQL it did before.
 *
 * Every method takes a pg `client` (may be a pool or an in-transaction client)
 * so callers control the transaction boundary.
 */

// Accept either shape the callers use: enrollment.sequence_id (routes/advance)
// or enrollment.seq_id (firer due-query alias).
function seqIdOf(enrollment) {
  return enrollment.sequence_id != null ? enrollment.sequence_id : enrollment.seq_id;
}

// ── Variant overlay ──────────────────────────────────────────────────────────

/**
 * Map(step_id → { subject_template, body_template, personalize_config }) of the
 * arm's copy, restricted to steps that are genuinely varied. Empty map when the
 * arm has no rows (e.g. arm 'C' was added after this enrollment was assigned 'B'
 * and then removed) — callers then fall through to base templates, which is the
 * safe direction to fail.
 */
async function loadVariantOverlay(client, sequenceId, variantKey) {
  const overlay = new Map();
  if (!variantKey || sequenceId == null) return overlay;

  const { rows } = await client.query(
    `WITH varied AS (
       SELECT sv.sequence_step_id
         FROM sequence_step_variants sv
         JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
        WHERE ss.sequence_id = $1 AND sv.status = 'active'
        GROUP BY sv.sequence_step_id
       HAVING COUNT(*) >= 2
     )
     SELECT sv.sequence_step_id, sv.subject_template, sv.body_template,
            sv.personalize_config
       FROM sequence_step_variants sv
       JOIN varied v ON v.sequence_step_id = sv.sequence_step_id
      WHERE sv.variant_key = $2 AND sv.status = 'active'`,
    [sequenceId, variantKey]
  );

  for (const r of rows) {
    overlay.set(r.sequence_step_id, {
      subject_template: r.subject_template,
      body_template: r.body_template,
      personalize_config: r.personalize_config,
    });
  }
  return overlay;
}

/**
 * Apply an overlay to an ordered step list. Pure. Returns new objects — never
 * mutates the caller's rows (the firer holds references to them).
 *
 * COALESCE semantics: a NULL/blank field on the variant row falls back to the
 * base step, so an arm may vary the subject alone and inherit the body.
 */
function applyOverlay(steps, overlay) {
  if (!overlay || !overlay.size) return steps;
  return steps.map((s) => {
    const v = overlay.get(s.id);
    if (!v) return s;
    return {
      ...s,
      subject_template: v.subject_template != null && v.subject_template !== ''
        ? v.subject_template
        : s.subject_template,
      body_template: v.body_template != null && v.body_template !== ''
        ? v.body_template
        : s.body_template,
      personalize_config: v.personalize_config != null
        ? v.personalize_config
        : s.personalize_config,
      variant_key: null, // filled by caller context; kept for shape parity
    };
  });
}

/**
 * A snapshot written on or after 2026_46 is already variant-resolved (freeze
 * stamps `variant_key` onto every row). Legacy snapshots predate variants and
 * carry base copy, so they still want the overlay.
 */
function snapshotIsVariantResolved(snap) {
  return Array.isArray(snap) && snap.length > 0 && 'variant_key' in snap[0];
}

// ── Step resolution ──────────────────────────────────────────────────────────

/** Ordered [{ id, step_order, channel, ... }] from snapshot or live table. */
async function orderedSteps(client, enrollment) {
  const snap = enrollment.steps_snapshot;

  if (Array.isArray(snap) && snap.length) {
    const sorted = [...snap].sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
    if (snapshotIsVariantResolved(snap)) return sorted;
    // Legacy snapshot: base copy pinned pre-2026_46. Overlay the arm on top.
    const overlay = await loadVariantOverlay(
      client, seqIdOf(enrollment), enrollment.variant_key
    );
    return applyOverlay(sorted, overlay);
  }

  const { rows } = await client.query(
    `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
    [seqIdOf(enrollment)]
  );
  // Fast path: no arm, no second query. Identical SQL to the pre-A/B module.
  if (!enrollment.variant_key) return rows;

  const overlay = await loadVariantOverlay(
    client, seqIdOf(enrollment), enrollment.variant_key
  );
  return applyOverlay(rows, overlay);
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

const SNAPSHOT_COLS = [
  'id', 'step_order', 'channel', 'delay_days', 'delay_hours',
  'subject_template', 'body_template', 'task_note',
  'require_approval', 'step_intent', 'personalize_config',
];

/** Project a resolved step down to the snapshot shape, stamped with its arm. */
function toSnapshotRow(step, variantKey) {
  const out = {};
  for (const c of SNAPSHOT_COLS) out[c] = step[c] ?? null;
  out.variant_key = variantKey ?? null; // marker: this snapshot is variant-resolved
  return out;
}

/**
 * Copy-on-write. Call BEFORE mutating a sequence's steps (reorder/edit/add/
 * delete). For orgs on 'freeze', snapshots the current live plan onto every
 * active enrollment of that sequence that doesn't already have one — pinning
 * in-flight prospects to the pre-edit version. No-op for 'live' orgs.
 *
 * A/B: enrollments of the same sequence sit in different arms, so a single
 * snapshot blob would be wrong for at least one of them. We resolve the plan
 * ONCE PER DISTINCT ARM present among the enrollments being frozen and write
 * each blob to its own arm. Freeze then pins copy as well as structure, which
 * is what freeze-mode orgs are paying for.
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

  // Which arms are actually about to be frozen? Usually exactly one: [null].
  const { rows: armRows } = await client.query(
    `SELECT DISTINCT variant_key
       FROM sequence_enrollments
      WHERE sequence_id = $1
        AND org_id       = $2
        AND status       = 'active'
        AND steps_snapshot IS NULL`,
    [sequenceId, orgId]
  );
  if (!armRows.length) return 0;

  let frozen = 0;
  for (const { variant_key: arm } of armRows) {
    const overlay = await loadVariantOverlay(client, sequenceId, arm);
    const resolved = applyOverlay(steps, overlay).map((s) => toSnapshotRow(s, arm));

    // IS NOT DISTINCT FROM: matches the NULL arm (not in a test) as well as 'A'/'B'.
    const r = await client.query(
      `UPDATE sequence_enrollments
          SET steps_snapshot = $1::jsonb
        WHERE sequence_id = $2
          AND org_id       = $3
          AND status       = 'active'
          AND steps_snapshot IS NULL
          AND variant_key IS NOT DISTINCT FROM $4`,
      [JSON.stringify(resolved), sequenceId, orgId, arm]
    );
    frozen += r.rowCount;
  }
  return frozen;
}

module.exports = {
  orderedSteps,
  currentStep,
  nextStep,
  applyAdvance,
  stampInitialCursor,
  editPropagationMode,
  freezeIfConfigured,
  loadVariantOverlay,
  // exported for unit tests
  pickCurrent,
  applyOverlay,
  snapshotIsVariantResolved,
};
