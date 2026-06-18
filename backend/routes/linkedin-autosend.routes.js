// routes/linkedin-autosend.routes.js
//
// Mount at: /api/linkedin-autosend
//
// The browser-extension surface for OPTIONAL, opt-in LinkedIn connection-request
// auto-send. Companion to /api/linkedin-connections (the manual sync). Every
// route is authenticated, org-scoped, prospecting-gated, and SEAT-BOUND: the
// caller proves which LinkedIn login they are via viewer.publicIdentifier, which
// is bound to their GoWarm user (user_linkedin_seats). A seat already owned by a
// teammate is rejected — a rep can only ever act on their own enrollments.
//
//   POST /claim
//     body: { viewer:{ publicIdentifier, name?, memberUrn? }, limit? }
//     → leases up to `limit` (default 3, max 10) scheduled connection-request
//       rows, capped by the org daily cap counted from this seat's confirmed
//       sends in the last 24h. Returns the per-action guardrails so the
//       extension can apply jitter + the human-hours window locally.
//     resp: { ok, enabled, source, window, jitter_seconds, lease_minutes,
//             daily_cap, remaining_budget, items:[ { logId, note,
//             prospect:{name,linkedinUrl} } ] }
//     When auto-send is OFF for this rep, returns { ok:true, enabled:false,
//     items:[] } — the extension then goes dormant. 409 SEAT_CONFLICT /
//     422 SEAT_UNKNOWN on seat problems.
//
//   POST /confirm        body: { viewer, logId, timeText? }
//     → sending→sent, records connection_request_sent (counter/stage parity),
//       advances the enrollment.
//
//   POST /report-failure body: { viewer, logId, reason }
//     → sending→failed, pauses the enrollment, surfaces a fix-and-resume action.

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');

const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

const Sync         = require('../services/LinkedInConnectionSyncService');
const AutoSend     = require('../services/LinkedInAutoSendService');
const AutoConfig   = require('../services/linkedinAutomationConfig');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const DEFAULT_LIMIT = 3;
const MAX_LIMIT     = 10;

// Shared: validate viewer, open a txn, bind the seat. Returns { client, seatSlug }
// on success, or sends the error response and returns null.
async function beginSeatBoundTxn(req, res) {
  const viewer = req.body && req.body.viewer;
  if (!viewer || !viewer.publicIdentifier || !String(viewer.publicIdentifier).trim()) {
    res.status(422).json({
      error: { code: 'SEAT_UNKNOWN', message: 'Could not identify the logged-in LinkedIn account (viewer.publicIdentifier missing)' },
    });
    return null;
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const seatRes = await Sync.bindSeat(client, {
      orgId: req.orgId, userId: req.user.userId,
      viewer: {
        publicIdentifier: String(viewer.publicIdentifier).trim(),
        name:      viewer.name      ? String(viewer.name).slice(0, 200)      : null,
        memberUrn: viewer.memberUrn ? String(viewer.memberUrn).slice(0, 200) : null,
      },
    });
    if (!seatRes.ok) {
      await client.query('ROLLBACK');
      client.release();
      res.status(409).json({
        error: {
          code: 'SEAT_CONFLICT',
          message: `This LinkedIn account (${viewer.publicIdentifier}) is already linked to ${seatRes.boundTo}. `
                 + `Use the LinkedIn account that belongs to you, or ask an admin to unlink it.`,
        },
      });
      return null;
    }
    return { client, seatSlug: seatRes.seat.public_identifier };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
    res.status(500).json({ error: { message: 'Seat binding failed: ' + err.message } });
    return null;
  }
}

// ── POST /claim ───────────────────────────────────────────────────────────────
router.post('/claim', async (req, res) => {
  const ctx = await beginSeatBoundTxn(req, res);
  if (!ctx) return;
  const { client, seatSlug } = ctx;

  try {
    // Resolve org toggle + this rep's opt-in on the SAME client (snapshot).
    const gate = await AutoConfig.resolveForUser(client, { orgId: req.orgId, userId: req.user.userId });
    if (!gate.enabled) {
      await client.query('COMMIT');
      return res.json({ ok: true, enabled: false, source: gate.source, items: [] });
    }

    const org   = gate.org;
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || DEFAULT_LIMIT, MAX_LIMIT));

    const result = await AutoSend.claimForSeat(client, {
      orgId: req.orgId, userId: req.user.userId, seatSlug,
      limit,
      leaseMinutes: org.lease_minutes,
      dailyCap:     org.daily_cap,
    });

    await client.query('COMMIT');

    console.log(
      `🔗 linkedin-autosend/claim org=${req.orgId} user=${req.user.userId} seat=${seatSlug} `
      + `claimed=${result.claimed.length} remaining=${result.remainingBudget} cappedOut=${result.cappedOut}`
    );

    res.json({
      ok: true,
      enabled: true,
      source: gate.source,
      window:         org.human_hours,      // extension enforces in LOCAL time
      jitter_seconds: org.jitter_seconds,   // extension waits a random gap in [min,max]
      lease_minutes:  org.lease_minutes,
      daily_cap:      org.daily_cap,
      remaining_budget: result.remainingBudget,
      capped_out:       result.cappedOut,
      items: result.claimed.map(c => ({
        logId: c.logId,
        note:  c.note,
        prospect: c.prospect,
      })),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('linkedin-autosend/claim error:', err);
    res.status(500).json({ error: { message: 'Claim failed: ' + err.message } });
  } finally {
    client.release();
  }
});

// ── POST /confirm ──────────────────────────────────────────────────────────────
router.post('/confirm', async (req, res) => {
  const logId = Number(req.body?.logId);
  if (!Number.isInteger(logId) || logId <= 0) {
    return res.status(400).json({ error: { message: 'logId is required' } });
  }
  const ctx = await beginSeatBoundTxn(req, res);
  if (!ctx) return;
  const { client, seatSlug } = ctx;

  try {
    const result = await AutoSend.confirmSent(client, {
      orgId: req.orgId, userId: req.user.userId, seatSlug,
      logId, timeText: req.body?.timeText || null,
    });
    if (!result.ok) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { code: result.code || 'NOT_CLAIMABLE', message: 'This send is no longer claimable (lease expired or already finalized).' } });
    }
    await client.query('COMMIT');
    console.log(`🔗 linkedin-autosend/confirm org=${req.orgId} seat=${seatSlug} log=${logId} advanced=${result.advanced}`);
    res.json({ ok: true, advanced: result.advanced });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('linkedin-autosend/confirm error:', err);
    res.status(500).json({ error: { message: 'Confirm failed: ' + err.message } });
  } finally {
    client.release();
  }
});

// ── POST /report-failure ────────────────────────────────────────────────────────
router.post('/report-failure', async (req, res) => {
  const logId = Number(req.body?.logId);
  if (!Number.isInteger(logId) || logId <= 0) {
    return res.status(400).json({ error: { message: 'logId is required' } });
  }
  const ctx = await beginSeatBoundTxn(req, res);
  if (!ctx) return;
  const { client, seatSlug } = ctx;

  try {
    const result = await AutoSend.reportFailure(client, {
      orgId: req.orgId, userId: req.user.userId, seatSlug,
      logId, reason: (req.body?.reason || '').toString().slice(0, 500),
    });
    if (!result.ok) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { code: result.code || 'NOT_CLAIMABLE', message: 'This send is no longer claimable.' } });
    }
    await client.query('COMMIT');
    console.log(`🔗 linkedin-autosend/report-failure org=${req.orgId} seat=${seatSlug} log=${logId}`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('linkedin-autosend/report-failure error:', err);
    res.status(500).json({ error: { message: 'Report-failure failed: ' + err.message } });
  } finally {
    client.release();
  }
});

module.exports = router;
