/**
 * moduleAccessRequests.routes.js
 * DROP-IN: backend/routes/moduleAccessRequests.routes.js
 * Mount: app.use('/api/module-requests', require('./routes/moduleAccessRequests.routes'));
 *
 *   GET  /colleagues          members the caller can request for
 *   GET  /grantable?target=ID  modules the caller can grant that colleague
 *   GET  /mine                 requests the caller has made for others
 *   POST /                     request a module for a colleague { targetUserId, moduleKey, reason? }
 *   GET  /pending              admin: pending requests for the org
 *   POST /:id/review           admin: { action:'approve'|'reject', reason? }
 */
'use strict';

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const svc               = require('../services/moduleAccessRequests.service');

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
const adminOnly = (req, res, next) => req.isAdmin ? next() : res.status(403).json({ error: { message: 'Admin only' } });

const send = (res, p) => p.then(o => res.json(o)).catch(e => res.status(e.status || 500).json({ error: { message: e.message } }));

router.get('/colleagues',  (req, res) => send(res, svc.colleagues(req.orgId, req.userId)));
router.get('/grantable',   (req, res) => send(res, svc.grantableFor(req.orgId, req.userId, parseInt(req.query.target, 10))));
router.get('/my-grantable',(req, res) => send(res, svc.myGrantableModules(req.orgId, req.userId)));
router.get('/mine',        (req, res) => send(res, svc.listMine(req.orgId, req.userId)));
router.post('/',           (req, res) => send(res, svc.request(req.orgId, req.userId, req.body || {})));
router.post('/invite-new', (req, res) => send(res, svc.requestNewUser(req.orgId, req.userId, req.body || {})));
router.get('/pending',     adminOnly, (req, res) => send(res, svc.listPending(req.orgId)));
router.post('/:id/review', adminOnly, (req, res) =>
  send(res, svc.review(req.orgId, req.userId, parseInt(req.params.id, 10), req.body?.action, req.body?.reason)));

module.exports = router;
