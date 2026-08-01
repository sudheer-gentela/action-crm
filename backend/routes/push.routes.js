/**
 * push.routes.js
 *
 * DROP-IN LOCATION: backend/routes/push.routes.js  (NEW FILE)
 *
 * Mount in server.js alongside the other API routes:
 *   app.use('/api/push', require('./routes/push.routes'));
 *
 *   GET    /api/push/vapid-key   -> { publicKey }  (null when unconfigured)
 *   POST   /api/push/subscribe   -> { ok: true }
 *   DELETE /api/push/subscribe   -> { ok: true }
 *
 * All three require a valid token: a subscription is bound to the authenticated
 * user, never to a user id supplied by the client.
 */

const express = require('express');
const router  = express.Router();

const { authenticateToken } = require('../middleware/auth.middleware');
const webPush = require('../services/webPush.service');

router.use(authenticateToken);

/**
 * The VAPID public key is not a secret — the browser needs it to create a
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
  try {
    await webPush.saveSubscription({
      orgId:     req.orgId,
      userId:    req.userId,
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
 * Removing a subscription is idempotent — unsubscribing a browser that was
 * never registered, or registered twice, both succeed.
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
