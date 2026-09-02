#!/usr/bin/env node
/**
 * verify_task_linked_136.js — behavioural verification of migration 2026_136.
 *
 * STANDALONE, same shape as verify_daily_work_132.js. Run it the same way:
 *
 *   cd C:\\Projects\\dw-verify
 *   node verify_task_linked_136.js
 *
 * with DATABASE_URL either in .env or set inline.
 *
 * What it proves, beyond "the column exists":
 *
 *   - one item per (person, task), and one per person on the SAME task —
 *     the partial unique index has to permit the second and refuse the first
 *   - a linked RECURRING item is refused, so neither trigger can ever write a
 *     status that chk_dwi_status_by_kind rejects
 *   - completing a task closes its items as 'completed'; skipping and
 *     cancelling close them as 'dropped'; both people's items move
 *   - a task update that does not MOVE the status is a no-op, which is the
 *     guard that keeps due-date and sort_order rewrites off this table
 *   - an item already closed is not re-closed, so closed_at does not drift
 *   - completing, cancelling and RETIRING a project close the items on its
 *     tasks — retirement is a timestamp, not a status, and needs its own arm
 *   - ordinary unlinked items are untouched by every one of the above
 *   - a task with logged work against it cannot be deleted, and the deletion
 *     is refused by name rather than cascading someone's day away
 *
 * The fixture builds two projects: one time-boxed (completion and
 * cancellation) and one standing (retirement — chk_sh_retired_shape only
 * permits retired_at on a standing project).
 *
 * TEARDOWN ORDER MATTERS. daily_work_items -> project_play_instances is
 * ON DELETE NO ACTION, and project_play_instances cascades from
 * sales_handovers, so the items must go before the projects or the teardown
 * refuses itself. That is the constraint working, not a harness bug.
 *
 * NOTE: none of sales_handovers, project_play_instances or the daily work
 * tables carry RLS today, so a plain pool sees every row. If that changes,
 * this harness must set app.current_org_id per statement or every query
 * silently returns nothing.
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
  console.error('  $env:DATABASE_URL="postgresql://..."; node verify_task_linked_136.js\n');
  process.exit(2);
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(CONN);
const pool = new Pool({
  connectionString: CONN,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10000,
});

const FIXTURE_ORG  = 'DW136_VERIFY_FIXTURE';
const FIXTURE_SLUG = 'dw136-verify-fixture';

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
 * Assert that `fn` fails with a named constraint.
 *
 * Postgres reports the violated constraint in err.constraint; comparing
 * against it is what distinguishes "the constraint did its job" from "my
 * fixture had a typo and the insert died for some other reason". A bare
 * try/catch would call both a pass.
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
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'daily_work_items'
        AND column_name = 'play_instance_id'`);

  check('daily_work_items.play_instance_id exists', cols.length === 1);
  check('play_instance_id is an integer',
    cols[0]?.data_type === 'integer', `got ${cols[0]?.data_type}`);
  check('play_instance_id is nullable — ordinary items carry none',
    cols[0]?.is_nullable === 'YES');

  const { rows: cons } = await q(
    `SELECT conname, confdeltype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'public.daily_work_items'::regclass
        AND conname = ANY($1)`,
    [['daily_work_items_play_instance_fkey', 'chk_dwi_linked_is_assigned',
      'chk_dwi_anchor_kind']]);
  const c = n => cons.find(r => r.conname === n);

  check('the foreign key exists', !!c('daily_work_items_play_instance_fkey'));

  // confdeltype 'a' = NO ACTION. 'r' (RESTRICT) would fire before a sibling
  // cascade could clear the referencing rows, so deleting an organization —
  // which cascades to BOTH daily_work_items and project_play_instances —
  // could abort on this constraint. 'c' (CASCADE) would delete somebody's
  // logged days along with the task. 'n' (SET NULL) would silently convert a
  // task item into an ordinary one.
  check('the foreign key is ON DELETE NO ACTION',
    c('daily_work_items_play_instance_fkey')?.confdeltype === 'a',
    `confdeltype = ${c('daily_work_items_play_instance_fkey')?.confdeltype}`);

  check('chk_dwi_linked_is_assigned exists', !!c('chk_dwi_linked_is_assigned'));

  // The anchor vocabulary is the thing the design promised not to touch.
  check('chk_dwi_anchor_kind is unchanged',
    /handover/.test(c('chk_dwi_anchor_kind')?.def || '') &&
    /account/.test(c('chk_dwi_anchor_kind')?.def || '') &&
    /campaign/.test(c('chk_dwi_anchor_kind')?.def || '') &&
    !/play/.test(c('chk_dwi_anchor_kind')?.def || ''),
    c('chk_dwi_anchor_kind')?.def || 'constraint missing');

  const { rows: idx } = await q(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [['uq_dwi_owner_play', 'idx_dwi_play_instance']]);
  const i = n => idx.find(r => r.indexname === n)?.indexdef || '';

  check('uq_dwi_owner_play exists', !!i('uq_dwi_owner_play'));
  check('uq_dwi_owner_play is UNIQUE', /CREATE UNIQUE INDEX/i.test(i('uq_dwi_owner_play')));
  // Partial, so the thousands of ordinary items stay out of it entirely.
  check('uq_dwi_owner_play is partial', /WHERE/i.test(i('uq_dwi_owner_play')),
    'index exists but has no WHERE clause');
  check('idx_dwi_play_instance exists', !!i('idx_dwi_play_instance'));
  check('idx_dwi_play_instance is partial', /WHERE/i.test(i('idx_dwi_play_instance')));

  const { rows: trg } = await q(
    `SELECT tgname, tgrelid::regclass::text AS on_table,
            pg_get_triggerdef(oid) AS def
       FROM pg_trigger WHERE tgname = ANY($1)`,
    [['trg_close_daily_work_items_for_play', 'trg_close_daily_work_items_for_project']]);
  const t = n => trg.find(r => r.tgname === n);

  check('the task trigger is attached to project_play_instances',
    t('trg_close_daily_work_items_for_play')?.on_table === 'project_play_instances',
    `on ${t('trg_close_daily_work_items_for_play')?.on_table || '(nothing)'}`);
  check('the project trigger is attached to sales_handovers',
    t('trg_close_daily_work_items_for_project')?.on_table === 'sales_handovers',
    `on ${t('trg_close_daily_work_items_for_project')?.on_table || '(nothing)'}`);

  // UPDATE OF <column> rather than a bare UPDATE. Without the column list both
  // triggers would fire on every write to two of the busiest tables in the
  // schema, for a condition that is false almost every time.
  check('the task trigger is scoped to UPDATE OF status',
    /UPDATE OF status/i.test(t('trg_close_daily_work_items_for_play')?.def || ''),
    t('trg_close_daily_work_items_for_play')?.def || 'trigger missing');
  check('the project trigger watches status AND retired_at',
    /UPDATE OF status, retired_at/i.test(t('trg_close_daily_work_items_for_project')?.def || ''),
    t('trg_close_daily_work_items_for_project')?.def || 'trigger missing');

  const { rows: [live] } = await q(
    `SELECT count(*)::int AS n FROM daily_work_items
      WHERE play_instance_id IS NOT NULL AND kind <> 'assigned'`);
  check('no existing item is linked with the wrong kind', live.n === 0,
    `${live.n} rows would violate chk_dwi_linked_is_assigned`);
}

/* ───────────────────────── fixture ─────────────────────────── */

async function setup() {
  await teardown();  // in case a previous run died before its finally block

  const { rows: [org] } = await q(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [FIXTURE_ORG, FIXTURE_SLUG]);

  const mkUser = async (first) => {
    const { rows: [u] } = await q(
      `INSERT INTO users (email, password_hash, first_name, last_name, org_id)
       VALUES ($1, 'x', $2, 'Fixture', $3) RETURNING id`,
      [`dw136.${first.toLowerCase()}.${Date.now()}@fixture.invalid`, first, org.id]);
    await q(`INSERT INTO org_users (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [org.id, u.id]);
    return u.id;
  };

  // Two people, because "one item per person per task" is only half a rule
  // until a second person on the SAME task is shown to be accepted.
  const userA = await mkUser('Ana');
  const userB = await mkUser('Ben');

  // project_kind 'internal' keeps sales_handovers_kind_shape_chk satisfied
  // with no account and no deal, and sales_handovers_name_required_chk needs
  // the name because deal_id is null.
  const mkProject = async (name, trackingMode) => {
    const { rows: [h] } = await q(
      `INSERT INTO sales_handovers
         (org_id, name, project_kind, tracking_mode, status, created_by)
       VALUES ($1, $2, 'internal', $3, 'in_progress', $4) RETURNING id`,
      [org.id, name, trackingMode, userA]);
    return h.id;
  };

  const projectTimeboxed = await mkProject('DW136 Timeboxed', 'timeboxed');
  const projectStanding  = await mkProject('DW136 Standing',  'standing');

  return { orgId: org.id, userA, userB, projectTimeboxed, projectStanding };
}

async function teardown() {
  const orgSel = `(SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}')`;
  // Items before projects: the FK is NO ACTION, so a project delete that
  // cascades to its tasks is refused while any item still points at one.
  await q(`DELETE FROM daily_work_entries WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM daily_work_items   WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM sales_handovers    WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM org_users          WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM users              WHERE org_id = ${orgSel}`);
  await q(`DELETE FROM organizations      WHERE name = '${FIXTURE_ORG}'`);
}

/* ───────────────────────── helpers ─────────────────────────── */

let taskSeq = 0;

async function mkTask(orgId, handoverId, title = null) {
  taskSeq += 1;
  const { rows: [p] } = await q(
    `INSERT INTO project_play_instances
       (handover_id, org_id, stage_key, title, status, sort_order)
     VALUES ($1, $2, 'custom', $3, 'not_started', $4) RETURNING id`,
    [handoverId, orgId, title || `DW136 task ${taskSeq}`, taskSeq * 10]);
  return p.id;
}

async function mkLinkedItem(orgId, userId, handoverId, playInstanceId) {
  const { rows: [i] } = await q(
    `INSERT INTO daily_work_items
       (org_id, owner_user_id, kind, title, status,
        anchor_kind, anchor_id, play_instance_id)
     VALUES ($1, $2, 'assigned', 'DW136 linked item', 'in_progress',
             'handover', $3, $4) RETURNING id`,
    [orgId, userId, handoverId, playInstanceId]);
  return i.id;
}

async function itemState(itemId) {
  const { rows: [r] } = await q(
    `SELECT status, closed_at FROM daily_work_items WHERE id = $1`, [itemId]);
  return r;
}

/* ───────────────────────── behaviour ───────────────────────── */

async function uniquenessChecks({ orgId, userA, userB, projectTimeboxed }) {
  console.log('\nBEHAVIOUR — one item per person per task');

  const task = await mkTask(orgId, projectTimeboxed);
  await mkLinkedItem(orgId, userA, projectTimeboxed, task);

  await expectViolation(
    'a second item for the same person and task is refused',
    'uq_dwi_owner_play',
    () => mkLinkedItem(orgId, userA, projectTimeboxed, task));

  // The other half of the rule. Two people working the same task each keep
  // their own log, which is what makes days-logged-across-every-person mean
  // anything on plan vs actual.
  await expectSuccess(
    'a second PERSON on the same task is accepted',
    () => mkLinkedItem(orgId, userB, projectTimeboxed, task));

  // Ordinary items are outside the index entirely, so any number of them may
  // coexist for one person.
  await expectSuccess(
    'unlinked items are unaffected by the unique index',
    async () => {
      for (let n = 0; n < 2; n++) {
        await q(
          `INSERT INTO daily_work_items (org_id, owner_user_id, kind, title, status)
           VALUES ($1, $2, 'recurring', 'DW136 ordinary', 'active')`,
          [orgId, userA]);
      }
    });

  await expectViolation(
    'a linked RECURRING item is refused',
    'chk_dwi_linked_is_assigned',
    () => q(
      `INSERT INTO daily_work_items
         (org_id, owner_user_id, kind, title, status, play_instance_id)
       VALUES ($1, $2, 'recurring', 'DW136 wrong kind', 'active', $3)`,
      [orgId, userA, task]));
}

async function taskClosureChecks({ orgId, userA, userB, projectTimeboxed }) {
  console.log('\nBEHAVIOUR — closing a task closes its items');

  // ── completed ──────────────────────────────────────────────────────
  const done = await mkTask(orgId, projectTimeboxed);
  const doneA = await mkLinkedItem(orgId, userA, projectTimeboxed, done);
  const doneB = await mkLinkedItem(orgId, userB, projectTimeboxed, done);

  await q(`UPDATE project_play_instances SET status = 'completed', completed_at = now()
            WHERE id = $1`, [done]);

  const a = await itemState(doneA);
  const b = await itemState(doneB);
  check("a completed task closes its item as 'completed'",
    a.status === 'completed', `status is ${a.status}`);
  check('closed_at is set', a.closed_at != null);
  check("EVERY person's item on that task closes, not just the owner's",
    b.status === 'completed', `the second person's item is ${b.status}`);

  // ── cancelled ──────────────────────────────────────────────────────
  const killed = await mkTask(orgId, projectTimeboxed);
  const killedA = await mkLinkedItem(orgId, userA, projectTimeboxed, killed);
  await q(`UPDATE project_play_instances SET status = 'cancelled' WHERE id = $1`, [killed]);
  check("a cancelled task closes its item as 'dropped'",
    (await itemState(killedA)).status === 'dropped',
    `status is ${(await itemState(killedA)).status}`);

  // ── skipped ────────────────────────────────────────────────────────
  const skipped = await mkTask(orgId, projectTimeboxed);
  const skippedA = await mkLinkedItem(orgId, userA, projectTimeboxed, skipped);
  await q(`UPDATE project_play_instances SET status = 'skipped' WHERE id = $1`, [skipped]);
  check("a skipped task closes its item as 'dropped'",
    (await itemState(skippedA)).status === 'dropped',
    `status is ${(await itemState(skippedA)).status}`);

  // ── in-flight statuses must NOT close anything ─────────────────────
  const live = await mkTask(orgId, projectTimeboxed);
  const liveA = await mkLinkedItem(orgId, userA, projectTimeboxed, live);
  for (const s of ['in_progress', 'blocked', 'snoozed']) {
    await q(`UPDATE project_play_instances SET status = $2 WHERE id = $1`, [live, s]);
    const st = await itemState(liveA);
    check(`'${s}' leaves the item open`,
      st.status === 'in_progress' && st.closed_at == null,
      `item became ${st.status}`);
  }

  // ── a status write that does not MOVE the status is a no-op ────────
  //
  // The trigger fires whenever status appears in the SET list, which it does
  // on paths that are rewriting something else entirely. The IS NOT DISTINCT
  // guard is what stops those from stamping closed_at.
  const still = await mkTask(orgId, projectTimeboxed);
  const stillA = await mkLinkedItem(orgId, userA, projectTimeboxed, still);
  await q(`UPDATE project_play_instances SET status = 'completed' WHERE id = $1`, [still]);
  const firstClose = (await itemState(stillA)).closed_at;
  await q(`UPDATE project_play_instances SET status = status, updated_at = now()
            WHERE id = $1`, [still]);
  check('re-writing the same status does not touch the item',
    String((await itemState(stillA)).closed_at) === String(firstClose),
    'closed_at moved on a no-op status write');

  // ── an item already closed is left alone ───────────────────────────
  await q(`UPDATE project_play_instances SET status = 'cancelled' WHERE id = $1`, [still]);
  const after = await itemState(stillA);
  check('an already-closed item keeps its original outcome',
    after.status === 'completed',
    `it was re-closed as ${after.status}`);
  check('an already-closed item keeps its original closed_at',
    String(after.closed_at) === String(firstClose),
    'closed_at drifted when the task was re-closed');
}

async function projectClosureChecks({ orgId, userA, projectTimeboxed, projectStanding }) {
  console.log('\nBEHAVIOUR — closing or retiring a project closes its tasks\' items');

  // A project reaching a terminal state does NOT cascade to its tasks —
  // updateStatus() writes sales_handovers only. Without this trigger the item
  // would stay open against a task that every read already hides.
  const orphanTask = await mkTask(orgId, projectTimeboxed);
  const orphanItem = await mkLinkedItem(orgId, userA, projectTimeboxed, orphanTask);

  await q(`UPDATE sales_handovers SET status = 'completed', completed_at = now()
            WHERE id = $1`, [projectTimeboxed]);

  const closed = await itemState(orphanItem);
  check("completing a project closes items on its tasks as 'completed'",
    closed.status === 'completed', `status is ${closed.status}`);
  check('the task itself is untouched — one direction only',
    (await q(`SELECT status FROM project_play_instances WHERE id = $1`, [orphanTask]))
      .rows[0].status === 'not_started',
    'the trigger wrote back to the task');

  // Retirement is a TIMESTAMP, not a seventh status (2026_133), so it needs
  // its own arm of the condition. chk_sh_retired_shape only permits it on a
  // standing project, and requires retired_by alongside.
  const standingTask = await mkTask(orgId, projectStanding);
  const standingItem = await mkLinkedItem(orgId, userA, projectStanding, standingTask);

  await q(`UPDATE sales_handovers SET retired_at = now(), retired_by = $2
            WHERE id = $1`, [projectStanding, userA]);

  check("retiring a project closes items on its tasks as 'dropped'",
    (await itemState(standingItem)).status === 'dropped',
    `status is ${(await itemState(standingItem)).status}`);

  // Cancelling, on a fresh project so the assertion is not reading the
  // completed one above.
  const { rows: [cancelled] } = await q(
    `INSERT INTO sales_handovers
       (org_id, name, project_kind, tracking_mode, status, created_by)
     VALUES ($1, 'DW136 Doomed', 'internal', 'timeboxed', 'in_progress', $2)
     RETURNING id`, [orgId, userA]);
  const cancelledTask = await mkTask(orgId, cancelled.id);
  const cancelledItem = await mkLinkedItem(orgId, userA, cancelled.id, cancelledTask);

  await q(`UPDATE sales_handovers SET status = 'cancelled' WHERE id = $1`, [cancelled.id]);
  check("cancelling a project closes items on its tasks as 'dropped'",
    (await itemState(cancelledItem)).status === 'dropped',
    `status is ${(await itemState(cancelledItem)).status}`);
}

async function ordinaryItemChecks({ orgId, userA }) {
  console.log('\nBEHAVIOUR — ordinary items are never touched');

  // Everything above fired triggers repeatedly. None of it may reach an item
  // with no link — the module has to keep working unchanged for the people
  // who log recurring work and never open a project.
  const { rows } = await q(
    `SELECT status, closed_at FROM daily_work_items
      WHERE org_id = $1 AND owner_user_id = $2 AND play_instance_id IS NULL`,
    [orgId, userA]);

  check('every unlinked item is still active',
    rows.length > 0 && rows.every(r => r.status === 'active'),
    `${rows.length} rows, statuses: ${rows.map(r => r.status).join(', ') || '(none)'}`);
  check('no unlinked item was given a closed_at',
    rows.every(r => r.closed_at == null));
}

async function deletionChecks({ orgId, userA, projectTimeboxed }) {
  console.log('\nBEHAVIOUR — a task with logged work cannot be deleted');

  const task = await mkTask(orgId, projectTimeboxed);
  const item = await mkLinkedItem(orgId, userA, projectTimeboxed, task);

  // removePlay() hard-deletes ad-hoc tasks, and every bulk-imported task is
  // ad-hoc. The FK is the backstop; the service refuses first, with a sentence.
  await expectViolation(
    'deleting a task with a linked item is refused',
    'daily_work_items_play_instance_fkey',
    () => q(`DELETE FROM project_play_instances WHERE id = $1`, [task]));

  await q(`DELETE FROM daily_work_items WHERE id = $1`, [item]);
  await expectSuccess(
    'the same task deletes once nothing is logged against it',
    () => q(`DELETE FROM project_play_instances WHERE id = $1`, [task]));
}

/* ───────────────────────── run ─────────────────────────────── */

(async () => {
  console.log(`\nverify_task_linked_136 — migration 2026_136`);
  console.log(`target:      ${CONN.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`fixture org: ${FIXTURE_ORG}\n`);

  let fixture;
  try {
    await structureChecks();
    fixture = await setup();
    await uniquenessChecks(fixture);
    await taskClosureChecks(fixture);
    await projectClosureChecks(fixture);
    await ordinaryItemChecks(fixture);
    await deletionChecks(fixture);
  } catch (err) {
    fail('harness aborted', err.stack || err.message);
  } finally {
    try { await teardown(); console.log('\nfixture torn down'); }
    catch (err) {
      console.log(`\nWARNING: teardown failed — ${err.message}`);
      console.log('The fixture org is STILL PRESENT. Remove it with:\n');
      console.log(`  BEGIN;`);
      // This order is the teardown order, and it is load-bearing: the items
      // must go before the projects whose tasks they point at.
      for (const t of ['daily_work_entries', 'daily_work_items', 'sales_handovers',
                       'org_users', 'users']) {
        console.log(`  DELETE FROM ${t} WHERE org_id = (SELECT id FROM organizations WHERE name = '${FIXTURE_ORG}');`);
      }
      console.log(`  DELETE FROM organizations WHERE name = '${FIXTURE_ORG}';`);
      console.log(`  COMMIT;\n`);
    }
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\nfailures:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('2026_136 verified.\n');
})();
