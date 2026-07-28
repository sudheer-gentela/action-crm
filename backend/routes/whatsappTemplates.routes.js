/**
 * whatsappTemplates.routes.js
 *
 * DROP-IN LOCATION: backend/routes/whatsappTemplates.routes.js
 *
 * Mount in server.js (right after the whatsapp mount):
 *   app.use('/api/whatsapp-templates', require('./routes/whatsappTemplates.routes'));
 *
 * All routes: authenticateToken + orgContext.
 *   GET  /mine            — the caller's own proposals + outcomes
 *   GET  /all             — every template in the org (admin: review screen)
 *   GET  /usable          — Meta-approved + internally-approved + visible (composer/pickers)
 *   POST /                — propose (admins author + auto-submit; others propose)
 *   POST /:id/review      — admin approve (→ Meta) or reject (with reason)
 *   POST /:id/submit      — admin resubmit an internally-approved template to Meta
 */
'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const templates         = require('../services/whatsappTemplates.service');

router.use(authenticateToken);
router.use(orgContext);

// Resolve the caller's org role once per request.
async function attachRole(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT role FROM org_users WHERE user_id = $1 AND org_id = $2`,
      [req.userId, req.orgId]);
    req.orgRole = rows[0]?.role || null;
    req.isAdmin = req.orgRole === 'admin';
    next();
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
}
router.use(attachRole);

function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: { message: 'Admin only' } });
  next();
}

const send = (res, p) => p
  .then(out => res.json(out))
  .catch(e => res.status(e.status || 500).json({ error: { message: e.message, code: e.code } }));

router.get('/mine',   (req, res) => send(res, templates.listMine(req.orgId, req.userId)));
router.get('/all',    adminOnly, (req, res) => send(res, templates.listAll(req.orgId)));
router.get('/usable', (req, res) => send(res, templates.listUsable(req.orgId, req.userId)));

router.post('/', (req, res) => send(res, templates.propose(req.orgId, req.userId, req.isAdmin, req.body || {})));

router.post('/:id/review', adminOnly, (req, res) =>
  send(res, templates.review(req.orgId, req.userId, parseInt(req.params.id, 10),
    req.body?.action, req.body?.reason)));

router.post('/:id/submit', adminOnly, (req, res) =>
  send(res, templates.submitToMeta(req.orgId, parseInt(req.params.id, 10))));

module.exports = router;
