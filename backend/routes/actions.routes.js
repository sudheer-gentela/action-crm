const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ActionsGenerator = require('../services/actionsGenerator');
const ActionConfigService = require('../services/actionConfig.service');
const ActionCompletionDetector = require('../services/actionCompletionDetector.service');

// ── Auth + org context on every route in this file ───────────
// authenticateToken  → validates JWT, sets req.userId + req.user
// orgContext         → resolves org_id from JWT/DB, sets req.orgId
router.use(authenticateToken);
router.use(orgContext);

// ── Shared row mapper (unchanged) ────────────────────────────
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
    createdAt:               row.created_at,
    updatedAt:               row.updated_at,
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
    ev.sent_at      AS evidence_sent_at
  FROM actions a
  LEFT JOIN deals d      ON a.deal_id    = d.id    AND d.org_id   = a.org_id
  LEFT JOIN users u      ON d.owner_id   = u.id
  LEFT JOIN contacts c   ON a.contact_id = c.id    AND c.org_id   = a.org_id
  LEFT JOIN accounts acc ON d.account_id = acc.id  AND acc.org_id = a.org_id
  LEFT JOIN emails ev    ON a.source_id  = ev.id::varchar AND ev.org_id = a.org_id
`;

const ORDER_CLAUSE = `
  ORDER BY
    CASE a.status WHEN 'yet_to_start' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
    CASE a.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
    a.due_date ASC NULLS LAST
`;

// ── GET /  — list actions with full filter support ────────────
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
    } = req.query;

    // org_id is the primary isolation filter — always first
    // user_id scopes to this rep's own actions within the org
    let query = BASE_QUERY + ' WHERE a.org_id = $1 AND a.user_id = $2';
    const params = [req.orgId, req.user.userId];

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

// ── GET /filter-options ───────────────────────────────────────
router.get('/filter-options', async (req, res) => {
  try {
    const [dealsRes, accountsRes, ownersRes] = await Promise.all([
      db.query(
        `SELECT DISTINCT d.id, d.name FROM deals d
         INNER JOIN actions a ON a.deal_id = d.id
         WHERE a.org_id = $1 AND a.user_id = $2
         ORDER BY d.name`,
        [req.orgId, req.user.userId]
      ),
      db.query(
        `SELECT DISTINCT acc.id, acc.name FROM accounts acc
         INNER JOIN deals d   ON d.account_id = acc.id
         INNER JOIN actions a ON a.deal_id    = d.id
         WHERE a.org_id = $1 AND a.user_id = $2
         ORDER BY acc.name`,
        [req.orgId, req.user.userId]
      ),
      db.query(
        `SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name AS name
         FROM users u
         INNER JOIN deals d   ON d.owner_id = u.id
         INNER JOIN actions a ON a.deal_id  = d.id
         WHERE a.org_id = $1 AND a.user_id = $2
         ORDER BY name`,
        [req.orgId, req.user.userId]
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
// NOTE: ActionsGenerator.generateAll() currently has no org
// awareness. Once actionsGenerator.js is updated (next service
// file to migrate), change this call to:
//   ActionsGenerator.generateAll({ orgId: req.orgId, userId: req.user.userId })
router.post('/generate', async (req, res) => {
  try {
    console.log('🤖 Manual action generation triggered — user:', req.user.userId, 'org:', req.orgId);
    const result = await ActionsGenerator.generateAll();
    if (result.success) {
      res.json({
        success:   true,
        message:   `Generated ${result.inserted} actions`,
        generated: result.generated,
        inserted:  result.inserted,
      });
    } else {
      res.status(500).json({ success: false, message: 'Failed to generate actions', error: result.error });
    }
  } catch (error) {
    console.error('Error in /generate endpoint:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

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
    const { dealId, contactId, type, priority, title, description, context, dueDate, isInternal } = req.body;
    const result = await db.query(
      `INSERT INTO actions
         (org_id, user_id, deal_id, contact_id, type, action_type, priority,
          title, description, context, due_date, is_internal, status, source)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,'yet_to_start','manual')
       RETURNING *`,
      [
        req.orgId,
        req.user.userId,
        dealId    || null,
        contactId || null,
        type      || 'follow_up',
        priority  || 'medium',
        title,
        description || null,
        context     || null,
        dueDate     || null,
        !!isInternal,
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
    const { status } = req.body;
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
           updated_at   = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5 AND user_id = $3
       RETURNING *`,
      [status, isCompleting, req.user.userId, req.params.id, req.orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Action not found' } });
    res.json({ action: result.rows[0] });
  } catch (error) {
    console.error('Status update error:', error);
    res.status(500).json({ error: { message: 'Failed to update status' } });
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
    res.json({ success: true, message: 'Failed to dismiss suggestion' });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to dismiss suggestion' } });
  }
});

module.exports = router;
