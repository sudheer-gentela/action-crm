/**
 * syncScheduler.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/jobs/syncScheduler.js
 *
 * Unified email sync - works with both Outlook and Gmail.
 * Key changes from original:
 *   - Uses UnifiedEmailProvider instead of outlookService directly
 *   - triggerSync() accepts a provider parameter ('outlook' | 'gmail')
 *   - storeEmailToDatabase() stores provider column
 *   - syncAllUsers() iterates both Outlook and Gmail connected users
 */

const cron      = require('node-cron');
const { pool }  = require('../config/database');
const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');
const { emailQueue }       = require('./emailProcessor');
const config               = require('../config/config');
const ActionsGenerator     = require('../services/actionsGenerator');

/**
 * Store email to database with deduplication.
 * Now accepts normalized email shape from UnifiedEmailProvider.
 */
async function storeEmailToDatabase(client, userId, orgId, email, userEmail, provider) {
  // Dedup scoped to user + org
  if (config.emailSync.deduplication.useMessageId) {
    const existingCheck = await client.query(
      'SELECT id FROM emails WHERE user_id = $1 AND org_id = $2 AND external_id = $3',
      [userId, orgId, email.id]
    );

    if (existingCheck.rows.length > 0) {
      if (config.system.debug) {
        console.log('Skip duplicate email:', email.id);
      }
      return { skipped: true, emailId: existingCheck.rows[0].id };
    }
  }

  // Determine email direction using normalized shape
  const fromAddress = email.from?.address || null;
  const direction   = fromAddress?.toLowerCase() === userEmail?.toLowerCase() ? 'sent' : 'received';

  // Extract email addresses from normalized shape
  const toAddresses = email.toRecipients?.map(r => r.address) || [];
  const ccAddresses = email.ccRecipients?.map(r => r.address) || [];

  // Find contact and deal associations
  const associations = await findEmailAssociations(
    client, userId, orgId, fromAddress, toAddresses, direction
  );

  // Skip if dealRelatedOnly is enabled and no deal found
  if (config.emailSync.scope.dealRelatedOnly && !associations.dealId) {
    if (config.system.debug) {
      console.log('Skip non-deal email:', email.subject);
    }
    return { skipped: true, reason: 'not_deal_related' };
  }

  // Store email -- now includes provider column
  const insertResult = await client.query(
    `INSERT INTO emails (
      org_id, user_id, deal_id, contact_id, direction,
      subject, body,
      to_address, from_address, cc_addresses,
      sent_at, external_id, external_data,
      conversation_id, provider,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    RETURNING id`,
    [
      orgId,
      userId,
      associations.dealId,
      associations.contactId,
      direction,
      email.subject,
      email.body?.content || email.bodyPreview || '',
      toAddresses.join(', '),
      fromAddress,
      ccAddresses.join(', '),
      email.receivedDateTime,
      email.id,
      JSON.stringify({
        conversationId: email.conversationId,
        importance:     email.importance,
        hasAttachments: email.hasAttachments,
        isRead:         email.isRead,
        categories:     email.categories,
      }),
      email.conversationId || null,
      provider,
    ]
  );

  const newEmailId = insertResult.rows[0].id;

  if (config.system.debug) {
    console.log('Stored ' + provider + ' email ' + newEmailId + ': ' + email.subject);
  }

  // Add contact activity if associated
  if (associations.contactId) {
    await client.query(
      "INSERT INTO contact_activities (contact_id, user_id, activity_type, description, created_at) VALUES ($1, $2, 'email_" + direction + "', $3, NOW())",
      [associations.contactId, userId, email.subject]
    );
  }

  return { stored: true, emailId: newEmailId, dealId: associations.dealId };
}

/**
 * Find contact and deal associations for an email.
 * Unchanged from original except uses normalized address format.
 */
async function findEmailAssociations(client, userId, orgId, fromAddress, toAddresses, direction) {
  let contactId = null;
  let dealId    = null;

  const lookupEmail = direction === 'received' ? fromAddress : toAddresses[0];
  if (!lookupEmail) return { contactId, dealId };

  const contactResult = await client.query(
    'SELECT id, account_id FROM contacts WHERE org_id = $1 AND LOWER(email) = LOWER($2) AND deleted_at IS NULL LIMIT 1',
    [orgId, lookupEmail]
  );

  if (contactResult.rows.length > 0) {
    contactId = contactResult.rows[0].id;
    const accountId = contactResult.rows[0].account_id;

    if (accountId) {
      const dealResult = await client.query(
        `SELECT id FROM deals
         WHERE org_id = $2
           AND account_id = $3
           AND stage NOT IN ('closed_won', 'closed_lost')
           AND deleted_at IS NULL
           AND (
             user_id = $1
             OR id IN (SELECT deal_id FROM deal_team_members WHERE user_id = $1 AND org_id = $2)
           )
         ORDER BY
           CASE WHEN user_id = $1 THEN 0 ELSE 1 END,
           created_at DESC
         LIMIT 1`,
        [userId, orgId, accountId]
      );

      if (dealResult.rows.length > 0) {
        dealId = dealResult.rows[0].id;
      }
    }
  }

  return { contactId, dealId };
}

/**
 * Trigger sync for a user.
 * @param {number} userId
 * @param {number} orgId
 * @param {string} type     - 'email' (default)
 * @param {string} provider - 'outlook' | 'gmail'
 */
async function triggerSync(userId, orgId, type, provider) {
  // Support old 3-arg call: triggerSync(userId, orgId, 'email')
  if (typeof type === 'string' && !provider) {
    if (type === 'outlook' || type === 'gmail') {
      provider = type;
      type = 'email';
    } else {
      provider = 'outlook'; // default for backward compat
    }
  }
  if (!type) type = 'email';
  if (!provider) provider = 'outlook';

  const client = await pool.connect();

  try {
    console.log('Triggering ' + type + ' sync (' + provider + ') for user ' + userId + ' org ' + orgId);

    if (!config.emailSync.enabled) {
      console.log('Email sync is disabled in config');
      return { success: false, message: 'Email sync disabled' };
    }

    await client.query('BEGIN');

    // Create sync history record
    const syncHistoryResult = await client.query(
      'INSERT INTO email_sync_history (user_id, org_id, sync_type, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
      [userId, orgId, type + '_' + provider, 'in_progress']
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;

    // Get last sync date
    const lastSyncResult = await client.query(
      "SELECT last_sync_date FROM email_sync_history WHERE user_id = $1 AND org_id = $2 AND sync_type = $3 AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
      [userId, orgId, type + '_' + provider]
    );
    const lastSyncDate = lastSyncResult.rows[0]?.last_sync_date;

    // Get user's email address for direction detection
    const userEmail = await UnifiedEmailProvider.getUserEmail(userId, provider);

    // Fetch emails via unified provider
    const fetchOptions = {
      top:     config.emailSync.scope.batchSize || 100,
      orderBy: 'receivedDateTime DESC',
    };
    if (lastSyncDate) fetchOptions.since = lastSyncDate;

    const result = await UnifiedEmailProvider.fetchEmails(userId, provider, fetchOptions);
    console.log('Found ' + result.emails.length + ' ' + provider + ' emails for user ' + userId);

    let stored  = 0;
    let skipped = 0;
    let failed  = 0;
    const queuedJobs = [];

    for (const email of result.emails) {
      try {
        const storeResult = await storeEmailToDatabase(
          client, userId, orgId, email, userEmail, provider
        );

        if (storeResult.skipped) {
          skipped++;
          continue;
        }

        if (storeResult.stored) {
          stored++;

          if (config.emailSync.autoGenerateRuleBasedActions && storeResult.dealId) {
            ActionsGenerator.generateForEmail(storeResult.emailId)
              .catch(err => console.error('Error generating rule-based actions:', err));
          }

          if (config.emailSync.autoGenerateAIActions) {
            const job = await emailQueue.add({
              userId,
              orgId,
              emailId:   email.id,
              dbEmailId: storeResult.emailId,
              dealId:    storeResult.dealId,
              provider,
            });
            queuedJobs.push(job.id);
          }
        }
      } catch (error) {
        console.error('Error processing ' + provider + ' email "' + email.subject + '":', error.message);
        failed++;
      }
    }

    await client.query(
      'UPDATE email_sync_history SET status = $2, items_processed = $3, items_failed = $4, last_sync_date = NOW() WHERE id = $1',
      [syncHistoryId, 'completed', stored, failed]
    );

    await client.query('COMMIT');

    console.log(provider + ' sync completed: ' + stored + ' stored, ' + skipped + ' skipped, ' + failed + ' failed');
    console.log('Queued ' + queuedJobs.length + ' emails for AI analysis');

    return {
      success: true, provider,
      emailsFound: result.emails.length,
      stored, skipped, failed,
      jobsQueued: queuedJobs.length,
      jobIds: queuedJobs,
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(provider + ' sync failed for user ' + userId + ':', error);

    try {
      await client.query(
        "UPDATE email_sync_history SET status = 'failed', error_message = $2 WHERE id = (SELECT id FROM email_sync_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)",
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
 * Get sync status for a user, scoped to their current org.
 */
async function getSyncStatus(userId, orgId) {
  const result = await pool.query(
    'SELECT * FROM email_sync_history WHERE user_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 10',
    [userId, orgId]
  );
  return result.rows;
}

/**
 * Sync all connected users across all orgs.
 * Now iterates BOTH Outlook and Gmail connected users.
 */
async function syncAllUsers() {
  try {
    console.log('Starting scheduled sync for all users...');

    // Outlook users
    const outlookUsers = await pool.query(
      "SELECT ou.user_id, ou.org_id FROM org_users ou JOIN users u ON u.id = ou.user_id WHERE u.outlook_connected = true AND u.deleted_at IS NULL AND ou.is_active = true"
    );

    // Gmail users
    const gmailUsers = await pool.query(
      "SELECT ou.user_id, ou.org_id FROM org_users ou JOIN users u ON u.id = ou.user_id WHERE u.gmail_connected = true AND u.deleted_at IS NULL AND ou.is_active = true"
    );

    const allSyncJobs = [
      ...outlookUsers.rows.map(r => ({ ...r, provider: 'outlook' })),
      ...gmailUsers.rows.map(r => ({ ...r, provider: 'gmail' })),
    ];

    console.log('Found ' + allSyncJobs.length + ' user-org-provider combinations to sync');

    const results = [];

    for (const { user_id, org_id, provider } of allSyncJobs) {
      try {
        const result = await triggerSync(user_id, org_id, 'email', provider);
        results.push({ userId: user_id, orgId: org_id, provider, ...result });
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('Error syncing user ' + user_id + ' org ' + org_id + ' ' + provider + ':', error);
        results.push({ userId: user_id, orgId: org_id, provider, success: false, error: error.message });
      }
    }

    console.log('Scheduled sync completed');
    return { success: true, usersProcessed: allSyncJobs.length, results };
  } catch (error) {
    console.error('Error in scheduled sync:', error);
    throw error;
  }
}

/**
 * Schedule automatic syncs based on config.
 */
function startScheduler() {
  if (config.emailSync.frequency !== 'scheduled') {
    console.log('Email sync scheduler: Manual mode');
    return;
  }
  if (!config.emailSync.enabled) {
    console.log('Email sync scheduler: Disabled');
    return;
  }

  const intervalMinutes = config.emailSync.intervalMinutes;
  const cronMap = {
    1: '* * * * *', 5: '*/5 * * * *', 10: '*/10 * * * *',
    15: '*/15 * * * *', 30: '*/30 * * * *', 60: '0 * * * *',
  };
  const cronExpression = cronMap[intervalMinutes] || '*/15 * * * *';

  console.log('Email sync scheduler started: Every ' + intervalMinutes + ' minutes');
  cron.schedule(cronExpression, () => {
    console.log('Running scheduled sync...');
    syncAllUsers();
  }, { timezone: config.system.timezone || 'UTC' });
}

module.exports = {
  triggerSync,
  getSyncStatus,
  syncAllUsers,
  startScheduler,
};
