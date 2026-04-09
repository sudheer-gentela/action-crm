const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');

// Email send services (reused from existing infrastructure)
const { sendEmail: sendGmailEmail }    = require('../services/googleService');
const { sendEmail: sendOutlookEmail }  = require('../services/outlookService');
const StrapActionGenerator             = require('../services/StrapActionGenerator');
const PlayCompletionService            = require('../services/PlayCompletionService');  // Phase 6
const { generateForProspectEvent }     = require('../services/prospectingActions.service'); // Phase 8

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
router.get('/', async (req, res) => {
  try {
    const {
      scope = 'mine', prospectId, status, channel, actionType, priority,
      dueBefore, dueAfter,
    } = req.query;

    let query = BASE_QUERY + ' WHERE pa.org_id = $1';
    const params = [req.orgId];

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

    if (prospectId) { query += ` AND pa.prospect_id = $${params.length + 1}`; params.push(parseInt(prospectId)); }
    if (status)     { query += ` AND pa.status = $${params.length + 1}`;      params.push(status); }
    if (channel)    { query += ` AND pa.channel = $${params.length + 1}`;     params.push(channel); }
    if (actionType) { query += ` AND pa.action_type = $${params.length + 1}`; params.push(actionType); }
    if (priority)   { query += ` AND pa.priority = $${params.length + 1}`;    params.push(priority); }
    if (dueAfter)   { query += ` AND pa.due_date >= $${params.length + 1}`;   params.push(new Date(dueAfter)); }
    if (dueBefore)  { query += ` AND pa.due_date <= $${params.length + 1}`;   params.push(new Date(dueBefore)); }

    query += ORDER_CLAUSE;

    const result = await db.query(query, params);
    res.json({ actions: result.rows.map(mapActionRow) });
  } catch (error) {
    console.error('Get prospecting actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch prospecting actions' } });
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────
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

// ── PUT /:id ──────────────────────────────────────────────────────────────────
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

// ── PATCH /:id/status ─────────────────────────────────────────────────────────
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

    // STRAP auto-resolve check
    if (isCompleting && action.strap_id) {
      StrapActionGenerator.checkAutoResolve(action.strap_id, req.user.userId, req.orgId)
        .catch(err => console.error('STRAP auto-resolve check error (prospecting):', err.message));
    }

    // Phase 6 — fire next sequential play
    if (isCompleting && action.play_id) {
      PlayCompletionService.fireNextPlay(
        'prospect', action.prospect_id, action.play_id, req.orgId, req.user.userId
      ).catch(err => console.error('Next-play hook error (prospecting status):', err.message));
    }

    // Update prospect engagement tracking
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

      // Auto-advance from target/research → outreach on first outreach
      const prospect = await db.query(
        'SELECT stage FROM prospects WHERE id = $1',
        [action.prospect_id]
      );
      if (prospect.rows[0] && ['target', 'research'].includes(prospect.rows[0].stage)) {
        await db.query(
          `UPDATE prospects SET stage = 'outreach', stage_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [action.prospect_id]
        );
        await db.query(
          `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description)
           VALUES ($1, $2, 'stage_change', 'Auto-advanced to outreach after first outreach')`,
          [action.prospect_id, req.user.userId]
        );
      }

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

    // Response outcome tracking
    if (isCompleting && ['replied', 'call_connected', 'meeting_booked'].includes(outcome)) {
      await db.query(
        `UPDATE prospects
         SET response_count = response_count + 1,
             last_response_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [action.prospect_id]
      );

      const prospect = await db.query(
        'SELECT stage FROM prospects WHERE id = $1',
        [action.prospect_id]
      );
      if (prospect.rows[0] && prospect.rows[0].stage === 'outreach') {
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

// ── PATCH /:id/snooze ─────────────────────────────────────────────────────────
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

// ── PATCH /:id/unsnooze ───────────────────────────────────────────────────────
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

// ── POST /:id/execute — execute outreach action ───────────────────────────────
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

    // Phase 6 — fire next sequential play when a playbook play is executed
    if (a.play_id) {
      PlayCompletionService.fireNextPlay(
        'prospect', a.prospect_id, a.play_id, req.orgId, req.user.userId
      ).catch(err => console.error('Next-play hook error (prospecting execute):', err.message));
    }

    // Phase 8 — diagnostic re-run after outreach execution.
    // Completing an outreach action may resolve a ghosting or stale_outreach
    // diagnostic alert immediately, rather than waiting for the nightly sweep.
    generateForProspectEvent(a.prospect_id, req.orgId, req.user.userId, 'outreach_executed')
      .catch(err => console.error('[prospecting execute] event trigger error:', err.message));

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

// ── DELETE /:id ───────────────────────────────────────────────────────────────
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

// ── POST /generate ────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    const { prospectId } = req.body;
    if (!prospectId) {
      return res.status(400).json({ error: { message: 'prospectId is required' } });
    }

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

    const { generateForProspect } = require('../services/prospectingActions.service');
    const result = await generateForProspect(prospectId, req.orgId, req.user.userId);

    res.json({
      success: true,
      created: result.created,
      skipped: result.skipped,
      source:  result.source,
      message: result.message || `Generated ${result.created} action(s) for stage "${stageKey}"`,
    });
  } catch (error) {
    console.error('Generate prospecting actions error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to generate actions' } });
  }
});

// ── POST /outreach/draft-email ────────────────────────────────────────────────
router.post('/outreach/draft-email', async (req, res) => {
  const { prospectId } = req.body;
  if (!prospectId) {
    return res.status(400).json({ error: { message: 'prospectId is required' } });
  }

  try {
    const prospectRes = await db.query(
      `SELECT p.*,
              a.name  AS account_name,
              a.industry AS account_industry
       FROM prospects p
       LEFT JOIN accounts a ON p.account_id = a.id
       WHERE p.id = $1 AND p.org_id = $2`,
      [prospectId, req.orgId]
    );
    if (prospectRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }
    const p = prospectRes.rows[0];

    const prospectInfo = [
      `Name: ${p.first_name} ${p.last_name}`,
      p.title            ? `Title: ${p.title}`             : null,
      p.company_name     ? `Company: ${p.company_name}`    : null,
      p.company_industry ? `Industry: ${p.company_industry}` : null,
      p.company_size     ? `Company size: ${p.company_size}` : null,
      p.location         ? `Location: ${p.location}`       : null,
      p.linkedin_url     ? `LinkedIn: ${p.linkedin_url}`   : null,
      p.account_name     ? `Account: ${p.account_name}`    : null,
      p.research_notes   ? `\nExisting research:\n${p.research_notes}` : null,
    ].filter(Boolean).join('\n');

    const [userPrefRes, orgCfgRes, userPromptRes, orgPromptRes] = await Promise.all([
      db.query(
        `SELECT preferences->'prospecting' AS prospecting FROM user_preferences WHERE user_id = $1 AND org_id = $2`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT config FROM org_integrations WHERE org_id = $1 AND integration_type = 'prospecting'`,
        [req.orgId]
      ),
      db.query(
        `SELECT template_data FROM user_prompts WHERE user_id = $1 AND org_id = $2 AND template_type = 'prospecting_draft'`,
        [req.user.userId, req.orgId]
      ),
      db.query(
        `SELECT template FROM prompts WHERE org_id = $1 AND user_id IS NULL AND key = 'prospecting_draft'`,
        [req.orgId]
      ),
    ]);

    const userPrefs = userPrefRes.rows[0]?.prospecting || {};
    const orgConfig = orgCfgRes.rows[0]?.config || {};

    const aiProvider = userPrefs.ai_provider || orgConfig.ai_provider || 'anthropic';
    const sanitiseModel = (m) => {
      if (!m) return m;
      return m
        .replace('claude-sonnet-4-5-20251022', 'claude-sonnet-4-6')
        .replace('claude-haiku-4-5-20251001', 'claude-haiku-4-5')
        .replace('claude-sonnet-4-20250514',  'claude-sonnet-4-6');
    };
    const aiModel = sanitiseModel(userPrefs.ai_model || orgConfig.ai_model) || 'claude-haiku-4-5';
    const productCtx = userPrefs.product_context !== undefined
      ? userPrefs.product_context
      : (orgConfig.product_context || '');

    const AI_PROMPTS = require('../config/aiPrompts');
    const systemDefault = AI_PROMPTS.prospecting_draft || `You are an expert B2B sales copywriter.

PROSPECT:
{{prospectInfo}}
{{#if productContext}}
WHAT WE SELL:
{{productContext}}
{{/if}}
RESEARCH:
{{researchNotes}}

Write a short personalised outreach email. Return ONLY valid JSON:
{"subject":"string","body":"string with \\n line breaks","tone":"consultative|direct|curious","confidence":0.8,"personalisationHooks":["hook"]}`;

    const rawTemplate = userPromptRes.rows[0]?.template_data
      || orgPromptRes.rows[0]?.template
      || systemDefault;

    const researchNotes = p.research_notes || 'No research notes yet — use general knowledge about this role and industry.';
    const prompt = rawTemplate
      .replace('{{prospectInfo}}',   prospectInfo)
      .replace('{{researchNotes}}',  researchNotes)
      .replace(/\{\{#if productContext\}\}[\s\S]*?\{\{\/if\}\}/g,
        productCtx ? `WHAT WE SELL:\n${productCtx}` : '')
      .replace('{{productContext}}',  productCtx);

    let rawText = '{}';

    if (aiProvider === 'openai') {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const completion = await openai.chat.completions.create({
        model: aiModel || 'gpt-4o-mini', max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });
      rawText = completion.choices[0]?.message?.content || '{}';
    } else if (aiProvider === 'gemini') {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
      const result = await genAI.getGenerativeModel({ model: aiModel || 'gemini-1.5-flash' })
                                .generateContent(prompt);
      rawText = result.response.text() || '{}';
    } else {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await anthropic.messages.create({
        model: aiModel, max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      });
      rawText = message.content[0]?.text || '{}';
      if (message.usage) {
        const TokenTrackingService = require('../services/TokenTrackingService');
        TokenTrackingService.log({
          orgId: req.orgId, userId: req.user.userId,
          callType: 'prospecting_draft', model: aiModel,
          usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
        }).catch(() => {});
      }
    }

    let parsed;
    try {
      const cleaned = rawText.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      const start = cleaned.indexOf('{');
      const end   = cleaned.lastIndexOf('}');
      parsed = JSON.parse(cleaned.substring(start, end + 1));
    } catch {
      parsed = {
        subject: 'Quick question for ' + p.first_name + (p.company_name ? ' at ' + p.company_name : ''),
        body:    rawText,
        tone:    'consultative',
        confidence: 0.5,
      };
    }

    db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'ai_draft', 'AI email draft generated', $3)`,
      [prospectId, req.user.userId, JSON.stringify({ model: aiModel, provider: aiProvider, confidence: parsed.confidence })]
    ).catch(() => {});

    res.json({
      subject:              parsed.subject || '',
      body:                 parsed.body    || '',
      tone:                 parsed.tone    || 'consultative',
      confidence:           parsed.confidence || 0.7,
      personalisationHooks: parsed.personalisationHooks || [],
      model:                aiModel,
      provider:             aiProvider,
    });

  } catch (error) {
    console.error('Draft email error:', error);
    res.status(500).json({ error: { message: 'Failed to generate email draft: ' + error.message } });
  }
});

module.exports = router;
