// ─────────────────────────────────────────────────────────────────────────────
// config/teamsScopes.js
//
// DROP-IN LOCATION: backend/config/teamsScopes.js
//
// Microsoft Graph scopes for the TEAMS app registration — deliberately a
// separate file, a separate list, and a separate Azure app from
// config/microsoftScopes.js.
//
// WHY NOT JUST ADD TO MICROSOFT_SCOPES
//   That list is shared by Outlook, OneDrive and calendar, and
//   refreshMicrosoftToken() exists because growing it breaks everyone already
//   connected: on the v2 endpoint a refresh_token grant asking for a scope the
//   user never consented to fails AADSTS65001, so the helper retries with no
//   scope parameter and returns whatever was originally granted. That is the
//   right behaviour for mail — it keeps working — but it means a Teams scope
//   added there would be silently absent for every existing user, with mail
//   fine, Teams dead, and nothing anywhere saying why. Each rep would have to
//   reconnect Outlook to fix Teams, which nobody would ever guess.
//
//   A separate registration makes Teams consent its own visible event, lets the
//   Teams secret rotate on its own schedule, and keeps the consent screen a
//   customer's security team reviews down to Teams permissions only.
//
// KEEP IN SYNC with the Azure app registration
// (portal.azure.com → App registrations → GoWarm Teams Integration →
//  API permissions, Delegated). A scope requested here but not registered there
// is rejected at consent.
//
// ENV VARS — all distinct from the Outlook ones:
//   MICROSOFT_TEAMS_CLIENT_ID
//   MICROSOFT_TEAMS_CLIENT_SECRET
//   MICROSOFT_TEAMS_AUTHORITY      optional, defaults to 'organizations'
//   MICROSOFT_TEAMS_REDIRECT_URI
//
// WHY 'organizations' AND NOT 'common'
//   The Outlook app is registered for All Microsoft account users and uses
//   /common. Teams work-or-school chat does not exist for a personal Microsoft
//   account and none of the scopes below are grantable to one, so /common would
//   only ever produce a sign-in that consents successfully and then returns an
//   empty chat list. 'organizations' rejects it at the door with an error the
//   rep can act on. Register the Teams app as AzureADMultipleOrgs to match.
//
// ADMIN CONSENT IS REQUIRED, AND WOULD BE ANYWAY
//   ChannelMessage.Read.All is admin-consent-required as a delegated scope, so
//   every tenant needs one pass through /adminconsent regardless. Worth knowing
//   because it means the missing verified-publisher MPN ID on the Outlook
//   registration costs nothing here: user consent was never going to be enough
//   for a connection that includes channels.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const GRAPH = 'https://graph.microsoft.com';

const TEAMS_SCOPES = [
  // Identity. /me gives the Entra object id that teams_connections stores and
  // that every chatMessage.from.user.id is matched against. Without it a sender
  // can only be resolved by display name, which is not an identity.
  `${GRAPH}/User.Read`,

  // Chats the signed-in user is in: list them for discovery, read their
  // messages, and — the part that matters — subscribe to
  // /chats/{chat-id}/messages, which accepts this delegated scope on v1.0.
  `${GRAPH}/Chat.Read`,

  // Channels. Team.ReadBasic.All enumerates /me/joinedTeams and
  // Channel.ReadBasic.All lists the channels inside them; neither reads a
  // single message. ChannelMessage.Read.All is the one that does, and it is the
  // only admin-consent-required scope in this list.
  `${GRAPH}/Team.ReadBasic.All`,
  `${GRAPH}/Channel.ReadBasic.All`,
  `${GRAPH}/ChannelMessage.Read.All`,

  'offline_access',
];

// NOT REQUESTED, deliberately:
//
//   Files.Read.All      Teams attachments are references — the chatMessage
//                       carries the file's name and contentUrl already, and
//                       phase 1 stores exactly that and fetches no bytes. Ask
//                       for this only when something actually needs to open a
//                       customer's SharePoint document, and ask then, so the
//                       consent screen stays honest about what we read.
//
//   Chat.ReadWrite      Read-only by design, same posture as the WhatsApp
//                       session worker. Nothing here sends.
//
//   ChannelMessage.Send Same.
//
//   Subscription.Read.All
//                       Only needed to LIST subscriptions belonging to others.
//                       teams_subscriptions is our registry; we never enumerate
//                       Graph's.

/**
 * Refresh a Teams access token.
 *
 * Same graceful-downgrade shape as refreshMicrosoftToken, and for the same
 * reason: the day Files.Read.All or anything else joins the list above, every
 * already-connected rep's refresh would start failing AADSTS65001 and look, to
 * the existing revocation handling, exactly like a mass revocation.
 *
 * The difference from the Outlook helper is what a downgrade MEANS. There, mail
 * keeps working and only file-write is lost, so degrading quietly is right.
 * Here the scopes are not separable — a token without Chat.Read cannot read
 * chats — so the caller is told, via `downgraded`, and is expected to move the
 * connection to 'consent_required' rather than carry on with a token that will
 * 403 on every call.
 *
 * Returns { data, downgraded }.
 */
async function refreshTeamsToken(axios, refreshToken) {
  const authority = process.env.MICROSOFT_TEAMS_AUTHORITY || 'organizations';
  const tokenUrl  = `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;

  const base = {
    client_id:     process.env.MICROSOFT_TEAMS_CLIENT_ID,
    client_secret: process.env.MICROSOFT_TEAMS_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  };

  try {
    const params = new URLSearchParams({ ...base, scope: TEAMS_SCOPES.join(' ') });
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

/**
 * The URL a tenant admin visits once to approve this app for their whole
 * organisation. Needed because ChannelMessage.Read.All cannot be user-consented.
 *
 * state should carry enough to identify the org on the way back — the admin who
 * clicks this is frequently not the rep who asked for it, and may not have a
 * GoWarmCRM session at all.
 */
function adminConsentUrl(state) {
  const authority = process.env.MICROSOFT_TEAMS_AUTHORITY || 'organizations';
  const params = new URLSearchParams({
    client_id:    process.env.MICROSOFT_TEAMS_CLIENT_ID,
    redirect_uri: process.env.MICROSOFT_TEAMS_REDIRECT_URI,
    state:        state || '',
  });
  return `https://login.microsoftonline.com/${authority}/v2.0/adminconsent?${params.toString()}`;
}

/** Fail loudly at boot rather than at a rep's first click. */
function assertTeamsConfigured() {
  const missing = [
    'MICROSOFT_TEAMS_CLIENT_ID',
    'MICROSOFT_TEAMS_CLIENT_SECRET',
    'MICROSOFT_TEAMS_REDIRECT_URI',
  ].filter((k) => !process.env[k]);

  if (missing.length) {
    throw new Error(
      `Teams integration is not configured — missing ${missing.join(', ')}. ` +
      'These are DISTINCT from the MICROSOFT_* Outlook variables and belong to ' +
      'the separate GoWarm Teams Integration app registration.'
    );
  }
}

module.exports = {
  TEAMS_SCOPES,
  refreshTeamsToken,
  adminConsentUrl,
  assertTeamsConfigured,
};
