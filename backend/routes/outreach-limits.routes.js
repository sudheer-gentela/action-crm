// ─────────────────────────────────────────────────────────────────────────────
// routes/outreach-limits.routes.js
//
// Org-level prospecting email ceiling configuration.
// Admin-only — reads/writes the org_integrations row for prospecting_email.
//
// Mount in server.js:
//   const outreachLimitsRoutes = require('./routes/outreach-limits.routes');
//   app.use('/api/org/outreach-limits', outreachLimitsRoutes);
// ─────────────────────────────────────────────────────────────────────────────

const express           = require('express');
const router            = express.Router();
const db                = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Admin guard ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'org_admin') {
    return res.status(403).json({ error: { message: 'Admin access required' } });
  }
  next();
}

// ── GET / — fetch current org ceiling config ──────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT config, updated_at FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );

    const config = result.rows[0]?.config || {
      dailyLimitCeiling:      100,
      minDelayMinutesCeiling: 2,
      defaultDailyLimit:      50,
      defaultMinDelayMinutes: 5,
    };

    res.json({
      limits: {
        dailyLimitCeiling:      config.dailyLimitCeiling      ?? 100,
        minDelayMinutesCeiling: config.minDelayMinutesCeiling ?? 2,
        defaultDailyLimit:      config.defaultDailyLimit      ?? 50,
        defaultMinDelayMinutes: config.defaultMinDelayMinutes ?? 5,
      },
      updatedAt: result.rows[0]?.updated_at || null,
    });
  } catch (error) {
    console.error('Get outreach limits error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch outreach limits' } });
  }
});

// ── PUT / — update org ceiling config ────────────────────────────────────────
router.put('/', requireAdmin, async (req, res) => {
  try {
    const {
      dailyLimitCeiling,
      minDelayMinutesCeiling,
      defaultDailyLimit,
      defaultMinDelayMinutes,
    } = req.body;

    // Validation
    const errors = [];
    if (dailyLimitCeiling !== undefined) {
      const v = parseInt(dailyLimitCeiling);
      if (isNaN(v) || v < 1 || v > 500) errors.push('dailyLimitCeiling must be between 1 and 500');
    }
    if (minDelayMinutesCeiling !== undefined) {
      const v = parseInt(minDelayMinutesCeiling);
      if (isNaN(v) || v < 0 || v > 120) errors.push('minDelayMinutesCeiling must be between 0 and 120');
    }
    if (defaultDailyLimit !== undefined) {
      const v = parseInt(defaultDailyLimit);
      if (isNaN(v) || v < 1) errors.push('defaultDailyLimit must be at least 1');
    }
    if (defaultMinDelayMinutes !== undefined) {
      const v = parseInt(defaultMinDelayMinutes);
      if (isNaN(v) || v < 0) errors.push('defaultMinDelayMinutes cannot be negative');
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: { message: errors.join('; ') } });
    }

    // Cross-validation: defaults must not exceed ceilings
    // We need to load current values to merge
    const current = await db.query(
      `SELECT config FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [req.orgId]
    );
    const existing = current.rows[0]?.config || {};

    const merged = {
      dailyLimitCeiling:      parseInt(dailyLimitCeiling)      ?? existing.dailyLimitCeiling      ?? 100,
      minDelayMinutesCeiling: parseInt(minDelayMinutesCeiling) ?? existing.minDelayMinutesCeiling ?? 2,
      defaultDailyLimit:      parseInt(defaultDailyLimit)      ?? existing.defaultDailyLimit      ?? 50,
      defaultMinDelayMinutes: parseInt(defaultMinDelayMinutes) ?? existing.defaultMinDelayMinutes ?? 5,
    };

    // Handle undefined (NaN from parseInt of undefined)
    if (isNaN(merged.dailyLimitCeiling))      merged.dailyLimitCeiling      = existing.dailyLimitCeiling      || 100;
    if (isNaN(merged.minDelayMinutesCeiling)) merged.minDelayMinutesCeiling = existing.minDelayMinutesCeiling || 2;
    if (isNaN(merged.defaultDailyLimit))      merged.defaultDailyLimit      = existing.defaultDailyLimit      || 50;
    if (isNaN(merged.defaultMinDelayMinutes)) merged.defaultMinDelayMinutes = existing.defaultMinDelayMinutes || 5;

    if (merged.defaultDailyLimit > merged.dailyLimitCeiling) {
      return res.status(400).json({
        error: { message: 'defaultDailyLimit cannot exceed dailyLimitCeiling' }
      });
    }
    if (merged.defaultMinDelayMinutes < merged.minDelayMinutesCeiling) {
      return res.status(400).json({
        error: { message: 'defaultMinDelayMinutes cannot be less than minDelayMinutesCeiling' }
      });
    }

    // Upsert
    const result = await db.query(
      `INSERT INTO org_integrations (org_id, integration_type, status, config, updated_at)
       VALUES ($1, 'prospecting_email', 'active', $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (org_id, integration_type) DO UPDATE
         SET config     = $2::jsonb,
             status     = 'active',
             updated_at = CURRENT_TIMESTAMP
       RETURNING config, updated_at`,
      [req.orgId, JSON.stringify(merged)]
    );

    console.log(`⚙️  Outreach limits updated for org ${req.orgId} by user ${req.user.userId}:`, merged);

    res.json({
      limits:    result.rows[0].config,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (error) {
    console.error('Update outreach limits error:', error);
    res.status(500).json({ error: { message: 'Failed to update outreach limits' } });
  }
});

module.exports = router;
