const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { analyzeTranscript, getTranscriptAnalysis } = require('../services/transcriptAnalyzer');

// Configure multer for text file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for text files
  },
  fileFilter: (req, file, cb) => {
    // Accept text files
    if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt files are allowed'));
    }
  }
});

router.use(authenticateToken);

/**
 * Upload transcript (file or text)
 * POST /api/transcripts/upload
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;
    const { text, dealId, meetingId, meetingDate, attendees } = req.body;
    
    // Get transcript text from file or body
    let transcriptText;
    if (req.file) {
      transcriptText = req.file.buffer.toString('utf-8');
    } else if (text) {
      transcriptText = text;
    } else {
      return res.status(400).json({ 
        error: { message: 'Either file or text must be provided' } 
      });
    }
    
    // Validate transcript has content
    if (!transcriptText || transcriptText.trim().length < 50) {
      return res.status(400).json({ 
        error: { message: 'Transcript is too short (minimum 50 characters)' } 
      });
    }
    
    console.log(`📝 Uploading transcript for user ${userId}`);
    console.log(`   Length: ${transcriptText.length} characters`);
    console.log(`   Deal ID: ${dealId || 'none'}`);
    
    // Store transcript
    const result = await pool.query(
      `INSERT INTO meeting_transcripts (
        user_id, deal_id, meeting_id, transcript_text, 
        meeting_date, attendees, source, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id`,
      [
        userId,
        dealId || null,
        meetingId || null,
        transcriptText,
        meetingDate || null,
        attendees ? JSON.stringify(attendees) : null,
        req.file ? 'file_upload' : 'text_paste'
      ]
    );
    
    const transcriptId = result.rows[0].id;
    
    console.log(`✅ Transcript stored with ID: ${transcriptId}`);
    
    // Trigger AI analysis (async, don't wait)
    analyzeTranscript(transcriptId, userId)
      .then(() => console.log(`✅ Analysis completed for transcript ${transcriptId}`))
      .catch(err => console.error(`❌ Analysis failed for transcript ${transcriptId}:`, err));
    
    res.status(201).json({
      success: true,
      transcriptId: transcriptId,
      message: 'Transcript uploaded successfully. Analysis in progress...'
    });
    
  } catch (error) {
    console.error('Error uploading transcript:', error);
    res.status(500).json({ 
      error: { message: 'Failed to upload transcript', details: error.message } 
    });
  }
});

/**
 * Get transcript with analysis
 * GET /api/transcripts/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const transcript = await getTranscriptAnalysis(req.params.id, req.user.userId);
    
    if (!transcript) {
      return res.status(404).json({ 
        error: { message: 'Transcript not found' } 
      });
    }
    
    res.json({ transcript });
    
  } catch (error) {
    console.error('Error fetching transcript:', error);
    res.status(500).json({ 
      error: { message: 'Failed to fetch transcript' } 
    });
  }
});

/**
 * Get all transcripts for user
 * GET /api/transcripts
 */
router.get('/', async (req, res) => {
  try {
    const { dealId, status } = req.query;
    
    let query = `
      SELECT 
        mt.id,
        mt.transcript_text,
        mt.analysis_status,
        mt.analysis_result,
        mt.meeting_date,
        mt.created_at,
        d.name as deal_name,
        m.title as meeting_title
      FROM meeting_transcripts mt
      LEFT JOIN deals d ON mt.deal_id = d.id
      LEFT JOIN meetings m ON mt.meeting_id = m.id
      WHERE mt.user_id = $1
    `;
    
    const params = [req.user.userId];
    
    if (dealId) {
      query += ` AND mt.deal_id = $${params.length + 1}`;
      params.push(dealId);
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
    res.status(500).json({ 
      error: { message: 'Failed to fetch transcripts' } 
    });
  }
});

/**
 * Trigger re-analysis of transcript
 * POST /api/transcripts/:id/analyze
 */
router.post('/:id/analyze', async (req, res) => {
  try {
    const transcriptId = req.params.id;
    const userId = req.user.userId;
    
    // Verify transcript exists and belongs to user
    const check = await pool.query(
      'SELECT id FROM meeting_transcripts WHERE id = $1 AND user_id = $2',
      [transcriptId, userId]
    );
    
    if (check.rows.length === 0) {
      return res.status(404).json({ 
        error: { message: 'Transcript not found' } 
      });
    }
    
    console.log(`🔄 Re-analyzing transcript ${transcriptId}`);
    
    // Trigger analysis (async)
    analyzeTranscript(transcriptId, userId)
      .then(() => console.log(`✅ Re-analysis completed for transcript ${transcriptId}`))
      .catch(err => console.error(`❌ Re-analysis failed:`, err));
    
    res.json({ 
      success: true,
      message: 'Analysis started' 
    });
    
  } catch (error) {
    console.error('Error triggering analysis:', error);
    res.status(500).json({ 
      error: { message: 'Failed to start analysis' } 
    });
  }
});

/**
 * Delete transcript
 * DELETE /api/transcripts/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM meeting_transcripts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: { message: 'Transcript not found' } 
      });
    }
    
    res.json({ 
      success: true,
      message: 'Transcript deleted successfully' 
    });
    
  } catch (error) {
    console.error('Error deleting transcript:', error);
    res.status(500).json({ 
      error: { message: 'Failed to delete transcript' } 
    });
  }
});

module.exports = router;
