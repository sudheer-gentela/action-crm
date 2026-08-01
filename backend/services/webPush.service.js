/**
 * webPush.service.js
 *
 * DROP-IN LOCATION: backend/services/webPush.service.js  (NEW FILE)
 *
 * Sends web push notifications to a user's registered browsers.
 *
 * Requires:
 *   npm install web-push --save
 *   migration db/2026_86_push_subscriptions.sql
 *   env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *
 * Generate a key pair once with:  npx web-push generate-vapid-keys
 * The pair is per-deployment and permanent — rotating it invalidates every
 * existing subscription, so keep it with the rest of your secrets.
 *
 * Everything here is best-effort. Push is a convenience channel layered on top
 * of the in-app notification, which remains the source of truth; a push failure
 * must never surface as a failed notification.
 */

const db = require('../config/database');
const deliveryLog = require('./notificationDeliveryLog');

const SUBJECT     = process.env.VAPID_SUBJECT || 'mailto:support@gowarmcrm.com';
const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

// Lazy, tolerant require. The app must boot fine on a deployment where push is
// not configured and `web-push` was never installed.
let webpush = null;
let initError = null;
function getWebPush() {
  if (webpush || initError) return webpush;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  } catch (e) {
    initError = e;
    webpush = null;
    console.warn('[push] disabled:', e.message);
  }
  return webpush;
}

function isConfigured() {
  return Boolean(PUBLIC_KEY && PRIVATE_KEY);
}

function getPublicKey() {
  return PUBLIC_KEY || null;
}

/**
 * Store or refresh a subscription. Keyed on endpoint, so a browser that
 * re-subscribes updates its row instead of creating a second one.
 */
async function saveSubscription({ orgId, userId, subscription, userAgent = null }) {
  const endpoint = subscription && subscription.endpoint;
  const keys     = (subscription && subscription.keys) || {};
  if (!endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('Incomplete push subscription');
  }

  await db.pool.query(
    `INSERT INTO push_subscriptions (org_id, user_id, endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (endpoint) DO UPDATE
       SET org_id        = EXCLUDED.org_id,
           user_id       = EXCLUDED.user_id,
           p256dh        = EXCLUDED.p256dh,
           auth          = EXCLUDED.auth,
           user_agent    = EXCLUDED.user_agent,
           failure_count = 0,
           last_used_at  = now()`,
    [orgId, userId, endpoint, keys.p256dh, keys.auth, userAgent]
  );
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await db.pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function listForUser(userId) {
  const { rows } = await db.pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  return rows;
}

/**
 * Deliver one notification to every device a user has registered.
 *
 * Returns { sent, failed, skipped } — a summary, never a throw.
 */
async function sendToUser({ orgId, userId, notificationId = null, title, body, url = '/' }) {
  const lib = isConfigured() ? getWebPush() : null;
  if (!lib) {
    await deliveryLog.record(null, {
      orgId, userId, notificationId, channel: 'push',
      status: 'skipped', reason: 'push_not_configured',
    });
    return { sent: 0, failed: 0, skipped: 1 };
  }

  const subs = await listForUser(userId);
  if (!subs.length) {
    await deliveryLog.record(null, {
      orgId, userId, notificationId, channel: 'push',
      status: 'skipped', reason: 'no_subscriptions',
    });
    return { sent: 0, failed: 0, skipped: 1 };
  }

  const payload = JSON.stringify({
    title: title || 'GoWarm CRM',
    body:  body  || '',
    url,
    // Same tag collapses repeat notifications about one item into a single
    // entry on the lock screen instead of a stack.
    tag: notificationId ? `gw-notif-${notificationId}` : 'gowarm',
    notificationId,
  });

  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    const target = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await lib.sendNotification(target, payload);
      sent += 1;
      await db.pool.query(
        'UPDATE push_subscriptions SET last_used_at = now(), failure_count = 0 WHERE id = $1',
        [sub.id]
      );
    } catch (err) {
      failed += 1;
      const code = err.statusCode;
      // 404 / 410 mean the push service has retired this endpoint for good.
      // Anything else might be transient, so count it and drop the row only
      // once it has clearly stopped working.
      if (code === 404 || code === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        await db.pool.query(
          'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1',
          [sub.id]
        );
        await db.pool.query(
          'DELETE FROM push_subscriptions WHERE id = $1 AND failure_count >= 10',
          [sub.id]
        );
      }
      console.warn(`[push] send failed (${code || 'no status'}):`, err.message);
    }
  }

  await deliveryLog.record(null, {
    orgId, userId, notificationId, channel: 'push',
    subject: title,
    status: sent > 0 ? 'sent' : 'failed',
    reason: sent > 0 ? null : 'all_endpoints_failed',
    metadata: { sent, failed, devices: subs.length },
  });

  return { sent, failed, skipped: 0 };
}

module.exports = {
  isConfigured,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  listForUser,
  sendToUser,
};
