// ============================================================================
// routes/user-activation-target.routes.js
//
// Slice 2 — per-rep override of the LinkedIn daily activation cap.
//
// Stored as a single integer at
//   user_preferences.preferences.linkedin_daily_activation_target
//
// Read by services/prospecting-campaigns bulk-activate logic
// (resolveActivationLimits). Effective cap = min(userTarget || orgCap, orgCap).
//
// Mount in server.js:
//   const userActivationTargetRoutes = require('./routes/user-activation-target.routes');
//   app.use('/api/me/activation-target', userActivationTargetRoutes);
//
// Endpoints:
//   GET  /              → { target: number | null, orgCap: number, effective: number }
//   PUT  /              → body { target: number | null }   (null clears it)
// ============================================================================

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: load org cap (default 25) ────────────────────────────────────────
async function loadOrgCap(orgId) {
  const r = await pool.query(
    `SELECT config FROM org_integrations
      WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
    [orgId]
  );
  const cfg = r.rows[0]?.config || {};
  const cap = parseInt(cfg.linkedinDailyActivationCap, 10);
  return (Number.isFinite(cap) && cap > 0) ? cap : 25;
}

// ── GET / — current target + effective cap ───────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [prefsRes, orgCap] = await Promise.all([
      pool.query(
        `SELECT preferences FROM user_preferences WHERE user_id = $1 AND org_id = $2`,
        [req.user.userId, req.orgId]
      ),
      loadOrgCap(req.orgId),
    ]);

    const raw = prefsRes.rows[0]?.preferences?.linkedin_daily_activation_target;
    const target = (Number.isFinite(parseInt(raw, 10)) && parseInt(raw, 10) > 0)
      ? parseInt(raw, 10)
      : null;

    const effective = target !== null ? Math.min(target, orgCap) : orgCap;

    res.json({ target, orgCap, effective });
  } catch (err) {
    console.error('GET activation-target error:', err);
    res.status(500).json({ error: { message: 'Failed to load activation target' } });
  }
});

// ── PUT / — set or clear the target ──────────────────────────────────────────
router.put('/', async (req, res) => {
  try {
    const { target } = req.body || {};
    let value = null;
    if (target !== null && target !== undefined && target !== '') {
      const v = parseInt(target, 10);
      if (!Number.isFinite(v) || v < 1 || v > 200) {
        return res.status(400).json({
          error: { message: 'target must be between 1 and 200, or null to clear' },
        });
      }
      value = v;
    }

    // Upsert into user_preferences.
    if (value === null) {
      // Remove the key. Use jsonb - 'key' operator.
      await pool.query(
        `UPDATE user_preferences
            SET preferences = preferences - 'linkedin_daily_activation_target',
                updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND org_id = $2`,
        [req.user.userId, req.orgId]
      );
    } else {
      await pool.query(
        `INSERT INTO user_preferences (user_id, org_id, preferences, updated_at)
         VALUES (
           $1, $2,
           jsonb_set('{}'::jsonb, '{linkedin_daily_activation_target}', $3::jsonb, true),
           CURRENT_TIMESTAMP
         )
         ON CONFLICT (user_id, org_id) DO UPDATE
           SET preferences = jsonb_set(
                 COALESCE(user_preferences.preferences, '{}'::jsonb),
                 '{linkedin_daily_activation_target}',
                 $3::jsonb,
                 true
               ),
               updated_at = CURRENT_TIMESTAMP`,
        [req.user.userId, req.orgId, JSON.stringify(value)]
      );
    }

    const orgCap = await loadOrgCap(req.orgId);
    const effective = value !== null ? Math.min(value, orgCap) : orgCap;
    res.json({ target: value, orgCap, effective });
  } catch (err) {
    console.error('PUT activation-target error:', err);
    res.status(500).json({ error: { message: 'Failed to save activation target' } });
  }
});

module.exports = router;
