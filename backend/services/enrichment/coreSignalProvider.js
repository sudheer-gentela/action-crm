// ============================================================================
// services/enrichment/coreSignalProvider.js
//
// Thin wrapper around CoreSignal's Multi-source Company Enrichment API.
//
// Single responsibility: take a LinkedIn company URL or a domain, call
// CoreSignal, return either { ok: true, data, raw } or { ok: false, reason }.
// Does NOT touch the database. Does NOT decide what to write where. The
// caller (services/enrichmentService.js) is responsible for mapping the
// result onto the accounts table.
//
// API reference (multi-source enrich endpoint):
//   GET https://api.coresignal.com/cdapi/v2/company_multi_source/enrich
//       ?website={domain}
//       OR
//       ?professional_network_url={linkedin_url}
//   Header: apikey: {CORESIGNAL_API_KEY}
//
// Cost: 2 credits per successful enrichment. Failed lookups (404) cost 0.
// ============================================================================

const CORESIGNAL_BASE_URL = 'https://api.coresignal.com/cdapi/v2/company_multi_source/enrich';
const REQUEST_TIMEOUT_MS  = 10000;

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
// enrich
//
// Public API of this module.
//
// Inputs (at least one of these must be a usable identifier):
//   - linkedinCompanyUrl: string (preferred when available)
//   - domain: string (used as fallback)
//
// Returns:
//   { ok: true, data, raw }      on success — `data` is the normalized shape,
//                                 `raw` is the full CoreSignal response for
//                                 storage in research_meta.coresignal.
//   { ok: false, reason: string,
//     status?: number }          on any failure. Reason values:
//                                 'no_api_key', 'no_identifier',
//                                 'not_found', 'rate_limited',
//                                 'no_credits', 'auth_failed',
//                                 'timeout', 'network_error',
//                                 'invalid_response', 'http_error'
// ─────────────────────────────────────────────────────────────────────────────
async function enrich({ linkedinCompanyUrl, domain }) {
  const apiKey = process.env.CORESIGNAL_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'no_api_key' };
  }

  // Pick the identifier. Prefer the LinkedIn URL because it's a stable
  // canonical reference; fall back to domain otherwise.
  let url;
  if (linkedinCompanyUrl) {
    url = `${CORESIGNAL_BASE_URL}?professional_network_url=${encodeURIComponent(linkedinCompanyUrl)}`;
  } else if (domain) {
    url = `${CORESIGNAL_BASE_URL}?website=${encodeURIComponent(domain)}`;
  } else {
    return { ok: false, reason: 'no_identifier' };
  }

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'apikey': apiKey,
        'accept': 'application/json',
      },
    }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    console.error('[coreSignal] network error:', err.message);
    return { ok: false, reason: 'network_error' };
  }

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, reason: 'auth_failed', status: resp.status };
  }
  if (resp.status === 402) {
    return { ok: false, reason: 'no_credits', status: 402 };
  }
  if (resp.status === 404) {
    return { ok: false, reason: 'not_found', status: 404 };
  }
  if (resp.status === 429) {
    return { ok: false, reason: 'rate_limited', status: 429 };
  }
  if (!resp.ok) {
    // Surface the upstream status and a snippet of the body so the caller
    // can tell the difference between a 400 (malformed input), 5xx (their
    // server problem), and other unexpected codes. We cap the body at
    // 500 chars so a runaway HTML error page doesn't bloat the response.
    let upstreamBody = null;
    try {
      const text = await resp.text();
      upstreamBody = text ? text.slice(0, 500) : null;
    } catch (_) { /* ignore body-read failures */ }
    return {
      ok: false,
      reason: 'http_error',
      status: resp.status,
      upstream_body: upstreamBody,
    };
  }

  let raw;
  try {
    raw = await resp.json();
  } catch (_) {
    return { ok: false, reason: 'invalid_response' };
  }

  // CoreSignal returns either an object or an array depending on the
  // endpoint. The /enrich endpoint returns a single object directly.
  const obj = Array.isArray(raw) ? raw[0] : raw;
  const data = normalize(obj);
  if (!data) {
    return { ok: false, reason: 'invalid_response' };
  }

  return { ok: true, data, raw: obj };
}

module.exports = {
  enrich,
  // Exported for unit tests:
  _normalize: normalize,
  _bucketHeadcount: bucketHeadcount,
  _cleanWebsiteToDomain: cleanWebsiteToDomain,
};
