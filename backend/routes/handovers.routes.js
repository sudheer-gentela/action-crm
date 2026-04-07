// ─────────────────────────────────────────────────────────────────────────────
// routes/handovers.routes.js
//
// deploy-trigger: v2
// All routes are under /handovers/sales
//
// GET    /handovers/sales                          list (scope: mine|assigned|all)
// POST   /handovers/sales                          create (manual — normally auto-created on closed_won)
// GET    /handovers/sales/:id                      full detail
// PUT    /handovers/sales/:id                      update core fields (draft only)
// PATCH  /handovers/sales/:id/status               advance status
// GET    /handovers/sales/:id/can-submit           gate check
//
// POST   /handovers/sales/:id/stakeholders         add stakeholder
// DELETE /handovers/sales/:id/stakeholders/:sid    remove stakeholder
//
// POST   /handovers/sales/:id/commitments          add commitment
// DELETE /handovers/sales/:id/commitments/:cid     remove commitment
//
// POST   /handovers/sales/:id/plays/:instanceId/complete   complete a play
// ─────────────────────────────────────────────────────────────────────────────

const express         = require('express');
const router          = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const handoverService   = require('../services/handover.service');

router.use(authenticateToken);
router.use(orgContext);

// ── GET /sales ────────────────────────────────────────────────────────────────

router.get('/sales', async (req, res) => {
  try {
    const { scope = 'mine', status } = req.query;

    if (!['mine', 'assigned', 'all'].includes(scope)) {
      return res.status(400).json({ error: { message: 'scope must be mine|assigned|all' } });
    }

    const handovers = await handoverService.list(req.orgId, req.user.userId, { scope, status });
    res.json({ handovers });
  } catch (err) {
    console.error('List handovers error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales — manual creation (edge case; normally auto-triggered) ────────

router.post('/sales', async (req, res) => {
  try {
    const { dealId } = req.body;
    if (!dealId) {
      return res.status(400).json({ error: { message: 'dealId is required' } });
    }

    const result = await handoverService.initiate(parseInt(dealId), req.orgId, req.user.userId);
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    console.error('Create handover error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /sales/:id ────────────────────────────────────────────────────────────

router.get('/sales/:id', async (req, res) => {
  try {
    const handover = await handoverService.getById(parseInt(req.params.id), req.orgId);
    res.json({ handover });
  } catch (err) {
    console.error('Get handover error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PUT /sales/:id ────────────────────────────────────────────────────────────

router.put('/sales/:id', async (req, res) => {
  try {
    const handover = await handoverService.update(parseInt(req.params.id), req.orgId, req.body);
    res.json({ handover });
  } catch (err) {
    console.error('Update handover error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PATCH /sales/:id/status ───────────────────────────────────────────────────

router.patch('/sales/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: { message: 'status is required' } });
    }

    const handover = await handoverService.advanceStatus(
      parseInt(req.params.id),
      req.orgId,
      req.user.userId,
      status
    );
    res.json({ handover });
  } catch (err) {
    console.error('Advance handover status error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /sales/:id/can-submit ─────────────────────────────────────────────────

router.get('/sales/:id/can-submit', async (req, res) => {
  try {
    const result = await handoverService.canSubmit(parseInt(req.params.id), req.orgId);
    res.json(result);
  } catch (err) {
    console.error('Can-submit check error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales/:id/stakeholders ──────────────────────────────────────────────

router.post('/sales/:id/stakeholders', async (req, res) => {
  try {
    const stakeholder = await handoverService.addStakeholder(
      parseInt(req.params.id),
      req.orgId,
      req.body
    );
    res.status(201).json({ stakeholder });
  } catch (err) {
    console.error('Add stakeholder error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── DELETE /sales/:id/stakeholders/:sid ───────────────────────────────────────

router.delete('/sales/:id/stakeholders/:sid', async (req, res) => {
  try {
    const result = await handoverService.removeStakeholder(
      parseInt(req.params.id),
      req.orgId,
      parseInt(req.params.sid)
    );
    res.json(result);
  } catch (err) {
    console.error('Remove stakeholder error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales/:id/commitments ───────────────────────────────────────────────

router.post('/sales/:id/commitments', async (req, res) => {
  try {
    const commitment = await handoverService.addCommitment(
      parseInt(req.params.id),
      req.orgId,
      req.user.userId,
      req.body
    );
    res.status(201).json({ commitment });
  } catch (err) {
    console.error('Add commitment error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── DELETE /sales/:id/commitments/:cid ───────────────────────────────────────

router.delete('/sales/:id/commitments/:cid', async (req, res) => {
  try {
    const result = await handoverService.removeCommitment(
      parseInt(req.params.id),
      req.orgId,
      parseInt(req.params.cid)
    );
    res.json(result);
  } catch (err) {
    console.error('Remove commitment error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales/:id/plays/:instanceId/complete ────────────────────────────────

router.post('/sales/:id/plays/:instanceId/complete', async (req, res) => {
  try {
    const result = await handoverService.completePlay(
      parseInt(req.params.id),
      parseInt(req.params.instanceId),
      req.user.userId,
      req.orgId
    );
    res.json(result);
  } catch (err) {
    console.error('Complete handover play error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PATCH /admin/module — enable/disable handovers module for org ─────────────

router.patch('/admin/module', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: { message: '`enabled` must be a boolean' } });
    }

    const { pool } = require('../config/database');
    // Read current allowed flag so we preserve it
    const cur = await pool.query(
      `SELECT (settings->'modules'->'handovers'->>'allowed')::boolean AS allowed
       FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const allowed = cur.rows[0]?.allowed ?? true;
    await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(
         COALESCE(settings, '{}'),
         '{modules,handovers}',
         $1::jsonb
       )
       WHERE id = $2`,
      [JSON.stringify({ allowed, enabled }), req.orgId]
    );

    res.json({ module: 'handovers', enabled, allowed });
  } catch (err) {
    console.error('Handovers module toggle error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

module.exports = router;
