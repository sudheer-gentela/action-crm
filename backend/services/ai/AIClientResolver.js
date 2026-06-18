/**
 * services/ai/AIClientResolver.js
 *
 * Single entry point for getting an AI client + model anywhere in the app.
 *
 * Resolution (specificity-first, then user-over-org at equal specificity):
 *   PROVIDER & MODEL — both come from a single "slot" value, which may be
 *   provider-qualified ('anthropic/claude-sonnet-4-6') or legacy-unqualified
 *   ('claude-sonnet-4-6', interpreted under that layer's ai_provider):
 *     1. user_preferences.ai_settings.models_by_call_type[callType]
 *     2. org_action_config.ai_settings.models_by_call_type[callType]
 *     3. user_preferences.ai_settings.default_model
 *     4. org_action_config.ai_settings.default_model
 *     5. SYSTEM_DEFAULT
 *   An invalid/unknown slot at any layer logs a warning and FALLS THROUGH
 *   to the next layer — it never silently substitutes a provider flagship.
 *   The returned `source` names the winning layer.
 *
 *   API KEY:
 *     1. ai_credentials (user-level for this provider)
 *     2. ai_credentials (org-level for this provider)
 *     3. process.env[PROVIDERS[provider].envKey]   (platform fallback)
 *
 * Org admin can lock either dimension:
 *   - allow_user_override=false → user slots ignored
 *   - allow_user_byok=false     → user API key ignored
 *
 * Usage from any service:
 *
 *     const resolver = require('./services/ai/AIClientResolver');
 *     const { adapter, model, provider, keySource, source } =
 *       await resolver.resolve(orgId, userId, 'action_generation');
 *     const { text, usage } = await adapter.complete({ model, prompt });
 *     TokenTrackingService.log({ orgId, userId, callType: 'action_generation',
 *                                model, usage, keySource, provider });
 */

const db = require('../../config/database');
const Entitlements = require('../entitlements.service');
const CredentialsStore = require('./CredentialsStore');
const {
  PROVIDERS, SYSTEM_DEFAULT, getProvider, isValidProvider, isValidModel,
  parseModelSlot,
} = require('../../config/aiProviders');

const AnthropicAdapter = require('./adapters/AnthropicAdapter');
const OpenAIAdapter    = require('./adapters/OpenAIAdapter');
// Lazy-loaded so we don't require the Google SDK unless someone uses Gemini
let GeminiAdapter      = null;

// ── Adapter cache — keyed by (provider, apiKeyFingerprint, endpoint) ─────
// Avoids reinstantiating SDK clients on every call.
const _adapterCache = new Map();
function _adapterKey(provider, apiKey, endpoint) {
  const fp = apiKey ? apiKey.slice(-8) : 'none';
  return `${provider}|${fp}|${endpoint || ''}`;
}

function _buildAdapter(provider, apiKey, endpoint) {
  const def = getProvider(provider);
  if (!def) throw new Error(`Unknown AI provider: ${provider}`);

  switch (def.adapter) {
    case 'anthropic':
      return new AnthropicAdapter({ apiKey, endpoint });
    case 'openai':
    case 'openai-compatible':
      return new OpenAIAdapter({ apiKey, endpoint: endpoint || def.endpoint });
    case 'gemini':
      if (!GeminiAdapter) GeminiAdapter = require('./adapters/GeminiAdapter');
      return new GeminiAdapter({ apiKey, endpoint });
    default:
      throw new Error(`No adapter implementation for: ${def.adapter}`);
  }
}

// ── Known-model check (static registry + live-discovered models) ─────────
// The static registry in aiProviders.js lags real provider catalogs;
// ModelDiscoveryService keeps a merged list. A model configured from the
// merged dropdown must also pass resolve-time validation, so we consult the
// merged list here too — memoized for 60s so resolution doesn't add a DB
// read to every AI call. On any discovery error we degrade to the static
// registry only (never throw out of a validity check).
let _knownModelsMemo = { at: 0, byProvider: null };
const KNOWN_MODELS_TTL_MS = 60 * 1000;

async function _getMergedModelIds() {
  const now = Date.now();
  if (_knownModelsMemo.byProvider && (now - _knownModelsMemo.at) < KNOWN_MODELS_TTL_MS) {
    return _knownModelsMemo.byProvider;
  }
  try {
    // Lazy require — avoids loading discovery (and its adapters) for
    // processes that never resolve an AI client.
    const ModelDiscoveryService = require('./ModelDiscoveryService');
    const merged = await ModelDiscoveryService.getAllMergedModels();
    const byProvider = {};
    for (const [pid, models] of Object.entries(merged || {})) {
      byProvider[pid] = new Set((models || []).map(m => m.id));
    }
    _knownModelsMemo = { at: now, byProvider };
    return byProvider;
  } catch (err) {
    console.warn('[ai-resolver] model discovery merge failed; static registry only:', err.message);
    return null;
  }
}

/**
 * Is (provider, model) usable? True when the provider allows free-form ids,
 * when the static registry lists it, or when live discovery knows it.
 */
async function isKnownModel(providerId, modelId) {
  const def = getProvider(providerId);
  if (!def) return false;
  if (def.allowFreeFormModel) return typeof modelId === 'string' && modelId.length > 0;
  if (isValidModel(providerId, modelId)) return true;
  const discovered = await _getMergedModelIds();
  return !!(discovered && discovered[providerId] && discovered[providerId].has(modelId));
}

/**
 * Pure precedence chain — exported for unit tests.
 *
 * Builds the ordered candidate list (specificity-first, user-over-org at
 * equal specificity) from raw org/user ai_settings. Each candidate carries
 * the legacy provider context used to interpret unqualified slots:
 * the layer's own ai_provider, falling back org → system.
 *
 * Returns [{ slot, legacyProvider, source }] — resolution walks this list
 * and takes the first candidate that parses to a known provider+model.
 */
function buildSlotCandidates({ orgAI = {}, userAI = {}, callType, allowUserOverride = true }) {
  const orgLegacy = (orgAI.ai_provider && isValidProvider(orgAI.ai_provider))
    ? orgAI.ai_provider : SYSTEM_DEFAULT.provider;
  const userLegacy = (allowUserOverride && userAI.ai_provider && isValidProvider(userAI.ai_provider))
    ? userAI.ai_provider : orgLegacy;

  const orgPerCall  = orgAI.models_by_call_type  || {};
  const userPerCall = userAI.models_by_call_type || {};

  const candidates = [];
  if (allowUserOverride && userPerCall[callType]) {
    candidates.push({ slot: userPerCall[callType], legacyProvider: userLegacy, source: 'user_call_type' });
  }
  if (orgPerCall[callType]) {
    candidates.push({ slot: orgPerCall[callType], legacyProvider: orgLegacy, source: 'org_call_type' });
  }
  if (allowUserOverride && userAI.default_model) {
    candidates.push({ slot: userAI.default_model, legacyProvider: userLegacy, source: 'user_default' });
  }
  if (orgAI.default_model) {
    candidates.push({ slot: orgAI.default_model, legacyProvider: orgLegacy, source: 'org_default' });
  }
  return candidates;
}

class AIClientResolver {

  /**
   * Main entry point.
   * Returns { adapter, model, provider, keySource, credentialId }.
   *
   * keySource ∈ {'user','org','platform','none'} — for cost attribution.
   * Throws if no usable key can be found (platform env var also missing).
   */
  static async resolve(orgId, userId, callType = 'default') {
    // ── AI entitlement gate (UNIVERSAL) ──────────────────────────────────
    // Every model call in the system funnels through resolve() before a client
    // is built — skills (via runSkill) AND every background enhancer
    // (Actions/CLM/Strap/Prospecting, transcript-analysis, playbook action
    // generation, action-completion detection). So this single guard makes AI
    // a paid capability everywhere, not just on the skill paths.
    //
    // orgId == null  → SYSTEM/platform call (e.g. aiProcessor email_analysis
    //                  resolve(null,null,...)). Not billable to any one org →
    //                  exempt. Only org-scoped calls are gated.
    //
    // This throws on a non-entitled org. Skill routes map statusCode 402 to a
    // clean response; the background enhancers already wrap resolve() in
    // try/catch and degrade gracefully (rules-based output, no AI), so an
    // un-entitled org never crashes a nightly batch — it just gets no AI.
    //
    // NOTE: _resolveProviderAndModel / explainResolution / validateKey are NOT
    // gated, so admin "what would run" preview + key-test screens keep working
    // for un-entitled orgs.
    if (orgId != null && !(await Entitlements.isEntitled(orgId, 'ai'))) {
      const e = new Error("AI generation is not included in this organization's plan.");
      e.statusCode  = 402;
      e.code        = 'ENTITLEMENT_REQUIRED';
      e.entitlement = 'ai';
      throw e;
    }

    const { provider, model, allowUserBYOK, source } =
      await this._resolveProviderAndModel(orgId, userId, callType);

    const def = getProvider(provider);
    if (!def) throw new Error(`Unknown AI provider: ${provider}`);

    // ── API key resolution ────────────────────────────────────────────
    let apiKey      = null;
    let endpointUrl = null;
    let keySource   = 'none';
    let credentialId = null;

    // 1. User key — only if BYOK is allowed
    if (allowUserBYOK && userId) {
      const userCred = await CredentialsStore.getActive(orgId, userId, provider);
      if (userCred?.apiKey) {
        apiKey       = userCred.apiKey;
        endpointUrl  = userCred.endpointUrl;
        credentialId = userCred.credentialId;
        keySource    = 'user';
      }
    }

    // 2. Org key
    if (!apiKey) {
      const orgCred = await CredentialsStore.getActive(orgId, null, provider);
      if (orgCred?.apiKey) {
        apiKey       = orgCred.apiKey;
        endpointUrl  = orgCred.endpointUrl;
        credentialId = orgCred.credentialId;
        keySource    = 'org';
      }
    }

    // 3. Platform fallback (env var)
    if (!apiKey && def.envKey) {
      const envKey = process.env[def.envKey];
      if (envKey) {
        apiKey    = envKey;
        keySource = 'platform';
      }
    }

    if (!apiKey) {
      throw new Error(
        `No API key available for provider '${provider}' ` +
        `(org=${orgId}, user=${userId || 'n/a'}). ` +
        `Configure one in Admin → AI Settings or set ${def.envKey || '<provider env var>'}.`
      );
    }

    // ── Build (or reuse) the adapter ──────────────────────────────────
    const cacheKey = _adapterKey(provider, apiKey, endpointUrl);
    let adapter = _adapterCache.get(cacheKey);
    if (!adapter) {
      adapter = _buildAdapter(provider, apiKey, endpointUrl);
      _adapterCache.set(cacheKey, adapter);
    }

    return { adapter, model, provider, keySource, credentialId, source };
  }

  /**
   * Effective resolution per call type — powers the "what will actually
   * run" table in the admin and user settings UIs. No clients are built and
   * no keys are read; this is provider/model resolution only.
   *
   * Pass userId=null for the org-level view (what a user with no personal
   * overrides gets); pass a userId to see that user's effective routing.
   */
  static async explainResolution(orgId, userId, callTypes) {
    const { CALL_TYPES } = require('../../config/aiProviders');
    const list = Array.isArray(callTypes) && callTypes.length
      ? callTypes
      : CALL_TYPES.map(ct => ct.id);
    const out = [];
    for (const callType of list) {
      const r = await this._resolveProviderAndModel(orgId, userId, callType);
      out.push({
        call_type: callType,
        provider:  r.provider,
        model:     r.model,
        source:    r.source,
      });
    }
    return out;
  }

  /**
   * Resolve just the provider/model without building a client.
   * Used by the admin UI to show what would be picked, and by routes that
   * want to validate config without making an API call.
   *
   * Walks the specificity-first candidate chain; the first slot that parses
   * to a known provider+model wins. Invalid slots log a warning and fall
   * through — never a silent flagship substitution. Returns
   * { provider, model, allowUserBYOK, allowUserOverride, source } where
   * source ∈ {'user_call_type','org_call_type','user_default','org_default',
   * 'system_default'}.
   */
  static async _resolveProviderAndModel(orgId, userId, callType) {
    const [orgRow, userRow] = await Promise.all([
      db.query(
        `SELECT ai_settings FROM org_action_config WHERE org_id = $1`,
        [orgId]
      ),
      userId
        ? db.query(
            `SELECT ai_settings FROM action_config WHERE user_id = $1 AND org_id = $2`,
            [userId, orgId]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const orgAI  = orgRow.rows[0]?.ai_settings  || {};
    const userAI = userRow.rows[0]?.ai_settings || {};

    const allowUserOverride = orgAI.allow_user_override !== false;  // default true
    const allowUserBYOK     = orgAI.allow_user_byok     === true;   // default false

    const candidates = buildSlotCandidates({ orgAI, userAI, callType, allowUserOverride });

    for (const c of candidates) {
      const parsed = parseModelSlot(c.slot, c.legacyProvider);
      if (parsed && await isKnownModel(parsed.provider, parsed.model)) {
        return {
          provider: parsed.provider,
          model: parsed.model,
          allowUserBYOK,
          allowUserOverride,
          source: c.source,
        };
      }
      console.warn(
        `[ai-resolver] Skipping invalid model slot '${c.slot}' at ${c.source} ` +
        `(callType=${callType}, org=${orgId}, user=${userId || 'n/a'}) — falling through.`
      );
    }

    return {
      provider: SYSTEM_DEFAULT.provider,
      model: SYSTEM_DEFAULT.model,
      allowUserBYOK,
      allowUserOverride,
      source: 'system_default',
    };
  }

  /**
   * Used by routes/admin/test endpoint. Validates a candidate key against
   * the provider by making a tiny 1-token call.
   *
   * Note: takes a plaintext key directly, used during the "Add key" flow
   * before storing. Doesn't read from ai_credentials.
   */
  static async validateKey({ provider, apiKey, endpointUrl, model }) {
    const def = getProvider(provider);
    if (!def) return { ok: false, error: `Unknown provider: ${provider}` };

    // Pick the model to test with. Prefer an explicitly-passed model, then
    // the cheapest 'fast' tier model (Haiku / gpt-4o-mini / etc.), and only
    // fall back to models[0] if nothing is tagged.
    //
    // Why: models[0] is the flagship (e.g. Opus 4.7). Newer or low-spend
    // accounts often can't call the flagship yet, so a liveness check
    // against it returns 404/403 even with a perfectly valid key. The
    // 'fast' tier model is the cheapest and most universally accessible.
    const fastModel = def.models?.find(m => m.tier === 'fast')?.id;
    const useModel  = model || fastModel || def.models?.[0]?.id;
    if (!useModel) return { ok: false, error: 'No model available to test with' };

    try {
      const adapter = _buildAdapter(provider, apiKey, endpointUrl);
      await adapter.ping(useModel);
      return { ok: true, model: useModel };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /** Clear the adapter cache — for tests or when keys are rotated. */
  static _clearCache() { _adapterCache.clear(); }
}

module.exports = AIClientResolver;
// Pure/utility exports — used by the settings routes for save-time slot
// validation and by unit tests for the precedence chain.
module.exports.isKnownModel = isKnownModel;
module.exports.buildSlotCandidates = buildSlotCandidates;
