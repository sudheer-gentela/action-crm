// routes/orgHierarchy.routes.js
// Mount in server.js: app.use('/api/org-hierarchy', require('./routes/orgHierarchy.routes'));

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const svc = require('../services/orgHierarchyService');

router.use(authenticateToken);
router.use(orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT ORG CHART
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/org-hierarchy/contacts/account/:accountId
// Returns { tree, unplaced }
router.get('/contacts/account/:accountId', async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    const canView = await svc.canViewOrgChart(req.orgId, req.user.userId, accountId);
    if (!canView) return res.status(403).json({ error: { message: 'Not authorised to view this org chart' } });
    const { tree, unplaced } = await svc.getContactOrgChart(req.orgId, accountId);
    res.json({ tree, unplaced });
  } catch (err) {
    console.error('GET contact org chart error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// GET /api/org-hierarchy/contacts/:contactId/position
// Returns { position } with manager, directReports, dottedManagers, dottedReports
router.get('/contacts/:contactId/position', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId, 10);
    const { rows: [c] } = await (require('../config/database').pool).query(
      'SELECT account_id FROM contacts WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL',
      [req.orgId, contactId]
    );
    if (!c) return res.status(404).json({ error: { message: 'Contact not found' } });
    const canView = await svc.canViewOrgChart(req.orgId, req.user.userId, c.account_id);
    if (!canView) return res.status(403).json({ error: { message: 'Not authorised' } });
    const position = await svc.getContactPosition(req.orgId, contactId);
    if (!position) return res.status(404).json({ error: { message: 'Contact not found' } });
    res.json({ position });
  } catch (err) {
    console.error('GET contact position error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// PATCH /api/org-hierarchy/contacts/:contactId/reports-to
// Body: { reportsToContactId, confidence? }  confidence: 'confirmed'|'best_guess'
router.patch('/contacts/:contactId/reports-to', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId, 10);
    const { reportsToContactId, confidence } = req.body;
    const updated = await svc.setReportsTo(
      req.orgId,
      contactId,
      reportsToContactId ? parseInt(reportsToContactId, 10) : null,
      confidence || 'confirmed'
    );
    res.json({ contact: updated });
  } catch (err) {
    console.error('PATCH reports-to error:', err);
    const status = err.message.includes('circular') || err.message.includes('themselves') ? 400 : 500;
    res.status(status).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DOTTED-LINE RELATIONSHIPS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/org-hierarchy/contacts/:contactId/dotted-lines
// Body: { dottedManagerId, notes? }
router.post('/contacts/:contactId/dotted-lines', async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId, 10);
    const { dottedManagerId, notes } = req.body;
    if (!dottedManagerId) return res.status(400).json({ error: { message: 'dottedManagerId is required' } });
    const row = await svc.addDottedLine(req.orgId, contactId, parseInt(dottedManagerId, 10), notes);
    res.status(201).json({ dottedLine: row });
  } catch (err) {
    console.error('POST dotted-line error:', err);
    const status = err.message.includes('not found') || err.message.includes('themselves') ? 400 : 500;
    res.status(status).json({ error: { message: err.message } });
  }
});

// DELETE /api/org-hierarchy/contacts/:contactId/dotted-lines?dottedManagerId=X
router.delete('/contacts/:contactId/dotted-lines', async (req, res) => {
  try {
    const contactId      = parseInt(req.params.contactId, 10);
    const dottedManagerId = parseInt(req.query.dottedManagerId, 10);
    if (isNaN(contactId) || isNaN(dottedManagerId)) {
      return res.status(400).json({ error: { message: 'contactId and dottedManagerId are required' } });
    }
    const removed = await svc.removeDottedLine(req.orgId, contactId, dottedManagerId);
    if (!removed) return res.status(404).json({ error: { message: 'Dotted-line not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE dotted-line error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT HIERARCHY
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/org-hierarchy/accounts/:accountId
router.get('/accounts/:accountId', async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    const canView = await svc.canViewOrgChart(req.orgId, req.user.userId, accountId);
    if (!canView) return res.status(403).json({ error: { message: 'Not authorised' } });
    const hierarchy = await svc.getAccountHierarchy(req.orgId, accountId);
    res.json({ hierarchy });
  } catch (err) {
    console.error('GET account hierarchy error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// POST /api/org-hierarchy/accounts/relationship
// Body: { parentAccountId, childAccountId, relationshipType }
router.post('/accounts/relationship', async (req, res) => {
  try {
    const { parentAccountId, childAccountId, relationshipType } = req.body;
    if (!parentAccountId || !childAccountId) {
      return res.status(400).json({ error: { message: 'parentAccountId and childAccountId are required' } });
    }
    const row = await svc.addAccountRelationship(
      req.orgId,
      parseInt(parentAccountId, 10),
      parseInt(childAccountId, 10),
      relationshipType,
      req.user.userId
    );
    res.status(201).json({ relationship: row });
  } catch (err) {
    console.error('POST account relationship error:', err);
    res.status(err.message.includes('cannot') ? 400 : 500).json({ error: { message: err.message } });
  }
});

// DELETE /api/org-hierarchy/accounts/relationship?parentAccountId=X&childAccountId=Y
router.delete('/accounts/relationship', async (req, res) => {
  try {
    const parentAccountId = parseInt(req.query.parentAccountId, 10);
    const childAccountId  = parseInt(req.query.childAccountId, 10);
    console.log('DELETE relationship:', { raw: req.query, parsed: { parentAccountId, childAccountId } });
    if (isNaN(parentAccountId) || isNaN(childAccountId)) {
      return res.status(400).json({ error: { message: `parentAccountId and childAccountId are required (got: ${JSON.stringify(req.query)})` } });
    }
    await svc.removeAccountRelationship(req.orgId, parentAccountId, childAccountId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE account relationship error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
