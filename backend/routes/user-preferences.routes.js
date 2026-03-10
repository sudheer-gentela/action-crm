/**
 * user-preferences.routes.js
 *
 * GET  /users/me/preferences         — return current user's ui_preferences merged with defaults
 * PATCH /users/me/preferences        — deep-merge supplied keys into ui_preferences
 *
 * Lives at: routes/user-preferences.routes.js
 * Mount in server.js:
 *   app.use('/api/users/me', require('./routes/user-preferences.routes'));
 *
 * Auth: requireAuth middleware (same as all other routes).
 * No org-admin requirement — every user can read/write their own prefs.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

// ── Defaults — applied when a key is missing from the stored JSONB ────────────
const UI_PREF_DEFAULTS = {
  // Actions — Recently Generated panel
  actions_show_sparkline:   false,
  actions_recent_windows:   ['12h', '1d', '1w'],
};

// ── GET /users/me/preferences ─────────────────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ui_preferences FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const stored = result.rows[0].ui_preferences || {};
    // Merge stored over defaults so new keys always have a sensible value
    const preferences = { ...UI_PREF_DEFAULTS, ...stored };

    res.json({ preferences });
  } catch (error) {
    console.error('GET /users/me/preferences error:', error);
    res.status(500).json({ error: { message: 'Failed to load preferences' } });
  }
});

// ── PATCH /users/me/preferences ───────────────────────────────────────────────
// Body: { actions_show_sparkline: true } — only supplied keys are updated.
// Uses jsonb_strip_nulls + || operator for a proper deep merge.
router.patch('/preferences', async (req, res) => {
  try {
    const updates = req.body;

    // Whitelist to only known pref keys — prevents arbitrary JSONB injection
    const allowed = Object.keys(UI_PREF_DEFAULTS);
    const filtered = {};
    for (const key of allowed) {
      if (key in updates) filtered[key] = updates[key];
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: { message: 'No valid preference keys supplied' } });
    }

    const result = await db.query(
      `UPDATE users
       SET ui_preferences = ui_preferences || $1::jsonb,
           updated_at     = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING ui_preferences`,
      [JSON.stringify(filtered), req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const stored = result.rows[0].ui_preferences || {};
    const preferences = { ...UI_PREF_DEFAULTS, ...stored };

    res.json({ preferences });
  } catch (error) {
    console.error('PATCH /users/me/preferences error:', error);
    res.status(500).json({ error: { message: 'Failed to save preferences' } });
  }
});

module.exports = router;
