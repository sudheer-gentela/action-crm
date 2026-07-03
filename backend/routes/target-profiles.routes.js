// ─────────────────────────────────────────────────────────────────────────────
// routes/target-profiles.routes.js
//
// Signal-Based Campaigns — Phase 3: the Target Profiles library API (D3/D4).
// Reusable, function-tagged Target Criteria sets. Org-shared (D10): any
// authenticated member of the org can list/read and CREATE (a rep-created
// profile carries created_by and renders as "rep-added"); editing/retiring an
// existing profile follows the same open model as the signal catalog — reps
// manage the shared library together. If you later want to lock edits to
// admins/owners, swap `router.use` scoping for per-route `adminOnly` like
// prospecting-config.routes.js does.
//
//   GET    /api/target-profiles           list (?functionTag, ?includeInactive)
//   POST   /api/target-profiles           create
//   GET    /api/target-profiles/:id       one
//   PUT    /api/target-profiles/:id       update (name/description/tags/criteria/active)
//   DELETE /api/target-profiles/:id       retire (soft)
//
// All queries are org-scoped via req.orgId (set by orgContext). Never trust
// org_id from the request body.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const TargetProfileService = require('../services/TargetProfileService');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / — list profiles ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const functionTag = typeof req.query.functionTag === 'string' && req.query.functionTag.trim()
      ? req.query.functionTag.trim().toLowerCase() : null;
    const includeInactive = req.query.includeInactive === 'true';
    const profiles = await TargetProfileService.listProfiles({
      orgId: req.orgId, functionTag, includeInactive,
    });
    res.json({ profiles });
  } catch (err) {
    console.error('target-profiles GET /', err);
    res.status(500).json({ error: { message: 'Failed to list target profiles' } });
  }
});

// ── POST / — create a profile ────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, description, function_tags, criteria } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: { message: 'name is required' } });
  }
  try {
    const profile = await TargetProfileService.createProfile({
      orgId: req.orgId,
      name,
      description: description ?? null,
      functionTags: Array.isArray(function_tags) ? function_tags : [],
      criteria: criteria ?? null,
      createdBy: req.user.userId,   // ⇒ "rep-added"
    });
    res.status(201).json({ profile });
  } catch (err) {
    // Duplicate name → 409; everything else 400/500 by shape.
    if (/already exists/.test(err.message)) {
      return res.status(409).json({ error: { message: err.message } });
    }
    if (/required|empty|invalid/i.test(err.message)) {
      return res.status(400).json({ error: { message: err.message } });
    }
    console.error('target-profiles POST /', err);
    res.status(500).json({ error: { message: 'Failed to create target profile' } });
  }
});

// ── GET /:id — one profile ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'invalid id' } });
  try {
    const profile = await TargetProfileService.getProfile({ orgId: req.orgId, id });
    if (!profile) return res.status(404).json({ error: { message: 'Target profile not found' } });
    res.json({ profile });
  } catch (err) {
    console.error('target-profiles GET /:id', err);
    res.status(500).json({ error: { message: 'Failed to load target profile' } });
  }
});

// ── PUT /:id — update ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'invalid id' } });

  // Only forward the fields the service knows how to patch. Map snake_case
  // (API) → camelCase (service) for function_tags.
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'name'))          patch.name = req.body.name;
  if (Object.prototype.hasOwnProperty.call(req.body, 'description'))   patch.description = req.body.description;
  if (Object.prototype.hasOwnProperty.call(req.body, 'function_tags')) patch.functionTags = req.body.function_tags;
  if (Object.prototype.hasOwnProperty.call(req.body, 'criteria'))      patch.criteria = req.body.criteria;
  if (Object.prototype.hasOwnProperty.call(req.body, 'active'))        patch.active = req.body.active;

  try {
    const profile = await TargetProfileService.updateProfile({ orgId: req.orgId, id, patch });
    res.json({ profile });
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    if (/already exists/.test(err.message)) return res.status(409).json({ error: { message: err.message } });
    if (/empty|invalid|required/i.test(err.message)) return res.status(400).json({ error: { message: err.message } });
    console.error('target-profiles PUT /:id', err);
    res.status(500).json({ error: { message: 'Failed to update target profile' } });
  }
});

// ── DELETE /:id — retire (soft) ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'invalid id' } });
  try {
    const profile = await TargetProfileService.retireProfile({ orgId: req.orgId, id });
    res.json({ profile });
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    console.error('target-profiles DELETE /:id', err);
    res.status(500).json({ error: { message: 'Failed to retire target profile' } });
  }
});

module.exports = router;
