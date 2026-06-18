/**
 * scripts/grandfatherEntitlements.js — one-time backfill for the first
 * entitlement layer.
 *
 * Sets organizations.settings.entitlements = { ai, calling } on every org that
 * doesn't already have it, so EXISTING / dogfood orgs keep working when the
 * default-off entitlement gate goes live. New orgs created after this run get
 * NO entitlements key → default-off → gated until the platform grants them.
 *
 * Grandfather rules (preserve current behaviour, don't over-grant):
 *   ai      = true  UNLESS the org explicitly disabled AI via
 *             settings.prospecting_config.ai_enabled === false (or "false").
 *             (AI was previously an opt-OUT org switch, effectively on for all.)
 *   calling = true  ONLY IF the org already has an ACTIVE Twilio subaccount
 *             (org_twilio_accounts.status = 'active'). Orgs that never set up
 *             calling stay gated — they must be granted explicitly.
 *
 * Idempotent: orgs that already have a settings.entitlements object are SKIPPED
 * (never overwritten), so re-running is safe.
 *
 * DRY-RUN BY DEFAULT. Prints the plan and writes nothing. Pass --apply to
 * execute. Matches the dry-run-first convention for destructive/bulk DB ops.
 *
 *   node scripts/grandfatherEntitlements.js            # preview only
 *   node scripts/grandfatherEntitlements.js --apply    # write
 *
 * Requires DATABASE_URL (same as the app).
 */

const { pool } = require('../config/database');

const APPLY = process.argv.includes('--apply');

function aiDisabledExplicitly(settings) {
  const v = settings?.prospecting_config?.ai_enabled;
  return v === false || v === 'false';
}

async function main() {
  console.log(`\n=== grandfatherEntitlements — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} ===\n`);

  // Pull every org's settings + whether it has an active Twilio subaccount.
  const { rows } = await pool.query(
    `SELECT o.id,
            o.name,
            o.settings,
            (ota.org_id IS NOT NULL AND ota.status = 'active') AS has_active_calling
       FROM organizations o
       LEFT JOIN org_twilio_accounts ota ON ota.org_id = o.id
      ORDER BY o.id`
  );

  let planned = 0, skipped = 0;
  const plan = [];

  for (const org of rows) {
    const settings = org.settings || {};

    // Idempotency: never overwrite an existing entitlements object.
    if (settings.entitlements && typeof settings.entitlements === 'object'
        && !Array.isArray(settings.entitlements)) {
      skipped++;
      continue;
    }

    const ai      = !aiDisabledExplicitly(settings);
    const calling = org.has_active_calling === true;

    plan.push({ id: org.id, name: org.name, ai, calling });
    planned++;
  }

  // Print the plan table.
  console.log(`Orgs total: ${rows.length}  |  to backfill: ${planned}  |  already set (skipped): ${skipped}\n`);
  if (plan.length) {
    console.log('  org_id  ai      calling   name');
    console.log('  ------  ------  --------  ----');
    for (const p of plan) {
      console.log(
        `  ${String(p.id).padEnd(6)}  ${String(p.ai).padEnd(6)}  ${String(p.calling).padEnd(8)}  ${p.name || ''}`
      );
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY-RUN complete. No rows were modified. Re-run with --apply to write.\n');
    await pool.end();
    return;
  }

  // Write — one row at a time, jsonb_set on the {entitlements} sub-key so we
  // never clobber the rest of settings.
  let written = 0;
  for (const p of plan) {
    await pool.query(
      `UPDATE organizations
          SET settings   = jsonb_set(COALESCE(settings, '{}'::jsonb), '{entitlements}', $2::jsonb, true),
              updated_at = NOW()
        WHERE id = $1`,
      [p.id, JSON.stringify({ ai: p.ai, calling: p.calling })]
    );
    written++;
  }

  console.log(`APPLY complete. ${written} org(s) updated.\n`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('grandfatherEntitlements failed:', err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
