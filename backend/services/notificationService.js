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
    -- 2026_131: only ACTIVE org members are notified.
    -- These scans joined the users table alone, which has no notion of
    -- membership, so a deactivated user kept receiving digests forever.
    -- Harmless while notifications were in-app only; once email is a
    -- channel it mails people who have been removed, at addresses that may
    -- no longer exist and will hard-bounce. Membership is in org_users.
    JOIN org_users ou_act ON ou_act.user_id = a.user_id
                         AND ou_act.org_id  = a.org_id
                         AND ou_act.is_active = TRUE
    LEFT JOIN user_preferences up ON up.user_id = a.user_id AND up.org_id = a.org_id
    WHERE a.org_id  = $1
      -- B18: this read 'pending', which has never been a valid actions status
      -- (pre-70 the set was yet_to_start|in_progress|completed|snoozed), so this
      -- query matched zero rows and overdue alerts never fired. Canonical open
      -- states only; 'snoozed' is deliberate deferral and is not overdue, which
      -- matches the plays_overdue rule in handover_deliverable_rollup.
      AND a.status IN ('not_started', 'in_progress', 'blocked')
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
    -- 2026_131: only ACTIVE org members are notified.
    -- These scans joined the users table alone, which has no notion of
    -- membership, so a deactivated user kept receiving digests forever.
    -- Harmless while notifications were in-app only; once email is a
    -- channel it mails people who have been removed, at addresses that may
    -- no longer exist and will hard-bounce. Membership is in org_users.
    JOIN org_users ou_act ON ou_act.user_id = a.user_id
                         AND ou_act.org_id  = a.org_id
                         AND ou_act.is_active = TRUE
    LEFT JOIN user_preferences up ON up.user_id = a.user_id AND up.org_id = a.org_id
    WHERE a.org_id  = $1
      -- B18: see note above — 'pending' never matched. Canonical open states only.
      AND a.status IN ('not_started', 'in_progress', 'blocked')
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

    // Web push mirrors the same notification to the user's registered
    // browsers. Same queue, same best-effort contract as Slack above:
    // the in-app row is already written and is the source of truth.
    notificationQueue.add(
      { type: 'push_delivery', orgId, userId, notificationId: notif.id, title, body },
      { jobId: `push-del-${notif.id}` }
    ).catch(err => console.warn('[notifications] push enqueue failed:', err.message));

    // Email. Same queue, same best-effort contract as Slack and push above.
    // deliverEmail resolves the subject, body, category and address from the
    // notification row, so every notification type is reachable by email
    // without its call site knowing anything about email. It is gated behind
    // channels.email_enabled, which defaults FALSE, so adding this enqueue
    // sends nothing until a user opts in.
    notificationQueue.add(
      { type: 'email_delivery', orgId, userId, notificationId: notif.id },
      { jobId: `email-del-${notif.id}` }
    ).catch(err => console.warn('[notifications] email enqueue failed:', err.message));
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
    -- 2026_131: only ACTIVE org members are notified.
    -- These scans joined the users table alone, which has no notion of
    -- membership, so a deactivated user kept receiving digests forever.
    -- Harmless while notifications were in-app only; once email is a
    -- channel it mails people who have been removed, at addresses that may
    -- no longer exist and will hard-bounce. Membership is in org_users.
    JOIN org_users ou_act ON ou_act.user_id = a.user_id
                         AND ou_act.org_id  = a.org_id
                         AND ou_act.is_active = TRUE
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
    // Email (2026_130). Defaults ON, unlike Slack: email is the only channel
    // that reaches someone who is not currently in the app, and a submission
    // sitting unreviewed because email silently defaulted off is the failure
    // the review loop exists to prevent. Only the 'review' category is
    // dispatched today.
    // Email defaults OFF, mirroring slack_enabled. Email is the only
    // channel that reaches someone who is not in the app, which is exactly
    // why it is opt-in: mailing every user every notification by default is
    // how a product teaches people to filter it. In-app is the only channel
    // on by default, and it is always on.
    //
    // Category defaults apply ONCE the user turns email on — same contract
    // as slack_categories. 'digest' is true here where Slack has it false:
    // a daily overdue summary is a natural email and a noisy DM.
    email_enabled:    false,
    email_categories: {
      immediate: true, escalation: true, revisit: true,
      digest:    true, review:     true,
    },
    // 'immediate' sends on every review event; 'digest' batches them into
    // one mail per sweep. On a large project immediate is a lot of mail,
    // which is how a channel gets filtered to a folder and stops working.
    // Immediate is still the default: a review sitting unseen is the
    // failure this feature exists to prevent, and batching adds latency.
    review_email_mode: 'immediate',
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
    email_categories: {
      ...DEFAULT_PREFS.channels.email_categories,
      ...(savedCh.email_categories || {}),
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

// ── Agency Phase 5 client-name text helpers ──────────────────────────────────
// Appended to notification titles when the underlying action's prospect belongs
// to an agency client. Both return '' for a null/blank client name, so alerts
// for non-agency prospects (and every action in a non-agency org) render
// BYTE-IDENTICALLY to the pre-Phase-5 output.
function _clientTitleSuffix(clientName) {
  const name = (clientName || '').trim();
  return name ? ` · ${name}` : '';
}
// Group label for the digest's per-client sections. Prospects with no client
// fall into the "No client" bucket (matches the reporting rollup convention).
function _clientGroupLabel(clientName) {
  const name = (clientName || '').trim();
  return name || 'No client';
}

// ── Find prospecting actions eligible for an IMMEDIATE alert ─────────────────
// Past due by more than the org's immediate_hours threshold AND not yet
// notified. User-level toggle is `prospecting_immediate_alert` in
// user_preferences.preferences->notifications (separate toggle from the
// deal-action `immediate_alert` so reps can opt in/out of each independently).
//
// Filter logic intentionally mirrors findActionsForImmediateNotification —
// any future change there should be considered for this function too.
// Agency Phase 6: this scan now surfaces rows via TWO branches (see WHERE):
//   (a) the ordinary owner immediate alert (opted in + past immediate_hours) —
//       gated on the org's immediate_alert_enabled toggle, BYTE-IDENTICAL to
//       the pre-Phase-6 behaviour; and
//   (b) the client-sender-missing fast-path — a `sequence_send_failed` action
//       whose client requires its own mailbox and has no active client sender
//       RIGHT NOW (live re-derivation, self-healing). This fires as soon as the
//       action is overdue at all, INDEPENDENT of the owner's opt-in AND the
//       org's immediate_alert_enabled toggle, because a client-wide sending
//       block is a config gap that must reach the client lead fast — only the
//       master `enabled` kill-switch suppresses it. A client-less prospect /
//       non-agency org never satisfies branch (b), so its result set is
//       byte-identical to before. The processor RE-DERIVES the condition, so
//       `client_sender_missing` here is a scan filter, not the authority.
async function findProspectingActionsForImmediateNotification(orgId, policy) {
  if (!policy.enabled) return [];

  const { rows } = await pool.query(`
    WITH scanned AS (
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
        p.client_id,
        c.name          AS client_name,
        u.first_name,
        u.last_name,
        u.email,
        COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs,
        COALESCE((up.preferences->'notifications'->>'prospecting_immediate_alert')::boolean, true)
          AS owner_immediate_opt_in,
        (
          pa.source = 'sequence_send_failed'
          AND p.client_id IS NOT NULL
          AND c.require_client_sender = true
          AND NOT EXISTS (
            SELECT 1 FROM prospecting_sender_accounts psa
             WHERE psa.org_id    = pa.org_id
               AND psa.client_id = p.client_id
               AND psa.is_active = true
          )
        ) AS client_sender_missing
      FROM prospecting_actions pa
      JOIN prospects p ON p.id = pa.prospect_id
      JOIN users     u ON u.id = pa.user_id
      -- 2026_131: only ACTIVE org members are notified.
      -- These scans joined the users table alone, which has no notion of
      -- membership, so a deactivated user kept receiving alerts forever.
      -- Harmless while notifications were in-app only; once email is a
      -- channel it mails people who have been removed, at addresses that may
      -- no longer exist and will hard-bounce. Membership is in org_users.
      JOIN org_users ou_act ON ou_act.user_id = pa.user_id
                           AND ou_act.org_id  = pa.org_id
                           AND ou_act.is_active = TRUE
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN user_preferences up
             ON up.user_id = pa.user_id AND up.org_id = pa.org_id
      WHERE pa.org_id              = $1
        AND pa.status              = 'pending'
        AND pa.due_date IS NOT NULL
        AND pa.due_date            < NOW()
        AND pa.notification_sent_at IS NULL
    )
    SELECT
      action_id, action_title, due_date, status, user_id, org_id, prospect_id,
      prospect_first_name, prospect_last_name, prospect_company,
      client_id, client_name, first_name, last_name, email, esc_prefs,
      owner_immediate_opt_in, client_sender_missing
    FROM scanned
    WHERE
      -- (a) ordinary owner immediate alert (pre-Phase-6 gate, unchanged)
      ( $3::boolean = true
        AND owner_immediate_opt_in = true
        AND due_date < NOW() - ($2::int * INTERVAL '1 hour') )
      OR
      -- (b) client-sender-missing fast-path (overdue at all; opt-in/toggle-independent)
      client_sender_missing = true
    ORDER BY user_id, due_date ASC
  `, [orgId, policy.immediate_hours, policy.immediate_alert_enabled]);

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
      p.client_id,
      c.name          AS client_name,
      u.first_name,
      u.last_name,
      u.email,
      COALESCE(up.preferences->'notifications', '{}'::jsonb) AS esc_prefs
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    -- 2026_131: only ACTIVE org members are notified.
    -- These scans joined the users table alone, which has no notion of
    -- membership, so a deactivated user kept receiving digests forever.
    -- Harmless while notifications were in-app only; once email is a
    -- channel it mails people who have been removed, at addresses that may
    -- no longer exist and will hard-bounce. Membership is in org_users.
    JOIN org_users ou_act ON ou_act.user_id = pa.user_id
                         AND ou_act.org_id  = pa.org_id
                         AND ou_act.is_active = TRUE
    LEFT JOIN clients c ON c.id = p.client_id
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
//
// Agency Phase 5: tier thresholds are resolved PER CLIENT. A client may
// override tier{1,2,3}_hours via clients.escalation_overrides (2026_54); the
// `eligible` CTE COALESCEs each override over the org policy value ($2/$3/$4),
// so different clients in the same org climb the ladder at their own pace in
// ONE query. A prospect with no client (client_id NULL) LEFT-JOINs to no
// client row → every COALESCE falls through to the org value → BYTE-IDENTICAL
// to the pre-Phase-5 scan for non-agency orgs and client-less prospects.
// client_id / client_name ride along for the notification text + the
// recipient resolver (client-lead loop-in).
async function findProspectingActionsForEscalation(orgId, policy) {
  if (!policy.enabled) return [];

  const { rows } = await pool.query(`
    WITH eligible AS (
      SELECT
        pa.id              AS action_id,
        pa.title           AS action_title,
        pa.due_date,
        pa.escalation_tier AS current_tier,
        pa.user_id,
        pa.org_id,
        pa.prospect_id,
        p.first_name    AS prospect_first_name,
        p.last_name     AS prospect_last_name,
        p.company_name  AS prospect_company,
        p.client_id,
        cl.name         AS client_name,
        u.first_name,
        u.last_name,
        COALESCE((cl.escalation_overrides->>'tier1_hours')::int, $2::int) AS t1,
        COALESCE((cl.escalation_overrides->>'tier2_hours')::int, $3::int) AS t2,
        COALESCE((cl.escalation_overrides->>'tier3_hours')::int, $4::int) AS t3
      FROM prospecting_actions pa
      JOIN prospects p ON p.id = pa.prospect_id
      JOIN users     u ON u.id = pa.user_id
      -- 2026_131: only ACTIVE org members are notified.
      -- These scans joined the users table alone, which has no notion of
      -- membership, so a deactivated user kept receiving alerts forever.
      -- Harmless while notifications were in-app only; once email is a
      -- channel it mails people who have been removed, at addresses that may
      -- no longer exist and will hard-bounce. Membership is in org_users.
      JOIN org_users ou_act ON ou_act.user_id = pa.user_id
                           AND ou_act.org_id  = pa.org_id
                           AND ou_act.is_active = TRUE
      LEFT JOIN clients cl ON cl.id = p.client_id
      WHERE pa.org_id   = $1
        AND pa.status   = 'pending'
        AND pa.due_date IS NOT NULL
        AND pa.escalation_tier < 3
    )
    SELECT
      action_id, action_title, due_date, current_tier,
      user_id, org_id, prospect_id,
      prospect_first_name, prospect_last_name, prospect_company,
      client_id, client_name, first_name, last_name,
      CASE
        WHEN due_date < NOW() - (t3 * INTERVAL '1 hour')
             AND current_tier < 3 THEN 3
        WHEN due_date < NOW() - (t2 * INTERVAL '1 hour')
             AND current_tier < 2 THEN 2
        WHEN due_date < NOW() - (t1 * INTERVAL '1 hour')
             AND current_tier < 1 THEN 1
        ELSE 0
      END AS target_tier
    FROM eligible
    WHERE due_date < NOW() - (t1 * INTERVAL '1 hour')
    ORDER BY due_date ASC
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
// Agency Phase 6: two concerns handled here, both keyed off the ONE
// notification_sent_at guard so each fires at most once per action:
//   • Owner's ordinary immediate alert (existing type/copy) — respects the org
//     immediate_alert_enabled toggle AND the owner's opt-in, byte-identical to
//     before for non-sender-missing actions.
//   • Client team lead(s) fast-path alert (new type 'prospecting_client_sender_
//     blocked') — fires when the client-sender-missing condition is TRUE right
//     now (re-derived live, self-healing), independent of the owner's opt-in.
async function processProspectingImmediateNotification(orgId, actionId) {
  const { rows: [action] } = await pool.query(`
    SELECT pa.*,
           p.first_name   AS prospect_first_name,
           p.last_name    AS prospect_last_name,
           p.company_name AS prospect_company,
           p.client_id    AS client_id,
           cl.name        AS client_name,
           u.first_name,
           u.last_name,
           COALESCE((up.preferences->'notifications'->>'prospecting_immediate_alert')::boolean, true)
             AS owner_immediate_opt_in,
           (
             pa.source = 'sequence_send_failed'
             AND p.client_id IS NOT NULL
             AND cl.require_client_sender = true
             AND NOT EXISTS (
               SELECT 1 FROM prospecting_sender_accounts psa
                WHERE psa.org_id    = pa.org_id
                  AND psa.client_id = p.client_id
                  AND psa.is_active = true
             )
           ) AS client_sender_missing
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    -- 2026_131: only ACTIVE org members are notified.
    -- These scans joined the users table alone, which has no notion of
    -- membership, so a deactivated user kept receiving digests forever.
    -- Harmless while notifications were in-app only; once email is a
    -- channel it mails people who have been removed, at addresses that may
    -- no longer exist and will hard-bounce. Membership is in org_users.
    JOIN org_users ou_act ON ou_act.user_id = pa.user_id
                         AND ou_act.org_id  = pa.org_id
                         AND ou_act.is_active = TRUE
    LEFT JOIN clients cl ON cl.id = p.client_id
    LEFT JOIN user_preferences up
           ON up.user_id = pa.user_id AND up.org_id = pa.org_id
    WHERE pa.id = $1 AND pa.org_id = $2
  `, [actionId, orgId]);

  if (!action) return { skipped: true, reason: 'action_not_found' };
  if (action.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (action.notification_sent_at) return { skipped: true, reason: 'already_notified' };

  // Re-derive LIVE (never from a stored tag). If a mailbox was connected since
  // the scan surfaced this row, the condition is now false and the fast-path
  // self-heals — no lead alert fires.
  const senderMissing = action.client_sender_missing === true;
  const ownerOptedIn  = action.owner_immediate_opt_in === true;

  // immediate_hours governs the OWNER's ordinary alert only.
  const policy             = await ProspectingEscalationService.getForOrg(orgId);
  const dueMs              = new Date(action.due_date).getTime();
  const overdueHours       = Math.round((Date.now() - dueMs) / 3600000);
  const ownerPastImmediate = (Date.now() - dueMs) >= policy.immediate_hours * 3600000;

  const ownerName    = `${action.first_name} ${action.last_name}`;
  const prospectName = `${action.prospect_first_name} ${action.prospect_last_name}`.trim();
  const dueStr       = new Date(action.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const prospectCtx  = prospectName ? ` for ${prospectName}` : '';
  const clientCtx    = _clientTitleSuffix(action.client_name);

  const notified = new Set();

  // ── Fast-path: notify the client team lead(s) about the client-wide block ──
  // Distinct type + actionable copy. Independent of the owner's opt-in (this
  // row was surfaced by the scan's branch (b)). Deduped for free by the shared
  // notification_sent_at guard below → the lead is told exactly once.
  if (senderMissing && action.client_id) {
    const leadIds   = await ProspectingEscalationService.resolveClientLeads(orgId, action.client_id);
    const clientLbl = (action.client_name || '').trim() || 'this client';
    for (const leadId of leadIds) {
      await createNotification(
        orgId, leadId,
        'prospecting_client_sender_blocked',
        `Sending blocked for ${clientLbl}: no mailbox connected`,
        `${prospectName || 'A prospect'}'s sequence step can't send — ${clientLbl} requires its own sender mailbox `
          + `and none is connected. Connect Gmail or Outlook for the client in Agency → ${clientLbl} → Senders `
          + `(or disable "Require client mailbox"). Sending stays paused for ${clientLbl} until a mailbox is connected.`,
        'prospecting_action', action.id,
        {
          action_user_id: action.user_id,
          prospect_id:    action.prospect_id,
          client_id:      action.client_id,
          client_name:    action.client_name || null,
          fail_reason:    'client_sender_required',
          overdue_hours:  overdueHours,
          channel:        action.channel,
        }
      );
      notified.add(leadId);
    }
  }

  // ── Owner's ordinary immediate alert (existing type + copy) ────────────────
  // Fires when the org has immediate alerts on AND the owner is opted in AND
  // either the action is past immediate_hours [pre-Phase-6 behaviour] OR it's a
  // client-sender-missing block [tell the owner early too, per fast #2].
  // Skipped if the owner is already being notified as a client lead.
  const notifyOwner =
    policy.immediate_alert_enabled === true &&
    ownerOptedIn &&
    (senderMissing || ownerPastImmediate);

  if (notifyOwner && !notified.has(action.user_id)) {
    await createNotification(
      orgId, action.user_id,
      'prospecting_immediate',
      `Overdue prospecting action: ${action.title}${prospectCtx}${clientCtx}`,
      `This action was due on ${dueStr} (${overdueHours}h ago) and hasn't been completed.`,
      'prospecting_action', action.id,
      {
        action_user_id: action.user_id,
        prospect_id:    action.prospect_id,
        client_id:      action.client_id || null,
        client_name:    action.client_name || null,
        overdue_hours:  overdueHours,
        channel:        action.channel,
      }
    );
    notified.add(action.user_id);
  }

  // Trip the once-only guard ONLY if someone was actually notified. Keeps the
  // path self-healing: a sender-missing row that healed before this job ran
  // (and whose owner isn't otherwise due) notifies no one and stays eligible
  // for a later legitimate alert. A persistent block with no client lead is
  // still backstopped by the tier ladder (org admins at tier 3).
  if (notified.size > 0) {
    await markProspectingActionNotified(action.id);
  }

  return {
    actionId,
    senderMissing,
    recipientCount: notified.size,
    recipients:     [...notified],
    overdueHours,
    marked:         notified.size > 0,
  };
}

// ── Process a daily digest for a single user across all their overdue
//    prospecting actions ───────────────────────────────────────────────────────
async function processProspectingDailyDigest(orgId, userId, overdueActions) {
  if (!overdueActions.length) return { skipped: true, reason: 'no_overdue' };

  const count = overdueActions.length;

  // Format one overdue line, identical wording in both the flat and grouped
  // layouts so nothing shifts for existing readers.
  const fmtLine = (a) => {
    const who = `${a.prospect_first_name || ''} ${a.prospect_last_name || ''}`.trim() || 'prospect';
    const when = new Date(a.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `• ${a.action_title} — ${who}${a.prospect_company ? ` (${a.prospect_company})` : ''} (due ${when})`;
  };

  // Agency Phase 5: if ANY overdue action belongs to a client, render the
  // digest grouped client-by-client (with a "No client" bucket). If NONE do —
  // i.e. a non-agency org, or an agency org whose overdue items are all
  // client-less — fall back to the ORIGINAL flat top-5 preview, byte-for-byte,
  // so nothing changes for those orgs.
  const hasClient = overdueActions.some(a => a.client_id != null);

  let body;
  if (!hasClient) {
    const preview = overdueActions.slice(0, 5).map(fmtLine).join('\n');
    const moreCount = count > 5 ? `\n…and ${count - 5} more` : '';
    body = `${preview}${moreCount}`;
  } else {
    // Bucket by client_id. Named clients first (alphabetical), "No client"
    // last — matches the reporting rollup's ORDER BY (client_id IS NULL) ASC.
    const groups = new Map();  // key: client_id ?? '__none__' → { label, items }
    for (const a of overdueActions) {
      const key = a.client_id != null ? `c${a.client_id}` : '__none__';
      if (!groups.has(key)) {
        groups.set(key, { label: _clientGroupLabel(a.client_name), isNone: a.client_id == null, items: [] });
      }
      groups.get(key).items.push(a);
    }
    const ordered = [...groups.values()].sort((x, y) => {
      if (x.isNone !== y.isNone) return x.isNone ? 1 : -1;   // "No client" last
      return x.label.localeCompare(y.label);
    });

    const PER_GROUP = 4;   // cap lines per client so the digest stays scannable
    const sections = ordered.map(g => {
      const shown = g.items.slice(0, PER_GROUP).map(fmtLine).join('\n');
      const more  = g.items.length > PER_GROUP ? `\n…and ${g.items.length - PER_GROUP} more` : '';
      return `${g.label} (${g.items.length})\n${shown}${more}`;
    });
    body = sections.join('\n\n');
  }

  // Digest only goes to the rep. Manager-level digest is a separate concern
  // we'd add later; today's design is: rep sees digest, manager sees
  // escalation notifications when tier 2 fires on any of their reports.
  await createNotification(
    orgId, userId,
    'prospecting_digest',
    `You have ${count} overdue prospecting action${count > 1 ? 's' : ''}`,
    body,
    'prospecting_action', null,
    {
      action_user_id: userId,
      action_ids:     overdueActions.map(a => a.action_id),
      count,
      // Per-client counts for downstream consumers (best-effort, cheap to add).
      client_ids:     [...new Set(overdueActions.map(a => a.client_id).filter(v => v != null))],
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
           p.client_id    AS client_id,
           cl.name        AS client_name,
           u.first_name,
           u.last_name
    FROM prospecting_actions pa
    JOIN prospects p ON p.id = pa.prospect_id
    JOIN users     u ON u.id = pa.user_id
    -- 2026_131: only ACTIVE org members are notified.
    -- These scans joined the users table alone, which has no notion of
    -- membership, so a deactivated user kept receiving digests forever.
    -- Harmless while notifications were in-app only; once email is a
    -- channel it mails people who have been removed, at addresses that may
    -- no longer exist and will hard-bounce. Membership is in org_users.
    JOIN org_users ou_act ON ou_act.user_id = pa.user_id
                         AND ou_act.org_id  = pa.org_id
                         AND ou_act.is_active = TRUE
    LEFT JOIN clients cl ON cl.id = p.client_id
    WHERE pa.id = $1 AND pa.org_id = $2
  `, [actionId, orgId]);

  if (!action) return { skipped: true, reason: 'action_not_found' };
  if (action.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (action.escalation_tier >= targetTier) return { skipped: true, reason: 'already_at_tier' };

  // Agency Phase 5: pass the action's client_id so the resolver additively
  // loops in the client team lead(s) from tier 2. Null for non-agency
  // prospects → recipient set is identical to the pre-Phase-5 ladder.
  const recipients = await ProspectingEscalationService.resolveEscalationRecipients(
    orgId, action.user_id, targetTier, action.client_id || null
  );

  const ownerName     = `${action.first_name} ${action.last_name}`;
  const prospectName  = `${action.prospect_first_name} ${action.prospect_last_name}`.trim();
  const overdueHours  = Math.round((Date.now() - new Date(action.due_date).getTime()) / 3600000);
  const dueStr        = new Date(action.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const prospectCtx   = prospectName ? ` for ${prospectName}${action.prospect_company ? ` (${action.prospect_company})` : ''}` : '';
  const clientCtx     = _clientTitleSuffix(action.client_name);

  // Tier text in the notification — helps the recipient understand why
  // they're being told now rather than at the original overdue point.
  const tierLabel = targetTier === 1 ? 'Reminder'
                  : targetTier === 2 ? 'Escalation'
                  : 'Final escalation';

  let notifCount = 0;
  for (const recipientId of recipients) {
    const isOwner = recipientId === action.user_id;
    const title = isOwner
      ? `${tierLabel}: ${action.title}${prospectCtx}${clientCtx}`
      : `${tierLabel} — ${ownerName}'s action: ${action.title}${prospectCtx}${clientCtx}`;
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
        client_id:      action.client_id || null,
        client_name:    action.client_name || null,
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
