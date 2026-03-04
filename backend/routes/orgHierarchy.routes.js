// routes/orgHierarchy.js
// Mount at: router.use('/api/org-hierarchy', require('./routes/orgHierarchy'))

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const svc = require('../services/orgHierarchyService');

router.use(authenticateToken);
router.use(orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT ORG CHART
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/org-hierarchy/contacts/account/:accountId
 * Full nested org chart tree for an account.
 */
router.get('/contacts/account/:accountId', async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);
    const canView = await svc.canViewOrgChart(req.orgId, req.user.userId, accountId);
    if (!canView) {
      return res.status(403).json({ error: { message: 'Not authorised to view this org chart' } });
    }
    const tree = await svc.getContactOrgChart(req.orgId, accountId);
    res.json({ tree });
  } catch (err) {
    console.error('GET contact org chart error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * GET /api/org-hierarchy/contacts/:contactId/position
 * Mini-tree: manager, self, direct reports (for Contact detail panel).
 */
router.get('/contacts/:contactId/position', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId);

    // Look up the contact's account_id first for the visibility check
    const { pool } = require('../config/database');
    const { rows: [c] } = await pool.query(
      `SELECT account_id FROM contacts WHERE org_id = $1 AND id = $2`,
      [req.orgId, contactId]
    );
    if (!c) return res.status(404).json({ error: { message: 'Contact not found' } });

    const canView = await svc.canViewOrgChart(req.orgId, req.user.userId, c.account_id);
    if (!canView) {
      return res.status(403).json({ error: { message: 'Not authorised to view this org chart' } });
    }

    const position = await svc.getContactPosition(req.orgId, contactId);
    res.json({ position });
  } catch (err) {
    console.error('GET contact position error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/org-hierarchy/contacts/:contactId/reports-to
 * Body: { reportsToContactId: number | null }
 * Sets who a contact reports to. Pass null to make them a root node.
 */
router.patch('/contacts/:contactId/reports-to', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId);
    const { reportsToContactId } = req.body;
    const updated = await svc.setReportsTo(
      req.orgId,
      contactId,
      reportsToContactId ? parseInt(reportsToContactId) : null
    );
    res.json({ contact: updated });
  } catch (err) {
    console.error('PATCH reports-to error:', err);
    const status = err.message.includes('circular') || err.message.includes('themselves') ? 400 : 500;
    res.status(status).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/org-hierarchy/contacts/:contactId/meta
 * Body: { orgChartTitle?: string, orgChartSeniority?: number }
 */
router.patch('/contacts/:contactId/meta', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId);
    const { orgChartTitle, orgChartSeniority } = req.body;
    const updated = await svc.updateOrgChartMeta(req.orgId, contactId, {
      orgChartTitle,
      orgChartSeniority: orgChartSeniority != null ? parseInt(orgChartSeniority) : undefined,
    });
    res.json({ contact: updated });
  } catch (err) {
    console.error('PATCH org chart meta error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT HIERARCHY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/org-hierarchy/accounts/:accountId
 * Full account hierarchy tree (ancestors + descendants) centred on accountId.
 */
router.get('/accounts/:accountId', async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);
    const hierarchy = await svc.getAccountHierarchy(req.orgId, accountId);
    res.json({ hierarchy });
  } catch (err) {
    console.error('GET account hierarchy error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /api/org-hierarchy/accounts/relationship
 * Body: { parentAccountId, childAccountId, relationshipType }
 * Adds a parent→child relationship between two accounts.
 */
router.post('/accounts/relationship', async (req, res) => {
  try {
    const { parentAccountId, childAccountId, relationshipType } = req.body;
    if (!parentAccountId || !childAccountId) {
      return res.status(400).json({ error: { message: 'parentAccountId and childAccountId are required' } });
    }
    const row = await svc.addAccountRelationship(
      req.orgId,
      parseInt(parentAccountId),
      parseInt(childAccountId),
      relationshipType || 'subsidiary',
      req.user.userId
    );
    res.status(201).json({ relationship: row });
  } catch (err) {
    console.error('POST account relationship error:', err);
    const status = err.message.includes('cannot') ? 400 : 500;
    res.status(status).json({ error: { message: err.message } });
  }
});

/**
 * DELETE /api/org-hierarchy/accounts/relationship
 * Body: { parentAccountId, childAccountId }
 */
router.delete('/accounts/relationship', async (req, res) => {
  try {
    const { parentAccountId, childAccountId } = req.body;
    await svc.removeAccountRelationship(
      req.orgId,
      parseInt(parentAccountId),
      parseInt(childAccountId)
    );
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE account relationship error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ORG SETTINGS — visibility toggle (admin only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/org-hierarchy/settings/visibility
 * Body: { visibility: 'whole_org' | 'deal_team' }
 * Admin only.
 */
router.patch('/settings/visibility', async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Admin access required' } });
    }
    const { visibility } = req.body;
    if (!['whole_org', 'deal_team'].includes(visibility)) {
      return res.status(400).json({ error: { message: 'visibility must be whole_org or deal_team' } });
    }
    const { pool } = require('../config/database');
    await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'), '{org_chart_visibility}', $1::jsonb)
       WHERE id = $2`,
      [JSON.stringify(visibility), req.orgId]
    );
    res.json({ success: true, visibility });
  } catch (err) {
    console.error('PATCH visibility error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
