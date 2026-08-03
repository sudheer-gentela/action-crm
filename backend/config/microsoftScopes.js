// ─────────────────────────────────────────────────────────────────────────────
// config/microsoftScopes.js
//
// ONE list of Microsoft Graph scopes.
//
// It lived in two places — outlookService.SCOPES and a hard-coded copy inside
// oauthTokenService.refreshUserToken — which meant changing one and not the other
// produced a silent, hard-to-spot failure: the auth URL asks for a scope, the
// user grants it, and then every token refresh quietly downgrades back to the
// old set. Files would 403 on write with nothing in the logs pointing at scope.
//
// A standalone module rather than exporting from outlookService, because
// outlookService already requires oauthTokenService — importing back the other way
// would be circular.
//
// KEEP IN SYNC with the Azure app registration
// (portal.azure.com → App registrations → GoWarm Outlook Integration →
//  API permissions, Delegated). A scope requested here but not registered there
// is rejected at consent.
//
// NOTE: this single registration serves BOTH Outlook and OneDrive —
// OneDriveProvider reads tokens under provider 'outlook'. There is no separate
// OneDrive app.
// ─────────────────────────────────────────────────────────────────────────────

const MICROSOFT_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
  // Files.Read → Files.ReadWrite. Read-only could not write into a mapped
  // folder. Delegated, so it acts as the signed-in user; Files.ReadWrite.All
  // (SharePoint libraries) is deliberately NOT requested until OneDriveProvider
  // stops being hard-wired to /me/drive and can actually use it.
  'https://graph.microsoft.com/Files.ReadWrite',
  'offline_access',
];

/**
 * Refresh an access token, degrading gracefully when the user has not yet
 * consented to a newly added scope.
 *
 * THE PROBLEM THIS SOLVES: on the v2 endpoint, asking a refresh_token grant for
 * a scope the user never consented to fails with AADSTS65001 — and the existing
 * error handling treats any invalid_grant as "revoked, reconnect". So simply
 * adding Files.ReadWrite to the refresh scope list would make every already-
 * connected user's mail sync start failing, and look like a mass revocation,
 * until each of them reconnected.
 *
 * Instead: ask for everything; if consent is the objection, retry once with no
 * scope parameter, which returns a token carrying whatever was originally
 * granted. Mail keeps working, file WRITE is simply unavailable for that user
 * until they reconnect, and it starts working by itself once they do.
 *
 * Returns { data, downgraded }.
 */
async function refreshMicrosoftToken(axios, refreshToken) {
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const base = {
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  };

  try {
    const params = new URLSearchParams({ ...base, scope: MICROSOFT_SCOPES.join(' ') });
    const res = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { data: res.data, downgraded: false };
  } catch (err) {
    const d = err.response?.data || {};
    const needsConsent = /AADSTS65001|AADSTS65004|consent/i.test(
      `${d.error_description || ''} ${err.message || ''}`
    );
    // Anything else — a genuinely revoked or expired grant — is rethrown so the
    // existing revocation handling still sees it.
    if (!needsConsent) throw err;

    const params = new URLSearchParams(base);   // no scope → the original grant
    const res = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return { data: res.data, downgraded: true };
  }
}

module.exports = { MICROSOFT_SCOPES, refreshMicrosoftToken };
