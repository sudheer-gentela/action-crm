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

// ── AI provider chain (same pattern as ProspectingAIEnhancer) ─────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
              COUNT(DISTINCT se.id)::int  AS enrollment_count
         FROM sequences s
    LEFT JOIN sequence_steps ss       ON ss.sequence_id = s.id
    LEFT JOIN sequence_enrollments se ON se.sequence_id = s.id AND se.status = 'active'
        WHERE s.org_id = $1 AND s.status != 'archived'
     GROUP BY s.id
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
  const { name, description, require_approval = true, steps = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: { message: 'name is required' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seqRes = await client.query(
      `INSERT INTO sequences (org_id, name, description, created_by, require_approval)
            VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.orgId, name.trim(), description || null, req.user.userId, require_approval]
    );
    const seq = seqRes.rows[0];

    const insertedSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const sr = await client.query(
        `INSERT INTO sequence_steps
                     (sequence_id, org_id, step_order, channel, delay_days,
                      subject_template, body_template, task_note, require_approval)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [seq.id, req.orgId, i + 1, s.channel, s.delay_days ?? 0,
         s.subject_template || null, s.body_template || null, s.task_note || null,
         s.require_approval !== undefined ? s.require_approval : null]
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
// AI PERSONALISE ENROLLMENT
// POST /api/sequences/ai-personalise-enrollment
// body: { sequenceId, prospectId }
// Returns personalised step content for ONE prospect using their research.
// Content is stored against the enrollment — master template is never modified.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai-personalise-enrollment', async (req, res) => {
  const { sequenceId, prospectId } = req.body;
  if (!sequenceId || !prospectId) {
    return res.status(400).json({ error: { message: 'sequenceId and prospectId are required' } });
  }

  try {
    // Load sequence + steps
    const seqRes = await pool.query(
      `SELECT * FROM sequences WHERE id=$1 AND org_id=$2`,
      [sequenceId, req.orgId]
    );
    if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Sequence not found' } });

    const stepsRes = await pool.query(
      `SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`,
      [sequenceId]
    );
    const steps = stepsRes.rows;

    // Load prospect + account research
    const prospectRes = await pool.query(
      `SELECT p.*, a.name AS account_name, a.research_notes AS account_research,
              a.domain AS account_domain, a.industry AS account_industry,
              a.research_meta AS account_research_meta
         FROM prospects p
    LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.id=$1 AND p.org_id=$2`,
      [prospectId, req.orgId]
    );
    if (!prospectRes.rows.length) return res.status(404).json({ error: { message: 'Prospect not found' } });
    const prospect = prospectRes.rows[0];

    const hasResearch = !!(prospect.research_notes || prospect.account_research);

    // Extract ALL structured Intel fields from research_meta
    const researchMeta    = prospect.research_meta  || {};
    const pitchAngle      = researchMeta.pitchAngle  || '';
    const crispPitch      = researchMeta.crispPitch  || '';
    const subjectLine     = researchMeta.subjectLine || '';
    const researchBullets = Array.isArray(researchMeta.researchBullets) ? researchMeta.researchBullets : [];

    // ── Fetch sender display_name so AI writes the sign-off naturally ──────
    // CHANGED: AND client_id IS NULL — only look up the rep's personal sender,
    // not a client-owned sender account.
    // Best-effort: if no sender account exists, AI omits the sign-off token.
    let senderDisplayName = '';
    try {
      const senderRes = await pool.query(
        `SELECT display_name FROM prospecting_sender_accounts
          WHERE org_id    = $1
            AND user_id   = $2
            AND client_id IS NULL
            AND is_active = true
          ORDER BY
            (CASE WHEN last_reset_at < CURRENT_DATE THEN 0 ELSE emails_sent_today END) ASC,
            last_sent_at ASC NULLS FIRST
          LIMIT 1`,
        [req.orgId, req.user.userId]
      );
      senderDisplayName = senderRes.rows[0]?.display_name || '';
    } catch (_) {
      // Non-fatal — proceed without display_name
    }

    // Build research block
    const researchBlock = hasResearch
      ? [
          'PROSPECT RESEARCH (write FROM this — not around it):',
          researchBullets.length > 0 ? 'Key insights:\n' + researchBullets.map(b => '  - ' + b).join('\n') : '',
          pitchAngle   ? '\nStrongest pitch angle: ' + pitchAngle : '',
          crispPitch   ? '\nPre-written pitch (use as core of step 1 body — adapt tone, do not ignore it):\n' + crispPitch : '',
          subjectLine  ? '\nSuggested subject line for step 1: ' + subjectLine : '',
          prospect.research_notes   ? '\nFull research notes:\n' + prospect.research_notes : '',
          prospect.account_research ? '\nAccount research:\n' + prospect.account_research  : '',
        ].filter(Boolean).join('\n')
      : 'No research available — write from first principles using their role, company and industry.';

    const systemPrompt = `You are an expert SDR writing highly personalised outreach emails. You write from research, not from templates.
Return ONLY valid JSON — no markdown fences, no prose.`;

    const userPrompt = `Write personalised outreach emails for this prospect. The research is your primary input — templates below are structural guides only. Do NOT copy template wording.

PROSPECT:
Name: ${prospect.first_name} ${prospect.last_name}
Title: ${prospect.title || 'unknown'}
Company: ${prospect.account_name || prospect.company_name || 'unknown'}
Industry: ${prospect.account_industry || 'unknown'}
${researchBlock}

SENDER: ${senderDisplayName || prospect.account_name || 'the sender'}
${senderDisplayName ? 'End each email body with a natural sign-off using the sender name above (e.g. "Best,\n' + senderDisplayName + '"). Do NOT add a signature block — just the name sign-off.' : ''}

SEQUENCE: "${seqRes.rows[0].name}"
Tone & Goal: ${seqRes.rows[0].description || 'Professional outreach'}

WRITING RULES:
- Step 1: Open with the most specific insight from the research. Write something that could only be for this person.
- If a crispPitch is provided, use it as the backbone of step 1.
- If a subjectLine is provided, use it (or a close variant) for the step 1 subject.
- Follow-ups: reference the first email, vary the angle, stay specific.
- Under 120 words per email body (excluding the sign-off). No filler openers.
- Use {{first_name}}, {{company}}, {{title}} tokens only where natural.
- Non-email steps (call, task, linkedin): write a specific task_note referencing what was sent.

STRUCTURAL REFERENCE (format/CTA style only — do not copy wording):
${steps.map((s, i) => 'Step ' + (i+1) + ': channel=' + s.channel + ', delay=' + s.delay_days + 'd\n  Template subject: ' + (s.subject_template || '(none)') + '\n  Template body: ' + (s.body_template || '(none)') + '\n  Task note: ' + (s.task_note || '(none)')).join('\n\n')}

Return JSON:
{
  "steps": [
    {
      "step_order": 1,
      "subject": "...",
      "body": "...",
      "task_note": ""
    }
  ]
}`;

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model:    'claude-sonnet-4-20250514',
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw    = aiRes.content.find(b => b.type === 'text')?.text || '{}';
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json({
      prospectId,
      hasResearch,
      steps: (parsed.steps || []).map(s => ({
        step_order: s.step_order,
        subject:    s.subject    || '',
        body:       s.body       || '',
        task_note:  s.task_note  || '',
      })),
    });

  } catch (err) {
    console.error('ai-personalise-enrollment error:', err);
    res.status(500).json({ error: { message: 'AI personalisation failed: ' + err.message } });
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
                           (prospect_id, user_id, activity_type, description, metadata)
                    VALUES ($1, $2, 'sequence_enrolled', $3, $4)`,
              [
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
  const { prospectId, status } = req.query;
  try {
    let query = `
      SELECT se.*,
             s.name AS sequence_name,
             p.first_name, p.last_name, p.email, p.company_name
        FROM sequence_enrollments se
        JOIN sequences s     ON s.id = se.sequence_id
        JOIN prospects p     ON p.id = se.prospect_id
       WHERE se.org_id = $1`;
    const params = [req.orgId];

    if (prospectId) { params.push(prospectId); query += ` AND se.prospect_id = $${params.length}`; }
    if (status)     { params.push(status);     query += ` AND se.status = $${params.length}`; }

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
    let query = `
      SELECT
        ssl.id, ssl.enrollment_id, ssl.subject, ssl.body,
        ssl.scheduled_send_at, ssl.status,
        ss.step_order, ssl.channel,
        se.sequence_id, se.enrolled_by,
        s.name AS sequence_name,
        p.id AS prospect_id, p.first_name, p.last_name,
        p.email AS prospect_email, p.company_name, p.linkedin_url,
        -- Auto-select the rep's least-used active personal sender account
        -- CHANGED: client_id IS NULL — excludes client-owned sender accounts
        psa.id   AS sender_id,
        psa.email AS sender_email,
        psa.provider AS sender_provider,
        psa.label AS sender_label
      FROM sequence_step_logs ssl
      JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
      JOIN sequences s             ON s.id   = se.sequence_id
      JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
      JOIN prospects p             ON p.id   = ssl.prospect_id
      -- Pick the rep's least-used personal sender via a lateral join
      LEFT JOIN LATERAL (
        SELECT id, email, provider, label
          FROM prospecting_sender_accounts
         WHERE org_id     = ssl.org_id
           AND user_id    = se.enrolled_by
           AND client_id  IS NULL
           AND is_active  = true
         ORDER BY
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

    const drafts = rows.map(r => ({
      id:             r.id,
      enrollmentId:   r.enrollment_id,
      sequenceId:     r.sequence_id,
      sequenceName:   r.sequence_name,
      stepOrder:      r.step_order,
      channel:        r.channel,
      subject:        r.subject || '',
      body:           r.body    || '',
      scheduledSendAt: r.scheduled_send_at,
      isOverdue:      new Date(r.scheduled_send_at) < new Date(),
      prospect: {
        id:          r.prospect_id,
        firstName:   r.first_name,
        lastName:    r.last_name,
        email:       r.prospect_email,
        companyName: r.company_name,
        linkedinUrl: r.linkedin_url || null,
      },
      suggestedSender: r.sender_id ? {
        id:       r.sender_id,
        email:    r.sender_email,
        provider: r.sender_provider,
        label:    r.sender_label,
      } : null,
    }));

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
    const draftRes = await client.query(
      `SELECT ssl.*, ss.step_order, se.enrolled_by, se.sequence_id,
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

    // ── Channel guard — only email drafts can be sent via this endpoint ───
    // LinkedIn / call / task drafts must be completed via POST /complete,
    // not this endpoint. Calling Send Now on a non-email draft would silently
    // do nothing (no matching provider branch) but still mark the log as
    // 'sent' and advance the enrollment — a ghost send.
    if (draft.channel !== 'email') {
      return res.status(400).json({
        error: {
          message: `This is a ${draft.channel} step — use "Mark as Done" once you have completed the action on ${draft.channel === 'linkedin' ? 'LinkedIn' : 'the appropriate channel'}.`,
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
          to:      prospect.email,
          subject: draft.subject,
          body:    htmlBody,
          isHtml:  true,
        });
      }
    } catch (err) {
      console.error(`❌ Draft send failed for log ${req.params.logId} → ${prospect.email}:`, err.message);
      // Surface token expiry as a clear actionable message
      const isTokenError = /invalid_grant|token.*expired|unauthorized|401/i.test(err.message);
      const userMessage = isTokenError
        ? `Sending account ${sender.email} needs to be reconnected — go to Settings → Outreach and reconnect it.`
        : `Failed to send email: ${err.message}`;
      return res.status(502).json({ error: { message: userMessage, code: isTokenError ? 'TOKEN_EXPIRED' : 'SEND_FAILED' } });
    }

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
         (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1,$2,'sequence_step_sent',$3,$4)`,
      [
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
         (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1,$2,'sequence_step_completed',$3,$4)`,
      [
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
         (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1,$2,'sequence_step_skipped',$3,$4)`,
      [
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
      `SELECT * FROM sequences WHERE id = $1 AND org_id = $2`,
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
  const { name, description, require_approval } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sequences SET name=$1, description=$2,
        require_approval=COALESCE($3, require_approval),
        updated_at=NOW()
        WHERE id=$4 AND org_id=$5 RETURNING *`,
      [name, description || null,
       require_approval !== undefined ? require_approval : null,
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
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE sequences SET status='archived', updated_at=NOW()
        WHERE id=$1 AND org_id=$2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ ok: true });
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
  const { channel, delay_days, subject_template, body_template, task_note, require_approval } = req.body;
  try {
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(step_order), 0) AS max_order FROM sequence_steps WHERE sequence_id=$1`,
      [req.params.id]
    );
    const nextOrder = maxRes.rows[0].max_order + 1;

    const { rows } = await pool.query(
      `INSERT INTO sequence_steps
         (sequence_id, org_id, step_order, channel, delay_days,
          subject_template, body_template, task_note, require_approval)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, req.orgId, nextOrder, channel, delay_days ?? 0,
       subject_template || null, body_template || null, task_note || null,
       require_approval !== undefined ? require_approval : null]
    );
    res.status(201).json({ step: rows[0] });
  } catch (err) {
    console.error('sequences POST /:id/steps', err);
    res.status(500).json({ error: { message: 'Failed to add step' } });
  }
});

// PUT /api/sequences/:id/steps/:stepId
router.put('/:id/steps/:stepId', async (req, res) => {
  const { channel, delay_days, subject_template, body_template, task_note, require_approval } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_steps
          SET channel=$1, delay_days=$2, subject_template=$3,
              body_template=$4, task_note=$5,
              require_approval=COALESCE($6, require_approval),
              updated_at=NOW()
        WHERE id=$7 AND sequence_id=$8
        RETURNING *`,
      [channel, delay_days ?? 0, subject_template || null,
       body_template || null, task_note || null,
       require_approval !== undefined ? require_approval : null,
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

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model:    'claude-sonnet-4-20250514',
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw   = aiRes.content.find(b => b.type === 'text')?.text || '{}';
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

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model:    'claude-sonnet-4-20250514',
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw   = aiRes.content.find(b => b.type === 'text')?.text || '{}';
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

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 800,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model:    'claude-sonnet-4-20250514',
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw   = aiRes.content.find(b => b.type === 'text')?.text || '{}';
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

    const statusRes = await pool.query(
      `SELECT status, COUNT(*) AS count
         FROM sequence_enrollments
        WHERE sequence_id = $1 AND org_id = $2
     GROUP BY status`,
      [req.params.id, req.orgId]
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
   GROUP BY ss.step_order
   ORDER BY ss.step_order`,
      [req.params.id, req.orgId]
    );

    const replyStepRes = await pool.query(
      `SELECT current_step, COUNT(*) AS reply_count
         FROM sequence_enrollments
        WHERE sequence_id = $1 AND org_id = $2 AND status = 'replied'
     GROUP BY current_step
     ORDER BY current_step`,
      [req.params.id, req.orgId]
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

    res.json({
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
    });
  } catch (err) {
    console.error('sequence stats error:', err);
    res.status(500).json({ error: { message: 'Failed to load stats' } });
  }
});

module.exports = router;
