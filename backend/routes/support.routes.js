// support.routes.js
// All Service / Customer Support endpoints.
// Middleware chain: authenticateToken → orgContext → requireModule('service')
// Module toggle route sits BEFORE the gate (same pattern as contracts.routes.js).
//
// Mount: app.use('/api/support', require('./routes/support.routes'));

const express      = require('express');
const router       = express.Router();
const db           = require('../config/database');
const auth         = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');
const SS           = require('../services/supportService');

router.use(auth);
router.use(orgContext);

const gate     = requireModule('service');
const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────────────────────
// Module admin — NO gate (must work when module is disabled)
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /admin/module — enable / disable
router.patch('/admin/module', adminOnly, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: { message: 'enabled must be boolean' } });
    }

    // Read current allowed flag so we preserve it
    const cur = await db.query(
      `SELECT (settings->'modules'->'service'->>'allowed')::boolean AS allowed
       FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const allowed = cur.rows[0]?.allowed ?? true;
    await db.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings,'{}'), '{modules,service}', $2::jsonb, true)
       WHERE id = $1`,
      [req.orgId, JSON.stringify({ allowed, enabled })]
    );

    requireModule.invalidate(req.orgId, 'service');

    // Seed default SLA tiers on first enable
    if (enabled) {
      await SS.enableModule(req.orgId);
    }

    res.json({ enabled });
  } catch (err) {
    console.error('PATCH /support/admin/module error:', err);
    res.status(500).json({ error: { message: 'Failed to update module' } });
  }
});

// All routes below require module enabled
router.use(gate);

// ─────────────────────────────────────────────────────────────────────────────
// SLA Tiers
// ─────────────────────────────────────────────────────────────────────────────

// GET /sla-tiers
router.get('/sla-tiers', async (req, res) => {
  try {
    const tiers = await SS.listSlaTiers(req.orgId);
    res.json({ tiers });
  } catch (err) {
    console.error('GET /support/sla-tiers error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch SLA tiers' } });
  }
});

// POST /sla-tiers — admin only
router.post('/sla-tiers', adminOnly, async (req, res) => {
  try {
    const tier = await SS.createSlaTier(req.orgId, {
      name:                  req.body.name,
      description:           req.body.description,
      responseTargetHours:   req.body.responseTargetHours,
      resolutionTargetHours: req.body.resolutionTargetHours,
    });
    res.status(201).json({ tier });
  } catch (err) {
    console.error('POST /support/sla-tiers error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// PATCH /sla-tiers/:id — admin only
router.patch('/sla-tiers/:id', adminOnly, async (req, res) => {
  try {
    const tier = await SS.updateSlaTier(req.orgId, parseInt(req.params.id), req.body);
    res.json({ tier });
  } catch (err) {
    console.error('PATCH /support/sla-tiers/:id error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Teams — used by assignment pickers in the frontend
// ─────────────────────────────────────────────────────────────────────────────

// GET /teams — list all active teams for this org
router.get('/teams', async (req, res) => {
  try {
    const teams = await SS.getSupportTeams(req.orgId);
    res.json({ teams });
  } catch (err) {
    console.error('GET /support/teams error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch teams' } });
  }
});

// GET /teams/:teamId/members — members of a specific team (for individual assignment picker)
router.get('/teams/:teamId/members', async (req, res) => {
  try {
    const members = await SS.getTeamMembers(req.orgId, parseInt(req.params.teamId));
    res.json({ members });
  } catch (err) {
    console.error('GET /support/teams/:teamId/members error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch team members' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

// GET /dashboard — stats, open by account, breach list, by owner
// ?scope=mine|team|all
router.get('/dashboard', async (req, res) => {
  try {
    const scope = req.query.scope || 'mine';
    const data  = await SS.getDashboard(
      req.orgId,
      req.userId,
      req.subordinateIds || [],
      scope
    );
    res.json(data);
  } catch (err) {
    console.error('GET /support/dashboard error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch dashboard' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────────────────────

// GET /cases
// Query params: status, accountId, assignedTo, teamId, priority,
//               breach (response|resolution|any), scope (mine|team|all),
//               search, limit, offset
router.get('/cases', async (req, res) => {
  try {
    const {
      status, accountId, assignedTo, teamId, priority,
      breach, scope = 'mine', search,
      limit = 50, offset = 0,
    } = req.query;

    const cases = await SS.listCases(
      req.orgId,
      req.userId,
      req.subordinateIds || [],
      {
        status,
        accountId:  accountId  ? parseInt(accountId)  : undefined,
        assignedTo: assignedTo ? parseInt(assignedTo) : undefined,
        teamId:     teamId     ? parseInt(teamId)     : undefined,
        priority,
        breach,
        scope,
        search,
        limit:  parseInt(limit),
        offset: parseInt(offset),
      }
    );
    res.json({ cases });
  } catch (err) {
    console.error('GET /support/cases error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch cases' } });
  }
});

// POST /cases — create
router.post('/cases', async (req, res) => {
  try {
    const {
      subject, description, priority,
      accountId, contactId, dealId,
      slaTierId, assignedTeamId, assignedTo,
      tags, source, playbookId,
    } = req.body;

    const newCase = await SS.createCase(req.orgId, req.userId, {
      subject, description, priority,
      accountId:     accountId     ? parseInt(accountId)     : undefined,
      contactId:     contactId     ? parseInt(contactId)     : undefined,
      dealId:        dealId        ? parseInt(dealId)        : undefined,
      slaTierId:     slaTierId     ? parseInt(slaTierId)     : undefined,
      assignedTeamId: assignedTeamId ? parseInt(assignedTeamId) : undefined,
      assignedTo:    assignedTo    ? parseInt(assignedTo)    : undefined,
      tags, source, playbookId,
    });

    res.status(201).json({ case: newCase });
  } catch (err) {
    console.error('POST /support/cases error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// GET /cases/:id — detail with notes + history + plays
router.get('/cases/:id', async (req, res) => {
  try {
    const c = await SS.getCase(req.orgId, parseInt(req.params.id));
    res.json({ case: c });
  } catch (err) {
    console.error('GET /support/cases/:id error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// PATCH /cases/:id — update (status, assignment, fields)
router.patch('/cases/:id', async (req, res) => {
  try {
    const {
      status, subject, description, priority,
      accountId, contactId, dealId,
      slaTierId, assignedTeamId, assignedTo,
      tags, note,
    } = req.body;

    const updated = await SS.updateCase(
      req.orgId,
      parseInt(req.params.id),
      req.userId,
      {
        status, subject, description, priority,
        accountId:     accountId     !== undefined ? (accountId     ? parseInt(accountId)     : null) : undefined,
        contactId:     contactId     !== undefined ? (contactId     ? parseInt(contactId)     : null) : undefined,
        dealId:        dealId        !== undefined ? (dealId        ? parseInt(dealId)        : null) : undefined,
        slaTierId:     slaTierId     !== undefined ? (slaTierId     ? parseInt(slaTierId)     : null) : undefined,
        assignedTeamId: assignedTeamId !== undefined ? (assignedTeamId ? parseInt(assignedTeamId) : null) : undefined,
        assignedTo:    assignedTo    !== undefined ? (assignedTo    ? parseInt(assignedTo)    : null) : undefined,
        tags, note,
      }
    );

    res.json({ case: updated });
  } catch (err) {
    console.error('PATCH /support/cases/:id error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// POST /cases/:id/notes — add note / comment
router.post('/cases/:id/notes', async (req, res) => {
  try {
    const { body, isInternal = false } = req.body;
    const note = await SS.addNote(
      req.orgId,
      parseInt(req.params.id),
      req.userId,
      { body, isInternal }
    );
    res.status(201).json({ note });
  } catch (err) {
    console.error('POST /support/cases/:id/notes error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// PATCH /cases/:id/plays/:playId — update play status (complete / skip)
router.patch('/cases/:id/plays/:playId', async (req, res) => {
  try {
    const { status } = req.body;
    const play = await SS.updateCasePlay(
      req.orgId,
      parseInt(req.params.id),
      parseInt(req.params.playId),
      req.userId,
      { status }
    );
    res.json({ play });
  } catch (err) {
    console.error('PATCH /support/cases/:id/plays/:playId error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

module.exports = router;
