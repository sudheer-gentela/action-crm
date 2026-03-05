// routes/teamNotifications.routes.js
//
// All team notification endpoints in one place.
// Mount in server.js: app.use('/api/team-notifications', require('./routes/teamNotifications.routes'));
//
// Endpoints:
//
//   Inbox (bell icon)
//   GET    /api/team-notifications                  — fetch notifications for current user
//   PATCH  /api/team-notifications/read             — mark multiple (or all) as read
//   PATCH  /api/team-notifications/:id/read         — mark one as read
//
//   Preferences
//   GET    /api/team-notifications/preferences      — get current user's preferences
//   PATCH  /api/team-notifications/preferences      — update preferences
//   GET    /api/team-notifications/org-members      — list members (for specific-users selector)
//
//   Admin triggers (testing / manual runs)
//   POST   /api/team-notifications/trigger/immediate  — admin: run immediate scan now
//   POST   /api/team-notifications/trigger/digest     — admin: run daily digest now

const express = require('express');
const router  = express.Router();
const authenticateToken     = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const notificationService   = require('../services/notificationService');
const { notificationQueue } = require('../jobs/notificationJob');
const { pool }              = require('../config/database');

router.use(authenticateToken);
router.use(orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── Inbox ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/team-notifications
 * Returns notifications for the current user.
 * Query params:
 *   unread=true   — only unread notifications
 *   limit=30      — max results (default 30, max 100)
 *   offset=0
 */
router.get('/', async (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const limit      = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset     = parseInt(req.query.offset) || 0;

    const result = await notificationService.getNotifications(
      req.user.userId,
      { unreadOnly, limit, offset }
    );
    res.json(result);
  } catch (err) {
    console.error('GET /team-notifications error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/team-notifications/read
 * Mark notifications as read.
 * Body: { ids: [1, 2, 3] }  — mark specific IDs
 *       {}                   — mark ALL unread as read
 */
router.patch('/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    await notificationService.markNotificationsRead(req.user.userId, ids);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /team-notifications/read error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/team-notifications/:id/read
 * Mark a single notification as read.
 */
router.patch('/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await notificationService.markNotificationsRead(req.user.userId, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /team-notifications/:id/read error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Preferences ───────────────────────────────────────────────────────────────

/**
 * GET /api/team-notifications/preferences
 * Returns the current user's notification preferences.
 */
router.get('/preferences', async (req, res) => {
  try {
    const prefs = await notificationService.getUserNotificationPrefs(req.user.userId);
    res.json({ preferences: prefs });
  } catch (err) {
    console.error('GET /team-notifications/preferences error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/team-notifications/preferences
 * Update the current user's notification preferences.
 * Body (all optional):
 *   immediate_alert:   boolean
 *   immediate_hours:   number (1–168)
 *   daily_digest:      boolean
 *   recipient_mode:    'reporting_manager' | 'specific_users' | 'none'
 *   specific_user_ids: number[]
 */
router.patch('/preferences', async (req, res) => {
  try {
    const updated = await notificationService.setUserNotificationPrefs(req.user.userId, req.body);
    res.json({ preferences: updated });
  } catch (err) {
    console.error('PATCH /team-notifications/preferences error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * GET /api/team-notifications/org-members
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
      WHERE ou.org_id    = $1
        AND ou.is_active = TRUE
        AND ou.user_id  != $2
      ORDER BY u.first_name, u.last_name
    `, [req.orgId, req.user.userId]);

    res.json({ members: rows });
  } catch (err) {
    console.error('GET /team-notifications/org-members error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Admin: manual triggers (for testing without waiting for cron) ─────────────

/**
 * POST /api/team-notifications/trigger/immediate
 * Admin-only: run the immediate notification scan for this org right now.
 */
router.post('/trigger/immediate', adminOnly, async (req, res) => {
  try {
    const overdueActions = await notificationService.findActionsForImmediateNotification(req.orgId);
    let queued = 0;

    for (const action of overdueActions) {
      await notificationQueue.add({
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
    console.error('POST /team-notifications/trigger/immediate error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /api/team-notifications/trigger/digest
 * Admin-only: run the daily digest scan for this org right now.
 */
router.post('/trigger/digest', adminOnly, async (req, res) => {
  try {
    const overdueRows = await notificationService.findActionsForDailyDigest(req.orgId);

    const byUser = {};
    for (const row of overdueRows) {
      if (!byUser[row.user_id]) byUser[row.user_id] = [];
      byUser[row.user_id].push(row);
    }

    let queued = 0;
    for (const [userId, actions] of Object.entries(byUser)) {
      await notificationQueue.add({
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
    console.error('POST /team-notifications/trigger/digest error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});


// ── My teams — single call for the NotificationSettings popup ─────────────────
//
// GET /api/team-notifications/my-teams
// Returns:
//   orgTeams:  [{ id, name, dimension, myRole, isPrimary, memberCount, description }]
//   dealTeams: [{ dealId, dealName, accountName, stage, myRole, members[] }]

router.get('/my-teams', async (req, res) => {
  const userId = req.user.userId;
  const orgId  = req.orgId;

  try {
    // Org teams this user belongs to
    const { rows: orgRows } = await pool.query(`
      SELECT
        t.id, t.name, t.dimension, t.description,
        tm.role        AS my_role,
        tm.is_primary,
        (SELECT COUNT(*)::int FROM team_memberships tm2
         WHERE tm2.team_id = t.id AND tm2.org_id = $2) AS member_count
      FROM team_memberships tm
      JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND tm.org_id  = $2
        AND t.is_active = TRUE
        AND t.org_id   = $2
      ORDER BY tm.is_primary DESC, t.name
    `, [userId, orgId]);

    // Active deals the user is on (exclude closed)
    const { rows: dealRows } = await pool.query(`
      SELECT
        d.id          AS deal_id,
        d.name        AS deal_name,
        d.stage,
        a.name        AS account_name,
        COALESCE(dtm.custom_role, r.name, 'Team member') AS my_role
      FROM deal_team_members dtm
      JOIN deals d      ON d.id  = dtm.deal_id
      LEFT JOIN accounts  a ON a.id  = d.account_id
      LEFT JOIN org_roles r ON r.id  = dtm.role_id
      WHERE dtm.user_id  = $1
        AND dtm.org_id   = $2
        AND d.deleted_at IS NULL
        AND d.stage NOT IN ('closed_won', 'closed_lost')
      ORDER BY d.name
    `, [userId, orgId]);

    // For each deal fetch the full member list so the popup can show teammates
    const dealTeams = [];
    for (const deal of dealRows) {
      const { rows: members } = await pool.query(`
        SELECT
          u.first_name || ' ' || u.last_name AS name,
          u.email,
          COALESCE(dtm.custom_role, r.name, 'Team member') AS role,
          (dtm.user_id = $1)                               AS is_me
        FROM deal_team_members dtm
        JOIN users u        ON u.id  = dtm.user_id
        LEFT JOIN org_roles r ON r.id  = dtm.role_id
        WHERE dtm.deal_id = $2 AND dtm.org_id = $3
        ORDER BY (dtm.user_id = $1) DESC, u.first_name
      `, [userId, deal.deal_id, orgId]);

      dealTeams.push({
        dealId:      deal.deal_id,
        dealName:    deal.deal_name,
        accountName: deal.account_name,
        stage:       deal.stage,
        myRole:      deal.my_role,
        members,
      });
    }

    res.json({
      orgTeams: orgRows.map(t => ({
        id:          t.id,
        name:        t.name,
        dimension:   t.dimension,
        description: t.description,
        myRole:      t.my_role || 'Member',
        isPrimary:   t.is_primary,
        memberCount: t.member_count,
      })),
      dealTeams,
    });
  } catch (err) {
    console.error('GET /team-notifications/my-teams error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
