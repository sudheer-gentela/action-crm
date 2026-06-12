// ─────────────────────────────────────────────────────────────────────────────
// routes/tracking-domains.routes.js — Phase 7 (docs/INSIGHTS_WBR_DESIGN.md)
//
// Authenticated admin CRUD for per-customer tracking domains. Standard auth
// pattern (unlike tracking.routes.js, which is deliberately public).
//
// Mount in server.js next to the other prospecting routes:
//   app.use('/api/tracking-domains', require('./routes/tracking-domains.routes'));
//
//   GET    /api/tracking-domains          list for org (with CNAME instructions)
//   POST   /api/tracking-domains          { hostname } → pending + instructions
//   POST   /api/tracking-domains/:id/verify   DNS check → CF cert → active
//   DELETE /api/tracking-domains/:id      disable
//   GET    /api/tracking-domains/campaign/:campaignId/toggles
//   PUT    /api/tracking-domains/campaign/:campaignId/toggles  { opens, clicks }
//          (dedicated columns, D39-amended — write allowed for org owner/admin
//           or the campaign owner, mirroring configWriteGuard semantics)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const TrackingDomainService = require('../services/TrackingDomainService');

router.use(authenticateToken);
router.use(orgContext);

router.get('/', async (req, res) => {
  try {
    res.json({ domains: await TrackingDomainService.listForOrg(req.orgId) });
  } catch (err) {
    console.error('[tracking-domains] list error:', err.message);
    res.status(500).json({ error: 'Failed to list tracking domains' });
  }
});

router.post('/', async (req, res) => {
  try {
    const row = await TrackingDomainService.request(req.orgId, req.body?.hostname, req.user.userId);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/verify', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    res.json(await TrackingDomainService.verify(req.orgId, id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    res.json(await TrackingDomainService.disable(req.orgId, id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Per-campaign toggles (dedicated columns — see D39 amendment) ─────────────

const { pool } = require('../config/database');

async function loadCampaignForToggles(req, res) {
  const id = parseInt(req.params.campaignId, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid campaign id' }); return null; }
  const r = await pool.query(
    `SELECT c.id, c.owner_id, c.tracking_opens, c.tracking_clicks, ou.role
       FROM prospecting_campaigns c
       LEFT JOIN org_users ou ON ou.org_id = c.org_id AND ou.user_id = $3
      WHERE c.id = $1 AND c.org_id = $2`,
    [id, req.orgId, req.user.userId]
  );
  if (r.rows.length === 0) { res.status(404).json({ error: 'Campaign not found' }); return null; }
  return r.rows[0];
}

router.get('/campaign/:campaignId/toggles', async (req, res) => {
  try {
    const c = await loadCampaignForToggles(req, res);
    if (!c) return;
    res.json({ opens: c.tracking_opens === true, clicks: c.tracking_clicks === true });
  } catch (err) {
    console.error('[tracking-domains] toggles get error:', err.message);
    res.status(500).json({ error: 'Failed to load tracking toggles' });
  }
});

router.put('/campaign/:campaignId/toggles', async (req, res) => {
  try {
    const c = await loadCampaignForToggles(req, res);
    if (!c) return;
    const canWrite = ['owner', 'admin'].includes(c.role) || c.owner_id === req.user.userId;
    if (!canWrite) return res.status(403).json({ error: 'Only org admins or the campaign owner can change tracking' });
    const r = await pool.query(
      `UPDATE prospecting_campaigns
          SET tracking_opens = $3, tracking_clicks = $4, updated_at = now()
        WHERE id = $1 AND org_id = $2
        RETURNING tracking_opens AS opens, tracking_clicks AS clicks`,
      [c.id, req.orgId, req.body?.opens === true, req.body?.clicks === true]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[tracking-domains] toggles put error:', err.message);
    res.status(500).json({ error: 'Failed to save tracking toggles' });
  }
});

module.exports = router;
