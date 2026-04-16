// ─────────────────────────────────────────────────────────────────────────────
// routes/prospecting-senders.routes.js
//
// Manages prospecting sender accounts (Gmail / Outlook accounts used to send
// outreach emails). Separate from oauth_tokens — these are accounts the user
// explicitly connects for prospecting, with per-sender rate limits.
//
// Mount in server.js:
//   const prospectingSendersRoutes = require('./routes/prospecting-senders.routes');
//   app.use('/api/prospecting-senders', prospectingSendersRoutes);
// ─────────────────────────────────────────────────────────────────────────────

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

// Google + Outlook OAuth helpers (reuse existing services)
const { getAuthUrl: getGoogleAuthUrl }   = require('../services/googleService');
const { getAuthUrl: getOutlookAuthUrl }  = require('../services/outlookService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// ── Row mapper ────────────────────────────────────────────────────────────────
// Tokens are NEVER returned to the frontend
function mapSenderRow(row) {
  return {
    id:                 row.id,
    orgId:              row.org_id,
    userId:             row.user_id,
    provider:           row.provider,
    email:              row.email,
    label:              row.label,
    isActive:           row.is_active,
    dailyLimit:         row.daily_limit,
    minDelayMinutes:    row.min_delay_minutes,
    emailsSentToday:    row.emails_sent_today,
    lastResetAt:        row.last_reset_at,
    lastSentAt:         row.last_sent_at,
    displayName:        row.display_name,
    signature:          row.signature,
    linkedinSignature:  row.linkedin_signature,
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
  };
}

// ── GET / — list sender accounts for the current user ────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM prospecting_sender_accounts
       WHERE org_id = $1 AND user_id = $2
       ORDER BY created_at ASC`,
      [req.orgId, req.user.userId]
    );
    res.json({ senders: result.rows.map(mapSenderRow) });
  } catch (error) {
    console.error('List senders error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch sender accounts' } });
  }
});

// ── GET /org-limits — fetch org-level outreach ceiling config ─────────────────
// Used by SettingsView to display limits to the user
router.get('/org-limits', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT config FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );

    const config = result.rows[0]?.config || {
      dailyLimitCeiling:      100,
      minDelayMinutesCeiling: 2,
      defaultDailyLimit:      50,
      defaultMinDelayMinutes: 5,
    };

    res.json({ limits: config });
  } catch (error) {
    console.error('Get org limits error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch org limits' } });
  }
});

// ── GET /connect-url — generate OAuth URL for connecting a sender account ────
// ?provider=gmail|outlook  &label=optional label
// The OAuth callback (google.routes.js / outlook.routes.js) detects
// mode=prospecting in state and saves to prospecting_sender_accounts instead
// of oauth_tokens.
router.get('/connect-url', async (req, res) => {
  try {
    const { provider, label } = req.query;

    if (!['gmail', 'outlook'].includes(provider)) {
      return res.status(400).json({ error: { message: 'provider must be gmail or outlook' } });
    }

    const state = Buffer.from(JSON.stringify({
      userId:    req.user.userId,
      orgId:     req.orgId,
      mode:      'prospecting',
      label:     label || null,
      timestamp: Date.now(),
    })).toString('base64');

    let authUrl;
    if (provider === 'gmail') {
      authUrl = getGoogleAuthUrl(state);
    } else {
      authUrl = await getOutlookAuthUrl(state);
    }

    res.json({ authUrl });
  } catch (error) {
    console.error('Connect URL error:', error);
    res.status(500).json({ error: { message: 'Failed to generate connect URL' } });
  }
});

// ── PATCH /:id — update label, limits, active status, display_name, signature ─
router.patch('/:id', async (req, res) => {
  try {
    const { label, isActive, dailyLimit, minDelayMinutes, displayName, signature, linkedinSignature } = req.body;

    // Load org ceiling so we can enforce it on any incoming limit
    const limitsResult = await db.query(
      `SELECT config FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );
    const orgConfig = limitsResult.rows[0]?.config || {};
    const ceiling     = orgConfig.dailyLimitCeiling      || 100;
    const delayCeiling = orgConfig.minDelayMinutesCeiling || 2;

    // Clamp incoming values to org ceiling
    let effectiveDailyLimit      = dailyLimit      !== undefined ? parseInt(dailyLimit)      : undefined;
    let effectiveMinDelayMinutes = minDelayMinutes !== undefined ? parseInt(minDelayMinutes) : undefined;

    if (effectiveDailyLimit !== undefined && effectiveDailyLimit > ceiling) {
      return res.status(400).json({
        error: { message: `Daily limit cannot exceed org ceiling of ${ceiling}` }
      });
    }
    if (effectiveMinDelayMinutes !== undefined && effectiveMinDelayMinutes < delayCeiling) {
      return res.status(400).json({
        error: { message: `Min delay cannot be less than org minimum of ${delayCeiling} minutes` }
      });
    }

    const fields = [];
    const values = [];
    let idx = 1;

    const maybeSet = (col, val) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };

    maybeSet('label',              label);
    maybeSet('is_active',          isActive);
    maybeSet('daily_limit',        effectiveDailyLimit);
    maybeSet('min_delay_minutes',  effectiveMinDelayMinutes);
    maybeSet('display_name',       displayName);
    maybeSet('signature',          signature);
    maybeSet('linkedin_signature', linkedinSignature);

    if (fields.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id, req.orgId, req.user.userId);

    const result = await db.query(
      `UPDATE prospecting_sender_accounts
       SET ${fields.join(', ')}
       WHERE id = $${idx++} AND org_id = $${idx++} AND user_id = $${idx}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Sender account not found' } });
    }

    res.json({ sender: mapSenderRow(result.rows[0]) });
  } catch (error) {
    console.error('Update sender error:', error);
    res.status(500).json({ error: { message: 'Failed to update sender account' } });
  }
});

// ── DELETE /:id — remove a sender account ────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM prospecting_sender_accounts
       WHERE id = $1 AND org_id = $2 AND user_id = $3
       RETURNING id, email`,
      [req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Sender account not found' } });
    }

    console.log(`🗑️  Prospecting sender removed: ${result.rows[0].email} (user ${req.user.userId})`);
    res.json({ message: 'Sender account removed successfully' });
  } catch (error) {
    console.error('Delete sender error:', error);
    res.status(500).json({ error: { message: 'Failed to remove sender account' } });
  }
});

// ── POST /:id/validate — test whether the sender account token is still live ──
// Called by Settings → Outreach when the page loads, so stale accounts are
// flagged before a send attempt rather than after.
// Returns { valid: true } or { valid: false, reason: '...' }
router.post('/:id/validate', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM prospecting_sender_accounts
        WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [req.params.id, req.orgId, req.user.userId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'Sender account not found' } });
    }
    const sender = result.rows[0];

    if (!sender.refresh_token) {
      return res.json({ valid: false, reason: 'No refresh token — please reconnect this account.' });
    }

    // Try a lightweight token refresh to confirm the credential is still valid
    const axios = require('axios');
    if (sender.provider === 'gmail') {
      try {
        const params = new URLSearchParams({
          client_id:     process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: sender.refresh_token,
          grant_type:    'refresh_token',
        });
        const response = await axios.post(
          'https://oauth2.googleapis.com/token',
          params.toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        // Persist the fresh access token
        await db.query(
          `UPDATE prospecting_sender_accounts
              SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3`,
          [response.data.access_token, new Date(Date.now() + response.data.expires_in * 1000), sender.id]
        );
        return res.json({ valid: true });
      } catch (err) {
        const isRevoked = /invalid_grant|Token has been expired or revoked/i.test(
          err.response?.data?.error || err.message
        );
        return res.json({
          valid: false,
          reason: isRevoked
            ? 'Access was revoked — please reconnect this account.'
            : `Token validation failed: ${err.message}`,
        });
      }
    }

    // Outlook — attempt a refresh via tokenService
    if (sender.provider === 'outlook') {
      try {
        const tenantId = process.env.MICROSOFT_TENANT_ID;
        const params = new URLSearchParams({
          client_id:     process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          refresh_token: sender.refresh_token,
          grant_type:    'refresh_token',
          scope:         'https://graph.microsoft.com/Mail.Send offline_access',
        });
        const response = await axios.post(
          `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          params.toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        await db.query(
          `UPDATE prospecting_sender_accounts
              SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3`,
          [response.data.access_token, new Date(Date.now() + response.data.expires_in * 1000), sender.id]
        );
        return res.json({ valid: true });
      } catch (err) {
        const isRevoked = /invalid_grant|AADSTS/i.test(err.response?.data?.error || err.message);
        return res.json({
          valid: false,
          reason: isRevoked
            ? 'Access was revoked — please reconnect this account.'
            : `Token validation failed: ${err.message}`,
        });
      }
    }

    return res.json({ valid: false, reason: 'Unknown provider' });
  } catch (error) {
    console.error('Validate sender error:', error);
    res.status(500).json({ error: { message: 'Failed to validate sender account' } });
  }
});

module.exports = router;
