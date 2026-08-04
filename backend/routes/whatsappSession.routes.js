/**
 * whatsappSession.routes.js
 *
 * DROP-IN LOCATION: backend/routes/whatsappSession.routes.js
 *
 * Mount in server.js next to the other WhatsApp mounts:
 *   app.use('/api/whatsapp-session', require('./routes/whatsappSession.routes'));
 *
 * TWO AUDIENCES, TWO AUTH SCHEMES
 *   /internal/*  — called by the worker process. Bearer WA_SESSION_WORKER_SECRET.
 *                  No user, no JWT: the worker is a machine and has no org until
 *                  it tells us its session id.
 *   everything else — authenticateToken + orgContext, as usual.
 *
 *   GET    /                       — session status + health
 *   POST   /                       — create a session (admin), worker picks it up
 *   DELETE /                       — disable + wipe key material (admin)
 *   GET    /qr                     — current pairing QR, if pending
 *   GET    /triage                 — captured groups awaiting binding
 *   POST   /triage/:groupId/bind   — attach a group to a handover project
 *   POST   /triage/:groupId/ignore — dismiss a group permanently
 *
 *   POST   /internal/claim         — worker asks for a session to run
 *   POST   /internal/status        — worker reports connection.update
 *   POST   /internal/qr            — worker publishes a pairing QR
 *   POST   /internal/messages      — worker delivers a batch of group messages
 *   POST   /internal/group-meta    — worker delivers group metadata / roster
 */

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const session = require('../services/whatsappSession.service');
const QRCode = require('qrcode');

// ─────────────────────────────────────────────────────────────────────────────
// Worker channel
//
// Mounted BEFORE the JWT middleware so the worker is not asked for a user
// token it does not have. Constant-time compare so this endpoint is not a
// timing oracle for the shared secret.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

function workerAuth(req, res, next) {
  const expected = process.env.WA_SESSION_WORKER_SECRET;
  if (!expected) {
    return res.status(503).json({ error: { message: 'WA_SESSION_WORKER_SECRET not configured' } });
  }
  const provided = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: { message: 'unauthorized' } });
  }
  return next();
}

// In-memory QR relay. A pairing QR is valid for ~20 seconds and is worthless
// after it is scanned, so persisting it would be storing a secret with no
// upside. Losing it on API restart just means the worker publishes the next one.
const qrCache = new Map();   // sessionId -> { qr, at }

router.post('/internal/claim', workerAuth, async (req, res) => {
  try {
    const { rows } = await require('../config/database').pool.query(
      `SELECT id, org_id, label, wa_phone, status, capture_enabled, capture_media
         FROM whatsapp_sessions
        WHERE status IN ('pending_qr', 'connecting', 'connected', 'disconnected')
        ORDER BY (status = 'pending_qr') DESC, updated_at ASC`
    );
    res.json({ sessions: rows });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/status', workerAuth, async (req, res) => {
  try {
    const { sessionId, status, statusDetail, waPhone, pushName } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });
    const updated = await session.updateSessionStatus(sessionId, { status, statusDetail, waPhone, pushName });
    if (status && status !== 'pending_qr') qrCache.delete(Number(sessionId));
    res.json({ ok: true, session: updated });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/qr', workerAuth, async (req, res) => {
  const { sessionId, qr } = req.body || {};
  if (!sessionId || !qr) return res.status(400).json({ error: { message: 'sessionId and qr required' } });
  qrCache.set(Number(sessionId), { qr, at: Date.now() });
  res.json({ ok: true });
});

router.post('/internal/heartbeat', workerAuth, async (req, res) => {
  try {
    const { sessionId, socketConnected } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });
    // Returns the live config, so tuning changes reach the worker on its normal
    // cadence rather than requiring a redeploy that would kill the socket.
    res.json(await session.heartbeat(sessionId, { socketConnected }));
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/reconnect', workerAuth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });
    await session.recordReconnect(sessionId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ── Auth key relay ───────────────────────────────────────────────────────────
//
// This is what lets the worker run with no database connection at all. It sends
// opaque serialised strings; encryption, key management and persistence stay on
// this service, which already holds AI_CREDS_KEY and the Postgres credentials.

router.post('/internal/auth/get', workerAuth, async (req, res) => {
  try {
    const { sessionId, keyIds } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });
    res.json({ values: await session.authGet(sessionId, keyIds || []) });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/auth/set', workerAuth, async (req, res) => {
  try {
    const { sessionId, upserts, deletes } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });
    const out = await session.authSet(sessionId, upserts || [], deletes || []);
    res.json({ ok: true, ...out });
  } catch (e) {
    // Must be a hard failure the worker can see: silently losing ratchet state
    // produces a session that connects once and then cannot decrypt anything.
    console.error(`[wa-session] auth set failed: ${e.message}`);
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/auth/clear', workerAuth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId required' } });
    res.json({ ok: true, ...(await session.authClear(sessionId)) });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/messages', workerAuth, async (req, res) => {
  try {
    const { sessionId, messages } = req.body || {};
    if (!sessionId || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'sessionId and messages[] required' } });
    }
    // Ack per message rather than per batch: one malformed event must not cost
    // us the other 49, and the worker needs to know which to not retry.
    const results = [];
    for (const evt of messages) {
      try {
        results.push(await session.ingestGroupMessage(sessionId, evt));
      } catch (err) {
        console.error(`[wa-session] ingest failed for ${evt?.messageId}: ${err.message}`);
        results.push({ stored: false, reason: 'ERROR', error: err.message });
      }
    }
    res.json({ ok: true, stored: results.filter(r => r.stored).length, results });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/internal/group-meta', workerAuth, async (req, res) => {
  try {
    const { sessionId, groups } = req.body || {};
    if (!sessionId || !Array.isArray(groups)) {
      return res.status(400).json({ error: { message: 'sessionId and groups[] required' } });
    }
    for (const g of groups) {
      try { await session.syncGroupMetadata(sessionId, g); }
      catch (err) { console.error(`[wa-session] group meta failed for ${g?.jid}: ${err.message}`); }
    }
    res.json({ ok: true, count: groups.length });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// User-facing
// ─────────────────────────────────────────────────────────────────────────────

router.use(authenticateToken);
router.use(orgContext);

router.get('/', async (req, res) => {
  try {
    res.json(await session.health(req.orgId));
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { label, captureMedia } = req.body || {};
    const result = await session.createSession(req.orgId, req.userId, { label, captureMedia });
    if (!result.ok) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.delete('/', requireRole('admin'), async (req, res) => {
  try {
    const result = await session.disableSession(req.orgId, req.userId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.get('/qr', requireRole('admin'), async (req, res) => {
  try {
    const s = await session.getSession(req.orgId);
    if (!s) return res.status(404).json({ error: { message: 'No session' } });
    const entry = qrCache.get(s.id);
    // QRs expire fast; serving a stale one sends someone to scan something
    // that will silently fail.
    if (!entry || Date.now() - entry.at > 60000) {
      return res.json({ qr: null, qrDataUrl: null, status: s.status, waiting: s.status === 'pending_qr' });
    }

    // Rendered server-side so the frontend needs no QR library at all — it just
    // drops the data URL into an <img src>. `qr` (the raw payload) is kept for
    // debugging and for rendering in a terminal during bring-up.
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(entry.qr, { margin: 1, width: 320, errorCorrectionLevel: 'L' });
    } catch (err) {
      console.error('[wa-session] QR render failed:', err.message);
    }

    res.json({ qr: entry.qr, qrDataUrl, status: s.status, ageMs: Date.now() - entry.at });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.put('/settings', requireRole('admin'), async (req, res) => {
  try {
    const result = await session.updateRuntimeConfig(req.orgId, req.body || {});
    if (!result.ok) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// "Someone opened WhatsApp on the handset today." Not detectable from the
// protocol, and WhatsApp unlinks every companion device after 14 days of
// handset inactivity — so a human asserting it is the only honest source.
router.post('/phone-seen', async (req, res) => {
  try {
    const result = await session.confirmPhoneSeen(req.orgId, req.userId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.get('/triage', async (req, res) => {
  try {
    res.json(await session.listTriage(req.orgId, {
      status:  req.query.status,
      watched: req.query.watched,
      q:       req.query.q,
      limit:   req.query.limit,
    }));
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// Bulk by design: with hundreds of catalogued groups, one request per group is
// not a workable interaction.
router.post('/triage/watch', async (req, res) => {
  try {
    const { groupIds, watched } = req.body || {};
    const result = await session.setWatch(req.orgId, req.userId, groupIds, watched);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/triage/:groupId/bind', async (req, res) => {
  try {
    const { handoverId } = req.body || {};
    if (!handoverId) return res.status(400).json({ error: { message: 'handoverId required' } });
    const result = await session.bindGroup(
      req.orgId, req.userId, parseInt(req.params.groupId, 10), parseInt(handoverId, 10)
    );
    if (!result.ok) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

router.post('/triage/:groupId/ignore', async (req, res) => {
  try {
    const result = await session.ignoreGroup(req.orgId, req.userId, parseInt(req.params.groupId, 10));
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

module.exports = router;
