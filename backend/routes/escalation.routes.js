// routes/escalation.routes.js
// Escalation preference management + admin trigger endpoints.
// Mount in server.js: app.use('/api/escalation', require('./routes/escalation.routes'));

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const escalationService  = require('../services/escalationService');
const { escalationQueue } = require('../jobs/escalationJob');
const { pool }            = require('../config/database');

router.use(authenticateToken);
router.use(orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── User preferences ──────────────────────────────────────────────────────────

/**
 * GET /api/escalation/preferences
 * Returns the current user's escalation notification preferences.
 */
router.get('/preferences', async (req, res) => {
  try {
    const prefs = await escalationService.getUserEscalationPrefs(req.user.userId);
    res.json({ preferences: prefs });
  } catch (err) {
    console.error('GET /escalation/preferences error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/escalation/preferences
 * Update the current user's escalation preferences.
 * Body (all optional):
 *   immediate_alert:   boolean
 *   immediate_hours:   number (1–168)
 *   daily_digest:      boolean
 *   recipient_mode:    'reporting_manager' | 'team' | 'specific_users' | 'none'
 *   specific_user_ids: number[]
 */
router.patch('/preferences', async (req, res) => {
  try {
    const updated = await escalationService.setUserEscalationPrefs(req.user.userId, req.body);
    res.json({ preferences: updated });
  } catch (err) {
    console.error('PATCH /escalation/preferences error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Org members list (for specific_users selector) ────────────────────────────

/**
 * GET /api/escalation/org-members
 * Returns active org members for the "specific users" recipient selector.
 * Excludes the requesting user (they're always notified as the action owner).
 */
router.get('/org-members', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ou.user_id AS id,
             u.first_name || ' ' || u.last_name AS name,
             u.email
      FROM org_users ou
      JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1
        AND ou.is_active = TRUE
        AND ou.user_id != $2
      ORDER BY u.first_name, u.last_name
    `, [req.orgId, req.user.userId]);

    res.json({ members: rows });
  } catch (err) {
    console.error('GET /escalation/org-members error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Admin: manual trigger ─────────────────────────────────────────────────────

/**
 * POST /api/escalation/trigger/immediate
 * Admin-only: manually trigger an immediate escalation scan for this org.
 * Useful for testing without waiting for the cron.
 */
router.post('/trigger/immediate', adminOnly, async (req, res) => {
  try {
    const overdueActions = await escalationService.findActionsForImmediateEscalation(req.orgId);
    let queued = 0;

    for (const action of overdueActions) {
      await escalationQueue.add({
        type:     'immediate',
        orgId:    req.orgId,
        actionId: action.action_id,
      }, {
        jobId: `imm-manual-${req.orgId}-${action.action_id}-${Date.now()}`,
      });
      queued++;
    }

    res.json({ success: true, queued, found: overdueActions.length });
  } catch (err) {
    console.error('POST /escalation/trigger/immediate error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /api/escalation/trigger/digest
 * Admin-only: manually trigger a daily digest scan for this org.
 */
router.post('/trigger/digest', adminOnly, async (req, res) => {
  try {
    const overdueRows = await escalationService.findActionsForDailyDigest(req.orgId);

    const byUser = {};
    for (const row of overdueRows) {
      if (!byUser[row.user_id]) byUser[row.user_id] = [];
      byUser[row.user_id].push(row);
    }

    let queued = 0;
    for (const [userId, actions] of Object.entries(byUser)) {
      await escalationQueue.add({
        type:           'daily_digest',
        orgId:          req.orgId,
        userId:         parseInt(userId),
        overdueActions: actions,
      }, {
        jobId: `digest-manual-${req.orgId}-${userId}-${Date.now()}`,
      });
      queued++;
    }

    res.json({ success: true, queued, usersWithOverdue: Object.keys(byUser).length });
  } catch (err) {
    console.error('POST /escalation/trigger/digest error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
