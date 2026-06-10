#!/usr/bin/env node
/**
 * scripts/encrypt-tokens-backfill.js
 *
 * One-time (but safely re-runnable) migration that encrypts existing
 * PLAINTEXT token rows at rest, using the same AES-256-GCM scheme as new
 * writes (services/credentials/tokenCrypto.js, key = AI_CREDS_KEY).
 *
 * Tables / columns covered:
 *   - oauth_tokens.access_token, oauth_tokens.refresh_token
 *   - prospecting_sender_accounts.access_token, prospecting_sender_accounts.refresh_token
 *
 * SAFETY PROPERTIES
 *   - Idempotent: rows already carrying the 'enc:v1:' prefix are skipped, so
 *     running it twice (or after new encrypted writes have landed) is a no-op
 *     on those rows. sealToken() also refuses to double-encrypt.
 *   - Race-safe with the live firer: each UPDATE re-reads the current value in
 *     its WHERE clause (access_token = $oldValue) and only writes if it hasn't
 *     changed since we read it. If the firer refreshed/sealed the token in the
 *     meantime, our UPDATE matches zero rows and we move on — no clobber.
 *   - Per-row, not a big transaction: a single bad row can't roll back the
 *     whole run. Failures are counted and reported at the end.
 *   - Placeholder rows (access_token = 'webhook_only', set by the notetaker
 *     webhook flow) are NOT real tokens; sealing them is harmless but pointless,
 *     so they're skipped explicitly.
 *
 * USAGE
 *   DATABASE_URL=... AI_CREDS_KEY=... node scripts/encrypt-tokens-backfill.js
 *   Add --dry-run to report what WOULD change without writing.
 *
 * Run this in a quiet window (the firer reads sender tokens every minute).
 * Because the code is dual-read, deploy order doesn't matter — encrypted and
 * plaintext rows coexist until this finishes.
 */

const { pool } = require('../config/database');
const { sealToken, isSealed, isConfigured } = require('../services/credentials/tokenCrypto');

const DRY_RUN = process.argv.includes('--dry-run');

const PLACEHOLDER_VALUES = new Set(['webhook_only']);

async function backfillTable(table, idCol = 'id') {
  let scanned = 0;
  let sealed = 0;
  let skipped = 0;
  let failed = 0;

  const { rows } = await pool.query(
    `SELECT ${idCol} AS id, access_token, refresh_token FROM ${table}`
  );

  for (const row of rows) {
    scanned += 1;

    // Decide what each column should become.
    const updates = [];
    const params = [];
    let p = 1;

    // access_token (NOT NULL in both tables)
    if (
      row.access_token != null &&
      !isSealed(row.access_token) &&
      !PLACEHOLDER_VALUES.has(row.access_token)
    ) {
      updates.push(`access_token = $${p++}`);
      params.push(sealToken(row.access_token));
    }

    // refresh_token (nullable)
    if (row.refresh_token != null && !isSealed(row.refresh_token)) {
      updates.push(`refresh_token = $${p++}`);
      params.push(sealToken(row.refresh_token));
    }

    if (updates.length === 0) {
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      sealed += 1;
      continue;
    }

    try {
      // Race-safe guard: only write if the columns still hold the exact
      // plaintext we read. If the firer refreshed/sealed them since, this
      // matches zero rows and we skip without clobbering.
      const guardParts = [`${idCol} = $${p++}`];
      params.push(row.id);

      guardParts.push(`access_token IS NOT DISTINCT FROM $${p++}`);
      params.push(row.access_token);

      guardParts.push(`refresh_token IS NOT DISTINCT FROM $${p++}`);
      params.push(row.refresh_token);

      const res = await pool.query(
        `UPDATE ${table} SET ${updates.join(', ')} WHERE ${guardParts.join(' AND ')}`,
        params
      );

      if (res.rowCount === 1) {
        sealed += 1;
      } else {
        // Value changed under us (concurrent refresh) — leave it; the writer
        // that changed it already sealed via sealToken().
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${table} ${idCol}=${row.id} failed: ${err.message}`);
    }
  }

  return { scanned, sealed, skipped, failed };
}

async function main() {
  if (!isConfigured()) {
    console.error('❌ AI_CREDS_KEY is not configured (or not 32 bytes). Aborting — cannot encrypt.');
    process.exit(1);
  }

  console.log(`🔐 Token backfill starting${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  let totalFailed = 0;
  for (const table of ['oauth_tokens', 'prospecting_sender_accounts']) {
    console.log(`\n── ${table} ──`);
    const r = await backfillTable(table);
    console.log(
      `   scanned ${r.scanned} · ${DRY_RUN ? 'would seal' : 'sealed'} ${r.sealed} · skipped ${r.skipped} · failed ${r.failed}`
    );
    totalFailed += r.failed;
  }

  console.log(`\n${totalFailed === 0 ? '✅' : '⚠️'} Backfill complete. Failures: ${totalFailed}`);

  // Verification hint for the operator.
  console.log(
    `\nVerify with:\n` +
    `  SELECT count(*) FILTER (WHERE access_token NOT LIKE 'enc:v1:%' AND access_token <> 'webhook_only') AS plaintext_access,\n` +
    `         count(*) FILTER (WHERE refresh_token IS NOT NULL AND refresh_token NOT LIKE 'enc:v1:%') AS plaintext_refresh\n` +
    `  FROM oauth_tokens;\n` +
    `  -- repeat for prospecting_sender_accounts. Both counts should be 0.`
  );

  await pool.end();
  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('❌ Backfill crashed:', err);
  process.exit(1);
});
