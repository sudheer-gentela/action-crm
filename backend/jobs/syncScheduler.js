/**
 * syncScheduler.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/jobs/syncScheduler.js
 *
 * Key changes from previous version:
 *   - findEmailAssociations now scans ALL addresses (from, all tos, all ccs)
 *     rather than just the single primary lookup address — catches CC'd team
 *     members and multi-recipient threads
 *   - Deal matching now queries deal_contacts directly (contact → deal_contacts
 *     → deal_id) rather than contact → account → deal. This is more precise
 *     and avoids false matches when one account has multiple concurrent deals.
 *   - Falls back to account-level match only when no direct deal_contacts row
 *     exists (preserves backward compatibility)
 *   - Terminal-stage filter uses pipeline_stages.is_terminal instead of the
 *     hardcoded 'closed_won'/'closed_lost' strings
 *   - storeEmailToDatabase stamps tag_source = 'auto' when a deal is matched
 *     automatically, so DealEmailHistory can distinguish auto-linked vs manual
 */

const cron      = require('node-cron');
const { pool }  = require('../config/database');
const UnifiedEmailProvider = require('../services/UnifiedEmailProvider');
const { emailQueue }       = require('./emailProcessor');
const config               = require('../config/config');
const ActionsGenerator             = require('../services/actionsGenerator');
const ContractActionsGenerator     = require('../services/ContractActionsGenerator');

/**
 * Store email to database with deduplication.
 * Accepts normalized email shape from UnifiedEmailProvider.
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
    client, userId, orgId, fromAddress, toAddresses, ccAddresses, direction
  );

  // Skip if dealRelatedOnly is enabled and no deal found
  if (config.emailSync.scope.dealRelatedOnly && !associations.dealId) {
    if (config.system.debug) {
      console.log('Skip non-deal email:', email.subject);
    }
    return { skipped: true, reason: 'not_deal_related' };
  }

  // tag_source: 'auto' when the deal was resolved automatically during sync,
  // null otherwise (manual tagging sets 'manual', team suggestions set 'team')
  const tagSource  = associations.dealId ? 'auto' : null;
  const taggedAt   = associations.dealId ? new Date() : null;
  const taggedBy   = associations.dealId ? userId : null;

  // Store email
  const insertResult = await client.query(
    `INSERT INTO emails (
      org_id, user_id, deal_id, contact_id, direction,
      subject, body,
      to_address, from_address, cc_addresses,
      sent_at, external_id, external_data,
      conversation_id, provider,
      tag_source, tagged_at, tagged_by,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
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
      tagSource,
      taggedAt,
      taggedBy,
    ]
  );

  const newEmailId = insertResult.rows[0].id;

  if (config.system.debug) {
    console.log('Stored ' + provider + ' email ' + newEmailId + ': ' + email.subject
      + (associations.dealId ? ' [deal ' + associations.dealId + ']' : ''));
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
 *
 * Strategy (in priority order):
 *
 * 1. Collect all unique non-self addresses across from, to, and cc fields.
 *    "Self" means the syncing user's own email — we skip it so we don't
 *    accidentally resolve our own address as a contact.
 *
 * 2. For each candidate address, look up the contact in this org.
 *    Take the first match as contactId.
 *
 * 3. For each matched contact, check deal_contacts for a direct link to an
 *    active deal the syncing user owns or is a team member of.
 *    This is more precise than account-level matching when one account has
 *    multiple concurrent deals.
 *
 * 4. If no deal_contacts row exists for any matched contact, fall back to the
 *    original account-level query: contact.account_id → deals WHERE owner or
 *    team member.
 *
 * 5. Terminal deals are excluded using pipeline_stages.is_terminal = true,
 *    with a hardcoded fallback for orgs that haven't migrated yet.
 *
 * @param {object} client       - pg transaction client
 * @param {number} userId       - syncing user's id
 * @param {number} orgId
 * @param {string} fromAddress
 * @param {string[]} toAddresses
 * @param {string[]} ccAddresses
 * @param {string} direction    - 'sent' | 'received'
 * @returns {{ contactId: number|null, dealId: number|null }}
 */
async function findEmailAssociations(client, userId, orgId, fromAddress, toAddresses, ccAddresses, direction) {
  let contactId = null;
  let dealId    = null;

  // Build a deduplicated list of all external addresses on this email.
  // For sent emails we skip our own fromAddress (it's us).
  // For received emails we skip our own address wherever it appears in to/cc.
  const allAddresses = [
    ...(direction === 'received' ? [fromAddress] : []),
    ...toAddresses,
    ...ccAddresses,
  ]
    .filter(Boolean)
    .map(a => a.toLowerCase().trim())
    .filter((a, idx, arr) => arr.indexOf(a) === idx); // dedupe

  if (allAddresses.length === 0) return { contactId, dealId };

  // ── Step 1: resolve contacts ──────────────────────────────────────────────
  // Look up all addresses in one query and take the first match.
  const contactResult = await client.query(
    `SELECT id, account_id, email
     FROM contacts
     WHERE org_id    = $1
       AND LOWER(email) = ANY($2::text[])
       AND deleted_at IS NULL
     ORDER BY id ASC`,
    [orgId, allAddresses]
  );

  if (contactResult.rows.length === 0) return { contactId, dealId };

  // Use the first matched contact as the primary contact for this email.
  // If multiple contacts match (e.g. a thread with several deal contacts),
  // subsequent contacts still contribute to deal matching below.
  contactId = contactResult.rows[0].id;
  const contactIds  = contactResult.rows.map(r => r.id);
  const accountIds  = [...new Set(contactResult.rows.map(r => r.account_id).filter(Boolean))];

  // ── Step 2: deal_contacts match (preferred) ───────────────────────────────
  // Check if any matched contact is directly linked to a deal the syncing
  // user owns or is a team member of, and the deal is still active.
  if (contactIds.length > 0) {
    const dealContactsResult = await client.query(
      `SELECT d.id AS deal_id
       FROM deal_contacts dc
       JOIN deals d ON d.id = dc.deal_id
       LEFT JOIN pipeline_stages ps
         ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
       WHERE dc.contact_id = ANY($1::int[])
         AND d.org_id  = $2
         AND d.deleted_at IS NULL
         AND (
           -- Exclude terminal stages: use pipeline_stages if available,
           -- fall back to hardcoded keys for pre-migration orgs
           CASE
             WHEN ps.id IS NOT NULL THEN ps.is_terminal = false
             ELSE d.stage NOT IN ('closed_won', 'closed_lost')
           END
         )
         AND (
           d.owner_id = $3
           OR d.id IN (
             SELECT deal_id FROM deal_team_members
             WHERE user_id = $3 AND org_id = $2
           )
         )
       ORDER BY
         CASE WHEN d.owner_id = $3 THEN 0 ELSE 1 END,
         d.created_at DESC
       LIMIT 1`,
      [contactIds, orgId, userId]
    );

    if (dealContactsResult.rows.length > 0) {
      dealId = dealContactsResult.rows[0].deal_id;
      return { contactId, dealId };
    }
  }

  // ── Step 3: account-level fallback ───────────────────────────────────────
  // No direct deal_contacts link found. Fall back to: contact.account_id →
  // deals on that account. This preserves behaviour for deals where contacts
  // haven't been explicitly linked yet.
  if (accountIds.length > 0) {
    const dealResult = await client.query(
      `SELECT d.id AS deal_id
       FROM deals d
       LEFT JOIN pipeline_stages ps
         ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
       WHERE d.org_id     = $1
         AND d.account_id = ANY($2::int[])
         AND d.deleted_at IS NULL
         AND (
           CASE
             WHEN ps.id IS NOT NULL THEN ps.is_terminal = false
             ELSE d.stage NOT IN ('closed_won', 'closed_lost')
           END
         )
         AND (
           d.owner_id = $3
           OR d.id IN (
             SELECT deal_id FROM deal_team_members
             WHERE user_id = $3 AND org_id = $1
           )
         )
       ORDER BY
         CASE WHEN d.owner_id = $3 THEN 0 ELSE 1 END,
         d.created_at DESC
       LIMIT 1`,
      [orgId, accountIds, userId]
    );

    if (dealResult.rows.length > 0) {
      dealId = dealResult.rows[0].deal_id;
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
 * Iterates BOTH Outlook and Gmail connected users.
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

  // ── CLM contract actions — nightly sweep ──────────────────────────────────
  // Runs at 02:00 UTC every day. Catches stagnation rules (contracts sitting in
  // a status for N days) and time-based rules (expiry warnings, expired with no
  // renewal) that are never triggered by status-change events.
  cron.schedule('0 2 * * *', () => {
    console.log('🌙 Running nightly CLM action sweep...');
    ContractActionsGenerator.generateAll()
      .then(r => console.log(`✅ CLM sweep done — generated: ${r.generated}, inserted: ${r.inserted}`))
      .catch(err => console.error('❌ CLM sweep error:', err.message));
  }, { timezone: 'UTC' });

  console.log('✅ CLM action scheduler started (nightly 02:00 UTC)');
}

module.exports = {
  triggerSync,
  getSyncStatus,
  syncAllUsers,
  startScheduler,
};
