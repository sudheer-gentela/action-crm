// ============================================================
// ActionCRM Playbook Builder — B4: Registrations Routes
// File: backend/routes/playbookRegistrations.routes.js
//
// Middleware pattern matches orgAdmin.routes.js exactly:
//   authenticateToken           — default export, auth.middleware
//   orgContext, requireRole     — named exports, orgContext.middleware
//   req.orgId                   — set by orgContext
//   req.user.userId             — set by authenticateToken
//   req.user.role               — set by authenticateToken ('owner'|'admin'|'member')
// ============================================================

const express = require('express');
const router  = express.Router();

const authenticateToken           = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const svc                         = require('../services/PlaybookBuilderService');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────
// GET /api/playbook-registrations
// Admin: all registrations for org. Others: own submissions only.
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const registrations = await svc.listRegistrations({
      org_id:  req.orgId,
      user_id: req.user.userId,
      role:    req.user.role || 'member',
      status,
    });
    res.json({ registrations });
  } catch (err) {
    console.error('GET /api/playbook-registrations', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/playbook-registrations/:id
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const reg = await svc.getRegistration(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Not found' });
    const role = req.user?.role || '';
    const isAdmin = role === 'owner' || role === 'admin';
    if (!isAdmin && reg.submitter_id !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ registration: reg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/playbook-registrations — create draft
// Any authenticated org member can register a playbook request.
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const reg = await svc.createRegistration({
      ...req.body,
      org_id:       req.orgId,
      submitter_id: req.user.userId,
    });
    res.status(201).json({ registration: reg });
  } catch (err) {
    console.error('POST /api/playbook-registrations', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/playbook-registrations/:id
// Only submitter (or admin) can edit, and only in draft/changes_requested.
// ─────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const reg = await svc.getRegistration(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Not found' });
    const role = req.user?.role || '';
    const isAdmin = role === 'owner' || role === 'admin';
    if (!isAdmin && reg.submitter_id !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!['draft', 'changes_requested'].includes(reg.status)) {
      return res.status(422).json({ error: `Cannot edit registration in status: ${reg.status}` });
    }
    const updated = await svc.updateRegistration(req.params.id, req.body);
    res.json({ registration: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/playbook-registrations/:id/submit
// ─────────────────────────────────────────────────────────────
router.post('/:id/submit', async (req, res) => {
  try {
    const result = await svc.submitRegistration({
      id:           req.params.id,
      submitted_by: req.user.userId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/playbook-registrations/:id/approve  — admin only
// ─────────────────────────────────────────────────────────────
router.post('/:id/approve', adminOnly, async (req, res) => {
  try {
    const result = await svc.approveRegistration({
      id:          req.params.id,
      approved_by: req.user.userId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/playbook-registrations/:id/reject  — admin only
// ─────────────────────────────────────────────────────────────
router.post('/:id/reject', adminOnly, async (req, res) => {
  try {
    const result = await svc.rejectRegistration({
      id:          req.params.id,
      rejected_by: req.user.userId,
      reason:      req.body.reason,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/playbook-registrations/:id/request-changes — admin only
// ─────────────────────────────────────────────────────────────
router.post('/:id/request-changes', adminOnly, async (req, res) => {
  try {
    const result = await svc.requestChanges({
      id:          req.params.id,
      reviewer_id: req.user.userId,
      notes:       req.body.notes,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
