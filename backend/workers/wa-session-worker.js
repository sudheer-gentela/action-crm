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
 *     Env           : WA_SESSION_API_URL, WA_SESSION_WORKER_SECRET,
 *                     DATABASE_URL, AI_CREDS_KEY
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
 */

'use strict';

require('dotenv').config();

const API_URL       = process.env.WA_SESSION_API_URL || 'http://localhost:5000';
const WORKER_SECRET = process.env.WA_SESSION_WORKER_SECRET;
const POLL_MS       = parseInt(process.env.WA_SESSION_POLL_MS || '30000', 10);
const FLUSH_MS      = parseInt(process.env.WA_SESSION_FLUSH_MS || '2000', 10);
const BATCH_MAX     = parseInt(process.env.WA_SESSION_BATCH_MAX || '50', 10);

if (!WORKER_SECRET) {
  console.error('[wa-session] WA_SESSION_WORKER_SECRET is required');
  process.exit(1);
}

const { usePostgresAuthState } = require('../services/whatsapp/sessionAuthStore');

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

function makeBuffer(sessionId) {
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
    if (!timer) timer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_MS);
  };

  return {
    push(evt) {
      queue.push(evt);
      if (queue.length >= BATCH_MAX) flush().catch(() => {});
      else schedule();
    },
    flush,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconnect backoff
// ─────────────────────────────────────────────────────────────────────────────

const backoff = new Map();   // sessionId -> attempt count

function nextDelay(sessionId) {
  const n = (backoff.get(sessionId) || 0) + 1;
  backoff.set(sessionId, n);
  // 5s, 10s, 20s, 40s ... capped at 5 min. Jittered so a mass reconnect after
  // an outage does not arrive as a thundering herd.
  const base = Math.min(5000 * 2 ** (n - 1), 300000);
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
    auth = await usePostgresAuthState(sessionId);
  } catch (err) {
    console.error(`[wa-session:${sessionId}] auth store unavailable: ${err.message}`);
    sockets.delete(sessionId);
    await safeApi('/internal/status', { sessionId, status: 'disconnected', statusDetail: err.message });
    return;
  }

  const { version } = await fetchLatestBaileysVersion();
  const buffer = makeBuffer(sessionId);

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

  sockets.set(sessionId, { sock, buffer });

  sock.ev.on('creds.update', auth.saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      await safeApi('/internal/qr', { sessionId, qr });
      await safeApi('/internal/status', { sessionId, status: 'pending_qr', statusDetail: 'waiting for scan' });
    }

    if (connection === 'open') {
      backoff.delete(sessionId);
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
        }));
        if (groups.length) {
          await safeApi('/internal/group-meta', { sessionId, groups });
          console.log(`[wa-session:${sessionId}] snapshotted ${groups.length} groups`);
        }
      } catch (err) {
        console.error(`[wa-session:${sessionId}] group snapshot failed: ${err.message}`);
      }
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
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

      const delay = nextDelay(sessionId);
      console.warn(`[wa-session:${sessionId}] closed (${status}); reconnecting in ${Math.round(delay / 1000)}s`);
      await safeApi('/internal/status', {
        sessionId, status: 'disconnected', statusDetail: `closed (${status ?? 'unknown'})`,
      });
      setTimeout(() => { startSession(sessionRow).catch(e => console.error(e.message)); }, delay);
    }
  });

  // ── the actual capture ────────────────────────────────────────────────────

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
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

console.log(`[wa-session] worker starting; api=${API_URL} poll=${POLL_MS}ms`);
poll();
setInterval(poll, POLL_MS);
