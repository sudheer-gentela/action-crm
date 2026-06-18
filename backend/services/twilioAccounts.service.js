/**
 * services/twilioAccounts.service.js
 *
 * Owns the `org_twilio_accounts` table: subaccount credential storage,
 * encryption, retrieval, and the parent-level subaccount PROVISIONING flow
 * (Model A — GoWarmCRM as reseller).
 *
 * This is the DB + lifecycle layer. twilioProvider.service.js is a pure
 * Twilio adapter that calls getCredentials()/getAuthToken() here to resolve
 * which subaccount to act against. Dependency is one-directional
 * (provider → accounts); this module never requires the provider.
 *
 * Crypto: reuses services/credentials/encryption.js (AES-256-GCM, AI_CREDS_KEY).
 * Plaintext auth tokens / API secrets never leave this module's call stack and
 * are never returned by an HTTP route.
 *
 * Environment variables consumed (PARENT account — used only for subaccount
 * lifecycle, never for per-org calls):
 *   TWILIO_ACCOUNT_SID   (required) — parent account SID
 *   TWILIO_AUTH_TOKEN    (required) — parent auth token
 *   RAILWAY_PUBLIC_DOMAIN | BACKEND_PUBLIC_URL — public base URL for the
 *     TwiML App voiceUrl (browser-dial outbound endpoint)
 */

const twilio = require('twilio');
const db     = require('../config/database');
const Entitlements = require('./entitlements.service');
const { encrypt, decrypt, last4, isConfigured: encIsConfigured } =
  require('./credentials/encryption');

// ── Constants ─────────────────────────────────────────────────────────────
// Path the TwiML App's voiceUrl points at. This endpoint is the browser-dial
// OUTBOUND TwiML handler — it returns <Dial><Number>{prospect}</Number></Dial>
// when a softphone Device.connect() fires. Built in the browser-dialing phase;
// provisioning the TwiML App now keeps subaccount onboarding atomic.
const VOICE_APP_PATH = '/api/twilio/webhooks/voice-app';

// ── Parent client (subaccount lifecycle only) ──────────────────────────────
let _parentClient = null;

function getParentClient() {
  if (_parentClient) return _parentClient;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Twilio parent creds missing: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
  }
  _parentClient = twilio(sid, token);
  return _parentClient;
}

// ── Internal: public base URL (kept local to avoid coupling to the provider) ─
function _resolvePublicBaseUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.BACKEND_PUBLIC_URL) {
    return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
  }
  return null;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Raw row for an org, or null. Does NOT decrypt anything.
 * @param {number} orgId
 */
async function getRow(orgId) {
  const { rows } = await db.pool.query(
    `SELECT org_id, subaccount_sid,
            auth_token_ciphertext, auth_token_iv, auth_token_tag, auth_token_last4,
            api_key_sid, api_key_secret_ciphertext, api_key_secret_iv,
            api_key_secret_tag, api_key_secret_last4,
            twiml_app_sid, status, friendly_name, created_at, updated_at
       FROM org_twilio_accounts
      WHERE org_id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

/**
 * Resolve the subaccount credentials the provider needs to build a client.
 * @param {number} orgId
 * @returns {Promise<{accountSid: string, authToken: string} | null>}
 *          null when the org has no provisioned/active subaccount.
 */
async function getCredentials(orgId) {
  const row = await getRow(orgId);
  if (!row || row.status !== 'active') return null;
  const authToken = decrypt(row.auth_token_ciphertext, row.auth_token_iv, row.auth_token_tag);
  return { accountSid: row.subaccount_sid, authToken };
}

/**
 * Just the subaccount auth token — used for webhook signature validation.
 * @param {number} orgId
 * @returns {Promise<string | null>}
 */
async function getAuthToken(orgId) {
  const creds = await getCredentials(orgId);
  return creds ? creds.authToken : null;
}

/**
 * Voice-SDK config for minting browser-dial access tokens.
 * @param {number} orgId
 * @returns {Promise<{accountSid, apiKeySid, apiKeySecret, twimlAppSid} | null>}
 *          null if the org isn't active or softphone resources aren't provisioned.
 */
async function getVoiceConfig(orgId) {
  const row = await getRow(orgId);
  if (!row || row.status !== 'active') return null;
  if (!row.api_key_sid || !row.api_key_secret_ciphertext || !row.twiml_app_sid) return null;
  const apiKeySecret = decrypt(
    row.api_key_secret_ciphertext, row.api_key_secret_iv, row.api_key_secret_tag
  );
  return {
    accountSid:  row.subaccount_sid,
    apiKeySid:   row.api_key_sid,
    apiKeySecret,
    twimlAppSid: row.twiml_app_sid,
  };
}

/** Has this org been provisioned with an active subaccount? */
async function isProvisioned(orgId) {
  const row = await getRow(orgId);
  return !!(row && row.status === 'active');
}

/**
 * Individual-level calling check. Calling can be granted at TWO levels, and
 * BOTH must be on for a rep to place a call:
 *   - ORG level:        settings.entitlements.calling (platform/billing) — default OFF
 *   - INDIVIDUAL level: users.calling_enabled = true   (org admin per rep)  — default OFF
 * This covers the individual level.
 *
 * Default-OFF / opt-in: calling is enabled for a rep ONLY when
 * users.calling_enabled is explicitly true. NULL / missing / false → disabled.
 * A rep must be deliberately turned on (and the org must be entitled).
 *
 * Migration-safe: if the calling_enabled column hasn't been added yet
 * (undefined_column, SQLSTATE 42703), returns true so deploying the code
 * BEFORE running the ALTER TABLE never causes a calling OUTAGE — the existing
 * behaviour persists for the brief deploy-before-migrate window. Once the
 * column exists (default false), opt-in semantics take effect. Other infra
 * errors also fail open, consistent with the rest of the calling stack.
 *
 * (If you'd rather fail CLOSED pre-migration — no calling until the column
 * exists and a rep is enabled — change the two `return true` lines below to
 * `return false`. That trades the no-outage guarantee for strict-by-default.)
 *
 * @param {number} orgId
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function isUserCallingEnabled(orgId, userId) {
  try {
    const { rows } = await db.pool.query(
      `SELECT calling_enabled FROM users WHERE id = $1 AND org_id = $2`,
      [userId, orgId]
    );
    if (!rows.length) return false;            // unknown user in this org
    return rows[0].calling_enabled === true;   // opt-in: only explicit true enables
  } catch (err) {
    if (err.code === '42703') return true;      // column not migrated yet → no outage
    console.warn(
      `isUserCallingEnabled lookup failed (org ${orgId}, user ${userId}); failing open: ${err.message}`
    );
    return true;
  }
}

// ── Provisioning ──────────────────────────────────────────────────────────

/**
 * Provision a Twilio subaccount for an org and persist its (encrypted)
 * credentials, plus an API key + TwiML App for browser dialing.
 *
 * Idempotent: if the org already has a row, returns a safe summary without
 * creating anything.
 *
 * Order matters — if a later step throws, earlier Twilio resources are left in
 * place (Twilio has no atomic multi-create). The summary the caller persists is
 * only written after every Twilio call succeeds, so a partial failure means the
 * DB row is never written and the operation can be retried; orphaned Twilio
 * resources (a bare subaccount with no row) can be reconciled by the admin.
 *
 * @param {Object}  args
 * @param {number}  args.orgId
 * @param {string}  args.friendlyName  human label, e.g. the org's name
 * @returns {Promise<{org_id, subaccount_sid, api_key_sid, twiml_app_sid, status, friendly_name, already_existed: boolean}>}
 */
async function provisionSubaccount({ orgId, friendlyName }) {
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error('provisionSubaccount: orgId must be a positive integer');
  }

  // Calling is a paid capability. Refuse to create billed Twilio resources for
  // a non-entitled org. Defense-in-depth: the route gates this too, but the
  // service guard means no future caller (job, script, new route) can provision
  // around the entitlement. Throws EntitlementError (statusCode 402) which the
  // route maps to a clean 402.
  if (!(await Entitlements.isEntitled(orgId, 'calling'))) {
    throw new Entitlements.EntitlementError('calling');
  }

  if (!encIsConfigured()) {
    const e = new Error('AI_CREDS_KEY not configured — cannot store Twilio credentials');
    e.code = 'ENCRYPTION_NOT_CONFIGURED';
    throw e;
  }

  // Idempotency guard.
  const existing = await getRow(orgId);
  if (existing) {
    return {
      org_id:         existing.org_id,
      subaccount_sid: existing.subaccount_sid,
      api_key_sid:    existing.api_key_sid,
      twiml_app_sid:  existing.twiml_app_sid,
      status:         existing.status,
      friendly_name:  existing.friendly_name,
      already_existed: true,
    };
  }

  const base = _resolvePublicBaseUrl();
  if (!base) {
    throw new Error(
      'Twilio: need a public backend URL for the TwiML App voiceUrl. ' +
      'Set RAILWAY_PUBLIC_DOMAIN or BACKEND_PUBLIC_URL.'
    );
  }

  const label  = (friendlyName && String(friendlyName).trim()) || `org-${orgId}`;
  const parent = getParentClient();

  // 1) Create the subaccount under the parent. Twilio returns the subaccount's
  //    own auth token exactly once, here.
  const sub = await parent.api.v2010.accounts.create({ friendlyName: label });
  const subSid       = sub.sid;
  const subAuthToken = sub.authToken;

  // 2) Build a client SCOPED to the subaccount for all subaccount-local creates.
  const subClient = twilio(subSid, subAuthToken);

  // 3) API key (for browser-dial access-token signing). Secret shown once.
  const key = await subClient.newKeys.create({ friendlyName: `${label} voice-sdk` });
  const apiKeySid    = key.sid;
  const apiKeySecret = key.secret;

  // 4) TwiML App (browser-dial outbound). voiceUrl → our outbound TwiML handler.
  const app = await subClient.applications.create({
    friendlyName: `${label} softphone`,
    voiceUrl:     `${base}${VOICE_APP_PATH}`,
    voiceMethod:  'POST',
  });
  const twimlAppSid = app.sid;

  // 5) Persist — encrypt the two secrets.
  const tok = encrypt(subAuthToken);
  const sec = encrypt(apiKeySecret);

  await db.pool.query(
    `INSERT INTO org_twilio_accounts
       (org_id, subaccount_sid,
        auth_token_ciphertext, auth_token_iv, auth_token_tag, auth_token_last4,
        api_key_sid, api_key_secret_ciphertext, api_key_secret_iv,
        api_key_secret_tag, api_key_secret_last4,
        twiml_app_sid, status, friendly_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13)`,
    [
      orgId, subSid,
      tok.ciphertext, tok.iv, tok.tag, last4(subAuthToken),
      apiKeySid, sec.ciphertext, sec.iv, sec.tag, last4(apiKeySecret),
      twimlAppSid, label,
    ]
  );

  return {
    org_id:          orgId,
    subaccount_sid:  subSid,
    api_key_sid:     apiKeySid,
    twiml_app_sid:   twimlAppSid,
    status:          'active',
    friendly_name:   label,
    already_existed: false,
  };
}

/**
 * Suspend a subaccount (stops it being usable without releasing numbers).
 * Sets Twilio account status to 'suspended' and mirrors it locally.
 * @param {number} orgId
 */
async function suspendSubaccount(orgId) {
  const row = await getRow(orgId);
  if (!row) return false;
  const parent = getParentClient();
  await parent.api.v2010.accounts(row.subaccount_sid).update({ status: 'suspended' });
  await db.pool.query(
    `UPDATE org_twilio_accounts SET status='suspended', updated_at=NOW() WHERE org_id=$1`,
    [orgId]
  );
  return true;
}

module.exports = {
  getParentClient,
  getRow,
  getCredentials,
  getAuthToken,
  getVoiceConfig,
  isProvisioned,
  isUserCallingEnabled,
  provisionSubaccount,
  suspendSubaccount,
  VOICE_APP_PATH,
};
