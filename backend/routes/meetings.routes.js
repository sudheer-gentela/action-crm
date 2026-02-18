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

// Update meeting - accepts all fields
router.put('/:id', async (req, res) => {
  try {
    const { 
      title, 
      description, 
      meetingType, 
      startTime, 
      endTime, 
      location, 
      status, 
      notes,
      dealId,
      attendees 
    } = req.body;
    
    // Build dynamic UPDATE query - only update fields that are provided
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (meetingType !== undefined) {
      updates.push(`meeting_type = $${paramCount++}`);
      values.push(meetingType);
    }
    if (startTime !== undefined) {
      updates.push(`start_time = $${paramCount++}`);
      values.push(startTime);
    }
    if (endTime !== undefined) {
      updates.push(`end_time = $${paramCount++}`);
      values.push(endTime);
    }
    if (location !== undefined) {
      updates.push(`location = $${paramCount++}`);
      values.push(location);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramCount++}`);
      values.push(notes);
    }
    if (dealId !== undefined) {
      updates.push(`deal_id = $${paramCount++}`);
      values.push(dealId);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }
    
    // Always update updated_at
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    
    // Add meeting ID and user ID to params
    values.push(req.params.id, req.user.userId);
    
    const result = await db.query(
      `UPDATE meetings 
       SET ${updates.join(', ')}
       WHERE id = $${paramCount++} AND user_id = $${paramCount++}
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }
    
    const updatedMeeting = result.rows[0];
    
    // Update attendees if provided
    if (attendees !== undefined) {
      // Delete existing attendees
      await db.query(
        'DELETE FROM meeting_attendees WHERE meeting_id = $1',
        [updatedMeeting.id]
      );
      
      // Insert new attendees
      if (attendees.length > 0) {
        for (const contactId of attendees) {
          await db.query(
            'INSERT INTO meeting_attendees (meeting_id, contact_id) VALUES ($1, $2)',
            [updatedMeeting.id, contactId]
          );
        }
      }
    }
    
    // 🤖 AUTO-GENERATE ACTIONS if meeting completed (non-blocking)
    if (status === 'completed') {
      ActionsGenerator.generateForMeeting(req.params.id).catch(err => 
        console.error('Error auto-generating actions for completed meeting:', err)
      );
    }
    
    res.json({ meeting: updatedMeeting });
  } catch (error) {
    console.error('Update meeting error:', error);
    res.status(500).json({ error: { message: 'Failed to update meeting' } });
  }
});

// Delete meeting
router.delete('/:id', async (req, res) => {
  try {
    const meetingId = req.params.id;
    const userId = req.user.userId;
    
    // First, check if meeting exists and belongs to user
    const checkResult = await db.query(
      'SELECT id FROM meetings WHERE id = $1 AND user_id = $2',
      [meetingId, userId]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        error: { message: 'Meeting not found or you do not have permission to delete it' } 
      });
    }
    
    // Delete attendees first (foreign key constraint)
    await db.query(
      'DELETE FROM meeting_attendees WHERE meeting_id = $1',
      [meetingId]
    );
    
    // Delete the meeting
    const result = await db.query(
      'DELETE FROM meetings WHERE id = $1 AND user_id = $2 RETURNING id',
      [meetingId, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }
    
    res.json({ 
      success: true,
      message: 'Meeting deleted successfully',
      deletedId: result.rows[0].id 
    });
    
  } catch (error) {
    console.error('Delete meeting error:', error);
    res.status(500).json({ error: { message: 'Failed to delete meeting' } });
  }
});

module.exports = router;
