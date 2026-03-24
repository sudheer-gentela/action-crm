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

// ── GET /:id/attendees ────────────────────────────────────────────────────────
// Returns attendees for a meeting with attendance_status and source.
// Used by MeetingTranscriptPanel to show the inline status selectors.
router.get('/:id/attendees', async (req, res) => {
  try {
    // Verify meeting belongs to this user/org
    const meetingCheck = await db.query(
      `SELECT id FROM meetings
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [req.params.id, req.orgId, req.user.userId]
    );

    if (meetingCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    const result = await db.query(
      `SELECT
         ma.contact_id,
         ma.attendance_status,
         ma.source,
         c.first_name || ' ' || c.last_name AS name,
         c.email,
         c.title
       FROM meeting_attendees ma
       JOIN contacts c ON c.id = ma.contact_id
       WHERE ma.meeting_id = $1
       ORDER BY
         -- Show attended first, then invited, then no_show, then unknown
         CASE ma.attendance_status
           WHEN 'attended' THEN 1
           WHEN 'invited'  THEN 2
           WHEN 'no_show'  THEN 3
           ELSE 4
         END,
         c.first_name`,
      [req.params.id]
    );

    res.json({ attendees: result.rows });
  } catch (error) {
    console.error('GET meeting attendees error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch attendees' } });
  }
});

// ── PATCH /:id/attendees/:contactId ──────────────────────────────────────────
// Update attendance status for a single attendee.
// Always sets source = 'manual' — manual overrides are never auto-overwritten.
router.patch('/:id/attendees/:contactId', async (req, res) => {
  try {
    const { attendance_status } = req.body;

    const VALID_STATUSES = ['invited', 'attended', 'no_show', 'unknown'];
    if (!attendance_status || !VALID_STATUSES.includes(attendance_status)) {
      return res.status(400).json({
        error: { message: `attendance_status must be one of: ${VALID_STATUSES.join(', ')}` }
      });
    }

    // Verify meeting belongs to this user/org
    const meetingCheck = await db.query(
      `SELECT id FROM meetings
       WHERE id = $1 AND org_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [req.params.id, req.orgId, req.user.userId]
    );

    if (meetingCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Meeting not found' } });
    }

    // Upsert — attendee row may or may not exist yet
    const result = await db.query(
      `INSERT INTO meeting_attendees (meeting_id, contact_id, org_id, attendance_status, source)
       VALUES ($1, $2, $3, $4, 'manual')
       ON CONFLICT (meeting_id, contact_id) DO UPDATE
         SET attendance_status = $4,
             source            = 'manual'
       RETURNING contact_id, attendance_status, source`,
      [req.params.id, req.params.contactId, req.orgId, attendance_status]
    );

    console.log(
      `👤 Attendance override: meeting ${req.params.id} contact ${req.params.contactId} → ${attendance_status} (manual)`
    );

    res.json({ attendee: result.rows[0] });
  } catch (error) {
    console.error('PATCH meeting attendee error:', error);
    res.status(500).json({ error: { message: 'Failed to update attendance' } });
  }
});

// ── GET /:id/attendees ─────────────────────────────────────────────────────────
router.get('/:id/attendees', async (req, res) => {
  try {
    const meetingCheck = await db.query(
      `SELECT id FROM meetings WHERE id=$1 AND org_id=$2 AND user_id=$3 AND deleted_at IS NULL`,
      [req.params.id, req.orgId, req.user.userId],
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
      [req.params.id],
    );

    res.json({ attendees: result.rows });
  } catch (error) {
    console.error('GET meeting attendees error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch attendees' } });
  }
});

// ── PATCH /:id/attendees/:contactId ───────────────────────────────────────────
// Works for both contacts (contactId param) and prospects (use prospect_id query param)
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
// Fetch a Google Meet transcript from the organiser's Google Drive.
//
// Google Meet saves transcripts as Google Docs in the organiser's Drive with
// the title pattern: "Transcript of [Meeting Title] [Date]"
// Requires: Google Workspace Admin to have enabled transcription for the domain,
//           and the user to have connected Google via /auth/google.
//
// Flow:
//   1. Load the meeting record to get title + start_time
//   2. Use GoogleDriveProvider to search Drive for a matching transcript doc
//   3. Extract the full text from the doc
//   4. Store as a meeting_transcripts row (source = 'google_meet')
//   5. Fire analyzeTranscript async (fire-and-forget)
//   6. Return { transcriptId, found: true } or { found: false }
router.get('/:id/gmeet-transcript', async (req, res) => {
  const { id: meetingId } = req.params;
  const { orgId, user: { userId } } = req;

  try {
    // ── 1. Load meeting ──────────────────────────────────────────
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

    // ── 2. Verify Google is connected (GoogleDriveProvider handles token
    //       refresh internally via tokenService / oauth_tokens table) ──────
    const GoogleDriveProvider = require('../services/GoogleDriveProvider');
    const driveProvider = new GoogleDriveProvider();

    const connCheck = await driveProvider.checkConnection(userId);
    if (!connCheck.connected) {
      return res.status(400).json({
        error: { message: 'Google account not connected. Please connect Google in Settings → Connections.' }
      });
    }

    // ── 3. Search Drive for a matching transcript doc ─────────────
    // GoogleDriveProvider.searchFiles() does a Drive fullText search.
    // G-Meet saves transcript docs with titles like:
    //   "Transcript of <Meeting Title> <Date>"
    // We search on "Transcript of" + the meeting title keywords so the
    // fullText index can narrow the result set.
    const titleKeyword = (meeting.title || '').replace(/[^\w\s]/g, '').trim();
    // Always anchor on "Transcript of" — present in every G-Meet doc title.
    // If the meeting has a title, include it to reduce false positives.
    const searchQuery = titleKeyword
      ? `Transcript of ${titleKeyword}`
      : 'Transcript of';

    let transcriptDoc = null;
    try {
      const files = await driveProvider.searchFiles(userId, searchQuery);

      // Filter to Google Docs only (G-Meet always saves as a Google Doc)
      const docs = (files || []).filter(
        f => f.mimeType === 'application/vnd.google-apps.document' ||
             f.isGoogleNative
      );

      if (docs.length > 0) {
        if (docs.length === 1) {
          transcriptDoc = docs[0];
        } else {
          // Multiple hits — prefer the doc whose name best matches the meeting.
          // Priority: date string match → title keyword match → most recent (first)
          const dateStr = meeting.start_time
            ? new Date(meeting.start_time).toISOString().slice(0, 10)  // "YYYY-MM-DD"
            : null;
          const lowerTitle = titleKeyword.toLowerCase();

          transcriptDoc =
            (dateStr   && docs.find(f => f.name && f.name.includes(dateStr)))         ||
            (lowerTitle && docs.find(f => f.name && f.name.toLowerCase().includes(lowerTitle))) ||
            docs[0];  // fallback: most recently modified (Drive returns modifiedTime desc)
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
        message: 'No Google Meet transcript found in Drive for this meeting. ' +
                 'Ensure transcription is enabled in Google Workspace Admin and that the meeting has ended.',
      });
    }

    // ── 4. Extract text via extractFileContent ────────────────────
    // extractFileContent exports the Google Doc as .docx, then extracts
    // plain text via contentExtractor — returns { rawText, fileName, ... }
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

    // ── 5. Check for duplicate (same doc already imported) ───────
    const existing = await db.query(
      `SELECT id FROM meeting_transcripts
       WHERE meeting_id = $1 AND source = 'google_meet' AND org_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [meetingId, orgId]
    );

    let transcriptId;

    if (existing.rows.length > 0) {
      // Overwrite transcript text (re-fetch = fresher version of same doc)
      transcriptId = existing.rows[0].id;
      await db.query(
        `UPDATE meeting_transcripts
         SET transcript_text = $1,
             analysis_status = 'pending',
             analysis_result = NULL,
             updated_at      = NOW()
         WHERE id = $2`,
        [transcriptText.trim(), transcriptId]
      );
      console.log(`🔄 G-Meet transcript re-fetched for meeting ${meetingId} (transcript ${transcriptId})`);
    } else {
      // Insert new transcript row
      const insertResult = await db.query(
        `INSERT INTO meeting_transcripts
           (org_id, user_id, meeting_id, transcript_text, source, meeting_date, created_at)
         VALUES ($1, $2, $3, $4, 'google_meet', $5, NOW())
         RETURNING id`,
        [
          orgId,
          userId,
          meetingId,
          transcriptText.trim(),
          meeting.start_time ? new Date(meeting.start_time) : null,
        ]
      );

      transcriptId = insertResult.rows[0].id;

      // Back-link to meeting
      await db.query(
        `UPDATE meetings
         SET transcript_id = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3`,
        [transcriptId, meetingId, orgId]
      );

      console.log(`✅ G-Meet transcript stored for meeting ${meetingId} (transcript ${transcriptId})`);
    }

    // ── 6. Fire AI analysis (async, fire-and-forget) ─────────────
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
