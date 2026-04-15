/**
 * salesforce.auth.js
 *
 * DROP-IN LOCATION: backend/services/salesforce.auth.js
 *
 * Salesforce OAuth 2.0 Web Server Flow.
 * Org-level connection — one token per org (stored under the connecting admin's user_id).
 *
 * Flow:
 *   1. GET  /api/salesforce/connect  → getAuthUrl(userId, orgId)  → redirect to SF
 *   2. GET  /api/salesforce/callback → exchangeCode(code, state)  → save tokens
 *   3. Any API call                  → getValidToken(orgId)       → auto-refresh if needed
 *   4. POST /api/salesforce/disconnect → revokeToken(orgId)
 *
 * Token storage: oauth_tokens table, provider = 'salesforce'.
 * Instance URL:  org_integrations.instance_url (set on first connect).
 */

const axios    = require('axios');
const { pool } = require('../config/database');

const SF_AUTH_BASE     = 'https://login.salesforce.com';
const SF_TOKEN_URL     = `${SF_AUTH_BASE}/services/oauth2/token`;
const SF_AUTHORIZE_URL = `${SF_AUTH_BASE}/services/oauth2/authorize`;
const SF_REVOKE_URL    = `${SF_AUTH_BASE}/services/oauth2/revoke`;

const CLIENT_ID     = process.env.SALESFORCE_CLIENT_ID;
const CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.SALESFORCE_REDIRECT_URI;

// ── getAuthUrl ────────────────────────────────────────────────────────────────

/**
 * Build the Salesforce OAuth authorization URL.
 * State encodes userId + orgId so the callback knows who to save the token for.
 */
function getAuthUrl(userId, orgId) {
  if (!CLIENT_ID || !REDIRECT_URI) {
    throw new Error('SALESFORCE_CLIENT_ID and SALESFORCE_REDIRECT_URI env vars are required');
  }

  const state = Buffer.from(JSON.stringify({
    userId:    parseInt(userId, 10),
    orgId:     parseInt(orgId,  10),
    timestamp: Date.now(),
  })).toString('base64');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    scope:         'api refresh_token offline_access id',
    state,
  });

  return `${SF_AUTHORIZE_URL}?${params.toString()}`;
}

// ── exchangeCode ──────────────────────────────────────────────────────────────

/**
 * Exchange the authorization code for access + refresh tokens.
 * Saves tokens to oauth_tokens and instance_url to org_integrations.
 *
 * @returns {{ userId, orgId, instanceUrl, email }}
 */
async function exchangeCode(code, stateStr) {
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(stateStr, 'base64').toString());
  } catch {
    throw new Error('Invalid OAuth state parameter');
  }

  const { userId, orgId } = stateData;

  // Exchange code for tokens
  const tokenRes = await axios.post(SF_TOKEN_URL, new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    code,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const { access_token, refresh_token, instance_url, id: identityUrl } = tokenRes.data;

  if (!access_token || !refresh_token) {
    throw new Error('Salesforce did not return tokens — ensure refresh_token scope is enabled on the Connected App');
  }

  // Fetch the connecting user's SF identity (email + SF user id)
  const identityRes = await axios.get(identityUrl, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const sfEmail    = identityRes.data.email;
  const sfUserId   = identityRes.data.user_id;
  const sfUsername = identityRes.data.username;

  // Calculate expiry — SF access tokens default to 2 hours
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Save tokens to oauth_tokens (same table as Outlook/Gmail)
    await client.query(`
      INSERT INTO oauth_tokens (user_id, org_id, provider, access_token, refresh_token, expires_at, account_data, created_at, updated_at)
      VALUES ($1, $2, 'salesforce', $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (user_id, provider)
      DO UPDATE SET
        access_token  = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
        expires_at    = EXCLUDED.expires_at,
        account_data  = EXCLUDED.account_data,
        updated_at    = NOW()
    `, [
      userId, orgId, access_token, refresh_token, expiresAt,
      JSON.stringify({ instance_url, sf_user_id: sfUserId, sf_username: sfUsername, sf_email: sfEmail }),
    ]);

    // Upsert org_integrations row — create or update on reconnect
    await client.query(`
      INSERT INTO org_integrations (org_id, integration_type, provider, instance_url, connected_by, connected_at, sync_status, settings, created_at, updated_at)
      VALUES ($1, 'salesforce', 'salesforce', $2, $3, NOW(), 'idle', $4, NOW(), NOW())
      ON CONFLICT (org_id, integration_type)
      DO UPDATE SET
        provider     = 'salesforce',
        instance_url = EXCLUDED.instance_url,
        connected_by = EXCLUDED.connected_by,
        connected_at = NOW(),
        sync_status  = 'idle',
        updated_at   = NOW()
    `, [
      orgId, instance_url, userId,
      JSON.stringify({
        sf_sync_mode:          'sf_primary',
        write_back_enabled:    false,
        write_back_mode:       'nightly',
        sync_objects:          ['Contact', 'Account', 'Opportunity', 'Lead'],
        stage_map:             {},
        field_map:             [],
        sync_cursors:          {},
        initial_sync_complete: { Contact: false, Account: false, Opportunity: false, Lead: false },
      }),
    ]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`✅ Salesforce connected for org ${orgId} by user ${userId} — instance: ${instance_url}`);
  return { userId, orgId, instanceUrl: instance_url, email: sfEmail };
}

// ── getValidToken ─────────────────────────────────────────────────────────────

/**
 * Get a valid access token for an org.
 * Auto-refreshes if the token is expired or within 5 minutes of expiry.
 *
 * @param {number} orgId
 * @returns {{ accessToken: string, instanceUrl: string }}
 */
async function getValidToken(orgId) {
  // Find the token — keyed to the org admin who connected SF
  // (org_integrations.connected_by links to the admin's user_id in oauth_tokens)
  const res = await pool.query(`
    SELECT ot.access_token, ot.refresh_token, ot.expires_at, ot.account_data, ot.user_id
    FROM oauth_tokens ot
    JOIN org_integrations oi ON oi.org_id = $1 AND oi.integration_type = 'salesforce' AND oi.connected_by = ot.user_id
    WHERE ot.provider = 'salesforce'
    LIMIT 1
  `, [orgId]);

  if (res.rows.length === 0) {
    throw new Error(`Salesforce not connected for org ${orgId}`);
  }

  const token       = res.rows[0];
  const instanceUrl = token.account_data?.instance_url;
  const expiresAt   = new Date(token.expires_at);
  const fiveMinutes = 5 * 60 * 1000;

  if (!instanceUrl) {
    throw new Error(`Salesforce instance_url missing for org ${orgId} — reconnect required`);
  }

  // Token is still valid
  if (expiresAt.getTime() - Date.now() > fiveMinutes) {
    return { accessToken: token.access_token, instanceUrl };
  }

  // Token expired or near expiry — refresh
  console.log(`🔄 Refreshing Salesforce token for org ${orgId}...`);
  const refreshed = await _refreshToken(token.refresh_token, token.user_id, orgId, instanceUrl);
  return { accessToken: refreshed.accessToken, instanceUrl };
}

// ── _refreshToken (internal) ──────────────────────────────────────────────────

async function _refreshToken(refreshToken, userId, orgId, instanceUrl) {
  const res = await axios.post(SF_TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const { access_token } = res.data;
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

  await pool.query(`
    UPDATE oauth_tokens
    SET access_token = $1, expires_at = $2, updated_at = NOW()
    WHERE user_id = $3 AND provider = 'salesforce'
  `, [access_token, expiresAt, userId]);

  return { accessToken: access_token };
}

// ── revokeToken ───────────────────────────────────────────────────────────────

/**
 * Disconnect Salesforce for an org — revoke SF token and delete local records.
 */
async function revokeToken(orgId) {
  const res = await pool.query(`
    SELECT ot.access_token, ot.user_id
    FROM oauth_tokens ot
    JOIN org_integrations oi ON oi.org_id = $1 AND oi.integration_type = 'salesforce' AND oi.connected_by = ot.user_id
    WHERE ot.provider = 'salesforce'
    LIMIT 1
  `, [orgId]);

  if (res.rows.length === 0) return; // Already disconnected

  const { access_token, user_id } = res.rows[0];

  // Best-effort SF revoke (don't fail if SF is unreachable)
  try {
    await axios.post(SF_REVOKE_URL, new URLSearchParams({ token: access_token }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (err) {
    console.warn(`⚠️  Salesforce token revocation failed (continuing): ${err.message}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = 'salesforce'`, [user_id]);
    await client.query(`
      UPDATE org_integrations
      SET sync_status = 'idle', connected_by = NULL, connected_at = NULL, instance_url = NULL, updated_at = NOW()
      WHERE org_id = $1 AND integration_type = 'salesforce'
    `, [orgId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`✅ Salesforce disconnected for org ${orgId}`);
}

// ── getConnectionStatus ───────────────────────────────────────────────────────

async function getConnectionStatus(orgId) {
  const res = await pool.query(`
    SELECT oi.instance_url, oi.connected_at, oi.last_sync_at, oi.sync_status,
           oi.last_sync_error, oi.settings, ot.token_data
    FROM org_integrations oi
    LEFT JOIN oauth_tokens ot
      ON ot.provider = 'salesforce' AND ot.user_id = oi.connected_by
    WHERE oi.org_id = $1 AND oi.integration_type = 'salesforce'
  `, [orgId]);

  if (res.rows.length === 0) return { connected: false };

  const row = res.rows[0];
  const isConnected = !!(row.instance_url && row.connected_at);

  return {
    connected:    isConnected,
    instanceUrl:  row.instance_url,
    connectedAt:  row.connected_at,
    lastSyncAt:   row.last_sync_at,
    syncStatus:   row.sync_status,
    lastSyncError: row.last_sync_error,
    sfEmail:      row.account_data?.sf_email,
    sfUsername:   row.account_data?.sf_username,
    settings:     row.settings,
  };
}

module.exports = { getAuthUrl, exchangeCode, getValidToken, revokeToken, getConnectionStatus };
