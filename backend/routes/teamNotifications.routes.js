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
const notificationDelivery  = require('../services/notificationDelivery.service');
const { notificationQueue } = require('../jobs/notificationJob');
const { pool }              = require('../config/database');

router.use(authenticateToken);
router.use(orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── Org config ────────────────────────────────────────────────────────────────
//
// GET /api/team-notifications/config
// PATCH /api/team-notifications/config   (admin)
//
// 2026_141. NotificationBell has called GET /config on every mount since it
// shipped, and this route did not exist — a 404 on every login, swallowed by
// the component's `.catch(() => {})`. So the poll interval was never
// configurable and every org has been on the client default.
//
// The key is settings->'notifications'->>'bell_poll_seconds', which is the key
// NotificationBell's own comment already names. Chosen from the client rather
// than invented here, so the two cannot disagree.
//
// READ is open to any authenticated user: the bell needs it before it can
// poll, and there is nothing sensitive in an interval that governs everyone
// equally. WRITE is admin, like the trigger routes below.

// Seconds. The floor exists because below it a bell is hammering the API for
// every logged-in user at once; the ceiling because past three hours it stops
// being a notification and becomes a page refresh.
const BELL_POLL_MIN     = 30;         // 30 seconds
const BELL_POLL_MAX     = 10800;      // 3 hours
const BELL_POLL_DEFAULT = 1800;       // 30 minutes

/**
 * Read the stored value, or the default.
 *
 * NEVER THROWS. Falls back on absent, malformed or out-of-range. A settings
 * blob is edited by people and by future code, and a bad value there should
 * narrow to the default rather than break the notification bell for everyone
 * in the org. Postgres returns NULL rather than erroring when the
 * 'notifications' key is missing entirely, so an org that has never set one
 * takes the same path as an org that set nonsense.
 */
async function resolveBellPoll(orgId) {
  try {
    const { rows } = await pool.query(
      `SELECT settings->'notifications'->>'bell_poll_seconds' AS v
         FROM organizations WHERE id = $1`, [orgId]);
    const n = parseInt(rows[0]?.v, 10);
    if (!Number.isInteger(n) || n < BELL_POLL_MIN || n > BELL_POLL_MAX) {
      return { pollSeconds: BELL_POLL_DEFAULT, isDefault: true };
    }
    return { pollSeconds: n, isDefault: false };
  } catch {
    return { pollSeconds: BELL_POLL_DEFAULT, isDefault: true };
  }
}

router.get('/config', async (req, res) => {
  const cfg = await resolveBellPoll(req.orgId);
  res.json({
    ...cfg,
    // Sent so the settings panel does not carry its own copy of the bounds.
    // Two definitions of "valid" is how a UI comes to accept a value the
    // server then rejects.
    min: BELL_POLL_MIN,
    max: BELL_POLL_MAX,
    default: BELL_POLL_DEFAULT,
  });
});

router.patch('/config', adminOnly, async (req, res) => {
  try {
    const n = parseInt(req.body?.pollSeconds, 10);
    if (!Number.isInteger(n) || n < BELL_POLL_MIN || n > BELL_POLL_MAX) {
      return res.status(400).json({
        error: `pollSeconds must be a whole number between ${BELL_POLL_MIN} and ${BELL_POLL_MAX}`,
      });
    }
    // jsonb_set with create_missing, NOT a whole-column write.
    // organizations.settings carries every module's configuration — dailywork's
    // reminder_hour and backfill_days among them — and replacing the column
    // from here would drop all of it. The merge happens in the database, so two
    // admins saving different modules at once cannot clobber each other.
    await pool.query(
      `UPDATE organizations
          SET settings = jsonb_set(
                COALESCE(settings, '{}'::jsonb),
                '{notifications,bell_poll_seconds}',
                to_jsonb($2::int),
                TRUE)
        WHERE id = $1`,
      [req.orgId, n]);

    const cfg = await resolveBellPoll(req.orgId);
    res.json({ ...cfg, min: BELL_POLL_MIN, max: BELL_POLL_MAX, default: BELL_POLL_DEFAULT });
  } catch (err) {
    console.error('PATCH /team-notifications/config error:', err);
    res.status(500).json({ error: 'Could not save that setting' });
  }
});

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
    const prefs = await notificationService.getUserNotificationPrefs(req.user.userId, req.orgId);
    const { rows: [u] } = await pool.query(
      `SELECT slack_email FROM users WHERE id = $1`, [req.user.userId]
    );
    res.json({ preferences: prefs, slack_email: u?.slack_email || '' });
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
    const updated = await notificationService.setUserNotificationPrefs(req.user.userId, req.orgId, req.body);
    res.json({ preferences: updated });
  } catch (err) {
    console.error('PATCH /team-notifications/preferences error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /api/team-notifications/test-slack
 * Sends a one-off test Slack DM to the requesting user, synchronously, so the UI
 * gets immediate pass/fail feedback. Exercises the REAL delivery path (install
 * lookup → email→Slack-ID resolution → chat.postMessage) but bypasses the
 * category filter (the user explicitly clicked "test"). Inserts the notification
 * row directly rather than via createNotification, so it does NOT also enqueue an
 * async delivery (which would double-send).
 */
/**
 * PATCH /api/team-notifications/slack-email
 * Sets (or clears, with empty string) the user's Slack email override — the
 * address used to match them on Slack when it differs from their login email.
 * Clears the cached slack_user_id so the next send re-resolves with the new email.
 */
router.patch('/slack-email', async (req, res) => {
  try {
    const raw = (req.body?.slack_email || '').trim();
    if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    await pool.query(
      `UPDATE users SET slack_email = $2, slack_user_id = NULL, slack_lookup_at = NULL WHERE id = $1`,
      [req.user.userId, raw || null]
    );
    res.json({ success: true, slack_email: raw });
  } catch (err) {
    console.error('PATCH /team-notifications/slack-email error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/test-slack', async (req, res) => {
  try {
    const orgId  = req.orgId;
    const userId = req.user.userId;

    const { rows: [notif] } = await pool.query(`
      INSERT INTO notifications (org_id, user_id, type, title, body, entity_type, entity_id, metadata)
      VALUES ($1, $2, 'slack_test', $3, $4, NULL, NULL, '{}'::jsonb)
      RETURNING id
    `, [
      orgId, userId,
      'Test notification from GoWarmCRM',
      'If you can see this in Slack, your Slack delivery is working. ✅',
    ]);

    const result = await notificationDelivery.deliverSlack(orgId, notif.id, { bypassPrefs: true });
    res.json({ success: true, result });
  } catch (err) {
    console.error('POST /team-notifications/test-slack error:', err);
    res.status(500).json({ success: false, error: err.message });
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
