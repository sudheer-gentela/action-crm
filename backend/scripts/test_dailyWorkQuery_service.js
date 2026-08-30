#!/usr/bin/env node
// test_dailyWorkQuery_service.js
//
//   cd C:\Projects\dw-verify
//   node test_dailyWorkQuery_service.js
//
// Exercises dailyWorkQuery.service.js — the read path — against a real
// database, from outside the repo. Same module-substitution trick and same
// fixture-and-teardown isolation as test_dailyWork_service.js.
//
// The fixture builds a small but deliberately awkward week:
//
//   Chandini  Marketing   logs 3 of 5 days, across two accounts
//   Pranay    Marketing   logs 1 day, internal work only
//   Nikhitha  Salesforce  logs nothing at all
//
// with one public holiday and one approved leave day, so the denominators
// differ per person. A fixture where everyone works the same week proves
// nothing about the calendar.

const path = require('path');
const fs = require('fs');

try { require('dotenv').config(); } catch {}

let Pool;
try { ({ Pool } = require('pg')); }
catch { console.error('\nRun `npm install pg dotenv` here first.\n'); process.exit(2); }

const CONN = process.env.DATABASE_URL;
if (!CONN) { console.error('\nNo DATABASE_URL.\n'); process.exit(2); }

const REPO_CANDIDATES = [
  process.env.DW_REPO,
  path.join(__dirname, '..', 'action-crm-clean', 'backend'),
  'C:/Projects/action-crm-clean/backend',
  path.join(__dirname, '..', 'backend'),
].filter(Boolean);

const REPO = REPO_CANDIDATES.find(p => {
  try { return fs.existsSync(path.join(p, 'services', 'dailyWorkQuery.service.js')); }
  catch { return false; }
});

if (!REPO) {
  console.error('\nCould not find dailyWorkQuery.service.js. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\n  set DW_REPO=C:\\Projects\\action-crm-clean\\backend\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4, connectionTimeoutMillis: 10000,
});

async function withOrgTransaction(orgId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}

const dbPath = path.resolve(REPO, 'config', 'database.js');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: { pool, db: pool, withOrgTransaction, query: (t, p) => pool.query(t, p) },
};

const svc = require(path.resolve(REPO, 'services', 'dailyWork.service.js'));
const qsvc = require(path.resolve(REPO, 'services', 'dailyWorkQuery.service.js'));
console.log(`\ntesting: ${path.resolve(REPO, 'services', 'dailyWorkQuery.service.js')}`);

let passed = 0, failed = 0;
const failures = [];
const pass = n => { passed++; console.log(`  PASS  ${n}`); };
const fail = (n, d) => { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); };
const check = (n, c, d) => c ? pass(n) : fail(n, d || 'condition was false');
const eq = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e),
  `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const q = (sql, params) => pool.query(sql, params);
const FIXTURE_ORG = 'DWQ_VERIFY_FIXTURE';

// Mon 24 Aug 2026 to Fri 28 Aug 2026.
const FROM = '2026-08-24', TO = '2026-08-28';
// An instant that is safely mid-morning in Kolkata, so no date arithmetic is
// done by hand anywhere in this file.
const atLocal = day => new Date(`2026-08-${day}T06:00:00Z`);

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['play_notes', 'play_evidence',
                   'daily_work_entries', 'daily_work_items',
                   'daily_work_schedules', 'daily_work_exceptions',
                   'daily_activity_types', 'holiday_calendar_dates', 'holiday_calendars',
                   'org_hierarchy', 'team_memberships', 'teams', 'team_dimensions',
                   'sales_handovers', 'org_users', 'users', 'accounts']) {
    await q(`DELETE FROM ${t} WHERE org_id = ${org}`, [FIXTURE_ORG]).catch(() => {});
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
}

async function setup() {
  await teardown();

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,'dwq-verify-fixture') RETURNING id`,
    [FIXTURE_ORG]);

  const mkUser = async (first) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id, timezone)
       VALUES ($1,'x',$2,'Fixture',$3,'Asia/Kolkata') RETURNING id`,
      [`dwq.${first}.${Date.now()}@fixture.invalid`, first, org.id]);
    await q(`INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1,$2,'member',TRUE)`,
      [org.id, u.id]);
    return u.id;
  };

  const manager  = await mkUser('Saideep');
  const chandini = await mkUser('Chandini');
  const pranay   = await mkUser('Pranay');
  const nikhitha = await mkUser('Nikhitha');

  for (const uid of [chandini, pranay, nikhitha]) {
    await q(`INSERT INTO org_hierarchy (org_id, user_id, reports_to, relationship_type)
             VALUES ($1,$2,$3,'solid')`, [org.id, uid, manager]);
  }

  await q(`INSERT INTO team_dimensions (org_id, key, name, applies_to)
           VALUES ($1,'department','Department','internal')`, [org.id]);
  const mkTeam = async (name) => {
    const { rows: [t] } = await q(
      `INSERT INTO teams (org_id, name, dimension, is_active)
       VALUES ($1,$2,'department',TRUE) RETURNING id`, [org.id, name]);
    return t.id;
  };
  const marketing = await mkTeam('Marketing');
  const salesforce = await mkTeam('Salesforce');
  await q(`INSERT INTO team_memberships (org_id, user_id, team_id, is_primary)
           VALUES ($1,$2,$3,TRUE),($1,$4,$3,TRUE),($1,$5,$6,TRUE)`,
    [org.id, chandini, marketing, pranay, nikhitha, salesforce]);

  const mkAccount = async (name) => {
    const { rows: [a] } = await q(
      `INSERT INTO accounts (name, org_id) VALUES ($1,$2) RETURNING id`, [name, org.id]);
    return a.id;
  };
  const acctCT = await mkAccount('CT');
  const acctOther = await mkAccount('Other Customer');

  const { rows: [internalProject] } = await q(
    `INSERT INTO sales_handovers (org_id, name, project_kind, status, created_by)
     VALUES ($1,'PowerBI','internal','draft',$2) RETURNING id`, [org.id, manager]);

  // Calendar: one holiday on Wednesday, applied to everyone.
  const { rows: [cal] } = await q(
    `INSERT INTO holiday_calendars (org_id, name, is_default) VALUES ($1,'India',TRUE) RETURNING id`,
    [org.id]);
  await q(`INSERT INTO holiday_calendar_dates (org_id, calendar_id, holiday_date, label)
           VALUES ($1,$2,'2026-08-26','Fixture Holiday')`, [org.id, cal.id]);

  for (const uid of [chandini, pranay, nikhitha]) {
    await q(`INSERT INTO daily_work_schedules
               (org_id, user_id, weekday_mask, holiday_calendar_id, effective_from)
             VALUES ($1,$2,31,$3,'2026-01-01')`, [org.id, uid, cal.id]);
  }

  // Pranay takes approved leave on the Thursday. Nikhitha has an UNAPPROVED
  // request on the Friday, which must not shrink her denominator.
  await q(`INSERT INTO daily_work_exceptions
             (org_id, user_id, exception_date, reason, approved_by, approved_at)
           VALUES ($1,$2,'2026-08-27','Fixture leave',$3, now())`, [org.id, pranay, manager]);
  await q(`INSERT INTO daily_work_exceptions (org_id, user_id, exception_date, reason)
           VALUES ($1,$2,'2026-08-28','Pending request')`, [org.id, nikhitha]);

  await q(`INSERT INTO daily_activity_types (org_id, key, label, is_system, status)
           VALUES ($1,'emails','Emails',TRUE,'active'),
                  ($1,'research','Research',TRUE,'active'),
                  ($1,'demo_call','Demo call',FALSE,'candidate')`, [org.id]);

  return { orgId: org.id, manager, chandini, pranay, nikhitha,
           marketing, salesforce, acctCT, acctOther,
           // .id, not the row — destructuring `rows: [x]` yields the whole row
           internalProject: internalProject.id };
}

async function seedWork(f) {
  // Chandini: CT account work on Mon and Tue, other-customer work on Fri.
  const ct = await svc.createItem(f.orgId, f.chandini, {
    kind: 'recurring', title: 'CT outreach', activityTypeKey: 'emails',
    anchorKind: 'account', anchorId: f.acctCT });
  const other = await svc.createItem(f.orgId, f.chandini, {
    kind: 'recurring', title: 'Other customer research', activityTypeKey: 'research',
    anchorKind: 'account', anchorId: f.acctOther });

  await svc.saveDay(f.orgId, f.chandini,
    [{ itemId: ct.id, description: 'Monday CT outreach.', dayStage: 'in_progress' }],
    { asOf: atLocal('24') });
  await svc.saveDay(f.orgId, f.chandini, [
    { itemId: ct.id, description: 'Tuesday CT outreach.', dayStage: 'in_progress' },
    { itemId: other.id, description: 'Tuesday research for the other customer.', dayStage: 'in_progress' },
  ], { asOf: atLocal('25') });
  await svc.saveDay(f.orgId, f.chandini,
    [{ itemId: other.id, description: 'Friday research.', dayStage: 'in_progress' }],
    { asOf: atLocal('28') });

  // Pranay: internal project work, one day only.
  const internal = await svc.createItem(f.orgId, f.pranay, {
    kind: 'recurring', title: 'PowerBI internal work', activityTypeKey: 'research',
    anchorKind: 'handover', anchorId: f.internalProject });
  await svc.saveDay(f.orgId, f.pranay,
    [{ itemId: internal.id, description: 'Internal PowerBI work.', dayStage: 'in_progress' }],
    { asOf: atLocal('25') });

  // An assigned item nobody has touched since it opened.
  const stalled = await svc.createItem(f.orgId, f.manager, {
    kind: 'assigned', title: 'Stalled deliverable', ownerUserId: f.nikhitha,
    assignedBy: f.manager, targetDate: '2026-08-31' });
  await q(`UPDATE daily_work_items SET opened_on = '2026-08-20' WHERE id = $1`, [stalled.id]);

  return { ct, other, internal, stalled };
}

async function run(f) {
  const w = await seedWork(f);
  const all = [f.chandini, f.pranay, f.nikhitha];

  console.log('\nSCOPE — the manager chain');

  const visible = await qsvc.getVisibleUserIds(f.orgId, f.manager);
  check('the manager sees all three reports plus themselves',
    [f.manager, ...all].every(id => visible.includes(id)),
    `got ${JSON.stringify(visible)}`);

  const own = await qsvc.getVisibleUserIds(f.orgId, f.chandini);
  eq('a member with no reports sees only themselves', own, [f.chandini]);

  console.log('\nLOG — one row per person per day');

  const log = await qsvc.getLog(f.orgId, { userIds: all, from: FROM, to: TO });
  eq('four person-days were logged in total', log.length, 4);

  const tuesday = log.find(r => r.user_id === f.chandini && r.entry_date === '2026-08-25');
  eq("Tuesday's two items are one row", tuesday && tuesday.item_count, 2);
  eq('and the descriptions are concatenated in item order',
    tuesday && tuesday.work_done,
    'Tuesday CT outreach. Tuesday research for the other customer.');
  eq('entry_date is a string, not a Date the driver shifted',
    typeof (tuesday && tuesday.entry_date), 'string');

  const dates = log.map(r => r.entry_date);
  eq('the log reads most recent first', dates, [...dates].sort().reverse());

  console.log('\nLOG — filters read the snapshot');

  const ctOnly = await qsvc.getLog(f.orgId,
    { userIds: all, from: FROM, to: TO, filters: { accountKey: String(f.acctCT) } });
  eq('filtering to one account narrows to its days', ctOnly.length, 2);
  eq("and rewrites Tuesday's text to only that account's work",
    ctOnly.find(r => r.entry_date === '2026-08-25').work_done, 'Tuesday CT outreach.');

  const internalOnly = await qsvc.getLog(f.orgId,
    { userIds: all, from: FROM, to: TO, filters: { accountKey: 'internal' } });
  eq('internal work is anchored work with no account', internalOnly.length, 1);
  eq('and it is Pranay\u2019s', internalOnly[0].user_id, f.pranay);

  const noneAnchor = await qsvc.getLog(f.orgId,
    { userIds: all, from: FROM, to: TO, filters: { accountKey: 'none' } });
  eq('unattributed work is a different bucket from internal', noneAnchor.length, 0);

  const marketingOnly = await qsvc.getLog(f.orgId,
    { userIds: all, from: FROM, to: TO, filters: { departmentTeamId: f.marketing } });
  eq('the department filter reads the entry snapshot', marketingOnly.length, 4);

  // The whole reason department is snapshotted rather than joined.
  await q(`UPDATE team_memberships SET team_id = $1
            WHERE org_id = $2 AND user_id = $3`, [f.salesforce, f.orgId, f.chandini]);
  const afterMove = await qsvc.getLog(f.orgId,
    { userIds: all, from: FROM, to: TO, filters: { departmentTeamId: f.marketing } });
  eq('moving someone to another department does not rewrite their history',
    afterMove.length, 4);

  console.log('\nDETAIL — the parts behind one row');

  const detail = await qsvc.getDayDetail(f.orgId, f.chandini, '2026-08-25');
  eq('two items behind Tuesday', detail.length, 2);
  eq('ordered by item creation, so the row keeps its slot',
    detail.map(r => r.item_id), [w.ct.id, w.other.id]);
  eq('the account name comes back for display',
    detail[0].account_name, 'CT');

  console.log('\nROLLUP — one row per person, whatever the period');

  const rollup = await qsvc.getRollup(f.orgId, { userIds: all, from: FROM, to: TO });
  eq('three people, three rows — not one row per person per day', rollup.length, 3);

  const rc = rollup.find(r => r.user_id === f.chandini);
  const rp = rollup.find(r => r.user_id === f.pranay);
  const rn = rollup.find(r => r.user_id === f.nikhitha);

  // Mon-Fri is five days, minus the Wednesday holiday.
  eq('the holiday is removed from everyone\u2019s denominator', rc.working_days, 4);
  eq('Chandini logged three of those four', rc.days_logged, 3);
  eq('her rate is three quarters', rc.rate, 0.75);

  // Pranay also has an approved leave day, so his denominator is smaller again.
  eq('approved leave removes another day for Pranay', rp.working_days, 3);
  eq('he logged one of three', rp.days_logged, 1);

  // Nikhitha's leave request is not approved and must not flatter her rate.
  eq('an unapproved leave request does not shrink the denominator', rn.working_days, 4);
  eq('and someone who logged nothing scores zero, not null', rn.rate, 0);

  eq('the day strip has one square per working day', rc.days.length, 4);
  check('and the holiday is not one of them',
    !rc.days.some(d => d.date === '2026-08-26'), 'the holiday appears in the strip');
  eq('every date in the strip is a string', typeof rc.days[0].date, 'string');

  console.log('\nACCOUNT — what was delivered, and by whom');

  const summary = await qsvc.getAccountSummary(f.orgId,
    { accountKey: String(f.acctCT), userIds: all, from: FROM, to: TO });
  eq('two entries against CT', summary.totals.entries, 2);
  eq('by one person', summary.totals.people, 1);
  eq('and the activity breakdown names the type',
    summary.byActivity[0].activity_key, 'emails');

  console.log('\nQUEUES — what is waiting on the manager');

  const stalled = await qsvc.getStalledAssigned(f.orgId,
    { userIds: all, asOfDate: '2026-08-28', staleDays: 3 });
  eq('the untouched assigned item is stalled', stalled.length, 1);
  eq('and it names the owner', stalled[0].owner_user_id, f.nikhitha);
  check('it counts quiet days from the item opening when nothing was ever logged',
    stalled[0].days_quiet >= 8, `days_quiet was ${stalled[0].days_quiet}`);
  eq('the target date is a string', typeof stalled[0].target_date, 'string');

  const notStale = await qsvc.getStalledAssigned(f.orgId,
    { userIds: all, asOfDate: '2026-08-28', staleDays: 30 });
  eq('a longer threshold clears the queue', notStale.length, 0);

  const candidates = await qsvc.getCandidateActivityTypes(f.orgId);
  eq('the proposed activity type is waiting', candidates.length, 1);
  eq('and it is the one the member named', candidates[0].key, 'demo_call');

  console.log('\nEMPTY — nobody in scope');

  eq('an empty scope returns no log', await qsvc.getLog(f.orgId,
    { userIds: [], from: FROM, to: TO }), []);
  eq('an empty scope returns no rollup', await qsvc.getRollup(f.orgId,
    { userIds: [], from: FROM, to: TO }), []);
}

(async () => {
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}`);

  try {
    const f = await setup();
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
  console.log('dailyWorkQuery.service verified.\n');
})();
