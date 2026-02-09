const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const ActionsGenerator = require('../services/actionsGenerator');

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = 'SELECT * FROM meetings WHERE user_id = $1';
    const params = [req.user.userId];
    
    if (startDate && endDate) {
      query += ' AND start_time BETWEEN $2 AND $3';
      params.push(startDate, endDate);
    }
    
    query += ' ORDER BY start_time ASC';
    const result = await db.query(query, params);
    res.json({ meetings: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch meetings' } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { dealId, title, description, meetingType, startTime, endTime, location, attendees } = req.body;
    const result = await db.query(
      `INSERT INTO meetings (deal_id, user_id, title, description, meeting_type, start_time, end_time, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [dealId, req.user.userId, title, description, meetingType, startTime, endTime, location]
    );
    
    const newMeeting = result.rows[0];
    
    if (attendees && attendees.length > 0) {
      for (const contactId of attendees) {
        await db.query(
          'INSERT INTO meeting_attendees (meeting_id, contact_id) VALUES ($1, $2)',
          [newMeeting.id, contactId]
        );
      }
    }
    
    // 🤖 AUTO-GENERATE ACTIONS (non-blocking)
    ActionsGenerator.generateForMeeting(newMeeting.id).catch(err => 
      console.error('Error auto-generating actions for meeting:', err)
    );
    
    res.status(201).json({ meeting: newMeeting });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to create meeting' } });
  }
});

// Update meeting (e.g., mark as completed)
router.put('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    
    const result = await db.query(
      `UPDATE meetings 
       SET status = COALESCE($1, status),
           notes = COALESCE($2, notes),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [status, notes, req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }
    
    // 🤖 AUTO-GENERATE ACTIONS if meeting completed (non-blocking)
    if (status === 'completed') {
      ActionsGenerator.generateForMeeting(req.params.id).catch(err => 
        console.error('Error auto-generating actions for completed meeting:', err)
      );
    }
    
    res.json({ meeting: result.rows[0] });
  } catch (error) {
    console.error('Update meeting error:', error);
    res.status(500).json({ error: { message: 'Failed to update meeting' } });
  }
});

module.exports = router;
