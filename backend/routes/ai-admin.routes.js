/**
 * routes/ai-admin.routes.js
 *
 * Mount at: /api/org/admin/ai
 *
 * Admin-only endpoints for AI provider, model selection, and API key
 * management. The user-level mirror lives in routes/ai-user.routes.js.
 */

const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const db                    = require('../config/database');

const {
  listProviders, getProvider, isValidProvider, isValidModel, CALL_TYPES,
  SYSTEM_DEFAULT, parseModelSlot,
} = require('../config/aiProviders');
const CredentialsStore  = require('../services/ai/CredentialsStore');
const AIClientResolver  = require('../services/ai/AIClientResolver');
const ModelDiscoveryService = require('../services/ai/ModelDiscoveryService');

const router = express.Router();
router.use(authenticateToken, orgContext);
const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────────────────
// GET /api/org/admin/ai/providers
// Catalog of providers/models — drives admin UI dropdowns.
// Model lists are MERGED: static registry + live-discovered models.
// ─────────────────────────────────────────────────────────────────────────
router.get('/providers', adminOnly, async (req, res) => {
  try {
    const providers = listProviders();
    const merged    = await ModelDiscoveryService.getAllMergedModels();

    // Overlay the merged model list onto each provider entry. Registry
    // models keep their metadata; discovered-only models appear flagged
    // with pricing_pending so the UI can mark them "new".
    const withDiscovered = providers.map(p => ({
      ...p,
      models: merged[p.id] || p.models,
    }));

    const discoveryState = await ModelDiscoveryService.getState();

    res.json({
      providers: withDiscovered,
      call_types: CALL_TYPES,
      credentials_configured: CredentialsStore.isConfigured(),
      discovery: {
        last_run_at: discoveryState?.last_run_at || null,
        last_run_status: discoveryState?.last_run_status || null,
      },
    });
  } catch (err) {
    console.error('GET /org/admin/ai/providers error:', err);
    // Degrade gracefully — fall back to registry-only catalog
    res.json({
      providers: listProviders(),
      call_types: CALL_TYPES,
      credentials_configured: CredentialsStore.isConfigured(),
      discovery: { last_run_at: null, last_run_status: null },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/org/admin/ai/refresh-models
// On-demand model discovery. Any org admin may trigger it; the run itself
// is a single SHARED platform-level operation, globally debounced. If a run
// happened within the SuperAdmin-configured window, returns the cached
// result instead of re-calling providers.
// ─────────────────────────────────────────────────────────────────────────
router.post('/refresh-models', adminOnly, async (req, res) => {
  try {
    const result = await ModelDiscoveryService.refreshOnDemand();

    if (!result.ran && result.reason === 'ondemand_disabled') {
      return res.status(200).json({
        ok: true,
        ran: false,
        reason: 'disabled',
        message: 'On-demand refresh is disabled by the platform admin. Model lists update automatically on a schedule.',
        last_run_at: result.state?.last_run_at || null,
      });
    }

    if (!result.ran && result.reason === 'debounced') {
      return res.status(200).json({
        ok: true,
        ran: false,
        reason: 'debounced',
        message: `Models were refreshed ${result.age_minutes} minute(s) ago — already current.`,
        last_run_at: result.state?.last_run_at || null,
      });
    }

    res.json({
      ok: true,
      ran: true,
      message: 'Model list refreshed.',
      last_run_at: result.state?.last_run_at || null,
      providers: result.state?.providers || {},
    });
  } catch (err) {
    console.error('POST /org/admin/ai/refresh-models error:', err);
    res.status(500).json({ error: { message: 'Model refresh failed' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/org/admin/ai/config
// Returns the org's AI settings (provider, model, per-call overrides,
// policy flags) and a list of which providers have keys configured.
// ─────────────────────────────────────────────────────────────────────────
router.get('/config', adminOnly, async (req, res) => {
  try {
    const cfgRes = await db.query(
      `SELECT ai_settings FROM org_action_config WHERE org_id = $1`,
      [req.orgId]
    );
    const ai_settings = cfgRes.rows[0]?.ai_settings || {};

    const credsRes = await db.query(
      `SELECT provider, COUNT(*)::int AS active_keys
         FROM org_credentials
        WHERE org_id = $1
          AND purpose = 'ai'
          AND user_id IS NULL
          AND status = 'active'
        GROUP BY provider`,
      [req.orgId]
    );
    const provider_status = {};
    for (const row of credsRes.rows) {
      provider_status[row.provider] = { has_org_key: true, active_keys: row.active_keys };
    }

    res.json({
      ai_settings: {
        ai_provider:        ai_settings.ai_provider        || 'anthropic',
        default_model:      ai_settings.default_model      || 'claude-haiku-4-5-20251001',
        models_by_call_type: ai_settings.models_by_call_type || {},
        allow_user_override: ai_settings.allow_user_override !== false,
        allow_user_byok:     ai_settings.allow_user_byok     === true,
      },
      provider_status,
    });
  } catch (err) {
    console.error('GET /org/admin/ai/config error:', err);
    res.status(500).json({ error: { message: 'Failed to load AI config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/org/admin/ai/effective
// Per-call-type effective resolution table: which provider/model would
// actually serve each call type, and which config layer set it. With no
// query param this is the ORG-level view (a user with no personal
// overrides). Pass ?userId=N to inspect a specific user's routing.
// ─────────────────────────────────────────────────────────────────────────
router.get('/effective', adminOnly, async (req, res) => {
  try {
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const rows = await AIClientResolver.explainResolution(req.orgId, userId);
    res.json({ userId, effective: rows });
  } catch (err) {
    console.error('GET /org/admin/ai/effective error:', err);
    res.status(500).json({ error: { message: 'Failed to resolve effective models' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/org/admin/ai/config
// Body: { ai_provider?, default_model?, models_by_call_type?,
//         allow_user_override?, allow_user_byok? }
// ─────────────────────────────────────────────────────────────────────────
router.patch('/config', adminOnly, async (req, res) => {
  const patch = {};
  const { ai_provider, default_model, models_by_call_type,
          allow_user_override, allow_user_byok } = req.body;

  if (ai_provider !== undefined) {
    if (!isValidProvider(ai_provider)) {
      return res.status(400).json({ error: { message: `Unknown provider: ${ai_provider}` } });
    }
    patch.ai_provider = ai_provider;
  }

  // Legacy provider context for UNQUALIFIED slot values: the ai_provider in
  // this request, else the stored org provider, else system default. Slots
  // may also arrive provider-qualified ('anthropic/claude-sonnet-4-6'), in
  // which case the embedded provider wins for that slot.
  let legacyProvider = patch.ai_provider || null;
  if (!legacyProvider) {
    const cur = await db.query(
      `SELECT ai_settings->>'ai_provider' AS p FROM org_action_config WHERE org_id = $1`,
      [req.orgId]
    );
    const storedP = cur.rows[0]?.p;
    legacyProvider = (storedP && isValidProvider(storedP)) ? storedP : SYSTEM_DEFAULT.provider;
  }

  // Validate a slot against the MERGED catalog (static registry + live
  // discovery) so newly-discovered models are saveable. Returns an error
  // string or null.
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
    const err = await validateSlot(default_model, 'default_model');
    if (err) return res.status(400).json({ error: { message: err } });
    patch.default_model = default_model;
  }
  if (models_by_call_type !== undefined) {
    if (typeof models_by_call_type !== 'object' || Array.isArray(models_by_call_type)) {
      return res.status(400).json({ error: { message: 'models_by_call_type must be an object' } });
    }
    const knownCallTypes = new Set(CALL_TYPES.map(ct => ct.id));
    for (const [ct, slot] of Object.entries(models_by_call_type)) {
      if (!knownCallTypes.has(ct)) {
        return res.status(400).json({ error: { message: `Unknown call type: ${ct}` } });
      }
      if (slot == null || slot === '') continue;   // explicit clear is allowed
      const err = await validateSlot(slot, `models_by_call_type.${ct}`);
      if (err) return res.status(400).json({ error: { message: err } });
    }
    patch.models_by_call_type = models_by_call_type;
  }
  if (typeof allow_user_override === 'boolean') patch.allow_user_override = allow_user_override;
  if (typeof allow_user_byok     === 'boolean') patch.allow_user_byok     = allow_user_byok;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields supplied' } });
  }

  try {
    await db.query(
      `INSERT INTO org_action_config (org_id, ai_settings, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (org_id) DO UPDATE
         SET ai_settings = org_action_config.ai_settings || $2::jsonb,
             updated_by  = $3,
             updated_at  = NOW()`,
      [req.orgId, JSON.stringify(patch), req.userId]
    );
    res.json({ ok: true, patch });
  } catch (err) {
    console.error('PATCH /org/admin/ai/config error:', err);
    res.status(500).json({ error: { message: 'Failed to save AI config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/org/admin/ai/credentials
// List org-level credentials (masked).
// ─────────────────────────────────────────────────────────────────────────
router.get('/credentials', adminOnly, async (req, res) => {
  try {
    const rows = await CredentialsStore.list(req.orgId, null);
    res.json({ credentials: rows });
  } catch (err) {
    console.error('GET /org/admin/ai/credentials error:', err);
    res.status(500).json({ error: { message: 'Failed to list credentials' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/org/admin/ai/credentials
// Body: { provider, api_key, label?, endpoint_url?, test_model? }
//
// Validates the key by making a 1-token call BEFORE storing. If validation
// fails, nothing is persisted.
// ─────────────────────────────────────────────────────────────────────────
router.post('/credentials', adminOnly, async (req, res) => {
  const { provider, api_key, label, endpoint_url, test_model } = req.body || {};

  if (!provider || !isValidProvider(provider)) {
    return res.status(400).json({ error: { message: `Unknown provider: ${provider}` } });
  }
  if (!api_key || typeof api_key !== 'string') {
    return res.status(400).json({ error: { message: 'api_key required' } });
  }
  const def = getProvider(provider);
  if (def.requiresEndpoint && !endpoint_url) {
    return res.status(400).json({ error: { message: `Provider ${provider} requires endpoint_url` } });
  }
  if (!CredentialsStore.isConfigured()) {
    return res.status(503).json({
      error: { message: 'AI_CREDS_KEY env var not configured on server — cannot store credentials.' },
    });
  }

  // Validate first
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
      userId:      null,
      provider,
      apiKey:      api_key,
      label,
      endpointUrl: endpoint_url,
      createdBy:   req.userId,
    });
    await CredentialsStore.markValidated(stored.id, true);
    AIClientResolver._clearCache();

    res.status(201).json({
      credential: { ...stored, last_validated_at: new Date().toISOString() },
      test_model: validation.model,
    });
  } catch (err) {
    console.error('POST /org/admin/ai/credentials error:', err);
    res.status(500).json({ error: { message: 'Failed to store credential' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/org/admin/ai/credentials/:id/test
// Re-validates a stored credential without rotating it.
// ─────────────────────────────────────────────────────────────────────────
router.post('/credentials/:id/test', adminOnly, async (req, res) => {
  const credId = parseInt(req.params.id, 10);
  try {
    const row = await db.query(
      `SELECT id, provider FROM org_credentials
        WHERE id = $1
          AND org_id = $2
          AND purpose = 'ai'
          AND user_id IS NULL
          AND status != 'revoked'`,
      [credId, req.orgId]
    );
    if (row.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });

    const provider = row.rows[0].provider;
    const cred = await CredentialsStore.getActive(req.orgId, null, provider);
    if (!cred) return res.status(404).json({ error: { message: 'No active key for this provider' } });

    const result = await AIClientResolver.validateKey({
      provider, apiKey: cred.apiKey, endpointUrl: cred.endpointUrl,
    });
    await CredentialsStore.markValidated(credId, result.ok, result.ok ? null : result.error);
    res.json(result);
  } catch (err) {
    console.error('POST /org/admin/ai/credentials/:id/test error:', err);
    res.status(500).json({ error: { message: 'Test failed' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/org/admin/ai/credentials/:id  → revoke
// ─────────────────────────────────────────────────────────────────────────
router.delete('/credentials/:id', adminOnly, async (req, res) => {
  const credId = parseInt(req.params.id, 10);
  try {
    const ok = await CredentialsStore.revoke(req.orgId, credId, null);
    if (!ok) return res.status(404).json({ error: { message: 'Not found' } });
    AIClientResolver._clearCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /org/admin/ai/credentials/:id error:', err);
    res.status(500).json({ error: { message: 'Failed to revoke credential' } });
  }
});

module.exports = router;
