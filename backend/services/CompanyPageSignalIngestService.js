/**
 * services/CompanyPageSignalIngestService.js
 *
 * DROP-IN LOCATION: backend/services/CompanyPageSignalIngestService.js
 *
 * Motion-1 adapter (Phase 10) — EXTENSION COMPANY-PAGE READ → signals.
 * The Chrome extension, on a linkedin.com/company/* page the rep is already
 * viewing, reads what LinkedIn rendered (top card + About + Jobs module +
 * latest post date; People tab deliberately out of scope) and, on an
 * EXPLICIT rep tap, posts one capture here. Rep-present, visible-page-only,
 * no crawling — the same posture as the /in/* profile capture (ToS care,
 * design §risks).
 *
 * THE ADAPTER CONTRACT (§5, same as P6/P7/P8/P9):
 *   normalize → SignalService.writeSignal({ source:'extension',
 *   observedAt, confidence:'medium' }) per key → THEN
 *   SignalActionSurfacer.reevalOnCapture on the account.
 *   Blank/absent never writes (unknown-never-false). Reconciliation
 *   upstream: rep values survive (rep_override); between vendor (P9
 *   'enrichment') and page-read ('extension') writes, fresher observed_at
 *   wins — a live page read can update a stale vendor record and vice
 *   versa; confidence breaks exact ties (enrichment high > extension
 *   medium).
 *
 * SIGNAL KEYS: reuses the P9 catalog where semantics match —
 *   industry, hq_country, hq_city, company_about, active_job_postings,
 *   and headcount ONLY from a real "associated members" count (never
 *   fabricated from the "51-200" size range; the range may ride along in
 *   the capture for display but is not written as a number)
 * — plus ONE new key:
 *   recent_company_post (recency, Prioritize, TTL 30, hook "active on
 *   LinkedIn"). Deliberately separate from recent_news: posts are
 *   activity, news is news; a news prioritizer should not fire on a
 *   corporate meme. Value = the post date ISO string (the recency
 *   evaluator prefers a date-like value), observed_at = the same date.
 *
 * ACCOUNT RESOLUTION (decided in-session):
 *   match by accounts.linkedin_company_url (normalized) → else by domain
 *   (from the About website) → else no match; the panel then offers an
 *   explicit "Create account & save" which lands here with
 *   createIfMissing=true and rides the existing resolveAccountId create
 *   path. A domain-based match backfills the account's missing
 *   linkedin_company_url (same never-overwrite rule as domainResolver).
 *
 * Never reads or writes prospect.stage.
 */

const { pool } = require('../config/database');
const SignalService        = require('./SignalService');
const SignalRegistry       = require('./SignalRegistryService');
const SignalActionSurfacer = require('./SignalActionSurfacer');
const EnrichmentSignalIngest = require('./EnrichmentSignalIngestService');
const { normalizeLinkedInCompanyUrl, normalizeDomain, resolveAccountId } = require('./domainResolver');

const RECENT_POST_KEY = 'recent_company_post';
const ABOUT_MAX_CHARS = 5000;
const HEADLINE_MAX_CHARS = 300;

// v1.23.1 additions — the fields the live-page test showed we were missing.
// All harvest (page-read) ⇒ medium reliability; specialties/followers keep
// 'both' (medium may Filter — only LOW clamps to Prioritize, RULE 1), the
// headline is rep/draft context, not a predicate.
const P10_EXTRA_DEFS = [
  {
    key: RECENT_POST_KEY, label: 'Recent company post', predicateType: 'recency',
    capability: 'prioritize', ttlDays: 30, defaultHook: 'active on LinkedIn right now',
    description: 'The company posted on LinkedIn recently (read from the company page by the extension). Activity, not news — recent_news is the separate news signal.',
  },
  {
    key: 'company_headline', label: 'Company headline', predicateType: 'set',
    capability: 'prioritize', ttlDays: 365, defaultHook: null,
    description: "The company's LinkedIn tagline — the one-liner under the name. Context for reps and drafts, not a targeting predicate.",
  },
  {
    key: 'specialties', label: 'Specialties', predicateType: 'set',
    capability: 'both', ttlDays: 365, defaultHook: null,
    description: 'Self-declared specialties from the LinkedIn company page.',
  },
  {
    key: 'linkedin_followers', label: 'LinkedIn followers', predicateType: 'number',
    capability: 'both', ttlDays: 180, defaultHook: null,
    description: "The company page's follower count.",
  },
  {
    key: 'company_size_range', label: 'Company size (range)', predicateType: 'set',
    capability: 'both', ttlDays: 180, defaultHook: null,
    description: 'The LinkedIn-stated employee range (e.g. "1,001-5,000 employees"). Stored as the stated range string — headcount remains reserved for real counts (no fabricated numbers).',
  },
  {
    key: 'recent_job_posting', label: 'Recent job posting', predicateType: 'recency',
    capability: 'prioritize', ttlDays: 30, defaultHook: 'hiring right now',
    description: "The newest job posting's date, read from the company's Jobs tab (LinkedIn often states no total there — the freshest posting is the stated fact, and the why-now). The open-roles COUNT comes from enrichment or pages that state one.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Defs: the shared P9 set (industry / headcount / hq / about / postings /
// etc.) + the one P10-only key. Both lazily ensured — an org whose first
// signal source is the extension gets the same catalog an enriching org has.
// ─────────────────────────────────────────────────────────────────────────────

async function ensureDefs(orgId, client) {
  await EnrichmentSignalIngest.ensureEnrichDefs(orgId, client);
  for (const def of P10_EXTRA_DEFS) {
    const existing = await SignalRegistry.getDef({ orgId, key: def.key, client });
    if (existing) continue;
    try {
      await SignalRegistry.createDef({
        orgId,
        key: def.key,
        label: def.label,
        description: def.description,
        capability: def.capability,
        scope: 'company',
        predicateType: def.predicateType,
        sourceKind: 'harvest',
        ttlDays: def.ttlDays,
        defaultHook: def.defaultHook || null,
        client,
      });
    } catch (err) {
      if (!/already exists/i.test(err.message)) throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction: capture payload → [{ key, value, observedAt? }]
// ─────────────────────────────────────────────────────────────────────────────

function _str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max && s.length > max ? s.slice(0, max) + '…' : s;
}

function _int(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function _strArray(v, max) {
  if (!Array.isArray(v)) return null;
  const arr = v.map((x) => (typeof x === 'string' ? x.trim() : null)).filter(Boolean);
  const uniq = [...new Set(arr)].slice(0, max || arr.length);
  return uniq.length ? uniq : null;
}

function _date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map one extension capture to signal writes. Pure — no I/O. Exported for
 * tests. NO FABRICATION: headcount only from a real member count;
 * recent_company_post only from a real date.
 *
 * Capture shape (all fields optional — blanks never write):
 *   { name, industry, hqCity, hqCountry, description, memberCount,
 *     sizeRange, jobOpenings, latestPostAt, websiteDomain,
 *     linkedinCompanyUrl, slug }
 */
function extractSignals(capture) {
  const c = capture || {};
  const out = [];
  const push = (key, value, observedAt) => {
    if (value === null || value === undefined) return;
    out.push({ key, value, ...(observedAt ? { observedAt } : {}) });
  };

  push('industry',      _str(c.industry, 200));
  push('hq_country',    _str(c.hqCountry, 120));
  push('hq_city',       _str(c.hqCity, 120));
  push('company_about', _str(c.description, ABOUT_MAX_CHARS));
  push('headcount',     _int(c.memberCount));       // NEVER from sizeRange
  push('active_job_postings', _int(c.jobOpenings)); // stated 0 = known fact

  // v1.23.1 — the fields the live-page test showed missing. sizeRange stays
  // display-only in the panel (no fabricated headcount) and phone stays
  // panel-only (accounts carry no phone column); everything below is a signal.
  push('company_headline',   _str(c.tagline, HEADLINE_MAX_CHARS));
  push('specialties',        _strArray(c.specialties, 25));
  push('linkedin_followers', _int(c.followers));
  push('founded_year',       _int(c.foundedYear));  // shared P9 key

  // v1.23.2 — the range itself persists as a stated-range STRING signal
  // ("1,001-5,000 employees"), targetable via one_of. headcount stays
  // reserved for real counts (associated members / staffCount).
  push('company_size_range', _str(c.sizeRange, 60));

  const postAt = _date(c.latestPostAt);
  if (postAt) push(RECENT_POST_KEY, postAt.toISOString(), postAt);

  // v1.23.3 — the newest job posting's date (the Jobs tab's stated fact when
  // no total exists). observed_at = the posting date, so within_days
  // prioritizers run off real hiring recency.
  const jobAt = _date(c.latestJobPostedAt);
  if (jobAt) push('recent_job_posting', jobAt.toISOString(), jobAt);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Account resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read-only match for the panel preview: linkedin_company_url first, then
 * domain. Returns { accountId, accountName, matchedBy } or
 * { accountId: null, matchedBy: 'none' }.
 */
async function matchAccount({ orgId, linkedinCompanyUrl, domain, client }) {
  const db = client || pool;
  const liUrl = normalizeLinkedInCompanyUrl ? normalizeLinkedInCompanyUrl(linkedinCompanyUrl) : (linkedinCompanyUrl || null);
  if (liUrl) {
    const { rows } = await db.query(
      `SELECT id, name FROM accounts
        WHERE org_id = $1 AND deleted_at IS NULL
          AND LOWER(linkedin_company_url) = LOWER($2)
        LIMIT 1`,
      [orgId, liUrl]
    );
    if (rows.length) return { accountId: rows[0].id, accountName: rows[0].name, matchedBy: 'linkedin_url' };
  }

  const realDomain = normalizeDomain ? normalizeDomain(domain) : (domain || null);
  if (realDomain) {
    const { rows } = await db.query(
      `SELECT id, name, linkedin_company_url FROM accounts
        WHERE org_id = $1 AND deleted_at IS NULL
          AND LOWER(domain) = LOWER($2)
        LIMIT 1`,
      [orgId, realDomain]
    );
    if (rows.length) {
      // Backfill the LinkedIn URL when missing — never overwrite (house rule).
      if (liUrl && !rows[0].linkedin_company_url) {
        await db.query(
          `UPDATE accounts SET linkedin_company_url = $2, updated_at = NOW()
            WHERE id = $1 AND (linkedin_company_url IS NULL OR linkedin_company_url = '')`,
          [rows[0].id, liUrl]
        ).catch(() => {});
      }
      return { accountId: rows[0].id, accountName: rows[0].name, matchedBy: 'domain' };
    }
  }

  return { accountId: null, accountName: null, matchedBy: 'none' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest: (resolve account) → write-then-reeval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One explicit rep tap. Resolves the account (match, or create when the rep
 * chose "Create account & save"), writes the extracted signals, reevals.
 *
 * @returns {Promise<{ok:boolean, reason?:string, accountId?:number,
 *                    accountName?:string, matchedBy?:string, created?:boolean,
 *                    written?:string[], skipped?:Array<{key,reason}>}>}
 */
async function ingestCompanyCapture({ orgId, userId, capture, createIfMissing = false }) {
  if (!orgId || !capture) {
    throw new Error('CompanyPageSignalIngest.ingestCompanyCapture: orgId and capture are required');
  }

  const items = extractSignals(capture);
  if (!items.length) {
    return { ok: false, reason: 'nothing_extractable' };
  }

  // ── Resolve the account ───────────────────────────────────────────────────
  let match = await matchAccount({
    orgId,
    linkedinCompanyUrl: capture.linkedinCompanyUrl,
    domain: capture.websiteDomain,
  });
  let created = false;

  if (!match.accountId) {
    if (!createIfMissing) {
      return { ok: false, reason: 'no_matching_account' };
    }
    if (!capture.name || !String(capture.name).trim()) {
      return { ok: false, reason: 'no_company_name' };
    }
    // Explicit rep choice — ride the existing create path (dedup by
    // domain/name, catchall handling, LinkedIn URL stamped on the new row).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await resolveAccountId({
        client,
        orgId,
        ownerId: userId || null,
        companyName: String(capture.name).trim(),
        companyDomain: capture.websiteDomain || null,
        companyLinkedInUrl: capture.linkedinCompanyUrl || null,
      });
      await client.query('COMMIT');
      if (!r.accountId) return { ok: false, reason: r.status || 'account_create_failed' };
      const nameRow = await pool.query(`SELECT name FROM accounts WHERE id = $1 AND org_id = $2`, [r.accountId, orgId]);
      match = { accountId: r.accountId, accountName: nameRow.rows[0]?.name || capture.name, matchedBy: r.status };
      created = ['created_with_domain', 'created_catchall'].some((s) => String(r.status).startsWith(s.split('_')[0])) || /creat/i.test(String(r.status));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Write-then-reeval (the adapter contract) ─────────────────────────────
  await ensureDefs(orgId);
  const now = new Date();
  const written = [];
  const skipped = [];
  for (const item of items) {
    const res = await SignalService.writeSignal({
      orgId,
      entityType: 'account',
      entityId: match.accountId,
      key: item.key,
      value: item.value,
      source: 'extension',
      observedAt: item.observedAt || now,
      confidence: 'medium',
    });
    if (res.written) written.push(item.key);
    else skipped.push({ key: item.key, reason: res.reason });
  }

  if (written.length) {
    await SignalActionSurfacer.reevalOnCapture({
      orgId, entityType: 'account', entityId: match.accountId,
    });
  }

  // Activity trail on the account is out of scope (prospecting_activities is
  // prospect-keyed); the signals themselves carry source + observed_at.

  return {
    ok: true,
    accountId: match.accountId,
    accountName: match.accountName,
    matchedBy: match.matchedBy,
    created,
    written,
    skipped,
  };
}

module.exports = {
  RECENT_POST_KEY,
  ensureDefs,
  extractSignals,
  matchAccount,
  ingestCompanyCapture,
};
