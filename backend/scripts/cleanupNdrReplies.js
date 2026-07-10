/**
 * cleanupNdrReplies.js — CLI wrapper over services/NdrCleanupService.
 *
 * All logic lives in the service, which the Org Admin UI
 * (routes/ndr-cleanup.routes.js → "Bounce Cleanup" panel) also calls. Fixing
 * one therefore fixes both. Read the service header for what this does and why.
 *
 * USAGE
 *   node scripts/cleanupNdrReplies.js                    # DRY RUN, all orgs
 *   node scripts/cleanupNdrReplies.js 7                  # DRY RUN, org 7
 *   node scripts/cleanupNdrReplies.js 7 --reprocess      # DRY RUN + parse each NDR
 *   node scripts/cleanupNdrReplies.js 7 --apply --reprocess
 *
 * DRY RUN IS THE DEFAULT. Every mutation runs inside a transaction that is
 * ROLLBACKed unless --apply is passed.
 *
 * ON RAILWAY
 *   railway ssh   →   node scripts/cleanupNdrReplies.js 7
 *
 * Or run locally against the PUBLIC proxy (the internal DATABASE_URL does not
 * resolve off-network) with NODE_ENV=production so pg enables SSL:
 *
 *   DATABASE_URL="$DATABASE_PUBLIC_URL" NODE_ENV=production \
 *     node scripts/cleanupNdrReplies.js 7
 *
 * config/database.js prints the host it connected to. Read that line before you
 * type --apply — dotenv silently falls back to your dev database otherwise.
 */

const db = require('../config/database');
const NdrCleanupService = require('../services/NdrCleanupService');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REPROCESS = args.includes('--reprocess');
const positional = args.filter((a) => !a.startsWith('--'));
const orgArg = positional[0] ? parseInt(positional[0], 10) : null;

if (positional[0] && !Number.isInteger(orgArg)) {
  console.error(`Invalid org id: ${positional[0]}`);
  process.exit(1);
}

async function main() {
  console.log(
    `[cleanupNdr] mode=${APPLY ? 'APPLY' : 'DRY RUN'} reprocess=${REPROCESS ? 'yes' : 'no'}`
  );
  if (!APPLY) console.log('[cleanupNdr] No changes will be committed. Re-run with --apply.\n');

  const orgs = orgArg ? [orgArg] : await NdrCleanupService.orgsWithEmail();

  let failures = 0;
  const totals = {
    ndrEmails: 0,
    reprocessed: 0,
    activitiesDeleted: 0,
    stagesReverted: 0,
    actionsReset: 0,
  };

  for (const orgId of orgs) {
    try {
      const r = await NdrCleanupService.execute({
        orgId,
        reprocess: REPROCESS,
        apply: APPLY,
        onLog: (line) => console.log(`[cleanupNdr] ${line}`),
      });
      for (const k of Object.keys(totals)) totals[k] += r.stats[k];
    } catch (err) {
      failures++;
      console.error(`[cleanupNdr] org=${orgId} FAILED (rolled back):`, err.message);
    }
  }

  console.log(
    `\n[cleanupNdr] ${APPLY ? 'applied' : 'would apply'} across ${orgs.length} org(s):\n` +
      `    NDR emails soft-deleted : ${totals.ndrEmails}\n` +
      `    delivery events written : ${totals.reprocessed}\n` +
      `    reply activities removed: ${totals.activitiesDeleted}\n` +
      `    stages reverted         : ${totals.stagesReverted}\n` +
      `    action outcomes reset   : ${totals.actionsReset}\n` +
      `    failures                : ${failures}`
  );
  if (!APPLY && totals.ndrEmails > 0) {
    console.log('\n[cleanupNdr] Re-run with --apply --reprocess to commit.');
  }

  await db.pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[cleanupNdr] fatal:', err);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
