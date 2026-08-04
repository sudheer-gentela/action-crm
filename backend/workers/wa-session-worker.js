/**
 * wa-session-worker.js
 *
 * DROP-IN LOCATION: backend/workers/wa-session-worker.js
 *
 * A SEPARATE Railway service. Do not run this inside the API process.
 *
 * WHY ITS OWN SERVICE
 *   A Baileys socket is a long-lived, stateful WebSocket holding Signal
 *   ratchet state. It cannot be horizontally scaled: two replicas on one number
 *   means two companion devices fighting over the same ratchet, which desyncs
 *   the keys and kills the session. It also must not restart every time you
 *   push an API change. So: replicas = 1, no autoscale, deploys rare.
 *
 *   Railway service config:
 *     Start command : node workers/wa-session-worker.js
 *     Replicas      : 1                       ← not negotiable
 *     Env           : WA_SESSION_API_URL, WA_SESSION_WORKER_SECRET
 *                     (that is the complete list — no DB, no crypto key)
 *
 * READ-ONLY CONTRACT — the three settings below are load-bearing:
 *
 *   markOnlineOnConnect: false
 *     Otherwise the account is marked permanently online and WhatsApp stops
 *     sending push notifications to the human's handset. Whoever owns that
 *     number will notice within a day and will be right to be annoyed.
 *
 *   never call sock.readMessages()
 *     Marking chats read from a server wrecks the human's unread state and
 *     shows blue ticks to people who were not read by a person.
 *
 *   never call sock.sendMessage()
 *     Sending is what turns "an extra linked device" into "an automation
 *     endpoint" in WhatsApp's eyes. Observation has a far smaller enforcement
 *     surface. There is no send path in this file and there should never be one.
 *
 *   never call updateMediaMessage()
 *     Baileys' documented recovery when the CDN has dropped an attachment: it
 *     asks the SENDER'S DEVICE to re-upload. That is a message we send, from a
 *     device that is supposed to only watch — and it is visible to the person
 *     on the other end, whose phone wakes up to service a request no human
 *     made. When the CDN has lost it, it is lost; we mark it expired and say
 *     so. The one place this would be tempting is fetchAndUpload's 404 branch,
 *     which is why the branch says so out loud.
 */

'use strict';

require('dotenv').config();

// This worker holds NO database connection. Session key material moves over the
// same HTTPS channel as everything else (see services/whatsapp/
// sessionAuthStore.js), so there is no DATABASE_URL, no AI_CREDS_KEY, and no
// private-network dependency here. One transport, one failure mode.
const API_WAIT_MAX_MS = parseInt(process.env.WA_SESSION_API_WAIT_MS || '120000', 10);

const API_URL       = process.env.WA_SESSION_API_URL || 'http://localhost:5000';
const WORKER_SECRET = process.env.WA_SESSION_WORKER_SECRET;
const POLL_MS       = parseInt(process.env.WA_SESSION_POLL_MS || '30000', 10);

// Per-session tuning lives in the DATABASE, not here — see migration 102. These
// are only the values used before the first heartbeat returns real ones, and on
// the fallback path if the API is briefly unreachable.
const DEFAULTS = {
  heartbeatSeconds:    60,
  flushIntervalMs:     2000,
  batchMax:            50,
  staleSocketMinutes:  20,
  reconnectMaxSeconds: 300,
  captureEnabled:      true,
  // Media defaults are deliberately CLOSED. captureEnabled defaults open
  // because losing text to a brief config outage is the worse error; writing
  // an attachment into somebody's Drive on a guessed default is not — that is
  // a decision an admin makes, and until the first heartbeat confirms it, we
  // do not have it.
  captureMedia:        false,
  mediaMaxBytes:       25 * 1024 * 1024,
};

if (!WORKER_SECRET) {
  console.error('[wa-session] WA_SESSION_WORKER_SECRET is required');
  process.exit(1);
}

const { useRemoteAuthState } = require('../services/whatsapp/sessionAuthStore');

// Active sockets keyed by session id, so the poller does not open a second
// socket for a session it already runs.
const sockets = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// API client
// ─────────────────────────────────────────────────────────────────────────────

async function api(path, body) {
  const res = await fetch(`${API_URL}/api/whatsapp-session${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Failing to report status must never kill the socket — the socket is the
// valuable thing and the API may just be mid-deploy.
async function safeApi(path, body) {
  try { return await api(path, body); }
  catch (err) { console.error(`[wa-session] ${path} failed: ${err.message}`); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound buffer
//
// A busy group produces bursts. One HTTP round trip per message would make the
// API the bottleneck and multiply write transactions. Buffer briefly, flush on
// size or time, and preserve order within a flush.
// ─────────────────────────────────────────────────────────────────────────────

function makeBuffer(sessionId, getConfig, mediaQueue) {
  let queue = [];
  let timer = null;

  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      const out = await api('/internal/messages', { sessionId, messages: batch });
      console.log(`[wa-session:${sessionId}] flushed ${batch.length}, stored ${out.stored}`);

      // The fast path for attachments. The API answers per message, in order,
      // so results[i] belongs to batch[i] — and batch[i] still carries the
      // media descriptor, which is what turns a database id into something
      // fetchable. This runs seconds after the message arrived, when the CDN
      // copy is freshest.
      if (mediaQueue && Array.isArray(out.results)) {
        out.results.forEach((r, i) => {
          if (r?.fetchMedia?.messageId && batch[i]?.media) {
            mediaQueue.push({
              messageId: r.fetchMedia.messageId,
              ref: batch[i].media,
              fileSize: r.fetchMedia.fileLength || null,
            });
          } else if (r?.mediaSkipped) {
            console.log(`[wa-session:${sessionId}] attachment not captured: ${r.mediaSkipped}`);
          }
        });
      }
    } catch (err) {
      // Put them back at the FRONT so ordering survives a transient API blip,
      // but cap the retry queue: an API that has been down for an hour should
      // not accumulate unbounded memory and OOM the worker.
      console.error(`[wa-session:${sessionId}] flush failed, requeueing: ${err.message}`);
      queue = [...batch, ...queue].slice(0, 1000);
      schedule();
    }
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(() => { flush().catch(() => {}); }, getConfig().flushIntervalMs);
  };

  return {
    push(evt) {
      queue.push(evt);
      if (queue.length >= getConfig().batchMax) flush().catch(() => {});
      else schedule();
    },
    flush,
  };
}

/**
 * The fetch handle for an attachment, base64-encoded and flattened.
 *
 * Unwraps the same containers normalizeContent does on the API side —
 * ephemeral, view-once, document-with-caption — because an attachment inside a
 * disappearing message is still an attachment, and missing the unwrap means
 * exactly those messages silently lose their files.
 *
 * Returns null for anything without an attachment, which is most messages.
 */
function extractMediaRef(message, depth = 0) {
  if (!message || depth > 3) return null;

  if (message.ephemeralMessage)   return extractMediaRef(message.ephemeralMessage.message, depth + 1);
  if (message.viewOnceMessage)    return extractMediaRef(message.viewOnceMessage.message, depth + 1);
  if (message.viewOnceMessageV2)  return extractMediaRef(message.viewOnceMessageV2.message, depth + 1);
  if (message.documentWithCaptionMessage) {
    return extractMediaRef(message.documentWithCaptionMessage.message, depth + 1);
  }

  const found =
    (message.imageMessage    && ['image',    message.imageMessage])    ||
    (message.videoMessage    && ['video',    message.videoMessage])    ||
    (message.documentMessage && ['document', message.documentMessage]) ||
    (message.audioMessage    && ['audio',    message.audioMessage])    ||
    (message.stickerMessage  && ['sticker',  message.stickerMessage])  ||
    null;
  if (!found) return null;

  const [mediaType, m] = found;
  const b64 = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    try { return Buffer.from(v).toString('base64'); } catch { return null; }
  };

  // An attachment we cannot fetch is worse than one we do not record: it sits
  // in the queue failing forever. Report it as absent instead.
  if (!m.mediaKey || !m.directPath) return null;

  return {
    mediaType,
    mediaKey:      b64(m.mediaKey),
    directPath:    m.directPath,
    url:           m.url || null,
    fileEncSha256: b64(m.fileEncSha256),
    fileSha256:    b64(m.fileSha256),
    fileLength:    m.fileLength ? Number(m.fileLength) : null,
    mimetype:      m.mimetype || null,
    fileName:      m.fileName || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Media queue
//
// Attachments are fetched on a SEPARATE, serialised path from the message
// buffer. Three reasons, all about protecting the socket:
//
//   1. Serial, not parallel. This process holds a live Signal socket. Four
//      concurrent 20 MB downloads is the memory and bandwidth spike that gets
//      that socket dropped, and the socket is the expensive thing to lose —
//      re-pairing needs a human with the handset.
//   2. Never blocks message capture. A slow CDN must not delay the text flush;
//      text is the thing every downstream feature reads.
//   3. Bounded. A backlog is capped and dropped from the FRONT rather than
//      accumulating until the worker OOMs. Anything dropped is still in
//      Postgres as 'pending' and comes back on the next heartbeat, so the
//      queue is a fast path, not the system of record.
//
// WHAT IS STREAMED AND WHAT IS NOT
//   downloadContentFromMessage returns an async iterable of decrypted chunks.
//   Those chunks are piped straight into the multipart request body, so the
//   whole file is never assembled in this process's heap. The API buffers it
//   (multer memoryStorage) because the storage providers' upload APIs take a
//   Buffer — but that is one hop, on a process with no socket to protect, under
//   a size cap the API enforces itself.
// ─────────────────────────────────────────────────────────────────────────────

const MEDIA_MAX_QUEUE = parseInt(process.env.WA_SESSION_MEDIA_QUEUE_MAX || '200', 10);

function makeMediaQueue(sessionId, getConfig) {
  const queue = [];
  const seen = new Set();     // message ids in flight or queued, so the fast
                              // path and the heartbeat backstop cannot both
                              // fetch the same attachment
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          await fetchAndUpload(sessionId, job, getConfig);
        } catch (err) {
          // Already reported to the API inside fetchAndUpload where possible.
          // Reaching here means even the reporting failed; the row stays
          // 'pending' and the next heartbeat offers it again.
          console.error(`[wa-session:${sessionId}] media ${job.messageId} failed: ${err.message}`);
        } finally {
          seen.delete(job.messageId);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    push(job) {
      if (!job?.messageId || seen.has(job.messageId)) return;
      if (queue.length >= MEDIA_MAX_QUEUE) {
        // Drop the OLDEST. A newer attachment is closer to its CDN expiry
        // being irrelevant and more likely to be what someone is waiting for;
        // the dropped one is still 'pending' in Postgres and will be re-offered.
        const dropped = queue.shift();
        if (dropped) seen.delete(dropped.messageId);
        console.warn(`[wa-session:${sessionId}] media queue full; deferring ${dropped?.messageId} to the heartbeat backstop`);
      }
      seen.add(job.messageId);
      queue.push(job);
      drain().catch(() => {});
    },
    get size() { return queue.length; },
  };
}

/**
 * Rebuild the Baileys media object from a stored descriptor.
 *
 * The descriptor round-trips through Postgres as base64 strings; Baileys wants
 * Buffers. Getting this wrong does not throw — it decrypts to garbage or fails
 * the MAC check with an error that reads like a library bug.
 */
function refToMediaMessage(ref) {
  const buf = (b64) => (b64 ? Buffer.from(String(b64), 'base64') : undefined);
  return {
    mediaKey:      buf(ref.mediaKey),
    directPath:    ref.directPath,
    url:           ref.url || undefined,
    fileEncSha256: buf(ref.fileEncSha256),
    fileSha256:    buf(ref.fileSha256),
    fileLength:    ref.fileLength || undefined,
    mimetype:      ref.mimetype || undefined,
    fileName:      ref.fileName || undefined,
  };
}

/** Tell the API this one is not coming. */
async function reportMediaFailure(sessionId, messageId, reason, flags = {}) {
  await safeApi(`/internal/media/${messageId}/failed`, {
    sessionId, reason: String(reason || '').slice(0, 400), ...flags,
  });
}

/**
 * Fetch one attachment and stream it to the API.
 *
 * NEVER calls updateMediaMessage(). That is Baileys' documented recovery for a
 * CDN 404 — it asks the sending device to re-upload — and it is a MESSAGE we
 * would be sending. See the READ-ONLY CONTRACT at the top of this file: this
 * device observes. A 404 here is a real, permanent loss and is reported as one.
 */
async function fetchAndUpload(sessionId, job, getConfig) {
  const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
  const { Readable } = require('stream');

  const { messageId, ref } = job;
  const limit = Number(getConfig().mediaMaxBytes) || 25 * 1024 * 1024;

  // ── Size gate, before a single byte moves ──
  //
  // fileLength is the sender's declaration and is not trustworthy on its own,
  // which is why the stream is metered below as well. But when it IS present
  // and over the limit, refusing here saves the whole download.
  const declared = Number(ref?.fileLength || job.fileSize || 0);
  if (declared && declared > limit) {
    const reason = `attachment is ${(declared / 1048576).toFixed(1)} MB — above this session's ${Math.round(limit / 1048576)} MB limit`;
    console.warn(`[wa-session:${sessionId}] media ${messageId} skipped: ${reason}`);
    await reportMediaFailure(sessionId, messageId, reason, { skipped: true });
    return;
  }

  if (!ref?.mediaKey || !ref?.directPath || !ref?.mediaType) {
    await reportMediaFailure(sessionId, messageId, 'incomplete media descriptor — cannot fetch', { skipped: true });
    return;
  }

  let stream;
  try {
    stream = await downloadContentFromMessage(refToMediaMessage(ref), ref.mediaType);
  } catch (err) {
    const status = err?.output?.statusCode || err?.status || err?.response?.status;
    // 404/410 from the CDN: the ciphertext is gone. The only recovery WhatsApp
    // offers is a re-upload request we will not send, so this is terminal.
    if (status === 404 || status === 410) {
      await reportMediaFailure(sessionId, messageId,
        'WhatsApp no longer has this attachment on its CDN', { expired: true });
      return;
    }
    await reportMediaFailure(sessionId, messageId, err.message);
    return;
  }

  // ── Meter the stream ──
  //
  // The declared length can lie or be absent. Counting as we go means an
  // oversized file is abandoned partway rather than discovered after we have
  // already paid for all of it — and the API is told the truthful reason.
  let bytes = 0;
  let overLimit = false;
  const metered = Readable.from((async function* () {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > limit) { overLimit = true; return; }
      yield chunk;
    }
  })());

  const fileName = ref.fileName || `whatsapp-${ref.mediaType}-${messageId}`;
  const mimeType = ref.mimetype || 'application/octet-stream';

  let res;
  try {
    res = await postMultipart(`/internal/media/${messageId}`, {
      sessionId, fileName, mimeType, stream: metered,
    });
  } catch (err) {
    if (overLimit) {
      const reason = `attachment exceeds this session's ${Math.round(limit / 1048576)} MB limit (declared size was ${declared ? 'wrong' : 'absent'})`;
      await reportMediaFailure(sessionId, messageId, reason, { skipped: true });
      return;
    }
    await reportMediaFailure(sessionId, messageId, err.message);
    return;
  }

  if (overLimit) {
    // The truncated body reached the API. Say so rather than let a partial
    // file be stored as if it were whole — a corrupt document in a customer's
    // project folder is worse than a visibly missing one.
    const reason = `attachment exceeds this session's ${Math.round(limit / 1048576)} MB limit`;
    await reportMediaFailure(sessionId, messageId, reason, { skipped: true });
    return;
  }

  console.log(`[wa-session:${sessionId}] media ${messageId} -> ${res?.status || 'unknown'} (${Math.round(bytes / 1024)} KB)`);
}

/**
 * multipart/form-data, streamed, with no dependency added.
 *
 * form-data is not a direct dependency and relying on axios pulling it in
 * transitively is how a working deploy breaks on an unrelated bump. Node 22's
 * fetch accepts a web ReadableStream body with duplex:'half', so the multipart
 * envelope is generated here and the file chunks pass straight through. No
 * Content-Length, so this goes out chunked — busboy (under multer) handles
 * that natively.
 */
async function postMultipart(path, { sessionId, fileName, mimeType, stream, fields = {} }) {
  const { Readable } = require('stream');
  const boundary = `gw${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

  const escape = (s) => String(s).replace(/"/g, '%22').replace(/[\r\n]/g, ' ');

  const body = Readable.from((async function* () {
    for (const [k, v] of Object.entries({ mimeType, ...fields })) {
      if (v == null) continue;
      yield Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escape(k)}"\r\n\r\n${v}\r\n`
      );
    }
    yield Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${escape(fileName)}"\r\n` +
      `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
    );
    for await (const chunk of stream) yield chunk;
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  })());

  const res = await fetch(`${API_URL}/api/whatsapp-session${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${WORKER_SECRET}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      // Read before the body, so the API can size its parser correctly.
      'x-wa-session-id': String(sessionId),
    },
    body: Readable.toWeb(body),
    duplex: 'half',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnect backoff
// ─────────────────────────────────────────────────────────────────────────────

const backoff = new Map();   // sessionId -> attempt count

function nextDelay(sessionId, maxSeconds) {
  const n = (backoff.get(sessionId) || 0) + 1;
  backoff.set(sessionId, n);
  // 5s, 10s, 20s, 40s ... capped at the configured ceiling. Jittered so a mass
  // reconnect after an outage does not arrive as a thundering herd.
  const base = Math.min(5000 * 2 ** (n - 1), (maxSeconds || 300) * 1000);
  return base + Math.floor(Math.random() * 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket
// ─────────────────────────────────────────────────────────────────────────────

async function startSession(sessionRow) {
  const sessionId = sessionRow.id;
  if (sockets.has(sessionId)) return;
  sockets.set(sessionId, { starting: true });

  const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
  } = require('@whiskeysockets/baileys');

  let auth;
  try {
    auth = await useRemoteAuthState(sessionId, { apiUrl: API_URL, workerSecret: WORKER_SECRET });
  } catch (err) {
    console.error(`[wa-session:${sessionId}] auth store unavailable: ${err.message}`);
    sockets.delete(sessionId);
    await safeApi('/internal/status', { sessionId, status: 'disconnected', statusDetail: err.message });
    return;
  }

  const { version } = await fetchLatestBaileysVersion();

  // Live, server-driven config. Refreshed on every heartbeat so an admin can
  // retune from the UI without a redeploy — a redeploy kills the socket, which
  // is precisely the thing we are protecting.
  let config = { ...DEFAULTS };
  const getConfig = () => config;

  let heartbeatTimer = null;
  let watchdogTimer  = null;

  // Last time this socket produced ANY event. The watchdog below keys on it.
  let lastEventAt = Date.now();
  const touch = () => { lastEventAt = Date.now(); };

  const mediaQueue = makeMediaQueue(sessionId, getConfig);
  const buffer = makeBuffer(sessionId, getConfig, mediaQueue);

  const sock = makeWASocket({
    version,
    auth: auth.state,
    // See the READ-ONLY CONTRACT at the top of this file.
    markOnlineOnConnect: false,
    // We do not want a full history dump: it is huge, it is mostly 1:1 traffic
    // we have no business storing, and WhatsApp does not backfill group history
    // to a device anyway. Present-to-future is the whole design.
    syncFullHistory: false,
    // Identifies us in the human's Linked Devices list. Being honest here is
    // both the decent thing and the thing that makes an audit defensible.
    browser: ['GoWarmCRM Capture', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  sockets.set(sessionId, { sock, buffer, mediaQueue, stopTimers: () => stopTimers() });

  sock.ev.on('creds.update', auth.saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      await safeApi('/internal/qr', { sessionId, qr });
      await safeApi('/internal/status', { sessionId, status: 'pending_qr', statusDetail: 'waiting for scan' });
    }

    if (connection === 'open') {
      backoff.delete(sessionId);
      touch();
      startTimers();
      const me = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      const phone = me ? me.split('@')[0].split(':')[0] : null;
      console.log(`[wa-session:${sessionId}] connected as ${phone}`);
      await safeApi('/internal/status', {
        sessionId, status: 'connected', statusDetail: null,
        waPhone: phone, pushName: sock.user?.name || null,
      });
      // Snapshot every group we are in, so triage is populated immediately
      // rather than only after someone happens to send a message.
      try {
        const all = await sock.groupFetchAllParticipating();
        const groups = Object.values(all).map(g => ({
          jid: g.id,
          subject: g.subject,
          owner: g.owner || null,
          creation: g.creation || null,
          participants: (g.participants || []).map(p => ({ id: p.id, name: p.notify || null })),
          via: 'snapshot',
        }));
        if (groups.length) {
          // Names and rosters go to the API's MEMORY cache, not its database.
          // Only groups a human switches on are ever persisted.
          await safeApi('/internal/group-snapshot', { sessionId, groups });
          console.log(`[wa-session:${sessionId}] cached ${groups.length} groups (nothing persisted until watched)`);
        }
      } catch (err) {
        console.error(`[wa-session:${sessionId}] group snapshot failed: ${err.message}`);
      }
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      stopTimers();
      sockets.delete(sessionId);
      await buffer.flush().catch(() => {});

      if (status === DisconnectReason.loggedOut) {
        // Terminal. The credentials are dead; retrying with them loops forever.
        // Wipe them so the next boot shows a QR, and tell a human — only
        // someone with the handset can fix this.
        console.error(`[wa-session:${sessionId}] LOGGED OUT — key material cleared, rescan required`);
        await auth.clear().catch(() => {});
        await safeApi('/internal/status', {
          sessionId, status: 'logged_out',
          statusDetail: 'WhatsApp ended the session. Rescan the QR from the handset.',
        });
        return;
      }

      const delay = nextDelay(sessionId, config.reconnectMaxSeconds);
      console.warn(`[wa-session:${sessionId}] closed (${status}); reconnecting in ${Math.round(delay / 1000)}s`);
      await safeApi('/internal/reconnect', { sessionId });
      await safeApi('/internal/status', {
        sessionId, status: 'disconnected', statusDetail: `closed (${status ?? 'unknown'})`,
      });
      setTimeout(() => { startSession(sessionRow).catch(e => console.error(e.message)); }, delay);
    }
  });

  // ── the actual capture ────────────────────────────────────────────────────

  // ── heartbeat + watchdog ─────────────────────────────────────────────────
  //
  // The heartbeat is what makes a dead worker distinguishable from a quiet
  // weekend: it writes on a timer regardless of traffic. The watchdog handles
  // the nastier failure — Baileys holding a TCP connection that WhatsApp has
  // actually abandoned, where connection.update never fires, no messages
  // arrive, and status stays 'connected' forever while capturing nothing.

  // Function declarations, not const arrows: these are referenced by the
  // connection.update handler registered further up the file, and hoisting
  // removes any temporal-dead-zone risk if an event ever arrives early.
  function stopTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (watchdogTimer)  { clearInterval(watchdogTimer);  watchdogTimer  = null; }
  }

  async function beat() {
    const out = await safeApi('/internal/heartbeat', { sessionId, socketConnected: true });

    // Someone has the triage screen open. Send the live group list — names and
    // counts only, straight into the API's memory cache. This is why the list
    // no longer needs to live in Postgres.
    if (out?.sendGroupSnapshot) {
      try {
        const all = await sock.groupFetchAllParticipating();
        const groups = Object.values(all).map(g => ({
          jid: g.id,
          subject: g.subject,
          creation: g.creation || null,
          participants: (g.participants || []).map(p => ({ id: p.id, name: p.notify || null })),
        }));
        await safeApi('/internal/group-snapshot', { sessionId, groups });
        console.log(`[wa-session:${sessionId}] sent snapshot of ${groups.length} groups`);
      } catch (err) {
        console.error(`[wa-session:${sessionId}] snapshot failed: ${err.message}`);
      }
    }

    // Attachments the API is still waiting on: a restart between capture and
    // upload, a storage folder configured after the fact, a Retry pressed in
    // the UI, a group whose media policy was just loosened. The fast path in
    // flush() covers the common case; this covers everything it missed, which
    // is the difference between "usually captured" and "captured".
    if (Array.isArray(out?.pendingMedia) && out.pendingMedia.length) {
      console.log(`[wa-session:${sessionId}] ${out.pendingMedia.length} attachment(s) queued from heartbeat`);
      for (const p of out.pendingMedia) {
        mediaQueue.push({ messageId: p.messageId, ref: p.ref, fileSize: p.fileSize });
      }
    }

    if (out?.config) {
      const before = JSON.stringify(config);
      config = { ...DEFAULTS, ...out.config };
      if (JSON.stringify(config) !== before) {
        console.log(`[wa-session:${sessionId}] config updated: ${JSON.stringify(config)}`);
      }
    }
  }

  function startTimers() {
    stopTimers();
    beat().catch(() => {});
    heartbeatTimer = setInterval(() => { beat().catch(() => {}); }, config.heartbeatSeconds * 1000);
    watchdogTimer = setInterval(() => {
      const idleMin = (Date.now() - lastEventAt) / 60000;
      if (idleMin < config.staleSocketMinutes) return;
      console.warn(`[wa-session:${sessionId}] no socket events for ${Math.round(idleMin)}min — forcing reconnect`);
      stopTimers();
      // end() emits connection.close, which runs the normal reconnect path —
      // no separate restart logic to keep in sync.
      try { sock.end(new Error('watchdog: stale socket')); } catch { /* already gone */ }
    }, 60000);
  }

  // Any event at all counts as proof of life, including ones we ignore.
  sock.ev.on('creds.update', touch);
  sock.ev.on('messaging-history.set', touch);
  sock.ev.on('chats.upsert', touch);
  sock.ev.on('presence.update', touch);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    touch();
    // 'notify' = live traffic. 'append' is history/backfill replay, which we
    // deliberately ignore: it is the pre-existing 1:1 conversation of whoever
    // owns this number, and storing it would be capturing material nobody in
    // any group consented to share.
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        const jid = m.key?.remoteJid;
        if (!jid || !jid.endsWith('@g.us')) continue;   // groups only, always
        if (!m.message) continue;                        // empty/protocol stub

        buffer.push({
          jid,
          messageId: m.key.id,
          participantJid: m.key.participant || m.participant || null,
          fromMe: !!m.key.fromMe,
          timestamp: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000),
          pushName: m.pushName || null,
          quotedMessageId:
            m.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
          baileysVersion: version.join('.'),
          // Base64 here, explicitly, rather than leaving the API to dig the
          // key out of `raw`. Byte fields do not survive JSON uniformly: a
          // Buffer round-trips fine, but a Uint8Array stringifies to an object
          // with numeric string keys that Buffer.from rejects outright —
          // which would fail the whole ingest batch over one attachment.
          // Encoding at the source makes the wire format one thing.
          media: extractMediaRef(m.message),
          raw: { message: m.message },
        });
      } catch (err) {
        console.error(`[wa-session:${sessionId}] event error: ${err.message}`);
      }
    }
  });

  // Roster and subject changes keep whatsapp_thread_participants honest, which
  // is what lets the CRM say "Nikhil (customer)" instead of a bare number.
  sock.ev.on('groups.update', async (updates) => {
    const groups = updates.filter(u => u.id).map(u => ({ jid: u.id, subject: u.subject }));
    if (groups.length) await safeApi('/internal/group-meta', { sessionId, groups });
  });

  sock.ev.on('group-participants.update', async ({ id }) => {
    try {
      const meta = await sock.groupMetadata(id);
      await safeApi('/internal/group-meta', {
        sessionId,
        groups: [{
          jid: meta.id,
          subject: meta.subject,
          owner: meta.owner || null,
          creation: meta.creation || null,
          participants: (meta.participants || []).map(p => ({ id: p.id, name: p.notify || null })),
        }],
      });
    } catch (err) {
      console.error(`[wa-session:${sessionId}] roster refresh failed: ${err.message}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervisor
// ─────────────────────────────────────────────────────────────────────────────

async function poll() {
  try {
    const { sessions } = await api('/internal/claim', {});
    for (const s of sessions) {
      if (!sockets.has(s.id)) {
        console.log(`[wa-session] starting session ${s.id} (org ${s.org_id}, status ${s.status})`);
        startSession(s).catch(err => console.error(`[wa-session:${s.id}] start failed: ${err.message}`));
      }
    }
    // Stop sockets whose session was disabled out from under us.
    const live = new Set(sessions.map(s => s.id));
    for (const [id, entry] of sockets) {
      if (!live.has(id)) {
        console.log(`[wa-session] session ${id} no longer active; closing socket`);
        try { entry.stopTimers?.(); } catch { /* nothing to stop */ }
        try { entry.sock?.end(); } catch { /* already gone */ }
        sockets.delete(id);
      }
    }
  } catch (err) {
    console.error(`[wa-session] poll failed: ${err.message}`);
  }
}

async function shutdown(signal) {
  console.log(`[wa-session] ${signal} received; flushing buffers`);
  for (const [, entry] of sockets) {
    try { await entry.buffer?.flush(); } catch { /* best effort */ }
    try { entry.sock?.end(); } catch { /* best effort */ }
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// An unhandled rejection inside a socket handler should be loud, not fatal:
// killing the process drops every session for one bad event.
process.on('unhandledRejection', (err) => {
  console.error('[wa-session] unhandled rejection:', err?.message || err);
});

/**
 * Block until the API answers, or until API_WAIT_MAX_MS elapses.
 *
 * Distinguishes the failure modes, because they need different fixes: a
 * network error means the API is not reachable yet (usually a deploy in
 * progress — wait), whereas a 401 means the shared secret does not match and
 * no amount of waiting will help.
 */
async function waitForApi() {
  const started = Date.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    try {
      await api('/internal/claim', {});
      console.log(`[wa-session] API reachable after ${Date.now() - started}ms (${attempt} attempt${attempt > 1 ? 's' : ''})`);
      return true;
    } catch (err) {
      const msg = String(err.message || '');
      const elapsed = Date.now() - started;

      if (msg.includes('-> 401')) {
        console.error('[wa-session] API rejected the worker secret (401)');
        console.error('[wa-session] WA_SESSION_WORKER_SECRET must be identical on this service and the API');
        return false;
      }
      if (msg.includes('-> 503')) {
        console.error('[wa-session] API has no WA_SESSION_WORKER_SECRET configured (503)');
        return false;
      }
      if (msg.includes('-> 404')) {
        console.error('[wa-session] API route not found (404) — is WA_SESSION_API_URL correct, and has the API deployed the session routes?');
        return false;
      }

      if (elapsed > API_WAIT_MAX_MS) {
        console.error(`[wa-session] API unreachable after ${Math.round(elapsed / 1000)}s: ${msg}`);
        console.error(`[wa-session] check WA_SESSION_API_URL (currently ${API_URL})`);
        return false;
      }

      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.log(`[wa-session] waiting for API (attempt ${attempt}); retry in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

(async () => {
  console.log(`[wa-session] worker starting; api=${API_URL} poll=${POLL_MS}ms`);

  const ready = await waitForApi();
  if (!ready) {
    // Exit rather than poll uselessly. Railway's restart policy brings us back,
    // and a crash loop with a clear reason is easier to notice than a worker
    // that appears healthy while capturing nothing.
    process.exit(1);
  }

  poll();
  setInterval(poll, POLL_MS);
})();
