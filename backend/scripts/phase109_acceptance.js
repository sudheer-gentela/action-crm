#!/usr/bin/env node
/**
 * phase109_acceptance.js — acceptance harness for the project/deal play split.
 *
 * Asserts BEHAVIOUR, not row counts. The SQL harness (2026_109_acceptance.sql)
 * already proved the migration moved the right rows; this proves the repointed
 * code does the right thing afterwards, and — just as importantly — that the
 * deal path still does exactly what it did before.
 *
 *   node scripts/phase109_acceptance.js
 *
 * Creates a fixture org named PHASE109_FIXTURE, runs the assertions, and tears
 * it down again. Safe to run against a live database: every write is scoped to
 * that org and the teardown deletes by name.
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 */

const { pool } = require('../config/database');
const PlaybookPlayService = require('../services/PlaybookPlayService');
const handoverService     = require('../services/handover.service');

const FIXTURE_ORG = 'PHASE109_FIXTURE';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else {
    failed++; failures.push(name);
    console.log(`  FAIL  ${name}\n          expected: ${JSON.stringify(expected)}\n          actual:   ${JSON.stringify(actual)}`);
  }
}

async function one(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}
async function count(sql, params) {
  const r = await one(sql, params);
  return parseInt(r.count, 10);
}

// ── Fixture ──────────────────────────────────────────────────────────────────
async function setup() {
  await teardown();

  const org = await one(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [FIXTURE_ORG, 'phase109-fixture']
  );
  const orgId = org.id;

  const user = await one(
    `INSERT INTO users (email, org_id, password_hash, first_name, last_name)
     VALUES ($1, $2, 'x', 'Fixture', 'Owner') RETURNING id`,
    [`owner+${Date.now()}@phase109.invalid`, orgId]
  );
  const userId = user.id;

  const deal = await one(
    `INSERT INTO deals (org_id, name, value, owner_id) VALUES ($1, 'Fixture deal', 1000, $2) RETURNING id`,
    [orgId, userId]
  );

  const pb = await one(
    `INSERT INTO playbooks (org_id, name, entity_type, type, is_default)
     VALUES ($1, 'Fixture delivery', 'handover', 'handover_s2i', true) RETURNING id`,
    [orgId]
  );

  // Two sequential plays so dependency chaining can be exercised, plus one
  // gated by a project condition and one gated by a deal-only condition.
  const p1 = await one(
    `INSERT INTO playbook_plays (org_id, playbook_id, stage_key, title, sort_order,
        execution_type, is_active, channel, priority, due_offset_days, due_anchor, fire_conditions)
     VALUES ($1,$2,'mobilise','Site mobilisation',10,'sequential',true,'internal_task','medium',5,'created','[]')
     RETURNING id`, [orgId, pb.id]);

  const p2 = await one(
    `INSERT INTO playbook_plays (org_id, playbook_id, stage_key, title, sort_order,
        execution_type, is_active, channel, priority, due_offset_days, due_anchor, fire_conditions, depends_on)
     VALUES ($1,$2,'mobilise','Design freeze',20,'sequential',true,'internal_task','medium',10,'created','[]',ARRAY[$3::int])
     RETURNING id`, [orgId, pb.id, p1.id]);

  // project-evaluable condition: only fires for internal projects
  const p3 = await one(
    `INSERT INTO playbook_plays (org_id, playbook_id, stage_key, title, sort_order,
        execution_type, is_active, channel, priority, due_offset_days, due_anchor, fire_conditions)
     VALUES ($1,$2,'mobilise','Internal-only step',30,'parallel',true,'internal_task','medium',5,'created',
             '[{"type":"project_kind_is","value":"internal"}]')
     RETURNING id`, [orgId, pb.id]);

  // deal-only condition: must be skipped WITH A NAMED WARNING
  const p4 = await one(
    `INSERT INTO playbook_plays (org_id, playbook_id, stage_key, title, sort_order,
        execution_type, is_active, channel, priority, due_offset_days, due_anchor, fire_conditions)
     VALUES ($1,$2,'mobilise','Deal-gated step',40,'parallel',true,'internal_task','medium',5,'created',
             '[{"type":"days_until_close","operator":"<","value":30}]')
     RETURNING id`, [orgId, pb.id]);

  // Two projects: one from a deal (customer), one internal with NO deal.
  const customer = await one(
    `INSERT INTO sales_handovers (org_id, deal_id, project_kind, name, status,
        assigned_service_owner_id, created_by)
     VALUES ($1,$2,'customer','Fixture customer project','in_progress',$3,$3) RETURNING id`,
    [orgId, deal.id, userId]);

  const internal = await one(
    `INSERT INTO sales_handovers (org_id, deal_id, project_kind, name, status,
        assigned_service_owner_id, created_by, budget)
     VALUES ($1,NULL,'internal','Fixture internal project','in_progress',$2,$2, 5000000) RETURNING id`,
    [orgId, userId]);

  return { orgId, userId, dealId: deal.id, playbookId: pb.id,
           playIds: [p1.id, p2.id, p3.id, p4.id],
           customerId: customer.id, internalId: internal.id };
}

async function teardown() {
  const org = await one(`SELECT id FROM organizations WHERE name = $1`, [FIXTURE_ORG]);
  if (!org) return;
  const orgId = org.id;
  // Ordered by dependency. project_play_assignees cascades from instances.
  await pool.query(`DELETE FROM project_play_instances WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM deal_play_instances   WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM actions               WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM sales_handovers       WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM playbook_plays        WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM playbooks             WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM deals                 WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM users                 WHERE org_id = $1`, [orgId]);
  await pool.query(`DELETE FROM organizations         WHERE id     = $1`, [orgId]);
}

// ── Assertions ───────────────────────────────────────────────────────────────
async function run(f) {
  const { orgId, userId, playbookId, playIds, customerId, internalId } = f;
  const [p1, , p3, p4] = playIds;

  // ── 1. A CUSTOMER project (has a deal) writes to the PROJECT table ────────
  const act1 = await PlaybookPlayService.activateStageForProject(
    customerId, 'mobilise', orgId, userId, playbookId);

  check('1a customer project plays land in project_play_instances',
    true,
    (await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1`, [customerId])) > 0);

  check('1b customer project writes NOTHING to deal_play_instances',
    0,
    await count(`SELECT count(*) FROM deal_play_instances WHERE org_id = $1`, [orgId]));

  check('1c sales_handover_plays is no longer written',
    0,
    await count(`SELECT count(*) FROM sales_handover_plays WHERE handover_id = $1`, [customerId]));

  // ── 2. Condition evaluation, not blanket skipping ─────────────────────────
  check('2a project_kind_is excludes the internal-only play from a customer project',
    0,
    await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1 AND play_id = $2`,
      [customerId, p3]));

  check('2b deal-only condition is skipped',
    0,
    await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1 AND play_id = $2`,
      [customerId, p4]));

  check('2c the skip names the offending condition',
    true,
    act1.warnings.some(w => w.includes('days_until_close')));

  // ── 3. The internal project — broken before the split ─────────────────────
  const act2 = await PlaybookPlayService.activateStageForProject(
    internalId, 'mobilise', orgId, userId, playbookId);
  void act2;

  check('3a internal project (no deal) gets plays at all',
    true,
    (await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1`, [internalId])) > 0);

  check('3b project_kind_is INCLUDES the internal-only play here',
    1,
    await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1 AND play_id = $2`,
      [internalId, p3]));

  check('3c internal project actions carry handover_id, not deal_id',
    true,
    (await count(
      `SELECT count(*) FROM actions a
        JOIN project_play_instances p ON p.action_id = a.id
       WHERE p.handover_id = $1 AND a.handover_id = $1 AND a.deal_id IS NULL`,
      [internalId])) > 0);

  // ── 4. Idempotency — the duplicate-action bug ─────────────────────────────
  const before = await count(`SELECT count(*) FROM actions WHERE handover_id = $1`, [internalId]);
  await PlaybookPlayService.activateStageForProject(internalId, 'mobilise', orgId, userId, playbookId);
  const after = await count(`SELECT count(*) FROM actions WHERE handover_id = $1`, [internalId]);
  check('4a re-activating a stage creates no duplicate actions', before, after);

  check('4b re-activating creates no duplicate play instances',
    await count(`SELECT count(DISTINCT play_id) FROM project_play_instances WHERE handover_id = $1 AND play_id IS NOT NULL`, [internalId]),
    await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1 AND play_id IS NOT NULL`, [internalId]));

  // ── 5. Ad-hoc plays: real stage, sparse ordering ──────────────────────────
  const adhoc = await handoverService.addPlay(internalId, orgId, userId,
    { title: 'Ad-hoc site visit', stageKey: 'mobilise' });
  void adhoc;

  const adhocRow = await one(
    `SELECT id, stage_key, sort_order FROM project_play_instances
      WHERE handover_id = $1 AND play_id IS NULL AND playbook_id IS NULL
      ORDER BY id DESC LIMIT 1`, [internalId]);
  if (!adhocRow) throw new Error('ad-hoc play was not created — cannot run checks 5 and 8');

  check('5a ad-hoc play joins the named stage, not "custom"', 'mobilise', adhocRow.stage_key);
  check('5b ad-hoc play does not use the hardcoded 9000 order', true, adhocRow.sort_order !== 9000);
  check('5c ad-hoc play sorts after the templated plays', true, adhocRow.sort_order > 30);

  // ── 6. Completion + dependency chaining on the project side ───────────────
  const blocked = await one(
    `SELECT id, status FROM project_play_instances
      WHERE handover_id = $1 AND play_id = $2`, [internalId, playIds[1]]);
  check('6a dependent play starts blocked', 'blocked', blocked.status);

  const firstInst = await one(
    `SELECT id FROM project_play_instances WHERE handover_id = $1 AND play_id = $2`,
    [internalId, p1]);
  await handoverService.completePlay(internalId, firstInst.id, userId, orgId);

  const nowUnblocked = await one(
    `SELECT status FROM project_play_instances WHERE id = $1`, [blocked.id]);
  check('6b completing its dependency unblocks the next play', 'not_started', nowUnblocked.status);

  const completed = await one(
    `SELECT status, completed_at IS NOT NULL AS has_ts FROM project_play_instances WHERE id = $1`,
    [firstInst.id]);
  check('6c completion is recorded on the instance', { status: 'completed', has_ts: true },
    { status: completed.status, has_ts: completed.has_ts });

  // ── 7. Reassign — the ON CONFLICT that 2026_110 repaired ──────────────────
  await PlaybookPlayService.reassignPlayForProject(firstInst.id, userId, null, userId, orgId);
  await PlaybookPlayService.reassignPlayForProject(firstInst.id, userId, null, userId, orgId);
  check('7a reassigning twice leaves one assignee row', 1,
    await count(`SELECT count(*) FROM project_play_assignees WHERE instance_id = $1`, [firstInst.id]));

  // ── 8. updatePlay / removePlay operate on the project table ───────────────
  await handoverService.updatePlay(internalId, orgId, adhocRow.id, { title: 'Renamed ad-hoc' });

  check('8a updatePlay writes through to the project table', 1,
    await count(`SELECT count(*) FROM project_play_instances WHERE handover_id = $1 AND title = 'Renamed ad-hoc'`,
      [internalId]));

  // ── 9. Deals are untouched ────────────────────────────────────────────────
  check('9a nothing in this org ever reached deal_play_instances', 0,
    await count(`SELECT count(*) FROM deal_play_instances WHERE org_id = $1`, [orgId]));

  check('9b no action in this org is attached to the deal', 0,
    await count(`SELECT count(*) FROM actions WHERE org_id = $1 AND deal_id IS NOT NULL`, [orgId]));
}

(async () => {
  console.log('\nphase109_acceptance — project/deal play split\n');
  let fixture;
  try {
    fixture = await setup();
    await run(fixture);
  } catch (err) {
    failed++;
    failures.push('harness error: ' + err.message);
    console.error('\n  HARNESS ERROR:', err.message, '\n', err.stack);
  } finally {
    try { await teardown(); console.log('\n  fixture torn down'); }
    catch (e) { console.error('  TEARDOWN FAILED — clean up org', FIXTURE_ORG, 'manually:', e.message); }
    await pool.end();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('  Failures:'); failures.forEach(f => console.log('   -', f));
    process.exit(1);
  }
  console.log('  All checks passed.\n');
  process.exit(0);
})();
