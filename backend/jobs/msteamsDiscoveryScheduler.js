// ─────────────────────────────────────────────────────────────────────────────
// jobs/msteamsDiscoveryScheduler.js
//
// DROP-IN LOCATION: backend/jobs/msteamsDiscoveryScheduler.js
//
// Refreshes each connected rep's list of Teams chats and channels.
//
// WIRE INTO jobs/worker.js beside the other schedulers:
//     const msteamsDiscovery = require('./msteamsDiscoveryScheduler');
//     msteamsDiscovery.startScheduler();
//
// WHY A POLL AND NOT A SUBSCRIPTION
//   Nothing in Graph tells us a rep joined a channel. The notification that
//   would — tenant-wide membership change — needs application permissions and
//   Microsoft's protected-API approval, which is the entire thing the delegated
//   design exists to avoid. So the list is refreshed on a schedule, and
//   last_discovery_at is published to the UI: a triage screen that is silently
//   three weeks stale is worse than one that admits it.
//
// WHY HOURLY
//   Chat membership is not fast-moving, and every pass costs one call per rep
//   plus one per team they belong to. Hourly keeps a rep who was added this
//   morning from waiting until tomorrow, while staying far inside Graph's
//   per-app-per-tenant throttling for any plausible number of reps. The manual
//   POST /api/msteams/discover covers the impatient case.
//
// NO Bull QUEUE
//   syncScheduler and notificationScheduler enqueue because their work fans out
//   per record and needs retries. Discovery is one bounded call chain per
//   connection that is idempotent and will simply run again in an hour, so a
//   queue would add a moving part for no benefit.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const cron    = require('node-cron');
const msteams = require('../services/msteams.service');

// How stale a connection must be before it is picked up. Slightly under the
// hourly cadence so a pass that starts a few seconds late does not skip
// everybody until the next hour.
const STALE_MINUTES = 55;

// Per pass, not per hour. A cap so one org with hundreds of connected reps
// cannot monopolise the worker; the remainder are simply first in line next
// time, because the query orders by last_discovery_at NULLS FIRST.
const BATCH_LIMIT = 100;

let running = false;

/**
 * One discovery pass.
 *
 * Sequential rather than parallel, deliberately. Graph throttles per app AND
 * per tenant, and firing a hundred concurrent paged walks is the reliable way
 * to earn a 429 that then affects every rep at once. Sequential is slower and
 * finishes; parallel is faster until it does not.
 *
 * A single rep failing must never abort the pass — the most common failure is
 * one person's consent lapsing, and that is precisely when everybody else's
 * list needs to keep updating.
 */
async function runDiscoveryPass() {
  if (running) {
    console.log('[msteams] discovery still running, skipping this tick');
    return;
  }
  running = true;

  try {
    const connections = await msteams.connectionsDueForDiscovery(STALE_MINUTES, BATCH_LIMIT);
    if (!connections.length) return;

    console.log(`[msteams] discovery pass: ${connections.length} connection(s)`);

    let ok = 0;
    let failed = 0;

    for (const conn of connections) {
      try {
        const result = await msteams.discoverForConnection(conn);
        if (result.ok) {
          ok += 1;
          if (result.warnings?.length) {
            console.warn(
              `[msteams] connection ${conn.id} partial: ${result.warnings.join('; ')}`
            );
          }
        } else {
          failed += 1;
          // Not an error log. discoverForConnection has already written the
          // reason to msteams_connections.status where the rep can see it, and
          // a lapsed consent is an expected state, not an incident.
          console.log(`[msteams] connection ${conn.id} skipped: ${result.code}`);
        }
      } catch (err) {
        failed += 1;
        console.error(`[msteams] connection ${conn.id} threw: ${err.message}`);
      }
    }

    console.log(`[msteams] discovery pass done — ${ok} ok, ${failed} skipped/failed`);
  } catch (err) {
    console.error('[msteams] discovery pass failed:', err.message);
  } finally {
    running = false;
  }
}

function startScheduler() {
  // Seventeen past the hour rather than zero: the top of the hour already has
  // the email sync and the notification sweep on it, and three jobs waking
  // together on one Railway worker is a self-inflicted latency spike.
  cron.schedule('17 * * * *', runDiscoveryPass);

  console.log('[msteams] discovery scheduler started (hourly, :17)');
}

module.exports = { startScheduler, runDiscoveryPass };
