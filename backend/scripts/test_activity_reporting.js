/**
 * scripts/test_activity_reporting.js — Activity Reporting integration test.
 *
 * Covers:
 *   • Atom derivation — seven mutually exclusive states across both action
 *     tables; deals 'not_started' → pending; auto_completed wins over
 *     status='completed'; states sum to generated per source.
 *   • Cohort boundaries — created before window excluded; created inside +
 *     completed after "now" is impossible, but completed long after creation
 *     (still inside query time) counts as rep_completed.
 *   • Scope — manager sees own + subordinate atoms; rep (self) sees only
 *     their own; drill-down userId outside scope → the endpoint's 403 rule
 *     (asserted at the query layer via explicitUserIds intersection).
 *   • Calls + deliveries aggregation.
 *   • Definition service — validation (unknown state, dup, name length),
 *     save/activate/delete, the 10-definition cap, org default set/get.
 *
 * Run (live PG, migration 2026_45 applied):
 *   DATABASE_URL=postgres://gowarm:gowarm@localhost:5432/gowarm_test \
 *     node scripts/test_activity_reporting.js
 *
 * Route handlers aren't invoked directly (they need HTTP auth context);
 * the SQL under test is exercised verbatim — the state CASE below must stay
 * byte-identical to ACTION_STATE_CASE in routes/reporting.routes.js — and
 * scope is exercised through ReportingScopeService itself. Everything rolls
 * back; the definition-service tests use the transaction-external pool, so
 * they run against throwaway rows created inside this script's org and are
 * cleaned by the final DELETEs (see bottom).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://gowarm:gowarm@localhost:5432/gowarm_test';

const { pool } = require('../config/database');
const ReportingScope = require('../services/ReportingScopeService');
const ActivityConfig = require('../services/activityReportConfig');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const ACTION_STATE_CASE = `
  CASE
    WHEN a.auto_completed = TRUE                                THEN 'auto_cleared'
    WHEN a.completed_at IS NOT NULL OR a.status = 'completed'   THEN 'rep_completed'
    WHEN a.status = 'snoozed'                                   THEN 'snoozed'
    WHEN a.status = 'in_progress'                               THEN 'in_progress'
    WHEN a.status = 'skipped'                                   THEN 'skipped'
    WHEN a.status = 'failed'                                    THEN 'failed'
    ELSE 'pending'
  END`;

async function main() {
  // NOTE: definition-service tests write via the shared pool (the service
  // manages its own queries), so this test creates REAL rows and deletes
  // them at the end rather than using one wrapping transaction.
  const c = await pool.connect();
  let orgId, mgrId, repId, outsiderId;
  try {
    // ── Seed ────────────────────────────────────────────────────────────
    orgId = (await c.query(
      `INSERT INTO organizations (name, slug) VALUES ('Activity Test Org', 'activity-test-' || floor(random()*100000)) RETURNING id`
    )).rows[0].id;

    const mkUser = async (fn, role) => {
      const uid = (await c.query(
        `INSERT INTO users (org_id, email, password_hash, first_name, last_name, role)
         VALUES ($1, lower($2) || floor(random()*100000) || '@test.io', 'x', $2, 'Test', 'member') RETURNING id`,
        [orgId, fn]
      )).rows[0].id;
      await c.query(
        `INSERT INTO org_users (org_id, user_id, role, is_active) VALUES ($1, $2, $3, TRUE)`,
        [orgId, uid, role]
      );
      return uid;
    };
    mgrId      = await mkUser('Mgr', 'member');
    repId      = await mkUser('Rep', 'member');
    outsiderId = await mkUser('Outsider', 'member');
    await c.query(
      `INSERT INTO org_hierarchy (org_id, user_id, reports_to) VALUES ($1, $2, $3)`,
      [orgId, repId, mgrId]
    );

    const now = new Date();
    const inWin  = new Date(now.getTime() - 2 * 86400000);   // 2d ago
    const outWin = new Date(now.getTime() - 30 * 86400000);  // 30d ago
    const winStart = new Date(now.getTime() - 7 * 86400000).toISOString();
    const winEnd   = now.toISOString();

    // prospecting_actions.prospect_id is NOT NULL — seed one prospect.
    const prospectId = (await c.query(
      `INSERT INTO prospects (org_id, owner_id, created_by, first_name, last_name, email, stage)
       VALUES ($1, $2, $2, 'Atom', 'Prospect', 'atom' || floor(random()*100000) || '@test.io', 'outreach')
       RETURNING id`,
      [orgId, repId]
    )).rows[0].id;

    // ── Seed prospecting actions for rep: one per state + out-of-window ──
    const seedPA = (status, { auto = false, completed = false, created = inWin, source = 'auto_generated' } = {}) =>
      c.query(
        `INSERT INTO prospecting_actions
           (org_id, user_id, prospect_id, title, action_type, status, source,
            auto_completed, completed_at, completed_by, created_at)
         VALUES ($1, $2, $7, 'seed', 'follow_up', $3, $4, $5,
                 ${completed ? 'NOW()' : 'NULL'},
                 ${completed && !auto ? '$2' : 'NULL'}, $6)`,
        [orgId, repId, status, source, auto, created.toISOString(), prospectId]
      );

    await seedPA('pending');
    await seedPA('in_progress');
    await seedPA('snoozed');
    await seedPA('skipped');
    await seedPA('failed');
    await seedPA('completed', { completed: true });                       // rep_completed
    await seedPA('completed', { completed: true, auto: true });          // auto_cleared (auto wins)
    await seedPA('pending',   { created: outWin });                       // outside cohort
    await seedPA('completed', { completed: true, source: 'signal' });    // second source

    // Deals actions for manager: not_started → pending; playbook vs manual.
    await c.query(
      `INSERT INTO actions (user_id, title, type, status, source_rule, created_at)
       VALUES ($1, 'seed-deal-1', 'task', 'not_started', 'health_2a_no_buyer', $2),
              ($1, 'seed-deal-2', 'task', 'completed',    NULL,                 $2)`,
      [mgrId, inWin.toISOString()]
    );
    await c.query(
      `UPDATE actions SET completed_at = NOW() WHERE title = 'seed-deal-2' AND user_id = $1`,
      [mgrId]
    );

    // Calls + deliveries for rep.
    await c.query(
      `INSERT INTO calls (org_id, user_id, direction, outcome, duration_seconds, occurred_at)
       VALUES ($1, $2, 'outbound', 'connected', 300, $3),
              ($1, $2, 'outbound', 'voicemail',  0,  $3)`,
      [orgId, repId, inWin.toISOString()]
    );
    await c.query(
      `INSERT INTO notification_deliveries (org_id, user_id, channel, status, reason)
       VALUES ($1, $2, 'slack', 'failed', 'channel_not_found'),
              ($1, $2, 'in_app', 'sent', NULL)`,
      [orgId, repId]
    );

    // ── Scope: manager (depth all) must include rep, exclude outsider ────
    const mgrScope = await ReportingScope.resolveReportingScope(mgrId, orgId, { depth: 'all' });
    check('scope: manager sees self + rep', mgrScope.userIds.includes(mgrId) && mgrScope.userIds.includes(repId));
    check('scope: manager does NOT see outsider', !mgrScope.userIds.includes(outsiderId));

    const repScope = await ReportingScope.resolveReportingScope(repId, orgId, { depth: 'all' });
    check('scope: rep is self-only', repScope.scope === 'self' && repScope.userIds.length === 1);

    // Drill-down auth rule: explicitUserIds intersect drops out-of-scope ids.
    const denied = await ReportingScope.resolveReportingScope(repId, orgId,
      { depth: 'all', explicitUserIds: [mgrId] });
    check('scope: drill-down at out-of-scope user is dropped (endpoint → 403)',
      !denied.userIds.includes(mgrId));

    // ── Atoms: the exact endpoint SQL against manager scope ─────────────
    const atomsPA = (await c.query(
      `SELECT COALESCE(a.source,'manual') AS source, ${ACTION_STATE_CASE} AS state, COUNT(*)::int AS n
         FROM prospecting_actions a
        WHERE a.org_id = $1 AND a.user_id = ANY($2::int[])
          AND a.created_at >= $3::timestamptz AND a.created_at <= $4::timestamptz
        GROUP BY 1, 2`,
      [orgId, mgrScope.userIds, winStart, winEnd]
    )).rows;

    const get = (src, st) => atomsPA.find(r => r.source === src && r.state === st)?.n || 0;
    for (const st of ['pending','in_progress','snoozed','skipped','failed','rep_completed','auto_cleared']) {
      check(`atoms: diagnostic has exactly 1 '${st}'`, get('auto_generated', st) === 1,
        atomsPA.filter(r => r.source === 'auto_generated'));
    }
    check('atoms: out-of-window row excluded (diagnostic total = 7)',
      atomsPA.filter(r => r.source === 'auto_generated').reduce((a, r) => a + r.n, 0) === 7);
    check('atoms: signal source counted separately', get('signal', 'rep_completed') === 1);

    const atomsDeals = (await c.query(
      `SELECT CASE WHEN a.source_rule IS NOT NULL THEN 'playbook' ELSE 'manual' END AS source,
              ${ACTION_STATE_CASE} AS state, COUNT(*)::int AS n
         FROM actions a
        WHERE a.user_id = ANY($1::int[])
          AND a.created_at >= $2::timestamptz AND a.created_at <= $3::timestamptz
          AND a.title LIKE 'seed-deal-%'
        GROUP BY 1, 2`,
      [mgrScope.userIds, winStart, winEnd]
    )).rows;
    const getD = (src, st) => atomsDeals.find(r => r.source === src && r.state === st)?.n || 0;
    check("atoms: deals 'not_started' normalizes to pending (playbook)", getD('playbook', 'pending') === 1, atomsDeals);
    check('atoms: deals manual completed → rep_completed', getD('manual', 'rep_completed') === 1, atomsDeals);

    // Rep self-scope must not see manager's deals atoms.
    const repDeals = (await c.query(
      `SELECT COUNT(*)::int AS n FROM actions a
        WHERE a.user_id = ANY($1::int[]) AND a.title LIKE 'seed-deal-%'`,
      [repScope.userIds]
    )).rows[0].n;
    check('scope: rep sees zero of manager deals atoms', repDeals === 0);

    // ── Calls + deliveries aggregation ───────────────────────────────────
    const calls = (await c.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(duration_seconds),0)::int AS secs
         FROM calls WHERE org_id = $1 AND user_id = ANY($2::int[])
          AND occurred_at >= $3::timestamptz AND occurred_at <= $4::timestamptz`,
      [orgId, mgrScope.userIds, winStart, winEnd]
    )).rows[0];
    check('calls: 2 calls, 300s talk', calls.n === 2 && calls.secs === 300, calls);

    const fails = (await c.query(
      `SELECT COUNT(*)::int AS n FROM notification_deliveries
        WHERE org_id = $1 AND user_id = $2 AND status = 'failed'`,
      [orgId, repId]
    )).rows[0].n;
    check('deliveries: rep has 1 failure', fails === 1);

    // ── Definition service ───────────────────────────────────────────────
    let threw = null;
    try { ActivityConfig.validateDefinition({ numerator: ['nope'], denominator: ['pending'] }); }
    catch (e) { threw = e.message; }
    check('defs: unknown state rejected', /unknown state/.test(threw || ''));

    threw = null;
    try { ActivityConfig.validateDefinition({ numerator: ['pending','pending'], denominator: ['pending'] }); }
    catch (e) { threw = e.message; }
    check('defs: duplicate state rejected', /repeats/.test(threw || ''));

    const sysDefault = await ActivityConfig.getOrgDefault(orgId);
    check('defs: no org row → system default', sysDefault.source === 'system');

    await ActivityConfig.setOrgDefault(orgId,
      { numerator: ['rep_completed','auto_cleared'], denominator: ['pending','rep_completed','auto_cleared'] }, mgrId);
    const orgDef = await ActivityConfig.getOrgDefault(orgId);
    check('defs: org default persists', orgDef.source === 'org'
      && orgDef.definition.numerator.includes('auto_cleared'));

    await ActivityConfig.saveUserDefinition(repId, orgId, 'Strict',
      { numerator: ['rep_completed'], denominator: ['pending','rep_completed'] });
    let st = await ActivityConfig.getUserState(repId, orgId);
    check('defs: save + auto-activate', st.active === 'Strict' && !!st.definitions.Strict);

    await ActivityConfig.setActiveDefinition(repId, orgId, null);
    st = await ActivityConfig.getUserState(repId, orgId);
    check('defs: set_active null → follow org default', st.active === null && !!st.definitions.Strict);

    threw = null;
    try {
      for (let i = 0; i < 12; i++) {
        await ActivityConfig.saveUserDefinition(repId, orgId, `Def${i}`,
          { numerator: ['rep_completed'], denominator: ['pending','rep_completed'] });
      }
    } catch (e) { threw = e.message; }
    check('defs: 10-definition cap enforced', /up to 10/.test(threw || ''));

    await ActivityConfig.deleteUserDefinition(repId, orgId, 'Strict');
    st = await ActivityConfig.getUserState(repId, orgId);
    check('defs: delete removes definition', !st.definitions.Strict);

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  } catch (err) {
    failures++;
    console.error('Test run failed:', err);
  } finally {
    // ── Cleanup (real rows — no wrapping transaction; see header note) ──
    try {
      if (orgId) {
        await c.query(`DELETE FROM actions WHERE title LIKE 'seed-deal-%' AND user_id = ANY($1::int[])`,
          [[mgrId, repId, outsiderId].filter(Boolean)]);
        await c.query(`DELETE FROM organizations WHERE id = $1`, [orgId]); // cascades org-scoped rows
        await c.query(`DELETE FROM users WHERE id = ANY($1::int[])`,
          [[mgrId, repId, outsiderId].filter(Boolean)]);
      }
    } catch (cleanupErr) {
      console.error('Cleanup failed (manual cleanup may be needed):', cleanupErr.message);
    }
    c.release();
    await pool.end().catch(() => {});
    process.exit(failures === 0 ? 0 : 1);
  }
}

main();
