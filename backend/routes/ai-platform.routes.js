/**
 * routes/ai-platform.routes.js
 *
 * Mount at: /api/super-admin/ai
 *
 * Super-admin-only endpoints for PLATFORM-LEVEL AI configuration:
 *   - Which providers are exposed to org admins (allowlist)
 *   - Read-only status of platform fallback env-var keys
 *   - Platform-wide call-volume rollups
 *
 * Actual env-var keys cannot be edited from the UI — they live in
 * the deploy environment (Railway secrets, AWS Parameter Store, etc.).
 * The UI shows whether each is configured so SuperAdmin can verify
 * deployment without leaving the app.
 *
 * Provider allowlist is stored in platform_settings (key='ai_provider_allowlist').
 * If absent, ALL providers in the registry are available.
 */

const express = require('express');
const authenticateToken = require('../middleware/auth.middleware');
const { requireSuperAdmin } = require('../middleware/superAdmin.middleware');
const db = require('../config/database');

const { listProviders, getProvider, isValidProvider } = require('../config/aiProviders');
const CredentialsStore = require('../services/ai/CredentialsStore');

const router = express.Router();
router.use(authenticateToken, requireSuperAdmin);

// ─────────────────────────────────────────────────────────────────────────
// GET /api/super-admin/ai/status
// ─────────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    // Provider env-var status
    const provider_env = listProviders().map(p => {
      const def = getProvider(p.id);
      const envKey = def.envKey;
      const hasEnv = envKey ? !!process.env[envKey] : null;
      return {
        id:        p.id,
        label:     p.label,
        env_var:   envKey || null,
        has_platform_key: hasEnv,
        requires_endpoint: p.requiresEndpoint,
      };
    });

    // Allowlist
    const allowRes = await db.query(
      `SELECT value FROM platform_settings WHERE key = 'ai_provider_allowlist'`
    ).catch(() => ({ rows: [] }));
    const allowlist = allowRes.rows[0]?.value?.providers || null;  // null = all allowed

    // Rough usage rollup last 30 days
    const usageRes = await db.query(`
      SELECT COALESCE(provider, 'unknown') AS provider,
             COALESCE(key_source, 'platform') AS key_source,
             COUNT(*)::int AS call_count,
             SUM(total_tokens)::bigint AS total_tokens
        FROM ai_token_usage
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY 1, 2
       ORDER BY total_tokens DESC NULLS LAST
    `).catch(() => ({ rows: [] }));

    res.json({
      credentials_storage_configured: CredentialsStore.isConfigured(),
      provider_env,
      allowlist,
      usage_30d: usageRes.rows,
    });
  } catch (err) {
    console.error('GET /super-admin/ai/status error:', err);
    res.status(500).json({ error: { message: 'Failed to load AI platform status' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/super-admin/ai/allowlist
// Body: { providers: ['anthropic', 'openai', ...] | null }
// null = allow all
// ─────────────────────────────────────────────────────────────────────────
router.patch('/allowlist', async (req, res) => {
  const { providers } = req.body || {};
  if (providers !== null && !Array.isArray(providers)) {
    return res.status(400).json({ error: { message: 'providers must be array or null' } });
  }
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (!isValidProvider(p)) {
        return res.status(400).json({ error: { message: `Unknown provider: ${p}` } });
      }
    }
  }

  try {
    await db.query(`
      INSERT INTO platform_settings (key, value, updated_by, updated_at)
      VALUES ('ai_provider_allowlist', $1::jsonb, $2, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = $1::jsonb, updated_by = $2, updated_at = NOW()
    `, [JSON.stringify({ providers }), req.userId]);
    res.json({ ok: true, providers });
  } catch (err) {
    console.error('PATCH /super-admin/ai/allowlist error:', err);
    res.status(500).json({ error: { message: 'Failed to update allowlist' } });
  }
});

module.exports = router;
