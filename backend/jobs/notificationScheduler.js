// jobs/notificationScheduler.js
//
// Cron-driven notification scheduler.
// Follows the same pattern as syncScheduler.js (node-cron + Bull).
//
// Schedules:
//   Immediate alert check: every 2 hours
//   Daily digest:          every day at 9:00 AM UTC

const cron               = require('node-cron');
const notificationService  = require('../services/notificationService');
const { notificationQueue } = require('./notificationJob');

/**
 * Scan all orgs for actions eligible for an immediate notification alert
 * and enqueue a Bull job for each one.
 *
 * Called every 2 hours.
 */
async function enqueueImmediateNotifications() {
  console.log('[notifications] Running immediate notification scan...');

  try {
    const orgIds = await notificationService.getActiveOrgIds();
    let totalQueued = 0;

    for (const orgId of orgIds) {
      try {
        const overdueActions = await notificationService.findActionsForImmediateNotification(orgId);

        for (const action of overdueActions) {
          await notificationQueue.add({
            type:     'immediate',
            orgId,
            actionId: action.action_id,
          }, {
            // Deduplicate: don't re-enqueue if already waiting for this action
            jobId: `imm-${orgId}-${action.action_id}`,
          });
          totalQueued++;
        }

        if (overdueActions.length > 0) {
          console.log(`[notifications] Org ${orgId}: queued ${overdueActions.length} immediate alerts`);
        }
      } catch (err) {
        console.error(`[notifications] Error scanning org ${orgId} for immediate notifications:`, err.message);
      }
    }

    console.log(`[notifications] Immediate scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[notifications] enqueueImmediateNotifications failed:', err.message);
    throw err;
  }
}

/**
 * Scan all orgs for daily digest — one job per user that has overdue actions.
 *
 * Called every day at 9:00 AM UTC.
 */
async function enqueueDailyDigests() {
  console.log('[notifications] Running daily digest scan...');

  try {
    const orgIds = await notificationService.getActiveOrgIds();
    let totalQueued = 0;

    for (const orgId of orgIds) {
      try {
        const overdueRows = await notificationService.findActionsForDailyDigest(orgId);

        // Group by user_id
        const byUser = {};
        for (const row of overdueRows) {
          if (!byUser[row.user_id]) byUser[row.user_id] = [];
          byUser[row.user_id].push(row);
        }

        for (const [userId, actions] of Object.entries(byUser)) {
          await notificationQueue.add({
            type:           'daily_digest',
            orgId,
            userId:         parseInt(userId),
            overdueActions: actions,
          }, {
            // One digest per user per day — use a date-scoped job ID
            jobId: `digest-${orgId}-${userId}-${new Date().toISOString().slice(0, 10)}`,
          });
          totalQueued++;
        }

        if (Object.keys(byUser).length > 0) {
          console.log(`[notifications] Org ${orgId}: queued ${Object.keys(byUser).length} user digests`);
        }
      } catch (err) {
        console.error(`[notifications] Error scanning org ${orgId} for daily digests:`, err.message);
      }
    }

    console.log(`[notifications] Daily digest scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[notifications] enqueueDailyDigests failed:', err.message);
    throw err;
  }
}

/**
 * Start the notification cron schedules.
 * Called from worker.js on startup.
 */
function startScheduler() {
  // Immediate alert check: every 2 hours (configurable — change cron expression to adjust)
  cron.schedule('0 */2 * * *', () => {
    enqueueImmediateNotifications().catch(err =>
      console.error('[notifications] Immediate cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  // Daily digest: 9:00 AM UTC every day
  cron.schedule('0 9 * * *', () => {
    enqueueDailyDigests().catch(err =>
      console.error('[notifications] Daily digest cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  console.log('✅ Notification scheduler started (immediate: every 2h | digest: daily 09:00 UTC)');
}

module.exports = {
  startScheduler,
  enqueueImmediateNotifications,
  enqueueDailyDigests,
};
