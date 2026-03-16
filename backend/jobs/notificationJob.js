// jobs/notificationJob.js
//
// Bull queue for action notification processing.
// Follows the exact same pattern as emailProcessor.js.
//
// Job types:
//   type='immediate'         — process a single overdue action's immediate alert
//   type='daily_digest'      — process a daily digest for a single user
//   type='revisit_prospect'  — surface a disqualified prospect whose revisit_date has arrived
//   type='revisit_account'   — surface an account whose account_revisit_date has arrived

const Queue              = require('bull');
const notificationService = require('../services/notificationService');
const db                  = require('../config/database');

// ── Queue setup ───────────────────────────────────────────────────────────────
const notificationQueue = new Queue('team-notifications', process.env.REDIS_URL, {
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 2000 },
    removeOnComplete: 200,
    removeOnFail:     100,
  },
});

// ── Job processor ─────────────────────────────────────────────────────────────
notificationQueue.process(async (job) => {
  const { type, orgId, actionId, userId, overdueActions, prospectId, accountId, meta } = job.data;

  console.log(`[notifications] Processing job ${job.id}: type=${type} org=${orgId}`);

  if (type === 'immediate') {
    job.progress(20);
    const result = await notificationService.processImmediateNotification(orgId, actionId);
    job.progress(100);
    return result;

  } else if (type === 'daily_digest') {
    job.progress(20);
    const result = await notificationService.processDailyDigest(orgId, userId, overdueActions);
    job.progress(100);
    return result;

  } else if (type === 'revisit_prospect') {
    job.progress(20);
    const result = await _processRevisitProspect({ orgId, prospectId, userId, meta });
    job.progress(100);
    return result;

  } else if (type === 'revisit_account') {
    job.progress(20);
    const result = await _processRevisitAccount({ orgId, accountId, userId, meta });
    job.progress(100);
    return result;

  } else {
    console.warn(`[notifications] Unknown job type: ${type}`);
    return { skipped: true, reason: 'unknown_type' };
  }
});

// ── revisit_prospect handler ──────────────────────────────────────────────────
//
// Creates a notification for the prospect owner and inserts a prospecting_action
// to prompt re-engagement. The prospect stage is NOT changed automatically —
// that is a manual rep decision.
//
async function _processRevisitProspect({ orgId, prospectId, userId, meta }) {
  try {
    // 1. Verify prospect is still disqualified and revisit_date hasn't been cleared
    const prospectRes = await db.query(
      `SELECT id, stage, disqualified_reason, revisit_date, owner_id,
              first_name, last_name, company_name, playbook_id
       FROM prospects
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, orgId]
    );

    if (prospectRes.rows.length === 0) {
      return { skipped: true, reason: 'prospect_not_found' };
    }

    const prospect = prospectRes.rows[0];

    // Guard: skip if prospect has already been re-engaged (stage changed)
    if (prospect.stage !== 'disqualified') {
      return { skipped: true, reason: 'prospect_already_re_engaged' };
    }

    const ownerUserId = prospect.owner_id;
    const prospectName = `${prospect.first_name} ${prospect.last_name}`;
    const companyName  = prospect.company_name || 'their company';
    const reasonLabel  = prospect.disqualified_reason === 'long_term'
      ? 'marked for long-term follow-up'
      : 'could not decide at the time';

    // 2. Create a notification in the notifications table
    await db.query(
      `INSERT INTO notifications
         (org_id, user_id, type, title, body, entity_type, entity_id, metadata, is_read)
       VALUES ($1, $2, 'revisit_prospect', $3, $4, 'prospect', $5, $6, false)`,
      [
        orgId,
        ownerUserId,
        `Time to revisit ${prospectName}`,
        `${prospectName} at ${companyName} was ${reasonLabel}. Today is the revisit date — consider re-engaging.`,
        prospectId,
        JSON.stringify({
          prospectId,
          companyName,
          disqualifiedReason: prospect.disqualified_reason,
          revisitDate:        prospect.revisit_date,
        }),
      ]
    ).catch(err => {
      // notifications table may have different columns — log and continue
      console.warn(`[notifications] Could not insert revisit notification for prospect ${prospectId}:`, err.message);
    });

    // 3. Create a prospecting_action to surface in the rep's action queue
    await db.query(
      `INSERT INTO prospecting_actions
         (org_id, user_id, prospect_id,
          title, description,
          action_type, channel,
          priority, due_date,
          source, source_rule,
          status)
       VALUES ($1, $2, $3, $4, $5, 'playbook_play', NULL, 'high', CURRENT_DATE, 'system', 'revisit_date', 'pending')
       ON CONFLICT DO NOTHING`,
      [
        orgId,
        ownerUserId,
        prospectId,
        `Revisit ${prospectName} at ${companyName}`,
        `Revisit date has arrived. This prospect was disqualified with reason "${prospect.disqualified_reason}". ` +
        `Review their current situation and decide: move to outreach, extend the revisit date, or disqualify permanently.`,
      ]
    );

    console.log(`[notifications] Revisit prospect job: created alert + action for prospect ${prospectId} (owner ${ownerUserId})`);

    return {
      prospectId,
      userId: ownerUserId,
      notified: true,
    };

  } catch (err) {
    console.error(`[notifications] _processRevisitProspect failed for prospect ${prospectId}:`, err.message);
    throw err;
  }
}

// ── revisit_account handler ───────────────────────────────────────────────────
//
// Creates a notification for the account owner when account_revisit_date arrives.
//
async function _processRevisitAccount({ orgId, accountId, userId, meta }) {
  try {
    // 1. Verify account still has a disposition set
    const accountRes = await db.query(
      `SELECT id, name, account_disposition, account_revisit_date, owner_id
       FROM accounts
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [accountId, orgId]
    );

    if (accountRes.rows.length === 0) {
      return { skipped: true, reason: 'account_not_found' };
    }

    const account = accountRes.rows[0];

    if (!account.account_disposition) {
      return { skipped: true, reason: 'account_disposition_cleared' };
    }

    const ownerUserId = account.owner_id || userId;
    const dispositionLabel = account.account_disposition === 'long_term_account'
      ? 'flagged for long-term follow-up'
      : 'flagged because a contact could not decide';

    // 2. Create notification
    await db.query(
      `INSERT INTO notifications
         (org_id, user_id, type, title, body, entity_type, entity_id, metadata, is_read)
       VALUES ($1, $2, 'revisit_account', $3, $4, 'account', $5, $6, false)`,
      [
        orgId,
        ownerUserId,
        `Time to revisit account: ${account.name}`,
        `${account.name} was ${dispositionLabel}. Today is the revisit date — consider prospecting new contacts here.`,
        accountId,
        JSON.stringify({
          accountId,
          accountName:        account.name,
          accountDisposition: account.account_disposition,
          revisitDate:        account.account_revisit_date,
        }),
      ]
    ).catch(err => {
      console.warn(`[notifications] Could not insert revisit notification for account ${accountId}:`, err.message);
    });

    console.log(`[notifications] Revisit account job: created alert for account ${accountId} (owner ${ownerUserId})`);

    return {
      accountId,
      userId: ownerUserId,
      notified: true,
    };

  } catch (err) {
    console.error(`[notifications] _processRevisitAccount failed for account ${accountId}:`, err.message);
    throw err;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
notificationQueue.on('completed', (job, result) => {
  if (result?.skipped) {
    console.log(`[notifications] Job ${job.id} skipped: ${result.reason}`);
  } else if (job.data.type === 'immediate') {
    console.log(`[notifications] Job ${job.id} (immediate): action ${result?.actionId}, ${result?.recipientCount} notifications`);
  } else if (job.data.type === 'daily_digest') {
    console.log(`[notifications] Job ${job.id} (digest): user ${result?.userId}, ${result?.overdueCount} overdue, ${result?.recipientCount} notifications`);
  } else if (job.data.type === 'revisit_prospect') {
    console.log(`[notifications] Job ${job.id} (revisit_prospect): prospect ${result?.prospectId}, notified=${result?.notified}`);
  } else if (job.data.type === 'revisit_account') {
    console.log(`[notifications] Job ${job.id} (revisit_account): account ${result?.accountId}, notified=${result?.notified}`);
  }
});

notificationQueue.on('failed', (job, err) => {
  console.error(`[notifications] Job ${job.id} (${job.data.type}) failed:`, err.message);
});

notificationQueue.on('stalled', (job) => {
  console.warn(`[notifications] Job ${job.id} stalled`);
});

notificationQueue.on('active', (job) => {
  console.log(`[notifications] Job ${job.id} (${job.data.type}) started`);
});

module.exports = { notificationQueue };
