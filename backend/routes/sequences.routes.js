/**
 * sequences.routes.js
 *
 * Mount at: app.use('/api/sequences', sequencesRoutes)
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────
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

    // Extract structured Intel data from research_meta if present
    const researchMeta  = prospect.research_meta  || {};
    const pitchAngle    = researchMeta.pitchAngle  || '';
    const crispPitch    = researchMeta.crispPitch  || '';
    const researchBullets = Array.isArray(researchMeta.researchBullets) ? researchMeta.researchBullets : [];

    const systemPrompt = `You are an expert SDR writing personalised outreach for a specific prospect.\nReturn ONLY valid JSON — no markdown fences, no prose.`;

    const userPrompt = `Personalise each step in this outreach sequence for the specific prospect below.\nUse their research data to make the copy relevant and specific. Keep emails under 150 words.\nUse {{first_name}}, {{company}}, {{title}} tokens where appropriate for remaining variables.\n\nPROSPECT:\nName: ${prospect.first_name} ${prospect.last_name}\nTitle: ${prospect.title || 'unknown'}\nCompany: ${prospect.account_name || prospect.company_name || 'unknown'}\nEmail: ${prospect.email || ''}\nIndustry: ${prospect.account_industry || 'unknown'}\n${hasResearch ? `\nResearch notes: ${prospect.research_notes || 'none'}\nAccount research: ${prospect.account_research || 'none'}\n${researchBullets.length > 0 ? `Key insights:\n${researchBullets.map(b => `• ${b}`).join('\n')}` : ''}\n${pitchAngle ? `Recommended pitch angle: ${pitchAngle}` : ''}\n${crispPitch ? `Suggested opening pitch: ${crispPitch}` : ''}\n` : 'No research data available — use general personalisation based on their role and company.'}\n\nSEQUENCE: "${seqRes.rows[0].name}"\nTone & Goal: ${seqRes.rows[0].description || 'Professional outreach'}\n\nSTEPS TO PERSONALISE (${steps.length} total):\n${steps.map((s, i) => `Step ${i + 1}: channel=${s.channel}, delay_days=${s.delay_days}\n  Template subject: ${s.subject_template || '(none)'}\n  Template body: ${s.body_template || '(none)'}\n  Task note: ${s.task_note || '(none)'}`).join('\n\n')}\n\nReturn JSON:\n{\n  "steps": [\n    {\n      "step_order": 1,\n      "subject": "...",\n      "body": "...",\n      "task_note": ""\n    }\n  ]\n}`;

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
  // FIX 2: destructure personalisedSteps from body
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

        // FIX 2: pull per-prospect AI drafts if provided, keyed by step_order
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

          // FIX 3: write activity so enrollment appears in the prospect's Activity tab
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
router.get('/enrollments/:enrollId', async (req, res) => {
  try {
    const er = await pool.query(
      `SELECT se.*, s.name AS sequence_name,
              p.first_name, p.last_name, p.email, p.company_name
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.id=$1 AND se.org_id=$2`,
      [req.params.enrollId, req.orgId]
    );
    if (!er.rows.length) return res.status(404).json({ error: { message: 'Not found' } });

    const logs = await pool.query(
      `SELECT ssl.*, ss.step_order, ss.channel AS step_channel
         FROM sequence_step_logs ssl
         JOIN sequence_steps ss ON ss.id = ssl.sequence_step_id
        WHERE ssl.enrollment_id=$1
        ORDER BY ssl.fired_at`,
      [req.params.enrollId]
    );

    res.json({ enrollment: er.rows[0], logs: logs.rows });
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
// STEPS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sequences/:id/steps
router.post('/:id/steps', async (req, res) => {
  const { channel, delay_days, subject_template, body_template, task_note, require_approval } = req.body;
  if (!channel) return res.status(400).json({ error: { message: 'channel is required' } });
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
    console.error('steps POST', err);
    res.status(500).json({ error: { message: 'Failed to add step' } });
  }
});

// PUT /api/sequences/:id/steps/:stepId
router.put('/:id/steps/:stepId', async (req, res) => {
  const { channel, delay_days, subject_template, body_template, task_note, require_approval } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_steps
          SET channel=$1, delay_days=$2, subject_template=$3, body_template=$4,
              task_note=$5, require_approval=$6, updated_at=NOW()
        WHERE id=$7 AND sequence_id=$8 AND org_id=$9 RETURNING *`,
      [channel, delay_days ?? 0, subject_template || null, body_template || null,
       task_note || null,
       require_approval !== undefined ? require_approval : null,
       req.params.stepId, req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { message: 'Step not found' } });
    res.json({ step: rows[0] });
  } catch (err) {
    console.error('steps PUT', err);
    res.status(500).json({ error: { message: 'Failed to update step' } });
  }
});

// DELETE /api/sequences/:id/steps/:stepId
router.delete('/:id/steps/:stepId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM sequence_steps WHERE id=$1 AND sequence_id=$2 AND org_id=$3`,
      [req.params.stepId, req.params.id, req.orgId]
    );
    // Re-number remaining steps
    await client.query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY step_order) AS new_order
           FROM sequence_steps WHERE sequence_id=$1
       )
       UPDATE sequence_steps ss
          SET step_order = ranked.new_order
         FROM ranked WHERE ss.id = ranked.id`,
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('steps DELETE', err);
    res.status(500).json({ error: { message: 'Failed to delete step' } });
  } finally {
    client.release();
  }
});

// POST /api/sequences/:id/steps/reorder  body: { order: [stepId, stepId, ...] }
router.post('/:id/steps/reorder', async (req, res) => {
  const { order } = req.body; // array of step IDs in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: { message: 'order must be an array' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        `UPDATE sequence_steps SET step_order=$1 WHERE id=$2 AND sequence_id=$3 AND org_id=$4`,
        [i + 1, order[i], req.params.id, req.orgId]
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
    console.error('steps reorder', err);
    res.status(500).json({ error: { message: 'Failed to reorder steps' } });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI GENERATE STEPS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sequences/:id/ai-generate
// body: { prospectId }  — generates personalised subject+body for each step
router.post('/:id/ai-generate', async (req, res) => {
  const { prospectId } = req.body;
  if (!prospectId) return res.status(400).json({ error: { message: 'prospectId is required' } });

  try {
    // Load sequence + steps
    const seqRes = await pool.query(
      `SELECT * FROM sequences WHERE id=$1 AND org_id=$2`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Sequence not found' } });

    const stepsRes = await pool.query(
      `SELECT * FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order`,
      [req.params.id]
    );
    const steps = stepsRes.rows;

    // Load prospect + account
    const prospectRes = await pool.query(
      `SELECT p.*, a.name AS account_name, a.research_notes AS account_research,
              a.domain AS account_domain, a.research_meta AS account_research_meta
         FROM prospects p
    LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.id=$1 AND p.org_id=$2`,
      [prospectId, req.orgId]
    );
    if (!prospectRes.rows.length) return res.status(404).json({ error: { message: 'Prospect not found' } });
    const prospect = prospectRes.rows[0];

    const systemPrompt = `You are an expert sales development rep writing personalised outreach sequences.\nReturn ONLY valid JSON — no markdown fences, no prose.`;

    const userPrompt = `Generate personalised email subject and body for each step in this outreach sequence.\n\nPROSPECT:\nName: ${prospect.first_name} ${prospect.last_name}\nTitle: ${prospect.title || 'unknown'}\nCompany: ${prospect.account_name || prospect.company_name || 'unknown'}\nEmail: ${prospect.email || ''}\nResearch notes: ${prospect.research_notes || 'none'}\n\nACCOUNT RESEARCH:\n${prospect.account_research || 'none available'}\n\nSEQUENCE STEPS (${steps.length} total):\n${steps.map((s, i) => `Step ${i + 1}: channel=${s.channel}, delay_days=${s.delay_days}\n  Template subject: ${s.subject_template || '(none)'}\n  Template body: ${s.body_template || '(none)'}`).join('\n\n')}\n\nFor each step generate personalised subject and body. Keep emails concise (under 150 words). Use the research to personalise.\n\nReturn JSON:\n{\n  "steps": [\n    { "step_order": 1, "subject": "...", "body": "..." },\n    ...\n  ]\n}`;

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    // Track tokens
    try {
      await TokenTrackingService.log({
        orgId:    req.orgId,
        userId:   req.user.userId,
        callType: 'prospecting_sequence_generate',
        model:    'claude-sonnet-4-20250514',
        usage:    aiRes.usage,
      });
    } catch (_) {}

    const raw = aiRes.content.find(b => b.type === 'text')?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json({ generatedSteps: parsed.steps || [] });
  } catch (err) {
    console.error('ai-generate error:', err);
    res.status(500).json({ error: { message: 'AI generation failed: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI BUILD SEQUENCE — generate full sequence structure from a plain-English goal
// POST /api/sequences/ai-build
// body: { goal, stepCount?, channels? }
// Returns: { name, description, steps: [{channel, delay_days, subject_template, body_template}] }
// Does NOT save — client reviews and calls POST / to save.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai-build', async (req, res) => {
  const { goal, stepCount = 5, channels = ['email'] } = req.body;
  if (!goal?.trim()) return res.status(400).json({ error: { message: 'goal is required' } });

  try {
    const systemPrompt = `You are an expert sales development rep and copywriter building outreach sequences.\nReturn ONLY valid JSON — no markdown fences, no preamble, no prose outside the JSON.`;

    const userPrompt = `Build a complete outreach sequence based on this goal:\n\nGOAL: ${goal}\nSTEPS: ${stepCount}\nCHANNELS AVAILABLE: ${channels.join(', ')}\n\nRules:\n- Use {{first_name}}, {{last_name}}, {{full_name}}, {{title}}, {{company}}, {{industry}} as personalisation tokens\n- Keep email bodies under 120 words — concise, human, not salesy\n- Vary the approach across steps: opener → value → social proof → breakup\n- Space steps realistically: day 0, then 2–4 day gaps between follow-ups\n- For call/task steps, write a brief task_note (what to say/do), leave subject_template and body_template empty\n- sequence name should be short and descriptive (under 50 chars)\n\nReturn this exact JSON shape:\n{\n  "name": "...",\n  "description": "...",\n  "steps": [\n    {\n      "step_order": 1,\n      "channel": "email",\n      "delay_days": 0,\n      "subject_template": "...",\n      "body_template": "...",\n      "task_note": ""\n    }\n  ]\n}`;

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
// AI WRITE STEP — write a single step from a plain-English prompt
// POST /api/sequences/ai-write-step
// body: { prompt, channel, stepNumber, totalSteps, previousSteps? }
// Returns: { subject_template, body_template, task_note }
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
// Returns: enrollment status breakdown + per-step funnel (sent/replied counts)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/stats', async (req, res) => {
  try {
    // Verify sequence belongs to org
    const seqRes = await pool.query(
      `SELECT s.*, COUNT(ss.id) AS step_count
         FROM sequences s
    LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
        WHERE s.id = $1 AND s.org_id = $2
     GROUP BY s.id`,
      [req.params.id, req.orgId]
    );
    if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Not found' } });

    // Enrollment status breakdown
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

    // Per-step funnel: how many reached each step (sent) and replied at each step
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

    // Reply step distribution — which step was active when prospect replied
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

    // Average step at which replies occurred
    let avgReplyStep = null;
    if (totalReplied > 0) {
      const weightedSum = replyStepRes.rows.reduce((sum, r) => sum + r.current_step * parseInt(r.reply_count), 0);
      avgReplyStep = (weightedSum / totalReplied).toFixed(1);
    }

    // Merge funnel + reply data into step-level array
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
        ss.step_order, ss.channel,
        se.sequence_id, se.enrolled_by,
        s.name AS sequence_name,
        p.id AS prospect_id, p.first_name, p.last_name,
        p.email AS prospect_email, p.company_name,
        -- Auto-select the rep's least-used active sender account
        psa.id   AS sender_id,
        psa.email AS sender_email,
        psa.provider AS sender_provider,
        psa.label AS sender_label
      FROM sequence_step_logs ssl
      JOIN sequence_enrollments se ON se.id  = ssl.enrollment_id
      JOIN sequences s             ON s.id   = se.sequence_id
      JOIN sequence_steps ss       ON ss.id  = ssl.sequence_step_id
      JOIN prospects p             ON p.id   = ssl.prospect_id
      -- Pick the rep's least-used sender via a lateral join
      LEFT JOIN LATERAL (
        SELECT id, email, provider, label
          FROM prospecting_sender_accounts
         WHERE org_id  = ssl.org_id
           AND user_id = se.enrolled_by
           AND is_active = true
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
// Rep edits subject and/or body before sending.
router.patch('/drafts/:logId', async (req, res) => {
  const { subject, body } = req.body;
  try {
    // Verify draft belongs to this org and is still a draft
    const { rows } = await pool.query(
      `UPDATE sequence_step_logs
          SET subject = COALESCE($1, subject),
              body    = COALESCE($2, body)
        WHERE id = $3
          AND org_id = $4
          AND status = 'draft'
        RETURNING *`,
      [subject ?? null, body ?? null, req.params.logId, req.orgId]
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

    if (!prospect.email) {
      return res.status(400).json({ error: { message: 'Prospect has no email address' } });
    }

    // ── 2. Select sender account ───────────────────────────────────────────
    let sender;
    if (senderAccountId) {
      const r = await client.query(
        `SELECT * FROM prospecting_sender_accounts
          WHERE id=$1 AND org_id=$2 AND user_id=$3 AND is_active=true`,
        [senderAccountId, req.orgId, req.user.userId]
      );
      if (!r.rows.length) return res.status(404).json({ error: { message: 'Sender account not found or inactive' } });
      sender = r.rows[0];
    } else {
      const r = await client.query(
        `SELECT * FROM prospecting_sender_accounts
          WHERE org_id=$1 AND user_id=$2 AND is_active=true
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

    // ── 5. Send via Gmail or Outlook ───────────────────────────────────────
    let sendError = null;
    try {
      if (sender.provider === 'gmail') {
        await sendGmailEmail(req.user.userId, {
          to:           prospect.email,
          subject:      draft.subject,
          body:         draft.body,
          isHtml:       true,
          senderEmail:  sender.email,
          accessToken:  sender.access_token,
          refreshToken: sender.refresh_token,
        });
      } else if (sender.provider === 'outlook') {
        await sendOutlookEmail(req.user.userId, {
          to:      prospect.email,
          subject: draft.subject,
          body:    draft.body,
          isHtml:  true,
        });
      }
    } catch (err) {
      sendError = err.message;
      console.warn(`⚠️  Sequence draft send failed (saving to DB anyway): ${err.message}`);
    }

    await client.query('BEGIN');

    // ── 6. Save email to DB ────────────────────────────────────────────────
    const emailRes = await client.query(
      `INSERT INTO emails
         (org_id, user_id, direction, subject, body,
          to_address, from_address, sent_at, prospect_id, sender_account_id, provider)
       VALUES ($1,$2,'sent',$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$9)
       RETURNING *`,
      [req.orgId, req.user.userId, draft.subject, draft.body,
       prospect.email, sender.email, draft.prospect_id, sender.id, sender.provider]
    );
    const newEmail = emailRes.rows[0];

    // ── 7. Flip draft → sent ───────────────────────────────────────────────
    await client.query(
      `UPDATE sequence_step_logs
          SET status='sent', fired_at=NOW(), email_id=$1
        WHERE id=$2`,
      [newEmail.id, draft.id]
    );

    // ── 8. Update sender counters ──────────────────────────────────────────
    await client.query(
      `UPDATE prospecting_sender_accounts
          SET emails_sent_today=emails_sent_today+1,
              last_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [sender.id]
    );

    // ── 9. Update prospect outreach tracking ──────────────────────────────
    await client.query(
      `UPDATE prospects
          SET outreach_count=outreach_count+1, last_outreach_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE id=$1`,
      [draft.prospect_id]
    );

    // Auto-advance stage on first outreach
    const stageRes = await client.query(`SELECT stage FROM prospects WHERE id=$1`, [draft.prospect_id]);
    if (['target', 'researched'].includes(stageRes.rows[0]?.stage)) {
      await client.query(
        `UPDATE prospects SET stage='contacted', stage_changed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [draft.prospect_id]
      );
    }

    // ── 10. Advance enrollment to next step ────────────────────────────────
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

    // ── 11. Mark any linked overdue action completed ───────────────────────
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

    // ── 12. Write activity ─────────────────────────────────────────────────
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
router.delete('/drafts/:logId', async (req, res) => {
  const client = await pool.connect();
  try {
    // Load draft + enrollment
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

    // Flip to skipped
    await client.query(
      `UPDATE sequence_step_logs SET status='skipped', fired_at=NOW() WHERE id=$1`,
      [draft.id]
    );

    // Advance enrollment (step consumed even when skipped)
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

    // Mark linked overdue action completed
    await client.query(
      `UPDATE prospecting_actions
          SET status='completed', completed_at=CURRENT_TIMESTAMP,
              completed_by=$1, outcome='skipped', updated_at=CURRENT_TIMESTAMP
        WHERE org_id=$2 AND source='sequence_draft'
          AND (metadata->>'draftLogId')::int=$3
          AND status != 'completed'`,
      [req.user.userId, req.orgId, draft.id]
    );

    // Write activity
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

module.exports = router;

