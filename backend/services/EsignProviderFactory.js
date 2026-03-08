/**
 * EsignProviderFactory.js
 *
 * DROP-IN LOCATION: backend/services/EsignProviderFactory.js
 *
 * ── Credential resolution order ─────────────────────────────────────────
 *
 *  1. BYOL (org-level)   — org has their own client_id in organizations.settings.esign
 *                          Token refresh writes back to that org's DB row.
 *                          Org admin sets this up via Org Admin → E-Signature tab.
 *
 *  2. Platform (default) — no org-level credentials found; fall back to
 *                          Railway environment variables (your Zoho account).
 *                          Token refresh writes back to platform_esign_tokens table.
 *                          You set this up once as the platform operator.
 *
 *  3. null               — neither configured; signing is skipped gracefully,
 *                          manual tracking in ActionCRM still works.
 *
 * ── Adding a new provider ───────────────────────────────────────────────
 *  1. Create DocuSignProvider.js extending EsignProviderBase
 *  2. Add an entry to REGISTERED_PROVIDERS — nothing else changes
 *
 * ── Railway env vars for the platform account ───────────────────────────
 *  ESIGN_PROVIDER        = zoho          (which provider you've set up)
 *  ESIGN_CLIENT_ID       = ...           (from Zoho API console)
 *  ESIGN_CLIENT_SECRET   = ...           (from Zoho API console)
 *  ESIGN_REDIRECT_URI    = https://your-backend.railway.app/api/contracts/admin/esign-callback
 *
 *  Tokens (access_token, refresh_token, token_expiry) are NOT stored in env vars
 *  because they rotate. They live in the platform_esign_tokens table instead.
 *  See migration_esign.sql for the table definition.
 */

const ZohoSignProvider    = require('./ZohoSignProvider');
// const DocuSignProvider = require('./DocuSignProvider');   ← uncomment when built

// ── Registered providers ─────────────────────────────────────────────────
// Each entry: { id, displayName, instance }
// id must match the value stored in organizations.settings.esign.provider
// and in the ESIGN_PROVIDER env var.

const REGISTERED_PROVIDERS = [
  {
    id:          'zoho',
    displayName: 'Zoho Sign',
    instance:    new ZohoSignProvider(),
  },
  // {
  //   id:          'docusign',
  //   displayName: 'DocuSign',
  //   instance:    new DocuSignProvider(),
  // },
];

// ── Provider lookup ──────────────────────────────────────────────────────

/**
 * Returns the provider instance for the given providerId.
 * Throws a clear error if the provider is not registered.
 */
function getProvider(providerId) {
  const entry = REGISTERED_PROVIDERS.find(p => p.id === providerId);
  if (!entry) {
    const available = REGISTERED_PROVIDERS.map(p => p.id).join(', ');
    throw new Error(
      `Unknown esign provider "${providerId}". ` +
      `Registered providers: ${available}. ` +
      `To add a new provider, create the adapter and register it in EsignProviderFactory.js.`
    );
  }
  return entry.instance;
}

/**
 * Returns metadata for all registered providers.
 * Used to populate the provider dropdown in OrgAdminView.
 */
function listProviders() {
  return REGISTERED_PROVIDERS.map(({ id, displayName }) => ({ id, displayName }));
}

// ── Credential resolution ────────────────────────────────────────────────

/**
 * Resolves which credentials to use for an org and returns a ready-to-use
 * { provider, credentials, credentialSource } object, or null if nothing is configured.
 *
 * credentialSource is either 'org' (BYOL) or 'platform' (default).
 * signatureService uses this to know where to write refreshed tokens back to.
 *
 * @param {object} orgSettings  — the full settings JSONB from organizations table
 * @param {object} platformTokens — live tokens for the platform account,
 *                                  fetched from platform_esign_tokens by signatureService.
 *                                  Pass null when platform tokens aren't needed
 *                                  (e.g. during org admin config calls).
 */
function resolveProvider(orgSettings, platformTokens = null) {

  // ── Path 1: BYOL — org has their own credentials ────────────────────
  const orgEsign = orgSettings?.esign;
  if (orgEsign?.provider && orgEsign?.client_id) {
    return {
      provider:         getProvider(orgEsign.provider),
      credentials:      orgEsign,          // full esign block from org settings
      credentialSource: 'org',
    };
  }

  // ── Path 2: Platform default — fall back to Railway env vars + DB tokens ─
  const platformProvider = process.env.ESIGN_PROVIDER;
  const platformClientId = process.env.ESIGN_CLIENT_ID;

  if (platformProvider && platformClientId) {
    return {
      provider: getProvider(platformProvider),
      credentials: {
        provider:      platformProvider,
        client_id:     platformClientId,
        client_secret: process.env.ESIGN_CLIENT_SECRET || '',
        redirect_uri:  process.env.ESIGN_REDIRECT_URI  || '',
        // Live tokens come from platform_esign_tokens table (not env vars)
        // signatureService fetches these and passes them in via platformTokens
        access_token:  platformTokens?.access_token  || null,
        refresh_token: platformTokens?.refresh_token || null,
        token_expiry:  platformTokens?.token_expiry  || null,
      },
      credentialSource: 'platform',
    };
  }

  // ── Path 3: Nothing configured ───────────────────────────────────────
  return null;
}

/**
 * Convenience wrapper used by OrgAdmin routes that only need the org-level
 * provider (e.g. getAuthUrl, saveProviderConfig).
 * Does NOT fall back to platform credentials — explicitly org-only.
 */
function getOrgProvider(orgSettings) {
  const orgEsign = orgSettings?.esign;
  if (!orgEsign?.provider || !orgEsign?.client_id) return null;
  return {
    provider:         getProvider(orgEsign.provider),
    credentials:      orgEsign,
    credentialSource: 'org',
  };
}

module.exports = { getProvider, listProviders, resolveProvider, getOrgProvider };
