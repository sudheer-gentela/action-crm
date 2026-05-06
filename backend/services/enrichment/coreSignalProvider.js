// ============================================================================
// services/enrichment/coreSignalProvider.js
//
// Thin wrapper around CoreSignal's Multi-source Company API.
//
// Single responsibility: take a LinkedIn company URL or a domain, call
// CoreSignal, return either { ok: true, data, raw } or { ok: false, reason }.
// Does NOT touch the database. Does NOT decide what to write where. The
// caller (services/enrichmentService.js) is responsible for mapping the
// result onto the accounts table.
//
// Three paths through the API depending on what input we have:
//
//   1. LinkedIn URL with numeric company ID (e.g. /company/10454372):
//      - POST /search/es_dsl  with { term: { source_id: "10454372" } }
//      - Expect 1 hit (CoreSignal internal ID).
//      - GET  /collect/{coresignal_id}
//      - 0 hits  -> not_found
//      - 2+ hits -> ambiguous (terminal; needs human resolution)
//      - 1 hit   -> proceed to collect
//      Total: 1 search + 1 collect = ~3 credits (search costs vary)
//
//   2. LinkedIn URL with slug (e.g. /company/gong-io):
//      - GET /collect/{slug}
//      - 1 collect call. ~2 credits.
//      - Note: ambiguous slugs (e.g. /company/gong matches multiple
//        companies) are NOT detected here; we trust the slug. If wrong
//        company comes back, that's surfaced to the user later by the
//        existing field-fill rules (we never overwrite real values).
//
//   3. Domain (e.g. gong.io):
//      - GET /enrich?website={domain}
//      - 1 call. ~2 credits.
//
// Header for all paths: apikey: {CORESIGNAL_API_KEY}
// ============================================================================

const CORESIGNAL_BASE = 'https://api.coresignal.com/cdapi/v2/company_multi_source';
const REQUEST_TIMEOUT_MS  = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// Plan the call path based on what we have.
//
// Returns one of:
//   { strategy: 'search_then_collect', source_id: '10454372' }
//     -> Use POST /search/es_dsl with term: { source_id }, then collect.
//   { strategy: 'direct_collect',      slug:      'gong-io'  }
//     -> Use GET /collect/{slug}.
//   { strategy: 'direct_enrich',       domain:    'gong.io'  }
//     -> Use GET /enrich?website={domain}.
//   null
//     -> No usable identifier.
//
// LinkedIn URL takes precedence over domain. Within LinkedIn URLs, numeric
// IDs go through search (CoreSignal's /collect endpoint doesn't accept
// numeric IDs as path segments — confirmed empirically) and slugs go direct.
// ─────────────────────────────────────────────────────────────────────────────
function planCall({ linkedinCompanyUrl, domain }) {
  if (linkedinCompanyUrl) {
    const m = String(linkedinCompanyUrl).match(/\/company\/([A-Za-z0-9._-]+)/i);
    if (m) {
      const segment = m[1];
      if (/^\d+$/.test(segment)) {
        return { strategy: 'search_then_collect', source_id: segment };
      }
      // Reject obvious non-companies (e.g. /company/setup/new captured by
      // accident). Real shorthands are at least 2 chars.
      if (segment.length >= 2 && segment !== 'setup' && segment !== 'new' && segment !== 'admin') {
        return { strategy: 'direct_collect', slug: segment.toLowerCase() };
      }
    }
    // URL didn't match — fall through to domain.
  }

  if (domain) {
    return { strategy: 'direct_enrich', domain };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket employees_count into the standard size ranges. We prefer
// CoreSignal's pre-bucketed size_range when present, but if it's missing
// or oddly-shaped, fall back to bucketing the raw count ourselves.
// ─────────────────────────────────────────────────────────────────────────────
function bucketHeadcount(count) {
  if (count == null || isNaN(count)) return null;
  const n = Number(count);
  if (n <= 0)     return null;
  if (n <= 10)    return '1-10 employees';
  if (n <= 50)    return '11-50 employees';
  if (n <= 200)   return '51-200 employees';
  if (n <= 500)   return '201-500 employees';
  if (n <= 1000)  return '501-1,000 employees';
  if (n <= 5000)  return '1,001-5,000 employees';
  if (n <= 10000) return '5,001-10,000 employees';
  return '10,001+ employees';
}

// ─────────────────────────────────────────────────────────────────────────────
// Strip protocol/path/etc. from CoreSignal's `websites_main` to a bare
// lowercased domain. The accounts.domain column expects "vitaledge.com",
// not "https://www.vitaledge.com/".
// ─────────────────────────────────────────────────────────────────────────────
function cleanWebsiteToDomain(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.split(':')[0];
  s = s.replace(/^www\./, '');
  s = s.replace(/\.$/, '');
  if (!s || !s.includes('.')) return null;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pick the best HQ location string CoreSignal returned, in order of
// usefulness. They sometimes give us "Austin, TX, United States" in
// hq_location; sometimes only the country.
// ─────────────────────────────────────────────────────────────────────────────
function pickLocation(raw) {
  if (raw.hq_location) return raw.hq_location;
  const parts = [raw.hq_city, raw.hq_state, raw.hq_country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// pickFirstString: CoreSignal returns some fields as either a scalar OR an
// array of strings depending on source. Some samples have `linkedin_url`
// as a string; others as an array. We only need one value.
// ─────────────────────────────────────────────────────────────────────────────
function pickFirstString(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.find(x => typeof x === 'string' && x.length > 0) || null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Map a raw CoreSignal response object into a normalized shape that the
// enrichment service can write straight onto the accounts table.
//
// Returns null if the response doesn't even have a name (the bare minimum
// to consider this a successful enrichment).
// ─────────────────────────────────────────────────────────────────────────────
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = raw.company_legal_name || raw.company_name || raw.name || null;
  if (!name) return null;

  // Domain: prefer websites_main, fall back to company_domain (Jobs API
  // sample shape used that key).
  const domain = cleanWebsiteToDomain(raw.websites_main || raw.company_domain);

  // Size: CoreSignal's pre-bucketed size_range looks like "501-1000 employees".
  // If absent, bucket the raw employees_count ourselves.
  const size = raw.size_range || raw.size || bucketHeadcount(raw.employees_count);

  // Description: prefer the AI-enriched version; fall back to the raw.
  const description = raw.description_enriched || raw.description || null;

  // Tech stack: list the technology names. Cap at 50 to keep payloads sane.
  let techStack = [];
  if (Array.isArray(raw.technologies_used)) {
    techStack = raw.technologies_used
      .map(t => (typeof t === 'string' ? t : t?.technology))
      .filter(Boolean)
      .slice(0, 50);
  }

  // Funding: most recent round. CoreSignal returns these as top-level keys.
  const lastRound = (raw.last_round_type || raw.last_round_money_raised) ? {
    type:   raw.last_round_type || null,
    amount: raw.last_round_money_raised || null,
  } : null;

  return {
    name,
    domain,                   // null when CoreSignal had no website for the company
    industry:    raw.industry || null,
    size,                      // already in "501-1000 employees" shape
    location:    pickLocation(raw),
    description,
    linkedin_url: pickFirstString(raw.linkedin_url) || pickFirstString(raw.professional_network_url),
    founded_year: raw.founded_year || null,
    employees_count: raw.employees_count || null,
    last_round: lastRound,
    tech_stack: techStack,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchWithTimeout
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// performHttpCall
//
// Shared HTTP transport for all three call paths. Maps CoreSignal status
// codes to our internal reason values. On success returns { ok: true, json }.
// On any failure returns { ok: false, reason, status?, upstream_body? }.
// ─────────────────────────────────────────────────────────────────────────────
async function performHttpCall(apiKey, url, opts = {}) {
  const { method = 'GET', body } = opts;
  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method,
      headers: {
        'apikey':       apiKey,
        'accept':       'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    console.error('[coreSignal] network error:', err.message);
    return { ok: false, reason: 'network_error' };
  }

  if (resp.status === 401 || resp.status === 403) return { ok: false, reason: 'auth_failed',  status: resp.status };
  if (resp.status === 402)                        return { ok: false, reason: 'no_credits',   status: 402 };
  if (resp.status === 404)                        return { ok: false, reason: 'not_found',    status: 404 };
  if (resp.status === 429)                        return { ok: false, reason: 'rate_limited', status: 429 };
  if (!resp.ok) {
    let upstreamBody = null;
    try {
      const text = await resp.text();
      upstreamBody = text ? text.slice(0, 500) : null;
    } catch (_) { /* ignore */ }
    return { ok: false, reason: 'http_error', status: resp.status, upstream_body: upstreamBody };
  }

  let json;
  try {
    json = await resp.json();
  } catch (_) {
    return { ok: false, reason: 'invalid_response' };
  }
  return { ok: true, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// searchBySourceId
//
// Look up a CoreSignal company record by LinkedIn numeric ID. Returns:
//   { ok: true,  coresignal_id }    on a single hit
//   { ok: false, reason: 'not_found' }   on zero hits
//   { ok: false, reason: 'ambiguous',
//     hit_count }                          on 2+ hits — terminal, needs human
//   { ok: false, reason: <other>,
//     ... }                                on transport / API errors
// ─────────────────────────────────────────────────────────────────────────────
async function searchBySourceId(apiKey, sourceId) {
  const url = `${CORESIGNAL_BASE}/search/es_dsl`;
  const body = {
    query: { term: { source_id: String(sourceId) } },
  };
  const result = await performHttpCall(apiKey, url, { method: 'POST', body });
  if (!result.ok) return result;

  // Search returns an array of CoreSignal numeric IDs.
  const hits = Array.isArray(result.json) ? result.json : [];
  if (hits.length === 0) return { ok: false, reason: 'not_found' };
  if (hits.length > 1) {
    return { ok: false, reason: 'ambiguous', hit_count: hits.length };
  }
  return { ok: true, coresignal_id: hits[0] };
}

// ─────────────────────────────────────────────────────────────────────────────
// collectByCoreSignalId
// ─────────────────────────────────────────────────────────────────────────────
async function collectByCoreSignalId(apiKey, coresignalId) {
  const url = `${CORESIGNAL_BASE}/collect/${encodeURIComponent(coresignalId)}`;
  return performHttpCall(apiKey, url);
}

// ─────────────────────────────────────────────────────────────────────────────
// collectBySlug — direct collect by LinkedIn shorthand
// ─────────────────────────────────────────────────────────────────────────────
async function collectBySlug(apiKey, slug) {
  const url = `${CORESIGNAL_BASE}/collect/${encodeURIComponent(slug)}`;
  return performHttpCall(apiKey, url);
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichByDomain — direct /enrich?website=...
// ─────────────────────────────────────────────────────────────────────────────
async function enrichByDomain(apiKey, domain) {
  const url = `${CORESIGNAL_BASE}/enrich?website=${encodeURIComponent(domain)}`;
  return performHttpCall(apiKey, url);
}

// ─────────────────────────────────────────────────────────────────────────────
// enrich — public API
//
// Inputs (at least one of these must be a usable identifier):
//   - linkedinCompanyUrl: string  (preferred — see strategy table at top)
//   - domain:             string  (used when no LinkedIn URL)
//
// Returns:
//   { ok: true,  data, raw, identifier_used }   on success
//   { ok: false, reason, ... }                  on failure
//
// Failure reasons (most common first):
//   'no_api_key'        — env var not set
//   'no_identifier'     — caller provided neither URL nor domain
//   'not_found'         — CoreSignal has no record for this identifier
//   'ambiguous'         — search returned multiple candidates; needs human
//                         resolution (catchall queue + needs_domain_review)
//   'no_credits'        — out of CoreSignal credits
//   'auth_failed'       — API key rejected
//   'rate_limited'      — 429 from CoreSignal
//   'timeout'           — request didn't return in REQUEST_TIMEOUT_MS
//   'network_error'     — TCP/DNS/etc. failure
//   'http_error'        — unexpected non-success status (also includes
//                         upstream_body)
//   'invalid_response'  — body wasn't parseable JSON or normalize failed
// ─────────────────────────────────────────────────────────────────────────────
async function enrich({ linkedinCompanyUrl, domain }) {
  const apiKey = process.env.CORESIGNAL_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no_api_key' };

  const plan = planCall({ linkedinCompanyUrl, domain });
  if (!plan) return { ok: false, reason: 'no_identifier' };

  // ── Path 1: numeric LinkedIn ID — search then collect ─────────────────
  if (plan.strategy === 'search_then_collect') {
    const search = await searchBySourceId(apiKey, plan.source_id);
    if (!search.ok) {
      return { ...search, identifier_used: 'linkedin_id' };
    }
    const coll = await collectByCoreSignalId(apiKey, search.coresignal_id);
    if (!coll.ok) {
      return { ...coll, identifier_used: 'linkedin_id' };
    }
    return finalizeRaw(coll.json, 'linkedin_id', { coresignal_id: search.coresignal_id });
  }

  // ── Path 2: slug — direct /collect ────────────────────────────────────
  if (plan.strategy === 'direct_collect') {
    const coll = await collectBySlug(apiKey, plan.slug);
    if (!coll.ok) return { ...coll, identifier_used: 'linkedin_shorthand' };
    return finalizeRaw(coll.json, 'linkedin_shorthand');
  }

  // ── Path 3: domain — direct /enrich ───────────────────────────────────
  if (plan.strategy === 'direct_enrich') {
    const coll = await enrichByDomain(apiKey, plan.domain);
    if (!coll.ok) return { ...coll, identifier_used: 'domain' };
    return finalizeRaw(coll.json, 'domain');
  }

  // Defensive — planCall should never produce an unknown strategy.
  return { ok: false, reason: 'invalid_response' };
}

// ─────────────────────────────────────────────────────────────────────────────
// finalizeRaw — common tail for all three paths.
//
// CoreSignal sometimes returns an object directly (collect endpoints) and
// sometimes an array (search endpoints, but those are intercepted earlier).
// We pick the first object and normalize it.
// ─────────────────────────────────────────────────────────────────────────────
function finalizeRaw(raw, identifierUsed, extra = {}) {
  const obj = Array.isArray(raw) ? raw[0] : raw;
  const data = normalize(obj);
  if (!data) {
    return { ok: false, reason: 'invalid_response', identifier_used: identifierUsed, ...extra };
  }
  return { ok: true, data, raw: obj, identifier_used: identifierUsed, ...extra };
}

module.exports = {
  enrich,
  // Exported for unit tests:
  _normalize: normalize,
  _bucketHeadcount: bucketHeadcount,
  _cleanWebsiteToDomain: cleanWebsiteToDomain,
  _planCall: planCall,
};
