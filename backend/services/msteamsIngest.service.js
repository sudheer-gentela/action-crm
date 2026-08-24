// ─────────────────────────────────────────────────────────────────────────────
// services/msteamsIngest.service.js
//
// DROP-IN LOCATION: backend/services/msteamsIngest.service.js
//
// Turns a Graph chatMessage into msteams_threads / msteams_messages /
// msteams_message_attachments / msteams_conversation_participants rows.
// Requires 2026_126 and 2026_127.
//
// EVERY SHAPE BELOW WAS OBSERVED, NOT ASSUMED. Three rounds of probing a live
// tenant produced the payloads this is written against, and three of the
// assumptions it started from were wrong. The specific corrections are called
// out at each site, because the wrong version looks perfectly reasonable and
// somebody will otherwise "fix" it back.
//
// WHAT IT DOES NOT DO
//   Mention-based attribution. The mentions array is stored whole and the
//   matching logic is phase 2. Until then a pool-mode conversation attributes
//   on thread root and then stops, exactly as 2026_108 specifies for WhatsApp —
//   an unassigned message is a correct outcome, not a failure.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this Teams machinery rather than something a person wrote?
 *
 * OBSERVED CORRECTION. The obvious test is messageType, and it does not work:
 * the live tenant returns 'unknownFutureValue' for call-started, call-ended,
 * membersDeleted and conversationMemberRoleUpdated, and 'message' for real
 * messages — but 'unknownFutureValue' is OData's open-enum placeholder, so
 * tomorrow it could mean anything. The reliable pair is `from` being null and
 * `eventDetail` being present, which held across every system message observed.
 */
function isSystemEvent(m) {
  return !!m.eventDetail || m.from == null;
}

/**
 * Flatten a Teams HTML body to searchable text.
 *
 * Two things here are not obvious and both were found by looking at real
 * payloads rather than documentation:
 *
 *   <attachment id="..."></attachment> appears INLINE IN THE BODY as a
 *   placeholder for each attachment. Left alone it lands in body_text, so every
 *   search index and every preview carries literal markup. It is dropped
 *   entirely — the attachment itself is a row in msteams_message_attachments.
 *
 *   <at id="0">Name</at> carries the mention's display text as its content, and
 *   the id indexes into the mentions array. Keeping the inner text means a
 *   search for a colleague's name finds messages that mention them, which is
 *   the behaviour anyone would expect.
 */
function bodyToText(html) {
  if (!html) return '';
  return String(html)
    // Attachment placeholders: drop the whole element, content included.
    .replace(/<attachment\b[^>]*>.*?<\/attachment>/gis, ' ')
    .replace(/<attachment\b[^>]*\/?>/gi, ' ')
    // Block boundaries become spaces so words do not run together.
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    // Keep <at> inner text; drop the tags.
    .replace(/<\/?at\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mentions, deduplicated by the mentioned user's Entra id.
 *
 * OBSERVED CORRECTION. The seeded test message carried two mentions resolving
 * to the SAME user id with different displayName and mentionText — Teams will
 * happily record "Sudheer" and "Sudheer Gentela" as separate entries. Any
 * matching keyed on name double-counts; keyed on id it does not.
 *
 * Also note `mentioned` has application, device, conversation and tag slots
 * beside user, all present-but-null in the observed payload. A channel mention
 * can target a TAG or the whole conversation, so `mentioned.user` is optional
 * and must never be dereferenced blind.
 */
function normalizeMentions(mentions) {
  if (!Array.isArray(mentions)) return [];
  const byId = new Map();

  for (const mention of mentions) {
    const target = mention?.mentioned || {};
    const user = target.user;
    const kind = user ? 'user'
               : target.tag ? 'tag'
               : target.conversation ? 'conversation'
               : target.application ? 'application'
               : 'unknown';

    const id = user?.id || target.tag?.id || target.conversation?.id || null;
    const key = `${kind}:${id || mention?.mentionText || Math.random()}`;
    if (byId.has(key)) continue;

    byId.set(key, {
      index: mention?.id ?? null,
      kind,
      id,
      displayName: user?.displayName || target.tag?.displayName || null,
      mentionText: mention?.mentionText || null,
      tenantId: user?.tenantId || null,
    });
  }

  return [...byId.values()];
}

/**
 * Turn a raw Graph chatMessage into the fields our tables want.
 *
 * `conversation` is the msteams_conversations row the message belongs to.
 */
function normalizeMessage(m, conversation) {
  const system = isSystemEvent(m);
  const html   = m.body?.content || null;

  // OBSERVED CORRECTION. lastModifiedDateTime is NOT an edit signal. On the
  // seeded post it sat 3.4 seconds after createdDateTime with lastEditedDateTime
  // still null — the attachment finishing processing. Keying edit detection on
  // it would mark a large fraction of messages as edited the moment they were
  // captured, and every one of those would show an "edited" marker that is a
  // lie. lastEditedDateTime is the only honest signal.
  const editedAt = m.lastEditedDateTime || null;

  // Chat or channel, decided on channelIdentity rather than by parsing the id
  // suffix. Observed: channel messages carry channelIdentity {teamId, channelId}
  // with chatId null and a populated webUrl; chat messages carry chatId with
  // channelIdentity null and webUrl null. Structural beats string-sniffing.
  const isChannel = !!m.channelIdentity;

  // A channel thread is rooted at replyToId, or at the message itself when it
  // starts one. A chat has no threading, so the whole chat is one thread rooted
  // at the conversation's own graph_id — one join path for both shapes.
  const rootGraphId = isChannel
    ? (m.replyToId || m.id)
    : conversation.graph_id;

  // OBSERVED CORRECTION. A reply's subject came back as '' — an empty string,
  // not null — while the thread root carried a real one. Treating '' as a
  // subject makes every reply look like it opens a new subject-bearing thread,
  // which would wreck subject-based attribution before it was even written.
  const subject = (typeof m.subject === 'string' && m.subject.trim())
    ? m.subject.trim()
    : null;

  return {
    graphMessageId: m.id,
    replyToGraphId: m.replyToId || null,
    rootGraphId,
    isChannel,
    subject,

    fromEntraId:     m.from?.user?.id || null,
    fromDisplayName: m.from?.user?.displayName || null,
    fromTenantId:    m.from?.user?.tenantId || null,

    messageType:  m.messageType || 'unknown',
    isSystemEvent: system,
    eventType:    m.eventDetail?.['@odata.type'] || null,

    bodyHtml:    html,
    bodyText:    bodyToText(html),
    contentType: m.body?.contentType || null,

    mentions: normalizeMentions(m.mentions),

    importance: m.importance || null,
    sentAt:     m.createdDateTime,
    editedAt,
    deletedAt:  m.deletedDateTime || null,

    attachments: (Array.isArray(m.attachments) ? m.attachments : []).map(a => ({
      graphAttachmentId: a.id || null,
      // OBSERVED: 'reference' is a real file in OneDrive/SharePoint.
      // 'application/vnd.microsoft.card.adaptive' is a bot card — the GitHub
      // integration posts these, and they are not files by any reading. Both
      // are stored; only references are treated as attachments a human would
      // want to open.
      attachmentType: a.contentType || null,
      isFile:     a.contentType === 'reference',
      fileName:   a.name || null,
      contentUrl: a.contentUrl || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a sender's Entra id to a GoWarmCRM user.
 *
 * Only connected reps can be resolved, because msteams_connections is the only
 * place an Entra object id is bound to a user_id. Everyone else — colleagues
 * who have not connected, and every external participant — is recorded by name
 * and left unlinked. That is the same posture as WhatsApp and it is correct:
 * inventing a link from a display name is how the wrong person ends up
 * attributed to a commitment.
 */
async function resolveSender(client, orgId, entraId) {
  if (!entraId) return null;
  const { rows: [row] } = await client.query(
    `SELECT user_id FROM msteams_connections
      WHERE org_id = $1 AND entra_object_id = $2 LIMIT 1`,
    [orgId, entraId]
  );
  return row?.user_id || null;
}

/**
 * Find or create the thread, and work out what project it belongs to.
 *
 * ATTRIBUTION ORDER — binding, then thread root, then nothing.
 *
 *   binding     The conversation is bound to one project, so everything in it
 *               inherits. Cheapest and most certain.
 *   thread_root The thread already has a handover_id from an earlier message.
 *               For channels this is the mechanism that makes a multi-project
 *               channel workable at all: attribute a root once and every reply
 *               follows deterministically. Confirmed against real payloads —
 *               every reply carries replyToId pointing at its root.
 *   (nothing)   Unassigned, and that is a legitimate resting state. Per
 *               2026_108, pool mode attributes on reply context and then STOPS
 *               rather than guessing. Mention matching is phase 2 and slots in
 *               here.
 */
async function resolveThread(client, orgId, conversation, n) {
  const { rows: [existing] } = await client.query(
    `SELECT * FROM msteams_threads WHERE conversation_id = $1 AND root_graph_id = $2`,
    [conversation.id, n.rootGraphId]
  );
  if (existing) return existing;

  // conversation_bindings keys on the Graph id, not our local id — see that
  // table's header. channel is the literal 'teams', which conv_bindings_channel_chk
  // has accepted since 2026_108.
  const { rows: [binding] } = await client.query(
    `SELECT binding_mode, handover_id FROM conversation_bindings
      WHERE org_id = $1 AND channel = 'teams' AND thread_ref = $2 LIMIT 1`,
    [orgId, conversation.graph_id]
  );

  let handoverId = null;
  let source = null;
  if (binding?.binding_mode === 'project' && binding.handover_id) {
    handoverId = binding.handover_id;
    source = 'binding';
  }

  // attributed_at is computed here rather than with
  //   CASE WHEN $5 IS NULL THEN NULL ELSE now() END
  // because that made $5 appear both as a column value and inside an untyped
  // CASE, and Postgres could not unify the two — "could not determine data type
  // of parameter $5". Same failure as the bind path hit. Every parameter that
  // could be NULL is cast explicitly for the same reason: node-postgres sends
  // parameters with no declared types and leaves inference to the server.
  const attributedAt = handoverId ? new Date() : null;

  const { rows: [created] } = await client.query(
    `INSERT INTO msteams_threads
       (org_id, conversation_id, root_graph_id, subject,
        handover_id, attribution_source, attributed_at,
        first_message_at, last_message_at, message_count)
     VALUES ($1::integer, $2::integer, $3::text, $4::text,
             $5::integer, $6::text, $7::timestamptz,
             $8::timestamptz, $8::timestamptz, 0)
     ON CONFLICT (conversation_id, root_graph_id) DO UPDATE
       SET subject = COALESCE(EXCLUDED.subject, msteams_threads.subject)
     RETURNING *`,
    [orgId, conversation.id, n.rootGraphId, n.subject,
     handoverId, source, attributedAt, n.sentAt]
  );
  return created;
}

/** Record everyone we see speaking or being mentioned. */
async function touchParticipant(client, orgId, conversationId, p) {
  if (!p.entraId) return;
  await client.query(
    `INSERT INTO msteams_conversation_participants
       (org_id, conversation_id, entra_object_id, user_id, display_name, is_external, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (conversation_id, entra_object_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, msteams_conversation_participants.display_name),
           user_id      = COALESCE(EXCLUDED.user_id, msteams_conversation_participants.user_id),
           last_seen_at = now(),
           updated_at   = now()`,
    [orgId, conversationId, p.entraId, p.userId || null, p.displayName || null, !!p.isExternal]
  );
}

/**
 * Ingest one message. Idempotent.
 *
 * Graph redelivers on retry, a failover can replay a window, and an 'updated'
 * notification arrives for a message we already hold — so this is written as an
 * upsert throughout rather than an insert with a pre-check. The dedup key is
 * (org_id, graph_message_id) from 126.
 *
 * WHAT AN UPDATE TOUCHES, AND WHAT IT MUST NOT.
 *   body_current follows the edit. body_original NEVER changes — it is what
 *   play evidence resolves to, and the whole point of holding both is that a
 *   later edit in Teams cannot rewrite what a play was built on. Attribution is
 *   likewise left alone: if a human moved a message to another project, an edit
 *   in Teams must not silently move it back.
 */
async function ingestMessage(raw, conversation, { connectionId } = {}) {
  const orgId = conversation.org_id;
  const n = normalizeMessage(raw, conversation);

  if (!n.graphMessageId || !n.sentAt) {
    return { ok: false, code: 'MALFORMED', detail: 'missing id or createdDateTime' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const thread = await resolveThread(client, orgId, conversation, n);
    const fromUserId = await resolveSender(client, orgId, n.fromEntraId);

    // Thread-root inheritance: the thread may have been attributed after this
    // thread row was first created, so read it here rather than only at
    // creation.
    let handoverId = thread.handover_id || null;
    let source = handoverId ? (thread.attribution_source || 'thread_root') : null;
    if (handoverId && source !== 'binding') source = 'thread_root';

    const { rows: [msg] } = await client.query(
      `INSERT INTO msteams_messages
         (org_id, conversation_id, thread_id, graph_message_id, reply_to_graph_id,
          from_entra_id, from_user_id, from_display_name,
          message_type, is_system_event, event_type,
          body_original, body_current, body_text, content_type,
          mentions, importance, has_attachments,
          sent_at, edited_at, deleted_at,
          handover_id, attribution_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (org_id, graph_message_id) DO UPDATE
         SET body_current = EXCLUDED.body_current,
             body_text    = EXCLUDED.body_text,
             mentions     = EXCLUDED.mentions,
             edited_at    = EXCLUDED.edited_at,
             deleted_at   = EXCLUDED.deleted_at,
             updated_at   = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        orgId, conversation.id, thread.id, n.graphMessageId, n.replyToGraphId,
        n.fromEntraId, fromUserId, n.fromDisplayName,
        n.messageType, n.isSystemEvent, n.eventType,
        n.bodyHtml, n.bodyText, n.contentType,
        JSON.stringify(n.mentions), n.importance, n.attachments.length > 0,
        n.sentAt, n.editedAt, n.deletedAt,
        handoverId, source,
      ]
    );

    // Attachments are replaced wholesale on update rather than diffed. There is
    // no stable ordering to diff against, the set is tiny, and an edit that
    // removes an attachment must not leave the old row behind.
    if (n.attachments.length) {
      await client.query(
        `DELETE FROM msteams_message_attachments WHERE message_id = $1`, [msg.id]);

      for (const a of n.attachments) {
        await client.query(
          `INSERT INTO msteams_message_attachments
             (org_id, message_id, graph_attachment_id, attachment_type,
              file_name, content_url,
              snapshot_file_name, snapshot_web_url, media_status)
           VALUES ($1,$2,$3,$4,$5,$6,$5,$6,$7)`,
          [
            orgId, msg.id, a.graphAttachmentId, a.attachmentType,
            a.fileName, a.contentUrl,
            // Only a 'reference' is a file somebody might open. A bot card is
            // recorded so the message renders faithfully, but marked skipped so
            // nothing tries to fetch or present it as a document.
            a.isFile ? 'linked' : 'skipped',
          ]
        );
      }
    }

    // The sender, plus anyone mentioned. Mentioned people belong here because a
    // mention is evidence of participation, and a participant list built only
    // from senders misses everyone who was addressed but has not yet replied.
    if (n.fromEntraId) {
      await touchParticipant(client, orgId, conversation.id, {
        entraId: n.fromEntraId,
        userId: fromUserId,
        displayName: n.fromDisplayName,
        isExternal: !!(n.fromTenantId && conversation.entra_tenant_id
                       && n.fromTenantId !== conversation.entra_tenant_id),
      });
    }
    for (const mention of n.mentions) {
      if (mention.kind === 'user' && mention.id) {
        await touchParticipant(client, orgId, conversation.id, {
          entraId: mention.id, displayName: mention.displayName,
        });
      }
    }

    // Counters. System events are excluded so "23 messages" means twenty-three
    // things people said, not nine of those plus fourteen call-ended notices.
    if (msg.inserted && !n.isSystemEvent) {
      await client.query(
        `UPDATE msteams_threads
            SET message_count   = message_count + 1,
                last_message_at = GREATEST(COALESCE(last_message_at, $2::timestamptz), $2::timestamptz),
                updated_at      = now()
          WHERE id = $1`, [thread.id, n.sentAt]);

      await client.query(
        `UPDATE msteams_conversations
            SET message_count   = message_count + 1,
                last_message_at = GREATEST(COALESCE(last_message_at, $2::timestamptz), $2::timestamptz),
                last_activity_at = GREATEST(COALESCE(last_activity_at, $2::timestamptz), $2::timestamptz),
                updated_at      = now()
          WHERE id = $1`, [conversation.id, n.sentAt]);
    }

    await client.query('COMMIT');
    return { ok: true, messageId: msg.id, threadId: thread.id, inserted: msg.inserted, isSystemEvent: n.isSystemEvent };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[msteams] ingest failed for ${n.graphMessageId}: ${err.message}`);
    return { ok: false, code: 'INGEST_FAILED', detail: err.message };
  } finally {
    client.release();
  }
}

module.exports = {
  isSystemEvent,
  bodyToText,
  normalizeMentions,
  normalizeMessage,
  ingestMessage,
};
