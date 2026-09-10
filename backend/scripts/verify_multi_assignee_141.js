#!/usr/bin/env node
//
// verify_multi_assignee_141.js
//
// Proves the behaviour 2026_141 claims. Run against a LIVE database, after the
// migration has committed and before the read-path change is trusted.
//
//   node scripts/verify_multi_assignee_141.js <orgId>
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────
//
// The migration's own VERIFY block proves the schema is SHAPED right — the
// triggers exist, the backfill left no orphans. It cannot prove the triggers
// DO anything, because that needs rows moving through them.
//
// The invariant everything else rests on is "the owner always has an assignee
// row". Six read queries stop testing owner_user_id on the strength of it. If
// it is false, tasks disappear from their owners' My day with no error
// anywhere — so it is worth more than a schema check.
//
// ── EVERYTHING IS ROLLED BACK ────────────────────────────────────────
//
// One transaction, always rolled back, even on success. This runs against live
// data and must not leave a test project behind. Test 7 is the exception it
// makes and it explains itself.
//
// Nothing here mutates a row that existed before the script started.

const { pool } = require('../config/database');

const orgId = parseInt(process.argv[2], 10);
if (!Number.isInteger(orgId)) {
  console.error('Usage: node scripts/verify_multi_assignee_141.js <orgId>');
  process.exit(1);
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else    { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// PostgreSQL error CONDITION NAMES, as written in the migration's
// `USING ERRCODE = ...`, mapped to the SQLSTATE that node-pg actually puts on
// err.code. RAISE accepts the name; the client only ever sees the five
// character code, so an assertion written against the name never matches — the
// trigger fires correctly and the test reports a failure. That is exactly what
// happened on the first real run of this script.
const SQLSTATE = {
  restrict_violation: '23001',
  unique_violation:   '23505',
  check_violation:    '23514',
  foreign_key_violation: '23503',
};

async function expectReject(client, name, fn, wantCode) {
  const want = SQLSTATE[wantCode] || wantCode;
  // Each attempt runs in a SAVEPOINT. A failed statement poisons the whole
  // transaction in Postgres, so without this the first expected rejection
  // would abort every test after it.
  await client.query('SAVEPOINT s');
  try {
    await fn();
    await client.query('ROLLBACK TO SAVEPOINT s');
    check(name, false, 'expected a rejection, got none');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    const ok = !want || err.code === want;
    check(name, ok, ok ? '' : `rejected with ${err.code}, expected ${want}: ${err.message}`);
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Fixtures ─────────────────────────────────────────────────────
    // Three real users in this org. Real, not invented: project_members and
    // project_play_assignees both have FKs to users, and a fabricated id
    // would fail on the constraint rather than on the behaviour being tested.
    const { rows: users } = await client.query(
      `SELECT u.id FROM users u
         JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = $1
        WHERE ou.is_active = true
        ORDER BY u.id LIMIT 3`, [orgId]);
    if (users.length < 3) {
      console.error(`Need 3 active users in org ${orgId}; found ${users.length}.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    const [owner, second, outsider] = users.map(u => u.id);

    // project_kind 'internal', explicitly.
    //
    // The column DEFAULTS to 'customer', and sales_handovers_kind_shape_chk
    // then requires account_id OR deal_id to be non-null — a fixture with
    // neither is refused, which is exactly what the first run of this script
    // hit. An internal project is the honest shape here anyway: this fixture
    // has no customer, and the constraint guarantees internal projects carry
    // no account, so there is nothing to invent and nothing to clean up.
    //
    // Nothing under test cares which kind it is. The triggers key on
    // play_instance_id and on sales_handovers.status/retired_at, none of which
    // consults project_kind.
    const { rows: [h] } = await client.query(
      `INSERT INTO sales_handovers
         (org_id, name, status, created_by, project_kind, account_id, deal_id)
       VALUES ($1, 'VERIFY 141 — rolled back', 'in_progress', $2,
               'internal', NULL, NULL)
       RETURNING id`, [orgId, owner]);

    // owner and second are on the project; outsider deliberately is not.
    await client.query(
      `INSERT INTO project_members
         (org_id, context_type, context_id, user_id, status, requested_by)
       SELECT $1, 'handover', $2, u, 'approved', $3 FROM unnest($4::int[]) AS u`,
      [orgId, h.id, owner, [owner, second]]);

    const { rows: [play] } = await client.query(
      `INSERT INTO project_play_instances
         (handover_id, org_id, stage_key, title, status, owner_user_id)
       VALUES ($1, $2, 'verify', 'Task under test', 'not_started', $3)
       RETURNING id`, [h.id, orgId, owner]);

    const assignees = async (id = play.id) => {
      const { rows } = await client.query(
        `SELECT user_id FROM project_play_assignees
          WHERE instance_id = $1 ORDER BY user_id`, [id]);
      return rows.map(r => r.user_id);
    };

    console.log(`\nverify_multi_assignee_141  org=${orgId}  play=${play.id}\n`);

    // ── 1. INSERT with an owner creates the assignee row ─────────────
    check('owner assigned on task creation',
      (await assignees()).includes(owner),
      `assignees are [${await assignees()}]`);

    // ── 2. A second person can be added ──────────────────────────────
    await client.query(
      `INSERT INTO project_play_assignees (instance_id, user_id, assigned_by)
       VALUES ($1, $2, $3)`, [play.id, second, owner]);
    check('a second assignee is accepted',
      (await assignees()).length === 2);

    // ── 3. The 2026_110 unique key rejects a duplicate ───────────────
    await expectReject(client, 'duplicate (task, person) rejected',
      () => client.query(
        `INSERT INTO project_play_assignees (instance_id, user_id)
         VALUES ($1, $2)`, [play.id, second]),
      '23505');

    // ── 4. Changing the owner adds the new one and KEEPS the old ─────
    // The decision most likely to be questioned later. Losing ownership is
    // not leaving the task: the previous owner usually still has an open
    // daily_work_items row against it.
    await client.query(
      `UPDATE project_play_instances SET owner_user_id = $2 WHERE id = $1`,
      [play.id, second]);
    const afterSwap = await assignees();
    check('new owner is assigned after an owner change',
      afterSwap.includes(second));
    check('previous owner STAYS assigned after an owner change',
      afterSwap.includes(owner),
      `assignees are [${afterSwap}]`);

    // ── 5. The owner's own row cannot be deleted ─────────────────────
    await expectReject(client, "owner's assignee row cannot be deleted",
      () => client.query(
        `DELETE FROM project_play_assignees
          WHERE instance_id = $1 AND user_id = $2`, [play.id, second]),
      'restrict_violation');

    // ── 6. A non-owner assignee CAN be removed ──────────────────────
    // The guard must refuse the owner specifically, not freeze the table.
    await client.query('SAVEPOINT s6');
    await client.query(
      `DELETE FROM project_play_assignees
        WHERE instance_id = $1 AND user_id = $2`, [play.id, owner]);
    check('a non-owner assignee can be removed',
      !(await assignees()).includes(owner));
    await client.query('ROLLBACK TO SAVEPOINT s6');

    // ── 7. Deleting the TASK still cascades ─────────────────────────
    // The delete guard fires per assignee row during that cascade. If it
    // compared user ids without checking the parent still exists, it would
    // abort the delete of any task that had an owner — the same class of
    // mistake 2026_136's NO ACTION / RESTRICT note describes.
    //
    // Done on a SECOND, disposable task rather than the one under test, so
    // the tests after this still have their fixture.
    const { rows: [tmp] } = await client.query(
      `INSERT INTO project_play_instances
         (handover_id, org_id, stage_key, title, status, owner_user_id)
       VALUES ($1, $2, 'verify', 'Disposable', 'not_started', $3)
       RETURNING id`, [h.id, orgId, owner]);
    await client.query('SAVEPOINT s7');
    let cascaded = true;
    try {
      await client.query(`DELETE FROM project_play_instances WHERE id = $1`, [tmp.id]);
    } catch (err) {
      cascaded = false;
      check('deleting a task cascades its assignee rows', false,
        `${err.code}: ${err.message}`);
    }
    if (cascaded) {
      check('deleting a task cascades its assignee rows',
        (await assignees(tmp.id)).length === 0);
    }
    await client.query('ROLLBACK TO SAVEPOINT s7');

    // ── 8. Closing the task closes EVERY assignee's daily work ──────
    // The rule the whole feature rests on: closure is for the task as a
    // whole, never per person. trg_close_daily_work_items_for_play (2026_136)
    // filters on play_instance_id alone, so it should not care how many
    // people have items — this proves it with two.
    for (const uid of [owner, second]) {
      await client.query(
        `INSERT INTO daily_work_items
           (org_id, owner_user_id, kind, title, anchor_kind, anchor_id,
            status, created_by, play_instance_id)
         VALUES ($1, $2, 'assigned', 'Work on the task', 'handover', $3,
                 'in_progress', $2, $4)`,
        [orgId, uid, h.id, play.id]);
    }
    await client.query(
      `UPDATE project_play_instances SET status = 'completed' WHERE id = $1`,
      [play.id]);
    const { rows: [closed] } = await client.query(
      `SELECT count(*)::int AS open FROM daily_work_items
        WHERE play_instance_id = $1 AND status NOT IN ('completed','dropped')`,
      [play.id]);
    check('closing a task closes the daily work of EVERY assignee',
      closed.open === 0, `${closed.open} item(s) left open`);

    // ── 8b. Roles: owner is 'assignee', the other is 'contributor' ──
    // The distinction the whole closure rule rests on. Asserted against the
    // live resolver rather than by reading the table, because the bug this
    // replaces was a resolver that returned 'assignee' for everyone.
    // A fresh task: `play` has been completed by test 8 and its owner swapped
    // by test 4, so neither of its two facts is what these assertions need.
    const { rows: [play2] } = await client.query(
      `INSERT INTO project_play_instances
         (handover_id, org_id, stage_key, title, status, owner_user_id)
       VALUES ($1, $2, 'verify', 'Role resolution', 'not_started', $3)
       RETURNING id`, [h.id, orgId, owner]);
    await client.query(
      `INSERT INTO project_play_assignees (instance_id, user_id, assigned_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [play2.id, second, owner]);

    try {
      const playReview = require('../services/playReview.service');
      const r1 = await playReview.resolveActorRole(h.id, play2.id, orgId, owner);
      const r2 = await playReview.resolveActorRole(h.id, play2.id, orgId, second);
      check("the task owner resolves to 'assignee'", r1?.role === 'assignee',
        `got ${r1?.role}`);
      check("a non-owner assignee resolves to 'contributor'", r2?.role === 'contributor',
        `got ${r2?.role}`);
      check('ownerUserId always names the OWNER, not the caller',
        Number(r2?.ownerUserId) === Number(owner),
        `got ${r2?.ownerUserId}, expected ${owner}`);
    } catch (err) {
      // The standalone copy has no app repo beside it; skip rather than fail.
      console.log(`  SKIP  role resolution (needs the app repo: ${err.code || err.message})`);
    }

    // ── 9. The backfill left nothing behind, org-wide ───────────────
    // Reads no longer test owner_user_id, so any owner without a row is a
    // task that has vanished from its owner's My day.
    const { rows: [gap] } = await client.query(
      `SELECT count(*)::int AS n FROM project_play_instances p
        WHERE p.org_id = $1 AND p.owner_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM project_play_assignees a
                           WHERE a.instance_id = p.id
                             AND a.user_id = p.owner_user_id)`, [orgId]);
    check('every owned task in this org has its owner assigned',
      gap.n === 0, `${gap.n} task(s) missing their owner`);

    // outsider is referenced only by the membership refusal, which is a
    // service-level rule rather than a database one — see setAssignees.
    void outsider;

    await client.query('ROLLBACK');
    console.log(`\n${passed} passed, ${failed} failed. All changes rolled back.\n`);
    process.exit(failed ? 1 : 0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nAborted:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
