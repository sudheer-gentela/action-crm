// jobs/escalationScheduler.js
//
// Cron-driven escalation scheduler.
// Follows the same pattern as syncScheduler.js (node-cron + Bull).
//
// Schedules:
//   Immediate alert check: every 30 minutes
//   Daily digest:          every day at 9:00 AM UTC

const cron               = require('node-cron');
const escalationService  = require('../services/escalationService');
const { escalationQueue } = require('./escalationJob');

/**
 * Scan all orgs for actions eligible for an immediate escalation alert
 * and enqueue a Bull job for each one.
 *
 * Called every 30 minutes.
 */
async function enqueueImmediateEscalations() {
  console.log('[escalation] Running immediate escalation scan...');

  try {
    const orgIds = await escalationService.getActiveOrgIds();
    let totalQueued = 0;

    for (const orgId of orgIds) {
      try {
        const overdueActions = await escalationService.findActionsForImmediateEscalation(orgId);

        for (const action of overdueActions) {
          await escalationQueue.add({
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
          console.log(`[escalation] Org ${orgId}: queued ${overdueActions.length} immediate alerts`);
        }
      } catch (err) {
        console.error(`[escalation] Error scanning org ${orgId} for immediate escalations:`, err.message);
      }
    }

    console.log(`[escalation] Immediate scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[escalation] enqueueImmediateEscalations failed:', err.message);
    throw err;
  }
}

/**
 * Scan all orgs for daily digest — one job per user that has overdue actions.
 *
 * Called every day at 9:00 AM UTC.
 */
async function enqueueDailyDigests() {
  console.log('[escalation] Running daily digest scan...');

  try {
    const orgIds = await escalationService.getActiveOrgIds();
    let totalQueued = 0;

    for (const orgId of orgIds) {
      try {
        const overdueRows = await escalationService.findActionsForDailyDigest(orgId);

        // Group by user_id
        const byUser = {};
        for (const row of overdueRows) {
          if (!byUser[row.user_id]) byUser[row.user_id] = [];
          byUser[row.user_id].push(row);
        }

        for (const [userId, actions] of Object.entries(byUser)) {
          await escalationQueue.add({
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
          console.log(`[escalation] Org ${orgId}: queued ${Object.keys(byUser).length} user digests`);
        }
      } catch (err) {
        console.error(`[escalation] Error scanning org ${orgId} for daily digests:`, err.message);
      }
    }

    console.log(`[escalation] Daily digest scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[escalation] enqueueDailyDigests failed:', err.message);
    throw err;
  }
}

/**
 * Start the escalation cron schedules.
 * Called from worker.js on startup.
 */
function startScheduler() {
  // Immediate alert check: every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    enqueueImmediateEscalations().catch(err =>
      console.error('[escalation] Immediate cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  // Daily digest: 9:00 AM UTC every day
  cron.schedule('0 9 * * *', () => {
    enqueueDailyDigests().catch(err =>
      console.error('[escalation] Daily digest cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  console.log('✅ Escalation scheduler started (immediate: every 30m | digest: daily 09:00 UTC)');
}

module.exports = {
  startScheduler,
  enqueueImmediateEscalations,
  enqueueDailyDigests,
};
