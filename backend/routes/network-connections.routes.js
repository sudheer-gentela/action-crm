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
      return { ingest, diff };
    });

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
