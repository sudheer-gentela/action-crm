/**
 * Sync Scheduler
 * Stores emails to DB + queues for AI analysis
 *
 * MULTI-ORG changes:
 *   - triggerSync(userId, orgId, type)
 *     orgId is now the second argument (was type)
 *   - storeEmailToDatabase(client, userId, orgId, email, userEmail)
 *     dedup query includes org_id; emails INSERT includes org_id
 *   - findEmailAssociations(client, userId, orgId, fromAddress, toAddresses, direction)
 *     contacts queried by org_id (no user_id on contacts table)
 *     deals queried by user_id AND org_id
 *   - email_sync_history INSERT/SELECT includes org_id
 *   - getSyncStatus(userId, orgId) — history scoped by org_id
 *   - syncAllUsers() now iterates org_users to get (user_id, org_id) pairs
 *     and passes orgId to triggerSync
 *   - emailQueue jobs now carry orgId so emailProcessor can use it
 *   - ActionsGenerator.generateForEmail(emailId) — signature unchanged
 *     (it looks up deal_id internally from the emails row)
 */

const cron      = require('node-cron');
const { pool }  = require('../config/database');
const { fetchEmails } = require('../services/outlookService');
const { emailQueue }  = require('./emailProcessor');
const config          = require('../config/config');
const ActionsGenerator = require('../services/actionsGenerator');

/**
 * Store email to database with deduplication.
 */
async function storeEmailToDatabase(client, userId, orgId, email, userEmail) {
  // Dedup scoped to user + org
  if (config.emailSync.deduplication.useMessageId) {
    const existingCheck = await client.query(
      `SELECT id FROM emails
       WHERE user_id = $1 AND org_id = $2 AND external_id = $3`,
      [userId, orgId, email.id]
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
  const direction   = fromAddress?.toLowerCase() === userEmail?.toLowerCase() ? 'sent' : 'received';

  // Extract email addresses
  const toAddresses = email.toRecipients?.map(r => r.emailAddress?.address) || [];
  const ccAddresses = email.ccRecipients?.map(r => r.emailAddress?.address) || [];

  // Find contact and deal associations
  const associations = await findEmailAssociations(
    client, userId, orgId, fromAddress, toAddresses, direction
  );

  // Skip if dealRelatedOnly is enabled and no deal found
  if (config.emailSync.scope.dealRelatedOnly && !associations.dealId) {
    if (config.system.debug) {
      console.log(`⏭️  Skipping non-deal email: ${email.subject}`);
    }
    return { skipped: true, reason: 'not_deal_related' };
  }

  // Store email — org_id is first data column
  const insertResult = await client.query(
    `INSERT INTO emails (
      org_id, user_id, deal_id, contact_id, direction,
      subject, body,
      to_address, from_address, cc_addresses,
      sent_at, external_id, external_data,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    RETURNING id`,
    [
      orgId,
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
      email.id,
      JSON.stringify({
        conversationId: email.conversationId,
        importance:     email.importance,
        hasAttachments: email.hasAttachments,
        isRead:         email.isRead,
        categories:     email.categories,
      }),
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
 * Find contact and deal associations for an email.
 * contacts are org-scoped (no user_id); deals are user + org scoped.
 */
async function findEmailAssociations(client, userId, orgId, fromAddress, toAddresses, direction) {
  let contactId = null;
  let dealId    = null;

  const lookupEmail = direction === 'received' ? fromAddress : toAddresses[0];
  if (!lookupEmail) return { contactId, dealId };

  // contacts have org_id but no user_id
  const contactResult = await client.query(
    `SELECT id, account_id FROM contacts
     WHERE org_id = $1
       AND LOWER(email) = LOWER($2)
       AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, lookupEmail]
  );

  if (contactResult.rows.length > 0) {
    contactId = contactResult.rows[0].id;
    const accountId = contactResult.rows[0].account_id;

    if (accountId) {
      const dealResult = await client.query(
        `SELECT id FROM deals
         WHERE user_id = $1
           AND org_id = $2
           AND account_id = $3
           AND stage NOT IN ('closed_won', 'closed_lost')
           AND deleted_at IS NULL
         ORDER BY created_at DESC
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
 * @param {string} type — 'email' (default)
 */
async function triggerSync(userId, orgId, type = 'email') {
  const client = await pool.connect();

  try {
    console.log(`📧 Triggering ${type} sync for user ${userId} org ${orgId}`);

    if (!config.emailSync.enabled) {
      console.log('⚠️  Email sync is disabled in config');
      return { success: false, message: 'Email sync disabled' };
    }

    await client.query('BEGIN');

    // Create sync history record — includes org_id
    const syncHistoryResult = await client.query(
      `INSERT INTO email_sync_history
       (user_id, org_id, sync_type, status, created_at)
       VALUES ($1, $2, $3, 'in_progress', NOW())
       RETURNING id`,
      [userId, orgId, type]
    );
    const syncHistoryId = syncHistoryResult.rows[0].id;

    // Get last sync date scoped to this user + org
    const lastSyncResult = await client.query(
      `SELECT last_sync_date FROM email_sync_history
       WHERE user_id = $1
         AND org_id = $2
         AND sync_type = $3
         AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, orgId, type]
    );
    const lastSyncDate = lastSyncResult.rows[0]?.last_sync_date;

    // Get user's email address for direction detection
    const userResult = await client.query(
      'SELECT outlook_email FROM users WHERE id = $1',
      [userId]
    );
    const userEmail = userResult.rows[0]?.outlook_email;

    // Fetch new emails from Outlook
    const fetchOptions = {
      top:     config.emailSync.scope.batchSize || 100,
      orderBy: 'receivedDateTime DESC',
    };
    if (lastSyncDate) fetchOptions.since = lastSyncDate;

    const result = await fetchEmails(userId, fetchOptions);
    console.log(`📬 Found ${result.emails.length} emails for user ${userId}`);

    let stored  = 0;
    let skipped = 0;
    let failed  = 0;
    const queuedJobs = [];

    for (const email of result.emails) {
      try {
        const storeResult = await storeEmailToDatabase(client, userId, orgId, email, userEmail);

        if (storeResult.skipped) {
          skipped++;
          continue;
        }

        if (storeResult.stored) {
          stored++;

          // Generate rule-based actions automatically (if enabled)
          // generateForEmail(emailId) looks up deal_id from emails row internally
          if (config.emailSync.autoGenerateRuleBasedActions && storeResult.dealId) {
            ActionsGenerator.generateForEmail(storeResult.emailId)
              .catch(err => console.error('Error generating rule-based actions:', err));
          }

          // Queue for AI analysis only if auto-AI is enabled
          if (config.emailSync.autoGenerateAIActions) {
            const job = await emailQueue.add({
              userId,
              orgId,
              emailId:   email.id,
              dbEmailId: storeResult.emailId,
              dealId:    storeResult.dealId,
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
      success:     true,
      emailsFound: result.emails.length,
      stored,
      skipped,
      failed,
      jobsQueued:  queuedJobs.length,
      jobIds:      queuedJobs,
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Sync failed for user ${userId}:`, error);

    try {
      await client.query(
        `UPDATE email_sync_history
         SET status = 'failed', error_message = $2
         WHERE id = (
           SELECT id FROM email_sync_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1
         )`,
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
 * @param {number} userId
 * @param {number} orgId
 */
async function getSyncStatus(userId, orgId) {
  const result = await pool.query(
    `SELECT * FROM email_sync_history
     WHERE user_id = $1 AND org_id = $2
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId, orgId]
  );

  return result.rows;
}

/**
 * Sync all connected users across all orgs.
 * Iterates org_users × users to get every active (user_id, org_id) pair
 * with an Outlook connection — a user in two orgs syncs emails separately
 * for each org they're active in.
 */
async function syncAllUsers() {
  try {
    console.log('🔄 Starting scheduled sync for all users...');

    const usersResult = await pool.query(
      `SELECT ou.user_id, ou.org_id
       FROM org_users ou
       JOIN users u ON u.id = ou.user_id
       WHERE u.outlook_connected = true
         AND u.deleted_at IS NULL
         AND ou.is_active = true`
    );

    console.log(`Found ${usersResult.rows.length} user-org pairs to sync`);

    const results = [];

    for (const { user_id, org_id } of usersResult.rows) {
      try {
        const result = await triggerSync(user_id, org_id, 'email');
        results.push({ userId: user_id, orgId: org_id, ...result });

        // Throttle to avoid Outlook rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Error syncing user ${user_id} org ${org_id}:`, error);
        results.push({ userId: user_id, orgId: org_id, success: false, error: error.message });
      }
    }

    console.log('✅ Scheduled sync completed');

    return {
      success:        true,
      usersProcessed: usersResult.rows.length,
      results,
    };

  } catch (error) {
    console.error('❌ Error in scheduled sync:', error);
    throw error;
  }
}

/**
 * Schedule automatic syncs based on config.
 */
function startScheduler() {
  if (config.emailSync.frequency !== 'scheduled') {
    console.log('ℹ️  Email sync scheduler: Manual mode (set EMAIL_SYNC_FREQUENCY=scheduled to enable)');
    return;
  }

  if (!config.emailSync.enabled) {
    console.log('ℹ️  Email sync scheduler: Disabled (set EMAIL_SYNC_ENABLED=true to enable)');
    return;
  }

  const intervalMinutes = config.emailSync.intervalMinutes;

  const cronMap = {
    1: '* * * * *', 5: '*/5 * * * *', 10: '*/10 * * * *',
    15: '*/15 * * * *', 30: '*/30 * * * *', 60: '0 * * * *',
  };
  const cronExpression = cronMap[intervalMinutes] || '*/15 * * * *';

  if (!cronMap[intervalMinutes]) {
    console.warn(`⚠️  Unsupported interval: ${intervalMinutes}min, defaulting to 15min`);
  }

  console.log(`✅ Email sync scheduler started: Every ${intervalMinutes} minutes`);
  console.log(`   Cron expression: ${cronExpression}`);

  cron.schedule(cronExpression, () => {
    console.log('⏰ Running scheduled sync...');
    syncAllUsers();
  }, {
    timezone: config.system.timezone || 'UTC',
  });
}

module.exports = {
  triggerSync,
  getSyncStatus,
  syncAllUsers,
  startScheduler,
};
