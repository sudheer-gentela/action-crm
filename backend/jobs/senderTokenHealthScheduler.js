/**
 * senderTokenHealthScheduler.js
 *
 * DROP-IN LOCATION: backend/jobs/senderTokenHealthScheduler.js  (NEW FILE)
 *
 * Daily sweep that proactively verifies every active prospecting sender's
 * OAuth credential, refreshes the healthy ones, and deactivates + notifies on
 * any that have been revoked — so a dead token surfaces as a notification the
 * morning it breaks, instead of being discovered only when a batch of
 * enrollments pauses mid-campaign.
 *
 * Wiring (one line, see server.js cron block):
 *     require('./jobs/senderTokenHealthScheduler').startScheduler();
 *
 * Safe to start more than once is NOT guaranteed (node-cron would double-
 * schedule); call startScheduler() exactly once at boot, like the other jobs.
 */

const cron = require('node-cron');
const SenderTokenHealth = require('../services/SenderTokenHealth');
const { pool } = require('../config/database');

// Default: every day at 06:00 UTC (before most send windows open). Override with
// SENDER_TOKEN_HEALTH_CRON if you want a different cadence.
const SCHEDULE = process.env.SENDER_TOKEN_HEALTH_CRON || '0 6 * * *';

async function runSweep() {
  try {
    const res = await SenderTokenHealth.sweepActiveSenders(pool);
    if (res.revoked > 0 || res.transient > 0) {
      console.log(
        `🔐 Sender token sweep: ${res.checked} checked, ${res.healthy} healthy, ` +
        `${res.revoked} revoked, ${res.transient} transient`
      );
    } else {
      console.log(`🔐 Sender token sweep: all ${res.checked} sender(s) healthy`);
    }
    return res;
  } catch (err) {
    console.error('🔐 Sender token sweep error:', err.message);
    return null;
  }
}

function startScheduler() {
  cron.schedule(SCHEDULE, runSweep);
  console.log(`🔐 Sender token-health scheduler started (cron: ${SCHEDULE})`);
}

module.exports = { startScheduler, runSweep };
