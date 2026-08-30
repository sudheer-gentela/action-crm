/**
 * verify_daily_work_schema.js — behavioural verification of migration 2026_131.
 *
 * STANDALONE. Does not import anything from the application repo, so it can
 * live in its own folder with its own node_modules and never touch
 * action-crm-clean. Its only dependencies are pg and (optionally) dotenv.
 *
 * Setup, once:
 *
 *   mkdir C:\Projects\dw-verify
 *   cd C:\Projects\dw-verify
 *   copy this file here, plus the package.json
 *   npm install
 *   create a .env holding one line:  DATABASE_URL=postgresql://user:pass@host:5432/db
 *
 * Then:
 *
 *   node verify_daily_work_schema.js
 *
 * SSL is enabled automatically for any host that is not localhost, because
 * hosted Postgres refuses plaintext connections.
 *
 * 2026_131 was applied to production but never behaviourally tested. A schema
 * dump proves the DDL landed; it does not prove the constraints actually refuse
 * what they were written to refuse. This does.
 *
 * Two kinds of check:
 *
 *   STRUCTURE — read-only catalogue queries. No writes at all.
 *   BEHAVIOUR — real inserts and updates inside a fixture org, asserting that
 *               each one fails with the SPECIFIC constraint that should catch
 *               it. A test that only checks "it threw" passes when the insert
 *               fails for an unrelated typo, so every negative assertion here
 *               names the constraint and compares err.constraint against it.
 *
 * Safety against a live database: every write is scoped to a fixture org named
 * DAILYWORK_VERIFY_FIXTURE, and teardown deletes that org by name. FK cascades
 * remove everything beneath it. Teardown runs in a finally block, so it happens
 * even when an assertion throws, and setup clears a stale fixture first in case
 * an earlier run died before its finally.
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 *
 * NOTE: if row-level security is later enabled on these tables, this harness
 * must set app.current_org_id per statement or every query will silently
 * return zero rows.
 */

try { require('dotenv').config(); } catch { /* fine — env may be set inline */ }

let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  console.error('\nThe pg module is not installed in this folder.\n');
  console.error('From the folder holding this script:');
  console.error('  npm install\n');
  console.error('It needs only pg and dotenv, and installs nothing into your app repo.\n');
  process.exit(2);
}

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  console.error('\nNo DATABASE_URL found.\n');
  console.error('Put it in a .env file next to this script:');
  console.error('  DATABASE_URL=postgresql://user:pass@host:5432/dbname\n');
  console.error('Or pass it inline (PowerShell):');
  console.error('  $env:DATABASE_URL="postgresql://..."; node verify_daily_work_schema.js\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const FIXTURE_ORG  = 'DAILYWORK_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'dailywork-verify-fixture';

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

  const TABLES = [
    'daily_activity_types', 'daily_work_entries', 'daily_work_exceptions',
    'daily_work_items', 'daily_work_schedules',
    'holiday_calendars', 'holiday_calendar_dates',
  ];
  const { rows: tabs } = await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`, [TABLES]);
  const found = tabs.map(r => r.table_name).sort();
  check('all seven tables exist',
    found.length === 7,
    `missing: ${TABLES.filter(t => !found.includes(t)).join(', ') || '(none)'}`);

  // The evidence/notes widening — §4.7. Both columns added, both existing
  // parent columns made nullable, one CHECK enforcing exactly one parent.
  const { rows: cols } = await q(
    `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('play_evidence','play_notes')
        AND column_name IN ('daily_work_entry_id','project_play_instance_id')`);
  const col = (t, c) => cols.find(r => r.table_name === t && r.column_name === c);

  check('play_evidence.daily_work_entry_id exists', !!col('play_evidence','daily_work_entry_id'));
  check('play_notes.daily_work_entry_id exists',    !!col('play_notes','daily_work_entry_id'));
  check('play_evidence.project_play_instance_id is nullable',
    col('play_evidence','project_play_instance_id')?.is_nullable === 'YES');
  check('play_notes.project_play_instance_id is nullable',
    col('play_notes','project_play_instance_id')?.is_nullable === 'YES');

  const { rows: chks } = await q(
    `SELECT conname FROM pg_constraint
      WHERE conname IN ('play_evidence_parent_shape_chk','play_notes_parent_shape_chk')`);
  check('play_evidence_parent_shape_chk exists',
    chks.some(r => r.conname === 'play_evidence_parent_shape_chk'));
  check('play_notes_parent_shape_chk exists',
    chks.some(r => r.conname === 'play_notes_parent_shape_chk'));

  // §8 of the migration replaced both trigger functions to enumerate the new
  // column. They list every column by name, so a column added without editing
  // them is silently unguarded — that is the trap this asserts against.
  const { rows: fns } = await q(
    `SELECT proname, pg_get_functiondef(oid) AS src FROM pg_proc
      WHERE proname IN ('play_evidence_immutable','play_notes_append_only')`);
  for (const name of ['play_evidence_immutable','play_notes_append_only']) {
    const fn = fns.find(f => f.proname === name);
    check(`${name}() knows about daily_work_entry_id`,
      !!fn && fn.src.includes('daily_work_entry_id'),
      fn ? 'function exists but does not reference the new column' : 'function missing');
  }

  const { rows: trgs } = await q(
    `SELECT tgname FROM pg_trigger
      WHERE tgname IN ('trg_play_evidence_immutable','trg_play_notes_append_only')
        AND NOT tgisinternal`);
  check('both immutability triggers are still attached', trgs.length === 2,
    `found: ${trgs.map(t => t.tgname).join(', ') || '(none)'}`);

  const { rows: idx } = await q(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [['uq_holiday_calendars_one_default','idx_dwen_user_date','idx_dwen_item_date',
      'idx_dwi_owner_open','idx_dws_user_effective','idx_play_evidence_daily_entry',
      'idx_play_notes_daily_entry']]);
  check('expected indexes exist', idx.length === 7,
    `found ${idx.length}/7: ${idx.map(i => i.indexname).join(', ')}`);

  // Pre-existing rows must still satisfy the new CHECK. If the migration ran
  // against real data, this is the query that proves it did not leave orphans.
  const { rows: [orphans] } = await q(
    `SELECT
       (SELECT count(*) FROM play_evidence
         WHERE num_nonnulls(project_play_instance_id, daily_work_entry_id) <> 1) AS ev,
       (SELECT count(*) FROM play_notes
         WHERE num_nonnulls(project_play_instance_id, daily_work_entry_id) <> 1) AS nt`);
  check('every existing evidence row has exactly one parent', Number(orphans.ev) === 0,
    `${orphans.ev} rows violate the shape`);
  check('every existing note row has exactly one parent', Number(orphans.nt) === 0,
    `${orphans.nt} rows violate the shape`);
}

/* ───────────────────────── fixtures ────────────────────────── */

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

  return { orgId: org.id, userId: user.id };
}

async function teardown() {
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
}

/* ───────────────────────── behaviour ───────────────────────── */

async function behaviourChecks({ orgId, userId }) {
  console.log('\nBEHAVIOUR — items');

  const mkItem = (kind, status, extra = {}) => q(
    `INSERT INTO daily_work_items
       (org_id, owner_user_id, kind, title, status, anchor_kind, anchor_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $2) RETURNING id`,
    [orgId, userId, kind, extra.title || 'fixture item', status,
     extra.anchorKind ?? null, extra.anchorId ?? null]);

  // The status vocabulary is conditional on kind — the constraint that makes
  // "recurring work never completes" a property of the database rather than a
  // note in a document.
  await expectViolation('recurring item cannot be completed', 'chk_dwi_status_by_kind',
    () => mkItem('recurring', 'completed'));
  await expectViolation('assigned item cannot be active', 'chk_dwi_status_by_kind',
    () => mkItem('assigned', 'active'));
  await expectViolation('unknown kind is refused', 'chk_dwi_kind',
    () => mkItem('adhoc', 'active'));
  await expectViolation('anchor_kind without anchor_id is refused', 'chk_dwi_anchor_shape',
    () => mkItem('recurring', 'active', { anchorKind: 'account' }));
  await expectViolation('unknown anchor_kind is refused', 'chk_dwi_anchor_kind',
    () => mkItem('recurring', 'active', { anchorKind: 'invoice', anchorId: 1 }));
  await expectViolation('blank title is refused', 'chk_dwi_title_not_blank',
    () => mkItem('recurring', 'active', { title: '   ' }));

  await expectSuccess('recurring + active is accepted', () => mkItem('recurring','active'));
  await expectSuccess('assigned + in_review is accepted', () => mkItem('assigned','in_review'));

  const { rows: [item] } = await mkItem('recurring', 'active', { title: 'entry parent' });

  console.log('\nBEHAVIOUR — entries');

  const mkEntry = (date, desc, stage = 'in_progress') => q(
    `INSERT INTO daily_work_entries
       (org_id, item_id, user_id, entry_date, description, day_stage)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, item.id, userId, date, desc, stage]);

  // The one hard gate in the whole design (§9). The sheet being replaced
  // contains rows filed with an empty description; this is what stops that.
  await expectViolation('blank description is refused', 'chk_dwen_description_not_blank',
    () => mkEntry('2026-08-27', '   '));
  await expectViolation('description over 2000 chars is refused', 'chk_dwen_description_len',
    () => mkEntry('2026-08-27', 'x'.repeat(2001)));
  await expectSuccess('description of exactly 2000 chars is accepted',
    () => mkEntry('2026-08-20', 'x'.repeat(2000)));
  await expectViolation('unknown day_stage is refused', 'chk_dwen_day_stage',
    () => mkEntry('2026-08-21', 'ok', 'nearly_done'));
  await expectViolation('next_steps over 2000 chars is refused', 'chk_dwen_next_steps_len',
    () => q(`INSERT INTO daily_work_entries
               (org_id, item_id, user_id, entry_date, description, day_stage, next_steps)
             VALUES ($1,$2,$3,'2026-08-22','ok','in_progress',$4)`,
      [orgId, item.id, userId, 'y'.repeat(2001)]));

  const { rows: [entry] } = await mkEntry('2026-08-19', 'first entry of the day');

  // One entry per item per local date — the storage grain. Without this the
  // person-day view could show the same item twice for one day.
  await expectViolation('second entry for the same item and date is refused',
    'daily_work_entries_org_id_item_id_entry_date_key',
    () => mkEntry('2026-08-19', 'duplicate for the same day'));

  console.log('\nBEHAVIOUR — evidence and notes');

  const mkEvidence = (ppi, dwe) => q(
    `INSERT INTO play_evidence (org_id, project_play_instance_id, daily_work_entry_id,
                                channel, note, accepted_by)
     VALUES ($1, $2, $3, 'manual', 'fixture evidence', $4) RETURNING id`,
    [orgId, ppi, dwe, userId]);

  await expectViolation('evidence with no parent is refused', 'play_evidence_parent_shape_chk',
    () => mkEvidence(null, null));
  await expectViolation('evidence with two parents is refused', 'play_evidence_parent_shape_chk',
    () => mkEvidence(1, entry.id));
  await expectSuccess('evidence parented to a daily entry is accepted',
    () => mkEvidence(null, entry.id));

  const { rows: [ev] } = await mkEvidence(null, entry.id);

  // Evidence stays immutable even though entries are editable — §4.7 calls that
  // asymmetry correct. This asserts the rewritten trigger actually guards the
  // NEW column, which is the specific thing 2026_131 §8 changed.
  try {
    await q(`UPDATE play_evidence SET daily_work_entry_id = NULL WHERE id = $1`, [ev.id]);
    fail('evidence daily_work_entry_id cannot be repointed', 'the UPDATE succeeded');
  } catch (err) {
    check('evidence daily_work_entry_id cannot be repointed',
      /immutab|cannot|revoke/i.test(err.message), `unexpected error: ${err.message}`);
  }

  await expectViolation('note with two parents is refused', 'play_notes_parent_shape_chk',
    () => q(`INSERT INTO play_notes (org_id, project_play_instance_id, daily_work_entry_id,
                                     author_id, body)
             VALUES ($1, 1, $2, $3, 'fixture note')`, [orgId, entry.id, userId]));

  await expectSuccess('note parented to a daily entry is accepted',
    () => q(`INSERT INTO play_notes (org_id, daily_work_entry_id, author_id, body)
             VALUES ($1, $2, $3, 'fixture note')`, [orgId, entry.id, userId]));

  console.log('\nBEHAVIOUR — schedules, calendars, exceptions');

  await expectViolation('weekday_mask of 0 is refused', 'chk_dws_weekday_mask',
    () => q(`INSERT INTO daily_work_schedules (org_id, user_id, weekday_mask, effective_from)
             VALUES ($1,$2,0,'2026-08-01')`, [orgId, userId]));
  await expectViolation('weekday_mask above 127 is refused', 'chk_dws_weekday_mask',
    () => q(`INSERT INTO daily_work_schedules (org_id, user_id, weekday_mask, effective_from)
             VALUES ($1,$2,128,'2026-08-01')`, [orgId, userId]));
  await expectSuccess('Mon-Fri mask of 31 is accepted',
    () => q(`INSERT INTO daily_work_schedules (org_id, user_id, weekday_mask, effective_from)
             VALUES ($1,$2,31,'2026-08-01')`, [orgId, userId]));
  await expectViolation('two schedules with the same effective_from are refused',
    'daily_work_schedules_org_id_user_id_effective_from_key',
    () => q(`INSERT INTO daily_work_schedules (org_id, user_id, weekday_mask, effective_from)
             VALUES ($1,$2,31,'2026-08-01')`, [orgId, userId]));

  await q(`INSERT INTO holiday_calendars (org_id, name, is_default)
           VALUES ($1,'Fixture India',TRUE)`, [orgId]);
  await expectViolation('a second default calendar in one org is refused',
    'uq_holiday_calendars_one_default',
    () => q(`INSERT INTO holiday_calendars (org_id, name, is_default)
             VALUES ($1,'Fixture Second',TRUE)`, [orgId]));
  await expectSuccess('a second NON-default calendar is accepted',
    () => q(`INSERT INTO holiday_calendars (org_id, name, is_default)
             VALUES ($1,'Fixture Second',FALSE)`, [orgId]));

  const { rows: [cal] } = await q(
    `SELECT id FROM holiday_calendars WHERE org_id = $1 AND is_default`, [orgId]);
  await q(`INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
           VALUES ($1,$2,'2026-08-15','Independence Day')`, [orgId, cal.id]);
  await expectViolation('the same holiday twice in one calendar is refused',
    'holiday_calendar_dates_calendar_id_holiday_date_key',
    () => q(`INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
             VALUES ($1,$2,'2026-08-15','Duplicate')`, [orgId, cal.id]));

  await q(`INSERT INTO daily_work_exceptions (org_id, user_id, exception_date, reason)
           VALUES ($1,$2,'2026-08-18','fixture leave')`, [orgId, userId]);
  await expectViolation('two exceptions on one day for one person are refused',
    'daily_work_exceptions_org_id_user_id_exception_date_key',
    () => q(`INSERT INTO daily_work_exceptions (org_id, user_id, exception_date, reason)
             VALUES ($1,$2,'2026-08-18','duplicate')`, [orgId, userId]));

  console.log('\nBEHAVIOUR — activity types and cascade');

  await q(`INSERT INTO daily_activity_types (org_id, key, label, is_system)
           VALUES ($1,'emails','Emails',TRUE)`, [orgId]);
  await expectViolation('duplicate activity key in one org is refused',
    'daily_activity_types_org_id_key_key',
    () => q(`INSERT INTO daily_activity_types (org_id, key, label)
             VALUES ($1,'emails','Emails again')`, [orgId]));
  await expectViolation('merged status without a target key is refused', 'chk_dat_merge_shape',
    () => q(`INSERT INTO daily_activity_types (org_id, key, label, status)
             VALUES ($1,'li','LinkedIn','merged')`, [orgId]));
  await expectSuccess('merged status with a target key is accepted',
    () => q(`INSERT INTO daily_activity_types (org_id, key, label, status, merged_into_key)
             VALUES ($1,'li','LinkedIn','merged','emails')`, [orgId]));

  // Deleting an item must take its entries with it, or the person-day view
  // would read entries whose parent no longer exists.
  const { rows: [doomed] } = await mkItem('recurring', 'active', { title: 'cascade parent' });
  await q(`INSERT INTO daily_work_entries
             (org_id, item_id, user_id, entry_date, description, day_stage)
           VALUES ($1,$2,$3,'2026-08-17','cascade child','in_progress')`,
    [orgId, doomed.id, userId]);
  await q(`DELETE FROM daily_work_items WHERE id = $1`, [doomed.id]);
  const { rows: [left] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_entries WHERE item_id = $1`, [doomed.id]);
  check('deleting an item cascades to its entries', left.n === 0,
    `${left.n} orphaned entries remain`);
}

/* ───────────────────────── run ─────────────────────────────── */

(async () => {
  console.log(`\nverify_daily_work_schema — migration 2026_131`);
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
    catch (err) { console.log(`\nWARNING: teardown failed — ${err.message}`);
                  console.log(`Remove it by hand: DELETE FROM organizations WHERE name = '${FIXTURE_ORG}';`); }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('2026_131 verified.\n');
})();
