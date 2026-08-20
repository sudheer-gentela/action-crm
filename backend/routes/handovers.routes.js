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
const planVariance    = require('../services/planVariance.service');   // 2026_111
const boq             = require('../services/boq.service');            // 2026_113/114
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

// ── Internal-customer sign-off ───────────────────────────────────────────────
// Only a named acceptor can call these; the service enforces it. Not open to
// admins on purpose — the record must not claim someone accepted the work who
// did not.
router.post('/sales/:id/sign-off', async (req, res) => {
  try {
    res.json(await handoverService.signOff(
      parseInt(req.params.id), req.orgId, req.user.userId, req.body?.note));
  } catch (err) {
    console.error('Project sign-off error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.delete('/sales/:id/sign-off', async (req, res) => {
  try {
    res.json(await handoverService.revokeSignOff(parseInt(req.params.id), req.orgId, req.user.userId));
  } catch (err) {
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

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
      parseInt(req.params.id, 10), req.orgId, req.user.userId, playbookId,
      req.body?.stageKey || null, Boolean(req.body?.replace)));
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
      // Deliberately NOT filtered by type. playbooks.type defaults to 'custom'
      // and is set inconsistently — PlaybookBuilderService.listPlaybooks(), which
      // powers the Playbooks module itself, filters on org / department /
      // is_active and never on type. Filtering here on a guessed set returned
      // nothing for orgs whose playbooks carry other type values.
      //
      // Instead: every active playbook, with handover-oriented ones sorted first
      // and `type` returned so the picker can label what it is offering.
      `SELECT id, name, type, entity_type, is_default
         FROM playbooks
        WHERE org_id = $1 AND is_active = TRUE
        ORDER BY (type IN ('handover_s2i','handover')) DESC,
                 (entity_type = 'implementation') DESC,
                 is_default DESC,
                 name`, [req.orgId]);
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

// GET /sales/:id/start-preview — what Start/Submit would do to the dates
// Query: ?startDate=YYYY-MM-DD (defaults to today)
router.get('/sales/:id/start-preview', async (req, res) => {
  try {
    res.json(await handoverService.getStartPreview(
      parseInt(req.params.id, 10), req.orgId, req.query.startDate || null));
  } catch (err) {
    console.error('Start preview error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// GET /sales/:id/evidence-policy — effective policy (org default + override)
router.get('/sales/:id/evidence-policy', async (req, res) => {
  try {
    res.json(await handoverService.getEvidencePolicy(
      parseInt(req.params.id, 10), req.orgId));
  } catch (err) {
    console.error('Evidence policy error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Project stages (2026_115) ────────────────────────────────────────────────
//
// Declared BEFORE /plays/* only for readability — these do not collide.
// Stage ordering used to be implicit and alphabetical for any stage the
// project's playbook did not define; these endpoints make it explicit.

// GET /sales/:id/stages — playbook + project stages merged, in run order
router.get('/sales/:id/stages', async (req, res) => {
  try {
    res.json(await handoverService.listStages(parseInt(req.params.id, 10), req.orgId));
  } catch (err) {
    console.error('List project stages error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// POST /sales/:id/stages — add a stage to this project
// Body: { name: 'User acceptance', key?: 'uat', sortOrder?: 30 }
router.post('/sales/:id/stages', async (req, res) => {
  try {
    res.json(await handoverService.addStage(
      parseInt(req.params.id, 10), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Add project stage error:', err);
    res.status(err.status || 500).json({ error: { message: err.message, code: err.code } });
  }
});

// PATCH /sales/:id/stages — rename / reorder in one atomic call
// Body: { stages: [{ key, name?, sortOrder? }, ...] }
router.patch('/sales/:id/stages', async (req, res) => {
  try {
    res.json(await handoverService.updateStages(
      parseInt(req.params.id, 10), req.orgId, req.body?.stages || []));
  } catch (err) {
    console.error('Update project stages error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// DELETE /sales/:id/stages/:stageKey — soft delete; refuses if tasks remain
router.delete('/sales/:id/stages/:stageKey', async (req, res) => {
  try {
    res.json(await handoverService.removeStage(
      parseInt(req.params.id, 10), req.orgId, req.params.stageKey));
  } catch (err) {
    console.error('Remove project stage error:', err);
    res.status(err.status || 500).json({ error: { message: err.message, code: err.code } });
  }
});

// PUT /sales/:id/plays/:instanceId/dependencies — set task prerequisites
// Body: { dependsOn: [12, 15] }  (instance ids on this same project; [] clears)
router.put('/sales/:id/plays/:instanceId/dependencies', async (req, res) => {
  try {
    res.json(await handoverService.setPlayDependencies(
      parseInt(req.params.id, 10), req.orgId,
      parseInt(req.params.instanceId, 10), req.body?.dependsOn || []));
  } catch (err) {
    console.error('Set play dependencies error:', err);
    res.status(err.status || 500).json({
      error: { message: err.message, code: err.code, blockedBy: err.blockedBy } });
  }
});

// ── PATCH /sales/:id/plays/reorder  — reposition plays within one stage ───────
//
// Body: { stageKey: 'mobilise', orderedIds: [12, 9, 30] }
//
// Declared BEFORE /plays/:instanceId. Express matches in declaration order, so
// with the routes the other way round 'reorder' would be captured as an
// :instanceId and parseInt would hand the service NaN.

router.patch('/sales/:id/plays/reorder', async (req, res) => {
  try {
    const { stageKey, orderedIds } = req.body || {};
    const result = await handoverService.reorderPlays(
      parseInt(req.params.id), req.orgId, stageKey, orderedIds
    );
    res.json(result);
  } catch (err) {
    console.error('Reorder handover plays error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PATCH /sales/:id/plays/:instanceId  — edit a checklist item ───────────────

router.patch('/sales/:id/plays/:instanceId', async (req, res) => {
  try {
    const result = await handoverService.updatePlay(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId),
      req.body || {}, req.user.userId
    );
    res.json(result);
  } catch (err) {
    console.error('Update handover play error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Plan vs actual (2026_111) ────────────────────────────────────────────────

// GET /sales/:id/variance — per-play variance + summary
router.get('/sales/:id/variance', async (req, res) => {
  try {
    res.json(await planVariance.getProjectVariance(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('Project variance error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// GET /sales/:id/variance/stages — rolled up per stage
router.get('/sales/:id/variance/stages', async (req, res) => {
  try {
    res.json(await planVariance.getStageVariance(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('Stage variance error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// GET /sales/:id/plays/:instanceId/revisions — date history for one play
router.get('/sales/:id/plays/:instanceId/revisions', async (req, res) => {
  try {
    res.json(await handoverService.listPlayRevisions(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId)
    ));
  } catch (err) {
    console.error('Play revisions error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// GET /sales/:id/plays/:instanceId/evidence
router.get('/sales/:id/plays/:instanceId/evidence', async (req, res) => {
  try {
    res.json(await handoverService.listPlayEvidence(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId)
    ));
  } catch (err) {
    console.error('List play evidence error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// POST /sales/:id/plays/:instanceId/evidence — attach a WhatsApp message
router.post('/sales/:id/plays/:instanceId/evidence', async (req, res) => {
  try {
    res.json(await handoverService.addPlayEvidence(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId),
      req.user.userId, req.body || {}
    ));
  } catch (err) {
    console.error('Add play evidence error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// POST /sales/:id/evidence/:evidenceId/revoke — withdraw, never delete
router.post('/sales/:id/evidence/:evidenceId/revoke', async (req, res) => {
  try {
    res.json(await handoverService.revokePlayEvidence(
      parseInt(req.params.id), req.orgId, parseInt(req.params.evidenceId),
      req.user.userId, (req.body || {}).reason
    ));
  } catch (err) {
    console.error('Revoke play evidence error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// GET /sales/:id/can-rebaseline — lets the UI hide the control rather than
// offering it and then rejecting the save
router.get('/sales/:id/can-rebaseline', async (req, res) => {
  try {
    const allowed = await handoverService.canRebaseline(
      parseInt(req.params.id), req.orgId, req.user.userId
    );
    res.json({ canRebaseline: allowed });
  } catch (err) {
    console.error('canRebaseline error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BILL OF QUANTITIES  (2026_113 / 2026_114)
//
// Bill-scoped routes take :boqId rather than resolving it from the project, so
// they keep working once a project may hold several bills. Every handler passes
// req.orgId, and the service scopes every statement on it — a bill id from
// another org resolves to nothing rather than to someone else's data.
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /sales/:id/boq — the bill, its items, sections and totals ─────────────
router.get('/sales/:id/boq', async (req, res) => {
  try {
    const data = await boq.getBill(parseInt(req.params.id), req.orgId);
    // Null rather than 404: "this project has no bill yet" is a normal state
    // the UI renders as an empty state with a create button, not an error.
    res.json(data || { bill: null, items: [], sections: [], totals: null });
  } catch (err) {
    console.error('Get BoQ error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.post('/sales/:id/boq', async (req, res) => {
  try {
    res.json(await boq.createBill(
      parseInt(req.params.id), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Create BoQ error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.patch('/boq/:boqId', async (req, res) => {
  try {
    res.json(await boq.updateBill(parseInt(req.params.boqId), req.orgId, req.body || {}));
  } catch (err) {
    console.error('Update BoQ error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Items ────────────────────────────────────────────────────────────────────
router.post('/boq/:boqId/items', async (req, res) => {
  try {
    res.json(await boq.addItem(
      parseInt(req.params.boqId), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Add BoQ item error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.patch('/boq/items/:itemId', async (req, res) => {
  try {
    res.json(await boq.updateItem(parseInt(req.params.itemId), req.orgId, req.body || {}));
  } catch (err) {
    console.error('Update BoQ item error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.delete('/boq/items/:itemId', async (req, res) => {
  try {
    res.json(await boq.removeItem(parseInt(req.params.itemId), req.orgId));
  } catch (err) {
    console.error('Remove BoQ item error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Progress ─────────────────────────────────────────────────────────────────
// Declared before /boq/:boqId/progress/bulk would be shadowed — distinct paths
// here, but the ordering discipline is kept deliberately.
router.get('/boq/items/:itemId/progress', async (req, res) => {
  try {
    res.json(await boq.listProgress(parseInt(req.params.itemId), req.orgId));
  } catch (err) {
    console.error('List BoQ progress error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.post('/boq/items/:itemId/progress', async (req, res) => {
  try {
    res.json(await boq.recordProgress(
      parseInt(req.params.itemId), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Record BoQ progress error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// Bulk measurement sheet — one date across many lines, for orgs configured
// with boq_progress_entry_mode = 'bulk_sheet'.
router.post('/boq/:boqId/progress/bulk', async (req, res) => {
  try {
    res.json(await boq.recordProgressBulk(
      parseInt(req.params.boqId), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Bulk BoQ progress error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// No DELETE for a progress entry, by design. The ledger is append-only; a
// mistake is corrected by posting a reversal, which stays on the record.
router.post('/boq/progress/:entryId/reverse', async (req, res) => {
  try {
    res.json(await boq.reverseProgress(
      parseInt(req.params.entryId), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Reverse BoQ progress error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.get('/boq/:boqId/ledger', async (req, res) => {
  try {
    res.json(await boq.listBillLedger(parseInt(req.params.boqId), req.orgId, req.query));
  } catch (err) {
    console.error('BoQ ledger error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Procurement ──────────────────────────────────────────────────────────────
router.patch('/boq/:boqId/procurement', async (req, res) => {
  try {
    res.json(await boq.setProcurement(parseInt(req.params.boqId), req.orgId, req.body || {}));
  } catch (err) {
    console.error('Set BoQ procurement error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// Approved vendors only. accounts has no 'vendor' type — vendor-ness lives in
// account_relationships — so the picker must not simply list accounts.
router.get('/boq/vendors', async (req, res) => {
  try {
    res.json(await boq.listVendors(req.orgId));
  } catch (err) {
    console.error('List vendors error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Variations ───────────────────────────────────────────────────────────────
router.get('/boq/:boqId/variations', async (req, res) => {
  try {
    res.json(await boq.listVariations(parseInt(req.params.boqId), req.orgId));
  } catch (err) {
    console.error('List BoQ variations error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.post('/boq/:boqId/variations', async (req, res) => {
  try {
    res.json(await boq.addVariation(
      parseInt(req.params.boqId), req.orgId, req.user.userId, req.body || {}));
  } catch (err) {
    console.error('Add BoQ variation error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// Approving is what makes a variation count towards the sanctioned amount, so
// it is gated on project management rights rather than plain membership.
router.post('/sales/:id/boq/variations/:variationId/decision', async (req, res) => {
  try {
    const allowed = await handoverService.canRebaseline(
      parseInt(req.params.id), req.orgId, req.user.userId);
    if (!allowed) {
      return res.status(403).json({
        error: { message: 'You do not have rights to approve variations on this project.' } });
    }
    res.json(await boq.decideVariation(
      parseInt(req.params.variationId), req.orgId, req.user.userId,
      (req.body || {}).decision, (req.body || {}).reason));
  } catch (err) {
    console.error('Decide BoQ variation error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── Overview one-liner ───────────────────────────────────────────────────────
router.get('/sales/:id/boq/summary', async (req, res) => {
  try {
    res.json(await boq.summaryForProject(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('BoQ summary error:', err);
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
      // Resolved once here so every screen uses the same word for the person
      // accountable for a project.
      managerLabel: cfg.manager_label,
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
