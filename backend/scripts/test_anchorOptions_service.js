#!/usr/bin/env node
// test_anchorOptions_service.js
//
//   cd C:\Projects\dw-verify
//   node test_anchorOptions_service.js
//
// Covers dailyWork.service.js getAnchorOptions, which had no harness at all
// while being the single query that decides what the whole org may file work
// against.
//
// ── The defect this exists for ───────────────────────────────────────
//
// getAnchorOptions filtered `status NOT IN ('cancelled','completed')` and
// nothing else. Retirement (2026_133) is a TIMESTAMP, not a seventh status
// value — deliberately, for the reasons in that migration's header — so the
// status predicate cannot see it. This query predates retirement and had no
// idea it existed. The consequence: retire an initiative and people could
// still file new work against it, which is precisely what retirement exists
// to stop.
//
// The fix is one predicate. The test is here because "one predicate" is
// exactly the size of change that gets reverted by a later merge and noticed
// by nobody.
//
// ── POSITIVE CONTROLS COME FIRST ─────────────────────────────────────
//
// Every "it is absent" assertion below is preceded by the "it is present"
// assertion for the same row. An absence check on its own passes when the
// fixture never reached the code — wrong org, failed insert, a typo in the
// name — and that failure mode looks exactly like success. So: prove the row
// shows up, THEN retire it and prove it stops.
//
// ── How it loads a repo module with no node_modules there ────────────
//
// Same trick as test_projectTracking_service.js and test_dailyWork_service.js:
// pre-populate require.cache for the resolved path of config/database.js with
// an implementation backed by the pg installed HERE, before the service is
// required. dailyWork.service.js pulls in only two peers; both are named
// explicitly, so a third require breaks this file loudly rather than quietly
// resolving to something real and half-working.
//
// ── Isolation ────────────────────────────────────────────────────────
//
// Fixture org, torn down in a finally. NOT rollback-based: getAnchorOptions
// runs inside withOrgTransaction, so an outer BEGIN here would be invisible
// to it.

const path = require('path');
const fs   = require('fs');

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
  console.error('\nSet it explicitly:\n  set DW_REPO=C:\\Projects\\action-crm-clean\\backend\n');
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
// this keeps working unchanged if RLS is switched on later. Note §7 of the
// handoff: sales_handovers has no RLS policy and accounts does, but the
// accounts policy is not FORCEd, so the table owner bypasses it. A non-owner
// DATABASE_URL would silently return zero account rows here — which is why
// the account assertion below is a positive control rather than a count.
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

function cache(relPath, exports) {
  const p = path.resolve(REPO, relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports };
}

cache('config/database.js', {
  pool, db: pool, withOrgTransaction, query: (t, p) => pool.query(t, p),
});

// The two peers. Named individually on purpose — see the header.
// dailyWorkDate is NOT stubbed: it is pure date arithmetic with no database
// and no side effects, and stubbing it would only hide a real break in it.
cache('services/hierarchyService.js', { getSubordinates: async () => [] });

const svcPath = path.resolve(REPO, 'services', 'dailyWork.service.js');
const svc = require(svcPath);
console.log(`\ntesting: ${svcPath}`);
console.log(`target:  ${CONN.replace(/:[^:@/]+@/, ':****@')}`);

// Module-load check, not just a require. `node --check` has passed on a file
// where a rewrite silently deleted two functions.
if (typeof svc.getAnchorOptions !== 'function') {
  console.error('\ngetAnchorOptions is not exported. Nothing below would mean anything.\n');
  process.exit(2);
}

/* ── assertions ────────────────────────────────────────────────────── */

let passed = 0, failed = 0;
const failures = [];

function pass(n) { passed++; console.log(`  PASS  ${n}`); }
function fail(n, d) { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); }
function check(n, cond, d) { cond ? pass(n) : fail(n, d || 'condition was false'); }

const q = (sql, params) => pool.query(sql, params);

// Find one anchor row by kind and id. Returns undefined when absent, which is
// what most of this file is asserting one way or the other.
const findAnchor = (rows, kind, id) =>
  rows.find(r => r.anchor_kind === kind && Number(r.anchor_id) === Number(id));

/* ── fixtures ──────────────────────────────────────────────────────── */

const FIXTURE_ORG  = 'ANCHOR_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'anchor-verify-fixture';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['daily_work_entries', 'daily_work_items',
                   'daily_work_schedules', 'daily_work_exceptions', 'daily_activity_types',
                   'sales_handover_plays', 'deal_play_instances', 'project_play_instances',
                   'project_members', 'sales_handovers',
                   'prospecting_campaigns',
                   'org_users', 'users', 'accounts']) {
    await q(`DELETE FROM ${t} WHERE org_id = ${org}`, [FIXTURE_ORG]);
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  const { rows: [left] } = await q(
    `SELECT count(*)::int AS n FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  if (left.n) throw new Error('fixture org still present after teardown');
}

async function setup() {
  await teardown();
  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`,
    [FIXTURE_ORG, FIXTURE_SLUG]);
  const { rows: [user] } = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
     VALUES ($1,'x','Anchor','Fixture',$2) RETURNING id`,
    [`anchor.verify.${Date.now()}@fixture.invalid`, org.id]);
  await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1,$2,'owner')`,
    [org.id, user.id]);
  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('Anchor Fixture Account',$1) RETURNING id`,
    [org.id]);

  // Inserted directly rather than through createProject. This file is testing
  // one SELECT; going through the creation service would drag in playbook
  // seeding and make a failure here ambiguous between the two.
  const handover = async (name, cols = {}) => {
    const {
      kind = 'internal', status = 'in_progress', trackingMode = 'timeboxed',
      goLiveDate = null, accountId = null,
    } = cols;
    const { rows: [h] } = await q(
      `INSERT INTO sales_handovers
         (org_id, project_kind, name, status, tracking_mode, go_live_date, account_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [org.id, kind, name, status, trackingMode, goLiveDate, accountId, user.id]);
    return h.id;
  };

  const ids = {
    orgId:     org.id,
    userId:    user.id,
    accountId: account.id,

    // The row the defect was about.
    standing:  await handover('AV Standing Initiative', { trackingMode: 'standing' }),
    // A second standing one, left live throughout, so the group assertions
    // are not resting on the row that gets retired half way down.
    standing2: await handover('AV Standing Retainer',
      { trackingMode: 'standing', kind: 'customer', accountId: account.id }),

    internal:  await handover('AV Internal Project',
      { goLiveDate: '2026-12-01' }),
    customer:  await handover('AV Customer Project',
      { kind: 'customer', accountId: account.id, goLiveDate: '2026-12-01' }),

    completed: await handover('AV Completed Project',
      { status: 'completed', goLiveDate: '2026-01-01' }),
    cancelled: await handover('AV Cancelled Project',
      { status: 'cancelled', goLiveDate: '2026-01-01' }),
  };

  const { rows: [campaign] } = await q(
    `INSERT INTO prospecting_campaigns (org_id, name, status, owner_id, created_by)
     VALUES ($1,'AV Active Campaign','active',$2,$2) RETURNING id`,
    [org.id, user.id]);
  const { rows: [paused] } = await q(
    `INSERT INTO prospecting_campaigns (org_id, name, status, owner_id, created_by)
     VALUES ($1,'AV Paused Campaign','paused',$2,$2) RETURNING id`,
    [org.id, user.id]);

  ids.campaign = campaign.id;
  ids.pausedCampaign = paused.id;
  return ids;
}

/* ── what the picker offers before anything is retired ─────────────── */
//
// All of these are positive controls for the section after them. If any fails,
// nothing below it means anything, because "absent" would be the fixture's
// fault rather than the code's.

async function baselineChecks(fx) {
  console.log('\nBASELINE — every fixture row reaches the query');

  const rows = await svc.getAnchorOptions(fx.orgId);

  check('a live standing initiative IS offered',
    !!findAnchor(rows, 'handover', fx.standing),
    'the row the retirement assertions depend on never reached the query');
  check('a live time-boxed internal project IS offered',
    !!findAnchor(rows, 'handover', fx.internal));
  check('a live time-boxed customer project IS offered',
    !!findAnchor(rows, 'handover', fx.customer));
  check('the account IS offered',
    !!findAnchor(rows, 'account', fx.accountId),
    'if this fails on a non-owner DATABASE_URL, see the RLS note at the top');
  check('an active campaign IS offered',
    !!findAnchor(rows, 'campaign', fx.campaign));

  console.log('\nBASELINE — what was already excluded, and still is');

  check('a completed project is NOT offered',
    !findAnchor(rows, 'handover', fx.completed),
    'you should not be able to start logging against something that finished');
  check('a cancelled project is NOT offered',
    !findAnchor(rows, 'handover', fx.cancelled));
  check('a non-active campaign is NOT offered',
    !findAnchor(rows, 'campaign', fx.pausedCampaign));

  // Not a hypothetical: name is nullable on sales_handovers and a deal-driven
  // row can carry one only through the deal. A null label renders as an empty
  // option, which is unpickable and unexplainable.
  check('every option has a label',
    rows.every(r => r.label != null && String(r.label).trim() !== ''),
    `${rows.filter(r => !r.label).length} option(s) came back with no label`);

  return rows;
}

/* ── grouping ──────────────────────────────────────────────────────── */

async function groupChecks(fx) {
  console.log('\nGROUPING — tracking mode wins over project kind');

  const rows = await svc.getAnchorOptions(fx.orgId);
  const g = id => findAnchor(rows, 'handover', id)?.group_key;

  // Before this, group_key came from project_kind alone, so standing
  // initiatives were scattered through the two project groups and there was
  // nowhere in the picker to look for them.
  check('an internal standing initiative groups as standing',
    g(fx.standing) === 'standing', `got '${g(fx.standing)}'`);
  check('a CUSTOMER standing initiative also groups as standing',
    g(fx.standing2) === 'standing',
    `got '${g(fx.standing2)}' — kind must not override tracking mode`);

  check('a time-boxed internal project still groups as internal_project',
    g(fx.internal) === 'internal_project', `got '${g(fx.internal)}'`);
  check('a time-boxed customer project still groups as customer_project',
    g(fx.customer) === 'customer_project', `got '${g(fx.customer)}'`);

  check('accounts and campaigns keep their own groups',
    findAnchor(rows, 'account', fx.accountId)?.group_key === 'account' &&
    findAnchor(rows, 'campaign', fx.campaign)?.group_key === 'campaign');

  // The frontend maps group_key to a heading and falls back to the raw key.
  // A key it does not know renders as 'standing' in the middle of a list of
  // sentence-case headings — legible, but obviously unfinished.
  const KNOWN = new Set(['standing', 'internal_project', 'customer_project',
                         'account', 'campaign']);
  const unknown = [...new Set(rows.map(r => r.group_key))].filter(k => !KNOWN.has(k));
  check('no group_key the frontend has no label for',
    unknown.length === 0,
    `add a label in groupAnchors for: ${unknown.join(', ')}`);
}

/* ── the defect ────────────────────────────────────────────────────── */

async function retirementChecks(fx) {
  console.log('\nRETIREMENT — the predicate this file exists for');

  // Retire through the DATABASE, not the service. This harness stubs
  // handover.service.js away entirely, and the point is the SELECT, not the
  // write. chk_sh_retired_shape requires both columns to move together and
  // requires tracking_mode = 'standing', so a wrong fixture fails here rather
  // than producing a misleading pass.
  await q(
    `UPDATE sales_handovers SET retired_at = NOW(), retired_by = $1
      WHERE id = $2 AND org_id = $3`,
    [fx.userId, fx.standing, fx.orgId]);

  const { rows: [state] } = await q(
    `SELECT retired_at IS NOT NULL AS retired, status
       FROM sales_handovers WHERE id = $1`, [fx.standing]);
  check('the fixture really is retired now', state.retired === true,
    'the UPDATE did not take, so the assertion below would pass for free');
  check('and its status is UNCHANGED by retirement',
    state.status === 'in_progress',
    `status moved to '${state.status}' — retirement is a timestamp, not a status`);

  const rows = await svc.getAnchorOptions(fx.orgId);

  check('a RETIRED initiative is NOT offered as an anchor',
    !findAnchor(rows, 'handover', fx.standing),
    'this is the whole defect: retirement is a timestamp, and the status ' +
    'predicate cannot see it, so retired initiatives stayed pickable');

  check('the OTHER standing initiative is still offered',
    !!findAnchor(rows, 'handover', fx.standing2),
    'the fix excluded too much — every standing row went, not just the retired one');

  check('time-boxed projects are untouched by the retirement predicate',
    !!findAnchor(rows, 'handover', fx.internal) &&
    !!findAnchor(rows, 'handover', fx.customer));

  console.log('\nRETIREMENT — reversible');

  await q(
    `UPDATE sales_handovers SET retired_at = NULL, retired_by = NULL
      WHERE id = $1 AND org_id = $2`, [fx.standing, fx.orgId]);

  const after = await svc.getAnchorOptions(fx.orgId);
  check('un-retiring puts it back in the picker',
    !!findAnchor(after, 'handover', fx.standing),
    'retirement must be reversible end to end, not just in the column');
}

/* ── org scoping ───────────────────────────────────────────────────── */

async function scopeChecks(fx) {
  console.log('\nSCOPE — another org sees none of this');

  // Cheap, and the failure it catches is the worst one this query can have.
  const { rows: [other] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`,
    [FIXTURE_ORG + '_OTHER', FIXTURE_SLUG + '-other']);
  try {
    const rows = await svc.getAnchorOptions(other.id);
    const leaked = rows.filter(r =>
      (r.anchor_kind === 'handover' &&
        [fx.standing, fx.standing2, fx.internal, fx.customer].includes(Number(r.anchor_id))) ||
      (r.anchor_kind === 'account'  && Number(r.anchor_id) === fx.accountId) ||
      (r.anchor_kind === 'campaign' && Number(r.anchor_id) === fx.campaign));
    check('no fixture row leaks into a different org', leaked.length === 0,
      `${leaked.length} row(s) leaked: ${leaked.map(r => r.label).join(', ')}`);
  } finally {
    await q(`DELETE FROM organizations WHERE id = $1`, [other.id]);
  }
}

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  let fx;
  try {
    fx = await setup();
    await baselineChecks(fx);
    await groupChecks(fx);
    await retirementChecks(fx);
    await scopeChecks(fx);
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
  console.log('anchor options verified.\n');
})();
