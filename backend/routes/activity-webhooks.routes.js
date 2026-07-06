/**
 * routes/activity-webhooks.routes.js
 *
 * DROP-IN LOCATION: backend/routes/activity-webhooks.routes.js
 * Mount in server.js (next to the transcript webhooks — same raw-body zone):
 *   app.use('/webhooks/activity', require('./routes/activity-webhooks.routes'));
 *
 * Motion-2 (P8) inbound ACTIVITY webhook surface. Follows the house pattern
 * of webhooks.routes.js: provider-keyed dispatch, per-provider signature
 * verification against the raw body, no auth middleware (security IS the
 * signature). Lives under /webhooks/* so server.js's raw-body capture
 * middleware applies (req.rawBody is required for HMAC verification).
 *
 * Routes:
 *   POST /webhooks/activity/hubspot — HubSpot app-level webhooks.
 *
 * HubSpot differs from the transcript providers in one structural way:
 * app-level webhooks are configured ONCE per developer app and fire for
 * EVERY portal that installed the app, arriving at a single URL. So there is
 * no :orgId in the path — each event carries portalId, and the ingest
 * service routes portal → org via the hub_id stored at OAuth connect. The
 * signing secret is likewise app-global: HUBSPOT_CLIENT_SECRET (already in
 * env for OAuth), not a per-org stored secret.
 *
 * Signature (X-HubSpot-Signature-v3):
 *   base64( HMAC-SHA256( clientSecret,
 *     method + fullUrl + rawBody + X-HubSpot-Request-Timestamp ) )
 *   Timestamps older than 5 minutes are rejected (replay protection).
 *   fullUrl must be the exact public URL HubSpot called. Behind the Railway
 *   proxy that's derived from x-forwarded-proto + Host; if the derivation
 *   ever disagrees with the registered URL, set HUBSPOT_WEBHOOK_URL to pin it.
 *
 * ALWAYS 200 after signature passes — HubSpot retries non-2xx for hours and
 * disables misbehaving subscriptions. Per-event failures are recorded on the
 * activity_inflow_events row (status='error'), never surfaced as HTTP errors.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const FormIngest = require('../services/HubSpotFormIngestService');

// Max age for the request timestamp (HubSpot's documented replay window).
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify X-HubSpot-Signature-v3.
 * @returns {boolean}
 */
function verifyHubSpotV3(req, clientSecret) {
  const signature = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];
  if (!signature || !timestamp || !clientSecret) return false;

  // Replay protection.
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_TIMESTAMP_SKEW_MS) {
    return false;
  }

  // The exact URL HubSpot signed. Pin with HUBSPOT_WEBHOOK_URL when the
  // proxy-derived value can't be trusted; otherwise derive it.
  const fullUrl = process.env.HUBSPOT_WEBHOOK_URL
    || `${req.headers['x-forwarded-proto'] || req.protocol || 'https'}://${req.get('host')}${req.originalUrl}`;

  const message  = `${req.method}${fullUrl}${req.rawBody || ''}${timestamp}`;
  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}

// ── POST /webhooks/activity/hubspot ──────────────────────────────────────────

router.post('/hubspot', async (req, res) => {
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret) {
    console.error('[ActivityWebhook] HUBSPOT_CLIENT_SECRET not configured');
    return res.status(503).json({ error: { message: 'Webhook not configured' } });
  }

  if (!verifyHubSpotV3(req, clientSecret)) {
    console.warn('[ActivityWebhook] HubSpot signature verification failed');
    return res.status(401).json({ error: { message: 'Invalid signature' } });
  }

  const events = Array.isArray(req.body) ? req.body : [];
  if (events.length === 0) {
    return res.status(200).json({ success: true, received: 0 });
  }

  // Respond fast, process in the background (HubSpot's delivery timeout is
  // short; the follow-up contact reads + routing can take seconds per batch).
  res.status(200).json({ success: true, received: events.length });

  FormIngest.handleWebhookEvents(events)
    .then((r) => {
      if (r.recorded > 0 || r.errors > 0) {
        console.log(
          `📥 [ActivityWebhook] hubspot batch — received:${r.received} recorded:${r.recorded} ` +
          `processed:${r.processed} parked:${r.parked} skipped:${r.skipped} errors:${r.errors}`
        );
      }
    })
    .catch((err) => console.error('[ActivityWebhook] hubspot batch failed:', err.message));
});

module.exports = router;
