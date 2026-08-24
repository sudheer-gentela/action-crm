// jobs/notificationScheduler.js
//
// Cron-driven notification scheduler.
// Follows the same pattern as syncScheduler.js (node-cron + Bull).
//
// Schedules:
//   Immediate alert check:     every 2 hours
//   Daily digest:              every day at 9:00 AM UTC
//   Revisit date check:        every day at 8:00 AM UTC

const cron                  = require('node-cron');
const notificationService   = require('../services/notificationService');
const { notificationQueue } = require('./notificationJob');
const db                    = require('../config/database');

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
 * Scan all orgs for prospects and accounts whose revisit_date is today.
 * Enqueues a revisit_prospect job for each matching prospect and
 * a revisit_account job for each matching account.
 *
 * Called every day at 8:00 AM UTC (runs before the digest so reps see
 * revisit alerts in their morning digest if digests are also running).
 */
async function enqueueRevisitAlerts() {
  console.log('[notifications] Running revisit date scan...');

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    let totalQueued = 0;

    // ── Prospects with revisit_date = today ─────────────────────────────────
    const prospectRows = await db.query(
      `SELECT p.id AS prospect_id,
              p.org_id,
              p.owner_id,
              p.first_name,
              p.last_name,
              p.company_name,
              p.revisit_disposition,
              p.stage
       FROM prospects p
       WHERE p.deleted_at IS NULL
         AND p.revisit_date::date = $1
         AND p.stage = 'disqualified'
         AND p.revisit_disposition IN ('long_term', 'unable_to_decide')`,
      [today]
    );

    for (const row of prospectRows.rows) {
      await notificationQueue.add({
        type:       'revisit_prospect',
        orgId:      row.org_id,
        prospectId: row.prospect_id,
        userId:     row.owner_id,
        meta: {
          firstName:            row.first_name,
          lastName:             row.last_name,
          companyName:          row.company_name,
          revisitDisposition:   row.revisit_disposition,
        },
      }, {
        // One alert per prospect per day
        jobId: `revisit-prospect-${row.prospect_id}-${today}`,
      });
      totalQueued++;
    }

    if (prospectRows.rows.length > 0) {
      console.log(`[notifications] Revisit scan: queued ${prospectRows.rows.length} prospect revisit alerts`);
    }

    // ── Accounts with account_revisit_date = today ──────────────────────────
    const accountRows = await db.query(
      `SELECT a.id AS account_id,
              a.org_id,
              a.owner_id,
              a.name AS account_name,
              a.account_disposition
       FROM accounts a
       WHERE a.deleted_at IS NULL
         AND a.account_revisit_date::date = $1
         AND a.account_disposition IN ('long_term_account', 'unable_to_decide_account')`,
      [today]
    );

    for (const row of accountRows.rows) {
      await notificationQueue.add({
        type:      'revisit_account',
        orgId:     row.org_id,
        accountId: row.account_id,
        userId:    row.owner_id,
        meta: {
          accountName:        row.account_name,
          accountDisposition: row.account_disposition,
        },
      }, {
        jobId: `revisit-account-${row.account_id}-${today}`,
      });
      totalQueued++;
    }

    if (accountRows.rows.length > 0) {
      console.log(`[notifications] Revisit scan: queued ${accountRows.rows.length} account revisit alerts`);
    }

    console.log(`[notifications] Revisit scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[notifications] enqueueRevisitAlerts failed:', err.message);
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECTING — three enqueuers mirroring the deal-action ones above.
//
// The daily-digest enqueuer is structurally different: it fires hourly but
// only kicks each org when the current UTC hour matches that org's
// digest_hour_utc policy. This lets India orgs get 8:30 AM IST digests and
// US orgs get 9 AM PT digests without a separate cron schedule per timezone.
// ═════════════════════════════════════════════════════════════════════════════

const ProspectingEscalationService = require('../services/prospectingEscalation.service');

/**
 * Scan all orgs for prospecting actions eligible for an immediate alert.
 * Called every 2 hours alongside the deal-action immediate scan.
 */
async function enqueueProspectingImmediateNotifications() {
  console.log('[notifications] Running prospecting immediate scan...');

  try {
    const orgIds = await notificationService.getActiveOrgIds();
    let totalQueued = 0;

    for (const orgId of orgIds) {
      try {
        const policy = await ProspectingEscalationService.getForOrg(orgId);
        // Agency Phase 6: gate only on the master kill-switch. The scan itself
        // still self-gates the ordinary owner alert on immediate_alert_enabled
        // (branch a); the client-sender-missing fast-path (branch b) must run
        // even when an org has turned routine immediate alerts OFF, so a
        // client-wide sending block still reaches the client lead.
        if (!policy.enabled) continue;

        const overdueActions = await notificationService
          .findProspectingActionsForImmediateNotification(orgId, policy);

        for (const action of overdueActions) {
          await notificationQueue.add({
            type:     'prospecting_immediate',
            orgId,
            actionId: action.action_id,
          }, {
            jobId: `pimm-${orgId}-${action.action_id}`,
          });
          totalQueued++;
        }

        if (overdueActions.length > 0) {
          console.log(`[notifications] Org ${orgId}: queued ${overdueActions.length} prospecting immediate alerts`);
        }
      } catch (err) {
        console.error(`[notifications] Error scanning org ${orgId} for prospecting immediate:`, err.message);
      }
    }

    console.log(`[notifications] Prospecting immediate scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[notifications] enqueueProspectingImmediateNotifications failed:', err.message);
    throw err;
  }
}

/**
 * Scan all orgs for prospecting daily digest — one job per user with overdue
 * actions. Fires HOURLY but only triggers each org when the current UTC hour
 * matches that org's digest_hour_utc policy. This gives per-org timezone
 * flexibility without needing a separate cron schedule per timezone.
 *
 * Called every hour at minute :05 (after the deal-action digest fires at :00
 * if applicable, so the two don't contend for the same Bull queue slot).
 */
async function enqueueProspectingDailyDigests() {
  const currentHourUtc = new Date().getUTCHours();
  console.log(`[notifications] Running prospecting daily digest scan (UTC hour: ${currentHourUtc})...`);

  try {
    const orgIds = await notificationService.getActiveOrgIds();
    let totalQueued = 0;
    let orgsConsidered = 0;
    let orgsFiring = 0;

    for (const orgId of orgIds) {
      try {
        orgsConsidered++;
        const policy = await ProspectingEscalationService.getForOrg(orgId);

        if (!policy.enabled || !policy.daily_digest_enabled) continue;
        if (policy.digest_hour_utc !== currentHourUtc) continue;
        orgsFiring++;

        const overdueRows = await notificationService
          .findProspectingActionsForDailyDigest(orgId, policy);

        const byUser = {};
        for (const row of overdueRows) {
          if (!byUser[row.user_id]) byUser[row.user_id] = [];
          byUser[row.user_id].push(row);
        }

        const today = new Date().toISOString().slice(0, 10);
        for (const [userId, actions] of Object.entries(byUser)) {
          await notificationQueue.add({
            type:           'prospecting_daily_digest',
            orgId,
            userId:         parseInt(userId),
            overdueActions: actions,
          }, {
            jobId: `pdigest-${orgId}-${userId}-${today}`,
          });
          totalQueued++;
        }

        if (Object.keys(byUser).length > 0) {
          console.log(`[notifications] Org ${orgId}: queued ${Object.keys(byUser).length} user prospecting digests`);
        }
      } catch (err) {
        console.error(`[notifications] Error scanning org ${orgId} for prospecting digest:`, err.message);
      }
    }

    console.log(`[notifications] Prospecting digest scan complete. ${orgsFiring}/${orgsConsidered} orgs fired this hour. Total queued: ${totalQueued}`);
    return { totalQueued, orgsFiring, orgsConsidered };

  } catch (err) {
    console.error('[notifications] enqueueProspectingDailyDigests failed:', err.message);
    throw err;
  }
}

/**
 * Scan all orgs for prospecting actions eligible for a tier bump and enqueue
 * one escalation job per action. The processor decides who to notify based
 * on the policy + org hierarchy.
 *
 * Called every 4 hours — tier thresholds are in hours, finer cadence has no
 * value and only burns Redis/Postgres.
 */
async function enqueueProspectingEscalations() {
  console.log('[notifications] Running prospecting escalation scan...');

  try {
    const orgIds = await notificationService.getActiveOrgIds();
    let totalQueued = 0;

    for (const orgId of orgIds) {
      try {
        const policy = await ProspectingEscalationService.getForOrg(orgId);
        if (!policy.enabled) continue;

        const eligible = await notificationService
          .findProspectingActionsForEscalation(orgId, policy);

        for (const row of eligible) {
          await notificationQueue.add({
            type:       'prospecting_escalation',
            orgId,
            actionId:   row.action_id,
            targetTier: row.target_tier,
          }, {
            // jobId includes target_tier so re-running the scan can't
            // collide with the previous tier's job. A single action moving
            // from tier 1 → 2 → 3 over time will have three distinct jobs.
            jobId: `pesc-${orgId}-${row.action_id}-t${row.target_tier}`,
          });
          totalQueued++;
        }

        if (eligible.length > 0) {
          console.log(`[notifications] Org ${orgId}: queued ${eligible.length} prospecting escalations`);
        }
      } catch (err) {
        console.error(`[notifications] Error scanning org ${orgId} for prospecting escalation:`, err.message);
      }
    }

    console.log(`[notifications] Prospecting escalation scan complete. Total queued: ${totalQueued}`);
    return { totalQueued };

  } catch (err) {
    console.error('[notifications] enqueueProspectingEscalations failed:', err.message);
    throw err;
  }
}

/**
 * Sweep users who have review alerts waiting in digest mode (2026_130).
 *
 * Finds the distinct (org, user) pairs with stamped-but-undigested review
 * notifications and enqueues one digest job each. Doing the grouping here in
 * one query — rather than iterating orgs and then users — keeps this O(1)
 * queries regardless of how many orgs run the review loop.
 *
 * Runs hourly. A user in digest mode therefore waits at most an hour, which is
 * the trade they opted into by choosing digest over immediate.
 */
async function enqueueReviewDigests() {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT org_id, user_id
         FROM notifications
        WHERE type LIKE 'play_review_%'
          AND metadata->>'email_deferred' = 'true'
          AND metadata->>'email_digested' IS NULL
          -- Bound the scan. Anything older than a week is stale enough that
          -- mailing it would confuse rather than help, and it stays readable
          -- in-app either way.
          AND created_at > now() - interval '7 days'`);

    for (const r of rows) {
      await notificationQueue.add(
        { type: 'review_email_digest', orgId: r.org_id, userId: r.user_id },
        // One job per user per hour. The jobId collapses duplicates if a sweep
        // overlaps the previous one.
        { jobId: `review-digest-${r.org_id}-${r.user_id}-${new Date().toISOString().slice(0, 13)}` }
      ).catch(() => {});
    }
    if (rows.length) {
      console.log(`[notifications] enqueued ${rows.length} review digest(s)`);
    }
    return { enqueued: rows.length };
  } catch (err) {
    console.error('[notifications] enqueueReviewDigests failed:', err.message);
    return { enqueued: 0 };
  }
}

/**
 * Start the notification cron schedules.
 * Called from worker.js on startup.
 */
function startScheduler() {
  // ── Deal-action path (unchanged) ────────────────────────────────────────
  // Immediate alert check: every 2 hours
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

  // Revisit date check: 8:00 AM UTC every day (runs before digest)
  cron.schedule('0 8 * * *', () => {
    enqueueRevisitAlerts().catch(err =>
      console.error('[notifications] Revisit cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  // ── Prospecting path (new) ──────────────────────────────────────────────
  // Immediate alerts: every 2 hours, offset by 30 minutes from the
  // deal-action immediate scan to keep the Bull queue from spiking.
  cron.schedule('30 */2 * * *', () => {
    enqueueProspectingImmediateNotifications().catch(err =>
      console.error('[notifications] Prospecting immediate cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  // Daily digest: every hour at :05. Each org self-filters by comparing
  // its digest_hour_utc to the current UTC hour. The :05 offset keeps it
  // off the same minute as the deal-action digest at 9:00 UTC.
  cron.schedule('5 * * * *', () => {
    enqueueProspectingDailyDigests().catch(err =>
      console.error('[notifications] Prospecting digest cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  // Escalation tiers: every 4 hours at :15
  cron.schedule('15 */4 * * *', () => {
    enqueueProspectingEscalations().catch(err =>
      console.error('[notifications] Prospecting escalation cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  // Review digests: hourly at :45, clear of every other sweep above.
  cron.schedule('45 * * * *', () => {
    enqueueReviewDigests().catch(err =>
      console.error('[notifications] Review digest cron error:', err.message)
    );
  }, { timezone: 'UTC' });

  console.log('✅ Notification scheduler started (deal: immediate 2h, digest 09:00 UTC, revisit 08:00 UTC | prospecting: immediate 2h+30m, digest hourly+org-filtered, escalation 4h+15m | review digest hourly+45m)');
}

module.exports = {
  startScheduler,
  enqueueImmediateNotifications,
  enqueueDailyDigests,
  enqueueRevisitAlerts,
  enqueueProspectingImmediateNotifications,
  enqueueProspectingDailyDigests,
  enqueueProspectingEscalations,
  enqueueReviewDigests,
};
