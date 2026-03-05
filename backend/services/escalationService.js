// services/escalationService.js
//
// Core logic for action escalation.
// Called by escalationJob.js (Bull processor) and escalationScheduler.js (cron).
//
// Responsibilities:
//   1. Find overdue actions — by org or across all orgs
//   2. Resolve notification recipients — manager / team / specific users
//   3. Create in-app notifications
//   4. Mark immediate escalations as sent (so they only fire once)

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// OVERDUE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all orgs that have at least one active org member with escalation enabled.
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
 * Find actions eligible for an IMMEDIATE escalation alert.
 *
 * Rules:
 *   - status = 'pending'
 *   - due_date IS NOT NULL and has passed
 *   - escalation_sent_at IS NULL (never escalated before)
 *   - The action owner has immediate_alert enabled in their prefs
 *   - The action passed due_date more than `immediate_hours` ago
 *
 * Returns rows grouped by user, enriched with user prefs.
 */
async function findActionsForImmediateEscalation(orgId) {
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
      COALESCE(up.preferences->'escalation', '{}'::jsonb) AS esc_prefs
    FROM actions a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN user_preferences up ON up.user_id = a.user_id
    WHERE a.org_id  = $1
      AND a.status  = 'pending'
      AND a.due_date IS NOT NULL
      AND a.due_date < NOW()
      AND a.escalation_sent_at IS NULL
      AND a.deleted_at IS NULL
      AND COALESCE((up.preferences->'escalation'->>'immediate_alert')::boolean, true) = true
      AND a.due_date < NOW() - (
        COALESCE((up.preferences->'escalation'->>'immediate_hours')::int, 24)
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
      COALESCE(up.preferences->'escalation', '{}'::jsonb) AS esc_prefs
    FROM actions a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN user_preferences up ON up.user_id = a.user_id
    WHERE a.org_id  = $1
      AND a.status  = 'pending'
      AND a.due_date IS NOT NULL
      AND a.due_date < NOW()
      AND a.deleted_at IS NULL
      AND COALESCE((up.preferences->'escalation'->>'daily_digest')::boolean, true) = true
    ORDER BY a.user_id, a.due_date ASC
  `, [orgId]);

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve who should be notified for an escalation event.
 *
 * recipientMode:
 *   'reporting_manager' — the user's solid-line manager in org_hierarchy
 *   'team'              — all of the user's solid-line subordinates
 *   'specific_users'    — the specificUserIds array
 *   'none'              — only the action owner
 *
 * Always returns a de-duped array of user IDs to notify.
 * The action owner is always included.
 */
async function resolveRecipients(orgId, actionOwnerId, recipientMode, specificUserIds = []) {
  const recipients = new Set([actionOwnerId]);

  if (recipientMode === 'reporting_manager') {
    // Look up solid-line manager in org_hierarchy
    const { rows } = await pool.query(`
      SELECT reports_to AS manager_id
      FROM org_hierarchy
      WHERE org_id = $1
        AND user_id = $2
        AND relationship_type = 'solid'
        AND reports_to IS NOT NULL
      LIMIT 1
    `, [orgId, actionOwnerId]);

    if (rows[0]?.manager_id) {
      recipients.add(rows[0].manager_id);
    }

  } else if (recipientMode === 'team') {
    // Everyone who reports (solid) to the same manager, plus the manager
    const { rows: managerRows } = await pool.query(`
      SELECT reports_to AS manager_id
      FROM org_hierarchy
      WHERE org_id = $1 AND user_id = $2 AND relationship_type = 'solid'
      LIMIT 1
    `, [orgId, actionOwnerId]);

    if (managerRows[0]?.manager_id) {
      const managerId = managerRows[0].manager_id;
      recipients.add(managerId);

      // All solid-line direct reports of that manager
      const { rows: teamRows } = await pool.query(`
        SELECT user_id FROM org_hierarchy
        WHERE org_id = $1 AND reports_to = $2 AND relationship_type = 'solid'
      `, [orgId, managerId]);

      teamRows.forEach(r => recipients.add(r.user_id));
    }

  } else if (recipientMode === 'specific_users' && specificUserIds.length > 0) {
    // Validate they all belong to this org before adding
    const { rows } = await pool.query(`
      SELECT user_id FROM org_users
      WHERE org_id = $1 AND user_id = ANY($2) AND is_active = TRUE
    `, [orgId, specificUserIds]);

    rows.forEach(r => recipients.add(r.user_id));
  }

  // 'none' mode: only action owner (already in set)

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
  return notif;
}

/**
 * Mark a single action's immediate escalation as sent.
 * Prevents duplicate immediate alerts.
 */
async function markEscalationSent(actionId) {
  await pool.query(`
    UPDATE actions SET escalation_sent_at = NOW()
    WHERE id = $1 AND escalation_sent_at IS NULL
  `, [actionId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS IMMEDIATE ESCALATIONS (called by Bull job processor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process immediate escalation for a single action.
 * Called by escalationJob processor for type='immediate'.
 */
async function processImmediateEscalation(orgId, actionId) {
  // Re-fetch action to confirm it's still pending and not already escalated
  const { rows: [action] } = await pool.query(`
    SELECT a.*, u.first_name, u.last_name,
           COALESCE(up.preferences->'escalation', '{}'::jsonb) AS esc_prefs
    FROM actions a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN user_preferences up ON up.user_id = a.user_id
    WHERE a.id = $1 AND a.org_id = $2
  `, [actionId, orgId]);

  if (!action) return { skipped: true, reason: 'action_not_found' };
  if (action.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (action.escalation_sent_at) return { skipped: true, reason: 'already_escalated' };

  const escPrefs = typeof action.esc_prefs === 'string'
    ? JSON.parse(action.esc_prefs)
    : action.esc_prefs;

  const recipientMode   = escPrefs.recipient_mode || 'reporting_manager';
  const specificUserIds = escPrefs.specific_user_ids || [];

  const recipients = await resolveRecipients(orgId, action.user_id, recipientMode, specificUserIds);

  const overdueHours  = Math.round((Date.now() - new Date(action.due_date).getTime()) / 3600000);
  const ownerName     = `${action.first_name} ${action.last_name}`;
  const dueStr        = new Date(action.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  const notifCount = { created: 0 };
  for (const recipientId of recipients) {
    const isOwner = recipientId === action.user_id;
    const title   = isOwner
      ? `Overdue action: ${action.title}`
      : `Overdue action from ${ownerName}: ${action.title}`;
    const body    = isOwner
      ? `This action was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`
      : `${ownerName}'s action "${action.title}" was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`;

    await createNotification(
      orgId, recipientId,
      'escalation_immediate',
      title, body,
      'action', action.id,
      { action_user_id: action.user_id, deal_id: action.deal_id, overdue_hours: overdueHours }
    );
    notifCount.created++;
  }

  await markEscalationSent(action.id);

  return {
    actionId,
    recipientCount: notifCount.created,
    recipients,
    overdueHours,
  };
}

/**
 * Process daily digest for a single user.
 * Called by escalationJob processor for type='daily_digest'.
 * overdueActions: array of action rows for this user.
 */
async function processDailyDigest(orgId, userId, overdueActions) {
  if (!overdueActions.length) return { skipped: true, reason: 'no_overdue' };

  const escPrefs = typeof overdueActions[0].esc_prefs === 'string'
    ? JSON.parse(overdueActions[0].esc_prefs)
    : overdueActions[0].esc_prefs;

  const recipientMode   = escPrefs.recipient_mode || 'reporting_manager';
  const specificUserIds = escPrefs.specific_user_ids || [];

  const recipients = await resolveRecipients(orgId, userId, recipientMode, specificUserIds);

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
      'escalation_digest',
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
  immediate_alert:   true,
  immediate_hours:   24,
  daily_digest:      true,
  recipient_mode:    'reporting_manager',
  specific_user_ids: [],
};

async function getUserEscalationPrefs(userId) {
  const { rows: [row] } = await pool.query(`
    SELECT preferences->'escalation' AS esc
    FROM user_preferences
    WHERE user_id = $1
  `, [userId]);

  const saved = row?.esc ? (typeof row.esc === 'string' ? JSON.parse(row.esc) : row.esc) : {};
  return { ...DEFAULT_PREFS, ...saved };
}

async function setUserEscalationPrefs(userId, patch) {
  const allowed = ['immediate_alert', 'immediate_hours', 'daily_digest', 'recipient_mode', 'specific_user_ids'];
  const safe    = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) safe[key] = patch[key];
  }

  // Validate
  if (safe.immediate_hours !== undefined) {
    safe.immediate_hours = Math.max(1, Math.min(168, parseInt(safe.immediate_hours) || 24));
  }
  if (safe.recipient_mode !== undefined) {
    const valid = ['reporting_manager', 'team', 'specific_users', 'none'];
    if (!valid.includes(safe.recipient_mode)) safe.recipient_mode = 'reporting_manager';
  }
  if (safe.specific_user_ids !== undefined) {
    safe.specific_user_ids = Array.isArray(safe.specific_user_ids)
      ? safe.specific_user_ids.filter(id => Number.isInteger(id))
      : [];
  }

  // Upsert user_preferences row if missing
  await pool.query(`
    INSERT INTO user_preferences (user_id, preferences)
    VALUES ($1, jsonb_build_object('escalation', $2::jsonb))
    ON CONFLICT (user_id) DO UPDATE
    SET preferences = jsonb_set(
      COALESCE(user_preferences.preferences, '{}'::jsonb),
      '{escalation}',
      COALESCE(user_preferences.preferences->'escalation', '{}'::jsonb) || $2::jsonb
    )
  `, [userId, JSON.stringify(safe)]);

  return getUserEscalationPrefs(userId);
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

module.exports = {
  getActiveOrgIds,
  findActionsForImmediateEscalation,
  findActionsForDailyDigest,
  resolveRecipients,
  createNotification,
  markEscalationSent,
  processImmediateEscalation,
  processDailyDigest,
  getUserEscalationPrefs,
  setUserEscalationPrefs,
  getNotifications,
  markNotificationsRead,
};
