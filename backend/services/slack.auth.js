/**
 * slack.auth.js
 *
 * DROP-IN LOCATION: backend/services/slack.auth.js
 *
 * Slack OAuth 2.0 (v2) install flow. One distributed app; each customer org
 * installs it into their workspace and we store the encrypted BOT token in
 * org_slack_installs (see db/2026_28_slack_installs.sql).
 *
 * Unlike Salesforce/HubSpot there are no refresh tokens — Slack bot tokens
 * (xoxb-…) don't expire unless the workspace revokes the app. So we just store
 * the bot token, encrypted with the same AES-256-GCM helper used for Twilio.
 *
 * Required env vars:
 *   SLACK_CLIENT_ID
 *   SLACK_CLIENT_SECRET
 *   SLACK_REDIRECT_URI   (e.g. https://api.gowarmcrm.com/api/slack/callback)
 *
 * Bot scopes requested: chat:write, users:read, users:read.email
 *   (team channels later will add chat:write.public, channels:read — additive)
 */

const axios    = require('axios');
const crypto   = require('crypto');
const { pool } = require('../config/database');
const enc      = require('./credentials/encryption');

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL     = 'https://slack.com/api/oauth.v2.access';
const SLACK_REVOKE_URL    = 'https://slack.com/api/auth.revoke';

const BOT_SCOPES = ['chat:write', 'users:read', 'users:read.email'];

// Read env at call time so Railway injections are picked up regardless of
// require() caching order (same pattern as hubspot.auth.js).
function _env() {
  return {
    CLIENT_ID:     process.env.SLACK_CLIENT_ID,
    CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
    REDIRECT_URI:  process.env.SLACK_REDIRECT_URI,
  };
}

// ── State (CSRF protection) ─────────────────────────────────────────────────
// The callback is public/unauthenticated, so we sign the state with an HMAC so a
// forged callback can't bind an install to an arbitrary org. Format:
//   base64url(payloadJSON) + '.' + base64url(hmac)
function _signState({ userId, orgId }) {
  const { CLIENT_SECRET } = _env();
  const payload = Buffer.from(JSON.stringify({
    userId: parseInt(userId, 10),
    orgId:  parseInt(orgId, 10),
    nonce:  crypto.randomBytes(8).toString('hex'),
    ts:     Date.now(),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', CLIENT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function _verifyState(stateStr) {
  const { CLIENT_SECRET } = _env();
  const [payload, sig] = String(stateStr || '').split('.');
  if (!payload || !sig) throw new Error('Invalid OAuth state');
  const expected = crypto.createHmac('sha256', CLIENT_SECRET).update(payload).digest('base64url');
  // constant-time compare
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('OAuth state signature mismatch');
  }
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (Date.now() - data.ts > 10 * 60 * 1000) throw new Error('OAuth state expired');
  return data;
}

// ── getAuthUrl ──────────────────────────────────────────────────────────────
function getAuthUrl(userId, orgId) {
  const { CLIENT_ID, REDIRECT_URI } = _env();
  if (!CLIENT_ID || !REDIRECT_URI) {
    throw new Error('SLACK_CLIENT_ID and SLACK_REDIRECT_URI env vars are required');
  }
  const params = new URLSearchParams({
    client_id:    CLIENT_ID,
    scope:        BOT_SCOPES.join(','),   // bot token scopes
    redirect_uri: REDIRECT_URI,
    state:        _signState({ userId, orgId }),
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

// ── exchangeCode ──────────────────────────────────────────────────────────────
/**
 * Exchange the OAuth code for a bot token and persist the install.
 * @returns {{ orgId, teamId, teamName, botUserId }}
 */
async function exchangeCode(code, stateStr) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = _env();
  const { userId, orgId } = _verifyState(stateStr);

  const res = await axios.post(SLACK_TOKEN_URL, new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri:  REDIRECT_URI,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  const d = res.data;
  if (!d.ok)            throw new Error(`Slack OAuth failed: ${d.error || 'unknown_error'}`);
  if (!d.access_token)  throw new Error('Slack did not return a bot token — check requested scopes');

  const botToken  = d.access_token;        // xoxb-…
  const teamId    = d.team?.id;
  const teamName  = d.team?.name || null;
  const botUserId = d.bot_user_id || null;
  const scope     = d.scope || BOT_SCOPES.join(',');

  const { ciphertext, iv, tag } = enc.encrypt(botToken);

  await pool.query(`
    INSERT INTO org_slack_installs
      (org_id, slack_team_id, slack_team_name, bot_user_id,
       bot_token_ciphertext, bot_token_iv, bot_token_tag, bot_token_last4,
       authed_user_id, scopes, status, installed_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',now(),now())
    ON CONFLICT (org_id) DO UPDATE SET
      slack_team_id        = EXCLUDED.slack_team_id,
      slack_team_name      = EXCLUDED.slack_team_name,
      bot_user_id          = EXCLUDED.bot_user_id,
      bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
      bot_token_iv         = EXCLUDED.bot_token_iv,
      bot_token_tag        = EXCLUDED.bot_token_tag,
      bot_token_last4      = EXCLUDED.bot_token_last4,
      authed_user_id       = EXCLUDED.authed_user_id,
      scopes               = EXCLUDED.scopes,
      status               = 'active',
      updated_at           = now()
  `, [
    orgId, teamId, teamName, botUserId,
    ciphertext, iv, tag, enc.last4(botToken),
    userId, scope,
  ]);

  return { orgId, teamId, teamName, botUserId };
}

// ── getInstallStatus ──────────────────────────────────────────────────────────
async function getInstallStatus(orgId) {
  const { rows: [row] } = await pool.query(
    `SELECT slack_team_name, bot_user_id, default_channel_id, installed_at, status
       FROM org_slack_installs WHERE org_id = $1`,
    [orgId]
  );
  if (!row || row.status !== 'active') {
    return { connected: false };
  }
  return {
    connected:          true,
    team_name:          row.slack_team_name,
    bot_user_id:        row.bot_user_id,
    default_channel_id: row.default_channel_id,
    installed_at:       row.installed_at,
  };
}

// ── revokeInstall ─────────────────────────────────────────────────────────────
async function revokeInstall(orgId) {
  // Best-effort: tell Slack to revoke the token, then mark our row revoked.
  try {
    const { rows: [row] } = await pool.query(
      `SELECT bot_token_ciphertext, bot_token_iv, bot_token_tag
         FROM org_slack_installs WHERE org_id = $1 AND status = 'active'`,
      [orgId]
    );
    if (row) {
      const token = enc.decrypt(row.bot_token_ciphertext, row.bot_token_iv, row.bot_token_tag);
      await axios.post(SLACK_REVOKE_URL, new URLSearchParams({ token }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }).catch(() => {}); // non-fatal
    }
  } catch (e) {
    console.warn(`[slack] revoke token call failed for org ${orgId}: ${e.message}`);
  }
  await pool.query(
    `UPDATE org_slack_installs SET status = 'revoked', updated_at = now() WHERE org_id = $1`,
    [orgId]
  );
}

module.exports = { getAuthUrl, exchangeCode, getInstallStatus, revokeInstall };
