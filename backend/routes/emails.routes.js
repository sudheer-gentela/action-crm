const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const ActionsGenerator = require('../services/actionsGenerator');

const { fetchEmails, fetchEmailById } = require('../services/outlookService');
const { analyzeEmail } = require('../services/claudeService');
const { emailQueue } = require('../jobs/emailProcessor');


router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const { dealId, contactId } = req.query;
    let query = 'SELECT * FROM emails WHERE user_id = $1';
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

router.post('/', async (req, res) => {
  try {
    const { dealId, contactId, subject, body, toAddress } = req.body;
    const result = await db.query(
      `INSERT INTO emails (user_id, deal_id, contact_id, direction, subject, body, to_address, from_address, sent_at)
       VALUES ($1, $2, $3, 'sent', $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING *`,
      [req.user.userId, dealId, contactId, subject, body, toAddress, req.user.email]
    );
    
    const newEmail = result.rows[0];
    
    if (contactId) {
      await db.query(
        `INSERT INTO contact_activities (contact_id, user_id, activity_type, description)
         VALUES ($1, $2, 'email_sent', $3)`,
        [contactId, req.user.userId, subject]
      );
    }
    
    // 🤖 AUTO-GENERATE ACTIONS (non-blocking)
    ActionsGenerator.generateForEmail(newEmail.id).catch(err => 
      console.error('Error auto-generating actions for email:', err)
    );
    
    res.status(201).json({ email: newEmail });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to send email' } });
  }
});


/**
 * Fetch Outlook emails
 * GET /api/emails/outlook
 */
router.get('/outlook', async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    const { top = 50, skip = 0, since } = req.query;
    
    const result = await fetchEmails(userId, { 
      top: parseInt(top), 
      skip: parseInt(skip),
      since 
    });
    
    res.json({
      success: true,
      data: result.emails,
      hasMore: result.hasMore,
      count: result.emails.length
    });
  } catch (error) {
    console.error('Error fetching Outlook emails:', error);
    
    // ✅ Handle "no tokens" error gracefully
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ 
        success: false,
        error: 'Outlook not connected',
        message: 'Please connect your Outlook account first',
        code: 'NOT_CONNECTED'
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * Analyze single email with AI
 * POST /api/emails/analyze
 */
router.post('/analyze', async (req, res) => {
  try {
    const userId = req.user?.id || req.body.userId;
    const { emailId } = req.body;
    
    if (!emailId) {
      return res.status(400).json({ 
        success: false,
        error: 'emailId is required' 
      });
    }
    
    const email = await fetchEmailById(userId, emailId);
    const analysis = await analyzeEmail(email);
    
    res.json({
      success: true,
      data: {
        email,
        analysis
      }
    });
  } catch (error) {
    console.error('Error analyzing email:', error);
    
    // ✅ Handle "no tokens" error
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ 
        success: false,
        error: 'Outlook not connected',
        code: 'NOT_CONNECTED'
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * Process email and create actions
 * POST /api/emails/process
 */
router.post('/process', async (req, res) => {
  try {
    const userId = req.user?.id || req.body.userId;
    const { emailId } = req.body;
    
    if (!emailId) {
      return res.status(400).json({ 
        success: false,
        error: 'emailId is required' 
      });
    }
    
    const job = await emailQueue.add({
      userId,
      emailId
    });
    
    res.json({
      success: true,
      message: 'Email queued for processing',
      jobId: job.id
    });
  } catch (error) {
    console.error('Error processing email:', error);
    
    // ✅ Handle "no tokens" error
    if (error.message.includes('No tokens found')) {
      return res.status(403).json({ 
        success: false,
        error: 'Outlook not connected',
        code: 'NOT_CONNECTED'
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

module.exports = router;
