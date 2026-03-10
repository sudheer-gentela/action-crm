// ─────────────────────────────────────────────────────────────────────────────
// routes/account-teams.routes.js
//
// GET    /account-teams?accountId=     list teams for an account (with members)
// POST   /account-teams                create team
// PUT    /account-teams/:id            update team
// DELETE /account-teams/:id            delete team
// POST   /account-teams/:id/members    add member to team
// DELETE /account-teams/:id/members/:memberId  remove member
// GET    /account-teams/contact/:contactId      all teams a contact belongs to
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken   = require('../middleware/auth.middleware');
const { orgContext }      = require('../middleware/orgContext.middleware');
const accountTeamsService = require('../services/accountTeams.service');

router.use(authenticateToken);
router.use(orgContext);

// ── GET /contact/:contactId — must be before GET / to avoid param collision ──

router.get('/contact/:contactId', async (req, res) => {
  try {
    const teams = await accountTeamsService.listByContact(
      parseInt(req.params.contactId),
      req.orgId
    );
    res.json({ teams });
  } catch (err) {
    console.error('List contact account teams error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── GET / ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { accountId, includeInactive } = req.query;
    if (!accountId) {
      return res.status(400).json({ error: { message: 'accountId query param is required' } });
    }

    const teams = await accountTeamsService.listByAccount(
      parseInt(accountId),
      req.orgId,
      { activeOnly: includeInactive !== 'true' }
    );
    res.json({ teams });
  } catch (err) {
    console.error('List account teams error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST / ───────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const team = await accountTeamsService.createTeam(req.orgId, req.user.userId, req.body);
    res.status(201).json({ team });
  } catch (err) {
    console.error('Create account team error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const team = await accountTeamsService.updateTeam(req.orgId, parseInt(req.params.id), req.body);
    res.json({ team });
  } catch (err) {
    console.error('Update account team error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const result = await accountTeamsService.deleteTeam(req.orgId, parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    console.error('Delete account team error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── POST /:id/members ────────────────────────────────────────────────────────

router.post('/:id/members', async (req, res) => {
  try {
    const member = await accountTeamsService.addMember(
      req.orgId,
      parseInt(req.params.id),
      req.body
    );
    res.status(201).json({ member });
  } catch (err) {
    console.error('Add account team member error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

// ── DELETE /:id/members/:memberId ────────────────────────────────────────────

router.delete('/:id/members/:memberId', async (req, res) => {
  try {
    const result = await accountTeamsService.removeMember(
      req.orgId,
      parseInt(req.params.id),
      parseInt(req.params.memberId)
    );
    res.json(result);
  } catch (err) {
    console.error('Remove account team member error:', err);
    res.status(err.status || 500).json({ error: { message: err.message } });
  }
});

module.exports = router;
