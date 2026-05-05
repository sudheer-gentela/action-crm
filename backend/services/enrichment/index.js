// ============================================================================
// services/enrichment/index.js
//
// Provider-agnostic firmographic enrichment.
//
// Today: CoreSignal multi-source company API.
// Tomorrow: when we want to switch (or A/B), only this file changes.
//
// All callers should import { enrich } from this module — never from
// coreSignalProvider directly. The route layer should not know which
// vendor we're using.
// ============================================================================

const coreSignal = require('./coreSignalProvider');

const PROVIDER = (process.env.ENRICHMENT_PROVIDER || 'coresignal').toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// enrich
//
// Inputs:
//   { linkedinCompanyUrl?, domain? } — at least one must be present.
//
// Returns the provider's response verbatim:
//   { ok: true, data, raw, provider }    on success
//   { ok: false, reason, provider }      on failure
// ─────────────────────────────────────────────────────────────────────────────
async function enrich(inputs) {
  let result;
  switch (PROVIDER) {
    case 'coresignal':
      result = await coreSignal.enrich(inputs);
      break;
    default:
      console.error(`[enrichment] Unknown provider: ${PROVIDER}`);
      return { ok: false, reason: 'unknown_provider', provider: PROVIDER };
  }
  return { ...result, provider: PROVIDER };
}

module.exports = { enrich };
