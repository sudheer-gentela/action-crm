const Queue = require('bull');
const { fetchEmailById } = require('../services/outlookService');
const AIProcessor = require('../services/aiProcessor');
const { createActionsFromEmail } = require('../services/emailActionsService');
const { pool } = require('../config/database');

/**
 * OPTIMIZED Email Processor - Uses database-stored emails
 * Only fetches from Outlook if database content is insufficient
 * Uses AIProcessor for all AI analysis (consolidated from claudeService)
 */

// Create queue
const emailQueue = new Queue('email-processing', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100,
    removeOnFail: 50
  }
});

// Process jobs
emailQueue.process(async (job) => {
  const { userId, emailId, dbEmailId, dealId } = job.data;
  
  console.log(`🤖 Processing email ${emailId} (DB ID: ${dbEmailId}) for user ${userId}`);
  
  try {
    // Check if already processed (actions already created)
    const existing = await pool.query(
      'SELECT id FROM actions WHERE source = $1 AND source_id = $2 AND user_id = $3',
      ['outlook_email', emailId, userId]
    );
    
    if (existing.rows.length > 0) {
      console.log(`⏭️  Email ${emailId} already processed, skipping`);
      return { 
        success: true, 
        skipped: true,
        reason: 'Already processed' 
      };
    }
    
    // ✅ OPTIMIZED: Fetch email from DATABASE first
    job.progress(20);
    let email;
    let usedDatabase = false;
    
    if (dbEmailId) {
      const dbResult = await pool.query(
        `SELECT 
          id,
          external_id,
          subject,
          body,
          from_address,
          to_address,
          cc_addresses,
          sent_at as receivedDateTime,
          direction,
          external_data
         FROM emails 
         WHERE id = $1 AND user_id = $2`,
        [dbEmailId, userId]
      );
      
      if (dbResult.rows.length > 0) {
        const dbEmail = dbResult.rows[0];
        
        // Convert database format to Outlook format
        email = {
          id: dbEmail.external_id,
          subject: dbEmail.subject,
          body: {
            content: dbEmail.body,
            contentType: 'HTML'
          },
          from: {
            emailAddress: {
              address: dbEmail.from_address
            }
          },
          toRecipients: dbEmail.to_address?.split(',').map(addr => ({
            emailAddress: { address: addr.trim() }
          })) || [],
          ccRecipients: dbEmail.cc_addresses?.split(',').map(addr => ({
            emailAddress: { address: addr.trim() }
          })) || [],
          receivedDateTime: dbEmail.receivedDateTime,
          importance: dbEmail.external_data?.importance || 'normal',
          hasAttachments: dbEmail.external_data?.hasAttachments || false,
          conversationId: dbEmail.external_data?.conversationId || null,
          isRead: dbEmail.external_data?.isRead || false
        };
        
        usedDatabase = true;
        console.log(`✅ Using email from database (saved Outlook API call)`);
      }
    }
    
    // ⚠️ FALLBACK: Only fetch from Outlook if database doesn't have it
    if (!email) {
      console.log(`⚠️  Email not in database, fetching from Outlook API`);
      email = await fetchEmailById(userId, emailId);
      usedDatabase = false;
    }
    
    // Analyze with Claude AI (using consolidated AIProcessor)
    job.progress(50);
    const analysis = await AIProcessor.analyzeEmailSimple(email);
    
    console.log(`📊 Email analysis:`, {
      category: analysis.category,
      sentiment: analysis.sentiment,
      requiresResponse: analysis.requires_response,
      actionItems: analysis.action_items?.length || 0,
      source: usedDatabase ? 'database' : 'outlook_api'
    });
    
    // Create actions based on AI analysis
    job.progress(80);
    const actions = await createActionsFromEmail(userId, email, analysis);
    
    // Update email record with AI analysis metadata
    if (dbEmailId) {
      await pool.query(
        `UPDATE emails 
         SET external_data = jsonb_set(
           COALESCE(external_data, '{}'::jsonb),
           '{ai_analysis}',
           $1::jsonb
         )
         WHERE id = $2`,
        [JSON.stringify({
          analyzed_at: new Date().toISOString(),
          category: analysis.category,
          sentiment: analysis.sentiment,
          requires_response: analysis.requires_response,
          action_items_count: analysis.action_items?.length || 0,
          used_database: usedDatabase
        }), dbEmailId]
      );
    }
    
    job.progress(100);
    
    console.log(`✅ Successfully processed email ${emailId}, created ${actions.length} actions`);
    
    return {
      success: true,
      emailId,
      dbEmailId,
      dealId,
      actionsCreated: actions.length,
      usedDatabase,
      analysis: {
        category: analysis.category,
        sentiment: analysis.sentiment,
        requiresResponse: analysis.requires_response
      },
      actions: actions.map(a => ({ id: a.id, title: a.title }))
    };
  } catch (error) {
    console.error(`❌ Error processing email ${emailId}:`, error);
    
    // Update email record with error
    if (dbEmailId) {
      try {
        await pool.query(
          `UPDATE emails 
           SET external_data = jsonb_set(
             COALESCE(external_data, '{}'::jsonb),
             '{processing_error}',
             $1::jsonb
           )
           WHERE id = $2`,
          [JSON.stringify({
            error_at: new Date().toISOString(),
            error_message: error.message
          }), dbEmailId]
        );
      } catch (updateError) {
        console.error('Failed to update email with error:', updateError);
      }
    }
    
    throw error;
  }
});

// Event listeners
emailQueue.on('completed', (job, result) => {
  if (result.skipped) {
    console.log(`⏭️  Job ${job.id} skipped: ${result.reason}`);
  } else {
    const source = result.usedDatabase ? '💾 DB' : '🌐 API';
    console.log(`✅ Job ${job.id} completed: ${result.actionsCreated} actions (${source})`);
  }
});

emailQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

emailQueue.on('stalled', (job) => {
  console.warn(`⚠️  Job ${job.id} stalled`);
});

emailQueue.on('active', (job) => {
  console.log(`🔄 Job ${job.id} started processing`);
});

// Clean up old jobs periodically
emailQueue.on('cleaned', (jobs, type) => {
  console.log(`🧹 Cleaned ${jobs.length} ${type} jobs from queue`);
});

module.exports = { emailQueue };
