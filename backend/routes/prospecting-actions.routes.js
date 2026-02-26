const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { generateForProspect } = require('../services/prospectingActions.service');

router.use(authenticateToken);
router.use(orgContext);

// ── Shared row mapper ────────────────────────────────────────────────────────

function mapActionRow(row) {
  return {
    id:               row.id,
    prospectId:       row.prospect_id,
    title:            row.title,
    description:      row.description,
    actionType:       row.action_type,
    channel:          row.channel,
    messageSubject:   row.message_subject,
    messageBody:      row.message_body,
    messageMetadata:  row.message_metadata,
    sequenceStep:     row.sequence_step,
    scheduledAt:      row.scheduled_at,
    status:           row.status,
    priority:         row.priority,
    completedAt:      row.completed_at,
    completedBy:      row.completed_by,
    outcome:          row.outcome,
    source:           row.source,
    aiContext:         row.ai_context,
    suggestedAction:  row.suggested_action,
    dueDate:          row.due_date,
    snoozedUntil:     row.snoozed_until,
    snoozeReason:     row.snooze_reason,
    snoozeDuration:   row.snooze_duration,
    metadata:         row.metadata,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    // Joined fields
    prospect: row.prospect_first_name ? {
      id:          row.prospect_id,
      firstName:   row.prospect_first_name,
      lastName:    row.prospect_last_name,
      email:       row.prospect_email,
      companyName: row.prospect_company_name,
      stage:       row.prospect_stage,
    } : null,
  };
}

// ── Base query ───────────────────────────────────────────────────────────────

const BASE_QUERY = `
  SELECT
    pa.*,
    p.first_name    AS prospect_first_name,
    p.last_name     AS prospect_last_name,
    p.email         AS prospect_email,
    p.company_name  AS prospect_company_name,
    p.stage         AS prospect_stage
  FROM prospecting_actions pa
  LEFT JOIN prospects p ON pa.prospect_id = p.id
`;

const ORDER_CLAUSE = `
  ORDER BY
    CASE pa.status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
    CASE pa.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
    pa.due_date ASC NULLS LAST
`;

// ── GET / — list prospecting actions ─────────────────────────────────────────
// Supports ?scope, ?prospectId, ?status, ?channel, ?actionType
router.get('/', async (req, res) => {
  try {
    const {
      scope = 'mine', prospectId, status, channel, actionType, priority,
      dueBefore, dueAfter,
    } = req.query;

    let query = BASE_QUERY + ' WHERE pa.org_id = $1';
    const params = [req.orgId];

    // Scope
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      query += ` AND pa.user_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // No user filter
    } else {
      query += ` AND pa.user_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    if (prospectId) {
      query += ` AND pa.prospect_id = $${params.length + 1}`;
      params.push(parseInt(prospectId));
    }

    if (status) {
      query += ` AND pa.status = $${params.length + 1}`;
      params.push(status);
    }

    if (channel) {
      query += ` AND pa.channel = $${params.length + 1}`;
      params.push(channel);
    }

    if (actionType) {
      query += ` AND pa.action_type = $${params.length + 1}`;
      params.push(actionType);
    }

    if (priority) {
      query += ` AND pa.priority = $${params.length + 1}`;
      params.push(priority);
    }

    if (dueAfter) {
      query += ` AND pa.due_date >= $${params.length + 1}`;
      params.push(new Date(dueAfter));
    }

    if (dueBefore) {
      query += ` AND pa.due_date <= $${params.length + 1}`;
      params.push(new Date(dueBefore));
    }

    query += ORDER_CLAUSE;

    const result = await db.query(query, params);
    res.json({ actions: result.rows.map(mapActionRow) });
  } catch (error) {
    console.error('Get prospecting actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospecting actions' } });
  }
});

// ── GET /:id — action detail ─────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      BASE_QUERY + ' WHERE pa.id = $1 AND pa.org_id = $2',
      [req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Get action detail error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch action' } });
  }
});

// ── POST / — create manual action ────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      prospectId, title, description, actionType, channel, priority,
      dueDate, messageSubject, messageBody, sequenceStep, source,
    } = req.body;

    if (!prospectId || !title || !actionType) {
      return res.status(400).json({ error: { message: 'prospectId, title, and actionType are required' } });
    }

    // Verify prospect exists in org
    const prospect = await db.query(
      'SELECT id FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [prospectId, req.orgId]
    );
    if (prospect.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const result = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id, title, description, action_type,
         channel, priority, due_date, message_subject, message_body,
         sequence_step, source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        req.orgId, req.user.userId, prospectId, title, description, actionType,
        channel || null, priority || 'medium', dueDate || null,
        messageSubject || null, messageBody || null,
        sequenceStep || null, source || 'manual',
      ]
    );

    res.status(201).json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Create prospecting action error:', error);
    res.status(500).json({ error: { message: 'Failed to create action' } });
  }
});

// ── PUT /:id — update action ─────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      title, description, priority, dueDate, channel,
      messageSubject, messageBody,
    } = req.body;

    const result = await db.query(
      `UPDATE prospecting_actions
       SET title           = COALESCE($1, title),
           description     = COALESCE($2, description),
           priority        = COALESCE($3, priority),
           due_date        = COALESCE($4, due_date),
           channel         = COALESCE($5, channel),
           message_subject = COALESCE($6, message_subject),
           message_body    = COALESCE($7, message_body),
           updated_at      = CURRENT_TIMESTAMP
       WHERE id = $8 AND org_id = $9 AND user_id = $10
       RETURNING *`,
      [title, description, priority, dueDate, channel,
       messageSubject, messageBody,
       req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Update action error:', error);
    res.status(500).json({ error: { message: 'Failed to update action' } });
  }
});

// ── PATCH /:id/status — update status (complete/reopen) ──────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, outcome } = req.body;
    const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}` } });
    }

    const isCompleting = status === 'completed';

    const updates = [`status = $1`, `updated_at = CURRENT_TIMESTAMP`];
    const params = [status];
    if (isCompleting) {
      updates.push(`completed_at = CURRENT_TIMESTAMP`, `completed_by = $${params.length + 1}`);
      params.push(req.user.userId);
      if (outcome) {
        updates.push(`outcome = $${params.length + 1}`);
        params.push(outcome);
      }
    }

    params.push(req.params.id, req.orgId, req.user.userId);
    const idIdx = params.length - 2;

    const result = await db.query(
      `UPDATE prospecting_actions
       SET ${updates.join(', ')}
       WHERE id = $${idIdx} AND org_id = $${idIdx + 1} AND user_id = $${idIdx + 2}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    const action = result.rows[0];

    // Auto-advance logic on completion of outreach actions
    if (isCompleting && action.channel) {
      await db.query(
        `UPDATE prospects
         SET outreach_count = outreach_count + 1,
             last_outreach_at = CURRENT_TIMESTAMP,
             current_sequence_step = COALESCE($1, current_sequence_step),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [action.sequence_step, action.prospect_id]
      );

      // Auto-advance from target/researched → contacted on first outreach
      const prospect = await db.query(
        'SELECT stage FROM prospects WHERE id = $1',
        [action.prospect_id]
      );
      if (prospect.rows[0] && ['target', 'researched'].includes(prospect.rows[0].stage)) {
        await db.query(
          `UPDATE prospects SET stage = 'contacted', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [action.prospect_id]
        );
        await db.query(
          `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
           VALUES ($1, $2, 'stage_change', 'Auto-advanced to contacted after first outreach')`,
          [action.prospect_id, req.user.userId]
        );
      }

      // Log outreach activity
      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, 'outreach_sent', $3, $4)`,
        [
          action.prospect_id, req.user.userId,
          `${action.channel} outreach: ${action.title}`,
          JSON.stringify({ channel: action.channel, outcome: outcome || null, actionId: action.id }),
        ]
      );
    }

    // If response outcome, update response tracking
    if (isCompleting && ['replied', 'call_connected', 'meeting_booked'].includes(outcome)) {
      await db.query(
        `UPDATE prospects
         SET response_count = response_count + 1,
             last_response_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [action.prospect_id]
      );

      // Auto-advance to engaged on first response
      const prospect = await db.query(
        'SELECT stage FROM prospects WHERE id = $1',
        [action.prospect_id]
      );
      if (prospect.rows[0] && prospect.rows[0].stage === 'contacted') {
        await db.query(
          `UPDATE prospects SET stage = 'engaged', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [action.prospect_id]
        );
        await db.query(
          `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
           VALUES ($1, $2, 'stage_change', 'Auto-advanced to engaged after response received')`,
          [action.prospect_id, req.user.userId]
        );
      }

      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, 'response_received', $3, $4)`,
        [
          action.prospect_id, req.user.userId,
          `Response via ${action.channel}: ${outcome}`,
          JSON.stringify({ channel: action.channel, outcome, actionId: action.id }),
        ]
      );
    }

    res.json({ action: mapActionRow(action) });
  } catch (error) {
    console.error('Status update error:', error);
    res.status(500).json({ error: { message: 'Failed to update status' } });
  }
});

// ── PATCH /:id/snooze ────────────────────────────────────────────────────────
router.patch('/:id/snooze', async (req, res) => {
  try {
    const { reason, duration } = req.body;
    const VALID_DURATIONS = ['1_week', '2_weeks', '1_month', 'indefinite'];
    if (!duration || !VALID_DURATIONS.includes(duration)) {
      return res.status(400).json({
        error: { message: `duration must be one of: ${VALID_DURATIONS.join(', ')}` }
      });
    }

    let snoozedUntil = null;
    if (duration === '1_week')  snoozedUntil = new Date(Date.now() + 7  * 86400000);
    if (duration === '2_weeks') snoozedUntil = new Date(Date.now() + 14 * 86400000);
    if (duration === '1_month') {
      snoozedUntil = new Date();
      snoozedUntil.setMonth(snoozedUntil.getMonth() + 1);
    }

    const result = await db.query(
      `UPDATE prospecting_actions
       SET status = 'snoozed', snoozed_until = $1, snooze_reason = $2,
           snooze_duration = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5 AND user_id = $6
       RETURNING *`,
      [snoozedUntil, reason || null, duration, req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Snooze error:', error);
    res.status(500).json({ error: { message: 'Failed to snooze action' } });
  }
});

// ── PATCH /:id/unsnooze ──────────────────────────────────────────────────────
router.patch('/:id/unsnooze', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE prospecting_actions
       SET status = 'pending', snoozed_until = NULL, snooze_reason = NULL,
           snooze_duration = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status = 'snoozed'
       RETURNING *`,
      [req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found or not snoozed' } });
    }

    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Unsnooze error:', error);
    res.status(500).json({ error: { message: 'Failed to unsnooze action' } });
  }
});

// ── POST /:id/execute — execute outreach action ──────────────────────────────
// For email: sends via existing email infrastructure
// For other channels: marks as completed with outcome
router.post('/:id/execute', async (req, res) => {
  try {
    const { outcome, notes } = req.body;

    const action = await db.query(
      'SELECT * FROM prospecting_actions WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [req.params.id, req.orgId, req.user.userId]
    );

    if (action.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    const a = action.rows[0];

    // Update action as completed with outcome
    const result = await db.query(
      `UPDATE prospecting_actions
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           completed_by = $1, outcome = $2,
           message_metadata = message_metadata || $3::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [
        req.user.userId, outcome || 'completed',
        JSON.stringify({ notes: notes || null, executed_at: new Date().toISOString() }),
        a.id,
      ]
    );

    // Update prospect outreach tracking
    if (a.channel) {
      await db.query(
        `UPDATE prospects
         SET outreach_count = outreach_count + 1,
             last_outreach_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [a.prospect_id]
      );
    }

    // Log activity
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'outreach_sent', $3, $4)`,
      [
        a.prospect_id, req.user.userId,
        `Executed: ${a.title} via ${a.channel || 'task'}`,
        JSON.stringify({ channel: a.channel, outcome, actionId: a.id }),
      ]
    );

    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Execute action error:', error);
    res.status(500).json({ error: { message: 'Failed to execute action' } });
  }
});

// ── POST /generate — generate actions from playbook for a prospect ──────────
router.post('/generate', async (req, res) => {
  try {
    const { prospectId } = req.body;
    if (!prospectId) {
      return res.status(400).json({ error: { message: 'prospectId is required' } });
    }

    const result = await generateForProspect(prospectId, req.orgId, req.user.userId);
    res.json(result);
  } catch (error) {
    console.error('Generate actions error:', error);
    res.status(400).json({ error: { message: error.message || 'Failed to generate actions' } });
  }
});

// ── POST /outreach-send — create a completed outreach + optional email record ─
// Used by OutreachComposer to log any channel's outreach in one call.
// For email channel, also creates an emails record with prospect_id set.
router.post('/outreach-send', async (req, res) => {
  try {
    const {
      prospectId, channel, subject, body, outcome,
      notes, toAddress,
    } = req.body;

    if (!prospectId || !channel) {
      return res.status(400).json({ error: { message: 'prospectId and channel are required' } });
    }

    // Verify prospect
    const pRes = await db.query(
      'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [prospectId, req.orgId]
    );
    if (pRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const prospect = pRes.rows[0];

    const channelLabel = channel.charAt(0).toUpperCase() + channel.slice(1);
    const title = `${channelLabel} outreach to ${prospect.first_name} ${prospect.last_name}`;

    // Create completed action
    const actionResult = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id, title, action_type, channel,
         message_subject, message_body, status, completed_at, completed_by,
         outcome, source, message_metadata
       ) VALUES ($1, $2, $3, $4, 'outreach', $5, $6, $7, 'completed', CURRENT_TIMESTAMP, $2, $8, 'manual', $9)
       RETURNING *`,
      [
        req.orgId, req.user.userId, prospectId, title, channel,
        subject || null, body || null,
        outcome || 'sent',
        JSON.stringify({ notes: notes || null, toAddress: toAddress || null }),
      ]
    );

    // Update prospect outreach tracking
    await db.query(
      `UPDATE prospects
       SET outreach_count = outreach_count + 1,
           last_outreach_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [prospectId]
    );

    // Auto-advance target/researched → contacted
    if (['target', 'researched'].includes(prospect.stage)) {
      await db.query(
        `UPDATE prospects SET stage = 'contacted', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [prospectId]
      );
      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
         VALUES ($1, $2, 'stage_change', 'Auto-advanced to contacted after first outreach')`,
        [prospectId, req.user.userId]
      );
    }

    // If response outcome, advance engaged
    if (['replied', 'call_connected', 'meeting_booked'].includes(outcome)) {
      await db.query(
        `UPDATE prospects
         SET response_count = response_count + 1, last_response_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [prospectId]
      );
      if (prospect.stage === 'contacted') {
        await db.query(
          `UPDATE prospects SET stage = 'engaged', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [prospectId]
        );
        await db.query(
          `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
           VALUES ($1, $2, 'stage_change', 'Auto-advanced to engaged after response received')`,
          [prospectId, req.user.userId]
        );
      }
    }

    // For email channel, also create an emails record
    let emailRecord = null;
    if (channel === 'email' && (subject || body)) {
      try {
        const emailResult = await db.query(
          `INSERT INTO emails (
             org_id, user_id, prospect_id, contact_id,
             subject, body, to_address, direction, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'outbound', 'sent')
           RETURNING id`,
          [
            req.orgId, req.user.userId, prospectId,
            prospect.contact_id || null,
            subject || '', body || '', toAddress || prospect.email || '',
          ]
        );
        emailRecord = { id: emailResult.rows[0].id };
      } catch (emailErr) {
        // Non-fatal — email record creation can fail if emails table schema differs
        console.warn('Could not create emails record for prospect outreach:', emailErr.message);
      }
    }

    // Log activity
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'outreach_sent', $3, $4)`,
      [
        prospectId, req.user.userId,
        `${channelLabel} outreach sent${outcome && outcome !== 'sent' ? ` — outcome: ${outcome}` : ''}`,
        JSON.stringify({
          channel, outcome: outcome || 'sent', actionId: actionResult.rows[0].id,
          emailId: emailRecord?.id || null,
        }),
      ]
    );

    res.json({
      action: mapActionRow(actionResult.rows[0]),
      emailId: emailRecord?.id || null,
    });
  } catch (error) {
    console.error('Outreach send error:', error);
    res.status(500).json({ error: { message: 'Failed to send outreach' } });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM prospecting_actions WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id',
      [req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    res.json({ message: 'Action deleted successfully' });
  } catch (error) {
    console.error('Delete action error:', error);
    res.status(500).json({ error: { message: 'Failed to delete action' } });
  }
});

module.exports = router;
