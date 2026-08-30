#!/usr/bin/env node
/**
 * verify_daily_work_132.js — behavioural verification of migration 2026_132.
 *
 * STANDALONE, same shape as verify_daily_work_schema.js. Run it the same way:
 *
 *   cd C:\\Projects\\dw-verify
 *   node verify_daily_work_132.js
 *
 * with DATABASE_URL either in .env or set inline.
 *
 * What it proves, beyond "the columns exist":
 *
 *   - a recurring item cannot carry a target date (chk_dwi_target_date_kind)
 *   - an assigned item can
 *   - account_id survives on the ENTRY independently of the item, which is the
 *     whole point of snapshotting it twice
 *   - the FK is ON DELETE SET NULL, not RESTRICT, so deleting an account does
 *     not block and does not cascade the entry away
 *   - the three partial indexes exist with their WHERE clauses intact
 *
 * The account tests need a real accounts row, so the fixture creates one inside
 * the fixture org and tears it down with everything else.
 *
 * NOTE: if RLS is later enabled (2026_133), this harness must set
 * app.current_org_id per statement or every query silently returns zero rows.
 */

try { require('dotenv').config(); } catch { /* fine — env may be set inline */ }

let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  console.error('\nThe pg module is not installed in this folder.\n');
  console.error('From the folder holding this script:');
  console.error('  npm install pg dotenv\n');
  process.exit(2);
}

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  console.error('\nNo DATABASE_URL found.\n');
  console.error('Put it in a .env file next to this script, or (PowerShell):');
  console.error('  $env:DATABASE_URL="postgresql://..."; node verify_daily_work_132.js\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const FIXTURE_ORG  = 'DW132_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'dw132-verify-fixture';

let passed = 0, failed = 0;
const failures = [];

function pass(name) { passed++; console.log(`  PASS  ${name}`); }
function fail(name, detail) {
  failed++; failures.push(name);
  console.log(`  FAIL  ${name}\n          ${detail}`);
}

function check(name, condition, detail) {
  condition ? pass(name) : fail(name, detail || 'condition was false');
}

/**
 * Assert that `fn` fails with a named constraint.
 *
 * This is the whole point of the harness. Postgres reports the violated
 * constraint in err.constraint; comparing against it is what distinguishes
 * "the CHECK did its job" from "my fixture had a typo and the insert died for
 * some other reason". A bare try/catch would call both a pass.
 */
async function expectViolation(name, constraintName, fn) {
  try {
    await fn();
    fail(name, `expected ${constraintName} to reject this, but the write succeeded`);
  } catch (err) {
    if (err.constraint === constraintName) pass(name);
    else fail(name, `expected constraint ${constraintName}, got ${err.constraint || '(none)'} — ${err.message}`);
  }
}

async function expectSuccess(name, fn) {
  try { await fn(); pass(name); }
  catch (err) { fail(name, `expected this to be accepted, got ${err.constraint || err.code} — ${err.message}`); }
}

const q = (sql, params) => pool.query(sql, params);

/* ───────────────────────── structure ───────────────────────── */

async function structureChecks() {
  console.log('\nSTRUCTURE');

  const { rows: cols } = await q(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'daily_work_items'   AND column_name IN ('account_id','target_date'))
          OR (table_name = 'daily_work_entries' AND column_name = 'account_id'))`);
  const col = (t, c) => cols.find(r => r.table_name === t && r.column_name === c);

  check('daily_work_items.account_id exists',   !!col('daily_work_items','account_id'));
  check('daily_work_entries.account_id exists', !!col('daily_work_entries','account_id'));
  check('daily_work_items.target_date exists',  !!col('daily_work_items','target_date'));
  check('target_date is a date, not a timestamp',
    col('daily_work_items','target_date')?.data_type === 'date',
    `got ${col('daily_work_items','target_date')?.data_type}`);
  check('account_id is nullable on entries',
    col('daily_work_entries','account_id')?.is_nullable === 'YES');

  const { rows: cons } = await q(
    `SELECT conname, confdeltype FROM pg_constraint
      WHERE conname IN ('fk_dwi_account','fk_dwen_account','chk_dwi_target_date_kind')`);
  const c = n => cons.find(r => r.conname === n);

  check('chk_dwi_target_date_kind exists', !!c('chk_dwi_target_date_kind'));
  check('fk_dwi_account exists',  !!c('fk_dwi_account'));
  check('fk_dwen_account exists', !!c('fk_dwen_account'));

  // confdeltype 'n' = SET NULL. RESTRICT ('r') would let daily work block an
  // account deletion from an unrelated part of the product.
  check('fk_dwi_account is ON DELETE SET NULL',
    c('fk_dwi_account')?.confdeltype === 'n',
    `confdeltype = ${c('fk_dwi_account')?.confdeltype}`);
  check('fk_dwen_account is ON DELETE SET NULL',
    c('fk_dwen_account')?.confdeltype === 'n',
    `confdeltype = ${c('fk_dwen_account')?.confdeltype}`);

  const { rows: [vocab] } = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'chk_dwi_status_by_kind'`);
  check('chk_dwi_status_by_kind allows yet_to_start',
    /yet_to_start/.test(vocab?.def || ''), vocab?.def || 'constraint missing');
  check('chk_dwi_status_by_kind no longer mentions not_started',
    !/not_started/.test(vocab?.def || ''),
    'the old word survives in the constraint — the rename did not run');

  const { rows: [left] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_items WHERE status = 'not_started'`);
  check('no item rows still hold not_started', left.n === 0, `${left.n} rows remain`);

  const { rows: idx } = await q(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [['idx_dwi_account','idx_dwen_account_date','idx_dwi_target']]);
  check('all three indexes exist', idx.length === 3,
    `found: ${idx.map(i => i.indexname).join(', ') || '(none)'}`);

  // Partial indexes only help if the WHERE survived. A full index here would
  // be mostly NULLs, since internal work carries no account.
  for (const name of ['idx_dwi_account','idx_dwen_account_date','idx_dwi_target']) {
    const def = idx.find(i => i.indexname === name)?.indexdef || '';
    check(`${name} is partial`, /WHERE/i.test(def), 'index exists but has no WHERE clause');
  }
  // An index whose predicate names a status that can no longer exist would
  // never match a row — the failure is silent, so it is asserted.
  check('idx_dwi_target predicate uses the new vocabulary',
    /yet_to_start/.test(idx.find(i => i.indexname === 'idx_dwi_target')?.indexdef || '') &&
    !/not_started/.test(idx.find(i => i.indexname === 'idx_dwi_target')?.indexdef || ''),
    idx.find(i => i.indexname === 'idx_dwi_target')?.indexdef || 'index missing');

  check('idx_dwen_account_date orders entry_date descending',
    /entry_date DESC/i.test(idx.find(i => i.indexname === 'idx_dwen_account_date')?.indexdef || ''),
    'the account view reads most-recent-first; ascending would sort after the scan');
}

async function setup() {
  await teardown();  // in case a previous run died before its finally block

  // users requires password_hash, last_name and org_id; organizations requires
  // slug. Both were fixture errors caught by earlier harnesses in this build.
  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [FIXTURE_ORG, FIXTURE_SLUG]);

  const { rows: [user] } = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
     VALUES ($1, 'x', 'Fixture', 'User', $2) RETURNING id`,
    [`dailywork.verify.${Date.now()}@fixture.invalid`, org.id]);

  await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, 'member')`,
    [org.id, user.id]);

  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('DW132 Fixture Account', $1) RETURNING id`,
    [org.id]);

  return { orgId: org.id, userId: user.id, accountId: account.id };
}

/**
 * Teardown, in dependency order.
 *
 * The first version of this deleted the organization and relied on FK cascades.
 * That left the fixture behind on a real database, because fk_users_org has no
 * ON DELETE CASCADE — users must go before their org. Everything else beneath
 * the org does cascade, but deleting explicitly costs nothing and means this
 * keeps working if a future migration adds another table without one.
 *
 * Every statement is scoped by the fixture org id, so nothing outside it can be
 * touched even if this runs against production.
 */
async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  const scoped = [
    'play_notes', 'play_evidence',
    'daily_work_entries', 'daily_work_items',
    'daily_work_schedules', 'daily_work_exceptions', 'daily_activity_types',
    'holiday_calendar_dates', 'holiday_calendars',
    'org_users', 'users', 'accounts',
  ];
  for (const table of scoped) {
    await q(`DELETE FROM ${table} WHERE org_id = ${org}`, [FIXTURE_ORG]);
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);

  const { rows: [left] } = await q(
    `SELECT count(*)::int AS n FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  if (left.n) throw new Error('fixture org still present after teardown');
}

/* ───────────────────────── behaviour ───────────────────────── */

async function behaviourChecks({ orgId, userId, accountId }) {
  console.log('\nBEHAVIOUR — target_date');

  const mkItem = (kind, status, extra = {}) => q(
    `INSERT INTO daily_work_items
       (org_id, owner_user_id, kind, title, status, target_date, account_id,
        anchor_kind, anchor_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2) RETURNING id`,
    [orgId, userId, kind, extra.title || 'dw132 fixture', status,
     extra.target ?? null, extra.account ?? null,
     extra.anchorKind ?? null, extra.anchorId ?? null]);

  // Recurring work never completes, so a date by which it should be done is
  // meaningless. The CHECK enforces in the database what the form enforces.
  await expectViolation('recurring item cannot carry a target date', 'chk_dwi_target_date_kind',
    () => mkItem('recurring', 'active', { target: '2026-09-30' }));
  await expectSuccess('assigned item can carry a target date',
    () => mkItem('assigned', 'yet_to_start', { target: '2026-09-30' }));
  await expectSuccess('assigned item without a target date is still fine',
    () => mkItem('assigned', 'yet_to_start'));

  console.log('\nBEHAVIOUR — status vocabulary');

  // One word for one idea across items and entries. The old word must be
  // refused outright, or code written against it would keep half-working.
  await expectViolation('an item can no longer be created as not_started',
    'chk_dwi_status_by_kind',
    () => mkItem('assigned', 'not_started'));
  await expectSuccess('yet_to_start is accepted on an assigned item',
    () => mkItem('assigned', 'yet_to_start'));
  await expectViolation('yet_to_start is still refused on recurring work',
    'chk_dwi_status_by_kind',
    () => mkItem('recurring', 'yet_to_start'));
  await expectSuccess('recurring work still uses active',
    () => mkItem('recurring', 'active'));

  console.log('\nBEHAVIOUR — account snapshot');

  const { rows: [item] } = await mkItem('recurring', 'active',
    { title: 'account parent', account: accountId, anchorKind: 'account', anchorId: accountId });

  const mkEntry = (date, acct) => q(
    `INSERT INTO daily_work_entries
       (org_id, item_id, user_id, entry_date, description, day_stage, account_id)
     VALUES ($1,$2,$3,$4,'fixture entry','in_progress',$5) RETURNING id`,
    [orgId, item.id, userId, date, acct]);

  await expectSuccess('entry carries its own account_id', () => mkEntry('2026-08-10', accountId));
  await expectSuccess('entry may have no account (internal work)', () => mkEntry('2026-08-11', null));

  const { rows: [entry] } = await mkEntry('2026-08-12', accountId);

  // The reason the column is duplicated onto the entry. Re-anchoring the item
  // must not disturb what was already logged — that is the whole snapshot rule.
  await q(`UPDATE daily_work_items SET account_id = NULL WHERE id = $1`, [item.id]);
  const { rows: [after] } = await q(
    `SELECT account_id FROM daily_work_entries WHERE id = $1`, [entry.id]);
  check('re-anchoring the item does not disturb logged entries',
    after.account_id === accountId,
    `entry account_id became ${after.account_id} after the item changed`);

  console.log('\nBEHAVIOUR — account deletion');

  // Soft delete is the norm for accounts, so a hard delete is administrative.
  // When one happens history should degrade to "no account", not block the
  // deletion and not take the entry with it.
  const { rows: [doomed] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('DW132 Doomed Account', $1) RETURNING id`,
    [orgId]);
  const { rows: [attached] } = await mkEntry('2026-08-13', doomed.id);

  await expectSuccess('deleting an account is not blocked by daily work',
    () => q(`DELETE FROM accounts WHERE id = $1`, [doomed.id]));

  const { rows: [survivor] } = await q(
    `SELECT id, account_id FROM daily_work_entries WHERE id = $1`, [attached.id]);
  check('the entry survives its account being deleted', !!survivor,
    'the entry was cascaded away — the FK is wrong');
  check('the entry account_id is set to NULL, not left dangling',
    survivor && survivor.account_id === null,
    `account_id is ${survivor && survivor.account_id}`);
}

/* ───────────────────────── run ─────────────────────────────── */

(async () => {
  console.log(`\nverify_daily_work_132 — migration 2026_132`);
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}\n`);

  let fixture;
  try {
    await structureChecks();
    fixture = await setup();
    await behaviourChecks(fixture);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) {
      console.log(`\nWARNING: teardown failed — ${err.message}`);
      console.log('The fixture org is STILL PRESENT. Remove it with:\n');
      console.log(`  BEGIN;`);
      for (const t of ['play_notes','play_evidence','daily_work_entries','daily_work_items',
                       'daily_work_schedules','daily_work_exceptions','daily_activity_types',
                       'holiday_calendar_dates','holiday_calendars','org_users','users']) {
        console.log(`  DELETE FROM ${t} WHERE org_id = (SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}');`);
      }
      console.log(`  DELETE FROM organizations WHERE name = '${FIXTURE_ORG}';`);
      console.log(`  COMMIT;\n`);
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('2026_132 verified.\n');
})();
