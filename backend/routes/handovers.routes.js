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
//
// GET    /handovers/sales/:id/plays/:instanceId/notes      notes on a task
// POST   /handovers/sales/:id/plays/:instanceId/notes      add a note (any status)
// DELETE /handovers/sales/:id/notes/:noteId                withdraw a note
// POST   /handovers/sales/:id/notes/:noteId/attachments    attach a file to a note
//
// POST   /handovers/sales/:id/plays/:instanceId/evidence/upload   file as evidence
//
// ── Review loop (2026_130) ───────────────────────────────────────────────────
// POST   /handovers/sales/:id/plays/:instanceId/transition   submit / approve / send back
// GET    /handovers/sales/:id/plays/:instanceId/transitions  status history for a task
// GET    /handovers/review-queue                             awaiting MY review, all projects
// GET    /handovers/sales/:id/review-queue                   everything awaiting review on one project
// GET    /handovers/sales/:id/review-watchers                who is alerted
// PUT    /handovers/sales/:id/review-watchers                set who is alerted
// ─────────────────────────────────────────────────────────────────────────────

const express         = require('express');
const router          = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const handoverService   = require('../services/handover.service');
// 2026_136. Bulk plan import — kept out of handover.service, which is already
// 5,900 lines, and self-contained enough to be read on its own.
const planImport        = require('../services/planImport.service');

// Multipart for file evidence and note attachments (2026_124).
// memoryStorage because the buffer is handed straight to the Drive/OneDrive
// provider and never written to this container's disk — the same arrangement
// projectFiles.routes.js uses, and the same 100 MB ceiling.
const multer  = require('multer');
const upload  = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const projectSettings = require('../services/projectSettings.service');
const planVariance    = require('../services/planVariance.service');   // 2026_111
const boq             = require('../services/boq.service');            // 2026_113/114
const playReview      = require('../services/playReview.service');     // 2026_130
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
    const { scope = 'mine', status, kind, trackingMode } = req.query;

    // 'all' predates the rollup scopes and is kept as an alias for 'org' so any
    // existing caller keeps working.
    const requested = scope === 'all' ? 'org' : scope;
    if (!['mine', 'assigned', 'team', 'org'].includes(requested)) {
      return res.status(400).json({ error: { message: 'scope must be mine|assigned|team|org' } });
    }

    // 2026_133. Omitted means 'timeboxed' — the Projects list, which is what
    // every existing caller of this endpoint is. 'standing' is the Initiatives
    // screen and 'all' is the combined view, which is deferred; it is accepted
    // here because the service already supports it and refusing a value the
    // layer below understands only moves the work later.
    if (trackingMode != null && !['timeboxed', 'standing', 'all'].includes(trackingMode)) {
      return res.status(400).json({ error: { message: 'trackingMode must be timeboxed|standing|all' } });
    }

    const handovers = await handoverService.list(req.orgId, req.user.userId, {
      scope: requested,
      status,
      kind,
      trackingMode: trackingMode === 'all' ? null : (trackingMode || 'timeboxed'),
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
/**
 * Who may change the SET of standing initiatives: manager and above.
 *
 * Four operations, one rule: create one, convert a project into one, retire
 * one, un-retire one. Every one of them adds to or removes from the list of
 * containers the whole org files daily work against, so they are the same
 * decision wearing four hats and they must not drift apart.
 *
 * There is no 'manager' role — org_users.role is exactly
 * ('owner','admin','member','viewer') and management is a position in
 * org_hierarchy, not a role. This is the same idiom the project-access config
 * already uses for canUseTeam: you manage someone if orgContext resolved
 * subordinates for you.
 *
 * The reason for the gate is the one daily work already learned: ten people
 * free-typing container names produces three spellings of PowerBI inside a
 * fortnight, which is why daily work anchors are select-only. The set of
 * things work can be filed against has to stay small and deliberate.
 *
 * Retirement is on this list rather than on ownership because a standing
 * initiative HAS no owner — that is the point of the mode, and
 * list() explicitly stops counting one as unassigned for exactly that reason.
 * There is nobody to check against, so the gate is the same org-wide manager
 * gate that governs creation.
 *
 * Note the failure direction. orgContext sets subordinateIds = [] when the
 * hierarchy lookup errors, so an infrastructure blip narrows this to owners and
 * admins rather than widening it to everyone. That is the opposite of
 * requireModule, which fails open — know which one you are behind.
 */
async function canManageStanding(req) {
  const role = await projectSettings.resolveRole(req.orgId, req.user.userId);
  if (['owner', 'admin'].includes(role)) return true;
  return (req.subordinateIds || []).length > 0;
}

router.post('/projects', async (req, res) => {
  try {
    if ((req.body || {}).trackingMode === 'standing' && !(await canManageStanding(req))) {
      return res.status(403).json({
        error: { message: 'Only a manager, admin or owner can create a standing initiative.' },
      });
    }
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
    // userId is threaded through for go-live rescheduling: every date the
    // reschedule moves is written to play_due_date_revisions, whose revised_by
    // is NOT NULL. Without it the go-live saves and the checklist is left
    // alone rather than moved anonymously.
    const handover = await handoverService.update(
      parseInt(req.params.id), req.orgId, req.body, req.user.userId);
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

// ── PATCH /sales/:id/tracking-mode — convert between the two axes (2026_133) ──
//
// Separate from PUT /sales/:id because update() cannot clear go_live_date:
// every field there is COALESCE($n, column), so null means "unchanged".

router.patch('/sales/:id/tracking-mode', async (req, res) => {
  try {
    const { trackingMode, assignedServiceOwnerId, goLiveDate, acknowledgeAnchoredPlays } = req.body || {};
    if (!trackingMode) {
      return res.status(400).json({ error: { message: 'trackingMode is required' } });
    }
    if (trackingMode === 'standing' && !(await canManageStanding(req))) {
      return res.status(403).json({
        error: { message: 'Only a manager, admin or owner can convert a project to a standing initiative.' },
      });
    }

    const project = await handoverService.convertTrackingMode(
      parseInt(req.params.id), req.orgId, req.user.userId, trackingMode,
      { assignedServiceOwnerId, goLiveDate, acknowledgeAnchoredPlays: acknowledgeAnchoredPlays === true });
    res.json({ project });
  } catch (err) {
    // 409 + GO_LIVE_ANCHORED_PLAYS carries the list of affected tasks so the UI
    // can show them and offer to proceed, rather than making the person guess
    // which dates the conversion is about to strand.
    if (err.code === 'GO_LIVE_ANCHORED_PLAYS') {
      return res.status(409).json({
        error: { message: err.message, code: err.code, details: err.details },
      });
    }
    console.error('Convert tracking mode error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST/DELETE /sales/:id/retire — standing initiatives only ────────────────
//
// Retire, never delete. daily_work_items.anchor_id is a soft reference with no
// foreign key, so deleting the container does not cascade its logged work away
// — it leaves rows pointing at an id that resolves to nothing.

//
// Both directions are gated by canManageStanding — manager and above, the same
// rule that governs creating one. Retiring removes a container from the picker
// the whole org files work against; un-retiring puts it back. Gating only one
// half would mean a member could not retire an initiative but could resurrect
// one, which is the wider of the two powers.

router.post('/sales/:id/retire', async (req, res) => {
  try {
    if (!(await canManageStanding(req))) {
      return res.status(403).json({
        error: { message: 'Only a manager, admin or owner can retire a standing initiative.' },
      });
    }
    const project = await handoverService.retire(parseInt(req.params.id), req.orgId, req.user.userId);
    res.json({ project });
  } catch (err) {
    console.error('Retire initiative error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.delete('/sales/:id/retire', async (req, res) => {
  try {
    if (!(await canManageStanding(req))) {
      return res.status(403).json({
        error: { message: 'Only a manager, admin or owner can un-retire a standing initiative.' },
      });
    }
    const project = await handoverService.unretire(parseInt(req.params.id), req.orgId);
    res.json({ project });
  } catch (err) {
    console.error('Un-retire initiative error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /sales/:id/go-live-drift ──────────────────────────────────────────────
//
// The frozen half of go-live rescheduling. On a project whose plan is frozen the
// rescheduler deliberately moves nothing — a date move there is a rebaseline and
// has to be somebody's decision, with a reason, through PATCH .../plays/:id.
// This reports the gap so it is visible rather than a silently wrong checklist.
// Empty for an unfrozen project, where the dates have already been moved.
router.get('/sales/:id/go-live-drift', async (req, res) => {
  try {
    res.json(await handoverService.getGoLiveDrift(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('Go-live drift error:', err);
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

// ═════════════════════════════════════════════════════════════════════════════
// REVIEW LOOP (2026_130)
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /sales/:id/plays/:instanceId/transition ──────────────────────────────
//
// One endpoint for the whole loop rather than four, because the permission
// rules, evidence rules and audit write are shared and splitting them would
// mean four places to keep in step.
//
//   { to: 'in_review',   targetStatus, evidence }  submit for review
//   { to: 'completed'|'skipped'|'cancelled', evidence? }  approve, or close direct
//   { to: 'in_progress', reason }                  send back for rework
//
// Authorisation lives in the service, not here: the same rules have to hold
// for any future caller (a bulk approve screen, the mobile app), and a check
// in the route protects only the route.
router.post('/sales/:id/plays/:instanceId/transition', async (req, res) => {
  try {
    const result = await playReview.transition(
      parseInt(req.params.id), parseInt(req.params.instanceId),
      req.orgId, req.user.userId, req.body || {}
    );
    res.json(result);
  } catch (err) {
    console.error('Play transition error:', err);
    res.status(err.status || 500).json({
      error: {
        message: err.message,
        code:    err.code || null,
        // Pass the structured detail through so the UI can name what is in the
        // way instead of repeating a sentence the user cannot act on.
        blockedBy:      err.blockedBy      || undefined,
        stageBlockedBy: err.stageBlockedBy || undefined,
      },
    });
  }
});

// ── GET /sales/:id/plays/:instanceId/transitions ──────────────────────────────
// Status history for one task. A status that can move backwards needs this:
// without it, in_progress → in_review → in_progress reads in the database as
// though the task had never left in_progress.
router.get('/sales/:id/plays/:instanceId/transitions', async (req, res) => {
  try {
    res.json(await playReview.history(
      parseInt(req.params.id), parseInt(req.params.instanceId), req.orgId));
  } catch (err) {
    console.error('Play transition history error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /review-queue ─────────────────────────────────────────────────────────
// Everything awaiting THIS user's review, across every project they run.
//
// Declared at the router root, not under /sales/:id — it is not scoped to a
// project, and that is the whole point of it. Express matches by path, so
// there is no ordering hazard against the /sales/* routes.
router.get('/review-queue', async (req, res) => {
  try {
    res.json(await playReview.myReviewQueue(req.orgId, req.user.userId));
  } catch (err) {
    console.error('My review queue error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET /sales/:id/review-queue ───────────────────────────────────────────────
// Everything on this project awaiting review — the question 'in_review' was
// made a first-class status in order to answer.
router.get('/sales/:id/review-queue', async (req, res) => {
  try {
    res.json(await playReview.reviewQueue(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('Review queue error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET / PUT /sales/:id/review-watchers ──────────────────────────────────────
// The designated people alerted alongside the Project Manager. The PM and the
// creator are always notified and never appear here — a list that can be
// emptied must not be able to silence them.
router.get('/sales/:id/review-watchers', async (req, res) => {
  try {
    res.json(await playReview.listWatchers(parseInt(req.params.id), req.orgId));
  } catch (err) {
    console.error('List review watchers error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

router.put('/sales/:id/review-watchers', async (req, res) => {
  try {
    res.json(await playReview.setWatchers(
      parseInt(req.params.id), req.orgId, req.user.userId, req.body?.userIds || []));
  } catch (err) {
    console.error('Set review watchers error:', err);
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

// ── Plan import (2026_136) ───────────────────────────────────────────────────
//
// POST /sales/:id/plan-import/preview   durations -> dates, writes nothing
// POST /sales/:id/plan-import           create the stages and tasks
//
// Two calls because the DATES ARE EDITABLE between them. Preview is pure, so
// the client can re-run it whenever the start date changes; commit takes
// whatever the person confirmed, which is not necessarily what preview
// produced.
router.post('/sales/:id/plan-import/preview', async (req, res) => {
  try {
    res.json(await planImport.preview(
      parseInt(req.params.id, 10), req.orgId,
      { rows: req.body?.rows, startDate: req.body?.startDate || null }));
  } catch (err) {
    if (err.name === 'PlanImportError') {
      return res.status(400).json({ error: { message: err.message, code: err.code },
                                    code: err.code, details: err.details });
    }
    console.error('Plan import preview error:', err);
    res.status(500).json({ error: { message: 'Could not read that plan' } });
  }
});

router.post('/sales/:id/plan-import', async (req, res) => {
  try {
    res.json(await planImport.commit(
      parseInt(req.params.id, 10), req.orgId, req.user.userId,
      { rows: req.body?.rows }));
  } catch (err) {
    if (err.name === 'PlanImportError') {
      return res.status(400).json({ error: { message: err.message, code: err.code },
                                    code: err.code, details: err.details });
    }
    console.error('Plan import commit error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

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
    const handoverId = parseInt(req.params.id);
    // 2026_120: the note counts on each row must match what this viewer would
    // actually be shown if they opened the row.
    const { hideInternalNotes } = await handoverService.getNoteVisibility(
      handoverId, req.orgId, req.user.userId);
    res.json(await planVariance.getProjectVariance(handoverId, req.orgId, hideInternalNotes));
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

// POST /sales/:id/plays/:instanceId/evidence/upload — a file as evidence
//
// multipart: file, and optionally note.
//
// The bytes go to the org's Google Drive or OneDrive, never to Postgres. A
// project with no mapped upload folder is refused with the message from
// projectFiles.uploadLocalFile(), which names the setting to change — there is
// deliberately no database fallback.
router.post('/sales/:id/plays/:instanceId/evidence/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: { message: 'No file received' } });
    res.status(201).json(await handoverService.uploadPlayEvidenceFile(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId),
      req.user.userId,
      {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer:   req.file.buffer,
        note:     (req.body || {}).note,
      }
    ));
  } catch (err) {
    // multer rejects an oversized file before the handler runs, so surface
    // that as a size problem rather than a generic 500.
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: { message: 'That file is over the 100 MB limit.' } });
    }
    console.error('Upload play evidence error:', err);
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

// ── NOTES ON A TASK (2026_120) ───────────────────────────────────────────────
//
// Notes attach to a task in ANY status. There is no open/closed check on these
// routes, deliberately: annotating a finished task is the case a manager
// writing up a project needs most.
//
// Permission lives entirely in the service (canNoteOnProject / the author-or-
// manager rule in deletePlayNote), so these handlers stay thin and there is
// one place to change the rule.

// GET /sales/:id/plays/:instanceId/notes
router.get('/sales/:id/plays/:instanceId/notes', async (req, res) => {
  try {
    res.json(await handoverService.listPlayNotes(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId),
      req.user.userId
    ));
  } catch (err) {
    console.error('List play notes error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// POST /sales/:id/plays/:instanceId/notes — { body, noteType?, isInternal? }
router.post('/sales/:id/plays/:instanceId/notes', async (req, res) => {
  try {
    res.json(await handoverService.addPlayNote(
      parseInt(req.params.id), req.orgId, parseInt(req.params.instanceId),
      req.user.userId, req.body || {}
    ));
  } catch (err) {
    console.error('Add play note error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// DELETE /sales/:id/notes/:noteId — soft delete; the row is retained
//
// Keyed on the note rather than nested under the play: a note id already
// resolves to exactly one task, and the service re-checks that the task
// belongs to this project, so carrying the instance id here would add a
// parameter that has to agree with the note and can therefore disagree.
router.delete('/sales/:id/notes/:noteId', async (req, res) => {
  try {
    res.json(await handoverService.deletePlayNote(
      parseInt(req.params.id), req.orgId, parseInt(req.params.noteId),
      req.user.userId
    ));
  } catch (err) {
    console.error('Delete play note error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// POST /sales/:id/notes/:noteId/attachments — attach a file to a note
//
// multipart: file. Same storage path as evidence; same refusal when the
// project has no upload folder.
//
// A second step rather than part of the note POST on purpose: a multipart
// upload can fail long after the sentence was typed, and losing the note
// because the photo failed would be the wrong trade.
router.post('/sales/:id/notes/:noteId/attachments', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: { message: 'No file received' } });
    res.status(201).json(await handoverService.addPlayNoteAttachment(
      parseInt(req.params.id), req.orgId, parseInt(req.params.noteId),
      req.user.userId,
      { fileName: req.file.originalname, mimeType: req.file.mimetype, buffer: req.file.buffer }
    ));
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: { message: 'That file is over the 100 MB limit.' } });
    }
    console.error('Add note attachment error:', err);
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

// ── GET /team-members/:userId/project-summary — for the daily work module ────
//
// Cross-module read (2026_133): the daily work person view calls this so
// "what is Chandini doing" is answerable without leaving it.
//
// SCOPED, unlike the two routes above it. Those return anyone's projects to
// anyone in the org, which is pre-existing and not widened here — but this one
// is new, it is consumed by a module whose every team read is bounded by the
// manager chain, and shipping a new unscoped route beside a scoped module would
// hand people a way around that boundary. Self plus reports, matching the rule
// list() already uses for scope=team.
//
// Returns empty rather than 403: a 403 confirms the person exists.
router.get('/team-members/:userId/project-summary', async (req, res) => {
  try {
    const target = parseInt(req.params.userId, 10);
    if (!Number.isInteger(target) || target <= 0) {
      return res.status(400).json({ error: { message: 'userId must be a positive integer' } });
    }
    const visible = new Set([req.user.userId, ...(req.subordinateIds || [])]);
    if (!visible.has(target)) return res.json({ projects: [], commitments: [] });

    res.json(await handoverService.getPersonProjectSummary(target, req.orgId));
  } catch (err) {
    console.error('Person project summary error:', err);
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
        // 2026_133. Sent rather than re-derived on the client, so the button
        // and the 403 can never disagree. Note it is NOT canUseTeam: that
        // ANDs in team_scope_enabled, an unrelated org setting, so a manager
        // in an org with team scope switched off would be shown no option and
        // then allowed by the server.
        canCreateStanding: await canManageStanding(req),
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
