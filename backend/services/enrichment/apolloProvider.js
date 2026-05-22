// ============================================================================
// services/enrichment/apolloProvider.js
//
// Apollo.io provider. Two capabilities:
//
//   enrichCompany({ domain, linkedinCompanyUrl, apiKey })
//     - GET /api/v1/organizations/enrich?domain=...  if domain available
//     - GET /api/v1/organizations/enrich?...         (Apollo also accepts
//       a LinkedIn URL via the `linkedin_url` parameter for orgs)
//     - Returns normalized firmographic data shaped the same as CoreSignal's
//       output so callers can treat both providers interchangeably.
//
//   enrichPerson({ email, linkedinUrl, firstName, lastName, domain, apiKey })
//     - POST /api/v1/people/match
//     - Returns person + their organization. Apollo is the better source
//       for person-level data; CoreSignal multi-source company API doesn't
//       do people.
//
// Apollo credit costs vary by endpoint and customer plan. The values below
// are best-effort estimates from Apollo's public docs. The credit_log table
// records what we billed; reconciliation against Apollo's own dashboard is
// done out-of-band.
//
// Header for all paths: 'X-Api-Key: {apiKey}'  (Apollo's auth scheme)
// Base URL: https://api.apollo.io
// ============================================================================

const APOLLO_BASE = 'https://api.apollo.io';
const REQUEST_TIMEOUT_MS = 10000;

// Best-effort credit cost per operation.
const APOLLO_CREDIT_COSTS = {
  organization_enrich: 1,
  person_match:        1,
  person_search:       1,
};

// ─────────────────────────────────────────────────────────────────────────────
// Common HTTP helper — adds the API key header, applies the timeout, and
// translates network-layer failures into the shared { ok, reason } shape
// used everywhere in this module.
// ─────────────────────────────────────────────────────────────────────────────
async function _call({ apiKey, method, path, query, body }) {
  const url = new URL(APOLLO_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        'X-Api-Key':    apiKey,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    // Apollo's documented failure semantics:
    //   401 — bad/expired API key
    //   402 — out of credits (paid plans)
    //   422 — validation error
    //   429 — rate limited
    if (resp.status === 401) return { ok: false, reason: 'auth_failed',  status: 401 };
    if (resp.status === 402) return { ok: false, reason: 'no_credits',   status: 402 };
    if (resp.status === 429) return { ok: false, reason: 'rate_limited', status: 429 };

    let json = null;
    try { json = await resp.json(); } catch { /* non-JSON body */ }

    if (!resp.ok) {
      return {
        ok: false,
        reason: 'http_error',
        status: resp.status,
        upstream_body: json,
      };
    }

    return { ok: true, json };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network_error', message: err.message };
  } finally {
    clearTimeout(to);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalize Apollo's organization payload into the shape callers expect.
// We try to match coreSignalProvider's data shape as closely as is sensible
// so the orchestrator can mix them without per-provider conditionals.
//
// Output shape (best-effort fill — missing fields are null):
//   {
//     name, domain, linkedin_url, industry,
//     size_range, headcount,
//     location, hq_country, hq_state, hq_city,
//     description, founded_year,
//     technologies (array, may be empty),
//   }
// ─────────────────────────────────────────────────────────────────────────────
function normalizeCompany(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const org = raw.organization || raw;  // /enrich responses wrap in { organization }
  if (!org || typeof org !== 'object') return null;

  // Apollo's size buckets are usually free text like "11-50 employees".
  // Pass through if present; else bucket from estimated_num_employees.
  let sizeRange = org.size_range || org.organization_size || null;
  if (!sizeRange && org.estimated_num_employees) {
    sizeRange = bucketHeadcount(org.estimated_num_employees);
  }

  return {
    name:           org.name || null,
    domain:         (org.website_url || org.primary_domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || null,
    linkedin_url:   org.linkedin_url || null,
    industry:       org.industry || null,
    size_range:     sizeRange,
    headcount:      org.estimated_num_employees ?? null,
    location:       org.raw_address || (org.city && org.country ? `${org.city}, ${org.country}` : null),
    hq_country:     org.country || null,
    hq_state:       org.state   || null,
    hq_city:        org.city    || null,
    description:    org.short_description || null,
    founded_year:   org.founded_year || null,
    technologies:   Array.isArray(org.current_technologies) ? org.current_technologies.map(t => t.name).filter(Boolean) : [],
  };
}

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
// Normalize Apollo's person payload into a shape callers expect.
// Designed to map cleanly onto linkedin_profiles when written.
//
// Output shape:
//   {
//     full_name, first_name, last_name,
//     email, phone,
//     title, headline,
//     linkedin_url, twitter_url,
//     location,
//     experience:  [{ company, title, start, end, description }],
//     education:   [{ school, degree, field, start, end }],
//     organization: { ...normalized company shape... } | null,
//   }
// ─────────────────────────────────────────────────────────────────────────────
function normalizePerson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw.person || raw;
  if (!p || typeof p !== 'object') return null;

  const experience = Array.isArray(p.employment_history) ? p.employment_history.map(e => ({
    company:     e.organization_name || null,
    title:       e.title             || null,
    start:       e.start_date        || null,
    end:         e.end_date          || null,
    description: e.description       || null,
  })) : [];

  return {
    full_name:    p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
    first_name:   p.first_name || null,
    last_name:    p.last_name  || null,
    email:        p.email      || null,
    phone:        p.sanitized_phone || p.phone_number || null,
    title:        p.title      || null,
    headline:     p.headline   || null,
    linkedin_url: p.linkedin_url || null,
    twitter_url:  p.twitter_url  || null,
    location:     p.city && p.country ? `${p.city}, ${p.country}` : (p.city || p.country || null),
    experience,
    education:    Array.isArray(p.education) ? p.education.map(e => ({
      school: e.school || null,
      degree: e.degree || null,
      field:  e.field_of_study || null,
      start:  e.start_date || null,
      end:    e.end_date   || null,
    })) : [],
    organization: p.organization ? normalizeCompany({ organization: p.organization }) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichCompany — Apollo's organization enrich endpoint.
// Returns the same shape as coreSignalProvider.enrich():
//   { ok: true, data, raw, identifier_used, credits }
//   { ok: false, reason, credits, ... }
// ─────────────────────────────────────────────────────────────────────────────
async function enrichCompany({ domain, linkedinCompanyUrl, apiKey }) {
  if (!apiKey) return { ok: false, reason: 'no_api_key', credits: 0 };
  if (!domain && !linkedinCompanyUrl) {
    return { ok: false, reason: 'no_identifier', credits: 0 };
  }

  const query = {};
  let identifierUsed;
  if (domain) {
    query.domain = domain;
    identifierUsed = 'domain';
  } else {
    query.linkedin_url = linkedinCompanyUrl;
    identifierUsed = 'linkedin_url';
  }

  const credits = APOLLO_CREDIT_COSTS.organization_enrich;
  const resp = await _call({
    apiKey,
    method: 'GET',
    path:   '/api/v1/organizations/enrich',
    query,
  });

  if (!resp.ok) return { ...resp, identifier_used: identifierUsed, credits };

  const data = normalizeCompany(resp.json);
  if (!data) {
    return { ok: false, reason: 'invalid_response', identifier_used: identifierUsed, credits };
  }
  return { ok: true, data, raw: resp.json, identifier_used: identifierUsed, credits };
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichPerson — Apollo's /people/match. Best when called with email; can
// also work with linkedinUrl, or name + domain combo as a fuzzier match.
//
// Returns:
//   { ok: true, data, raw, identifier_used, credits }
//   { ok: false, reason, credits, ... }
// ─────────────────────────────────────────────────────────────────────────────
async function enrichPerson({ email, linkedinUrl, firstName, lastName, domain, apiKey }) {
  if (!apiKey) return { ok: false, reason: 'no_api_key', credits: 0 };

  // Pick the strongest available identifier. /people/match accepts a flexible
  // body — Apollo scores the candidates and returns the best.
  const body = {};
  let identifierUsed;
  if (email) {
    body.email = email;
    identifierUsed = 'email';
  } else if (linkedinUrl) {
    body.linkedin_url = linkedinUrl;
    identifierUsed = 'linkedin_url';
  } else if (firstName && lastName && domain) {
    body.first_name        = firstName;
    body.last_name         = lastName;
    body.organization_name = domain;  // Apollo accepts domain here
    identifierUsed = 'name_domain';
  } else {
    return { ok: false, reason: 'no_identifier', credits: 0 };
  }

  // reveal_personal_emails / reveal_phone_number: opt-in, costs more credits.
  // Default off — caller can pass these explicitly if they want them.
  body.reveal_personal_emails = false;
  body.reveal_phone_number    = false;

  const credits = APOLLO_CREDIT_COSTS.person_match;
  const resp = await _call({
    apiKey,
    method: 'POST',
    path:   '/api/v1/people/match',
    body,
  });

  if (!resp.ok) return { ...resp, identifier_used: identifierUsed, credits };

  const data = normalizePerson(resp.json);
  if (!data) {
    return { ok: false, reason: 'invalid_response', identifier_used: identifierUsed, credits };
  }
  return { ok: true, data, raw: resp.json, identifier_used: identifierUsed, credits };
}

module.exports = {
  enrichCompany,
  enrichPerson,
  // Exported for unit tests:
  _normalizeCompany: normalizeCompany,
  _normalizePerson:  normalizePerson,
  _bucketHeadcount:  bucketHeadcount,
};
