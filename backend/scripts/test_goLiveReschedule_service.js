#!/usr/bin/env node
// test_goLiveReschedule_service.js
//
//   cd C:\Projects\dw-verify
//   node test_goLiveReschedule_service.js
//
// Exercises the REAL handover.service.js against a real database.
//
// WHAT THIS IS GUARDING. Moving a go-live now moves the checklist — but only
// while the plan is not frozen, and never without writing a revision row. Both
// halves of that fail SILENTLY if they break: a rescheduler that skips the
// frozen check overwrites a committed baseline and nobody finds out until a
// variance report is wrong, and one that skips the revision insert loses the
// audit trail with no error anywhere. So each is asserted from both sides —
// that it happens when it should AND that it does not when it should not.
//
// The negative assertions matter more than the positive ones here. "It did not
// move a frozen plan" is only meaningful next to "it did move an unfrozen one",
// so every skip case is paired with its control.

const path = require('path');
const fs   = require('fs');

try { require('dotenv').config(); } catch {}

let Pool;
try { ({ Pool } = require('pg')); }
catch { console.error('\nRun `npm install pg dotenv` in this folder first.\n'); process.exit(2); }

const CONN = process.env.DATABASE_URL;
if (!CONN) { console.error('\nNo DATABASE_URL. Set it in .env or inline.\n'); process.exit(2); }

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
  console.error('\nCould not find the backend. Set DW_REPO explicitly.\n');
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
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}

function cache(relPath, exports) {
  const p = path.resolve(REPO, relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports };
}

cache('config/database.js', { pool, db: pool, withOrgTransaction, query: (t, p) => pool.query(t, p) });

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
  ownerColumn: () => 'assigned_service_owner_id',
  canUseOrgScope: () => true,
  resolveRole: async () => 'owner',
});

const svc = require(path.resolve(REPO, 'services', 'handover.service.js'));
console.log(`\ntesting: ${path.resolve(REPO, 'services', 'handover.service.js')}`);
console.log(`target:  ${CONN.replace(/:[^:@/]+@/, ':****@')}`);

let passed = 0, failed = 0;
const failures = [];
function pass(n) { passed++; console.log(`  PASS  ${n}`); }
function fail(n, d) { failed++; failures.push(n); console.log(`  FAIL  ${n}\n          ${d}`); }
function check(n, cond, d) { cond ? pass(n) : fail(n, d || 'condition was false'); }

const q = (sql, params) => pool.query(sql, params);

const FIXTURE_ORG  = 'GLRS_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'glrs-verify-fixture';

async function teardown() {
  const org = `(SELECT id FROM organizations WHERE name = $1)`;
  for (const t of ['play_due_date_revisions',
                   'daily_work_entries', 'daily_work_items',
                   'sales_handover_plays', 'deal_play_instances',
                   'project_play_instances', 'project_members',
                   'sales_handovers',
                   'playbook_plays', 'playbook_stages', 'playbooks',
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
    `INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [FIXTURE_ORG, FIXTURE_SLUG]);
  const { rows: [user] } = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
     VALUES ($1,'x','Fixture','User',$2) RETURNING id`,
    [`glrs.verify.${Date.now()}@fixture.invalid`, org.id]);
  await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, user.id]);
  const { rows: [account] } = await q(
    `INSERT INTO accounts (name, org_id) VALUES ('GLRS Fixture Account',$1) RETURNING id`, [org.id]);

  // A playbook play carrying a NEGATIVE offset, which is the real shape:
  // "UAT sign-off two weeks before go-live" is due_offset_days = -14.
  const { rows: [pb] } = await q(
    `INSERT INTO playbooks (org_id, name, type, created_by)
     VALUES ($1, 'GLRS fixture playbook', 'handover_s2i', $2) RETURNING id`, [org.id, user.id]);
  const { rows: [play] } = await q(
    `INSERT INTO playbook_plays (org_id, playbook_id, stage_key, title, due_anchor, due_offset_days)
     VALUES ($1, $2, 'delivery', 'UAT sign-off', 'go_live', -14) RETURNING id`, [org.id, pb.id]);

  return { orgId: org.id, userId: user.id, accountId: account.id, playId: play.id };
}

/** A project plus one go_live-anchored play, in whatever starting state. */
async function mkProject({ orgId, userId, accountId, playId },
                         { goLive = null, dueDate = null, frozen = false, baseline = null } = {}) {
  const { rows: [h] } = await q(
    `INSERT INTO sales_handovers
       (org_id, project_kind, name, account_id, tracking_mode, go_live_date,
        status, created_by, assigned_service_owner_id, baseline_frozen_at)
     VALUES ($1,'customer','GLRS project',$2,'timeboxed',$3,'in_progress',$4,$4,$5)
     RETURNING id`,
    [orgId, accountId, goLive, userId, frozen ? new Date().toISOString() : null]);

  const { rows: [p] } = await q(
    `INSERT INTO project_play_instances
       (org_id, handover_id, play_id, stage_key, title, due_date, due_anchor, status,
        baseline_due_date, baseline_source)
     VALUES ($1,$2,$3,'delivery','UAT sign-off',$4,'go_live','not_started',$5,$6)
     RETURNING id`,
    [orgId, h.id, playId, dueDate, baseline, baseline ? 'original' : null]);

  return { handoverId: h.id, playId: p.id };
}

const dueOf = async id =>
  (await q(`SELECT due_date::text AS d FROM project_play_instances WHERE id = $1`, [id])).rows[0].d;
const baselineOf = async id =>
  (await q(`SELECT baseline_due_date::text AS d, baseline_source AS s
              FROM project_play_instances WHERE id = $1`, [id])).rows[0];
const revisionsOf = async id =>
  (await q(`SELECT from_due_date::text AS f, to_due_date::text AS t, reason,
                   is_rebaseline, revised_by
              FROM play_due_date_revisions
             WHERE project_play_instance_id = $1 ORDER BY id`, [id])).rows;

/* ── first set: NULL -> a date ──────────────────────────────────────── */

async function firstSetChecks(fx) {
  console.log('\nFIRST SET — a go-live where there was none');

  // Unfrozen. due_date NULL, so nothing is being disturbed.
  const a = await mkProject(fx, { goLive: null, dueDate: null });
  await svc.update(a.handoverId, fx.orgId, { goLiveDate: '2026-12-01' }, fx.userId);
  check('an unscheduled play is scheduled from the offset',
    await dueOf(a.playId) === '2026-11-17',
    `due_date is ${await dueOf(a.playId)}, expected 2026-12-01 minus 14 days`);

  // The case that sits outside the frozen rule on purpose: there is no plan to
  // disturb, so a frozen project gets its unscheduled plays filled in too.
  const b = await mkProject(fx, { goLive: null, dueDate: null, frozen: true });
  await svc.update(b.handoverId, fx.orgId, { goLiveDate: '2026-12-01' }, fx.userId);
  check('a FROZEN project still gets its unscheduled plays filled in',
    await dueOf(b.playId) === '2026-11-17',
    `due_date is ${await dueOf(b.playId)} — the first-set carve-out is not firing`);

  const revs = await revisionsOf(a.playId);
  check('the first set is logged as a revision', revs.length === 1, `${revs.length} revisions`);
  check('with no from-date, because there was none',
    revs[0]?.f === null, `from_due_date is ${revs[0]?.f}`);
  check('and it is not marked a rebaseline',
    revs[0]?.is_rebaseline === false);
  check('and it names who did it',
    revs[0]?.revised_by === fx.userId, `revised_by is ${revs[0]?.revised_by}`);
}

/* ── subsequent move, unfrozen: option B ────────────────────────────── */

async function unfrozenChecks(fx) {
  console.log('\nUNFROZEN — the plan is provisional, so it moves');

  const a = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-17' });
  const res = await svc.update(a.handoverId, fx.orgId, { goLiveDate: '2026-12-08' }, fx.userId);

  check('the play shifts by the same delta as the go-live',
    await dueOf(a.playId) === '2026-11-24',
    `due_date is ${await dueOf(a.playId)}, expected +7 days`);
  check('the caller is told what moved',
    res?.reschedule?.rescheduled === 1,
    `reschedule payload was ${JSON.stringify(res?.reschedule)}`);

  const revs = await revisionsOf(a.playId);
  check('the move is logged', revs.length === 1, `${revs.length} revisions`);
  check('with both dates', revs[0]?.f === '2026-11-17' && revs[0]?.t === '2026-11-24',
    `${revs[0]?.f} -> ${revs[0]?.t}`);
  check('and a reason naming the go-live change',
    /go-live/i.test(revs[0]?.reason || ''), `reason was "${revs[0]?.reason}"`);

  // DELTA, not recompute. A date somebody deliberately nudged must keep its
  // nudge — recomputing from the offset would erase every manual adjustment on
  // the checklist and there would be no sign it had happened.
  const b = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-10' });  // nudged 7 early
  await svc.update(b.handoverId, fx.orgId, { goLiveDate: '2026-12-08' }, fx.userId);
  check('a manually adjusted date keeps its adjustment',
    await dueOf(b.playId) === '2026-11-17',
    `due_date is ${await dueOf(b.playId)} — expected the nudge preserved (+7 from 11-10), ` +
    'not a recompute from the offset (which would give 2026-11-24)');

  // Moving it backwards has to work too, and negative deltas are where an
  // interval built by string concatenation goes wrong.
  const c = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-17' });
  await svc.update(c.handoverId, fx.orgId, { goLiveDate: '2026-11-24' }, fx.userId);
  check('pulling the go-live earlier moves the play earlier',
    await dueOf(c.playId) === '2026-11-10',
    `due_date is ${await dueOf(c.playId)}, expected -7 days`);
}

/* ── subsequent move, frozen: option C ──────────────────────────────── */

async function frozenChecks(fx) {
  console.log('\nFROZEN — the plan is a commitment, so it does not move');

  const a = await mkProject(fx, {
    goLive: '2026-12-01', dueDate: '2026-11-17', frozen: true, baseline: '2026-11-17' });
  const res = await svc.update(a.handoverId, fx.orgId, { goLiveDate: '2026-12-08' }, fx.userId);

  check('the go-live itself still saves',
    String(res?.goLiveDate).startsWith('2026-12-08'), `goLiveDate is ${res?.goLiveDate}`);
  check('the play does NOT move', await dueOf(a.playId) === '2026-11-17',
    `due_date became ${await dueOf(a.playId)} — a committed plan was silently rewritten`);

  const bl = await baselineOf(a.playId);
  check('the baseline is untouched', bl.d === '2026-11-17' && bl.s === 'original',
    `baseline is ${bl.d} / ${bl.s}`);
  check('no revision is written for a move that did not happen',
    (await revisionsOf(a.playId)).length === 0);
  check('the caller is told how many were left alone',
    res?.reschedule?.skippedFrozen === 1 && res?.reschedule?.frozen === true,
    `reschedule payload was ${JSON.stringify(res?.reschedule)}`);

  console.log('\nFROZEN — and the drift is reported rather than hidden');

  const drift = await svc.getGoLiveDrift(a.handoverId, fx.orgId);
  check('drift reports the project as frozen', drift.frozen === true);
  check('drift names the play that is now out of step',
    drift.plays.length === 1 && drift.plays[0].id === a.playId,
    JSON.stringify(drift.plays));
  check('drift gives the date it would have had',
    drift.plays[0]?.expectedDueDate === '2026-11-24',
    `expected 2026-11-24, got ${drift.plays[0]?.expectedDueDate}`);
  check('drift gives the gap in days', drift.plays[0]?.driftDays === 7,
    `driftDays is ${drift.plays[0]?.driftDays}`);

  // The control. An unfrozen project has already been rescheduled, so any
  // remaining difference is a deliberate manual adjustment — reporting that as
  // drift would be telling someone their own edit was a mistake.
  const b = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-10' });
  const noDrift = await svc.getGoLiveDrift(b.handoverId, fx.orgId);
  check('an unfrozen project reports no drift even when dates differ',
    noDrift.frozen === false && noDrift.plays.length === 0,
    JSON.stringify(noDrift));
}

/* ── the things that must NOT trigger a reschedule ──────────────────── */

async function noopChecks(fx) {
  console.log('\nNO-OP — saves that must not touch the checklist');

  // The one that would be invisible: fmt() returns a string and RETURNING gives
  // a Date. Comparing those directly finds them always different and shifts the
  // whole checklist on a save that touched only the contract value.
  const a = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-17' });
  const res = await svc.update(a.handoverId, fx.orgId, { contractValue: 50000 }, fx.userId);
  check('editing an unrelated field does not move any date',
    await dueOf(a.playId) === '2026-11-17',
    `due_date became ${await dueOf(a.playId)} on a save that never mentioned the go-live`);
  check('and reports no reschedule at all', res?.reschedule === undefined,
    `reschedule payload was ${JSON.stringify(res?.reschedule)}`);
  check('and writes no revision', (await revisionsOf(a.playId)).length === 0);

  // Re-saving the same date is not a change.
  const b = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-17' });
  await svc.update(b.handoverId, fx.orgId, { goLiveDate: '2026-12-01' }, fx.userId);
  check('re-saving the same go-live is not a move',
    (await revisionsOf(b.playId)).length === 0,
    'a no-op save produced a revision row');

  // Closed work is history. Shifting a completed task's due date would rewrite
  // what happened.
  const c = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-17' });
  await q(`UPDATE project_play_instances SET status = 'completed' WHERE id = $1`, [c.playId]);
  await svc.update(c.handoverId, fx.orgId, { goLiveDate: '2026-12-08' }, fx.userId);
  check('a completed play is not rescheduled', await dueOf(c.playId) === '2026-11-17',
    `due_date became ${await dueOf(c.playId)} — closed work was rewritten`);

  // Without an author there is no revision row possible, and moving dates
  // anonymously is worse than not moving them.
  const d = await mkProject(fx, { goLive: '2026-12-01', dueDate: '2026-11-17' });
  await svc.update(d.handoverId, fx.orgId, { goLiveDate: '2026-12-08' });   // no userId
  check('no userId means no reschedule rather than an unattributed one',
    await dueOf(d.playId) === '2026-11-17',
    `due_date became ${await dueOf(d.playId)} with nobody to attribute it to`);
}

/* ── conversion path ────────────────────────────────────────────────── */

async function conversionChecks(fx) {
  console.log('\nCONVERSION — standing to time-boxed sets a go-live for the first time');

  const { rows: [h] } = await q(
    `INSERT INTO sales_handovers
       (org_id, project_kind, name, tracking_mode, status, created_by)
     VALUES ($1,'internal','GLRS standing','standing','in_progress',$2) RETURNING id`,
    [fx.orgId, fx.userId]);
  const { rows: [p] } = await q(
    `INSERT INTO project_play_instances
       (org_id, handover_id, play_id, stage_key, title, due_date, due_anchor, status)
     VALUES ($1,$2,$3,'delivery','UAT sign-off',NULL,'go_live','not_started') RETURNING id`,
    [fx.orgId, h.id, fx.playId]);

  const res = await svc.convertTrackingMode(h.id, fx.orgId, fx.userId, 'timeboxed',
    { assignedServiceOwnerId: fx.userId, goLiveDate: '2026-12-01' });

  check('conversion schedules the previously unscheduled play',
    await dueOf(p.id) === '2026-11-17',
    `due_date is ${await dueOf(p.id)}`);
  check('and reports it', res?.reschedule?.scheduled === 1,
    `reschedule payload was ${JSON.stringify(res?.reschedule)}`);
  check('a standing initiative reports no drift',
    (await svc.getGoLiveDrift(h.id, fx.orgId)).plays.length === 0);
}

/* ── run ────────────────────────────────────────────────────────────── */

(async () => {
  let fx;
  try {
    fx = await setup();
    await firstSetChecks(fx);
    await unfrozenChecks(fx);
    await frozenChecks(fx);
    await noopChecks(fx);
    await conversionChecks(fx);
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
  console.log('go-live rescheduling verified.\n');
})();
