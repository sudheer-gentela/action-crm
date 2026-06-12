/**
 * PostmasterHealthService.js
 *
 * Phase 6 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Nightly pull of Google Postmaster Tools v2 domain statistics + compliance
 * status into `domain_health_daily` (table created in migration 2026_23).
 * Feeds the OutboundInsightEngine's deliverability_domain causes via the
 * spam-rate detector.
 *
 * API surface (v2, verified against Google's migration guide June 2026):
 *   POST https://gmailpostmastertools.googleapis.com/v2/domains/{domain}/domainStats:query
 *        body: { startDate: {year,month,day}, endDate: {year,month,day} }
 *   GET  https://gmailpostmastertools.googleapis.com/v2/domains/{domain}/complianceStatus
 *        (domains.getComplianceStatus)
 *
 * SCHEMA HONESTY: the exact v2 response field names are not fully publicly
 * documented. This service therefore (a) ALWAYS stores the raw response in
 * domain_health_daily.raw, and (b) extracts normalized columns defensively
 * through fallback key lists covering v1 names and plausible v2 renames.
 * After the first real pull, inspect a raw row and tighten EXTRACTORS if a
 * key is missed — one-time adjustment, flagged in the design doc.
 *
 * Setup required (one-time, per deployment):
 *   1. Verify each sending domain at postmaster.google.com (DNS TXT).
 *   2. Enable "Postmaster Tools API" in the GCP project.
 *   3. Mint a refresh token with scope
 *      https://www.googleapis.com/auth/postmaster.readonly using a Google
 *      account that owns the Postmaster domains:
 *        node scripts/postmasterAuthHelper.js
 *   4. Railway env: POSTMASTER_OAUTH_REFRESH_TOKEN (+ optionally
 *      POSTMASTER_OAUTH_CLIENT_ID / POSTMASTER_OAUTH_CLIENT_SECRET; falls
 *      back to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 *   5. Per org: organizations.settings.postmaster.domains, e.g.
 *        { "postmaster": { "domains": ["gowarmcrm.com", "gowarm.info"] } }
 *
 * Data expectations (decision D15): Google suppresses metrics below ~200
 * Gmail-recipient sends/day — sparse rows at dogfood volume are CORRECT,
 * not a bug. Data also lags 1–3 days, so each run pulls a trailing
 * 7-day window and upserts.
 */

const db = require('../config/database');

const API_BASE = 'https://gmailpostmastertools.googleapis.com/v2';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PULL_WINDOW_DAYS = 7;

// Overridable for tests.
let _fetchImpl = typeof fetch === 'function' ? fetch : null;
function setFetchImpl(fn) { _fetchImpl = fn; }

// ── defensive field extraction (see SCHEMA HONESTY above) ────────────────────

const EXTRACTORS = {
  spam_rate: ['userReportedSpamRatio', 'spamRate', 'userReportedSpamRate'],
  spf_rate: ['spfSuccessRatio', 'spfSuccessRate'],
  dkim_rate: ['dkimSuccessRatio', 'dkimSuccessRate'],
  dmarc_rate: ['dmarcSuccessRatio', 'dmarcSuccessRate'],
  delivery_errors: ['deliveryErrors', 'deliveryErrorBreakdown'],
};

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

/** Per-day stat object → normalized row fields. */
function normalizeStat(item) {
  const spam = pick(item, EXTRACTORS.spam_rate);
  const spf = pick(item, EXTRACTORS.spf_rate);
  const dkim = pick(item, EXTRACTORS.dkim_rate);
  const dmarc = pick(item, EXTRACTORS.dmarc_rate);
  // auth_pass_rate = the WEAKEST of the available auth ratios (the failing
  // mechanism is the one that matters; averaging would hide it).
  const auths = [spf, dkim, dmarc].filter((x) => x !== null).map(Number);
  return {
    spam_rate: spam !== null ? Number(spam) : null,
    auth_pass_rate: auths.length ? Math.min(...auths) : null,
    delivery_errors: pick(item, EXTRACTORS.delivery_errors),
  };
}

/** Extract the stat date as YYYY-MM-DD from {date:{year,month,day}} or a
 *  trailing-YYYYMMDD resource name. Null when neither is present. */
function statDate(item) {
  const d = item?.date;
  if (d && d.year && d.month && d.day) {
    return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  }
  const m = /(\d{4})(\d{2})(\d{2})\s*$/.exec(item?.name || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ── OAuth ────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const clientId = process.env.POSTMASTER_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.POSTMASTER_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.POSTMASTER_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Postmaster OAuth not configured (need POSTMASTER_OAUTH_REFRESH_TOKEN + client id/secret)');
  }
  const res = await _fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Postmaster token refresh failed: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

// ── API calls ────────────────────────────────────────────────────────────────

function ymdObj(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { year: y, month: m, day: d };
}

async function queryDomainStats(token, domain, startDate, endDate) {
  const res = await _fetchImpl(
    `${API_BASE}/domains/${encodeURIComponent(domain)}/domainStats:query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: ymdObj(startDate), endDate: ymdObj(endDate) }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 || res.status === 404) {
    throw new Error(`domain '${domain}' not accessible (verify it at postmaster.google.com and that the OAuth account owns it) — HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`domainStats:query ${domain} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  // Tolerate either { domainStats: [...] } or { stats: [...] } shapes.
  return data.domainStats || data.stats || data.trafficStats || [];
}

async function getComplianceStatus(token, domain) {
  try {
    const res = await _fetchImpl(
      `${API_BASE}/domains/${encodeURIComponent(domain)}/complianceStatus`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null; // compliance is supplementary — never fail the pull on it
  }
}

/** Summarize compliance into a short status string for the column; raw goes
 *  into the jsonb regardless. */
function complianceSummary(c) {
  if (!c) return null;
  // Look for any obviously boolean/enum verdict fields, else 'see_raw'.
  const verdict = pick(c, ['complianceStatus', 'status', 'overallStatus', 'state']);
  if (typeof verdict === 'string') return verdict.slice(0, 30);
  return 'see_raw';
}

// ── persistence ──────────────────────────────────────────────────────────────

async function upsertRow(orgId, domain, metricDate, fields, raw) {
  await db.query(
    `INSERT INTO domain_health_daily
       (org_id, domain, metric_date, source, spam_rate, compliance_status,
        auth_pass_rate, delivery_errors, raw)
     VALUES ($1, $2, $3, 'postmaster_v2', $4, $5, $6, $7, $8)
     ON CONFLICT (org_id, domain, metric_date, source)
     DO UPDATE SET spam_rate = EXCLUDED.spam_rate,
                   compliance_status = COALESCE(EXCLUDED.compliance_status, domain_health_daily.compliance_status),
                   auth_pass_rate = EXCLUDED.auth_pass_rate,
                   delivery_errors = EXCLUDED.delivery_errors,
                   raw = EXCLUDED.raw`,
    [
      orgId, domain, metricDate,
      fields.spam_rate, fields.compliance_status || null, fields.auth_pass_rate,
      fields.delivery_errors ? JSON.stringify(fields.delivery_errors) : null,
      JSON.stringify(raw || {}),
    ]
  );
}

// ── entry points ─────────────────────────────────────────────────────────────

async function getConfiguredDomains(orgId) {
  const r = await db.query(
    `SELECT settings -> 'postmaster' -> 'domains' AS d FROM organizations WHERE id = $1`,
    [orgId]
  );
  const d = r.rows[0]?.d;
  return Array.isArray(d) ? d.filter((x) => typeof x === 'string' && x.includes('.')) : [];
}

/**
 * Pull the trailing window for every configured domain of one org.
 * Per-domain failures are isolated. Returns counts for the cron log.
 */
async function runNightly(orgId) {
  const domains = await getConfiguredDomains(orgId);
  if (domains.length === 0) return { domains: 0, rows: 0, errors: 0, skipped: true };

  const token = await getAccessToken(); // throws once if unconfigured — caller logs
  const winRes = await db.query(
    `SELECT (CURRENT_DATE - $1::int)::text AS s, (CURRENT_DATE - 1)::text AS e`,
    [PULL_WINDOW_DAYS]
  );
  const { s: startDate, e: endDate } = winRes.rows[0];

  let rows = 0, errors = 0;
  for (const domain of domains) {
    try {
      const stats = await queryDomainStats(token, domain, startDate, endDate);
      const compliance = await getComplianceStatus(token, domain);
      const complianceStr = complianceSummary(compliance);
      let latestDate = null;

      for (const item of stats) {
        const date = statDate(item);
        if (!date) continue;
        const fields = normalizeStat(item);
        await upsertRow(orgId, domain, date, fields, item);
        rows++;
        if (!latestDate || date > latestDate) latestDate = date;
      }

      // Compliance is point-in-time: attach to the latest pulled day (or
      // today when Google returned no per-day stats yet — low volume).
      if (compliance) {
        const cDate = latestDate || endDate;
        await db.query(
          `INSERT INTO domain_health_daily (org_id, domain, metric_date, source, compliance_status, raw)
           VALUES ($1, $2, $3, 'postmaster_v2', $4, $5)
           ON CONFLICT (org_id, domain, metric_date, source)
           DO UPDATE SET compliance_status = EXCLUDED.compliance_status,
                         raw = domain_health_daily.raw || jsonb_build_object('compliance', $5::jsonb)`,
          [orgId, domain, cDate, complianceStr, JSON.stringify(compliance)]
        );
        rows++;
      }

      console.log(`[PostmasterHealth] org=${orgId} domain=${domain} pulled ${stats.length} day(s), compliance=${complianceStr || 'n/a'}`);
    } catch (err) {
      errors++;
      console.error(`[PostmasterHealth] org=${orgId} domain=${domain} FAILED: ${err.message}`);
    }
  }
  return { domains: domains.length, rows, errors, skipped: false };
}

module.exports = {
  runNightly,
  getConfiguredDomains,
  setFetchImpl,
  // exported for tests
  normalizeStat,
  statDate,
  complianceSummary,
};
