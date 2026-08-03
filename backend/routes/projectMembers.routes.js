/**
 * projectMembers.routes.js
 *
 * DROP-IN LOCATION: backend/routes/projectMembers.routes.js
 *
 * Mount in server.js:
 *   app.use('/api/project-members', require('./routes/projectMembers.routes'));
 *
 *   GET    /handovers/:id/members               list members (approved + pending)
 *   POST   /handovers/:id/members               request a member (auto-approve or pending)
 *   POST   /handovers/:id/members/:mid/review   admin: approve / reject(+reason)
 *   DELETE /handovers/:id/members/:mid          admin: remove
 *   GET    /domains                             list org email domains
 *   POST   /domains                             admin: add a domain
 *   DELETE /domains/:did                        admin: remove a domain
 */
'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const svc               = require('../services/projectMembers.service');

router.use(authenticateToken, orgContext);

async function attachAdmin(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT role FROM org_users WHERE user_id = $1 AND org_id = $2`, [req.userId, req.orgId]);
    req.isAdmin = ['admin', 'owner'].includes(rows[0]?.role);
    next();
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
}
router.use(attachAdmin);
const adminOnly = (req, res, next) =>
  req.isAdmin ? next() : res.status(403).json({ error: { message: 'Admin only' } });

const send = (res, p) => p
  .then(out => res.json(out))
  .catch(e => res.status(e.status || 500).json({ error: { message: e.message, code: e.code } }));

// Members
router.get('/handovers/:id/members', (req, res) =>
  send(res, svc.listForHandover(parseInt(req.params.id, 10), req.orgId)));

router.post('/handovers/:id/members', (req, res) =>
  send(res, svc.requestMember(parseInt(req.params.id, 10), req.orgId, req.userId, req.body || {})));

// Approve, reject and remove are project-scoped: an org admin OR the project's
// service owner OR its creator. adminOnly stays on the org-wide domain routes
// below, where org-admin really is the right bar.
const canManage = async (req, res, next) => {
  try {
    const ok = req.isAdmin ||
      await svc.canManageProject(parseInt(req.params.id, 10), req.orgId, req.userId);
    return ok ? next() : res.status(403).json({
      error: { message: 'Only an org admin, the service owner or the project creator can do that' },
    });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
};

// Whether the caller may staff this project, and whether auto-approve is
// actually available. Lets the UI warn about missing org domains up front
// rather than after an add silently lands in 'pending'.
router.get('/handovers/:id/members/permissions', async (req, res) => {
  try {
    const [canManageProject, decision] = await Promise.all([
      svc.canManageProject(parseInt(req.params.id, 10), req.orgId, req.userId),
      svc.autoApproveDecision(req.orgId, req.userId),
    ]);
    const { domains } = await svc.listDomains(req.orgId);
    res.json({
      canManage: req.isAdmin || canManageProject,
      isOrgAdmin: req.isAdmin,
      orgDomainsConfigured: domains.length > 0,
      autoApprove: decision,
    });
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

// A member declining an invitation or leaving. Self-service by definition, so
// no permission gate — the service refuses if the caller is not on the project.
router.post('/handovers/:id/members/me/exit', (req, res) =>
  send(res, svc.selfExit(parseInt(req.params.id, 10), req.orgId, req.userId, req.body?.reason)));

router.post('/handovers/:id/members/:mid/review', canManage, (req, res) =>
  send(res, svc.reviewMember(parseInt(req.params.id, 10), req.orgId, req.userId,
    parseInt(req.params.mid, 10), req.body?.action, req.body?.reason)));

router.patch('/handovers/:id/members/:mid', canManage, (req, res) =>
  send(res, svc.changeRole(parseInt(req.params.id, 10), req.orgId,
    parseInt(req.params.mid, 10), req.body || {})));

router.delete('/handovers/:id/members/:mid', canManage, (req, res) =>
  send(res, svc.removeMember(parseInt(req.params.id, 10), req.orgId, parseInt(req.params.mid, 10))));

// Org email domains
router.get('/domains', (req, res) => send(res, svc.listDomains(req.orgId)));
router.post('/domains', adminOnly, (req, res) => send(res, svc.addDomain(req.orgId, req.userId, req.body?.domain)));
router.delete('/domains/:did', adminOnly, (req, res) => send(res, svc.removeDomain(req.orgId, parseInt(req.params.did, 10))));

module.exports = router;
