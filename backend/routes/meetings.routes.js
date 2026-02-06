const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

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
    
    if (attendees && attendees.length > 0) {
      for (const contactId of attendees) {
        await db.query(
          'INSERT INTO meeting_attendees (meeting_id, contact_id) VALUES ($1, $2)',
          [result.rows[0].id, contactId]
        );
      }
    }
    
    res.status(201).json({ meeting: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to create meeting' } });
  }
});

module.exports = router;
