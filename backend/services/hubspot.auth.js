/**
 * hubspot.auth.js
 *
 * DROP-IN LOCATION: backend/services/hubspot.auth.js
 *
 * HubSpot OAuth 2.0 flow for GoWarm.
 * Mirrors salesforce.auth.js structure exactly — same table, same pattern.
 *
 * HubSpot differences from Salesforce:
 *   - No per-org instance_url — API base is always https://api.hubapi.com
 *   - Token identified by HubSpot Portal ID (hub_id), stored in account_data
 *   - Access tokens expire in 30 minutes (not 2 hours)
 *   - Refresh tokens do not expire unless revoked
 *
 * Required env vars:
 *   HUBSPOT_CLIENT_ID
 *   HUBSPOT_CLIENT_SECRET
 *   HUBSPOT_REDIRECT_URI   (e.g. https://api.gowarmcrm.com/api/hubspot/callback)
 *
 * Scopes required:
 *   crm.objects.companies.read  crm.objects.contacts.read
 *   crm.objects.deals.read      crm.objects.owners.read
 *   crm.schemas.deals.read      oauth
 */

const axios    = require('axios');
const { pool } = require('../config/database');

const HS_AUTH_BASE    = 'https://app.hubspot.com/oauth/authorize';
const HS_TOKEN_URL    = 'https://api.hubapi.com/oauth/v1/token';
const HS_REVOKE_URL   = 'https://api.hubapi.com/oauth/v1/refresh-tokens';
const HS_API_BASE     = 'https://api.hubapi.com';

// Read env vars at call time (not module load time) so Railway injections
// are always picked up regardless of require() caching order.
function _env() {
  return {
    CLIENT_ID:     process.env.HUBSPOT_CLIENT_ID,
    CLIENT_SECRET: process.env.HUBSPOT_CLIENT_SECRET,
    REDIRECT_URI:  process.env.HUBSPOT_REDIRECT_URI,
  };
}

const SCOPES = [
  'crm.objects.companies.read',
  'crm.objects.contacts.read',
  'crm.objects.deals.read',
  'crm.objects.owners.read',
  'crm.schemas.deals.read',
  'oauth',
].join(' ');

// ── getAuthUrl ────────────────────────────────────────────────────────────────

function getAuthUrl(userId, orgId) {
  const { CLIENT_ID, REDIRECT_URI } = _env();
  if (!CLIENT_ID || !REDIRECT_URI) {
    throw new Error('HUBSPOT_CLIENT_ID and HUBSPOT_REDIRECT_URI env vars are required');
  }

  const state = Buffer.from(JSON.stringify({
    userId:    parseInt(userId, 10),
    orgId:     parseInt(orgId,  10),
    timestamp: Date.now(),
  })).toString('base64');

  const params = new URLSearchParams({
    client_id:    CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope:        SCOPES,
    state,
  });

  return `${HS_AUTH_BASE}?${params.toString()}`;
}

// ── exchangeCode ──────────────────────────────────────────────────────────────

/**
 * Exchange authorization code for tokens.
 * Saves to oauth_tokens (provider='hubspot') and org_integrations.
 *
 * @returns {{ userId, orgId, hubId, email }}
 */
async function exchangeCode(code, stateStr) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = _env();
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(stateStr, 'base64').toString());
  } catch {
    throw new Error('Invalid OAuth state parameter');
  }

  const { userId, orgId } = stateData;

  // Exchange code for tokens
  const tokenRes = await axios.post(HS_TOKEN_URL, new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    code,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const { access_token, refresh_token, expires_in } = tokenRes.data;

  if (!access_token || !refresh_token) {
    throw new Error('HubSpot did not return tokens — check Connected App scopes');
  }

  // Fetch HubSpot portal info and connecting user identity
  const [tokenInfoRes, ownerRes] = await Promise.all([
    axios.get(`${HS_API_BASE}/oauth/v1/access-tokens/${access_token}`),
    axios.get(`${HS_API_BASE}/crm/v3/owners/me`, {
      headers: { Authorization: `Bearer ${access_token}` },
    }).catch(() => ({ data: null })), // owners/me may not exist on all plans — non-fatal
  ]);

  const hubId   = tokenInfoRes.data.hub_id;
  const email   = tokenInfoRes.data.user     || ownerRes.data?.email || null;
  const hubDomain = tokenInfoRes.data.hub_domain || null;

  // HubSpot access tokens expire in expires_in seconds (typically 1800 = 30 min)
  const expiresAt = new Date(Date.now() + (expires_in || 1800) * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO oauth_tokens
        (user_id, org_id, provider, access_token, refresh_token, expires_at, account_data, created_at, updated_at)
      VALUES ($1, $2, 'hubspot', $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (user_id, provider)
      DO UPDATE SET
        access_token  = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
        expires_at    = EXCLUDED.expires_at,
        account_data  = EXCLUDED.account_data,
        updated_at    = NOW()
    `, [
      userId, orgId, access_token, refresh_token, expiresAt,
      JSON.stringify({ hub_id: hubId, hub_domain: hubDomain, email }),
    ]);

    // instance_url = HubSpot portal URL (for display in UI)
    const instanceUrl = hubDomain ? `https://${hubDomain}` : `https://app.hubspot.com/portal/${hubId}`;

    await client.query(`
      INSERT INTO org_integrations
        (org_id, integration_type, provider, instance_url, connected_by, connected_at, sync_status, settings, created_at, updated_at)
      VALUES ($1, 'hubspot', 'hubspot', $2, $3, NOW(), 'idle', $4, NOW(), NOW())
      ON CONFLICT (org_id, integration_type)
      DO UPDATE SET
        provider     = 'hubspot',
        instance_url = EXCLUDED.instance_url,
        connected_by = EXCLUDED.connected_by,
        connected_at = NOW(),
        sync_status  = 'idle',
        updated_at   = NOW()
    `, [
      orgId, instanceUrl, userId,
      JSON.stringify({
        sync_objects:          ['Company', 'Contact', 'Deal'],
        stage_map:             {},
        field_map:             [],
        sync_cursors:          {},
        initial_sync_complete: { Company: false, Contact: false, Deal: false },
      }),
    ]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`✅ HubSpot connected for org ${orgId} by user ${userId} — hub_id: ${hubId}`);
  return { userId, orgId, hubId, email };
}

// ── getValidToken ─────────────────────────────────────────────────────────────

/**
 * Get a valid HubSpot access token for an org.
 * Auto-refreshes if expired or within 2 minutes of expiry.
 *
 * @param {number} orgId
 * @returns {{ accessToken: string, hubId: number }}
 */
async function getValidToken(orgId) {
  const res = await pool.query(`
    SELECT ot.access_token, ot.refresh_token, ot.expires_at, ot.account_data, ot.user_id
    FROM oauth_tokens ot
    JOIN org_integrations oi
      ON oi.org_id = $1 AND oi.integration_type = 'hubspot' AND oi.connected_by = ot.user_id
    WHERE ot.provider = 'hubspot'
    LIMIT 1
  `, [orgId]);

  if (res.rows.length === 0) {
    throw new Error(`HubSpot not connected for org ${orgId}`);
  }

  const token     = res.rows[0];
  const expiresAt = new Date(token.expires_at);
  const twoMins   = 2 * 60 * 1000;

  if (expiresAt.getTime() - Date.now() > twoMins) {
    return {
      accessToken: token.access_token,
      hubId:       token.account_data?.hub_id,
    };
  }

  // Refresh
  console.log(`🔄 Refreshing HubSpot token for org ${orgId}...`);
  const refreshed = await _refreshToken(token.refresh_token, token.user_id, orgId);
  return { accessToken: refreshed.accessToken, hubId: token.account_data?.hub_id };
}

// ── _refreshToken ─────────────────────────────────────────────────────────────

async function _refreshToken(refreshToken, userId, orgId) {
  const { CLIENT_ID, CLIENT_SECRET } = _env();
  const res = await axios.post(HS_TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const { access_token, expires_in } = res.data;
  const expiresAt = new Date(Date.now() + (expires_in || 1800) * 1000);

  await pool.query(`
    UPDATE oauth_tokens
    SET access_token = $1, expires_at = $2, updated_at = NOW()
    WHERE user_id = $3 AND provider = 'hubspot'
  `, [access_token, expiresAt, userId]);

  return { accessToken: access_token };
}

// ── revokeToken ───────────────────────────────────────────────────────────────

async function revokeToken(orgId) {
  const res = await pool.query(`
    SELECT ot.refresh_token, ot.user_id
    FROM oauth_tokens ot
    JOIN org_integrations oi
      ON oi.org_id = $1 AND oi.integration_type = 'hubspot' AND oi.connected_by = ot.user_id
    WHERE ot.provider = 'hubspot'
    LIMIT 1
  `, [orgId]);

  if (res.rows.length === 0) return;

  const { refresh_token, user_id } = res.rows[0];

  // Best-effort revoke
  try {
    await axios.delete(`${HS_REVOKE_URL}/${refresh_token}`);
  } catch (err) {
    console.warn(`⚠️  HubSpot token revocation failed (continuing): ${err.message}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM oauth_tokens WHERE user_id = $1 AND provider = 'hubspot'`,
      [user_id]
    );
    await client.query(`
      UPDATE org_integrations
      SET sync_status = 'idle', connected_by = NULL, connected_at = NULL,
          instance_url = NULL, updated_at = NOW()
      WHERE org_id = $1 AND integration_type = 'hubspot'
    `, [orgId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`✅ HubSpot disconnected for org ${orgId}`);
}

// ── getConnectionStatus ───────────────────────────────────────────────────────

async function getConnectionStatus(orgId) {
  const res = await pool.query(`
    SELECT oi.instance_url, oi.connected_at, oi.last_sync_at, oi.sync_status,
           oi.last_sync_error, oi.settings, ot.account_data
    FROM org_integrations oi
    LEFT JOIN oauth_tokens ot
      ON ot.provider = 'hubspot' AND ot.user_id = oi.connected_by
    WHERE oi.org_id = $1 AND oi.integration_type = 'hubspot'
  `, [orgId]);

  if (res.rows.length === 0) return { connected: false };

  const row = res.rows[0];
  return {
    connected:    !!(row.instance_url && row.connected_at),
    instanceUrl:  row.instance_url,
    connectedAt:  row.connected_at,
    lastSyncAt:   row.last_sync_at,
    syncStatus:   row.sync_status,
    lastSyncError: row.last_sync_error,
    email:        row.account_data?.email,
    hubId:        row.account_data?.hub_id,
    settings:     row.settings,
  };
}

module.exports = { getAuthUrl, exchangeCode, getValidToken, revokeToken, getConnectionStatus };
