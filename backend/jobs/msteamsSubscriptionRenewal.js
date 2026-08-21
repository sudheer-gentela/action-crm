// ─────────────────────────────────────────────────────────────────────────────
// jobs/msteamsSubscriptionRenewal.js
//
// DROP-IN LOCATION: backend/jobs/msteamsSubscriptionRenewal.js
//
// WIRE INTO jobs/worker.js beside the discovery scheduler:
//     require('./msteamsSubscriptionRenewal').startScheduler();
//
// WHY THIS JOB IS NOT OPTIONAL
//   Teams chatMessage subscriptions expire in an hour. If this stops running,
//   every watched conversation goes silent within sixty minutes — and it goes
//   silent QUIETLY. Graph does not backfill a lapsed subscription, so messages
//   sent in the gap are gone with no error anywhere. Of everything in the Teams
//   integration, this is the piece whose failure is least visible and most
//   expensive.
//
// EVERY FIFTEEN MINUTES
//   Against a 55-minute lifetime and a 25-minute renewal window, that gives
//   three chances to renew before anything lapses. A deploy, a restart, or one
//   throttled sweep costs nothing. Hourly would leave no margin at all.
//
// SEQUENTIAL, NOT PARALLEL
//   Same reasoning as discovery: Graph throttles per app AND per tenant, and
//   firing a hundred concurrent renewals is the reliable way to earn a 429 that
//   then affects every conversation at once. Renewals are cheap; the sweep has
//   time.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cron = require('node-cron');
const { pool } = require('../config/database');
const subs = require('../services/msteamsSubscriptions.service');
const msteams = require('../services/msteams.service');

let running = false;

async function runRenewalSweep() {
  if (running) {
    console.log('[msteams] renewal sweep still running, skipping this tick');
    return;
  }
  running = true;

  try {
    // ── Renew what is close to expiring ──────────────────────────────────
    const due = await subs.dueForRenewal();
    let renewed = 0, failedOver = 0, failed = 0;

    for (const sub of due) {
      try {
        // Mark it in-window first, so a sweep that dies halfway leaves visible
        // state rather than rows that still claim to be healthy.
        await pool.query(
          `UPDATE msteams_subscriptions SET status = 'expiring', updated_at = now()
            WHERE id = $1 AND status = 'active'`, [sub.id]);

        const r = await subs.renew(sub);
        if (r.ok && r.failedOver) failedOver += 1;
        else if (r.ok) renewed += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        console.error(`[msteams] renewal threw for ${sub.subscription_id}: ${err.message}`);
      }
    }

    // ── Recreate what Graph dropped ──────────────────────────────────────
    // A subscription Graph has removed cannot be renewed, only rebuilt. These
    // are watched conversations whose subscription is gone, which means they
    // are silently not capturing until this runs.
    const gone = await subs.dueForRecreate();
    let recreated = 0;

    for (const row of gone) {
      try {
        const { rows: [conv] } = await pool.query(
          `SELECT * FROM msteams_conversations WHERE id = $1`, [row.conversation_id]);
        if (!conv || !conv.is_watched) continue;

        const conn = await msteams.getConnectionById(conv.connection_id);
        if (!conn || conn.status !== 'connected' || !conn.capture_enabled) continue;

        const created = await subs.subscribe(conv, conn);
        if (created.ok && !created.already) {
          recreated += 1;
          // The old row stays as 'expired' for audit. It is a record that
          // capture had a gap, which somebody may need to explain later.
          console.warn(
            `[msteams] recreated subscription for ${conv.graph_id} — ` +
            `messages between ${row.expires_at?.toISOString?.() || row.expires_at} and now were not captured`);
        }
      } catch (err) {
        console.error(`[msteams] recreate threw for conversation ${row.conversation_id}: ${err.message}`);
      }
    }

    if (due.length || gone.length) {
      console.log(
        `[msteams] renewal sweep — ${renewed} renewed, ${failedOver} failed over, ` +
        `${failed} failed, ${recreated} recreated`);
    }
  } catch (err) {
    console.error('[msteams] renewal sweep failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduler() {
  // Offset from :00 and from discovery's :17, so three jobs do not wake
  // together on one Railway worker.
  cron.schedule('4,19,34,49 * * * *', runRenewalSweep);
  console.log('[msteams] subscription renewal scheduler started (every 15m)');
}

module.exports = { startScheduler, runRenewalSweep };
