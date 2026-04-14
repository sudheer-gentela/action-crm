/**
 * salesforce.routes.js
 *
 * DROP-IN LOCATION: backend/routes/salesforce.routes.js
 * Mount in server.js: app.use('/api/salesforce', salesforceRoutes);
 *
 * Endpoints:
 *   GET  /connect              → Start OAuth flow (org admin only)
 *   GET  /callback             → OAuth callback (no auth — public redirect)
 *   GET  /status               → Connection status + last sync info
 *   POST /disconnect           → Revoke token and clear connection
 *   POST /trigger              → Manual sync trigger
 *   GET  /describe/:object     → SF object fields (for field mapping UI)
 *   GET  /settings             → Get org integration settings
 *   PATCH /settings            → Update stage_map, field_map, sync_mode, write_back config
 */

const express          = require('express');
const router           = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }   = require('../middleware/orgContext.middleware');
const { pool }         = require('../config/database');
const sfAuth           = require('../services/salesforce.auth');
const sfSync           = require('../services/salesforce.sync.service');
const { createClient } = require('../services/salesforce.client');

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://app.gowarmcrm.com';

// ── Public: OAuth callback (no auth middleware) ───────────────────────────────

router.get('/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    console.error('SF OAuth error:', oauthError);
    return res.redirect(`${FRONTEND_URL}/?error=salesforce_auth_failed&message=${encodeURIComponent(oauthError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_URL}/?error=salesforce_auth_failed&message=missing_params`);
  }

  try {
    await sfAuth.exchangeCode(code, state);
    return res.redirect(`${FRONTEND_URL}/?salesforce_connected=true`);
  } catch (err) {
    console.error('SF OAuth callback error:', err.message);
    return res.redirect(`${FRONTEND_URL}/?error=salesforce_auth_failed&message=${encodeURIComponent(err.message)}`);
  }
});

// ── All other routes require auth + org context ───────────────────────────────

router.use(authenticateToken);
router.use(orgContext);

// GET /connect — initiate OAuth (org admin initiates, token stored org-level)
router.get('/connect', async (req, res) => {
  try {
    const authUrl = sfAuth.getAuthUrl(req.user.userId, req.orgId);
    res.json({ success: true, authUrl });
  } catch (err) {
    console.error('SF connect error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /status
router.get('/status', async (req, res) => {
  try {
    const status = await sfAuth.getConnectionStatus(req.orgId);
    res.json({ success: true, data: status });
  } catch (err) {
    console.error('SF status error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /disconnect
router.post('/disconnect', async (req, res) => {
  try {
    await sfAuth.revokeToken(req.orgId);
    res.json({ success: true, message: 'Salesforce disconnected' });
  } catch (err) {
    console.error('SF disconnect error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /trigger — manual sync
router.post('/trigger', async (req, res) => {
  try {
    const status = await sfAuth.getConnectionStatus(req.orgId);
    if (!status.connected) {
      return res.status(400).json({ success: false, error: 'Salesforce is not connected' });
    }

    // Run async — don't wait for completion (sync can take minutes)
    sfSync.runSyncForOrg(req.orgId)
      .then(r  => console.log(`Manual SF sync completed for org ${req.orgId}:`, r))
      .catch(e => console.error(`Manual SF sync error for org ${req.orgId}:`, e.message));

    res.json({ success: true, message: 'Sync started — check status in a few minutes' });
  } catch (err) {
    console.error('SF trigger error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /describe/:object — fetch SF object fields for field mapping UI
router.get('/describe/:object', async (req, res) => {
  const ALLOWED_OBJECTS = ['Contact', 'Account', 'Opportunity', 'Lead', 'Task'];
  const sfObject = req.params.object;

  if (!ALLOWED_OBJECTS.includes(sfObject)) {
    return res.status(400).json({ success: false, error: `Object must be one of: ${ALLOWED_OBJECTS.join(', ')}` });
  }

  try {
    const sf     = await createClient(req.orgId);
    const fields = await sf.describeObject(sfObject);
    res.json({ success: true, data: { object: sfObject, fields } });
  } catch (err) {
    console.error(`SF describe ${sfObject} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /settings — full org integration settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT settings, instance_url, connected_at, last_sync_at, sync_status
       FROM org_integrations WHERE org_id = $1 AND provider = 'salesforce'`,
      [req.orgId]
    );
    if (result.rows.length === 0) {
      return res.json({ success: true, data: { exists: false } });
    }
    res.json({ success: true, data: { exists: true, ...result.rows[0] } });
  } catch (err) {
    console.error('SF settings get error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /settings — update stage_map, field_map, sync_mode, write_back config
router.patch('/settings', async (req, res) => {
  const ALLOWED_KEYS = [
    'sf_sync_mode', 'write_back_enabled', 'write_back_mode',
    'sync_objects', 'stage_map', 'field_map',
  ];

  const updates = {};
  for (const key of ALLOWED_KEYS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid settings keys provided' });
  }

  // Validate sf_sync_mode
  if (updates.sf_sync_mode && !['bidirectional', 'sf_primary', 'gowarm_primary'].includes(updates.sf_sync_mode)) {
    return res.status(400).json({ success: false, error: 'sf_sync_mode must be bidirectional, sf_primary, or gowarm_primary' });
  }

  // Validate write_back_mode
  if (updates.write_back_mode && !['nightly', 'realtime'].includes(updates.write_back_mode)) {
    return res.status(400).json({ success: false, error: 'write_back_mode must be nightly or realtime' });
  }

  // Check SuperAdmin has enabled write-back globally before allowing org to enable it
  if (updates.write_back_enabled === true) {
    const platformRes = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'sf_write_back_enabled'`
    ).catch(() => ({ rows: [] }));
    const globalEnabled = platformRes.rows[0]?.value?.enabled || false;
    if (!globalEnabled) {
      return res.status(403).json({
        success: false,
        error: 'Salesforce write-back is not enabled on this platform. Contact your GoWarm administrator.',
      });
    }
  }

  try {
    // Merge updates into existing settings JSONB
    const setExpressions = Object.entries(updates).map(([key], i) => `$${i + 2}`);
    const paths = Object.keys(updates).map(k => `{${k}}`);

    // Build jsonb_set chain
    let settingsExpr = 'settings';
    const params = [req.orgId];
    Object.entries(updates).forEach(([key, val], i) => {
      settingsExpr = `jsonb_set(${settingsExpr}, '{${key}}', $${i + 2}::jsonb)`;
      params.push(JSON.stringify(val));
    });

    await pool.query(
      `UPDATE org_integrations SET settings = ${settingsExpr}, updated_at = NOW() WHERE org_id = $1 AND provider = 'salesforce'`,
      params
    );

    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    console.error('SF settings patch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /locked-fields/:entity — return locked fields for given entity in this org
// Called by frontend forms to know which fields to disable
router.get('/locked-fields/:entity', async (req, res) => {
  const ALLOWED = ['deal', 'contact', 'account', 'prospect'];
  if (!ALLOWED.includes(req.params.entity)) {
    return res.json({ success: true, data: [] });
  }
  try {
    const { getLockedFieldsForOrg } = require('../middleware/sfReadonly.middleware');
    const fields = await getLockedFieldsForOrg(req.orgId, req.params.entity);
    res.json({ success: true, data: fields });
  } catch (err) {
    res.json({ success: true, data: [] }); // Non-blocking — fail open
  }
});

// GET /identity-queue — pending identity resolution actions for this org
router.get('/identity-queue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ci.id, ci.identity_type, ci.identity_value, ci.confidence, ci.created_at,
             ci.canonical_contact_id, ci.canonical_prospect_id,
             a.id AS action_id, a.title AS action_title, a.deal_id,
             d.name AS deal_name
      FROM contact_identities ci
      LEFT JOIN actions a ON a.source = 'salesforce_sync' AND a.source_id = ci.identity_value AND a.org_id = $1
      LEFT JOIN deals d ON d.id = a.deal_id
      WHERE ci.org_id = $1 AND ci.status = 'pending_review'
      ORDER BY ci.created_at DESC
      LIMIT 50
    `, [req.orgId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('SF identity queue error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /identity-queue/:id/resolve — confirm or reject a pending identity match
router.post('/identity-queue/:id/resolve', async (req, res) => {
  const { action } = req.body; // 'confirm' | 'reject' | 'create_new'
  if (!['confirm', 'reject', 'create_new'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be confirm, reject, or create_new' });
  }

  try {
    const ciRes = await pool.query(
      `SELECT * FROM contact_identities WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (ciRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Identity record not found' });
    }

    const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
    await pool.query(`
      UPDATE contact_identities
      SET status = $2, confirmed_by = $3, confirmed_at = NOW()
      WHERE id = $1
    `, [req.params.id, newStatus, req.user.userId]);

    // Complete the identity resolution action on the deal
    await pool.query(`
      UPDATE actions
      SET completed = true, completed_at = NOW(), updated_at = NOW()
      WHERE source = 'salesforce_sync' AND source_id = $1 AND org_id = $2
    `, [ciRes.rows[0].identity_value, req.orgId]);

    res.json({ success: true, message: `Identity ${newStatus}` });
  } catch (err) {
    console.error('SF identity resolve error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
