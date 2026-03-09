const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');
const AccountProspectingService = require('../services/accountProspecting.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── GET /api/accounts/:id/prospecting ────────────────────────────────────────
// Returns the full prospecting picture for an account
router.get('/:id/prospecting', async (req, res) => {
  try {
    const overview = await AccountProspectingService.getAccountOverview(
      parseInt(req.params.id), req.orgId
    );

    if (!overview) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }

    res.json(overview);
  } catch (error) {
    console.error('Account prospecting overview error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch account prospecting overview' } });
  }
});

// ── GET /api/accounts/:id/coverage ───────────────────────────────────────────
// Returns coverage scorecard for an account against a playbook
router.get('/:id/coverage', async (req, res) => {
  try {
    const { playbookId } = req.query;

    if (!playbookId) {
      return res.status(400).json({ error: { message: 'playbookId query parameter is required' } });
    }

    const scorecard = await AccountProspectingService.getCoverageScorecard(
      parseInt(req.params.id), req.orgId, parseInt(playbookId)
    );

    if (!scorecard) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    res.json(scorecard);
  } catch (error) {
    console.error('Coverage scorecard error:', error);
    res.status(500).json({ error: { message: 'Failed to generate coverage scorecard' } });
  }
});

module.exports = router;
