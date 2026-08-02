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

const projectSettings = require('../services/projectSettings.service');
router.use(authenticateToken);
router.use(orgContext);

// ── GET /assignable-users ─────────────────────────────────────────────────────
// Org-scoped member list for the commitment owner picker (non-super). Kept on
// the handovers router so it inherits auth + orgContext; can be promoted to a
// general /org-users endpoint later without changing the query.

router.get('/assignable-users', async (req, res) => {
  try {
    const users = await handoverService.listAssignableUsers(req.orgId);
    res.json({ users });
  } catch (err) {
    console.error('List assignable users error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /sales ────────────────────────────────────────────────────────────────

router.get('/sales', async (req, res) => {
  try {
    const { scope = 'mine', status, kind } = req.query;

    // 'all' predates the rollup scopes and is kept as an alias for 'org' so any
    // existing caller keeps working.
    const requested = scope === 'all' ? 'org' : scope;
    if (!['mine', 'assigned', 'team', 'org'].includes(requested)) {
      return res.status(400).json({ error: { message: 'scope must be mine|assigned|team|org' } });
    }

    const handovers = await handoverService.list(req.orgId, req.user.userId, {
      scope: requested,
      status,
      kind,
      // Populated by orgContext on every request; covers solid and dotted lines.
      subordinateIds: req.subordinateIds || [],
      userRole:       await projectSettings.resolveRole(req.orgId, req.user.userId),
    });
    res.json({ handovers });
  } catch (err) {
    console.error('List handovers error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /portfolio — Dashboard tab aggregation ────────────────────────────────

router.get('/portfolio', async (req, res) => {
  try {
    res.json(await handoverService.getPortfolio(req.orgId));
  } catch (err) {
    console.error('Handover portfolio error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales — manual creation (edge case; normally auto-triggered) ────────

// ── POST /projects — create without a won deal ───────────────────────────────
// Internal projects (no account, no deal) and the documented exception of a
// customer project with an account but no deal. Deal-driven creation stays on
// POST /sales, which is idempotent per deal.
router.post('/projects', async (req, res) => {
  try {
    const project = await handoverService.createProject(req.orgId, req.user.userId, req.body || {});
    res.status(201).json({ project });
  } catch (err) {
    console.error('Create project error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

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
    const handover = await handoverService.getById(parseInt(req.params.id), req.orgId, req.userId);
    res.json({ handover });
  } catch (err) {
    console.error('Get handover error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Restricted-tab viewers (e.g. commercial) ─────────────────────────────────
router.get('/sales/:id/tab-viewers', async (req, res) => {
  try { res.json(await handoverService.getTabViewers(parseInt(req.params.id), req.orgId, req.query.tab || 'commercial')); }
  catch (err) { res.status(err.status || 500).json({ error: { message: err.message } }); }
});
router.put('/sales/:id/tab-viewers', async (req, res) => {
  try { res.json(await handoverService.setTabViewers(parseInt(req.params.id), req.orgId, req.userId, req.body?.tabKey || 'commercial', req.body?.userIds || [])); }
  catch (err) { res.status(err.status || 500).json({ error: { message: err.message } }); }
});

// ── Project actions (next steps) ──────────────────────────────────────────────
router.get('/sales/:id/actions', async (req, res) => {
  try { res.json(await handoverService.listActions(parseInt(req.params.id), req.orgId)); }
  catch (err) { res.status(err.status || 500).json({ error: { message: err.message } }); }
});
router.post('/sales/:id/actions', async (req, res) => {
  try { res.status(201).json(await handoverService.createAction(parseInt(req.params.id), req.orgId, req.userId, req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: { message: err.message } }); }
});
router.post('/sales/:id/actions/:actionId/complete', async (req, res) => {
  try { res.json(await handoverService.completeAction(parseInt(req.params.id), req.orgId, parseInt(req.params.actionId))); }
  catch (err) { res.status(err.status || 500).json({ error: { message: err.message } }); }
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
    const { status, closureSummary } = req.body;
    if (!status) {
      return res.status(400).json({ error: { message: 'status is required' } });
    }

    const handover = await handoverService.advanceStatus(
      parseInt(req.params.id),
      req.orgId,
      req.user.userId,
      status,
      closureSummary ?? null
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

// ── GET /sales/:id/can-close ──────────────────────────────────────────────────
// Closure gate: returns is_closeable plus the deliverable rollup, so the UI can
// both disable the Complete button and explain exactly what is blocking it.

router.get('/sales/:id/can-close', async (req, res) => {
  try {
    const result = await handoverService.canClose(parseInt(req.params.id), req.orgId);
    res.json(result);
  } catch (err) {
    console.error('Can-close check error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /sales/:id/communications — unified email + WhatsApp timeline ──────────

router.get('/sales/:id/communications', async (req, res) => {
  try {
    res.json(await handoverService.getCommunications(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('Communications error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales/:id/stakeholders ──────────────────────────────────────────────

router.post('/sales/:id/stakeholders', async (req, res) => {
  try {
    const stakeholder = await handoverService.addStakeholder(
      parseInt(req.params.id),
      req.orgId,
      req.userId,
      req.body
    );
    res.status(201).json({ stakeholder });
  } catch (err) {
    console.error('Add stakeholder error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Contact-add policy (who may add project contacts) ─────────────────────────
router.get('/sales/:id/contact-policy', async (req, res) => {
  try {
    const policy = await handoverService.getContactPolicy(parseInt(req.params.id), req.orgId);
    res.json({ policy });
  } catch (err) {
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.put('/sales/:id/contact-policy', async (req, res) => {
  try {
    const out = await handoverService.setContactPolicy(
      parseInt(req.params.id), req.orgId, req.userId, req.body?.policy || req.body || {});
    res.json(out);
  } catch (err) {
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

// ── PATCH /sales/:id/commitments/:cid ─────────────────────────────────────────
// The route that was missing. Retarget a commitment (dueDate, ownerUserId,
// description) or drive it to closure (status + closureNote).

router.patch('/sales/:id/commitments/:cid', async (req, res) => {
  try {
    const commitment = await handoverService.updateCommitment(
      parseInt(req.params.id),
      req.orgId,
      req.user.userId,
      parseInt(req.params.cid),
      req.body
    );
    res.json({ commitment });
  } catch (err) {
    console.error('Update commitment error:', err);
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
      req.orgId,
      req.body || {}
    );
    res.json(result);
  } catch (err) {
    console.error('Complete handover play error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /sales/:id/plays  — add an ad-hoc checklist item ─────────────────────

// ── PUT /sales/:id/playbook — attach a playbook and activate its first stage ──
// Projects created from a won deal get one automatically; every other project
// had no route to one until now.
router.put('/sales/:id/playbook', async (req, res) => {
  try {
    const playbookId = parseInt(req.body?.playbookId, 10);
    if (!playbookId) {
      return res.status(400).json({ error: { message: 'playbookId is required' } });
    }
    res.json(await handoverService.setPlaybook(
      parseInt(req.params.id, 10), req.orgId, req.user.userId, playbookId, req.body?.stageKey || null));
  } catch (err) {
    console.error('Set project playbook error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// Playbooks this org can attach to a project.
router.get('/playbooks/available', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const { rows } = await pool.query(
      `SELECT id, name, type, is_default FROM playbooks
        WHERE org_id = $1 AND type IN ('handover_s2i', 'handover', 'custom')
        ORDER BY is_default DESC, name`, [req.orgId]);
    res.json({ playbooks: rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/sales/:id/plays', async (req, res) => {
  try {
    const result = await handoverService.addPlay(
      parseInt(req.params.id), req.orgId, req.user.userId, req.body || {}
    );
    res.json(result);
  } catch (err) {
    console.error('Add handover play error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PATCH /sales/:id/plays/:instanceId  — edit a checklist item ───────────────

router.patch('/sales/:id/plays/:instanceId', async (req, res) => {
  try {
    const result = await handoverService.updatePlay(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId), req.body || {}
    );
    res.json(result);
  } catch (err) {
    console.error('Update handover play error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── DELETE /sales/:id/plays/:instanceId  — remove an ad-hoc checklist item ─────

router.delete('/sales/:id/plays/:instanceId', async (req, res) => {
  try {
    const result = await handoverService.removePlay(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId)
    );
    res.json(result);
  } catch (err) {
    console.error('Remove handover play error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /team-members/:userId/projects — person drill-down ────────────────────

router.get('/team-members/:userId/projects', async (req, res) => {
  try {
    const projects = await handoverService.getTeamMemberProjects(parseInt(req.params.userId), req.orgId);
    res.json({ projects });
  } catch (err) {
    console.error('Team member projects error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /team-members/:userId/dashboard — person side-panel ───────────────────

router.get('/team-members/:userId/dashboard', async (req, res) => {
  try {
    res.json(await handoverService.getPersonDashboard(parseInt(req.params.userId), req.orgId));
  } catch (err) {
    console.error('Person dashboard error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /contacts/:contactId/communications — customer-contact comms drill-down

router.get('/contacts/:contactId/communications', async (req, res) => {
  try {
    res.json(await handoverService.getContactCommunications(parseInt(req.params.contactId), req.orgId));
  } catch (err) {
    console.error('Contact communications error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /commitments/:cid/activity — deliverable drill-down ───────────────────

router.get('/commitments/:cid/activity', async (req, res) => {
  try {
    res.json(await handoverService.getCommitmentActivity(parseInt(req.params.cid), req.orgId));
  } catch (err) {
    console.error('Commitment activity error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PATCH /admin/module — enable/disable handovers module for org ─────────────

// ── Project access configuration (org admin) ─────────────────────────────────
// Who can see which projects, and whether restricted tabs follow the reporting
// line. Read is open to any member so the UI can decide which scope buttons to
// render; write is org admin only.

router.get('/admin/project-access', async (req, res) => {
  try {
    const [cfg, role] = await Promise.all([
      projectSettings.get(req.orgId),
      projectSettings.resolveRole(req.orgId, req.user.userId),
    ]);
    res.json({
      settings: cfg,
      // Everything the client needs to render the scope switcher without a
      // second round trip.
      viewer: {
        role,
        hasTeam:    (req.subordinateIds || []).length > 0,
        canUseOrg:  projectSettings.canUseOrgScope(cfg, role),
        canUseTeam: cfg.team_scope_enabled && (req.subordinateIds || []).length > 0,
      },
    });
  } catch (err) {
    console.error('Get project access config error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.put('/admin/project-access', async (req, res) => {
  try {
    const role = await projectSettings.resolveRole(req.orgId, req.user.userId);
    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: { message: 'Only an org owner or admin can change project access' } });
    }
    const settings = await projectSettings.update(req.orgId, req.body || {});
    res.json({ settings });
  } catch (err) {
    console.error('Update project access config error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

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
