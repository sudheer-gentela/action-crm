/**
 * whatsappBilling.routes.js
 *
 * DROP-IN LOCATION: backend/routes/whatsappBilling.routes.js
 *
 * Mount in server.js (after the whatsapp-templates mount):
 *   app.use('/api/whatsapp-billing', require('./routes/whatsappBilling.routes'));
 *
 * Org (authenticateToken + orgContext):
 *   GET  /usage?from&to        — this org's usage rollup for a period
 *   GET  /config               — this org's billing config
 *   PUT  /config               — admin: choose billing_mode / currency (A vs B)
 *
 * Superadmin (authenticateToken + requireSuperAdmin):
 *   GET  /admin/usage?from&to  — cross-org usage, cost, billed, margin
 *   PUT  /admin/config/:orgId  — set any org's mode + markup + platform fee
 */
'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { requireSuperAdmin } = require('../middleware/superAdmin.middleware');
const { pool }          = require('../config/database');
const billing           = require('../services/whatsappBilling.service');

const send = (res, p) => p
  .then(out => res.json(out))
  .catch(e => res.status(e.status || 500).json({ error: { message: e.message, code: e.code } }));

// ── Superadmin (mounted first so /admin isn't captured by orgContext) ─────────
router.get('/admin/usage', authenticateToken, requireSuperAdmin, (req, res) =>
  send(res, billing.superadminUsage(req.query.from, req.query.to)));

router.put('/admin/config/:orgId', authenticateToken, requireSuperAdmin, (req, res) =>
  send(res, billing.setConfig(parseInt(req.params.orgId, 10), req.body || {}, req.userId, true)));

// ── Org-scoped ────────────────────────────────────────────────────────────────
router.use(authenticateToken, orgContext);

async function attachAdmin(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT role FROM org_users WHERE user_id = $1 AND org_id = $2`, [req.userId, req.orgId]);
    req.isAdmin = rows[0]?.role === 'admin';
    next();
  } catch (e) { res.status(500).json({ error: { message: e.message } }); }
}

router.get('/usage',  attachAdmin, (req, res) => send(res, billing.orgUsage(req.orgId, req.query.from, req.query.to)));
router.get('/config', attachAdmin, (req, res) => send(res, billing.getConfig(req.orgId).then(config => ({ config }))));

router.put('/config', attachAdmin, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: { message: 'Admin only' } });
  // Org admins choose their billing mode; markup/platform fee stay superadmin-only.
  return send(res, billing.setConfig(req.orgId, req.body || {}, req.userId, false));
});

module.exports = router;
