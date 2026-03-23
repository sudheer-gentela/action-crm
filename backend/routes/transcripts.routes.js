const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const { analyzeTranscript, getTranscriptAnalysis } = require('../services/transcriptAnalyzer');

const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt files are allowed'));
    }
  },
});

router.use(authenticateToken);
router.use(orgContext);

// ── POST /upload ───────────────────────────────────────────────────────────────
//
// Phase 2 additions:
//   1. When meetingId supplied: validate it belongs to this user/org.
//      Back-fill deal_id and meeting_date from the meeting row if not provided.
//   2. After insert: write meetings.transcript_id so CalendarView can show
//      a "transcript available" badge without a join.
//   3. Fire analyzeTranscript as before — no change to that pipeline.
//
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;
    const orgId  = req.orgId;
    const { text, meetingDate, attendees } = req.body;
    let { dealId, meetingId } = req.body;

    // ── Resolve transcript text ──────────────────────────────────
    let transcriptText;
    if (req.file) {
      transcriptText = req.file.buffer.toString('utf-8');
    } else if (text) {
      transcriptText = text;
    } else {
      return res.status(400).json({ error: { message: 'Either file or text must be provided' } });
    }

    if (!transcriptText || transcriptText.trim().length < 50) {
      return res.status(400).json({ error: { message: 'Transcript is too short (minimum 50 characters)' } });
    }

    // ── Validate + enrich from meeting if meetingId provided ─────
    let resolvedMeetingDate = meetingDate || null;

    if (meetingId) {
      const meetingRow = await pool.query(
        `SELECT id, deal_id, start_time
         FROM meetings
         WHERE id      = $1
           AND org_id  = $2
           AND user_id = $3
           AND deleted_at IS NULL`,
        [meetingId, orgId, userId],
      );

      if (meetingRow.rows.length === 0) {
        // Meeting not found for this user — detach silently rather than reject
        // (avoids leaking IDs, still stores transcript without meeting link)
        console.warn(
          `⚠️  Transcript upload: meetingId ${meetingId} not found for ` +
          `user ${userId} — storing without meeting link`,
        );
        meetingId = null;
      } else {
        const mtg = meetingRow.rows[0];
        // Back-fill deal_id from meeting if caller did not supply one
        if (!dealId && mtg.deal_id) dealId = mtg.deal_id;
        // Back-fill meeting date from start_time if not provided
        if (!resolvedMeetingDate && mtg.start_time) {
          resolvedMeetingDate = mtg.start_time.toISOString().split('T')[0];
        }
      }
    }

    console.log(`📝 Uploading transcript for user ${userId} org ${orgId}`);

    // ── Insert transcript record ─────────────────────────────────
    const result = await pool.query(
      `INSERT INTO meeting_transcripts
         (org_id, user_id, deal_id, meeting_id, transcript_text,
          meeting_date, attendees, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id`,
      [
        orgId,
        userId,
        dealId    || null,
        meetingId || null,
        transcriptText,
        resolvedMeetingDate,
        attendees ? JSON.stringify(attendees) : null,
        req.file ? 'file_upload' : 'text_paste',
      ],
    );

    const transcriptId = result.rows[0].id;

    // ── Back-link: write meetings.transcript_id ──────────────────
    // Lets CalendarView show a transcript badge without a join.
    if (meetingId) {
      try {
        await pool.query(
          `UPDATE meetings
           SET transcript_id = $1, updated_at = NOW()
           WHERE id = $2 AND org_id = $3`,
          [transcriptId, meetingId, orgId],
        );
        console.log(`   🔗 Linked transcript ${transcriptId} → meeting ${meetingId}`);
      } catch (linkErr) {
        // Non-fatal — transcript is still usable without the back-link
        console.error(`   ⚠️  Could not back-link transcript to meeting:`, linkErr.message);
      }
    }

    // ── Fire async AI analysis ───────────────────────────────────
    analyzeTranscript(transcriptId, userId)
      .then(() => console.log(`✅ Analysis completed for transcript ${transcriptId}`))
      .catch(err => console.error(`❌ Analysis failed for transcript ${transcriptId}:`, err));

    res.status(201).json({
      success: true,
      transcriptId,
      meetingId: meetingId || null,
      message: 'Transcript uploaded successfully. Analysis in progress...',
    });

  } catch (error) {
    console.error('Error uploading transcript:', error);
    res.status(500).json({ error: { message: 'Failed to upload transcript', details: error.message } });
  }
});

// ── GET / ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { dealId, meetingId, status } = req.query;

    let query = `
      SELECT
        mt.id, mt.transcript_text, mt.analysis_status,
        mt.analysis_result, mt.meeting_date, mt.created_at,
        d.name  AS deal_name,
        m.title AS meeting_title
      FROM meeting_transcripts mt
      LEFT JOIN deals    d ON mt.deal_id    = d.id
      LEFT JOIN meetings m ON mt.meeting_id = m.id
      WHERE mt.org_id = $1 AND mt.user_id = $2
    `;

    const params = [req.orgId, req.user.userId];

    if (dealId) {
      query += ` AND mt.deal_id = $${params.length + 1}`;
      params.push(dealId);
    }
    if (meetingId) {
      query += ` AND mt.meeting_id = $${params.length + 1}`;
      params.push(meetingId);
    }
    if (status) {
      query += ` AND mt.analysis_status = $${params.length + 1}`;
      params.push(status);
    }

    query += ' ORDER BY mt.created_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json({ transcripts: result.rows });

  } catch (error) {
    console.error('Error fetching transcripts:', error);
    res.status(500).json({ error: { message: 'Failed to fetch transcripts' } });
  }
});

// ── GET /:id ───────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const transcript = await getTranscriptAnalysis(req.params.id, req.user.userId);

    if (!transcript) {
      return res.status(404).json({ error: { message: 'Transcript not found' } });
    }

    res.json({ transcript });
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.status(500).json({ error: { message: 'Failed to fetch transcript' } });
  }
});

// ── POST /:id/analyze (re-trigger) ────────────────────────────────────────────
router.post('/:id/analyze', async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT id FROM meeting_transcripts WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [req.params.id, req.orgId, req.user.userId],
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Transcript not found' } });
    }

    analyzeTranscript(req.params.id, req.user.userId)
      .then(() => console.log(`✅ Re-analysis completed for transcript ${req.params.id}`))
      .catch(err => console.error('❌ Re-analysis failed:', err));

    res.json({ success: true, message: 'Analysis started' });

  } catch (error) {
    console.error('Error triggering analysis:', error);
    res.status(500).json({ error: { message: 'Failed to start analysis' } });
  }
});

// ── DELETE /:id ────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    // Clear back-link on meeting before deleting the transcript
    await pool.query(
      `UPDATE meetings
       SET transcript_id = NULL, updated_at = NOW()
       WHERE transcript_id = $1 AND org_id = $2`,
      [req.params.id, req.orgId],
    );

    const result = await pool.query(
      'DELETE FROM meeting_transcripts WHERE id = $1 AND org_id = $2 AND user_id = $3 RETURNING id',
      [req.params.id, req.orgId, req.user.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Transcript not found' } });
    }

    res.json({ success: true, message: 'Transcript deleted successfully' });

  } catch (error) {
    console.error('Error deleting transcript:', error);
    res.status(500).json({ error: { message: 'Failed to delete transcript' } });
  }
});

module.exports = router;
