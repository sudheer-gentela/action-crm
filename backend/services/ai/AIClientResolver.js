/**
 * services/ai/AIClientResolver.js
 *
 * Single entry point for getting an AI client + model anywhere in the app.
 *
 * Resolution chain (highest precedence first):
 *   PROVIDER & MODEL:
 *     1. user_preferences.ai_settings.models_by_call_type[callType]
 *     2. user_preferences.ai_settings.default_model
 *     3. org_action_config.ai_settings.models_by_call_type[callType]
 *     4. org_action_config.ai_settings.default_model
 *     5. SYSTEM_DEFAULT
 *
 *   API KEY:
 *     1. ai_credentials (user-level for this provider)
 *     2. ai_credentials (org-level for this provider)
 *     3. process.env[PROVIDERS[provider].envKey]   (platform fallback)
 *
 * Org admin can lock either dimension:
 *   - allow_user_override=false → user provider/model ignored
 *   - allow_user_byok=false     → user API key ignored
 *
 * Usage from any service:
 *
 *     const resolver = require('./services/ai/AIClientResolver');
 *     const { adapter, model, provider, keySource } =
 *       await resolver.resolve(orgId, userId, 'action_generation');
 *     const { text, usage } = await adapter.complete({ model, prompt });
 *     TokenTrackingService.log({ orgId, userId, callType: 'action_generation',
 *                                model, usage, keySource, provider });
 */

const db = require('../../config/database');
const CredentialsStore = require('./CredentialsStore');
const {
  PROVIDERS, SYSTEM_DEFAULT, getProvider, isValidProvider, isValidModel,
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

class AIClientResolver {

  /**
   * Main entry point.
   * Returns { adapter, model, provider, keySource, credentialId }.
   *
   * keySource ∈ {'user','org','platform','none'} — for cost attribution.
   * Throws if no usable key can be found (platform env var also missing).
   */
  static async resolve(orgId, userId, callType = 'default') {
    const { provider, model, allowUserBYOK } =
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

    return { adapter, model, provider, keySource, credentialId };
  }

  /**
   * Resolve just the provider/model without building a client.
   * Used by the admin UI to show what would be picked, and by routes that
   * want to validate config without making an API call.
   */
  static async _resolveProviderAndModel(orgId, userId, callType) {
    const [orgRow, userRow, orgPolicy] = await Promise.all([
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
      // Org policy lives in the same ai_settings — load it here too
      Promise.resolve(null),
    ]);

    const orgAI  = orgRow.rows[0]?.ai_settings  || {};
    const userAI = userRow.rows[0]?.ai_settings || {};

    const allowUserOverride = orgAI.allow_user_override !== false;  // default true
    const allowUserBYOK     = orgAI.allow_user_byok     === true;   // default false

    // Pick provider
    let provider = SYSTEM_DEFAULT.provider;
    if (orgAI.ai_provider && isValidProvider(orgAI.ai_provider)) {
      provider = orgAI.ai_provider;
    }
    if (allowUserOverride && userAI.ai_provider && isValidProvider(userAI.ai_provider)) {
      provider = userAI.ai_provider;
    }

    // Pick model — call-type override beats default
    let model = SYSTEM_DEFAULT.model;
    const orgPerCall  = orgAI.models_by_call_type  || {};
    const userPerCall = userAI.models_by_call_type || {};

    if (orgAI.default_model)                model = orgAI.default_model;
    if (orgPerCall[callType])               model = orgPerCall[callType];
    if (allowUserOverride && userAI.default_model)  model = userAI.default_model;
    if (allowUserOverride && userPerCall[callType]) model = userPerCall[callType];

    // Sanity: model must belong to provider, otherwise fall back to provider default
    if (!isValidModel(provider, model)) {
      const def = getProvider(provider);
      model = def?.models?.[0]?.id || SYSTEM_DEFAULT.model;
    }

    return { provider, model, allowUserBYOK, allowUserOverride };
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
