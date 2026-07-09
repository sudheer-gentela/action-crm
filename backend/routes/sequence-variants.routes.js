// ─────────────────────────────────────────────────────────────────────────────
// routes/sequence-variants.routes.js
//
// Step-level A/B variants (migration 2026_46). Email + LinkedIn steps only.
//
// Mount AFTER the main sequences router — same base path, disjoint sub-paths:
//   app.use('/api/sequences', require('./routes/sequences.routes'));
//   app.use('/api/sequences', require('./routes/sequence-variants.routes'));
//
//   GET    /api/sequences/:id/variants                    arms by step + cap state
//   POST   /api/sequences/:id/steps/:stepId/variants      add an arm to a step
//   PUT    /api/sequences/:id/variants/:variantId         edit copy / weight / status
//   DELETE /api/sequences/:id/variants/:variantId         remove an arm
//   GET    /api/sequences/:id/experiment                  per-arm results
//
// Invariants enforced here (the DB can't express them):
//   1. Only email / linkedin steps may be varied. task_note is an instruction to
//      a rep, never delivered to a prospect — varying it is not an A/B test.
//   2. At most `ab_max_varied_steps` steps per sequence may carry >= 2 active
//      arms. Default 1. Arms are sequence-wide, so two varied steps means a
//      reply is attributable to the ARM, not to either change.
//   3. Every varied step declares the same arm key set. The assigner reads split
//      weights from the lowest-order varied step; divergent key sets would make
//      that read silently wrong.
//   4. Editing an arm's copy while prospects are enrolled in the test
//      invalidates the result. Requires confirmMidTestEdit: true.
//   5. v1: no variants on ai_enabled sequences. The dispatcher personalises
//      FROM the step template and would need the arm's copy as its prompt
//      base; until PersonalizationDispatcher.loadSequenceSteps takes a
//      variantKey, an AI sequence would personalise arm A's copy onto arm B.
//      Strong personalisation also converges the arms and washes out the
//      effect you are trying to measure.
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

router.use(authenticateToken, orgContext);

// Mirrors gateSequenceEdit in sequences.routes.js — kept local so the two
// routers stay independently mountable.
async function gateSequenceEdit(req, res, seqId) {
  const r = await pool.query(
    `SELECT created_by, allow_manager_edit, ai_enabled
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

/** Live enrollments currently sitting in an arm of this sequence. */
async function enrolledInTest(client, sequenceId, orgId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM sequence_enrollments
      WHERE sequence_id = $1 AND org_id = $2
        AND status = 'active' AND variant_key IS NOT NULL`,
    [sequenceId, orgId]
  );
  return rows[0].n;
}

/** Canonical arm keys = keys on the lowest-order varied step. [] when no test. */
async function canonicalArmKeys(client, sequenceId) {
  const arms = await ExperimentAssigner.activeArms(client, sequenceId);
  return arms.map((a) => a.variant_key);
}

// ── GET /:id/variants ────────────────────────────────────────────────────────
// Everything the builder needs to render the A/B panel in one call.

router.get('/:id/variants', async (req, res) => {
  try {
    const seqRes = await pool.query(
      `SELECT id FROM sequences WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Not found' } });
    }

    const { rows } = await pool.query(
      `SELECT sv.*, ss.step_order, ss.channel
         FROM sequence_step_variants sv
         JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
        WHERE ss.sequence_id = $1 AND sv.org_id = $2
        ORDER BY ss.step_order ASC, sv.variant_key ASC`,
      [req.params.id, req.orgId]
    );

    const [cap, variedIds, arms, enrolled] = await Promise.all([
      ExperimentAssigner.maxVariedSteps(pool, req.orgId, req.params.id),
      ExperimentAssigner.variedStepIds(pool, req.params.id),
      ExperimentAssigner.activeArms(pool, req.params.id),
      enrolledInTest(pool, req.params.id, req.orgId),
    ]);

    const byStep = {};
    for (const v of rows) {
      (byStep[v.sequence_step_id] ||= []).push(v);
    }

    res.json({
      variantsByStep: byStep,
      variedStepIds: variedIds,
      maxVariedSteps: cap,
      variedStepsRemaining: Math.max(0, cap - variedIds.length),
      arms,                       // [] when fewer than 2 live arms => no test running
      testIsLive: arms.length >= 2,
      enrolledInTest: enrolled,
    });
  } catch (err) {
    console.error('sequence-variants GET /:id/variants', err);
    res.status(500).json({ error: { message: 'Failed to load variants' } });
  }
});

// ── POST /:id/steps/:stepId/variants ─────────────────────────────────────────
// Body: { variant_key?, subject_template?, body_template?, weight?, personalize_config? }
//
// First call on a virgin step seeds arm 'A' from the step's base templates and
// then creates the requested arm (default 'B'), so a step never sits in the
// half-varied state where one arm exists and the base copy silently still wins.

router.post('/:id/steps/:stepId/variants', async (req, res) => {
  const { variant_key, subject_template, body_template, weight, personalize_config } = req.body || {};
  const armKey = (variant_key || 'B').toUpperCase();
  if (!/^[A-Z]$/.test(armKey)) {
    return res.status(400).json({ error: { message: 'variant_key must be a single A-Z letter' } });
  }
  const seq = await gateSequenceEdit(req, res, req.params.id);
  if (!seq) return;

  // Invariant 5 — v1 scope. See header.
  if (seq.ai_enabled) {
    return res.status(422).json({ error: { message:
      'A/B variants are not available on AI-personalised sequences yet. The AI rewrites ' +
      'the body from the step template, which both bypasses the arm and converges the arms. ' +
      'Turn off AI personalisation on this sequence to run a copy test.',
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

    const existingRes = await client.query(
      `SELECT variant_key, status FROM sequence_step_variants WHERE sequence_step_id = $1`,
      [step.id]
    );
    const existing = existingRes.rows;
    const activeCount = existing.filter((v) => v.status === 'active').length;
    const seedA = existing.length === 0 && armKey !== 'A';

    if (existing.some((v) => v.variant_key === armKey)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Arm ${armKey} already exists on this step` } });
    }

    // Invariant 2 — would this step BECOME varied, and is there room?
    const willBeVaried = (activeCount + (seedA ? 2 : 1)) >= 2;
    if (willBeVaried && activeCount < 2) {
      const [cap, variedIds] = await Promise.all([
        ExperimentAssigner.maxVariedSteps(client, req.orgId, req.params.id),
        ExperimentAssigner.variedStepIds(client, req.params.id),
      ]);
      if (!variedIds.includes(step.id) && variedIds.length >= cap) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message:
          `This sequence already varies ${variedIds.length} step(s), its limit. ` +
          `Raise sequences.ab_max_varied_steps (or prospecting_config.ab_max_varied_steps) ` +
          `to test more than one step at a time — but note arms are sequence-wide, so a ` +
          `reply then tells you which ARM won, not which step.`,
          code: 'AB_MAX_VARIED_STEPS' } });
      }
    }

    // Invariant 3 — arm keys must match the rest of the experiment.
    const canonical = await canonicalArmKeys(client, req.params.id);
    if (canonical.length && !canonical.includes(armKey)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message:
        `This sequence's experiment uses arms ${canonical.join('/')}. ` +
        `Every varied step must declare the same arm set.` } });
    }

    const created = [];

    if (seedA) {
      const a = await client.query(
        `INSERT INTO sequence_step_variants
           (org_id, sequence_step_id, variant_key, subject_template, body_template,
            personalize_config, weight, created_by)
         VALUES ($1,$2,'A',$3,$4,$5,50,$6) RETURNING *`,
        [req.orgId, step.id, step.subject_template, step.body_template,
         step.personalize_config ? JSON.stringify(step.personalize_config) : null,
         req.user.userId]
      );
      created.push(a.rows[0]);
    }

    const b = await client.query(
      `INSERT INTO sequence_step_variants
         (org_id, sequence_step_id, variant_key, subject_template, body_template,
          personalize_config, weight, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.orgId, step.id, armKey,
       subject_template ?? step.subject_template,
       body_template    ?? step.body_template,
       personalize_config ? JSON.stringify(personalize_config) : null,
       Number.isInteger(weight) ? weight : 50,
       req.user.userId]
    );
    created.push(b.rows[0]);

    await client.query('COMMIT');
    res.status(201).json({ variants: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequence-variants POST /:id/steps/:stepId/variants', err);
    res.status(500).json({ error: { message: 'Failed to create variant' } });
  } finally {
    client.release();
  }
});

// ── PUT /:id/variants/:variantId ─────────────────────────────────────────────
// Body: { subject_template?, body_template?, weight?, status?, confirmMidTestEdit? }

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
      `SELECT sv.* FROM sequence_step_variants sv
         JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
        WHERE sv.id = $1 AND ss.sequence_id = $2 AND sv.org_id = $3
        FOR UPDATE OF sv`,
      [req.params.variantId, req.params.id, req.orgId]
    );
    if (!vRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Variant not found' } });
    }

    // Invariant 4 — copy edits mid-test silently poison the result. Weight and
    // status changes are legitimate mid-flight (pausing a losing arm), so only
    // gate the content fields.
    const editsCopy = subject_template !== undefined
      || body_template !== undefined
      || personalize_config !== undefined;
    if (editsCopy && confirmMidTestEdit !== true) {
      const n = await enrolledInTest(client, req.params.id, req.orgId);
      if (n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message:
          `${n} prospect(s) are live in this experiment. Editing arm copy now mixes two ` +
          `treatments under one label and invalidates the result. Pass confirmMidTestEdit: true ` +
          `to override, or pause the arm and start a fresh test.`,
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
// Dropping an arm below 2 un-varies the step: live enrollments keep their stored
// variant_key, the resolver finds no overlay, and they fall back to base copy.
// That is the safe direction to fail, but it does end the test — say so.

router.delete('/:id/variants/:variantId', async (req, res) => {
  if (!(await gateSequenceEdit(req, res, req.params.id))) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const delRes = await client.query(
      `DELETE FROM sequence_step_variants sv
        USING sequence_steps ss
        WHERE sv.id = $1 AND ss.id = sv.sequence_step_id
          AND ss.sequence_id = $2 AND sv.org_id = $3
        RETURNING sv.sequence_step_id`,
      [req.params.variantId, req.params.id, req.orgId]
    );
    if (!delRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Variant not found' } });
    }

    const stepId = delRes.rows[0].sequence_step_id;
    const remainRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM sequence_step_variants
        WHERE sequence_step_id = $1 AND status = 'active'`,
      [stepId]
    );
    const remaining = remainRes.rows[0].n;

    await client.query('COMMIT');
    res.json({
      ok: true,
      stepStillVaried: remaining >= 2,
      warning: remaining < 2
        ? 'This step is no longer varied. Live enrollments fall back to the base step templates.'
        : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequence-variants DELETE /:id/variants/:variantId', err);
    res.status(500).json({ error: { message: 'Failed to delete variant' } });
  } finally {
    client.release();
  }
});

// ── GET /:id/experiment — per-arm results ────────────────────────────────────
//
// NOT served from prospecting_metric_daily. Two reasons, both verified against
// the codebase:
//
//   * REPLY. Nothing anywhere sets sequence_step_logs.status = 'replied'. The
//     only writer of 'replied' is SequenceStepFirer.js (on sequence_enrollments,
//     when an inbound email lands after enrolled_at). So the snapshot's
//     replied_steps column is structurally always 0. Reply is ENROLLMENT-grain —
//     which is also the correct unit here, since the arm is the unit of
//     randomisation. One table, no joins.
//
//   * LINKEDIN ACCEPT. connection_accepted arrives asynchronously as a
//     prospect-grain prospecting_activities row with no step-log reference, so
//     MetricSnapshotService's familyActivities carries the '-' sentinel. We
//     anchor on the step log and reach forward, guarding on
//     a.created_at > ssl.fired_at — without that you count prospects who were
//     already connected before the request went out.
//
// Caveats worth surfacing in the UI:
//   * Reply detection is email-only and needs the enrollment to still be active
//     on a due tick, so replies arriving after the final step are never counted.
//     The undercount is equal across arms — it biases the absolute rate down,
//     not the comparison.
//   * ?since / ?until bound the window. There is no experiment identity yet: if
//     you conclude a test, rewrite both arms and run another on the same step,
//     both tests' rows carry the same variant_key. Always pass a window.

router.get('/:id/experiment', async (req, res) => {
  const { since, until } = req.query;
  try {
    const seqRes = await pool.query(
      `SELECT id, name FROM sequences WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Not found' } });
    }

    const params = [req.params.id, req.orgId];
    let window = '';
    if (since) { params.push(since); window += ` AND se.enrolled_at >= $${params.length}::timestamptz`; }
    if (until) { params.push(until); window += ` AND se.enrolled_at <  $${params.length}::timestamptz`; }

    // Enrollment grain: enrolled + replied per arm.
    const enrRes = await pool.query(
      `SELECT se.variant_key,
              COUNT(*)::int                                          AS enrolled,
              COUNT(*) FILTER (WHERE se.status = 'replied')::int     AS replied,
              COUNT(*) FILTER (WHERE se.status = 'active')::int      AS still_active
         FROM sequence_enrollments se
        WHERE se.sequence_id = $1 AND se.org_id = $2
          AND se.variant_key IS NOT NULL ${window}
        GROUP BY se.variant_key
        ORDER BY se.variant_key ASC`,
      params
    );

    // Step-log grain, per arm per varied step: sends, and LinkedIn accepts.
    const stepRes = await pool.query(
      `WITH varied AS (
         SELECT sv.sequence_step_id
           FROM sequence_step_variants sv
           JOIN sequence_steps ss ON ss.id = sv.sequence_step_id
          WHERE ss.sequence_id = $1 AND sv.status = 'active'
          GROUP BY sv.sequence_step_id
         HAVING COUNT(*) >= 2
       )
       SELECT se.variant_key,
              ssl.sequence_step_id,
              ss.step_order,
              ssl.channel,
              COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed','replied'))::int AS sent,
              COUNT(*) FILTER (WHERE ssl.status = 'failed')::int                        AS failed,
              COUNT(DISTINCT a.prospect_id)::int                                        AS li_accepted
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN sequence_steps ss       ON ss.id = ssl.sequence_step_id
         JOIN varied v                ON v.sequence_step_id = ssl.sequence_step_id
    LEFT JOIN prospecting_activities a
           ON a.prospect_id       = ssl.prospect_id
          AND a.org_id            = ssl.org_id
          AND a.activity_type     = 'linkedin_event'
          AND a.metadata->>'event' = 'connection_accepted'
          AND a.created_at > ssl.fired_at
        WHERE se.sequence_id = $1 AND ssl.org_id = $2
          AND se.variant_key IS NOT NULL ${window}
        GROUP BY se.variant_key, ssl.sequence_step_id, ss.step_order, ssl.channel
        ORDER BY ss.step_order ASC, se.variant_key ASC`,
      params
    );

    res.json({
      sequence: seqRes.rows[0],
      window: { since: since || null, until: until || null },
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
      ],
    });
  } catch (err) {
    console.error('sequence-variants GET /:id/experiment', err);
    res.status(500).json({ error: { message: 'Failed to load experiment results' } });
  }
});

module.exports = router;
