/**
 * signatureService.js
 *
 * DROP-IN LOCATION: backend/services/signatureService.js
 *
 * Orchestration layer between contracts.routes / contractService and the
 * e-signature provider adapters. This is the only file in the codebase that
 * understands the platform-vs-org credential split.
 *
 * ── How token persistence works ─────────────────────────────────────────
 *
 *  BYOL (org credentials):
 *    Tokens stored in organizations.settings.esign
 *    Refreshed tokens written back to the same org row via saveOrgTokens()
 *
 *  Platform (default):
 *    Tokens stored in platform_esign_tokens table (one row per provider)
 *    Refreshed tokens written back there via savePlatformTokens()
 *    Static config (client_id, client_secret) stays in Railway env vars only
 *
 * ── OrgAdmin UI behaviour ───────────────────────────────────────────────
 *  getEsignConfig()  returns:
 *    - usingPlatform: true/false  — tells the UI whether the org is on the
 *                                   platform default or has their own credentials
 *    - connected: true/false      — whether the active credential set has tokens
 *    - platformAvailable: true    — whether a platform account is configured
 *                                   (so the UI can show "using platform default")
 *
 *  This lets the OrgAdmin UI show a clear "You are using the ActionCRM shared
 *  signing account" message, with an option to override with their own.
 */

const { pool }    = require('../config/database');
const { resolveProvider, getOrgProvider, listProviders } = require('./EsignProviderFactory');

// ── Platform token store ─────────────────────────────────────────────────
// Platform tokens live in platform_esign_tokens (see migration_esign.sql).
// One row per provider — keyed by provider id e.g. 'zoho'.

async function getPlatformTokens(providerId) {
  const r = await pool.query(
    `SELECT access_token, refresh_token, token_expiry
     FROM platform_esign_tokens
     WHERE provider = $1`,
    [providerId]
  );
  return r.rows[0] || null;
}

async function savePlatformTokens(providerId, { access_token, refresh_token, token_expiry }) {
  await pool.query(
    `INSERT INTO platform_esign_tokens (provider, access_token, refresh_token, token_expiry)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider) DO UPDATE
       SET access_token  = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, platform_esign_tokens.refresh_token),
           token_expiry  = EXCLUDED.token_expiry,
           updated_at    = NOW()`,
    [providerId, access_token, refresh_token || null, token_expiry]
  );
}

// ── Org settings helpers ─────────────────────────────────────────────────

async function getOrgSettings(orgId) {
  const r = await pool.query(
    `SELECT settings FROM organizations WHERE id = $1`, [orgId]
  );
  return r.rows[0]?.settings || {};
}

async function saveOrgEsignField(orgId, key, value) {
  await pool.query(
    `UPDATE organizations
     SET settings = jsonb_set(settings, $2::text[], $3::jsonb, true)
     WHERE id = $1`,
    [orgId, `{esign,${key}}`, JSON.stringify(value)]
  );
}

async function saveOrgEsignBlock(orgId, block) {
  await pool.query(
    `UPDATE organizations
     SET settings = jsonb_set(COALESCE(settings, '{}'), '{esign}', $2::jsonb, true)
     WHERE id = $1`,
    [orgId, JSON.stringify(block)]
  );
}

// ── Token refresh callback ───────────────────────────────────────────────
// ZohoSignProvider (and future providers) call this when they refresh a token.
// We pass it in as a callback so the provider doesn't need to know about DB structure.

function makeTokenRefreshCallback(credentialSource, orgId, providerId) {
  if (credentialSource === 'org') {
    return async ({ access_token, token_expiry }) => {
      await saveOrgEsignField(orgId, 'access_token', access_token);
      await saveOrgEsignField(orgId, 'token_expiry', token_expiry);
    };
  }
  // platform
  return async ({ access_token, token_expiry }) => {
    await savePlatformTokens(providerId, { access_token, token_expiry });
  };
}

// ── Resolve the active provider for an org ───────────────────────────────
// Used by all signing operations. Fetches org settings + platform tokens,
// resolves which credentials to use, and wires up the token refresh callback.

async function resolveActiveProvider(orgId) {
  const settings        = await getOrgSettings(orgId);
  const platformProvider = process.env.ESIGN_PROVIDER;

  // Pre-fetch platform tokens only if we might need them
  const orgHasOwnCreds = !!(settings?.esign?.provider && settings?.esign?.client_id);
  const platformTokens = (!orgHasOwnCreds && platformProvider)
    ? await getPlatformTokens(platformProvider)
    : null;

  const resolved = resolveProvider(settings, platformTokens);
  if (!resolved) return null;

  // Attach the token refresh callback so the provider can persist refreshed tokens
  resolved.onTokenRefresh = makeTokenRefreshCallback(
    resolved.credentialSource,
    orgId,
    resolved.credentials.provider
  );

  return resolved;
}

// ── OrgAdmin: config endpoints ───────────────────────────────────────────

/**
 * Returns the esign configuration state for the Org Admin settings tab.
 * Safe to return to the frontend — never includes tokens or client_secret.
 */
async function getEsignConfig(orgId) {
  const settings         = await getOrgSettings(orgId);
  const orgEsign         = settings.esign || {};
  const orgHasOwnCreds   = !!(orgEsign.provider && orgEsign.client_id);
  const platformProvider = process.env.ESIGN_PROVIDER;
  const platformAvailable = !!(platformProvider && process.env.ESIGN_CLIENT_ID);

  // Determine connection status
  let connected     = false;
  let usingPlatform = false;

  if (orgHasOwnCreds) {
    connected     = !!(orgEsign.access_token && orgEsign.refresh_token);
    usingPlatform = false;
  } else if (platformAvailable) {
    const platformTokens = await getPlatformTokens(platformProvider);
    connected     = !!(platformTokens?.access_token && platformTokens?.refresh_token);
    usingPlatform = true;
  }

  return {
    // What the org has configured (may be empty if using platform default)
    provider:          orgEsign.provider     || null,
    client_id:         orgEsign.client_id    || '',
    redirect_uri:      orgEsign.redirect_uri || '',
    // Status flags for the UI
    connected,
    usingPlatform,
    platformAvailable,
    platformProvider,
    // All available providers for the dropdown
    providers: listProviders(),
  };
}

/**
 * Save BYOL credentials for an org.
 * Clears any previously stored tokens since credentials changed.
 */
async function saveProviderConfig(orgId, { provider, client_id, client_secret, redirect_uri }) {
  if (!provider)      throw Object.assign(new Error('provider is required'),      { status: 400 });
  if (!client_id)     throw Object.assign(new Error('client_id is required'),     { status: 400 });
  if (!client_secret) throw Object.assign(new Error('client_secret is required'), { status: 400 });

  await saveOrgEsignBlock(orgId, {
    provider,
    client_id,
    client_secret,
    redirect_uri:  redirect_uri || '',
    access_token:  null,
    refresh_token: null,
    token_expiry:  null,
  });
}

/**
 * Generate the OAuth URL for either:
 *   - BYOL: org admin connecting their own Zoho/DocuSign account
 *   - Platform: you (the platform operator) connecting the shared account
 *               Pass orgId = null and mode = 'platform'
 */
async function getAuthUrl(orgId, mode = 'org') {
  if (mode === 'platform') {
    const providerId = process.env.ESIGN_PROVIDER;
    const clientId   = process.env.ESIGN_CLIENT_ID;
    const redirectUri = process.env.ESIGN_REDIRECT_URI;

    if (!providerId)  throw Object.assign(new Error('ESIGN_PROVIDER env var not set'),      { status: 400 });
    if (!clientId)    throw Object.assign(new Error('ESIGN_CLIENT_ID env var not set'),     { status: 400 });
    if (!redirectUri) throw Object.assign(new Error('ESIGN_REDIRECT_URI env var not set'),  { status: 400 });

    const { getProvider } = require('./EsignProviderFactory');
    const provider = getProvider(providerId);
    return provider.getAuthUrl(clientId, redirectUri);
  }

  // BYOL — org connecting their own account
  const settings = await getOrgSettings(orgId);
  const esign    = settings.esign;

  if (!esign?.provider)     throw Object.assign(new Error('No provider configured for this org'), { status: 400 });
  if (!esign?.client_id)    throw Object.assign(new Error('client_id not set'), { status: 400 });
  if (!esign?.redirect_uri) throw Object.assign(new Error('redirect_uri not set'), { status: 400 });

  const resolved = getOrgProvider(settings);
  return resolved.provider.getAuthUrl(esign.client_id, esign.redirect_uri);
}

/**
 * Handle the OAuth callback — exchange the code for tokens and store them.
 * mode = 'org'      → tokens saved to organizations.settings.esign
 * mode = 'platform' → tokens saved to platform_esign_tokens
 */
async function handleOAuthCallback(orgId, code, mode = 'org') {
  if (mode === 'platform') {
    const providerId  = process.env.ESIGN_PROVIDER;
    const { getProvider } = require('./EsignProviderFactory');
    const provider    = getProvider(providerId);
    const credentials = {
      client_id:     process.env.ESIGN_CLIENT_ID,
      client_secret: process.env.ESIGN_CLIENT_SECRET,
      redirect_uri:  process.env.ESIGN_REDIRECT_URI,
    };
    const tokens = await provider.exchangeCodeForTokens(code, credentials);
    await savePlatformTokens(providerId, tokens);
    return { connected: true, mode: 'platform' };
  }

  // BYOL
  const settings   = await getOrgSettings(orgId);
  const resolved   = getOrgProvider(settings);
  if (!resolved)   throw Object.assign(new Error('No provider configured for this org'), { status: 400 });

  const tokens = await resolved.provider.exchangeCodeForTokens(code, resolved.credentials);
  await saveOrgEsignField(orgId, 'access_token',  tokens.access_token);
  await saveOrgEsignField(orgId, 'refresh_token', tokens.refresh_token);
  await saveOrgEsignField(orgId, 'token_expiry',  tokens.token_expiry);

  return { connected: true, mode: 'org' };
}

/**
 * Disconnect — clears tokens but preserves static config so reconnecting is easy.
 * mode = 'org' clears the org's tokens; mode = 'platform' clears platform tokens.
 */
async function disconnectProvider(orgId, mode = 'org') {
  if (mode === 'platform') {
    const providerId = process.env.ESIGN_PROVIDER;
    if (providerId) {
      await pool.query(
        `UPDATE platform_esign_tokens
         SET access_token = NULL, refresh_token = NULL, token_expiry = NULL
         WHERE provider = $1`,
        [providerId]
      );
    }
    return;
  }
  await saveOrgEsignField(orgId, 'access_token',  null);
  await saveOrgEsignField(orgId, 'refresh_token', null);
  await saveOrgEsignField(orgId, 'token_expiry',  null);
}

/**
 * Remove all BYOL config for an org — they revert to the platform default.
 */
async function removeOrgProvider(orgId) {
  await pool.query(
    `UPDATE organizations
     SET settings = settings - 'esign'
     WHERE id = $1`,
    [orgId]
  );
}

/**
 * Validate the active connection for an org (BYOL or platform).
 */
async function validateConnection(orgId) {
  const resolved = await resolveActiveProvider(orgId);
  if (!resolved) return { valid: false, message: 'No e-signature provider configured' };

  if (!resolved.credentials.access_token) {
    return {
      valid:   false,
      message: resolved.credentialSource === 'platform'
        ? 'Platform signing account not connected — contact your administrator'
        : 'Not connected — complete OAuth setup in Org Settings',
    };
  }

  const result = await resolved.provider.validateCredentials(resolved.credentials);
  return { ...result, credentialSource: resolved.credentialSource };
}

// ── Core signing operations ──────────────────────────────────────────────

/**
 * Trigger a signing request at the provider for a contract.
 * Called from contracts.routes after contractService moves status to in_signatures.
 *
 * Uses BYOL if org has own credentials; falls back to platform otherwise.
 * Gracefully skips (non-fatal) if neither is configured.
 */
async function triggerSigning(orgId, contract, signatories) {
  if (!signatories?.length) {
    console.log(`[SignatureService] No signatories on contract ${contract.id} — skipping provider call`);
    return { requestId: null, providerSkipped: true, reason: 'no_signatories' };
  }

  const resolved = await resolveActiveProvider(orgId);

  if (!resolved) {
    console.log(`[SignatureService] No esign provider for org ${orgId} — skipping (manual tracking only)`);
    return { requestId: null, providerSkipped: true, reason: 'no_provider' };
  }

  if (!resolved.credentials.access_token || !resolved.credentials.refresh_token) {
    throw Object.assign(
      new Error(
        resolved.credentialSource === 'platform'
          ? 'Platform signing account is not connected — contact your administrator'
          : 'Your e-signature provider is not connected — complete OAuth setup in Org Settings'
      ),
      { status: 400, code: 'ESIGN_NOT_CONNECTED' }
    );
  }

  const result = await resolved.provider.sendSigningRequest(
    orgId,
    resolved.credentials,
    contract,
    signatories,
    resolved.onTokenRefresh    // provider calls this if it refreshes the token mid-request
  );

  if (result.requestId) {
    await pool.query(
      `UPDATE contracts
       SET esign_request_id = $2, esign_provider = $3, esign_credential_source = $4
       WHERE id = $1`,
      [contract.id, result.requestId, resolved.credentials.provider, resolved.credentialSource]
    );
  }

  return result;
}

/**
 * Cancel a signing request at the provider (on recall or void).
 * Non-fatal — contract state change proceeds even if this fails.
 */
async function cancelSigning(orgId, contractId) {
  try {
    const r = await pool.query(
      `SELECT esign_request_id FROM contracts WHERE id = $1 AND org_id = $2`,
      [contractId, orgId]
    );
    const requestId = r.rows[0]?.esign_request_id;
    if (!requestId) return;

    const resolved = await resolveActiveProvider(orgId);
    if (!resolved)  return;

    await resolved.provider.cancelSigningRequest(
      orgId, resolved.credentials, requestId, resolved.onTokenRefresh
    );
  } catch (err) {
    console.error(`[SignatureService] cancelSigning failed for contract ${contractId}:`, err.message);
  }
}

/**
 * Parse an inbound webhook from a provider into a normalised ActionCRM event.
 */
async function handleWebhook(providerId, rawBody, headers) {
  const { getProvider } = require('./EsignProviderFactory');
  const provider = getProvider(providerId);
  return provider.parseWebhookPayload(rawBody, headers);
}

module.exports = {
  // OrgAdmin config
  getEsignConfig,
  saveProviderConfig,
  getAuthUrl,
  handleOAuthCallback,
  disconnectProvider,
  removeOrgProvider,
  validateConnection,
  // Signing operations
  triggerSigning,
  cancelSigning,
  handleWebhook,
  // Token store (used by platform setup route in contracts.routes)
  savePlatformTokens,
  getPlatformTokens,
};
