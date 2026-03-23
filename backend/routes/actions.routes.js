const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ActionsGenerator           = require('../services/actionsGenerator');
const ContractActionsGenerator   = require('../services/ContractActionsGenerator');
const ActionConfigService = require('../services/actionConfig.service');
const ActionCompletionDetector = require('../services/actionCompletionDetector.service');
const StrapEngine = require('../services/StrapEngine');
const StrapActionGenerator = require('../services/StrapActionGenerator');

// ── Auth + org context on every route in this file ───────────
// authenticateToken  → validates JWT, sets req.userId + req.user
// orgContext         → resolves org_id from JWT/DB, sets req.orgId
router.use(authenticateToken);
router.use(orgContext);

// ── Module derivation ─────────────────────────────────────────
function deriveModule(row) {
  if (row.source_module) return row.source_module;
  if (row.contract_id)   return 'contracts';
  if (row.prospect_id)   return 'prospecting';
  if (row.source_rule && (
    row.source_rule.includes('handoff') ||
    row.source_rule.includes('kickoff') ||
    row.source_rule.includes('stakeholder_gap') ||
    row.source_rule.includes('milestone') ||
    row.source_rule.includes('adoption') ||
    row.source_rule.includes('escalation')
  )) return 'handovers';
  if (row.deal_id)    return 'deals';
  if (row.case_id)    return 'service';
  if (row.client_id)  return 'agency';
  return 'general';
}

// ── Shared row mapper ─────────────────────────────────────────
function mapActionRow(row) {
  return {
    id:                      row.id,
    type:                    row.type,
    actionType:              row.action_type,
    priority:                row.priority,
    title:                   row.title,
    description:             row.description,
    context:                 row.context,
    suggestedAction:         row.suggested_action,
    sourceRule:              row.source_rule,
    healthParam:             row.health_param,
    source:                  row.source,
    sourceId:                row.source_id,
    nextStep:                row.next_step || 'email',
    isInternal:              row.is_internal || false,
    status:                  row.status || (row.completed ? 'completed' : 'yet_to_start'),
    completed:               row.completed,
    completedAt:             row.completed_at,
    completedBy:             row.completed_by,
    autoCompleted:           row.auto_completed,
    completionEvidence:      row.completion_evidence,
    metadata:                row.metadata,
    dueDate:                 row.due_date,
    // Snooze fields
    snoozedUntil:            row.snoozed_until,
    snoozeReason:            row.snooze_reason,
    snoozeDuration:          row.snooze_duration,
    createdAt:               row.created_at,
    updatedAt:               row.updated_at,
    sourceModule:            deriveModule(row),
    deal: row.deal_id ? {
      id:        row.deal_id,
      name:      row.deal_name,
      value:     parseFloat(row.deal_value) || 0,
      stage:     row.deal_stage,
      account:   row.account_name,
      ownerId:   row.deal_owner_id,
      ownerName: row.deal_owner_name,
    } : null,
    contact: row.contact_id ? {
      id:        row.contact_id,
      firstName: row.contact_first_name,
      lastName:  row.contact_last_name,
      email:     row.contact_email,
    } : null,
    evidenceEmail: row.evidence_subject ? {
      subject:   row.evidence_subject,
      snippet:   row.evidence_snippet,
      direction: row.evidence_direction,
      sentAt:    row.evidence_sent_at,
    } : null,
    contract: row.contract_id ? {
      id:           row.contract_id,
      title:        row.contract_title,
      contractType: row.contract_type,
      status:       row.contract_status,
    } : null,
  };
}

// ── Shared base query ─────────────────────────────────────────
// org_id filter is on `a` (actions). The joined tables
// (deals, contacts, accounts, emails) are implicitly org-scoped
// because they FK through actions — but we also guard deals and
// emails explicitly to prevent cross-org data leaking through
// the LEFT JOINs.
const BASE_QUERY = `
  SELECT
    a.*,
    d.name          AS deal_name,
    d.value         AS deal_value,
    d.stage         AS deal_stage,
    d.owner_id      AS deal_owner_id,
    u.first_name || ' ' || u.last_name AS deal_owner_name,
    c.first_name    AS contact_first_name,
    c.last_name     AS contact_last_name,
    c.email         AS contact_email,
    acc.name        AS account_name,
    ev.subject      AS evidence_subject,
    LEFT(ev.body, 300) AS evidence_snippet,
    ev.direction    AS evidence_direction,
    ev.sent_at      AS evidence_sent_at,
    ct.title        AS contract_title,
    ct.contract_type AS contract_type,
    ct.status       AS contract_status,
    a.source_module,
    a.prospect_id
  FROM actions a
  LEFT JOIN deals d      ON a.deal_id     = d.id    AND d.org_id   = a.org_id
  LEFT JOIN users u      ON d.owner_id    = u.id
  LEFT JOIN contacts c   ON a.contact_id  = c.id    AND c.org_id   = a.org_id
  LEFT JOIN accounts acc ON d.account_id  = acc.id  AND acc.org_id = a.org_id
  LEFT JOIN emails ev    ON a.source_id   = ev.id::varchar AND ev.org_id = a.org_id
  LEFT JOIN contracts ct ON a.contract_id = ct.id   AND ct.org_id  = a.org_id
`;

const ORDER_CLAUSE = `
  ORDER BY
    CASE a.status WHEN 'yet_to_start' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'snoozed' THEN 3 ELSE 4 END,
    CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
    a.due_date ASC NULLS LAST
`;

// ── GET /  — list actions with full filter support ────────────
// Supports ?scope=mine|team|org (default: mine)
//   mine — only current user's actions
//   team — current user + all subordinates (hierarchy-based)
//   org  — all actions in the org
router.get('/', async (req, res) => {
  try {
    const {
      completed,
      status,
      priority,
      dealId,
      accountId,
      ownerId,
      actionType,
      isInternal,
      nextStep,
      dueBefore,
      dueAfter,
      scope = 'mine',
      contractId,
    } = req.query;

    // org_id is the primary isolation filter — always first
    let query = BASE_QUERY + ' WHERE a.org_id = $1';
    const params = [req.orgId];

    // Scope filtering on a.user_id
    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      query += ` AND a.user_id = ANY($${params.length + 1}::int[])`;
      params.push(teamIds);
    } else if (scope === 'org') {
      // No user_id filter — all actions in org
    } else {
      // Default: mine only
      query += ` AND a.user_id = $${params.length + 1}`;
      params.push(req.user.userId);
    }

    if (status) {
      query += ` AND a.status = $${params.length + 1}`;
      params.push(status);
    } else if (completed !== undefined) {
      query += ` AND a.completed = $${params.length + 1}`;
      params.push(completed === 'true');
    }

    if (priority) {
      query += ` AND a.priority = $${params.length + 1}`;
      params.push(priority);
    }

    if (dealId) {
      query += ` AND a.deal_id = $${params.length + 1}`;
      params.push(parseInt(dealId));
    }

    if (accountId) {
      query += ` AND d.account_id = $${params.length + 1}`;
      params.push(parseInt(accountId));
    }

    if (ownerId) {
      query += ` AND d.owner_id = $${params.length + 1}`;
      params.push(parseInt(ownerId));
    }

    if (contractId) {
      query += ` AND a.contract_id = $${params.length + 1}`;
      params.push(parseInt(contractId));
    }

    if (actionType) {
      const TYPE_MAP = {
        meeting:       ['meeting', 'meeting_schedule'],
        follow_up:     ['follow_up'],
        email_send:    ['email', 'email_send'],
        document_prep: ['document_prep', 'document'],
        meeting_prep:  ['meeting_prep', 'review'],
        internal:      null,
      };
      if (actionType === 'internal') {
        query += ` AND a.is_internal = true`;
      } else if (TYPE_MAP[actionType]) {
        query += ` AND a.type = ANY($${params.length + 1}::varchar[])`;
        params.push(TYPE_MAP[actionType]);
      }
    }

    if (isInternal !== undefined) {
      query += ` AND a.is_internal = $${params.length + 1}`;
      params.push(isInternal === 'true');
    }

    if (nextStep) {
      query += ` AND a.next_step = $${params.length + 1}`;
      params.push(nextStep);
    }

    if (dueAfter) {
      query += ` AND a.due_date >= $${params.length + 1}`;
      params.push(new Date(dueAfter));
    }

    if (dueBefore) {
      query += ` AND a.due_date <= $${params.length + 1}`;
      params.push(new Date(dueBefore));
    }

    query += ORDER_CLAUSE;

    const result = await db.query(query, params);
    res.json({ actions: result.rows.map(mapActionRow) });

  } catch (error) {
    console.error('Get actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch actions' } });
  }
});

// ── GET /straps — list all active STRAPs for the user's scope ───
// Used by ActionsView pinned STRAP section.
// Supports ?scope=mine|team|org, ?entityType, ?dealId, ?accountId
router.get('/straps', async (req, res) => {
  try {
    const { scope = 'mine', entityType, dealId, accountId } = req.query;
    const straps = await StrapEngine.getAllActive(req.user.userId, req.orgId, {
      scope,
      subordinateIds: req.subordinateIds || [],
      entityType: entityType || null,
      dealId: dealId || null,
      accountId: accountId || null,
    });
    res.json({ straps });
  } catch (error) {
    console.error('List active STRAPs error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch active STRAPs' } });
  }
});

// ── PATCH /straps/:id — partially update a STRAP ─────────────
// Body: { situation?, target?, response?, action_plan?, hurdle_title?, priority? }
router.patch('/straps/:id', async (req, res) => {
  try {
    const result = await StrapEngine.update(
      parseInt(req.params.id),
      req.user.userId,
      req.orgId,
      req.body
    );
    res.json(result);
  } catch (error) {
    console.error('Update STRAP error:', error);
    const status = error.message.includes('not found') ? 404 : error.message.includes('Access denied') ? 403 : 400;
    res.status(status).json({ error: { message: error.message } });
  }
});

// ── GET /straps/:id/progress — get action completion progress ─
router.get('/straps/:id/progress', async (req, res) => {
  try {
    const progress = await StrapActionGenerator.getProgress(parseInt(req.params.id));
    res.json({ progress });
  } catch (error) {
    console.error('STRAP progress error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch STRAP progress' } });
  }
});

// ── GET /straps/:id/actions — detailed STRAP actions with assignees ──────
router.get('/straps/:id/actions', async (req, res) => {
  try {
    const strapId = parseInt(req.params.id);
    const orgId = req.orgId;

    const result = await db.query(`
      SELECT
        sa.action_table,
        sa.action_id,
        CASE sa.action_table
          WHEN 'actions' THEN a.title
          WHEN 'prospecting_actions' THEN pa.title
        END AS title,
        CASE sa.action_table
          WHEN 'actions' THEN a.status
          WHEN 'prospecting_actions' THEN
            CASE pa.status WHEN 'pending' THEN 'yet_to_start' ELSE pa.status END
        END AS status,
        CASE sa.action_table
          WHEN 'actions' THEN a.next_step
          WHEN 'prospecting_actions' THEN pa.channel
        END AS next_step,
        CASE sa.action_table
          WHEN 'actions' THEN a.priority
          WHEN 'prospecting_actions' THEN pa.priority
        END AS priority,
        CASE sa.action_table
          WHEN 'actions' THEN a.due_date
          WHEN 'prospecting_actions' THEN pa.due_date
        END AS due_date,
        CASE sa.action_table
          WHEN 'actions' THEN a.user_id
          WHEN 'prospecting_actions' THEN pa.user_id
        END AS user_id,
        u.first_name || ' ' || u.last_name AS assignee_name
      FROM strap_actions sa
      LEFT JOIN actions a ON sa.action_table = 'actions' AND sa.action_id = a.id
      LEFT JOIN prospecting_actions pa ON sa.action_table = 'prospecting_actions' AND sa.action_id = pa.id
      LEFT JOIN users u ON u.id = CASE sa.action_table
        WHEN 'actions' THEN a.user_id
        WHEN 'prospecting_actions' THEN pa.user_id
      END
      WHERE sa.strap_id = $1
      ORDER BY
        CASE
          WHEN COALESCE(a.status, pa.status) = 'completed' THEN 3
          WHEN COALESCE(a.status, pa.status) = 'in_progress' THEN 1
          ELSE 2
        END,
        COALESCE(a.due_date, pa.due_date) ASC NULLS LAST
    `, [strapId]);

    res.json({ actions: result.rows });
  } catch (error) {
    console.error('STRAP actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch STRAP actions' } });
  }
});

// ── PATCH /straps/actions/:actionId/assign — reassign a STRAP action ─────
router.patch('/straps/actions/:actionId/assign', async (req, res) => {
  try {
    const actionId = parseInt(req.params.actionId);
    const { userId, actionTable = 'actions' } = req.body;
    const orgId = req.orgId;

    if (!userId) {
      return res.status(400).json({ error: { message: 'userId is required' } });
    }

    // Verify user exists in org
    const userCheck = await db.query(
      'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND org_id = $2',
      [userId, orgId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found in this org' } });
    }

    const assignee = userCheck.rows[0];
    let actionRow;

    // Update the action's user_id and fetch action details
    if (actionTable === 'prospecting_actions') {
      const result = await db.query(
        `UPDATE prospecting_actions SET user_id = $1 WHERE id = $2 AND org_id = $3
         RETURNING id, title, due_date, channel, priority, prospect_id, strap_id`,
        [userId, actionId, orgId]
      );
      actionRow = result.rows[0];
    } else {
      const result = await db.query(
        `UPDATE actions SET user_id = $1 WHERE id = $2 AND org_id = $3
         RETURNING id, title, due_date, next_step, priority, deal_id, strap_id`,
        [userId, actionId, orgId]
      );
      actionRow = result.rows[0];
    }

    if (!actionRow) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }

    // Create a calendar entry (meeting) for the assignee so it shows in CalendarView
    let meetingId = null;
    if (actionRow.due_date) {
      try {
        const dueDate = new Date(actionRow.due_date);
        // Default to a 30-min block at 9:00 AM on the due date
        const startTime = new Date(dueDate);
        startTime.setHours(9, 0, 0, 0);
        const endTime = new Date(startTime);
        endTime.setMinutes(endTime.getMinutes() + 30);

        const channel = actionRow.next_step || actionRow.channel || 'internal_task';
        const channelLabel = {
          email: 'Email', call: 'Call', linkedin: 'LinkedIn',
          whatsapp: 'WhatsApp', document: 'Document Prep',
          internal_task: 'Task', slack: 'Slack',
        }[channel] || 'Task';

        const meetingResult = await db.query(
          `INSERT INTO meetings (
             org_id, user_id, deal_id,
             title, description,
             start_time, end_time,
             meeting_type, source, status,
             created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'strap','scheduled',NOW())
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            orgId,
            userId,
            actionRow.deal_id || null,
            `[STRAP ${channelLabel}] ${actionRow.title}`,
            `Auto-created from STRAP action assignment. Priority: ${actionRow.priority || 'medium'}.`,
            startTime,
            endTime,
            channel === 'call' ? 'call' : channel === 'email' ? 'virtual' : 'task',
          ]
        );
        meetingId = meetingResult.rows[0]?.id || null;
      } catch (calErr) {
        // Calendar entry is best-effort — don't fail the assignment
        console.error('📅 STRAP calendar entry creation failed (non-blocking):', calErr.message);
      }
    }

    res.json({
      success: true,
      assignee: {
        id: assignee.id,
        name: `${assignee.first_name} ${assignee.last_name}`,
      },
      meetingCreated: !!meetingId,
    });
  } catch (error) {
    console.error('STRAP action assign error:', error);
    res.status(500).json({ error: { message: 'Failed to assign action' } });
  }
});

// ── GET /filter-options ───────────────────────────────────────
// Respects ?scope=mine|team|org so filter dropdowns match the active scope
router.get('/filter-options', async (req, res) => {
  try {
    const { scope = 'mine' } = req.query;

    // Build user_id filter fragment
    let userFilter;
    const baseParams = [req.orgId];

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      userFilter = `a.user_id = ANY($2::int[])`;
      baseParams.push(teamIds);
    } else if (scope === 'org') {
      userFilter = 'TRUE'; // no user_id filter
    } else {
      userFilter = `a.user_id = $2`;
      baseParams.push(req.user.userId);
    }

    const [dealsRes, accountsRes, ownersRes] = await Promise.all([
      db.query(
        `SELECT DISTINCT d.id, d.name FROM deals d
         INNER JOIN actions a ON a.deal_id = d.id
         WHERE a.org_id = $1 AND ${userFilter}
         ORDER BY d.name`,
        baseParams
      ),
      db.query(
        `SELECT DISTINCT acc.id, acc.name FROM accounts acc
         INNER JOIN deals d   ON d.account_id = acc.id
         INNER JOIN actions a ON a.deal_id    = d.id
         WHERE a.org_id = $1 AND ${userFilter}
         ORDER BY acc.name`,
        baseParams
      ),
      db.query(
        `SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name AS name
         FROM users u
         INNER JOIN deals d   ON d.owner_id = u.id
         INNER JOIN actions a ON a.deal_id  = d.id
         WHERE a.org_id = $1 AND ${userFilter}
         ORDER BY name`,
        baseParams
      ),
    ]);
    res.json({
      deals:    dealsRes.rows,
      accounts: accountsRes.rows,
      owners:   ownersRes.rows,
    });
  } catch (error) {
    console.error('Filter options error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch filter options' } });
  }
});

// ── POST /generate ────────────────────────────────────────────
// Generates deal actions AND prospecting actions in one click.
// Optional body: { dealId } — if provided, generates for that deal only.
// Optional body: { source: 'prospecting' } — only generate prospecting actions.
router.post('/generate', async (req, res) => {
  try {
    const { dealId, source } = req.body || {};
    console.log('🤖 Manual action generation triggered — user:', req.user.userId, 'org:', req.orgId,
      dealId ? `deal: ${dealId}` : source === 'prospecting' ? '(prospecting only)' : '(all)');

    let dealResult = { success: true, generated: 0, inserted: 0 };
    let prospectResult = { created: 0, skipped: 0, prospects: 0 };

    // ── Deal actions (skip if prospecting-only) ────────────────
    if (source !== 'prospecting') {
      if (dealId) {
        dealResult = await ActionsGenerator.generateForDeal(dealId);
      } else {
        dealResult = await ActionsGenerator.generateAll();
      }
    }

    // ── Prospecting actions (skip if deal-specific) ────────────
    if (!dealId && source !== 'deals') {
      prospectResult = await generateAllProspectingActions(req.orgId, req.user.userId);
    }

    // ── CLM contract actions ───────────────────────────────────
    let clmResult = { success: true, generated: 0, inserted: 0 };
    if (source !== 'prospecting' && source !== 'deals') {
      const { contractId } = req.body || {};
      if (contractId) {
        const ins = await ContractActionsGenerator.generateForContract(parseInt(contractId));
        clmResult = { success: true, generated: ins, inserted: ins };
      } else if (!dealId) {
        clmResult = await ContractActionsGenerator.generateAll();
      }
    }

    res.json({
      success:   true,
      message:   `Generated ${dealResult.inserted || 0} deal action(s), ${prospectResult.created} prospecting action(s), ${clmResult.inserted || 0} CLM action(s)`,
      generated: (dealResult.generated || 0) + prospectResult.created + (clmResult.generated || 0),
      inserted:  (dealResult.inserted  || 0) + prospectResult.created + (clmResult.inserted  || 0),
      deal:      { generated: dealResult.generated || 0, inserted: dealResult.inserted || 0 },
      prospecting: prospectResult,
      clm:       { generated: clmResult.generated || 0, inserted: clmResult.inserted || 0 },
    });
  } catch (error) {
    console.error('Error in /generate endpoint:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// ── Bulk prospecting action generator ────────────────────────
// Finds all prospects with an assigned playbook, reads their current stage,
// and generates actions from the playbook's stage_guidance. Skips duplicates.
async function generateAllProspectingActions(orgId, userId) {
  const result = { created: 0, skipped: 0, prospects: 0, errors: [] };

  try {
    const prospectsRes = await db.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.company_name,
              p.stage, p.stage_changed_at, p.owner_id, p.playbook_id,
              p.preferred_channel, p.research_notes, p.company_industry,
              p.current_sequence_step,
              pb.stage_guidance, pb.name AS playbook_name
       FROM prospects p
       JOIN playbooks pb ON p.playbook_id = pb.id
       WHERE p.org_id = $1 AND p.deleted_at IS NULL
         AND p.stage NOT IN ('converted', 'disqualified')`,
      [orgId]
    );

    result.prospects = prospectsRes.rows.length;

    for (const prospect of prospectsRes.rows) {
      try {
        // ── Try structured plays with conditional firing first ──────────
        const PlaybookService = require('../services/playbook.service');
        const plays = await PlaybookService.getPlaysForStage(orgId, prospect.stage);

        if (plays.length > 0) {
          const prospectContext = await buildProspectContext(prospect, orgId);
          const existingRes = await db.query(
            `SELECT title FROM prospecting_actions
             WHERE prospect_id = $1 AND org_id = $2 AND status IN ('pending', 'in_progress', 'snoozed')`,
            [prospect.id, orgId]
          );
          const existingTitles = new Set(existingRes.rows.map(r => r.title.toLowerCase()));
          const now = new Date();

          for (const play of plays) {
            if (!PlaybookService.evaluateConditions(play.fire_conditions, prospectContext)) {
              result.skipped++; continue;
            }
            if (existingTitles.has(play.title.toLowerCase())) {
              result.skipped++; continue;
            }
            const dueDate = new Date(now.getTime() + (play.due_offset_days || 2) * 86400000);
            const channel = play.channel || prospectDefaultChannel(prospect.stage);
            await db.query(
              `INSERT INTO prospecting_actions
               (org_id, user_id, prospect_id, title, description, action_type, channel,
                sequence_step, status, priority, due_date, source, suggested_action, ai_context, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,'playbook',$11,$12,$13)`,
              [
                orgId, prospect.owner_id, prospect.id, play.title,
                play.description || `Playbook action for ${prospect.stage} stage`,
                channel === 'document' ? 'document_prep' : 'outreach',
                channel,
                (prospect.current_sequence_step || 0) + 1,
                play.priority || 'medium', dueDate,
                play.suggested_action || null,
                JSON.stringify({ playbook_id: prospect.playbook_id, playbook_name: prospect.playbook_name, stage: prospect.stage }),
                JSON.stringify({ generated_from: 'playbook_plays', play_id: play.id, stage_key: prospect.stage }),
              ]
            );
            result.created++;
          }
          continue; // structured plays handled — skip legacy path
        }

        // ── Legacy fallback: key_actions string array (unconditional) ──
        const rawGuidance = prospect.stage_guidance;
        const guidance = typeof rawGuidance === 'string' ? JSON.parse(rawGuidance) : (rawGuidance || {});
        const stageGuidance = guidance[prospect.stage];
        if (!stageGuidance?.key_actions?.length) continue;

        const existingRes = await db.query(
          `SELECT title FROM prospecting_actions
           WHERE prospect_id = $1 AND org_id = $2 AND status IN ('pending', 'in_progress', 'snoozed')`,
          [prospect.id, orgId]
        );
        const existingTitles = new Set(existingRes.rows.map(r => r.title.toLowerCase()));
        const now = new Date();

        for (let i = 0; i < stageGuidance.key_actions.length; i++) {
          const actionKey = stageGuidance.key_actions[i];
          const title = prospectActionTitle(actionKey, prospect);
          if (existingTitles.has(title.toLowerCase())) { result.skipped++; continue; }

          const actionType = prospectActionType(actionKey);
          const channel    = prospectActionChannel(actionKey);
          const priority   = prospectActionPriority(prospect.stage, actionType, i);
          const baseDays   = { target: 2, researched: 1, contacted: 1, engaged: 1, qualified: 0, nurture: 5 };
          const dueDate    = new Date(now.getTime() + ((baseDays[prospect.stage] ?? 2) + i) * 86400000);

          await db.query(
            `INSERT INTO prospecting_actions
             (org_id, user_id, prospect_id, title, description, action_type, channel,
              sequence_step, status, priority, due_date, source, ai_context, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,'playbook',$11,$12)`,
            [
              orgId, prospect.owner_id, prospect.id, title,
              stageGuidance.goal ? `Stage goal: ${stageGuidance.goal}` : `Action for ${prospect.stage} stage`,
              actionType, channel,
              (prospect.current_sequence_step || 0) + i + 1,
              priority, dueDate,
              JSON.stringify({ playbook_id: prospect.playbook_id, playbook_name: prospect.playbook_name, stage: prospect.stage }),
              JSON.stringify({ generated_from: 'playbook_bulk', action_key: actionKey, stage_key: prospect.stage }),
            ]
          );
          result.created++;
        }

        // ── AI Enhancement (optional, module-gated) ──────────────────────
        try {
          const ActionConfigService = require('../services/actionConfig.service');
          const actionConfig = await ActionConfigService.getConfig(prospect.owner_id, orgId);
          if (ActionConfigService.isAiEnabledForModule(actionConfig, 'prospecting')) {
            const ProspectingAIEnhancer = require('../services/ProspectingAIEnhancer');
            const aiCreated = await ProspectingAIEnhancer.enhance(prospect, orgId, prospect.owner_id);
            if (aiCreated > 0) result.created += aiCreated;
          }
        } catch (aiErr) {
          console.error(`Prospecting AI enhancement skipped for ${prospect.id}:`, aiErr.message);
        }

      } catch (err) {
        result.errors.push({ prospectId: prospect.id, error: err.message });
      }
    }
  } catch (err) {
    result.errors.push({ error: err.message });
  }
  return result;
}

// Minimal context object for ProspectingService.evaluateConditions()
async function buildProspectContext(prospect, orgId) {
  try {
    const [actionsRes, meetingsRes] = await Promise.all([
      db.query(
        `SELECT title, status, channel, completed_at, created_at FROM prospecting_actions
         WHERE prospect_id=$1 AND org_id=$2 ORDER BY created_at DESC LIMIT 20`,
        [prospect.id, orgId]
      ),
      db.query(
        `SELECT id, status, start_time FROM meetings
         WHERE org_id=$1 AND title ILIKE $2 ORDER BY start_time DESC LIMIT 10`,
        [orgId, `%${prospect.first_name}%`]
      ),
    ]);
    const now = Date.now();
    const stageEntry = prospect.stage_changed_at ? new Date(prospect.stage_changed_at) : new Date(0);
    const daysInStage = Math.floor((now - stageEntry) / 86400000);
    const completedMeetings = meetingsRes.rows.filter(m => m.status === 'completed');
    const upcomingMeetings  = meetingsRes.rows.filter(m => m.status === 'scheduled' && new Date(m.start_time) > new Date());
    const sentEmails = actionsRes.rows.filter(a => a.channel === 'email' && a.status === 'completed');
    return {
      deal: { id: prospect.id, stage: prospect.stage, stage_changed_at: prospect.stage_changed_at, org_id: orgId },
      contacts: [], files: [], healthBreakdown: null,
      emails: sentEmails.map(a => ({ direction: 'sent', sent_at: a.completed_at || a.created_at })),
      derived: {
        completedMeetings, upcomingMeetings, daysInStage, daysUntilClose: null,
        decisionMakers: [], champions: [], isHighValue: false, isStagnant: daysInStage > 14,
        closingImminently: false, isPastClose: false,
        daysSinceLastMeeting: completedMeetings.length > 0
          ? Math.floor((now - new Date(completedMeetings[0].start_time)) / 86400000) : 999,
        daysSinceLastEmail: sentEmails.length > 0
          ? Math.floor((now - new Date(sentEmails[0].completed_at || 0)) / 86400000) : 999,
      },
    };
  } catch {
    return {
      deal: { id: prospect.id, stage: prospect.stage, stage_changed_at: prospect.stage_changed_at },
      contacts: [], emails: [], files: [], healthBreakdown: null,
      derived: { completedMeetings: [], upcomingMeetings: [], daysInStage: 0, daysUntilClose: null,
                 decisionMakers: [], champions: [] },
    };
  }
}

function prospectDefaultChannel(stage) {
  return { target: 'email', researched: 'email', contacted: 'email', engaged: 'call', qualified: 'call', nurture: 'email' }[stage] || 'email';
}

// ── Prospect action helpers (mirrored from prospecting-actions.routes.js) ────

function prospectActionTitle(actionKey, prospect) {
  const map = {
    research_company: `Research ${prospect.company_name || 'company'} — firmographics & ICP fit`,
    research_contact: `Research ${prospect.first_name} ${prospect.last_name} — LinkedIn & background`,
    craft_outreach: `Draft personalised outreach for ${prospect.first_name}`,
    identify_pain_points: `Map pain points & value proposition for ${prospect.company_name || 'prospect'}`,
    send_email: `Send personalised email to ${prospect.first_name}`,
    send_linkedin: `Send LinkedIn message to ${prospect.first_name}`,
    follow_up: `Follow up with ${prospect.first_name} (${prospect.company_name || ''})`,
    make_call: `Call ${prospect.first_name} ${prospect.last_name}`,
    discovery_call: `Schedule discovery call with ${prospect.first_name}`,
    qualify: `Qualify ${prospect.first_name} — BANT assessment`,
    share_resources: `Share relevant case study/resources with ${prospect.first_name}`,
    schedule_demo: `Schedule demo for ${prospect.first_name} at ${prospect.company_name || ''}`,
    intro_to_ae: `Introduce ${prospect.first_name} to Account Executive`,
    convert: `Convert ${prospect.first_name} to deal — create opportunity`,
  };
  return map[actionKey] || actionKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ` — ${prospect.first_name} ${prospect.last_name}`;
}

function prospectActionType(key) {
  const map = {
    research_company: 'research', research_contact: 'research',
    craft_outreach: 'document_prep', identify_pain_points: 'research',
    send_email: 'email_send', send_linkedin: 'social_touch',
    follow_up: 'email_send', make_call: 'call',
    discovery_call: 'meeting_schedule', qualify: 'task_complete',
    share_resources: 'email_send', schedule_demo: 'meeting_schedule',
    intro_to_ae: 'task_complete', convert: 'task_complete',
  };
  return map[key] || 'task_complete';
}

function prospectActionChannel(key) {
  const map = { send_email: 'email', follow_up: 'email', share_resources: 'email', send_linkedin: 'linkedin', make_call: 'phone', discovery_call: 'phone' };
  return map[key] || null;
}

function prospectActionPriority(stage, actionType, index) {
  const sp = { qualified: 'high', engaged: 'high', contacted: 'medium', researched: 'medium', target: 'low', nurture: 'low' };
  if (sp[stage] === 'high') return index === 0 ? 'critical' : 'high';
  if (actionType === 'meeting_schedule') return 'high';
  return sp[stage] || 'medium';
}

// ── GET /config ───────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    if (!req.user?.userId) return res.status(401).json({ error: { message: 'User not authenticated' } });
    const config = await ActionConfigService.getConfig(req.user.userId, req.orgId);
    res.json({ config });
  } catch (error) {
    console.error('Get action config error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch config' } });
  }
});

// ── PUT /config ───────────────────────────────────────────────
router.put('/config', async (req, res) => {
  try {
    const config = await ActionConfigService.updateConfig(req.user.userId, req.orgId, req.body);
    res.json({ config });
  } catch (error) {
    console.error('Update action config error:', error);
    res.status(500).json({ error: { message: 'Failed to update config' } });
  }
});

// ── GET /unified — merge deal actions + prospecting actions into one list ────
// IMPORTANT: This must be defined BEFORE /:id to avoid Express matching "unified" as an ID.
router.get('/unified', async (req, res) => {
  try {
    const {
      scope = 'mine', status, source, actionType, nextStep,
      dueBefore, dueAfter, dealId, accountId, ownerId, isInternal,
      contractId,
    } = req.query;

    let ownerFilterDeal = '';
    let ownerFilterProspect = '';
    const ownerParams = [];
    let pIdx = 1;

    ownerParams.push(req.orgId);
    pIdx = 2;

    if (scope === 'team' && req.subordinateIds?.length > 0) {
      const teamIds = [req.user.userId, ...req.subordinateIds];
      ownerFilterDeal = `AND a.user_id = ANY($${pIdx}::int[])`;
      ownerFilterProspect = `AND pa.user_id = ANY($${pIdx}::int[])`;
      ownerParams.push(teamIds);
      pIdx++;
    } else if (scope === 'org') {
      // no owner filter
    } else {
      ownerFilterDeal = `AND a.user_id = $${pIdx}`;
      ownerFilterProspect = `AND pa.user_id = $${pIdx}`;
      ownerParams.push(req.user.userId);
      pIdx++;
    }

    // Deal actions query
    let dealWhere = '';
    const dealParams = [...ownerParams];
    let dIdx = pIdx;

    if (status) { dealWhere += ` AND a.status = $${dIdx}`; dealParams.push(status); dIdx++; }
    if (dealId) { dealWhere += ` AND a.deal_id = $${dIdx}`; dealParams.push(parseInt(dealId)); dIdx++; }
    if (contractId) { dealWhere += ` AND a.contract_id = $${dIdx}`; dealParams.push(parseInt(contractId)); dIdx++; }
    if (actionType) { dealWhere += ` AND a.action_type = $${dIdx}`; dealParams.push(actionType); dIdx++; }
    if (nextStep) { dealWhere += ` AND a.next_step = $${dIdx}`; dealParams.push(nextStep); dIdx++; }
    if (isInternal === 'true') { dealWhere += ` AND a.is_internal = TRUE`; }
    if (dueBefore) { dealWhere += ` AND a.due_date <= $${dIdx}`; dealParams.push(dueBefore); dIdx++; }
    if (dueAfter) { dealWhere += ` AND a.due_date >= $${dIdx}`; dealParams.push(dueAfter); dIdx++; }

    const dealQuery = `
      SELECT
        'deal' AS action_source,
        a.id, a.title, a.description, a.action_type, a.priority,
        a.status, a.source, a.source_rule, a.source_id,
        a.next_step, a.is_internal,
        a.due_date, a.created_at, a.updated_at,
        a.completed_at, a.completed_by, a.auto_completed,
        a.completion_evidence, a.context, a.suggested_action, a.metadata,
        a.snoozed_until, a.snooze_reason, a.snooze_duration,
        a.deal_id, a.contact_id, a.user_id, a.health_param,
        a.contract_id, a.source_module,
        ct.title        AS contract_title,
        ct.contract_type AS contract_type,
        ct.status       AS contract_status,
        d.name AS deal_name, d.value AS deal_value, d.stage AS deal_stage,
        d.owner_id AS deal_owner_id,
        du.first_name || ' ' || du.last_name AS deal_owner_name,
        c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.email AS contact_email,
        c.phone AS contact_phone, c.linkedin_url AS contact_linkedin_url,
        acc.name AS account_name,
        ev.subject AS evidence_subject, LEFT(ev.body, 300) AS evidence_snippet,
        ev.direction AS evidence_direction, ev.sent_at AS evidence_sent_at,
        NULL::integer AS prospect_id, NULL AS prospect_first_name, NULL AS prospect_last_name,
        NULL AS prospect_email, NULL AS prospect_company_name, NULL AS prospect_stage,
        NULL AS prospect_phone, NULL AS prospect_linkedin_url, NULL AS channel
      FROM actions a
      LEFT JOIN deals d ON a.deal_id = d.id AND d.org_id = a.org_id
      LEFT JOIN users du ON d.owner_id = du.id
      LEFT JOIN contacts c ON a.contact_id = c.id AND c.org_id = a.org_id
      LEFT JOIN accounts acc ON d.account_id = acc.id AND acc.org_id = a.org_id
      LEFT JOIN emails ev ON a.source_id = ev.id::varchar AND ev.org_id = a.org_id
      LEFT JOIN contracts ct ON a.contract_id = ct.id AND ct.org_id = a.org_id
      WHERE a.org_id = $1 ${ownerFilterDeal} ${dealWhere}
    `;

    // Prospecting actions query
    let prospectWhere = '';
    const prospectParams = [...ownerParams];
    let ppIdx = pIdx;

    if (status) {
      const statusMap = { yet_to_start: 'pending' };
      const mappedStatus = statusMap[status] || status;
      prospectWhere += ` AND pa.status = $${ppIdx}`; prospectParams.push(mappedStatus); ppIdx++;
    }
    if (actionType) {
      // Map deal action types to prospecting equivalents
      const prospectTypeMap = {
        'meeting':       ['meeting_schedule'],
        'follow_up':     ['outreach', 'follow_up'],
        'email_send':    ['outreach'],
        'document_prep': ['document_prep'],
        'meeting_prep':  ['meeting_prep'],
      };
      if (actionType === 'internal') {
        // Prospecting actions don't have is_internal, skip them
        prospectWhere += ` AND FALSE`;
      } else if (prospectTypeMap[actionType]) {
        prospectWhere += ` AND pa.action_type = ANY($${ppIdx}::varchar[])`; prospectParams.push(prospectTypeMap[actionType]); ppIdx++;
      } else {
        prospectWhere += ` AND pa.action_type = $${ppIdx}`; prospectParams.push(actionType); ppIdx++;
      }
    }
    if (nextStep) {
      // nextStep maps to pa.channel in prospecting_actions
      prospectWhere += ` AND pa.channel = $${ppIdx}`; prospectParams.push(nextStep); ppIdx++;
    }
    if (dueBefore) { prospectWhere += ` AND pa.due_date <= $${ppIdx}`; prospectParams.push(dueBefore); ppIdx++; }
    if (dueAfter) { prospectWhere += ` AND pa.due_date >= $${ppIdx}`; prospectParams.push(dueAfter); ppIdx++; }

    const prospectQuery = `
      SELECT
        'prospecting' AS action_source,
        pa.id, pa.title, pa.description, pa.action_type, pa.priority,
        CASE pa.status WHEN 'pending' THEN 'yet_to_start' ELSE pa.status END AS status,
        pa.source, NULL AS source_rule, NULL AS source_id,
        pa.channel AS next_step, FALSE AS is_internal,
        pa.due_date, pa.created_at, pa.updated_at,
        pa.completed_at, pa.completed_by, FALSE AS auto_completed,
        NULL AS completion_evidence, pa.ai_context AS context, pa.suggested_action, pa.metadata,
        pa.snoozed_until, pa.snooze_reason, pa.snooze_duration,
        NULL::integer AS deal_id, NULL::integer AS contact_id, pa.user_id, NULL AS health_param,
        NULL AS deal_name, NULL::numeric AS deal_value, NULL AS deal_stage,
        NULL::integer AS deal_owner_id, NULL AS deal_owner_name,
        NULL AS contact_first_name, NULL AS contact_last_name, NULL AS contact_email,
        NULL AS contact_phone, NULL AS contact_linkedin_url,
        NULL AS account_name,
        NULL AS evidence_subject, NULL AS evidence_snippet,
        NULL AS evidence_direction, NULL::timestamp AS evidence_sent_at,
        pa.prospect_id, p.first_name AS prospect_first_name, p.last_name AS prospect_last_name,
        p.email AS prospect_email, p.company_name AS prospect_company_name, p.stage AS prospect_stage,
        p.phone AS prospect_phone, p.linkedin_url AS prospect_linkedin_url,
        pa.channel
      FROM prospecting_actions pa
      LEFT JOIN prospects p ON pa.prospect_id = p.id
      WHERE pa.org_id = $1 ${ownerFilterProspect} ${prospectWhere}
    `;

    const [dealResult, prospectResult] = await Promise.all([
      db.query(dealQuery, dealParams),
      // Skip prospecting query when deal-specific filters are active
      // (prospects don't have deal_id, account_id, owner_id, or is_internal)
      (dealId || accountId || ownerId || isInternal === 'true')
        ? Promise.resolve({ rows: [] })
        : db.query(prospectQuery, prospectParams),
    ]);

    const allActions = [
      ...dealResult.rows.map(r => mapUnifiedAction(r, 'deal')),
      ...prospectResult.rows.map(r => mapUnifiedAction(r, 'prospecting')),
    ];

    allActions.sort((a, b) => {
      const statusOrder = { yet_to_start: 1, in_progress: 2, snoozed: 3, completed: 4, skipped: 5 };
      const sA = statusOrder[a.status] || 4;
      const sB = statusOrder[b.status] || 4;
      if (sA !== sB) return sA - sB;
      const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
      const pA = priorityOrder[a.priority] || 3;
      const pB = priorityOrder[b.priority] || 3;
      if (pA !== pB) return pA - pB;
      if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });

    res.json({ actions: allActions });
  } catch (error) {
    console.error('Unified actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch unified actions' } });
  }
});

// ── GET /:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      BASE_QUERY + ' WHERE a.id = $1 AND a.org_id = $2 AND a.user_id = $3',
      [req.params.id, req.orgId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });
    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Get action error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch action' } });
  }
});

// ── POST / — create manual action ────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { dealId, contactId, contractId, prospectId, type, priority, title, description, context, dueDate, isInternal } = req.body;
    const manualModule = contractId ? 'contracts' : prospectId ? 'prospecting' : dealId ? 'deals' : 'general';
    const result = await db.query(
      `INSERT INTO actions
         (org_id, user_id, deal_id, contact_id, contract_id, prospect_id, type, action_type, priority,
          title, description, context, due_date, is_internal, status, source, source_module)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,'yet_to_start','manual',$14)
       RETURNING *`,
      [
        req.orgId,
        req.user.userId,
        dealId      || null,
        contactId   || null,
        contractId  || null,
        prospectId  || null,
        type        || 'follow_up',
        priority    || 'medium',
        title,
        description || null,
        context     || null,
        dueDate     || null,
        !!isInternal,
        manualModule,
      ]
    );
    res.status(201).json({ action: result.rows[0] });
  } catch (error) {
    console.error('Create action error:', error);
    res.status(500).json({ error: { message: 'Failed to create action' } });
  }
});

// ── PUT /:id — update action ──────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { priority, title, description, context, dueDate, completed } = req.body;
    const statusFromCompleted = completed === true ? 'completed' : undefined;

    const result = await db.query(
      `UPDATE actions
       SET priority    = COALESCE($1, priority),
           title       = COALESCE($2, title),
           description = COALESCE($3, description),
           context     = COALESCE($4, context),
           due_date    = COALESCE($5, due_date),
           completed   = COALESCE($6, completed),
           status      = COALESCE($7, status),
           completed_at= CASE WHEN $6 = true THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at  = CURRENT_TIMESTAMP
       WHERE id = $8 AND org_id = $9 AND user_id = $10
       RETURNING *`,
      [priority, title, description, context, dueDate, completed,
       statusFromCompleted, req.params.id, req.orgId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });
    res.json({ action: result.rows[0] });
  } catch (error) {
    console.error('Update action error:', error);
    res.status(500).json({ error: { message: 'Failed to update action' } });
  }
});

// ── PATCH /:id/status ─────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const VALID = ['yet_to_start', 'in_progress', 'completed'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: { message: `status must be one of: ${VALID.join(', ')}` } });
    }

    const isCompleting = status === 'completed';

    const result = await db.query(
      `UPDATE actions
       SET status       = $1,
           completed    = $2,
           completed_at = CASE WHEN $2 = true THEN CURRENT_TIMESTAMP ELSE completed_at END,
           completed_by = CASE WHEN $2 = true THEN $3 ELSE completed_by END,
           notes        = COALESCE($6, notes),
           updated_at   = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5 AND user_id = $3
       RETURNING *`,
      [status, isCompleting, req.user.userId, req.params.id, req.orgId, notes || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });

    const completedAction = result.rows[0];
    let nextAction = null;

    // STRAP auto-resolve check
    if (isCompleting && completedAction.strap_id) {
      StrapActionGenerator.checkAutoResolve(completedAction.strap_id, req.user.userId, req.orgId)
        .catch(err => console.error('STRAP auto-resolve check error:', err.message));
    }

    // ── Phase 2: Gated next-action generation ────────────────────────────────
    // When a gate play action is completed, check if it unlocks a follow-on play.
    if (isCompleting && completedAction.playbook_play_id) {
      try {
        const gateRes = await db.query(
          `SELECT * FROM playbook_plays
           WHERE id = $1 AND org_id = $2 AND is_gate = true AND unlocks_play_id IS NOT NULL`,
          [completedAction.playbook_play_id, req.orgId]
        );

        if (gateRes.rows.length > 0) {
          const unlockedRes = await db.query(
            `SELECT * FROM playbook_plays WHERE id = $1 AND org_id = $2`,
            [gateRes.rows[0].unlocks_play_id, req.orgId]
          );

          if (unlockedRes.rows.length > 0) {
            const unlockedPlay = unlockedRes.rows[0];
            const fireConditions = typeof unlockedPlay.fire_conditions === 'string'
              ? JSON.parse(unlockedPlay.fire_conditions)
              : (unlockedPlay.fire_conditions || []);

            // Evaluate conditions if any, using a lightweight context
            let conditionsMet = true;
            if (fireConditions.length > 0 && completedAction.deal_id) {
              const PlaybookService = require('../services/playbook.service');
              const dealRes = await db.query('SELECT * FROM deals WHERE id = $1', [completedAction.deal_id]);
              if (dealRes.rows.length > 0) {
                const deal = dealRes.rows[0];
                const [cR, eR, mR, fR] = await Promise.all([
                  db.query('SELECT * FROM contacts WHERE account_id = $1 AND org_id = $2', [deal.account_id, req.orgId]),
                  db.query('SELECT * FROM emails WHERE deal_id = $1 AND org_id = $2', [deal.id, req.orgId]),
                  db.query('SELECT * FROM meetings WHERE deal_id = $1 AND org_id = $2', [deal.id, req.orgId]),
                  db.query("SELECT * FROM storage_files WHERE deal_id = $1 AND org_id = $2 AND processing_status = 'completed'", [deal.id, req.orgId]),
                ]);
                const ActionsGenerator = require('../services/actionsGenerator');
                const context = await ActionsGenerator.buildContextPublic(
                  deal, cR.rows, eR.rows, mR.rows, fR.rows, req.user.userId, req.orgId
                );
                conditionsMet = PlaybookService.evaluateConditions(fireConditions, context);
              }
            }

            if (conditionsMet) {
              const dueDate = new Date();
              dueDate.setDate(dueDate.getDate() + (unlockedPlay.due_offset_days || 3));

              const insertRes = await db.query(
                `INSERT INTO actions (
                   org_id, user_id, type, title, description, action_type, priority,
                   due_date, deal_id, account_id, source, source_rule, next_step,
                   playbook_play_id, status, suggested_action, created_at
                 ) VALUES (
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   'playbook','playbook_gate_unlock',$11,$12,'yet_to_start',$13,NOW()
                 ) RETURNING *`,
                [
                  req.orgId, req.user.userId,
                  unlockedPlay.channel || 'follow_up',
                  unlockedPlay.title,
                  unlockedPlay.description || `Unlocked after completing: ${completedAction.title}`,
                  unlockedPlay.channel || 'follow_up',
                  unlockedPlay.priority || 'medium',
                  dueDate,
                  completedAction.deal_id   || null,
                  completedAction.account_id || null,
                  unlockedPlay.channel || 'email',
                  unlockedPlay.id,
                  unlockedPlay.suggested_action || null,
                ]
              );
              nextAction = insertRes.rows[0];

              // Create calendar entry for the next action
              try {
                const startTime = new Date(dueDate);
                startTime.setHours(9, 0, 0, 0);
                const endTime = new Date(startTime);
                endTime.setMinutes(endTime.getMinutes() + 30);
                await db.query(
                  `INSERT INTO meetings (
                     org_id, user_id, deal_id, title, description,
                     start_time, end_time, meeting_type, source, status, action_id, created_at
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,'task','action','scheduled',$8,NOW())`,
                  [
                    req.orgId, req.user.userId, completedAction.deal_id || null,
                    unlockedPlay.title,
                    `Next step unlocked from playbook gate: ${completedAction.title}`,
                    startTime, endTime,
                    nextAction.id,
                  ]
                );
              } catch (calErr) {
                console.error('Calendar entry for next action failed (non-blocking):', calErr.message);
              }
            }
          }
        }
      } catch (gateErr) {
        console.error('Gate unlock error (non-blocking):', gateErr.message);
      }
    }

    res.json({ action: completedAction, nextAction: nextAction || null });
  } catch (error) {
    console.error('Status update error:', error);
    res.status(500).json({ error: { message: 'Failed to update status' } });
  }
});

// ── PATCH /:id/snooze ─────────────────────────────────────────
// Body: { reason: string, duration: '1_week'|'2_weeks'|'1_month'|'stage_change'|'indefinite' }
// duration drives the computed snoozed_until timestamp.
// 'stage_change' and 'indefinite' set snoozed_until = NULL (no auto-expiry).
router.patch('/:id/snooze', async (req, res) => {
  try {
    const { reason, duration } = req.body;

    const VALID_DURATIONS = ['1_week', '2_weeks', '1_month', 'stage_change', 'indefinite'];
    if (!duration || !VALID_DURATIONS.includes(duration)) {
      return res.status(400).json({
        error: { message: `duration must be one of: ${VALID_DURATIONS.join(', ')}` }
      });
    }

    // Compute snoozed_until based on duration
    let snoozedUntil = null;
    if (duration === '1_week') {
      snoozedUntil = new Date(Date.now() + 7  * 24 * 60 * 60 * 1000);
    } else if (duration === '2_weeks') {
      snoozedUntil = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    } else if (duration === '1_month') {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      snoozedUntil = d;
    }
    // 'stage_change' and 'indefinite' → snoozed_until stays NULL

    const result = await db.query(
      `UPDATE actions
       SET status          = 'snoozed',
           snoozed_until   = $1,
           snooze_reason   = $2,
           snooze_duration = $3,
           updated_at      = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5 AND user_id = $6
       RETURNING *`,
      [snoozedUntil, reason || null, duration, req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });
    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Snooze action error:', error);
    res.status(500).json({ error: { message: 'Failed to snooze action' } });
  }
});

// ── PATCH /:id/unsnooze ───────────────────────────────────────
// Clears snooze fields and returns action to 'yet_to_start'.
router.patch('/:id/unsnooze', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE actions
       SET status          = 'yet_to_start',
           snoozed_until   = NULL,
           snooze_reason   = NULL,
           snooze_duration = NULL,
           updated_at      = CURRENT_TIMESTAMP
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND status = 'snoozed'
       RETURNING *`,
      [req.params.id, req.orgId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found or not snoozed' } });
    res.json({ action: mapActionRow(result.rows[0]) });
  } catch (error) {
    console.error('Unsnooze action error:', error);
    res.status(500).json({ error: { message: 'Failed to unsnooze action' } });
  }
});

// ── PATCH /:id/complete — legacy endpoint (backward compat) ──
router.patch('/:id/complete', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE actions
       SET completed    = true,
           status       = 'completed',
           completed_at = CURRENT_TIMESTAMP,
           completed_by = $1,
           updated_at   = CURRENT_TIMESTAMP
       WHERE id = $2 AND org_id = $3 AND user_id = $1
       RETURNING *`,
      [req.user.userId, req.params.id, req.orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });
    res.json({ action: result.rows[0] });
  } catch (error) {
    console.error('Complete action error:', error);
    res.status(500).json({ error: { message: 'Failed to complete action' } });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM actions WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id',
      [req.params.id, req.orgId, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });
    res.json({ message: 'Action deleted successfully' });
  } catch (error) {
    console.error('Delete action error:', error);
    res.status(500).json({ error: { message: 'Failed to delete action' } });
  }
});

// ── GET /:id/suggestions ──────────────────────────────────────
router.get('/:id/suggestions', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM action_suggestions
       WHERE action_id = $1 AND org_id = $2 AND user_id = $3 AND status = 'pending'
       ORDER BY confidence DESC`,
      [req.params.id, req.orgId, req.user.userId]
    );
    res.json({ suggestions: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch suggestions' } });
  }
});

// ── POST /suggestions/:id/accept ─────────────────────────────
// NOTE: ActionCompletionDetector.acceptSuggestion() currently
// only takes (suggestionId, userId). Once the service is updated
// add orgId: ActionCompletionDetector.acceptSuggestion(id, userId, orgId)
router.post('/suggestions/:id/accept', async (req, res) => {
  try {
    await ActionCompletionDetector.acceptSuggestion(req.params.id, req.user.userId);
    res.json({ success: true, message: 'Suggestion accepted and action completed' });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to accept suggestion' } });
  }
});

// ── POST /suggestions/:id/dismiss ────────────────────────────
router.post('/suggestions/:id/dismiss', async (req, res) => {
  try {
    await ActionCompletionDetector.dismissSuggestion(req.params.id, req.user.userId);
    res.json({ success: true, message: 'Suggestion dismissed' });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to dismiss suggestion' } });
  }
});

// Unified row mapper — works for both deal and prospecting action rows
function mapUnifiedAction(row, source) {
  return {
    id:                      row.id,
    actionSource:            source || row.action_source,
    type:                    row.action_type,
    actionType:              row.action_type,
    priority:                row.priority,
    title:                   row.title,
    description:             row.description,
    context:                 row.context,
    suggestedAction:         row.suggested_action,
    sourceRule:              row.source_rule,
    healthParam:             row.health_param,
    source:                  row.source,
    sourceId:                row.source_id,
    nextStep:                row.next_step || row.channel || 'email',
    isInternal:              row.is_internal || false,
    status:                  row.status || 'yet_to_start',
    completed:               row.status === 'completed',
    completedAt:             row.completed_at,
    completedBy:             row.completed_by,
    autoCompleted:           row.auto_completed,
    completionEvidence:      row.completion_evidence,
    metadata:                row.metadata,
    dueDate:                 row.due_date,
    snoozedUntil:            row.snoozed_until,
    snoozeReason:            row.snooze_reason,
    snoozeDuration:          row.snooze_duration,
    createdAt:               row.created_at,
    updatedAt:               row.updated_at,
    sourceModule:            deriveModule(row),
    deal: row.deal_id ? {
      id:        row.deal_id,
      name:      row.deal_name,
      value:     parseFloat(row.deal_value) || 0,
      stage:     row.deal_stage,
      account:   row.account_name,
      ownerId:   row.deal_owner_id,
      ownerName: row.deal_owner_name,
    } : null,
    contact: row.contact_id ? {
      id:        row.contact_id,
      firstName: row.contact_first_name,
      lastName:  row.contact_last_name,
      email:     row.contact_email,
      phone:     row.contact_phone,
      linkedinUrl: row.contact_linkedin_url,
    } : null,
    prospect: row.prospect_id ? {
      id:          row.prospect_id,
      firstName:   row.prospect_first_name,
      lastName:    row.prospect_last_name,
      email:       row.prospect_email,
      companyName: row.prospect_company_name,
      stage:       row.prospect_stage,
      phone:       row.prospect_phone,
      linkedinUrl: row.prospect_linkedin_url,
    } : null,
    evidenceEmail: row.evidence_subject ? {
      subject:   row.evidence_subject,
      snippet:   row.evidence_snippet,
      direction: row.evidence_direction,
      sentAt:    row.evidence_sent_at,
    } : null,
    contract: row.contract_id ? {
      id:           row.contract_id,
      title:        row.contract_title,
      contractType: row.contract_type,
      status:       row.contract_status,
    } : null,
  };
}

module.exports = router;
