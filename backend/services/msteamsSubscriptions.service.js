// ─────────────────────────────────────────────────────────────────────────────
// services/msteamsSubscriptions.service.js
//
// DROP-IN LOCATION: backend/services/msteamsSubscriptions.service.js
//
// Graph change-notification subscriptions: create, renew, delete, fail over.
// Requires 2026_126 (msteams_subscriptions) and 2026_128 (readability).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY SUBSCRIPTIONS ARE SO SHORT-LIVED HERE
//   Teams chatMessage subscriptions expire in an hour. Everything else in this
//   file follows from that: a renewal job that cannot be allowed to fall
//   behind, and a failover path for when the token doing the renewing stops
//   working. Graph does NOT backfill a lapsed subscription — messages sent
//   while it was dead are simply gone, with no error anywhere. That is why this
//   heals itself rather than only alerting.
//
// ONE SUBSCRIPTION PER CONVERSATION, NOT PER WATCHER
//   Graph allows one subscription per app-and-conversation combination. Two
//   reps watching the same channel is two msteams_conversations rows but ONE
//   Graph subscription, owned by whichever token created it. 2026_126's unique
//   index on (org_id, graph_id) is what enforces that locally, which is the
//   invariant 2026_125 got wrong by keying on conversation_id.
//
// FAILOVER, AGREED EXPLICITLY
//   When renewal fails for the owning connection, reassign to another
//   connection that also watches the same graph_id, and log it. Without this, a
//   single rep's lapsed consent silently stops capture for everyone in that
//   channel, and nobody finds out until somebody asks why March is missing.
//   The log entry matters as much as the failover: the original rep's broken
//   connection still needs fixing rather than being papered over.
//
// PHASE 1 USES includeResourceData: false
//   The notification carries only an id and we GET the message back with the
//   owning rep's delegated token. Resource data would mean an encryption
//   certificate, AES key unwrapping and validationTokens JWT verification —
//   real work with no analogue anywhere else in this codebase. The cost is one
//   extra Graph call per message, which at Teams volumes is nothing.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { pool } = require('../config/database');
const graph   = require('./msteamsGraph.service');
const msteams = require('./msteams.service');

const GRAPH_SUBS = 'https://graph.microsoft.com/v1.0/subscriptions';

// Teams caps chatMessage subscriptions at 60 minutes. Ask for 55: a request
// that overshoots the cap is rejected outright, and the clock starts at
// Microsoft's clock, not ours.
const LIFETIME_MINUTES = 55;

// Renew anything inside this window. Generously wide relative to the 15-minute
// sweep, so a single missed tick — a deploy, a restart — does not lapse
// anything.
const RENEW_WINDOW_MINUTES = 25;

const MAX_RENEWAL_FAILURES = 3;

function notificationUrl() {
  const base = (process.env.BACKEND_URL || 'https://api.gowarmcrm.com').replace(/\/+$/, '');
  return `${base}/webhooks/msteams`;
}
function lifecycleUrl() {
  const base = (process.env.BACKEND_URL || 'https://api.gowarmcrm.com').replace(/\/+$/, '');
  return `${base}/webhooks/msteams/lifecycle`;
}

/** The Graph resource path for a conversation. Stored, never rebuilt — see 126. */
function resourcePathFor(conv) {
  return conv.kind === 'channel'
    ? `/teams/${conv.team_id}/channels/${conv.graph_id}/messages`
    : `/chats/${conv.graph_id}/messages`;
}

function expiryIso(minutes = LIFETIME_MINUTES) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Readability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Can this rep actually read this channel?
 *
 * Channel.ReadBasic.All lists every channel in a joined team, but only a MEMBER
 * of a private channel can read its messages — measured in the pilot tenant,
 * where 3 of 7 channels returned 403 because the signed-in user owned the team
 * without belonging to those channels. Probing before subscribing turns a
 * silent nothing-ever-arrives into an answerable "ask a channel owner to add
 * you".
 *
 * Chats need no probe: a participant can always read a chat they are in.
 */
async function probeReadability(accessToken, conv) {
  if (conv.kind !== 'channel') return { readable: true };
  try {
    await graph.graphGet(accessToken, `${resourcePathFor(conv)}?$top=1`);
    return { readable: true };
  } catch (err) {
    return {
      readable: false,
      error: err.status === 403
        ? `You are not a member of this ${conv.membership_type || 'private'} channel, so its messages cannot be read. Ask a channel owner to add you.`
        : `Could not read this channel: ${err.message}`,
    };
  }
}

async function recordReadability(convId, readable, error) {
  await pool.query(
    `UPDATE msteams_conversations
        SET is_readable = $2, readability_error = $3,
            readability_checked_at = now(), updated_at = now()
      WHERE id = $1`,
    [convId, readable, error || null]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to a conversation, unless something already is.
 *
 * Checks the local registry FIRST. Graph would reject a duplicate anyway, but
 * finding out locally avoids a wasted call and a rejected-request log line
 * every time two reps watch the same channel.
 */
async function subscribe(conv, conn) {
  const { rows: [live] } = await pool.query(
    `SELECT * FROM msteams_subscriptions
      WHERE org_id = $1 AND graph_id = $2 AND status IN ('active','expiring')`,
    [conv.org_id, conv.graph_id]
  );
  if (live) return { ok: true, already: true, subscriptionId: live.subscription_id };

  const tok = await msteams.accessTokenFor(conn);
  if (!tok.ok) return { ok: false, code: tok.code };

  const probe = await probeReadability(tok.accessToken, conv);
  await recordReadability(conv.id, probe.readable, probe.error);
  if (!probe.readable) return { ok: false, code: 'NOT_READABLE', error: probe.error };

  const clientState = crypto.randomBytes(24).toString('base64url');
  const resource = resourcePathFor(conv);

  try {
    const res = await require('axios').post(GRAPH_SUBS, {
      changeType: 'created,updated,deleted',
      notificationUrl: notificationUrl(),
      lifecycleNotificationUrl: lifecycleUrl(),
      resource,
      expirationDateTime: expiryIso(),
      clientState,
      includeResourceData: false,
    }, {
      headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const sub = res.data;
    await pool.query(
      `INSERT INTO msteams_subscriptions
         (org_id, connection_id, conversation_id, graph_id, owner_connection_id,
          subscription_id, resource_path, client_state, expires_at, status)
       VALUES ($1,$2,$3,$4,$2,$5,$6,$7,$8,'active')`,
      [conv.org_id, conn.id, conv.id, conv.graph_id,
       sub.id, resource, clientState, sub.expirationDateTime]
    );

    await pool.query(
      `UPDATE msteams_conversations
          SET capture_started_at = COALESCE(capture_started_at, now()),
              capture_stopped_at = NULL, updated_at = now()
        WHERE id = $1`, [conv.id]);

    return { ok: true, subscriptionId: sub.id, expiresAt: sub.expirationDateTime };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[msteams] subscribe failed for ${conv.graph_id}: ${detail}`);
    // Private and shared channels are reported to reject SUBSCRIPTIONS even
    // where a plain GET succeeds. If that is what happened, the readability
    // probe passed and this did not — record it against the conversation so the
    // rep sees a reason rather than an empty timeline.
    if (err.response?.status === 403 && conv.kind === 'channel') {
      await recordReadability(conv.id, false,
        `This ${conv.membership_type || 'private'} channel can be read but not subscribed to, so live capture is not available for it.`);
    }
    return { ok: false, code: 'SUBSCRIBE_FAILED', error: detail };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Renew, fail over, delete
// ─────────────────────────────────────────────────────────────────────────────

/** Another connection watching the same conversation, for failover. */
async function findAlternateOwner(sub) {
  const { rows } = await pool.query(
    `SELECT c.*
       FROM msteams_connections c
       JOIN msteams_conversations v ON v.connection_id = c.id
      WHERE v.org_id = $1 AND v.graph_id = $2 AND v.is_watched = true
        AND c.id <> $3
        AND c.status = 'connected' AND c.capture_enabled = true
      ORDER BY c.last_discovery_at DESC NULLS LAST
      LIMIT 1`,
    [sub.org_id, sub.graph_id, sub.owner_connection_id || sub.connection_id]
  );
  return rows[0] || null;
}

async function renew(sub) {
  const ownerId = sub.owner_connection_id || sub.connection_id;
  const conn = await msteams.getConnectionById(ownerId);

  if (conn) {
    const tok = await msteams.accessTokenFor(conn);
    if (tok.ok) {
      try {
        const res = await require('axios').patch(
          `${GRAPH_SUBS}/${encodeURIComponent(sub.subscription_id)}`,
          { expirationDateTime: expiryIso() },
          { headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json' },
            timeout: 20000 }
        );
        await pool.query(
          `UPDATE msteams_subscriptions
              SET expires_at = $2, last_renewed_at = now(),
                  renewal_failures = 0, last_error = NULL,
                  status = 'active', updated_at = now()
            WHERE id = $1`,
          [sub.id, res.data.expirationDateTime]);
        return { ok: true, renewed: true };
      } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        // A 404 means Graph has already dropped it. Renewing is pointless;
        // it has to be recreated, and marking it expired is what makes the
        // recreate path pick it up.
        if (err.response?.status === 404) {
          await pool.query(
            `UPDATE msteams_subscriptions
                SET status = 'expired', last_error = $2, updated_at = now()
              WHERE id = $1`, [sub.id, 'Subscription no longer exists at Graph']);
          return { ok: false, code: 'GONE', recreate: true };
        }
        await pool.query(
          `UPDATE msteams_subscriptions
              SET renewal_failures = renewal_failures + 1, last_error = $2, updated_at = now()
            WHERE id = $1`, [sub.id, detail.slice(0, 500)]);
      }
    }
  }

  // The owner cannot renew. Hand it to somebody else who is watching the same
  // conversation before giving up — this is the whole point of failover.
  const alt = await findAlternateOwner(sub);
  if (alt) {
    const altTok = await msteams.accessTokenFor(alt);
    if (altTok.ok) {
      // A subscription belongs to the identity that created it, so it cannot be
      // handed over in place: delete and recreate under the new token.
      await deleteAtGraph(sub, conn).catch(() => {});
      await pool.query(
        `UPDATE msteams_subscriptions SET status = 'deleted', updated_at = now() WHERE id = $1`,
        [sub.id]);

      const { rows: [conv] } = await pool.query(
        `SELECT * FROM msteams_conversations WHERE connection_id = $1 AND graph_id = $2`,
        [alt.id, sub.graph_id]);

      if (conv) {
        const created = await subscribe(conv, alt);
        if (created.ok) {
          await pool.query(
            `UPDATE msteams_subscriptions
                SET failed_over_from = $2,
                    failover_count = $3,
                    last_failover_at = now(),
                    updated_at = now()
              WHERE subscription_id = $1`,
            [created.subscriptionId, sub.owner_connection_id || sub.connection_id,
             (sub.failover_count || 0) + 1]);

          console.warn(
            `[msteams] failed over ${sub.graph_id} from connection ` +
            `${sub.owner_connection_id || sub.connection_id} to ${alt.id} — ` +
            `the original connection still needs attention`);
          return { ok: true, failedOver: true, to: alt.id };
        }
      }
    }
  }

  const { rows: [after] } = await pool.query(
    `SELECT renewal_failures FROM msteams_subscriptions WHERE id = $1`, [sub.id]);

  if ((after?.renewal_failures || 0) >= MAX_RENEWAL_FAILURES) {
    await pool.query(
      `UPDATE msteams_subscriptions SET status = 'failed', updated_at = now() WHERE id = $1`,
      [sub.id]);
    return { ok: false, code: 'FAILED_PERMANENTLY' };
  }
  return { ok: false, code: 'RENEW_FAILED' };
}

async function deleteAtGraph(sub, conn) {
  const c = conn || await msteams.getConnectionById(sub.owner_connection_id || sub.connection_id);
  if (!c) return;
  const tok = await msteams.accessTokenFor(c);
  if (!tok.ok) return;
  await require('axios').delete(
    `${GRAPH_SUBS}/${encodeURIComponent(sub.subscription_id)}`,
    { headers: { Authorization: `Bearer ${tok.accessToken}` }, timeout: 20000 });
}

/** Tear down when a conversation is unwatched. */
async function unsubscribe(convId) {
  const { rows } = await pool.query(
    `SELECT s.* FROM msteams_subscriptions s
      WHERE s.conversation_id = $1 AND s.status IN ('active','expiring')`,
    [convId]);

  for (const sub of rows) {
    // Only tear down at Graph if nobody ELSE is still watching this
    // conversation — one subscription serves every watcher, so unwatching is
    // not the same as stopping capture.
    const { rows: [others] } = await pool.query(
      `SELECT count(*)::int AS n FROM msteams_conversations
        WHERE org_id = $1 AND graph_id = $2 AND is_watched = true AND id <> $3`,
      [sub.org_id, sub.graph_id, convId]);

    if ((others?.n || 0) > 0) continue;

    try { await deleteAtGraph(sub); }
    catch (err) { console.warn(`[msteams] Graph delete failed for ${sub.subscription_id}: ${err.message}`); }

    await pool.query(
      `UPDATE msteams_subscriptions SET status = 'deleted', updated_at = now() WHERE id = $1`,
      [sub.id]);
  }

  await pool.query(
    `UPDATE msteams_conversations SET capture_stopped_at = now(), updated_at = now() WHERE id = $1`,
    [convId]);
}

/** Everything the renewal sweep should touch. */
async function dueForRenewal(limit = 200) {
  const { rows } = await pool.query(
    `SELECT * FROM msteams_subscriptions
      WHERE status IN ('active','expiring')
        AND expires_at < now() + ($1 || ' minutes')::interval
      ORDER BY expires_at
      LIMIT $2`,
    [String(RENEW_WINDOW_MINUTES), limit]);
  return rows;
}

/** Subscriptions Graph dropped, which must be recreated rather than renewed. */
async function dueForRecreate(limit = 100) {
  const { rows } = await pool.query(
    `SELECT s.*, v.id AS conv_id
       FROM msteams_subscriptions s
       JOIN msteams_conversations v ON v.id = s.conversation_id
      WHERE s.status = 'expired' AND v.is_watched = true
      ORDER BY s.updated_at
      LIMIT $1`, [limit]);
  return rows;
}

module.exports = {
  LIFETIME_MINUTES,
  RENEW_WINDOW_MINUTES,
  resourcePathFor,
  probeReadability,
  recordReadability,
  subscribe,
  renew,
  unsubscribe,
  deleteAtGraph,
  dueForRenewal,
  dueForRecreate,
  findAlternateOwner,
};
