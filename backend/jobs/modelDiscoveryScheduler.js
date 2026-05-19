/**
 * jobs/modelDiscoveryScheduler.js
 *
 * Schedules the recurring model-discovery run. A single daily cron tick
 * checks the SuperAdmin config and decides whether to actually run:
 *
 *   cron_enabled = false        → never runs (cron-only refresh disabled)
 *   cron_frequency = 'daily'    → runs every day
 *   cron_frequency = 'weekly'   → runs only on Mondays
 *
 * Using one daily tick + an in-job check (rather than re-registering cron
 * expressions when the setting changes) keeps this simple and means a
 * config change takes effect on the next tick with no restart.
 *
 * Wire into server.js boot block:
 *   require('./jobs/modelDiscoveryScheduler').startScheduler();
 */

const cron = require('node-cron');
const ModelDiscoveryService = require('../services/ai/ModelDiscoveryService');

const WEEKLY_RUN_DOW = 1;  // Monday (0=Sun..6=Sat)

async function tick() {
  try {
    const config = await ModelDiscoveryService.getConfig();

    if (!config.cron_enabled) {
      return;  // scheduled discovery disabled by SuperAdmin
    }

    if (config.cron_frequency === 'weekly') {
      const dow = new Date().getUTCDay();
      if (dow !== WEEKLY_RUN_DOW) return;  // not the weekly run day
    }
    // 'daily' (or anything else) → run every tick

    const state = await ModelDiscoveryService.runDiscovery('cron');
    const counts = Object.entries(state.providers || {})
      .filter(([, v]) => v.ok)
      .map(([k, v]) => `${k}:${v.count}`)
      .join(' ');
    console.log(`🔎 Model discovery (${config.cron_frequency}) ran — ${state.last_run_status} — ${counts}`);
  } catch (err) {
    console.error('🔎 Model discovery cron error:', err.message);
  }
}

function startScheduler() {
  // Daily tick at 03:30 UTC — quiet hours, after other nightly jobs.
  cron.schedule('30 3 * * *', () => { tick(); }, { timezone: 'UTC' });
  console.log('✅ Model discovery scheduler started (daily tick 03:30 UTC; honors cron_enabled + cron_frequency)');
}

module.exports = { startScheduler, tick };
