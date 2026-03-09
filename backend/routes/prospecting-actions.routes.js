const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

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

// ── PATCH /:id/status — change status ────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, outcome } = req.body;
    const VALID = ['pending', 'in_progress', 'completed', 'skipped', 'failed'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: { message: `status must be one of: ${VALID.join(', ')}` } });
    }

    const isCompleting = status === 'completed';

    const result = await db.query(
      `UPDATE prospecting_actions
       SET status       = $1,
           outcome      = COALESCE($2, outcome),
           completed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE completed_at END,
           completed_by = CASE WHEN $3 THEN $4 ELSE completed_by END,
           updated_at   = CURRENT_TIMESTAMP
       WHERE id = $5 AND org_id = $6 AND user_id = $4
       RETURNING *`,
      [status, outcome || null, isCompleting, req.user.userId, req.params.id, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    const action = result.rows[0];

    // If completing an outreach action, update prospect's engagement tracking
    if (isCompleting && action.channel) {
      await db.query(
        `UPDATE prospects
         SET outreach_count = outreach_count + 1,
             last_outreach_at = CURRENT_TIMESTAMP,
             current_sequence_step = GREATEST(current_sequence_step, COALESCE($1, 0)),
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

// ── POST /generate — generate actions from a prospect's assigned playbook ────
// Reads the prospect's current stage, looks up the playbook's stage_guidance for
// that stage, and creates prospecting_actions from the key_actions list.
// Skips actions that already exist (by title match) to avoid duplicates.

router.post('/generate', async (req, res) => {
  try {
    const { prospectId } = req.body;
    if (!prospectId) {
      return res.status(400).json({ error: { message: 'prospectId is required' } });
    }

    // 1. Load the prospect
    const prospectResult = await db.query(
      `SELECT p.*, pb.stage_guidance, pb.name AS playbook_name, pb.type AS playbook_type
       FROM prospects p
       LEFT JOIN playbooks pb ON p.playbook_id = pb.id
       WHERE p.id = $1 AND p.org_id = $2`,
      [prospectId, req.orgId]
    );

    if (prospectResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const prospect = prospectResult.rows[0];

    if (!prospect.playbook_id) {
      return res.status(400).json({ error: { message: 'No playbook assigned to this prospect. Assign one in the Overview tab first.' } });
    }

    const stageKey = prospect.stage;
    if (!stageKey) {
      return res.status(400).json({ error: { message: 'Prospect has no stage set' } });
    }

    // Terminal stages don't generate actions
    if (['converted', 'disqualified'].includes(stageKey)) {
      return res.json({ created: 0, skipped: 0, message: `No actions generated — prospect is in terminal stage "${stageKey}".` });
    }

    // 2. Get stage guidance
    const rawGuidance = prospect.stage_guidance;
    const guidance = typeof rawGuidance === 'string' ? JSON.parse(rawGuidance) : (rawGuidance || {});
    const stageGuidance = guidance[stageKey];

    if (!stageGuidance) {
      return res.json({
        created: 0, skipped: 0,
        message: `No guidance found for stage "${stageKey}" in playbook "${prospect.playbook_name}". Add stage guidance in Org Admin → Playbooks.`,
      });
    }

    const keyActions = stageGuidance.key_actions || [];
    if (keyActions.length === 0) {
      return res.json({
        created: 0, skipped: 0,
        message: `Stage "${stageKey}" has guidance but no key_actions defined. Add actions in the playbook stage guidance.`,
      });
    }

    // 3. Check existing actions to avoid duplicates
    const existingResult = await db.query(
      `SELECT title FROM prospecting_actions 
       WHERE prospect_id = $1 AND org_id = $2 AND status IN ('pending', 'in_progress', 'snoozed')`,
      [prospectId, req.orgId]
    );
    const existingTitles = new Set(existingResult.rows.map(r => r.title.toLowerCase()));

    // 4. Generate actions from key_actions
    let created = 0;
    let skipped = 0;
    const now = new Date();

    for (let i = 0; i < keyActions.length; i++) {
      const actionKey = keyActions[i];
      // Convert key to human-readable title
      const title = actionKeyToTitle(actionKey, stageKey, prospect);

      if (existingTitles.has(title.toLowerCase())) {
        skipped++;
        continue;
      }

      // Classify the action
      const actionType = classifyProspectingAction(actionKey);
      const channel    = inferChannel(actionKey, prospect.preferred_channel);
      const priority   = inferPriority(stageKey, actionType, i);
      const dueDays    = inferDueDays(stageKey, actionType, i);
      const dueDate    = new Date(now.getTime() + dueDays * 86400000);

      const description = buildActionDescription(actionKey, stageKey, stageGuidance, prospect);

      await db.query(
        `INSERT INTO prospecting_actions 
         (org_id, user_id, prospect_id, title, description, action_type, channel,
          sequence_step, status, priority, due_date, source, ai_context, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, 'playbook', $11, $12)`,
        [
          req.orgId,
          prospect.owner_id,
          prospectId,
          title,
          description,
          actionType,
          channel,
          prospect.current_sequence_step + i + 1,
          priority,
          dueDate,
          JSON.stringify({
            playbook_id: prospect.playbook_id,
            playbook_name: prospect.playbook_name,
            stage: stageKey,
            guidance_goal: stageGuidance.goal || null,
          }),
          JSON.stringify({
            generated_from: 'playbook',
            action_key: actionKey,
            stage_key: stageKey,
          }),
        ]
      );
      created++;
    }

    // 5. Log activity
    if (created > 0) {
      await db.query(
        `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
         VALUES ($1, $2, 'actions_generated', $3, $4)`,
        [
          prospectId,
          req.user.userId,
          `Generated ${created} action(s) from playbook "${prospect.playbook_name}" for stage "${stageKey}"`,
          JSON.stringify({ created, skipped, playbook_id: prospect.playbook_id, stage: stageKey }),
        ]
      );
    }

    res.json({
      created,
      skipped,
      message: `Created ${created} action(s)${skipped > 0 ? `, skipped ${skipped} duplicate(s)` : ''} for stage "${stageKey}".`,
    });
  } catch (error) {
    console.error('Generate prospecting actions error:', error);
    res.status(500).json({ error: { message: 'Failed to generate actions: ' + error.message } });
  }
});

// ── Helper: convert action key to readable title ────────────────────────────

function actionKeyToTitle(actionKey, stageKey, prospect) {
  const titleMap = {
    // Target stage
    research_company:      `Research ${prospect.company_name || 'company'} — firmographics & ICP fit`,
    research_contact:      `Research ${prospect.first_name} ${prospect.last_name} — LinkedIn & background`,
    // Researched stage
    craft_outreach:        `Draft personalised outreach for ${prospect.first_name}`,
    identify_pain_points:  `Map pain points & value proposition for ${prospect.company_name || 'prospect'}`,
    // Contacted stage
    send_email:            `Send personalised email to ${prospect.first_name}`,
    send_linkedin:         `Send LinkedIn message to ${prospect.first_name}`,
    follow_up:             `Follow up with ${prospect.first_name} (${prospect.company_name || ''})`,
    make_call:             `Call ${prospect.first_name} ${prospect.last_name}`,
    // Engaged stage
    discovery_call:        `Schedule discovery call with ${prospect.first_name}`,
    qualify:               `Qualify ${prospect.first_name} — BANT assessment`,
    share_resources:       `Share relevant case study/resources with ${prospect.first_name}`,
    // Qualified stage
    schedule_demo:         `Schedule demo for ${prospect.first_name} at ${prospect.company_name || ''}`,
    intro_to_ae:           `Introduce ${prospect.first_name} to Account Executive`,
    convert:               `Convert ${prospect.first_name} to deal — create opportunity`,
  };

  if (titleMap[actionKey]) return titleMap[actionKey];

  // Fallback: humanise the key
  return actionKey
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    + ` — ${prospect.first_name} ${prospect.last_name}`;
}

// ── Helper: classify action type ────────────────────────────────────────────

function classifyProspectingAction(actionKey) {
  const map = {
    research_company:     'research',
    research_contact:     'research',
    craft_outreach:       'document_prep',
    identify_pain_points: 'research',
    send_email:           'email_send',
    send_linkedin:        'social_touch',
    follow_up:            'email_send',
    make_call:            'call',
    discovery_call:       'meeting_schedule',
    qualify:              'task_complete',
    share_resources:      'email_send',
    schedule_demo:        'meeting_schedule',
    intro_to_ae:          'task_complete',
    convert:              'task_complete',
  };
  return map[actionKey] || 'task_complete';
}

// ── Helper: infer channel ───────────────────────────────────────────────────

function inferChannel(actionKey, preferredChannel) {
  const channelMap = {
    send_email:    'email',
    follow_up:     'email',
    share_resources: 'email',
    send_linkedin: 'linkedin',
    make_call:     'phone',
    discovery_call: 'phone',
  };
  return channelMap[actionKey] || null;
}

// ── Helper: infer priority ──────────────────────────────────────────────────

function inferPriority(stageKey, actionType, index) {
  // Later stages are higher priority
  const stagePriority = {
    qualified: 'high',
    engaged:   'high',
    contacted: 'medium',
    researched: 'medium',
    target:    'low',
    nurture:   'low',
  };

  if (stagePriority[stageKey] === 'high') return index === 0 ? 'critical' : 'high';
  if (actionType === 'meeting_schedule') return 'high';
  return stagePriority[stageKey] || 'medium';
}

// ── Helper: infer due days ──────────────────────────────────────────────────

function inferDueDays(stageKey, actionType, index) {
  const baseByStage = {
    target:     2,
    researched: 1,
    contacted:  1,
    engaged:    1,
    qualified:  0, // today
    nurture:    5,
  };
  const base = baseByStage[stageKey] ?? 2;
  // Stagger actions: each subsequent action gets +1 day
  return base + index;
}

// ── Helper: build action description ────────────────────────────────────────

function buildActionDescription(actionKey, stageKey, stageGuidance, prospect) {
  const parts = [];

  // Stage context
  if (stageGuidance.goal) {
    parts.push(`Stage goal: ${stageGuidance.goal}`);
  }
  if (stageGuidance.timeline) {
    parts.push(`Target timeline: ${stageGuidance.timeline}`);
  }

  // Prospect context
  if (prospect.research_notes) {
    parts.push(`Research notes: ${prospect.research_notes.substring(0, 200)}`);
  }
  if (prospect.company_industry) {
    parts.push(`Industry: ${prospect.company_industry}`);
  }

  // Success criteria
  if (stageGuidance.success_criteria?.length) {
    parts.push(`Success criteria: ${stageGuidance.success_criteria.join('; ')}`);
  }

  return parts.join('\n\n') || `Action for ${stageKey} stage.`;
}

module.exports = router;
