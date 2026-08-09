// ─────────────────────────────────────────────────────────────────────────────
// routes/accountRelationships.routes.js   → /api/account-relationships
//
// Vendors and partners. They are ACCOUNTS carrying a relationship, so the
// listing returns the account shape and the Vendors screen is the Accounts
// screen with one join.
//
//   GET    /vendors                 vendor accounts  (?status=active|pending|all)
//   GET    /partners                partner accounts
//   GET    /account/:accountId      every relationship one account holds
//   GET    /account/:accountId/projects
//                                   projects this account is on, with the SIDE
//                                   it holds per project — SCOPED to what the
//                                   caller may see
//   POST   /                        request  { accountId, relationship, notes }
//   POST   /:id/review              approve / reject   (approver only)
//   POST   /:id/end                 end an active relationship (approver only)
//   GET    /policy                  who may approve
//   PUT    /policy                  set approvers      (admin)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const svc               = require('../services/accountRelationships.service');
const { pool }          = require('../config/database');

router.use(authenticateToken, orgContext);

const fail = (res, err) => {
  console.error('[account-relationships]', err.message);
  res.status(err.status || 500).json({ error: { message: err.message } });
};

router.get('/vendors', async (req, res) => {
  try { res.json(await svc.listAccounts(req.orgId, 'vendor', { status: req.query.status || 'active' })); }
  catch (err) { fail(res, err); }
});

router.get('/partners', async (req, res) => {
  try { res.json(await svc.listAccounts(req.orgId, 'partner', { status: req.query.status || 'active' })); }
  catch (err) { fail(res, err); }
});

router.get('/account/:accountId', async (req, res) => {
  try { res.json(await svc.listForAccount(req.orgId, parseInt(req.params.accountId, 10))); }
  catch (err) { fail(res, err); }
});

// Scoped read: the registry is org-wide, but engagements are not. The service
// applies the same visibility rule as the project list.
router.get('/account/:accountId/projects', async (req, res) => {
  try {
    res.json(await svc.listProjectsForAccount(
      req.orgId,
      req.user.userId,
      parseInt(req.params.accountId, 10),
      req.subordinateIds || []
    ));
  } catch (err) { fail(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const { accountId, relationship, notes } = req.body || {};
    res.status(201).json(await svc.request(req.orgId, req.user.userId, { accountId, relationship, notes }));
  } catch (err) { fail(res, err); }
});

router.post('/:id/review', async (req, res) => {
  try {
    const { action, reason } = req.body || {};
    res.json(await svc.review(req.orgId, req.user.userId, parseInt(req.params.id, 10), action, reason));
  } catch (err) { fail(res, err); }
});

router.post('/:id/end', async (req, res) => {
  try { res.json(await svc.end(req.orgId, req.user.userId, parseInt(req.params.id, 10))); }
  catch (err) { fail(res, err); }
});

router.get('/policy', async (req, res) => {
  try {
    res.json({
      policy: await svc.getApprovalPolicy(req.orgId),
      canApprove: await svc.canApprove(req.orgId, req.user.userId),
    });
  } catch (err) { fail(res, err); }
});

router.put('/policy', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [req.orgId, req.user.userId]);
    if (!['owner', 'admin'].includes(rows[0]?.role)) {
      return res.status(403).json({ error: { message: 'Only an org admin can set approvers' } });
    }
    res.json({ policy: await svc.setApprovalPolicy(req.orgId, req.body || {}) });
  } catch (err) { fail(res, err); }
});

module.exports = router;
