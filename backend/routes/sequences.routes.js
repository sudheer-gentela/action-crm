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

// POST /api/sequences  — body: { name, description, steps: [{channel, delay_days, subject_template, body_template, task_note}] }
router.post('/', async (req, res) => {
  const { name, description, steps = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: { message: 'name is required' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seqRes = await client.query(
      `INSERT INTO sequences (org_id, name, description, created_by)
            VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.orgId, name.trim(), description || null, req.user.userId]
    );
    const seq = seqRes.rows[0];

    const insertedSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const sr = await client.query(
        `INSERT INTO sequence_steps
                     (sequence_id, org_id, step_order, channel, delay_days,
                      subject_template, body_template, task_note)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [seq.id, req.orgId, i + 1, s.channel, s.delay_days ?? 0,
         s.subject_template || null, s.body_template || null, s.task_note || null]
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
  const { name, description } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sequences SET name=$1, description=$2, updated_at=NOW()
        WHERE id=$3 AND org_id=$4 RETURNING *`,
      [name, description || null, req.params.id, req.orgId]
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
  const { channel, delay_days, subject_template, body_template, task_note } = req.body;
  if (!channel) return res.status(400).json({ error: { message: 'channel is required' } });
  try {
    // Get max step_order
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(step_order), 0) AS max_order FROM sequence_steps WHERE sequence_id=$1`,
      [req.params.id]
    );
    const nextOrder = maxRes.rows[0].max_order + 1;
    const { rows } = await pool.query(
      `INSERT INTO sequence_steps
               (sequence_id, org_id, step_order, channel, delay_days, subject_template, body_template, task_note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, req.orgId, nextOrder, channel, delay_days ?? 0,
       subject_template || null, body_template || null, task_note || null]
    );
    res.status(201).json({ step: rows[0] });
  } catch (err) {
    console.error('steps POST', err);
    res.status(500).json({ error: { message: 'Failed to add step' } });
  }
});

// PUT /api/sequences/:id/steps/:stepId
router.put('/:id/steps/:stepId', async (req, res) => {
  const { channel, delay_days, subject_template, body_template, task_note } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE sequence_steps
          SET channel=$1, delay_days=$2, subject_template=$3, body_template=$4,
              task_note=$5, updated_at=NOW()
        WHERE id=$6 AND sequence_id=$7 AND org_id=$8 RETURNING *`,
      [channel, delay_days ?? 0, subject_template || null, body_template || null,
       task_note || null, req.params.stepId, req.params.id, req.orgId]
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

    const systemPrompt = `You are an expert sales development rep writing personalised outreach sequences.
Return ONLY valid JSON — no markdown fences, no prose.`;

    const userPrompt = `Generate personalised email subject and body for each step in this outreach sequence.

PROSPECT:
Name: ${prospect.first_name} ${prospect.last_name}
Title: ${prospect.title || 'unknown'}
Company: ${prospect.account_name || prospect.company_name || 'unknown'}
Email: ${prospect.email || ''}
Research notes: ${prospect.research_notes || 'none'}

ACCOUNT RESEARCH:
${prospect.account_research || 'none available'}

SEQUENCE STEPS (${steps.length} total):
${steps.map((s, i) => `Step ${i + 1}: channel=${s.channel}, delay_days=${s.delay_days}
  Template subject: ${s.subject_template || '(none)'}
  Template body: ${s.body_template || '(none)'}`).join('\n\n')}

For each step generate personalised subject and body. Keep emails concise (under 150 words). Use the research to personalise.

Return JSON:
{
  "steps": [
    { "step_order": 1, "subject": "...", "body": "..." },
    ...
  ]
}`;

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
// ENROLL
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/sequences/enroll
// body: { sequenceId, prospectIds: [id, ...], generatedSteps?: [{prospect_id, steps:[{step_order,subject,body}]}] }
router.post('/enroll', async (req, res) => {
  const { sequenceId, prospectIds, generatedSteps } = req.body;
  if (!sequenceId || !Array.isArray(prospectIds) || prospectIds.length === 0) {
    return res.status(400).json({ error: { message: 'sequenceId and prospectIds[] are required' } });
  }

  // Validate sequence belongs to org
  const seqRes = await pool.query(
    `SELECT * FROM sequences WHERE id=$1 AND org_id=$2 AND status='active'`,
    [sequenceId, req.orgId]
  );
  if (!seqRes.rows.length) return res.status(404).json({ error: { message: 'Sequence not found' } });

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
        const er = await client.query(
          `INSERT INTO sequence_enrollments
                       (org_id, sequence_id, prospect_id, enrolled_by, next_step_due)
                VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (sequence_id, prospect_id) DO NOTHING
           RETURNING *`,
          [req.orgId, sequenceId, prospectId, req.user.userId, nextDue]
        );
        if (er.rows.length) {
          enrolled.push(er.rows[0]);
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
// ENROLLMENTS
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

module.exports = router;
