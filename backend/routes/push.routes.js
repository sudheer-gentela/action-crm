/**
 * push.routes.js
 *
 * DROP-IN LOCATION: backend/routes/push.routes.js  (REPLACES the earlier version)
 *
 * Mount in server.js:
 *   app.use('/api/push', require('./routes/push.routes'));
 *
 *   GET    /api/push/vapid-key   -> { publicKey }  (null when unconfigured)
 *   POST   /api/push/subscribe   -> { ok: true }
 *   DELETE /api/push/subscribe   -> { ok: true }
 *
 * Middleware matches notifications.routes.js: authenticateToken is a DIRECT
 * export (not destructured), orgContext is destructured. orgContext is required
 * because push_subscriptions.org_id is NOT NULL and req.orgId is only populated
 * from the JWT when that claim is present.
 *
 * A subscription is always bound to the authenticated user, never to an id
 * supplied by the client.
 */

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const webPush           = require('../services/webPush.service');

router.use(authenticateToken);
router.use(orgContext);

/**
 * The VAPID public key is not a secret — the browser needs it to build a
 * subscription — but it is served behind auth anyway so an unauthenticated
 * caller cannot fingerprint whether push is configured.
 */
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: webPush.getPublicKey() });
});

router.post('/subscribe', async (req, res) => {
  const { subscription, userAgent } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: { message: 'A push subscription is required' } });
  }

  const orgId  = req.orgId;
  const userId = req.userId || (req.user && req.user.userId);
  if (!orgId || !userId) {
    return res.status(401).json({ error: { message: 'Could not resolve your account context' } });
  }

  try {
    await webPush.saveSubscription({
      orgId,
      userId,
      subscription,
      userAgent: userAgent || req.get('user-agent') || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe failed:', err.message);
    res.status(400).json({ error: { message: err.message } });
  }
});

/**
 * Idempotent: unsubscribing a browser that was never registered, or registered
 * twice, both succeed.
 */
router.delete('/subscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: { message: 'An endpoint is required' } });
  }
  try {
    await webPush.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe failed:', err.message);
    res.status(500).json({ error: { message: 'Could not remove the subscription' } });
  }
});

module.exports = router;
