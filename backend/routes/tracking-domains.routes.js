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
//          → { opens, clicks, can_write }  (can_write lets the UI enable/disable
//            the checkboxes without an optimistic-then-revert round trip)
//   PUT    /api/tracking-domains/campaign/:campaignId/toggles  { opens, clicks }
//          Write allowed for the campaign owner, ANY manager of the owner, or an
//          org owner/admin (CampaignAccess.canToggleTracking — deliberately
//          broader than config writes; managers oversee their reps' tracking).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const TrackingDomainService = require('../services/TrackingDomainService');
const CampaignAccess = require('../services/CampaignAccess');

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
  if (!Number.isInteger(id)) { res.status(400).json({ error: { message: 'Invalid campaign id' } }); return null; }
  const r = await pool.query(
    `SELECT id, owner_id, tracking_opens, tracking_clicks
       FROM prospecting_campaigns
      WHERE id = $1 AND org_id = $2`,
    [id, req.orgId]
  );
  if (r.rows.length === 0) { res.status(404).json({ error: { message: 'Campaign not found' } }); return null; }
  return r.rows[0];
}

router.get('/campaign/:campaignId/toggles', async (req, res) => {
  try {
    const c = await loadCampaignForToggles(req, res);
    if (!c) return;
    const { allowed } = await CampaignAccess.canToggleTracking(req, c);
    res.json({
      opens: c.tracking_opens === true,
      clicks: c.tracking_clicks === true,
      can_write: allowed,
    });
  } catch (err) {
    console.error('[tracking-domains] toggles get error:', err.message);
    res.status(500).json({ error: { message: 'Failed to load tracking toggles' } });
  }
});

router.put('/campaign/:campaignId/toggles', async (req, res) => {
  try {
    const c = await loadCampaignForToggles(req, res);
    if (!c) return;
    const { allowed, reason } = await CampaignAccess.canToggleTracking(req, c);
    if (!allowed) return res.status(403).json({ error: { message: reason } });
    const r = await pool.query(
      `UPDATE prospecting_campaigns
          SET tracking_opens = $3, tracking_clicks = $4, updated_at = now()
        WHERE id = $1 AND org_id = $2
        RETURNING tracking_opens AS opens, tracking_clicks AS clicks`,
      [c.id, req.orgId, req.body?.opens === true, req.body?.clicks === true]
    );
    res.json({ opens: r.rows[0].opens === true, clicks: r.rows[0].clicks === true, can_write: true });
  } catch (err) {
    console.error('[tracking-domains] toggles put error:', err.message);
    res.status(500).json({ error: { message: 'Failed to save tracking toggles' } });
  }
});

module.exports = router;
