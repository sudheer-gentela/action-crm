// ─────────────────────────────────────────────────────────────────────────────
// routes/msteams-webhook.routes.js
//
// DROP-IN LOCATION: backend/routes/msteams-webhook.routes.js
//
// Receives Microsoft Graph change notifications for Teams.
//
// MOUNT IN server.js NEXT TO THE WHATSAPP WEBHOOK, above express.json():
//     app.use('/webhooks/msteams', require('./routes/msteams-webhook.routes'));
//
// It MUST go there and not with the /api routes. The /webhooks/* raw-body
// middleware already in server.js parses the stream and sets req.body, and
// mounting below express.json() would mean the body is consumed twice. Being
// under /webhooks/ also keeps it clear of the bare `app.use('/api', ...)`
// catch-all that already swallowed one unauthenticated endpoint.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS ENDPOINT IS PUBLIC AND MUST STAY THAT WAY
//   Graph calls it with no Authorization header. Two things stand between it
//   and the open internet:
//
//   clientState  A secret generated per subscription, stored in
//                msteams_subscriptions, echoed by Graph on every notification.
//                A notification whose clientState does not match a known
//                subscription is discarded without a database write.
//
//   subscriptionId  The notification names a subscription we must already know
//                   about. An unknown id is dropped.
//
//   Both must pass. Neither alone is enough: an attacker who guessed a
//   subscription id still cannot produce its clientState.
//
// THE VALIDATION HANDSHAKE
//   When a subscription is created, Graph immediately POSTs here with
//   ?validationToken=... and expects that token echoed back as PLAIN TEXT with
//   a 200, within 10 seconds. It is not JSON, it must not be JSON, and the
//   content type matters. This is why the webhook has to be deployed BEFORE
//   anything subscribes — Graph will refuse to create a subscription whose
//   notificationUrl does not answer this correctly.
//
// ALWAYS 202, ALMOST ALWAYS
//   Graph retries on a non-2xx and escalates to dropping the subscription if
//   failures persist. Since a notification carries no data we cannot re-fetch,
//   a processing error here is OUR problem, not a reason to make Graph retry a
//   payload that will fail again. So: acknowledge fast, process after, log
//   loudly. The exception is a payload we cannot authenticate, which gets a 202
//   as well — telling an unauthenticated caller that their guess was wrong is
//   free information.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const { pool } = require('../config/database');
const graph   = require('../services/msteamsGraph.service');
const msteams = require('../services/msteams.service');
const subs    = require('../services/msteamsSubscriptions.service');
const ingest  = require('../services/msteamsIngest.service');

/**
 * Graph sends the validation token on POST, and some tooling probes with GET.
 * Handle both identically.
 */
function handleValidation(req, res) {
  const token = req.query.validationToken;
  if (!token) return null;
  console.log('[msteams-webhook] validation handshake');
  res.set('Content-Type', 'text/plain').status(200).send(token);
  return true;
}

router.get('/', (req, res) => {
  if (handleValidation(req, res)) return;
  res.status(200).send('ok');
});

/**
 * Fetch the message a notification points at, and ingest it.
 *
 * The notification's `resource` is a path like
 *   chats('19:...')/messages('1787291349561')
 * which Graph will accept back verbatim. We use it as given rather than
 * rebuilding a path from parts, for the same reason msteams_subscriptions
 * stores resource_path: a rebuilt path is a guess about a format we do not own.
 */
async function processNotification(note) {
  const { rows: [sub] } = await pool.query(
    `SELECT * FROM msteams_subscriptions
      WHERE subscription_id = $1 AND status IN ('active','expiring')`,
    [note.subscriptionId]);

  if (!sub) {
    console.warn(`[msteams-webhook] unknown subscription ${note.subscriptionId}`);
    return;
  }
  // Constant-time is overkill for a value we generated at 24 random bytes, but
  // a mismatch is a genuine signal and worth logging rather than ignoring.
  if (!note.clientState || note.clientState !== sub.client_state) {
    console.error(`[msteams-webhook] clientState mismatch on ${note.subscriptionId} — dropped`);
    return;
  }

  const { rows: [conv] } = await pool.query(
    `SELECT * FROM msteams_conversations WHERE id = $1`, [sub.conversation_id]);
  if (!conv) return;

  // Capture can be paused without tearing the subscription down, so honour the
  // switch here rather than assuming a live subscription means live capture.
  if (!conv.is_watched) return;

  const conn = await msteams.getConnectionById(sub.owner_connection_id || sub.connection_id);
  if (!conn || !conn.capture_enabled) return;

  const tok = await msteams.accessTokenFor(conn);
  if (!tok.ok) {
    console.warn(`[msteams-webhook] no token for connection ${conn.id} (${tok.code})`);
    return;
  }

  let raw;
  try {
    raw = await graph.graphGet(tok.accessToken, `/${note.resource.replace(/^\/+/, '')}`);
  } catch (err) {
    // A deleted message may 404 on re-fetch. The notification already told us
    // it was deleted, so mark it rather than losing the fact.
    if (err.status === 404 && note.changeType === 'deleted') {
      await pool.query(
        `UPDATE msteams_messages SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
          WHERE org_id = $1 AND graph_message_id = $2`,
        [conv.org_id, (note.resourceData && note.resourceData.id) || null]);
      return;
    }
    console.error(`[msteams-webhook] fetch failed for ${note.resource}: ${err.message}`);
    return;
  }

  const result = await ingest.ingestMessage(raw, conv, { connectionId: conn.id });
  if (!result.ok) {
    console.error(`[msteams-webhook] ingest failed: ${result.code} ${result.detail || ''}`);
  }
}

router.post('/', async (req, res) => {
  if (handleValidation(req, res)) return;

  const notes = Array.isArray(req.body?.value) ? req.body.value : [];

  // Acknowledge BEFORE processing. Graph allows about 10 seconds and drops
  // subscriptions that repeatedly time out; a batch of notifications each
  // needing a Graph round trip will not reliably fit inside that.
  res.status(202).send();

  for (const note of notes) {
    try {
      await processNotification(note);
    } catch (err) {
      console.error(`[msteams-webhook] unhandled: ${err.message}`);
    }
  }
});

/**
 * Lifecycle notifications.
 *
 * Required because lifecycleNotificationUrl is set on every subscription, which
 * Teams demands whenever expiry is more than an hour out. Two events matter:
 *
 *   reauthorizationRequired  Graph wants the subscription re-authorised. A
 *                            renewal with a valid token satisfies it. Ignoring
 *                            it means the subscription dies at expiry.
 *   subscriptionRemoved      Already gone. Marked expired so the recreate sweep
 *                            picks it up — renewing something that no longer
 *                            exists just 404s forever.
 */
router.post('/lifecycle', async (req, res) => {
  if (handleValidation(req, res)) return;

  const notes = Array.isArray(req.body?.value) ? req.body.value : [];
  res.status(202).send();

  for (const note of notes) {
    try {
      const { rows: [sub] } = await pool.query(
        `SELECT * FROM msteams_subscriptions WHERE subscription_id = $1`,
        [note.subscriptionId]);
      if (!sub) continue;
      if (note.clientState && note.clientState !== sub.client_state) {
        console.error(`[msteams-webhook] lifecycle clientState mismatch — dropped`);
        continue;
      }

      if (note.lifecycleEvent === 'reauthorizationRequired') {
        const r = await subs.renew(sub);
        console.log(`[msteams-webhook] reauthorization for ${sub.graph_id}: ${r.ok ? 'renewed' : r.code}`);
      } else if (note.lifecycleEvent === 'subscriptionRemoved') {
        await pool.query(
          `UPDATE msteams_subscriptions
              SET status = 'expired', last_error = 'Removed by Graph', updated_at = now()
            WHERE id = $1`, [sub.id]);
        console.warn(`[msteams-webhook] subscription removed by Graph for ${sub.graph_id}`);
      } else if (note.lifecycleEvent === 'missed') {
        // Graph is telling us notifications were dropped on their side. There
        // is nothing to re-fetch — this is unrecoverable data loss and the only
        // honest response is to say so in the log.
        console.error(`[msteams-webhook] MISSED notifications for ${sub.graph_id} — messages in that window were not captured`);
      }
    } catch (err) {
      console.error(`[msteams-webhook] lifecycle unhandled: ${err.message}`);
    }
  }
});

router.get('/lifecycle', (req, res) => {
  if (handleValidation(req, res)) return;
  res.status(200).send('ok');
});

module.exports = router;
