// ─────────────────────────────────────────────────────────────────────────────
// prospect-context.routes.js
//
// Exposes ProspectContextBuilder and IcpScoringService to the frontend.
// Mount in server.js: app.use('/api/prospect-context', require('./routes/prospect-context.routes'));
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const authenticateToken           = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const ProspectContextBuilder      = require('../services/ProspectContextBuilder');
const IcpScoringService           = require('../services/icpScoring.service');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── GET /:prospectId — full context for a prospect ──────────────────────────
// Returns the assembled context used by the Outreach Composer and detail panel.
// Includes: prospect, account, deals, contacts, email history, siblings,
//           stage guidance, ICP breakdown, derived signals, outreach summary.

router.get('/:prospectId', async (req, res) => {
  try {
    const context = await ProspectContextBuilder.build(
      parseInt(req.params.prospectId),
      req.user.userId,
      req.orgId
    );

    // Return a trimmed version for the frontend (full objects can be large)
    res.json({
      prospect: context.prospect,
      account: context.account ? {
        id: context.account.id,
        name: context.account.name,
        domain: context.account.domain,
        industry: context.account.industry,
      } : null,
      accountDeals: context.accountDeals.map(d => ({
        id: d.id, name: d.name, value: d.value,
        stage: d.stage, closeDate: d.close_date,
      })),
      accountContacts: context.accountContacts.map(c => ({
        id: c.id, firstName: c.first_name, lastName: c.last_name,
        email: c.email, title: c.title,
      })),
      teamEngagement: context.teamEngagement.map(t => ({
        userId: t.user_id, firstName: t.first_name,
        lastName: t.last_name, lastEngagement: t.last_engagement,
      })),
      emailHistory: context.emailHistory.map(e => ({
        id: e.id, subject: e.subject, direction: e.direction,
        sentAt: e.sent_at, snippet: e.body_snippet,
      })),
      siblingProspects: context.siblingProspects.map(p => ({
        id: p.id, firstName: p.first_name, lastName: p.last_name,
        title: p.title, stage: p.stage, icpScore: p.icp_score,
      })),
      stageGuidance: context.stageGuidance,
      icpBreakdown: context.icpBreakdown,
      icpScore: context.icpScore,
      derived: {
        daysSinceLastOutreach: context.derived.daysSinceLastOutreach,
        daysSinceLastResponse: context.derived.daysSinceLastResponse,
        responseRate: context.derived.responseRate,
        isGhosting: context.derived.isGhosting,
        isStale: context.derived.isStale,
        isHotLead: context.derived.isHotLead,
        hasReplied: context.derived.hasReplied,
        unansweredCount: context.derived.unansweredCount,
        isExistingCustomer: context.derived.isExistingCustomer,
        isLostAccount: context.derived.isLostAccount,
        hasOpenDeal: context.derived.hasOpenDeal,
        totalAccountRevenue: context.derived.totalAccountRevenue,
        knownContactCount: context.derived.knownContactCount,
        teamMembersEngaged: context.derived.teamMembersEngaged,
        pendingActions: context.derived.pendingActions.length,
        overdueActions: context.derived.overdueActions.length,
      },
      outreachContext: context.outreachContext,
    });
  } catch (error) {
    console.error('Prospect context error:', error);
    res.status(500).json({ error: { message: error.message || 'Failed to build prospect context' } });
  }
});

// ── POST /:prospectId/score — recalculate ICP score for one prospect ────────

router.post('/:prospectId/score', async (req, res) => {
  try {
    const prospectRes = await require('../config/database').query(
      'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [parseInt(req.params.prospectId), req.orgId]
    );
    if (prospectRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Prospect not found' } });
    }

    const breakdown = await IcpScoringService.score(prospectRes.rows[0], req.orgId);
    res.json({ icpScore: breakdown.score, breakdown });
  } catch (error) {
    console.error('ICP scoring error:', error);
    res.status(500).json({ error: { message: 'Failed to score prospect' } });
  }
});

// ── POST /score-all — bulk score all unscored prospects (admin only) ────────

router.post('/score-all', adminOnly, async (req, res) => {
  try {
    const result = await IcpScoringService.scoreAll(req.orgId);
    res.json({ message: `Scored ${result.scored} of ${result.total} prospect(s)`, ...result });
  } catch (error) {
    console.error('Bulk ICP scoring error:', error);
    res.status(500).json({ error: { message: 'Failed to bulk score prospects' } });
  }
});

// ── GET /icp-config — get org's ICP scoring config ──────────────────────────

router.get('/icp-config/current', async (req, res) => {
  try {
    const config = await IcpScoringService.getConfig(req.orgId);
    res.json({ config });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch ICP config' } });
  }
});

// ── PUT /icp-config — update org's ICP scoring config (admin only) ──────────

router.put('/icp-config/current', adminOnly, async (req, res) => {
  try {
    const config = await IcpScoringService.saveConfig(req.orgId, req.body);
    res.json({ config, message: 'ICP config updated' });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to update ICP config' } });
  }
});

module.exports = router;
