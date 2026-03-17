/**
 * emails.routes.js
 *
 * DROP-IN LOCATION: backend/routes/emails.routes.js
 *
 * Mount in server.js:
 *   const emailsRoutes = require('./routes/emails.routes');
 *   app.use('/api/emails', emailsRoutes);
 *
 * Endpoints:
 *   GET  /gmail                          — fetch Gmail emails for display
 *   GET  /unified                        — fetch from all connected providers
 *   GET  /deal/:dealId                   — email history for a deal (DealEmailHistory)
 *   GET  /untagged                       — emails with no deal_id for the manual tagging modal
 *   PATCH /:id/tag                       — manually tag an email to a deal
 *   GET  /deal/:dealId/snoozed-contacts  — contacts snoozed from email suggestions on this deal
 *
 * NOTE: /gmail and /unified must be defined BEFORE /:id routes to prevent
 * Express matching 'gmail' or 'unified' as an id parameter.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: verify deal exists in this org ────────────────────────────────────
async function resolveDeal(req, res, dealId) {
  const result = await db.query(
    `SELECT d.id, d.owner_id, d.org_id, d.account_id
     FROM deals d
     WHERE d.id = $1 AND d.org_id = $2`,
    [dealId, req.orgId]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: { message: 'Deal not found' } });
    return null;
  }

  return result.rows[0];
}

// ── GET /gmail ────────────────────────────────────────────────────────────────
// Fetch Gmail emails for the calling user via UnifiedEmailProvider.
// Must be defined BEFORE /:id to avoid Express matching 'gmail' as an id.
//
// Query params:
//   top    (default 50)  — max emails to return
//   skip   (default 0)   — pagination offset
//   dealId (optional)    — filter to emails tagged to this deal
router.get('/gmail', async (req, res) => {
  try {
    const { top = 50, skip = 0, dealId } = req.query;
    const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');

    const result = await UnifiedEmailProvider.fetchEmails(
      req.user.userId, 'gmail', { top: parseInt(top), skip: parseInt(skip) }
    );

    let emails = result.emails || [];

    if (dealId) {
      const dealIdInt = parseInt(dealId, 10);
      if (isNaN(dealIdInt)) return res.status(400).json({ success: false, error: 'Invalid dealId' });
      const dbResult = await db.query(
        `SELECT external_id FROM emails
         WHERE deal_id = $1 AND user_id = $2 AND org_id = $3 AND provider = 'gmail'`,
        [dealIdInt, req.user.userId, req.orgId]
      );
      const dealEmailIds = new Set(dbResult.rows.map(r => r.external_id));
      emails = emails.filter(e => dealEmailIds.has(e.id));
    }

    res.json({ success: true, data: emails });
  } catch (error) {
    console.error('Error fetching Gmail emails:', error);
    if (error.message?.includes('No tokens found') || error.message?.includes('not connected')) {
      return res.status(403).json({ success: false, error: 'Gmail not connected' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /unified ──────────────────────────────────────────────────────────────
// Fetch emails from ALL providers the user has connected (Gmail + Outlook).
// Must be defined BEFORE /:id to avoid Express matching 'unified' as an id.
//
// Query params:
//   top    (default 50)  — max emails to return (applied after merge + sort)
//   dealId (optional)    — filter to emails tagged to this deal
router.get('/unified', async (req, res) => {
  try {
    const { top = 50, dealId } = req.query;
    const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');

    // Get all providers this user has connected
    const providers = await UnifiedEmailProvider.getConnectedProviders(req.user.userId);

    // If no providers connected, return empty list rather than erroring
    if (!providers || providers.length === 0) {
      return res.json({ success: true, data: [], providers: [] });
    }

    const allEmails = [];

    for (const provider of providers) {
      try {
        const result = await UnifiedEmailProvider.fetchEmails(
          req.user.userId, provider, { top: parseInt(top) }
        );
        allEmails.push(...(result.emails || []));
      } catch (err) {
        // Non-blocking — one provider failing should not prevent others from loading
        console.warn(`[emails/unified] Failed to fetch ${provider} emails:`, err.message);
      }
    }

    // Sort by date descending across all providers
    allEmails.sort((a, b) => new Date(b.receivedDateTime || b.sentAt || 0) - new Date(a.receivedDateTime || a.sentAt || 0));

    // Optionally filter to emails tagged to a specific deal
    let filtered = allEmails;
    if (dealId) {
      const dealIdInt = parseInt(dealId, 10);
      if (isNaN(dealIdInt)) return res.status(400).json({ success: false, error: 'Invalid dealId' });
      const dbResult = await db.query(
        `SELECT external_id, provider FROM emails
         WHERE deal_id = $1 AND user_id = $2 AND org_id = $3`,
        [dealIdInt, req.user.userId, req.orgId]
      );
      const dealEmailIds = new Set(dbResult.rows.map(r => r.external_id));
      filtered = allEmails.filter(e => dealEmailIds.has(e.id));
    }

    const sliced = filtered.slice(0, parseInt(top));

    // Attach DB integer id (dbId) to each email so the frontend can call
    // /sync/emails/:id/analyze with a real integer, not a provider string id.
    if (sliced.length > 0) {
      const externalIds = sliced.map(e => e.id).filter(Boolean);
      const dbRows = await db.query(
        `SELECT id AS db_id, external_id, direction
         FROM emails
         WHERE external_id = ANY($1::text[])
           AND user_id = $2
           AND org_id  = $3`,
        [externalIds, req.user.userId, req.orgId]
      );
      const dbIdMap = {};
      for (const row of dbRows.rows) {
        dbIdMap[row.external_id] = { dbId: row.db_id, direction: row.direction };
      }
      for (const email of sliced) {
        const match = dbIdMap[email.id];
        email.dbId      = match?.dbId      || null;
        email.direction = match?.direction || null;
      }
    }

    res.json({
      success:   true,
      data:      sliced,
      providers,
    });
  } catch (error) {
    console.error('Error fetching unified emails:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /deal/:dealId ─────────────────────────────────────────────────────────
// Returns all emails tagged to this deal, enriched with contact and sender info.
// DealEmailHistory.js groups these into threads client-side via groupIntoThreads().
router.get('/deal/:dealId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res, req.params.dealId);
    if (!deal) return;

    const result = await db.query(
      `SELECT
         e.id,
         e.direction,
         e.subject,
         e.body,
         LEFT(regexp_replace(COALESCE(e.body, ''), '<[^>]+>', '', 'g'), 300) AS body_preview,
         e.from_address,
         e.to_address,
         e.cc_addresses,
         e.sent_at,
         e.conversation_id,
         e.tag_source,
         e.provider,
         c.id         AS contact_id,
         c.first_name AS contact_first_name,
         c.last_name  AS contact_last_name,
         acc.name     AS contact_account_name,
         u.first_name AS sender_first_name,
         u.last_name  AS sender_last_name
       FROM emails e
       LEFT JOIN contacts c   ON c.id   = e.contact_id
       LEFT JOIN accounts acc ON acc.id = c.account_id
       LEFT JOIN users u      ON u.id   = e.user_id
       WHERE e.deal_id    = $1
         AND e.org_id     = $2
         AND e.deleted_at IS NULL
       ORDER BY e.sent_at DESC`,
      [deal.id, req.orgId]
    );

    res.json({
      emails: result.rows.map(row => ({
        id:             row.id,
        direction:      row.direction,
        subject:        row.subject,
        body:           row.body,
        bodyPreview:    row.body_preview,
        fromAddress:    row.from_address,
        toAddress:      row.to_address,
        ccAddresses:    row.cc_addresses,
        sentAt:         row.sent_at,
        conversationId: row.conversation_id,
        tagSource:      row.tag_source,
        provider:       row.provider,
        contact: row.contact_id ? {
          id:          row.contact_id,
          name:        `${row.contact_first_name || ''} ${row.contact_last_name || ''}`.trim(),
          accountName: row.contact_account_name || null,
        } : null,
        sender: row.sender_first_name ? {
          name: `${row.sender_first_name} ${row.sender_last_name}`.trim(),
        } : null,
      })),
    });
  } catch (err) {
    console.error('Get deal emails error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch deal emails' } });
  }
});

// ── GET /untagged ─────────────────────────────────────────────────────────────
// Returns emails from the calling user's mailbox that have a contact_id but no
// deal_id — used by the "Tag Emails" modal in DealEmailHistory.
router.get('/untagged', async (req, res) => {
  try {
    const { accountId } = req.query;

    const params = [req.orgId, req.user.userId];
    let accountFilter = '';

    if (accountId) {
      params.push(parseInt(accountId));
      accountFilter = `AND c.account_id = $${params.length}`;
    }

    const result = await db.query(
      `SELECT
         e.id,
         e.direction,
         e.subject,
         LEFT(regexp_replace(COALESCE(e.body, ''), '<[^>]+>', '', 'g'), 300) AS body_preview,
         e.from_address,
         e.to_address,
         e.sent_at,
         e.conversation_id,
         e.provider,
         c.id         AS contact_id,
         c.first_name AS contact_first_name,
         c.last_name  AS contact_last_name,
         c.email      AS contact_email,
         acc.name     AS contact_account_name
       FROM emails e
       JOIN contacts c        ON c.id   = e.contact_id
       LEFT JOIN accounts acc ON acc.id = c.account_id
       WHERE e.org_id      = $1
         AND e.user_id     = $2
         AND e.deal_id     IS NULL
         AND e.prospect_id IS NULL
         AND e.deleted_at  IS NULL
         AND c.deleted_at  IS NULL
         AND c.email_snoozed = false
         ${accountFilter}
       ORDER BY e.sent_at DESC
       LIMIT 100`,
      params
    );

    res.json({
      emails: result.rows.map(row => ({
        id:             row.id,
        direction:      row.direction,
        subject:        row.subject,
        bodyPreview:    row.body_preview,
        fromAddress:    row.from_address,
        toAddress:      row.to_address,
        sentAt:         row.sent_at,
        conversationId: row.conversation_id,
        provider:       row.provider,
        contact: {
          id:          row.contact_id,
          name:        `${row.contact_first_name || ''} ${row.contact_last_name || ''}`.trim(),
          email:       row.contact_email,
          accountName: row.contact_account_name || null,
        },
      })),
    });
  } catch (err) {
    console.error('Get untagged emails error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch untagged emails' } });
  }
});

// ── PATCH /:id/tag ────────────────────────────────────────────────────────────
// Manually tag an email to a deal.
// Body: { dealId: number }
router.patch('/:id/tag', async (req, res) => {
  try {
    const { dealId } = req.body;
    if (!dealId) {
      return res.status(400).json({ error: { message: 'dealId is required' } });
    }

    const emailCheck = await db.query(
      `SELECT id FROM emails
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [req.params.id, req.orgId, req.user.userId]
    );
    if (emailCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Email not found' } });
    }

    const deal = await resolveDeal(req, res, dealId);
    if (!deal) return;

    await db.query(
      `UPDATE emails
       SET deal_id    = $1,
           tag_source = 'manual',
           tagged_by  = $2,
           tagged_at  = NOW()
       WHERE id = $3 AND org_id = $4`,
      [dealId, req.user.userId, req.params.id, req.orgId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Tag email error:', err);
    res.status(500).json({ error: { message: 'Failed to tag email' } });
  }
});

// ── GET /deal/:dealId/snoozed-contacts ────────────────────────────────────────
// Returns contacts snoozed from email suggestions on this deal's account.
router.get('/deal/:dealId/snoozed-contacts', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res, req.params.dealId);
    if (!deal) return;

    const result = await db.query(
      `SELECT
         c.id,
         c.first_name,
         c.last_name,
         c.email,
         c.email_snooze_reason AS snooze_reason
       FROM contacts c
       WHERE c.org_id        = $1
         AND c.account_id    = $2
         AND c.email_snoozed = true
         AND c.deleted_at    IS NULL
       ORDER BY c.first_name, c.last_name`,
      [req.orgId, deal.account_id]
    );

    res.json({
      contacts: result.rows.map(c => ({
        id:           c.id,
        name:         `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email:        c.email,
        snoozeReason: c.snooze_reason || null,
      })),
    });
  } catch (err) {
    console.error('Get snoozed contacts error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch snoozed contacts' } });
  }
});

module.exports = router;
