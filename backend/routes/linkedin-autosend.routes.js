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
const ReportingScope = require('../services/ReportingScopeService');

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

// ── GET /risk ─────────────────────────────────────────────────────────────────
//
// STANDALONE operational risk monitor for LinkedIn auto-send — deliberately
// SEPARATE from WBR/performance reporting. Different purpose: WBR is the
// period-over-period business review; this answers "is a seat about to get its
// LinkedIn account restricted, right now." So it reads sequence_step_logs LIVE
// (no nightly snapshot lag) and attributes by the SENDING SEAT (enrolled_by),
// not the prospect owner.
//
// Visibility uses the same gate as every other report: ReportingScopeService.
// A rep sees their own seat; a manager sees their reports; an admin sees the
// org. Risk signals are parsed from the failure reason stored in error_message:
//   limited   — rate/quota pushback   (limit|quota|429|exceeded)
//   challenge — captcha/security/hard-abort (challenge|captcha)  ← most serious
// The two are mutually exclusive (limited regex excludes challenge terms and
// vice-versa) so "Aborted: limited" can't double-count as a challenge.
//
//   GET /risk?window=24h|7d|30d&userIds=1,2&depth=direct|plus1|plus2|all
//   resp: { ok, window, since, scope:{type,userIds},
//           seats:[ { userId, publicIdentifier, displayName,
//                     sent, failed, limited, challenge, riskEvents, pending,
//                     lastRiskAt, lastChallengeAt } ],
//           recentEvents:[ { logId, userId, prospectId, name, linkedinUrl,
//                            riskKind, reason, firedAt } ] }
const RISK_WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
const RE_LIMITED   = "(limit|quota|429|exceeded)";
const RE_CHALLENGE = "(challenge|captcha)";

function parseIntList(s) {
  if (!s) return null;
  const ids = String(s).split(',').map(x => parseInt(x.trim(), 10)).filter(Number.isInteger);
  return ids.length ? ids : null;
}

router.get('/risk', async (req, res) => {
  try {
    const orgId    = req.orgId;
    const viewerId = req.user.userId;

    // Same visibility gate as the rest of reporting. self / team / admin.
    const scope = await ReportingScope.resolveReportingScope(viewerId, orgId, {
      depth: req.query.depth,
      explicitUserIds: parseIntList(req.query.userIds),
    });
    const userIds = scope.userIds;   // always non-empty; always includes viewer

    const winKey   = RISK_WINDOWS[String(req.query.window)] ? String(req.query.window) : '7d';
    const interval = RISK_WINDOWS[winKey];
    const windowMs = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[winKey];
    const since    = new Date(Date.now() - windowMs).toISOString();

    // Per-seat aggregation. Windowed measures require fired_at in range; pending
    // (scheduled/sending) is a live backlog gauge, so it ignores the window.
    const agg = await db.query(
      `SELECT se.enrolled_by AS user_id,
              COUNT(*) FILTER (WHERE ssl.status = 'sent'   AND ssl.fired_at >= now() - $3::interval)                                                   AS sent,
              COUNT(*) FILTER (WHERE ssl.status = 'failed' AND ssl.fired_at >= now() - $3::interval)                                                   AS failed,
              COUNT(*) FILTER (WHERE ssl.status = 'failed' AND ssl.fired_at >= now() - $3::interval AND ssl.error_message ~* '${RE_LIMITED}')          AS limited,
              COUNT(*) FILTER (WHERE ssl.status = 'failed' AND ssl.fired_at >= now() - $3::interval AND ssl.error_message ~* '${RE_CHALLENGE}')        AS challenge,
              COUNT(*) FILTER (WHERE ssl.status IN ('scheduled','sending'))                                                                            AS pending,
              MAX(ssl.fired_at) FILTER (WHERE ssl.status = 'failed' AND ssl.error_message ~* '(${RE_LIMITED}|${RE_CHALLENGE})')                         AS last_risk_at,
              MAX(ssl.fired_at) FILTER (WHERE ssl.status = 'failed' AND ssl.error_message ~* '${RE_CHALLENGE}')                                         AS last_challenge_at
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id AND se.org_id = ssl.org_id
        WHERE ssl.org_id  = $1
          AND ssl.channel = 'linkedin'
          AND se.enrolled_by = ANY($2::int[])
          AND ( ssl.fired_at >= now() - $3::interval OR ssl.status IN ('scheduled','sending') )
        GROUP BY se.enrolled_by`,
      [orgId, userIds, interval]
    );

    // Hydrate seat display from the LinkedIn seat identity (more meaningful for
    // risk than the GoWarm user name — it's the account that's exposed).
    const seatRows = await db.query(
      `SELECT user_id, public_identifier, display_name
         FROM user_linkedin_seats
        WHERE org_id = $1 AND user_id = ANY($2::int[])`,
      [orgId, userIds]
    );
    const seatById = new Map(seatRows.rows.map(s => [s.user_id, s]));

    const seats = agg.rows.map(r => {
      const s = seatById.get(r.user_id) || {};
      const limited   = Number(r.limited)   || 0;
      const challenge = Number(r.challenge) || 0;
      return {
        userId:           r.user_id,
        publicIdentifier: s.public_identifier || null,
        displayName:      s.display_name || null,
        sent:             Number(r.sent)    || 0,
        failed:           Number(r.failed)  || 0,
        limited,
        challenge,
        riskEvents:       limited + challenge,
        pending:          Number(r.pending) || 0,
        lastRiskAt:       r.last_risk_at      || null,
        lastChallengeAt:  r.last_challenge_at || null,
      };
    }).sort((a, b) =>
      (b.challenge - a.challenge) || (b.limited - a.limited) || (b.failed - a.failed)
    );

    // Recent failures in-window for investigation (all failures, tagged by kind
    // so URN-resolve/HTTP errors are visible too — not just the ToS-risk ones).
    const events = await db.query(
      `SELECT ssl.id AS log_id, se.enrolled_by AS user_id, ssl.prospect_id,
              p.first_name, p.last_name, p.linkedin_url,
              ssl.error_message, ssl.fired_at,
              CASE WHEN ssl.error_message ~* '${RE_CHALLENGE}' THEN 'challenge'
                   WHEN ssl.error_message ~* '${RE_LIMITED}'   THEN 'limited'
                   ELSE 'failed' END AS risk_kind
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id AND se.org_id = ssl.org_id
         JOIN prospects p             ON p.id  = ssl.prospect_id    AND p.org_id  = ssl.org_id
        WHERE ssl.org_id  = $1
          AND ssl.channel = 'linkedin'
          AND ssl.status  = 'failed'
          AND se.enrolled_by = ANY($2::int[])
          AND ssl.fired_at >= now() - $3::interval
        ORDER BY ssl.fired_at DESC
        LIMIT 50`,
      [orgId, userIds, interval]
    );

    const recentEvents = events.rows.map(e => ({
      logId:       e.log_id,
      userId:      e.user_id,
      prospectId:  e.prospect_id,
      name:        `${e.first_name || ''} ${e.last_name || ''}`.trim() || null,
      linkedinUrl: e.linkedin_url || null,
      riskKind:    e.risk_kind,
      reason:      e.error_message || null,
      firedAt:     e.fired_at,
    }));

    res.json({
      ok: true,
      window: winKey,
      since,
      scope: { type: scope.scope, userIds },
      seats,
      recentEvents,
    });
  } catch (err) {
    console.error('linkedin-autosend/risk error:', err.message);
    res.status(500).json({ error: { message: 'Failed to load LinkedIn auto-send risk' } });
  }
});

module.exports = router;
