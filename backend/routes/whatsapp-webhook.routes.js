/**
 * whatsapp-webhook.routes.js
 *
 * DROP-IN LOCATION: backend/routes/whatsapp-webhook.routes.js
 *
 * Mount in server.js at a /webhooks/* path so the raw-body capture middleware
 * (already present for signature verification) applies:
 *   app.use('/webhooks/whatsapp', require('./routes/whatsapp-webhook.routes'));
 *
 * NO auth middleware — Meta calls this unauthenticated. Trust is established by
 * (GET) the verify-token handshake and (POST) the X-Hub-Signature-256 HMAC over
 * the raw body. req.rawBody and req.body are both populated by the /webhooks/*
 * raw-body middleware in server.js.
 *
 *   GET  /   — subscription verification (echoes hub.challenge)
 *   POST /   — inbound messages + delivery/read/failed statuses
 */

'use strict';

const express = require('express');
const router  = express.Router();
const whatsapp = require('../services/whatsapp.service');

// Verification handshake
router.get('/', async (req, res) => {
  try {
    const challenge = await whatsapp.verifyChallenge(req.query || {});
    if (challenge != null) return res.status(200).send(String(challenge));
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

// Event delivery
router.post('/', async (req, res) => {
  try {
    // rawBody is the untouched source (a downstream JSON parser may have reset
    // req.body). Signature is computed over exactly these bytes.
    let payload;
    try { payload = JSON.parse(req.rawBody); }
    catch { payload = (req.body && Object.keys(req.body).length) ? req.body : {}; }

    const ok = await whatsapp.verifySignature(
      req.rawBody, req.get('x-hub-signature-256'), payload
    );
    if (!ok) return res.sendStatus(401);

    // Ack fast; Meta retries aggressively on non-2xx. Ingest is idempotent.
    res.sendStatus(200);
    whatsapp.ingestWebhook(payload).catch(err =>
      console.error('[whatsapp] webhook ingest error:', err.message)
    );
  } catch (err) {
    console.error('[whatsapp] webhook error:', err.message);
    if (!res.headersSent) res.sendStatus(200);
  }
});

module.exports = router;
