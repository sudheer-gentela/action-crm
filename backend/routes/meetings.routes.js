const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ActionsGenerator = require('../services/actionsGenerator');

router.use(authenticateToken);
router.use(orgContext);

// ── GET / ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query    = 'SELECT * FROM meetings WHERE org_id = $1 AND user_id = $2';
    const params = [req.orgId, req.user.userId];

    if (startDate && endDate) {
      query += ` AND start_time BETWEEN $${params.length + 1} AND $${params.length + 2}`;
      params.push(startDate, endDate);
    }

    query += ' ORDER BY start_time ASC';
    const result = await db.query(query, params);
    res.json({ meetings: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch meetings' } });
  }
});

// ── POST / ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { dealId, title, description, meetingType, startTime, endTime, location, attendees } = req.body;

    const result = await db.query(
      `INSERT INTO meetings
         (org_id, deal_id, user_id, title, description, meeting_type, start_time, end_time, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.orgId, dealId, req.user.userId, title, description, meetingType, startTime, endTime, location]
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

    ActionsGenerator.generateForMeeting(newMeeting.id).catch(err =>
      console.error('Error auto-generating actions for meeting:', err)
    );

    res.status(201).json({ meeting: newMeeting });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to create meeting' } });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      title, description, meetingType, startTime, endTime,
      location, status, notes, dealId, attendees
    } = req.body;

    const updates = [];
    const values  = [];
    let paramCount = 1;

    if (title       !== undefined) { updates.push(`title = $${paramCount++}`);        values.push(title); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`);  values.push(description); }
    if (meetingType !== undefined) { updates.push(`meeting_type = $${paramCount++}`); values.push(meetingType); }
    if (startTime   !== undefined) { updates.push(`start_time = $${paramCount++}`);   values.push(startTime); }
    if (endTime     !== undefined) { updates.push(`end_time = $${paramCount++}`);     values.push(endTime); }
    if (location    !== undefined) { updates.push(`location = $${paramCount++}`);     values.push(location); }
    if (status      !== undefined) { updates.push(`status = $${paramCount++}`);       values.push(status); }
    if (notes       !== undefined) { updates.push(`notes = $${paramCount++}`);        values.push(notes); }
    if (dealId      !== undefined) { updates.push(`deal_id = $${paramCount++}`);      values.push(dealId); }

    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id, req.orgId, req.user.userId);

    const result = await db.query(
      `UPDATE meetings
       SET ${updates.join(', ')}
       WHERE id = $${paramCount} AND org_id = $${paramCount + 1} AND user_id = $${paramCount + 2}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    const updatedMeeting = result.rows[0];

    if (attendees !== undefined) {
      await db.query('DELETE FROM meeting_attendees WHERE meeting_id = $1', [updatedMeeting.id]);
      if (attendees.length > 0) {
        for (const contactId of attendees) {
          await db.query(
            'INSERT INTO meeting_attendees (meeting_id, contact_id) VALUES ($1, $2)',
            [updatedMeeting.id, contactId]
          );
        }
      }
    }

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

// ── DELETE /:id ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const check = await db.query(
      'SELECT id FROM meetings WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [req.params.id, req.orgId, req.user.userId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({
        error: { message: 'Meeting not found or you do not have permission to delete it' }
      });
    }

    await db.query('DELETE FROM meeting_attendees WHERE meeting_id = $1', [req.params.id]);

    const result = await db.query(
      'DELETE FROM meetings WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id',
      [req.params.id, req.orgId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    res.json({ success: true, message: 'Meeting deleted successfully', deletedId: result.rows[0].id });
  } catch (error) {
    console.error('Delete meeting error:', error);
    res.status(500).json({ error: { message: 'Failed to delete meeting' } });
  }
});

module.exports = router;
