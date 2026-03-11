const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken        = require('../middleware/auth.middleware');
const { orgContext }           = require('../middleware/orgContext.middleware');
const ActionsGenerator         = require('../services/actionsGenerator');
const ActionCompletionDetector = require('../services/actionCompletionDetector.service');

const { fetchEmails, fetchEmailById, sendEmail } = require('../services/outlookService');
const AIProcessor  = require('../services/aiProcessor');
const { emailQueue } = require('../jobs/emailProcessor');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { dealId, contactId } = req.query;
    let query    = 'SELECT * FROM emails WHERE org_id = $1 AND user_id = $2';
    const params = [req.orgId, req.user.userId];

    if (dealId) {
      query += ` AND deal_id = $${params.length + 1}`;
      params.push(dealId);
    } else if (contactId) {
      query += ` AND contact_id = $${params.length + 1}`;
      params.push(contactId);
    }

    query += ' ORDER BY sent_at DESC LIMIT 50';
    const result = await db.query(query, params);
    res.json({ emails: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch emails' } });
  }
});

// ── POST / — compose and send email ──────────────────────────
router.post('/', async (req, res) => {
  try {
    const { dealId, contactId, subject, body, toAddress, actionId, replyToId } = req.body;
    const userId = req.user.userId;
    const orgId  = req.orgId;

    // ── 1. Send via Outlook if connected ─────────────────────
    let outlookSent  = false;
    let outlookError = null;

    try {
      await sendEmail(userId, {
        to:        toAddress,
        subject,
        body,
        isHtml:    false,
        replyToId: replyToId || null,
      });
      outlookSent = true;
    } catch (err) {
      outlookError = err.message;
      console.warn('⚠️  Outlook send failed, saving to DB only:', err.message);
    }

    // ── 2. Save to DB with org_id ─────────────────────────────
    const result = await db.query(
      `INSERT INTO emails
         (org_id, user_id, deal_id, contact_id, direction, subject, body,
          to_address, from_address, sent_at)
       VALUES ($1, $2, $3, $4, 'sent', $5, $6, $7, $8, CURRENT_TIMESTAMP)
       RETURNING *`,
      [orgId, userId, dealId || null, contactId || null,
       subject, body, toAddress, req.user.email]
    );

    const newEmail = result.rows[0];

    // ── 3. Contact activity log ───────────────────────────────
    if (contactId) {
      db.query(
        `INSERT INTO contact_activities (contact_id, user_id, activity_type, description)
         VALUES ($1, $2, 'email_sent', $3)`,
        [contactId, userId, subject]
      ).catch(err => console.error('Contact activity log error:', err));
    }

    // ── 4. Advance action to in_progress ─────────────────────
    if (actionId) {
      db.query(
        `UPDATE actions
         SET status = CASE WHEN status = 'yet_to_start' THEN 'in_progress' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND org_id = $2 AND user_id = $3`,
        [actionId, orgId, userId]
      ).catch(err => console.error('Action status update error:', err));
    }

    // ── 5. Completion detection (non-blocking) ────────────────
    if (actionId) {
      ActionCompletionDetector
        .detectFromEmailForAction(newEmail.id, userId, parseInt(actionId), orgId)
        .catch(err => console.error('Targeted completion detection error:', err));
    } else {
      ActionCompletionDetector
        .detectFromEmail(newEmail.id, userId, orgId)
        .catch(err => console.error('Broad completion detection error:', err));
    }

    // ── 6. Regenerate actions (non-blocking) ──────────────────
    ActionsGenerator
      .generateForEmail(newEmail.id)
      .catch(err => console.error('Action generation error:', err));

    res.status(201).json({ email: newEmail, outlookSent, outlookError });

  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: { message: 'Failed to send email' } });
  }
});

// ── GET /outlook — fetch from Outlook inbox ───────────────────
router.get('/outlook', async (req, res) => {
  try {
    const { top = 50, skip = 0, since } = req.query;
    const result = await fetchEmails(req.user.userId, {
      top:  parseInt(top),
      skip: parseInt(skip),
      since
    });
    res.json({ success: true, data: result.emails, hasMore: result.hasMore, count: result.emails.length });
  } catch (error) {
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ success: false, error: 'Outlook not connected', code: 'NOT_CONNECTED' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /analyze ─────────────────────────────────────────────
router.post('/analyze', async (req, res) => {
  try {
    const { emailId } = req.body;
    if (!emailId) return res.status(400).json({ success: false, error: 'emailId is required' });

    const email    = await fetchEmailById(req.user.userId, emailId);
    const analysis = await AIProcessor.analyzeEmailSimple(email);
    res.json({ success: true, data: { email, analysis } });
  } catch (error) {
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ success: false, error: 'Outlook not connected', code: 'NOT_CONNECTED' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /process ─────────────────────────────────────────────
router.post('/process', async (req, res) => {
  try {
    const { emailId } = req.body;
    if (!emailId) return res.status(400).json({ success: false, error: 'emailId is required' });

    const job = await emailQueue.add({ userId: req.user.userId, emailId });
    res.json({ success: true, message: 'Email queued for processing', jobId: job.id });
  } catch (error) {
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ success: false, error: 'Outlook not connected', code: 'NOT_CONNECTED' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});


// ── GET /gmail — fetch from Gmail inbox ─────────────────────
router.get('/gmail', async (req, res) => {
  try {
    const { top = 50, skip = 0, dealId } = req.query;
    const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');

    const result = await UnifiedEmailProvider.fetchEmails(
      req.user.userId, 'gmail', { top: parseInt(top), skip: parseInt(skip) }
    );

    let emails = result.emails;

    if (dealId) {
      const dbResult = await db.query(
        "SELECT external_id FROM emails WHERE deal_id = $1 AND user_id = $2 AND org_id = $3 AND provider = 'gmail'",
        [dealId, req.user.userId, req.orgId]
      );
      const dealEmailIds = new Set(dbResult.rows.map(r => r.external_id));
      emails = emails.filter(e => dealEmailIds.has(e.id));
    }

    res.json({ success: true, data: emails });
  } catch (error) {
    console.error('Error fetching Gmail emails:', error);
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ success: false, error: 'Gmail not connected' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /unified — fetch from ALL connected providers ────────
router.get('/unified', async (req, res) => {
  try {
    const { top = 50, dealId } = req.query;
    const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');
    const providers = await UnifiedEmailProvider.getConnectedProviders(req.user.userId);

    const allEmails = [];

    const providerErrors = [];
    for (const provider of providers) {
      try {
        const result = await UnifiedEmailProvider.fetchEmails(
          req.user.userId, provider, { top: parseInt(top) }
        );
        allEmails.push(...result.emails);
      } catch (err) {
        console.warn('Failed to fetch ' + provider + ' emails:', err.message);
        providerErrors.push({ provider, error: err.message });
      }
    }

    // Sort by date descending
    allEmails.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));

    // Optionally filter by deal
    let filtered = allEmails;
    if (dealId) {
      const dbResult = await db.query(
        'SELECT external_id, provider FROM emails WHERE deal_id = $1 AND user_id = $2 AND org_id = $3',
        [dealId, req.user.userId, req.orgId]
      );
      const dealEmailIds = new Set(dbResult.rows.map(r => r.external_id));
      filtered = allEmails.filter(e => dealEmailIds.has(e.id));
    }

    res.json({
      success:        true,
      data:           filtered.slice(0, parseInt(top)),
      providers:      providers,
      providerErrors: providerErrors.length ? providerErrors : undefined,
    });
  } catch (error) {
    console.error('Error fetching unified emails:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /deal/:dealId — emails for a deal including team members' emails ────────
// Fetches from DB only (not Outlook). Includes emails from all deal team members.
// Returns threads grouped by conversation_id, ordered newest first.
router.get('/deal/:dealId', async (req, res) => {
  try {
    const { dealId } = req.params;

    // Verify deal belongs to this org
    const dealCheck = await db.query(
      `SELECT id FROM deals WHERE id = $1 AND org_id = $2`,
      [dealId, req.orgId]
    );
    if (dealCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    // Fetch emails for this deal — includes the deal owner's AND all team members' emails
    const result = await db.query(
      `SELECT
         e.id,
         e.direction,
         e.subject,
         e.body,
         e.from_address,
         e.to_address,
         e.cc_addresses,
         e.sent_at,
         e.conversation_id,
         e.tagged_by,
         e.tag_source,
         e.contact_id,
         e.user_id,
         c.first_name  AS contact_first,
         c.last_name   AS contact_last,
         c.email       AS contact_email,
         u.first_name  AS sender_first,
         u.last_name   AS sender_last
       FROM emails e
       LEFT JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN users    u ON u.id = e.user_id
       WHERE e.deal_id = $1
         AND e.org_id  = $2
         AND (
           -- Deal owner's emails
           e.user_id = $3
           OR
           -- Any deal team member's emails
           e.user_id IN (
             SELECT user_id FROM deal_team_members
             WHERE deal_id = $1 AND org_id = $2
           )
         )
       ORDER BY e.sent_at DESC
       LIMIT 100`,
      [dealId, req.orgId, req.user.userId]
    );

    // Collect all CC addresses across emails, resolve to org users in one query
    const allCcEmails = new Set();
    result.rows.forEach(e => {
      if (e.cc_addresses) {
        e.cc_addresses.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
          .forEach(addr => allCcEmails.add(addr));
      }
    });

    const ccUserMap = new Map(); // lowercase email → { userId, name, email }
    if (allCcEmails.size > 0) {
      const ccUsersResult = await db.query(
        `SELECT id, first_name, last_name, email FROM users
         WHERE org_id = $1 AND LOWER(email) = ANY($2::text[])`,
        [req.orgId, [...allCcEmails]]
      );
      ccUsersResult.rows.forEach(u => {
        ccUserMap.set(u.email.toLowerCase(), {
          userId: u.id,
          name:   `${u.first_name} ${u.last_name}`.trim(),
          email:  u.email,
        });
      });
    }

    const emails = result.rows.map(e => {
      const ccAddresses = (e.cc_addresses || '').split(',').map(s => s.trim()).filter(Boolean);
      const ccUsers = ccAddresses
        .map(addr => ccUserMap.get(addr.toLowerCase()))
        .filter(Boolean);

      return {
        id:             e.id,
        direction:      e.direction,
        subject:        e.subject,
        bodyPreview:    (e.body || '').replace(/<[^>]+>/g, '').slice(0, 200),
        body:           e.body,
        fromAddress:    e.from_address,
        toAddress:      e.to_address,
        ccAddresses,
        sentAt:         e.sent_at,
        conversationId: e.conversation_id,
        tagSource:      e.tag_source,
        contact: e.contact_id ? {
          id:        e.contact_id,
          name:      `${e.contact_first || ''} ${e.contact_last || ''}`.trim(),
          email:     e.contact_email,
        } : null,
        sender: {
          name: `${e.sender_first || ''} ${e.sender_last || ''}`.trim() || e.from_address,
        },
        senderId:   e.user_id,
        senderName: `${e.sender_first || ''} ${e.sender_last || ''}`.trim(),
        ccUsers,   // org users found in CC — used by DealTeamPanel for suggestions
      };
    });

    res.json({ emails });
  } catch (err) {
    console.error('Get deal emails error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch deal emails' } });
  }
});

// ── GET /untagged — emails with a contact but no deal, not from snoozed contacts
// Used to power the "Tag to deal" flow in the deal panel.
// Optional ?accountId=X to scope to contacts from a specific account.
router.get('/untagged', async (req, res) => {
  try {
    const { accountId } = req.query;

    let query = `
      SELECT
        e.id,
        e.direction,
        e.subject,
        e.body,
        e.from_address,
        e.to_address,
        e.sent_at,
        e.conversation_id,
        c.id          AS contact_id,
        c.first_name  AS contact_first,
        c.last_name   AS contact_last,
        c.email       AS contact_email,
        c.account_id,
        acc.name      AS account_name
      FROM emails e
      JOIN contacts c   ON c.id  = e.contact_id AND c.org_id = e.org_id
      LEFT JOIN accounts acc ON acc.id = c.account_id
      WHERE e.org_id     = $1
        AND e.user_id    = $2
        AND e.deal_id    IS NULL
        AND e.contact_id IS NOT NULL
        AND (c.email_snoozed IS NULL OR c.email_snoozed = false)
    `;

    const params = [req.orgId, req.user.userId];

    if (accountId) {
      query += ` AND c.account_id = $${params.length + 1}`;
      params.push(accountId);
    }

    query += ` ORDER BY e.sent_at DESC LIMIT 50`;

    const result = await db.query(query, params);

    res.json({
      emails: result.rows.map(e => ({
        id:          e.id,
        direction:   e.direction,
        subject:     e.subject,
        bodyPreview: (e.body || '').replace(/<[^>]+>/g, '').slice(0, 150),
        fromAddress: e.from_address,
        sentAt:      e.sent_at,
        contact: {
          id:          e.contact_id,
          name:        `${e.contact_first || ''} ${e.contact_last || ''}`.trim(),
          email:       e.contact_email,
          accountId:   e.account_id,
          accountName: e.account_name,
        },
      }))
    });
  } catch (err) {
    console.error('Get untagged emails error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch untagged emails' } });
  }
});

// ── PATCH /:id/tag — manually tag an email to a deal ─────────────────────────
router.patch('/:id/tag', async (req, res) => {
  try {
    const { dealId } = req.body;
    if (!dealId) {
      return res.status(400).json({ error: { message: 'dealId is required' } });
    }

    // Verify deal belongs to this org and caller has access (owner or team member)
    const dealCheck = await db.query(
      `SELECT d.id FROM deals d
       WHERE d.id = $1 AND d.org_id = $2
         AND (
           d.user_id = $3
           OR EXISTS (
             SELECT 1 FROM deal_team_members dtm
             WHERE dtm.deal_id = d.id AND dtm.user_id = $3 AND dtm.org_id = $2
           )
         )`,
      [dealId, req.orgId, req.user.userId]
    );
    if (dealCheck.rows.length === 0) {
      return res.status(403).json({ error: { message: 'Deal not found or access denied' } });
    }

    // Verify email belongs to this org and this user (or a team member)
    const emailCheck = await db.query(
      `SELECT id FROM emails WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (emailCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Email not found' } });
    }

    const result = await db.query(
      `UPDATE emails
       SET deal_id    = $1,
           tagged_by  = $2,
           tagged_at  = CURRENT_TIMESTAMP,
           tag_source = 'manual'
       WHERE id = $3 AND org_id = $4
       RETURNING id, deal_id, tag_source, tagged_at`,
      [dealId, req.user.userId, req.params.id, req.orgId]
    );

    res.json({ email: result.rows[0] });
  } catch (err) {
    console.error('Tag email error:', err);
    res.status(500).json({ error: { message: 'Failed to tag email' } });
  }
});

// ── GET /deal/:dealId/snoozed-contacts — contacts snoozed on this deal ────────
// Shows which contacts' emails are being suppressed from tagging prompts,
// scoped to contacts whose account matches this deal's account.
router.get('/deal/:dealId/snoozed-contacts', async (req, res) => {
  try {
    const dealCheck = await db.query(
      `SELECT d.id, d.account_id FROM deals d WHERE d.id = $1 AND d.org_id = $2`,
      [req.params.dealId, req.orgId]
    );
    if (dealCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }
    const { account_id } = dealCheck.rows[0];

    const result = await db.query(
      `SELECT
         c.id,
         c.first_name,
         c.last_name,
         c.email,
         c.email_snooze_reason,
         c.email_snoozed_at,
         u.first_name AS snoozed_by_first,
         u.last_name  AS snoozed_by_last
       FROM contacts c
       LEFT JOIN users u ON u.id = c.email_snoozed_by
       WHERE c.account_id = $1
         AND c.org_id     = $2
         AND c.email_snoozed = true`,
      [account_id, req.orgId]
    );

    res.json({
      contacts: result.rows.map(c => ({
        id:           c.id,
        name:         `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        email:        c.email,
        snoozeReason: c.email_snooze_reason,
        snoozedAt:    c.email_snoozed_at,
        snoozedBy:    c.snoozed_by_first
                        ? `${c.snoozed_by_first} ${c.snoozed_by_last}`.trim()
                        : null,
      }))
    });
  } catch (err) {
    console.error('Get snoozed contacts error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch snoozed contacts' } });
  }
});

module.exports = router;
