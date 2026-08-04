/**
 * whatsappSession.service.js
 *
 * DROP-IN LOCATION: backend/services/whatsappSession.service.js
 *
 * Turns raw Baileys group messages into rows in the EXISTING whatsapp_threads /
 * whatsapp_messages tables, so every downstream feature you already built —
 * the Handover Communications tab, listMessages, moveMessage, the activity
 * timeline — works on session-captured traffic with no changes.
 *
 * The worker process (workers/wa-session-worker.js) owns the socket. This file
 * owns the database. They talk over HTTP so the socket can live in its own
 * single-replica Railway service without dragging the API with it.
 *
 * READ-ONLY CONTRACT
 *   Nothing here sends. Session threads are written with source='session',
 *   which whatsapp.service.listSendTargets() must filter out — a Graph send
 *   against a JID fails with a confusing error, and we would rather it never
 *   be offered. See the patch note in docs/whatsapp-session-capture.md.
 */

'use strict';

const { pool } = require('../config/database');
const waService = require('./whatsapp.service');

const WORKER_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function getSession(orgId) {
  const { rows } = await pool.query(
    `SELECT id, org_id, label, wa_phone, push_name, status, status_detail,
            connected_at, last_seen_at, last_message_at, phone_last_seen_at,
            capture_enabled, capture_media, created_at
       FROM whatsapp_sessions
      WHERE org_id = $1 AND status <> 'disabled'
      LIMIT 1`,
    [orgId]
  );
  return rows[0] || null;
}

async function getSessionById(sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_sessions WHERE id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

/**
 * Create the session row a worker will then pick up and open a socket for.
 * Does NOT connect — the worker polls for status='pending_qr'.
 */
async function createSession(orgId, userId, { label = null, captureMedia = false } = {}) {
  const existing = await getSession(orgId);
  if (existing) {
    return { ok: false, code: 'ALREADY_EXISTS', error: 'A WhatsApp session already exists for this org', session: existing };
  }
  const { rows: [session] } = await pool.query(
    `INSERT INTO whatsapp_sessions (org_id, label, capture_media, status, created_by)
     VALUES ($1, $2, $3, 'pending_qr', $4)
     RETURNING *`,
    [orgId, label, !!captureMedia, userId || null]
  );
  return { ok: true, session };
}

/**
 * Called by the worker on every connection.update. `patch` is a partial:
 * { status, statusDetail, waPhone, pushName, connectedAt }.
 */
async function updateSessionStatus(sessionId, patch = {}) {
  const sets = ['updated_at = now()', 'last_seen_at = now()'];
  const vals = [];
  let i = 1;

  const push = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };

  if (patch.status)        push('status', patch.status);
  if ('statusDetail' in patch) push('status_detail', patch.statusDetail ?? null);
  if (patch.waPhone)       push('wa_phone', patch.waPhone);
  if (patch.pushName)      push('push_name', patch.pushName);
  if (patch.status === 'connected') sets.push('connected_at = COALESCE(connected_at, now())');

  vals.push(sessionId);
  const { rows } = await pool.query(
    `UPDATE whatsapp_sessions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0] || null;
}

async function disableSession(orgId, userId) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_sessions
        SET status = 'disabled', status_detail = 'disabled by user', updated_at = now()
      WHERE org_id = $1 AND status <> 'disabled'
      RETURNING id`,
    [orgId]
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };
  // Key material is useless once disabled and is the most sensitive thing here.
  await pool.query(`DELETE FROM whatsapp_session_auth WHERE session_id = $1`, [rows[0].id]);
  return { ok: true, sessionId: rows[0].id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth key storage (server side of the worker's AuthenticationState)
//
// The worker holds no database connection. It sends already-serialised JSON
// strings (Baileys' BufferJSON form, which encodes Buffers losslessly) and we
// do the encryption and persistence here. That keeps AI_CREDS_KEY and the
// Postgres credentials on exactly one service, and means the worker needs
// nothing but an HTTPS route to the API.
//
// Deliberately opaque: we never parse these values. They are Signal ratchet
// state and only Baileys knows their shape.
// ─────────────────────────────────────────────────────────────────────────────

const encryption = require('./credentials/encryption');

async function authGet(sessionId, keyIds) {
  if (!Array.isArray(keyIds) || !keyIds.length) return {};
  const { rows } = await pool.query(
    `SELECT key_id, value_ciphertext, value_iv, value_tag
       FROM whatsapp_session_auth
      WHERE session_id = $1 AND key_id = ANY($2::text[])`,
    [sessionId, keyIds]
  );
  const out = {};
  for (const r of rows) {
    try {
      out[r.key_id] = encryption.decrypt(r.value_ciphertext, r.value_iv, r.value_tag);
    } catch (err) {
      // A key we cannot decrypt is worse than one we do not have: Baileys will
      // re-request a missing key, but a throw here aborts the connection.
      console.error(`[wa-session] undecryptable auth key ${r.key_id} (session ${sessionId}): ${err.message}`);
    }
  }
  return out;
}

/**
 * @param {Array<[string,string]>} upserts  [keyId, serialisedJson]
 * @param {string[]} deletes
 *
 * One transaction: Baileys treats each batch as atomic, and a partial apply
 * leaves the ratchet inconsistent, surfacing later as "Bad MAC" decryption
 * failures that look like a library bug.
 */
async function authSet(sessionId, upserts = [], deletes = []) {
  if (!upserts.length && !deletes.length) return { written: 0, deleted: 0 };
  if (!encryption.isConfigured()) {
    throw new Error('AI_CREDS_KEY is not configured — refusing to store WhatsApp session keys in plaintext');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [keyId, value] of upserts) {
      const enc = encryption.encrypt(String(value));
      await client.query(
        `INSERT INTO whatsapp_session_auth
           (session_id, key_id, value_ciphertext, value_iv, value_tag, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (session_id, key_id) DO UPDATE SET
           value_ciphertext = EXCLUDED.value_ciphertext,
           value_iv         = EXCLUDED.value_iv,
           value_tag        = EXCLUDED.value_tag,
           updated_at       = now()`,
        [sessionId, keyId, enc.ciphertext, enc.iv, enc.tag]
      );
    }
    if (deletes.length) {
      await client.query(
        `DELETE FROM whatsapp_session_auth WHERE session_id = $1 AND key_id = ANY($2::text[])`,
        [sessionId, deletes]
      );
    }
    await client.query('COMMIT');
    return { written: upserts.length, deleted: deletes.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Wipe key material — called when WhatsApp reports loggedOut. */
async function authClear(sessionId) {
  const { rowCount } = await pool.query(
    `DELETE FROM whatsapp_session_auth WHERE session_id = $1`, [sessionId]
  );
  return { cleared: rowCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/** '919876543210@s.whatsapp.net' | '919876543210:12@s.whatsapp.net' -> '919876543210' */
function phoneFromJid(jid) {
  if (!jid) return null;
  const user = String(jid).split('@')[0].split(':')[0];
  const digits = user.replace(/[^0-9]/g, '');
  return digits || null;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * Extract displayable text and a type from Baileys' deeply-nested message union.
 *
 * There is no single `body` field: text lives in `conversation` for a plain
 * message, `extendedTextMessage.text` when there is a reply or link preview,
 * and `<media>Message.caption` for captioned media. Ephemeral and view-once
 * messages wrap the real payload one or two levels down.
 *
 * Anything we do not recognise is stored with its type name rather than
 * dropped, and logged — an unlogged unknown type is a silent hole in an audit
 * trail that is supposed to be complete.
 */
function normalizeContent(message, depth = 0) {
  if (!message || depth > 3) return { type: 'unknown', body: '[unsupported message]' };

  // Unwrap containers before inspecting.
  if (message.ephemeralMessage)      return normalizeContent(message.ephemeralMessage.message, depth + 1);
  if (message.viewOnceMessage)       return normalizeContent(message.viewOnceMessage.message, depth + 1);
  if (message.viewOnceMessageV2)     return normalizeContent(message.viewOnceMessageV2.message, depth + 1);
  if (message.documentWithCaptionMessage) {
    return normalizeContent(message.documentWithCaptionMessage.message, depth + 1);
  }

  if (message.conversation) {
    return { type: 'text', body: message.conversation };
  }
  if (message.extendedTextMessage) {
    return { type: 'text', body: message.extendedTextMessage.text || '' };
  }
  if (message.imageMessage) {
    return { type: 'image', body: message.imageMessage.caption || '[image]', media: message.imageMessage };
  }
  if (message.videoMessage) {
    return { type: 'video', body: message.videoMessage.caption || '[video]', media: message.videoMessage };
  }
  if (message.documentMessage) {
    const fn = message.documentMessage.fileName;
    return { type: 'document', body: fn ? `[document] ${fn}` : '[document]', media: message.documentMessage };
  }
  if (message.audioMessage) {
    const ptt = message.audioMessage.ptt;
    return { type: 'audio', body: ptt ? '[voice note]' : '[audio]', media: message.audioMessage };
  }
  if (message.stickerMessage) {
    return { type: 'sticker', body: '[sticker]', media: message.stickerMessage };
  }
  if (message.locationMessage) {
    const l = message.locationMessage;
    return { type: 'location', body: `[location] ${l.degreesLatitude}, ${l.degreesLongitude}` };
  }
  if (message.contactMessage) {
    return { type: 'contact', body: `[contact] ${message.contactMessage.displayName || ''}`.trim() };
  }
  if (message.contactsArrayMessage) {
    return { type: 'contact', body: '[contacts]' };
  }
  if (message.reactionMessage) {
    // Reactions arrive as their own message. Stored so "he thumbs-upped the
    // date change" is recoverable, but typed so the UI can render it inline.
    return { type: 'reaction', body: message.reactionMessage.text || '[reaction]' };
  }
  if (message.pollCreationMessage || message.pollCreationMessageV3) {
    const p = message.pollCreationMessage || message.pollCreationMessageV3;
    return { type: 'poll', body: `[poll] ${p.name || ''}`.trim() };
  }
  if (message.protocolMessage) {
    // Revokes, ephemeral-setting changes, key distribution. Not user content.
    return { type: 'system', body: null, skip: true };
  }
  if (message.senderKeyDistributionMessage) {
    return { type: 'system', body: null, skip: true };
  }

  const key = Object.keys(message)[0] || 'unknown';
  console.warn(`[wa-session] unhandled message type: ${key}`);
  return { type: 'unknown', body: `[${key}]` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist one captured group message.
 *
 * @param {number} sessionId
 * @param {object} evt  Normalised envelope from the worker:
 *   { jid, messageId, participantJid, fromMe, timestamp, pushName,
 *     subject, quotedMessageId, raw: { message } }
 *
 * Returns { stored: boolean, reason?: string, messageId?: number }.
 */
async function ingestGroupMessage(sessionId, evt) {
  const session = await getSessionById(sessionId);
  if (!session) return { stored: false, reason: 'NO_SESSION' };
  if (!session.capture_enabled) return { stored: false, reason: 'CAPTURE_DISABLED' };
  if (!isGroupJid(evt.jid)) return { stored: false, reason: 'NOT_A_GROUP' };

  const orgId = session.org_id;

  // Group registry first: this is what makes an unseen group appear in triage
  // even if the message itself turns out to be a protocol no-op.
  const group = await upsertSessionGroup(sessionId, orgId, {
    jid: evt.jid,
    subject: evt.subject || null,
  });

  if (group.binding_status === 'ignored') {
    return { stored: false, reason: 'GROUP_IGNORED' };
  }

  const content = normalizeContent(evt.raw?.message);
  if (content.skip) return { stored: false, reason: 'PROTOCOL_MESSAGE' };

  // Mirror into whatsapp_threads so the Handover Communications tab, which
  // reads by handover_id off threads, sees this without knowing it came from a
  // different transport.
  const thread = await threadForSessionGroup(orgId, evt.jid, group);

  const senderPhone = phoneFromJid(evt.participantJid);
  if (senderPhone) {
    try {
      await upsertParticipant(orgId, thread.id, senderPhone, evt.pushName, evt.fromMe);
    } catch (err) {
      console.warn(`[wa-session] participant upsert failed for ${evt.jid}: ${err.message}`);
    }
  }

  // Reuse the existing attribution brain rather than inventing a second one.
  // It handles reply-context, recent-outbound and manual-move signals, and
  // expects Meta's shape — so hand it Meta's shape.
  const attribution = await waService.resolveInboundHandover(orgId, thread, {
    context: evt.quotedMessageId ? { id: evt.quotedMessageId } : undefined,
    timestamp: evt.timestamp,
  });

  const captureMeta = {
    sessionId,
    workerVersion: WORKER_VERSION,
    baileysVersion: evt.baileysVersion || null,
    jid: evt.jid,
    participantJid: evt.participantJid || null,
    receivedAt: new Date().toISOString(),
    msgType: content.type,
    fromMe: !!evt.fromMe,
  };

  // direction: a message the observed number itself sent is 'outbound' from the
  // org's point of view even though we only watched it happen. Recording it as
  // inbound would corrupt the 24h-window arithmetic on the thread.
  const direction = evt.fromMe ? 'outbound' : 'inbound';

  const { rows, rowCount } = await pool.query(
    `INSERT INTO whatsapp_messages
       (org_id, thread_id, wa_message_id, direction, message_type, body,
        from_phone, from_name, status, sent_at,
        handover_id, handover_source, reply_to_wa_message_id,
        capture_source, capture_meta, is_automated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10),
             $11,$12,$13,'session',$14,false)
     ON CONFLICT (org_id, wa_message_id) WHERE wa_message_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      orgId, thread.id, evt.messageId, direction, content.type, content.body,
      senderPhone, evt.pushName || null,
      direction === 'inbound' ? 'received' : 'sent',
      Number(evt.timestamp) || Date.now() / 1000,
      attribution.handoverId, attribution.source, attribution.replyToWamid,
      JSON.stringify(captureMeta),
    ]
  );

  if (!rowCount) return { stored: false, reason: 'DUPLICATE' };

  await pool.query(
    `UPDATE whatsapp_session_groups
        SET last_message_at = to_timestamp($2),
            message_count   = message_count + 1,
            updated_at      = now()
      WHERE id = $1`,
    [group.id, Number(evt.timestamp) || Date.now() / 1000]
  );
  await pool.query(
    `UPDATE whatsapp_sessions SET last_message_at = now(), last_seen_at = now() WHERE id = $1`,
    [sessionId]
  );

  return { stored: true, messageId: rows[0].id, threadId: thread.id, groupId: group.id };
}

/** Register or refresh a group we have been added to. */
async function upsertSessionGroup(sessionId, orgId, { jid, subject, participantCount = null, createdAt = null }) {
  const { rows: [group] } = await pool.query(
    `INSERT INTO whatsapp_session_groups
       (session_id, org_id, group_jid, subject, participant_count, group_created_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (session_id, group_jid) DO UPDATE SET
       subject           = COALESCE(EXCLUDED.subject, whatsapp_session_groups.subject),
       participant_count = COALESCE(EXCLUDED.participant_count, whatsapp_session_groups.participant_count),
       updated_at        = now()
     RETURNING *`,
    [sessionId, orgId, jid, subject, participantCount,
     createdAt ? new Date(createdAt * 1000) : null]
  );
  return group;
}

/**
 * The session mirror of whatsapp.service.threadForInboundGroup.
 *
 * Separate rather than shared because the thread MUST be written with
 * source='session' — that column is what stops the send path offering a JID to
 * Graph. Keyed on the same (org_id, wa_group_id) partial unique index.
 */
async function threadForSessionGroup(orgId, jid, group) {
  const { rows: [thread] } = await pool.query(
    `INSERT INTO whatsapp_threads
       (org_id, kind, source, wa_group_id, group_subject, status, opt_in_source)
     VALUES ($1, 'group', 'session', $2, $3, 'active', 'session_capture')
     ON CONFLICT (org_id, wa_group_id) WHERE kind = 'group'
       DO UPDATE SET group_subject = COALESCE(EXCLUDED.group_subject, whatsapp_threads.group_subject),
                     updated_at    = now()
     RETURNING *`,
    [orgId, jid, group.subject || null]
  );

  // Keep the registry pointed at the thread so triage can bind in one write.
  if (group.thread_id !== thread.id) {
    await pool.query(
      `UPDATE whatsapp_session_groups SET thread_id = $1, updated_at = now() WHERE id = $2`,
      [thread.id, group.id]
    );
  }
  return thread;
}

/**
 * Roster upsert. Mirrors whatsapp.service.upsertGroupParticipant (which is not
 * exported) and adds the `side` inference: the observed number itself is us.
 */
async function upsertParticipant(orgId, threadId, waPhone, displayName, isSelf) {
  await pool.query(
    `INSERT INTO whatsapp_thread_participants
       (thread_id, org_id, wa_phone, display_name, side, joined_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (thread_id, wa_phone) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, whatsapp_thread_participants.display_name),
       joined_at    = COALESCE(whatsapp_thread_participants.joined_at, EXCLUDED.joined_at)`,
    [threadId, orgId, waPhone, displayName || null, isSelf ? 'internal' : 'customer']
  );
}

/** Roster refresh from a groups.update / group-participants.update event. */
async function syncGroupMetadata(sessionId, { jid, subject, participants = [], owner = null, creation = null }) {
  const session = await getSessionById(sessionId);
  if (!session) return { ok: false };

  const group = await upsertSessionGroup(session.id, session.org_id, {
    jid, subject, participantCount: participants.length || null, createdAt: creation,
  });
  if (!group.thread_id) return { ok: true, thread: null };

  const selfPhone = session.wa_phone;
  for (const p of participants) {
    const phone = phoneFromJid(p.id || p.jid);
    if (!phone) continue;
    try {
      await upsertParticipant(session.org_id, group.thread_id, phone, p.name || null, phone === selfPhone);
    } catch (err) {
      console.warn(`[wa-session] roster sync failed for ${phone}: ${err.message}`);
    }
  }
  if (owner) {
    await pool.query(
      `UPDATE whatsapp_session_groups SET subject_owner_jid = $1, updated_at = now() WHERE id = $2`,
      [owner, group.id]
    );
  }
  return { ok: true, groupId: group.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Triage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups awaiting a human decision, newest chatter first. This is the screen
 * that turns raw capture into CRM data — without it the messages land in
 * threads nobody can find.
 */
async function listTriage(orgId, { status = 'unbound', limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT g.id, g.group_jid, g.subject, g.participant_count, g.message_count,
            g.last_message_at, g.first_seen_at, g.binding_status,
            g.thread_id, t.handover_id,
            h.name AS project_name,
            (SELECT body FROM whatsapp_messages m
              WHERE m.thread_id = g.thread_id
              ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview
       FROM whatsapp_session_groups g
       LEFT JOIN whatsapp_threads   t ON t.id = g.thread_id
       LEFT JOIN sales_handovers    h ON h.id = t.handover_id
      WHERE g.org_id = $1 AND g.binding_status = $2
      ORDER BY g.last_message_at DESC NULLS LAST
      LIMIT $3`,
    [orgId, status, Math.min(parseInt(limit, 10) || 50, 200)]
  );
  return rows;
}

/**
 * Attach a captured group to a project. Writes the link onto the THREAD (which
 * is what Communications reads) and back-fills every message already captured
 * from this group that has no project of its own — otherwise binding on Friday
 * loses Monday-to-Thursday.
 */
async function bindGroup(orgId, userId, groupId, handoverId) {
  const { rows: [group] } = await pool.query(
    `SELECT * FROM whatsapp_session_groups WHERE id = $1 AND org_id = $2`,
    [groupId, orgId]
  );
  if (!group) return { ok: false, code: 'NOT_FOUND' };
  if (!group.thread_id) return { ok: false, code: 'NO_THREAD', error: 'No messages captured yet' };

  const { rows: [handover] } = await pool.query(
    `SELECT id FROM sales_handovers WHERE id = $1 AND org_id = $2`,
    [handoverId, orgId]
  );
  if (!handover) return { ok: false, code: 'INVALID_HANDOVER' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_org_id = '${parseInt(orgId, 10)}'`);

    await client.query(
      `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now() WHERE id = $2 AND org_id = $3`,
      [handoverId, group.thread_id, orgId]
    );

    const { rowCount: backfilled } = await client.query(
      `UPDATE whatsapp_messages
          SET handover_id = $1, handover_source = 'thread'
        WHERE org_id = $2 AND thread_id = $3 AND handover_id IS NULL`,
      [handoverId, orgId, group.thread_id]
    );

    await client.query(
      `UPDATE whatsapp_session_groups
          SET binding_status = 'bound', bound_by = $1, bound_at = now(), updated_at = now()
        WHERE id = $2`,
      [userId || null, groupId]
    );

    await client.query('COMMIT');
    return { ok: true, threadId: group.thread_id, handoverId, backfilled };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Dismiss a group permanently. Capture stops; existing messages are kept. */
async function ignoreGroup(orgId, userId, groupId) {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_session_groups
        SET binding_status = 'ignored', bound_by = $1, bound_at = now(), updated_at = now()
      WHERE id = $2 AND org_id = $3`,
    [userId || null, groupId, orgId]
  );
  return rowCount ? { ok: true } : { ok: false, code: 'NOT_FOUND' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Staleness view for alerting. A session that stopped receiving is
 * indistinguishable from a quiet weekend by message volume alone, so we key on
 * socket liveness (last_seen_at, written on every event including keepalives),
 * not on message arrival.
 *
 * phoneStaleDays matters because of Meta's rule: if the primary handset is not
 * opened for 14 days, every companion device is logged out. We warn at 10.
 */
async function health(orgId) {
  const session = await getSession(orgId);
  if (!session) return { configured: false };

  const now = Date.now();
  const minsSince = (t) => (t ? Math.round((now - new Date(t).getTime()) / 60000) : null);
  const daysSince = (t) => (t ? Math.floor((now - new Date(t).getTime()) / 86400000) : null);

  const socketStaleMins = minsSince(session.last_seen_at);
  const phoneStaleDays  = daysSince(session.phone_last_seen_at);

  const warnings = [];
  if (session.status === 'logged_out') {
    warnings.push({ level: 'critical', message: 'Session logged out — a human must rescan the QR from the handset.' });
  }
  if (session.status === 'connected' && socketStaleMins != null && socketStaleMins > 15) {
    warnings.push({ level: 'critical', message: `No socket activity for ${socketStaleMins} minutes — capture is probably dead.` });
  }
  if (phoneStaleDays != null && phoneStaleDays >= 10) {
    warnings.push({
      level: phoneStaleDays >= 13 ? 'critical' : 'warning',
      message: `Primary handset last seen ${phoneStaleDays} days ago. WhatsApp logs out all companion devices at 14 days.`,
    });
  }

  const { rows: [counts] } = await pool.query(
    `SELECT count(*) FILTER (WHERE binding_status = 'unbound') AS unbound,
            count(*) FILTER (WHERE binding_status = 'bound')   AS bound
       FROM whatsapp_session_groups WHERE org_id = $1`,
    [orgId]
  );

  return {
    configured: true,
    status: session.status,
    statusDetail: session.status_detail,
    waPhone: session.wa_phone,
    captureEnabled: session.capture_enabled,
    socketStaleMins,
    phoneStaleDays,
    groups: { unbound: Number(counts.unbound), bound: Number(counts.bound) },
    warnings,
    healthy: warnings.every(w => w.level !== 'critical'),
  };
}

module.exports = {
  authGet,
  authSet,
  authClear,
  getSession,
  getSessionById,
  createSession,
  updateSessionStatus,
  disableSession,
  ingestGroupMessage,
  syncGroupMetadata,
  listTriage,
  bindGroup,
  ignoreGroup,
  health,
  // exported for tests
  normalizeContent,
  phoneFromJid,
  isGroupJid,
};
