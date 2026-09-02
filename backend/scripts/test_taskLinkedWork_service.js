#!/usr/bin/env node
// test_taskLinkedWork_service.js
//
//   cd C:\Projects\dw-verify
//   node test_taskLinkedWork_service.js
//
// Exercises the real dailyWork.service.js against a real database, from
// outside the repo. Same shape and the same require.cache substitution as
// test_dailyWork_service.js — see that file's header for why the trick is
// there and what keeping it faithful costs.
//
// This covers the 2026_136 surface only:
//
//   postTaskUpdate   find-or-create + entry, in ONE transaction
//   getTaskForUpdate the three refusals about the work itself
//   getTaskWork      composer state, feed across people, canPost
//   updateItem       the four guards on a linked item
//   saveDay          the linked-stage refusal, and Rule 4 left intact
//
// TIME IS PINNED. The fixture user's timezone is UTC and every call passes an
// explicit asOf, so "today" is 2026-06-15 throughout and the backfill window
// is arithmetic rather than a race against the clock at midnight.
//
// TEARDOWN ORDER MATTERS. daily_work_items -> project_play_instances is
// ON DELETE NO ACTION and project_play_instances cascades from
// sales_handovers, so the items must go before the projects.

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

/* ── locate the repo ───────────────────────────────────────────────── */

const REPO_CANDIDATES = [
  process.env.DW_REPO,
  path.join(__dirname, '..', 'action-crm-clean', 'backend'),
  'C:/Projects/action-crm-clean/backend',
  path.join(__dirname, '..', 'backend'),
].filter(Boolean);

const REPO = REPO_CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'services', 'dailyWork.service.js')); }
  catch { return false; }
});

if (!REPO) {
  console.error('\nCould not find the backend. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\nSet it explicitly:');
  console.error('  set DW_REPO=C:\\\\Projects\\\\action-crm-clean\\\\backend\n');
  process.exit(2);
}

/* ── substitute config/database before the service loads ───────────── */

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

const svc = require(path.resolve(REPO, 'services', 'dailyWork.service.js'));
console.log(`\ntesting: ${path.resolve(REPO, 'services', 'dailyWork.service.js')}`);

/* ── assertions ────────────────────────────────────────────────────── */

let passed = 0, failed = 0;
const failures = [];

function pass(n) { passed++; console.log(`  PASS  ${n}`); }
function fail(n, d) { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); }
function check(n, cond, d) { cond ? pass(n) : fail(n, d || 'condition was false'); }
function eq(n, actual, expected) {
  check(n, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Assert the service refuses something, and refuses it for the RIGHT reason. */
async function expectCode(name, code, fn) {
  try {
    await fn();
    fail(name, `expected ${code}, but it was accepted`);
  } catch (err) {
    if (err.code === code) pass(name);
    else fail(name, `expected code ${code}, got ${err.code || '(none)'} — ${err.message}`);
  }
}

async function expectOk(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (err) { fail(name, `expected success, got ${err.code || ''} ${err.message}`); return null; }
}

const q = (sql, params) => pool.query(sql, params);

/* ── time ──────────────────────────────────────────────────────────── */

const AS_OF = new Date('2026-06-15T12:00:00Z');
const TODAY = '2026-06-15';
const day = (offset) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/* ── fixtures ──────────────────────────────────────────────────────── */

const FIXTURE_ORG = 'DWTASK_VERIFY_FIXTURE';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  // daily_work_items BEFORE sales_handovers — see the header.
  for (const t of ['play_notes', 'play_evidence',
                   'daily_work_entries', 'daily_work_items',
                   'daily_work_schedules', 'daily_work_exceptions',
                   'daily_activity_types', 'holiday_calendar_dates', 'holiday_calendars',
                   'team_memberships', 'teams', 'team_dimensions',
                   'sales_handovers', 'org_users', 'users', 'accounts']) {
    await q(`DELETE FROM ${t} WHERE org_id = ${org}`, [FIXTURE_ORG]);
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
}

let taskSeq = 0;

async function setup() {
  await teardown();

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,'dwtask-verify-fixture') RETURNING id`,
    [FIXTURE_ORG]);

  // UTC on purpose: entry_date is resolved from the OWNER's timezone, so a
  // fixture in any other zone would make every date assertion below depend on
  // what time of day the harness happened to run.
  const mkUser = async (first) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id, timezone)
       VALUES ($1,'x',$2,'Fixture',$3,'UTC') RETURNING id`,
      [`dwtask.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@fixture.invalid`,
       first, org.id]);
    await q(`INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1,$2,'member',TRUE)`,
      [org.id, u.id]);
    return u.id;
  };

  const userA = await mkUser('Ana');
  const userB = await mkUser('Ben');

  const mkProject = async (name, trackingMode = 'timeboxed') => {
    const { rows: [h] } = await q(
      `INSERT INTO sales_handovers
         (org_id, name, project_kind, tracking_mode, status, created_by)
       VALUES ($1,$2,'internal',$3,'in_progress',$4) RETURNING id`,
      [org.id, name, trackingMode, userA]);
    return h.id;
  };

  const project = await mkProject('DWTASK Live Project');

  return { orgId: org.id, userA, userB, project, mkProject };
}

async function mkTask(orgId, handoverId, title = null) {
  taskSeq += 1;
  const { rows: [p] } = await q(
    `INSERT INTO project_play_instances
       (handover_id, org_id, stage_key, title, status, sort_order, owner_user_id)
     VALUES ($1,$2,'custom',$3,'not_started',$4,NULL) RETURNING id`,
    [handoverId, orgId, title || `DWTASK task ${taskSeq}`, taskSeq * 10]);
  return p.id;
}

const itemsFor = async (orgId, playInstanceId) => (await q(
  `SELECT id, owner_user_id, kind, title, status, anchor_kind, anchor_id,
          play_instance_id, opened_on::text AS opened_on, closed_at
     FROM daily_work_items
    WHERE org_id = $1 AND play_instance_id = $2
    ORDER BY id`, [orgId, playInstanceId])).rows;

const entriesFor = async (itemId) => (await q(
  `SELECT id, entry_date::text AS entry_date, description, day_stage,
          written_on::text AS written_on, is_continuation,
          (updated_at > created_at) AS edited
     FROM daily_work_entries WHERE item_id = $1 ORDER BY entry_date`,
  [itemId])).rows;

/* ── the first post ────────────────────────────────────────────────── */

async function firstPostChecks({ orgId, userA, project }) {
  console.log('\nPOST — the first update creates the item');

  const task = await mkTask(orgId, project, 'Wire up the export');

  const r = await expectOk('a first update is accepted', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: task,
      description: 'Sketched the CSV shape and checked it against the spec.',
      dayStage: 'in_progress',
      asOf: AS_OF,
    }));

  check('the item was created by this post', r && r.itemCreated === true);
  eq('the entry landed on today', r && r.entryDate, TODAY);

  const items = await itemsFor(orgId, task);
  check('exactly one item exists for the task', items.length === 1, `${items.length} items`);

  const item = items[0] || {};
  eq('the item is assigned work', item.kind, 'assigned');
  eq('the item takes its title from the task', item.title, 'Wire up the export');
  // The anchor is the PROJECT. This is the promise the design made about
  // anchor_kind, and it is the one most easily broken by a later refactor.
  eq("the item is anchored to the project, not the task", item.anchor_kind, 'handover');
  eq('the anchor id is the project', item.anchor_id, project);
  eq('the link is set', item.play_instance_id, task);
  eq("the item's status follows the day's stage", item.status, 'in_progress');
  eq('the item opened on the day being logged', item.opened_on, TODAY);

  const entries = await entriesFor(item.id);
  check('one entry was written', entries.length === 1, `${entries.length} entries`);
  eq('written_on records the day it was typed', entries[0]?.written_on, TODAY);
  check('the first entry is not a continuation', entries[0]?.is_continuation === false);

  return { task, itemId: item.id };
}

async function reuseChecks({ orgId, userA, userB, project }) {
  console.log('\nPOST — later updates reuse the same item');

  const task = await mkTask(orgId, project);
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: task, description: 'Day one.', dayStage: 'in_progress', asOf: AS_OF });

  const second = await expectOk('a second update on the same day is accepted', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: task, description: 'Day one, corrected.',
      dayStage: 'in_review', asOf: AS_OF }));

  check('the second update did NOT create a second item', second?.itemCreated === false);
  const items = await itemsFor(orgId, task);
  check('still exactly one item for this person and task', items.length === 1,
    `${items.length} items`);

  const entries = await entriesFor(items[0].id);
  check('the same day is one row, upserted', entries.length === 1, `${entries.length} entries`);
  eq('the text was replaced', entries[0]?.description, 'Day one, corrected.');
  check('the row is marked as edited', entries[0]?.edited === true);
  eq('the stage moved with it', items[0].status, 'in_review');

  // The other half of one-item-per-person-per-task.
  await expectOk('a second PERSON gets their own item', () =>
    svc.postTaskUpdate(orgId, userB, {
      playInstanceId: task, description: 'Picked up the second half.',
      dayStage: 'in_progress', asOf: AS_OF }));

  const both = await itemsFor(orgId, task);
  check('two people, two items', both.length === 2, `${both.length} items`);
  check('each item belongs to its own owner',
    new Set(both.map(i => i.owner_user_id)).size === 2);

  return { task, items: both };
}

/* ── status is always an explicit act ──────────────────────────────── */

async function stageChecks({ orgId, userA, project }) {
  console.log('\nSTAGE — a progress note cannot close a task');

  const task = await mkTask(orgId, project);

  eq('only the three non-closing stages are offered',
    svc.LINKED_DAY_STAGES, ['yet_to_start', 'in_progress', 'in_review']);

  await expectCode("'completed' is refused before anything is created",
    'BAD_LINKED_STAGE', () =>
      svc.postTaskUpdate(orgId, userA, {
        playInstanceId: task, description: 'All done.',
        dayStage: 'completed', asOf: AS_OF }));

  await expectCode("'dropped' is refused too", 'BAD_LINKED_STAGE', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: task, description: 'Abandoned.',
      dayStage: 'dropped', asOf: AS_OF }));

  check('nothing was created by a refused post',
    (await itemsFor(orgId, task)).length === 0);

  // The same rule from the OTHER entry point. saveDay is reachable from My
  // day with an arbitrary itemId, so the guard has to live in the shared body
  // and not only in postTaskUpdate's pre-check.
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: task, description: 'Under way.', dayStage: 'in_progress', asOf: AS_OF });
  const [item] = await itemsFor(orgId, task);

  await expectCode('saveDay refuses a closing stage on a linked item',
    'LINKED_STAGE_NOT_CLOSABLE', () =>
      svc.saveDay(orgId, userA, [{
        itemId: item.id, description: 'Finished it.', dayStage: 'completed',
      }], { asOf: AS_OF }));

  const after = await itemsFor(orgId, task);
  eq('the refused save left the item open', after[0].status, 'in_progress');
  check('and left closed_at alone', after[0].closed_at == null);

  await expectOk("'in_review' IS accepted, and does not close the item", () =>
    svc.saveDay(orgId, userA, [{
      itemId: item.id, description: 'Sent it over.', dayStage: 'in_review',
    }], { asOf: AS_OF }));

  const reviewed = await itemsFor(orgId, task);
  eq('Rule 4 still writes the stage onto the item', reviewed[0].status, 'in_review');
  check('but nothing closed', reviewed[0].closed_at == null);
}

async function ordinaryItemStillWorks({ orgId, userA }) {
  console.log('\nSTAGE — ordinary items are unchanged');

  // The guard keys on play_instance_id, so an ordinary assigned item must
  // still be closeable from the day's stage exactly as before 2026_136.
  const item = await svc.createItem(orgId, userA, {
    kind: 'assigned', title: 'DWTASK ordinary assigned',
  });

  // createItem leaves opened_on to the column DEFAULT, which is the DATABASE's
  // CURRENT_DATE — the real today, not the date this harness is pinned to. The
  // entry would then predate its own item and be refused by ITEM_NOT_OPEN_YET,
  // which would be the harness's clock failing rather than the service.
  //
  // Pinned here rather than by dropping asOf, because every other assertion in
  // this file depends on the pin. postTaskUpdate does not need this: it sets
  // opened_on to the day being logged, which is the whole point of that line.
  await q(`UPDATE daily_work_items SET opened_on = $2 WHERE id = $1`, [item.id, TODAY]);

  await expectOk("an ordinary assigned item still accepts 'completed'", () =>
    svc.saveDay(orgId, userA, [{
      itemId: item.id, description: 'Done and dusted.', dayStage: 'completed',
    }], { asOf: AS_OF }));

  const { rows: [after] } = await q(
    `SELECT status, closed_at FROM daily_work_items WHERE id = $1`, [item.id]);
  eq('and still closes', after.status, 'completed');
  check('with closed_at set', after.closed_at != null);
}

/* ── the backfill window ───────────────────────────────────────────── */

async function backfillChecks({ orgId, userA, project }) {
  console.log('\nBACKFILL — the window, and opened_on');

  // The Monday-morning writeup. Left at the CURRENT_DATE default, the very
  // first post on a task could never be backfilled: the item would be born
  // today and then refuse the day being logged.
  const t1 = await mkTask(orgId, project);
  const r = await expectOk('a first update can be backfilled', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: t1, description: 'What I did on Friday.',
      dayStage: 'in_progress', date: day(-2), asOf: AS_OF }));
  eq('the entry landed on the day requested', r?.entryDate, day(-2));

  const [i1] = await itemsFor(orgId, t1);
  eq('the item opened on that day, not today', i1.opened_on, day(-2));

  // Backfilling FURTHER than before, after the item already exists.
  const t2 = await mkTask(orgId, project);
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: t2, description: 'Today.', dayStage: 'in_progress', asOf: AS_OF });
  await expectOk('an existing item accepts an earlier day', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: t2, description: 'Three days ago.',
      dayStage: 'in_progress', date: day(-3), asOf: AS_OF }));

  const [i2] = await itemsFor(orgId, t2);
  eq('opened_on was lowered to reach it', i2.opened_on, day(-3));

  // ...and never moves forward again. An item that has held a day keeps it.
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: t2, description: 'Today again.', dayStage: 'in_progress', asOf: AS_OF });
  const [i2b] = await itemsFor(orgId, t2);
  eq('opened_on does not move forward', i2b.opened_on, day(-3));

  const e2 = await entriesFor(i2.id);
  check('both days are separate rows', e2.length === 2, `${e2.length} entries`);

  // is_continuation is NOT in the upsert's DO UPDATE list — it is computed
  // once, at insert, and left alone afterwards. Same reasoning as written_on:
  // it records what was true when the day was first written up. Today's row
  // was written before the earlier day existed, so it stays false even though
  // an earlier entry now sits behind it. Asserted rather than assumed, because
  // adding it to the DO UPDATE list would look like a tidy-up and would
  // silently rewrite pilot instrumentation.
  check('a later backfill does not rewrite an existing row',
    e2.find(e => e.entry_date === TODAY)?.is_continuation === false,
    'is_continuation was recomputed on update — check the DO UPDATE list');

  // The flag itself, tested the way it is actually produced: an earlier day
  // already on file when the later one is written.
  const t2b = await mkTask(orgId, project);
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: t2b, description: 'Two days ago.',
    dayStage: 'in_progress', date: day(-2), asOf: AS_OF });
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: t2b, description: 'Carried on today.',
    dayStage: 'in_progress', asOf: AS_OF });

  const [i2b2] = await itemsFor(orgId, t2b);
  const e2b = await entriesFor(i2b2.id);
  check('a day written after an earlier one is marked as carried over',
    e2b.find(e => e.entry_date === TODAY)?.is_continuation === true,
    `is_continuation is ${e2b.find(e => e.entry_date === TODAY)?.is_continuation}`);
  check('and the earlier day is not',
    e2b.find(e => e.entry_date === day(-2))?.is_continuation === false);

  // The window itself is unchanged — the same numbers POST /day enforces.
  const t3 = await mkTask(orgId, project);
  await expectCode(`${svc.BACKFILL_DAYS + 1} days back is refused`,
    'OUTSIDE_BACKFILL_WINDOW', () =>
      svc.postTaskUpdate(orgId, userA, {
        playInstanceId: t3, description: 'Too long ago.',
        dayStage: 'in_progress', date: day(-(svc.BACKFILL_DAYS + 1)), asOf: AS_OF }));

  await expectCode('tomorrow is refused', 'FUTURE_DATE', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: t3, description: 'Work I have not done.',
      dayStage: 'in_progress', date: day(1), asOf: AS_OF }));

  check('neither refusal created an item', (await itemsFor(orgId, t3)).length === 0);
}

/* ── one transaction ───────────────────────────────────────────────── */

async function atomicityChecks({ orgId, userA, project }) {
  console.log('\nATOMICITY — a refused entry leaves no item behind');

  // The reason find-or-create and the entry share a transaction. Split in
  // two, every one of these would leave a row on the person's My day for work
  // they were just told was not saved.
  const blank = await mkTask(orgId, project);
  await expectCode('a blank description is refused', 'BLANK_DESCRIPTION', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: blank, description: '   ', dayStage: 'in_progress', asOf: AS_OF }));
  check('no item was left behind by the blank save',
    (await itemsFor(orgId, blank)).length === 0);

  const long = await mkTask(orgId, project);
  await expectCode('an over-long description is refused', 'DESCRIPTION_TOO_LONG', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: long, description: 'x'.repeat(svc.MAX_DESCRIPTION + 1),
      dayStage: 'in_progress', asOf: AS_OF }));
  check('no item was left behind by the over-long save',
    (await itemsFor(orgId, long)).length === 0);
}

/* ── the refusals about the work itself ────────────────────────────── */

async function closedWorkChecks({ orgId, userA, project, mkProject }) {
  console.log('\nREFUSALS — closed work has nowhere to be counted');

  await expectCode('an unknown task is refused', 'NO_SUCH_TASK', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: 2147483000, description: 'Nowhere.',
      dayStage: 'in_progress', asOf: AS_OF }));

  const closed = await mkTask(orgId, project);
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: closed, description: 'Some work.', dayStage: 'in_progress', asOf: AS_OF });

  await q(`UPDATE project_play_instances SET status = 'completed', completed_at = now()
            WHERE id = $1`, [closed]);

  // The trigger from 2026_136 should have closed the item as it went.
  const [closedItem] = await itemsFor(orgId, closed);
  eq('completing the task closed the item', closedItem.status, 'completed');

  await expectCode('a closed task refuses further updates', 'TASK_CLOSED', () =>
    svc.postTaskUpdate(orgId, userA, {
      playInstanceId: closed, description: 'One more thing.',
      dayStage: 'in_progress', asOf: AS_OF }));

  const deadProject = await mkProject('DWTASK Cancelled Project');
  const orphan = await mkTask(orgId, deadProject);
  await q(`UPDATE sales_handovers SET status = 'cancelled' WHERE id = $1`, [deadProject]);
  await expectCode('a cancelled project refuses updates on its tasks',
    'PROJECT_CLOSED', () =>
      svc.postTaskUpdate(orgId, userA, {
        playInstanceId: orphan, description: 'Still going.',
        dayStage: 'in_progress', asOf: AS_OF }));

  // Retirement is a timestamp, not a status, so it needs its own predicate —
  // this is the assertion that catches someone simplifying that away.
  const standing = await mkProject('DWTASK Standing', 'standing');
  const standingTask = await mkTask(orgId, standing);
  await q(`UPDATE sales_handovers SET retired_at = now(), retired_by = $2 WHERE id = $1`,
    [standing, userA]);
  await expectCode('a retired initiative refuses updates on its tasks',
    'PROJECT_CLOSED', () =>
      svc.postTaskUpdate(orgId, userA, {
        playInstanceId: standingTask, description: 'Still going.',
        dayStage: 'in_progress', asOf: AS_OF }));
}

/* ── the item is not editable from Daily Work ──────────────────────── */

async function updateItemChecks({ orgId, userA, project }) {
  console.log('\nGUARDS — a linked item is owned by its task');

  const task = await mkTask(orgId, project, 'Original task name');
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: task, description: 'Started.', dayStage: 'in_progress', asOf: AS_OF });
  const [item] = await itemsFor(orgId, task);

  await expectCode('renaming is refused', 'LINKED_ITEM_TITLE', () =>
    svc.updateItem(orgId, userA, item.id, { title: 'My own name for it' }));

  await expectCode('re-anchoring is refused', 'LINKED_ITEM_ANCHOR', () =>
    svc.updateItem(orgId, userA, item.id, { anchorKind: 'handover', anchorId: project }));

  await expectCode('a target date is refused', 'LINKED_ITEM_TARGET', () =>
    svc.updateItem(orgId, userA, item.id, { targetDate: day(3) }));

  // "Stop tracking this" would send exactly this. Retiring the item directly
  // would leave a live task whose next update has nowhere to go.
  await expectCode('retiring is refused', 'LINKED_ITEM_STATUS', () =>
    svc.updateItem(orgId, userA, item.id, { status: 'retired' }));

  await expectCode('so is any other status', 'LINKED_ITEM_STATUS', () =>
    svc.updateItem(orgId, userA, item.id, { status: 'completed' }));

  // The activity type is NOT refused, and should not be: the vocabulary is a
  // daily work concept the task knows nothing about, and classifying your own
  // work is the point of it.
  const reclassified = await expectOk('the activity type can still be set', () =>
    svc.updateItem(orgId, userA, item.id, { activityTypeKey: 'development' }));
  eq('and it took', reclassified?.activity_type_key, 'development');

  const [after] = await itemsFor(orgId, task);
  eq('the title is still the task name', after.title, 'Original task name');
  eq('the anchor is still the project', after.anchor_id, project);
}

/* ── the composer's state ──────────────────────────────────────────── */

async function taskWorkChecks({ orgId, userA, userB, project }) {
  console.log('\nREAD — getTaskWork');

  const task = await mkTask(orgId, project, 'Shared task');
  await svc.postTaskUpdate(orgId, userA, {
    playInstanceId: task, description: 'Ana did the first half.',
    dayStage: 'in_progress', asOf: AS_OF });
  await svc.postTaskUpdate(orgId, userB, {
    playInstanceId: task, description: 'Ben did the second.',
    dayStage: 'in_progress', asOf: AS_OF });

  const state = await expectOk('the composer state loads', () =>
    svc.getTaskWork(orgId, userA, task, { asOf: AS_OF }));

  eq('it names the task', state?.task?.title, 'Shared task');
  eq('it carries the project id for the permission check',
    state?.task?.handoverId, project);
  check('the work is postable', state?.canPost === true);
  eq('it offers the three non-closing stages', state?.stages,
    ['yet_to_start', 'in_progress', 'in_review']);
  eq('today is resolved server-side', state?.today, TODAY);
  eq('and the earliest day the window allows', state?.earliest, day(-svc.BACKFILL_DAYS));
  check("it returns the viewer's own item", state?.item?.owner_user_id === userA);

  // The deliberate widening: one task's updates, to people who can already
  // read and write notes on that same task. A feed showing each person only
  // their own half would leave the task looking untouched to everyone but the
  // last person to type.
  check('the feed carries BOTH people', (state?.feed || []).length === 2,
    `${(state?.feed || []).length} entries`);
  check('each entry is attributed',
    (state?.feed || []).every(f => f.first_name));

  // Reading a finished task is the reviewing case, and the one that matters
  // most — so the read answers, and canPost carries the refusal instead.
  await q(`UPDATE project_play_instances SET status = 'cancelled' WHERE id = $1`, [task]);
  const afterClose = await expectOk('a closed task still reads', () =>
    svc.getTaskWork(orgId, userA, task, { asOf: AS_OF }));
  check('but canPost is false', afterClose?.canPost === false);
  check('and the feed survives', (afterClose?.feed || []).length === 2);
}

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}`);
  console.log(`pinned to:   ${TODAY}\n`);

  let fx;
  try {
    fx = await setup();
    await firstPostChecks(fx);
    await reuseChecks(fx);
    await stageChecks(fx);
    await ordinaryItemStillWorks(fx);
    await backfillChecks(fx);
    await atomicityChecks(fx);
    await closedWorkChecks(fx);
    await updateItemChecks(fx);
    await taskWorkChecks(fx);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) {
      console.log(`\nWARNING: teardown failed — ${err.message}`);
      console.log(`The fixture org '${FIXTURE_ORG}' is STILL PRESENT.`);
      console.log('Delete daily_work_items before sales_handovers — the FK is NO ACTION.');
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('task-linked daily work verified.\n');
})();
