/**
 * scripts/test_p7_workstage.js — P7 integration test (throwaway, not shipped).
 * Run: DATABASE_URL=postgres://gowarm:gowarm@localhost:5432/gowarm_test node scripts/test_p7_workstage.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://gowarm:gowarm@localhost:5432/gowarm_test';

const { pool } = require('../config/database');
const SignalService = require('../services/SignalService');
const SignalRegistry = require('../services/SignalRegistryService');
const Surfacer = require('../services/SignalActionSurfacer');
const WorkStage = require('../services/WorkStageService');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function main() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ── Seed org / user / account / campaign / prospect ──────────────────────
    const org = (await c.query(`INSERT INTO organizations (name, slug) VALUES ('P7 Test Org', 'p7-test-org') RETURNING id`)).rows[0];
    const orgId = org.id;
    const user = (await c.query(
      `INSERT INTO users (org_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, 'p7rep@test.io', 'x', 'Pat', 'Rep', 'member') RETURNING id`, [orgId]
    )).rows[0];
    const account = (await c.query(
      `INSERT INTO accounts (org_id, owner_id, name, domain) VALUES ($1, $2, 'Acme Corp', 'acme.io') RETURNING id`,
      [orgId, user.id]
    )).rows[0];

    // Catalog defs: a filter (uses_salesforce, boolean, TTL 90) and a
    // prioritizer trigger (recently_raised, recency, TTL 180, with a hook).
    await SignalRegistry.setInferred
      ? null : null; // (createDef used below; setInferred is admin path)
    const mkDef = async (key, patch) => c.query(
      `INSERT INTO signal_defs (org_id, key, label, capability, scope, function_tags, predicate_type, reliability, source_kind, ttl_days, default_hook)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgId, key, patch.label, patch.capability, patch.scope || 'company', JSON.stringify(patch.tags || []),
       patch.predicateType, patch.reliability || 'high', patch.sourceKind || 'list', patch.ttlDays ?? null, patch.hook || null]
    );
    await mkDef('uses_salesforce', { label: 'Uses Salesforce', capability: 'filter', predicateType: 'boolean', ttlDays: 90 });
    await mkDef('recently_raised', { label: 'Recently raised', capability: 'prioritize', predicateType: 'recency', ttlDays: 180, hook: 'fresh capital usually means new {leader} priorities' });
    await mkDef('hiring_sdrs',     { label: 'Hiring SDRs', capability: 'prioritize', predicateType: 'boolean', ttlDays: 60, hook: 'scaling the team' });

    const targeting = {
      function_key: 'sales',
      filters: [
        { signal_key: 'uses_salesforce', role: 'filter', label: 'Uses Salesforce', predicate: { operator: 'is_true' } },
      ],
      prioritizers: [
        { signal_key: 'recently_raised', role: 'prioritize', label: 'Recently raised', predicate: { operator: 'within_days', value: 120 } },
        { signal_key: 'hiring_sdrs', role: 'prioritize', label: 'Hiring SDRs', predicate: { operator: 'is_true' } },
      ],
    };
    const campaign = (await c.query(
      `INSERT INTO prospecting_campaigns (org_id, name, status, solution, activity_type, prospecting_config_override, created_by, owner_id)
       VALUES ($1, 'P7 Campaign', 'active', 'pipeline discipline', 'outreach', $2, $3, $3) RETURNING *`,
      [orgId, JSON.stringify({ targeting }), user.id]
    )).rows[0];

    const prospect = (await c.query(
      `INSERT INTO prospects (org_id, owner_id, created_by, first_name, last_name, title, company_name, account_id, campaign_id, stage)
       VALUES ($1, $2, $2, 'Vera', 'VP', 'VP Sales', 'Acme Corp', $3, $4, 'target') RETURNING *`,
      [orgId, user.id, account.id, campaign.id]
    )).rows[0];

    // ── 1. No signals yet → qualifies on unknowns, filter is a confirmation ──
    let r = await Surfacer.surfaceForProspect({ orgId, campaign, prospect, client: c });
    check('unknown filter → still qualifies', r.verdict.qualifies === true);
    check('unknown filter → confirmation, not drop', r.verdict.confirmations.length === 1 && r.verdict.confirmations[0].signalKey === 'uses_salesforce');
    check('no trigger → low priority', r.verdict.priority === 'low');
    check('action upserted', r.upserted === 1);

    let ctx = await WorkStage.buildWorkContext({ orgId, prospectId: prospect.id, client: c });
    check('work context: hasTargeting', ctx.hasTargeting === true);
    check('work context: confirmation carries predicate + entityType', ctx.confirmations[0].predicate.operator === 'is_true' && ctx.confirmations[0].entityType === 'account');
    check('work context: action row present', !!ctx.action && ctx.action.status === 'pending');

    // ── 2. On-page validation: confirm Salesforce (account-scope def routes to account) ──
    ctx = await WorkStage.validateSignal({ orgId, userId: user.id, prospectId: prospect.id, key: 'uses_salesforce', value: true, client: c });
    check('validate: confirmation cleared', ctx.confirmations.length === 0);
    check('validate: signal now rep/high on ACCOUNT', ctx.signals.some(s => s.key === 'uses_salesforce' && s.repWritten && s.entityType === 'account' && s.value === true));
    check('validate: still qualifies, still low (no trigger)', ctx.verdict.qualifies === true && ctx.verdict.priority === 'low');

    // ── 3. Trigger fires via a vendor signal → priority + hook flip ──────────
    await SignalService.writeSignal({ orgId, entityType: 'account', entityId: account.id, key: 'recently_raised', value: new Date().toISOString(), source: 'list', client: c });
    await Surfacer.reevalOnCapture({ orgId, entityType: 'account', entityId: account.id, client: c });
    ctx = await WorkStage.buildWorkContext({ orgId, prospectId: prospect.id, client: c });
    check('trigger active → high priority', ctx.verdict.priority === 'high', ctx.verdict);
    check('why-now resolves {leader} through sales fn', /CRO|VP of Sales|sales/i.test(ctx.verdict.whyNow || ''), ctx.verdict.whyNow);
    const act = (await c.query(`SELECT * FROM prospecting_actions WHERE prospect_id=$1 AND source_rule=$2`, [prospect.id, `signal:${campaign.id}`])).rows[0];
    check('queue row updated to high', act.priority === 'high');

    // ── 4. Rep validation can DISQUALIFY honestly (fresh value-fail) ─────────
    ctx = await WorkStage.validateSignal({ orgId, userId: user.id, prospectId: prospect.id, key: 'uses_salesforce', value: false, client: c });
    check('fresh value-fail → disqualified', ctx.verdict.qualifies === false);
    check('action auto-resolved on disqualify', ctx.action.status === 'completed' && ctx.action.auto_completed === true);
    // undo — rep re-confirms true
    ctx = await WorkStage.validateSignal({ orgId, userId: user.id, prospectId: prospect.id, key: 'uses_salesforce', value: true, client: c });
    check('re-confirm → action re-surfaced pending', ctx.action.status === 'pending', ctx.action);

    // ── 5. Vendor can never clobber the rep validation (P1 rule holds) ───────
    const w = await SignalService.writeSignal({ orgId, entityType: 'account', entityId: account.id, key: 'uses_salesforce', value: false, source: 'list', client: c });
    check('vendor write dropped (rep_override)', w.written === false && w.reason === 'rep_override');

    // ── 6. Not-in-role: suppress + spawn replacement; nightly stays quiet ────
    const nir = await WorkStage.markNotInRole({ orgId, userId: user.id, prospectId: prospect.id, client: c });
    check('not-in-role: replacement task spawned', !!nir.replacementActionId);
    let mainAct = (await c.query(`SELECT * FROM prospecting_actions WHERE prospect_id=$1 AND source_rule=$2`, [prospect.id, `signal:${campaign.id}`])).rows[0];
    check('not-in-role: signal action resolved', mainAct.status === 'completed' && mainAct.auto_completed === true);
    // nightly-style sweep must NOT resurface
    r = await Surfacer.surfaceForCampaign({ orgId, campaign, client: c });
    mainAct = (await c.query(`SELECT * FROM prospecting_actions WHERE prospect_id=$1 AND source_rule=$2`, [prospect.id, `signal:${campaign.id}`])).rows[0];
    check('sweep does not resurface suppressed contact', mainAct.status === 'completed');
    const repl = (await c.query(`SELECT * FROM prospecting_actions WHERE id=$1`, [nir.replacementActionId])).rows[0];
    check('sweep leaves find-replacement pending', repl.status === 'pending');
    ctx = await WorkStage.buildWorkContext({ orgId, prospectId: prospect.id, client: c });
    check('work context reports notInRole + hides reserved key', ctx.notInRole === true && !ctx.signals.some(s => s.key === 'contact_not_in_role'));

    // clear-not-in-role → resurfaces on next reeval, replacement auto-completed
    await WorkStage.clearNotInRole({ orgId, userId: user.id, prospectId: prospect.id, client: c });
    mainAct = (await c.query(`SELECT * FROM prospecting_actions WHERE prospect_id=$1 AND source_rule=$2`, [prospect.id, `signal:${campaign.id}`])).rows[0];
    check('clear-not-in-role: action resurfaced', mainAct.status === 'pending');
    const repl2 = (await c.query(`SELECT * FROM prospecting_actions WHERE id=$1`, [nir.replacementActionId])).rows[0];
    check('clear-not-in-role: replacement task auto-completed', repl2.status === 'completed');

    // ── 7. Replace contact ────────────────────────────────────────────────────
    const rep = await WorkStage.replaceContact({
      orgId, userId: user.id, prospectId: prospect.id,
      firstName: 'Nia', lastName: 'New', title: 'CRO', email: 'nia@acme.io', client: c,
    });
    check('replace: new prospect inherits account+campaign', rep.prospect.account_id === account.id && rep.prospect.campaign_id === campaign.id);
    check('replace: classified from title', rep.classification && ['sales','revenue'].includes(rep.classification.function), rep.classification);
    check('replace: newcomer qualifies (account signals apply)', rep.workContext.verdict.qualifies === true);
    check('replace: newcomer surfaced at high (trigger still fresh)', rep.workContext.action && rep.workContext.action.status === 'pending' && rep.workContext.verdict.priority === 'high');
    mainAct = (await c.query(`SELECT * FROM prospecting_actions WHERE prospect_id=$1 AND source_rule=$2`, [prospect.id, `signal:${campaign.id}`])).rows[0];
    check('replace: old contact suppressed again', mainAct.status === 'completed');
    // duplicate email guard
    let dupErr = null;
    try {
      await WorkStage.replaceContact({ orgId, userId: user.id, prospectId: prospect.id, firstName: 'Nia', lastName: 'Dup', email: 'nia@acme.io', client: c });
    } catch (e) { dupErr = e; }
    check('replace: duplicate email → 409', dupErr && dupErr.statusCode === 409 && dupErr.code === 'DUPLICATE_EMAIL');

    // ── 7b. Rep-recorded outcomes are FINAL — reeval must not re-open them ───
    const newAct = (await c.query(`SELECT * FROM prospecting_actions WHERE prospect_id=$1 AND source_rule=$2`, [rep.prospect.id, `signal:${campaign.id}`])).rows[0];
    await c.query(
      `UPDATE prospecting_actions SET status='completed', auto_completed=false, completed_at=NOW(), completed_by=$2, outcome='sent' WHERE id=$1`,
      [newAct.id, user.id]
    );
    await Surfacer.surfaceForCampaign({ orgId, campaign, client: c });
    const afterSweep = (await c.query(`SELECT status, outcome FROM prospecting_actions WHERE id=$1`, [newAct.id])).rows[0];
    check('rep-completed (outcome recorded) stays completed through sweep', afterSweep.status === 'completed' && afterSweep.outcome === 'sent');

    // ── 8. TTL aging → unknown → confirmation (never false) via work context ─
    await c.query(`UPDATE entity_signals SET observed_at = NOW() - interval '200 days' WHERE org_id=$1 AND key='recently_raised'`, [orgId]);
    const ctx2 = await WorkStage.buildWorkContext({ orgId, prospectId: rep.prospect.id, client: c });
    check('stale trigger → priority falls back to low, still qualifies', ctx2.verdict.priority === 'low' && ctx2.verdict.qualifies === true);
    check('stale trigger not a filter → NOT a confirmation', ctx2.confirmations.length === 0);
    const staleSig = ctx2.signals.find(s => s.key === 'recently_raised');
    check('stale signal reads unknown with staleValue kept', staleSig.state === 'unknown' && staleSig.value === null && staleSig.staleValue != null);

    await c.query('ROLLBACK');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('FATAL', err);
    failures++;
  } finally {
    c.release();
    await pool.end();
  }
  console.log(failures === 0 ? '\nALL P7 TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
