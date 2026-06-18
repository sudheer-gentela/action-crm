// ============================================================================
// services/entitlements.service.js
//
// The first customer-billing/entitlement layer in GoWarmCRM.
//
// Entitlements are PLATFORM-controlled capability flags ("has this org paid for
// X?"), stored at organizations.settings.entitlements as a thin object:
//
//   settings.entitlements = { ai: bool, calling: bool }
//
// They are distinct from, and sit ABOVE, the org-admin's own switches. The
// model mirrors the two-tier modules system (settings.modules.<name> =
// { allowed, enabled }):
//
//   entitlement   — set by the PLATFORM (super admin / billing). "allowed".
//   org switch     — set by the ORG admin. "enabled".
//                    AI:      organizations.settings.prospecting_config.ai_enabled
//                    Calling: org_twilio_accounts.status === 'active'
//
//   A capability is usable only when BOTH the entitlement AND the org switch
//   are on. This service owns the entitlement (top) axis only.
//
// Storage shape & defaults:
//   - Missing settings.entitlements              → { ai:false, calling:false }
//   - Each key must be the literal boolean true   to grant. Anything else
//     (false / missing / null / "true" string)    → denied for that key.
//   - DEFAULT-OFF is intentional: a brand-new org is gated until the platform
//     grants it (manually for now, via billing later). Existing/dogfood orgs
//     are protected by the one-time grandfather migration
//     (scripts/grandfatherEntitlements.js), NOT by a permissive default.
//
// Fail behaviour:
//   Lookups FAIL OPEN on infra error, consistent with requireModule.middleware
//   and PersonalizationDispatcher.isOrgAiEnabled. A transient DB hiccup must
//   never strip a paying org of AI/calling mid-session. The downside — a
//   non-entitled org briefly keeping access during a DB outage — is negligible
//   revenue-wise. Revisit (fail-closed) once real billing exists and lapses
//   carry money.
//
// Caching mirrors requireModule: 60s TTL, keyed by org, invalidated by the
// super-admin write path.
// ============================================================================

const { pool } = require('../config/database');

const ENTITLEMENT_KEYS = ['ai', 'calling'];

const _cache = new Map(); // String(orgId) -> { ents, ts }
const TTL = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// parseEntitlements — normalise the raw settings.entitlements JSONB value into
// a complete { ai, calling } object. Default-off: only literal boolean true
// grants. Tolerates the value being absent, null, or a non-object.
// ─────────────────────────────────────────────────────────────────────────────
function parseEntitlements(raw) {
  const out = { ai: false, calling: false };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ENTITLEMENT_KEYS) {
      out[key] = raw[key] === true;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// getEntitlements(orgId) → { ai, calling }
//
// Cached. Fails OPEN (returns all-true) on DB error — see header.
// ─────────────────────────────────────────────────────────────────────────────
async function getEntitlements(orgId) {
  const key = String(orgId);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.ents;

  try {
    const r = await pool.query(
      `SELECT settings->'entitlements' AS ents FROM organizations WHERE id = $1`,
      [orgId]
    );
    const ents = parseEntitlements(r.rows[0]?.ents ?? null);
    _cache.set(key, { ents, ts: Date.now() });
    return ents;
  } catch (err) {
    console.warn(
      `entitlements: lookup failed for org ${orgId}; failing OPEN (granting): ${err.message}`
    );
    // Fail open, but do NOT cache the open result — so the next request retries
    // the DB rather than serving 60s of accidental grants off one blip.
    return { ai: true, calling: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// isEntitled(orgId, key) → boolean
// ─────────────────────────────────────────────────────────────────────────────
async function isEntitled(orgId, key) {
  if (!ENTITLEMENT_KEYS.includes(key)) {
    throw new Error(`entitlements: unknown entitlement key '${key}'`);
  }
  const ents = await getEntitlements(orgId);
  return ents[key] === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// invalidate(orgId?) — drop cached entitlements. Called by the super-admin
// write path after a PATCH. No args → clear all.
// ─────────────────────────────────────────────────────────────────────────────
function invalidate(orgId) {
  if (orgId == null) _cache.clear();
  else _cache.delete(String(orgId));
}

// ─────────────────────────────────────────────────────────────────────────────
// requireEntitlement(key) — Express middleware factory for the route layer.
//
// Use AFTER orgContext (needs req.orgId). Returns 402 Payment Required — the
// resource exists, the org just hasn't paid for it — with a stable code the
// frontend can branch on. Fails OPEN on infra error, like the helper.
//
//   router.use(requireEntitlement('calling'));
// ─────────────────────────────────────────────────────────────────────────────
function requireEntitlement(key) {
  if (!ENTITLEMENT_KEYS.includes(key)) {
    throw new Error(`requireEntitlement: unknown entitlement key '${key}'`);
  }
  return async (req, res, next) => {
    try {
      if (await isEntitled(req.orgId, key)) return next();
      return res.status(402).json({
        error: {
          message: key === 'calling'
            ? 'Calling is not included in your plan. Contact your account owner to enable it.'
            : 'This AI feature is not included in your plan. Contact your account owner to enable it.',
          code:        'ENTITLEMENT_REQUIRED',
          entitlement: key,
        },
      });
    } catch (err) {
      console.error('requireEntitlement: gate check failed, failing open:', err.message);
      return next();
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EntitlementError — typed error for SERVICE-layer guards (e.g.
// twilioAccounts.provisionSubaccount), so a service can refuse without an HTTP
// res in scope. Carries statusCode=402 + code so the calling route maps it to
// a clean 402 response.
// ─────────────────────────────────────────────────────────────────────────────
class EntitlementError extends Error {
  constructor(key) {
    super(`Org is not entitled to '${key}'`);
    this.name        = 'EntitlementError';
    this.code        = 'ENTITLEMENT_REQUIRED';
    this.entitlement = key;
    this.statusCode  = 402;
  }
}

module.exports = {
  ENTITLEMENT_KEYS,
  getEntitlements,
  isEntitled,
  invalidate,
  requireEntitlement,
  parseEntitlements,
  EntitlementError,
};
