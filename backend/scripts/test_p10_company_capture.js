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

  // ── v1.23.1 — the fields the 10Xme live test showed missing ───────────────
  console.log('\nA2. v1.23.1 extraction (URN industry / followers / tagline / About dl)');

  // Dash-shaped entity: industry is a URN reference resolved via an included
  // sibling entity; size only as employeeCountRange; followers behind a
  // *followingState reference; tagline, foundedOn, specialities, phone inline.
  const IND_URN = 'urn:li:fsd_industryV2:1999';
  const FS_URN  = 'urn:li:fsd_followingState:acme';
  const dashDoc = {
    included: [
      { entityUrn: IND_URN, name: 'E-Learning Providers' },
      { entityUrn: FS_URN, followerCount: 496 },
      {
        entityUrn: 'urn:li:fsd_company:9999',
        universalName: 'tenxme', name: '10Xme',
        tagline: 'Premium AI education for ambitious professionals.',
        '*industryV2Taxonomy': [IND_URN],
        '*followingState': FS_URN,
        employeeCountRange: { start: 2, end: 10 },
        foundedOn: { year: 2024 },
        specialities: ['AI education', 'Prompt systems', 'AI education'],
        phone: { number: '+91 98765 43210' },
        websiteUrl: 'https://10xme.biz',
        description: 'Most professionals open ChatGPT, ask a question, get a generic answer, and move on.',
      },
    ],
  };
  const dom3 = new JSDOM(
    `<!DOCTYPE html><html><body><code>${JSON.stringify(dashDoc).replace(/</g, '\\u003c')}</code></body></html>`,
    { url: 'https://www.linkedin.com/company/tenxme/', runScripts: 'outside-only' }
  );
  dom3.window.__GOWARM_TEST__ = true;
  dom3.window.eval(src);
  const cap3 = dom3.window.__gowarmCompanyTest.buildCapture('tenxme', dom3.window.document, NOW);
  check('industry resolved through the URN reference', cap3.industry === 'E-Learning Providers', cap3.industry);
  check('tagline captured', cap3.tagline === 'Premium AI education for ambitious professionals.');
  check('employeeCountRange → "2-10 employees" display range, NO fabricated headcount',
    cap3.sizeRange === '2-10 employees' && cap3.memberCount === null, cap3.sizeRange);
  check('followers via *followingState reference', cap3.followers === 496);
  check('foundedOn.year / specialties (deduped) / phone.number captured',
    cap3.foundedYear === 2024 && JSON.stringify(cap3.specialties) === JSON.stringify(['AI education','Prompt systems']) && cap3.phone === '+91 98765 43210', cap3);

  // Top-card DOM fallback: NO usable entity — the visible summary line and
  // the tagline above it carry the facts (the screenshot's exact shape).
  const domTop = new JSDOM(`<!DOCTYPE html><html><body><section>
      <h1>10Xme</h1>
      <p>Premium AI education for ambitious professionals. Stop using AI like a chatbot.</p>
      <p>E-Learning Providers · 496 followers · 2-10 employees</p>
    </section></body></html>`,
    { url: 'https://www.linkedin.com/company/tenxme/', runScripts: 'outside-only' });
  domTop.window.__GOWARM_TEST__ = true;
  domTop.window.eval(src);
  const capTop = domTop.window.__gowarmCompanyTest.buildCapture('tenxme', domTop.window.document, NOW);
  check('top-card fallback: industry + followers + size range parsed from the dotted line',
    capTop.industry === 'E-Learning Providers' && capTop.followers === 496 && capTop.sizeRange === '2-10 employees', capTop);
  check('top-card fallback: tagline from the previous sibling', /Premium AI education/.test(capTop.tagline || ''));
  check('follower K-suffix parses ("12K followers" → 12000)',
    domTop.window.__gowarmCompanyTest.parseFollowerCount('Software · 12K followers') === 12000);

  // About-tab <dl>: the detailed facts block (Website / Phone / Industry /
  // Company size incl. associated members / Headquarters / Founded / Specialties).
  const domDl = new JSDOM(`<!DOCTYPE html><html><body><dl>
      <dt>Website</dt><dd><a href="https://10xme.biz">10xme.biz</a></dd>
      <dt>Phone</dt><dd><a href="tel:+919876543210">+91 98765 43210</a> Phone number is +91 98765 43210</dd>
      <dt>Industry</dt><dd>E-Learning Providers</dd>
      <dt>Company size</dt><dd>2-10 employees 13 associated members</dd>
      <dt>Headquarters</dt><dd>Hyderabad, Telangana, India</dd>
      <dt>Founded</dt><dd>2024</dd>
      <dt>Specialties</dt><dd>AI education, Prompt systems, and Agent workflows</dd>
    </dl></body></html>`,
    { url: 'https://www.linkedin.com/company/tenxme/about/', runScripts: 'outside-only' });
  domDl.window.__GOWARM_TEST__ = true;
  domDl.window.eval(src);
  const capDl = domDl.window.__gowarmCompanyTest.buildCapture('tenxme', domDl.window.document, NOW);
  check('About dl: website→domain, phone via tel:, industry',
    capDl.websiteDomain === '10xme.biz' && capDl.phone === '+919876543210' && capDl.industry === 'E-Learning Providers', capDl);
  check('About dl: size range display-only BUT associated members is a real count',
    capDl.sizeRange === '2-10 employees' && capDl.memberCount === 13);
  check('About dl: HQ city/country, founded, specialties',
    capDl.hqCity === 'Hyderabad' && capDl.hqCountry === 'India' && capDl.foundedYear === 2024
    && JSON.stringify(capDl.specialties) === JSON.stringify(['AI education','Prompt systems','Agent workflows']), capDl);

  // ── v1.23.2 — Gainsight live-test fixes ────────────────────────────────────
  console.log('\nA3. v1.23.2 (double-dd associated members + full Overview)');

  // Live /about shape: Company size renders TWO <dd> siblings — the range,
  // then "1,131 associated members" (with an ⓘ). Both must be read.
  const TRUNCATED = 'Gainsight is the retention engine behind the world\'s most customer-centric companies. The Gainsight platform orchestrates the customer journ…';
  const FULL_OVERVIEW = 'Gainsight is the retention engine behind the world\'s most customer-centric companies. The Gainsight platform orchestrates the customer journey from onboarding to outcomes. More than 2,000 companies trust Gainsight\'s applications and AI agents to drive learning, adoption, community connection and success for their customers. Learn more at www.gainsight.com. '
    + 'Second paragraph with additional detail well past the three hundred character truncation point that the entity JSON exhibits on live pages today.';
  const gsEntity = { universalName: 'gainsight', name: 'Gainsight', description: TRUNCATED, employeeCountRange: { start: 1001, end: 5000 } };
  const domGs = new JSDOM(`<!DOCTYPE html><html><body>
      <code>${JSON.stringify({ included: [gsEntity] }).replace(/</g, '\\u003c')}</code>
      <h2>Overview</h2>
      <p>${FULL_OVERVIEW.split('. Second paragraph')[0]}.</p>
      <p>Second paragraph${FULL_OVERVIEW.split('. Second paragraph')[1]}</p>
      <dl>
        <dt>Company size</dt>
        <dd>1,001-5,000 employees</dd>
        <dd>1,131 associated members <span>ⓘ</span></dd>
        <dt>Headquarters</dt><dd>San Francisco, California</dd>
      </dl>
    </body></html>`,
    { url: 'https://www.linkedin.com/company/gainsight/about/', runScripts: 'outside-only' });
  domGs.window.__GOWARM_TEST__ = true;
  domGs.window.eval(src);
  const capGs = domGs.window.__gowarmCompanyTest.buildCapture('gainsight', domGs.window.document, NOW);
  check('associated members read from the SECOND dd → real headcount 1131', capGs.memberCount === 1131, capGs.memberCount);
  check('range still captured alongside', capGs.sizeRange === '1,001-5,000 employees');
  check('full Overview beats the truncated entity description',
    capGs.description && capGs.description.length > 400 && !/journ…$/.test(capGs.description) && /Second paragraph/.test(capGs.description),
    capGs.description && capGs.description.length);
  check('entity-only pages keep the entity description (no Overview present)',
    /journ…$/.test(dom3.window.__gowarmCompanyTest.buildCapture('tenxme', dom3.window.document, NOW).description || 'x') === false); // dom3 has its own full entity description

  // ── v1.23.3 — Jobs tab: no stated total, but posting ages exist ────────────
  console.log('\nA4. v1.23.3 (newest job-posting age from the Jobs tab)');
  const domJobs = new JSDOM(`<!DOCTYPE html><html><body>
      <a href="https://www.linkedin.com/jobs/view/111">Quote Analyst – Salesforce CPQ</a>
      <span>8 hours ago</span>
      <a href="https://www.linkedin.com/jobs/view/222">Director, Technical Services</a>
      <span>4 days ago</span>
      <a href="https://www.linkedin.com/jobs/view/333">Senior Compensation Analyst</a>
      <span>30+ days ago</span>
      <span>See More Jobs</span>
    </body></html>`,
    { url: 'https://www.linkedin.com/company/gainsight/jobs/', runScripts: 'outside-only' });
  domJobs.window.__GOWARM_TEST__ = true;
  domJobs.window.eval(src);
  const capJobs = domJobs.window.__gowarmCompanyTest.buildCapture('gainsight', domJobs.window.document, NOW);
  check('NO fabricated open-roles count (page states none)', capJobs.jobOpenings === null);
  check('newest posting age wins (8h, not 4d/30d)',
    capJobs.latestJobPostedAt === new Date(NOW.getTime() - 8 * 3600e3).toISOString(), capJobs.latestJobPostedAt);
  check('"30+ days ago" parses conservatively as 30d',
    domJobs.window.__gowarmCompanyTest.parseRelativeTime('30+ days ago', NOW) === new Date(NOW.getTime() - 30 * 86400e3).toISOString());
  check('no job links → null (top-card pages unaffected)',
    domTop.window.__gowarmCompanyTest.extractLatestJobPostedAt(domTop.window.document, NOW) === null);

  // ── v1.23.4 — the visible job cards themselves ─────────────────────────────
  console.log('\nA5. v1.23.4 (job cards → titles/locations/ages)');
  const gsCode = JSON.stringify({ included: [{ universalName: 'gainsight', name: 'Gainsight' }] }).replace(/</g, '\\u003c');
  const domCards = new JSDOM(`<!DOCTYPE html><html><body>
      <code>${gsCode}</code>
      <ul>
        <li><a href="https://www.linkedin.com/jobs/view/111">Quote Analyst – Salesforce CPQ</a>
          <span>Gainsight</span><span>Greater Hyderabad Area</span>
          <span>1 school alum works here</span><span>8 hours ago</span></li>
        <li><a href="https://www.linkedin.com/jobs/view/222">Director, Technical Services</a>
          <span>Gainsight</span><span>Greater Hyderabad Area</span><span>4 days ago</span></li>
        <li><a href="https://www.linkedin.com/jobs/view/222">Director, Technical Services</a>
          <span>duplicate card — same job id</span></li>
        <li><a href="https://www.linkedin.com/jobs/search/?currentCompany=9">See More Jobs</a></li>
      </ul>
    </body></html>`,
    { url: 'https://www.linkedin.com/company/gainsight/jobs/', runScripts: 'outside-only' });
  domCards.window.__GOWARM_TEST__ = true;
  domCards.window.eval(src);
  const capCards = domCards.window.__gowarmCompanyTest.buildCapture('gainsight', domCards.window.document, NOW);
  check('two unique jobs captured (duplicate id + See-More link excluded)',
    Array.isArray(capCards.recentJobs) && capCards.recentJobs.length === 2, capCards.recentJobs);
  const j0 = capCards.recentJobs[0];
  check('title + location + posted age per card (company/alum lines filtered)',
    j0.title === 'Quote Analyst – Salesforce CPQ' && j0.location === 'Greater Hyderabad Area'
    && j0.postedAt === new Date(NOW.getTime() - 8 * 3600e3).toISOString(), j0);
  check('second card parsed too', capCards.recentJobs[1].title === 'Director, Technical Services'
    && capCards.recentJobs[1].postedAt === new Date(NOW.getTime() - 4 * 86400e3).toISOString());

  // ── v1.23.5 — accumulation across the rep's own pagination ─────────────────
  console.log('\nA6. v1.23.5 (mergeJobs: pages accumulate, dedupe, detail-upgrade, cap)');
  const MJ = domCards.window.__gowarmCompanyTest.mergeJobs;
  const page1 = [
    { id: '111', title: 'Quote Analyst', location: null, postedAt: null },
    { id: '222', title: 'Director, Technical Services', location: 'Hyderabad', postedAt: '2026-07-04T00:00:00.000Z' },
  ];
  const page2 = [
    { id: '111', title: 'Quote Analyst', location: 'Greater Hyderabad Area', postedAt: '2026-07-07T16:00:00.000Z' }, // richer duplicate
    { id: '333', title: 'Senior Compensation Analyst', location: 'Remote', postedAt: '2026-07-02T00:00:00.000Z' },
  ];
  const merged = MJ(page1, page2);
  check('pages merge with dedupe (3 unique across 2 pages)', merged.length === 3, merged.map(j => j.id));
  check('later scan UPGRADES a sparse record (location/age filled in)',
    merged.find(j => j.id === '111').location === 'Greater Hyderabad Area' && merged.find(j => j.id === '111').postedAt === '2026-07-07T16:00:00.000Z');
  check('newest-first ordering, undated would sink', merged[0].id === '111' && merged[1].id === '222' && merged[2].id === '333');
  const many = MJ([], Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: 'Role ' + i, postedAt: new Date(NOW.getTime() - i * 3600e3).toISOString() })));
  check('cap holds at 25', many.length === 25 && many[0].id === '0');

  // ── v1.23.6 — the live SDUI card shape (from the DevTools screenshot) ──────
  console.log('\nA7. v1.23.6 (SDUI job cards: lockup titles, no /jobs/view anchors)');
  const domSdui = new JSDOM(`<!DOCTYPE html><html><body>
      <code>${gsCode}</code>
      <ul>
        <li class="ember-view occludable-update" data-chameleon-result-urn="urn:li:jobPosting:41112223334">
          <div class="job-card-square__text--2-line-large artdeco-entity-lockup__title ember-view">
            <div class="job-card-square__title" dir="ltr">
              <div class="visually-hidden">Quote Analyst – Salesforce CPQ with verification</div>
              <span><span aria-hidden="true"><strong>Quote Analyst</strong> – Salesforce CPQ</span></span>
            </div>
          </div>
          <span>Gainsight</span>
          <span>Greater Hyderabad Area</span>
          <span>1 school alum works here</span>
          <span>22 hours ago</span>
        </li>
        <li class="job-card-square ember-view">
          <div class="artdeco-entity-lockup__title">
            <span><span aria-hidden="true">Principal Engineer</span><span class="visually-hidden">Principal Engineer</span></span>
          </div>
          <span>Gainsight</span>
          <span>Bengaluru</span>
          <span>1 week ago</span>
        </li>
        <li><a href="https://www.linkedin.com/company/gainsight/jobs/">Show all jobs</a></li>
      </ul>
    </body></html>`,
    { url: 'https://www.linkedin.com/company/gainsight/jobs/', runScripts: 'outside-only' });
  domSdui.window.__GOWARM_TEST__ = true;
  domSdui.window.eval(src);
  const capSdui = domSdui.window.__gowarmCompanyTest.buildCapture('gainsight', domSdui.window.document, NOW);
  check('SDUI cards captured without any /jobs/view anchor',
    Array.isArray(capSdui.recentJobs) && capSdui.recentJobs.length === 2, capSdui.recentJobs);
  const s0 = capSdui.recentJobs.find(j => /Quote Analyst/.test(j.title));
  check('visually-hidden duplicate stripped (title reads once, clean)',
    s0 && s0.title === 'Quote Analyst – Salesforce CPQ', s0 && s0.title);
  check('id from the jobPosting URN data attribute', s0.id === '41112223334');
  check('location + age per SDUI card (company/alum filtered)',
    s0.location === 'Greater Hyderabad Area' && s0.postedAt === new Date(NOW.getTime() - 22 * 3600e3).toISOString(), s0);
  const s1 = capSdui.recentJobs.find(j => j.title === 'Principal Engineer');
  check('no-id card falls back to a title key and still dedupes',
    s1 && s1.id === 't:principal engineer' && s1.location === 'Bengaluru');
  check('newest-first: 22h card leads', capSdui.recentJobs[0].title === 'Quote Analyst – Salesforce CPQ');
  check('latestJobPostedAt gate passes on SDUI-only pages',
    capSdui.latestJobPostedAt === new Date(NOW.getTime() - 22 * 3600e3).toISOString(), capSdui.latestJobPostedAt);

  // ── v1.23.7 — pre-rendered carousels: capture past the old 10-card cap ─────
  console.log('\nA8. v1.23.7 (per-scan cap 25: pre-rendered carousel fully captured)');
  const manyCards = Array.from({ length: 14 }, (_, i) => `
    <li class="job-card-square ember-view" data-job-id="90000${String(i).padStart(2,'0')}">
      <div class="artdeco-entity-lockup__title"><span><span aria-hidden="true">Role ${i + 1}</span></span></div>
      <span>Gainsight</span><span>Hyderabad</span><span>${i + 1} days ago</span>
    </li>`).join('');
  const domMany = new JSDOM(`<!DOCTYPE html><html><body><code>${gsCode}</code><ul>${manyCards}</ul></body></html>`,
    { url: 'https://www.linkedin.com/company/gainsight/jobs/', runScripts: 'outside-only' });
  domMany.window.__GOWARM_TEST__ = true;
  domMany.window.eval(src);
  const capMany = domMany.window.__gowarmCompanyTest.buildCapture('gainsight', domMany.window.document, NOW);
  check('all 14 pre-rendered cards captured in ONE scan (old cap was 10)',
    Array.isArray(capMany.recentJobs) && capMany.recentJobs.length === 14, capMany.recentJobs && capMany.recentJobs.length);
  check('newest-first held across the full set',
    capMany.recentJobs[0].title === 'Role 1' && capMany.recentJobs[13].title === 'Role 14');

  // ── v1.23.8 — full specialties captured (Gainsight declares ~28) ───────────
  console.log('\nA9. v1.23.8 (specialties cap 50)');
  const specs = Array.from({ length: 28 }, (_, i) => 'Specialty ' + (i + 1));
  const domSpec = new JSDOM(`<!DOCTYPE html><html><body>
      <code>${JSON.stringify({ included: [{ universalName: 'gainsight', name: 'Gainsight', specialities: specs }] }).replace(/</g, '\\u003c')}</code>
    </body></html>`,
    { url: 'https://www.linkedin.com/company/gainsight/', runScripts: 'outside-only' });
  domSpec.window.__GOWARM_TEST__ = true;
  domSpec.window.eval(src);
  const capSpec = domSpec.window.__gowarmCompanyTest.buildCapture('gainsight', domSpec.window.document, NOW);
  check('all 28 specialties captured (old cap was 25)',
    Array.isArray(capSpec.specialties) && capSpec.specialties.length === 28, capSpec.specialties && capSpec.specialties.length);

  // ── v1.23.9 — cross-path duplicate reconciliation ──────────────────────────
  console.log('\nA10. v1.23.9 (mergeJobs two-tier dedupe)');
  const MJ9 = domCards.window.__gowarmCompanyTest.mergeJobs;
  // Same job seen by both paths: numeric id vs t: fallback, same title+loc.
  let m9 = MJ9(
    [{ id: 't:principal engineer - ii', title: 'Principal Engineer - II', location: 'Bengaluru', postedAt: null }],
    [{ id: '4111222333', title: 'Principal Engineer - II', location: 'Bengaluru', postedAt: '2026-07-01T00:00:00.000Z' }]
  );
  check('fallback + numeric same title/loc → ONE record, numeric id, details merged',
    m9.length === 1 && m9[0].id === '4111222333' && m9[0].postedAt === '2026-07-01T00:00:00.000Z', m9);
  // Reverse arrival order.
  m9 = MJ9(
    [{ id: '4111222333', title: 'Principal Engineer - II', location: 'Bengaluru', postedAt: '2026-07-01T00:00:00.000Z' }],
    [{ id: 't:principal engineer - ii', title: 'Principal Engineer - II', location: 'Bengaluru', postedAt: null }]
  );
  check('reverse order too → one record, numeric id kept', m9.length === 1 && m9[0].id === '4111222333');
  // Two DISTINCT numeric ids, identical title/loc → genuinely two postings.
  m9 = MJ9(
    [{ id: '111', title: 'GTM Data Architect', location: 'Greater Hyderabad Area', postedAt: '2026-07-01T00:00:00.000Z' }],
    [{ id: '222', title: 'GTM Data Architect', location: 'Greater Hyderabad Area', postedAt: '2026-07-01T00:00:00.000Z' }]
  );
  check('two distinct numeric ids, same title → BOTH kept (reposts are real)', m9.length === 2);
  // Same title, DIFFERENT locations, one fallback → distinct roles kept.
  m9 = MJ9(
    [{ id: 't:senior analyst', title: 'Senior Analyst', location: 'Bengaluru', postedAt: null }],
    [{ id: '333', title: 'Senior Analyst', location: 'United States', postedAt: null }]
  );
  check('same title different location → not collapsed', m9.length === 2);
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
    check('capture → 8 keys (incl. recent_company_post + company_size_range)',
      JSON.stringify(keys) === JSON.stringify(['active_job_postings','company_about','company_size_range','headcount','hq_city','hq_country','industry','recent_company_post']), keys);
    check('size range persisted AS the stated string (v1.23.2)',
      items.find(i => i.key === 'company_size_range').value === '51-200 employees');
    const post = items.find(i => i.key === 'recent_company_post');
    check('post signal: date value + observed_at = post date', post.value === '2026-07-01T00:00:00.000Z' && post.observedAt.toISOString() === '2026-07-01T00:00:00.000Z');

    items = Ingest.extractSignals({ ...CAP, memberCount: null, jobOpenings: 0, latestPostAt: 'garbage' });
    check('no fabrication from range; postings 0 written; bad date skipped',
      !items.some(i => i.key === 'headcount') && items.find(i => i.key === 'active_job_postings').value === 0 && !items.some(i => i.key === 'recent_company_post'));

    // ── v1.23.1: the new capture fields → signals ─────────────────────────
    items = Ingest.extractSignals({
      ...CAP,
      tagline: 'Premium AI education for ambitious professionals.',
      specialties: ['AI education', 'Prompt systems'],
      followers: 496,
      foundedYear: 2024,
      phone: '+91 98765 43210', // panel-only — must NOT become a signal
    });
    const m2 = Object.fromEntries(items.map(i => [i.key, i.value]));
    check('v1.23.1: headline/specialties/followers/founded_year extracted',
      m2.company_headline === 'Premium AI education for ambitious professionals.'
      && JSON.stringify(m2.specialties) === JSON.stringify(['AI education','Prompt systems'])
      && m2.linkedin_followers === 496 && m2.founded_year === 2024, m2);
    check('phone is panel-only, never a signal', !('phone' in m2));

    // v1.23.3 — newest job posting date → recency signal with its own observed_at
    const jobItems = Ingest.extractSignals({ ...CAP, latestJobPostedAt: '2026-07-07T16:00:00.000Z' });
    const rj = jobItems.find(i => i.key === 'recent_job_posting');
    check('v1.23.3: recent_job_posting extracted with posting-date observed_at',
      rj && rj.value === '2026-07-07T16:00:00.000Z' && rj.observedAt.toISOString() === '2026-07-07T16:00:00.000Z', rj);

    // v1.23.4 — the posted-roles list becomes a set signal (titles + locations)
    const jt = Ingest.extractSignals({ ...CAP, recentJobs: [
      { id: '111', title: 'Quote Analyst – Salesforce CPQ', location: 'Greater Hyderabad Area', postedAt: '2026-07-07T16:00:00.000Z' },
      { id: '222', title: 'Director, Technical Services', location: null, postedAt: null },
      { id: '333', title: '   ' },
    ]}).find(i => i.key === 'recent_job_titles');
    check('v1.23.4: recent_job_titles set built (location folded in, blanks dropped)',
      jt && JSON.stringify(jt.value) === JSON.stringify(['Quote Analyst – Salesforce CPQ (Greater Hyderabad Area)','Director, Technical Services']), jt);

    // v1.23.8 — specialties signal keeps all items up to 50
    const sp = Ingest.extractSignals({ ...CAP, specialties: Array.from({ length: 28 }, (_, i) => 'S' + i) }).find(i => i.key === 'specialties');
    check('v1.23.8: 28 specialties persist in the signal (cap now 50)', sp && sp.value.length === 28, sp && sp.value.length);

    const newDefs = (await pool.query(
      `SELECT key, source_kind, reliability, capability, predicate_type FROM signal_defs
        WHERE org_id=$1 AND key IN ('company_headline','specialties','linkedin_followers','company_size_range','recent_job_posting','recent_job_titles')`, [orgId])).rows;
    check('6 new defs ensured (harvest ⇒ medium; specialties/followers/size-range may Filter)',
      newDefs.length === 6
      && newDefs.every(d => d.source_kind === 'harvest' && d.reliability === 'medium')
      && newDefs.find(d => d.key === 'specialties').capability === 'both'
      && newDefs.find(d => d.key === 'linkedin_followers').capability === 'both'
      && newDefs.find(d => d.key === 'company_size_range').capability === 'both'
      && newDefs.find(d => d.key === 'recent_job_posting').predicate_type === 'recency'
      && newDefs.find(d => d.key === 'recent_job_titles').capability === 'prioritize'
      && newDefs.find(d => d.key === 'company_headline').capability === 'prioritize', newDefs);

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
    check('createIfMissing creates + writes', r.ok === true && r.accountId && r.written.length === 8, r);
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
      r.skipped.length === 1 && r.skipped[0].key === 'company_about' && r.skipped[0].reason === 'rep_override' && r.written.length === 7, r.skipped);
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
