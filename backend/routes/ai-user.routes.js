/**
 * routes/ai-user.routes.js
 *
 * Mount at: /api/me/ai
 *
 * User-level AI settings and BYOK keys. Both are gated by org policy flags
 * (allow_user_override and allow_user_byok respectively) — if the admin has
 * disabled them, these endpoints return 403 with a clear message.
 */

const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }        = require('../middleware/orgContext.middleware');
const db                    = require('../config/database');

const {
  listProviders, getProvider, isValidProvider, isValidModel, CALL_TYPES,
  parseModelSlot,
} = require('../config/aiProviders');
const CredentialsStore  = require('../services/ai/CredentialsStore');
const AIClientResolver  = require('../services/ai/AIClientResolver');
const ModelDiscoveryService = require('../services/ai/ModelDiscoveryService');

const router = express.Router();
router.use(authenticateToken, orgContext);

// ── Helper — load org policy flags ───────────────────────────────────────
async function _loadPolicy(orgId) {
  const r = await db.query(
    `SELECT ai_settings FROM org_action_config WHERE org_id = $1`, [orgId]
  );
  const ai = r.rows[0]?.ai_settings || {};
  return {
    allow_user_override: ai.allow_user_override !== false,
    allow_user_byok:     ai.allow_user_byok     === true,
    org_provider:        ai.ai_provider   || 'anthropic',
    org_model:           ai.default_model || 'claude-haiku-4-5-20251001',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/me/ai/config
// Returns user's effective settings + org defaults + policy flags so the UI
// can render ghost-text placeholders for "uses org default".
// ─────────────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const policy = await _loadPolicy(req.orgId);
    const ur = await db.query(
      `SELECT ai_settings FROM action_config WHERE user_id = $1 AND org_id = $2`,
      [req.userId, req.orgId]
    );
    const user_settings = ur.rows[0]?.ai_settings || {};

    // Provider catalog with merged model lists (static registry + live
    // discovered models). Falls back to the static catalog if discovery
    // is unavailable, so this endpoint never hard-fails on it.
    let providers;
    try {
      const merged = await ModelDiscoveryService.getAllMergedModels();
      providers = listProviders().map(p => ({
        ...p,
        models: merged[p.id] || p.models,
      }));
    } catch (e) {
      console.error('GET /me/ai/config — model merge failed, using registry:', e.message);
      providers = listProviders();
    }

    res.json({
      policy,
      user_settings: {
        ai_provider:        user_settings.ai_provider        || null,
        default_model:      user_settings.default_model      || null,
        models_by_call_type: user_settings.models_by_call_type || {},
      },
      providers,
      call_types: CALL_TYPES,
    });
  } catch (err) {
    console.error('GET /me/ai/config error:', err);
    res.status(500).json({ error: { message: 'Failed to load AI config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/me/ai/config
// ─────────────────────────────────────────────────────────────────────────
router.patch('/config', async (req, res) => {
  const policy = await _loadPolicy(req.orgId);
  if (!policy.allow_user_override) {
    return res.status(403).json({
      error: { message: 'Your organization has disabled per-user AI overrides.' },
    });
  }

  const patch = {};
  const { ai_provider, default_model, models_by_call_type } = req.body || {};

  if (ai_provider !== undefined) {
    if (ai_provider !== null && !isValidProvider(ai_provider)) {
      return res.status(400).json({ error: { message: `Unknown provider: ${ai_provider}` } });
    }
    patch.ai_provider = ai_provider;
  }

  // Legacy provider context for UNQUALIFIED slots: the provider in this
  // request, else the user's stored provider, else the org provider.
  // Provider-qualified slots ('anthropic/claude-sonnet-4-6') carry their own.
  let legacyProvider = (patch.ai_provider && isValidProvider(patch.ai_provider))
    ? patch.ai_provider : null;
  if (!legacyProvider) {
    const cur = await db.query(
      `SELECT ai_settings->>'ai_provider' AS p
         FROM action_config WHERE user_id = $1 AND org_id = $2`,
      [req.userId, req.orgId]
    );
    const storedP = cur.rows[0]?.p;
    legacyProvider = (storedP && isValidProvider(storedP)) ? storedP : policy.org_provider;
  }

  const validateSlot = async (slot, fieldLabel) => {
    const parsed = parseModelSlot(slot, legacyProvider);
    if (!parsed) {
      return `${fieldLabel}: '${slot}' is not a valid model reference. ` +
             `Use 'provider/model' (e.g. 'anthropic/claude-sonnet-4-6') or a model id.`;
    }
    if (!(await AIClientResolver.isKnownModel(parsed.provider, parsed.model))) {
      return `${fieldLabel}: model '${parsed.model}' is not known for provider ` +
             `'${parsed.provider}'. Refresh the model list if it was released recently.`;
    }
    return null;
  };

  if (default_model !== undefined) {
    if (default_model !== null) {
      const err = await validateSlot(default_model, 'default_model');
      if (err) return res.status(400).json({ error: { message: err } });
    }
    patch.default_model = default_model;
  }
  if (models_by_call_type !== undefined) {
    if (typeof models_by_call_type !== 'object' || Array.isArray(models_by_call_type)) {
      return res.status(400).json({ error: { message: 'models_by_call_type must be an object' } });
    }
    const knownCallTypes = new Set(CALL_TYPES.map(ct => ct.id));
    for (const [ct, slot] of Object.entries(models_by_call_type || {})) {
      if (!knownCallTypes.has(ct)) {
        return res.status(400).json({ error: { message: `Unknown call type: ${ct}` } });
      }
      if (slot == null || slot === '') continue;   // explicit clear is allowed
      const err = await validateSlot(slot, `models_by_call_type.${ct}`);
      if (err) return res.status(400).json({ error: { message: err } });
    }
    patch.models_by_call_type = models_by_call_type;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields supplied' } });
  }

  try {
    await db.query(
      `INSERT INTO action_config (user_id, org_id, ai_settings, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_id, org_id) DO UPDATE
         SET ai_settings = action_config.ai_settings || $3::jsonb,
             updated_at  = NOW()`,
      [req.userId, req.orgId, JSON.stringify(patch)]
    );
    res.json({ ok: true, patch });
  } catch (err) {
    console.error('PATCH /me/ai/config error:', err);
    res.status(500).json({ error: { message: 'Failed to save AI config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/me/ai/effective
// The caller's own per-call-type effective resolution (provider, model, and
// which config layer set it) — "what will actually run when I click
// generate". Powers the routing table in user AI preferences.
// ─────────────────────────────────────────────────────────────────────────
router.get('/effective', async (req, res) => {
  try {
    const rows = await AIClientResolver.explainResolution(req.orgId, req.userId);
    res.json({ effective: rows });
  } catch (err) {
    console.error('GET /me/ai/effective error:', err);
    res.status(500).json({ error: { message: 'Failed to resolve effective models' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/me/ai/credentials
// ─────────────────────────────────────────────────────────────────────────
router.get('/credentials', async (req, res) => {
  try {
    const rows = await CredentialsStore.list(req.orgId, req.userId);
    res.json({ credentials: rows });
  } catch (err) {
    console.error('GET /me/ai/credentials error:', err);
    res.status(500).json({ error: { message: 'Failed to list credentials' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/me/ai/credentials
// ─────────────────────────────────────────────────────────────────────────
router.post('/credentials', async (req, res) => {
  const policy = await _loadPolicy(req.orgId);
  if (!policy.allow_user_byok) {
    return res.status(403).json({
      error: { message: 'Your organization has disabled bring-your-own-key.' },
    });
  }

  const { provider, api_key, label, endpoint_url, test_model } = req.body || {};
  if (!provider || !isValidProvider(provider)) {
    return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
  }
  if (!api_key) return res.status(400).json({ error: { message: 'api_key required' } });

  const def = getProvider(provider);
  if (def.requiresEndpoint && !endpoint_url) {
    return res.status(400).json({ error: { message: `Provider ${provider} requires endpoint_url` } });
  }
  if (!CredentialsStore.isConfigured()) {
    return res.status(503).json({ error: { message: 'Server not configured for credential storage.' } });
  }

  const validation = await AIClientResolver.validateKey({
    provider, apiKey: api_key, endpointUrl: endpoint_url, model: test_model,
  });
  if (!validation.ok) {
    return res.status(400).json({
      error: { message: 'Key validation failed', detail: validation.error },
    });
  }

  try {
    const stored = await CredentialsStore.store({
      orgId:       req.orgId,
      userId:      req.userId,
      provider,
      apiKey:      api_key,
      label,
      endpointUrl: endpoint_url,
      createdBy:   req.userId,
    });
    await CredentialsStore.markValidated(stored.id, true);
    AIClientResolver._clearCache();
    res.status(201).json({ credential: stored, test_model: validation.model });
  } catch (err) {
    console.error('POST /me/ai/credentials error:', err);
    res.status(500).json({ error: { message: 'Failed to store credential' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/me/ai/credentials/:id
// ─────────────────────────────────────────────────────────────────────────
router.delete('/credentials/:id', async (req, res) => {
  const credId = parseInt(req.params.id, 10);
  try {
    const ok = await CredentialsStore.revoke(req.orgId, credId, req.userId);
    if (!ok) return res.status(404).json({ error: { message: 'Not found' } });
    AIClientResolver._clearCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /me/ai/credentials/:id error:', err);
    res.status(500).json({ error: { message: 'Failed to revoke credential' } });
  }
});

module.exports = router;
