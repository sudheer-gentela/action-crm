#!/usr/bin/env node
/**
 * verify_project_tracking_133.js — behavioural verification of migration 2026_133.
 *
 * STANDALONE, same shape and same invocation as verify_daily_work_132.js:
 *
 *   node verify_project_tracking_133.js
 *
 * with DATABASE_URL either in .env beside the script or set inline.
 *
 * What it proves, beyond "the column exists":
 *
 *   - tracking_mode defaults to 'timeboxed', so every pre-existing project
 *     behaves exactly as it did before the migration
 *   - a standing initiative is refused a go_live_date, BY NAME
 *   - a standing initiative is refused completion, BY NAME, and the two
 *     refusals are distinguishable from each other
 *   - 'cancelled' is still available to a standing initiative — cancel and
 *     retire are different acts and only one of them is blocked
 *   - retirement is refused on a timeboxed project and refused half-set
 *   - project_kind was NOT widened to carry 'standing' — the specific wrong
 *     turn this design exists to avoid
 *   - all four project_kind x tracking_mode combinations are actually
 *     insertable, which is the whole claim that the axes are orthogonal
 *   - CONVERSION IN BOTH DIRECTIONS LEAVES LOGGED DAILY WORK UNTOUCHED.
 *     This is the user's decision recorded as an executable assertion rather
 *     than as a sentence in a design document.
 *   - a go-live change does not reschedule project_play_instances (it never
 *     did), and clearing it on conversion moves nothing in either the live or
 *     the legacy play table — with a positive control on the legacy trigger so
 *     the "nothing moved" assertions are not green for the wrong reason
 *
 * NOTE ON RLS: sales_handovers has none, and neither do deal_play_instances,
 * project_play_instances, sales_handover_plays, org_users, users,
 * organizations or the daily work tables. ACCOUNTS DOES —
 * org_isolation_accounts, keyed on app.current_org_id, which this harness
 * never sets. It works anyway for the same reason verify_daily_work_132.js
 * does: the policy is not FORCEd, so the table owner bypasses it, and
 * DATABASE_URL connects as the owner. If that connection is ever changed to a
 * non-owner role, the accounts fixture starts returning zero rows and the
 * account-scoped setup fails loudly rather than silently — but check this note
 * first when it does.
 *
 * If RLS is later enabled on sales_handovers or the daily work tables, this
 * file starts silently returning zero rows and every check goes green for the
 * wrong reason. Set app.current_org_id per statement at that point.
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
  console.error('  $env:DATABASE_URL="postgresql://..."; node verify_project_tracking_133.js\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const FIXTURE_ORG  = 'TM133_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'tm133-verify-fixture';

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
 * Assert that `fn` fails with a NAMED constraint.
 *
 * A bare try/catch would pass when the insert died because the fixture had a
 * typo. err.constraint is what separates "the CHECK did its job" from "this
 * write failed for some reason I have not looked at".
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
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'sales_handovers'
        AND column_name IN ('tracking_mode','retired_at','retired_by','project_kind')`);
  const col = c => cols.find(r => r.column_name === c);

  check('sales_handovers.tracking_mode exists', !!col('tracking_mode'));
  check('tracking_mode is text', col('tracking_mode')?.data_type === 'text',
    `got ${col('tracking_mode')?.data_type}`);
  check('tracking_mode is NOT NULL', col('tracking_mode')?.is_nullable === 'NO',
    'a NULL here would mean "undecided" and every read would need a COALESCE');
  check("tracking_mode defaults to 'timeboxed'",
    /timeboxed/.test(col('tracking_mode')?.column_default || ''),
    `default is ${col('tracking_mode')?.column_default} — existing rows would change behaviour`);

  check('sales_handovers.retired_at exists', !!col('retired_at'));
  check('retired_at is a timestamptz',
    col('retired_at')?.data_type === 'timestamp with time zone',
    `got ${col('retired_at')?.data_type}`);
  check('sales_handovers.retired_by exists', !!col('retired_by'));

  // project_kind must still be exactly what it was.
  check('project_kind is still present and untouched', !!col('project_kind'));

  const { rows: cons } = await q(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = ANY($1)`,
    [['sales_handovers_tracking_mode_chk','chk_sh_standing_no_go_live',
      'chk_sh_standing_never_completes','chk_sh_retired_shape',
      'sales_handovers_retired_by_fkey','sales_handovers_project_kind_chk',
      'sales_handovers_kind_shape_chk']]);
  const c = n => cons.find(r => r.conname === n);

  check('sales_handovers_tracking_mode_chk exists', !!c('sales_handovers_tracking_mode_chk'));
  check('chk_sh_standing_no_go_live exists',        !!c('chk_sh_standing_no_go_live'));
  check('chk_sh_standing_never_completes exists',   !!c('chk_sh_standing_never_completes'));
  check('chk_sh_retired_shape exists',              !!c('chk_sh_retired_shape'));
  check('sales_handovers_retired_by_fkey exists',   !!c('sales_handovers_retired_by_fkey'));

  check('tracking_mode CHECK allows exactly timeboxed and standing',
    /timeboxed/.test(c('sales_handovers_tracking_mode_chk')?.def || '') &&
    /standing/.test(c('sales_handovers_tracking_mode_chk')?.def || ''),
    c('sales_handovers_tracking_mode_chk')?.def || 'constraint missing');

  // The two axes stayed separate. Merging them is the obvious wrong turn:
  // a third project_kind value would make a customer retainer inexpressible.
  check('project_kind was NOT widened to carry standing',
    !/standing/.test(c('sales_handovers_project_kind_chk')?.def || ''),
    `project_kind CHECK now reads: ${c('sales_handovers_project_kind_chk')?.def}`);
  check('sales_handovers_kind_shape_chk survived the migration',
    !!c('sales_handovers_kind_shape_chk'),
    'the internal/customer shape rule is gone — something widened the crossing');

  const { rows: idx } = await q(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_sales_handovers_standing'`);
  check('idx_sales_handovers_standing exists', idx.length === 1,
    'the standing-initiatives screen would sequential-scan every project in the org');
  check('idx_sales_handovers_standing is partial on the standing side',
    /WHERE.*standing/is.test(idx[0]?.indexdef || ''),
    idx[0]?.indexdef || 'index missing — a full index here would be almost entirely timeboxed rows');

  // The trigger is not modified by 2026_133, but conversion fires it, so its
  // continued existence is part of what this migration relies on.
  const { rows: trg } = await q(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.sales_handovers'::regclass AND NOT tgisinternal`);
  check('trg_reschedule_go_live still exists',
    trg.some(t => t.tgname === 'trg_reschedule_go_live'),
    `triggers found: ${trg.map(t => t.tgname).join(', ') || '(none)'}`);
}

/* ───────────────────────── fixture ─────────────────────────── */

async function setup() {
  await teardown();  // in case a previous run died before its finally block

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [FIXTURE_ORG, FIXTURE_SLUG]);

  // users requires password_hash and last_name; is_active lives on org_users,
  // not users. Both were fixture errors caught during the daily work build.
  const { rows: [user] } = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
     VALUES ($1, 'x', 'Fixture', 'User', $2) RETURNING id`,
    [`tracking.verify.${Date.now()}@fixture.invalid`, org.id]);

  await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, 'member')`,
    [org.id, user.id]);

  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('TM133 Fixture Account', $1) RETURNING id`,
    [org.id]);

  return { orgId: org.id, userId: user.id, accountId: account.id };
}

/**
 * Teardown, in dependency order, every statement scoped to the fixture org so
 * nothing outside it can be touched even if this runs against production.
 *
 * Users go before their organization: fk_users_org has no ON DELETE CASCADE.
 * sales_handovers goes before accounts: sales_handovers_account_id_fkey is
 * ON DELETE RESTRICT, so an account with a project on it cannot be deleted.
 */
async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  const scoped = [
    'daily_work_entries', 'daily_work_items',
    'daily_work_schedules', 'daily_work_exceptions', 'daily_activity_types',
    'sales_handover_plays', 'deal_play_instances', 'project_play_instances',
    'project_members',
    'sales_handovers',
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
  /**
   * Insert a project. Defaults produce a valid CUSTOMER project on the fixture
   * account; pass kind:'internal' to get one with no account, which
   * sales_handovers_kind_shape_chk requires.
   */
  const mkProject = (o = {}) => {
    const kind = o.kind || 'customer';
    // tracking_mode is always passed explicitly here. The DEFAULT path — a
    // caller that never mentions the column — cannot be exercised through this
    // helper and gets its own statement below, because that is the case every
    // pre-existing row is in and it deserves to be tested as written.
    return q(
      `INSERT INTO sales_handovers
         (org_id, project_kind, name, account_id, tracking_mode,
          go_live_date, status, completed_at, retired_at, retired_by,
          assigned_service_owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, tracking_mode, go_live_date::text AS go_live_date`,
      [orgId, kind, o.name || 'tm133 fixture',
       kind === 'internal' ? null : accountId,
       o.mode || 'timeboxed', o.goLive ?? null, o.status || 'draft',
       o.completedAt ?? null, o.retiredAt ?? null, o.retiredBy ?? null,
       o.owner ?? null, userId]);
  };

  console.log('\nBEHAVIOUR — the default is invisible');

  // The whole safety argument for crossing the §12 fence rests on this one
  // fact: a project created without mentioning tracking_mode behaves today
  // exactly as it did before the migration.
  const { rows: [dflt] } = await q(
    `INSERT INTO sales_handovers
       (org_id, project_kind, name, account_id, go_live_date, status, created_by)
     VALUES ($1,'customer','tm133 default probe',$2,'2026-11-30','draft',$3)
     RETURNING tracking_mode, go_live_date::text AS go_live_date`,
    [orgId, accountId, userId]);
  check('a project inserted without tracking_mode is timeboxed',
    dflt.tracking_mode === 'timeboxed', `got ${dflt.tracking_mode}`);
  check('and it keeps its go-live date',
    dflt.go_live_date === '2026-11-30', `got ${dflt.go_live_date}`);

  await expectViolation('an unknown tracking mode is refused',
    'sales_handovers_tracking_mode_chk',
    () => mkProject({ mode: 'recurring' }));   // the plausible wrong word

  console.log('\nBEHAVIOUR — a standing initiative has no end date');

  await expectViolation('standing initiative cannot carry a go-live date',
    'chk_sh_standing_no_go_live',
    () => mkProject({ kind: 'internal', mode: 'standing', goLive: '2026-12-31' }));
  await expectSuccess('standing initiative without a go-live date is fine',
    () => mkProject({ kind: 'internal', mode: 'standing' }));
  await expectSuccess('a timeboxed project still takes a go-live date',
    () => mkProject({ goLive: '2026-12-31' }));

  console.log('\nBEHAVIOUR — a standing initiative never completes');

  await expectViolation('standing initiative cannot be completed',
    'chk_sh_standing_never_completes',
    () => mkProject({ kind: 'internal', mode: 'standing', status: 'completed' }));
  await expectViolation('standing initiative cannot carry a completion timestamp',
    'chk_sh_standing_never_completes',
    () => mkProject({ kind: 'internal', mode: 'standing', completedAt: new Date().toISOString() }));

  // Cancel and retire are different acts. Only one of them is blocked, and a
  // constraint that blocked both would strand an initiative created in error.
  await expectSuccess('standing initiative CAN still be cancelled',
    () => mkProject({ kind: 'internal', mode: 'standing', status: 'cancelled' }));

  console.log('\nBEHAVIOUR — retirement');

  await expectViolation('retired_at without retired_by is refused',
    'chk_sh_retired_shape',
    () => mkProject({ kind: 'internal', mode: 'standing', retiredAt: new Date().toISOString() }));
  await expectViolation('a timeboxed project cannot be retired',
    'chk_sh_retired_shape',
    () => mkProject({ retiredAt: new Date().toISOString(), retiredBy: userId }));
  await expectSuccess('a standing initiative can be retired',
    () => mkProject({ kind: 'internal', mode: 'standing',
                      retiredAt: new Date().toISOString(), retiredBy: userId }));

  console.log('\nBEHAVIOUR — the two axes are genuinely independent');

  // If any of these four fails, the model has collapsed into one axis and the
  // whole design is wrong — most likely by someone "simplifying" project_kind.
  await expectSuccess('customer + timeboxed (an implementation)',
    () => mkProject({ mode: 'timeboxed', goLive: '2026-10-01' }));
  await expectSuccess('customer + standing (a retainer)',
    () => mkProject({ mode: 'standing' }));
  await expectSuccess('internal + timeboxed (a migration with a date)',
    () => mkProject({ kind: 'internal', mode: 'timeboxed', goLive: '2026-10-01' }));
  await expectSuccess('internal + standing (Skill Development)',
    () => mkProject({ kind: 'internal', mode: 'standing' }));

  await conversionChecks({ orgId, userId, accountId, mkProject });
  await anchoredPlayChecks({ orgId, userId, accountId });
}

/* ── conversion leaves logged work alone ─────────────────────────────── */

async function conversionChecks({ orgId, userId, mkProject }) {
  console.log('\nBEHAVIOUR — conversion does not disturb logged work');

  const { rows: [proj] } = await mkProject({
    kind: 'internal', mode: 'standing', name: 'TM133 Skill Development' });

  // A recurring daily work item anchored to the initiative, with one entry
  // logged against it. Both hold their own snapshot of the anchor — nothing is
  // derived from the project at read time, which is why conversion is safe.
  const { rows: [item] } = await q(
    `INSERT INTO daily_work_items
       (org_id, owner_user_id, kind, title, status, anchor_kind, anchor_id, created_by)
     VALUES ($1,$2,'recurring','tm133 recurring work','active','handover',$3,$2)
     RETURNING id`,
    [orgId, userId, proj.id]);

  const { rows: [entry] } = await q(
    `INSERT INTO daily_work_entries
       (org_id, item_id, user_id, entry_date, description, day_stage, anchor_kind, anchor_id)
     VALUES ($1,$2,$3,'2026-08-14','what October says','in_progress','handover',$4)
     RETURNING id`,
    [orgId, item.id, userId, proj.id]);

  const readEntry = async () => {
    const { rows: [r] } = await q(
      `SELECT entry_date::text AS entry_date, description, day_stage,
              anchor_kind, anchor_id
         FROM daily_work_entries WHERE id = $1`, [entry.id]);
    return r;
  };

  const before = await readEntry();

  // standing -> timeboxed. The user's answer: name an owner and a date; the
  // work already logged just carries over with all its details.
  await expectSuccess('standing converts to timeboxed by naming an owner and a date',
    () => q(`UPDATE sales_handovers
                SET tracking_mode = 'timeboxed',
                    assigned_service_owner_id = $2,
                    go_live_date = '2026-12-15'
              WHERE id = $1`, [proj.id, userId]));

  const afterForward = await readEntry();
  check('the logged entry is byte-for-byte unchanged by the conversion',
    JSON.stringify(afterForward) === JSON.stringify(before),
    `before ${JSON.stringify(before)} / after ${JSON.stringify(afterForward)}`);
  check('the entry still points at the same project',
    afterForward.anchor_kind === 'handover' && afterForward.anchor_id === proj.id,
    `anchor is now ${afterForward.anchor_kind}/${afterForward.anchor_id}`);

  // timeboxed -> standing. The date MUST be cleared in the same statement:
  // this is the trap the service layer has to handle, so it is asserted as a
  // refusal first and then as the correct form.
  await expectViolation('converting to standing without clearing the date is refused',
    'chk_sh_standing_no_go_live',
    () => q(`UPDATE sales_handovers SET tracking_mode = 'standing' WHERE id = $1`,
      [proj.id]));

  await expectSuccess('converting to standing while clearing the date in one statement works',
    () => q(`UPDATE sales_handovers
                SET tracking_mode = 'standing', go_live_date = NULL
              WHERE id = $1`, [proj.id]));

  const afterBack = await readEntry();
  check('the logged entry survives the round trip unchanged',
    JSON.stringify(afterBack) === JSON.stringify(before),
    `before ${JSON.stringify(before)} / after ${JSON.stringify(afterBack)}`);

  const { rows: [it] } = await q(
    `SELECT anchor_kind, anchor_id, status FROM daily_work_items WHERE id = $1`, [item.id]);
  check('the daily work item is unchanged too',
    it.anchor_kind === 'handover' && it.anchor_id === proj.id && it.status === 'active',
    JSON.stringify(it));
}

/* ── what a go-live change does to anchored plays ────────────────────── */

/**
 * THE TABLE HERE MATTERS, AND THE OBVIOUS CHOICE IS THE WRONG ONE.
 *
 * sales_handovers carries trg_reschedule_go_live, which calls
 * reschedule_go_live_anchored_plays() and updates DEAL_PLAY_INSTANCES through
 * the sales_handover_plays join. That reads like the mechanism a conversion has
 * to worry about. It is not, any more.
 *
 * 2026_109 split project plays into their own table. Project checklists live in
 * PROJECT_PLAY_INSTANCES, linked by a mandatory handover_id, and that table has
 * NO trigger — grep pg_trigger for it and nothing comes back. Its go_live-
 * anchored due dates are computed once, at insert, by computeInstanceDueDate()
 * in PlaybookPlayService, and nothing in the backend recomputes them afterwards.
 *
 * So both tables are checked, for different reasons:
 *
 *   A. project_play_instances — the live path. Moving the go-live date does NOT
 *      move these dates, and neither does clearing it. The first half is a
 *      pre-existing product behaviour this migration did not cause and does not
 *      change; it is asserted so that if someone later adds the rescheduling
 *      that is arguably missing, conversion-to-standing has to be reconsidered
 *      at the same time.
 *
 *   B. deal_play_instances via sales_handover_plays — the legacy path. 2026_109
 *      deliberately left the migrated rows and their link rows in place, so the
 *      trigger still fires on them. Asserted with a positive control, because a
 *      "nothing moved" assertion on a fixture that never reached the trigger
 *      would be green and worthless.
 */
async function anchoredPlayChecks({ orgId, userId, accountId }) {
  console.log('\nBEHAVIOUR — go-live changes and anchored plays');

  const { rows: [proj] } = await q(
    `INSERT INTO sales_handovers
       (org_id, project_kind, name, account_id, tracking_mode, go_live_date,
        status, created_by)
     VALUES ($1,'customer','TM133 anchored plays',$2,'timeboxed','2026-10-01','in_progress',$3)
     RETURNING id`,
    [orgId, accountId, userId]);

  // A. The live table.
  const { rows: [ppi] } = await q(
    `INSERT INTO project_play_instances
       (org_id, handover_id, stage_key, title, due_date, due_anchor, status)
     VALUES ($1,$2,'delivery','tm133 project play','2026-09-17','go_live','not_started')
     RETURNING id`,
    [orgId, proj.id]);

  // B. The legacy table. deal_id stays NULL — deal_play_instances_owner_chk
  // requires exactly one of deal_id and handover_id, and 2026_109 records that
  // every project row here has handover_id NULL and is reached only through
  // sales_handover_plays. The link row is what the trigger actually reads;
  // without it the control below would fail and say so.
  const { rows: [dpi] } = await q(
    `INSERT INTO deal_play_instances
       (org_id, handover_id, stage_key, title, due_date, due_anchor, status)
     VALUES ($1,$2,'delivery','tm133 legacy play','2026-09-17','go_live','not_started')
     RETURNING id`,
    [orgId, proj.id]);
  await q(
    `INSERT INTO sales_handover_plays (org_id, handover_id, play_instance_id)
     VALUES ($1,$2,$3)`,
    [orgId, proj.id, dpi.id]);

  const dueOf = async (table, id) => {
    const { rows: [r] } = await q(
      `SELECT due_date::text AS due_date FROM ${table} WHERE id = $1`, [id]);
    return r.due_date;
  };

  // Move the go-live seven days.
  await q(`UPDATE sales_handovers SET go_live_date = '2026-10-08' WHERE id = $1`, [proj.id]);

  const dpiShift = await dueOf('deal_play_instances', dpi.id);
  check('control: the legacy trigger still shifts deal_play_instances',
    dpiShift === '2026-09-24',
    `due_date is ${dpiShift}, expected 2026-09-24 — the fixture never reached ` +
    'trg_reschedule_go_live, so the "nothing moved" checks below prove nothing');

  const ppiShift = await dueOf('project_play_instances', ppi.id);
  check('moving the go-live does NOT reschedule project_play_instances',
    ppiShift === '2026-09-17',
    `due_date became ${ppiShift} — something now recomputes project play dates ` +
    'from go_live, which changes what conversion to standing has to do');

  // Now the thing conversion actually does.
  await q(
    `UPDATE sales_handovers SET tracking_mode = 'standing', go_live_date = NULL WHERE id = $1`,
    [proj.id]);

  check('clearing the go-live on conversion moves no legacy due date',
    await dueOf('deal_play_instances', dpi.id) === dpiShift,
    'reschedule_go_live_anchored_plays no longer returns early on NULL');
  check('clearing the go-live on conversion moves no project due date',
    await dueOf('project_play_instances', ppi.id) === '2026-09-17',
    'project_play_instances dates changed on conversion');

  console.log('\n          Both plays now hold dates derived from a go-live the project');
  console.log('          no longer has. Nothing in the database is wrong; the UI would');
  console.log('          be misleading. Service layer decision, not a schema rule.');
}

/* ───────────────────────── run ─────────────────────────────── */

(async () => {
  console.log(`\nverify_project_tracking_133 — migration 2026_133`);
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
      console.log('  BEGIN;');
      for (const t of ['daily_work_entries','daily_work_items','daily_work_schedules',
                       'daily_work_exceptions','daily_activity_types',
                       'sales_handover_plays','deal_play_instances',
                       'project_play_instances','project_members',
                       'sales_handovers','org_users','users','accounts']) {
        console.log(`  DELETE FROM ${t} WHERE org_id = (SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}');`);
      }
      console.log(`  DELETE FROM organizations WHERE name = '${FIXTURE_ORG}';`);
      console.log('  COMMIT;\n');
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('2026_133 verified.\n');
})();
