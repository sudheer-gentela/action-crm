// routes/network-connections.routes.js
//
// Network roster + job-change detection surface (Design & Execution Tracker §G).
// Distinct from linkedin-connections.routes.js (which handles the connection-
// ACTIVITY reconcile). This file owns the rep's full network roster, snapshots,
// and the job-change feed.
//
// MOUNT — add this line to server.js right after the linkedin-connections mount
// (currently server.js:287):
//   app.use('/api/network-connections', require('./routes/network-connections.routes')); // network roster + job-change detection
//
// P0 endpoints:
//   POST /snapshot        — ingest one client-parsed export, then diff vs prior
//   GET  /events          — read-only job-change feed (the "moves this cycle" view)
//   GET  /snapshots       — list this rep's snapshots (audit)
//
// Auth/scoping mirrors linkedin-autosend.routes.js exactly.

const express = require('express');
const router  = express.Router();

const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const requireModule     = require('../middleware/requireModule.middleware');

const Ingest = require('../services/NetworkConnectionIngestService');
const Diff   = require('../services/NetworkJobChangeDiffService');
const Plays  = require('../services/NetworkJobChangePlayService');
const Config = require('../services/NetworkJobChangeConfig');
const { createNotification } = require('../services/notificationService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const MAX_ROWS = 60000; // generous; largest personal networks run ~30k

// ── POST /snapshot ────────────────────────────────────────────────────────────
// Body (CSV parsed client-side, mirror of POST /prospects/bulk):
//   {
//     source?: 'csv_export' | 'extension_harvest' | 'on_demand',  // default csv_export
//     seatId?: number,                                            // user_linkedin_seats.id
//     connections: [ { firstName, lastName, email, company, position, connectedOn,
//                      memberUrn?, linkedinUrl? }, ... ]
//   }
// The caller (req.user.userId) is always the owner — a rep imports their OWN network.
// Ingest + diff run in ONE transaction so a snapshot immediately yields events.
router.post('/snapshot', async (req, res) => {
  try {
    const { source = 'csv_export', seatId = null, connections } = req.body || {};

    if (!Array.isArray(connections) || connections.length === 0) {
      return res.status(400).json({
        error: { code: 'NO_ROWS', message: 'connections must be a non-empty array' },
      });
    }
    if (connections.length > MAX_ROWS) {
      return res.status(413).json({
        error: { code: 'TOO_MANY_ROWS', message: `connections exceeds ${MAX_ROWS} rows` },
      });
    }

    const result = await db.withOrgTransaction(req.orgId, async (client) => {
      const ingest = await Ingest.ingestSnapshot(client, {
        orgId:   req.orgId,
        ownerId: req.user.userId,
        seatId:  seatId != null ? parseInt(seatId, 10) : null,
        source,
        rows:    connections,
      });
      const diff = await Diff.runDiffForSnapshot(client, {
        orgId:         req.orgId,
        ownerId:       req.user.userId,
        newSnapshotId: ingest.snapshotId,
      });
      // P1: classify champion-left + mint churn-risk actions for new company_change events.
      const plays = await Plays.routeChampionLeftForSnapshot(client, {
        orgId:   req.orgId,
        ownerId: req.user.userId,
      });
      // P2: classify inbound moves into target accounts → warm-intro plays.
      const inbound = await Plays.routeInboundTargetForSnapshot(client, {
        orgId:   req.orgId,
        ownerId: req.user.userId,
      });
      // P2: catch-all ICP re-engage for moves into senior buying roles.
      const icp = await Plays.routeIcpMoveForSnapshot(client, {
        orgId:   req.orgId,
        ownerId: req.user.userId,
      });
      return { ingest, diff, plays, inbound, icp };
    });

    // Payoff-forward (D5): surface the result on the bell + Slack so the rep
    // sees value immediately. Best-effort — never block the response.
    try {
      const d = result.diff || {};
      const p = result.plays || {};
      const moves = (d.byType && (d.byType.company_change || 0)) || 0;
      if ((d.events || 0) > 0 || (p.championLeft || 0) > 0) {
        const bits = [];
        if (moves) bits.push(`${moves} job change${moves === 1 ? '' : 's'}`);
        if (p.championLeft) bits.push(`${p.championLeft} champion${p.championLeft === 1 ? '' : 's'} left a customer`);
        const inb = result.inbound || {};
        if (inb.intoTarget) bits.push(`${inb.intoTarget} into target accounts`);
        const ic = result.icp || {};
        if (ic.icpMoves) bits.push(`${ic.icpMoves} into ICP roles`);
        const totalPromoted = (p.promoted || 0) + (inb.promoted || 0) + (ic.promoted || 0);
        if (totalPromoted) bits.push(`${totalPromoted} promoted to prospects`);
        await createNotification(
          req.orgId, req.user.userId, 'network_snapshot_done',
          'Network sync complete',
          bits.length ? `Found ${bits.join(', ')}.` : `Processed ${result.ingest.rows} connections.`,
          'network', result.ingest.snapshotId,
          { diff: d, plays: p }
        );
      }
    } catch (e) { console.warn('network snapshot notification failed (non-blocking):', e.message); }

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('network-connections/snapshot error:', err.message);
    return res.status(500).json({
      error: { code: 'SNAPSHOT_FAILED', message: err.message },
    });
  }
});

// ── GET /events ───────────────────────────────────────────────────────────────
// Read-only job-change feed for the caller's network. P0 = owner-scoped; the
// per-rep view scope (D10) and RevOps org-wide firehose are P1.
// Query: ?type=company_change&limit=100&before=<ISO>
router.get('/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const params = [req.orgId, req.user.userId];
    let where = `e.org_id = $1 AND e.owner_id = $2`;

    // View scope (D10): 'champion_left' shows only champion-left events; 'all' shows everything.
    // (Org-wide RevOps firehose is a separate P2 view.)
    const cfg = await Config.resolveForUser(db, { orgId: req.orgId, userId: req.user.userId });
    if (cfg.notifyScope === 'champion_left') {
      where += ` AND e.is_from_customer_account = true`;
    }

    if (req.query.type) { params.push(req.query.type); where += ` AND e.event_type = $${params.length}`; }
    if (req.query.before) { params.push(req.query.before); where += ` AND e.detected_at < $${params.length}`; }
    params.push(limit);

    const rows = await db.orgQuery(
      req.orgId,
      `SELECT e.id, e.event_type, e.from_company, e.from_title, e.to_company, e.to_title,
              e.detected_at, e.detection_source, e.confidence,
              c.full_name, c.linkedin_url, c.member_urn, c.connected_on
         FROM connection_job_events e
         JOIN linkedin_connections c ON c.id = e.connection_id AND c.org_id = e.org_id
        WHERE ${where}
        ORDER BY e.detected_at DESC
        LIMIT $${params.length}`,
      params
    );
    return res.json({ ok: true, events: rows.rows });
  } catch (err) {
    console.error('network-connections/events error:', err.message);
    return res.status(500).json({ error: { code: 'EVENTS_FAILED', message: err.message } });
  }
});

// ── GET /snapshots ────────────────────────────────────────────────────────────
router.get('/snapshots', async (req, res) => {
  try {
    const rows = await db.orgQuery(
      req.orgId,
      `SELECT id, source, imported_at, row_count, is_complete, prior_snapshot_id, parse_warnings
         FROM connection_snapshots
        WHERE org_id = $1 AND owner_id = $2
        ORDER BY imported_at DESC
        LIMIT 50`,
      [req.orgId, req.user.userId]
    );
    return res.json({ ok: true, snapshots: rows.rows });
  } catch (err) {
    console.error('network-connections/snapshots error:', err.message);
    return res.status(500).json({ error: { code: 'SNAPSHOTS_FAILED', message: err.message } });
  }
});

module.exports = router;
