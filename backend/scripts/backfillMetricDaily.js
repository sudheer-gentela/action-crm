/**
 * backfillMetricDaily.js
 *
 * One-time (re-runnable) backfill of `prospecting_metric_daily` from the
 * earliest observable event per org through today. Phase 1 of the Outbound
 * Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Usage (from backend/):
 *   node scripts/backfillMetricDaily.js                 # all orgs with prospecting data
 *   node scripts/backfillMetricDaily.js 111             # one org
 *   node scripts/backfillMetricDaily.js 111 2026-01-01  # one org, explicit start date
 *   node scripts/backfillMetricDaily.js --verify 111    # reconcile snapshot vs live (30d)
 *
 * Safe to re-run: the writer is DELETE+INSERT per date range. Run --verify
 * after backfill — `match: true` on sent/replied/failed/enrolled against the
 * live team-overview-style aggregates is the Phase 1 acceptance test.
 */

const db = require('../config/database');
const MetricSnapshotService = require('../services/MetricSnapshotService');

async function orgsWithProspectingData() {
  const r = await db.query(
    `SELECT DISTINCT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND EXISTS (SELECT 1 FROM prospects p WHERE p.org_id = o.id)
      ORDER BY o.id ASC`
  );
  return r.rows.map((x) => x.id);
}

async function main() {
  const args = process.argv.slice(2);
  const verifyMode = args.includes('--verify');
  const positional = args.filter((a) => !a.startsWith('--'));
  const orgArg = positional[0] ? parseInt(positional[0], 10) : null;
  const fromDate = positional[1] || null;

  if (positional[0] && isNaN(orgArg)) {
    console.error(`Invalid org id: ${positional[0]}`);
    process.exit(1);
  }

  const orgIds = orgArg ? [orgArg] : await orgsWithProspectingData();
  console.log(`[backfillMetricDaily] ${verifyMode ? 'VERIFY' : 'BACKFILL'} — orgs: ${orgIds.join(', ') || '(none)'}`);

  let failures = 0;

  for (const orgId of orgIds) {
    try {
      if (verifyMode) {
        const v = await MetricSnapshotService.verify(orgId, 30);
        const flag = v.match ? '✅ MATCH' : '❌ MISMATCH';
        console.log(`[backfillMetricDaily] org=${orgId} ${flag} window=${v.window}`);
        console.log(`  snapshot: ${JSON.stringify(v.snapshot)}`);
        console.log(`  live:     ${JSON.stringify(v.live)}`);
        if (!v.match) failures++;
      } else {
        const res = await MetricSnapshotService.backfill(orgId, fromDate);
        console.log(`[backfillMetricDaily] org=${orgId} done — ${res.rows} rows, ${res.start}..${res.end}`);
      }
    } catch (err) {
      failures++;
      console.error(`[backfillMetricDaily] org=${orgId} FAILED: ${err.message}`);
    }
  }

  console.log(`[backfillMetricDaily] complete — ${failures} failure(s)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfillMetricDaily] fatal:', err);
  process.exit(1);
});
