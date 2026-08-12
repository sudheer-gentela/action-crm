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
 *   POST   /triage/:groupId/bind   — say how a group is organised (project |
 *                                    account | pool)
 *   POST   /triage/:groupId/unbind — remove the binding; back to legacy
 *   POST   /triage/:groupId/ignore — dismiss a group permanently
 *   POST   /triage/media-policy    — per-group attachment policy (bulk)
 *
 *   POST   /internal/claim         — worker asks for a session to run
 *   POST   /internal/status        — worker reports connection.update
 *   POST   /internal/qr            — worker publishes a pairing QR
 *   POST   /internal/messages      — worker delivers a batch of group messages
 *   POST   /internal/group-meta    — worker delivers group metadata / roster
 *   POST   /internal/media/:messageId         — worker streams a decrypted
 *                                    attachment (multipart, NOT json/base64)
 *   POST   /internal/media/:messageId/failed  — worker could not fetch it
 */

'use strict';

const express = require('express');
const router  = express.Router();

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const session = require('../services/whatsappSession.service');
const media   = require('../services/whatsappMedia.service');
const groupCache = require('../services/whatsapp/groupCache');
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

/**
 * The live group list. Goes to process memory with a short TTL and is NEVER
 * written to Postgres — see services/whatsapp/groupCache.js for why.
 */
router.post('/internal/group-snapshot', workerAuth, async (req, res) => {
  try {
    const { sessionId, groups } = req.body || {};
    if (!sessionId || !Array.isArray(groups)) {
      return res.status(400).json({ error: { message: 'sessionId and groups[] required' } });
    }
    const entry = groupCache.put(sessionId, groups);
    // Groups a human already decided about still get their stored row refreshed
    // — a bound group whose name changed should not show a stale name.
    for (const g of groups) {
      try { await session.syncGroupMetadata(sessionId, { ...g, via: 'snapshot' }); }
      catch (err) { console.warn(`[wa-session] decided-group refresh failed for ${g?.jid}: ${err.message}`); }
    }
    console.log(`[wa-session] snapshot cached: ${entry.groups.length} groups (not persisted)`);
    res.json({ ok: true, cached: entry.groups.length });
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

// ─────────────────────────────────────────────────────────────────────────────
// Media relay
//
// The worker decrypts a session attachment and streams it here as
// multipart/form-data. Not base64 in a JSON body: that is a 33% inflation on
// top of a payload the worker must otherwise hold entire in a heap that also
// holds a live Signal socket, and express.json's 5 MB limit would reject
// anything interesting anyway.
//
// The bytes are in memory on this process for the duration of one upload and
// are never written to disk here. Their destination is the customer's own
// Drive or OneDrive; this service is a pipe, and the only durable record it
// keeps is the storage_files row pointing at the customer's copy.
// ─────────────────────────────────────────────────────────────────────────────

const multer = require('multer');

// The ceiling on the ceiling. media_max_bytes is constrained to 100 MB in the
// database, so nothing legitimate exceeds this; it exists so a malformed or
// hostile request cannot make this process allocate without bound before the
// per-session limit is even known.
const HARD_MAX_BYTES = parseInt(process.env.WA_SESSION_MEDIA_HARD_MAX || String(100 * 1024 * 1024), 10);

/**
 * Build the upload parser with THIS session's limit, so multer aborts the
 * stream at the cap instead of buffering the whole thing and rejecting it
 * afterwards. The session id arrives as a header because it has to be readable
 * before the body is touched.
 */
async function mediaUpload(req, res, next) {
  const sessionId = parseInt(req.get('x-wa-session-id') || '', 10);
  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ error: { message: 'x-wa-session-id header required' } });
  }
  req.waSessionId = sessionId;

  let limit = HARD_MAX_BYTES;
  try {
    limit = Math.min(await media.sessionMediaLimit(sessionId), HARD_MAX_BYTES);
  } catch (err) {
    console.warn(`[wa-session] could not read media limit for session ${sessionId}: ${err.message}`);
  }
  req.waMediaLimit = limit;

  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limit, files: 1, fields: 8 },
  }).single('file');

  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      // Over the cap is 'skipped', not 'failed': retrying cannot help, but
      // raising the limit can, and the message must stay visible so somebody
      // can decide whether this file was worth the higher limit.
      const messageId = parseInt(req.params.messageId, 10);
      const reason = `attachment exceeds this session's ${Math.round(limit / 1048576)} MB limit`;
      media.recordSessionFetchFailure(null, messageId, { reason, skipped: true })
        .catch(e => console.error(`[wa-session] could not mark ${messageId} skipped: ${e.message}`));
      return res.status(413).json({ error: { message: reason }, status: 'skipped' });
    }
    return res.status(400).json({ error: { message: err.message } });
  });
}

router.post('/internal/media/:messageId', workerAuth, mediaUpload, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId, 10);
    if (!Number.isInteger(messageId)) {
      return res.status(400).json({ error: { message: 'messageId must be an integer' } });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: { message: 'file part required' } });
    }

    // The worker authenticates with a shared secret, not an org identity.
    // Without this check any worker could upload arbitrary bytes against any
    // message id in any org — the secret would be an org-crossing capability.
    const owned = await session.sessionOwnsMessage(req.waSessionId, messageId);
    if (!owned) {
      return res.status(404).json({ error: { message: 'message not found for this session' } });
    }

    const result = await media.storeSessionMedia(
      owned.org_id, messageId, req.file.buffer,
      req.body?.mimeType || req.file.mimetype || null,
      { sessionId: req.waSessionId }
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[wa-session] media store failed for ${req.params.messageId}: ${e.message}`);
    res.status(500).json({ error: { message: e.message } });
  }
});

/**
 * The worker could not fetch it. Reported separately so the reason recorded is
 * the CDN's rather than a store failure we did not have.
 */
router.post('/internal/media/:messageId/failed', workerAuth, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId, 10);
    const { sessionId, reason, expired, skipped } = req.body || {};
    if (!Number.isInteger(messageId) || !sessionId) {
      return res.status(400).json({ error: { message: 'messageId and sessionId required' } });
    }
    const owned = await session.sessionOwnsMessage(sessionId, messageId);
    if (!owned) return res.status(404).json({ error: { message: 'message not found for this session' } });

    res.json({ ok: true, ...await media.recordSessionFetchFailure(owned.org_id, messageId, {
      reason, expired: !!expired, skipped: !!skipped,
    }) });
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

/**
 * The triage list = live snapshot (memory) + stored decisions (Postgres).
 *
 * Opening this screen asks the worker for a refresh, which arrives on its next
 * heartbeat. The cached list renders immediately so the screen is never blank;
 * `snapshotAgeMs` lets the UI say how fresh it is.
 */
router.get('/triage', async (req, res) => {
  try {
    const s = await session.getSession(req.orgId);
    if (!s) return res.json({ groups: [], counts: {}, connected: false });

    // SCOPING, and why the snapshot is handled separately.
    //
    // listTriage scopes STORED groups: stewards and admins see all, everyone
    // else sees only groups they were a participant in. But the live snapshot
    // is the worker's in-memory list of EVERY group the connected handset is
    // in — it has no thread, no participants and no stored decision, so there
    // is nothing to scope it by. Merging it unscoped would hand every group
    // name in the org to any logged-in user and make the query-level scoping
    // decorative.
    //
    // So a non-steward gets NO snapshot at all. That is coherent rather than a
    // compromise: an undecided group is triage work, triage is a steward's job,
    // and a group with no stored row is by definition undecided.
    const access = require('../services/whatsappAccess.service');
    const { steward } = await access.isSteward(req.orgId, req.userId);

    if (steward) groupCache.requestRefresh(s.id);
    const snap = steward ? groupCache.get(s.id) : null;

    const stored = await session.listTriage(req.orgId, {
      status: req.query.status, watched: req.query.watched,
      q: req.query.q, limit: req.query.limit,
      userId: req.userId,
    });

    // Stored decisions win: they carry the project link, message counts and
    // capture state that the snapshot knows nothing about.
    const byJid = new Map((stored.groups || []).map(g => [g.group_jid, g]));
    const merged = [];

    for (const g of (snap?.groups || [])) {
      const known = byJid.get(g.jid);
      if (known) { merged.push({ ...known, participant_count: g.participants ?? known.participant_count, live: true }); byJid.delete(g.jid); }
      else merged.push({
        id: null, group_jid: g.jid, subject: g.subject,
        participant_count: g.participants, message_count: 0,
        is_watched: false, binding_status: 'unbound',
        thread_id: null, handover_id: null, project_name: null,
        last_message_at: null, live: true, persisted: false,
      });
    }
    // Decided groups the snapshot did not mention — the number may have left
    // them. Still shown, because their captured history is still ours to manage.
    for (const g of byJid.values()) merged.push({ ...g, live: false, persisted: true });

    const q = (req.query.q || '').toLowerCase();
    const filtered = q ? merged.filter(g => (g.subject || '').toLowerCase().includes(q)) : merged;

    res.json({
      groups: filtered,
      counts: {
        ...stored.counts,
        visible: filtered.length,
        inSnapshot: snap?.groups?.length ?? 0,
      },
      connected: s.status === 'connected',
      snapshotAgeMs: snap?.ageMs ?? null,
      snapshotStale: snap?.stale ?? true,
      // Partial view. The UI must be able to say so — somebody seeing four
      // groups should not conclude the org has four.
      scoped: !!stored.scoped,
      canTriage: steward,
      // Say it plainly in the API too, not just the UI copy.
      note: 'Group names are held in memory only. Nothing is stored until you switch capture on.',
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// Watch by JID: an undecided group has no database id, because deciding is what
// creates the row.
router.post('/triage/watch-jid', async (req, res) => {
  try {
    const { jids, watched } = req.body || {};
    const s = await session.getSession(req.orgId);
    if (!s) return res.status(404).json({ error: { message: 'No session' } });
    const snap = groupCache.get(s.id);
    const result = await session.watchByJid(req.orgId, s.id, req.userId, jids, watched, snap?.groups || []);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
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

/**
 * Per-group attachment policy, set by whoever runs the project.
 *
 * Bulk like the watch routes, for the same reason: a number in eighty groups
 * is configured in sweeps, not one dialog at a time.
 *
 * Loosening a policy requeues what the old one skipped — `requeued` in the
 * response is how the UI can say "and 6 earlier attachments are being fetched"
 * instead of leaving someone to wonder whether the change was retroactive.
 */
router.post('/triage/media-policy', async (req, res) => {
  try {
    const { groupIds, policy } = req.body || {};
    const result = await session.setGroupMediaPolicy(req.orgId, req.userId, groupIds, policy);
    if (!result.ok) return res.status(result.code === 'NOT_FOUND' ? 404 : 400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

/**
 * Say how a group is organised: around a project, around a vendor/partner
 * account, or as a pool of declared projects.
 *
 * `mode` defaults to 'project' so a caller sending only { handoverId } — which
 * is the entire pre-Phase-1 payload — behaves exactly as it did before.
 *
 * 409 rather than 400 for NEEDS_FORCE: the request was well formed and the
 * caller is expected to re-send it with force:true after confirming, which
 * mirrors the existing `force` flag on POST /threads/:threadId/link.
 */
router.post('/triage/:groupId/bind', async (req, res) => {
  try {
    const { mode = 'project', handoverId, accountId, candidateIds, force } = req.body || {};

    if (mode === 'project' && !handoverId) {
      return res.status(400).json({ error: { message: 'handoverId required' } });
    }
    if (mode === 'account' && !accountId) {
      return res.status(400).json({ error: { message: 'accountId required' } });
    }
    if (mode === 'pool' && !(Array.isArray(candidateIds) && candidateIds.length)) {
      return res.status(400).json({ error: { message: 'candidateIds required — name at least one project' } });
    }

    const result = await session.bindGroup(
      req.orgId, req.userId, parseInt(req.params.groupId, 10),
      { mode, handoverId, accountId, candidateIds, force: !!force }
    );

    if (!result.ok) {
      const status = result.code === 'NOT_FOUND'   ? 404
                   : result.code === 'NEEDS_FORCE' ? 409
                   : 400;
      return res.status(status).json({ ...result, error: { message: result.error || result.code } });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

/**
 * Bind by THREAD id — the entry point for direct threads and for the vendor
 * panel, which starts from an account rather than from triage.
 *
 * A group with a session row is delegated to bindGroup so it takes exactly the
 * same path as a triage bind: same force rules, same back-fill suppression,
 * same media handling. Direct threads are account mode only.
 */
router.post('/threads/:threadId/bind', async (req, res) => {
  try {
    const { mode = 'account', accountId, force } = req.body || {};
    if (mode === 'account' && !accountId) {
      return res.status(400).json({ error: { message: 'accountId required' } });
    }
    const result = await session.bindThread(
      req.orgId, req.userId, parseInt(req.params.threadId, 10),
      { mode, accountId, force: !!force }
    );
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND'   ? 404
                   : result.code === 'NEEDS_FORCE' ? 409
                   : 400;
      return res.status(status).json({ ...result, error: { message: result.error || result.code } });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

/**
 * Unbind — the group reverts to legacy behaviour: no binding row, and the
 * attribution chain runs all three rules again against whatever the thread
 * carries.
 *
 * Does NOT restore a thread project that a previous entity bind cleared, and
 * does not retract anything already attributed. Both would be guesses about
 * what the person meant, and this is the escape hatch from a wrong bind, not a
 * time machine.
 */
router.post('/triage/:groupId/unbind', async (req, res) => {
  try {
    const result = await session.unbindGroup(
      req.orgId, req.userId, parseInt(req.params.groupId, 10)
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
