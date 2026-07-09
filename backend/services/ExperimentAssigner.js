/**
 * ExperimentAssigner.js
 *
 * DROP-IN LOCATION: backend/services/ExperimentAssigner.js
 *
 * Single source of truth for "which A/B arm is this prospect in, and how many
 * steps of this sequence are allowed to vary".
 *
 * ── Why assignment must be PURE ──────────────────────────────────────────────
 * bulk-activate runs the personalisation dispatcher BEFORE the enrollment row
 * exists (prospecting-campaigns.routes.js — dispatcher at ~:3583, INSERT at
 * ~:3634). The dispatcher needs the arm's template as its prompt base, so the
 * arm has to be resolvable from (sequence_id, prospect_id) alone. A
 * Math.random() coin flip would silently personalise arm B's copy onto an arm A
 * enrollment.
 *
 * So: sha256(`${sequenceId}:${prospectId}`) -> weighted bucket. Same prospect,
 * same sequence, same arm — forever. Re-enrolment never contaminates the test,
 * and `POST /:id/preview` can show the exact arm a not-yet-enrolled prospect
 * will land in.
 *
 * The resolved key is still STORED on sequence_enrollments.variant_key. That is
 * the authority once the enrollment exists: it pins the arm if a rep later edits
 * weights or adds an arm C, and it gives the metric snapshot something to join.
 *
 * ── Arm semantics ────────────────────────────────────────────────────────────
 * Arms are sequence-wide, not per-step. An enrollment assigned 'B' reads 'B'
 * copy on every varied step. Two varied steps therefore test an ARM, not a step
 * — a reply is not attributable to either change. That is precisely why
 * maxVariedSteps() defaults to 1.
 *
 * A step is "varied" iff it has >= 2 ACTIVE variant rows. Zero rows, or one row
 * (the transient state while a rep builds the test), fall through to the base
 * sequence_steps templates.
 *
 * Every function takes a pg `client` (pool or in-transaction client) so callers
 * own the transaction boundary — same contract as EnrollmentStepResolver.
 */

const crypto = require('crypto');

/** Org default when neither the sequence nor prospecting_config says otherwise. */
const DEFAULT_MAX_VARIED_STEPS = 1;

/** Channels whose content is actually delivered to a prospect. */
const VARIABLE_CHANNELS = ['email', 'linkedin'];

// ── cap resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the cap for a sequence: per-sequence override, else the org's
 * prospecting_config, else 1. Mirrors the settings read in
 * EnrollmentStepResolver.editPropagationMode().
 */
async function maxVariedSteps(client, orgId, sequenceId) {
  const { rows } = await client.query(
    `SELECT s.ab_max_varied_steps AS seq_cap,
            o.settings->'prospecting_config'->>'ab_max_varied_steps' AS org_cap
       FROM sequences s
       JOIN organizations o ON o.id = s.org_id
      WHERE s.id = $1 AND s.org_id = $2`,
    [sequenceId, orgId]
  );
  if (!rows.length) return DEFAULT_MAX_VARIED_STEPS;

  const seqCap = rows[0].seq_cap;
  if (Number.isInteger(seqCap) && seqCap >= 1) return seqCap;

  const orgCap = parseInt(rows[0].org_cap, 10);
  if (Number.isInteger(orgCap) && orgCap >= 1) return orgCap;

  return DEFAULT_MAX_VARIED_STEPS;
}

/** Step ids in this sequence that currently carry >= 2 active variant rows. */
async function variedStepIds(client, sequenceId) {
  const { rows } = await client.query(
    `SELECT ss.id
       FROM sequence_steps ss
       JOIN sequence_step_variants sv
         ON sv.sequence_step_id = ss.id AND sv.status = 'active'
      WHERE ss.sequence_id = $1
      GROUP BY ss.id, ss.step_order
     HAVING COUNT(*) >= 2
      ORDER BY ss.step_order ASC`,
    [sequenceId]
  );
  return rows.map((r) => r.id);
}

// ── arm set ──────────────────────────────────────────────────────────────────

/**
 * The live arm set for a sequence, with split weights.
 *
 * Weights are read from the LOWEST step_order varied step only. Routes enforce
 * that every varied step in a sequence declares the same arm keys, so any varied
 * step would do — taking the first makes the choice deterministic and the error
 * message obvious when the invariant is broken.
 *
 * Returns [] when the sequence has no live test (fewer than 2 arms). Callers
 * treat [] as "not in a test" and leave variant_key NULL.
 */
async function activeArms(client, sequenceId) {
  const { rows } = await client.query(
    `WITH varied AS (
       SELECT ss.id, ss.step_order
         FROM sequence_steps ss
         JOIN sequence_step_variants sv
           ON sv.sequence_step_id = ss.id AND sv.status = 'active'
        WHERE ss.sequence_id = $1
        GROUP BY ss.id, ss.step_order
       HAVING COUNT(*) >= 2
        ORDER BY ss.step_order ASC
        LIMIT 1
     )
     SELECT sv.variant_key, sv.weight
       FROM sequence_step_variants sv
       JOIN varied v ON v.id = sv.sequence_step_id
      WHERE sv.status = 'active'
      ORDER BY sv.variant_key ASC`,
    [sequenceId]
  );
  const arms = rows.filter((r) => r.weight > 0);
  return arms.length >= 2 ? arms : [];
}

// ── assignment ───────────────────────────────────────────────────────────────

/**
 * Deterministic 32-bit bucket from the experiment coordinates. Exported for
 * tests and for the dry-run split checker (scripts/).
 */
function bucketOf(sequenceId, prospectId) {
  return crypto
    .createHash('sha256')
    .update(`${sequenceId}:${prospectId}`)
    .digest()
    .readUInt32BE(0);
}

/** Pure weighted pick over a sorted arm list. Exported for unit tests. */
function pickArm(arms, bucket) {
  const total = arms.reduce((a, r) => a + r.weight, 0);
  if (total <= 0) return null;
  let n = bucket % total;
  for (const arm of arms) {
    if (n < arm.weight) return arm.variant_key;
    n -= arm.weight;
  }
  return arms[arms.length - 1].variant_key; // unreachable; belt and braces
}

/**
 * The arm this prospect belongs to for this sequence, or null when the sequence
 * has no live test.
 *
 * Call this at every INSERT INTO sequence_enrollments site:
 *   sequences.routes.js:~418
 *   prospects.routes.js:~123
 *   prospecting-campaigns.routes.js:~2559 and ~3636  (in bulk-activate, call it
 *     BEFORE PersonalizationDispatcher.personaliseEnrollment and pass the key in)
 *
 * Safe to call for sequences with no variants — one indexed aggregate, then null.
 */
async function assignVariant(client, { sequenceId, prospectId }) {
  if (sequenceId == null || prospectId == null) return null;
  const arms = await activeArms(client, sequenceId);
  if (!arms.length) return null;
  return pickArm(arms, bucketOf(sequenceId, prospectId));
}

/**
 * Read-through for an existing enrollment: the stored key wins (it pins the arm
 * across weight edits), falling back to a fresh assignment for rows enrolled
 * before the sequence had variants.
 */
async function variantForEnrollment(client, enrollment) {
  if (enrollment.variant_key) return enrollment.variant_key;
  const sequenceId =
    enrollment.sequence_id != null ? enrollment.sequence_id : enrollment.seq_id;
  return assignVariant(client, { sequenceId, prospectId: enrollment.prospect_id });
}

module.exports = {
  DEFAULT_MAX_VARIED_STEPS,
  VARIABLE_CHANNELS,
  maxVariedSteps,
  variedStepIds,
  activeArms,
  assignVariant,
  variantForEnrollment,
  // exported for unit tests / dry-run split checker
  bucketOf,
  pickArm,
};
