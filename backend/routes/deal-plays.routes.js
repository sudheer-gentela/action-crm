// ─────────────────────────────────────────────────────────────────────────────
// deal-plays.routes.js
//
// Deal-level play instance management (execution layer).
// Mount: app.use('/api/deal-plays', require('./routes/deal-plays.routes'));
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext }       = require('../middleware/orgContext.middleware');
const PlaybookPlayService  = require('../services/PlaybookPlayService');

router.use(authenticateToken, orgContext);

// ── Helper: verify deal belongs to org ───────────────────────────────────────
async function resolveDeal(req, res) {
  const result = await db.query(
    `SELECT id, user_id, org_id FROM deals WHERE id = $1 AND org_id = $2`,
    [req.params.dealId, req.orgId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: { message: 'Deal not found' } });
    return null;
  }
  return result.rows[0];
}

// ── Helper: check if caller can manage plays ─────────────────────────────────
async function canManage(req, deal) {
  if (deal.user_id === req.user.userId) return true;
  const r = await db.query(
    `SELECT role FROM users WHERE id = $1 AND org_id = $2`, [req.user.userId, req.orgId]
  );
  const role = r.rows[0]?.role;
  return role === 'admin' || role === 'owner';
}

// ── GET /:dealId ────────────────────────────────────────────────────────────
// List play instances for a deal (optional ?stageKey= and ?userId= filters)

router.get('/:dealId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const instances = await PlaybookPlayService.getPlayInstances(
      deal.id, req.orgId,
      { stageKey: req.query.stageKey, userId: req.query.userId ? parseInt(req.query.userId) : null }
    );

    res.json({ instances });
  } catch (err) {
    console.error('Get deal plays error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch plays' } });
  }
});

// ── POST /:dealId/activate ──────────────────────────────────────────────────
// Activate plays for a stage (usually called on stage change)
// Body: { stageKey }

router.post('/:dealId/activate', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const { stageKey } = req.body;
    if (!stageKey) {
      return res.status(400).json({ error: { message: 'stageKey is required' } });
    }

    const result = await PlaybookPlayService.activateStage(
      deal.id, stageKey, req.orgId, req.user.userId
    );

    res.json(result);
  } catch (err) {
    console.error('Activate plays error:', err);
    res.status(500).json({ error: { message: 'Failed to activate plays' } });
  }
});

// ── PATCH /:dealId/instances/:instanceId ────────────────────────────────────
// Update instance (status, due_date, priority, etc.)
// Handles complete, skip, and field updates

router.patch('/:dealId/instances/:instanceId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const { status, dueDate, priority, title, description } = req.body;

    // Handle complete/skip via service (triggers dependency resolution)
    if (status === 'completed') {
      const result = await PlaybookPlayService.completePlay(
        parseInt(req.params.instanceId), req.user.userId, req.orgId
      );
      return res.json(result);
    }

    if (status === 'skipped') {
      if (!(await canManage(req, deal))) {
        return res.status(403).json({ error: { message: 'Only deal owner or admin can skip plays' } });
      }
      const result = await PlaybookPlayService.skipPlay(
        parseInt(req.params.instanceId), req.user.userId, req.orgId
      );
      return res.json(result);
    }

    // General field updates
    const sets = [];
    const params = [];
    let idx = 1;

    if (dueDate !== undefined)    { sets.push(`due_date = $${idx}`);    params.push(dueDate);    idx++; }
    if (priority !== undefined)   { sets.push(`priority = $${idx}`);    params.push(priority);   idx++; }
    if (title !== undefined)      { sets.push(`title = $${idx}`);       params.push(title);      idx++; }
    if (description !== undefined){ sets.push(`description = $${idx}`); params.push(description);idx++; }
    if (status !== undefined)     { sets.push(`status = $${idx}`);      params.push(status);     idx++; }

    if (sets.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    sets.push('updated_at = NOW()');
    params.push(parseInt(req.params.instanceId), req.orgId);

    const result = await db.query(
      `UPDATE deal_play_instances SET ${sets.join(', ')}
       WHERE id = $${idx} AND org_id = $${idx + 1}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Play instance not found' } });
    }

    res.json({ instance: result.rows[0] });
  } catch (err) {
    console.error('Update play instance error:', err);
    res.status(500).json({ error: { message: err.message || 'Failed to update play' } });
  }
});

// ── POST /:dealId/instances/:instanceId/assignees ───────────────────────────
// Add an assignee

router.post('/:dealId/instances/:instanceId/assignees', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    if (!(await canManage(req, deal))) {
      return res.status(403).json({ error: { message: 'Only deal owner or admin can manage assignees' } });
    }

    const { userId, roleId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: { message: 'userId is required' } });
    }

    await PlaybookPlayService.reassignPlay(
      parseInt(req.params.instanceId),
      parseInt(userId),
      roleId ? parseInt(roleId) : null,
      req.user.userId,
      req.orgId
    );

    // Return updated assignees
    const assignees = await db.query(
      `SELECT dpa.*, u.first_name || ' ' || u.last_name AS name, dr.name AS role_name, dr.key AS role_key
       FROM deal_play_assignees dpa
       JOIN users u ON u.id = dpa.user_id
       LEFT JOIN deal_roles dr ON dr.id = dpa.role_id
       WHERE dpa.instance_id = $1`,
      [req.params.instanceId]
    );

    res.json({ assignees: assignees.rows });
  } catch (err) {
    console.error('Add assignee error:', err);
    res.status(500).json({ error: { message: err.message || 'Failed to add assignee' } });
  }
});

// ── DELETE /:dealId/instances/:instanceId/assignees/:userId ─────────────────
// Remove an assignee

router.delete('/:dealId/instances/:instanceId/assignees/:userId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    if (!(await canManage(req, deal))) {
      return res.status(403).json({ error: { message: 'Only deal owner or admin can manage assignees' } });
    }

    const result = await db.query(
      `DELETE FROM deal_play_assignees
       WHERE instance_id = $1 AND user_id = $2
       RETURNING id`,
      [req.params.instanceId, req.params.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Assignee not found' } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Remove assignee error:', err);
    res.status(500).json({ error: { message: 'Failed to remove assignee' } });
  }
});

// ── POST /:dealId/manual ────────────────────────────────────────────────────
// Add a manual play (not from playbook template)

router.post('/:dealId/manual', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const instance = await PlaybookPlayService.addManualPlay(
      deal.id, req.orgId, req.user.userId, req.body
    );

    res.status(201).json({ instance });
  } catch (err) {
    console.error('Add manual play error:', err);
    res.status(500).json({ error: { message: err.message || 'Failed to add play' } });
  }
});

// ── GET /:dealId/gate-check ─────────────────────────────────────────────────
// Check if all gates are cleared for stage advancement
// Query: ?stageKey=demo

router.get('/:dealId/gate-check', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const { stageKey } = req.query;
    if (!stageKey) {
      return res.status(400).json({ error: { message: 'stageKey query param is required' } });
    }

    const result = await PlaybookPlayService.checkGates(deal.id, stageKey, req.orgId);

    res.json(result);
  } catch (err) {
    console.error('Gate check error:', err);
    res.status(500).json({ error: { message: 'Failed to check gates' } });
  }
});

module.exports = router;
