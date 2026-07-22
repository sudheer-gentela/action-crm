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
 * Report surface (weeks 3–4):
 *   POST /snapshots/:id/report          — generate findings report (findings
 *                                         engine + AI narrative + HTML).
 *                                         Regenerable; newest wins.
 *   GET  /snapshots/:id/report          — latest report meta + findings +
 *                                         narrative (JSON)
 *   GET  /reports/:id/html              — rendered report (text/html; print
 *                                         to PDF from the browser)
 *   POST /reports/:id/share             — mint/return share token
 *   POST /reports/:id/revoke-share      — revoke it
 *   GET  /reports/shared/:token         — PUBLIC rendered report (defined
 *                                         BEFORE the auth middleware, same
 *                                         pattern as the OAuth callbacks)
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const BaselineCaptureService = require('../services/baseline/BaselineCaptureService');
const reportService          = require('../services/baseline/reportService');

// ── PUBLIC: GET /reports/shared/:token ───────────────────────────────────────
// No auth — the token is the credential (same trust model as the client
// portal magic link). Must be registered before the auth middleware below.

router.get('/reports/shared/:token', async (req, res) => {
  try {
    const found = await reportService.getSharedHtml(req.params.token);
    if (!found) return res.status(404).send('Report not found');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Robots-Tag', 'noindex');
    res.send(found.html);
  } catch (err) {
    console.error('[baseline] shared report error:', err.message);
    res.status(500).send('Error loading report');
  }
});

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

// ── POST /snapshots/:id/report ───────────────────────────────────────────────

router.post('/snapshots/:id/report', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await reportService.generateReport({
      snapshotId: parseInt(req.params.id, 10),
      orgId: req.orgId,
      userId: req.userId,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[baseline] report generate error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// ── GET /snapshots/:id/report — latest report for a snapshot (JSON) ──────────

router.get('/snapshots/:id/report', async (req, res) => {
  try {
    const row = await pool.query(`
      SELECT id, snapshot_id, branding, label_name, findings, narrative,
             narrative_status, narrative_model, share_token IS NOT NULL AS shared,
             generated_at
      FROM baseline_reports
      WHERE snapshot_id = $1 AND org_id = $2
      ORDER BY generated_at DESC LIMIT 1
    `, [req.params.id, req.orgId]);
    if (!row.rows.length) {
      return res.status(404).json({ success: false, error: 'No report generated for this snapshot yet' });
    }
    res.json({ success: true, report: row.rows[0] });
  } catch (err) {
    console.error('[baseline] report fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /reports/:id/html — rendered report for in-app view / print-to-PDF ───

router.get('/reports/:id/html', async (req, res) => {
  try {
    const row = await pool.query(
      `SELECT html FROM baseline_reports WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]);
    if (!row.rows.length) return res.status(404).send('Report not found');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(row.rows[0].html);
  } catch (err) {
    console.error('[baseline] report html error:', err.message);
    res.status(500).send('Error loading report');
  }
});

// ── Share management ─────────────────────────────────────────────────────────

router.post('/reports/:id/share', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await reportService.enableShare({
      reportId: parseInt(req.params.id, 10), orgId: req.orgId,
    });
    res.json({ success: true, ...result, url: `/api/baseline/reports/shared/${result.shareToken}` });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

router.post('/reports/:id/revoke-share', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await reportService.revokeShare({
      reportId: parseInt(req.params.id, 10), orgId: req.orgId,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

module.exports = router;
