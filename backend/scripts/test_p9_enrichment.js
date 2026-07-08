/**
 * scripts/test_p9_enrichment.js — P9 integration test (throwaway, not shipped).
 * Run: DATABASE_URL=postgres://claude:claude@localhost:5432/gowarm9 node scripts/test_p9_enrichment.js
 *
 * Exercises the Motion-1 enrich→signal adapter on live Postgres 16
 * (v2 schema.sql + 2026_36 → 2026_43):
 *   - def ensure: 10 enrich defs, idempotent, right dims (enrich ⇒ HIGH
 *     reliability ⇒ 'both' capability allowed — enrichment may Filter)
 *   - extractSignals: Apollo shape (7 keys), CoreSignal shape + raw
 *     (10 keys: competitors / hiring / dated news), blank-never-write,
 *     postings=0 written, undated news skipped, caps applied
 *   - ingest: source='enrich' confidence high; def linkage; account-scoped
 *   - per-key reconciliation: rep edit survives re-ingest (rep_override)
 *     while untouched keys refresh; rep clear → next ingest fills;
 *     Apollo-after-CoreSignal keeps CoreSignal-only keys intact
 *   - reeval: campaign filtering on tech_stack + prioritizing on
 *     active_job_postings & recent_news → queue row flips to HIGH
 *   - enrichForWorkPanel (stubbed provider seam): one call → fields+signals;
 *     soft failures pass through (no_api_key, cap, no_account)
 *
 * COMMITS seed data; cleans up by org at the end (same as P8 suite).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://claude:claude@localhost:5432/gowarm9';

const path = require('path');
const jobPath = path.resolve(__dirname, '../jobs/notificationJob.js');
require.cache[jobPath] = {
  id: jobPath, filename: jobPath, loaded: true,
  exports: { notificationQueue: { add: async () => ({}) } },
};

const { pool } = require('../config/database');
const SignalService = require('../services/SignalService');
const Ingest = require('../services/EnrichmentSignalIngestService');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const RUN = String(Date.now());

// ── Provider payload fixtures ─────────────────────────────────────────────────
const APOLLO_DATA = {
  name: 'Acme Corp', domain: 'acme.io', industry: 'Software',
  size_range: '51-200 employees', headcount: 120,
  location: 'Austin, United States', hq_country: 'United States', hq_state: 'TX', hq_city: 'Austin',
  description: 'Acme builds revenue tooling for B2B teams.',
  founded_year: 2015,
  technologies: ['Salesforce', 'Marketo', 'AWS'],
};

const CS_DATA = {
  name: 'Acme Corp', domain: 'acme.io', industry: 'Software Development',
  size: '51-200 employees', employees_count: 135,
  location: 'Austin, Texas, United States',
  description: 'Acme is the revenue execution layer for modern B2B sales teams, ' + 'x'.repeat(6000),
  founded_year: 2015,
  tech_stack: ['Salesforce', 'HubSpot', 'Snowflake'],
  last_round: { type: 'Series A', amount: 12000000, date: '2026-01-15', currency: 'USD' },
};

const CS_RAW = {
  hq_country: 'United States', hq_city: 'Austin',
  competitors: [{ company_name: 'RivalOne' }, 'RivalTwo', { name: 'RivalThree' }],
  active_job_postings_count: 7,
  company_updates: [
    { date: '2026-06-20', description: 'Acme announces Series A extension led by Foo Ventures.' },
    { date: '2026-05-02', description: 'Acme ships agent workflows.' },
  ],
};

async function main() {
  let orgId;
  try {
    const org = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P9 Test Org', 'p9-test-${RUN}') RETURNING id`)).rows[0];
    orgId = org.id;
    const user = (await pool.query(
      `INSERT INTO users (org_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, 'p9rep-${RUN}@test.io', 'x', 'Pat', 'Rep', 'member') RETURNING id`, [orgId])).rows[0];
    const account = (await pool.query(
      `INSERT INTO accounts (org_id, owner_id, name, domain) VALUES ($1,$2,'Acme Corp','acme.io') RETURNING id`,
      [orgId, user.id])).rows[0];

    // ── 1. Def ensure ─────────────────────────────────────────────────────────
    console.log('\n1. Def ensure (10 defs, idempotent, enrich ⇒ high ⇒ may Filter)');
    await Ingest.ensureEnrichDefs(orgId);
    await Ingest.ensureEnrichDefs(orgId); // idempotent
    const defs = (await pool.query(
      `SELECT key, capability, scope, predicate_type, reliability, source_kind, ttl_days
         FROM signal_defs WHERE org_id=$1 AND key = ANY($2)`,
      [orgId, Ingest.ENRICH_SIGNAL_KEYS])).rows;
    check('all 10 defs created once', defs.length === 10, defs.length);
    check('all company-scoped, source enrich, reliability HIGH',
      defs.every(d => d.scope === 'company' && d.source_kind === 'enrich' && d.reliability === 'high'));
    const byKey = Object.fromEntries(defs.map(d => [d.key, d]));
    check('tech_stack may FILTER (capability both, not clamped)', byKey.tech_stack.capability === 'both');
    check('recent_news is recency/prioritize ttl 30', byKey.recent_news.predicate_type === 'recency' && byKey.recent_news.capability === 'prioritize' && byKey.recent_news.ttl_days === 30);
    check('active_job_postings number/both ttl 180', byKey.active_job_postings.predicate_type === 'number' && byKey.active_job_postings.ttl_days === 180);

    // ── 2. extractSignals mapping ─────────────────────────────────────────────
    console.log('\n2. extractSignals');
    let items = Ingest.extractSignals({ data: APOLLO_DATA, raw: { organization: {} } });
    const keys = items.map(i => i.key).sort();
    check('Apollo shape → exactly the 7 both-provider keys',
      JSON.stringify(keys) === JSON.stringify(['company_about','founded_year','headcount','hq_city','hq_country','industry','tech_stack']), keys);
    check('no CoreSignal-only keys fabricated from Apollo', !keys.includes('competitors') && !keys.includes('recent_news') && !keys.includes('active_job_postings'));

    items = Ingest.extractSignals({ data: CS_DATA, raw: CS_RAW });
    const map = Object.fromEntries(items.map(i => [i.key, i]));
    check('CoreSignal shape → all 10 keys', items.length === 10, items.map(i => i.key));
    check('headcount from employees_count', map.headcount.value === 135);
    check('competitors: mixed shapes normalized', JSON.stringify(map.competitors.value) === JSON.stringify(['RivalOne','RivalTwo','RivalThree']));
    check('about capped at 5000 + ellipsis', map.company_about.value.length === 5001 && map.company_about.value.endsWith('…'));
    check('news picks the LATEST dated item', /Series A extension/.test(map.recent_news.value));
    check('news observedAt = the item date (real news recency)', map.recent_news.observedAt.toISOString().startsWith('2026-06-20'));
    check('hq from raw when normalize lacks it (CoreSignal)', map.hq_country.value === 'United States' && map.hq_city.value === 'Austin');

    items = Ingest.extractSignals({ data: { industry: '  ' }, raw: { active_job_postings_count: 0, company_updates: [{ description: 'undated' }] } });
    check('blank never writes; postings=0 IS written; undated news skipped',
      items.length === 1 && items[0].key === 'active_job_postings' && items[0].value === 0, items);

    // ── 3. Ingest + reconciliation ────────────────────────────────────────────
    console.log('\n3. Ingest + per-key reconciliation');
    let r = await Ingest.ingestEnrichment({ orgId, accountId: account.id, data: CS_DATA, raw: CS_RAW, observedAt: new Date(Date.now() - 60000) });
    check('first ingest writes all 10', r.written.length === 10 && r.skipped.length === 0, r);
    const sig = (await pool.query(
      `SELECT key, source, confidence, signal_def_id FROM entity_signals WHERE org_id=$1 AND entity_type='account' AND entity_id=$2`,
      [orgId, account.id])).rows;
    check('all account-scoped, source enrich, confidence high, def-linked',
      sig.length === 10 && sig.every(s => s.source === 'enrichment' && s.confidence === 'high' && s.signal_def_id != null));

    // Rep edits company_about (✎ in the panel) — every rep edit saves.
    await SignalService.writeSignal({ orgId, entityType: 'account', entityId: account.id, key: 'company_about', value: 'Rep note v1', source: 'rep' });
    await SignalService.writeSignal({ orgId, entityType: 'account', entityId: account.id, key: 'company_about', value: 'Rep note v2 — refined', source: 'rep' });
    let about = (await pool.query(`SELECT value, source FROM entity_signals WHERE org_id=$1 AND entity_id=$2 AND key='company_about'`, [orgId, account.id])).rows[0];
    check('second rep edit saved (edits are never lost)', about.value === 'Rep note v2 — refined' && about.source === 'rep');

    // Re-ingest: about is dropped (rep_override); everything else refreshes.
    r = await Ingest.ingestEnrichment({ orgId, accountId: account.id, data: CS_DATA, raw: CS_RAW });
    check('re-ingest: about dropped by rep_override, other 9 written',
      r.written.length === 9 && r.skipped.length === 1 && r.skipped[0].key === 'company_about' && r.skipped[0].reason === 'rep_override', r.skipped);
    about = (await pool.query(`SELECT value, source FROM entity_signals WHERE org_id=$1 AND entity_id=$2 AND key='company_about'`, [orgId, account.id])).rows[0];
    check('rep text untouched (not appended, not replaced)', about.value === 'Rep note v2 — refined');

    // Rep clears (⌫ → unknown) → next ingest fills fresh.
    await SignalService.deleteSignal
      ? await SignalService.deleteSignal({ orgId, entityType: 'account', entityId: account.id, key: 'company_about' })
      : await pool.query(`DELETE FROM entity_signals WHERE org_id=$1 AND entity_id=$2 AND key='company_about'`, [orgId, account.id]);
    r = await Ingest.ingestEnrichment({ orgId, accountId: account.id, data: CS_DATA, raw: CS_RAW });
    about = (await pool.query(`SELECT source FROM entity_signals WHERE org_id=$1 AND entity_id=$2 AND key='company_about'`, [orgId, account.id])).rows[0];
    check('after rep clear, next ingest fills fresh vendor text', r.written.includes('company_about') && about.source === 'enrichment');

    // Apollo after CoreSignal: shared keys refresh, CS-only keys stay intact.
    r = await Ingest.ingestEnrichment({ orgId, accountId: account.id, data: APOLLO_DATA, raw: {} });
    const after = (await pool.query(
      `SELECT key, value FROM entity_signals WHERE org_id=$1 AND entity_id=$2 AND key IN ('headcount','competitors','active_job_postings','recent_news')`,
      [orgId, account.id])).rows;
    const am = Object.fromEntries(after.map(x => [x.key, x.value]));
    check('Apollo refreshed headcount (135→120)', am.headcount === 120, am.headcount);
    check('CoreSignal-only keys survive an Apollo run',
      Array.isArray(am.competitors) && am.competitors.length === 3 && am.active_job_postings === 7 && typeof am.recent_news === 'string');

    // ── 4. Reeval: enrichment answers targeting live ──────────────────────────
    console.log('\n4. Campaign reeval off enriched signals');
    const targeting = {
      filters: [
        { signal_key: 'tech_stack', role: 'filter', label: 'Uses Salesforce', predicate: { operator: 'one_of', value: ['Salesforce'] } },
      ],
      prioritizers: [
        { signal_key: 'active_job_postings', role: 'prioritize', label: 'Hiring ≥ 5', predicate: { operator: 'gte', value: 5 } },
        { signal_key: 'recent_news', role: 'prioritize', label: 'In the news', predicate: { operator: 'within_days', value: 45 } },
      ],
    };
    const camp = (await pool.query(
      `INSERT INTO prospecting_campaigns (org_id, name, status, activity_type, prospecting_config_override, created_by, owner_id)
       VALUES ($1,'P9 Campaign','active','outreach',$2,$3,$3) RETURNING *`,
      [orgId, JSON.stringify({ targeting }), user.id])).rows[0];
    const prospect = (await pool.query(
      `INSERT INTO prospects (org_id, owner_id, created_by, first_name, last_name, title, company_name, account_id, campaign_id, stage)
       VALUES ($1,$2,$2,'Vera','VP','VP Sales','Acme Corp',$3,$4,'target') RETURNING *`,
      [orgId, user.id, account.id, camp.id])).rows[0];

    // Fresh CS ingest (restores hiring/news recency), which reevals the account.
    await Ingest.ingestEnrichment({ orgId, accountId: account.id, data: CS_DATA, raw: CS_RAW });
    const act = (await pool.query(
      `SELECT * FROM prospecting_actions WHERE org_id=$1 AND prospect_id=$2 AND source='signal' AND source_rule=$3`,
      [orgId, prospect.id, `signal:${camp.id}`])).rows[0];
    check('enriched signals qualify + prioritize → queue row HIGH', !!act && act.status === 'pending' && act.priority === 'high', act && { p: act.priority, s: act.status });

    // ── 5. enrichForWorkPanel (stubbed provider seam) ─────────────────────────
    console.log('\n5. enrichForWorkPanel — one credit, fields + signals');
    let calls = 0;
    Ingest._deps.enrichAccountForProspect = async ({ prospectId, orgId: o }) => {
      calls++;
      return { ok: true, accountId: account.id, status: 'fields_applied',
               enriched: { industry_set: true }, provider: 'coresignal',
               data: CS_DATA, raw: CS_RAW };
    };
    let out = await Ingest.enrichForWorkPanel({ orgId, prospectId: prospect.id });
    check('one provider call → ok + provider + fields + signal summary',
      calls === 1 && out.ok === true && out.provider === 'coresignal' && out.fieldsApplied.industry_set === true && out.signals.written.length >= 9, out.signals);

    Ingest._deps.enrichAccountForProspect = async () => ({ ok: false, reason: 'no_api_key', provider: null });
    out = await Ingest.enrichForWorkPanel({ orgId, prospectId: prospect.id });
    check('no key configured → soft ok:false passthrough', out.ok === false && out.reason === 'no_api_key');

    Ingest._deps.enrichAccountForProspect = async () => ({ ok: false, reason: 'monthly_cap_reached', cap: 100, used: 100 });
    out = await Ingest.enrichForWorkPanel({ orgId, prospectId: prospect.id });
    check('cap reached → soft failure with cap/used', out.ok === false && out.reason === 'monthly_cap_reached' && out.cap === 100);

    Ingest._deps.enrichAccountForProspect = async () => ({ ok: false, reason: 'prospect_has_no_account' });
    out = await Ingest.enrichForWorkPanel({ orgId, prospectId: prospect.id });
    check('no account → soft failure', out.ok === false && out.reason === 'prospect_has_no_account');
  } catch (err) {
    console.error('FATAL', err);
    failures++;
  } finally {
    if (orgId) {
      const CLEANUP = [
        'entity_signals', 'prospecting_actions', 'prospecting_activities',
        'notifications', 'prospects', 'prospecting_campaigns', 'accounts',
        'signal_defs', 'org_users', 'users',
      ];
      for (const t of CLEANUP) {
        await pool.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]).catch(() => {});
      }
      await pool.query(`DELETE FROM organizations WHERE id=$1`, [orgId]).catch((e) => console.error('cleanup:', e.message));
    }
    await pool.end();
  }
  console.log(failures === 0 ? '\nALL P9 TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
