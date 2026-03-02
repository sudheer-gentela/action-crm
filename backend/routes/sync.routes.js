/**
 * sync.routes.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/routes/sync.routes.js
 *
 * Key changes from original:
 *   - POST /emails accepts optional 'provider' in body/query ('outlook' | 'gmail')
 *   - Error messages are provider-aware
 *   - All other endpoints unchanged
 */

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

// -- POST /emails -- now accepts provider parameter --
router.post('/emails', async (req, res) => {
  try {
    const provider = req.body.provider || req.query.provider || 'outlook';

    if (!['outlook', 'gmail'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Invalid provider. Use "outlook" or "gmail".' });
    }

    console.log('Manual ' + provider + ' email sync triggered for user ' + req.user.userId + ' org ' + req.orgId);

    const result = await triggerSync(req.user.userId, req.orgId, 'email', provider);

    if (!result.success) {
      return res.status(200).json({ success: false, message: result.message });
    }

    res.json({
      success: true,
      message: provider + ' email sync completed',
      data: {
        provider:      provider,
        found:         result.emailsFound,
        stored:        result.stored,
        skipped:       result.skipped,
        failed:        result.failed,
        aiJobsQueued:  result.jobsQueued,
        aiAutoEnabled: config.emailSync.autoGenerateAIActions
      }
    });
  } catch (error) {
    console.error('Email sync error:', error);
    const provider = req.body.provider || req.query.provider || 'outlook';

    if (error.message.includes('No tokens found') ||
        error.message.includes('not connected') ||
        error.message.includes('Please reconnect')) {
      const label = provider === 'gmail' ? 'Gmail' : 'Outlook';
      return res.status(403).json({
        success: false, error: label + ' not connected',
        message: 'Please connect your ' + label + ' account first', code: 'NOT_CONNECTED'
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- POST /emails/:emailId/analyze -- unchanged --
router.post('/emails/:emailId/analyze', async (req, res) => {
  try {
    const { emailId } = req.params;
    console.log('Manual AI analysis requested for email ' + emailId + ' by user ' + req.user.userId);

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
      orgId:     req.orgId,
      emailId:   email.external_id,
      dbEmailId: emailId,
      dealId:    email.deal_id,
      provider:  email.provider || 'outlook',
    }, { priority: 1 });

    res.json({ success: true, message: 'Email queued for AI analysis', jobId: job.id, estimatedTime: '30-60 seconds' });
  } catch (error) {
    console.error('Error queuing email for analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- POST /emails/analyze-bulk -- now includes provider --
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
          userId: req.user.userId,
          orgId: req.orgId,
          emailId: email.external_id,
          dbEmailId: emailId,
          dealId: email.deal_id,
          provider: email.provider || 'outlook',
        });

        queuedJobs.push({ emailId, jobId: job.id });
      } catch (error) {
        errors.push({ emailId, error: error.message });
      }
    }

    res.json({
      success: true,
      message: 'Queued ' + queuedJobs.length + ' emails for AI analysis',
      queued: queuedJobs.length, skipped: errors.length,
      jobs: queuedJobs, errors
    });
  } catch (error) {
    console.error('Error in bulk analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- GET /emails/:emailId/analysis -- unchanged --
router.get('/emails/:emailId/analysis', async (req, res) => {
  try {
    const { emailId } = req.params;

    const emailResult = await pool.query(
      'SELECT id, subject, external_data, provider, created_at FROM emails WHERE id = $1 AND org_id = $2 AND user_id = $3',
      [emailId, req.orgId, req.user.userId]
    );

    if (emailResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    const email = emailResult.rows[0];
    const aiAnalysis = email.external_data?.ai_analysis;
    const processingError = email.external_data?.processing_error;

    // Use provider-aware source for action lookup
    const source = (email.provider === 'gmail') ? 'gmail_email' : 'outlook_email';
    const actionsResult = await pool.query(
      `SELECT id, title, priority, status, created_at
       FROM actions
       WHERE org_id = $1 AND source = $2
         AND source_id = (SELECT external_id FROM emails WHERE id = $3)
         AND user_id = $4
       ORDER BY created_at DESC`,
      [req.orgId, source, emailId, req.user.userId]
    );

    res.json({
      success: true,
      data: {
        emailId, subject: email.subject, provider: email.provider,
        analyzed: !!aiAnalysis,
        analysis: aiAnalysis || null,
        error: processingError || null,
        actionsCreated: actionsResult.rows.length,
        actions: actionsResult.rows
      }
    });
  } catch (error) {
    console.error('Error fetching analysis:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- GET /emails/status -- unchanged --
router.get('/emails/status', async (req, res) => {
  try {
    const history = await getSyncStatus(req.user.userId, req.orgId);
    res.json({
      success: true,
      data: { enabled: config.emailSync.enabled, frequency: config.emailSync.frequency, lastSyncs: history }
    });
  } catch (error) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -- GET /config -- unchanged --
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
    console.error('Error fetching config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
