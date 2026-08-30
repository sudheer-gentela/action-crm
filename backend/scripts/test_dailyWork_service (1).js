#!/usr/bin/env node
// test_dailyWork_service.js
//
//   cd C:\Projects\dw-verify
//   node test_dailyWork_service.js
//
// Exercises the real dailyWork.service.js against a real database, from
// outside the repo.
//
// ── How it loads a repo module with no node_modules there ────────────
//
// dailyWork.service.js does `require('../config/database')` at load time, so
// there is no seam to inject through — and the repo has no node_modules, so
// that file could not load anyway. The harness therefore pre-populates
// require.cache for the resolved path of config/database.js with its own
// implementation, backed by the pg installed HERE.
//
// This is a test-only trick and it is worth being uneasy about, so: the
// substitute is a faithful copy of the real orgQuery/withOrgTransaction,
// including SET LOCAL app.current_org_id. If the real one changes, this must
// change with it. The alternative — installing node_modules in the app repo —
// was ruled out, and stubbing the database entirely would test nothing, since
// every rule in this service is enforced partly by Postgres.
//
// ── Isolation ────────────────────────────────────────────────────────
//
// Fixture org, torn down in a finally, exactly as the migration harnesses do.
// NOT rollback-based: the service opens its own transactions through
// withOrgTransaction, so an outer BEGIN here would be invisible to it. That
// was learned the hard way earlier in this build.

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
  console.error('  set DW_REPO=C:\\Projects\\action-crm-clean\\backend\n');
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

// Faithful copy of the real helper, including the RLS session variable, so
// this keeps working unchanged if RLS is switched on later.
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

/* ── fixtures ──────────────────────────────────────────────────────── */

const FIXTURE_ORG = 'DWSVC_VERIFY_FIXTURE';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
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

async function setup() {
  await teardown();

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,'dwsvc-verify-fixture') RETURNING id`,
    [FIXTURE_ORG]);

  const mkUser = async (tz) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id, timezone)
       VALUES ($1,'x','Fix','Ture',$2,$3) RETURNING id`,
      [`dwsvc.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@fixture.invalid`, org.id, tz]);
    await q(`INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1,$2,'member',TRUE)`,
      [org.id, u.id]);
    return u.id;
  };

  const owner = await mkUser('Asia/Kolkata');
  const other = await mkUser('Asia/Kolkata');

  const inactive = await mkUser('Asia/Kolkata');
  await q(`UPDATE org_users SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
    [org.id, inactive]);

  // Departments are teams on an INTERNAL dimension. teams.dimension holds
  // team_dimensions.key — a string join, not an id.
  await q(`INSERT INTO team_dimensions (org_id, key, name, applies_to)
           VALUES ($1,'department','Department','internal')`, [org.id]);
  const { rows: [team] } = await q(
    `INSERT INTO teams (org_id, name, dimension, is_active)
     VALUES ($1,'Marketing','department',TRUE) RETURNING id`, [org.id]);
  await q(`INSERT INTO team_memberships (org_id, user_id, team_id, is_primary)
           VALUES ($1,$2,$3,TRUE)`, [org.id, owner, team.id]);

  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('Fixture Account',$1) RETURNING id`, [org.id]);
  // A second account, so the re-parenting test can move a project between two
  // real customers. Nulling the account is not possible — see below.
  const { rows: [account2] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('Fixture Account Two',$1) RETURNING id`, [org.id]);
  // sales_handovers has two CHECKs a fixture has to satisfy, neither of them
  // a NOT NULL:
  //   name_required  — a handover needs a deal_id OR a non-blank name
  //   kind_shape     — project_kind 'customer' needs account_id or deal_id,
  //                    and project_kind 'internal' must have NEITHER
  const { rows: [handover] } = await q(
    `INSERT INTO sales_handovers (org_id, account_id, name, project_kind, status, created_by)
     VALUES ($1,$2,'Fixture Customer Project','customer','draft',$3) RETURNING id`,
    [org.id, account.id, owner]);

  // An INTERNAL project. The product already models these — project_kind
  // 'internal' with no account and no deal — which is what the daily work
  // module means by "Internal Projects".
  const { rows: [internal] } = await q(
    `INSERT INTO sales_handovers (org_id, name, project_kind, status, created_by)
     VALUES ($1,'Fixture Internal Project','internal','draft',$2) RETURNING id`,
    [org.id, owner]);

  return { orgId: org.id, owner, other, inactive, teamId: team.id,
           accountId: account.id, accountId2: account2.id,
           handoverId: handover.id, internalHandoverId: internal.id };
}

/* ── tests ─────────────────────────────────────────────────────────── */

async function run(f) {
  console.log('\nITEMS — creation and status');

  const rec = await expectOk('a recurring item opens as active',
    () => svc.createItem(f.orgId, f.owner, { kind: 'recurring', title: 'LinkedIn outreach' }));
  eq('recurring status is active', rec && rec.status, 'active');

  const asg = await expectOk('an assigned item opens as yet_to_start',
    () => svc.createItem(f.orgId, f.owner, { kind: 'assigned', title: 'Power BI report' }));
  eq('assigned status uses the aligned vocabulary', asg && asg.status, 'yet_to_start');

  await expectCode('a blank title is refused', 'BLANK_TITLE',
    () => svc.createItem(f.orgId, f.owner, { kind: 'recurring', title: '   ' }));
  await expectCode('an unknown kind is refused', 'BAD_KIND',
    () => svc.createItem(f.orgId, f.owner, { kind: 'adhoc', title: 'x' }));
  await expectCode('a target date on recurring work is refused', 'TARGET_ON_RECURRING',
    () => svc.createItem(f.orgId, f.owner, {
      kind: 'recurring', title: 'x', targetDate: '2026-09-30' }));
  await expectCode('an inactive member cannot own work', 'INACTIVE_MEMBER',
    () => svc.createItem(f.orgId, f.owner, {
      kind: 'recurring', title: 'x', ownerUserId: f.inactive }));

  console.log('\nITEMS — the write-time snapshot');

  eq('the department is snapshotted onto the item', rec && rec.department_team_id, f.teamId);

  const onAccount = await svc.createItem(f.orgId, f.owner, {
    kind: 'recurring', title: 'account work',
    anchorKind: 'account', anchorId: f.accountId });
  eq('an account anchor resolves to itself', onAccount.account_id, f.accountId);

  const onHandover = await svc.createItem(f.orgId, f.owner, {
    kind: 'recurring', title: 'project work',
    anchorKind: 'handover', anchorId: f.handoverId });
  eq("a project anchor resolves to the project's account", onHandover.account_id, f.accountId);

  const onCampaign = await svc.createItem(f.orgId, f.owner, {
    kind: 'recurring', title: 'campaign work',
    anchorKind: 'campaign', anchorId: 999999 });
  eq('campaign work carries no account — it is internal by definition',
    onCampaign.account_id, null);

  const unanchored = await svc.createItem(f.orgId, f.owner,
    { kind: 'recurring', title: 'unanchored work' });
  eq('unanchored work carries no account either', unanchored.account_id, null);

  // An internal project is a real anchor with no account, which is exactly the
  // "Internal Projects" bucket — distinguishable from unanchored work because
  // the anchor is set even though the account is not.
  const onInternal = await svc.createItem(f.orgId, f.owner, {
    kind: 'recurring', title: 'internal project work',
    anchorKind: 'handover', anchorId: f.internalHandoverId });
  eq('an internal project resolves to no account', onInternal.account_id, null);
  check('but it still carries its anchor, so it is internal rather than unattributed',
    onInternal.anchor_kind === 'handover' && onInternal.anchor_id === f.internalHandoverId,
    'the anchor was lost');

  // The reason account_id is stored and not joined.
  //
  // Note what the schema does and does not permit here. A customer project
  // cannot be left with no account at all — sales_handovers_kind_shape_chk
  // requires an account_id or a deal_id — so the risk is not a project losing
  // its account. It is a project MOVING to a different one, which is ordinary:
  // an account gets merged, or work was filed under the wrong customer and is
  // corrected months later. A live join would silently move every past day's
  // work along with it.
  await q(`UPDATE sales_handovers SET account_id = $1 WHERE id = $2`,
    [f.accountId2, f.handoverId]);
  const { rows: [still] } = await q(
    `SELECT account_id FROM daily_work_items WHERE id = $1`, [onHandover.id]);
  eq('re-parenting the project to another account does not rewrite the item',
    still.account_id, f.accountId);

  // And new work anchored to the same project after the move picks up the NEW
  // account — the snapshot is taken at write, so both answers are correct for
  // the day they describe.
  const afterMove = await svc.createItem(f.orgId, f.owner, {
    kind: 'recurring', title: 'work after the move',
    anchorKind: 'handover', anchorId: f.handoverId });
  eq('work created after the move carries the new account',
    afterMove.account_id, f.accountId2);

  console.log('\nSAVE — validation is all or nothing');

  await expectCode('a blank description is refused', 'BLANK_DESCRIPTION',
    () => svc.saveDay(f.orgId, f.owner, [{ itemId: rec.id, description: '  ', dayStage: 'in_progress' }]));

  await expectCode('an over-long description is refused', 'DESCRIPTION_TOO_LONG',
    () => svc.saveDay(f.orgId, f.owner, [
      { itemId: rec.id, description: 'x'.repeat(2001), dayStage: 'in_progress' }]));

  await expectCode('an unknown stage is refused', 'BAD_STAGE',
    () => svc.saveDay(f.orgId, f.owner, [
      { itemId: rec.id, description: 'ok', dayStage: 'nearly' }]));

  await expectCode('the same item twice in one save is refused', 'DUPLICATE_ITEM',
    () => svc.saveDay(f.orgId, f.owner, [
      { itemId: rec.id, description: 'a', dayStage: 'in_progress' },
      { itemId: rec.id, description: 'b', dayStage: 'in_progress' }]));

  await expectCode('logging against someone else\u2019s item is refused', 'NOT_YOUR_ITEM',
    () => svc.saveDay(f.orgId, f.other, [
      { itemId: rec.id, description: 'ok', dayStage: 'in_progress' }]));

  // The important one: a bad row must not leave the good rows written.
  await expectCode('a bad fourth row aborts the whole save', 'DESCRIPTION_TOO_LONG',
    () => svc.saveDay(f.orgId, f.owner, [
      { itemId: rec.id, description: 'first', dayStage: 'in_progress' },
      { itemId: asg.id, description: 'x'.repeat(2001), dayStage: 'in_progress' }]));
  const { rows: [none] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_entries WHERE org_id = $1`, [f.orgId]);
  eq('nothing at all was written by the aborted save', none.n, 0);

  console.log('\nSAVE — the local date');

  // 19:00 UTC is already tomorrow in Kolkata. A server in UTC deciding this
  // would file the work against the wrong day.
  const late = await svc.saveDay(f.orgId, f.owner,
    [{ itemId: rec.id, description: 'logged late in the evening', dayStage: 'in_progress' }],
    { asOf: new Date('2026-08-27T19:00:00Z') });
  eq('entry_date is the owner\u2019s local date, not the server\u2019s',
    late.entryDate, '2026-08-28');
  eq('the resolved timezone is reported back', late.timezone, 'Asia/Kolkata');

  eq('the first entry for an item is not a continuation',
    late.entries[0].is_continuation, false);

  const next = await svc.saveDay(f.orgId, f.owner,
    [{ itemId: rec.id, description: 'and again the next day', dayStage: 'in_progress' }],
    { asOf: new Date('2026-08-28T19:00:00Z') });
  eq('the following day is a continuation', next.entries[0].is_continuation, true);

  // Read the dates back rather than computing them here. An earlier draft of
  // this file hardcoded them and got them wrong: 19:00Z on the 28th is 00:30
  // on the 29th in Kolkata, so this save lands a day later than a UTC reader
  // expects. That is the entire behaviour under test, and asserting against
  // hand-arithmetic re-introduces the bug into the test.
  eq('the two saves landed on consecutive local dates',
    [late.entryDate, next.entryDate], ['2026-08-28', '2026-08-29']);

  console.log('\nSAVE — one entry per item per day');

  const again = await svc.saveDay(f.orgId, f.owner,
    [{ itemId: rec.id, description: 'corrected wording', dayStage: 'completed' }],
    { asOf: new Date('2026-08-28T19:00:00Z') });
  eq('saving the same day again updates rather than duplicating',
    again.entries[0].id, next.entries[0].id);
  eq('the correction is what is stored', again.entries[0].description, 'corrected wording');

  const { rows: [sameDay] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_entries
      WHERE org_id = $1 AND item_id = $2 AND entry_date = $3`,
    [f.orgId, rec.id, again.entryDate]);
  eq('still exactly one row for that item and date', sameDay.n, 1);

  const { rows: [allDays] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_entries
      WHERE org_id = $1 AND item_id = $2`, [f.orgId, rec.id]);
  eq('two days logged against that item in total, not three', allDays.n, 2);

  console.log('\nSTAGE — lives in different places for the two kinds');

  // Recurring work marked complete is complete FOR TODAY. The item must
  // survive, or it would vanish from tomorrow's list.
  const { rows: [recAfter] } = await q(
    `SELECT status, closed_at FROM daily_work_items WHERE id = $1`, [rec.id]);
  eq('completing a recurring day does not close the item', recAfter.status, 'active');
  eq('and does not stamp closed_at', recAfter.closed_at, null);

  await svc.saveDay(f.orgId, f.owner,
    [{ itemId: asg.id, description: 'sent it for review', dayStage: 'in_review' }],
    { asOf: new Date('2026-08-28T19:00:00Z') });
  const { rows: [asgReview] } = await q(
    `SELECT status, closed_at FROM daily_work_items WHERE id = $1`, [asg.id]);
  eq('an assigned item takes the stage from the day', asgReview.status, 'in_review');
  eq('in_review does not close it', asgReview.closed_at, null);

  await svc.saveDay(f.orgId, f.owner,
    [{ itemId: asg.id, description: 'done and delivered', dayStage: 'completed' }],
    { asOf: new Date('2026-08-29T19:00:00Z') });
  const { rows: [asgDone] } = await q(
    `SELECT status, closed_at FROM daily_work_items WHERE id = $1`, [asg.id]);
  eq('completing an assigned item closes it', asgDone.status, 'completed');
  check('and stamps closed_at', asgDone.closed_at !== null, 'closed_at is still null');

  console.log('\nANCHORS — select only, never create');

  const anchors = await svc.getAnchorOptions(f.orgId);

  const customer = anchors.find(a =>
    a.anchor_kind === 'handover' && a.anchor_id === f.handoverId);
  const internal = anchors.find(a =>
    a.anchor_kind === 'handover' && a.anchor_id === f.internalHandoverId);

  check('the customer project is offered', !!customer, 'missing');
  eq('and is grouped as a customer project', customer && customer.group_key, 'customer_project');

  check('the internal project is offered', !!internal, 'missing');
  eq('and is grouped separately as an internal project',
    internal && internal.group_key, 'internal_project');
  eq('an internal project carries no account, by database constraint',
    internal && internal.account_id, null);

  check('the account itself is offered as an anchor',
    anchors.some(a => a.anchor_kind === 'account' && a.anchor_id === f.accountId), 'missing');

  // Finishing a project should stop new work being logged against it, without
  // disturbing what is already anchored to it.
  await q(`UPDATE sales_handovers SET status = 'completed' WHERE id = $1`, [f.handoverId]);
  const afterClose = await svc.getAnchorOptions(f.orgId);
  check('a completed project is no longer offered',
    !afterClose.some(a => a.anchor_kind === 'handover' && a.anchor_id === f.handoverId),
    'it is still selectable');
  const { rows: [kept] } = await q(
    `SELECT anchor_id, account_id FROM daily_work_items WHERE id = $1`, [onHandover.id]);
  eq('work already anchored to it keeps its anchor', kept.anchor_id, f.handoverId);
  eq('and keeps the account it was snapshotted with, not the current one',
    kept.account_id, f.accountId);

  console.log('\nGET DAY — what the member surface reads');

  // Read the SECOND day, so there is a previous day to offer.
  const day = await svc.getDay(f.orgId, f.owner, { date: next.entryDate });
  eq('the day is reported for the right date', day.entryDate, next.entryDate);
  check('open items are returned', day.rows.length > 0, 'no rows');

  const recRow = day.rows.find(r => r.item_id === rec.id);
  check('the recurring item is still listed after being completed for a day',
    !!recRow, 'the item disappeared from the list');
  eq("that day's own entry is returned", recRow && recRow.description, 'corrected wording');
  eq('the previous day is offered for "start from this"',
    recRow && recRow.prior_description, 'logged late in the evening');
  eq('and it is dated the day before', recRow && recRow.prior_date &&
    recRow.prior_date.toISOString().slice(0, 10), late.entryDate);

  // The first day has nothing before it, and must not borrow from later.
  const firstDay = await svc.getDay(f.orgId, f.owner, { date: late.entryDate });
  const firstRow = firstDay.rows.find(r => r.item_id === rec.id);
  eq('the first day offers no previous entry', firstRow && firstRow.prior_description, null);

  const ordered = day.rows.map(r => r.item_id);
  eq('items are ordered by creation, so rows do not reshuffle',
    ordered, [...ordered].sort((a, b) => a - b));
}

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}`);

  let f;
  try {
    f = await setup();
    await run(f);
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
  console.log('dailyWork.service verified.\n');
})();
