// ============================================================
// ActionCRM Playbook Builder — Module B: Routes
// File: backend/routes/playbookBuilder.routes.js
//
// Middleware pattern matches orgAdmin.routes.js exactly:
//   authenticateToken           — default export, auth.middleware
//   orgContext, requireRole     — named exports, orgContext.middleware
//   req.orgId                   — set by orgContext
//   req.user.userId             — set by authenticateToken
//   adminOnly = requireRole('owner', 'admin')
// ============================================================

const express = require('express');
const router  = express.Router();

const authenticateToken           = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const svc                         = require('../services/PlaybookBuilderService');
const accessResolver              = require('../services/PlaybookAccessResolver');

router.use(authenticateToken, orgContext);

// Role middleware — matches orgAdmin.routes.js pattern exactly
const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────
// Helper — resolves access for the calling user.
// Admins (owner/admin role) always get 'owner' access —
// no DB lookup needed.
// ─────────────────────────────────────────────────────────────
async function getAccess(playbook_id, req) {
  const role = req.user?.role || '';
  if (role === 'owner' || role === 'admin') return 'owner';
  return accessResolver.resolve(playbook_id, req.user.userId, req.orgId);
}

// ─────────────────────────────────────────────────────────────
// IMPORTANT: fixed-path routes MUST come before /:id wildcards
// ─────────────────────────────────────────────────────────────

// B6 — Stats summary (before /:id to prevent 'stats' matching as id)
router.get('/stats/summary', async (req, res) => {
  try {
    const stats = await svc.getStats({ org_id: req.orgId });
    res.json({ stats });
  } catch (err) {
    console.error('GET /api/playbooks/stats/summary', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// B1 — Playbook CRUD
// ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { dept, status, search } = req.query;
    const playbooks = await svc.listPlaybooks({
      org_id:  req.orgId,
      user_id: req.user.userId,
      role:    req.user.role || 'member',
      dept, status, search,
    });
    res.json({ playbooks });
  } catch (err) {
    console.error('GET /api/playbooks', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    let access = await getAccess(req.params.id, req);
    // null means no explicit grant — fall back to 'reader' so org members
    // can always view playbooks. Write operations still require 'owner'.
    if (access === null) access = 'reader';
    const playbook = await svc.getPlaybook(req.params.id);
    res.json({ playbook, access });
  } catch (err) {
    console.error('GET /api/playbooks/:id', err);
    res.status(500).json({ error: err.message });
  }
});

// Direct creation — admin only (normal path is via registration approval)
router.post('/', adminOnly, async (req, res) => {
  try {
    const playbook = await svc.createPlaybook({
      ...req.body,
      org_id:     req.orgId,
      created_by: req.user.userId,
    });
    res.status(201).json({ playbook });
  } catch (err) {
    console.error('POST /api/playbooks', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const access = await getAccess(req.params.id, req);
    if (access !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    const playbook = await svc.updatePlaybook(req.params.id, req.body);
    res.json({ playbook });
  } catch (err) {
    console.error('PATCH /api/playbooks/:id', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/archive', adminOnly, async (req, res) => {
  try {
    const result = await svc.archivePlaybook({
      playbook_id:       req.params.id,
      archived_by:       req.user.userId,
      reason:            req.body.reason,
      replacement_pb_id: req.body.replacement_pb_id || null,
      sunset_days:       req.body.sunset_days ?? 7,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/playbooks/:id/archive', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// B2 — Versions
// ─────────────────────────────────────────────────────────────

router.get('/:id/versions', async (req, res) => {
  try {
    let access = await getAccess(req.params.id, req);
    if (access === null) access = 'reader';
    const versions = await svc.getVersionHistory(req.params.id);
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/versions', async (req, res) => {
  try {
    const access = await getAccess(req.params.id, req);
    if (access !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    const version = await svc.createDraftVersion({
      playbook_id:    req.params.id,
      created_by:     req.user.userId,
      change_summary: req.body.change_summary || null,
    });
    res.status(201).json({ version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/versions/:v/submit', async (req, res) => {
  try {
    const access = await getAccess(req.params.id, req);
    if (access !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    const result = await svc.submitVersionForApproval({
      playbook_id:    req.params.id,
      version_number: parseInt(req.params.v, 10),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/versions/:v/approve', adminOnly, async (req, res) => {
  try {
    const result = await svc.approveVersion({
      playbook_id:    req.params.id,
      version_number: parseInt(req.params.v, 10),
      approved_by:    req.user.userId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/versions/:v/reject', adminOnly, async (req, res) => {
  try {
    const result = await svc.rejectVersion({
      playbook_id:    req.params.id,
      version_number: parseInt(req.params.v, 10),
      rejected_by:    req.user.userId,
      reason:         req.body.reason || '',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// B3 — Plays CRUD
// ─────────────────────────────────────────────────────────────

router.get('/:id/plays', async (req, res) => {
  try {
    let access = await getAccess(req.params.id, req);
    if (access === null) access = 'reader';
    const { stage_key, version_number } = req.query;
    const plays = await svc.getPlays({
      playbook_id:    req.params.id,
      stage_key:      stage_key || null,
      version_number: version_number ? parseInt(version_number, 10) : null,
    });
    res.json({ plays });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/plays', async (req, res) => {
  try {
    const access = await getAccess(req.params.id, req);
    if (access !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    const play = await svc.createPlay({
      ...req.body,
      playbook_id: req.params.id,
      org_id:      req.orgId,       // always from server — never trust client body
      created_by:  req.user.userId,
    });
    res.status(201).json({ play });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/plays/:play_id', async (req, res) => {
  try {
    const access = await getAccess(req.params.id, req);
    if (access !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    const play = await svc.updatePlay(req.params.play_id, req.body);
    res.json({ play });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/plays/:play_id', async (req, res) => {
  try {
    const access = await getAccess(req.params.id, req);
    if (access !== 'owner') return res.status(403).json({ error: 'Owner access required' });
    await svc.deletePlay(req.params.play_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// B5 — Access management
// ─────────────────────────────────────────────────────────────

router.get('/:id/access', async (req, res) => {
  try {
    const target_user_id = req.query.user_id
      ? parseInt(req.query.user_id, 10)
      : req.user.userId;
    const level = await accessResolver.resolve(req.params.id, target_user_id, req.orgId);
    res.json({ user_id: target_user_id, playbook_id: req.params.id, access_level: level });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/teams', async (req, res) => {
  try {
    let access = await getAccess(req.params.id, req);
    if (access === null) access = 'reader';
    const teams = await svc.getTeamGrants(req.params.id);
    res.json({ teams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/teams', adminOnly, async (req, res) => {
  try {
    const result = await svc.addTeamGrant({
      playbook_id:  req.params.id,
      team_id:      req.body.team_id,
      access_level: req.body.access_level,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/teams/:team_id', adminOnly, async (req, res) => {
  try {
    await svc.removeTeamGrant(req.params.id, req.params.team_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/user-access', adminOnly, async (req, res) => {
  try {
    const overrides = await svc.getUserOverrides(req.params.id);
    res.json({ overrides });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/user-access', adminOnly, async (req, res) => {
  try {
    const result = await svc.setUserOverride({
      playbook_id:  req.params.id,
      set_by:       req.user.userId,
      user_id:      req.body.user_id,
      access_level: req.body.access_level,
      reason:       req.body.reason || null,
      expires_at:   req.body.expires_at || null,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/user-access/:target_user_id', adminOnly, async (req, res) => {
  try {
    await svc.removeUserOverride(req.params.id, req.params.target_user_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B6 — Per-playbook stats (after all fixed routes)
router.get('/:id/stats', async (req, res) => {
  try {
    let access = await getAccess(req.params.id, req);
    if (access === null) access = 'reader';
    const stats = await svc.getPlaybookStats(req.params.id);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
