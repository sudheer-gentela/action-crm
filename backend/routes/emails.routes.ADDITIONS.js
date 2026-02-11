// ============================================================
// ADD THESE ENDPOINTS TO YOUR EXISTING emails.routes.js FILE
// ============================================================

const { fetchEmails, fetchEmailById } = require('../services/outlookService');
const { analyzeEmail } = require('../services/claudeService');
const { emailQueue } = require('../jobs/emailProcessor');

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
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});
