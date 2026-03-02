/**
 * emailProcessor.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/jobs/emailProcessor.js
 *
 * Key changes from original:
 *   - Uses UnifiedEmailProvider instead of outlookService for fallback fetch
 *   - Reads provider from job.data to determine source
 *   - Source tracking: 'outlook_email' or 'gmail_email'
 */

const Queue        = require('bull');
const UnifiedEmailProvider       = require('../services/UnifiedEmailProvider');
const AIProcessor                = require('../services/aiProcessor');
const { createActionsFromEmail } = require('../services/emailActionsService');
const { pool }                   = require('../config/database');

// -- Queue setup --

const emailQueue = new Queue('email-processing', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail:     50,
  },
});

// -- Job processor --

emailQueue.process(async (job) => {
  const { userId, orgId, emailId, dbEmailId, dealId, provider = 'outlook' } = job.data;
  const source = provider === 'gmail' ? 'gmail_email' : 'outlook_email';

  console.log('Processing ' + provider + ' email ' + emailId + ' (DB ID: ' + dbEmailId + ') for user ' + userId + ' org ' + orgId);

  try {
    // Check if already processed -- scoped to org + provider source
    const existing = await pool.query(
      'SELECT id FROM actions WHERE source = $1 AND source_id = $2 AND user_id = $3 AND org_id = $4',
      [source, emailId, userId, orgId]
    );

    if (existing.rows.length > 0) {
      console.log('Email ' + emailId + ' already processed, skipping');
      return { success: true, skipped: true, reason: 'Already processed' };
    }

    // -- Fetch from database first --
    job.progress(20);
    let email;
    let usedDatabase = false;

    if (dbEmailId) {
      const dbResult = await pool.query(
        `SELECT id, external_id, subject, body, from_address, to_address,
                cc_addresses, sent_at AS "receivedDateTime", direction, external_data
         FROM emails WHERE id = $1 AND org_id = $2`,
        [dbEmailId, orgId]
      );

      if (dbResult.rows.length > 0) {
        const dbEmail = dbResult.rows[0];
        // Convert to shape expected by AIProcessor
        email = {
          id:      dbEmail.external_id,
          subject: dbEmail.subject,
          body: { content: dbEmail.body, contentType: 'HTML' },
          from: { emailAddress: { address: dbEmail.from_address } },
          toRecipients: dbEmail.to_address?.split(',').map(addr => ({
            emailAddress: { address: addr.trim() },
          })) || [],
          ccRecipients: dbEmail.cc_addresses?.split(',').map(addr => ({
            emailAddress: { address: addr.trim() },
          })) || [],
          receivedDateTime: dbEmail.receivedDateTime,
          importance:       dbEmail.external_data?.importance       || 'normal',
          hasAttachments:   dbEmail.external_data?.hasAttachments   || false,
          conversationId:   dbEmail.external_data?.conversationId   || null,
          isRead:           dbEmail.external_data?.isRead           || false,
        };
        usedDatabase = true;
        console.log('Using email from database (saved API call)');
      }
    }

    // -- Fallback: fetch from provider API --
    if (!email) {
      console.log('Email not in database, fetching from ' + provider + ' API');
      const fetched = await UnifiedEmailProvider.fetchEmailById(userId, provider, emailId);
      email = UnifiedEmailProvider.toAIProcessorShape(fetched);
      usedDatabase = false;
    }

    // -- AI analysis --
    job.progress(50);
    const analysis = await AIProcessor.analyzeEmailSimple(email);

    console.log('Email analysis:', JSON.stringify({
      category: analysis.category,
      sentiment: analysis.sentiment,
      requiresResponse: analysis.requires_response,
      actionItems: analysis.action_items?.length || 0,
      source: usedDatabase ? 'database' : provider + '_api',
    }));

    // -- Create actions -- pass provider
    job.progress(80);
    const actions = await createActionsFromEmail(userId, orgId, email, analysis, provider);

    // -- Update email record with analysis metadata --
    if (dbEmailId) {
      const conversationId = email.conversationId || null;
      await pool.query(
        `UPDATE emails
         SET external_data = jsonb_set(
               COALESCE(external_data, '{}'::jsonb),
               '{ai_analysis}',
               $1::jsonb
             ),
             conversation_id = COALESCE(conversation_id, $3)
         WHERE id = $2`,
        [
          JSON.stringify({
            analyzed_at:        new Date().toISOString(),
            category:           analysis.category,
            sentiment:          analysis.sentiment,
            requires_response:  analysis.requires_response,
            action_items_count: analysis.action_items?.length || 0,
            used_database:      usedDatabase,
            provider:           provider,
          }),
          dbEmailId,
          conversationId,
        ]
      );
    }

    job.progress(100);

    console.log('Successfully processed ' + provider + ' email ' + emailId + ', created ' + actions.length + ' actions');

    return {
      success: true, emailId, dbEmailId, dealId, provider,
      actionsCreated: actions.length, usedDatabase,
      analysis: {
        category: analysis.category,
        sentiment: analysis.sentiment,
        requiresResponse: analysis.requires_response,
      },
      actions: actions.map(a => ({ id: a.id, title: a.title })),
    };

  } catch (error) {
    console.error('Error processing ' + provider + ' email ' + emailId + ':', error);

    if (dbEmailId) {
      try {
        await pool.query(
          `UPDATE emails SET external_data = jsonb_set(
             COALESCE(external_data, '{}'::jsonb), '{processing_error}', $1::jsonb
           ) WHERE id = $2`,
          [JSON.stringify({ error_at: new Date().toISOString(), error_message: error.message }), dbEmailId]
        );
      } catch (updateError) {
        console.error('Failed to update email with error:', updateError);
      }
    }
    throw error;
  }
});

// -- Event listeners --

emailQueue.on('completed', (job, result) => {
  if (result.skipped) {
    console.log('Job ' + job.id + ' skipped: ' + result.reason);
  } else {
    const src = result.usedDatabase ? 'DB' : 'API';
    console.log('Job ' + job.id + ' completed [' + (result.provider || 'outlook') + '/' + src + ']: ' + result.actionsCreated + ' actions');
  }
});

emailQueue.on('failed', (job, err) => {
  console.error('Job ' + job.id + ' failed:', err.message);
});

emailQueue.on('stalled', (job) => {
  console.warn('Job ' + job.id + ' stalled');
});

emailQueue.on('active', (job) => {
  console.log('Job ' + job.id + ' started processing');
});

emailQueue.on('cleaned', (jobs, type) => {
  console.log('Cleaned ' + jobs.length + ' ' + type + ' jobs from queue');
});

module.exports = { emailQueue };
