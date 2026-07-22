/**
 * baseline.routes.js
 *
 * DROP-IN LOCATION: backend/routes/baseline.routes.js
 *
 * Mount in server.js:
 *   app.use('/api/baseline', require('./routes/baseline.routes'));
 *
 * The discover → capture → poll surface for Baseline/Assessment.
 * All routes: authenticateToken + orgContext; runs require admin role.
 *
 *   POST /connections/:id/discover  — run schema discovery (synchronous:
 *                                     seconds for typical orgs). Returns the
 *                                     frozen crm_schema_snapshots id.
 *   POST /connections/:id/capture   — start a baseline capture. Returns 202 +
 *                                     snapshotId immediately; the pull can take
 *                                     minutes on large orgs, so it runs in the
 *                                     background. Poll GET /snapshots/:id.
 *   GET  /snapshots                 — list baseline snapshots for the org
 *                                     (optionally ?connection_id= / ?client_id=)
 *   GET  /snapshots/:id             — one snapshot: status while computing;
 *                                     metrics + segments + warnings once
 *                                     frozen. ?include=evidence adds the
 *                                     drill-through payload (large).
 *
 * Report generation (findings PDF) is week-3/4 scope and will mount here as
 * POST /snapshots/:id/report.
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const BaselineCaptureService = require('../services/baseline/BaselineCaptureService');

router.use(authenticateToken);
router.use(orgContext);

// ── POST /connections/:id/discover ───────────────────────────────────────────

router.post('/connections/:id/discover', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await BaselineCaptureService.runDiscovery({
      connectionId: parseInt(req.params.id, 10),
      orgId: req.orgId,
      userId: req.userId,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[baseline] discover error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ── POST /connections/:id/capture ────────────────────────────────────────────

router.post('/connections/:id/capture', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await BaselineCaptureService.startBaselineCapture({
      connectionId: parseInt(req.params.id, 10),
      orgId: req.orgId,
      userId: req.userId,
    });
    // 202: accepted, computing in background. Poll the snapshot.
    res.status(202).json({ success: true, ...result });
  } catch (err) {
    // Precondition failures (no stage_map / no schema snapshot) land here
    // synchronously with a clear message.
    console.error('[baseline] capture error:', err.message);
    res.status(err.statusCode || 400).json({ success: false, error: err.message });
  }
});

// ── GET /snapshots ───────────────────────────────────────────────────────────

router.get('/snapshots', async (req, res) => {
  try {
    const where = ['bs.org_id = $1'];
    const params = [req.orgId];
    if (req.query.connection_id) {
      params.push(parseInt(req.query.connection_id, 10));
      where.push(`bs.connection_id = $${params.length}`);
    }
    if (req.query.client_id) {
      params.push(parseInt(req.query.client_id, 10));
      where.push(`bs.client_id = $${params.length}`);
    }

    const rows = await pool.query(`
      SELECT bs.id, bs.connection_id, bs.client_id, c.name AS client_name,
             bs.crm_type, bs.status, bs.captured_at, bs.history_from,
             bs.history_to, bs.metric_defs_version, bs.error_detail
      FROM baseline_snapshots bs
      LEFT JOIN clients c ON c.id = bs.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY bs.captured_at DESC
      LIMIT 50
    `, params);

    res.json({ success: true, snapshots: rows.rows });
  } catch (err) {
    console.error('[baseline] snapshots list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /snapshots/:id ───────────────────────────────────────────────────────

router.get('/snapshots/:id', async (req, res) => {
  try {
    const includeEvidence = req.query.include === 'evidence';
    const cols = `id, connection_id, client_id, crm_type, status, captured_at,
                  history_from, history_to, metric_defs_version,
                  baseline_config, metrics, segments, warnings, error_detail
                  ${includeEvidence ? ', evidence' : ''}`;
    const row = await pool.query(
      `SELECT ${cols} FROM baseline_snapshots WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]);
    if (!row.rows.length) {
      return res.status(404).json({ success: false, error: 'Snapshot not found' });
    }
    res.json({ success: true, snapshot: row.rows[0] });
  } catch (err) {
    console.error('[baseline] snapshot detail error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
