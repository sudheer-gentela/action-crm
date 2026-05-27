/**
 * sequences.routes.js
 *
 * Mount at: app.use('/api/sequences', sequencesRoutes)
 *
 * Endpoints
 * ─────────────────────────────────────────────────────
 * GET    /                          list sequences for org
 * POST   /                          create sequence (+ steps)
 * GET    /:id                       get sequence with steps
 * PUT    /:id                       update name/description
 * DELETE /:id                       archive (soft)
 *
 * POST   /:id/steps                 add a step
 * PUT    /:id/steps/:stepId         update a step
 * DELETE /:id/steps/:stepId         delete a step
 * POST   /:id/steps/reorder         reorder steps
 *
 * POST   /:id/ai-generate           AI pre-fill steps for a prospect
 *
 * POST   /enroll                    enroll one or many prospects
 * GET    /enrollments               list enrollments for org
 * GET    /enrollments/:enrollId     get single enrollment + step logs
 * POST   /enrollments/:enrollId/stop  manually stop enrollment
 * POST   /enrollments/:enrollId/pause
 * POST   /enrollments/:enrollId/resume
 *
 * Cron logic lives in services/SequenceStepFirer.js — called directly by server.js
 */

const express = require('express');
const { sendEmail: sendGmailEmail }   = require('../services/googleService');
const { sendEmail: sendOutlookEmail } = require('../services/outlookService');
const { plainTextToHtml }             = require('../services/emailFormatter');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const TokenTrackingService = require('../services/TokenTrackingService');
const { resolvePersonalizeConfig } = require('../services/personalizeConfig');
// Slice 3: personalisation runs through the dispatcher, which walks every
// sequence step and calls per-channel skills with the right step_intent.
const PersonalizationDispatcher = require('../services/PersonalizationDispatcher');
const { buildLinkedInArtifacts }   = require('../services/linkedinSnippets');

// ── AI provider chain (same pattern as ProspectingAIEnhancer) ─────────────────
const AIClientResolver = require('../services/ai/AIClientResolver');

// Phase 3 — sequence reporting: per-rep filters on /enrollments and /:id/stats
// go through the scope service for auth (silently drop out-of-scope userIds).
const ReportingScopeService = require('../services/ReportingScopeService');

// ── Auth middleware on all routes ─────────────────────────────────────────────
router.use(authenticateToken, orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Calculate next_step_due based on delay_days from now (used by enroll) */
function calcDueDate(delayDays) {
  const d = new Date();
  d.setDate(d.getDate() + (parseInt(delayDays) || 0));
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCES CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/sequences
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
              COUNT(DISTINCT ss.id)::int  AS step_count,
              COUNT(DISTINCT se.id)::int  AS enrollment_count,
              cu.first_name AS creator_first_name,
              cu.last_name  AS creator_last_name
         FROM sequences s
    LEFT JOIN sequence_steps ss       ON ss.sequence_id = s.id
    LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id AND se.status = 'active'
    LEFT JOIN users           cu      ON cu.id = s.created_by
        WHERE s.org_id = $1 AND s.status != 'archived'
     GROUP BY s.id, cu.first_name, cu.last_name
     ORDER BY s.created_at DESC`,
      [req.orgId]
    );
    res.json({ sequences: rows });
  } catch (err) {
    console.error('sequences GET /', err);
    res.status(500).json({ error: { message: 'Failed to load sequences' } });
  }
});

// POST /api/sequences  — body: { name, description, require_approval, steps: [{channel, delay_days, subject_template, body_template, task_note, require_approval}] }
router.post('/', async (req, res) => {
  const { name, description, require_approval = true, personalize_config_default = null, steps = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: { message: 'name is required' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seqRes = await client.query(
      `INSERT INTO sequences (org_id, name, description, created_by, require_approval, personalize_config_default)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.orgId, name.trim(), description || null, req.user.userId, require_approval,
       personalize_config_default ? JSON.stringify(personalize_config_default) : null]
    );
    const seq = seqRes.rows[0];

    const insertedSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const sr = await client.query(
        `INSERT INTO sequence_steps
                     (sequence_id, org_id, step_order, channel, delay_days,
                      subject_template, body_template, task_note, require_approval,
                      personalize_config, step_intent)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [seq.id, req.orgId, i + 1, s.channel, s.delay_days ?? 0,
         s.subject_template || null, s.body_template || null, s.task_note || null,
         s.require_approval !== undefined ? s.require_approval : null,
         s.personalize_config ? JSON.stringify(s.personalize_config) : null,
         // Slice 3: step_intent — null means "auto-infer at dispatch time".
         s.step_intent || null]
      );
      insertedSteps.push(sr.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ sequence: { ...seq, steps: insertedSteps } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequences POST /', err);
    res.status(500).json({ error: { message: 'Failed to create sequence' } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI PERSONALISE ENROLLMENT  (Slice 3 — refactored)
// POST /api/sequences/ai-personalise-enrollment
// body: { sequenceId, prospectId, hookPreferences? }
//
// Returns personalised step content for ONE prospect. This endpoint is now
// a thin wrapper around PersonalizationDispatcher — the entire 250-line
// inline prompt that lived here previously is replaced by the dispatcher,
// which walks every sequence step and calls the right per-channel skill
// (outreach-email / outreach-linkedin) with the inferred step_intent.
//
// Response shape is preserved for back-compat with existing callers
// (SequencesView "Preview personalised" feature, etc.):
//   {
//     prospectId,
//     hasResearch,
//     steps: [{ step_order, subject, body, task_note, personalize_sources }],
//     dispatchSummary: { total, personalised, skipped, errored },
//     errors: [{ stepOrder, channel, intent, reason }]
//   }
//
// The dispatchSummary and errors fields are NEW in Slice 3 — additive, so
// callers that ignore them still work.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai-personalise-enrollment', async (req, res) => {
  const { sequenceId, prospectId, hookPreferences } = req.body || {};
  if (!sequenceId || !prospectId) {
    return res.status(400).json({ error: { message: 'sequenceId and prospectId are required' } });
  }

  try {
    // Sequence existence + org scope — guards against the dispatcher loading
    // a sequence from a different org.
    const seqRes = await pool.query(
      `SELECT id, name FROM sequences WHERE id = $1 AND org_id = $2`,
      [sequenceId, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Sequence not found' } });
    }

    // Prospect existence — same guard.
    const pRes = await pool.query(
      `SELECT id, research_notes, research_meta FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, req.orgId]
    );
    if (!pRes.rows.length) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const p = pRes.rows[0];
    const hasResearch = !!(
      p.research_notes ||
      (p.research_meta && typeof p.research_meta === 'object' &&
        (p.research_meta.signal_summary || p.research_meta.researchBullets))
    );

    // Dispatch.
    const dispatchResult = await PersonalizationDispatcher.personaliseEnrollment({
      orgId:      req.orgId,
      userId:     req.user.userId,
      sequenceId,
      prospectId,
      hookPreferences,
    });

    // Convert dispatcher's keyed map into the legacy steps[] array shape.
    const stepOrders = Object.keys(dispatchResult.personalisedSteps || {})
      .map(k => parseInt(k, 10))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const steps = stepOrders.map(order => {
      const s = dispatchResult.personalisedSteps[String(order)] || {};
      return {
        step_order:          order,
        subject:             s.subject   || '',
        body:                s.body      || '',
        task_note:           s.task_note || '',
        personalize_sources: s.personalize_sources || null,
      };
    });

    res.json({
      prospectId,
      hasResearch,
      steps,
      dispatchSummary: dispatchResult.summary,
      errors:          dispatchResult.errors || [],
    });
  } catch (err) {
    console.error('ai-personalise-enrollment error:', err);
    res.status(err.statusCode || 500).json({
      error: { message: 'AI personalisation failed: ' + err.message },
    });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ENROLL  (must be before /:id to avoid shadowing)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sequences/enroll
// body: { sequenceId, prospectIds: [id, ...], personalisedSteps?: { [prospectId]: { [step_order]: { subject, body, task_note } } } }
router.post('/enroll', async (req, res) => {
  const { sequenceId, prospectIds, personalisedSteps } = req.body;
  if (!sequenceId || !Array.isArray(prospectIds) || prospectIds.length === 0) {
    return res.status(400).json({ error: { message: 'sequenceId and prospectIds[] are required' } });
  }

  // Validate sequence belongs to org
  const seqRes = await pool.query(
    `SELECT * FROM sequences WHERE id=$1 AND org_id=$2 AND status='active'`,
    [sequenceId, req.orgId]
  );
  if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Sequence not found' } });

  const sequenceName = seqRes.rows[0].name;

  // Get first step to calculate next_step_due
  const firstStepRes = await pool.query(
    `SELECT delay_days FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order LIMIT 1`,
    [sequenceId]
  );
  const firstDelayDays = firstStepRes.rows[0]?.delay_days ?? 0;

  const enrolled = [];
  const skipped  = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const prospectId of prospectIds) {
      try {
        const nextDue = calcDueDate(firstDelayDays);

        // Pull per-prospect AI drafts if provided, keyed by step_order
        const prosSteps = personalisedSteps?.[prospectId] ?? {};

        const er = await client.query(
          `INSERT INTO sequence_enrollments
                       (org_id, sequence_id, prospect_id, enrolled_by, next_step_due, personalised_steps)
                VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (sequence_id, prospect_id) DO NOTHING
           RETURNING *`,
          [req.orgId, sequenceId, prospectId, req.user.userId, nextDue, JSON.stringify(prosSteps)]
        );

        if (er.rows.length) {
          enrolled.push(er.rows[0]);

          // Write activity so enrollment appears in the prospect's Activity tab
          try {
            await client.query(
              `INSERT INTO prospecting_activities
                           (org_id, prospect_id, user_id, activity_type, description, metadata)
                    VALUES ($1, $2, $3, 'sequence_enrolled', $4, $5)`,
              [req.orgId, 
                prospectId,
                req.user.userId,
                `Enrolled in sequence "${sequenceName}"`,
                JSON.stringify({
                  sequenceId,
                  sequenceName,
                  enrollmentId: er.rows[0].id,
                }),
              ]
            );
          } catch (actErr) {
            // Non-fatal — don't block enrollment if activity log fails
            console.warn('sequence enroll: activity log failed for prospect', prospectId, actErr.message);
          }
        } else {
          skipped.push({ prospectId, reason: 'already enrolled' });
        }
      } catch (err) {
        skipped.push({ prospectId, reason: err.message });
      }
    }

    await client.query('COMMIT');
    res.json({ enrolled: enrolled.length, skipped, enrollments: enrolled });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('enroll error', err);
    res.status(500).json({ error: { message: 'Enrollment failed' } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENTS  (must be before /:id to avoid shadowing)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/sequences/enrollments
router.get('/enrollments', async (req, res) => {
  const { prospectId, status, enrolledBy, depth, sequenceId, campaignId } = req.query;
  try {
    // Phase 3: optional ?enrolledBy=csv and ?depth= filter the enrollments
    // by the rep who enrolled the prospect, intersected with the viewer's
    // resolved scope (silently drops out-of-scope IDs).
    //
    // Phase 4: added ?sequenceId= and ?campaignId= so the reporting view
    // can list prospects within a specific sequence / campaign without
    // pulling the whole org's enrollments.
    //
    // Backward compat: callers without enrolledBy/depth see the original
    // behavior (no per-rep filter). All other filters are independently
    // applied.
    let scopedUserIds = null;   // null = no enrolled_by predicate
    if (enrolledBy !== undefined || depth !== undefined) {
      const explicitUserIds = enrolledBy !== undefined
        ? String(enrolledBy).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger)
        : null;
      const scope = await ReportingScopeService.resolveReportingScope(
        req.user.userId,
        req.orgId,
        { depth, explicitUserIds }
      );
      scopedUserIds = scope.userIds;
    }

    // Phase 4: enriched response. The reporting view needs per-enrollment
    // step progress (current step, total steps, last log activity) without
    // a per-row follow-up fetch. We compute these inline via subqueries on
    // sequence_steps and sequence_step_logs.
    let query = `
      SELECT se.*,
             s.name AS sequence_name,
             p.first_name, p.last_name, p.email, p.company_name,
             p.campaign_id,
             (SELECT COUNT(*)::int FROM sequence_steps
                WHERE sequence_id = se.sequence_id) AS total_steps,
             (SELECT MAX(fired_at) FROM sequence_step_logs
                WHERE enrollment_id = se.id) AS last_fired_at,
             (SELECT status FROM sequence_step_logs
                WHERE enrollment_id = se.id
                ORDER BY fired_at DESC NULLS LAST LIMIT 1) AS last_log_status
        FROM sequence_enrollments se
        JOIN sequences s ON s.id = se.sequence_id
        JOIN prospects p ON p.id = se.prospect_id
       WHERE se.org_id = $1`;
    const params = [req.orgId];

    if (prospectId) { params.push(prospectId); query += ` AND se.prospect_id = $${params.length}`; }
    if (status)     { params.push(status);     query += ` AND se.status = $${params.length}`; }
    if (sequenceId) { params.push(sequenceId); query += ` AND se.sequence_id = $${params.length}`; }
    if (campaignId) { params.push(campaignId); query += ` AND p.campaign_id = $${params.length}`; }
    if (scopedUserIds !== null) {
      params.push(scopedUserIds);
      query += ` AND se.enrolled_by = ANY($${params.length}::int[])`;
    }

    query += ' ORDER BY se.enrolled_at DESC LIMIT 200';
    const { rows } = await pool.query(query, params);
    res.json({ enrollments: rows });
  } catch (err) {
    console.error('enrollments GET', err);
    res.status(500).json({ error: { message: 'Failed to load enrollments' } });
  }
});

// GET /api/sequences/enrollments/:enrollId
// Returns enrollment + full step timeline:
//   - Executed steps (from sequence_step_logs) with fired_at, subject, body, status
//   - Future planned steps (from sequence_steps) with calculated due dates
router.get('/enrollments/:enrollId', async (req, res) => {
  try {
    const er = await pool.query(
      `SELECT se.*, s.name AS sequence_name, s.id AS seq_id,
              p.first_name, p.last_name, p.email, p.company_name
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.id=$1 AND se.org_id=$2`,
      [req.params.enrollId, req.orgId]
    );
    if (!er.rows.length) return res.status(404).json({ error: { message: 'Not found' } });
    const enrollment = er.rows[0];

    // All executed / drafted logs for this enrollment
    const logsRes = await pool.query(
      `SELECT ssl.id, ssl.status, ssl.fired_at, ssl.scheduled_send_at,
              ssl.subject, ssl.body, ssl.channel, ssl.error_message,
              ss.step_order, ss.channel AS step_channel, ss.task_note,
              ss.delay_days, ss.id AS step_id
         FROM sequence_step_logs ssl
         JOIN sequence_steps ss ON ss.id = ssl.sequence_step_id
        WHERE ssl.enrollment_id = $1
        ORDER BY ss.step_order ASC, ssl.fired_at ASC NULLS LAST`,
      [req.params.enrollId]
    );

    // All steps in the sequence (to build future planned steps)
    const stepsRes = await pool.query(
      `SELECT id, step_order, channel, delay_days, subject_template,
              body_template, task_note, require_approval
         FROM sequence_steps
        WHERE sequence_id = $1
        ORDER BY step_order ASC`,
      [enrollment.seq_id]
    );

    // Build a map of step_order → log (most recent if multiple)
    const logByStep = {};
    for (const log of logsRes.rows) {
      logByStep[log.step_order] = log;
    }

    // Calculate due dates for future steps by walking from next_step_due
    const now = new Date();
    let rollingDate = enrollment.next_step_due
      ? new Date(enrollment.next_step_due)
      : now;

    const timeline = stepsRes.rows.map(step => {
      const log = logByStep[step.step_order];

      if (log) {
        return {
          step_order:       step.step_order,
          step_id:          step.id,
          channel:          step.channel,
          delay_days:       step.delay_days,
          task_note:        step.task_note || null,
          subject_template: step.subject_template || null,
          log_id:           log.id,
          status:           log.status,
          fired_at:         log.fired_at || null,
          scheduled_send_at: log.scheduled_send_at || null,
          subject:          log.subject || null,
          body:             log.body    || null,
          error_message:    log.error_message || null,
          is_future:        false,
        };
      }

      let due;
      if (step.step_order === enrollment.current_step) {
        due = rollingDate;
      } else if (step.step_order > enrollment.current_step) {
        const d = new Date(rollingDate);
        d.setDate(d.getDate() + (parseInt(step.delay_days) || 0));
        due = d;
        rollingDate = due;
      }

      const personalised = enrollment.personalised_steps?.[step.step_order]
        || enrollment.personalised_steps?.[String(step.step_order)];

      return {
        step_order:        step.step_order,
        step_id:           step.id,
        channel:           step.channel,
        delay_days:        step.delay_days,
        task_note:         step.task_note || null,
        subject_template:  personalised?.subject || step.subject_template || null,
        body_template:     personalised?.body    || step.body_template    || null,
        log_id:            null,
        status:            enrollment.status === 'active' ? 'pending' : 'skipped',
        fired_at:          null,
        scheduled_send_at: due || null,
        subject:           null,
        body:              null,
        error_message:     null,
        is_future:         true,
        is_personalised:   !!personalised,
      };
    });

    res.json({ enrollment, logs: timeline });
  } catch (err) {
    console.error('enrollment GET /:id', err);
    res.status(500).json({ error: { message: 'Failed to load enrollment' } });
  }
});

// POST /api/sequences/enrollments/:enrollId/stop
router.post('/enrollments/:enrollId/stop', async (req, res) => {
  const { reason = 'manual' } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_enrollments
          SET status='stopped', stopped_at=NOW(), stop_reason=$1
        WHERE id=$2 AND org_id=$3 RETURNING *`,
      [reason, req.params.enrollId, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ enrollment: rows[0] });
  } catch (err) {
    console.error('enrollment stop', err);
    res.status(500).json({ error: { message: 'Failed to stop enrollment' } });
  }
});

// POST /api/sequences/enrollments/:enrollId/pause
router.post('/enrollments/:enrollId/pause', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_enrollments SET status='paused'
        WHERE id=$1 AND org_id=$2 AND status='active' RETURNING *`,
      [req.params.enrollId, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found or not active' } });
    res.json({ enrollment: rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to pause' } });
  }
});

// POST /api/sequences/enrollments/:enrollId/resume
router.post('/enrollments/:enrollId/resume', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_enrollments SET status='active', next_step_due=NOW()
        WHERE id=$1 AND org_id=$2 AND status='paused' RETURNING *`,
      [req.params.enrollId, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found or not paused' } });
    res.json({ enrollment: rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to resume' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DRAFT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/sequences/drafts  (?prospectId=X)
// List all draft step logs for the current user.
// Returns everything the UI needs to render + send the email.
router.get('/drafts', async (req, res) => {
  const { prospectId } = req.query;
  try {
    // Sender resolution mirrors SequenceStepFirer.resolveSender():
    //   1. If prospect.client_id is set, prefer a client-owned sender.
    //   2. Otherwise fall back to the rep's personal sender (client_id IS NULL).
    //
    // Source-of-truth for rendering: ss.channel (the CURRENT sequence step),
    // NOT ssl.channel (the draft-time snapshot). We return both so the UI
    // can detect drift (rep edited the sequence after draft was created).
    //
    // ownerType is derived in SQL (client vs user priority) rather than
    // read from a column.
    let query = `
      SELECT
        ssl.id, ssl.enrollment_id, ssl.subject, ssl.body,
        ssl.scheduled_send_at, ssl.status,
        ssl.channel        AS draft_channel,
        ssl.personalize_sources,
        ss.step_order,
        ss.channel         AS step_channel,
        ss.subject_template AS step_subject_template,
        ss.body_template    AS step_body_template,
        se.sequence_id, se.enrolled_by,
        s.name AS sequence_name,
        p.id AS prospect_id, p.first_name, p.last_name,
        p.email AS prospect_email, p.company_name, p.linkedin_url,
        p.client_id AS prospect_client_id,
        psa.id                 AS sender_id,
        psa.email              AS sender_email,
        psa.provider           AS sender_provider,
        psa.label              AS sender_label,
        psa.display_name       AS sender_display_name,
        psa.signature          AS sender_signature,
        psa.linkedin_signature AS sender_linkedin_signature,
        psa.owner_type         AS sender_owner_type
      FROM sequence_step_logs ssl
      JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
      JOIN sequences s             ON s.id   = se.sequence_id
      JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
      JOIN prospects p             ON p.id   = ssl.prospect_id
      LEFT JOIN LATERAL (
        SELECT id, email, provider, label, display_name,
               signature, linkedin_signature, owner_type
        FROM (
          -- Client sender (preferred when prospect belongs to a client).
          -- Dormant: agency module not in use, so this branch returns zero rows.
          SELECT id, email, provider, label, display_name,
                 signature, linkedin_signature,
                 'client'::text AS owner_type,
                 1              AS priority,
                 last_reset_at, emails_sent_today, last_sent_at
            FROM prospecting_sender_accounts
           WHERE org_id     = ssl.org_id
             AND client_id IS NOT NULL
             AND client_id  = p.client_id
             AND is_active  = true

          UNION ALL

          -- Rep personal sender (the only branch that matches in practice).
          SELECT id, email, provider, label, display_name,
                 signature, linkedin_signature,
                 'user'::text AS owner_type,
                 2            AS priority,
                 last_reset_at, emails_sent_today, last_sent_at
            FROM prospecting_sender_accounts
           WHERE org_id     = ssl.org_id
             AND user_id    = se.enrolled_by
             AND client_id IS NULL
             AND is_active  = true
        ) candidates
        ORDER BY
          priority ASC,
          (CASE WHEN last_reset_at < CURRENT_DATE THEN 0 ELSE emails_sent_today END) ASC,
          last_sent_at ASC NULLS FIRST
        LIMIT 1
      ) psa ON true
      WHERE ssl.org_id = $1
        AND ssl.status = 'draft'
        AND se.enrolled_by = $2
    `;
    const params = [req.orgId, req.user.userId];
    if (prospectId) {
      params.push(parseInt(prospectId));
      query += ` AND ssl.prospect_id = $${params.length}`;
    }
    query += ' ORDER BY ssl.scheduled_send_at ASC';

    const { rows } = await pool.query(query, params);

    const drafts = rows.map(r => {
      // Source of truth = current sequence step channel.
      // draftChannel is the snapshot at creation time; exposed so the UI
      // can show a hint when they disagree (rep edited the sequence).
      const channel      = r.step_channel;       // live step channel
      const draftChannel = r.draft_channel;      // snapshot
      const channelDrift = channel !== draftChannel;

      // Subject can be empty on LinkedIn drafts — if the step is now email
      // and the draft was composed as LinkedIn, fall back to the step
      // template so the email has at least something in the subject line.
      const subject = r.subject || (channelDrift && channel === 'email' ? (r.step_subject_template || '') : '');

      return {
        id:              r.id,
        enrollmentId:    r.enrollment_id,
        sequenceId:      r.sequence_id,
        sequenceName:    r.sequence_name,
        stepOrder:       r.step_order,
        channel,                 // live step channel — render by this
        draftChannel,            // snapshot at creation — for drift hint
        channelDrift,            // true if the sequence was edited after drafting
        subject,
        body:            r.body || '',
        scheduledSendAt: r.scheduled_send_at,
        isOverdue:       new Date(r.scheduled_send_at) < new Date(),
        // Send Now is only valid for current-email steps with a prospect email.
        canSendNow:      channel === 'email' && !!r.prospect_email,
        prospect: {
          id:          r.prospect_id,
          firstName:   r.first_name,
          lastName:    r.last_name,
          email:       r.prospect_email,
          companyName: r.company_name,
          linkedinUrl: r.linkedin_url || null,
        },
        suggestedSender: r.sender_id ? {
          id:                r.sender_id,
          email:             r.sender_email,
          provider:          r.sender_provider,
          label:             r.sender_label,
          displayName:       r.sender_display_name,
          signature:         r.sender_signature,
          linkedinSignature: r.sender_linkedin_signature,
          ownerType:         r.sender_owner_type, // 'client' | 'user'
        } : null,
        // Phase 3: provenance for the AI's LinkedIn data sources, if any.
        // Null when the step had no personalize config or no profile data.
        personalizeSources: r.personalize_sources || null,
      };
    });

    res.json({ drafts });
  } catch (err) {
    console.error('GET /sequences/drafts', err);
    res.status(500).json({ error: { message: 'Failed to load drafts' } });
  }
});

// ── PATCH /api/sequences/drafts/:logId
// Rep edits subject, body, and/or channel before sending.
// channel is allowed when correcting a draft whose step was changed after creation
// (e.g. linkedin -> email). Only 'email' is a valid target channel for sending.
router.patch('/drafts/:logId', async (req, res) => {
  const { subject, body, channel } = req.body;
  const ALLOWED_CHANNELS = ['email', 'linkedin', 'call', 'task'];
  if (channel !== undefined && !ALLOWED_CHANNELS.includes(channel)) {
    return res.status(400).json({ error: { message: `Invalid channel: ${channel}` } });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_step_logs
          SET subject = COALESCE($1, subject),
              body    = COALESCE($2, body),
              channel = COALESCE($3, channel)
        WHERE id = $4
          AND org_id = $5
          AND status = 'draft'
        RETURNING *`,
      [subject ?? null, body ?? null, channel ?? null, req.params.logId, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Draft not found or already sent' } });
    res.json({ draft: rows[0] });
  } catch (err) {
    console.error('PATCH /sequences/drafts/:logId', err);
    res.status(500).json({ error: { message: 'Failed to update draft' } });
  }
});

// ── POST /api/sequences/drafts/:logId/send
// Rep approves and sends the draft email via their prospecting sender account.
// Mirrors the logic in POST /prospecting-actions/outreach-send.
router.post('/drafts/:logId/send', async (req, res) => {
  const { senderAccountId } = req.body; // optional — omit for auto-rotation
  const client = await pool.connect();
  try {
    // ── 1. Load draft + enrollment + prospect ──────────────────────────────
    // ss.channel is the CURRENT step channel (source of truth).
    // ssl.channel is the snapshot at draft creation — kept for diagnostics.
    const draftRes = await client.query(
      `SELECT ssl.*,
              ssl.channel AS draft_channel,
              ss.step_order,
              ss.channel  AS step_channel,
              se.enrolled_by, se.sequence_id,
              se.current_step, se.org_id AS enroll_org_id,
              s.name AS sequence_name
         FROM sequence_step_logs ssl
         JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
         JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
         JOIN sequences s             ON s.id   = se.sequence_id
        WHERE ssl.id = $1 AND ssl.org_id = $2 AND ssl.status = 'draft'`,
      [req.params.logId, req.orgId]
    );
    if (!draftRes.rows.length) {
      return res.status(404).json({ error: { message: 'Draft not found or already sent' } });
    }
    const draft = draftRes.rows[0];

    // Guard: only the rep who enrolled can send
    if (draft.enrolled_by !== req.user.userId) {
      return res.status(403).json({ error: { message: 'Only the enrolling rep can send this draft' } });
    }

    const prospectRes = await client.query(
      `SELECT p.*, a.name AS account_name
         FROM prospects p
    LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.id = $1 AND p.org_id = $2`,
      [draft.prospect_id, req.orgId]
    );
    if (!prospectRes.rows.length) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const prospect = prospectRes.rows[0];

    // ── Channel guard — send only if the CURRENT step is email ──────────────
    // Source of truth is ss.channel (the live sequence step), not ssl.channel.
    // Two drift scenarios are possible and handled here:
    //   (a) Draft was linkedin, step is now email → allow send (rule #3).
    //   (b) Draft was email, step is now linkedin → block, rep must Mark Done.
    // A non-email send would silently do nothing in the provider branch
    // but still mark the log 'sent' and advance the enrollment — a ghost send.
    if (draft.step_channel !== 'email') {
      return res.status(400).json({
        error: {
          message: `This step is now a ${draft.step_channel} step — use "Mark as Done" once you have completed the action on ${draft.step_channel === 'linkedin' ? 'LinkedIn' : 'the appropriate channel'}.`,
          code: 'WRONG_CHANNEL',
        },
      });
    }

    if (!prospect.email) {
      return res.status(400).json({ error: { message: 'Prospect has no email address' } });
    }

    // ── 2. Select sender account ───────────────────────────────────────────
    // CHANGED: AND client_id IS NULL on both branches — rep's personal senders only.
    // Client senders are selected automatically by SequenceStepFirer at draft
    // creation time; the rep sends from whichever account the draft was created for.
    let sender;
    if (senderAccountId) {
      const r = await client.query(
        `SELECT * FROM prospecting_sender_accounts
          WHERE id=$1 AND org_id=$2 AND user_id=$3 AND client_id IS NULL AND is_active=true`,
        [senderAccountId, req.orgId, req.user.userId]
      );
      if (!r.rows.length) return res.status(404).json({ error: { message: 'Sender account not found or inactive' } });
      sender = r.rows[0];
    } else {
      const r = await client.query(
        `SELECT * FROM prospecting_sender_accounts
          WHERE org_id=$1 AND user_id=$2 AND client_id IS NULL AND is_active=true
          ORDER BY
            (CASE WHEN last_reset_at < CURRENT_DATE THEN 0 ELSE emails_sent_today END) ASC,
            last_sent_at ASC NULLS FIRST
          LIMIT 1`,
        [req.orgId, req.user.userId]
      );
      if (!r.rows.length) {
        return res.status(400).json({
          error: { message: 'No active sender accounts. Connect a Gmail or Outlook account in Settings → Outreach.', code: 'NO_SENDER_ACCOUNTS' }
        });
      }
      sender = r.rows[0];
    }

    // ── 3. Reset daily counter if new day ─────────────────────────────────
    if (new Date(sender.last_reset_at).toDateString() !== new Date().toDateString()) {
      await client.query(
        `UPDATE prospecting_sender_accounts
            SET emails_sent_today=0, last_reset_at=CURRENT_DATE, updated_at=CURRENT_TIMESTAMP
          WHERE id=$1`,
        [sender.id]
      );
      sender.emails_sent_today = 0;
    }

    // ── 4. Enforce daily limit ─────────────────────────────────────────────
    const limitsRes = await client.query(
      `SELECT config FROM org_integrations
        WHERE org_id=$1 AND integration_type='prospecting_email'`,
      [req.orgId]
    );
    const orgConfig = limitsRes.rows[0]?.config || {};
    const dailyLimit = Math.min(sender.daily_limit ?? (orgConfig.defaultDailyLimit || 50), orgConfig.dailyLimitCeiling || 100);

    if (sender.emails_sent_today >= dailyLimit) {
      return res.status(429).json({
        error: { message: `Daily send limit reached for ${sender.email} (${dailyLimit}/day). Resets tomorrow.`, code: 'DAILY_LIMIT_REACHED' }
      });
    }

    // ── 5. Ensure signature is present (safety-net), then convert to HTML ────
    // bodyToSend stays as plain text until the very last moment so the
    // DB record (step 7) stores the plain-text version. htmlBody is what
    // actually goes over the wire to Gmail / Outlook.
    let bodyToSend = draft.body || '';
    if (sender.signature) {
      const trimmedSig = sender.signature.trim();
      if (trimmedSig && !bodyToSend.includes(trimmedSig)) {
        bodyToSend = bodyToSend + `\n\n${trimmedSig}`;
      }
    }
    const htmlBody = plainTextToHtml(bodyToSend);

    // ── 6. Send via Gmail or Outlook ───────────────────────────────────────
    // IMPORTANT: errors here are NOT swallowed. If the send fails (expired token,
    // network error, etc.) we return a 502 immediately so:
    //   a) The draft stays in the queue — the rep can retry after reconnecting
    //   b) We never write a ghost 'sent' record to the DB
    // The frontend catches the 502 and shows the error on the draft card.
    try {
      if (sender.provider === 'gmail') {
        await sendGmailEmail(req.user.userId, {
          to:           prospect.email,
          subject:      draft.subject,
          body:         htmlBody,
          isHtml:       true,
          senderEmail:  sender.email,
          accessToken:  sender.access_token,
          refreshToken: sender.refresh_token,
        });
      } else if (sender.provider === 'outlook') {
        await sendOutlookEmail(req.user.userId, {
          to:           prospect.email,
          subject:      draft.subject,
          body:         htmlBody,
          isHtml:       true,
          senderEmail:  sender.email,
          accessToken:  sender.access_token,
          refreshToken: sender.refresh_token,
        });
      }
    } catch (err) {
      console.error(`❌ Draft send failed for log ${req.params.logId} → ${prospect.email}:`, err.message);
      // Surface token expiry as a clear actionable message
      // Only flag as token error on confirmed invalid_grant — not generic 401/unauthorized
      // which can come from other causes and would show a false "needs to be reconnected" message.
      const isTokenError = /invalid_grant|needs to be reconnected/i.test(err.message);
      const userMessage = isTokenError
        ? `Sending account ${sender.email} needs to be reconnected — go to Settings → Outreach and reconnect it.`
        : `Failed to send email: ${err.message}`;
      return res.status(502).json({ error: { message: userMessage, code: isTokenError ? 'TOKEN_EXPIRED' : 'SEND_FAILED' } });
    }

    const sendError = null; // send succeeded — no error
    await client.query('BEGIN');

    // ── 7. Save email to DB ────────────────────────────────────────────────
    const emailRes = await client.query(
      `INSERT INTO emails
         (org_id, user_id, direction, subject, body,
          to_address, from_address, sent_at, prospect_id, sender_account_id, provider)
       VALUES ($1,$2,'sent',$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$9)
       RETURNING *`,
      [req.orgId, req.user.userId, draft.subject, bodyToSend,
       prospect.email, sender.email, draft.prospect_id, sender.id, sender.provider]
    );
    const newEmail = emailRes.rows[0];

    // ── 8. Flip draft → sent ───────────────────────────────────────────────
    await client.query(
      `UPDATE sequence_step_logs
          SET status='sent', fired_at=NOW(), email_id=$1, body=$2
        WHERE id=$3`,
      [newEmail.id, bodyToSend, draft.id]
    );

    // ── 9. Update sender counters ──────────────────────────────────────────
    await client.query(
      `UPDATE prospecting_sender_accounts
          SET emails_sent_today=emails_sent_today+1,
              last_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [sender.id]
    );

    // ── 10. Update prospect outreach tracking ──────────────────────────────
    await client.query(
      `UPDATE prospects
          SET outreach_count=outreach_count+1, last_outreach_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [draft.prospect_id]
    );

    // Auto-advance stage on first outreach
    const stageRes = await client.query(`SELECT stage, channel_data FROM prospects WHERE id=$1`, [draft.prospect_id]);
    const currentStage = stageRes.rows[0]?.stage;
    if (['target', 'research'].includes(currentStage)) {
      await client.query(
        `UPDATE prospects SET stage='outreach', stage_changed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [draft.prospect_id]
      );
    }

    // ── Sync LinkedIn channel_data if this is a LinkedIn step ────────────────
    if (draft.channel === 'linkedin') {
      const channelData = stageRes.rows[0]?.channel_data || {};
      const li          = channelData.linkedin || {};
      const STATUS_ORDER = [
        'connection_request_sent', 'connection_accepted',
        'message_sent', 'reply_received', 'meeting_booked',
      ];
      const liStatus   = draft.step_order === 1 ? 'connection_request_sent' : 'message_sent';
      const currentIdx = STATUS_ORDER.indexOf(li.connection_status || '');
      const newIdx     = STATUS_ORDER.indexOf(liStatus);
      if (newIdx > currentIdx) {
        li.connection_status = liStatus;
      }
      if (liStatus === 'connection_request_sent' && !li.request_sent_at) {
        li.request_sent_at = new Date().toISOString();
      } else if (liStatus === 'message_sent') {
        li.last_message_at = new Date().toISOString();
        li.message_count   = (li.message_count || 0) + 1;
      }
      channelData.linkedin = li;
      await client.query(
        `UPDATE prospects SET channel_data = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(channelData), draft.prospect_id]
      );
    }

    // ── 11. Advance enrollment to next step ────────────────────────────────
    const enrollRes = await client.query(
      `SELECT se.*, s.id AS seq_id FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
        WHERE se.id=$1`,
      [draft.enrollment_id]
    );
    const enrollment = enrollRes.rows[0];

    if (enrollment) {
      const nextStepRes = await client.query(
        `SELECT * FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2`,
        [enrollment.seq_id, enrollment.current_step + 1]
      );
      if (nextStepRes.rows.length) {
        const ns = nextStepRes.rows[0];
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + (parseInt(ns.delay_days) || 0));
        await client.query(
          `UPDATE sequence_enrollments SET current_step=$1, next_step_due=$2 WHERE id=$3`,
          [enrollment.current_step + 1, nextDue, enrollment.id]
        );
      } else {
        await client.query(
          `UPDATE sequence_enrollments SET status='completed', completed_at=NOW() WHERE id=$1`,
          [enrollment.id]
        );
      }
    }

    // ── 12. Mark any linked overdue action completed ───────────────────────
    await client.query(
      `UPDATE prospecting_actions
          SET status='completed', completed_at=CURRENT_TIMESTAMP,
              completed_by=$1, outcome='email_sent', updated_at=CURRENT_TIMESTAMP
        WHERE org_id=$2
          AND source='sequence_draft'
          AND (metadata->>'draftLogId')::int = $3
          AND status != 'completed'`,
      [req.user.userId, req.orgId, draft.id]
    );

    // ── 13. Write activity ─────────────────────────────────────────────────
    await client.query(
      `INSERT INTO prospecting_activities
         (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2,$3,'sequence_step_sent',$4,$5)`,
      [req.orgId, 
        draft.prospect_id, req.user.userId,
        `Sequence step ${draft.step_order} sent — ${draft.sequence_name}: ${draft.subject || '(no subject)'}`,
        JSON.stringify({
          enrollmentId: draft.enrollment_id,
          sequenceId:   draft.sequence_id,
          sequenceName: draft.sequence_name,
          stepOrder:    draft.step_order,
          draftLogId:   draft.id,
          emailId:      newEmail.id,
          senderId:     sender.id,
          fromEmail:    sender.email,
          sendError:    sendError || null,
        }),
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      emailSent:   !sendError,
      sendError:   sendError || null,
      emailId:     newEmail.id,
      fromAddress: sender.email,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /sequences/drafts/:logId/send', err);
    res.status(500).json({ error: { message: 'Failed to send draft: ' + err.message } });
  } finally {
    client.release();
  }
});

// ── DELETE /api/sequences/drafts/:logId
// Rep discards a draft — step is consumed and enrollment advances.
// ── POST /api/sequences/drafts/:logId/complete
// Mark a non-email step (LinkedIn, call, task) as completed manually.
// The rep did the action outside the CRM — this logs it as done and
// advances the enrollment to the next step, same as Send Now does for email.
router.post('/drafts/:logId/complete', async (req, res) => {
  const client = await pool.connect();
  try {
    // Load draft + enrollment context
    const draftRes = await client.query(
      `SELECT ssl.*, ss.step_order, ss.channel,
              se.enrolled_by, se.current_step,
              s.id AS seq_id, s.name AS sequence_name
         FROM sequence_step_logs ssl
         JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
         JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
         JOIN sequences s             ON s.id   = se.sequence_id
        WHERE ssl.id=$1 AND ssl.org_id=$2 AND ssl.status='draft'`,
      [req.params.logId, req.orgId]
    );
    if (!draftRes.rows.length) {
      return res.status(404).json({ error: { message: 'Draft not found or already actioned' } });
    }
    const draft = draftRes.rows[0];

    if (draft.enrolled_by !== req.user.userId) {
      return res.status(403).json({ error: { message: 'Only the enrolling rep can complete this step' } });
    }

    // ── Channel guard — reject /complete for steps that are now email ─────
    // If the step is currently email, the rep should use Send Now so an
    // actual email goes out. Letting /complete through here would silently
    // close the step without sending anything.
    if (draft.channel === 'email') {
      return res.status(400).json({
        error: {
          message: 'This step is now an email step — use "Send Now" to dispatch it.',
          code: 'WRONG_CHANNEL',
        },
      });
    }

    await client.query('BEGIN');

    // ── 1. Mark step log as completed ─────────────────────────────────────
    await client.query(
      `UPDATE sequence_step_logs SET status='completed', fired_at=NOW() WHERE id=$1`,
      [draft.id]
    );

    // ── 2. Update prospect outreach tracking ──────────────────────────────
    await client.query(
      `UPDATE prospects
          SET outreach_count=outreach_count+1, last_outreach_at=CURRENT_TIMESTAMP,
              updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [draft.prospect_id]
    );

    // Auto-advance prospect stage on first outreach
    const stageRes = await client.query(
      `SELECT stage, channel_data FROM prospects WHERE id=$1`,
      [draft.prospect_id]
    );
    const currentStage = stageRes.rows[0]?.stage;
    if (['target', 'research'].includes(currentStage)) {
      await client.query(
        `UPDATE prospects
            SET stage='outreach', stage_changed_at=CURRENT_TIMESTAMP,
                updated_at=CURRENT_TIMESTAMP
          WHERE id=$1`,
        [draft.prospect_id]
      );
    }

    // ── 2b. Sync LinkedIn channel_data if this is a LinkedIn step ────────────
    // So the LinkedIn funnel status updates when rep clicks Mark as Done,
    // without requiring a separate Save on the Chrome extension.
    if (draft.channel === 'linkedin') {
      const channelData = stageRes.rows[0]?.channel_data || {};
      const li          = channelData.linkedin || {};
      const STATUS_ORDER = [
        'connection_request_sent', 'connection_accepted',
        'message_sent', 'reply_received', 'meeting_booked',
      ];
      // Map sequence step order to LinkedIn status
      // step 1 = connection request, step 2+ = message
      const liStatus = draft.step_order === 1 ? 'connection_request_sent' : 'message_sent';
      const currentIdx = STATUS_ORDER.indexOf(li.connection_status || '');
      const newIdx     = STATUS_ORDER.indexOf(liStatus);
      if (newIdx > currentIdx) {
        li.connection_status = liStatus;
      }
      if (liStatus === 'connection_request_sent' && !li.request_sent_at) {
        li.request_sent_at = new Date().toISOString();
      } else if (liStatus === 'message_sent') {
        li.last_message_at = new Date().toISOString();
        li.message_count   = (li.message_count || 0) + 1;
      }
      channelData.linkedin = li;
      await client.query(
        `UPDATE prospects SET channel_data = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [JSON.stringify(channelData), draft.prospect_id]
      );
    }

    // ── 3. Advance enrollment to next step ────────────────────────────────
    const nextStepRes = await client.query(
      `SELECT * FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2`,
      [draft.seq_id, draft.current_step + 1]
    );
    if (nextStepRes.rows.length) {
      const ns = nextStepRes.rows[0];
      const nextDue = new Date();
      nextDue.setDate(nextDue.getDate() + (parseInt(ns.delay_days) || 0));
      await client.query(
        `UPDATE sequence_enrollments
            SET current_step=$1, next_step_due=$2
          WHERE id=$3`,
        [draft.current_step + 1, nextDue, draft.enrollment_id]
      );
    } else {
      await client.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW() WHERE id=$1`,
        [draft.enrollment_id]
      );
    }

    // ── 4. Mark any linked prospecting action completed ───────────────────
    await client.query(
      `UPDATE prospecting_actions
          SET status='completed', completed_at=CURRENT_TIMESTAMP,
              completed_by=$1, outcome='completed_manually', updated_at=CURRENT_TIMESTAMP
        WHERE org_id=$2 AND source='sequence_draft'
          AND (metadata->>'draftLogId')::int=$3
          AND status != 'completed'`,
      [req.user.userId, req.orgId, draft.id]
    );

    // ── 5. Write activity ─────────────────────────────────────────────────
    await client.query(
      `INSERT INTO prospecting_activities
         (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2,$3,'sequence_step_completed',$4,$5)`,
      [req.orgId, 
        draft.prospect_id, req.user.userId,
        `${draft.channel} step completed — ${draft.sequence_name} step ${draft.step_order}`,
        JSON.stringify({
          enrollmentId: draft.enrollment_id,
          draftLogId:   draft.id,
          stepOrder:    draft.step_order,
          channel:      draft.channel,
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({ ok: true });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /sequences/drafts/:logId/complete', err);
    res.status(500).json({ error: { message: 'Failed to complete step: ' + err.message } });
  } finally {
    client.release();
  }
});

router.delete('/drafts/:logId', async (req, res) => {
  const client = await pool.connect();
  try {
    const draftRes = await client.query(
      `SELECT ssl.*, ss.step_order, se.enrolled_by, se.current_step,
              s.id AS seq_id, s.name AS sequence_name
         FROM sequence_step_logs ssl
         JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
         JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
         JOIN sequences s             ON s.id   = se.sequence_id
        WHERE ssl.id=$1 AND ssl.org_id=$2 AND ssl.status='draft'`,
      [req.params.logId, req.orgId]
    );
    if (!draftRes.rows.length) {
      return res.status(404).json({ error: { message: 'Draft not found or already actioned' } });
    }
    const draft = draftRes.rows[0];

    if (draft.enrolled_by !== req.user.userId) {
      return res.status(403).json({ error: { message: 'Only the enrolling rep can discard this draft' } });
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE sequence_step_logs SET status='skipped', fired_at=NOW() WHERE id=$1`,
      [draft.id]
    );

    const nextStepRes = await client.query(
      `SELECT * FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2`,
      [draft.seq_id, draft.current_step + 1]
    );
    if (nextStepRes.rows.length) {
      const ns = nextStepRes.rows[0];
      const nextDue = new Date();
      nextDue.setDate(nextDue.getDate() + (parseInt(ns.delay_days) || 0));
      await client.query(
        `UPDATE sequence_enrollments SET current_step=$1, next_step_due=$2 WHERE id=$3`,
        [draft.current_step + 1, nextDue, draft.enrollment_id]
      );
    } else {
      await client.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW() WHERE id=$1`,
        [draft.enrollment_id]
      );
    }

    await client.query(
      `UPDATE prospecting_actions
          SET status='completed', completed_at=CURRENT_TIMESTAMP,
              completed_by=$1, outcome='skipped', updated_at=CURRENT_TIMESTAMP
        WHERE org_id=$2 AND source='sequence_draft'
          AND (metadata->>'draftLogId')::int=$3
          AND status != 'completed'`,
      [req.user.userId, req.orgId, draft.id]
    );

    await client.query(
      `INSERT INTO prospecting_activities
         (org_id, prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2,$3,'sequence_step_skipped',$4,$5)`,
      [req.orgId, 
        draft.prospect_id, req.user.userId,
        `Draft discarded — ${draft.sequence_name} step ${draft.step_order}`,
        JSON.stringify({ enrollmentId: draft.enrollment_id, draftLogId: draft.id, stepOrder: draft.step_order }),
      ]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /sequences/drafts/:logId', err);
    res.status(500).json({ error: { message: 'Failed to discard draft: ' + err.message } });
  } finally {
    client.release();
  }
});

// SEQUENCES CRUD  — /:id routes last so literals above aren't shadowed
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/sequences/:id
router.get('/:id', async (req, res) => {
  try {
    const seqRes = await pool.query(
      `SELECT s.*,
              cu.first_name AS creator_first_name,
              cu.last_name  AS creator_last_name,
              (SELECT COUNT(*)::int FROM sequence_enrollments se
                 WHERE se.sequence_id = s.id AND se.status = 'active'
              ) AS active_enrollment_count
         FROM sequences s
    LEFT JOIN users cu ON cu.id = s.created_by
        WHERE s.id = $1 AND s.org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Not found' } });

    const stepsRes = await pool.query(
      `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order`,
      [req.params.id]
    );
    res.json({ sequence: { ...seqRes.rows[0], steps: stepsRes.rows } });
  } catch (err) {
    console.error('sequences GET /:id', err);
    res.status(500).json({ error: { message: 'Failed to load sequence' } });
  }
});

// PUT /api/sequences/:id
router.put('/:id', async (req, res) => {
  const { name, description, require_approval, personalize_config_default } = req.body;
  try {
    // personalize_config_default semantics:
    //   undefined → don't touch (COALESCE keeps existing)
    //   null      → explicitly clear (revert to user/system default in cascade)
    //   object    → set new override
    const pcdParam = personalize_config_default === undefined
      ? null
      : (personalize_config_default === null ? null : JSON.stringify(personalize_config_default));
    const pcdProvided = personalize_config_default !== undefined;

    const { rows } = await pool.query(
      `UPDATE sequences SET name=$1, description=$2,
        require_approval=COALESCE($3, require_approval),
        personalize_config_default = CASE WHEN $4::boolean THEN $5::jsonb ELSE personalize_config_default END,
        updated_at=NOW()
        WHERE id=$6 AND org_id=$7 RETURNING *`,
      [name, description || null,
       require_approval !== undefined ? require_approval : null,
       pcdProvided, pcdParam,
       req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ sequence: rows[0] });
  } catch (err) {
    console.error('sequences PUT /:id', err);
    res.status(500).json({ error: { message: 'Failed to update sequence' } });
  }
});

// DELETE /api/sequences/:id  — soft archive
//
// Sequences remain org-shared (no ownership scoping), but archiving a
// sequence with active enrollments is a footgun: the firer skips archived
// sequences entirely, so in-flight enrollments silently stop advancing.
// Block non-admin archives in that state; allow admins to force-archive
// with ?force=true after they've acknowledged the consequence in the UI.
//
// The original message "Existing enrollments will not be affected" was
// factually wrong — they ARE affected (they stall). This change makes the
// real consequence visible.
router.delete('/:id', async (req, res) => {
  try {
    // Count active enrollments first — if any, gate by role.
    const enrollRes = await pool.query(
      `SELECT COUNT(*)::int AS active_count
         FROM sequence_enrollments
        WHERE sequence_id = $1 AND org_id = $2 AND status = 'active'`,
      [req.params.id, req.orgId]
    );
    const activeCount = enrollRes.rows[0]?.active_count || 0;

    if (activeCount > 0) {
      // Look up caller's role (admin/owner can force; member cannot).
      const roleRes = await pool.query(
        `SELECT role FROM org_users
          WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
        [req.userId, req.orgId]
      );
      const role = roleRes.rows[0]?.role || null;
      const isAdmin = role === 'admin' || role === 'owner';
      const forced  = req.query.force === 'true' || req.query.force === '1';

      if (!isAdmin) {
        return res.status(403).json({ error: {
          message: `Cannot archive — sequence has ${activeCount} active enrollment${activeCount === 1 ? '' : 's'}. Stop them first, or ask an admin to force-archive.`,
        } });
      }
      if (!forced) {
        return res.status(409).json({ error: {
          message: `Sequence has ${activeCount} active enrollment${activeCount === 1 ? '' : 's'}. Their next steps will silently stop firing once archived. Re-send with ?force=true to confirm.`,
          activeEnrollmentCount: activeCount,
          requiresForce: true,
        } });
      }
      // Admin + force=true: fall through to archive.
    }

    const { rows } = await pool.query(
      `UPDATE sequences SET status='archived', updated_at=NOW()
        WHERE id=$1 AND org_id=$2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ ok: true, archivedActiveEnrollments: activeCount });
  } catch (err) {
    console.error('sequences DELETE /:id', err);
    res.status(500).json({ error: { message: 'Failed to archive sequence' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEPS CRUD
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sequences/:id/steps
router.post('/:id/steps', async (req, res) => {
  const { channel, delay_days, subject_template, body_template, task_note,
          require_approval, personalize_config, step_intent } = req.body;
  try {
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(step_order), 0) AS max_order FROM sequence_steps WHERE sequence_id=$1`,
      [req.params.id]
    );
    const nextOrder = maxRes.rows[0].max_order + 1;

    const { rows } = await pool.query(
      `INSERT INTO sequence_steps
         (sequence_id, org_id, step_order, channel, delay_days,
          subject_template, body_template, task_note, require_approval,
          personalize_config, step_intent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, req.orgId, nextOrder, channel, delay_days ?? 0,
       subject_template || null, body_template || null, task_note || null,
       require_approval !== undefined ? require_approval : null,
       personalize_config ? JSON.stringify(personalize_config) : null,
       step_intent || null]
    );
    res.status(201).json({ step: rows[0] });
  } catch (err) {
    console.error('sequences POST /:id/steps', err);
    res.status(500).json({ error: { message: 'Failed to add step' } });
  }
});

// PUT /api/sequences/:id/steps/:stepId
router.put('/:id/steps/:stepId', async (req, res) => {
  const { channel, delay_days, subject_template, body_template, task_note,
          require_approval, personalize_config, step_intent } = req.body;
  try {
    // personalize_config: undefined → don't touch; null → clear (inherit); obj → set
    const pcParam = personalize_config === undefined
      ? null
      : (personalize_config === null ? null : JSON.stringify(personalize_config));
    const pcProvided = personalize_config !== undefined;

    // step_intent semantics mirror personalize_config:
    //   undefined → don't touch
    //   null      → clear (auto-infer)
    //   string    → set explicit override
    const siProvided = step_intent !== undefined;
    const siParam = step_intent === undefined ? null : (step_intent || null);

    const { rows } = await pool.query(
      `UPDATE sequence_steps
          SET channel=$1, delay_days=$2, subject_template=$3,
              body_template=$4, task_note=$5,
              require_approval=COALESCE($6, require_approval),
              personalize_config = CASE WHEN $7::boolean THEN $8::jsonb ELSE personalize_config END,
              step_intent = CASE WHEN $9::boolean THEN $10::text ELSE step_intent END,
              updated_at=NOW()
        WHERE id=$11 AND sequence_id=$12
        RETURNING *`,
      [channel, delay_days ?? 0, subject_template || null,
       body_template || null, task_note || null,
       require_approval !== undefined ? require_approval : null,
       pcProvided, pcParam,
       siProvided, siParam,
       req.params.stepId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Step not found' } });
    res.json({ step: rows[0] });
  } catch (err) {
    console.error('sequences PUT /:id/steps/:stepId', err);
    res.status(500).json({ error: { message: 'Failed to update step' } });
  }
});

// DELETE /api/sequences/:id/steps/:stepId
router.delete('/:id/steps/:stepId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delRes = await client.query(
      `DELETE FROM sequence_steps WHERE id=$1 AND sequence_id=$2 RETURNING step_order`,
      [req.params.stepId, req.params.id]
    );
    if (!delRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Step not found' } });
    }
    const deletedOrder = delRes.rows[0].step_order;
    // Re-number subsequent steps
    await client.query(
      `UPDATE sequence_steps SET step_order=step_order-1 WHERE sequence_id=$1 AND step_order>$2`,
      [req.params.id, deletedOrder]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequences DELETE /:id/steps/:stepId', err);
    res.status(500).json({ error: { message: 'Failed to delete step' } });
  } finally {
    client.release();
  }
});

// POST /api/sequences/:id/steps/reorder
router.post('/:id/steps/reorder', async (req, res) => {
  const { steps } = req.body; // [{ id, step_order }]
  if (!Array.isArray(steps)) return res.status(400).json({ error: { message: 'steps[] required' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of steps) {
      await client.query(
        `UPDATE sequence_steps SET step_order=$1 WHERE id=$2 AND sequence_id=$3`,
        [s.step_order, s.id, req.params.id]
      );
    }
    await client.query('COMMIT');
    const { rows } = await pool.query(
      `SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`,
      [req.params.id]
    );
    res.json({ steps: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('sequences POST /:id/steps/reorder', err);
    res.status(500).json({ error: { message: 'Failed to reorder steps' } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI GENERATE STEPS
// POST /api/sequences/:id/ai-generate
// body: { prospectId }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/ai-generate', async (req, res) => {
  const { prospectId } = req.body;
  if (!prospectId) return res.status(400).json({ error: { message: 'prospectId is required' } });

  try {
    const seqRes = await pool.query(
      `SELECT * FROM sequences WHERE id=$1 AND org_id=$2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Sequence not found' } });

    const stepsRes = await pool.query(
      `SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`,
      [req.params.id]
    );

    const prospectRes = await pool.query(
      `SELECT p.*, a.name AS account_name, a.domain AS account_domain,
              a.industry AS account_industry
         FROM prospects p
    LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.id=$1 AND p.org_id=$2`,
      [prospectId, req.orgId]
    );
    if (!prospectRes.rows.length) return res.status(404).json({ error: { message: 'Prospect not found' } });
    const prospect = prospectRes.rows[0];

    const systemPrompt = `You are an expert SDR copywriter. Personalise the following email sequence steps for the given prospect.
Return ONLY valid JSON — no markdown, no prose.`;

    const userPrompt = `Personalise these sequence steps for:
Name: ${prospect.first_name} ${prospect.last_name}
Title: ${prospect.title || 'unknown'}
Company: ${prospect.account_name || prospect.company_name || 'unknown'}
Industry: ${prospect.account_industry || 'unknown'}
${prospect.research_notes ? 'Research: ' + prospect.research_notes : ''}

STEPS:
${stepsRes.rows.map((s, i) => `Step ${i+1} (${s.channel}): subject="${s.subject_template||''}" body="${(s.body_template||'').slice(0,200)}"`).join('\n')}

Return JSON: { "steps": [{ "step_order": 1, "subject": "...", "body": "...", "task_note": "" }] }`;

    const { adapter, model, provider, keySource } =
      await AIClientResolver.resolve(req.orgId, req.user.userId, 'prospecting_sequence_generate');

    const aiRes = await adapter.complete({
      model,
      maxTokens: 2000,
      system:    systemPrompt,
      messages:  [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model,
        provider,
        keySource,
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw   = aiRes.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json({
      steps: (parsed.steps || []).map(s => ({
        step_order: s.step_order,
        subject:    s.subject    || '',
        body:       s.body       || '',
        task_note:  s.task_note  || '',
      })),
    });
  } catch (err) {
    console.error('ai-generate error:', err);
    res.status(500).json({ error: { message: 'AI generation failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI BUILD SEQUENCE
// POST /api/sequences/ai-build
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai-build', async (req, res) => {
  const { name, description, channelMix, steps: stepCount, tone, goal } = req.body;

  try {
    const systemPrompt = `You are an expert SDR sequence architect. Build a complete outreach sequence.
Return ONLY valid JSON — no markdown fences, no prose.`;

    const userPrompt = `Build an outreach sequence with these requirements:
Name: ${name || 'New Sequence'}
Goal: ${goal || 'Book a discovery call'}
Tone: ${tone || 'Professional, concise'}
Description: ${description || ''}
Number of steps: ${stepCount || 5}
Channel mix: ${channelMix || 'Mostly email with 1-2 LinkedIn touchpoints'}

For each step include: channel (email|linkedin|call|task), delay_days (days after previous step), subject_template (for email/linkedin), body_template (for email/linkedin), task_note (for call/task).
Use {{first_name}}, {{company}}, {{title}}, {{industry}} as personalisation tokens.

Return JSON:
{
  "name": "...",
  "description": "...",
  "steps": [
    {
      "step_order": 1,
      "channel": "email",
      "delay_days": 0,
      "subject_template": "...",
      "body_template": "...",
      "task_note": ""
    }
  ]
}`;

    const { adapter, model, provider, keySource } =
      await AIClientResolver.resolve(req.orgId, req.user.userId, 'prospecting_sequence_generate');

    const aiRes = await adapter.complete({
      model,
      maxTokens: 3000,
      system:    systemPrompt,
      messages:  [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model,
        provider,
        keySource,
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw   = aiRes.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json({
      name:        parsed.name        || '',
      description: parsed.description || '',
      steps:       (parsed.steps      || []).map((s, i) => ({ ...s, step_order: i + 1 })),
    });
  } catch (err) {
    console.error('ai-build error:', err);
    res.status(500).json({ error: { message: 'AI build failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI WRITE STEP
// POST /api/sequences/ai-write-step
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai-write-step', async (req, res) => {
  const { prompt, channel = 'email', stepNumber = 1, totalSteps = 1, previousSteps = [] } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: { message: 'prompt is required' } });

  const hasContent = ['email', 'linkedin'].includes(channel);

  try {
    const systemPrompt = `You are an expert SDR copywriter writing outreach message templates.\nReturn ONLY valid JSON — no markdown fences, no prose.`;

    const context = previousSteps.length > 0
      ? `\nPREVIOUS STEPS IN THIS SEQUENCE:\n${previousSteps.map((s, i) =>
          `Step ${i + 1} (${s.channel}): ${s.subject_template || s.task_note || '(no subject)'}`
        ).join('\n')}\n`
      : '';

    const userPrompt = `Write step ${stepNumber} of ${totalSteps} in an outreach sequence.\n\nCHANNEL: ${channel}\nINSTRUCTION: ${prompt}\n${context}\nRules:\n- Use {{first_name}}, {{company}}, {{title}}, {{industry}} as personalisation tokens\n- Keep it human and concise — under 100 words for email body\n- This is a TEMPLATE, not a personalised message\n${hasContent
  ? '- Return subject_template and body_template; leave task_note as empty string'
  : '- This is a call/task step — return a brief task_note describing what to do; leave subject_template and body_template as empty strings'
}\n\nReturn JSON:\n{\n  "subject_template": "...",\n  "body_template": "...",\n  "task_note": ""\n}`;

    const { adapter, model, provider, keySource } =
      await AIClientResolver.resolve(req.orgId, req.user.userId, 'prospecting_sequence_generate');

    const aiRes = await adapter.complete({
      model,
      maxTokens: 800,
      system:    systemPrompt,
      messages:  [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model,
        provider,
        keySource,
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw   = aiRes.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json({
      subject_template: parsed.subject_template || '',
      body_template:    parsed.body_template    || '',
      task_note:        parsed.task_note        || '',
    });
  } catch (err) {
    console.error('ai-write-step error:', err);
    res.status(500).json({ error: { message: 'AI step write failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCE STATS
// GET /api/sequences/:id/stats
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sequences/:id/stats
// ─────────────────────────────────────────────────────────────────────────────
//
// Per-sequence funnel stats. Original (Sprint-3) behavior is preserved when
// called with no Phase-3 query params — frontends like SequencesView keep
// working without any change.
//
// Phase 3 extensions (all optional, additive):
//   ?depth=direct|plus1|plus2|all   filter to a scope of enrolled_by users
//   ?userIds=1,2,3                   filter to a specific set (∩ with scope)
//   ?startDate=ISO  ?endDate=ISO     time window for the byUser block
//   ?windowDays=N                    alternative to start/end
//   ?groupBy=sequence|user|both      defaults to 'sequence' (current behavior).
//                                    'user' or 'both' add a byUser[] array.
//
// Important note on the time window (see SEQUENCE_REPORTING_DESIGN.md
// Appendix A.3 for context):
//   The original response fields (totalEnrolled, statusBreakdown, stepFunnel,
//   replyRate, avgReplyStep) remain ALL-TIME by default. They reflect the
//   current state of enrollments + cumulative log activity. Changing those
//   silently to "last 7 days" would break SequencesView's "Reply Rate" tile
//   (it would suddenly show only a fraction of the historical denominator).
//
//   The new byUser[] block is window-bound — it shows per-rep activity
//   within the supplied window. windowDays defaults to 7 in that block.
//
//   If a caller wants the original fields windowed too, they should pass
//   ?userIds= AND ?startDate=/?endDate= explicitly. In that mode the user
//   filter applies to the original state queries as well (the caller has
//   asked to slice). This compromise satisfies A.3's goal of bounding heavy
//   queries while preserving back-compat for the existing UI caller.
//
// Auth: when ?userIds or ?depth is set, results pass through
// ReportingScopeService.resolveReportingScope — out-of-scope IDs are
// silently dropped, never errored.
//
router.get('/:id/stats', async (req, res) => {
  try {
    const seqRes = await pool.query(
      `SELECT s.*, COUNT(ss.id) AS step_count
         FROM sequences s
    LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
        WHERE s.id = $1 AND s.org_id = $2
     GROUP BY s.id`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Not found' } });

    // ── Phase 3: parse optional filters ──────────────────────────────
    const groupBy = ['sequence', 'user', 'both'].includes(req.query.groupBy)
      ? req.query.groupBy
      : 'sequence';

    const hasUserFilter = req.query.userIds !== undefined || req.query.depth !== undefined;
    let scope = null;     // resolved when needed
    let userFilterIds = null;
    if (hasUserFilter || groupBy !== 'sequence') {
      const explicitUserIds = req.query.userIds !== undefined
        ? String(req.query.userIds).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isInteger)
        : null;
      scope = await ReportingScopeService.resolveReportingScope(
        req.user.userId,
        req.orgId,
        { depth: req.query.depth, explicitUserIds }
      );
      userFilterIds = scope.userIds;
    }

    // Build the rep-filter SQL fragment for the state queries below.
    // Only applied when the caller explicitly opted into a user filter.
    // When groupBy !== 'sequence' but no userIds/depth was passed, the
    // scope service still ran (to enable the byUser block) but the state
    // queries should remain unfiltered for back-compat.
    let repFilterClause = '';
    let repFilterParam  = null;
    if (hasUserFilter && userFilterIds) {
      repFilterParam = userFilterIds;
      // Will be appended as the third param below.
    }

    // ── Original (state) queries — params + optional rep filter ──────
    const stateParams = [req.params.id, req.orgId];
    let stateRepClause = '';
    if (repFilterParam) {
      stateParams.push(repFilterParam);
      stateRepClause = `AND se.enrolled_by = ANY($3::int[])`;
    }

    const statusRes = await pool.query(
      `SELECT status, COUNT(*) AS count
         FROM sequence_enrollments se
        WHERE se.sequence_id = $1 AND se.org_id = $2
              ${stateRepClause}
     GROUP BY status`,
      stateParams
    );
    const statusMap = {};
    statusRes.rows.forEach(r => { statusMap[r.status] = parseInt(r.count); });
    const totalEnrolled = Object.values(statusMap).reduce((a, b) => a + b, 0);
    const totalReplied  = statusMap['replied'] || 0;

    const stepFunnelRes = await pool.query(
      `SELECT
         ss.step_order,
         COUNT(*) FILTER (WHERE ssl.status = 'sent')    AS sent,
         COUNT(*) FILTER (WHERE ssl.status = 'skipped') AS skipped,
         COUNT(*) FILTER (WHERE ssl.status = 'failed')  AS failed
       FROM sequence_step_logs ssl
       JOIN sequence_steps ss       ON ss.id = ssl.sequence_step_id
       JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
      WHERE se.sequence_id = $1 AND se.org_id = $2
            ${stateRepClause}
   GROUP BY ss.step_order
   ORDER BY ss.step_order`,
      stateParams
    );

    const replyStepRes = await pool.query(
      `SELECT current_step, COUNT(*) AS reply_count
         FROM sequence_enrollments se
        WHERE se.sequence_id = $1 AND se.org_id = $2 AND se.status = 'replied'
              ${stateRepClause}
     GROUP BY current_step
     ORDER BY current_step`,
      stateParams
    );
    const replyByStep = {};
    replyStepRes.rows.forEach(r => { replyByStep[r.current_step] = parseInt(r.reply_count); });

    let avgReplyStep = null;
    if (totalReplied > 0) {
      const weightedSum = replyStepRes.rows.reduce((sum, r) => sum + r.current_step * parseInt(r.reply_count), 0);
      avgReplyStep = (weightedSum / totalReplied).toFixed(1);
    }

    const stepFunnel = stepFunnelRes.rows.map(row => ({
      step_order:  row.step_order,
      sent:        parseInt(row.sent),
      skipped:     parseInt(row.skipped),
      failed:      parseInt(row.failed),
      replied_here: replyByStep[row.step_order] || 0,
    }));

    const response = {
      sequence:      seqRes.rows[0],
      totalEnrolled,
      totalReplied,
      replyRate:     totalEnrolled > 0 ? ((totalReplied / totalEnrolled) * 100).toFixed(1) : '0.0',
      avgReplyStep,
      statusBreakdown: {
        active:    statusMap['active']    || 0,
        paused:    statusMap['paused']    || 0,
        completed: statusMap['completed'] || 0,
        stopped:   statusMap['stopped']   || 0,
        replied:   statusMap['replied']   || 0,
      },
      stepFunnel,
    };

    // ── Phase 3: byUser block (window-bound) ─────────────────────────
    if (groupBy === 'user' || groupBy === 'both') {
      const w = _parsePhase3Window(req.query);
      const buParams = [req.orgId, scope.userIds, req.params.id, w.startISO, w.endISO];

      const buRes = await pool.query(
        `WITH log_agg AS (
           SELECT
             se.enrolled_by AS user_id,
             COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                              AS drafts,
             COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int                AS sent,
             COUNT(*) FILTER (WHERE ssl.status = 'replied')::int                            AS replied,
             COUNT(*) FILTER (WHERE ssl.status = 'failed')::int                             AS failed,
             COUNT(*) FILTER (WHERE ssl.status = 'draft'    AND ssl.fired_at >= NOW() - INTERVAL '24 hours')::int               AS drafts_24h,
             COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed') AND ssl.fired_at >= NOW() - INTERVAL '24 hours')::int    AS sent_24h,
             COUNT(*) FILTER (WHERE ssl.status = 'replied'  AND ssl.fired_at >= NOW() - INTERVAL '24 hours')::int               AS replied_24h,
             COUNT(*) FILTER (WHERE ssl.status = 'failed'   AND ssl.fired_at >= NOW() - INTERVAL '24 hours')::int               AS failed_24h,
             COUNT(*) FILTER (WHERE ssl.status = 'draft'    AND ssl.fired_at >= NOW() - INTERVAL '7 days')::int                 AS drafts_7d,
             COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed') AND ssl.fired_at >= NOW() - INTERVAL '7 days')::int      AS sent_7d,
             COUNT(*) FILTER (WHERE ssl.status = 'replied'  AND ssl.fired_at >= NOW() - INTERVAL '7 days')::int                 AS replied_7d,
             COUNT(*) FILTER (WHERE ssl.status = 'failed'   AND ssl.fired_at >= NOW() - INTERVAL '7 days')::int                 AS failed_7d,
             MAX(ssl.fired_at) AS last_fired_at
           FROM sequence_step_logs ssl
           JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
           WHERE ssl.org_id     = $1
             AND se.sequence_id = $3
             AND se.enrolled_by = ANY($2::int[])
             AND ssl.fired_at  >= $4::timestamptz
             AND ssl.fired_at  <= $5::timestamptz
           GROUP BY se.enrolled_by
         ),
         enroll_agg AS (
           SELECT
             se.enrolled_by AS user_id,
             COUNT(*)::int AS enrolled,
             COUNT(*) FILTER (WHERE se.status = 'active')::int AS active_enrollments
           FROM sequence_enrollments se
           WHERE se.org_id     = $1
             AND se.sequence_id = $3
             AND se.enrolled_by = ANY($2::int[])
             AND se.enrolled_at >= $4::timestamptz
             AND se.enrolled_at <= $5::timestamptz
           GROUP BY se.enrolled_by
         ),
         stalled_agg AS (
           SELECT
             se.enrolled_by AS user_id,
             COUNT(*)::int AS stalled
           FROM sequence_enrollments se
           LEFT JOIN LATERAL (
             SELECT MAX(fired_at) AS last_fired FROM sequence_step_logs
              WHERE enrollment_id = se.id
           ) sx ON true
           WHERE se.org_id     = $1
             AND se.sequence_id = $3
             AND se.enrolled_by = ANY($2::int[])
             AND se.status     = 'active'
             AND COALESCE(sx.last_fired, se.enrolled_at) < $5::timestamptz - INTERVAL '7 days'
           GROUP BY se.enrolled_by
         )
         SELECT
           u.id AS user_id, u.first_name, u.last_name, u.email,
           COALESCE(l.drafts, 0)    AS drafts,
           COALESCE(l.sent, 0)      AS sent,
           COALESCE(l.replied, 0)   AS replied,
           COALESCE(l.failed, 0)    AS failed,
           COALESCE(l.drafts_24h,  0) AS drafts_24h,
           COALESCE(l.sent_24h,    0) AS sent_24h,
           COALESCE(l.replied_24h, 0) AS replied_24h,
           COALESCE(l.failed_24h,  0) AS failed_24h,
           COALESCE(l.drafts_7d,   0) AS drafts_7d,
           COALESCE(l.sent_7d,     0) AS sent_7d,
           COALESCE(l.replied_7d,  0) AS replied_7d,
           COALESCE(l.failed_7d,   0) AS failed_7d,
           l.last_fired_at,
           COALESCE(e.enrolled, 0)            AS enrolled,
           COALESCE(e.active_enrollments, 0)  AS active_enrollments,
           COALESCE(st.stalled, 0)            AS stalled
         FROM users u
         LEFT JOIN log_agg     l  ON l.user_id  = u.id
         LEFT JOIN enroll_agg  e  ON e.user_id  = u.id
         LEFT JOIN stalled_agg st ON st.user_id = u.id
         WHERE u.id = ANY($2::int[])
         ORDER BY l.last_fired_at DESC NULLS LAST, u.first_name ASC`,
        buParams
      );

      const reportByUserId = new Map(scope.reports.map(r => [r.userId, r]));
      response.byUser = buRes.rows.map(r => {
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email;
        const meta = reportByUserId.get(r.user_id);
        const isViewer = r.user_id === req.user.userId;
        return {
          userId:           r.user_id,
          name,
          email:            r.email,
          isDirect:         isViewer ? false : (meta?.isDirect ?? null),
          depthFromManager: isViewer ? 0     : (meta?.depthFromManager ?? null),
          enrolled:         r.enrolled,
          drafts:           r.drafts,
          sent:             r.sent,
          replied:          r.replied,
          failed:           r.failed,
          stalled:          r.stalled,
          drafts_24h:       r.drafts_24h,
          sent_24h:         r.sent_24h,
          replied_24h:      r.replied_24h,
          failed_24h:       r.failed_24h,
          drafts_7d:        r.drafts_7d,
          sent_7d:          r.sent_7d,
          replied_7d:       r.replied_7d,
          failed_7d:        r.failed_7d,
          lastFiredAt:      r.last_fired_at,
          activeEnrollments: r.active_enrollments,
        };
      });
      response.period = {
        startDate:   w.startISO,
        endDate:     w.endISO,
        description: w.isoIntervalDescription,
      };
      response.scope = scope;
    }

    res.json(response);
  } catch (err) {
    console.error('sequence stats error:', err);
    res.status(500).json({ error: { message: 'Failed to load stats: ' + err.message } });
  }
});

// Phase 3 helper — same semantics as parseTimeWindow in reporting.routes.js
// (duplicated here to avoid a circular import; both files own their own
// param-parsing surface). Default window: last 7 days. windowDays clamped
// to [1, 365].
function _parsePhase3Window(query) {
  const { startDate, endDate, windowDays } = query;
  if (startDate && endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      throw new Error('startDate and endDate must be valid ISO date strings');
    }
    return {
      startISO: s.toISOString(),
      endISO:   e.toISOString(),
      isoIntervalDescription: `${s.toISOString().slice(0, 10)} to ${e.toISOString().slice(0, 10)}`,
    };
  }
  const days = windowDays !== undefined
    ? Math.max(1, Math.min(365, parseInt(windowDays, 10) || 7))
    : 7;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    startISO: start.toISOString(),
    endISO:   end.toISOString(),
    isoIntervalDescription: `last ${days} day${days === 1 ? '' : 's'}`,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// GET /api/sequences/health
// Sprint 4 (Group C). Per-sequence telemetry for the last 24h and 7d.
//
// Returns an array, one entry per active sequence in the org:
//   {
//     sequenceId, sequenceName,
//     last24h: { drafts, sent, replied, failed },
//     last7d:  { drafts, sent, replied, failed },
//     lastFiredAt,             // most recent log row's fired_at
//     topErrors,               // [{ message, count }] for the last 7d
//     stalledEnrollments,      // active enrollments with no log activity in 7d
//   }
//
// Health is computed against sequence_step_logs. A 'failed' row is written
// whenever SequenceStepFirer's per-step block throws. Without the Sprint-4
// migration that adds 'failed' to the status check constraint, this endpoint
// will return all-zero failed counts (correct, but uninformative).
// ═════════════════════════════════════════════════════════════════════════════
router.get('/health', async (req, res) => {
  try {
    // Window helpers
    const day  = `'24 hours'::interval`;
    const week = `'7 days'::interval`;

    // Per-sequence aggregates over the last 7d, including last24h via FILTER.
    // Joining sequences ensures we list every active sequence even if it has
    // no recent logs (drafts=sent=failed=0).
    const aggRes = await pool.query(
      `SELECT
         s.id    AS sequence_id,
         s.name  AS sequence_name,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status = 'draft')::int                              AS drafts_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status IN ('sent','completed'))::int                AS sent_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status = 'replied')::int                            AS replied_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${day}  AND ssl.status = 'failed')::int                             AS failed_24h,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status = 'draft')::int                              AS drafts_7d,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status IN ('sent','completed'))::int                AS sent_7d,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status = 'replied')::int                            AS replied_7d,
         COUNT(*) FILTER (WHERE ssl.fired_at >= NOW() - ${week} AND ssl.status = 'failed')::int                             AS failed_7d,
         MAX(ssl.fired_at) AS last_fired_at
       FROM sequences s
       LEFT JOIN sequence_step_logs ssl
              ON ssl.org_id = s.org_id
             AND EXISTS (
                   SELECT 1 FROM sequence_enrollments se2
                    WHERE se2.id = ssl.enrollment_id AND se2.sequence_id = s.id
                 )
      WHERE s.org_id = $1
        AND s.status = 'active'
      GROUP BY s.id, s.name
      ORDER BY s.id ASC`,
      [req.orgId]
    );

    // Top error messages over the last 7d, grouped per sequence. We collect
    // these once and stitch into the aggregate result so we don't run N+1
    // queries per sequence.
    const errRes = await pool.query(
      `SELECT se.sequence_id,
              ssl.error_message,
              COUNT(*)::int AS count
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
        WHERE ssl.org_id = $1
          AND ssl.status = 'failed'
          AND ssl.fired_at >= NOW() - ${week}
          AND ssl.error_message IS NOT NULL
     GROUP BY se.sequence_id, ssl.error_message
     ORDER BY se.sequence_id, count DESC`,
      [req.orgId]
    );
    const errorsBySeq = {};
    for (const row of errRes.rows) {
      if (!errorsBySeq[row.sequence_id]) errorsBySeq[row.sequence_id] = [];
      if (errorsBySeq[row.sequence_id].length < 3) {
        errorsBySeq[row.sequence_id].push({ message: row.error_message, count: row.count });
      }
    }

    // Stalled enrollments per sequence: active enrollments whose last log
    // row (or enrolled_at if no log yet) is older than 7d. Indicates the
    // firer never ran for them, or they're stuck.
    const stalledRes = await pool.query(
      `SELECT se.sequence_id,
              COUNT(*)::int AS stalled
         FROM sequence_enrollments se
         LEFT JOIN LATERAL (
           SELECT MAX(fired_at) AS last_fired
             FROM sequence_step_logs
            WHERE enrollment_id = se.id
         ) ssl ON true
        WHERE se.org_id = $1
          AND se.status = 'active'
          AND COALESCE(ssl.last_fired, se.enrolled_at) < NOW() - ${week}
     GROUP BY se.sequence_id`,
      [req.orgId]
    );
    const stalledBySeq = {};
    for (const row of stalledRes.rows) stalledBySeq[row.sequence_id] = row.stalled;

    const health = aggRes.rows.map(r => ({
      sequenceId:   r.sequence_id,
      sequenceName: r.sequence_name,
      last24h: {
        drafts:  r.drafts_24h,
        sent:    r.sent_24h,
        replied: r.replied_24h,
        failed:  r.failed_24h,
      },
      last7d: {
        drafts:  r.drafts_7d,
        sent:    r.sent_7d,
        replied: r.replied_7d,
        failed:  r.failed_7d,
      },
      lastFiredAt:        r.last_fired_at,
      topErrors:          errorsBySeq[r.sequence_id] || [],
      stalledEnrollments: stalledBySeq[r.sequence_id] || 0,
    }));

    res.json({ health });
  } catch (err) {
    console.error('sequence health error:', err);
    res.status(500).json({ error: { message: 'Failed to load sequence health' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 4 — PREVIEW + STOP-AND-UNDO ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /:id/preview — non-destructive personalisation for N prospects ─────
// Runs the dispatcher in-memory for each prospect and returns the full
// personalised steps as JSON. No DB writes to sequence_enrollments,
// sequence_step_logs, or prospects. The only side effect is skill_runs rows
// (each skill call persists for audit), which is acceptable — the rep
// triggered the run intentionally.
//
// Body:
//   { prospectIds: number[] }   // 1-5 prospect IDs
//
// Response:
//   {
//     sequenceId,
//     sequenceName,
//     previews: [{
//       prospectId,
//       prospectName,
//       prospectCompany,
//       steps: [{ step_order, channel, subject, body, task_note,
//                 personalize_sources, intent }],
//       dispatchSummary: { total, personalised, skipped, errored },
//       errors: [...]
//     }],
//     summary: { requested, succeeded, failed }
//   }
//
// HARD CAP: 5 prospects per preview to bound skill API cost (a 3-step
// sequence × 5 prospects = up to 15 Anthropic calls per preview).
router.post('/:id/preview', async (req, res) => {
  const { prospectIds } = req.body || {};
  if (!Array.isArray(prospectIds) || prospectIds.length === 0) {
    return res.status(400).json({ error: { message: 'prospectIds array is required' } });
  }
  if (prospectIds.length > 5) {
    return res.status(400).json({ error: {
      message: 'Maximum 5 prospects per preview (to bound Anthropic API cost).',
    } });
  }

  try {
    // Sequence existence + org scope
    const seqRes = await pool.query(
      `SELECT id, name FROM sequences WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) {
      return res.status(404).json({ error: { message: 'Sequence not found' } });
    }
    const sequence = seqRes.rows[0];

    // Validate prospects belong to this org
    const ids = prospectIds.map(x => parseInt(x, 10)).filter(Number.isFinite);
    if (ids.length === 0) {
      return res.status(400).json({ error: { message: 'No valid prospect IDs' } });
    }
    const pRes = await pool.query(
      `SELECT id, first_name, last_name, company_name
         FROM prospects
        WHERE id = ANY($1::int[]) AND org_id = $2 AND deleted_at IS NULL`,
      [ids, req.orgId]
    );
    if (pRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'No prospects found in this org' } });
    }
    const prospectsById = {};
    for (const p of pRes.rows) prospectsById[p.id] = p;

    // Sequence steps — needed to attach channel + intent to each preview step
    const stepsRes = await pool.query(
      `SELECT id, step_order, channel, step_intent
         FROM sequence_steps
        WHERE sequence_id = $1 AND org_id = $2
     ORDER BY step_order ASC`,
      [req.params.id, req.orgId]
    );
    const stepsByOrder = {};
    for (const s of stepsRes.rows) stepsByOrder[s.step_order] = s;

    // Run dispatcher per prospect — sequentially to keep skill rate-limited.
    const previews = [];
    let succeeded = 0, failed = 0;

    for (const prospectId of ids) {
      const p = prospectsById[prospectId];
      if (!p) {
        previews.push({
          prospectId,
          prospectName: null,
          prospectCompany: null,
          error: 'Prospect not found or in another org',
          steps: [],
        });
        failed++;
        continue;
      }

      try {
        const dispatch = await PersonalizationDispatcher.personaliseEnrollment({
          orgId:      req.orgId,
          userId:     req.user.userId,
          sequenceId: parseInt(req.params.id, 10),
          prospectId,
        });

        // Flatten dispatcher's keyed map → array sorted by step_order, with
        // channel/intent metadata attached from sequence_steps for display.
        const stepOrders = Object.keys(dispatch.personalisedSteps || {})
          .map(k => parseInt(k, 10))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);

        const steps = stepOrders.map(order => {
          const s = dispatch.personalisedSteps[String(order)] || {};
          const seqStep = stepsByOrder[order] || {};
          return {
            step_order:          order,
            channel:             seqStep.channel || null,
            subject:             s.subject   || '',
            body:                s.body      || '',
            task_note:           s.task_note || '',
            personalize_sources: s.personalize_sources || null,
            intent:              s.personalize_sources?.stepIntent || null,
            intent_source:       s.personalize_sources?.intentSource || null,
          };
        });

        previews.push({
          prospectId,
          prospectName:   `${p.first_name || ''} ${p.last_name || ''}`.trim(),
          prospectCompany: p.company_name || null,
          steps,
          dispatchSummary: dispatch.summary,
          errors:          dispatch.errors || [],
        });
        succeeded++;
      } catch (err) {
        console.error(`preview failed for prospect ${prospectId}:`, err);
        previews.push({
          prospectId,
          prospectName: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
          prospectCompany: p.company_name || null,
          error: err.message,
          steps: [],
        });
        failed++;
      }
    }

    res.json({
      sequenceId:   parseInt(req.params.id, 10),
      sequenceName: sequence.name,
      previews,
      summary: {
        requested: ids.length,
        succeeded,
        failed,
      },
    });
  } catch (err) {
    console.error('preview error:', err);
    res.status(500).json({ error: { message: 'Preview failed: ' + err.message } });
  }
});

// ── POST /enrollments/:enrollId/undo — stop AND clean up ────────────────────
// Differs from the existing /stop endpoint:
//   - /stop just sets status='stopped' (existing audit-friendly action)
//   - /undo sets status='stopped' AND discards unsent drafts AND reverts
//     prospect stage (the rep is saying "I made a mistake, undo")
//
// What gets undone:
//   - sequence_step_logs WHERE enrollment_id = X AND status = 'draft' → deleted
//   - prospects.stage reverts to 'research' (or 'target' if no research_notes)
//   - sequence_enrollments.status = 'stopped' with stop_reason = 'undone'
//
// What does NOT get undone:
//   - Already-sent emails (status='sent') — cannot recall outbound mail
//   - Already-logged LinkedIn touches (prospecting_activities rows)
//   - The enrollment row itself — kept for audit (status='stopped')
//
// The rep can re-enroll the prospect fresh after undo (the bulk-activate
// candidate query filters out 'active'/'paused' enrollments, so 'stopped'
// enrollments don't block re-enrollment).
router.post('/enrollments/:enrollId/undo', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load enrollment, scope to org. Lock the row to prevent races with
    // the firer picking up the same enrollment.
    const eRes = await client.query(
      `SELECT id, prospect_id, sequence_id, status
         FROM sequence_enrollments
        WHERE id = $1 AND org_id = $2
        FOR UPDATE`,
      [req.params.enrollId, req.orgId]
    );
    if (!eRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Enrollment not found' } });
    }
    const enrollment = eRes.rows[0];

    if (['stopped', 'completed'].includes(enrollment.status)) {
      // Already terminal — no-op. Return current state.
      await client.query('ROLLBACK');
      return res.json({
        enrollmentId: enrollment.id,
        wasAlreadyTerminal: true,
        status: enrollment.status,
        draftsDiscarded: 0,
        stageReverted: null,
      });
    }

    // Count + discard unsent drafts. Sent steps stay (audit trail).
    const draftRes = await client.query(
      `DELETE FROM sequence_step_logs
        WHERE enrollment_id = $1 AND org_id = $2 AND status = 'draft'
      RETURNING id`,
      [enrollment.id, req.orgId]
    );
    const draftsDiscarded = draftRes.rowCount;

    // Stop the enrollment with explicit stop_reason='undone' so audit
    // queries can distinguish manual undo from other stops.
    await client.query(
      `UPDATE sequence_enrollments
          SET status = 'stopped',
              stopped_at = NOW(),
              stop_reason = 'undone'
        WHERE id = $1 AND org_id = $2`,
      [enrollment.id, req.orgId]
    );

    // Revert prospect stage. The rule:
    //   - had research_notes (or research_meta.signal_summary) → 'research'
    //   - else → 'target'
    //
    // Only revert if the prospect is currently in 'outreach' — if they've
    // already advanced beyond outreach (engaged, qualified, etc.) we leave
    // the stage alone; undoing one enrollment shouldn't push them backwards
    // through engagement.
    const pRes = await client.query(
      `SELECT id, stage, research_notes, research_meta
         FROM prospects
        WHERE id = $1 AND org_id = $2`,
      [enrollment.prospect_id, req.orgId]
    );
    let stageReverted = null;
    if (pRes.rows.length && pRes.rows[0].stage === 'outreach') {
      const hadResearch = !!(
        pRes.rows[0].research_notes ||
        (pRes.rows[0].research_meta && (
          pRes.rows[0].research_meta.signal_summary ||
          pRes.rows[0].research_meta.researchBullets
        ))
      );
      const newStage = hadResearch ? 'research' : 'target';
      await client.query(
        `UPDATE prospects
            SET stage = $3,
                stage_changed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND org_id = $2`,
        [enrollment.prospect_id, req.orgId, newStage]
      );
      stageReverted = newStage;
    }

    // Audit activity row. Non-fatal if it fails.
    try {
      await client.query(
        `INSERT INTO prospecting_activities
                     (org_id, prospect_id, user_id, activity_type, description, metadata)
              VALUES ($1, $2, $3, 'enrollment_undone', $4, $5::jsonb)`,
        [
          req.orgId, enrollment.prospect_id, req.user.userId,
          `Enrollment undone — ${draftsDiscarded} draft(s) discarded` +
            (stageReverted ? `, stage reverted to '${stageReverted}'` : ''),
          JSON.stringify({
            enrollmentId:    enrollment.id,
            sequenceId:      enrollment.sequence_id,
            draftsDiscarded,
            stageReverted,
          }),
        ]
      );
    } catch (actErr) {
      console.warn('undo: activity log failed:', actErr.message);
    }

    await client.query('COMMIT');
    res.json({
      enrollmentId:        enrollment.id,
      wasAlreadyTerminal:  false,
      status:              'stopped',
      draftsDiscarded,
      stageReverted,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('enrollment undo error:', err);
    res.status(500).json({ error: { message: 'Undo failed: ' + err.message } });
  } finally {
    client.release();
  }
});

module.exports = router;
