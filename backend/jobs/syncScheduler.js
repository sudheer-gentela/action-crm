const cron = require('node-cron');
const { pool } = require('../config/database');
const { fetchEmails } = require('../services/outlookService');
const { emailQueue } = require('./emailProcessor');
const config = require('../config/config');
const ActionsGenerator = require('../services/actionsGenerator');

/**
 * ENHANCED Sync Scheduler - Stores emails to DB + Queues for AI analysis
 * Combines database storage with Bull queue processing
 */

/**
 * Store email to database with deduplication
 */
async function storeEmailToDatabase(client, userId, email, userEmail) {
  // Check for duplicate using messageId
  if (config.emailSync.deduplication.useMessageId) {
    const existingCheck = await client.query(
      `SELECT id FROM emails 
       WHERE user_id = $1 AND external_id = $2`,
      [userId, email.id]
    );
    
    if (existingCheck.rows.length > 0) {
      if (config.system.debug) {
        console.log(`⏭️  Skipping duplicate email: ${email.id}`);
      }
      return { skipped: true, emailId: existingCheck.rows[0].id };
    }
  }
  
  // Determine email direction
  const fromAddress = email.from?.emailAddress?.address || null;
  const direction = fromAddress?.toLowerCase() === userEmail?.toLowerCase() ? 'sent' : 'received';
  
  // Extract email addresses
  const toAddresses = email.toRecipients?.map(r => r.emailAddress?.address) || [];
  const ccAddresses = email.ccRecipients?.map(r => r.emailAddress?.address) || [];
  
  // Find contact and deal associations
  const associations = await findEmailAssociations(
    client, 
    userId, 
    fromAddress, 
    toAddresses,
    direction
  );
  
  // Skip if dealRelatedOnly is enabled and no deal found
  if (config.emailSync.scope.dealRelatedOnly && !associations.dealId) {
    if (config.system.debug) {
      console.log(`⏭️  Skipping non-deal email: ${email.subject}`);
    }
    return { skipped: true, reason: 'not_deal_related' };
  }
  
  // Store email
  const insertResult = await client.query(
    `INSERT INTO emails (
      user_id, deal_id, contact_id, direction,
      subject, body, 
      to_address, from_address, cc_addresses,
      sent_at, external_id, external_data,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    RETURNING id`,
    [
      userId,
      associations.dealId,
      associations.contactId,
      direction,
      email.subject || '(No Subject)',
      email.body?.content || email.bodyPreview || '',
      toAddresses.join(', '),
      fromAddress,
      ccAddresses.join(', '),
      email.receivedDateTime,
      email.id, // Outlook message ID
      JSON.stringify({
        conversationId: email.conversationId,
        importance: email.importance,
        hasAttachments: email.hasAttachments,
        isRead: email.isRead,
        categories: email.categories
      })
    ]
  );
  
  const newEmailId = insertResult.rows[0].id;
  
  if (config.system.debug) {
    console.log(`✅ Stored email ${newEmailId}: ${email.subject}`);
  }
  
  // Add contact activity if associated
  if (associations.contactId) {
    await client.query(
      `INSERT INTO contact_activities (contact_id, user_id, activity_type, description, created_at)
       VALUES ($1, $2, 'email_${direction}', $3, NOW())`,
      [associations.contactId, userId, email.subject]
    );
  }
  
  return { stored: true, emailId: newEmailId, dealId: associations.dealId };
}

/**
 * Find contact and deal associations for an email
 */
async function findEmailAssociations(client, userId, fromAddress, toAddresses, direction) {
  let contactId = null;
  let dealId = null;
  
  const lookupEmail = direction === 'received' ? fromAddress : toAddresses[0];
  
  if (!lookupEmail) {
    return { contactId, dealId };
  }
  
  // Find contact by email
  const contactResult = await client.query(
    `SELECT id, account_id FROM contacts 
     WHERE user_id = $1 
       AND LOWER(email) = LOWER($2)
       AND deleted_at IS NULL
     LIMIT 1`,
    [userId, lookupEmail]
  );
  
  if (contactResult.rows.length > 0) {
    contactId = contactResult.rows[0].id;
    const accountId = contactResult.rows[0].account_id;
    
    // Find active deal for this contact's account
    if (accountId) {
      const dealResult = await client.query(
        `SELECT id FROM deals 
         WHERE user_id = $1 
           AND account_id = $2
           AND stage NOT IN ('closed_won', 'closed_lost')
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, accountId]
      );
      
      if (dealResult.rows.length > 0) {
        dealId = dealResult.rows[0].id;
      }
    }
  }
  
  return { contactId, dealId };
}

/**
 * Trigger sync for a user - ENHANCED with database storage
 */
async function triggerSync(userId, type = 'email') {
  const client = await pool.connect();
  
  try {
    console.log(`📧 Triggering ${type} sync for user ${userId}`);
    
    // Check if email sync is enabled
    if (!config.emailSync.enabled) {
      console.log('⚠️  Email sync is disabled in config');
      return { success: false, message: 'Email sync disabled' };
    }
    
    await client.query('BEGIN');
    
    // Create sync history record
    const syncHistoryResult = await client.query(
      `INSERT INTO email_sync_history 
       (user_id, sync_type, status, created_at)
       VALUES ($1, $2, 'in_progress', NOW())
       RETURNING id`,
      [userId, type]
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;
    
    // Get last sync date
    const lastSyncResult = await client.query(
      `SELECT last_sync_date FROM email_sync_history 
       WHERE user_id = $1 
         AND sync_type = $2 
         AND status = 'completed'
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId, type]
    );
    
    const lastSyncDate = lastSyncResult.rows[0]?.last_sync_date;
    
    // Get user's email for direction detection
    const userResult = await client.query(
      'SELECT outlook_email FROM users WHERE id = $1',
      [userId]
    );
    const userEmail = userResult.rows[0]?.outlook_email;
    
    // Fetch new emails from Outlook
    const fetchOptions = {
      top: config.emailSync.scope.batchSize || 100,
      orderBy: 'receivedDateTime DESC'
    };
    
    if (lastSyncDate) {
      fetchOptions.since = lastSyncDate;
    }
    
    const result = await fetchEmails(userId, fetchOptions);
    
    console.log(`📬 Found ${result.emails.length} emails for user ${userId}`);
    
    // Process each email: Store to DB + Queue for AI analysis
    let stored = 0;
    let skipped = 0;
    let failed = 0;
    const queuedJobs = [];
    
    for (const email of result.emails) {
      try {
        // 1. Store email to database
        const storeResult = await storeEmailToDatabase(client, userId, email, userEmail);
        
        if (storeResult.skipped) {
          skipped++;
          continue;
        }
        
        if (storeResult.stored) {
          stored++;
          
          // Generate rule-based actions automatically (if enabled)
          if (config.emailSync.autoGenerateRuleBasedActions && storeResult.dealId) {
            // Use ActionsGenerator for rule-based actions (non-blocking)
            ActionsGenerator.generateForEmail(storeResult.emailId).catch(err => 
              console.error('Error generating rule-based actions:', err)
            );
          }
          
          // Queue for AI analysis ONLY if auto-AI is enabled
          // By default, this is FALSE - user must click "Analyze with AI" button
          if (config.emailSync.autoGenerateAIActions) {
            const job = await emailQueue.add({
              userId,
              emailId: email.id,
              dbEmailId: storeResult.emailId,
              dealId: storeResult.dealId
            });
            queuedJobs.push(job.id);
          }
        }
      } catch (error) {
        console.error(`❌ Error processing email "${email.subject}":`, error.message);
        failed++;
      }
    }
    
    // Update sync history
    await client.query(
      `UPDATE email_sync_history 
       SET status = 'completed',
           items_processed = $2,
           items_failed = $3,
           last_sync_date = NOW()
       WHERE id = $1`,
      [syncHistoryId, stored, failed]
    );
    
    await client.query('COMMIT');
    
    console.log(`✅ Sync completed: ${stored} stored, ${skipped} skipped, ${failed} failed`);
    console.log(`🤖 Queued ${queuedJobs.length} emails for AI analysis`);
    
    return {
      success: true,
      emailsFound: result.emails.length,
      stored,
      skipped,
      failed,
      jobsQueued: queuedJobs.length,
      jobIds: queuedJobs
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Sync failed for user ${userId}:`, error);
    
    // Record failed sync
    try {
      await client.query(
        `UPDATE email_sync_history 
         SET status = 'failed',
             error_message = $2
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [userId, error.message]
      );
    } catch (updateError) {
      console.error('Failed to update sync history:', updateError);
    }
    
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get sync status for user
 */
async function getSyncStatus(userId) {
  const result = await pool.query(
    `SELECT * FROM email_sync_history 
     WHERE user_id = $1 
     ORDER BY created_at DESC 
     LIMIT 10`,
    [userId]
  );
  
  return result.rows;
}

/**
 * Sync all connected users
 */
async function syncAllUsers() {
  try {
    console.log('🔄 Starting scheduled sync for all users...');
    
    const usersResult = await pool.query(
      `SELECT id FROM users 
       WHERE outlook_connected = true 
       AND deleted_at IS NULL`
    );
    
    console.log(`Found ${usersResult.rows.length} users to sync`);
    
    const results = [];
    
    for (const user of usersResult.rows) {
      try {
        const result = await triggerSync(user.id, 'email');
        results.push({ userId: user.id, ...result });
        
        // Add delay between users to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Error syncing user ${user.id}:`, error);
        results.push({ 
          userId: user.id, 
          success: false, 
          error: error.message 
        });
      }
    }
    
    console.log('✅ Scheduled sync completed');
    
    return {
      success: true,
      usersProcessed: usersResult.rows.length,
      results
    };
  } catch (error) {
    console.error('❌ Error in scheduled sync:', error);
    throw error;
  }
}

/**
 * Schedule automatic syncs based on config
 */
function startScheduler() {
  // Only start if scheduled sync is enabled
  if (config.emailSync.frequency !== 'scheduled') {
    console.log('ℹ️  Email sync scheduler: Manual mode (set EMAIL_SYNC_FREQUENCY=scheduled to enable)');
    return;
  }
  
  if (!config.emailSync.enabled) {
    console.log('ℹ️  Email sync scheduler: Disabled (set EMAIL_SYNC_ENABLED=true to enable)');
    return;
  }
  
  const intervalMinutes = config.emailSync.intervalMinutes;
  
  // Convert interval to cron expression
  let cronExpression;
  
  if (intervalMinutes === 1) {
    cronExpression = '* * * * *';
  } else if (intervalMinutes === 5) {
    cronExpression = '*/5 * * * *';
  } else if (intervalMinutes === 10) {
    cronExpression = '*/10 * * * *';
  } else if (intervalMinutes === 15) {
    cronExpression = '*/15 * * * *';
  } else if (intervalMinutes === 30) {
    cronExpression = '*/30 * * * *';
  } else if (intervalMinutes === 60) {
    cronExpression = '0 * * * *';
  } else {
    console.warn(`⚠️  Unsupported interval: ${intervalMinutes}min, defaulting to 15min`);
    cronExpression = '*/15 * * * *';
  }
  
  console.log(`✅ Email sync scheduler started: Every ${intervalMinutes} minutes`);
  console.log(`   Cron expression: ${cronExpression}`);
  
  cron.schedule(cronExpression, () => {
    console.log('⏰ Running scheduled sync...');
    syncAllUsers();
  }, {
    timezone: config.system.timezone || 'UTC'
  });
}

module.exports = {
  triggerSync,
  getSyncStatus,
  syncAllUsers,
  startScheduler
};
