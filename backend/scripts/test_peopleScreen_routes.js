#!/usr/bin/env node
// test_peopleScreen_routes.js
//
//   cd C:\Projects\dw-verify
//   node test_peopleScreen_routes.js
//
// Covers the two endpoints added for the People screen:
//
//   GET /people/overdue                        the queue behind the chip
//   GET /people/:userId/project/:handoverId    is this task link still honest
//
// ── Why this drives the ROUTES, not the services ─────────────────────
//
// The other harnesses in this folder test service functions. That is the right
// level for a query. It is the WRONG level here, because for these two the
// interesting logic is not in a service at all — it is the composition:
//
//   which visible set is consulted, in which order the two refusals are
//   checked, which status code each returns, and whether the reason string
//   the client renders verbatim actually says what happened.
//
// A service-level test would have to restate that composition to assert it,
// and a restated rule passes happily while the route it mirrors is wrong. So
// this file loads the real route module, captures the handlers it registers,
// and calls them with a req/res double. The services underneath run for real
// against the database.
//
// ── POSITIVE CONTROLS COME FIRST ─────────────────────────────────────
//
// Every refusal assertion is preceded by the same link resolving. A 403 is
// indistinguishable from a fixture that never reached the code — wrong org,
// failed insert, a typo — and that failure mode looks exactly like success.
// So: prove the link opens, THEN break its basis, THEN prove it refuses.
//
// ── Isolation ────────────────────────────────────────────────────────
//
// Fixture org, torn down in a finally. Not rollback-based: the services run
// their own transactions, which an outer BEGIN here would be invisible to.

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
  try { return fs.existsSync(path.join(p, 'routes', 'dailyWork.routes.js')); }
  catch { return false; }
});

if (!REPO) {
  console.error('\nCould not find the backend. Looked in:\n');
  REPO_CANDIDATES.forEach(p => console.error('  ' + p));
  console.error('\nSet it explicitly:\n  set DW_REPO=C:\\Projects\\action-crm-clean\\backend\n');
  process.exit(2);
}

/* ── database, substituted before anything in the repo loads ───────── */

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

function cache(relPath, exports) {
  const p = path.resolve(REPO, relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports };
}

cache('config/database.js', {
  pool, db: pool, withOrgTransaction, query: (t, p) => pool.query(t, p),
});

// Capture the routes instead of mounting them. express.Router() is replaced
// with a recorder; router.use() is swallowed, since the middleware chain is
// stubbed below and there is nothing for it to do.
const routes = { get: new Map(), post: new Map(), patch: new Map(), put: new Map(), delete: new Map() };
const record = (m) => (p, ...h) => { routes[m].set(p, h[h.length - 1]); return fakeRouter; };
const fakeRouter = {
  use: () => fakeRouter,
  get: record('get'), post: record('post'), patch: record('patch'),
  put: record('put'), delete: record('delete'),
};

// Substitution by REQUEST NAME, not by resolved path.
//
// The obvious version — require.resolve('express') then poke require.cache —
// needs express to be installed somewhere reachable from here, and dies with
// MODULE_NOT_FOUND if the backend's node_modules is absent or this folder has
// its own. Intercepting the load hides that difference: nothing needs
// installing, because nothing real is ever loaded.
//
// Middleware is stubbed to nothing for the same reason it is stubbed at all —
// this file tests two handlers, and auth/orgContext/requireModule are other
// files' problem. Leaving them real would mean minting a JWT to test a SQL
// predicate. What orgContext WOULD have set (req.orgId, req.userId) is set by
// hand in the req double below, which keeps the thing under test honest: if a
// handler starts depending on some other field it provides, it fails here
// loudly rather than passing on a value the harness invented.
const Module = require('module');
const passthrough = (req, res, next) => next();
const BY_NAME = new Map([
  ['express', Object.assign(() => fakeRouter, { Router: () => fakeRouter })],
]);
const BY_SUFFIX = [
  ['middleware/auth.middleware', passthrough],
  ['middleware/orgContext.middleware', { orgContext: passthrough, requireRole: () => passthrough }],
  ['middleware/requireModule.middleware', () => passthrough],
];

// A callable-and-indexable stub, for third-party packages this harness pulls
// in transitively and never uses.
//
// handover.service requires orgAdmin.routes, which requires multer. None of
// that is on the path being tested, but a bare MODULE_NOT_FOUND anywhere in
// that graph takes the whole run down. Rather than requiring every dependency
// of the app to be reachable from wherever this is run, unresolvable BARE
// requires (never relative ones — those are repo files, and a miss there is a
// real break worth failing on) become stubs.
//
// Callable AND indexable because both shapes occur: multer is a function,
// most services export an object, and a stub that is only one of the two
// breaks on the other.
const makeStub = () => {
  const fn = function stub() { return stub; };
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === 'then') return undefined;
      if (!(k in t)) t[k] = makeStub();
      return t[k];
    },
    apply: () => makeStub(),
    construct: () => makeStub(),
  });
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (BY_NAME.has(request)) return BY_NAME.get(request);
  const norm = request.replace(/\\/g, '/');
  for (const [suffix, exports] of BY_SUFFIX) {
    if (norm.endsWith(suffix) || norm.endsWith(suffix + '.js')) return exports;
  }
  try {
    return origLoad.call(this, request, parent, isMain);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && !request.startsWith('.') && !path.isAbsolute(request)) {
      return makeStub();
    }
    throw err;
  }
};

const routePath = path.resolve(REPO, 'routes', 'dailyWork.routes.js');
require(routePath);
console.log(`\ntesting: ${routePath}`);
console.log(`target:  ${CONN.replace(/:[^:@/]+@/, ':****@')}`);

const OVERDUE_PATH = '/people/overdue';
const LINK_PATH    = '/people/:userId/project/:handoverId';

for (const p of [OVERDUE_PATH, LINK_PATH]) {
  if (!routes.get.has(p)) {
    console.error(`\nGET ${p} is not registered. Nothing below would mean anything.\n`);
    process.exit(2);
  }
}

// Route ordering matters and is not visible from the handler itself: Express
// matches in declaration order, so if '/people/:userId' were declared first,
// 'overdue' would be captured as a :userId and this endpoint would never run.
// Map preserves insertion order, so the registration order is testable.
const declared = [...routes.get.keys()];

/* ── calling a handler ─────────────────────────────────────────────── */

// Minimal res double. Records rather than sends, and resolves a promise so the
// caller can await a handler that has no callback of its own.
function callRoute(handler, { params = {}, query = {}, orgId, userId }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    handler({ params, query, orgId, userId, user: { userId } }, res)
      .catch(err => resolve({ status: 500, body: { error: err.message } }));
  });
}

/* ── assertions ────────────────────────────────────────────────────── */

let passed = 0, failed = 0;
const failures = [];

function pass(n) { passed++; console.log(`  PASS  ${n}`); }
function fail(n, d) { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); }
function check(n, cond, d) { cond ? pass(n) : fail(n, d || 'condition was false'); }

const q = (sql, params) => pool.query(sql, params);

/* ── fixtures ──────────────────────────────────────────────────────── */

const FIXTURE_ORG  = 'PEOPLE_ROUTES_FIXTURE';
const FIXTURE_SLUG = 'people-routes-fixture';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['daily_work_entries', 'daily_work_items',
                   'daily_work_schedules', 'daily_work_exceptions', 'daily_activity_types',
                   'sales_handover_commitments', 'project_play_instances',
                   'sales_handover_plays', 'project_members', 'sales_handovers',
                   'org_hierarchy', 'org_users', 'users', 'accounts']) {
    await q(`DELETE FROM ${t} WHERE org_id = ${org}`, [FIXTURE_ORG]);
  }
  await q(`DELETE FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  const { rows: [left] } = await q(
    `SELECT count(*)::int AS n FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  if (left.n) throw new Error('fixture org still present after teardown');
}

// Dates relative to today, so the fixture does not rot. A hard-coded
// '2026-01-05' is overdue forever, right up until it silently is not.
//
// LOCAL, not UTC, and that is not cosmetic. handover.service's toDateStr uses
// getFullYear/getMonth/getDate, so 'today' on the server is the local date.
// Building these with toISOString() instead would put the fixture a day out
// whenever local and UTC dates differ — in IST that is every day between
// midnight and 05:30, which is a test that fails only on early mornings.
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let fixtureCreated = false;

async function setup() {
  await teardown();
  // Set before the first insert, not after the last: if setup dies half way
  // the rows that DID land still need clearing, and a flag set at the end
  // would tell the operator nothing needs doing.
  fixtureCreated = true;

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`,
    [FIXTURE_ORG, FIXTURE_SLUG]);

  const stamp = Date.now();
  const mkUser = async (first) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
       VALUES ($1,'x',$2,'Fixture',$3) RETURNING id`,
      [`${first.toLowerCase()}.${stamp}@people.invalid`, first, org.id]);
    await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1,$2,'member')`,
      [org.id, u.id]);
    return u.id;
  };

  const manager   = await mkUser('Manager');
  const report    = await mkUser('Report');
  const outsider  = await mkUser('Outsider');   // in the org, NOT in the team
  const otherMgr  = await mkUser('Othermgr');

  // Report reports to Manager. Outsider reports to nobody, so getSubordinates
  // will not return them — which is what makes the not-in-your-team refusal
  // testable rather than theoretical.
  await q(`INSERT INTO org_hierarchy (org_id, user_id, reports_to, relationship_type)
           VALUES ($1,$2,$3,'solid')`, [org.id, report, manager]);

  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('People Fixture Account',$1) RETURNING id`,
    [org.id]);

  const handover = async (name, cols = {}) => {
    const { kind = 'customer', trackingMode = 'timeboxed',
            goLiveDate = null, accountId = account.id } = cols;
    const { rows: [h] } = await q(
      `INSERT INTO sales_handovers
         (org_id, project_kind, name, status, tracking_mode, go_live_date, account_id, created_by)
       VALUES ($1,$2,$3,'in_progress',$4,$5,$6,$7) RETURNING id`,
      [org.id, kind, name,
       trackingMode, goLiveDate,
       kind === 'internal' ? null : accountId, manager]);
    return h.id;
  };

  const project   = await handover('PR Timeboxed Project', { goLiveDate: dayOffset(60) });
  const initiative = await handover('PR Standing Initiative',
    { kind: 'internal', trackingMode: 'standing' });

  const play = async (handoverId, title, { due, owner, status = 'not_started' }) => {
    const { rows: [p] } = await q(
      `INSERT INTO project_play_instances
         (handover_id, org_id, stage_key, title, due_date, owner_user_id, status)
       VALUES ($1,$2,'kickoff',$3,$4,$5,$6) RETURNING id`,
      [handoverId, org.id, title, due, owner, status]);
    return p.id;
  };

  const ids = {
    orgId: org.id, manager, report, outsider, otherMgr,
    project, initiative,

    // The row the link assertions use. Overdue, open, owned by the report.
    overdueTask: await play(project, 'PR Overdue Task',
      { due: dayOffset(-10), owner: report }),
    // Open but not yet due — must be reachable by link, absent from the queue.
    futureTask: await play(project, 'PR Future Task',
      { due: dayOffset(+10), owner: report }),
    // On a standing initiative: never late, whatever its date says.
    standingTask: await play(initiative, 'PR Standing Task',
      { due: dayOffset(-30), owner: report }),
    // Someone else's overdue work, to prove the visible-set filter bites.
    outsiderTask: await play(project, 'PR Outsider Task',
      { due: dayOffset(-5), owner: outsider }),
  };

  const { rows: [commitment] } = await q(
    `INSERT INTO sales_handover_commitments
       (handover_id, org_id, description, due_date, owner_user_id, status, created_by)
     VALUES ($1,$2,'PR Overdue Commitment',$3,$4,'open',$5) RETURNING id`,
    [project, org.id, dayOffset(-3), report, manager]);
  ids.commitment = commitment.id;

  return ids;
}

/* ── route ordering ────────────────────────────────────────────────── */

function orderingChecks() {
  console.log('\nORDERING — a static route behind a parameterised one never runs');

  const iOverdue = declared.indexOf(OVERDUE_PATH);
  const iPerson  = declared.indexOf('/people/:userId');

  check('/people/overdue is declared before /people/:userId',
    iPerson === -1 || iOverdue < iPerson,
    `overdue at ${iOverdue}, :userId at ${iPerson} — Express matches in order, so ` +
    `'overdue' would be captured as a userId and 400 instead of running`);
}

/* ── the link check ────────────────────────────────────────────────── */

async function linkChecks(fx) {
  const handler = routes.get.get(LINK_PATH);
  const ask = (userId, handoverId, viewer = fx.manager) =>
    callRoute(handler, {
      params: { userId: String(userId), handoverId: String(handoverId) },
      orgId: fx.orgId, userId: viewer,
    });

  console.log('\nLINK — it resolves (these are the controls for every refusal below)');

  const ok = await ask(fx.report, fx.project);
  check('a manager may open a subordinate\'s time-boxed project',
    ok.status === 200 && ok.body.ok === true,
    `got ${ok.status} ${JSON.stringify(ok.body)}`);
  check('and is told which board tab it lives on',
    ok.body.scope === 'assigned', `scope was '${ok.body.scope}'`);
  check('and gets the project name back',
    ok.body.project === 'PR Timeboxed Project', `got '${ok.body.project}'`);

  const standing = await ask(fx.report, fx.initiative);
  check('a standing initiative resolves to the initiatives tab',
    standing.status === 200 && standing.body.scope === 'initiatives',
    `got ${standing.status}, scope '${standing.body.scope}'`);

  console.log('\nLINK — refusals, each with its control proven above');

  const outsider = await ask(fx.outsider, fx.project);
  check('someone outside your team is refused',
    outsider.status === 403 && outsider.body.ok === false,
    `got ${outsider.status}`);
  check('and the refusal says it is about the person, not the project',
    /team/i.test(outsider.body.reason || ''),
    `reason was '${outsider.body.reason}'`);

  // Every refusal carries text the client renders verbatim. A 403 with no
  // reason renders as an empty banner, which is worse than no banner.
  check('every refusal carries a non-empty reason',
    typeof outsider.body.reason === 'string' && outsider.body.reason.trim() !== '');

  // A project the person has NO task on. Not a permissions failure — the
  // derived basis simply never existed.
  const otherProject = await ask(fx.report, 999999);
  check('a project this person has no task on is refused',
    otherProject.status === 403, `got ${otherProject.status}`);

  console.log('\nLINK — the basis lapsing between page load and click');

  // 1. reassigned away
  await q(`UPDATE project_play_instances SET owner_user_id = $1 WHERE id = $2`,
    [fx.outsider, fx.overdueTask]);
  await q(`UPDATE project_play_instances SET owner_user_id = $1 WHERE id = $2`,
    [fx.outsider, fx.futureTask]);
  const reassigned = await ask(fx.report, fx.project);
  check('reassigning every task away refuses the link',
    reassigned.status === 403, `got ${reassigned.status}`);
  check('and the reason mentions reassignment or completion',
    /reassign|complet/i.test(reassigned.body.reason || ''),
    `reason was '${reassigned.body.reason}'`);

  await q(`UPDATE project_play_instances SET owner_user_id = $1 WHERE id = ANY($2)`,
    [fx.report, [fx.overdueTask, fx.futureTask]]);
  const restored = await ask(fx.report, fx.project);
  check('giving them back restores the link',
    restored.status === 200, 'the refusal above was not caused by the reassignment');

  // 2. completed
  await q(`UPDATE project_play_instances SET status = 'completed' WHERE id = ANY($1)`,
    [[fx.overdueTask, fx.futureTask]]);
  const completed = await ask(fx.report, fx.project);
  check('completing every task refuses the link',
    completed.status === 403, `got ${completed.status}`);
  await q(`UPDATE project_play_instances SET status = 'not_started' WHERE id = ANY($1)`,
    [[fx.overdueTask, fx.futureTask]]);

  // 3. retired — the case 2026_133 exists for
  await q(`UPDATE sales_handovers SET retired_at = NOW(), retired_by = $1 WHERE id = $2`,
    [fx.manager, fx.initiative]);
  const retired = await ask(fx.report, fx.initiative);
  check('a retired initiative refuses the link',
    retired.status === 403, `got ${retired.status}`);
  await q(`UPDATE sales_handovers SET retired_at = NULL, retired_by = NULL WHERE id = $1`,
    [fx.initiative]);
  const unretired = await ask(fx.report, fx.initiative);
  check('un-retiring restores it',
    unretired.status === 200, 'retirement is meant to be reversible end to end');

  // 4. project closed
  await q(`UPDATE sales_handovers SET status = 'completed' WHERE id = $1`, [fx.project]);
  const closed = await ask(fx.report, fx.project);
  check('a completed project refuses the link',
    closed.status === 403, `got ${closed.status}`);
  await q(`UPDATE sales_handovers SET status = 'in_progress' WHERE id = $1`, [fx.project]);

  console.log('\nLINK — malformed input');

  const bad = await callRoute(handler, {
    params: { userId: 'overdue', handoverId: '12' }, orgId: fx.orgId, userId: fx.manager });
  check('a non-numeric userId is a 400, not a 500',
    bad.status === 400, `got ${bad.status}`);
}

/* ── the overdue queue ─────────────────────────────────────────────── */

async function overdueChecks(fx) {
  const handler = routes.get.get(OVERDUE_PATH);
  const ask = (viewer) => callRoute(handler, { orgId: fx.orgId, userId: viewer });

  console.log('\nOVERDUE — what the queue contains');

  const { status, body } = await ask(fx.manager);
  check('the endpoint answers', status === 200, `got ${status}`);
  const items = body.items || [];
  const titles = items.map(i => i.title);

  check('an overdue task on a time-boxed project IS listed',
    titles.includes('PR Overdue Task'),
    `got: ${titles.join(', ') || '(nothing)'}`);
  check('an overdue commitment IS listed too',
    titles.includes('PR Overdue Commitment'),
    'the chip counts commitments, so the queue must as well or the two disagree');

  check('a task not yet due is NOT listed',
    !titles.includes('PR Future Task'));
  check('a task on a STANDING initiative is NOT listed',
    !titles.includes('PR Standing Task'),
    'an initiative has no end, so work on one is never late');
  check('work belonging to someone outside the team is NOT listed',
    !titles.includes('PR Outsider Task'),
    'the queue must not show rows for people whose row is not on the list above it');

  console.log('\nOVERDUE — shape');

  const row = items.find(i => i.title === 'PR Overdue Task');
  check('rows carry userId', row && Number.isInteger(row.userId));
  check('rows carry NO name',
    row && row.name === undefined,
    'names come from the rollup — a second source drifts after a rename');
  check('daysOver is computed server-side and is right',
    row && row.daysOver === 10, `daysOver was ${row && row.daysOver}, expected 10`);
  check('rows carry handoverId, so each can link into its project',
    row && row.handoverId === fx.project);
  check('worst first', items.length < 2 ||
    items.every((r, i) => i === 0 || items[i - 1].dueDate <= r.dueDate));

  console.log('\nOVERDUE — lockstep with the number on the chip');

  // The chip sums getProjectWorkloadByUser's overdue_count; the panel lists
  // these rows. They are separate queries over the same idea, which is exactly
  // the arrangement that drifts. This is the assertion that catches it.
  const svc = require(path.resolve(REPO, 'services', 'handover.service.js'));
  const workload = await svc.getProjectWorkloadByUser(fx.orgId,
    [fx.manager, fx.report]);
  const chipTotal = [...workload.values()].reduce((n, w) => n + w.overdueTasks, 0);
  check('the chip total equals the number of rows in the queue',
    chipTotal === items.length,
    `chip would say ${chipTotal}, queue has ${items.length} — the two queries have drifted`);

  console.log('\nOVERDUE — another manager');

  const other = await ask(fx.otherMgr);
  const otherTitles = (other.body.items || []).map(i => i.title);
  check('a manager with no reports sees none of this team\'s work',
    !otherTitles.includes('PR Overdue Task') &&
    !otherTitles.includes('PR Overdue Commitment'),
    `leaked: ${otherTitles.join(', ')}`);
}

/* ── run ───────────────────────────────────────────────────────────── */

(async () => {
  let fx;
  try {
    orderingChecks();
    fx = await setup();
    // Overdue first: linkChecks mutates ownership and status as it goes, and
    // leaves the fixture restored but not provably so.
    await overdueChecks(fx);
    await linkChecks(fx);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try {
      if (fixtureCreated) { await teardown(); console.log('\nfixture torn down'); }
    } catch (err) {
      // Only alarming if something was actually written. A run that died
      // before the first insert — no database, wrong URL — leaves nothing
      // behind, and saying otherwise sends the operator hunting for rows
      // that were never created.
      console.log(`\nWARNING: teardown failed — ${err.message}`);
      console.log(`The fixture org '${FIXTURE_ORG}' may still be PRESENT.`);
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('people screen routes verified.\n');
})();
