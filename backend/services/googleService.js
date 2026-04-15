// ─────────────────────────────────────────────────────────────────────────────
// services/googleService.js
//
// Google OAuth + Gmail / Calendar / Drive API integration.
// Mirrors outlookService.js patterns — uses oauth_tokens table via tokenService.
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');
const { getTokenByUserId, saveUserToken, refreshUserToken } = require('./tokenService');

// ── OAuth2 Client ─────────────────────────────────────────────────────────────

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ── Scopes ────────────────────────────────────────────────────────────────────
// Single consent covers Gmail + Calendar + Drive
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/**
 * Generate authorization URL for OAuth flow
 */
function getAuthUrl(state) {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    prompt: 'consent',        // force consent to always get refresh_token
    include_granted_scopes: true,
  });
}

/**
 * Exchange authorization code for tokens
 */
async function getTokenFromCode(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  console.log('🔑 Google token exchange — refresh_token present:', !!tokens.refresh_token);

  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresOn:    new Date(tokens.expiry_date || Date.now() + 3600000),
    account:      null,
  };
}

/**
 * Get an authenticated OAuth2 client for a user.
 * Proactively refreshes the token if expired — mirrors outlookService/calendarService pattern.
 */
async function getAuthenticatedClient(userId) {
  let tokenData = await getTokenByUserId(userId, 'google');

  // Proactively refresh if token is expired or within 60s of expiry
  const expiresAt = new Date(tokenData.expires_at).getTime();
  const isExpired = expiresAt < Date.now() + 60_000;
  if (isExpired) {
    console.log('🔄 Google token expired for user:', userId, '— refreshing proactively');
    try {
      tokenData = await refreshUserToken(userId, 'google');
    } catch (err) {
      console.error('❌ Google token refresh failed for user:', userId, err.message);
      throw new Error('Google token expired. Please reconnect your Google account in Settings.');
    }
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry_date:   new Date(tokenData.expires_at).getTime(),
  });

  // Auto-refresh listener — save new tokens if Google refreshes mid-session
  oauth2Client.on('tokens', async (tokens) => {
    console.log('🔄 Google token auto-refreshed mid-session for user:', userId);
    await saveUserToken(userId, 'google', {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token || tokenData.refresh_token,
      expiresOn:    new Date(tokens.expiry_date || Date.now() + 3600000),
      account:      null,
    });
  });

  return oauth2Client;
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

/**
 * Fetch recent emails from Gmail
 */
async function fetchEmails(userId, options = {}) {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const { maxResults = 50, query = '', pageToken = null } = options;

  const listParams = {
    userId: 'me',
    maxResults,
    q: query || undefined,
  };
  if (pageToken) listParams.pageToken = pageToken;

  const listRes = await gmail.users.messages.list(listParams);
  const messageIds = listRes.data.messages || [];

  // Fetch full message details in parallel (batches of 10)
  const emails = [];
  for (let i = 0; i < messageIds.length; i += 10) {
    const batch = messageIds.slice(i, i + 10);
    const details = await Promise.all(
      batch.map(m =>
        gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        })
      )
    );
    emails.push(...details.map(d => _parseGmailMessage(d.data)));
  }

  return {
    emails,
    hasMore:       !!listRes.data.nextPageToken,
    nextPageToken: listRes.data.nextPageToken || null,
  };
}

/**
 * Fetch a single email by ID
 */
async function fetchEmailById(userId, emailId) {
  const auth = await getAuthenticatedClient(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: emailId,
    format: 'full',
  });

  return _parseGmailMessage(res.data);
}

/**
 * Send an email via Gmail
 *
 * If accessToken is provided (prospecting sender accounts), uses those tokens directly
 * instead of loading from oauth_tokens — so the email goes out from the correct address.
 */
async function sendEmail(userId, { to, subject, body, isHtml = false, accessToken = null, refreshToken = null, senderEmail = null }) {
  let auth;

  if (accessToken) {
    // Use the prospecting sender account's own tokens.
    // Proactively refresh if the access token is expired or within 5 minutes of
    // expiry — mirrors getAuthenticatedClient(). This prevents the ghost-send
    // pattern where an expired token causes a silent failure after DB writes.
    const oauth2Client = getOAuth2Client();

    let resolvedAccessToken  = accessToken;
    let resolvedRefreshToken = refreshToken || undefined;

    if (senderEmail && refreshToken) {
      // Proactively refresh only when we KNOW the token is expired.
      // If expires_at is NULL (older accounts or first connect before expiry tracking),
      // treat it as still valid — the Gmail SDK will handle mid-call refresh automatically.
      // This avoids false-positive "needs to be reconnected" errors on healthy accounts.
      try {
        const { pool } = require('../config/database');
        const expiryRes = await pool.query(
          `SELECT expires_at FROM prospecting_sender_accounts WHERE email = $1 LIMIT 1`,
          [senderEmail]
        );
        const rawExpiry = expiryRes.rows[0]?.expires_at;

        // Only attempt proactive refresh when expires_at is known AND expired
        if (rawExpiry) {
          const expiresAt = new Date(rawExpiry).getTime();
          const isExpired = expiresAt < Date.now() + 5 * 60 * 1000; // 5-min buffer

          if (isExpired) {
            console.log(`🔄 Sender account ${senderEmail} token expires at ${rawExpiry} — refreshing proactively`);
            const params = new URLSearchParams({
              client_id:     process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type:    'refresh_token',
            });
            const response = await require('axios').post(
              'https://oauth2.googleapis.com/token',
              params.toString(),
              { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );
            resolvedAccessToken = response.data.access_token;
            const newExpiry = new Date(Date.now() + response.data.expires_in * 1000);
            await pool.query(
              `UPDATE prospecting_sender_accounts
                  SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
                WHERE email = $3`,
              [resolvedAccessToken, newExpiry, senderEmail]
            );
            console.log(`✅ Sender account ${senderEmail} token refreshed, new expiry: ${newExpiry}`);
          }
        } else {
          console.log(`ℹ️  Sender account ${senderEmail} has no expires_at — skipping proactive refresh, SDK will handle it`);
        }
      } catch (refreshErr) {
        // Only block the send on confirmed revocation (invalid_grant).
        // Network blips, DB errors, etc. fall through — let the SDK attempt with current token.
        const isRevoked = /invalid_grant|Token has been expired or revoked/i.test(
          refreshErr.response?.data?.error || refreshErr.message
        );
        if (isRevoked) {
          throw new Error(`invalid_grant: sender account ${senderEmail} needs to be reconnected in Settings → Outreach.`);
        }
        console.warn(`⚠️  Proactive refresh failed for ${senderEmail} (non-fatal, attempting send anyway):`, refreshErr.message);
      }
    }

    oauth2Client.setCredentials({
      access_token:  resolvedAccessToken,
      refresh_token: resolvedRefreshToken,
    });
    // Save refreshed tokens back if Google auto-refreshes mid-call
    oauth2Client.on('tokens', async (tokens) => {
      if (senderEmail && tokens.access_token) {
        const { pool } = require('../config/database');
        await pool.query(
          `UPDATE prospecting_sender_accounts
           SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
           WHERE email = $3`,
          [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, senderEmail]
        ).catch(err => console.warn('Failed to save refreshed sender token:', err.message));
      }
    });
    auth = oauth2Client;
  } else {
    // Fall back to user's standard oauth_tokens
    auth = await getAuthenticatedClient(userId);
  }

  const gmail = google.gmail({ version: 'v1', auth });

  const contentType = isHtml ? 'text/html' : 'text/plain';
  const raw = _encodeEmail(to, subject, body, contentType);

  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  const messageId = sendRes.data.id || null;
  const threadId  = sendRes.data.threadId || null;
  console.log(`📤 Sent email via Gmail (${senderEmail || 'default'}) to ${to} — messageId: ${messageId}`);

  return { messageId, threadId };
}

// ── Calendar ──────────────────────────────────────────────────────────────────

/**
 * Fetch upcoming calendar events
 */
async function fetchCalendarEvents(userId, options = {}) {
  const auth = await getAuthenticatedClient(userId);
  const calendar = google.calendar({ version: 'v3', auth });

  const {
    maxResults = 50,
    timeMin = new Date().toISOString(),
    timeMax = null,
  } = options;

  const params = {
    calendarId: 'primary',
    maxResults,
    timeMin,
    singleEvents: true,
    orderBy: 'startTime',
  };
  if (timeMax) params.timeMax = timeMax;

  const res = await calendar.events.list(params);
  return (res.data.items || []).map(e => ({
    id:          e.id,
    title:       e.summary || '(No title)',
    description: e.description || '',
    start:       e.start?.dateTime || e.start?.date,
    end:         e.end?.dateTime || e.end?.date,
    location:    e.location || '',
    attendees:   (e.attendees || []).map(a => ({ email: a.email, name: a.displayName, status: a.responseStatus })),
    htmlLink:    e.htmlLink,
    status:      e.status,
  }));
}

// ── Drive ─────────────────────────────────────────────────────────────────────

/**
 * List files from Google Drive
 */
async function listDriveFiles(userId, options = {}) {
  const auth = await getAuthenticatedClient(userId);
  const drive = google.drive({ version: 'v3', auth });

  const { pageSize = 25, query = '', pageToken = null, folderId = null } = options;

  let q = "trashed = false";
  if (folderId)  q += ` and '${folderId}' in parents`;
  if (query)     q += ` and name contains '${query}'`;

  const params = {
    pageSize,
    q,
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink, thumbnailLink, parents)',
    orderBy: 'modifiedTime desc',
  };
  if (pageToken) params.pageToken = pageToken;

  const res = await drive.files.list(params);
  return {
    files:         res.data.files || [],
    nextPageToken: res.data.nextPageToken || null,
  };
}

// ── User Profile ──────────────────────────────────────────────────────────────

/**
 * Get user profile (email, name)
 */
async function getUserProfile(userId) {
  const auth = await getAuthenticatedClient(userId);
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const res = await oauth2.userinfo.get();
  return {
    email: res.data.email,
    name:  res.data.name,
    picture: res.data.picture,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _parseGmailMessage(msg) {
  const headers = {};
  (msg.payload?.headers || []).forEach(h => {
    headers[h.name.toLowerCase()] = h.value;
  });

  return {
    id:            msg.id,
    threadId:      msg.threadId,
    subject:       headers['subject'] || '(No subject)',
    from:          headers['from'] || '',
    to:            headers['to'] || '',
    cc:            headers['cc'] || '',
    date:          headers['date'] || '',
    snippet:       msg.snippet || '',
    labelIds:      msg.labelIds || [],
    isRead:        !(msg.labelIds || []).includes('UNREAD'),
    hasAttachments: (msg.payload?.parts || []).some(p => p.filename),
  };
}

function _encodeEmail(to, subject, body, contentType) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: ${contentType}; charset=utf-8`,
    '',
    body,
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

module.exports = {
  getAuthUrl,
  getTokenFromCode,
  getAuthenticatedClient,
  fetchEmails,
  fetchEmailById,
  sendEmail,
  fetchCalendarEvents,
  listDriveFiles,
  getUserProfile,
  SCOPES,
};
