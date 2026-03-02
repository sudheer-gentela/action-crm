// ─────────────────────────────────────────────────────────────────────────
// routes/teams.routes.js
//
// Admin-only routes for managing teams and team memberships.
// Follows the same middleware pattern as orgAdmin.routes.js:
//   router.use(authenticateToken, orgContext) at router level
//   adminOnly = requireRole('owner', 'admin') per route
//
// Mount under: /api/org/admin/
//   GET    /team-dimensions          — get org's dimension config
//   PUT    /team-dimensions          — update dimension config
//   GET    /teams                    — list teams (optional ?dimension= filter)
//   POST   /teams                    — create a team
//   PUT    /teams/:id                — update a team
//   DELETE /teams/:id                — soft-delete a team
//   GET    /team-memberships         — all memberships (admin grid)
//   POST   /team-memberships         — assign user to team
//   DELETE /team-memberships/:userId/:teamId — remove membership
//   GET    /team-profile/:userId     — user's team profile
//   POST   /team-memberships/bulk    — bulk assign
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const teamService = require('../services/teamService');

// Apply auth + org context to all routes in this file
router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');


// ── Dimension Configuration ───────────────────────────────────────────

router.get('/team-dimensions', adminOnly, async (req, res) => {
  try {
    const dimensions = await teamService.getDimensions(req.orgId);
    res.json({ dimensions });
  } catch (err) {
    console.error('GET /team-dimensions error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.put('/team-dimensions', adminOnly, async (req, res) => {
  try {
    const { dimensions } = req.body;
    if (!dimensions) return res.status(400).json({ error: { message: 'dimensions is required' } });

    const saved = await teamService.saveDimensions(req.orgId, dimensions);
    res.json({ dimensions: saved });
  } catch (err) {
    console.error('PUT /team-dimensions error:', err);
    res.status(400).json({ error: { message: err.message } });
  }
});


// ── Teams CRUD ────────────────────────────────────────────────────────

router.get('/teams', adminOnly, async (req, res) => {
  try {
    const { dimension } = req.query;
    const teams = await teamService.getTeams(req.orgId, dimension || null);
    res.json({ teams });
  } catch (err) {
    console.error('GET /teams error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/teams', adminOnly, async (req, res) => {
  try {
    const { name, dimension, description, parentTeamId, settings } = req.body;
    const team = await teamService.createTeam(req.orgId, {
      name, dimension, description, parentTeamId, settings,
      createdBy: req.userId,
    });
    res.status(201).json({ team });
  } catch (err) {
    console.error('POST /teams error:', err);
    const status = err.message.includes('duplicate') || err.message.includes('unique') ? 409 : 400;
    res.status(status).json({ error: { message: err.message } });
  }
});

router.put('/teams/:id', adminOnly, async (req, res) => {
  try {
    const team = await teamService.updateTeam(req.orgId, parseInt(req.params.id), req.body);
    res.json({ team });
  } catch (err) {
    console.error('PUT /teams/:id error:', err);
    res.status(400).json({ error: { message: err.message } });
  }
});

router.delete('/teams/:id', adminOnly, async (req, res) => {
  try {
    const deleted = await teamService.deleteTeam(req.orgId, parseInt(req.params.id));
    if (!deleted) return res.status(404).json({ error: { message: 'Team not found' } });
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /teams/:id error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});


// ── Team Memberships ──────────────────────────────────────────────────

router.get('/team-memberships', adminOnly, async (req, res) => {
  try {
    const memberships = await teamService.getAllMemberships(req.orgId);
    res.json({ memberships });
  } catch (err) {
    console.error('GET /team-memberships error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/team-memberships', adminOnly, async (req, res) => {
  try {
    const { userId, teamId, role, isPrimary } = req.body;
    if (!userId || !teamId) return res.status(400).json({ error: { message: 'userId and teamId are required' } });

    const membership = await teamService.setMembership(req.orgId, userId, teamId, { role, isPrimary });
    res.status(201).json({ membership });
  } catch (err) {
    console.error('POST /team-memberships error:', err);
    res.status(400).json({ error: { message: err.message } });
  }
});

router.delete('/team-memberships/:userId/:teamId', adminOnly, async (req, res) => {
  try {
    const removed = await teamService.removeMembership(
      req.orgId,
      parseInt(req.params.userId),
      parseInt(req.params.teamId)
    );
    if (!removed) return res.status(404).json({ error: { message: 'Membership not found' } });
    res.json({ removed: true });
  } catch (err) {
    console.error('DELETE /team-memberships error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.get('/team-profile/:userId', adminOnly, async (req, res) => {
  try {
    const profile = await teamService.getUserProfile(parseInt(req.params.userId), req.orgId);
    res.json({ profile });
  } catch (err) {
    console.error('GET /team-profile error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/team-memberships/bulk', adminOnly, async (req, res) => {
  try {
    const { assignments } = req.body;
    if (!Array.isArray(assignments)) return res.status(400).json({ error: { message: 'assignments must be an array' } });

    const results = await teamService.bulkAssign(req.orgId, assignments);
    const failed = results.filter(r => !r.success);
    res.json({
      results,
      summary: { total: results.length, succeeded: results.length - failed.length, failed: failed.length },
    });
  } catch (err) {
    console.error('POST /team-memberships/bulk error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});


module.exports = router;
