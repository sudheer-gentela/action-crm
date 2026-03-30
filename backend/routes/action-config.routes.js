/**
 * action-config.routes.js
 *
 * Per-user action config — reads merged (org defaults + user overrides).
 *
 * GET  /api/action-config       — resolved config (org defaults merged in)
 * PATCH /api/action-config      — save user overrides (partial, JSONB merge)
 *
 * Register in server.js:
 *   app.use('/api/action-config', require('./routes/action-config.routes'));
 */

const express             = require('express');
const router              = express.Router();
const authenticateToken   = require('../middleware/auth.middleware');
const { orgContext }      = require('../middleware/orgContext.middleware');
const ActionConfigService = require('../services/actionConfig.service');

router.use(authenticateToken, orgContext);

// ── GET /api/action-config ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const config = await ActionConfigService.getConfigWithOrgDefaults(
      req.user.userId,
      req.orgId
    );
    res.json({ config });
  } catch (err) {
    console.error('GET /action-config error:', err.message);
    res.status(500).json({ error: { message: 'Failed to load action config' } });
  }
});

// ── PATCH /api/action-config ──────────────────────────────────────────────────
// Accepts any subset of fields. ai_settings is JSONB-merged, never overwritten.
// generation_mode accepts an array: ["playbook","rules","ai"] or [] for manual.

router.patch('/', async (req, res) => {
  try {
    const updates = req.body;

    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: { message: 'No update fields provided' } });
    }

    await ActionConfigService.updateConfig(req.user.userId, req.orgId, updates);

    // Return full merged config after save so frontend stays in sync
    const config = await ActionConfigService.getConfigWithOrgDefaults(
      req.user.userId,
      req.orgId
    );
    res.json({ config });
  } catch (err) {
    console.error('PATCH /action-config error:', err.message);
    if (err.message === 'No valid fields to update') {
      return res.status(400).json({ error: { message: err.message } });
    }
    res.status(500).json({ error: { message: 'Failed to update action config' } });
  }
});

module.exports = router;
