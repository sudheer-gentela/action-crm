/**
 * hubspot.routes.js
 *
 * DROP-IN LOCATION: backend/routes/hubspot.routes.js
 * Mount in server.js: app.use('/api/hubspot', require('./routes/hubspot.routes'));
 *
 * Endpoints:
 *   GET  /connect       → Start OAuth flow
 *   GET  /callback      → OAuth callback (public — no auth)
 *   GET  /status        → Connection status + last sync info
 *   POST /disconnect    → Revoke token and clear connection
 *   POST /trigger       → Manual sync trigger
 *   GET  /stages        → Live deal pipeline stage values (for Stage Mapping UI)
 *   GET  /settings      → Get org integration settings
 *   PATCH /settings     → Update stage_map, field_map, sync_objects
 */

const express           = require('express');
const router            = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { pool }          = require('../config/database');
const hsAuth            = require('../services/hubspot.auth');
const crmSync           = require('../services/crm');

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://app.gowarmcrm.com';

// ── Public: OAuth callback ────────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(
      `${FRONTEND_URL}/?error=hubspot_auth_failed&message=${encodeURIComponent(oauthError)}`
    );
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/?error=hubspot_auth_failed&message=missing_params`);
  }

  try {
    await hsAuth.exchangeCode(code, state);
    return res.redirect(`${FRONTEND_URL}/?hubspot_connected=true`);
  } catch (err) {
    console.error('HubSpot OAuth callback error:', err.message);
    return res.redirect(
      `${FRONTEND_URL}/?error=hubspot_auth_failed&message=${encodeURIComponent(err.message)}`
    );
  }
});

// ── All other routes require auth + org context ───────────────────────────────

router.use(authenticateToken);
router.use(orgContext);

// GET /connect
router.get('/connect', async (req, res) => {
  try {
    const authUrl = hsAuth.getAuthUrl(req.user.userId, req.orgId);
    res.json({ success: true, authUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /status
router.get('/status', async (req, res) => {
  try {
    const status = await hsAuth.getConnectionStatus(req.orgId);
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /disconnect
router.post('/disconnect', async (req, res) => {
  try {
    await hsAuth.revokeToken(req.orgId);
    res.json({ success: true, message: 'HubSpot disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /trigger — manual sync
router.post('/trigger', async (req, res) => {
  try {
    const status = await hsAuth.getConnectionStatus(req.orgId);
    if (!status.connected) {
      return res.status(400).json({ success: false, error: 'HubSpot is not connected' });
    }

    crmSync.runSyncForOrg(req.orgId, 'hubspot')
      .then(r  => console.log(`Manual HubSpot sync completed for org ${req.orgId}:`, r.results))
      .catch(e => console.error(`Manual HubSpot sync error for org ${req.orgId}:`, e.message));

    res.json({ success: true, message: 'Sync started — check status in a few minutes' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /stages — live deal pipeline stages for Stage Mapping UI
router.get('/stages', async (req, res) => {
  try {
    const { createHubSpotAdapter } = require('../services/crm/adapters/hubspot.adapter');
    const adapter = await createHubSpotAdapter(req.orgId);
    const stages  = await adapter.getOpportunityStages();
    res.json({ success: true, data: stages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT settings, instance_url, connected_at, last_sync_at, sync_status
       FROM org_integrations WHERE org_id = $1 AND integration_type = 'hubspot'`,
      [req.orgId]
    );
    if (result.rows.length === 0) {
      return res.json({ success: true, data: { exists: false } });
    }
    res.json({ success: true, data: { exists: true, ...result.rows[0] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /settings — update stage_map, field_map, sync_objects
router.patch('/settings', async (req, res) => {
  const ALLOWED_KEYS = ['sync_objects', 'stage_map', 'field_map'];

  const updates = {};
  for (const key of ALLOWED_KEYS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid settings keys provided' });
  }

  try {
    let settingsExpr = 'settings';
    const params = [req.orgId];
    Object.entries(updates).forEach(([key, val], i) => {
      settingsExpr = `jsonb_set(${settingsExpr}, '{${key}}', $${i + 2}::jsonb)`;
      params.push(JSON.stringify(val));
    });

    await pool.query(
      `UPDATE org_integrations SET settings = ${settingsExpr}, updated_at = NOW()
       WHERE org_id = $1 AND integration_type = 'hubspot'`,
      params
    );

    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
