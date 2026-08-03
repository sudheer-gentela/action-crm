const { Client } = require('@microsoft/microsoft-graph-client');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const { getTokenByUserId, saveUserToken, refreshUserToken } = require('./oauthTokenService');

const msalConfig = {
  auth: {
    clientId:     process.env.MICROSOFT_CLIENT_ID,
    authority:    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  }
};

const cca = new ConfidentialClientApplication(msalConfig);

// ── Scopes ────────────────────────────────────────────────────────────────────
// Now defined once in config/microsoftScopes.js. There used to be a second,
// hard-coded copy inside oauthTokenService.refreshUserToken, so changing this list
// alone silently downgraded every refreshed token back to the old scopes.
//
// Files.ReadWrite (was Files.Read) — users who consented under the old list are
// prompted to re-consent once when they next click "Connect Outlook". Until
// they do, refreshMicrosoftToken keeps their mail working on the scopes they
// already granted; only file WRITE waits for the reconnect.
const { MICROSOFT_SCOPES: SCOPES, refreshMicrosoftToken } = require('../config/microsoftScopes');

/**
 * Get authorization URL for OAuth flow
 */
async function getAuthUrl(state) {
  const authCodeUrlParameters = {
    scopes:       SCOPES,
    redirectUri:  process.env.MICROSOFT_REDIRECT_URI,
    state,
    // NOTE: do NOT use prompt: 'consent' here.
    // On the Microsoft v2 endpoint the refresh_token is obtained via the
    // 'offline_access' scope (already in SCOPES) — prompt=consent is NOT needed
    // for that. Forcing prompt=consent re-shows the consent dialog on every
    // sign-in; for a non-admin user in a tenant where this app requires admin
    // consent, that forced re-consent renders as "Approval required" even when
    // tenant-wide admin consent already exists. Omitting prompt lets Azure honor
    // the existing admin consent and sign the user in silently.
    // (This is the key difference from Google, where access_type=offline +
    //  prompt=consent IS the documented way to force a refresh token.)
    prompt:       'select_account',
    responseMode: 'query',
    responseType: 'code'
  };
  return await cca.getAuthCodeUrl(authCodeUrlParameters);
}

/**
 * Exchange authorization code for tokens.
 * Uses direct HTTP POST to avoid MSAL hiding the refresh_token.
 */
async function getTokenFromCode(code) {
  const tenantId  = process.env.MICROSOFT_TENANT_ID;
  const tokenUrl  = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    code,
    redirect_uri:  process.env.MICROSOFT_REDIRECT_URI,
    grant_type:    'authorization_code',
    scope:         SCOPES.join(' '),
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const data = response.data;
  console.log('🔑 Direct token exchange — refresh_token present:', !!data.refresh_token);

  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresOn:    new Date(Date.now() + data.expires_in * 1000),
    account:      null,
  };
}

/**
 * Get Microsoft Graph client for user (handles token refresh)
 */
async function getGraphClient(userId) {
  let tokenData = await getTokenByUserId(userId, 'outlook');

  const expiresAt = new Date(tokenData.expires_at);
  if (new Date() >= expiresAt) {
    tokenData = await refreshUserToken(userId, 'outlook');
  }

  return Client.init({
    authProvider: (done) => done(null, tokenData.access_token)
  });
}

/**
 * Build a Graph client from an explicit access token (used by prospecting
 * sender accounts whose tokens live in prospecting_sender_accounts, not
 * oauth_tokens). If senderEmail + refreshToken are provided, proactively
 * refreshes the token when within 5 minutes of expiry and writes the new
 * value back to prospecting_sender_accounts. Detects invalid_grant
 * (revoked tokens) and throws a clear "needs to be reconnected" error.
 *
 * Used by fetchEmails, fetchEmailById, sendEmail, and getProfileWithAccessToken's
 * downstream consumers via the same signature pattern.
 */
async function _getGraphClientFromAccessToken({ accessToken, refreshToken = null, senderEmail = null }) {
  let resolvedAccessToken = accessToken;

  if (senderEmail && refreshToken) {
    try {
      const { pool } = require('../config/database');
      const expiryRes = await pool.query(
        `SELECT expires_at FROM prospecting_sender_accounts WHERE email = $1 LIMIT 1`,
        [senderEmail]
      );
      const rawExpiry = expiryRes.rows[0]?.expires_at;

      if (rawExpiry) {
        const expiresAt = new Date(rawExpiry).getTime();
        const isExpired = expiresAt < Date.now() + 5 * 60 * 1000; // 5-min buffer

        if (isExpired) {
          console.log(`🔄 Outlook sender ${senderEmail} token expires at ${rawExpiry} — refreshing proactively`);
          const { data: refreshed, downgraded } = await refreshMicrosoftToken(axios, refreshToken);
          if (downgraded) {
            console.warn(
              `⚠️  Outlook sender ${senderEmail} has not consented to Files.ReadWrite — ` +
              `refreshed on their existing scopes. Mail is unaffected; writing files to ` +
              `OneDrive will fail until they reconnect in Settings → Outreach.`
            );
          }
          const response = { data: refreshed };
          resolvedAccessToken = response.data.access_token;
          const newRefresh = response.data.refresh_token || refreshToken;
          const newExpiry  = new Date(Date.now() + response.data.expires_in * 1000);
          await pool.query(
            `UPDATE prospecting_sender_accounts
                SET access_token = $1, refresh_token = $2, expires_at = $3, updated_at = CURRENT_TIMESTAMP
              WHERE email = $4`,
            [resolvedAccessToken, newRefresh, newExpiry, senderEmail]
          );
          console.log(`✅ Outlook sender ${senderEmail} token refreshed, new expiry: ${newExpiry}`);
        }
      } else {
        console.log(`ℹ️  Outlook sender ${senderEmail} has no expires_at — skipping proactive refresh`);
      }
    } catch (refreshErr) {
      const errData = refreshErr.response?.data || {};
      const isRevoked =
        errData.error === 'invalid_grant' ||
        /AADSTS70008|AADSTS700082|invalid_grant/i.test(errData.error_description || refreshErr.message || '');
      if (isRevoked) {
        throw new Error(`invalid_grant: Outlook sender ${senderEmail} needs to be reconnected in Settings → Outreach.`);
      }
      console.warn(`⚠️  Outlook proactive refresh failed for ${senderEmail} (non-fatal):`, refreshErr.message);
    }
  }

  return Client.init({
    authProvider: (done) => done(null, resolvedAccessToken),
  });
}

/**
 * Fetch recent emails from Outlook.
 *
 * Two auth modes (same pattern as sendEmail):
 *  - Standard:    pass only userId; tokens read from oauth_tokens.
 *  - Prospecting: pass options.accessToken (+ refreshToken + senderEmail);
 *                 skips the DB lookup, reads the sender's own mailbox.
 */
async function fetchEmails(userId, options = {}) {
  try {
    const {
      top = 50, skip = 0, orderBy = 'receivedDateTime DESC',
      filter = null, since = null,
      accessToken = null, refreshToken = null, senderEmail = null,
    } = options;

    const client = accessToken
      ? await _getGraphClientFromAccessToken({ accessToken, refreshToken, senderEmail })
      : await getGraphClient(userId);

    let query = client
      .api('/me/messages')
      .select([
        'id', 'subject', 'from', 'toRecipients', 'ccRecipients',
        'receivedDateTime', 'bodyPreview', 'body', 'importance',
        'hasAttachments', 'conversationId', 'isRead', 'categories', 'internetMessageId'
      ].join(','))
      .top(top)
      .skip(skip)
      .orderby(orderBy);

    if (since)  query = query.filter(`receivedDateTime gt ${new Date(since).toISOString()}`);
    if (filter) query = query.filter(filter);

    const result = await query.get();
    return {
      emails:   result.value,
      hasMore:  result['@odata.nextLink'] != null,
      nextLink: result['@odata.nextLink']
    };
  } catch (error) {
    console.error('Error fetching emails:', error);
    throw new Error(`Failed to fetch emails: ${error.message}`);
  }
}

/**
 * Fetch single email by ID
 */
async function fetchEmailById(userId, emailId) {
  try {
    const client = await getGraphClient(userId);
    return await client
      .api(`/me/messages/${emailId}`)
      .select([
        'id', 'subject', 'from', 'toRecipients', 'ccRecipients',
        'receivedDateTime', 'body', 'importance',
        'hasAttachments', 'conversationId', 'isRead', 'categories', 'internetMessageId'
      ].join(','))
      .get();
  } catch (error) {
    throw new Error(`Failed to fetch email: ${error.message}`);
  }
}

/**
 * Send an email via Outlook / Microsoft Graph.
 *
 * @param {number} userId
 * @param {object} opts
 * @param {string}   opts.to              — recipient email address
 * @param {string}   opts.subject
 * @param {string}   opts.body            — plain text or HTML
 * @param {boolean}  [opts.isHtml=false]  — true if body is HTML
 * @param {string}   [opts.replyToId]     — Graph message ID to reply to (optional)
 * @param {string}   [opts.saveToSentItems=true]
 * @returns {Promise<void>}  Graph returns 202 Accepted with no body on success
 */
/**
 * Send an email via Outlook.
 *
 * Two auth modes:
 *  - Standard: pass only `userId`; tokens are read from `oauth_tokens` via
 *    getGraphClient(userId). Used by personal/main Outlook integration.
 *  - Prospecting sender: pass `accessToken`, `refreshToken`, and `senderEmail`.
 *    Skips the DB token lookup. If the access token is near expiry, refreshes
 *    it via Microsoft's token endpoint and writes the new value back to
 *    `prospecting_sender_accounts` (keyed by senderEmail) so subsequent sends
 *    pick it up. Mirrors googleService.sendEmail's prospecting branch.
 */
async function sendEmail(userId, {
  to, subject, body, isHtml = false,
  replyToId = null, saveToSentItems = true,
  accessToken = null, refreshToken = null, senderEmail = null,
  thread = null,
}) {
  try {
    const client = accessToken
      ? await _getGraphClientFromAccessToken({ accessToken, refreshToken, senderEmail })
      : await getGraphClient(userId);

    const message = {
      subject,
      body: {
        contentType: isHtml ? 'HTML' : 'Text',
        content:     body,
      },
      toRecipients: [
        { emailAddress: { address: to } }
      ],
    };

    // ── Threaded path (opt-in, 2026_71): draft-then-send to capture ids ───────
    // /sendMail and /reply return 202 No Content — they never hand back the
    // created message, so we can't capture the id/conversationId needed to thread
    // the NEXT step. The threaded path creates the message as a draft (which DOES
    // return those) and then sends it. Immutable IDs (Prefer header) keep the id
    // valid across the Drafts→Sent move so it stays a usable createReply target.
    if (thread) {
      const IMMUTABLE = 'IdType="ImmutableId"';
      let draft;

      if (thread.replyToMessageId) {
        // createReply nests in the same conversation and seeds In-Reply-To/
        // References automatically; we overwrite the body (drop quoted history)
        // and set the subject to whatever the caller resolved (keep vs Re:).
        draft = await client
          .api(`/me/messages/${thread.replyToMessageId}/createReply`)
          .header('Prefer', IMMUTABLE)
          .post({});
        const patch = { body: { contentType: isHtml ? 'HTML' : 'Text', content: body } };
        if (subject) patch.subject = subject;
        await client
          .api(`/me/messages/${draft.id}`)
          .header('Prefer', IMMUTABLE)
          .patch(patch);
      } else {
        // Root of the thread — create a fresh draft we can send and read ids off.
        draft = await client
          .api('/me/messages')
          .header('Prefer', IMMUTABLE)
          .post(message);
      }

      await client
        .api(`/me/messages/${draft.id}/send`)
        .post({});

      console.log(`📤 Sent threaded email via Outlook (${senderEmail || 'default'}) to ${to} — msgId: ${draft.id}, conv: ${draft.conversationId || 'n/a'}`);
      return {
        messageId:         draft.id,
        conversationId:    draft.conversationId    || null,
        internetMessageId: draft.internetMessageId || null,
      };
    }

    // ── Fast path (unchanged) ──────────────────────────────────────
    if (replyToId) {
      // Reply to an existing thread — Graph puts it in the same conversation
      await client
        .api(`/me/messages/${replyToId}/reply`)
        .post({ message, comment: body });
    } else {
      // New message
      await client
        .api('/me/sendMail')
        .post({ message, saveToSentItems });
    }

    console.log(`📤 Sent email via Outlook (${senderEmail || 'default'}) to ${to} — subject: "${subject}"`);
    return { messageId: null, conversationId: null, internetMessageId: null };
  } catch (error) {
    console.error('Error sending email via Outlook:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Get user profile info
 */
async function getUserProfile(userId) {
  try {
    const client = await getGraphClient(userId);
    return await client
      .api('/me')
      .select('id,displayName,mail,userPrincipalName')
      .get();
  } catch (error) {
    throw new Error(`Failed to fetch user profile: ${error.message}`);
  }
}

/**
 * Get user profile using an access token directly — bypasses the DB token
 * lookup. Used in the OAuth callback for "prospecting" / "prospecting_client"
 * modes, where tokens haven't been saved to oauth_tokens yet (they go into
 * prospecting_sender_accounts instead) but we still need the user's email
 * + display name to seed that row. The standard mode saves to oauth_tokens
 * first and can use the userId-based getUserProfile() above.
 */
async function getProfileWithAccessToken(accessToken) {
  try {
    const client = Client.init({
      authProvider: (done) => done(null, accessToken)
    });
    return await client
      .api('/me')
      .select('id,displayName,mail,userPrincipalName')
      .get();
  } catch (error) {
    throw new Error(`Failed to fetch user profile: ${error.message}`);
  }
}

module.exports = {
  getAuthUrl,
  getTokenFromCode,
  fetchEmails,
  fetchEmailById,
  sendEmail,
  getUserProfile,
  getProfileWithAccessToken,
  SCOPES
};
