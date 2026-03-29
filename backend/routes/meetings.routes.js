const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ActionsGenerator = require('../services/actionsGenerator');

// Phase 8 — event trigger services (lazy-required to avoid startup circular deps)
// Both calls are fire-and-forget; failures never affect the meeting response.
function getHandoverService()          { return require('../services/handover.service'); }
function getProspectingActionsService(){ return require('../services/prospectingActions.service'); }

router.use(authenticateToken);
router.use(orgContext);

// ── GET / ─────────────────────────────────────────────────────────────────────
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

// ── POST / ────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      dealId, title, description, meetingType,
      startTime, endTime, location, attendees,
      // Phase 8: optional FKs for handover/prospect linking
      handoverId, prospectId,
    } = req.body;

    const result = await db.query(
      `INSERT INTO meetings
         (org_id, deal_id, user_id, title, description, meeting_type,
          start_time, end_time, location, handover_id, prospect_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.orgId, dealId || null, req.user.userId,
        title, description, meetingType,
        startTime, endTime, location,
        handoverId || null, prospectId || null,
      ]
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

    // Deal-level action generation (existing)
    ActionsGenerator.generateForMeeting(newMeeting.id).catch(err =>
      console.error('Error auto-generating actions for meeting:', err)
    );

    // Phase 8 — handover kickoff meeting created
    // Fires if this meeting is linked to a handover via handover_id column.
    // Re-evaluates handover diagnostic rules immediately so handover_no_kickoff
    // can resolve before the nightly sweep.
    if (newMeeting.handover_id) {
      // Resolve the org_id from the handover row — already have it from req.orgId
      getHandoverService()
        .generateForHandoverEvent(newMeeting.handover_id, req.orgId, 'kickoff_meeting_created')
        .catch(err => console.error(
          `[meetings POST] handover event trigger error (handover=${newMeeting.handover_id}):`,
          err.message
        ));
    }

    // Phase 8 — prospect meeting booked
    // Fires if this meeting is linked to a prospect via prospect_id column on meeting,
    // OR if a prospect attendee is present in the attendees list.
    // Resolves prospect_no_meeting diagnostic alert immediately.
    const effectiveProspectId = newMeeting.prospect_id;
    if (effectiveProspectId) {
      getProspectingActionsService()
        .generateForProspectEvent(effectiveProspectId, req.orgId, req.user.userId, 'meeting_booked')
        .catch(err => console.error(
          `[meetings POST] prospect event trigger error (prospect=${effectiveProspectId}):`,
          err.message
        ));
    }

    res.status(201).json({ meeting: newMeeting });
  } catch (error) {
    console.error('Create meeting error:', error);
    res.status(500).json({ error: { message: 'Failed to create meeting' } });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      title, description, meetingType, startTime, endTime,
      location, status, notes, dealId, attendees,
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

    // Existing deal-level action generation on completion
    if (status === 'completed') {
      ActionsGenerator.generateForMeeting(req.params.id).catch(err =>
        console.error('Error auto-generating actions for completed meeting:', err)
      );
    }

    // Phase 8 — meeting completed → fire event triggers for linked entities
    if (status === 'completed') {
      // Handover: kickoff meeting completed → re-run diagnostic rules
      if (updatedMeeting.handover_id) {
        getHandoverService()
          .generateForHandoverEvent(updatedMeeting.handover_id, req.orgId, 'kickoff_meeting_completed')
          .catch(err => console.error(
            `[meetings PUT] handover event trigger error (handover=${updatedMeeting.handover_id}):`,
            err.message
          ));
      }

      // Prospect: meeting completed → re-run diagnostic rules.
      // Resolves prospect_no_meeting, may also shift prospect_stale_outreach or prospect_ghosting.
      if (updatedMeeting.prospect_id) {
        getProspectingActionsService()
          .generateForProspectEvent(updatedMeeting.prospect_id, req.orgId, req.user.userId, 'meeting_completed')
          .catch(err => console.error(
            `[meetings PUT] prospect event trigger error (prospect=${updatedMeeting.prospect_id}):`,
            err.message
          ));
      }
    }

    res.json({ meeting: updatedMeeting });
  } catch (error) {
    console.error('Update meeting error:', error);
    res.status(500).json({ error: { message: 'Failed to update meeting' } });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
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

// ── GET /:id/attendees ────────────────────────────────────────────────────────
router.get('/:id/attendees', async (req, res) => {
  try {
    const meetingCheck = await db.query(
      `SELECT id FROM meetings WHERE id = $1 AND org_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [req.params.id, req.orgId, req.user.userId]
    );

    if (meetingCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    // Return both contact-based and prospect-based attendees as a unified list
    const result = await db.query(
      `SELECT
         ma.contact_id,
         ma.prospect_id,
         ma.attendance_status,
         ma.source,
         COALESCE(c.first_name || ' ' || c.last_name, p.first_name || ' ' || p.last_name) AS name,
         COALESCE(c.email, p.email)   AS email,
         COALESCE(c.title, p.title)   AS title,
         CASE WHEN ma.contact_id IS NOT NULL THEN 'contact' ELSE 'prospect' END AS person_type
       FROM meeting_attendees ma
       LEFT JOIN contacts  c ON c.id = ma.contact_id
       LEFT JOIN prospects p ON p.id = ma.prospect_id
       WHERE ma.meeting_id = $1
       ORDER BY
         CASE ma.attendance_status
           WHEN 'attended' THEN 1 WHEN 'invited' THEN 2
           WHEN 'no_show'  THEN 3 ELSE 4 END,
         name`,
      [req.params.id]
    );

    res.json({ attendees: result.rows });
  } catch (error) {
    console.error('GET meeting attendees error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch attendees' } });
  }
});

// ── PATCH /:id/attendees/:personId ────────────────────────────────────────────
// Works for both contacts (default) and prospects (?type=prospect)
router.patch('/:id/attendees/:personId', async (req, res) => {
  try {
    const { attendance_status } = req.body;
    const personType = req.query.type === 'prospect' ? 'prospect' : 'contact';

    const VALID_STATUSES = ['invited', 'attended', 'no_show', 'unknown'];
    if (!attendance_status || !VALID_STATUSES.includes(attendance_status)) {
      return res.status(400).json({
        error: { message: `attendance_status must be one of: ${VALID_STATUSES.join(', ')}` },
      });
    }

    const meetingCheck = await db.query(
      `SELECT id FROM meetings WHERE id=$1 AND org_id=$2 AND user_id=$3 AND deleted_at IS NULL`,
      [req.params.id, req.orgId, req.user.userId],
    );
    if (meetingCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    if (personType === 'contact') {
      await db.query(
        `INSERT INTO meeting_attendees (meeting_id, contact_id, org_id, attendance_status, source)
         VALUES ($1,$2,$3,$4,'manual')
         ON CONFLICT (meeting_id, contact_id) WHERE contact_id IS NOT NULL
         DO UPDATE SET attendance_status=$4, source='manual'`,
        [req.params.id, req.params.personId, req.orgId, attendance_status],
      );
    } else {
      await db.query(
        `INSERT INTO meeting_attendees (meeting_id, prospect_id, org_id, attendance_status, source)
         VALUES ($1,$2,$3,$4,'manual')
         ON CONFLICT (meeting_id, prospect_id) WHERE prospect_id IS NOT NULL
         DO UPDATE SET attendance_status=$4, source='manual'`,
        [req.params.id, req.params.personId, req.orgId, attendance_status],
      );
    }

    console.log(`👤 Attendance override: meeting ${req.params.id} ${personType} ${req.params.personId} → ${attendance_status}`);
    res.json({ success: true, attendance_status, source: 'manual' });
  } catch (error) {
    console.error('PATCH meeting attendee error:', error);
    res.status(500).json({ error: { message: 'Failed to update attendance' } });
  }
});

// ── GET /:id/gmeet-transcript ─────────────────────────────────────────────────
router.get('/:id/gmeet-transcript', async (req, res) => {
  const { id: meetingId } = req.params;
  const { orgId, user: { userId } } = req;

  try {
    const meetingResult = await db.query(
      `SELECT id, title, start_time, deal_id
       FROM meetings
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [meetingId, orgId, userId]
    );

    if (meetingResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    const meeting = meetingResult.rows[0];
    const GoogleDriveProvider = require('../services/GoogleDriveProvider');
    const driveProvider = new GoogleDriveProvider();

    const connCheck = await driveProvider.checkConnection(userId);
    if (!connCheck.connected) {
      return res.status(400).json({
        error: { message: 'Google account not connected. Please connect Google in Settings → Connections.' }
      });
    }

    const titleKeyword = (meeting.title || '').replace(/[^\w\s]/g, '').trim();
    const searchQuery = titleKeyword ? `Transcript of ${titleKeyword}` : 'Transcript of';

    let transcriptDoc = null;
    try {
      const files = await driveProvider.searchFiles(userId, searchQuery);
      const docs = (files || []).filter(
        f => f.mimeType === 'application/vnd.google-apps.document' || f.isGoogleNative
      );

      if (docs.length > 0) {
        if (docs.length === 1) {
          transcriptDoc = docs[0];
        } else {
          const dateStr   = meeting.start_time ? new Date(meeting.start_time).toISOString().slice(0, 10) : null;
          const lowerTitle = titleKeyword.toLowerCase();
          transcriptDoc =
            (dateStr    && docs.find(f => f.name && f.name.includes(dateStr)))          ||
            (lowerTitle && docs.find(f => f.name && f.name.toLowerCase().includes(lowerTitle))) ||
            docs[0];
        }
      }
    } catch (driveErr) {
      console.error('Drive search error:', driveErr.message);
      return res.status(502).json({
        error: { message: 'Failed to search Google Drive. Check your Google connection and try again.' }
      });
    }

    if (!transcriptDoc) {
      return res.json({
        found:   false,
        message: 'No Google Meet transcript found in Drive for this meeting.',
      });
    }

    let transcriptText = '';
    try {
      const extracted = await driveProvider.extractFileContent(userId, transcriptDoc.id);
      transcriptText  = extracted.rawText || '';
    } catch (exportErr) {
      console.error('Drive export error:', exportErr.message);
      return res.status(502).json({
        error: { message: 'Found transcript doc but failed to read its contents. Please try again.' }
      });
    }

    if (!transcriptText || transcriptText.trim().length < 50) {
      return res.json({
        found:   false,
        message: 'Transcript doc was found but appears to be empty or too short to process.',
      });
    }

    const existing = await db.query(
      `SELECT id FROM meeting_transcripts
       WHERE meeting_id = $1 AND source = 'google_meet' AND org_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [meetingId, orgId]
    );

    let transcriptId;

    if (existing.rows.length > 0) {
      transcriptId = existing.rows[0].id;
      await db.query(
        `UPDATE meeting_transcripts
         SET transcript_text = $1, analysis_status = 'pending', analysis_result = NULL, updated_at = NOW()
         WHERE id = $2`,
        [transcriptText.trim(), transcriptId]
      );
    } else {
      const insertResult = await db.query(
        `INSERT INTO meeting_transcripts
           (org_id, user_id, meeting_id, transcript_text, source, meeting_date, created_at)
         VALUES ($1, $2, $3, $4, 'google_meet', $5, NOW())
         RETURNING id`,
        [orgId, userId, meetingId, transcriptText.trim(), meeting.start_time ? new Date(meeting.start_time) : null]
      );

      transcriptId = insertResult.rows[0].id;

      await db.query(
        `UPDATE meetings SET transcript_id = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
        [transcriptId, meetingId, orgId]
      );
    }

    const { analyzeTranscript } = require('../services/transcriptAnalyzer');
    analyzeTranscript(transcriptId, userId)
      .then(() => console.log(`✅ G-Meet transcript ${transcriptId} analysis complete`))
      .catch(err  => console.error(`❌ G-Meet transcript ${transcriptId} analysis failed:`, err.message));

    return res.json({
      found:        true,
      transcriptId,
      docTitle:     transcriptDoc.name,
      message:      'Transcript fetched and analysis started.',
    });

  } catch (error) {
    console.error('GET gmeet-transcript error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch Google Meet transcript' } });
  }
});

module.exports = router;
