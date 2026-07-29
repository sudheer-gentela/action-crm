/**
 * approvals.routes.js
 * DROP-IN: backend/routes/approvals.routes.js
 * Mount: app.use('/api/approvals', require('./routes/approvals.routes'));
 *
 *   GET  /            unified pending approvals for the org (admin)
 *   POST /review      { type, id, contextId?, action:'approve'|'reject', reason? } (admin)
 */
'use strict';

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const svc               = require('../services/approvals.service');

router.use(authenticateToken, orgContext);

async function adminOnly(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT role FROM org_users WHERE user_id = $1 AND org_id = $2`, [req.userId, req.orgId]);
    if (!['admin', 'owner'].includes(rows[0]?.role))
      return res.status(403).json({ error: { message: 'Admin only' } });
    next();
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
}
router.use(adminOnly);

const send = (res, p) => p.then(o => res.json(o)).catch(e => res.status(e.status || 500).json({ error: { message: e.message } }));

router.get('/',       (req, res) => send(res, svc.listPending(req.orgId)));
router.post('/review',(req, res) => send(res, svc.review(req.orgId, req.userId, req.body || {})));

module.exports = router;
