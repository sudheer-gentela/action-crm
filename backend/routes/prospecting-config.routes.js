// ============================================================================
// routes/prospecting-config.routes.js
//
// Read/write the prospecting_config that feeds the outreach-personalization
// skill. Two layers:
//
//   ORG  (owner/admin only)  — organizations.settings.prospecting_config
//     GET  /api/prospecting-config/org
//     PUT  /api/prospecting-config/org
//
//   USER (any authenticated)  — user_preferences.preferences.prospecting_config
//     GET  /api/prospecting-config/me
//     PUT  /api/prospecting-config/me
//
// The user GET also returns the resolved org baseline + the org competitor
// list, so the per-user editor can render "what the org set" alongside the
// rep's own overrides in a single round-trip.
//
// JSONB writes use jsonb_set so only the prospecting_config key is touched —
// the rest of settings / preferences (e.g. preferences.ui) is never clobbered.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const {
  sanitizeOrgConfig,
  sanitizeUserConfig,
  emptyOrgConfig,
  emptyUserConfig,
} = require('../config/prospectingConfigSchema');

router.use(authenticateToken);
router.use(orgContext);

const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────────────────────
// GET /org — current org-level prospecting_config (sanitized).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/org', adminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT settings FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const raw = r.rows[0]?.settings?.prospecting_config || null;
    res.json({ config: sanitizeOrgConfig(raw) });
  } catch (err) {
    console.error('prospecting-config GET /org:', err);
    res.status(500).json({ error: { message: 'Failed to load org config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /org — replace the org-level prospecting_config.
// Body: { config: { ...org shape... } }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/org', adminOnly, async (req, res) => {
  try {
    if (!req.body || typeof req.body.config !== 'object') {
      return res.status(400).json({ error: { message: 'config object is required' } });
    }
    const clean = sanitizeOrgConfig(req.body.config);

    // jsonb_set onto settings — only the prospecting_config key is replaced.
    const r = await pool.query(
      `UPDATE organizations
          SET settings = jsonb_set(
                COALESCE(settings, '{}'::jsonb),
                '{prospecting_config}',
                $2::jsonb,
                true
              )
        WHERE id = $1
      RETURNING settings`,
      [req.orgId, JSON.stringify(clean)]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: { message: 'Organization not found' } });
    }
    res.json({ config: sanitizeOrgConfig(r.rows[0].settings?.prospecting_config) });
  } catch (err) {
    console.error('prospecting-config PUT /org:', err);
    res.status(500).json({ error: { message: 'Failed to save org config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — the caller's user-level config, PLUS the org baseline and the org
// competitor list (so the per-user editor renders in one round-trip).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const userId = req.user.userId;

    const [upRes, orgRes, compRes] = await Promise.all([
      pool.query(
        `SELECT preferences FROM user_preferences
          WHERE user_id = $1 AND org_id = $2`,
        [userId, req.orgId]
      ),
      pool.query(
        `SELECT settings FROM organizations WHERE id = $1`,
        [req.orgId]
      ),
      pool.query(
        `SELECT id, name FROM competitors WHERE org_id = $1 ORDER BY name`,
        [req.orgId]
      ),
    ]);

    const userRaw = upRes.rows[0]?.preferences?.prospecting_config || null;
    const orgRaw  = orgRes.rows[0]?.settings?.prospecting_config   || null;

    res.json({
      config:        sanitizeUserConfig(userRaw),
      org_baseline:  sanitizeOrgConfig(orgRaw),
      org_competitors: compRes.rows.map(c => ({ id: c.id, name: c.name })),
    });
  } catch (err) {
    console.error('prospecting-config GET /me:', err);
    res.status(500).json({ error: { message: 'Failed to load your config' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /me — replace the caller's user-level config.
// Body: { config: { ...user shape... } }
//
// Deep-merge into preferences: jsonb_set writes ONLY the prospecting_config
// key, leaving preferences.ui (owned by user-preferences.routes.js) untouched.
// Upsert because the user may not yet have a user_preferences row.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/me', async (req, res) => {
  try {
    if (!req.body || typeof req.body.config !== 'object') {
      return res.status(400).json({ error: { message: 'config object is required' } });
    }
    const userId = req.user.userId;
    const clean  = sanitizeUserConfig(req.body.config);

    const r = await pool.query(
      `INSERT INTO user_preferences (user_id, org_id, preferences, updated_at)
       VALUES (
         $1, $2,
         jsonb_set('{}'::jsonb, '{prospecting_config}', $3::jsonb, true),
         CURRENT_TIMESTAMP
       )
       ON CONFLICT (user_id, org_id) DO UPDATE
         SET preferences = jsonb_set(
               COALESCE(user_preferences.preferences, '{}'::jsonb),
               '{prospecting_config}',
               $3::jsonb,
               true
             ),
             updated_at = CURRENT_TIMESTAMP
       RETURNING preferences`,
      [userId, req.orgId, JSON.stringify(clean)]
    );
    res.json({ config: sanitizeUserConfig(r.rows[0].preferences?.prospecting_config) });
  } catch (err) {
    console.error('prospecting-config PUT /me:', err);
    res.status(500).json({ error: { message: 'Failed to save your config' } });
  }
});

module.exports = router;
