#!/usr/bin/env node
// test_dailyWorkMove_service.js
//
//   node test_dailyWorkMove_service.js
//
// Exercises the real dailyWorkMove.service.js — and the parts of
// dailyWork.service.js it changed — against a real database, from outside the
// repo. Same shape and the same require.cache substitution as
// test_taskLinkedWork_service.js; see test_dailyWork_service.js for why.
//
// Needs migration 2026_142 applied.
//
// What it covers:
//
//   new task         placement on a task created for the move: validation,
//                    dependency loops, every conflict kind, added scope on a
//                    frozen plan and none on a draft one, nothing created when
//                    the request is rejected, re-validation when batch 1 moves,
//                    and the added-scope count in plan vs actual
//
//   createRequest    who may raise, the item and entry refusals, approval rows
//                    for target and source projects, access granted to approvers
//   decide           who may decide, placement rules, what each approver may
//                    untick, rejection needs a reason
//   batches          entries added after an approval form a new batch; a later
//                    batch waits for batch 1 and moves with it; rejecting a
//                    later batch drops only its entries
//   the move         membership, assignee, linked item, re-point and re-tag,
//                    'moved' on assigned items, the recurring question
//   merge            text appended under a separator, evidence / notes /
//                    attachments copied with their original attribution,
//                    source deleted, needs_edit raised; too long left out with
//                    a reason and merged automatically once it fits — through
//                    the flagged editor and through the task composer
//   afterwards       Done clears the flag; retire-or-keep; saves and edits on a
//                    moved item refused; withdraw; review queue; visibility
//   moduleAccess     an admin save keeps a grant's source
//
// TIME IS PINNED where the backfill window matters: every save passes asOf.
//
// TEARDOWN ORDER MATTERS. Requests and items point at tasks with ON DELETE NO
// ACTION, and tasks cascade from projects, so requests and items go first.

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
  path.join(__dirname, '..'),
].filter(Boolean);

const REPO = REPO_CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'services', 'dailyWorkMove.service.js')); }
  catch { return false; }
});

if (!REPO) {
  console.error('\nCould not find the backend. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\nSet it explicitly:');
  console.error('  set DW_REPO=C:\\\\Projects\\\\action-crm-clean\\\\backend\n');
  process.exit(2);
}

/* ── substitute config/database before the services load ───────────── */

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 6,
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

const move = require(path.resolve(REPO, 'services', 'dailyWorkMove.service.js'));
const planVariance = require(path.resolve(REPO, 'services', 'planVariance.service.js'));
const dw = require(path.resolve(REPO, 'services', 'dailyWork.service.js'));
const moduleAccess = require(path.resolve(REPO, 'services', 'moduleAccess.service.js'));
console.log(`\ntesting: ${path.resolve(REPO, 'services', 'dailyWorkMove.service.js')}`);

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
const one = async (sql, params) => (await q(sql, params)).rows[0];

/* ── time ──────────────────────────────────────────────────────────── */

const AS_OF = new Date('2026-06-15T12:00:00Z');
const TODAY = '2026-06-15';
const day = (offset) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/* ── fixture ───────────────────────────────────────────────────────── */

const FIXTURE_ORG = 'DWMOVE_TEST_FIXTURE';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}')`;
  await q(`DELETE FROM daily_work_move_requests WHERE org_id = ${org}`);
  await q(`DELETE FROM daily_work_entries       WHERE org_id = ${org}`);
  await q(`DELETE FROM daily_work_items         WHERE org_id = ${org}`);
  await q(`DELETE FROM project_members          WHERE org_id = ${org}`);
  await q(`DELETE FROM sales_handovers          WHERE org_id = ${org}`);
  await q(`DELETE FROM user_module_access       WHERE org_id = ${org}`);
  await q(`DELETE FROM org_hierarchy            WHERE org_id = ${org}`);
  await q(`DELETE FROM org_users                WHERE org_id = ${org}`);
  await q(`DELETE FROM users                    WHERE org_id = ${org}`);
  await q(`DELETE FROM organizations            WHERE name = '${FIXTURE_ORG}'`);
}

async function setup() {
  await teardown();
  const { id: orgId } = await one(
    `INSERT INTO organizations (name, slug, settings)
     VALUES ($1, 'dwmove-test-fixture',
             '{"modules":{"dailywork":{"allowed":true,"enabled":true},"handovers":{"allowed":true,"enabled":true}}}')
     RETURNING id`, [FIXTURE_ORG]);

  const mkUser = async (first, role = 'member') => {
    const { id } = await one(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id, timezone)
       VALUES ($1, 'x', $2, 'Fixture', $3, 'UTC') RETURNING id`,
      [`dwmove.${first.toLowerCase()}.${Date.now()}@fixture.invalid`, first, orgId]);
    await q(`INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1, $2, $3, TRUE)`,
      [orgId, id, role]);
    return id;
  };

  // Ana does the work; Mo is her manager; Pat runs Target and the initiative;
  // Sam runs Source; Zed is in the org and has no say over any of it.
  const ana = await mkUser('Ana');
  const mo  = await mkUser('Mo');
  const pat = await mkUser('Pat');
  const sam = await mkUser('Sam');
  const zed = await mkUser('Zed');
  await q(`INSERT INTO org_hierarchy (org_id, user_id, reports_to) VALUES ($1, $2, $3)`, [orgId, ana, mo]);
  // Ana and Mo already have Daily Work, as anyone using it would.
  for (const u of [ana, mo]) {
    await q(`INSERT INTO user_module_access (org_id, user_id, module_key) VALUES ($1, $2, 'dailywork')`,
      [orgId, u]);
  }

  const mkProject = async (name, mode, owner, status = 'in_progress') => (await one(
    `INSERT INTO sales_handovers (org_id, name, project_kind, tracking_mode, status, created_by)
     VALUES ($1, $2, 'internal', $3, $4, $5) RETURNING id`,
    [orgId, name, mode, status, owner])).id;

  const target = await mkProject('Move Target', 'timeboxed', pat);
  const source = await mkProject('Move Source', 'timeboxed', sam);
  const init   = await mkProject('Move Initiative', 'standing', pat);
  const closed = await mkProject('Move Closed', 'timeboxed', pat, 'completed');

  let seq = 0;
  const mkTask = async (handoverId, status = 'in_progress') => (await one(
    `INSERT INTO project_play_instances (handover_id, org_id, stage_key, title, status, sort_order)
     VALUES ($1, $2, 'custom', $3, $4, $5) RETURNING id`,
    [handoverId, orgId, `Move task ${++seq}`, status, seq * 10])).id;

  return {
    orgId, ana, mo, pat, sam, zed, target, source, init, closed,
    t1: await mkTask(target), tDone: await mkTask(target, 'completed'), s1: await mkTask(source),
    mkTask,
  };
}

let itemSeq = 0;
async function mkItem(f, { kind = 'assigned', anchorKind = null, anchorId = null } = {}) {
  return (await one(
    `INSERT INTO daily_work_items (org_id, owner_user_id, kind, title, status, anchor_kind, anchor_id, opened_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01') RETURNING id`,
    [f.orgId, f.ana, kind, `Move item ${++itemSeq}`, kind === 'assigned' ? 'in_progress' : 'active',
     anchorKind, anchorId])).id;
}

async function mkEntry(f, itemId, date, { text = 'work done', anchorKind = null, anchorId = null } = {}) {
  return (await one(
    `INSERT INTO daily_work_entries
       (org_id, item_id, user_id, entry_date, description, day_stage, anchor_kind, anchor_id, written_on)
     VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, $4) RETURNING id`,
    [f.orgId, itemId, f.ana, date, text, anchorKind, anchorId])).id;
}

const entryRow = (id) => one(`SELECT *, entry_date::text AS d FROM daily_work_entries WHERE id = $1`, [id]);
const moveRows = (requestId) => q(
  `SELECT *, snap_entry_date::text AS snap_date FROM daily_work_move_entries
    WHERE request_id = $1 ORDER BY snap_entry_date, id`, [requestId])
  .then(r => r.rows);

/* ── A. raising ────────────────────────────────────────────────────── */

async function raising(f) {
  console.log('\nRAISING A REQUEST');

  const item = await mkItem(f);
  const e1 = await mkEntry(f, item, day(-10));
  const e2 = await mkEntry(f, item, day(-9), { anchorKind: 'handover', anchorId: f.source });

  await expectCode('someone outside the owner\'s chain cannot raise it', 'NOT_YOUR_ITEM',
    () => move.createRequest(f.orgId, f.zed, { itemId: item, targetHandoverId: f.target, entryIds: [e1] }));

  const res = await expectOk('her manager can raise it for her',
    () => move.createRequest(f.orgId, f.mo, { itemId: item, targetHandoverId: f.target, entryIds: [e1, e2] }));
  const r = res && res.request;
  if (!r) return null;

  eq('it is pending and open', [r.status, r.is_open], ['pending', true]);
  eq('the requester is recorded', r.requested_by, f.mo);
  const roles = r.approvals.map(a => [a.role, a.handover_id]).sort();
  eq('the target and the tagged source project must both approve',
    roles, [['source', f.source], ['target', f.target]].sort());
  eq('both entries are in batch 1', r.entries.length, 2);

  const grants = (await q(
    `SELECT user_id, source, source_move_request_id FROM user_module_access
      WHERE org_id = $1 AND module_key = 'dailywork' AND source IS NOT NULL ORDER BY user_id`,
    [f.orgId])).rows;
  eq('the two approvers were granted Daily Work, marked as for this request',
    grants.map(g => [g.user_id, g.source, g.source_move_request_id]),
    [[f.pat, 'move_request_approver', r.id], [f.sam, 'move_request_approver', r.id]].sort((a, b) => a[0] - b[0]));
  eq('the response lists who was granted', [...res.grantedUserIds].sort(), [f.pat, f.sam].sort());

  await expectCode('a second open request on the item is refused', 'REQUEST_ALREADY_OPEN',
    () => move.createRequest(f.orgId, f.ana, { itemId: item, targetHandoverId: f.target }));

  const other = await mkItem(f);
  await expectCode('a closed target project is refused', 'PROJECT_CLOSED',
    () => move.createRequest(f.orgId, f.ana, { itemId: other, targetHandoverId: f.closed }));
  await expectCode('an entry from another item is refused', 'ENTRY_NOT_ON_ITEM',
    () => move.createRequest(f.orgId, f.ana, { itemId: other, targetHandoverId: f.target, entryIds: [e1] }));

  const initItem = await mkItem(f, { anchorKind: 'handover', anchorId: f.init });
  await expectCode('an item tagged to another standing initiative is refused', 'ITEM_ON_OTHER_INITIATIVE',
    () => move.createRequest(f.orgId, f.ana, { itemId: initItem, targetHandoverId: f.target }));
  const intoOwn = await expectOk('the same item can move into its own initiative',
    () => move.createRequest(f.orgId, f.ana, { itemId: initItem, targetHandoverId: f.init }));
  if (intoOwn) await move.withdraw(f.orgId, f.ana, intoOwn.request.id);

  const initEntry = await mkEntry(f, other, day(-8), { anchorKind: 'handover', anchorId: f.init });
  await expectCode('an entry tagged to another standing initiative is refused', 'ENTRY_ON_OTHER_INITIATIVE',
    () => move.createRequest(f.orgId, f.ana, { itemId: other, targetHandoverId: f.target, entryIds: [initEntry] }));

  const linked = (await one(
    `INSERT INTO daily_work_items (org_id, owner_user_id, kind, title, status, anchor_kind, anchor_id, play_instance_id)
     VALUES ($1, $2, 'assigned', 'already linked', 'in_progress', 'handover', $3, $4) RETURNING id`,
    [f.orgId, f.ana, f.source, f.s1])).id;
  await expectCode('an item already on a task is refused', 'ITEM_ALREADY_ON_TASK',
    () => move.createRequest(f.orgId, f.ana, { itemId: linked, targetHandoverId: f.target }));

  const closedItem = await mkItem(f);
  await q(`UPDATE daily_work_items SET status = 'completed', closed_at = now() WHERE id = $1`, [closedItem]);
  await expectCode('a closed item is refused', 'ITEM_CLOSED',
    () => move.createRequest(f.orgId, f.ana, { itemId: closedItem, targetHandoverId: f.target }));

  return { requestId: r.id, item, e1, e2 };
}

/* ── B. deciding, batches and the move ─────────────────────────────── */

async function decidingAndMoving(f, a) {
  console.log('\nDECIDING, BATCHES AND THE MOVE');
  const { requestId, item, e1, e2 } = a;

  await expectCode('someone who manages neither project cannot decide', 'NOT_PROJECT_MANAGER',
    () => move.decide(f.orgId, f.zed, requestId, { handoverId: f.target, decision: 'approve' }));
  await expectCode('the target must choose a task', 'PLACEMENT_REQUIRED',
    () => move.decide(f.orgId, f.pat, requestId, { handoverId: f.target, decision: 'approve' }));
  await expectCode('a new task needs a title', 'BLANK_TASK_TITLE',
    () => move.decide(f.orgId, f.pat, requestId, {
      handoverId: f.target, decision: 'approve', placement: { newTask: { title: '  ' } } }));
  await expectCode('a closed task is refused', 'TASK_CLOSED',
    () => move.decide(f.orgId, f.pat, requestId, {
      handoverId: f.target, decision: 'approve', placement: { existingPlayInstanceId: f.tDone } }));
  await expectCode('a task on another project is refused', 'TASK_NOT_ON_PROJECT',
    () => move.decide(f.orgId, f.pat, requestId, {
      handoverId: f.target, decision: 'approve', placement: { existingPlayInstanceId: f.s1 } }));

  const rows = await moveRows(requestId);
  const m1 = rows.find(r => r.entry_id === e1);
  await expectCode('a source may not untick an entry that is not tagged to it', 'NOT_YOUR_ENTRY_TO_UNTICK',
    () => move.decide(f.orgId, f.sam, requestId, {
      handoverId: f.source, decision: 'approve', untickEntryIds: [m1.id] }));
  await expectCode('a source may not choose the task', 'PLACEMENT_NOT_YOURS',
    () => move.decide(f.orgId, f.sam, requestId, {
      handoverId: f.source, decision: 'approve', placement: { existingPlayInstanceId: f.t1 } }));
  await expectCode('a rejection needs a reason', 'REASON_REQUIRED',
    () => move.decide(f.orgId, f.sam, requestId, { handoverId: f.source, decision: 'reject' }));

  let r = await expectOk('the target approves onto an open task',
    () => move.decide(f.orgId, f.pat, requestId, {
      handoverId: f.target, decision: 'approve', placement: { existingPlayInstanceId: f.t1 } }));
  eq('nothing moves while the source has not decided',
    [r.status, (await entryRow(e1)).item_id], ['pending', item]);

  // Entries logged since. Pat has decided on batch 1, so these form batch 2.
  const e3 = await mkEntry(f, item, day(-2));
  r = (await expectOk('the requester adds a later entry',
    () => move.addEntries(f.orgId, f.mo, requestId, [e3])))?.request;
  eq('it went into a new batch, because batch 1 already has a decision',
    r.batches.map(b => [b.batch_no, b.status]), [[1, 'pending'], [2, 'pending']]);
  await expectCode('only the requester can add entries', 'NOT_REQUESTER',
    () => move.addEntries(f.orgId, f.ana, requestId, [e3]));

  r = await expectOk('the target approves batch 2',
    () => move.decide(f.orgId, f.pat, requestId, { handoverId: f.target, decision: 'approve' }));
  const b2 = r.batches.find(b => b.batch_no === 2);
  eq('batch 2 waits for batch 1, because there is no task yet', b2.status, 'pending');
  check('its entry has not moved', (await entryRow(e3)).item_id === item);

  r = await expectOk('the source approves batch 1',
    () => move.decide(f.orgId, f.sam, requestId, { handoverId: f.source, decision: 'approve' }));

  eq('both batches moved', r.batches.map(b => b.status), ['approved', 'approved']);
  eq('the request is approved and closed', [r.status, r.is_open, r.placement, r.play_instance_id],
    ['approved', false, 'existing_task', f.t1]);

  const linked = await one(
    `SELECT * FROM daily_work_items WHERE owner_user_id = $1 AND play_instance_id = $2`, [f.ana, f.t1]);
  check('Ana now has a linked item on the task', !!linked);
  eq('it was created by the approver who completed the move', linked && linked.created_by, f.sam);

  for (const [label, id] of [['untagged', e1], ['source-tagged', e2], ['batch 2', e3]]) {
    const e = await entryRow(id);
    eq(`the ${label} entry is on the task's item and tagged to the target`,
      [e.item_id, e.anchor_kind, e.anchor_id], [linked.id, 'handover', f.target]);
  }
  const e1row = await entryRow(e1);
  check('moving did not mark the entry edited', String(e1row.updated_at) === String(e1row.created_at),
    `created ${e1row.created_at}, updated ${e1row.updated_at}`);

  eq("the assigned item is 'moved'", (await one(`SELECT status FROM daily_work_items WHERE id = $1`, [item])).status, 'moved');
  const snap = (await moveRows(requestId)).find(m => m.entry_id === e2);
  eq('the snapshot still records the source tag', [snap.snap_anchor_kind, snap.snap_anchor_id], ['handover', f.source]);

  const member = await one(
    `SELECT status, side FROM project_members WHERE context_type = 'handover' AND context_id = $1 AND user_id = $2`,
    [f.target, f.ana]);
  eq('Ana is an approved member of the target project', member && [member.status, member.side], ['approved', 'delivery']);
  const assignee = await one(
    `SELECT 1 AS ok FROM project_play_assignees WHERE instance_id = $1 AND user_id = $2`, [f.t1, f.ana]);
  check('Ana is an assignee on the task', !!assignee);

  await expectCode('a save on the moved item is refused', 'ITEM_MOVED',
    () => dw.saveDay(f.orgId, f.ana, [{ itemId: item, description: 'more', dayStage: 'in_progress' }], { asOf: AS_OF }));
  await expectCode('editing the moved item is refused', 'ITEM_MOVED',
    () => dw.updateItem(f.orgId, f.ana, item, { title: 'renamed' }));
  const today = await dw.getDay(f.orgId, f.ana, { asOf: AS_OF });
  check('the moved item is not on My day for a date it has no entry',
    !today.rows.some(row => row.item_id === item));

  await expectCode('entries cannot be added once batch 1 has moved', 'REQUEST_NOT_ADDABLE',
    () => move.addEntries(f.orgId, f.mo, requestId, [e3]));
  await expectCode('there is nothing left to withdraw', 'REQUEST_NOT_OPEN',
    () => move.withdraw(f.orgId, f.mo, requestId));

  // Ana is on the project now, so she can post on the task — used below.
  return { linkedId: linked.id };
}

/* ── C. merging ────────────────────────────────────────────────────── */

async function merging(f) {
  console.log('\nMERGING INTO EXISTING TASK ENTRIES');

  const rec = await mkItem(f, { kind: 'recurring' });
  const dShort = day(-4), dLong = day(-3), dComposer = day(-1);

  // Ana has already logged on the task for these three days.
  // The composer day's task entry is long, so the pair is too long until Ana
  // shortens the TASK side — which is the path being tested for that day.
  for (const d of [dShort, dLong, dComposer]) {
    await dw.postTaskUpdate(f.orgId, f.ana, {
      playInstanceId: f.t1, dayStage: 'in_progress', date: d, asOf: AS_OF,
      description: d === dComposer ? 'T'.repeat(500) : `task work on ${d}` });
  }
  const onTask = async (d) => one(
    `SELECT e.* FROM daily_work_entries e JOIN daily_work_items i ON i.id = e.item_id
      WHERE i.owner_user_id = $1 AND i.play_instance_id = $2 AND e.entry_date = $3`, [f.ana, f.t1, d]);

  const sShort = await mkEntry(f, rec, dShort, { text: 'recurring work, short' });
  const sLong = await mkEntry(f, rec, dLong, { text: 'L'.repeat(1990) });
  const sComposer = await mkEntry(f, rec, dComposer, { text: 'C'.repeat(1900) });

  // Evidence and a note, with an attachment, on the entry that will merge.
  const ev = await one(
    `INSERT INTO play_evidence (org_id, daily_work_entry_id, channel, note, accepted_by, accepted_at)
     VALUES ($1, $2, 'manual', 'photo of the whiteboard', $3, '2026-06-11T10:00:00Z') RETURNING id`,
    [f.orgId, sShort, f.mo]);
  const note = await one(
    `INSERT INTO play_notes (org_id, daily_work_entry_id, author_id, body, created_at)
     VALUES ($1, $2, $3, 'blocked on labels', '2026-06-11T11:00:00Z') RETURNING id`,
    [f.orgId, sShort, f.mo]);
  await q(`INSERT INTO play_note_attachments (org_id, play_note_id, file_name, uploaded_by)
           VALUES ($1, $2, 'labels.csv', $3)`, [f.orgId, note.id, f.mo]);

  const { request } = await move.createRequest(f.orgId, f.ana, {
    itemId: rec, targetHandoverId: f.target, entryIds: [sShort, sLong, sComposer] });
  eq('no source project, so only the target approves', request.approvals.map(x => x.role), ['target']);

  const r = await expectOk('the target approves and the move runs at once',
    () => move.decide(f.orgId, f.pat, request.id, {
      handoverId: f.target, decision: 'approve', placement: { existingPlayInstanceId: f.t1 } }));
  const rows = await moveRows(request.id);
  const byDate = (d) => rows.find(m => m.snap_date === d);

  const short = byDate(dShort);
  eq('the short one merged and needs editing', [short.outcome, short.needs_edit], ['merged', true]);
  const merged = await onTask(dShort);
  check('the task entry now carries both texts under a separator',
    merged.description.startsWith(`task work on ${dShort}`)
      && merged.description.includes('— moved from')
      && merged.description.endsWith('recurring work, short'),
    merged.description);
  check('the source entry is gone', !(await entryRow(sShort)));
  eq('the move record keeps the snapshot', [short.entry_id, short.snap_description], [null, 'recurring work, short']);

  const copiedEv = await one(`SELECT * FROM play_evidence WHERE daily_work_entry_id = $1`, [merged.id]);
  eq('evidence was copied with its original acceptor and time',
    copiedEv && [copiedEv.note, copiedEv.accepted_by, new Date(copiedEv.accepted_at).toISOString()],
    ['photo of the whiteboard', f.mo, '2026-06-11T10:00:00.000Z']);
  check('the original evidence went with its entry',
    !(await one(`SELECT 1 AS x FROM play_evidence WHERE id = $1`, [ev.id])));
  const copiedNote = await one(`SELECT * FROM play_notes WHERE daily_work_entry_id = $1`, [merged.id]);
  eq('the note was copied with its author and time',
    copiedNote && [copiedNote.body, copiedNote.author_id, new Date(copiedNote.created_at).toISOString()],
    ['blocked on labels', f.mo, '2026-06-11T11:00:00.000Z']);
  const att = copiedNote && await one(`SELECT file_name FROM play_note_attachments WHERE play_note_id = $1`, [copiedNote.id]);
  eq('and its attachment came with it', att && att.file_name, 'labels.csv');
  eq('the copies are mapped back to the originals',
    [short.copied_evidence[0].from, short.copied_notes[0].from], [ev.id, note.id]);

  const long = byDate(dLong);
  eq('the long one was left out, with a reason', [long.outcome, !!long.left_out_reason], ['left_out_too_long', true]);
  check('and it has not moved', (await entryRow(sLong)).item_id === rec);
  eq('the recurring item stays active and its owner is asked', [
    (await one(`SELECT status FROM daily_work_items WHERE id = $1`, [rec])).status, r.recurring_decision],
    ['active', 'pending']);

  // ── auto-merge through the flagged editor ────────────────────────
  await expectCode('someone else cannot edit the flagged entry', 'NOT_YOUR_ENTRY',
    () => move.editFlaggedEntry(f.orgId, f.mo, long.id, { which: 'original', description: 'short now' }));
  await q(`UPDATE daily_work_entries SET next_steps = 'label the rest' WHERE id = $1`, [sLong]);
  const afterEdit = await expectOk('shortening the left-out entry through the editor',
    () => move.editFlaggedEntry(f.orgId, f.ana, long.id, { which: 'original', description: 'short now' }));
  eq('it merged automatically, and now needs editing', afterEdit && [afterEdit.outcome, afterEdit.needs_edit], ['merged', true]);
  check('the merged text ends with the shortened words', (await onTask(dLong)).description.endsWith('short now'));
  eq('editing only the description kept its next steps, and they merged too',
    (await onTask(dLong)).next_steps, 'label the rest');

  // ── auto-merge through the task composer (dailyWork._saveDayIn) ──
  const comp = byDate(dComposer);
  eq('the composer case starts left out', comp.outcome, 'left_out_too_long');
  await expectOk('Ana shortens the task entry in the composer',
    () => dw.postTaskUpdate(f.orgId, f.ana, {
      playInstanceId: f.t1, description: 'brief', dayStage: 'in_progress', date: dComposer, asOf: AS_OF }));
  const compAfter = (await moveRows(request.id)).find(m => m.id === comp.id);
  eq('the save merged it in the same transaction', compAfter.outcome, 'merged');
  check('the source entry is gone', !(await entryRow(sComposer)));

  // ── Done, and the recurring question ─────────────────────────────
  const done = await expectOk('Ana marks the merged entry done', () => move.markEntryDone(f.orgId, f.ana, short.id));
  eq('the flag is cleared', done && [done.needs_edit, !!done.needs_edit_cleared_at], [false, true]);
  await expectCode('marking it done twice is refused', 'NOT_FLAGGED', () => move.markEntryDone(f.orgId, f.ana, short.id));

  await expectCode('only the owner answers the recurring question', 'NOT_YOUR_ITEM',
    () => move.setRecurringDecision(f.orgId, f.mo, request.id, 'retire'));
  const kept = await expectOk('Ana retires the recurring item', () => move.setRecurringDecision(f.orgId, f.ana, request.id, 'retire'));
  eq('it is retired and the question is answered', kept && [kept.item_status, kept.recurring_decision], ['retired', 'retired']);

  const mine = await move.listMine(f.orgId, f.ana);
  check('My day still lists the merges waiting for Done',
    mine.flagged.filter(x => x.needs_edit).length === 2, JSON.stringify(mine.flagged.map(x => [x.id, x.needs_edit])));
}

/* ── D. rejecting and withdrawing ──────────────────────────────────── */

async function rejectingAndWithdrawing(f) {
  console.log('\nREJECTING AND WITHDRAWING');

  // Rejection on batch 1 ends the request.
  const item = await mkItem(f);
  const e = await mkEntry(f, item, day(-6), { anchorKind: 'handover', anchorId: f.source });
  const { request } = await move.createRequest(f.orgId, f.ana, { itemId: item, targetHandoverId: f.target, entryIds: [e] });
  const rej = await expectOk('the source rejects, with a reason',
    () => move.decide(f.orgId, f.sam, request.id, { handoverId: f.source, decision: 'reject', reason: 'still ours this sprint' }));
  eq('the request is rejected and closed', rej && [rej.status, rej.is_open], ['rejected', false]);
  eq('its entry is excluded and has not moved', [
    (await moveRows(request.id))[0].outcome, (await entryRow(e)).item_id], ['excluded', item]);
  await expectOk('the item can be asked about again', () => move.createRequest(f.orgId, f.ana, { itemId: item, targetHandoverId: f.target }));

  // Rejecting a LATER batch drops only that batch.
  const item2 = await mkItem(f);
  const a1 = await mkEntry(f, item2, day(-7), { anchorKind: 'handover', anchorId: f.source });
  const { request: r2 } = await move.createRequest(f.orgId, f.mo, { itemId: item2, targetHandoverId: f.target, entryIds: [a1] });
  await move.decide(f.orgId, f.pat, r2.id, { handoverId: f.target, decision: 'approve', placement: { existingPlayInstanceId: f.t1 } });
  const a2 = await mkEntry(f, item2, day(-5));
  await move.addEntries(f.orgId, f.mo, r2.id, [a2]);
  const afterReject = await expectOk('the target rejects batch 2',
    () => move.decide(f.orgId, f.pat, r2.id, { handoverId: f.target, decision: 'reject', reason: 'not task work' }));
  eq('batch 2 is rejected, the request is still waiting on batch 1',
    afterReject && [afterReject.status, afterReject.is_open, afterReject.batches.map(b => b.status)],
    ['pending', true, ['pending', 'rejected']]);
  const afterApprove = await expectOk('the source approves batch 1',
    () => move.decide(f.orgId, f.sam, r2.id, { handoverId: f.source, decision: 'approve' }));
  eq('batch 1 moved and the request closed', afterApprove && [afterApprove.status, afterApprove.is_open], ['approved', false]);
  check('the batch 2 entry stayed where it was', (await entryRow(a2)).item_id === item2);

  // Withdraw.
  const item3 = await mkItem(f);
  const { request: r3 } = await move.createRequest(f.orgId, f.mo, { itemId: item3, targetHandoverId: f.target });
  await expectCode('only the requester can withdraw', 'NOT_REQUESTER', () => move.withdraw(f.orgId, f.ana, r3.id));
  const w = await expectOk('the requester withdraws', () => move.withdraw(f.orgId, f.mo, r3.id));
  eq('it is withdrawn and closed', w && [w.status, w.is_open, w.batches[0].status], ['withdrawn', false, 'withdrawn']);
}

/* ── E. queue, visibility, membership edges, grants ────────────────── */

async function readsAndEdges(f) {
  console.log('\nQUEUE, VISIBILITY AND EDGES');

  const item = await mkItem(f);
  const e = await mkEntry(f, item, day(-11), { anchorKind: 'handover', anchorId: f.source });
  const { request } = await move.createRequest(f.orgId, f.ana, { itemId: item, targetHandoverId: f.target, entryIds: [e] });

  const patQ = await move.listReviewQueue(f.orgId, f.pat);
  const samQ = await move.listReviewQueue(f.orgId, f.sam);
  const zedQ = await move.listReviewQueue(f.orgId, f.zed);
  check("the request is in Pat's queue as target", patQ.some(x => x.request_id === request.id && x.role === 'target'));
  check("and in Sam's queue as source", samQ.some(x => x.request_id === request.id && x.role === 'source'));
  eq('Zed has nothing waiting', zedQ.length, 0);

  await expectCode('Zed cannot read it', 'NO_SUCH_REQUEST', () => move.getRequest(f.orgId, f.zed, request.id));
  await expectOk('the source manager can read it in full', () => move.getRequest(f.orgId, f.sam, request.id));
  await expectOk("Ana's manager can read it", () => move.getRequest(f.orgId, f.mo, request.id));

  // An internal-customer request to join is not approved through a move.
  await q(`INSERT INTO project_members (org_id, context_type, context_id, user_id, status, side)
           VALUES ($1, 'handover', $2, $3, 'pending', 'internal_customer')`, [f.orgId, f.source, f.ana]);
  const t = await f.mkTask(f.source);
  const item2 = await mkItem(f);
  const { request: r2 } = await move.createRequest(f.orgId, f.ana, { itemId: item2, targetHandoverId: f.source });
  await expectCode('a pending internal-customer seat blocks the move with a reason', 'MEMBERSHIP_NEEDS_ADMIN',
    () => move.decide(f.orgId, f.sam, r2.id, { handoverId: f.source, decision: 'approve', placement: { existingPlayInstanceId: t } }));
  eq('and nothing was written', (await one(`SELECT status FROM daily_work_move_requests WHERE id = $1`, [r2.id])).status, 'pending');

  // Someone who LEFT a project is brought back by a move.
  await q(`UPDATE project_members SET side = 'delivery', status = 'left', exited_at = now()
            WHERE context_id = $1 AND user_id = $2`, [f.source, f.ana]);
  await expectOk('the move re-approves a member who had left',
    () => move.decide(f.orgId, f.sam, r2.id, { handoverId: f.source, decision: 'approve', placement: { existingPlayInstanceId: t } }));
  const m = await one(`SELECT status, exited_at FROM project_members WHERE context_id = $1 AND user_id = $2`, [f.source, f.ana]);
  eq('approved, exit cleared', [m.status, m.exited_at], ['approved', null]);

  // An admin save of Pat's modules keeps the grant's source.
  await moduleAccess.setUserModules(f.orgId, f.pat, ['dailywork', 'handovers'], f.zed);
  const g = await one(`SELECT source FROM user_module_access WHERE org_id = $1 AND user_id = $2 AND module_key = 'dailywork'`,
    [f.orgId, f.pat]);
  eq('the source survives an Org Admin save', g && g.source, 'move_request_approver');
  const h = await one(`SELECT source FROM user_module_access WHERE org_id = $1 AND user_id = $2 AND module_key = 'handovers'`,
    [f.orgId, f.pat]);
  eq('a module the admin added carries no source', h && h.source, null);
}

/* ── F. two approvers finishing at the same moment ─────────────────── */

async function concurrency(f) {
  console.log('\nCONCURRENT DECISIONS');

  // The request row is locked first in decide(). Without that, both approvers
  // could see "every row approved" and both run the move.
  const item = await mkItem(f);
  const e = await mkEntry(f, item, day(-12), { anchorKind: 'handover', anchorId: f.source });
  const { request } = await move.createRequest(f.orgId, f.ana, { itemId: item, targetHandoverId: f.target, entryIds: [e] });

  const results = await Promise.allSettled([
    move.decide(f.orgId, f.pat, request.id, {
      handoverId: f.target, decision: 'approve', placement: { existingPlayInstanceId: f.t1 } }),
    move.decide(f.orgId, f.sam, request.id, { handoverId: f.source, decision: 'approve' }),
  ]);
  eq('both decisions succeed', results.map(x => x.status), ['fulfilled', 'fulfilled']);
  const final = await move.getRequest(f.orgId, f.ana, request.id);
  eq('the batch moved exactly once', [final.status, final.batches.map(b => b.status)], ['approved', ['approved']]);
  eq('the entry is on the task once', (await entryRow(e)).anchor_id, f.target);
  const linkedCount = await one(
    `SELECT count(*)::int AS n FROM daily_work_items WHERE owner_user_id = $1 AND play_instance_id = $2`, [f.ana, f.t1]);
  eq('there is still exactly one linked item', linkedCount.n, 1);

  await expectCode('deciding again is refused: the request is closed', 'REQUEST_NOT_OPEN',
    () => move.decide(f.orgId, f.sam, request.id, { handoverId: f.source, decision: 'approve' }));
}

/* ── G. a new task ─────────────────────────────────────────────────── */

async function newTask(f) {
  console.log('\nPLACEMENT ON A NEW TASK');

  // A frozen, timeboxed plan with a go-live and three gated stages.
  const { id: plan } = await one(
    `INSERT INTO sales_handovers (org_id, name, project_kind, tracking_mode, status, created_by,
                                  go_live_date, baseline_frozen_at)
     VALUES ($1, 'Frozen Plan', 'internal', 'timeboxed', 'in_progress', $2, '2026-07-31', now())
     RETURNING id`, [f.orgId, f.pat]);
  const { id: draft } = await one(
    `INSERT INTO sales_handovers (org_id, name, project_kind, tracking_mode, status, created_by)
     VALUES ($1, 'Draft Plan', 'internal', 'timeboxed', 'draft', $2) RETURNING id`, [f.orgId, f.pat]);
  for (const [key, name, order, gating] of [
      ['build', 'Build', 10, 'none'], ['test', 'Test', 20, 'strict'], ['launch', 'Launch', 30, 'gates']]) {
    await q(`INSERT INTO project_stages (handover_id, org_id, key, name, sort_order, gating)
             VALUES ($1, $2, $3, $4, $5, $6)`, [plan, f.orgId, key, name, order, gating]);
  }
  const mkTask = async (handoverId, stage, title, { status = 'not_started', due = null, dependsOn = null } = {}) =>
    (await one(
      `INSERT INTO project_play_instances
         (handover_id, org_id, stage_key, title, status, sort_order, due_date, depends_on)
       VALUES ($1, $2, $3, $4, $5, 10, $6, $7) RETURNING id`,
      [handoverId, f.orgId, stage, title, status, due, dependsOn])).id;

  const tPre  = await mkTask(plan, 'build', 'Prerequisite', { due: '2026-08-20' });
  const tDep  = await mkTask(plan, 'build', 'Dependent', { status: 'in_progress', due: '2026-07-01' });
  const tTest = await mkTask(plan, 'test', 'Test run');
  await mkTask(plan, 'launch', 'Launch prep');
  const tOther = await mkTask(f.source, 'custom', 'Elsewhere');

  // Ana already has an overdue task somewhere, for the load check.
  const late = await mkTask(f.source, 'custom', 'Late one', { due: '2026-06-01' });
  await q(`INSERT INTO project_play_assignees (instance_id, user_id) VALUES ($1, $2)`, [late, f.ana]);

  const item = await mkItem(f);
  const e = await mkEntry(f, item, day(-13));
  const { request } = await move.createRequest(f.orgId, f.ana, { itemId: item, targetHandoverId: plan, entryIds: [e] });

  const spec = {
    title: 'Annotate the circuit set', stageKey: 'Build', dueDate: '2026-08-10', isGate: false,
    dependsOn: [tPre], dependents: [tDep],
  };

  // ── validation ───────────────────────────────────────────────────
  await expectCode('only a manager of the target can check a new task', 'NOT_PROJECT_MANAGER',
    () => move.getConflicts(f.orgId, f.zed, request.id, spec));
  await expectCode('a stage the project does not have is refused', 'STAGE_NOT_ON_PROJECT',
    () => move.getConflicts(f.orgId, f.pat, request.id, { ...spec, stageKey: 'Deploy' }));
  await expectCode('an impossible date is refused', 'BAD_DATE',
    () => move.getConflicts(f.orgId, f.pat, request.id, { ...spec, dueDate: '2026-02-30' }));
  await expectCode('a task from another project is refused', 'TASK_NOT_ON_PROJECT',
    () => move.getConflicts(f.orgId, f.pat, request.id, { ...spec, dependents: [tOther] }));
  await expectCode('the same task before and after is refused', 'DEPENDENCY_CYCLE',
    () => move.getConflicts(f.orgId, f.pat, request.id, { ...spec, dependsOn: [tPre], dependents: [tPre] }));

  // tPre waits for tTest. New task waits for tPre, and tTest would wait for the
  // new task: tTest -> new -> tPre -> tTest.
  await q(`UPDATE project_play_instances SET depends_on = ARRAY[$2::int] WHERE id = $1`, [tPre, tTest]);
  await expectCode('a loop through existing dependencies is refused', 'DEPENDENCY_CYCLE',
    () => move.getConflicts(f.orgId, f.pat, request.id, { ...spec, dependents: [tTest] }));
  await q(`UPDATE project_play_instances SET depends_on = NULL WHERE id = $1`, [tPre]);

  // ── conflicts ────────────────────────────────────────────────────
  const c = await expectOk('the conflicts for a proposed task',
    () => move.getConflicts(f.orgId, f.pat, request.id, spec));
  const kinds = (c ? c.conflicts : []).map(x => `${x.kind}:${x.severity}`).sort();
  eq('each collision and note is reported, with its severity', kinds, [
    'added_scope:info', 'after_go_live:conflict', 'dependent_due_earlier:conflict',
    'dependent_started:info', 'locks_later_stage:info', 'owner_load:info', 'prerequisite_due_later:conflict',
  ].sort());
  // 'test' is ALREADY locked by the open prerequisite and dependent in Build,
  // so the new task adds to a lock rather than creating one.
  const lock = c && c.conflicts.find(x => x.kind === 'locks_later_stage');
  eq('the strict later stage is named, and already locked', lock && [lock.stageName, lock.alreadyLocked], ['Test', true]);
  check('a gates stage is not affected by a task that is not a gate',
    !c.conflicts.some(x => x.kind === 'locks_later_stage' && x.stageName === 'Launch'));
  const loadRow = c && c.conflicts.find(x => x.kind === 'owner_load');
  eq("Ana's overdue task is counted", loadRow && loadRow.overdue, 1);
  eq('the plan is frozen, so it is added scope', c && c.addedScope, true);

  const asGate = await move.getConflicts(f.orgId, f.pat, request.id, { ...spec, isGate: true });
  check('as a gate, the gates stage is affected too',
    asGate.conflicts.some(x => x.kind === 'locks_later_stage' && x.stageName === 'Launch'));

  // With Build otherwise clear, the lock on Test is new — a conflict.
  await q(`UPDATE project_play_instances SET status = 'completed', completed_at = now()
            WHERE id = ANY($1::int[])`, [[tPre, tDep]]);
  const fresh = await move.getConflicts(f.orgId, f.pat, request.id, { ...spec, dependsOn: [], dependents: [] });
  const freshLock = fresh.conflicts.find(x => x.kind === 'locks_later_stage');
  eq('a lock on a stage that was free is a conflict', freshLock && [freshLock.severity, freshLock.notStarted], ['conflict', 1]);
  await q(`UPDATE project_play_instances SET status = 'not_started', completed_at = NULL WHERE id = $1`, [tPre]);
  await q(`UPDATE project_play_instances SET status = 'in_progress', completed_at = NULL WHERE id = $1`, [tDep]);

  // ── approving onto a new task ────────────────────────────────────
  const r = await expectOk('the target approves onto a new task',
    () => move.decide(f.orgId, f.pat, request.id, { handoverId: plan, decision: 'approve', placement: { newTask: spec } }));
  const appr = r && r.approvals.find(x => x.role === 'target');
  check('what the approver was shown is stored with the decision',
    appr && appr.placement === 'new_task' && Array.isArray(appr.new_task.conflictsAtDecision)
      && appr.new_task.conflictsAtDecision.some(x => x.kind === 'after_go_live'));
  eq('the move ran: approved onto a new task', r && [r.status, r.placement], ['approved', 'new_task']);

  const task = r && await one(
    `SELECT *, due_date::text AS d, baseline_due_date::text AS bd FROM project_play_instances WHERE id = $1`,
    [r.play_instance_id]);
  eq('the task has the title, stage, date and owner asked for',
    task && [task.title, task.stage_key, task.d, task.owner_user_id, task.status],
    ['Annotate the circuit set', 'build', '2026-08-10', f.ana, 'not_started']);
  eq('it is marked as added scope by this request',
    task && [task.added_by_move_request_id, task.scope_added_at != null], [request.id, true]);
  eq('on the frozen plan it is born with its baseline, as addPlay does',
    task && [task.bd, task.baseline_source], ['2026-08-10', 'original']);
  eq('it waits for the prerequisite', task && task.depends_on, [tPre]);
  const dep = await one(`SELECT depends_on FROM project_play_instances WHERE id = $1`, [tDep]);
  check('the dependent now waits for it', dep.depends_on.includes(task.id));
  check('Ana is its assignee', !!(await one(
    `SELECT 1 AS ok FROM project_play_assignees WHERE instance_id = $1 AND user_id = $2`, [task.id, f.ana])));
  const moved = await entryRow(e);
  const linked = await one(`SELECT id FROM daily_work_items WHERE owner_user_id = $1 AND play_instance_id = $2`, [f.ana, task.id]);
  eq('the entry moved onto it', [moved.item_id, moved.anchor_id], [linked && linked.id, plan]);

  const variance = await planVariance.getProjectVariance(plan, f.orgId);
  eq('plan vs actual counts one added task', variance.summary.addedScope, 1);
  check('and marks it on the row',
    variance.plays.some(p => p.id === task.id && p.scopeAddedAt != null && p.addedByMoveRequestId === request.id));

  // ── a draft plan: part of the plan, not added to it ───────────────
  const item2 = await mkItem(f);
  const { request: r2 } = await move.createRequest(f.orgId, f.ana, { itemId: item2, targetHandoverId: draft });
  const d2 = await expectOk('approving onto a new task on a draft plan',
    () => move.decide(f.orgId, f.pat, r2.id, { handoverId: draft, decision: 'approve',
      placement: { newTask: { title: 'Draft work', dueDate: '2026-09-01' } } }));
  const t2 = d2 && await one(`SELECT stage_key, scope_added_at, baseline_due_date, baseline_source
                                FROM project_play_instances WHERE id = $1`, [d2.play_instance_id]);
  eq('no added-scope marker and no baseline yet, in the ad-hoc stage',
    t2 && [t2.stage_key, t2.scope_added_at, t2.baseline_due_date, t2.baseline_source],
    ['custom', null, null, null]);

  // ── nothing is created when the request is rejected ───────────────
  const item3 = await mkItem(f);
  const e3 = await mkEntry(f, item3, day(-14), { anchorKind: 'handover', anchorId: f.source });
  const { request: r3 } = await move.createRequest(f.orgId, f.ana, { itemId: item3, targetHandoverId: plan, entryIds: [e3] });
  await move.decide(f.orgId, f.pat, r3.id, { handoverId: plan, decision: 'approve',
    placement: { newTask: { title: 'Never made', stageKey: 'build' } } });
  check('while the source has not decided, no task exists',
    !(await one(`SELECT 1 AS x FROM project_play_instances WHERE added_by_move_request_id = $1`, [r3.id])));
  await move.decide(f.orgId, f.sam, r3.id, { handoverId: f.source, decision: 'reject', reason: 'keep it with us' });
  check('after a rejection, still no task',
    !(await one(`SELECT 1 AS x FROM project_play_instances WHERE added_by_move_request_id = $1`, [r3.id])));

  // ── re-validated when batch 1 moves ───────────────────────────────
  const item4 = await mkItem(f);
  const e4 = await mkEntry(f, item4, day(-15), { anchorKind: 'handover', anchorId: f.source });
  const { request: r4 } = await move.createRequest(f.orgId, f.ana, { itemId: item4, targetHandoverId: plan, entryIds: [e4] });
  await move.decide(f.orgId, f.pat, r4.id, { handoverId: plan, decision: 'approve',
    placement: { newTask: { title: 'Late stage', stageKey: 'launch' } } });
  await q(`UPDATE project_stages SET is_active = FALSE WHERE handover_id = $1 AND key = 'launch'`, [plan]);
  await expectCode('a stage removed since the approval stops the move, with the reason', 'STAGE_NOT_ON_PROJECT',
    () => move.decide(f.orgId, f.sam, r4.id, { handoverId: f.source, decision: 'approve' }));
  eq('and nothing was written', [
    (await one(`SELECT status FROM daily_work_move_requests WHERE id = $1`, [r4.id])).status,
    (await entryRow(e4)).item_id], ['pending', item4]);
  const rechosen = await expectOk('the target re-chooses the task on batch 1',
    () => move.decide(f.orgId, f.pat, r4.id, { handoverId: plan, decision: 'approve', batchId: r4.batches[0].id,
      placement: { newTask: { title: 'Late stage', stageKey: 'test' } } }));
  eq('still waiting on the source', rechosen && rechosen.status, 'pending');
  const done4 = await expectOk('the source approves', () => move.decide(f.orgId, f.sam, r4.id, { handoverId: f.source, decision: 'approve' }));
  eq('it moved onto a task in the re-chosen stage', done4 && (await one(
    `SELECT stage_key FROM project_play_instances WHERE id = $1`, [done4.play_instance_id])).stage_key, 'test');
}

/* ── H. reads for the screens ──────────────────────────────────────── */

async function screenReads(f) {
  console.log('\nREADS FOR THE SCREENS');

  const tagged = await mkItem(f, { anchorKind: 'handover', anchorId: f.source });
  const eA = await mkEntry(f, tagged, day(0), { anchorKind: 'handover', anchorId: f.source });
  const eB = await mkEntry(f, tagged, day(-1), { anchorKind: 'handover', anchorId: f.init });

  await expectCode('someone outside the chain cannot see the options', 'NO_SUCH_ITEM',
    () => move.getMoveOptions(f.orgId, f.zed, tagged));
  const opt = await expectOk("Ana's manager gets the options", () => move.getMoveOptions(f.orgId, f.mo, tagged));
  eq('the item can move, with no locked target', opt && [opt.item.movable, opt.item.lockedTargetId], [true, null]);
  eq('entries newest first, with the initiative tag flagged',
    opt && opt.entries.map(e => [e.id, e.anchor_is_standing]), [[eA, false], [eB, true]]);
  check('closed projects are not offered as targets', opt && !opt.targets.some(t => t.id === f.closed));
  check('open projects and initiatives are', opt && [f.target, f.source, f.init].every(id => opt.targets.some(t => t.id === id)));

  const onInit = await mkItem(f, { anchorKind: 'handover', anchorId: f.init });
  const optInit = await move.getMoveOptions(f.orgId, f.ana, onInit);
  eq('an item on an initiative can only go to that initiative',
    [optInit.item.lockedTargetId, optInit.targets.map(t => t.id)], [f.init, [f.init]]);

  // My day: the prompt condition and the open request.
  let dayRows = (await dw.getDay(f.orgId, f.ana, { asOf: AS_OF })).rows;
  const row = dayRows.find(r => r.item_id === tagged);
  eq('the tagged item is flagged for the prompt, with no request yet',
    row && [row.on_project_not_plan, row.open_move_request_id], [true, null]);
  eq('an item on an initiative is not prompted', dayRows.find(r => r.item_id === onInit).on_project_not_plan, false);

  const { request } = await move.createRequest(f.orgId, f.ana, { itemId: tagged, targetHandoverId: f.source, entryIds: [eA] });
  dayRows = (await dw.getDay(f.orgId, f.ana, { asOf: AS_OF })).rows;
  eq('once asked, the row carries the open request', dayRows.find(r => r.item_id === tagged).open_move_request_id, request.id);
  const optAfter = await move.getMoveOptions(f.orgId, f.ana, tagged);
  eq('and the options say why it cannot be asked again',
    [optAfter.item.movable, optAfter.entries.find(e => e.id === eA).in_other_request], [false, true]);

  await expectCode('placement options are for the target manager only', 'NOT_PROJECT_MANAGER',
    () => move.getPlacementOptions(f.orgId, f.pat, request.id));
  const place = await expectOk('the target manager gets tasks and stages',
    () => move.getPlacementOptions(f.orgId, f.sam, request.id));
  check('the project\'s task is listed with its status', place && place.tasks.some(t => t.id === f.s1 && t.status));
  eq('the item title is offered for a new task', place && place.itemTitle,
    (await one(`SELECT title FROM daily_work_items WHERE id = $1`, [tagged])).title);
}

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  let f;
  try {
    f = await setup();
    const a = await raising(f);
    if (a) await decidingAndMoving(f, a);
    await merging(f);
    await rejectingAndWithdrawing(f);
    await readsAndEdges(f);
    await concurrency(f);
    await newTask(f);
    await screenReads(f);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) { console.log(`\nWARNING: teardown failed — ${err.message}`); }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(x => `  - ${x}`).join('\n')}`);
    process.exit(1);
  }
})();
