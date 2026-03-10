// ─────────────────────────────────────────────────────────────────────────────
// routes/team-dimensions.routes.js
//
// GET    /team-dimensions              list (query: ?appliesTo=internal|customer|both)
// POST   /team-dimensions              create custom dimension
// PUT    /team-dimensions/:id          rename / update
// PATCH  /team-dimensions/:id/toggle   activate or deactivate
// DELETE /team-dimensions/:id          remove (custom only)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken          = require('../middleware/auth.middleware');
const { orgContext }             = require('../middleware/orgContext.middleware');
const teamDimensionsService      = require('../services/teamDimensions.service');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { appliesTo, includeInactive } = req.query;
    const activeOnly = includeInactive !== 'true';

    const dimensions = await teamDimensionsService.list(req.orgId, { appliesTo, activeOnly });
    res.json({ dimensions });
  } catch (err) {
    console.error('List team dimensions error:', err);
    res.status(500).json({ error: { message: 'Failed to load team dimensions' } });
  }
});

// ── POST / ───────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const dimension = await teamDimensionsService.create(req.orgId, req.body);
    res.status(201).json({ dimension });
  } catch (err) {
    console.error('Create team dimension error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const dimension = await teamDimensionsService.update(req.orgId, parseInt(req.params.id), req.body);
    res.json({ dimension });
  } catch (err) {
    console.error('Update team dimension error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PATCH /:id/toggle ────────────────────────────────────────────────────────

router.patch('/:id/toggle', async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: { message: 'isActive (boolean) is required' } });
    }
    const dimension = await teamDimensionsService.toggle(req.orgId, parseInt(req.params.id), isActive);
    res.json({ dimension });
  } catch (err) {
    console.error('Toggle team dimension error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const result = await teamDimensionsService.remove(req.orgId, parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    console.error('Delete team dimension error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

module.exports = router;
