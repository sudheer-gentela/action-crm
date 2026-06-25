/**
 * notificationDeliveryLog.js
 *
 * DROP-IN LOCATION: backend/services/notificationDeliveryLog.js  (NEW FILE)
 *
 * Records each notification delivery attempt into notification_deliveries so the
 * app has a queryable audit of "who was notified, when, via which channel, and
 * whether it landed" — instead of that data being ephemeral (logged + dropped)
 * or living in a spreadsheet.
 *
 * Requires migration db/2026_31_notification_deliveries.sql.
 *
 * record() is best-effort and NEVER throws — a logging failure must not break
 * the notification it's recording.
 */

const { pool: defaultPool } = require('../config/database');

const CHANNELS = new Set(['in_app', 'email', 'slack', 'teams']);
const STATUSES = new Set(['sent', 'failed', 'skipped']);

async function record(db, {
  orgId,
  userId = null,
  notificationId = null,
  channel,
  recipient = null,
  subject = null,
  status = 'sent',
  reason = null,
  metadata = {},
} = {}) {
  const conn = db || defaultPool;
  try {
    if (!orgId || !CHANNELS.has(channel)) return; // nothing sensible to log
    const safeStatus = STATUSES.has(status) ? status : 'sent';
    await conn.query(
      `INSERT INTO notification_deliveries
         (org_id, user_id, notification_id, channel, recipient, subject, status, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [orgId, userId, notificationId, channel, recipient, subject, safeStatus, reason,
       JSON.stringify(metadata || {})]
    );
  } catch (e) {
    console.warn('notificationDeliveryLog.record failed:', e.message);
  }
}

module.exports = { record };
