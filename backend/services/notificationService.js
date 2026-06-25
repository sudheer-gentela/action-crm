// services/notificationService.js
//
// Core logic for action notification.
// Called by notificationJob.js (Bull processor) and notificationScheduler.js (cron).
//
// Responsibilities:
//   1. Find overdue actions — by org or across all orgs
//   2. Resolve notification recipients — manager / team / specific users
//   3. Create in-app notifications
//   4. Mark immediate notifications as sent (so they only fire once)

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// OVERDUE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all orgs that have at least one active org member with notification enabled.
 * Used by the scheduler to know which orgs to scan.
 */
async function getActiveOrgIds() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ou.org_id
    FROM org_users ou
    WHERE ou.is_active = TRUE
  `);
  return rows.map(r => r.org_id);
}

/**
 * Find actions eligible for an IMMEDIATE notification alert.
 *
 * Rules:
 *   - status = 'pending'
 *   - due_date IS NOT NULL and has passed
 *   - notification_sent_at IS NULL (never escalated before)
 *   - The action owner has immediate_alert enabled in their prefs
 *   - The action passed due_date more than `immediate_hours` ago
 *
 * Returns rows grouped by user, enriched with user prefs.
 */
async function findActionsForImmediateNotification(orgId) {
  const { rows } = await pool.query(`
    SELECT
      a.id           AS action_id,
      a.title        AS action_title,
      a.due_date,
      a.status,
      a.user_id,
      a.deal_id,
      a.org_id,
      u.first_name,
      u.last_name,
      u.email,
      COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs
    FROM actions a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN user_preferences up ON up.user_id = a.user_id AND up.org_id = a.org_id
    WHERE a.org_id  = $1
      AND a.status  = 'pending'
      AND a.due_date IS NOT NULL
      AND a.due_date < NOW()
      AND a.notification_sent_at IS NULL
      AND COALESCE((up.preferences->'notifications'->>'immediate_alert')::boolean, true) = true
      AND a.due_date < NOW() - (
        COALESCE((up.preferences->'notifications'->>'immediate_hours')::int, 24)
        * INTERVAL '1 hour'
      )
    ORDER BY a.user_id, a.due_date ASC
  `, [orgId]);

  return rows;
}

/**
 * Find actions for the DAILY DIGEST.
 *
 * Returns ALL overdue pending actions for users who have daily_digest enabled,
 * grouped by user. No sent-at filter — digest fires every day.
 */
async function findActionsForDailyDigest(orgId) {
  const { rows } = await pool.query(`
    SELECT
      a.id           AS action_id,
      a.title        AS action_title,
      a.due_date,
      a.status,
      a.user_id,
      a.deal_id,
      a.org_id,
      u.first_name,
      u.last_name,
      u.email,
      COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs
    FROM actions a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN user_preferences up ON up.user_id = a.user_id AND up.org_id = a.org_id
    WHERE a.org_id  = $1
      AND a.status  = 'pending'
      AND a.due_date IS NOT NULL
      AND a.due_date < NOW()
      AND COALESCE((up.preferences->'notifications'->>'daily_digest')::boolean, true) = true
    ORDER BY a.user_id, a.due_date ASC
  `, [orgId]);

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve who should be notified for a notification event.
 *
 * prefs shape: { notify_deal_team, notify_my_teams, fallback_mode, specific_user_ids }
 *
 * Resolution order — each step is additive (recipients accumulate):
 *   1. Action owner — always included
 *   2. Deal team    — if action has deal_id AND notify_deal_team=true
 *   3. Org teams    — if notify_my_teams=true, all members of every team the owner belongs to
 *   4. Fallback     — only if steps 2+3 added nobody new:
 *                       'reporting_manager' | 'specific_users' | 'none'
 */
async function resolveRecipients(orgId, actionOwnerId, prefs = {}, dealId = null) {
  const {
    notify_deal_team  = true,
    notify_my_teams   = true,
    fallback_mode     = 'reporting_manager',
    specific_user_ids = [],
  } = prefs;

  const recipients   = new Set([actionOwnerId]);
  let addedFromTeams = false;

  // ── Step 2: Deal team ─────────────────────────────────────────────────────
  if (dealId && notify_deal_team) {
    const { rows } = await pool.query(`
      SELECT dtm.user_id
      FROM deal_team_members dtm
      JOIN org_users ou ON ou.user_id = dtm.user_id AND ou.org_id = dtm.org_id
      WHERE dtm.deal_id = $1
        AND dtm.org_id  = $2
        AND ou.is_active = TRUE
    `, [dealId, orgId]);

    rows.forEach(r => {
      recipients.add(r.user_id);
      if (r.user_id !== actionOwnerId) addedFromTeams = true;
    });
  }

  // ── Step 3: Org teams the owner belongs to ────────────────────────────────
  if (notify_my_teams) {
    const { rows: teamRows } = await pool.query(`
      SELECT tm.team_id
      FROM team_memberships tm
      JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id  = $1
        AND tm.org_id   = $2
        AND t.is_active = TRUE
        AND t.org_id    = $2
    `, [actionOwnerId, orgId]);

    if (teamRows.length > 0) {
      const teamIds = teamRows.map(r => r.team_id);
      const { rows: memberRows } = await pool.query(`
        SELECT DISTINCT tm.user_id
        FROM team_memberships tm
        JOIN org_users ou ON ou.user_id = tm.user_id AND ou.org_id = tm.org_id
        WHERE tm.team_id = ANY($1)
          AND tm.org_id  = $2
          AND ou.is_active = TRUE
      `, [teamIds, orgId]);

      memberRows.forEach(r => {
        recipients.add(r.user_id);
        if (r.user_id !== actionOwnerId) addedFromTeams = true;
      });
    }
  }

  // ── Step 4: Fallback — only if nothing was added beyond the owner ─────────
  if (!addedFromTeams) {
    if (fallback_mode === 'reporting_manager') {
      const { rows } = await pool.query(`
        SELECT reports_to AS manager_id
        FROM org_hierarchy
        WHERE org_id = $1
          AND user_id = $2
          AND relationship_type = 'solid'
          AND reports_to IS NOT NULL
        LIMIT 1
      `, [orgId, actionOwnerId]);

      if (rows[0]?.manager_id) recipients.add(rows[0].manager_id);

    } else if (fallback_mode === 'specific_users' && specific_user_ids.length > 0) {
      const { rows } = await pool.query(`
        SELECT user_id FROM org_users
        WHERE org_id = $1 AND user_id = ANY($2) AND is_active = TRUE
      `, [orgId, specific_user_ids]);

      rows.forEach(r => recipients.add(r.user_id));
    }
    // 'none': only owner already in set
  }

  return Array.from(recipients);
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a single in-app notification.
 */
async function createNotification(orgId, userId, type, title, body, entityType, entityId, metadata = {}) {
  const { rows: [notif] } = await pool.query(`
    INSERT INTO notifications (org_id, user_id, type, title, body, entity_type, entity_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, created_at
  `, [orgId, userId, type, title, body, entityType || null, entityId || null, JSON.stringify(metadata)]);

  // Best-effort cross-channel fan-out (currently Slack). The in-app row above is
  // the source of truth; delivery runs on the worker queue so it can't slow or
  // break the notification write. Lazy require avoids a load-time cycle with
  // notificationJob (which requires this module).
  try {
    const { notificationQueue } = require('../jobs/notificationJob');
    notificationQueue.add(
      { type: 'slack_delivery', orgId, userId, notificationId: notif.id },
      { jobId: `slack-del-${notif.id}` }
    ).catch(err => console.warn('[notifications] slack enqueue failed:', err.message));
  } catch (err) {
    console.warn('[notifications] slack enqueue unavailable:', err.message);
  }

  return notif;
}

/**
 * Mark a single action's immediate notification as sent.
 * Prevents duplicate immediate alerts.
 */
async function markNotificationSent(actionId) {
  await pool.query(`
    UPDATE actions SET notification_sent_at = NOW()
    WHERE id = $1 AND notification_sent_at IS NULL
  `, [actionId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS IMMEDIATE ESCALATIONS (called by Bull job processor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process immediate notification for a single action.
 * Called by notificationJob processor for type='immediate'.
 */
async function processImmediateNotification(orgId, actionId) {
  // Re-fetch action to confirm it's still pending and not already escalated
  const { rows: [action] } = await pool.query(`
    SELECT a.*, u.first_name, u.last_name,
           COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs
    FROM actions a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN user_preferences up ON up.user_id = a.user_id AND up.org_id = a.org_id
    WHERE a.id = $1 AND a.org_id = $2
  `, [actionId, orgId]);

  if (!action) return { skipped: true, reason: 'action_not_found' };
  if (action.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (action.notification_sent_at) return { skipped: true, reason: 'already_escalated' };

  const notifPrefs = typeof action.esc_prefs === 'string'
    ? JSON.parse(action.esc_prefs)
    : (action.esc_prefs || {});

  const recipients = await resolveRecipients(orgId, action.user_id, notifPrefs, action.deal_id || null);

  const overdueHours  = Math.round((Date.now() - new Date(action.due_date).getTime()) / 3600000);
  const ownerName     = `${action.first_name} ${action.last_name}`;
  const dueStr        = new Date(action.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  // Fetch deal name if action is deal-linked (used in notification body)
  let dealName = null;
  if (action.deal_id) {
    const { rows: [deal] } = await pool.query(
      `SELECT name FROM deals WHERE id = $1 AND org_id = $2`,
      [action.deal_id, orgId]
    );
    dealName = deal?.name || null;
  }

  const dealContext = dealName ? ` (Deal: ${dealName})` : '';

  const notifCount = { created: 0 };
  for (const recipientId of recipients) {
    const isOwner = recipientId === action.user_id;
    const title   = isOwner
      ? `Overdue action: ${action.title}${dealContext}`
      : `Overdue action from ${ownerName}: ${action.title}${dealContext}`;
    const body    = isOwner
      ? `This action was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`
      : `${ownerName}'s action "${action.title}" was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`;

    await createNotification(
      orgId, recipientId,
      'notification_immediate',
      title, body,
      'action', action.id,
      { action_user_id: action.user_id, deal_id: action.deal_id, overdue_hours: overdueHours }
    );
    notifCount.created++;
  }

  await markNotificationSent(action.id);

  return {
    actionId,
    recipientCount: notifCount.created,
    recipients,
    overdueHours,
  };
}

/**
 * Process daily digest for a single user.
 * Called by notificationJob processor for type='daily_digest'.
 * overdueActions: array of action rows for this user.
 */
async function processDailyDigest(orgId, userId, overdueActions) {
  if (!overdueActions.length) return { skipped: true, reason: 'no_overdue' };

  const notifPrefs = typeof overdueActions[0].esc_prefs === 'string'
    ? JSON.parse(overdueActions[0].esc_prefs)
    : (overdueActions[0].esc_prefs || {});

  // For digest: pass null dealId — the digest covers all overdue actions which may
  // span multiple deals. Team membership + fallback handles routing correctly.
  const recipients = await resolveRecipients(orgId, userId, notifPrefs, null);

  const ownerName = `${overdueActions[0].first_name} ${overdueActions[0].last_name}`;
  const count     = overdueActions.length;

  // Build a short list: up to 5 action titles
  const preview = overdueActions
    .slice(0, 5)
    .map(a => `• ${a.action_title} (due ${new Date(a.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`)
    .join('\n');
  const moreCount = count > 5 ? `\n…and ${count - 5} more` : '';

  let notifCount = 0;
  for (const recipientId of recipients) {
    const isOwner = recipientId === userId;
    const title   = isOwner
      ? `You have ${count} overdue action${count > 1 ? 's' : ''}`
      : `${ownerName} has ${count} overdue action${count > 1 ? 's' : ''}`;
    const body    = `${preview}${moreCount}`;

    await createNotification(
      orgId, recipientId,
      'notification_digest',
      title, body,
      'action', null,
      { action_user_id: userId, action_ids: overdueActions.map(a => a.action_id), count }
    );
    notifCount++;
  }

  return {
    userId,
    overdueCount: count,
    recipientCount: notifCount,
    recipients,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PREFERENCES
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PREFS = {
  immediate_alert:               true,
  immediate_hours:               24,
  daily_digest:                  true,
  notify_deal_team:              true,
  notify_my_teams:               true,
  fallback_mode:                 'reporting_manager',
  specific_user_ids:             [],
  // Prospecting-specific toggles. Default ON — reps with overdue prospecting
  // actions get nudged unless they explicitly opt out. The org policy can
  // override this for the immediate-alert path (master kill-switch) but the
  // user toggle here lets individuals quiet just their own per-action alerts
  // without disabling the whole org.
  prospecting_immediate_alert:   true,
  prospecting_daily_digest:      true,
  // Delivery channels. Master switch per channel + per-category routing when on.
  // slack_enabled defaults OFF (opt-in); category defaults apply once a rep
  // turns Slack on. Digests are off by default — too noisy as DMs.
  channels: {
    slack_enabled:    false,
    slack_categories: { immediate: true, escalation: true, revisit: true, digest: false },
  },
};

async function getUserNotificationPrefs(userId, orgId) {
  const { rows: [row] } = await pool.query(`
    SELECT preferences->'notifications' AS esc
    FROM user_preferences
    WHERE user_id = $1
      AND org_id  = $2
  `, [userId, orgId]);

  const saved = row?.esc ? (typeof row.esc === 'string' ? JSON.parse(row.esc) : row.esc) : {};
  const merged = { ...DEFAULT_PREFS, ...saved };
  // channels needs a deep merge — a shallow spread would drop category defaults
  // for any sub-key the saved blob doesn't mention.
  const savedCh = saved.channels || {};
  merged.channels = {
    ...DEFAULT_PREFS.channels,
    ...savedCh,
    slack_categories: {
      ...DEFAULT_PREFS.channels.slack_categories,
      ...(savedCh.slack_categories || {}),
    },
  };
  return merged;
}

async function setUserNotificationPrefs(userId, orgId, patch) {
  const allowed = [
    'immediate_alert', 'immediate_hours', 'daily_digest',
    'notify_deal_team', 'notify_my_teams', 'fallback_mode', 'specific_user_ids',
    'prospecting_immediate_alert', 'prospecting_daily_digest',
    'channels',
  ];
  const safe    = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) safe[key] = patch[key];
  }

  // Validate
  if (safe.immediate_hours !== undefined) {
    safe.immediate_hours = Math.max(1, Math.min(168, parseInt(safe.immediate_hours) || 24));
  }
  if (safe.fallback_mode !== undefined) {
    const valid = ['reporting_manager', 'specific_users', 'none'];
    if (!valid.includes(safe.fallback_mode)) safe.fallback_mode = 'reporting_manager';
  }
  if (safe.specific_user_ids !== undefined) {
    safe.specific_user_ids = Array.isArray(safe.specific_user_ids)
      ? safe.specific_user_ids.filter(id => Number.isInteger(id))
      : [];
  }

  // Normalize the channels object to a complete, well-typed shape so we never
  // persist a partial blob. Frontend sends the full channels object on save.
  if (safe.channels !== undefined) {
    const inCh  = (safe.channels && typeof safe.channels === 'object') ? safe.channels : {};
    const inCat = (inCh.slack_categories && typeof inCh.slack_categories === 'object')
      ? inCh.slack_categories : {};
    const def   = DEFAULT_PREFS.channels;
    safe.channels = {
      slack_enabled: inCh.slack_enabled === undefined ? def.slack_enabled : !!inCh.slack_enabled,
      slack_categories: {
        immediate:  inCat.immediate  === undefined ? def.slack_categories.immediate  : !!inCat.immediate,
        escalation: inCat.escalation === undefined ? def.slack_categories.escalation : !!inCat.escalation,
        revisit:    inCat.revisit    === undefined ? def.slack_categories.revisit    : !!inCat.revisit,
        digest:     inCat.digest     === undefined ? def.slack_categories.digest     : !!inCat.digest,
      },
    };
  }

  // Upsert — conflict on composite PK (user_id, org_id)
  await pool.query(`
    INSERT INTO user_preferences (user_id, org_id, preferences)
    VALUES ($1, $2, jsonb_build_object('notifications', $3::jsonb))
    ON CONFLICT (user_id, org_id) DO UPDATE
    SET preferences = jsonb_set(
      COALESCE(user_preferences.preferences, '{}'::jsonb),
      '{notifications}',
      COALESCE(user_preferences.preferences->'notifications', '{}'::jsonb) || $3::jsonb
    ),
    updated_at = CURRENT_TIMESTAMP
  `, [userId, orgId, JSON.stringify(safe)]);

  return getUserNotificationPrefs(userId, orgId);
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS CRUD (for the /notifications API)
// ─────────────────────────────────────────────────────────────────────────────

async function getNotifications(userId, { unreadOnly = false, limit = 30, offset = 0 } = {}) {
  const conditions = ['user_id = $1'];
  const params     = [userId];

  if (unreadOnly) {
    conditions.push('read_at IS NULL');
  }

  const { rows } = await pool.query(`
    SELECT id, org_id, type, title, body, entity_type, entity_id,
           metadata, read_at, created_at
    FROM notifications
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, limit, offset]);

  const { rows: [countRow] } = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE read_at IS NULL) AS unread
    FROM notifications WHERE user_id = $1
  `, [userId]);

  return {
    notifications: rows,
    total:  parseInt(countRow.total),
    unread: parseInt(countRow.unread),
  };
}

async function markNotificationsRead(userId, notificationIds) {
  if (!notificationIds?.length) {
    // Mark ALL unread as read
    await pool.query(`
      UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND read_at IS NULL
    `, [userId]);
  } else {
    await pool.query(`
      UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL
    `, [userId, notificationIds]);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PROSPECTING — separate query + processor functions
//
// Mirrors the deal-action notification path but against prospecting_actions.
// Kept as separate functions (not generalized over a table name) because
// the JOINs, notification body language, and entity_type differ enough that
// a single parameterized version would be harder to read than two near-copies.
//
// Recipient resolution defers to ProspectingEscalationService — the tier
// semantics (rep / manager / skip-level) are policy concerns, not generic
// notification concerns.
// ═════════════════════════════════════════════════════════════════════════════

const ProspectingEscalationService = require('./prospectingEscalation.service');

// ── Find prospecting actions eligible for an IMMEDIATE alert ─────────────────
// Past due by more than the org's immediate_hours threshold AND not yet
// notified. User-level toggle is `prospecting_immediate_alert` in
// user_preferences.preferences->notifications (separate toggle from the
// deal-action `immediate_alert` so reps can opt in/out of each independently).
//
// Filter logic intentionally mirrors findActionsForImmediateNotification —
// any future change there should be considered for this function too.
async function findProspectingActionsForImmediateNotification(orgId, policy) {
  if (!policy.enabled || !policy.immediate_alert_enabled) return [];

  const { rows } = await pool.query(`
    SELECT
      pa.id           AS action_id,
      pa.title        AS action_title,
      pa.due_date,
      pa.status,
      pa.user_id,
      pa.org_id,
      pa.prospect_id,
      p.first_name    AS prospect_first_name,
      p.last_name     AS prospect_last_name,
      p.company_name  AS prospect_company,
      u.first_name,
      u.last_name,
      u.email,
      COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    LEFT JOIN user_preferences up
           ON up.user_id = pa.user_id AND up.org_id = pa.org_id
    WHERE pa.org_id              = $1
      AND pa.status              = 'pending'
      AND pa.due_date IS NOT NULL
      AND pa.due_date            < NOW()
      AND pa.notification_sent_at IS NULL
      AND COALESCE((up.preferences->'notifications'->>'prospecting_immediate_alert')::boolean, true) = true
      AND pa.due_date < NOW() - ($2::int * INTERVAL '1 hour')
    ORDER BY pa.user_id, pa.due_date ASC
  `, [orgId, policy.immediate_hours]);

  return rows;
}

// ── Find prospecting actions for the DAILY DIGEST ────────────────────────────
// All overdue pending actions for users who have the prospecting digest
// enabled. No sent-at filter — digest fires each day.
async function findProspectingActionsForDailyDigest(orgId, policy) {
  if (!policy.enabled || !policy.daily_digest_enabled) return [];

  const { rows } = await pool.query(`
    SELECT
      pa.id           AS action_id,
      pa.title        AS action_title,
      pa.due_date,
      pa.status,
      pa.user_id,
      pa.org_id,
      pa.prospect_id,
      p.first_name    AS prospect_first_name,
      p.last_name     AS prospect_last_name,
      p.company_name  AS prospect_company,
      u.first_name,
      u.last_name,
      u.email,
      COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    LEFT JOIN user_preferences up
           ON up.user_id = pa.user_id AND up.org_id = pa.org_id
    WHERE pa.org_id   = $1
      AND pa.status   = 'pending'
      AND pa.due_date IS NOT NULL
      AND pa.due_date < NOW()
      AND COALESCE((up.preferences->'notifications'->>'prospecting_daily_digest')::boolean, true) = true
    ORDER BY pa.user_id, pa.due_date ASC
  `, [orgId]);

  return rows;
}

// ── Find prospecting actions eligible for a TIER-N escalation bump ───────────
// Returns rows where:
//   - status = 'pending' (completed/snoozed/cancelled never escalate)
//   - due_date < NOW() - tier_N_hours
//   - escalation_tier < N  (don't re-escalate a row already at this tier or higher)
//
// Each row's `target_tier` is the tier that should be reached next. We compute
// the highest-eligible tier for each row in one pass, rather than running
// three separate queries — this is what the CASE expression in the SELECT
// does.
async function findProspectingActionsForEscalation(orgId, policy) {
  if (!policy.enabled) return [];

  const { rows } = await pool.query(`
    SELECT
      pa.id           AS action_id,
      pa.title        AS action_title,
      pa.due_date,
      pa.escalation_tier AS current_tier,
      pa.user_id,
      pa.org_id,
      pa.prospect_id,
      p.first_name    AS prospect_first_name,
      p.last_name     AS prospect_last_name,
      p.company_name  AS prospect_company,
      u.first_name,
      u.last_name,
      CASE
        WHEN pa.due_date < NOW() - ($4::int * INTERVAL '1 hour')
             AND pa.escalation_tier < 3 THEN 3
        WHEN pa.due_date < NOW() - ($3::int * INTERVAL '1 hour')
             AND pa.escalation_tier < 2 THEN 2
        WHEN pa.due_date < NOW() - ($2::int * INTERVAL '1 hour')
             AND pa.escalation_tier < 1 THEN 1
        ELSE 0
      END AS target_tier
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    WHERE pa.org_id   = $1
      AND pa.status   = 'pending'
      AND pa.due_date IS NOT NULL
      AND pa.escalation_tier < 3
      AND pa.due_date < NOW() - ($2::int * INTERVAL '1 hour')
    ORDER BY pa.due_date ASC
  `, [orgId, policy.tier1_hours, policy.tier2_hours, policy.tier3_hours]);

  // Drop rows where target_tier = 0 (would happen if a row's tier already
  // matches its eligible tier — defensive, shouldn't occur given the
  // WHERE clause but cheaper than retrying).
  return rows.filter(r => r.target_tier > 0);
}

// ── Mark a prospecting action notified ───────────────────────────────────────
async function markProspectingActionNotified(actionId) {
  await pool.query(
    `UPDATE prospecting_actions SET notification_sent_at = NOW() WHERE id = $1`,
    [actionId]
  );
}

// ── Mark a prospecting action escalated to a given tier ──────────────────────
async function markProspectingActionEscalated(actionId, tier) {
  await pool.query(
    `UPDATE prospecting_actions
        SET escalation_tier = $2,
            escalated_at    = NOW()
      WHERE id = $1
        AND escalation_tier < $2`,
    [actionId, tier]
  );
}

// ── Process an immediate alert for a single prospecting action ───────────────
async function processProspectingImmediateNotification(orgId, actionId) {
  const { rows: [action] } = await pool.query(`
    SELECT pa.*,
           p.first_name   AS prospect_first_name,
           p.last_name    AS prospect_last_name,
           p.company_name AS prospect_company,
           u.first_name,
           u.last_name
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    WHERE pa.id = $1 AND pa.org_id = $2
  `, [actionId, orgId]);

  if (!action) return { skipped: true, reason: 'action_not_found' };
  if (action.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (action.notification_sent_at) return { skipped: true, reason: 'already_notified' };

  // For immediate alerts on prospecting we notify only the owner (the rep).
  // Manager loops happen at tier 2 of the escalation path, not at the
  // immediate-alert step.
  const ownerName     = `${action.first_name} ${action.last_name}`;
  const prospectName  = `${action.prospect_first_name} ${action.prospect_last_name}`.trim();
  const overdueHours  = Math.round((Date.now() - new Date(action.due_date).getTime()) / 3600000);
  const dueStr        = new Date(action.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const prospectCtx   = prospectName ? ` for ${prospectName}` : '';

  await createNotification(
    orgId, action.user_id,
    'prospecting_immediate',
    `Overdue prospecting action: ${action.title}${prospectCtx}`,
    `This action was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`,
    'prospecting_action', action.id,
    {
      action_user_id: action.user_id,
      prospect_id:    action.prospect_id,
      overdue_hours:  overdueHours,
      channel:        action.channel,
    }
  );

  await markProspectingActionNotified(action.id);

  return {
    actionId,
    recipientCount: 1,
    recipients:     [action.user_id],
    overdueHours,
  };
}

// ── Process a daily digest for a single user across all their overdue
//    prospecting actions ───────────────────────────────────────────────────────
async function processProspectingDailyDigest(orgId, userId, overdueActions) {
  if (!overdueActions.length) return { skipped: true, reason: 'no_overdue' };

  const ownerName = `${overdueActions[0].first_name} ${overdueActions[0].last_name}`;
  const count     = overdueActions.length;

  const preview = overdueActions
    .slice(0, 5)
    .map(a => {
      const who = `${a.prospect_first_name || ''} ${a.prospect_last_name || ''}`.trim() || 'prospect';
      return `• ${a.action_title} — ${who}${a.prospect_company ? ` (${a.prospect_company})` : ''} (due ${new Date(a.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`;
    })
    .join('\n');
  const moreCount = count > 5 ? `\n…and ${count - 5} more` : '';

  // Digest only goes to the rep. Manager-level digest is a separate concern
  // we'd add later; today's design is: rep sees digest, manager sees
  // escalation notifications when tier 2 fires on any of their reports.
  await createNotification(
    orgId, userId,
    'prospecting_digest',
    `You have ${count} overdue prospecting action${count > 1 ? 's' : ''}`,
    `${preview}${moreCount}`,
    'prospecting_action', null,
    {
      action_user_id: userId,
      action_ids:     overdueActions.map(a => a.action_id),
      count,
    }
  );

  return {
    userId,
    overdueCount: count,
    recipientCount: 1,
    recipients:     [userId],
  };
}

// ── Process a tier-N escalation bump for a single prospecting action ─────────
// Resolves recipients via ProspectingEscalationService, writes notifications,
// and marks the action as escalated to the target tier.
//
// Called by the escalation cron — one job per (action, target_tier) pair.
async function processProspectingEscalation(orgId, actionId, targetTier) {
  const { rows: [action] } = await pool.query(`
    SELECT pa.*,
           p.first_name   AS prospect_first_name,
           p.last_name    AS prospect_last_name,
           p.company_name AS prospect_company,
           u.first_name,
           u.last_name
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    WHERE pa.id = $1 AND pa.org_id = $2
  `, [actionId, orgId]);

  if (!action) return { skipped: true, reason: 'action_not_found' };
  if (action.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (action.escalation_tier >= targetTier) return { skipped: true, reason: 'already_at_tier' };

  const recipients = await ProspectingEscalationService.resolveEscalationRecipients(
    orgId, action.user_id, targetTier
  );

  const ownerName     = `${action.first_name} ${action.last_name}`;
  const prospectName  = `${action.prospect_first_name} ${action.prospect_last_name}`.trim();
  const overdueHours  = Math.round((Date.now() - new Date(action.due_date).getTime()) / 3600000);
  const dueStr        = new Date(action.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const prospectCtx   = prospectName ? ` for ${prospectName}${action.prospect_company ? ` (${action.prospect_company})` : ''}` : '';

  // Tier text in the notification — helps the recipient understand why
  // they're being told now rather than at the original overdue point.
  const tierLabel = targetTier === 1 ? 'Reminder'
                  : targetTier === 2 ? 'Escalation'
                  : 'Final escalation';

  let notifCount = 0;
  for (const recipientId of recipients) {
    const isOwner = recipientId === action.user_id;
    const title = isOwner
      ? `${tierLabel}: ${action.title}${prospectCtx}`
      : `${tierLabel} — ${ownerName}'s action: ${action.title}${prospectCtx}`;
    const body = isOwner
      ? `This action was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`
      : `${ownerName}'s action "${action.title}" was due on ${dueStr} (${overdueHours}h ago) and is now at escalation tier ${targetTier}.`;

    await createNotification(
      orgId, recipientId,
      `prospecting_escalation_tier_${targetTier}`,
      title, body,
      'prospecting_action', action.id,
      {
        action_user_id: action.user_id,
        prospect_id:    action.prospect_id,
        overdue_hours:  overdueHours,
        tier:           targetTier,
        channel:        action.channel,
      }
    );
    notifCount++;
  }

  await markProspectingActionEscalated(action.id, targetTier);

  return {
    actionId,
    targetTier,
    recipientCount: notifCount,
    recipients:     [...recipients],
    overdueHours,
  };
}

module.exports = {
  // Deal-action path (unchanged)
  getActiveOrgIds,
  findActionsForImmediateNotification,
  findActionsForDailyDigest,
  resolveRecipients,
  createNotification,
  markNotificationSent,
  processImmediateNotification,
  processDailyDigest,
  getUserNotificationPrefs,
  setUserNotificationPrefs,
  getNotifications,
  markNotificationsRead,

  // Prospecting-action path (new)
  findProspectingActionsForImmediateNotification,
  findProspectingActionsForDailyDigest,
  findProspectingActionsForEscalation,
  markProspectingActionNotified,
  markProspectingActionEscalated,
  processProspectingImmediateNotification,
  processProspectingDailyDigest,
  processProspectingEscalation,
};
