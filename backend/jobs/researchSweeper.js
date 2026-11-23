/**
 * jobs/researchSweeper.js
 *
 * Phase 1, step 1.1b — runs background research on flagged prospects.
 * All the rules (who gets claimed, fairness, budget / kill-switch pauses,
 * retries, notifications) live in services/research/ResearchPipelineService;
 * this file is only the clock.
 *
 * Wiring (server.js cron block, inside `if (backgroundEnabled)` so
 * DISABLE_CRON=true keeps a dev box from spending AI on production data):
 *     require('./jobs/researchSweeper').startScheduler();
 *
 * Call startScheduler() exactly once at boot. A second web replica is safe —
 * rows are claimed with FOR UPDATE SKIP LOCKED — it just does half the work
 * each.
 *
 * Env:
 *   RESEARCH_SWEEP_CRON   default '* * * * *' (every minute)
 *   RESEARCH_SWEEP_BATCH  default 5 prospects per run
 */

const cron = require('node-cron');
const ResearchPipeline = require('../services/research/ResearchPipelineService');

const SCHEDULE = process.env.RESEARCH_SWEEP_CRON || '* * * * *';
const BATCH    = Math.min(Math.max(parseInt(process.env.RESEARCH_SWEEP_BATCH || '5', 10) || 5, 1), 25);

// A run can outlast a minute when a provider is slow; never overlap runs in
// one process (another process is fine — the claim lock handles that).
let running = false;

async function runSweep() {
  if (running) return null;
  running = true;
  try {
    const t = await ResearchPipeline.runSweep({ limit: BATCH });
    if (t.claimed || t.recovered || t.dropped) {
      console.log(
        `🔎 Research sweep: ${t.claimed} claimed → ${t.ready} ready, ${t.paused} paused, ` +
        `${t.retry} retry, ${t.failed} failed, ${t.gone} gone` +
        (t.recovered ? `, ${t.recovered} recovered` : '') +
        (t.dropped ? `, ${t.dropped} no longer needed` : '') +
        (t.notified ? `, ${t.notified} notified` : '')
      );
    }
    return t;
  } catch (err) {
    console.error('🔎 Research sweep error:', err.message);
    return null;
  } finally {
    running = false;
  }
}

function startScheduler() {
  cron.schedule(SCHEDULE, runSweep);
  console.log(`🔎 Research sweeper started (cron: ${SCHEDULE}, batch: ${BATCH})`);
}

module.exports = { startScheduler, runSweep };
