const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { triggerSync, getSyncStatus } = require('../jobs/syncScheduler');
const { emailQueue } = require('../jobs/emailProcessor');
const { pool } = require('../config/database');
const config = require('../config/config');

router.use(authenticateToken);
router.use(orgContext);

// ── POST /emails ──────────────────────────────────────────────
router.post('/emails', async (req, res) => {
  try {
    console.log(`📧 Manual email sync triggered for user ${req.user.userId} org ${req.orgId}`);

    const result = await triggerSync(req.user.userId, 'email');

    if (!result.success) {
      return res.status(200).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: 'Email sync completed',
      data: {
        found:         result.emailsFound,
        stored:        result.stored,
        skipped:       result.skipped,
        failed:        result.failed,
        aiJobsQueued:  result.jobsQueued,
        aiAutoEnabled: config.emailSync.autoGenerateAIActions
      }
    });
  } catch (error) {
    console.error('❌ Email sync error:', error);
    if (error.message.includes('No tokens found') || error.message.includes('Outlook not connected')) {
      return res.status(403).json({
        success: false, error: 'Outlook not connected',
        message: 'Please connect your Outlook account first', code: 'NOT_CONNECTED'
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /emails/:emailId/analyze ─────────────────────────────
router.post('/emails/:emailId/analyze', async (req, res) => {
  try {
    const { emailId } = req.params;
    console.log(`🤖 Manual AI analysis requested for email ${emailId} by user ${req.user.userId}`);

    const emailResult = await pool.query(
      'SELECT * FROM emails WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [emailId, req.orgId, req.user.userId]
    );

    if (emailResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    const email = emailResult.rows[0];

    if (email.external_data?.ai_analysis) {
      return res.status(200).json({
        success: true, message: 'Email already analyzed',
        alreadyAnalyzed: true, data: email.external_data.ai_analysis
      });
    }

    const job = await emailQueue.add({
      userId:    req.user.userId,
      emailId:   email.external_id,
      dbEmailId: emailId,
      dealId:    email.deal_id
    }, { priority: 1 });

    res.json({ success: true, message: 'Email queued for AI analysis', jobId: job.id, estimatedTime: '30-60 seconds' });
  } catch (error) {
    console.error('❌ Error queuing email for analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /emails/analyze-bulk ─────────────────────────────────
router.post('/emails/analyze-bulk', async (req, res) => {
  try {
    const { emailIds } = req.body;

    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({ success: false, error: 'emailIds array is required' });
    }

    const queuedJobs = [];
    const errors     = [];

    for (const emailId of emailIds) {
      try {
        const emailResult = await pool.query(
          'SELECT * FROM emails WHERE id = $1 AND org_id = $2 AND user_id = $3',
          [emailId, req.orgId, req.user.userId]
        );

        if (emailResult.rows.length === 0) { errors.push({ emailId, error: 'Not found' }); continue; }

        const email = emailResult.rows[0];
        if (email.external_data?.ai_analysis) { errors.push({ emailId, error: 'Already analyzed' }); continue; }

        const job = await emailQueue.add({
          userId: req.user.userId, emailId: email.external_id,
          dbEmailId: emailId, dealId: email.deal_id
        });

        queuedJobs.push({ emailId, jobId: job.id });
      } catch (error) {
        errors.push({ emailId, error: error.message });
      }
    }

    res.json({
      success: true,
      message: `Queued ${queuedJobs.length} emails for AI analysis`,
      queued: queuedJobs.length, skipped: errors.length,
      jobs: queuedJobs, errors
    });
  } catch (error) {
    console.error('❌ Error in bulk analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /emails/:emailId/analysis ─────────────────────────────
router.get('/emails/:emailId/analysis', async (req, res) => {
  try {
    const { emailId } = req.params;

    const emailResult = await pool.query(
      `SELECT id, subject, external_data, created_at
       FROM emails
       WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [emailId, req.orgId, req.user.userId]
    );

    if (emailResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    const email          = emailResult.rows[0];
    const aiAnalysis     = email.external_data?.ai_analysis;
    const processingError = email.external_data?.processing_error;

    const actionsResult = await pool.query(
      `SELECT id, title, priority, status, created_at
       FROM actions
       WHERE org_id = $1 AND source = 'outlook_email'
         AND source_id = (SELECT external_id FROM emails WHERE id = $2)
         AND user_id = $3
       ORDER BY created_at DESC`,
      [req.orgId, emailId, req.user.userId]
    );

    res.json({
      success: true,
      data: {
        emailId, subject: email.subject,
        analyzed:       !!aiAnalysis,
        analysis:       aiAnalysis || null,
        error:          processingError || null,
        actionsCreated: actionsResult.rows.length,
        actions:        actionsResult.rows
      }
    });
  } catch (error) {
    console.error('❌ Error fetching analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /emails/status ────────────────────────────────────────
router.get('/emails/status', async (req, res) => {
  try {
    const history = await getSyncStatus(req.user.userId);
    res.json({
      success: true,
      data: {
        enabled:   config.emailSync.enabled,
        frequency: config.emailSync.frequency,
        lastSyncs: history
      }
    });
  } catch (error) {
    console.error('❌ Error fetching sync status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /config ───────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        emailSync: {
          enabled:                       config.emailSync.enabled,
          frequency:                     config.emailSync.frequency,
          intervalMinutes:               config.emailSync.intervalMinutes,
          batchSize:                     config.emailSync.scope.batchSize,
          dealRelatedOnly:               config.emailSync.scope.dealRelatedOnly,
          autoGenerateRuleBasedActions:  config.emailSync.autoGenerateRuleBasedActions,
          autoGenerateAIActions:         config.emailSync.autoGenerateAIActions,
        },
        features: {
          manualAIAnalysis:  true,
          bulkAIAnalysis:    true,
          ruleBasedActions:  config.emailSync.autoGenerateRuleBasedActions
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
