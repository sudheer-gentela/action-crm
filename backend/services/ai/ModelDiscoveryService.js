/**
 * services/ai/ModelDiscoveryService.js
 *
 * Live model discovery. Calls each provider's "list models" endpoint, stores
 * the results in `discovered_models`, and merges them with the static registry
 * (config/aiProviders.js) so the OrgAdmin model dropdown stays current without
 * a redeploy.
 *
 * Design:
 *   - Discovery is PLATFORM-level. A provider's model list is the same
 *     regardless of which org's key is used, so we run on the platform
 *     env-var key and store ONE shared result. (Org keys are only consulted
 *     as a fallback if no platform key exists for that provider.)
 *   - Triggered two ways: a weekly/daily cron, and an on-demand refresh
 *     button on the OrgAdmin screen.
 *   - The on-demand path is DEBOUNCED globally: if a run happened within
 *     `ondemand_debounce_minutes`, a click returns the cached result
 *     instead of re-calling providers. SuperAdmin configures the window
 *     (0..1440 min) or disables on-demand entirely.
 *
 * Config + state live in platform_settings:
 *   ai_model_discovery        — SuperAdmin config (see DEFAULT_CONFIG below)
 *   ai_model_discovery_state  — runtime state (last_run_at, per-provider result)
 */

const db = require('../../config/database');
const {
  PROVIDERS, getProvider, getModelCost,
} = require('../../config/aiProviders');

const AnthropicAdapter = require('./adapters/AnthropicAdapter');
const OpenAIAdapter    = require('./adapters/OpenAIAdapter');
let   GeminiAdapter    = null;  // lazy — only if a Gemini key exists

const SETTINGS_KEY = 'ai_model_discovery';
const STATE_KEY    = 'ai_model_discovery_state';

const DEFAULT_CONFIG = {
  cron_enabled:              true,
  cron_frequency:            'weekly',   // 'daily' | 'weekly'
  ondemand_enabled:          true,
  ondemand_debounce_minutes: 10,         // 0..1440
};

// ── Build an adapter for discovery (platform key preferred) ────────────────

function _buildAdapter(providerId, apiKey, endpoint) {
  const def = getProvider(providerId);
  if (!def) throw new Error(`Unknown provider: ${providerId}`);
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
      throw new Error(`No adapter for: ${def.adapter}`);
  }
}

/**
 * Resolve a usable API key for discovery for the given provider.
 * Platform env-var key first; if absent, fall back to any active org-level
 * key for that provider (discovery doesn't care which org — the model list
 * is identical).
 */
async function _discoveryKey(providerId) {
  const def = getProvider(providerId);
  if (!def) return null;

  // 1. Platform env-var key
  if (def.envKey && process.env[def.envKey]) {
    return { apiKey: process.env[def.envKey], endpoint: null };
  }

  // 2. Any active org-level key for this provider
  try {
    const r = await db.query(
      `SELECT key_ciphertext, key_iv, key_tag, endpoint_url
         FROM ai_credentials
        WHERE provider = $1 AND user_id IS NULL AND status = 'active'
        ORDER BY last_validated_at DESC NULLS LAST
        LIMIT 1`,
      [providerId]
    );
    if (r.rows.length) {
      // Decrypt via CredentialsStore's primitives. We re-require here to
      // avoid a circular dependency at module load.
      const CredentialsStore = require('./CredentialsStore');
      // CredentialsStore.getActive() takes (orgId,userId,provider); we don't
      // have an orgId, so decrypt the row directly through its helper.
      // It exposes a decryptRow() helper for exactly this use.
      if (typeof CredentialsStore.decryptRow === 'function') {
        const apiKey = CredentialsStore.decryptRow(r.rows[0]);
        if (apiKey) return { apiKey, endpoint: r.rows[0].endpoint_url || null };
      }
    }
  } catch (err) {
    console.error('[ModelDiscovery] org-key fallback failed for', providerId, err.message);
  }
  return null;
}

// ── Settings / state in platform_settings ─────────────────────────────────

class ModelDiscoveryService {

  static async getConfig() {
    try {
      const r = await db.query(
        `SELECT value FROM platform_settings WHERE key = $1`, [SETTINGS_KEY]
      );
      return { ...DEFAULT_CONFIG, ...(r.rows[0]?.value || {}) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  static async setConfig(patch, updatedBy = null) {
    const current = await this.getConfig();
    const next = { ...current, ...patch };

    // Clamp / validate
    if (next.cron_frequency !== 'daily' && next.cron_frequency !== 'weekly') {
      next.cron_frequency = 'weekly';
    }
    next.cron_enabled     = !!next.cron_enabled;
    next.ondemand_enabled = !!next.ondemand_enabled;
    let db_min = parseInt(next.ondemand_debounce_minutes, 10);
    if (isNaN(db_min)) db_min = DEFAULT_CONFIG.ondemand_debounce_minutes;
    next.ondemand_debounce_minutes = Math.max(0, Math.min(1440, db_min));

    await db.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = $2::jsonb, updated_by = $3, updated_at = NOW()`,
      [SETTINGS_KEY, JSON.stringify(next), updatedBy]
    );
    return next;
  }

  static async getState() {
    try {
      const r = await db.query(
        `SELECT value FROM platform_settings WHERE key = $1`, [STATE_KEY]
      );
      return r.rows[0]?.value || null;
    } catch {
      return null;
    }
  }

  static async _saveState(state) {
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, NULL, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = $2::jsonb, updated_at = NOW()`,
      [STATE_KEY, JSON.stringify(state)]
    );
  }

  // ── Core discovery run ───────────────────────────────────────────────────

  /**
   * Run discovery for every provider that has a usable key.
   * @param {string} source — 'cron' | 'ondemand'
   * @returns {Promise<object>} the new state object
   */
  static async runDiscovery(source = 'cron') {
    const providerIds = Object.keys(PROVIDERS).filter(id => {
      const def = PROVIDERS[id];
      // Skip 'custom' — user-defined endpoints, nothing to enumerate.
      return def.adapter !== undefined && id !== 'custom';
    });

    const perProvider = {};
    let okCount = 0;
    let errCount = 0;

    for (const providerId of providerIds) {
      const key = await _discoveryKey(providerId);
      if (!key) {
        perProvider[providerId] = { ok: false, skipped: true, reason: 'no key' };
        continue;
      }
      try {
        const adapter = _buildAdapter(providerId, key.apiKey, key.endpoint);
        const models  = await adapter.listModels();
        await this._storeModels(providerId, models);
        perProvider[providerId] = { ok: true, count: models.length };
        okCount++;
      } catch (err) {
        perProvider[providerId] = { ok: false, error: err.message || String(err) };
        errCount++;
        console.error(`[ModelDiscovery] ${providerId} failed:`, err.message);
      }
    }

    const state = {
      last_run_at:     new Date().toISOString(),
      last_run_status: errCount === 0 ? 'ok' : (okCount > 0 ? 'partial' : 'error'),
      last_run_source: source,
      providers:       perProvider,
    };
    await this._saveState(state);
    return state;
  }

  /**
   * Upsert discovered models for one provider. Models seen this run get
   * last_seen_at bumped; brand-new ones get a row with first_seen_at=now.
   */
  static async _storeModels(providerId, models) {
    for (const m of models) {
      await db.query(
        `INSERT INTO discovered_models (provider, model_id, raw, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3::jsonb, NOW(), NOW())
         ON CONFLICT (provider, model_id) DO UPDATE
           SET last_seen_at = NOW(),
               raw = EXCLUDED.raw`,
        [providerId, m.id, JSON.stringify(m.raw || {})]
      );
    }
  }

  // ── On-demand entry point (debounced) ────────────────────────────────────

  /**
   * Called by the OrgAdmin "Refresh models" button.
   * Respects ondemand_enabled and the global debounce window.
   *
   * @returns {Promise<{ ran: boolean, reason?: string, state: object|null }>}
   *   ran=true  → a fresh discovery run happened
   *   ran=false → debounced or disabled; `reason` explains; `state` is the
   *               last known state (still current within the debounce window)
   */
  static async refreshOnDemand() {
    const config = await this.getConfig();

    if (!config.ondemand_enabled) {
      return {
        ran: false,
        reason: 'ondemand_disabled',
        state: await this.getState(),
      };
    }

    const state = await this.getState();
    const debounceMs = config.ondemand_debounce_minutes * 60 * 1000;

    if (state?.last_run_at && debounceMs > 0) {
      const age = Date.now() - new Date(state.last_run_at).getTime();
      if (age < debounceMs) {
        return {
          ran: false,
          reason: 'debounced',
          debounce_minutes: config.ondemand_debounce_minutes,
          age_minutes: Math.round(age / 60000),
          state,
        };
      }
    }

    const newState = await this.runDiscovery('ondemand');
    return { ran: true, state: newState };
  }

  // ── Merge: registry + discovered → what the dropdown shows ───────────────

  /**
   * Return the merged model list for one provider:
   *   - every registry model, marked { source: 'registry' }
   *   - every discovered model NOT in the registry, marked
   *     { source: 'discovered', pricing_pending: true }
   *
   * Registry always wins on label/tier/cost. Discovered-only models get a
   * generated label and 'balanced' tier so they're immediately selectable
   * (design Option A) — only the cost is unknown until someone backfills it.
   */
  static async getMergedModels(providerId) {
    const def = getProvider(providerId);
    if (!def) return [];

    const registryModels = def.models || [];
    const registryIds    = new Set(registryModels.map(m => m.id));

    const merged = registryModels.map(m => ({
      id:    m.id,
      label: m.label,
      tier:  m.tier || 'balanced',
      source: 'registry',
      pricing_pending: !getModelCost(providerId, m.id),
    }));

    // Discovered-only models
    try {
      const r = await db.query(
        `SELECT model_id, first_seen_at FROM discovered_models
          WHERE provider = $1
          ORDER BY model_id`,
        [providerId]
      );
      for (const row of r.rows) {
        if (registryIds.has(row.model_id)) continue;  // registry wins
        merged.push({
          id:    row.model_id,
          label: row.model_id,            // raw id as label until backfilled
          tier:  'balanced',
          source: 'discovered',
          pricing_pending: true,
          first_seen_at: row.first_seen_at,
        });
      }
    } catch (err) {
      console.error('[ModelDiscovery] getMergedModels query failed:', err.message);
      // Degrade gracefully — registry list is still returned
    }

    return merged;
  }

  /** Convenience: merged models for ALL providers, keyed by provider id. */
  static async getAllMergedModels() {
    const out = {};
    for (const providerId of Object.keys(PROVIDERS)) {
      out[providerId] = await this.getMergedModels(providerId);
    }
    return out;
  }
}

module.exports = ModelDiscoveryService;
