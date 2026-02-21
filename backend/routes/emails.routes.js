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

module.exports = router;
