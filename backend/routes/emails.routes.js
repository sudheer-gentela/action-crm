const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const ActionsGenerator = require('../services/actionsGenerator');

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

module.exports = router;
