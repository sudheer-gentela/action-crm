/**
 * /api/org/call-settings
 *
 * Org-admin endpoints for managing the call_settings JSONB on
 * org_action_config. Used by the "Call settings" sub-tab in
 * OrgAdminView > Prospecting.
 *
 *   GET    /                  Returns the org's current effective settings,
 *                             including the system defaults for any keys
 *                             the org hasn't overridden.
 *
 *   PATCH  /                  Updates settings. Allowed fields: outcomes
 *                             (full array replacement), edit_window_hours.
 *
 * Authorization: any org user can GET (so the prospect drawer can render
 * the outcomes list without an extra permission), but only admins can
 * PATCH. Admin check uses the same pattern as other org-admin routes.
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');
const CallSettingsService = require('../services/callSettings.service');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

// Admin gate for write operations. Matches the pattern in orgAdmin.routes
// and other admin-touching routes.
const adminOnly = requireRole('owner', 'admin');


// ── GET / — fetch effective settings ────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const settings = await CallSettingsService.getForOrg(req.orgId);
    return res.json({ settings });
  } catch (err) {
    console.error('org-call-settings GET error:', err);
    return res.status(500).json({ error: { message: 'Failed to fetch call settings' } });
  }
});


// ── PATCH / — update settings (admin only) ──────────────────────────────────
router.patch('/', adminOnly, async (req, res) => {
  try {
    const updated = await CallSettingsService.setForOrg(
      req.orgId,
      req.body || {},
      req.user.userId
    );
    return res.json({ settings: updated });
  } catch (err) {
    // Validation errors throw with descriptive messages; surface them as 400.
    // Anything else is a 500.
    const msg = err.message || 'Failed to update call settings';
    const isValidation = /must be|required|cannot|exceeds|duplicated|use|in use/i.test(msg);
    console.error('org-call-settings PATCH error:', err);
    return res.status(isValidation ? 400 : 500).json({ error: { message: msg } });
  }
});


module.exports = router;
