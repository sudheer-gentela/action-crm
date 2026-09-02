#!/usr/bin/env node
// test_planImport_service.js
//
//   cd C:\Projects\dw-verify
//   node test_planImport_service.js
//
// Exercises the real planImport.service.js against a real database, same shape
// and the same require.cache substitution as test_dailyWork_service.js.
//
// Two halves, and the first needs no database at all:
//
//   PURE       parseDuration and the working-day walk. This is where every
//              date in an imported plan comes from, and it is worth testing
//              without a project in front of it.
//   AGAINST DB preview() and commit() — stage creation, sort_order, the
//              frozen-baseline rule, and the transaction.
//
// TIME IS PINNED where it matters: the fixture supplies explicit start dates,
// so nothing here depends on which day the harness runs. The one exception is
// preview() with no startDate, which deliberately means "today" and is only
// asserted to be A working day, not a particular one.
//
// TEARDOWN: no daily work is created here, so project_play_instances cascades
// from sales_handovers normally.

const path = require('path');
const fs = require('fs');

try { require('dotenv').config(); } catch {}

let Pool;
try { ({ Pool } = require('pg')); }
catch {
  console.error('\nRun `npm install pg dotenv` in this folder first.\n');
  process.exit(2);
}

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  console.error('\nNo DATABASE_URL. Set it in .env or inline.\n');
  process.exit(2);
}

const REPO_CANDIDATES = [
  process.env.DW_REPO,
  path.join(__dirname, '..', 'action-crm-clean', 'backend'),
  'C:/Projects/action-crm-clean/backend',
  path.join(__dirname, '..', 'backend'),
].filter(Boolean);

const REPO = REPO_CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'services', 'planImport.service.js')); }
  catch { return false; }
});

if (!REPO) {
  console.error('\nCould not find the backend. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\nSet it explicitly:');
  console.error('  set DW_REPO=C:\\\\Projects\\\\action-crm-clean\\\\backend\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

async function withOrgTransaction(orgId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

const dbPath = path.resolve(REPO, 'config', 'database.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { pool, db: pool, withOrgTransaction, query: (t, p) => pool.query(t, p) },
};

const svc = require(path.resolve(REPO, 'services', 'planImport.service.js'));
console.log(`\ntesting: ${path.resolve(REPO, 'services', 'planImport.service.js')}`);

let passed = 0, failed = 0;
const failures = [];

function pass(n) { passed++; console.log(`  PASS  ${n}`); }
function fail(n, d) { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); }
function check(n, cond, d) { cond ? pass(n) : fail(n, d || 'condition was false'); }
function eq(n, actual, expected) {
  check(n, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function expectCode(name, code, fn) {
  try { await fn(); fail(name, `expected ${code}, but it was accepted`); }
  catch (err) {
    if (err.code === code) pass(name);
    else fail(name, `expected code ${code}, got ${err.code || '(none)'} — ${err.message}`);
  }
}

async function expectOk(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (err) { fail(name, `expected success, got ${err.code || ''} ${err.message}`); return null; }
}

const q = (sql, params) => pool.query(sql, params);

/* ───────────────────────── pure ────────────────────────────────────── */

function durationChecks() {
  console.log('\nPURE — reading a duration cell');

  const d = (raw) => svc.parseDuration(raw);

  eq('a bare number', d('3').days, 3);
  eq('and carries no note', d('3').note, null);
  eq('"3 days"', d('3 days').days, 3);
  eq('"3d"', d('3d').days, 3);

  // The upper end, deliberately: picking the optimistic end of somebody else's
  // estimate is how a plan is late before it starts.
  eq('a hyphen range takes the upper end', d('3-5 days').days, 5);
  eq('an EN DASH range too', d('3–5 days').days, 5);
  eq('"3 to 5"', d('3 to 5').days, 5);
  check('a range says so', /upper end/.test(d('3-5').note || ''), d('3-5').note);

  // Weeks are WORKING weeks. A five-day week is the assumption the schedule
  // already makes everywhere else.
  eq('"2 weeks" is ten working days', d('2 weeks').days, 10);

  eq('a blank cell is one day', d('').days, 1);
  check('and says it assumed that', /assumed/.test(d('').note || ''), d('').note);
  eq('so is nonsense', d('tbd').days, 1);
  check('naming what it could not read',
    /could not read/.test(d('tbd').note || ''), d('tbd').note);

  // Refusing the whole import over one bad cell would send the person back to
  // the spreadsheet, which is what this exists to prevent.
  eq('a fractional duration rounds up', d('2.5').days, 3);
  eq('an absurd duration is capped', d('9999').days, 365);
  eq('zero is not a duration', d('0').days, 1);
}

function calendarChecks() {
  console.log('\nPURE — the working-day walk');

  const none = new Set();
  // 2026-06-15 is a Monday; 2026-06-20 a Saturday; 2026-06-21 a Sunday.
  check('a Monday is a working day', svc.isWorkingDay('2026-06-15', none));
  check('a Friday is', svc.isWorkingDay('2026-06-19', none));
  check('a Saturday is not', !svc.isWorkingDay('2026-06-20', none));
  check('a Sunday is not', !svc.isWorkingDay('2026-06-21', none));

  eq('a working day is its own next working day',
    svc.nextWorkingDay('2026-06-15', none), '2026-06-15');
  eq('Saturday rolls to Monday',
    svc.nextWorkingDay('2026-06-20', none), '2026-06-22');
  eq('Sunday rolls to Monday',
    svc.nextWorkingDay('2026-06-21', none), '2026-06-22');

  const holidays = new Set(['2026-06-22', '2026-06-23']);
  eq('holidays are skipped too',
    svc.nextWorkingDay('2026-06-20', holidays), '2026-06-24');

  // UTC arithmetic, not local. A date built from a bare YYYY-MM-DD in local
  // time is the classic way a scheduler lands a day out east of Greenwich.
  eq('adding days does not drift', svc.addDays('2026-06-15', 7), '2026-06-22');
  eq('nor across a month end', svc.addDays('2026-06-30', 1), '2026-07-01');
  eq('nor across a year end', svc.addDays('2026-12-31', 1), '2027-01-01');
}

/* ───────────────────────── fixture ─────────────────────────────────── */

const FIXTURE_ORG = 'PLANIMP_VERIFY_FIXTURE';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['daily_work_entries', 'daily_work_items',
                   'project_stages', 'sales_handovers',
                   'holiday_calendar_dates', 'holiday_calendars',
                   'org_users', 'users']) {
    await q(`DELETE FROM ${t} WHERE org_id = ${org}`, [FIXTURE_ORG]);
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
}

async function setup() {
  await teardown();

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,'planimp-verify-fixture') RETURNING id`,
    [FIXTURE_ORG]);

  const { rows: [user] } = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
     VALUES ($1,'x','Fix','Ture',$2) RETURNING id`,
    [`planimp.${Date.now()}@fixture.invalid`, org.id]);
  await q(`INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1,$2,'member',TRUE)`,
    [org.id, user.id]);

  // A default holiday calendar with one date inside the test window, so the
  // holiday arm of the schedule is exercised rather than assumed.
  const { rows: [cal] } = await q(
    `INSERT INTO holiday_calendars (org_id, name, is_default, is_active, created_by)
     VALUES ($1,'PLANIMP Fixture Calendar',TRUE,TRUE,$2) RETURNING id`,
    [org.id, user.id]);
  await q(
    `INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
     VALUES ($1,$2,'2026-06-17','Fixture holiday')`,
    [org.id, cal.id]);

  const mkProject = async (name) => {
    const { rows: [h] } = await q(
      `INSERT INTO sales_handovers
         (org_id, name, project_kind, tracking_mode, status, created_by)
       VALUES ($1,$2,'internal','timeboxed','in_progress',$3) RETURNING id`,
      [org.id, name, user.id]);
    return h.id;
  };

  return { orgId: org.id, userId: user.id, mkProject };
}

const plays = async (handoverId) => (await q(
  `SELECT id, title, description, stage_key, sort_order, due_date::text AS due_date,
          baseline_due_date::text AS baseline_due_date, baseline_source,
          owner_user_id, is_gate, due_anchor, status, play_id, playbook_id
     FROM project_play_instances WHERE handover_id = $1
    ORDER BY stage_key, sort_order`, [handoverId])).rows;

const stages = async (handoverId) => (await q(
  `SELECT key, name, sort_order, source, is_active FROM project_stages
    WHERE handover_id = $1 ORDER BY sort_order`, [handoverId])).rows;

/* ───────────────────────── preview ─────────────────────────────────── */

async function previewChecks({ orgId, mkProject }) {
  console.log('\nPREVIEW — durations become dates');

  const project = await mkProject('PLANIMP Preview');

  const rows = [
    { phase: 'Core model', title: 'Base pipeline',   duration: '3 days' },
    { phase: 'Core model', title: 'Initial training', duration: '2' },
    { phase: 'Annotation', title: 'Environment setup', duration: '1' },
  ];

  // Monday 15 June. The fixture calendar makes Wednesday 17th a holiday, so a
  // three-day task starting Monday runs Mon, Tue, Thu.
  const p = await expectOk('preview runs', () =>
    svc.preview(project, orgId, { rows, startDate: '2026-06-15' }));

  eq('it starts on the day asked for', p?.startDate, '2026-06-15');
  eq('a 3-day task skips the holiday in the middle', p?.rows[0].dueDate, '2026-06-18');
  eq('the next task starts the day after', p?.rows[1].dueDate, '2026-06-22');  // Fri + Mon
  eq('and the next after that', p?.rows[2].dueDate, '2026-06-23');
  eq('three rows will be created', p?.summary.willCreate, 3);
  eq('two stages are new', p?.newStages.length, 2);
  check('nothing was written by a preview',
    (await plays(project)).length === 0, 'preview created rows');

  // A weekend start rolls forward rather than scheduling on a Saturday.
  const wk = await svc.preview(project, orgId, { rows: [rows[2]], startDate: '2026-06-20' });
  eq('a Saturday start rolls to Monday', wk.startDate, '2026-06-22');

  // A date already in the sheet is kept, and the sequence continues from it.
  const withDate = await svc.preview(project, orgId, {
    rows: [
      { title: 'Fixed date task', duration: '5', dueDate: '2026-07-10' },
      { title: 'Follows it', duration: '1' },
    ],
    startDate: '2026-06-15',
  });
  eq('an explicit date is kept, not recomputed', withDate.rows[0].dueDate, '2026-07-10');
  eq('and the next task follows it', withDate.rows[1].dueDate, '2026-07-13');   // Mon

  // A row with no task name is reported, not silently dropped.
  const blank = await svc.preview(project, orgId, {
    rows: [{ title: '', duration: '2' }, { title: 'Real', duration: '1' }],
    startDate: '2026-06-15',
  });
  eq('a nameless row is skipped', blank.summary.skipped, 1);
  eq('but still reported', blank.rows.length, 2);
  check('and says why', /no task name/.test(blank.rows[0].notes.join(' ')),
    blank.rows[0].notes.join(' '));

  await expectCode('an empty import is refused', 'EMPTY_IMPORT', () =>
    svc.preview(project, orgId, { rows: [] }));
  await expectCode('a bad start date is refused', 'BAD_DATE', () =>
    svc.preview(project, orgId, { rows, startDate: '15/06/2026' }));
  await expectCode('an unknown project is refused', 'NO_SUCH_PROJECT', () =>
    svc.preview(2147483000, orgId, { rows }));
  await expectCode('too many rows is refused', 'TOO_MANY_ROWS', () =>
    svc.preview(project, orgId, {
      rows: Array.from({ length: svc.MAX_ROWS + 1 }, (_, i) => ({ title: `T${i}` })) }));
}

/* ───────────────────────── commit ──────────────────────────────────── */

async function commitChecks({ orgId, userId, mkProject }) {
  console.log('\nCOMMIT — the tasks and stages get created');

  const project = await mkProject('PLANIMP Commit');

  const result = await expectOk('commit runs', () =>
    svc.commit(project, orgId, userId, {
      rows: [
        { phase: 'Core model', title: 'Base pipeline', duration: '3',
          dueDate: '2026-06-18', description: 'The detector' },
        { phase: 'Core model', title: 'Initial training', dueDate: '2026-06-22',
          ownerUserId: userId },
        { phase: 'Annotation', title: 'Environment setup', dueDate: '2026-06-23',
          isGate: true },
        { title: 'No phase at all', dueDate: '2026-06-24' },
      ],
    }));

  eq('four tasks created', result?.tasksCreated, 4);
  eq('two stages created', result?.stagesCreated, 2);

  const created = await plays(project);
  eq('four rows on the project', created.length, 4);

  const byTitle = t => created.find(p => p.title === t);
  eq('the description came through', byTitle('Base pipeline').description, 'The detector');
  eq('the stage key is normalised', byTitle('Base pipeline').stage_key, 'core_model');
  eq('a row with no phase lands in custom', byTitle('No phase at all').stage_key, 'custom');
  eq('the owner came through', byTitle('Initial training').owner_user_id, userId);
  eq('the gate flag came through', byTitle('Environment setup').is_gate, true);
  eq('the date came through', byTitle('Base pipeline').due_date, '2026-06-18');

  // Same as addPlay: an imported task has no template to take a go-live offset
  // from, so it must not be go_live-anchored.
  check('due_anchor is created, matching addPlay',
    created.every(p => p.due_anchor === 'created'));
  check('every task is ad-hoc — no playbook behind it',
    created.every(p => p.play_id === null && p.playbook_id === null));
  check('every task starts not_started',
    created.every(p => p.status === 'not_started'));

  // Unfrozen project: no baseline yet. Giving one would invent a commitment
  // nobody made.
  check('an unfrozen plan gets no baseline',
    created.every(p => p.baseline_due_date === null && p.baseline_source === null),
    JSON.stringify(created.map(p => p.baseline_source)));

  const st = await stages(project);
  eq('the stages exist', st.filter(s => ['core_model', 'annotation'].includes(s.key)).length, 2);
  check('in first-appearance order',
    st.find(s => s.key === 'core_model').sort_order
      < st.find(s => s.key === 'annotation').sort_order);
  check('the stage keeps its typed name',
    st.find(s => s.key === 'core_model').name === 'Core model');

  // sort_order on the sparse 10-step scale, per stage, so a later import lands
  // after what is already there rather than tying with it.
  const core = created.filter(p => p.stage_key === 'core_model')
    .sort((a, b) => a.sort_order - b.sort_order);
  check('sort_order is spaced within the stage',
    core[1].sort_order - core[0].sort_order === 10,
    `${core[0].sort_order} then ${core[1].sort_order}`);

  const second = await svc.commit(project, orgId, userId, {
    rows: [{ phase: 'Core model', title: 'Added later', dueDate: '2026-06-25' }] });
  eq('a second import into the same stage creates no new stage', second.stagesCreated, 0);
  const after = await plays(project);
  const added = after.find(p => p.title === 'Added later');
  check('and lands after what was already there',
    added.sort_order > core[core.length - 1].sort_order,
    `${added.sort_order} vs ${core[core.length - 1].sort_order}`);
}

async function frozenChecks({ orgId, userId, mkProject }) {
  console.log('\nCOMMIT — a frozen plan baselines what it creates');

  const project = await mkProject('PLANIMP Frozen');
  await q(`UPDATE sales_handovers SET baseline_frozen_at = now(), started_at = now()
            WHERE id = $1`, [project]);

  const r = await expectOk('import into a committed plan is allowed', () =>
    svc.commit(project, orgId, userId, {
      rows: [
        { phase: 'Late addition', title: 'Forgotten step', dueDate: '2026-07-01' },
        { phase: 'Late addition', title: 'Undated step' },
      ],
    }));
  eq('it says it baselined them', r?.baselined, true);

  const created = await plays(project);
  const dated = created.find(p => p.title === 'Forgotten step');
  const undated = created.find(p => p.title === 'Undated step');

  // Same rule addPlay applies: without this an imported task on a live project
  // reports isAdHoc forever and contributes nothing to plan-vs-actual.
  eq('a dated task is born with a committed baseline', dated.baseline_source, 'original');
  eq('at the date given', dated.baseline_due_date, '2026-07-01');
  // And the other half of the same rule: a baseline with no date in it would
  // be a row claiming to be a commitment while naming no day.
  eq('an undated task gets no baseline', undated.baseline_source, null);
  eq('and no baseline date', undated.baseline_due_date, null);
}

async function refusalChecks({ orgId, userId, mkProject }) {
  console.log('\nCOMMIT — refusals, and nothing half-written');

  const project = await mkProject('PLANIMP Refusals');

  await expectCode('an empty commit is refused', 'EMPTY_IMPORT', () =>
    svc.commit(project, orgId, userId, { rows: [] }));

  await expectCode('rows with no task name at all are refused', 'NO_USABLE_ROWS', () =>
    svc.commit(project, orgId, userId, { rows: [{ phase: 'X', title: '   ' }] }));

  // The whole point of the transaction: one bad date must not leave the good
  // rows behind it.
  await expectCode('a bad date refuses the whole import', 'BAD_DATE', () =>
    svc.commit(project, orgId, userId, {
      rows: [
        { title: 'Good one', dueDate: '2026-07-01' },
        { title: 'Bad one', dueDate: 'next Tuesday' },
      ],
    }));
  check('and nothing was created', (await plays(project)).length === 0,
    'a refused import left rows behind');

  const dead = await mkProject('PLANIMP Cancelled');
  await q(`UPDATE sales_handovers SET status = 'cancelled' WHERE id = $1`, [dead]);
  await expectCode('a cancelled project refuses an import', 'PROJECT_TERMINAL', () =>
    svc.commit(dead, orgId, userId, { rows: [{ title: 'Too late' }] }));

  await expectCode('an unknown project is refused', 'NO_SUCH_PROJECT', () =>
    svc.commit(2147483000, orgId, userId, { rows: [{ title: 'Nowhere' }] }));
}

async function volumeChecks({ orgId, userId, mkProject }) {
  console.log('\nCOMMIT — the size this exists for');

  // 49 tasks is the number in the design note: the plan that stays in a
  // spreadsheet because entering it by hand is worse than not using the tool.
  const project = await mkProject('PLANIMP Volume');
  const rows = Array.from({ length: 49 }, (_, i) => ({
    phase: `Phase ${Math.floor(i / 7) + 1}`,
    title: `Task ${i + 1}`,
    duration: '2',
  }));

  const p = await svc.preview(project, orgId, { rows, startDate: '2026-06-15' });
  eq('all 49 are scheduled', p.summary.willCreate, 49);
  check('and land on working days only',
    p.rows.every(r => svc.isWorkingDay(r.dueDate, new Set())),
    'a task was scheduled on a weekend');

  const started = Date.now();
  const r = await svc.commit(project, orgId, userId, {
    rows: p.rows.map(x => ({ phase: x.phase, title: x.title, dueDate: x.dueDate })) });
  const ms = Date.now() - started;

  eq('all 49 created', r.tasksCreated, 49);
  eq('seven stages created', r.stagesCreated, 7);
  eq('and they are all there', (await plays(project)).length, 49);
  // Not a benchmark, a smoke test: a loop over addPlay would be ~250 round
  // trips here. One statement should be nowhere near this bound.
  check(`49 tasks in one statement, not 250 round trips (${ms}ms)`, ms < 10000,
    `took ${ms}ms — that looks like a loop, not a batch`);
}

/* ───────────────────────── run ─────────────────────────────────────── */

(async () => {
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}\n`);

  let fx;
  try {
    durationChecks();
    calendarChecks();
    fx = await setup();
    await previewChecks(fx);
    await commitChecks(fx);
    await frozenChecks(fx);
    await refusalChecks(fx);
    await volumeChecks(fx);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) {
      console.log(`\nWARNING: teardown failed — ${err.message}`);
      console.log(`The fixture org '${FIXTURE_ORG}' is STILL PRESENT.`);
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('plan import verified.\n');
})();
