/**
 * ExperimentAssigner.js  (2026_47)
 *
 * DROP-IN LOCATION: backend/services/ExperimentAssigner.js
 * REPLACES the 2026_46 version. Signature change: assignVariant now returns
 * { experimentId, variantKey } instead of a bare key. All four enrollment call
 * sites are updated in the accompanying drop-ins.
 *
 * Single source of truth for "which experiment is running, which arm is this
 * prospect in, and how many steps may vary".
 *
 * ── Why assignment must be PURE ──────────────────────────────────────────────
 * bulk-activate runs the personalisation dispatcher BEFORE the enrollment row
 * exists (prospecting-campaigns.routes.js — dispatcher first, INSERT ~50 lines
 * later). The dispatcher needs the arm's template as its prompt base, so the arm
 * must be resolvable from (sequence_id, prospect_id) alone. Math.random() would
 * silently personalise arm B's copy onto an arm A enrollment.
 *
 * ── Why the hash key changed to experiment_id ───────────────────────────────
 * 2026_46 hashed (sequence_id, prospect_id). Stickiness within a test: good.
 * But it also meant a prospect who hashed into arm A landed in arm A of EVERY
 * successive test on that sequence, forever. Sequential experiments would share
 * a fixed, invisible partition of the prospect pool. Hashing (experiment_id,
 * prospect_id) reshuffles per experiment while keeping re-enrolment sticky
 * within one — which is all re-enrolment needs.
 *
 * ── Arm semantics ────────────────────────────────────────────────────────────
 * Arms are sequence-wide within an experiment: an enrollment assigned 'B' reads
 * 'B' copy on every varied step. Two varied steps therefore test an ARM, not a
 * step — which is why maxVariedSteps() defaults to 1.
 *
 * A step is "varied" iff it has >= 2 ACTIVE arms in the RUNNING experiment. That
 * is now purely an assignment-side concern. The send-time overlay does not check
 * it: a half-built experiment has one arm, activeArms() returns [], no
 * enrollment is ever stamped with its id, so its orphan row can never reach a
 * send. (Under 2026_46 the overlay carried a `varied` CTE for exactly this; it
 * is gone.)
 *
 * Every function takes a pg `client` (pool or in-transaction client) so callers
 * own the transaction boundary — same contract as EnrollmentStepResolver.
 */

const crypto = require('crypto');

/** Org default when neither the sequence nor prospecting_config says otherwise. */
const DEFAULT_MAX_VARIED_STEPS = 1;

/** Channels whose content is actually delivered to a prospect. */
const VARIABLE_CHANNELS = ['email', 'linkedin'];

// ── experiment lookup ────────────────────────────────────────────────────────

/**
 * The running experiment for a sequence, or null. `uq_sexp_one_running`
 * guarantees at most one.
 */
async function runningExperiment(client, sequenceId) {
  if (sequenceId == null) return null;
  const { rows } = await client.query(
    `SELECT id, sequence_id, org_id, name, started_at
       FROM sequence_experiments
      WHERE sequence_id = $1 AND status = 'running'
      LIMIT 1`,
    [sequenceId]
  );
  return rows[0] || null;
}

// ── cap resolution ───────────────────────────────────────────────────────────

/**
 * Per-sequence override, else the org's prospecting_config, else 1. Mirrors the
 * settings read in EnrollmentStepResolver.editPropagationMode().
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

/** Step ids carrying >= 2 active arms in this experiment. */
async function variedStepIds(client, experimentId) {
  if (experimentId == null) return [];
  const { rows } = await client.query(
    `SELECT sv.sequence_step_id AS id
       FROM sequence_step_variants sv
       JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
      WHERE sv.experiment_id = $1 AND sv.status = 'active'
      GROUP BY sv.sequence_step_id, ss.step_order
     HAVING COUNT(*) >= 2
      ORDER BY ss.step_order ASC`,
    [experimentId]
  );
  return rows.map((r) => r.id);
}

// ── arm set ──────────────────────────────────────────────────────────────────

/**
 * Live arm set for an experiment, with split weights.
 *
 * Weights come from the LOWEST step_order varied step only. Routes enforce that
 * every varied step in an experiment declares the same arm keys, so any would
 * do — taking the first makes the read deterministic and the error obvious when
 * the invariant is broken.
 *
 * Returns [] when fewer than 2 arms carry weight. Callers treat [] as "no live
 * test" and leave variant_key / experiment_id NULL.
 */
async function activeArms(client, experimentId) {
  if (experimentId == null) return [];
  const { rows } = await client.query(
    `WITH varied AS (
       SELECT sv.sequence_step_id, ss.step_order
         FROM sequence_step_variants sv
         JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
        WHERE sv.experiment_id = $1 AND sv.status = 'active'
        GROUP BY sv.sequence_step_id, ss.step_order
       HAVING COUNT(*) >= 2
        ORDER BY ss.step_order ASC
        LIMIT 1
     )
     SELECT sv.variant_key, sv.weight
       FROM sequence_step_variants sv
       JOIN varied v ON v.sequence_step_id = sv.sequence_step_id
      WHERE sv.experiment_id = $1 AND sv.status = 'active'
      ORDER BY sv.variant_key ASC`,
    [experimentId]
  );
  const arms = rows.filter((r) => r.weight > 0);
  return arms.length >= 2 ? arms : [];
}

// ── assignment ───────────────────────────────────────────────────────────────

/** Deterministic 32-bit bucket. Exported for tests + the dry-run split checker. */
function bucketOf(experimentId, prospectId) {
  return crypto
    .createHash('sha256')
    .update(`${experimentId}:${prospectId}`)
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

const NO_ARM = Object.freeze({ experimentId: null, variantKey: null });

/**
 * Resolve the arm for a prospect about to be enrolled.
 *
 * Returns { experimentId, variantKey }, both null when the sequence has no live
 * test. `chk_se_arm_has_experiment` enforces that pairing at the DB level, so
 * always write both columns or neither.
 *
 * Call at every INSERT INTO sequence_enrollments site:
 *   sequences.routes.js  (POST /enroll)
 *   prospects.routes.js  (single enroll)
 *   prospecting-campaigns.routes.js  (campaign enroll, and bulk-activate — in
 *     bulk-activate call it BEFORE PersonalizationDispatcher.personaliseEnrollment)
 *
 * MANUAL OVERRIDE (gap 1). `variantKeyOverride` pins a prospect to a named arm —
 * for dogfooding your own copy, or re-running a specific prospect through a
 * known treatment. Deliberately constrained:
 *   * it must name an ACTIVE arm of the running experiment; anything else 400s
 *     at the route layer rather than silently falling back to the hash;
 *   * it is admin-gated at the route layer;
 *   * it is NOT wired into bulk-activate. A pinned prospect is not a randomised
 *     one, and letting a batch path pin hundreds at once would quietly destroy
 *     the randomisation the whole design rests on.
 * Every override is a small, known bias. Use it to inspect copy, not to steer a
 * test.
 */
async function assignVariant(client, { sequenceId, prospectId, variantKeyOverride } = {}) {
  if (sequenceId == null || prospectId == null) return NO_ARM;

  const exp = await runningExperiment(client, sequenceId);
  if (!exp) return NO_ARM;

  const arms = await activeArms(client, exp.id);
  if (!arms.length) return NO_ARM;

  if (variantKeyOverride) {
    const key = String(variantKeyOverride).toUpperCase();
    const hit = arms.find((a) => a.variant_key === key);
    if (!hit) {
      const err = new Error(
        `Arm ${key} is not an active arm of the running experiment (arms: ${arms.map((a) => a.variant_key).join('/')})`
      );
      err.code = 'AB_BAD_OVERRIDE';
      throw err;
    }
    return { experimentId: exp.id, variantKey: key };
  }

  return { experimentId: exp.id, variantKey: pickArm(arms, bucketOf(exp.id, prospectId)) };
}

module.exports = {
  DEFAULT_MAX_VARIED_STEPS,
  VARIABLE_CHANNELS,
  runningExperiment,
  maxVariedSteps,
  variedStepIds,
  activeArms,
  assignVariant,
  // exported for unit tests / dry-run split checker
  bucketOf,
  pickArm,
};
