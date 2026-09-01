#!/usr/bin/env node
// test_projectTracking_service.js
//
//   cd C:\Projects\dw-verify
//   node test_projectTracking_service.js
//
// Exercises the REAL handover.service.js against a real database, from outside
// the repo. Companion to verify_project_tracking_133.js: that one proves the
// database refuses the wrong shapes, this one proves the service refuses them
// first, with a sentence a person can act on instead of a constraint name.
//
// ── How it loads a repo module with no node_modules there ────────────
//
// Same trick as test_dailyWork_service.js: pre-populate require.cache for the
// resolved path of config/database.js with an implementation backed by the pg
// installed HERE, before the service is required.
//
// handover.service.js pulls in nine peer modules, which pull in express and
// more. Those are stubbed the same way — permissively, since none of them is
// under test. The stubs are listed explicitly rather than caught by a wildcard,
// so adding a tenth dependency fails loudly here instead of silently loading
// something real and half-working.
//
// ── Isolation ────────────────────────────────────────────────────────
//
// Fixture org, torn down in a finally. NOT rollback-based: createProject opens
// its own transaction through withOrgTransaction, so an outer BEGIN here would
// be invisible to it.
//
// ── NOT COVERED, deliberately ────────────────────────────────────────
//
// runNightlySweep now excludes standing initiatives (otherwise every one of
// them raises handover_stalled every night, forever). Testing that end to end
// means standing up HandoverRulesEngine and ActionPersister for real, which is
// a bigger fixture than the assertion is worth. The change is one predicate in
// the sweep's own query; read it there.

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
  try { return fs.existsSync(path.join(p, 'services', 'handover.service.js')); }
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

// Faithful copy of the real helper, including the RLS session variable, so this
// keeps working unchanged if RLS is switched on later.
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

// Peers. Named one by one on purpose: a new require in handover.service.js
// should break this file rather than quietly resolve to something real.
const permissive = () => new Proxy({}, { get: () => async () => ({ rows: [] }) });
cache('services/PlaybookPlayService.js',   permissive());
cache('services/ActionPersister.js',       permissive());
cache('services/HandoverRulesEngine.js',   { evaluate: () => [], REQUIRED_ROLES: [] });
cache('services/projectMembers.service.js', permissive());
cache('services/playReview.service.js',    { seedWatchersFromOrgDefault: async () => {} });
cache('routes/orgAdmin.routes.js',         { getDiagnosticRulesConfig: async () => ({}) });
cache('services/PlayCompletionService.js', permissive());
cache('services/hierarchyService.js',      { getSubordinates: async () => [] });
cache('services/projectSettings.service.js', {
  get: async () => ({ rollup_basis: 'people', team_scope_enabled: true,
                      show_unassigned_in_team_scope: true }),
  ownerColumn:    () => 'assigned_service_owner_id',
  canUseOrgScope: () => true,
  resolveRole:    async () => 'owner',
});

const svcPath = path.resolve(REPO, 'services', 'handover.service.js');
const svc = require(svcPath);
console.log(`\ntesting: ${svcPath}`);
console.log(`target:  ${CONN.replace(/:[^:@/]+@/, ':****@')}`);

/* ── assertions ────────────────────────────────────────────────────── */

let passed = 0, failed = 0;
const failures = [];

function pass(n) { passed++; console.log(`  PASS  ${n}`); }
function fail(n, d) { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); }
function check(n, cond, d) { cond ? pass(n) : fail(n, d || 'condition was false'); }

/**
 * Assert the service refuses something, and refuses it with a message a person
 * can act on rather than a constraint name leaking out of Postgres.
 *
 * `match` is checked against the message. A bare "it threw" would pass when the
 * write reached the database and came back as a 500 carrying
 * chk_sh_standing_no_go_live — which is exactly the outcome these guards exist
 * to prevent, so it has to be distinguishable from success.
 */
async function expectRefusal(name, status, match, fn) {
  try {
    await fn();
    fail(name, 'expected a refusal, but it was accepted');
  } catch (err) {
    if (err.status !== status) {
      fail(name, `expected status ${status}, got ${err.status || '(none)'} — ${err.message}`);
    } else if (!match.test(err.message)) {
      fail(name, `status was right but the message was not: ${err.message}`);
    } else if (/chk_sh_|constraint/i.test(err.message)) {
      fail(name, `a database constraint name reached the caller: ${err.message}`);
    } else pass(name);
  }
}

async function expectOk(name, fn) {
  try { const r = await fn(); pass(name); return r; }
  catch (err) { fail(name, `expected success, got ${err.status || ''} ${err.message}`); return null; }
}

const q = (sql, params) => pool.query(sql, params);

/* ── fixtures ──────────────────────────────────────────────────────── */

const FIXTURE_ORG  = 'PTSVC_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'ptsvc-verify-fixture';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['daily_work_entries', 'daily_work_items',
                   'daily_work_schedules', 'daily_work_exceptions', 'daily_activity_types',
                   'sales_handover_plays', 'deal_play_instances', 'project_play_instances',
                   'project_members', 'sales_handovers',
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
     VALUES ($1,'x','Fixture','User',$2) RETURNING id`,
    [`pt.verify.${Date.now()}@fixture.invalid`, org.id]);
  await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1,$2,'owner')`,
    [org.id, user.id]);
  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('PT Fixture Account',$1) RETURNING id`,
    [org.id]);
  return { orgId: org.id, userId: user.id, accountId: account.id };
}

/* ── creation ──────────────────────────────────────────────────────── */

async function creationChecks({ orgId, userId, accountId }) {
  console.log('\nCREATE — the rule that could not be a CHECK constraint');

  // Owner and end date are required for time-boxed work. This lives in the
  // service, not the database, because every pre-existing row defaults to
  // timeboxed and many have neither.
  await expectRefusal('time-boxed project without an owner is refused', 400, /owner/i,
    () => svc.createProject(orgId, userId,
      { kind: 'customer', name: 'PT no owner', accountId, goLiveDate: '2026-12-01' }));

  await expectRefusal('time-boxed project without an end date is refused', 400, /end date/i,
    () => svc.createProject(orgId, userId,
      { kind: 'customer', name: 'PT no date', accountId, assignedServiceOwnerId: userId }));

  // The message has to name the alternative, or the person's only move is to
  // invent a date — which is how the seven ownerless rows happened.
  await expectRefusal('the refusal points at standing initiatives', 400, /standing initiative/i,
    () => svc.createProject(orgId, userId, { kind: 'internal', name: 'PT neither' }));

  const tb = await expectOk('time-boxed project with both is created',
    () => svc.createProject(orgId, userId, {
      kind: 'customer', name: 'PT timeboxed', accountId,
      assignedServiceOwnerId: userId, goLiveDate: '2026-12-01' }));
  check('it comes back as timeboxed', tb?.trackingMode === 'timeboxed', `got ${tb?.trackingMode}`);
  check('isStanding is false', tb?.isStanding === false, `got ${tb?.isStanding}`);

  console.log('\nCREATE — standing initiatives');

  const st = await expectOk('standing initiative needs neither owner nor date',
    () => svc.createProject(orgId, userId, { kind: 'internal', name: 'PT Skill Development',
                                             trackingMode: 'standing' }));
  check('it comes back as standing', st?.trackingMode === 'standing', `got ${st?.trackingMode}`);
  check('isStanding is true', st?.isStanding === true);
  check('isRetired is false on a live initiative', st?.isRetired === false);

  // Refused rather than silently dropped. A date on a standing initiative means
  // the person believes it finishes; discarding that quietly is how someone
  // finds out months later their deadline was never stored.
  await expectRefusal('a date on a standing initiative is refused, not dropped', 400, /no end date/i,
    () => svc.createProject(orgId, userId, { kind: 'internal', name: 'PT dated standing',
                                             trackingMode: 'standing', goLiveDate: '2026-12-01' }));

  return { tb, st };
}

/* ── the list, and the header that was lying ───────────────────────── */

async function listChecks({ orgId, userId }, { tb, st }) {
  console.log('\nLIST — the counts stop lying');

  const names = rows => rows.map(r => r.projectName || r.name).sort();

  const dflt = await svc.list(orgId, userId, { scope: 'org' });
  check('the default list excludes standing initiatives',
    !dflt.some(r => r.id === st.id) && dflt.some(r => r.id === tb.id),
    `default list returned: ${names(dflt).join(', ')}`);

  const standing = await svc.list(orgId, userId, { scope: 'org', trackingMode: 'standing' });
  check('trackingMode standing returns only standing initiatives',
    standing.length > 0 && standing.every(r => r.trackingMode === 'standing')
      && standing.some(r => r.id === st.id),
    `standing list returned: ${names(standing).join(', ')}`);

  const both = await svc.list(orgId, userId, { scope: 'org', trackingMode: null });
  check('trackingMode null returns both axes',
    both.some(r => r.id === tb.id) && both.some(r => r.id === st.id),
    `combined list returned: ${names(both).join(', ')}`);

  // THE HEADER FIX. A standing initiative has no owner by design, so it must
  // not be counted as unassigned — that count is what read "7 unassigned"
  // permanently. Inserted directly, because createProject now refuses to make
  // an ownerless time-boxed project; this is what a legacy row looks like.
  const { rows: [legacy] } = await q(
    `INSERT INTO sales_handovers (org_id, project_kind, name, status, created_by)
     VALUES ($1,'internal','PT legacy ownerless','draft',$2) RETURNING id`,
    [orgId, userId]);

  const all = await svc.list(orgId, userId, { scope: 'org', trackingMode: null });
  const row = id => all.find(r => r.id === id);

  check('a standing initiative is NOT counted as unassigned',
    row(st.id)?.isUnassigned === false,
    'this is the count that read "7 unassigned" forever');
  check('an ownerless time-boxed project IS still unassigned',
    row(legacy.id)?.isUnassigned === true,
    'the fix must not hide genuinely unassigned projects — that is a real state to act on');
  check('an owned time-boxed project is not unassigned',
    row(tb.id)?.isUnassigned === false);
}

/* ── conversion ────────────────────────────────────────────────────── */

async function conversionChecks({ orgId, userId, accountId }) {
  console.log('\nCONVERT — standing to time-boxed');

  const st = await svc.createProject(orgId, userId,
    { kind: 'internal', name: 'PT convert me', trackingMode: 'standing' });

  // Recurring daily work logged against it, to prove conversion leaves history
  // alone through the SERVICE path and not only through raw SQL.
  const { rows: [item] } = await q(
    `INSERT INTO daily_work_items
       (org_id, owner_user_id, kind, title, status, anchor_kind, anchor_id, created_by)
     VALUES ($1,$2,'recurring','PT recurring','active','handover',$3,$2) RETURNING id`,
    [orgId, userId, st.id]);
  const { rows: [entry] } = await q(
    `INSERT INTO daily_work_entries
       (org_id, item_id, user_id, entry_date, description, day_stage, anchor_kind, anchor_id)
     VALUES ($1,$2,$3,'2026-08-14','what October says','in_progress','handover',$4) RETURNING id`,
    [orgId, item.id, userId, st.id]);
  const readEntry = async () => (await q(
    `SELECT entry_date::text AS entry_date, description, day_stage, anchor_kind, anchor_id
       FROM daily_work_entries WHERE id = $1`, [entry.id])).rows[0];
  const before = await readEntry();

  await expectRefusal('converting to time-boxed without an owner is refused', 400, /owner/i,
    () => svc.convertTrackingMode(st.id, orgId, userId, 'timeboxed', { goLiveDate: '2026-12-01' }));
  await expectRefusal('converting to time-boxed without a date is refused', 400, /end date/i,
    () => svc.convertTrackingMode(st.id, orgId, userId, 'timeboxed',
      { assignedServiceOwnerId: userId }));

  const conv = await expectOk('converting with owner and date works',
    () => svc.convertTrackingMode(st.id, orgId, userId, 'timeboxed',
      { assignedServiceOwnerId: userId, goLiveDate: '2026-12-01' }));
  check('it is time-boxed afterwards', conv?.trackingMode === 'timeboxed');

  // Asserted against the STORED value, read with ::text, not against fmt()'s
  // rendering of it.
  //
  // fmt() maps go_live_date straight through, so it comes back as a JS Date —
  // node-postgres parses DATE at LOCAL midnight, so res.json() serialises it as
  // the previous day's 18:30Z from IST. That is a pre-existing defect in the
  // API's date handling, it predates tracking modes, and it is not fixed here:
  // the whole fix is two-sided, because the frontend's fmtDate does
  // `new Date(d)`, and feeding that a bare 'YYYY-MM-DD' renders the day BEFORE
  // west of UTC. Swapping one timezone bug for the other inside a feature
  // commit is worse than leaving it visible. See the NOTE printed below.
  //
  // Reading ::text keeps this assertion about the thing it claims to test —
  // that conversion stored the date it was given.
  const { rows: [stored] } = await q(
    `SELECT go_live_date::text AS d FROM sales_handovers WHERE id = $1`, [st.id]);
  check('and it carries the date', stored.d === '2026-12-01',
    `the stored go_live_date is ${stored.d}`);
  check('NOTE — fmt() still returns goLiveDate as a Date, not YYYY-MM-DD',
    conv?.goLiveDate instanceof Date || typeof conv?.goLiveDate === 'string',
    'unexpected type for goLiveDate');
  if (conv?.goLiveDate instanceof Date) {
    console.log('          ^ pre-existing: res.json() will serialise this as');
    console.log(`            ${conv.goLiveDate.toISOString()} — the previous day in UTC.`);
    console.log('            Fix backend and frontend together, not in a feature commit.');
  }

  check('logged work is untouched by the conversion',
    JSON.stringify(await readEntry()) === JSON.stringify(before),
    'the entry changed — the snapshot rule has been broken somewhere');

  const same = await expectOk('converting to the mode it already has is a no-op, not an error',
    () => svc.convertTrackingMode(st.id, orgId, userId, 'timeboxed'));
  check('the no-op returns the project unchanged', same?.trackingMode === 'timeboxed');

  console.log('\nCONVERT — time-boxed to standing, and the stale dates it strands');

  // A task scheduled from the go-live date. Conversion removes that date and
  // nothing recomputes it, so the caller has to be told before it happens.
  await q(
    `INSERT INTO project_play_instances
       (org_id, handover_id, stage_key, title, due_date, due_anchor, status)
     VALUES ($1,$2,'delivery','PT anchored task','2026-11-17','go_live','not_started')`,
    [orgId, st.id]);

  let conflict = null;
  try {
    await svc.convertTrackingMode(st.id, orgId, userId, 'standing');
    fail('conversion warns about go-live-anchored tasks', 'it converted silently');
  } catch (err) { conflict = err; }

  check('conversion warns about go-live-anchored tasks',
    conflict?.code === 'GO_LIVE_ANCHORED_PLAYS' && conflict?.status === 409,
    `got code ${conflict?.code} status ${conflict?.status}`);
  check('the warning names the affected tasks',
    conflict?.details?.plays?.length === 1 && conflict.details.plays[0].title === 'PT anchored task',
    `details were ${JSON.stringify(conflict?.details)}`);
  check('nothing was converted while the warning stood',
    (await svc.getById(st.id, orgId))?.trackingMode === 'timeboxed',
    'the write happened anyway — the check is not blocking');

  const back = await expectOk('converting proceeds once acknowledged',
    () => svc.convertTrackingMode(st.id, orgId, userId, 'standing',
      { acknowledgeAnchoredPlays: true }));
  check('it is standing afterwards', back?.trackingMode === 'standing');
  check('and the date is cleared', back?.goLiveDate == null, `goLiveDate is ${back?.goLiveDate}`);

  check('logged work survives the round trip',
    JSON.stringify(await readEntry()) === JSON.stringify(before));

  return { standingId: st.id };
}

/* ── status, retirement ────────────────────────────────────────────── */

async function lifecycleChecks({ orgId, userId, accountId }, { standingId }) {
  console.log('\nSTATUS — a standing initiative never completes');

  // Internal projects go draft -> in_progress directly; 'completed' is only
  // reachable from there, so the transition table has to be satisfied before
  // the tracking-mode guard is the thing being tested.
  await expectOk('a standing initiative can be started',
    () => svc.advanceStatus(standingId, orgId, userId, 'in_progress'));

  await expectRefusal('completing a standing initiative is refused', 400, /never completes/i,
    () => svc.advanceStatus(standingId, orgId, userId, 'completed'));
  await expectRefusal('and the refusal names retirement as the alternative', 400, /retire/i,
    () => svc.advanceStatus(standingId, orgId, userId, 'completed'));

  console.log('\nUPDATE — no back door for the end date');

  await expectRefusal('update() cannot give a standing initiative a go-live date', 400, /no end date/i,
    () => svc.update(standingId, orgId, { goLiveDate: '2026-12-31' }));

  console.log('\nRETIRE — never delete');

  const tb = await svc.createProject(orgId, userId, {
    kind: 'customer', name: 'PT not retirable', accountId,
    assignedServiceOwnerId: userId, goLiveDate: '2026-12-01' });
  await expectRefusal('a time-boxed project cannot be retired', 400, /standing initiative/i,
    () => svc.retire(tb.id, orgId, userId));

  const ret = await expectOk('a standing initiative can be retired',
    () => svc.retire(standingId, orgId, userId));
  check('retiredAt is set', ret?.retiredAt != null);
  check('retiredBy is the person who did it', ret?.retiredBy === userId, `got ${ret?.retiredBy}`);
  check('isRetired is true', ret?.isRetired === true);

  const again = await expectOk('retiring twice is a no-op, not an error',
    () => svc.retire(standingId, orgId, userId));
  check('the second retire did not move the timestamp',
    String(again?.retiredAt) === String(ret?.retiredAt),
    'retiring an already-retired initiative rewrote when it happened');

  await expectRefusal('a retired initiative cannot be converted', 400, /un-retire/i,
    () => svc.convertTrackingMode(standingId, orgId, userId, 'timeboxed',
      { assignedServiceOwnerId: userId, goLiveDate: '2026-12-01' }));

  const un = await expectOk('un-retiring works', () => svc.unretire(standingId, orgId));
  check('both retirement columns clear together', un?.retiredAt == null && un?.retiredBy == null,
    'chk_sh_retired_shape requires them to move as a pair');
}

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  let fx;
  try {
    fx = await setup();
    const created = await creationChecks(fx);
    await listChecks(fx, created);
    const conv = await conversionChecks(fx);
    await lifecycleChecks(fx, conv);
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
  console.log('tracking mode service layer verified.\n');
})();
