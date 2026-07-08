/**
 * scripts/test_p10_company_capture.js — P10 integration test (throwaway).
 * Run: DATABASE_URL=postgres://claude:claude@localhost:5432/gowarm9 \
 *        EXT_DIR=/path/to/gowarm-linkedin-ext node scripts/test_p10_company_capture.js
 *
 * Two halves:
 *
 * A) EXTENSION EXTRACTION (JSDOM harness — executes the real
 *    company_content.js against fixture LinkedIn HTML):
 *    - slug parsing; owner-binding (a decoy "similar company" entity with a
 *      different universalName is never captured)
 *    - org entity fields incl. staffCount vs staffCountRange (range is
 *      display-only — NO fabricated headcount)
 *    - jobs-count DOM fallback ("See all 12 jobs")
 *    - latest-post relative-time parsing ("2w" → ISO, conservative)
 *    NOTE ON WHAT THIS PROVES: the harness proves the extraction logic is
 *    correct against the documented entity/DOM shapes — it does NOT prove
 *    LinkedIn's live DOM matches those shapes today. That check is a 2-min
 *    manual pass on a real company page after install (see handoff note).
 *
 * B) BACKEND INGEST (live Postgres 16, v2 schema + 2026_36→43):
 *    - defs: shared P9 set + recent_company_post (harvest ⇒ medium ⇒
 *      Prioritize clamp), idempotent
 *    - extractSignals: no fabrication from sizeRange; jobOpenings 0 written;
 *      post date → value + observed_at
 *    - matchAccount: linkedin_company_url → domain → none; URL backfill on
 *      domain match (never overwrite)
 *    - ingest: source='extension' confidence 'medium'; no-match without
 *      create → soft failure; createIfMissing creates via resolveAccountId
 *    - reconciliation: fresher page-read updates older enrichment value;
 *      EXACT-tie goes to higher confidence (enrichment high > extension
 *      medium); rep beats page-read
 *    - reeval: campaign prioritizing recent_company_post within 14d → HIGH
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://claude:claude@localhost:5432/gowarm9';

const path = require('path');
const fs   = require('fs');
const jobPath = path.resolve(__dirname, '../jobs/notificationJob.js');
require.cache[jobPath] = {
  id: jobPath, filename: jobPath, loaded: true,
  exports: { notificationQueue: { add: async () => ({}) } },
};

const { pool } = require('../config/database');
const SignalService = require('../services/SignalService');
const Ingest = require('../services/CompanyPageSignalIngestService');
const EnrichIngest = require('../services/EnrichmentSignalIngestService');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const RUN = String(Date.now());
const EXT_DIR = process.env.EXT_DIR || path.resolve(__dirname, '../../../ext/gowarm-linkedin-ext');

// ─────────────────────────────────────────────────────────────────────────────
// A) Extension extraction harness
// ─────────────────────────────────────────────────────────────────────────────
async function testExtraction() {
  console.log('\nA. company_content.js extraction (JSDOM)');
  const { JSDOM } = require('jsdom');

  const orgEntity = {
    universalName: 'acme-corp',
    name: 'Acme Corp',
    industry: 'Software Development',
    description: 'Acme is the revenue execution layer for modern B2B teams.',
    staffCount: 137,
    staffCountRange: { start: 51, end: 200 },
    websiteUrl: 'https://www.acme.io/products',
    headquarter: { address: { city: 'Austin', country: 'United States' } },
  };
  const decoyEntity = { // "similar pages" module — must NEVER be captured
    universalName: 'rival-inc',
    name: 'Rival Inc',
    industry: 'Fintech',
    staffCount: 9000,
  };

  const html = `<!DOCTYPE html><html><body>
    <code style="display:none">${JSON.stringify({ included: [decoyEntity, orgEntity] })}</code>
    <div><a href="https://www.linkedin.com/jobs/search/?currentCompany=123">See all 12 jobs</a></div>
    <div class="feed-shared-update-v2">
      <div class="update-components-actor__sub-description"><span aria-hidden="true">2w •</span></div>
    </div>
  </body></html>`;

  const dom = new JSDOM(html, { url: 'https://www.linkedin.com/company/acme-corp/posts/', runScripts: 'outside-only' });
  dom.window.__GOWARM_TEST__ = true;
  const src = fs.readFileSync(path.join(EXT_DIR, 'company_content.js'), 'utf8');
  dom.window.eval(src);
  const T = dom.window.__gowarmCompanyTest;
  check('test hook exposed (harness mode, no chrome)', !!T && typeof T.buildCapture === 'function');
  if (!T) return;

  check('slug parsed from /posts/ sub-page', T.getCompanySlug('https://www.linkedin.com/company/acme-corp/posts/') === 'acme-corp');

  const NOW = new Date('2026-07-08T00:00:00Z');
  const cap = T.buildCapture('acme-corp', dom.window.document, NOW);
  check('owner-bound: org entity found, decoy ignored', cap.name === 'Acme Corp' && cap.industry === 'Software Development', cap.name);
  check('member count from staffCount (137, not the decoy 9000)', cap.memberCount === 137);
  check('size range display-only string built', cap.sizeRange === '51-200 employees');
  check('HQ city/country from nested address', cap.hqCity === 'Austin' && cap.hqCountry === 'United States');
  check('website → bare domain', cap.websiteDomain === 'acme.io');
  check('jobs count from DOM anchor text', cap.jobOpenings === 12);
  check('latest post: "2w" → 14 days before now', cap.latestPostAt === new Date(NOW.getTime() - 14 * 86400e3).toISOString(), cap.latestPostAt);
  check('linkedinCompanyUrl assembled', cap.linkedinCompanyUrl === 'https://www.linkedin.com/company/acme-corp');

  // No-fabrication: entity WITHOUT staffCount but WITH a range → memberCount null.
  const html2 = `<!DOCTYPE html><html><body>
    <code>${JSON.stringify({ data: { universalName: 'acme-corp', name: 'Acme Corp', staffCountRange: '51-200 employees' } })}</code>
  </body></html>`;
  const dom2 = new JSDOM(html2, { url: 'https://www.linkedin.com/company/acme-corp/', runScripts: 'outside-only' });
  dom2.window.__GOWARM_TEST__ = true;
  dom2.window.eval(src);
  const cap2 = dom2.window.__gowarmCompanyTest.buildCapture('acme-corp', dom2.window.document, NOW);
  check('NO fabrication: range without staffCount → memberCount null', cap2.memberCount === null && cap2.sizeRange === '51-200 employees');
  check('missing modules degrade to null (jobs/post)', cap2.jobOpenings === null && cap2.latestPostAt === null);

  check('relative time: hours/months parse, garbage → null',
    T.parseRelativeTime('5h', NOW) === new Date(NOW.getTime() - 5 * 3600e3).toISOString()
    && T.parseRelativeTime('1mo', NOW) === new Date(NOW.getTime() - 30 * 86400e3).toISOString()
    && T.parseRelativeTime('Promoted', NOW) === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Backend ingest
// ─────────────────────────────────────────────────────────────────────────────
async function testIngest() {
  console.log('\nB. Backend ingest (live Postgres)');
  let orgId;
  try {
    const org = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P10 Test Org', 'p10-test-${RUN}') RETURNING id`)).rows[0];
    orgId = org.id;
    const user = (await pool.query(
      `INSERT INTO users (org_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, 'p10rep-${RUN}@test.io', 'x', 'Pat', 'Rep', 'member') RETURNING id`, [orgId])).rows[0];

    // ── defs ──────────────────────────────────────────────────────────────
    await Ingest.ensureDefs(orgId);
    await Ingest.ensureDefs(orgId);
    const def = (await pool.query(`SELECT * FROM signal_defs WHERE org_id=$1 AND key='recent_company_post'`, [orgId])).rows[0];
    check('recent_company_post def: harvest ⇒ medium ⇒ recency/prioritize ttl 30',
      def && def.source_kind === 'harvest' && def.reliability === 'medium' && def.predicate_type === 'recency' && def.capability === 'prioritize' && def.ttl_days === 30);
    const shared = (await pool.query(`SELECT COUNT(*)::int n FROM signal_defs WHERE org_id=$1 AND key = ANY($2)`, [orgId, EnrichIngest.ENRICH_SIGNAL_KEYS])).rows[0].n;
    check('shared P9 defs ensured too (extension-first org gets full catalog)', shared === 10);

    // ── extractSignals ────────────────────────────────────────────────────
    const CAP = {
      slug: 'acme-corp', linkedinCompanyUrl: 'https://www.linkedin.com/company/acme-corp',
      name: 'Acme Corp', industry: 'Software Development', hqCity: 'Austin', hqCountry: 'United States',
      description: 'Acme builds revenue tooling.', memberCount: 137, sizeRange: '51-200 employees',
      jobOpenings: 12, latestPostAt: '2026-07-01T00:00:00.000Z', websiteDomain: 'acme.io',
    };
    let items = Ingest.extractSignals(CAP);
    const keys = items.map(i => i.key).sort();
    check('capture → 7 keys (incl. recent_company_post)',
      JSON.stringify(keys) === JSON.stringify(['active_job_postings','company_about','headcount','hq_city','hq_country','industry','recent_company_post']), keys);
    const post = items.find(i => i.key === 'recent_company_post');
    check('post signal: date value + observed_at = post date', post.value === '2026-07-01T00:00:00.000Z' && post.observedAt.toISOString() === '2026-07-01T00:00:00.000Z');

    items = Ingest.extractSignals({ ...CAP, memberCount: null, jobOpenings: 0, latestPostAt: 'garbage' });
    check('no fabrication from range; postings 0 written; bad date skipped',
      !items.some(i => i.key === 'headcount') && items.find(i => i.key === 'active_job_postings').value === 0 && !items.some(i => i.key === 'recent_company_post'));

    // ── matchAccount ──────────────────────────────────────────────────────
    const acc = (await pool.query(
      `INSERT INTO accounts (org_id, owner_id, name, domain) VALUES ($1,$2,'Acme Corp','acme.io') RETURNING id`,
      [orgId, user.id])).rows[0];
    let m = await Ingest.matchAccount({ orgId, linkedinCompanyUrl: CAP.linkedinCompanyUrl, domain: 'acme.io' });
    check('match by domain when no LinkedIn URL on file', m.accountId === acc.id && m.matchedBy === 'domain');
    const backfilled = (await pool.query(`SELECT linkedin_company_url FROM accounts WHERE id=$1`, [acc.id])).rows[0];
    check('domain match backfilled the LinkedIn URL', /company\/acme-corp/.test(backfilled.linkedin_company_url || ''));
    m = await Ingest.matchAccount({ orgId, linkedinCompanyUrl: 'https://www.linkedin.com/company/acme-corp/', domain: null });
    check('now matches by LinkedIn URL (normalized, trailing slash ok)', m.accountId === acc.id && m.matchedBy === 'linkedin_url');
    m = await Ingest.matchAccount({ orgId, linkedinCompanyUrl: 'https://www.linkedin.com/company/nobody', domain: 'nobody.io' });
    check('unknown company → none', m.accountId === null && m.matchedBy === 'none');

    // ── ingest: no match without create → soft failure ────────────────────
    const CAP2 = { ...CAP, slug: 'newco', linkedinCompanyUrl: 'https://www.linkedin.com/company/newco', name: 'NewCo', websiteDomain: 'newco.io' };
    let r = await Ingest.ingestCompanyCapture({ orgId, userId: user.id, capture: CAP2, createIfMissing: false });
    check('no matching account without create → soft ok:false', r.ok === false && r.reason === 'no_matching_account');

    r = await Ingest.ingestCompanyCapture({ orgId, userId: user.id, capture: CAP2, createIfMissing: true });
    check('createIfMissing creates + writes', r.ok === true && r.accountId && r.written.length === 7, r);
    const newAcc = (await pool.query(`SELECT * FROM accounts WHERE id=$1`, [r.accountId])).rows[0];
    check('created account carries domain + LinkedIn URL', newAcc.domain === 'newco.io' && /company\/newco/.test(newAcc.linkedin_company_url || ''));

    // ── ingest onto the existing account + reconciliation ────────────────
    // Seed an OLDER enrichment value for industry, then page-read updates it.
    await SignalService.writeSignal({ orgId, entityType: 'account', entityId: acc.id, key: 'industry', value: 'Software (vendor, stale)', source: 'enrichment', confidence: 'high', observedAt: new Date(Date.now() - 30 * 86400e3) });
    // Rep claims company_about.
    await SignalService.writeSignal({ orgId, entityType: 'account', entityId: acc.id, key: 'company_about', value: 'Rep-written summary', source: 'rep' });

    r = await Ingest.ingestCompanyCapture({ orgId, userId: user.id, capture: CAP, createIfMissing: false });
    check('ingest onto matched account', r.ok === true && r.accountId === acc.id && r.matchedBy === 'linkedin_url');
    check('rep-claimed about skipped (rep_override), rest written',
      r.skipped.length === 1 && r.skipped[0].key === 'company_about' && r.skipped[0].reason === 'rep_override' && r.written.length === 6, r.skipped);
    const sigs = (await pool.query(`SELECT key, value, source, confidence FROM entity_signals WHERE org_id=$1 AND entity_id=$2`, [orgId, acc.id])).rows;
    const byKey = Object.fromEntries(sigs.map(s => [s.key, s]));
    check('fresher page-read updated the stale vendor industry', byKey.industry.value === 'Software Development' && byKey.industry.source === 'extension' && byKey.industry.confidence === 'medium');
    check('rep about untouched', byKey.company_about.value === 'Rep-written summary' && byKey.company_about.source === 'rep');

    // EXACT observed_at tie: enrichment(high) must not lose to extension(medium).
    // Uses founded_year — a key company captures never write, so no earlier
    // fresher row can shadow the tie with stale_incoming.
    const tieAt = new Date();
    await SignalService.writeSignal({ orgId, entityType: 'account', entityId: acc.id, key: 'founded_year', value: 2015, source: 'enrichment', confidence: 'high', observedAt: tieAt });
    const tie = await SignalService.writeSignal({ orgId, entityType: 'account', entityId: acc.id, key: 'founded_year', value: 2016, source: 'extension', confidence: 'medium', observedAt: tieAt });
    check('exact-tie: medium page-read loses to high vendor', tie.written === false && tie.reason === 'lower_confidence', tie);

    // ── reeval: recent post prioritizes the queue ─────────────────────────
    const targeting = {
      filters: [],
      prioritizers: [{ signal_key: 'recent_company_post', role: 'prioritize', label: 'Active on LinkedIn', predicate: { operator: 'within_days', value: 14 } }],
    };
    const camp = (await pool.query(
      `INSERT INTO prospecting_campaigns (org_id, name, status, activity_type, prospecting_config_override, created_by, owner_id)
       VALUES ($1,'P10 Campaign','active','outreach',$2,$3,$3) RETURNING *`,
      [orgId, JSON.stringify({ targeting }), user.id])).rows[0];
    const prospect = (await pool.query(
      `INSERT INTO prospects (org_id, owner_id, created_by, first_name, last_name, title, company_name, account_id, campaign_id, stage)
       VALUES ($1,$2,$2,'Vera','VP','VP Sales','Acme Corp',$3,$4,'target') RETURNING *`,
      [orgId, user.id, acc.id, camp.id])).rows[0];

    // Fresh capture with a 3-day-old post → tap → HIGH.
    const freshPost = new Date(Date.now() - 3 * 86400e3).toISOString();
    r = await Ingest.ingestCompanyCapture({ orgId, userId: user.id, capture: { ...CAP, latestPostAt: freshPost }, createIfMissing: false });
    check('tap ingested fresh post', r.ok && r.written.includes('recent_company_post'));
    const act = (await pool.query(
      `SELECT * FROM prospecting_actions WHERE org_id=$1 AND prospect_id=$2 AND source='signal' AND source_rule=$3`,
      [orgId, prospect.id, `signal:${camp.id}`])).rows[0];
    check('page-read trigger → queue row HIGH', !!act && act.status === 'pending' && act.priority === 'high', act && { p: act.priority });

    check('nothing_extractable soft failure', (await Ingest.ingestCompanyCapture({ orgId, userId: user.id, capture: { slug: 'x' } })).reason === 'nothing_extractable');
  } catch (err) {
    console.error('FATAL', err);
    failures++;
  } finally {
    if (orgId) {
      const CLEANUP = [
        'entity_signals', 'prospecting_actions', 'prospecting_activities', 'notifications',
        'prospects', 'prospecting_campaigns', 'accounts', 'signal_defs', 'org_users', 'users',
      ];
      for (const t of CLEANUP) {
        await pool.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]).catch(() => {});
      }
      await pool.query(`DELETE FROM organizations WHERE id=$1`, [orgId]).catch((e) => console.error('cleanup:', e.message));
    }
  }
}

async function main() {
  try {
    await testExtraction();
    await testIngest();
  } finally {
    await pool.end();
  }
  console.log(failures === 0 ? '\nALL P10 TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
