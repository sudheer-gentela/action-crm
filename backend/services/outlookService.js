const { Client } = require('@microsoft/microsoft-graph-client');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const { getTokenByUserId, saveUserToken, refreshUserToken } = require('./tokenService');

const msalConfig = {
  auth: {
    clientId:     process.env.MICROSOFT_CLIENT_ID,
    authority:    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  }
};

const cca = new ConfidentialClientApplication(msalConfig);

// ── Scopes ────────────────────────────────────────────────────────────────────
// Mail.Send added — users who already consented with the old scope list will be
// prompted to re-consent once when they next click "Connect Outlook".
const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',   // ← NEW
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
  'https://graph.microsoft.com/Files.Read',
];

/**
 * Get authorization URL for OAuth flow
 */
async function getAuthUrl(state) {
  const authCodeUrlParameters = {
    scopes:       SCOPES,
    redirectUri:  process.env.MICROSOFT_REDIRECT_URI,
    state,
    prompt:       'consent',
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
 * Fetch recent emails from Outlook
 */
async function fetchEmails(userId, options = {}) {
  try {
    const client = await getGraphClient(userId);
    const { top = 50, skip = 0, orderBy = 'receivedDateTime DESC', filter = null, since = null } = options;

    let query = client
      .api('/me/messages')
      .select([
        'id', 'subject', 'from', 'toRecipients', 'ccRecipients',
        'receivedDateTime', 'bodyPreview', 'body', 'importance',
        'hasAttachments', 'conversationId', 'isRead', 'categories'
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
        'hasAttachments', 'conversationId', 'isRead', 'categories'
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
}) {
  try {
    let client;

    if (accessToken) {
      // ── Prospecting sender path ──────────────────────────────────────
      let resolvedAccessToken = accessToken;

      if (senderEmail && refreshToken) {
        // Proactively refresh if the access token is expired or within
        // 5 minutes of expiry. Mirrors the Gmail flow — prevents the
        // ghost-send pattern where an expired token causes a silent
        // failure after DB writes.
        try {
          const { pool } = require('../config/database');
          const expiryRes = await pool.query(
            `SELECT expires_at FROM prospecting_sender_accounts WHERE email = $1 LIMIT 1`,
            [senderEmail]
          );
          const rawExpiry = expiryRes.rows[0]?.expires_at;

          if (rawExpiry) {
            const expiresAt = new Date(rawExpiry).getTime();
            const isExpired = expiresAt < Date.now() + 5 * 60 * 1000;

            if (isExpired) {
              console.log(`🔄 Outlook sender ${senderEmail} token expires at ${rawExpiry} — refreshing proactively`);
              const tenantId = process.env.MICROSOFT_TENANT_ID;
              const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
              const params = new URLSearchParams({
                client_id:     process.env.MICROSOFT_CLIENT_ID,
                client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type:    'refresh_token',
                scope:         SCOPES.join(' '),
              });
              const response = await axios.post(tokenUrl, params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              });
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
          // Only block the send on confirmed revocation. Other errors
          // (network, DB) fall through and we try with the existing token.
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

      client = Client.init({
        authProvider: (done) => done(null, resolvedAccessToken),
      });
    } else {
      // ── Standard path: read from oauth_tokens by userId ─────────────
      client = await getGraphClient(userId);
    }

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
