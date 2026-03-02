/**
 * UnifiedEmailProvider.js
 *
 * Abstraction layer that normalizes Outlook and Gmail emails into a
 * common format. Every function returns emails in the same shape
 * regardless of source provider.
 *
 * DROP-IN LOCATION: backend/services/UnifiedEmailProvider.js
 */

const outlookService = require('./outlookService');
const googleService  = require('./googleService');

// -- Normalizers --

function normalizeOutlookEmail(email) {
  return {
    id:               email.id,
    provider:         'outlook',
    subject:          email.subject || '(No Subject)',
    from: {
      name:    email.from?.emailAddress?.name    || '',
      address: email.from?.emailAddress?.address || '',
    },
    toRecipients: (email.toRecipients || []).map(r => ({
      name:    r.emailAddress?.name    || '',
      address: r.emailAddress?.address || '',
    })),
    ccRecipients: (email.ccRecipients || []).map(r => ({
      name:    r.emailAddress?.name    || '',
      address: r.emailAddress?.address || '',
    })),
    body: {
      content:     email.body?.content     || email.bodyPreview || '',
      contentType: email.body?.contentType  || 'Text',
    },
    bodyPreview:      email.bodyPreview || '',
    receivedDateTime: email.receivedDateTime,
    importance:       email.importance  || 'normal',
    hasAttachments:   email.hasAttachments || false,
    conversationId:   email.conversationId || null,
    isRead:           email.isRead !== false,
    categories:       email.categories || [],
  };
}

function normalizeGmailEmail(email) {
  const parseAddress = (raw) => {
    if (!raw) return { name: '', address: '' };
    const match = raw.match(/^(.+?)\s*<(.+?)>$/);
    if (match) return { name: match[1].trim(), address: match[2].trim() };
    return { name: '', address: raw.trim() };
  };

  const parseAddressList = (raw) => {
    if (!raw) return [];
    return raw.split(',').map(addr => parseAddress(addr.trim())).filter(a => a.address);
  };

  const from = parseAddress(email.from);

  return {
    id:               email.id,
    provider:         'gmail',
    subject:          email.subject || '(No Subject)',
    from,
    toRecipients:     parseAddressList(email.to),
    ccRecipients:     parseAddressList(email.cc),
    body: {
      content:     email.snippet || '',
      contentType: 'Text',
    },
    bodyPreview:      email.snippet || '',
    receivedDateTime: email.date ? new Date(email.date).toISOString() : new Date().toISOString(),
    importance:       'normal',
    hasAttachments:   email.hasAttachments || false,
    conversationId:   email.threadId || null,
    isRead:           email.isRead !== false,
    categories:       [],
  };
}

// -- Provider Methods --

async function fetchEmails(userId, provider, options = {}) {
  if (provider === 'gmail') {
    const gmailOptions = {
      maxResults: options.top || 50,
      query:      '',
      pageToken:  options.pageToken || null,
    };
    if (options.since) {
      const sinceDate = new Date(options.since);
      const formatted = sinceDate.getFullYear() + '/' +
        String(sinceDate.getMonth() + 1).padStart(2, '0') + '/' +
        String(sinceDate.getDate()).padStart(2, '0');
      gmailOptions.query = 'after:' + formatted;
    }
    const result = await googleService.fetchEmails(userId, gmailOptions);
    return { emails: result.emails.map(normalizeGmailEmail), hasMore: result.hasMore };
  }

  const result = await outlookService.fetchEmails(userId, options);
  return { emails: result.emails.map(normalizeOutlookEmail), hasMore: result.hasMore };
}

async function fetchEmailById(userId, provider, emailId) {
  if (provider === 'gmail') {
    const email = await googleService.fetchEmailById(userId, emailId);
    return normalizeGmailEmail(email);
  }
  const email = await outlookService.fetchEmailById(userId, emailId);
  return normalizeOutlookEmail(email);
}

async function sendEmail(userId, provider, { to, subject, body, isHtml = false }) {
  if (provider === 'gmail') {
    return await googleService.sendEmail(userId, { to, subject, body, isHtml });
  }
  return await outlookService.sendEmail(userId, { to, subject, body, isHtml });
}

async function getConnectedProviders(userId) {
  const { pool } = require('../config/database');
  const result = await pool.query(
    "SELECT provider FROM oauth_tokens WHERE user_id = $1 AND provider IN ('outlook', 'google')",
    [userId]
  );
  return result.rows.map(r => r.provider === 'google' ? 'gmail' : r.provider);
}

async function getUserEmail(userId, provider) {
  const { pool } = require('../config/database');
  if (provider === 'gmail') {
    const result = await pool.query('SELECT gmail_email FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.gmail_email || null;
  }
  const result = await pool.query('SELECT outlook_email FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.outlook_email || null;
}

/** Convert normalized email back to AIProcessor shape */
function toAIProcessorShape(normalizedEmail) {
  return {
    id:      normalizedEmail.id,
    subject: normalizedEmail.subject,
    body: {
      content:     normalizedEmail.body?.content || '',
      contentType: normalizedEmail.body?.contentType || 'Text',
    },
    from: {
      emailAddress: {
        address: normalizedEmail.from?.address,
        name:    normalizedEmail.from?.name,
      },
    },
    toRecipients: normalizedEmail.toRecipients.map(r => ({
      emailAddress: { address: r.address, name: r.name },
    })),
    ccRecipients: normalizedEmail.ccRecipients.map(r => ({
      emailAddress: { address: r.address, name: r.name },
    })),
    receivedDateTime: normalizedEmail.receivedDateTime,
    importance:       normalizedEmail.importance,
    hasAttachments:   normalizedEmail.hasAttachments,
    conversationId:   normalizedEmail.conversationId,
    isRead:           normalizedEmail.isRead,
  };
}

module.exports = {
  fetchEmails,
  fetchEmailById,
  sendEmail,
  getConnectedProviders,
  getUserEmail,
  normalizeOutlookEmail,
  normalizeGmailEmail,
  toAIProcessorShape,
};
