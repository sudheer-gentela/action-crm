// ============================================================================
// services/enrichment/index.js
//
// Provider-agnostic enrichment orchestrator (Sprint-3 refactor).
//
// Public API:
//   enrichCompany(orgId, inputs)   → { ok, data, raw?, provider, ... }
//   enrichPerson (orgId, inputs)   → { ok, data, raw?, provider, ... }
//
// inputs (company): { linkedinCompanyUrl?, domain?, prospectId?, accountId? }
// inputs (person):  { email?, linkedinUrl?, firstName?, lastName?, domain?,
//                     prospectId?, accountId? }
//
// The orchestrator walks a provider chain (configured per-org via
// org_action_config.enrichment) and returns the first ok result. Every
// call — success or failure — writes to enrichment_credit_log. Monthly
// caps are enforced before any provider is hit.
//
// Default chains:
//   company: ['coresignal', 'apollo']   — CoreSignal first (cheaper for
//                                          company data), Apollo fallback
//   person:  ['apollo']                  — CoreSignal multi-source company
//                                          doesn't do people
//
// Per-org overrides live in org_action_config.enrichment:
//   { chain_company: [...], chain_person: [...], monthly_cap: number|null }
// ============================================================================

const CredentialsStore = require('../ai/CredentialsStore');
const coreSignal       = require('./coreSignalProvider');
const apollo           = require('./apolloProvider');
const creditLog        = require('./creditLog');
const enrichmentSettings = require('../enrichmentSettings.service');

// ─────────────────────────────────────────────────────────────────────────────
// Provider adapters. Each adapter normalizes the per-provider interface to
// a uniform signature:
//
//   ({ orgId, apiKey, inputs }) → { ok, data, raw?, credits, reason?, ... }
//
// Adding a third provider = a new entry here + entries in PROVIDER_NAMES.
// ─────────────────────────────────────────────────────────────────────────────
const COMPANY_ADAPTERS = {
  coresignal: async ({ apiKey, inputs }) => coreSignal.enrich({
    linkedinCompanyUrl: inputs.linkedinCompanyUrl,
    domain:             inputs.domain,
    apiKey,
  }),
  apollo: async ({ apiKey, inputs }) => apollo.enrichCompany({
    linkedinCompanyUrl: inputs.linkedinCompanyUrl,
    domain:             inputs.domain,
    apiKey,
  }),
};

const PERSON_ADAPTERS = {
  // CoreSignal multi-source company API doesn't enrich people. We could add
  // a CoreSignal employee endpoint later; for now Apollo is the only person
  // source.
  apollo: async ({ apiKey, inputs }) => apollo.enrichPerson({
    email:       inputs.email,
    linkedinUrl: inputs.linkedinUrl,
    firstName:   inputs.firstName,
    lastName:    inputs.lastName,
    domain:      inputs.domain,
    apiKey,
  }),
};

// Default chains. Overrides in org_action_config.enrichment.
const DEFAULT_CHAIN_COMPANY = ['coresignal', 'apollo'];
const DEFAULT_CHAIN_PERSON  = ['apollo'];

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a provider's API key for an org.
//
//   1. Try org_credentials (purpose='enrichment') — preferred path.
//   2. Fall back to env var for CoreSignal only — transitional, removed in
//      a future cleanup. Apollo has no env-var fallback.
//
// Returns the plaintext key or null. The key never leaves this scope; the
// adapter that needs it is invoked directly below.
// ─────────────────────────────────────────────────────────────────────────────
async function _resolveKey(orgId, provider) {
  const cred = await CredentialsStore.getActive(orgId, null, provider, 'enrichment');
  if (cred && cred.apiKey) return cred.apiKey;

  if (provider === 'coresignal' && process.env.CORESIGNAL_API_KEY) {
    console.warn(`[enrichment] org ${orgId} using CORESIGNAL_API_KEY env var fallback — migrate to org_credentials`);
    return process.env.CORESIGNAL_API_KEY;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Translate an adapter response into a credit-log status string.
//   ok=true                        → 'ok'
//   reason='not_found'             → 'not_found'
//   reason='ambiguous'             → 'ambiguous'
//   reason='rate_limited'          → 'rate_limited'
//   other failure                  → 'error'
// ─────────────────────────────────────────────────────────────────────────────
function _statusFromResult(result) {
  if (result.ok) return 'ok';
  if (result.reason === 'not_found')    return 'not_found';
  if (result.reason === 'ambiguous')    return 'ambiguous';
  if (result.reason === 'rate_limited') return 'rate_limited';
  return 'error';
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk a provider chain. Returns the first ok result, or the LAST failure
// when all providers exhaust. Each call writes to credit_log.
// ─────────────────────────────────────────────────────────────────────────────
async function _walkChain({ orgId, chain, adapters, inputs, operationLabel }) {
  let lastFailure = null;

  for (const provider of chain) {
    const adapter = adapters[provider];
    if (!adapter) {
      console.warn(`[enrichment] unknown provider '${provider}' in chain — skipping`);
      continue;
    }

    const apiKey = await _resolveKey(orgId, provider);
    if (!apiKey) {
      // Skip silently — orgs that don't have this provider configured just
      // fall through to the next in the chain. We log nothing here because
      // the absence of a key is expected for unconfigured providers; only
      // an actual call attempt that fails warrants a credit-log entry.
      lastFailure = { ok: false, reason: 'no_api_key', provider };
      continue;
    }

    let result;
    try {
      result = await adapter({ apiKey, inputs });
    } catch (err) {
      console.error(`[enrichment] provider ${provider} threw:`, err.message);
      result = { ok: false, reason: 'error', message: err.message, credits: 0 };
    }

    // Write the ledger entry. Even credits=0 paths (no_identifier) write
    // a row so we can see attempt counts.
    //
    // The metadata block intentionally captures all the diagnostic data the
    // adapter returned on failure. Without this, debugging a provider failure
    // requires reproducing the call out-of-band — which is exactly what we
    // had to do for the May 2026 Apollo http_error case. The cost of a few
    // extra JSONB bytes per row is well worth the operability win.
    //
    // upstream_body is truncated to 4 KB to avoid pathological cases where
    // a provider returns a huge HTML error page; the first few KB are always
    // enough to see the error class and message.
    const truncatedBody = (() => {
      if (result.upstream_body == null) return null;
      try {
        const s = typeof result.upstream_body === 'string'
          ? result.upstream_body
          : JSON.stringify(result.upstream_body);
        return s.length > 4096 ? s.slice(0, 4096) + '…[truncated]' : s;
      } catch {
        return String(result.upstream_body).slice(0, 4096);
      }
    })();

    await creditLog.writeLog({
      orgId,
      provider,
      operation:    operationLabel,
      creditsUsed:  result.credits || 0,
      prospectId:   inputs.prospectId || null,
      accountId:    inputs.accountId  || null,
      status:       _statusFromResult(result),
      metadata: {
        identifier_used: result.identifier_used || null,
        reason:          result.reason || null,
        // Diagnostic fields — present on failure rows only, used by SuperAdmin
        // and on-call debugging. Schema is loose by design: providers may
        // surface different shapes, and JSONB tolerates that.
        ...(result.status        != null ? { http_status:   result.status }       : {}),
        ...(truncatedBody                ? { upstream_body: truncatedBody }       : {}),
        ...(result.message               ? { message:       result.message }      : {}),
        ...(result.hit_count     != null ? { hit_count:     result.hit_count }    : {}),
        ...(result.coresignal_id         ? { coresignal_id: result.coresignal_id }: {}),
      },
    });

    if (result.ok) {
      return { ...result, provider };
    }
    lastFailure = { ...result, provider };
    // Continue to next provider in chain.
  }

  return lastFailure || { ok: false, reason: 'no_providers_configured', provider: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichCompany — public entry.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichCompany(orgId, inputs = {}) {
  const settings = await enrichmentSettings.getForOrg(orgId);
  const chain    = Array.isArray(settings.chain_company) && settings.chain_company.length
                 ? settings.chain_company
                 : DEFAULT_CHAIN_COMPANY;

  // Cap check BEFORE any provider call.
  const cap = await creditLog.capCheck(orgId, settings.monthly_cap);
  if (!cap.withinCap) {
    return {
      ok:       false,
      reason:   cap.reason,
      provider: null,
      cap:      cap.cap,
      used:     cap.used,
    };
  }

  const result = await _walkChain({
    orgId, chain, adapters: COMPANY_ADAPTERS, inputs,
    operationLabel: 'enrich_company',
  });

  // After the call, check if we just crossed the 90% threshold and need to
  // notify org admins. Fires at most once per org per month.
  await _maybeFireCapWarning(orgId, settings.monthly_cap);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// enrichPerson — public entry.
// ─────────────────────────────────────────────────────────────────────────────
async function enrichPerson(orgId, inputs = {}) {
  const settings = await enrichmentSettings.getForOrg(orgId);
  const chain    = Array.isArray(settings.chain_person) && settings.chain_person.length
                 ? settings.chain_person
                 : DEFAULT_CHAIN_PERSON;

  const cap = await creditLog.capCheck(orgId, settings.monthly_cap);
  if (!cap.withinCap) {
    return {
      ok:       false,
      reason:   cap.reason,
      provider: null,
      cap:      cap.cap,
      used:     cap.used,
    };
  }

  const result = await _walkChain({
    orgId, chain, adapters: PERSON_ADAPTERS, inputs,
    operationLabel: 'enrich_person',
  });

  await _maybeFireCapWarning(orgId, settings.monthly_cap);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fire a one-time-per-month notification when usage crosses 90% of cap.
// Goes to all org admins. Idempotent per (org, month) — see creditLog.shouldFireCapWarning.
// ─────────────────────────────────────────────────────────────────────────────
async function _maybeFireCapWarning(orgId, monthlyCap) {
  try {
    const should = await creditLog.shouldFireCapWarning(orgId, monthlyCap);
    if (!should) return;

    const db = require('../../config/database');
    const used = await creditLog.monthlyUsage(orgId);
    const currentMonth = new Date().toISOString().slice(0, 7);

    // All active org admins
    const { rows: admins } = await db.query(
      `SELECT user_id FROM org_users
        WHERE org_id = $1 AND role IN ('owner','admin') AND is_active = TRUE`,
      [orgId]
    );

    for (const a of admins) {
      await db.query(
        `INSERT INTO notifications
           (org_id, user_id, type, title, body, entity_type, entity_id, metadata, created_at)
         VALUES ($1, $2, 'enrichment_cap_warning', $3, $4, NULL, NULL, $5::jsonb, NOW())`,
        [
          orgId,
          a.user_id,
          'Enrichment credit usage at 90%',
          `Your org has used ${used} of ${monthlyCap} enrichment credits this month. Calls will be blocked when the cap is reached. Adjust your provider chain or raise the cap in Org Admin → Prospecting → Enrichment.`,
          JSON.stringify({ month: currentMonth, used, cap: monthlyCap }),
        ]
      );
    }
  } catch (err) {
    // Notification failures should never break enrichment.
    console.warn('[enrichment] cap-warning notification failed:', err.message);
  }
}

module.exports = {
  enrichCompany,
  enrichPerson,
  // Re-exports for the legacy import path used by enrichmentService.js
  // before the Sprint-3 refactor. Callers that still want the old single-
  // provider "enrich" shape can use enrichCompany — same result minus
  // provider chaining.
  enrich: enrichCompany,
  DEFAULT_CHAIN_COMPANY,
  DEFAULT_CHAIN_PERSON,
};
