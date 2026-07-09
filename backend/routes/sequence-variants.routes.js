// ─────────────────────────────────────────────────────────────────────────────
// routes/sequence-variants.routes.js   (2026_47)
//
// Step-level A/B variants, scoped to an experiment. Email + LinkedIn steps only.
//
// Mount AFTER the main sequences router — same base path, disjoint sub-paths:
//   app.use('/api/sequences', require('./routes/sequences.routes'));
//   app.use('/api/sequences', require('./routes/sequence-variants.routes'));
//
//   GET    /api/sequences/:id/variants                     running experiment + arms + cap
//   POST   /api/sequences/:id/steps/:stepId/variants       add an arm (starts an experiment)
//   PUT    /api/sequences/:id/variants/:variantId          edit copy / weight / status
//   DELETE /api/sequences/:id/variants/:variantId          remove an arm
//   GET    /api/sequences/:id/experiments                  history
//   POST   /api/sequences/:id/experiments/:expId/conclude  conclude / abandon / promote
//   GET    /api/sequences/:id/experiment                   per-arm results (?experimentId=)
//
// Invariants enforced here (the DB can't express them):
//   1. Only email / linkedin steps may be varied. A call/task step's task_note is
//      an instruction to a rep, never delivered to a prospect.
//   2. At most `ab_max_varied_steps` steps per experiment may carry >= 2 active
//      arms. Default 1. Arms are sequence-wide, so two varied steps means a reply
//      is attributable to the ARM, not to either change.
//   3. Every varied step declares the same arm key set. The assigner reads split
//      weights from the lowest-order varied step; divergent key sets would make
//      that read silently wrong.
//   4. Editing an arm's copy while prospects are enrolled invalidates the result.
//      Requires confirmMidTestEdit: true. Weight and status changes pass freely —
//      pausing a losing arm is legitimate mid-flight.
//   5. No variants on ai_enabled sequences. The dispatcher personalises FROM the
//      step template and would need the arm's copy as its prompt base; until
//      PersonalizationDispatcher.loadSequenceSteps takes a variantKey, an AI
//      sequence would personalise arm A's copy onto arm B. Strong personalisation
//      also converges the arms and washes out the effect being measured.
//   6. Arms may only be added to, or edited in, a RUNNING experiment.
//
// Concluding does NOT delete arms. Enrollments stamped with a concluded
// experiment keep reading its copy until they finish — switching treatment
// mid-cadence would corrupt both the prospect experience and the result. Arm rows
// go status='concluded': invisible to activeArms(), still resolvable by the
// overlay (which matches on experiment_id, not status).
//
// Ownership follows the sequence: AccessPolicy.requireCanEdit on sequences.created_by.
// All queries org-scoped via req.orgId. Never trust org_id from the body.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const AccessPolicy      = require('../services/AccessPolicy');
const ExperimentAssigner = require('../services/ExperimentAssigner');
const EnrollmentStepResolver = require('../services/EnrollmentStepResolver');

router.use(authenticateToken, orgContext);

// Mirrors gateSequenceEdit in sequences.routes.js — kept local so the two routers
// stay independently mountable. Returns the sequence row, or false (response sent).
async function gateSequenceEdit(req, res, seqId) {
  const r = await pool.query(
    `SELECT id, created_by, allow_manager_edit, ai_enabled
       FROM sequences WHERE id = $1 AND org_id = $2`,
    [seqId, req.orgId]
  );
  if (!r.rows.length) {
    res.status(404).json({ error: { message: 'Not found' } });
    return false;
  }
  const ok = await AccessPolicy.requireCanEdit(req, res, r.rows[0].created_by, {
    allowManagerEdit: r.rows[0].allow_manager_edit,
  });
  return ok ? r.rows[0] : false;
}

/** Live enrollments currently sitting in an arm of this experiment. */
async function enrolledInExperiment(client, experimentId) {
  if (!experimentId) return 0;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM sequence_enrollments
      WHERE experiment_id = $1 AND status = 'active'`,
    [experimentId]
  );
  return rows[0].n;
}

// ── GET /:id/variants ────────────────────────────────────────────────────────
// Everything the builder's A/B panel needs in one call.

router.get('/:id/variants', async (req, res) => {
  try {
    const seqRes = await pool.query(
      `SELECT id FROM sequences WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Not found' } });
    }

    const exp = await ExperimentAssigner.runningExperiment(pool, req.params.id);
    const cap = await ExperimentAssigner.maxVariedSteps(pool, req.orgId, req.params.id);

    if (!exp) {
      return res.json({
        experiment: null,
        variantsByStep: {},
        variedStepIds: [],
        maxVariedSteps: cap,
        variedStepsRemaining: cap,
        arms: [],
        testIsLive: false,
        enrolledInTest: 0,
      });
    }

    const { rows } = await pool.query(
      `SELECT sv.*, ss.step_order, ss.channel
         FROM sequence_step_variants sv
         JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
        WHERE sv.experiment_id = $1 AND sv.org_id = $2
        ORDER BY ss.step_order ASC, sv.variant_key ASC`,
      [exp.id, req.orgId]
    );

    const [variedIds, arms, enrolled] = await Promise.all([
      ExperimentAssigner.variedStepIds(pool, exp.id),
      ExperimentAssigner.activeArms(pool, exp.id),
      enrolledInExperiment(pool, exp.id),
    ]);

    const byStep = {};
    for (const v of rows) (byStep[v.sequence_step_id] ||= []).push(v);

    res.json({
      experiment: exp,
      variantsByStep: byStep,
      variedStepIds: variedIds,
      maxVariedSteps: cap,
      variedStepsRemaining: Math.max(0, cap - variedIds.length),
      arms,
      testIsLive: arms.length >= 2,
      enrolledInTest: enrolled,
    });
  } catch (err) {
    console.error('sequence-variants GET /:id/variants', err);
    res.status(500).json({ error: { message: 'Failed to load variants' } });
  }
});

// ── POST /:id/steps/:stepId/variants ─────────────────────────────────────────
// Body: { variant_key?, subject_template?, body_template?, weight?, personalize_config?,
//         experiment_name?, hypothesis? }
//
// Starts a running experiment if none exists (uq_sexp_one_running keeps it to
// one). First call on a virgin step also seeds arm 'A' from the step's base
// templates, so a step never sits half-varied — one arm row with base copy still
// silently winning.

router.post('/:id/steps/:stepId/variants', async (req, res) => {
  const { variant_key, subject_template, body_template, weight, personalize_config,
          experiment_name, hypothesis } = req.body || {};
  const armKey = (variant_key || 'B').toUpperCase();
  if (!/^[A-Z]$/.test(armKey)) {
    return res.status(400).json({ error: { message: 'variant_key must be a single A-Z letter' } });
  }

  const seq = await gateSequenceEdit(req, res, req.params.id);
  if (!seq) return;

  // Invariant 5 — v1 scope. See header.
  if (seq.ai_enabled) {
    return res.status(422).json({ error: { message:
      'A/B variants are not available on AI-personalised sequences yet. The AI rewrites the body ' +
      'from the step template, which both bypasses the arm and converges the arms. Turn off AI ' +
      'personalisation on this sequence to run a copy test.',
      code: 'AB_AI_SEQUENCE' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stepRes = await client.query(
      `SELECT id, channel, subject_template, body_template, personalize_config
         FROM sequence_steps
        WHERE id = $1 AND sequence_id = $2 AND org_id = $3
        FOR UPDATE`,
      [req.params.stepId, req.params.id, req.orgId]
    );
    if (!stepRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Step not found' } });
    }
    const step = stepRes.rows[0];

    // Invariant 1 — channel scope.
    if (!ExperimentAssigner.VARIABLE_CHANNELS.includes(step.channel)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: { message:
        `Only ${ExperimentAssigner.VARIABLE_CHANNELS.join(' and ')} steps can be varied. ` +
        `A ${step.channel} step's task_note is never delivered to the prospect.` } });
    }

    // Invariant 6 — arms live in a running experiment. Create one on demand.
    let exp = await ExperimentAssigner.runningExperiment(client, req.params.id);
    if (!exp) {
      const e = await client.query(
        `INSERT INTO sequence_experiments (org_id, sequence_id, name, hypothesis, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, sequence_id, org_id, name, started_at`,
        [req.orgId, req.params.id, experiment_name || null, hypothesis || null, req.user.userId]
      );
      exp = e.rows[0];
    }

    const existingRes = await client.query(
      `SELECT variant_key, status FROM sequence_step_variants
        WHERE experiment_id = $1 AND sequence_step_id = $2`,
      [exp.id, step.id]
    );
    const existing    = existingRes.rows;
    const activeCount = existing.filter((v) => v.status === 'active').length;
    const seedA       = existing.length === 0 && armKey !== 'A';

    if (existing.some((v) => v.variant_key === armKey)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Arm ${armKey} already exists on this step` } });
    }

    // Invariant 2 — would this step BECOME varied, and is there room?
    const willBeVaried = (activeCount + (seedA ? 2 : 1)) >= 2;
    if (willBeVaried && activeCount < 2) {
      const [cap, variedIds] = await Promise.all([
        ExperimentAssigner.maxVariedSteps(client, req.orgId, req.params.id),
        ExperimentAssigner.variedStepIds(client, exp.id),
      ]);
      if (!variedIds.includes(step.id) && variedIds.length >= cap) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message:
          `This experiment already varies ${variedIds.length} step(s), its limit. ` +
          `Raise sequences.ab_max_varied_steps (or prospecting_config.ab_max_varied_steps) to test ` +
          `more than one step at a time — but note arms are sequence-wide, so a reply then tells you ` +
          `which ARM won, not which step.`,
          code: 'AB_MAX_VARIED_STEPS' } });
      }
    }

    // Invariant 3 — arm keys must match the rest of the experiment.
    const canonical = (await ExperimentAssigner.activeArms(client, exp.id)).map((a) => a.variant_key);
    if (canonical.length && !canonical.includes(armKey)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message:
        `This experiment uses arms ${canonical.join('/')}. Every varied step must declare the same arm set.` } });
    }

    const created = [];

    if (seedA) {
      const a = await client.query(
        `INSERT INTO sequence_step_variants
           (org_id, experiment_id, sequence_step_id, variant_key, subject_template,
            body_template, personalize_config, weight, created_by)
         VALUES ($1,$2,$3,'A',$4,$5,$6,50,$7) RETURNING *`,
        [req.orgId, exp.id, step.id, step.subject_template, step.body_template,
         step.personalize_config ? JSON.stringify(step.personalize_config) : null,
         req.user.userId]
      );
      created.push(a.rows[0]);
    }

    const b = await client.query(
      `INSERT INTO sequence_step_variants
         (org_id, experiment_id, sequence_step_id, variant_key, subject_template,
          body_template, personalize_config, weight, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.orgId, exp.id, step.id, armKey,
       subject_template ?? step.subject_template,
       body_template    ?? step.body_template,
       personalize_config ? JSON.stringify(personalize_config) : null,
       Number.isInteger(weight) ? weight : 50,
       req.user.userId]
    );
    created.push(b.rows[0]);

    await client.query('COMMIT');
    res.status(201).json({ experiment: exp, variants: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequence-variants POST /:id/steps/:stepId/variants', err);
    res.status(500).json({ error: { message: 'Failed to create variant' } });
  } finally {
    client.release();
  }
});

// ── PUT /:id/variants/:variantId ─────────────────────────────────────────────
// Body: { subject_template?, body_template?, weight?, status?, personalize_config?,
//         confirmMidTestEdit? }

router.put('/:id/variants/:variantId', async (req, res) => {
  const { subject_template, body_template, weight, status,
          personalize_config, confirmMidTestEdit } = req.body || {};
  if (status && !['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: { message: "status must be 'active' or 'paused'" } });
  }
  if (weight !== undefined && !(Number.isInteger(weight) && weight >= 0 && weight <= 100)) {
    return res.status(400).json({ error: { message: 'weight must be an integer 0-100' } });
  }
  if (!(await gateSequenceEdit(req, res, req.params.id))) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vRes = await client.query(
      `SELECT sv.*, e.status AS experiment_status
         FROM sequence_step_variants sv
         JOIN sequence_steps ss       ON ss.id = sv.sequence_step_id
         JOIN sequence_experiments e  ON e.id  = sv.experiment_id
        WHERE sv.id = $1 AND ss.sequence_id = $2 AND sv.org_id = $3
        FOR UPDATE OF sv`,
      [req.params.variantId, req.params.id, req.orgId]
    );
    if (!vRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Variant not found' } });
    }
    const variant = vRes.rows[0];

    // Invariant 6 — a concluded experiment's arms are exactly what in-flight
    // enrollments still read. Freeze them.
    if (variant.experiment_status !== 'running') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message:
        'This experiment has been concluded. Its arms are read-only so the enrollments still in ' +
        'flight keep the treatment they were randomised into. Start a new test instead.',
        code: 'AB_EXPERIMENT_CLOSED' } });
    }

    // Invariant 4 — copy edits mid-test silently poison the result. Weight and
    // status changes are legitimate mid-flight (pausing a losing arm), so only
    // gate the content fields.
    const editsCopy = subject_template !== undefined
      || body_template !== undefined
      || personalize_config !== undefined;
    if (editsCopy && confirmMidTestEdit !== true) {
      const n = await enrolledInExperiment(client, variant.experiment_id);
      if (n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message:
          `${n} prospect(s) are live in this experiment. Editing arm copy now mixes two treatments ` +
          `under one label and invalidates the result. Pass confirmMidTestEdit: true to override, ` +
          `or conclude this experiment and start a fresh one.`,
          code: 'AB_MID_TEST_EDIT', enrolledInTest: n } });
      }
    }

    const { rows } = await client.query(
      `UPDATE sequence_step_variants
          SET subject_template   = COALESCE($1, subject_template),
              body_template      = COALESCE($2, body_template),
              personalize_config = COALESCE($3::jsonb, personalize_config),
              weight             = COALESCE($4, weight),
              status             = COALESCE($5, status),
              updated_at         = now()
        WHERE id = $6 AND org_id = $7
        RETURNING *`,
      [subject_template ?? null, body_template ?? null,
       personalize_config ? JSON.stringify(personalize_config) : null,
       weight ?? null, status ?? null, req.params.variantId, req.orgId]
    );

    await client.query('COMMIT');
    res.json({ variant: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequence-variants PUT /:id/variants/:variantId', err);
    res.status(500).json({ error: { message: 'Failed to update variant' } });
  } finally {
    client.release();
  }
});

// ── DELETE /:id/variants/:variantId ──────────────────────────────────────────
// Dropping an arm un-varies the step for FUTURE enrollments. Enrollments already
// stamped with this experiment keep resolving their arm — unless the arm deleted
// is theirs, in which case the overlay misses and they fall back to base copy.
// That is the safe direction to fail, but it IS a treatment switch mid-cadence,
// so we count the affected rows and say so.

router.delete('/:id/variants/:variantId', async (req, res) => {
  if (!(await gateSequenceEdit(req, res, req.params.id))) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vRes = await client.query(
      `SELECT sv.id, sv.experiment_id, sv.sequence_step_id, sv.variant_key,
              e.status AS experiment_status
         FROM sequence_step_variants sv
         JOIN sequence_steps ss      ON ss.id = sv.sequence_step_id
         JOIN sequence_experiments e ON e.id  = sv.experiment_id
        WHERE sv.id = $1 AND ss.sequence_id = $2 AND sv.org_id = $3`,
      [req.params.variantId, req.params.id, req.orgId]
    );
    if (!vRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Variant not found' } });
    }
    const v = vRes.rows[0];

    if (v.experiment_status !== 'running') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message:
        'Concluded experiments are read-only — their arms are what in-flight enrollments still read.',
        code: 'AB_EXPERIMENT_CLOSED' } });
    }

    const stranded = (await client.query(
      `SELECT COUNT(*)::int AS n FROM sequence_enrollments
        WHERE experiment_id = $1 AND variant_key = $2 AND status = 'active'`,
      [v.experiment_id, v.variant_key]
    )).rows[0].n;

    await client.query(`DELETE FROM sequence_step_variants WHERE id = $1`, [v.id]);

    const remaining = (await client.query(
      `SELECT COUNT(*)::int AS n FROM sequence_step_variants
        WHERE experiment_id = $1 AND sequence_step_id = $2 AND status = 'active'`,
      [v.experiment_id, v.sequence_step_id]
    )).rows[0].n;

    await client.query('COMMIT');
    res.json({
      ok: true,
      stepStillVaried: remaining >= 2,
      strandedEnrollments: stranded,
      warning: stranded > 0
        ? `${stranded} live enrollment(s) were randomised into arm ${v.variant_key}. They now fall back to the base step copy mid-cadence.`
        : (remaining < 2
            ? 'This step is no longer varied. Future enrollments use the base step templates.'
            : null),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequence-variants DELETE /:id/variants/:variantId', err);
    res.status(500).json({ error: { message: 'Failed to delete variant' } });
  } finally {
    client.release();
  }
});

// ── GET /:id/experiments — history ───────────────────────────────────────────

router.get('/:id/experiments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*,
              (SELECT COUNT(*) FROM sequence_enrollments se
                WHERE se.experiment_id = e.id)::int AS enrolled,
              (SELECT COUNT(DISTINCT sv.sequence_step_id) FROM sequence_step_variants sv
                WHERE sv.experiment_id = e.id)::int AS varied_steps
         FROM sequence_experiments e
        WHERE e.sequence_id = $1 AND e.org_id = $2
        ORDER BY e.started_at DESC`,
      [req.params.id, req.orgId]
    );
    res.json({ experiments: rows });
  } catch (err) {
    console.error('sequence-variants GET /:id/experiments', err);
    res.status(500).json({ error: { message: 'Failed to load experiments' } });
  }
});

// ── POST /:id/experiments/:expId/conclude ────────────────────────────────────
// Body: { winningVariantKey?, promoteWinner?, note?, abandon? }
//
// Arms are NOT deleted. They go status='concluded': invisible to activeArms() so
// no new enrollment lands in them, still resolvable by the overlay (which matches
// on experiment_id, not status) so the prospects already in flight keep the
// treatment they were randomised into until they finish.
//
// promoteWinner copies the winning arm's copy into sequence_steps, so future
// enrollments — which now carry no arm — send the winner by default. That is a
// step mutation, so it runs freezeIfConfigured first for freeze-mode orgs.

router.post('/:id/experiments/:expId/conclude', async (req, res) => {
  const { winningVariantKey, promoteWinner, note, abandon } = req.body || {};
  const winner = winningVariantKey ? String(winningVariantKey).toUpperCase() : null;
  if (winner && !/^[A-Z]$/.test(winner)) {
    return res.status(400).json({ error: { message: 'winningVariantKey must be a single A-Z letter' } });
  }
  if (promoteWinner && !winner) {
    return res.status(400).json({ error: { message: 'promoteWinner requires winningVariantKey' } });
  }
  if (!(await gateSequenceEdit(req, res, req.params.id))) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const eRes = await client.query(
      `SELECT * FROM sequence_experiments
        WHERE id = $1 AND sequence_id = $2 AND org_id = $3 FOR UPDATE`,
      [req.params.expId, req.params.id, req.orgId]
    );
    if (!eRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Experiment not found' } });
    }
    if (eRes.rows[0].status !== 'running') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Experiment is already closed' } });
    }

    let promoted = 0;
    if (promoteWinner) {
      // Step mutation — pin in-flight prospects first for freeze-mode orgs.
      // freezeIfConfigured snapshots per (experiment, arm), so each keeps its own
      // copy and the promotion cannot leak into a frozen plan.
      await EnrollmentStepResolver.freezeIfConfigured(client, req.orgId, req.params.id);

      const p = await client.query(
        `UPDATE sequence_steps ss
            SET subject_template = COALESCE(NULLIF(sv.subject_template, ''), ss.subject_template),
                body_template    = COALESCE(NULLIF(sv.body_template, ''),    ss.body_template),
                updated_at       = now()
           FROM sequence_step_variants sv
          WHERE sv.experiment_id    = $1
            AND sv.variant_key      = $2
            AND sv.sequence_step_id = ss.id
            AND ss.sequence_id      = $3`,
        [req.params.expId, winner, req.params.id]
      );
      promoted = p.rowCount;
    }

    await client.query(
      `UPDATE sequence_step_variants SET status = 'concluded', updated_at = now()
        WHERE experiment_id = $1`,
      [req.params.expId]
    );

    const { rows } = await client.query(
      `UPDATE sequence_experiments
          SET status              = $1,
              concluded_at        = now(),
              winning_variant_key = $2,
              conclusion_note     = $3
        WHERE id = $4
        RETURNING *`,
      [abandon ? 'abandoned' : 'concluded', winner, note || null, req.params.expId]
    );

    const stillRunning = (await client.query(
      `SELECT COUNT(*)::int AS n FROM sequence_enrollments
        WHERE experiment_id = $1 AND status = 'active'`,
      [req.params.expId]
    )).rows[0].n;

    await client.query('COMMIT');
    res.json({
      experiment: rows[0],
      promotedSteps: promoted,
      inFlightEnrollments: stillRunning,
      note: stillRunning
        ? `${stillRunning} enrollment(s) are still mid-cadence. They keep this experiment's arm copy until they finish — treatment is never switched under a prospect.`
        : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequence-variants POST /:id/experiments/:expId/conclude', err);
    res.status(500).json({ error: { message: 'Failed to conclude experiment' } });
  } finally {
    client.release();
  }
});

// ── GET /:id/experiment — per-arm results ────────────────────────────────────
//
// ?experimentId=N  — defaults to the running experiment, else the most recent.
//
// NOT served from prospecting_metric_daily. Two reasons, both verified against
// the codebase:
//
//   * REPLY. Nothing anywhere sets sequence_step_logs.status = 'replied'. The only
//     writer of 'replied' is SequenceStepFirer (on sequence_enrollments, when an
//     inbound email lands after enrolled_at). The snapshot's replied_steps column
//     is structurally always 0. Reply is ENROLLMENT-grain — which is also the
//     correct unit here, since the enrollment is the unit of randomisation.
//
//   * LINKEDIN ACCEPT. connection_accepted arrives asynchronously as a
//     prospect-grain prospecting_activities row with no step-log reference, so
//     MetricSnapshotService's familyActivities carries the '-' sentinel. We anchor
//     on the step log and reach forward, guarding on a.created_at > ssl.fired_at —
//     without that you count prospects who were already connected.
//
// Scoping by experiment_id (rather than a date window) is exact: a second test on
// the same step reuses arm names A/B, and only experiment_id tells them apart.

router.get('/:id/experiment', async (req, res) => {
  try {
    const seqRes = await pool.query(
      `SELECT id, name FROM sequences WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Not found' } });
    }

    let expRow;
    if (req.query.experimentId) {
      expRow = (await pool.query(
        `SELECT * FROM sequence_experiments
          WHERE id = $1 AND sequence_id = $2 AND org_id = $3`,
        [req.query.experimentId, req.params.id, req.orgId]
      )).rows[0];
    } else {
      expRow = (await pool.query(
        `SELECT * FROM sequence_experiments
          WHERE sequence_id = $1 AND org_id = $2
          ORDER BY (status = 'running') DESC, started_at DESC
          LIMIT 1`,
        [req.params.id, req.orgId]
      )).rows[0];
    }
    if (!expRow) {
      return res.json({ sequence: seqRes.rows[0], experiment: null, arms: [], steps: [], notes: [] });
    }

    // Enrollment grain: enrolled + replied per arm. This is the unit of
    // randomisation, so it is also the correct denominator.
    const enrRes = await pool.query(
      `SELECT se.variant_key,
              COUNT(*)::int                                      AS enrolled,
              COUNT(*) FILTER (WHERE se.status = 'replied')::int AS replied,
              COUNT(*) FILTER (WHERE se.status = 'active')::int  AS still_active
         FROM sequence_enrollments se
        WHERE se.experiment_id = $1
        GROUP BY se.variant_key
        ORDER BY se.variant_key ASC`,
      [expRow.id]
    );

    // Step-log grain, per arm per varied step: sends, failures, LinkedIn accepts.
    const stepRes = await pool.query(
      `SELECT se.variant_key,
              ssl.sequence_step_id,
              ss.step_order,
              ssl.channel,
              COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed','replied'))::int AS sent,
              COUNT(*) FILTER (WHERE ssl.status = 'failed')::int                        AS failed,
              COUNT(DISTINCT a.prospect_id)::int                                        AS li_accepted
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN sequence_steps ss       ON ss.id = ssl.sequence_step_id
         JOIN sequence_step_variants sv
           ON sv.experiment_id     = se.experiment_id
          AND sv.sequence_step_id  = ssl.sequence_step_id
          AND sv.variant_key       = se.variant_key
    LEFT JOIN prospecting_activities a
           ON a.prospect_id        = ssl.prospect_id
          AND a.org_id             = ssl.org_id
          AND a.activity_type      = 'linkedin_event'
          AND a.metadata->>'event' = 'connection_accepted'
          AND a.created_at > ssl.fired_at
        WHERE se.experiment_id = $1 AND ssl.org_id = $2
        GROUP BY se.variant_key, ssl.sequence_step_id, ss.step_order, ssl.channel
        ORDER BY ss.step_order ASC, se.variant_key ASC`,
      [expRow.id, req.orgId]
    );

    res.json({
      sequence: seqRes.rows[0],
      experiment: expRow,
      arms: enrRes.rows.map((r) => ({
        ...r,
        reply_rate: r.enrolled ? Number((r.replied / r.enrolled).toFixed(4)) : null,
      })),
      steps: stepRes.rows.map((r) => ({
        ...r,
        li_accept_rate: r.channel === 'linkedin' && r.sent
          ? Number((r.li_accepted / r.sent).toFixed(4))
          : null,
      })),
      notes: [
        'Reply is enrollment-grain and email-only. A LinkedIn reply never sets status=replied.',
        'Replies arriving after the final step are not counted (equal across arms).',
        'still_active enrollments have not had their chance to reply yet — read rates as a lower bound.',
        'Manually pinned prospects (variantKeyOverride) are counted here. They were not randomised.',
      ],
    });
  } catch (err) {
    console.error('sequence-variants GET /:id/experiment', err);
    res.status(500).json({ error: { message: 'Failed to load experiment results' } });
  }
});

module.exports = router;
