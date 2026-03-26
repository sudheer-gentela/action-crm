// ============================================================
// ActionCRM Playbook Builder — B4: Registrations API
// File: backend/routes/playbookRegistrations.routes.js
// ============================================================

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const { requireOrgContext } = require('../middleware/orgContext.middleware');
const playbookBuilderService = require('../services/PlaybookBuilderService');

router.use(requireAuth);
router.use(requireOrgContext);

// GET /api/playbook-registrations — list registrations
// Org admin: all. Playbook owners: their own submissions.
router.get('/', async (req, res) => {
  try {
    const { org_id, user_id, role } = req.user;
    const { status } = req.query;
    const registrations = await playbookBuilderService.listRegistrations({
      org_id,
      user_id,
      role,
      status
    });
    res.json({ registrations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/playbook-registrations/:id
router.get('/:id', async (req, res) => {
  try {
    const { user_id, org_id, role } = req.user;
    const reg = await playbookBuilderService.getRegistration(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Not found' });
    // Access: org_admin or the submitter
    if (role !== 'org_admin' && reg.submitter_id !== user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ registration: reg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playbook-registrations — submit a new registration
router.post('/', async (req, res) => {
  try {
    const { user_id, org_id } = req.user;
    const reg = await playbookBuilderService.createRegistration({
      ...req.body,
      org_id,
      submitter_id: user_id
    });
    res.status(201).json({ registration: reg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/playbook-registrations/:id — update (allowed in draft / changes_requested)
router.patch('/:id', async (req, res) => {
  try {
    const { user_id, role } = req.user;
    const reg = await playbookBuilderService.getRegistration(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Not found' });
    if (role !== 'org_admin' && reg.submitter_id !== user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!['draft', 'changes_requested'].includes(reg.status)) {
      return res.status(422).json({ error: `Cannot edit registration in status: ${reg.status}` });
    }
    const updated = await playbookBuilderService.updateRegistration(req.params.id, req.body);
    res.json({ registration: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playbook-registrations/:id/submit — move from draft → submitted
router.post('/:id/submit', async (req, res) => {
  try {
    const { user_id } = req.user;
    const result = await playbookBuilderService.submitRegistration({
      id: req.params.id,
      submitted_by: user_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playbook-registrations/:id/approve — org_admin approves
router.post('/:id/approve', async (req, res) => {
  try {
    const { user_id, role } = req.user;
    if (role !== 'org_admin') return res.status(403).json({ error: 'Org admin required' });
    const result = await playbookBuilderService.approveRegistration({
      id: req.params.id,
      approved_by: user_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playbook-registrations/:id/reject — org_admin rejects with reason
router.post('/:id/reject', async (req, res) => {
  try {
    const { user_id, role } = req.user;
    if (role !== 'org_admin') return res.status(403).json({ error: 'Org admin required' });
    const result = await playbookBuilderService.rejectRegistration({
      id: req.params.id,
      rejected_by: user_id,
      reason: req.body.reason
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/playbook-registrations/:id/request-changes — org_admin requests changes
router.post('/:id/request-changes', async (req, res) => {
  try {
    const { user_id, role } = req.user;
    if (role !== 'org_admin') return res.status(403).json({ error: 'Org admin required' });
    const result = await playbookBuilderService.requestChanges({
      id: req.params.id,
      reviewer_id: user_id,
      notes: req.body.notes
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
