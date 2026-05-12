/**
 * StaleCallsNotificationService
 *
 * Scans for sequence call tasks that have been pending past their
 * scheduled_send_at by more than STALE_DAYS (default 5), and creates an
 * in-app notification for the rep who owns them. Idempotent — only creates
 * one notification per stale call task per day (de-duped via the existing
 * `notifications` table on entity_id + type + day).
 *
 * Two ways to invoke:
 *   1. On-demand from the frontend after login (cheap, scoped to current user)
 *   2. Cron job (TODO — register in node-cron in server.js to run nightly)
 *
 * The notification body is concise — for example:
 *   title: "Stale call task"
 *   body:  "3 call tasks have been pending for over 5 days. Review them in the Calls inbox."
 *
 * We send ONE summary notification per user per day rather than one per
 * stale task. Reps with 20 stale tasks would otherwise get 20 notifications,
 * which is noise. The summary points them to the inbox where they can act.
 */

const { pool } = require('../config/database');
const { createNotification } = require('./notificationService');

const STALE_DAYS = 5;

class StaleCallsNotificationService {

  // ── Public: scan + notify for one user ───────────────────────────────────
  // Returns { stale_count, notification_created: bool }
  // Idempotent for the day — won't create a second notification if one
  // already exists today for this user on this entity_type.
  static async scanForUser(orgId, userId) {
    try {
      // 1. Count stale call tasks owned by this user.
      const r = await pool.query(
        `SELECT COUNT(*)::int AS stale_count
           FROM sequence_step_logs ssl
           JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
          WHERE ssl.org_id = $1
            AND ssl.channel = 'call'
            AND ssl.status  = 'draft'
            AND ssl.scheduled_send_at < NOW() - INTERVAL '${STALE_DAYS} days'
            AND se.enrolled_by = $2`,
        [orgId, userId]
      );
      const staleCount = r.rows[0]?.stale_count || 0;
      if (staleCount === 0) {
        return { stale_count: 0, notification_created: false };
      }

      // 2. Check whether we already notified this user today.
      const dedupRes = await pool.query(
        `SELECT id FROM notifications
          WHERE org_id = $1 AND user_id = $2
            AND type = 'stale_call_tasks'
            AND created_at >= NOW() - INTERVAL '24 hours'
          LIMIT 1`,
        [orgId, userId]
      );
      if (dedupRes.rows.length > 0) {
        return { stale_count: staleCount, notification_created: false };
      }

      // 3. Create the notification.
      const title = staleCount === 1
        ? 'Stale call task'
        : `${staleCount} stale call tasks`;
      const body = staleCount === 1
        ? `One call task has been pending for over ${STALE_DAYS} days. Review it in the Calls inbox.`
        : `${staleCount} call tasks have been pending for over ${STALE_DAYS} days. Review them in the Calls inbox.`;

      await createNotification(
        orgId,
        userId,
        'stale_call_tasks',
        title,
        body,
        'call_inbox',
        null,
        { stale_count: staleCount, stale_threshold_days: STALE_DAYS },
      );

      return { stale_count: staleCount, notification_created: true };

    } catch (err) {
      // Non-fatal — don't break login over a notification scan.
      console.error('StaleCallsNotificationService.scanForUser error:', err.message);
      return { stale_count: 0, notification_created: false, error: err.message };
    }
  }
}

module.exports = StaleCallsNotificationService;
