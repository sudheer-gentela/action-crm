// ─────────────────────────────────────────────────────────────────────────────
// services/msteams.service.js
//
// DROP-IN LOCATION: backend/services/msteams.service.js
//
// Connections, discovery and triage for Microsoft Teams. Owns the tables from
// 2026_125 and orchestrates msteamsGraph.service.js. Requires that migration.
//
// PHASE 0 CAPTURES NOTHING. There is no message table here, no subscription is
// created, and no message body is read or stored. What this file produces is a
// list of the chats and channels a connected rep belongs to, and a place to
// record what a human decided about each one. 2026_126 reads is_watched.
//
// WHY TOKENS LIVE IN oauth_tokens
//   provider = 'teams'. That table is UNIQUE (user_id, provider), so a new
//   provider string costs no schema change and inherits deleteUserTokens and
//   the existing revocation semantics. msteams_connections holds what
//   oauth_tokens has nowhere to put: Entra identity and discovery state.
//
// WHY DISCOVERY IS A POLL
//   Nothing in Graph tells us a rep was added to a channel. There is no
//   membership notification we can subscribe to without tenant-wide
//   application permissions, which is the whole thing this design avoids. So
//   the list is refreshed on a schedule and last_discovery_at is published to
//   the UI, because a triage screen that is silently three weeks stale is worse
//   than one that admits it.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { pool } = require('../config/database');
const graph    = require('./msteamsGraph.service');
const {
  getTokenByUserId,
  saveUserToken,
  deleteUserTokens,
} = require('./oauthTokenService');

const PROVIDER = 'teams';

// Graph's chatType is an open enum — the schema documents unknownFutureValue —
// so an unrecognised value must not fail the poll at the CHECK constraint.
const KNOWN_CHAT_KINDS = new Set(['oneOnOne', 'group', 'meeting']);

// ─────────────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────────────

async function getConnection(orgId, userId) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM msteams_connections WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  return row || null;
}

async function getConnectionById(connectionId) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM msteams_connections WHERE id = $1`,
    [connectionId]
  );
  return row || null;
}

/**
 * Record a completed OAuth connection.
 *
 * Idempotent on (org_id, user_id): reconnecting is the documented remedy for
 * consent_required and revoked, so it must land on the SAME row rather than
 * failing the unique constraint. Reconnecting also clears status back to
 * 'connected' and wipes the stale error, because leaving a resolved failure
 * displayed is how a working integration keeps looking broken.
 */
async function upsertConnection(orgId, userId, profile) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO msteams_connections
       (org_id, user_id, entra_tenant_id, entra_object_id, entra_upn,
        display_name, status, status_detail, connected_at, disconnected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'connected',NULL,now(),NULL)
     ON CONFLICT (org_id, user_id) DO UPDATE
       SET entra_tenant_id  = EXCLUDED.entra_tenant_id,
           entra_object_id  = EXCLUDED.entra_object_id,
           entra_upn        = EXCLUDED.entra_upn,
           display_name     = EXCLUDED.display_name,
           status           = 'connected',
           status_detail    = NULL,
           last_discovery_error = NULL,
           connected_at     = now(),
           disconnected_at  = NULL,
           updated_at       = now()
     RETURNING *`,
    [
      orgId, userId,
      profile.tenantId    || null,
      profile.objectId    || null,
      profile.upn         || null,
      profile.displayName || null,
    ]
  );
  return row;
}

async function setStatus(connectionId, status, detail = null) {
  await pool.query(
    `UPDATE msteams_connections
        SET status = $2, status_detail = $3, updated_at = now(),
            disconnected_at = CASE WHEN $2 = 'disconnected' THEN now() ELSE disconnected_at END
      WHERE id = $1`,
    [connectionId, status, detail]
  );
}

async function setCaptureEnabled(orgId, userId, enabled) {
  const { rows: [row] } = await pool.query(
    `UPDATE msteams_connections
        SET capture_enabled = $3, updated_at = now()
      WHERE org_id = $1 AND user_id = $2
      RETURNING *`,
    [orgId, userId, !!enabled]
  );
  return row || null;
}

/**
 * Disconnect.
 *
 * Tokens go; msteams_conversations rows STAY. Deleting them would throw away
 * every watch and ignore decision a human made, so a rep who disconnects by
 * accident on Friday would come back Monday to an untriaged list. The rows are
 * inert without a connection — nothing polls them and, once 126 exists, their
 * subscriptions are torn down separately.
 */
async function disconnect(orgId, userId) {
  const conn = await getConnection(orgId, userId);
  if (!conn) return { ok: false, code: 'NOT_CONNECTED' };

  try {
    await deleteUserTokens(userId, PROVIDER);
  } catch (err) {
    // A token row that is already gone is the desired end state, not a failure.
    console.warn(`[msteams] token delete for user ${userId}: ${err.message}`);
  }

  await setStatus(conn.id, 'disconnected', 'Disconnected by user');
  return { ok: true, connectionId: conn.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Access tokens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A usable access token for a connection, refreshing if needed.
 *
 * Returns { ok, accessToken } or { ok:false, code } — never throws for the
 * ordinary failures, because every caller is either a scheduled job that must
 * carry on to the next rep or a route that needs to render a reason.
 *
 * The `downgraded` case is treated as fatal here and is NOT how the Outlook
 * helper treats it. There, a downgraded token still reads mail and only loses
 * file-write, so degrading quietly is right. Here the scopes are not separable:
 * a token without Chat.Read cannot read chats at all, so carrying on would mean
 * 403ing every call while the UI claims the connection is healthy.
 */
async function accessTokenFor(conn) {
  const row = await getTokenByUserId(conn.user_id, PROVIDER);
  if (!row || !row.access_token) {
    await setStatus(conn.id, 'revoked', 'No stored token — reconnect Teams.');
    return { ok: false, code: 'NO_TOKEN' };
  }

  // 2 minutes of headroom: a token that expires mid-discovery produces a 401
  // halfway through a paged walk, and the partial result is indistinguishable
  // from a rep who left a lot of channels.
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 120_000) {
    return { ok: true, accessToken: row.access_token };
  }

  if (!row.refresh_token) {
    await setStatus(conn.id, 'revoked', 'No refresh token — reconnect Teams.');
    return { ok: false, code: 'NO_REFRESH_TOKEN' };
  }

  try {
    const { data, downgraded } = await graph.refresh(row.refresh_token);

    if (downgraded) {
      await setStatus(
        conn.id, 'consent_required',
        'Teams permissions changed and must be approved again — reconnect Teams.'
      );
      return { ok: false, code: 'CONSENT_REQUIRED' };
    }

    await saveUserToken(conn.user_id, PROVIDER, {
      accessToken:  data.access_token,
      refresh_token: data.refresh_token || row.refresh_token,
      expiresOn:    new Date(Date.now() + (data.expires_in || 3600) * 1000),
    });

    return { ok: true, accessToken: data.access_token };
  } catch (err) {
    const body = err.response?.data || {};
    const revoked = /invalid_grant|AADSTS50173|AADSTS700082/i.test(
      `${body.error || ''} ${body.error_description || ''}`
    );
    await setStatus(
      conn.id,
      revoked ? 'revoked' : 'token_expired',
      revoked ? 'Access was withdrawn — reconnect Teams.' : `Token refresh failed: ${err.message}`
    );
    return { ok: false, code: revoked ? 'REVOKED' : 'TOKEN_EXPIRED' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chat frequently has no topic. Fall back to the other members' names.
 *
 * Graph returns each member as an aadUserConversationMember carrying userId and
 * displayName. Anyone without a userId is a non-user participant — an app or a
 * phone participant — and contributes no name.
 */
function chatDisplayName(chat, members, selfObjectId) {
  const others = (members || [])
    .filter(m => m.userId && m.userId !== selfObjectId)
    .map(m => m.displayName)
    .filter(Boolean);

  // A one-to-one chat IS the other person. Their name beats any topic, and a
  // topic on a oneOnOne is vanishingly rare anyway.
  if (chat.chatType === 'oneOnOne' && others.length) return others[0];

  if (chat.topic) return chat.topic;

  if (!others.length) {
    // Reached only when the members call failed or returned nobody. Naming the
    // shape is still better than an empty cell, but this is a degraded result,
    // not a normal one — see the warning logged at the call site.
    return chat.chatType === 'oneOnOne' ? 'Direct chat'
         : chat.chatType === 'meeting'  ? 'Meeting chat'
         : 'Group chat';
  }
  if (others.length <= 3) return others.join(', ');
  return `${others.slice(0, 3).join(', ')} +${others.length - 3}`;
}

/**
 * Should we spend a members call on this chat?
 *
 * Members cost one extra Graph call each, and a rep can be in hundreds of
 * chats, so this is not free. The rule that falls out of the measured tenant —
 * 475 chats, 405 of them meetings, 415 with a topic:
 *
 *   oneOnOne  ALWAYS. The other person's name is the only sane label, and
 *             there are only ~28 of them.
 *   group     Only when there is no topic. A named group chat is already
 *             better labelled than a list of members would be.
 *   meeting   Never. They almost always carry the meeting subject as a topic,
 *             they are hidden from triage by default, and at 405 per rep they
 *             are exactly where a per-chat call would hurt.
 */
function needsMembers(chat) {
  if (chat.chatType === 'oneOnOne') return true;
  if (chat.chatType === 'meeting')  return false;
  return !chat.topic;
}

/**
 * Activity time for ordering triage.
 *
 * lastMessagePreview.createdDateTime is when somebody last SPOKE.
 * chat.lastUpdatedDateTime moves on renames and membership changes too, so it
 * is only a fallback — preferring it would float renamed dead chats above busy
 * ones, which is precisely backwards for a list whose job is "where is the
 * work happening".
 */
function chatActivityAt(chat) {
  return chat.lastMessagePreview?.createdDateTime || chat.lastUpdatedDateTime || null;
}

/**
 * Write one discovered conversation.
 *
 * ON CONFLICT updates only the DISCOVERED fields. is_watched, binding_status
 * and the who/when columns are untouched, because a poll must never overwrite a
 * human's decision — that is the difference between a triage list and a list
 * that resets itself every hour.
 */
async function upsertConversation(client, orgId, connectionId, row) {
  await client.query(
    `INSERT INTO msteams_conversations
       (org_id, connection_id, kind, graph_id, team_id, topic, display_name,
        team_name, member_count, web_url, last_activity_at, last_discovered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (connection_id, graph_id) DO UPDATE
       SET topic              = EXCLUDED.topic,
           display_name       = EXCLUDED.display_name,
           team_name          = EXCLUDED.team_name,
           member_count       = COALESCE(EXCLUDED.member_count, msteams_conversations.member_count),
           web_url            = EXCLUDED.web_url,
           last_activity_at   = COALESCE(EXCLUDED.last_activity_at, msteams_conversations.last_activity_at),
           last_discovered_at = now(),
           updated_at         = now()`,
    [
      orgId, connectionId, row.kind, row.graphId, row.teamId || null,
      row.topic || null, row.displayName || null, row.teamName || null,
      row.memberCount ?? null, row.webUrl || null, row.lastActivityAt || null,
    ]
  );
}

/**
 * Enumerate everything one connection can see, and write it to triage.
 *
 * Partial success is a real outcome and is reported rather than hidden: a rep
 * in twelve teams where one team's channel listing 403s should still get the
 * other eleven. Returning counts plus a warning list lets the caller decide,
 * and lets the UI say "9 of 12 teams" instead of quietly showing nine.
 */
async function discoverForConnection(conn) {
  const tok = await accessTokenFor(conn);
  if (!tok.ok) return { ok: false, code: tok.code };

  const accessToken = tok.accessToken;
  const warnings = [];
  let chatCount = 0;
  let channelCount = 0;
  let memberFailures = 0;

  const client = await pool.connect();
  try {
    // ── Chats ────────────────────────────────────────────────────────────
    let chats = [];
    try {
      ({ chats } = await graph.listChats(accessToken));
    } catch (err) {
      warnings.push(`chats: ${err.message}`);
    }

    for (const chat of chats) {
      if (!chat.id) continue;

      const rawKind = chat.chatType;
      const kind = KNOWN_CHAT_KINDS.has(rawKind) ? rawKind : 'group';
      if (kind !== rawKind) {
        console.warn(`[msteams] unrecognised chatType '${rawKind}' → group (${chat.id})`);
      }

      // Members cost a Graph call each. needsMembers encodes when that is
      // worth it — always for one-to-ones, never for meeting chats.
      let members = null;
      if (needsMembers(chat)) {
        try {
          members = await graph.listChatMembers(accessToken, chat.id);
        } catch (err) {
          // Previously swallowed entirely, which is how a whole tenant's chats
          // ended up labelled "Direct chat" with no indication anything had
          // failed. Still non-fatal — a name is not worth failing discovery
          // over — but it is now counted and reported.
          memberFailures += 1;
          if (memberFailures === 1) {
            warnings.push(`chat members: ${err.message}`);
          }
        }
      }

      await upsertConversation(client, conn.org_id, conn.id, {
        kind,
        graphId:        chat.id,
        teamId:         null,
        topic:          chat.topic || null,
        displayName:    chatDisplayName(chat, members, conn.entra_object_id),
        memberCount:    members ? members.length : null,
        webUrl:         chat.webUrl || null,
        lastActivityAt: chatActivityAt(chat),
      });
      chatCount += 1;
    }

    // ── Channels ─────────────────────────────────────────────────────────
    let teams = [];
    try {
      teams = await graph.listJoinedTeams(accessToken);
    } catch (err) {
      warnings.push(`teams: ${err.message}`);
    }

    for (const team of teams) {
      if (!team.id) continue;

      let channels = [];
      try {
        channels = await graph.listChannels(accessToken, team.id);
      } catch (err) {
        warnings.push(`team ${team.displayName || team.id}: ${err.message}`);
        continue;
      }

      for (const ch of channels) {
        if (!ch.id) continue;
        await upsertConversation(client, conn.org_id, conn.id, {
          kind:        'channel',
          graphId:     ch.id,
          teamId:      team.id,
          topic:       ch.displayName || null,
          displayName: `${team.displayName || 'Team'} › ${ch.displayName || 'Channel'}`,
          teamName:    team.displayName || null,
          memberCount: null,
          webUrl:      ch.webUrl || null,
          // Channels expose no cheap last-activity field. Ordering falls back
          // to whatever a previous run recorded, and to real message times once
          // 126 is capturing.
          lastActivityAt: null,
        });
        channelCount += 1;
      }
    }
  } finally {
    client.release();
  }

  await pool.query(
    `UPDATE msteams_connections
        SET last_discovery_at        = now(),
            last_discovery_error     = $2,
            discovered_chat_count    = $3,
            discovered_channel_count = $4,
            updated_at               = now()
      WHERE id = $1`,
    [conn.id, warnings.length ? warnings.join('; ').slice(0, 1000) : null, chatCount, channelCount]
  );

  return { ok: true, chatCount, channelCount, memberFailures, warnings };
}

/** Every connection due for a discovery pass. Used by the scheduler. */
async function connectionsDueForDiscovery(staleMinutes = 60, limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM msteams_connections
      WHERE status = 'connected' AND capture_enabled = true
        AND (last_discovery_at IS NULL
             OR last_discovery_at < now() - ($1 || ' minutes')::interval)
      ORDER BY last_discovery_at NULLS FIRST
      LIMIT $2`,
    [String(staleMinutes), limit]
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Triage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The triage list for one org.
 *
 * Scoped to the CALLER'S OWN connection, not the org's. Two reps in the same
 * channel have two rows and each may only see and decide on their own, which
 * follows straight from the delegated design: the rows exist because that
 * person's token could see them. An org-wide view is a Phase 2 question with an
 * entitlement attached, not a default.
 *
 * MEETING CHATS ARE HIDDEN UNLESS ASKED FOR. Teams creates one chat per call,
 * and in the measured pilot tenant that was 405 of 475 — the ~66 conversations
 * a rep would actually want to capture were unfindable underneath them. They
 * are still stored and still reachable via kinds='meeting'; they are just not
 * what a triage screen should open on. `counts` reports how many are hidden so
 * the UI can say so rather than appearing to have lost them.
 */
async function listTriage(orgId, userId, {
  status = 'all', watched = null, q = null, limit = 200, kinds = null, includeMeetings = false,
} = {}) {
  const conn = await getConnection(orgId, userId);
  if (!conn) return { ok: false, code: 'NOT_CONNECTED' };

  const params = [orgId, conn.id];
  const where  = ['c.org_id = $1', 'c.connection_id = $2'];

  // An explicit kinds list always wins — asking for meetings is asking for
  // meetings, and the default must not override a deliberate request.
  const kindList = Array.isArray(kinds) && kinds.length
    ? kinds.filter(k => ['oneOnOne', 'group', 'meeting', 'channel'].includes(k))
    : null;

  if (kindList && kindList.length) {
    params.push(kindList);
    where.push(`c.kind = ANY($${params.length}::text[])`);
  } else if (!includeMeetings) {
    // A meeting chat someone deliberately watched stays visible. Hiding a
    // decision a human already made would look like the decision was lost.
    where.push(`(c.kind <> 'meeting' OR c.is_watched = true)`);
  }

  if (status && status !== 'all') {
    params.push(status);
    where.push(`c.binding_status = $${params.length}`);
  }
  if (watched !== null) {
    params.push(!!watched);
    where.push(`c.is_watched = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.display_name ILIKE $${params.length} OR c.topic ILIKE $${params.length} OR c.team_name ILIKE $${params.length})`);
  }
  params.push(Math.min(parseInt(limit, 10) || 200, 500));

  const { rows } = await pool.query(
    `SELECT c.id, c.kind, c.graph_id, c.team_id, c.topic, c.display_name,
            c.team_name, c.member_count, c.web_url,
            c.is_watched, c.binding_status, c.watched_at, c.bound_at,
            c.first_seen_at, c.last_discovered_at, c.last_activity_at
       FROM msteams_conversations c
      WHERE ${where.join(' AND ')}
      ORDER BY c.is_watched DESC, c.last_activity_at DESC NULLS LAST, c.display_name
      LIMIT $${params.length}`,
    params
  );

  // Counted over the whole connection, not the filtered page, so the UI can
  // honestly say "405 meeting chats hidden" rather than implying they vanished.
  const { rows: [tally] } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE kind = 'meeting')::int   AS meetings,
            count(*) FILTER (WHERE kind = 'channel')::int   AS channels,
            count(*) FILTER (WHERE is_watched)::int         AS watched,
            count(*) FILTER (WHERE binding_status = 'ignored')::int AS ignored
       FROM msteams_conversations
      WHERE org_id = $1 AND connection_id = $2`,
    [orgId, conn.id]
  );

  return {
    ok: true,
    conversations: rows,
    counts: tally,
    connection: {
      status:            conn.status,
      statusDetail:      conn.status_detail,
      captureEnabled:    conn.capture_enabled,
      displayName:       conn.display_name,
      upn:               conn.entra_upn,
      lastDiscoveryAt:   conn.last_discovery_at,
      lastDiscoveryError: conn.last_discovery_error,
    },
  };
}

/**
 * Watch or unwatch conversations.
 *
 * Phase 0 only RECORDS the decision — no subscription is created or destroyed,
 * because there is nothing yet to subscribe with. 2026_126 reads is_watched and
 * makes it mean something. Letting people triage before capture exists is
 * deliberate: it means the day capture ships, the watchlist is already right
 * instead of everything arriving at once into an untriaged pile.
 *
 * Unwatching resets binding_status to 'unbound' when it was a bound_* value,
 * because msteams_conversations_decided_chk forbids an unwatched row from
 * sitting in a bound state — and more to the point, a conversation nobody is
 * watching is not bound to anything in any useful sense.
 */
async function setWatch(orgId, userId, conversationIds = [], watched = true) {
  const conn = await getConnection(orgId, userId);
  if (!conn) return { ok: false, code: 'NOT_CONNECTED' };

  const ids = [...new Set(conversationIds.map(n => parseInt(n, 10)).filter(Number.isInteger))];
  if (!ids.length) return { ok: false, code: 'NO_IDS', error: 'Pick at least one conversation.' };

  const { rows } = await pool.query(
    `UPDATE msteams_conversations
        SET is_watched     = $4,
            watched_by     = CASE WHEN $4 THEN $3 ELSE watched_by END,
            watched_at     = CASE WHEN $4 THEN now() ELSE watched_at END,
            binding_status = CASE
              WHEN $4 = false AND binding_status <> 'ignored' THEN 'unbound'
              ELSE binding_status
            END,
            updated_at     = now()
      WHERE org_id = $1 AND connection_id = $2 AND id = ANY($5::int[])
      RETURNING id, is_watched, binding_status`,
    [orgId, conn.id, userId, !!watched, ids]
  );

  return { ok: true, updated: rows };
}

/**
 * Dismiss a conversation as not project traffic.
 *
 * A first-class outcome, exactly as in whatsapp_session_groups: a rep's chat
 * with their manager should be dismissable permanently rather than resurfacing
 * at the top of triage every time it is busy.
 */
async function setIgnored(orgId, userId, conversationIds = [], ignored = true) {
  const conn = await getConnection(orgId, userId);
  if (!conn) return { ok: false, code: 'NOT_CONNECTED' };

  const ids = [...new Set(conversationIds.map(n => parseInt(n, 10)).filter(Number.isInteger))];
  if (!ids.length) return { ok: false, code: 'NO_IDS', error: 'Pick at least one conversation.' };

  const { rows } = await pool.query(
    `UPDATE msteams_conversations
        SET binding_status = CASE WHEN $4 THEN 'ignored' ELSE 'unbound' END,
            is_watched     = CASE WHEN $4 THEN false ELSE is_watched END,
            updated_at     = now()
      WHERE org_id = $1 AND connection_id = $2 AND id = ANY($5::int[])
      RETURNING id, is_watched, binding_status`,
    [orgId, conn.id, userId, !!ignored, ids]
  );

  return { ok: true, updated: rows };
}

module.exports = {
  PROVIDER,
  getConnection,
  getConnectionById,
  upsertConnection,
  setStatus,
  setCaptureEnabled,
  disconnect,
  accessTokenFor,
  discoverForConnection,
  connectionsDueForDiscovery,
  listTriage,
  setWatch,
  setIgnored,
};
