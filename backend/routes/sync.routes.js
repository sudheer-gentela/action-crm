/**
 * Email Sync Routes - UPDATED
 * Uses the enhanced syncScheduler with Bull queue integration
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { triggerSync, getSyncStatus } = require('../jobs/syncScheduler');
const { emailQueue } = require('../jobs/emailProcessor');
const { pool } = require('../config/database');
const config = require('../config/config');

router.use(authenticateToken);

/**
 * Trigger manual email sync
 * POST /api/sync/emails
 * 
 * This now:
 * 1. Stores emails to database
 * 2. Generates rule-based actions (automatic)
 * 3. Queues for AI analysis ONLY if autoGenerateAIActions=true
 */
router.post('/emails', async (req, res) => {
  try {
    const userId = req.user.userId;
    
    console.log(`📧 Manual email sync triggered for user ${userId}`);
    
    const result = await triggerSync(userId, 'email');
    
    if (!result.success) {
      return res.status(200).json({
        success: false,
        message: result.message
      });
    }
    
    res.json({
      success: true,
      message: 'Email sync completed',
      data: {
        found: result.emailsFound,
        stored: result.stored,
        skipped: result.skipped,
        failed: result.failed,
        aiJobsQueued: result.jobsQueued,
        aiAutoEnabled: config.emailSync.autoGenerateAIActions
      }
    });
    
  } catch (error) {
    console.error('❌ Email sync error:', error);
    
    // Handle specific error cases
    if (error.message.includes('No tokens found') || error.message.includes('Outlook not connected')) {
      return res.status(403).json({
        success: false,
        error: 'Outlook not connected',
        message: 'Please connect your Outlook account first',
        code: 'NOT_CONNECTED'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Analyze single email with AI (MANUAL TRIGGER)
 * POST /api/sync/emails/:emailId/analyze
 * 
 * This is the button users click to get AI analysis
 */
router.post('/emails/:emailId/analyze', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { emailId } = req.params; // This is the DB email ID
    
    console.log(`🤖 Manual AI analysis requested for email ${emailId} by user ${userId}`);
    
    // Get email from database
    const emailResult = await pool.query(
      `SELECT * FROM emails 
       WHERE id = $1 AND user_id = $2`,
      [emailId, userId]
    );
    
    if (emailResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Email not found'
      });
    }
    
    const email = emailResult.rows[0];
    
    // Check if already analyzed
    const existingAnalysis = email.external_data?.ai_analysis;
    if (existingAnalysis) {
      return res.status(200).json({
        success: true,
        message: 'Email already analyzed',
        alreadyAnalyzed: true,
        data: existingAnalysis
      });
    }
    
    // Queue for AI analysis
    const job = await emailQueue.add({
      userId,
      emailId: email.external_id, // Outlook ID
      dbEmailId: emailId,          // DB ID
      dealId: email.deal_id
    }, {
      priority: 1 // High priority for manual requests
    });
    
    res.json({
      success: true,
      message: 'Email queued for AI analysis',
      jobId: job.id,
      estimatedTime: '30-60 seconds'
    });
    
  } catch (error) {
    console.error('❌ Error queuing email for analysis:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Analyze multiple emails with AI (BULK)
 * POST /api/sync/emails/analyze-bulk
 * Body: { emailIds: [1, 2, 3] }
 */
router.post('/emails/analyze-bulk', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { emailIds } = req.body;
    
    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'emailIds array is required'
      });
    }
    
    console.log(`🤖 Bulk AI analysis requested for ${emailIds.length} emails by user ${userId}`);
    
    const queuedJobs = [];
    const errors = [];
    
    for (const emailId of emailIds) {
      try {
        // Get email from database
        const emailResult = await pool.query(
          `SELECT * FROM emails 
           WHERE id = $1 AND user_id = $2`,
          [emailId, userId]
        );
        
        if (emailResult.rows.length === 0) {
          errors.push({ emailId, error: 'Not found' });
          continue;
        }
        
        const email = emailResult.rows[0];
        
        // Skip if already analyzed
        if (email.external_data?.ai_analysis) {
          errors.push({ emailId, error: 'Already analyzed' });
          continue;
        }
        
        // Queue for AI analysis
        const job = await emailQueue.add({
          userId,
          emailId: email.external_id,
          dbEmailId: emailId,
          dealId: email.deal_id
        });
        
        queuedJobs.push({ emailId, jobId: job.id });
        
      } catch (error) {
        errors.push({ emailId, error: error.message });
      }
    }
    
    res.json({
      success: true,
      message: `Queued ${queuedJobs.length} emails for AI analysis`,
      queued: queuedJobs.length,
      skipped: errors.length,
      jobs: queuedJobs,
      errors
    });
    
  } catch (error) {
    console.error('❌ Error in bulk analysis:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get AI analysis status for an email
 * GET /api/sync/emails/:emailId/analysis
 */
router.get('/emails/:emailId/analysis', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { emailId } = req.params;
    
    // Get email from database
    const emailResult = await pool.query(
      `SELECT 
        id, 
        subject, 
        external_data,
        created_at
       FROM emails 
       WHERE id = $1 AND user_id = $2`,
      [emailId, userId]
    );
    
    if (emailResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Email not found'
      });
    }
    
    const email = emailResult.rows[0];
    const aiAnalysis = email.external_data?.ai_analysis;
    const processingError = email.external_data?.processing_error;
    
    // Check if actions were created
    const actionsResult = await pool.query(
      `SELECT id, title, priority, status, created_at
       FROM actions 
       WHERE source = 'outlook_email' 
         AND source_id = (
           SELECT external_id FROM emails WHERE id = $1
         )
         AND user_id = $2
       ORDER BY created_at DESC`,
      [emailId, userId]
    );
    
    res.json({
      success: true,
      data: {
        emailId,
        subject: email.subject,
        analyzed: !!aiAnalysis,
        analysis: aiAnalysis || null,
        error: processingError || null,
        actionsCreated: actionsResult.rows.length,
        actions: actionsResult.rows
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching analysis:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get sync status and history
 * GET /api/sync/emails/status
 */
router.get('/emails/status', async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const history = await getSyncStatus(userId);
    
    res.json({
      success: true,
      data: {
        enabled: config.emailSync.enabled,
        frequency: config.emailSync.frequency,
        lastSyncs: history
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching sync status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get sync configuration
 * GET /api/sync/config
 */
router.get('/config', async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        emailSync: {
          enabled: config.emailSync.enabled,
          frequency: config.emailSync.frequency,
          intervalMinutes: config.emailSync.intervalMinutes,
          batchSize: config.emailSync.scope.batchSize,
          dealRelatedOnly: config.emailSync.scope.dealRelatedOnly,
          autoGenerateRuleBasedActions: config.emailSync.autoGenerateRuleBasedActions,
          autoGenerateAIActions: config.emailSync.autoGenerateAIActions,
        },
        features: {
          manualAIAnalysis: true,
          bulkAIAnalysis: true,
          ruleBasedActions: config.emailSync.autoGenerateRuleBasedActions
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
