/**
 * user-preferences.routes.js
 *
 * GET  /users/me/preferences   — return current user's UI prefs (merged with defaults)
 * PATCH /users/me/preferences  — deep-merge supplied keys into prefs
 *
 * Storage: user_preferences.preferences->'ui' JSONB
 * PK is (user_id, org_id) — both are required for all queries.
 *
 * Mount in server.js:
 *   app.use('/api/users/me', require('./routes/user-preferences.routes'));
 */

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

// ── Defaults — merged at read time so new keys always have a value ─────────
const UI_PREF_DEFAULTS = {
  actions_show_sparkline:  false,
  actions_recent_windows:  ['12h', '1d', '1w'],
};

// ── Helper ────────────────────────────────────────────────────────────────
async function getUiPrefs(userId, orgId) {
  const { rows: [row] } = await db.query(
    `SELECT preferences->'ui' AS ui
     FROM user_preferences
     WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId]
  );
  const stored = row?.ui
    ? (typeof row.ui === 'string' ? JSON.parse(row.ui) : row.ui)
    : {};
  return { ...UI_PREF_DEFAULTS, ...stored };
}

// ── GET /users/me/preferences ─────────────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    const preferences = await getUiPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('GET /users/me/preferences error:', error);
    res.status(500).json({ error: { message: 'Failed to load preferences' } });
  }
});

// ── PATCH /users/me/preferences ───────────────────────────────────────────
router.patch('/preferences', async (req, res) => {
  try {
    const allowed  = Object.keys(UI_PREF_DEFAULTS);
    const filtered = {};
    for (const key of allowed) {
      if (key in req.body) filtered[key] = req.body[key];
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: { message: 'No valid preference keys supplied' } });
    }

    // Upsert on composite PK (user_id, org_id) — merges only the 'ui' key
    await db.query(`
      INSERT INTO user_preferences (user_id, org_id, preferences)
      VALUES ($1, $2, jsonb_build_object('ui', $3::jsonb))
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET preferences = jsonb_set(
        COALESCE(user_preferences.preferences, '{}'::jsonb),
        '{ui}',
        COALESCE(user_preferences.preferences->'ui', '{}'::jsonb) || $3::jsonb
      ),
      updated_at = CURRENT_TIMESTAMP
    `, [req.user.userId, req.orgId, JSON.stringify(filtered)]);

    const preferences = await getUiPrefs(req.user.userId, req.orgId);
    res.json({ preferences });
  } catch (error) {
    console.error('PATCH /users/me/preferences error:', error);
    res.status(500).json({ error: { message: 'Failed to save preferences' } });
  }
});

module.exports = router;
