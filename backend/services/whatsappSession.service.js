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
const groupCache = require('./whatsapp/groupCache');

const WORKER_VERSION = '1.1.0';   // 1.1.0 adds session media capture

// How many stranded attachments to offer the worker per heartbeat. Small on
// purpose: the worker downloads these on the same process that holds the live
// Signal socket, and a hundred-file backlog arriving at once is exactly the
// memory and bandwidth spike that gets a socket dropped. A default 60s beat
// drains 25 files a minute, which clears any realistic backlog well inside the
// retention window.
const MEDIA_PER_BEAT = parseInt(process.env.WA_SESSION_MEDIA_PER_BEAT || '25', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

async function getSession(orgId) {
  const { rows } = await pool.query(
    `SELECT id, org_id, label, wa_phone, push_name, status, status_detail,
            connected_at, last_seen_at, last_message_at, phone_last_seen_at,
            capture_enabled, capture_media, created_at,
            heartbeat_at, heartbeat_seconds, flush_interval_ms, batch_max,
            stale_socket_minutes, reconnect_max_seconds, reconnect_count,
            capture_mode
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
  groupCache.drop(rows[0].id);
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
// Runtime config & liveness
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_BOUNDS = {
  heartbeat_seconds:     [15,  3600],
  flush_interval_ms:     [250, 60000],
  batch_max:             [1,   500],
  stale_socket_minutes:  [5,   1440],
  reconnect_max_seconds: [10,  3600],
};

/**
 * The knobs the worker reads on connect and re-reads on every heartbeat, so a
 * tuning change takes effect WITHOUT a redeploy — a redeploy would tear down
 * the WhatsApp socket, which is the thing we are trying to keep alive.
 */
async function getRuntimeConfig(sessionId) {
  const { rows: [r] } = await pool.query(
    `SELECT heartbeat_seconds, flush_interval_ms, batch_max,
            stale_socket_minutes, reconnect_max_seconds, capture_enabled,
            capture_media, media_max_bytes
       FROM whatsapp_sessions WHERE id = $1`,
    [sessionId]
  );
  if (!r) return null;
  return {
    heartbeatSeconds:    r.heartbeat_seconds,
    flushIntervalMs:     r.flush_interval_ms,
    batchMax:            r.batch_max,
    staleSocketMinutes:  r.stale_socket_minutes,
    reconnectMaxSeconds: r.reconnect_max_seconds,
    captureEnabled:      r.capture_enabled,
    // The worker enforces this before downloading. It is also re-checked on
    // arrival at the API, because a size limit that only exists on the client
    // is not a limit.
    captureMedia:        r.capture_media,
    mediaMaxBytes:       Number(r.media_max_bytes) || 26214400,
  };
}

/** Validate and persist config changes from the admin UI. */
async function updateRuntimeConfig(orgId, patch = {}) {
  const sets = ['updated_at = now()'];
  const vals = [];
  let i = 1;

  for (const [col, [min, max]] of Object.entries(CONFIG_BOUNDS)) {
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (patch[camel] === undefined) continue;
    const n = parseInt(patch[camel], 10);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, code: 'OUT_OF_RANGE', error: `${camel} must be between ${min} and ${max}` };
    }
    sets.push(`${col} = $${i++}`);
    vals.push(n);
  }
  if (patch.captureMode !== undefined) {
    if (!['allowlist', 'all'].includes(patch.captureMode)) {
      return { ok: false, code: 'BAD_MODE', error: "captureMode must be 'allowlist' or 'all'" };
    }
    sets.push(`capture_mode = $${i++}`);
    vals.push(patch.captureMode);
  }
  if (patch.captureEnabled !== undefined) {
    sets.push(`capture_enabled = $${i++}`);
    vals.push(!!patch.captureEnabled);
  }
  if (patch.captureMedia !== undefined) {
    sets.push(`capture_media = $${i++}`);
    vals.push(!!patch.captureMedia);
  }
  // Bounds duplicated from whatsapp_sessions_media_chk. The constraint is the
  // guarantee; this is so the admin gets a sentence instead of a 500 with a
  // Postgres constraint name in it.
  if (patch.mediaMaxBytes !== undefined) {
    const n = parseInt(patch.mediaMaxBytes, 10);
    if (!Number.isInteger(n) || n < 1048576 || n > 104857600) {
      return { ok: false, code: 'OUT_OF_RANGE', error: 'mediaMaxBytes must be between 1 MB and 100 MB' };
    }
    sets.push(`media_max_bytes = $${i++}`);
    vals.push(n);
  }
  if (patch.mediaRetentionDays !== undefined) {
    const n = parseInt(patch.mediaRetentionDays, 10);
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      return { ok: false, code: 'OUT_OF_RANGE', error: 'mediaRetentionDays must be between 1 and 30' };
    }
    sets.push(`media_retention_days = $${i++}`);
    vals.push(n);
  }
  if (patch.label !== undefined) {
    sets.push(`label = $${i++}`);
    vals.push(String(patch.label).slice(0, 200));
  }
  if (sets.length === 1) return { ok: false, code: 'NO_CHANGES' };

  vals.push(orgId);
  const { rows } = await pool.query(
    `UPDATE whatsapp_sessions SET ${sets.join(', ')}
      WHERE org_id = $${i} AND status <> 'disabled' RETURNING *`,
    vals
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, session: rows[0] };
}

/**
 * Worker liveness ping. Returns the current config so the worker picks up
 * changes on its normal cadence rather than needing to be told.
 */
async function heartbeat(sessionId, { socketConnected = true } = {}) {
  await pool.query(
    `UPDATE whatsapp_sessions
        SET heartbeat_at = now(),
            last_seen_at = now(),
            updated_at   = now()
      WHERE id = $1`,
    [sessionId]
  );
  // Attachments waiting on the worker. The fast path is the ack from
  // /internal/messages, which fires seconds after the message arrives; this is
  // the backstop that catches everything it misses — a worker restart between
  // capture and upload, a storage folder configured after the fact, a retry
  // pressed in the UI. Bounded per beat so a backlog drains steadily instead of
  // arriving as one burst that competes with the live socket for bandwidth.
  let pendingMedia = [];
  try {
    const media = require('./whatsappMedia.service');
    pendingMedia = await media.listPendingSessionMedia(sessionId, MEDIA_PER_BEAT);
  } catch (err) {
    // Never fatal. A heartbeat that fails takes the config refresh and the
    // liveness write down with it, and those matter more than a media batch
    // that the next beat will offer again anyway.
    console.error(`[wa-session] pending media lookup failed for session ${sessionId}: ${err.message}`);
  }

  return {
    ok: true,
    config: await getRuntimeConfig(sessionId),
    socketConnected,
    // Someone has the triage screen open and wants the live group list. The
    // worker answers by POSTing a snapshot to /internal/group-snapshot, which
    // goes to memory, not Postgres.
    sendGroupSnapshot: groupCache.takeRefreshRequest(sessionId),
    pendingMedia: pendingMedia.map(r => ({
      messageId: r.message_id,
      ref:       r.ref,
      mimeType:  r.media_mime_type,
      fileName:  r.media_filename,
      fileSize:  r.media_file_size ? Number(r.media_file_size) : null,
      expiresAt: r.media_expires_at,
    })),
  };
}

/** Count a reconnect, so a session that flaps constantly is visible. */
async function recordReconnect(sessionId) {
  await pool.query(
    `UPDATE whatsapp_sessions
        SET reconnect_count = reconnect_count + 1,
            last_reconnect_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [sessionId]
  );
}

/**
 * A human confirms the primary handset was opened. Nothing in the protocol
 * reports this, and WhatsApp unlinks every companion device after 14 days of
 * handset inactivity — so the only honest source is someone saying so.
 */
async function confirmPhoneSeen(orgId, userId) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_sessions
        SET phone_last_seen_at = now(), phone_confirmed_by = $1, updated_at = now()
      WHERE org_id = $2 AND status <> 'disabled' RETURNING phone_last_seen_at`,
    [userId || null, orgId]
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, phoneLastSeenAt: rows[0].phone_last_seen_at };
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
  // mediaType is Baileys' own vocabulary for downloadContentFromMessage, and
  // it is NOT always our message_type: a sticker downloads as 'sticker' but
  // files as an image, and a voice note downloads as 'audio' but reads as a
  // voice note. Carrying both means the fetch and the UI can each be right.
  if (message.imageMessage) {
    return { type: 'image', body: message.imageMessage.caption || '[image]', media: message.imageMessage, mediaType: 'image' };
  }
  if (message.videoMessage) {
    return { type: 'video', body: message.videoMessage.caption || '[video]', media: message.videoMessage, mediaType: 'video' };
  }
  if (message.documentMessage) {
    const fn = message.documentMessage.fileName;
    return { type: 'document', body: fn ? `[document] ${fn}` : '[document]', media: message.documentMessage, mediaType: 'document' };
  }
  if (message.audioMessage) {
    const ptt = message.audioMessage.ptt;
    return { type: 'audio', body: ptt ? '[voice note]' : '[audio]', media: message.audioMessage, mediaType: 'audio' };
  }
  if (message.stickerMessage) {
    return { type: 'sticker', body: '[sticker]', media: message.stickerMessage, mediaType: 'sticker' };
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
// Media descriptors
//
// A session attachment has no Meta media id. What it has is a mediaKey, a
// directPath on WhatsApp's CDN and two SHA-256 digests — enough for the worker
// to fetch the ciphertext and decrypt it, and useless to anyone without all
// four. Those go into whatsapp_messages.session_media_ref (migration 2026_107)
// so a fetch survives a worker restart.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bytes → base64, whatever shape they arrived in.
 *
 * Necessary because these fields cross a JSON boundary. Baileys usually holds
 * them as Buffer, which JSON.stringify renders as {"type":"Buffer","data":[…]}
 * and Buffer.from reads back correctly — so the common case is fine. But a
 * Uint8Array (which some proto paths and some Baileys versions produce)
 * stringifies to an object with NUMERIC STRING KEYS — {"0":143,"1":22,…} — and
 * Buffer.from throws ERR_INVALID_ARG_TYPE on that. Loud rather than silent,
 * which is the good news; it would still take down the whole ingest batch for
 * one attachment.
 *
 * The worker now base64-encodes before sending, so the string branch is the
 * normal path. The rest are here because the worker and the API are separate
 * Railway services that deploy independently: an API running ahead of an old
 * worker must still understand what that worker sends.
 *
 * Verified against all six shapes: base64 string, Buffer, Uint8Array, plain
 * array, {type:'Buffer',data}, and the numeric-keyed object.
 */
function toB64(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;                       // already base64
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return Buffer.from(v).toString('base64');
  if (typeof v === 'object') {
    // { type: 'Buffer', data: [...] } — Buffer's own toJSON output.
    if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data).toString('base64');
    // Numeric-keyed object from a stringified Uint8Array.
    const keys = Object.keys(v);
    if (keys.length && keys.every(k => /^\d+$/.test(k))) {
      const arr = new Uint8Array(keys.length);
      for (const k of keys) arr[Number(k)] = v[k];
      return Buffer.from(arr).toString('base64');
    }
  }
  return null;
}

/**
 * The fetch handle for one session attachment, or null if this message has no
 * attachment or is missing the fields that make it fetchable.
 *
 * Returning null for an incomplete descriptor is deliberate: a half-populated
 * ref would sit in the worker's queue failing forever. Better to record no
 * attachment than an unfetchable one.
 */
function buildSessionMediaRef(content, evt) {
  // Preferred: the worker built this explicitly, with the bytes already base64.
  const supplied = evt?.media;
  const proto    = content?.media;
  if (!supplied && !proto) return null;

  const mediaType = supplied?.mediaType || content?.mediaType || null;
  const mediaKey  = toB64(supplied?.mediaKey  ?? proto?.mediaKey);
  const directPath = supplied?.directPath ?? proto?.directPath ?? null;

  if (!mediaType || !mediaKey || !directPath) return null;

  const fileLength = Number(supplied?.fileLength ?? proto?.fileLength ?? 0) || null;

  return {
    mediaType,
    mediaKey,
    directPath,
    fileEncSha256: toB64(supplied?.fileEncSha256 ?? proto?.fileEncSha256),
    fileSha256:    toB64(supplied?.fileSha256    ?? proto?.fileSha256),
    // url is a convenience only. directPath is authoritative — Baileys rebuilds
    // the URL from it, and a stored absolute URL goes stale when WhatsApp moves
    // hosts.
    url:        supplied?.url        ?? proto?.url        ?? null,
    mimetype:   supplied?.mimetype   ?? proto?.mimetype   ?? null,
    fileName:   supplied?.fileName   ?? proto?.fileName   ?? null,
    fileLength,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Should this group's attachments be written into the customer's storage?
 *
 * Three switches, most specific first. Each can only say no — none of them
 * grants capture on its own, because writing into somebody's Drive should take
 * agreement from every level that has an opinion.
 *
 *   group.media_policy   the PM's per-group override. 'documents' is the
 *                        useful middle setting: an implementation channel
 *                        where the spreadsheets matter and the site photos and
 *                        birthday stickers do not.
 *   session.capture_media  the org-wide switch for this linked number.
 *   the project's media_capture_mode is checked later, inside
 *                        resolveUploadTarget — not duplicated here.
 *
 * Returns { capture: boolean, reason?: string }. A refusal always carries a
 * reason, because the message row keeps it in media_error and the whole point
 * of 'skipped' is that a person can see what stopped it.
 */
function mediaPolicyFor(session, group, content) {
  const policy = group?.media_policy || 'inherit';

  if (policy === 'none') {
    return { capture: false, reason: 'attachment capture is off for this group' };
  }
  if (policy === 'documents' && content.type !== 'document') {
    return { capture: false, reason: `this group captures documents only — ${content.type} not stored` };
  }
  if (policy === 'inherit' && !session.capture_media) {
    return { capture: false, reason: 'attachment capture is off for this WhatsApp session' };
  }
  // 'all' and 'documents' are explicit per-group decisions by a PM and stand on
  // their own — they are the override, so the session switch does not veto
  // them. That is what makes "capture documents from this one group" possible
  // without turning media on for every group the number is in.
  return { capture: true };
}

/** How long we assume WhatsApp's CDN will keep it. See migration 2026_107. */
function sessionMediaExpiry(session, timestampSeconds) {
  const days = Number(session?.media_retention_days) || 14;
  const base = Number(timestampSeconds) ? Number(timestampSeconds) * 1000 : Date.now();
  return new Date(base + days * 86400000);
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
  // No row means nobody has decided about this group. Under allowlist mode
  // that is also a decision NOT to store its messages, so we stop here without
  // creating a record of the group's existence.
  const group = await upsertSessionGroup(sessionId, orgId, {
    jid: evt.jid,
    subject: evt.subject || null,
    via: 'message',
  });
  if (!group) return { stored: false, reason: 'NOT_WATCHED' };

  // ── the capture gate ────────────────────────────────────────────────────
  //
  // Discovery already happened above: the group is catalogued and will appear
  // in triage regardless. This decides only whether we retain what was SAID.
  //
  // allowlist mode fails closed. That is deliberate — forgetting to watch a
  // group loses some history, whereas forgetting to ignore one puts a family
  // conversation in a customer's CRM.
  if (session.capture_mode === 'allowlist') {
    if (!group.is_watched) return { stored: false, reason: 'NOT_WATCHED' };
  } else if (group.binding_status === 'ignored') {
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

  // ── Attachment ───────────────────────────────────────────────────────────
  //
  // Decided here rather than at fetch time because the descriptor is only
  // available now: it lives in the message proto, which is not persisted. Get
  // this wrong and the attachment is unreachable forever — there is no second
  // delivery, and we will not ask the sender's device to re-upload.
  const ref    = buildSessionMediaRef(content, evt);
  const policy = ref ? mediaPolicyFor(session, group, content) : { capture: false };

  // Refused by policy is still RECORDED: media_source and the descriptor are
  // written, status 'skipped', reason attached. The bytes are not fetched, but
  // the row stays fully recoverable if someone changes the policy inside the
  // retention window. Dropping the descriptor here would make that decision
  // irreversible, which is not a decision a default should be allowed to make.
  const mediaSource   = ref ? 'session' : null;
  const mediaStatus   = ref ? (policy.capture ? 'pending' : 'skipped') : null;
  const mediaError    = ref && !policy.capture ? (policy.reason || null) : null;
  const mediaExpires  = ref ? sessionMediaExpiry(session, evt.timestamp) : null;
  const mediaMime     = ref ? (ref.mimetype || null) : null;
  const mediaFileName = ref ? (ref.fileName || null) : null;
  const mediaSize     = ref ? (ref.fileLength || null) : null;
  const mediaCaption  = ref && content.media?.caption ? content.media.caption : null;

  const captureMeta = {
    sessionId,
    workerVersion: WORKER_VERSION,
    baileysVersion: evt.baileysVersion || null,
    jid: evt.jid,
    participantJid: evt.participantJid || null,
    receivedAt: new Date().toISOString(),
    msgType: content.type,
    fromMe: !!evt.fromMe,
    // Provenance for the attachment decision, so "why was this photo not
    // stored" is answerable from the row six months later.
    mediaType: ref?.mediaType || null,
    mediaPolicy: ref ? (group.media_policy || 'inherit') : null,
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
        capture_source, capture_meta, is_automated,
        media_source, media_status, media_error, media_expires_at,
        media_mime_type, media_filename, media_caption, media_file_size,
        session_media_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10),
             $11,$12,$13,'session',$14,false,
             $15,$16,$17,$18,
             $19,$20,$21,$22,
             $23)
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
      mediaSource, mediaStatus, mediaError, mediaExpires,
      mediaMime, mediaFileName, mediaCaption, mediaSize,
      ref ? JSON.stringify(ref) : null,
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

  // Tell the worker to fetch, and hand back the DATABASE id it must upload
  // against. The worker still holds the decrypted message proto in memory at
  // this moment, so this is the cheapest and freshest possible fetch — the CDN
  // copy is seconds old. Everything else (heartbeat polling, the sweep) is a
  // backstop for when this fast path is missed.
  const fetchMedia = mediaStatus === 'pending'
    ? { messageId: rows[0].id, mediaType: ref.mediaType, fileLength: ref.fileLength || null }
    : null;

  return {
    stored: true, messageId: rows[0].id, threadId: thread.id, groupId: group.id,
    fetchMedia,
    // Present but not fetched, and why. The worker logs it; nobody has to guess
    // whether an attachment was missed or declined.
    mediaSkipped: mediaStatus === 'skipped' ? (mediaError || 'policy') : null,
  };
}

/** Register or refresh a group we have been added to. */
/**
 * Persist a group ONLY when a human has already decided about it, or when the
 * caller is explicitly recording a decision.
 *
 * Cataloguing every group the number belongs to is what produced a 306-row
 * table of somebody's alumni groups and residents' associations. The live list
 * lives in groupCache (memory, short TTL); this table holds DECISIONS.
 *
 * @param {boolean} opts.createIfMissing  true only from the watch/bind paths
 * @returns the row, or null when the group is undecided and none exists
 */
async function upsertSessionGroup(sessionId, orgId, { jid, subject, participantCount = null, createdAt = null, via = 'message', createIfMissing = false }) {
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM whatsapp_session_groups WHERE session_id = $1 AND group_jid = $2`,
    [sessionId, jid]
  );

  if (existing) {
    // Refresh what we already hold — a decided group's name may have changed.
    const { rows: [updated] } = await pool.query(
      `UPDATE whatsapp_session_groups
          SET subject           = COALESCE($3, subject),
              participant_count = COALESCE($4, participant_count),
              updated_at        = now()
        WHERE id = $1 AND org_id = $2
        RETURNING *`,
      [existing.id, orgId, subject, participantCount]
    );
    return updated;
  }

  if (!createIfMissing) return null;   // undecided: nothing is written

  const { rows: [group] } = await pool.query(
    `INSERT INTO whatsapp_session_groups
       (session_id, org_id, group_jid, subject, participant_count, group_created_at, discovered_via)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (session_id, group_jid) DO UPDATE SET
       subject           = COALESCE(EXCLUDED.subject, whatsapp_session_groups.subject),
       participant_count = COALESCE(EXCLUDED.participant_count, whatsapp_session_groups.participant_count),
       updated_at        = now()
     RETURNING *`,
    [sessionId, orgId, jid, subject, participantCount,
     createdAt ? new Date(createdAt * 1000) : null, via]
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

  // Link to a GoWarmCRM user when the number is a verified one. This is what
  // grants that user self-service search over this group, so it must only ever
  // match a VERIFIED number — see whatsappAccess.linkParticipantIfKnown.
  try {
    await require('./whatsappAccess.service').linkParticipantIfKnown(orgId, threadId, waPhone);
  } catch (err) {
    console.warn(`[wa-session] user link failed for ${waPhone}: ${err.message}`);
  }
}

/** Roster refresh from a groups.update / group-participants.update event. */
async function syncGroupMetadata(sessionId, { jid, subject, participants = [], owner = null, creation = null, ...opts }) {
  const session = await getSessionById(sessionId);
  if (!session) return { ok: false };

  const group = await upsertSessionGroup(session.id, session.org_id, {
    jid, subject, participantCount: participants.length || null, createdAt: creation,
    via: opts.via || 'metadata',
  });

  // Undecided group: its name and roster stay in the in-memory snapshot only.
  if (!group) return { ok: true, persisted: false };

  // For a DECIDED group, record which GoWarmCRM users are in it — that is what
  // scopes self-service search. Only the intersection with verified org users
  // is stored; non-user participants are matched in memory and discarded.
  try {
    await syncOrgMembersForGroup(session.org_id, group.id, participants);
  } catch (err) {
    console.warn(`[wa-session] org member sync failed for ${jid}: ${err.message}`);
  }

  if (!group.thread_id) return { ok: true, thread: null, groupId: group.id };

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

/**
 * Store the intersection of a group's participants with VERIFIED users of this
 * org, and nothing else. Marks anyone previously recorded but now absent as
 * having left, so search stays time-bounded.
 */
async function syncOrgMembersForGroup(orgId, sessionGroupId, participants = []) {
  const phones = participants
    .map(p => phoneFromJid(p.id || p.jid))
    .filter(Boolean);

  // One query resolves the whole roster against org users; unmatched numbers
  // never leave this function.
  const { rows: users } = phones.length
    ? await pool.query(
        `SELECT id FROM users
          WHERE org_id = $1 AND whatsapp_phone = ANY($2::text[])
            AND whatsapp_phone_verified_at IS NOT NULL`,
        [orgId, phones]
      )
    : { rows: [] };

  const userIds = users.map(u => u.id);

  if (userIds.length) {
    await pool.query(
      `INSERT INTO whatsapp_session_group_members (session_group_id, org_id, user_id)
       SELECT $1, $2, unnest($3::int[])
       ON CONFLICT (session_group_id, user_id)
         DO UPDATE SET last_seen_at = now(), left_at = NULL`,
      [sessionGroupId, orgId, userIds]
    );
  }

  // Anyone we previously recorded who is no longer in the roster has left.
  // Their access to prior messages is preserved by the time window; what stops
  // is access to anything sent after this point.
  await pool.query(
    `UPDATE whatsapp_session_group_members
        SET left_at = now()
      WHERE session_group_id = $1 AND org_id = $2 AND left_at IS NULL
        AND NOT (user_id = ANY($3::int[]))`,
    [sessionGroupId, orgId, userIds]
  );

  return { linked: userIds.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Triage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups awaiting a human decision, newest chatter first. This is the screen
 * that turns raw capture into CRM data — without it the messages land in
 * threads nobody can find.
 */
async function listTriage(orgId, { status = 'all', watched = null, q = null, limit = 200 } = {}) {
  const params = [orgId];
  const where = ['g.org_id = $1'];

  if (status && status !== 'all') { params.push(status); where.push(`g.binding_status = $${params.length}`); }
  if (watched === true  || watched === 'true')  where.push('g.is_watched = true');
  if (watched === false || watched === 'false') where.push('g.is_watched = false');
  if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`lower(coalesce(g.subject,'')) LIKE $${params.length}`); }

  params.push(Math.min(parseInt(limit, 10) || 200, 500));

  const { rows } = await pool.query(
    `SELECT g.id, g.group_jid, g.subject, g.participant_count, g.message_count,
            g.last_message_at, g.first_seen_at, g.binding_status, g.is_watched,
            g.discovered_via, g.thread_id, t.handover_id,
            g.media_policy, g.media_policy_at,
            (pu.first_name || ' ' || pu.last_name) AS media_policy_by_name,
            -- Attachments that arrived but are not in the customer's storage.
            -- Surfaced next to the group because that is where the setting
            -- that caused it lives; a count buried in a per-message list is a
            -- count nobody reads.
            (SELECT count(*) FROM whatsapp_messages mm
              WHERE mm.thread_id = g.thread_id
                AND mm.media_source = 'session'
                AND mm.media_status IN ('skipped', 'failed', 'expired')) AS media_unstored,
            h.name AS project_name,
            (SELECT m.body FROM whatsapp_messages m
              WHERE m.thread_id = g.thread_id
              ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview
       FROM whatsapp_session_groups g
       LEFT JOIN whatsapp_threads   t ON t.id = g.thread_id
       LEFT JOIN sales_handovers    h ON h.id = t.handover_id
       LEFT JOIN users              pu ON pu.id = g.media_policy_by
      WHERE ${where.join(' AND ')}
      ORDER BY g.is_watched DESC, g.last_message_at DESC NULLS LAST, g.subject
      LIMIT $${params.length}`,
    params
  );

  const { rows: [counts] } = await pool.query(
    `SELECT count(*)                                        AS total,
            count(*) FILTER (WHERE is_watched)              AS watched,
            count(*) FILTER (WHERE binding_status='bound')  AS bound,
            count(*) FILTER (WHERE binding_status='unbound' AND is_watched) AS needs_binding
       FROM whatsapp_session_groups WHERE org_id = $1`,
    [orgId]
  );

  return {
    groups: rows,
    counts: {
      total:        Number(counts.total),
      watched:      Number(counts.watched),
      bound:        Number(counts.bound),
      needsBinding: Number(counts.needs_binding),
    },
  };
}

/**
 * The PM's per-group attachment decision.
 *
 * Recorded with who and when, because "why are this group's documents not in
 * the project folder" is a question somebody will ask months later, and
 * "because a setting was off" is not an answer if nobody can say who set it.
 *
 * Loosening the policy immediately requeues everything the old policy skipped
 * and that is still inside the retention window. Without that, switching a
 * group from 'none' to 'all' would only affect FUTURE attachments — the ones
 * already declined would stay declined, which is not what anyone means when
 * they turn a setting on.
 */
async function setGroupMediaPolicy(orgId, userId, groupIds, policy) {
  const allowed = ['inherit', 'all', 'documents', 'none'];
  if (!allowed.includes(policy)) {
    return { ok: false, code: 'BAD_POLICY', error: `policy must be one of ${allowed.join(', ')}` };
  }
  const ids = (groupIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!ids.length) return { ok: false, code: 'NO_IDS' };

  const { rows } = await pool.query(
    `UPDATE whatsapp_session_groups
        SET media_policy    = $1,
            media_policy_by = $2,
            media_policy_at = now(),
            updated_at      = now()
      WHERE org_id = $3 AND id = ANY($4::int[])
      RETURNING id, thread_id, subject`,
    [policy, userId || null, orgId, ids]
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };

  let requeued = 0;
  if (policy !== 'none') {
    const threadIds = rows.map(r => r.thread_id).filter(Boolean);
    if (threadIds.length) {
      // 'documents' only revives documents; 'all' and 'inherit' revive
      // everything. Reviving a photo into a documents-only group would be a
      // setting quietly disagreeing with itself.
      const { rowCount } = await pool.query(
        `UPDATE whatsapp_messages
            SET media_status = 'pending', media_error = 'requeued: group media policy changed'
          WHERE thread_id = ANY($1::int[])
            AND org_id = $2
            AND media_source = 'session'
            AND media_status = 'skipped'
            AND session_media_ref IS NOT NULL
            AND (media_expires_at IS NULL OR media_expires_at > now())
            AND ($3::text <> 'documents' OR message_type = 'document')`,
        [threadIds, orgId, policy]
      );
      requeued = rowCount;
    }
  }

  return { ok: true, updated: rows.length, policy, requeued };
}

/**
 * Does this session own this message? The authorisation check behind
 * /internal/media/:messageId.
 *
 * The worker holds a shared secret, not an org identity, so without this any
 * worker could upload bytes against any message id in any org. The link is
 * message → thread → the session group that created that thread.
 */
async function sessionOwnsMessage(sessionId, messageId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.org_id
       FROM whatsapp_messages m
       JOIN whatsapp_session_groups g ON g.thread_id = m.thread_id
      WHERE m.id = $1 AND g.session_id = $2
      LIMIT 1`,
    [messageId, sessionId]
  );
  return rows[0] || null;
}

/**
 * Turn message retention on or off for specific groups. Bulk by design: with
 * hundreds of catalogued groups, one-at-a-time is not a workable interaction.
 */
async function setWatch(orgId, userId, groupIds, watched) {
  const ids = (groupIds || []).map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!ids.length) return { ok: false, code: 'NO_IDS' };

  const { rowCount } = await pool.query(
    `UPDATE whatsapp_session_groups
        SET is_watched = $1,
            watched_by = CASE WHEN $1 THEN $2 ELSE watched_by END,
            watched_at = CASE WHEN $1 THEN now() ELSE watched_at END,
            updated_at = now()
      WHERE org_id = $3 AND id = ANY($4::int[])`,
    [!!watched, userId || null, orgId, ids]
  );
  return { ok: true, updated: rowCount, watched: !!watched };
}

/**
 * Attach a captured group to a project. Writes the link onto the THREAD (which
 * is what the Communications tab reads) and back-fills every message already
 * captured from this group that has no project of its own — otherwise binding
 * on Friday loses Monday to Thursday.
 */
async function bindGroup(orgId, userId, groupId, handoverId) {
  const { rows: [group] } = await pool.query(
    `SELECT * FROM whatsapp_session_groups WHERE id = $1 AND org_id = $2`,
    [groupId, orgId]
  );
  if (!group) return { ok: false, code: 'NOT_FOUND' };
  if (!group.thread_id) {
    return { ok: false, code: 'NO_THREAD', error: 'Nothing captured from this group yet — switch capture on first.' };
  }

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
      `UPDATE whatsapp_threads SET handover_id = $1, updated_at = now()
        WHERE id = $2 AND org_id = $3`,
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
          SET binding_status = 'bound', bound_by = $1, bound_at = now(),
              -- Binding to a project is an unambiguous statement that this
              -- group's contents belong in the CRM, so it implies watching.
              is_watched = true,
              watched_by = COALESCE(watched_by, $1),
              watched_at = COALESCE(watched_at, now()),
              updated_at = now()
        WHERE id = $2`,
      [userId || null, groupId]
    );

    await client.query('COMMIT');

    // Binding is one of the two events that un-strands an attachment — the
    // other is choosing an upload folder. Every message captured before this
    // moment was skipped with "this WhatsApp thread is not linked to a
    // project", and that sentence has just stopped being true. Backfilling the
    // handover_id above without also requeueing the media would leave the
    // messages on the project and their attachments permanently absent.
    //
    // After COMMIT and outside the transaction: this is recovery, not part of
    // the binding, and a storage hiccup must not roll back the bind.
    let mediaRequeued = 0;
    try {
      const media = require('./whatsappMedia.service');
      ({ requeued: mediaRequeued } = await media.requeueForProject(
        orgId, handoverId, 'group bound to project'
      ));
    } catch (err) {
      console.warn(`[wa-session] media requeue after bind failed (group ${groupId}): ${err.message}`);
    }

    return { ok: true, threadId: group.thread_id, handoverId, backfilled, mediaRequeued };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Switch capture on for groups identified by JID.
 *
 * This is the path the triage screen uses now, because an undecided group has
 * no database id — it exists only in the in-memory snapshot. Switching capture
 * on IS the decision, so this is the moment the row is created.
 */
async function watchByJid(orgId, sessionId, userId, jids = [], watched = true, snapshot = []) {
  const list = (jids || []).filter(Boolean);
  if (!list.length) return { ok: false, code: 'NO_JIDS' };

  const byJid = new Map(snapshot.map(g => [g.jid, g]));
  const results = [];

  for (const jid of list) {
    const meta = byJid.get(jid) || {};
    const group = await upsertSessionGroup(sessionId, orgId, {
      jid,
      subject: meta.subject || null,
      participantCount: meta.participants ?? null,
      via: 'snapshot',
      // Turning capture ON creates the row. Turning it OFF only updates an
      // existing one — we never write a row to record a "no".
      createIfMissing: !!watched,
    });
    if (!group) { results.push({ jid, ok: false, reason: 'NOT_DECIDED' }); continue; }

    await pool.query(
      `UPDATE whatsapp_session_groups
          SET is_watched = $1,
              watched_by = CASE WHEN $1 THEN $2 ELSE watched_by END,
              watched_at = CASE WHEN $1 THEN now() ELSE watched_at END,
              updated_at = now()
        WHERE id = $3 AND org_id = $4`,
      [!!watched, userId || null, group.id, orgId]
    );
    results.push({ jid, ok: true, groupId: group.id });
  }

  return { ok: true, updated: results.filter(r => r.ok).length, results, watched: !!watched };
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

  // Liveness is measured on the HEARTBEAT, not on message arrival. A silent
  // group and a dead worker look identical by traffic; only a timer-driven
  // ping tells them apart.
  const heartbeatStaleMins = minsSince(session.heartbeat_at);
  const socketStaleMins    = minsSince(session.last_seen_at);
  const phoneStaleDays     = daysSince(session.phone_last_seen_at);
  const heartbeatBudget    = Math.ceil(((session.heartbeat_seconds || 60) * 3) / 60);

  const warnings = [];
  if (session.status === 'logged_out') {
    warnings.push({ level: 'critical', message: 'Session logged out — a human must rescan the QR from the handset.' });
  }
  if (session.status === 'connected' && heartbeatStaleMins == null) {
    warnings.push({ level: 'warning', message: 'Connected but no heartbeat received yet.' });
  }
  if (session.status === 'connected' && heartbeatStaleMins != null && heartbeatStaleMins > heartbeatBudget) {
    warnings.push({ level: 'critical', message: `No heartbeat for ${heartbeatStaleMins} minutes — the worker is not running.` });
  }
  if (session.reconnect_count >= 10) {
    warnings.push({ level: 'warning', message: `${session.reconnect_count} reconnects — the number may be contested or rate-limited.` });
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
    captureMode: session.capture_mode,
    label: session.label,
    heartbeatStaleMins,
    socketStaleMins,
    phoneStaleDays,
    lastMessageAt: session.last_message_at,
    reconnectCount: session.reconnect_count,
    config: {
      heartbeatSeconds:    session.heartbeat_seconds,
      flushIntervalMs:     session.flush_interval_ms,
      batchMax:            session.batch_max,
      staleSocketMinutes:  session.stale_socket_minutes,
      reconnectMaxSeconds: session.reconnect_max_seconds,
    },
    groups: { unbound: Number(counts.unbound), bound: Number(counts.bound) },
    warnings,
    healthy: warnings.every(w => w.level !== 'critical'),
  };
}

module.exports = {
  groupCache,
  watchByJid,
  syncOrgMembersForGroup,
  setWatch,
  getRuntimeConfig,
  updateRuntimeConfig,
  heartbeat,
  recordReconnect,
  confirmPhoneSeen,
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
  // media
  setGroupMediaPolicy,
  sessionOwnsMessage,
  // exported for tests
  normalizeContent,
  phoneFromJid,
  isGroupJid,
  buildSessionMediaRef,
  mediaPolicyFor,
  sessionMediaExpiry,
  toB64,
};
