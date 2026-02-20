const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken       = require('../middleware/auth.middleware');
const ActionsGenerator        = require('../services/actionsGenerator');
const ActionCompletionDetector = require('../services/actionCompletionDetector.service');

const { fetchEmails, fetchEmailById, sendEmail } = require('../services/outlookService');
const AIProcessor  = require('../services/aiProcessor');
const { emailQueue } = require('../jobs/emailProcessor');

router.use(authenticateToken);

// ── GET / — list emails ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { dealId, contactId } = req.query;
    let query  = 'SELECT * FROM emails WHERE user_id = $1';
    const params = [req.user.userId];

    if (dealId) {
      query += ' AND deal_id = $2';
      params.push(dealId);
    } else if (contactId) {
      query += ' AND contact_id = $2';
      params.push(contactId);
    }

    query += ' ORDER BY sent_at DESC LIMIT 50';
    const result = await db.query(query, params);
    res.json({ emails: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch emails' } });
  }
});

// ── POST / — compose and send email ──────────────────────────────────────────
//
// Body:
//   dealId      {number}   — deal to link this email to
//   contactId   {number}   — contact (recipient)
//   subject     {string}
//   body        {string}   — plain text
//   toAddress   {string}   — recipient email address
//   actionId    {number?}  — action that triggered this email (optional)
//   replyToId   {string?}  — Outlook message ID to reply to (optional)
//
// Flow:
//   1. Attempt to send via Outlook (Graph API)
//   2. Save to local DB regardless of provider result
//   3. If actionId supplied → run targeted completion check
//      Otherwise → run broad completion scan for the deal
//
router.post('/', async (req, res) => {
  try {
    const { dealId, contactId, subject, body, toAddress, actionId, replyToId } = req.body;
    const userId = req.user.userId;

    // ── 1. Send via Outlook if connected ─────────────────────────────────────
    let outlookSent = false;
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
      // Outlook send failed (not connected, token expired, etc.)
      // We still save to DB so the action flow works — but surface the error to the client
      outlookError = err.message;
      console.warn('⚠️  Outlook send failed, saving to DB only:', err.message);
    }

    // ── 2. Save to DB ─────────────────────────────────────────────────────────
    const result = await db.query(
      `INSERT INTO emails
         (user_id, deal_id, contact_id, direction, subject, body,
          to_address, from_address, sent_at)
       VALUES ($1, $2, $3, 'sent', $4, $5, $6, $7, CURRENT_TIMESTAMP)
       RETURNING *`,
      [userId, dealId || null, contactId || null, subject, body, toAddress, req.user.email]
    );

    const newEmail = result.rows[0];

    // ── 3. Contact activity log ───────────────────────────────────────────────
    if (contactId) {
      await db.query(
        `INSERT INTO contact_activities (contact_id, user_id, activity_type, description)
         VALUES ($1, $2, 'email_sent', $3)`,
        [contactId, userId, subject]
      ).catch(err => console.error('Contact activity log error:', err));
    }

    // ── 4. Advance action to in_progress if it was yet_to_start ──────────────
    if (actionId) {
      await db.query(
        `UPDATE actions
         SET status = CASE WHEN status = 'yet_to_start' THEN 'in_progress' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2`,
        [actionId, userId]
      ).catch(err => console.error('Action status update error:', err));
    }

    // ── 5. Completion detection (non-blocking) ────────────────────────────────
    if (actionId) {
      // Targeted: check whether THIS email completes THIS specific action
      ActionCompletionDetector
        .detectFromEmailForAction(newEmail.id, userId, parseInt(actionId))
        .catch(err => console.error('Targeted completion detection error:', err));
    } else {
      // Broad: scan all open actions for this deal
      ActionCompletionDetector
        .detectFromEmail(newEmail.id, userId)
        .catch(err => console.error('Broad completion detection error:', err));
    }

    // ── 6. Regenerate actions (non-blocking) ──────────────────────────────────
    ActionsGenerator
      .generateForEmail(newEmail.id)
      .catch(err => console.error('Action generation error:', err));

    // ── 7. Respond ────────────────────────────────────────────────────────────
    res.status(201).json({
      email:       newEmail,
      outlookSent,
      outlookError,  // null if sent OK; error message if Outlook failed
    });

  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: { message: 'Failed to send email' } });
  }
});

// ── GET /outlook — fetch from Outlook inbox ───────────────────────────────────
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

// ── POST /analyze — AI analysis of a single email ────────────────────────────
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

// ── POST /process — queue email for full AI processing ───────────────────────
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

module.exports = router;
