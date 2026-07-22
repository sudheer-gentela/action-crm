/**
 * crm-connections.routes.js
 *
 * DROP-IN LOCATION: backend/routes/crm-connections.routes.js
 *
 * Mount in server.js (next to the salesforce/hubspot mounts):
 *   app.use('/api/crm-connections', require('./routes/crm-connections.routes'));
 *
 * Connection listing + the mapping-approval surface for Baseline/Assessment.
 * All routes: authenticateToken + orgContext; mutations require admin role.
 *
 *   GET    /                       — list connections (org + client scoped)
 *   GET    /:id                    — connection detail + latest schema/baseline
 *                                    snapshot summaries
 *   GET    /:id/schema             — latest frozen schema snapshot (full payload,
 *                                    feeds the mapping UI + config-debt view)
 *   GET    /:id/mapping-proposal   — deterministic stage-map proposal
 *                                    (stageMappingProposer) for human review
 *   PATCH  /:id/stage-map          — APPROVE a stage map. Writes
 *                                    crm_connections.settings.stage_map and,
 *                                    for pointer-mode rows, mirrors into
 *                                    org_integrations.settings.stage_map so
 *                                    the live sync engine and the baseline
 *                                    engine can never disagree.
 *   PATCH  /:id/baseline-config    — update baseline_config (history_months,
 *                                    cycle_calc, segment_axes, min_cell_n,
 *                                    report.branding). Fill-rate gating on
 *                                    segment axes: axes on fields under the
 *                                    floor are accepted but flagged.
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const crmConnections = require('../services/crmConnections.service');
const { proposeStageMap } = require('../services/baseline/stageMappingProposer');

router.use(authenticateToken);
router.use(orgContext);

const SEGMENT_AXIS_FILL_FLOOR = 0.30; // axes under 30% fill get flagged

// ── GET / ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const rows = await crmConnections.listConnections(req.orgId);
    res.json({ success: true, connections: rows });
  } catch (err) {
    console.error('[crm-connections] list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const conn = await crmConnections.getConnection(req.orgId, req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'Connection not found' });
    // Never ship credentials to the client, even null ones.
    delete conn.credentials;

    const [schemaRes, baselineRes] = await Promise.all([
      pool.query(
        `SELECT id, status, captured_at, error_detail
           FROM crm_schema_snapshots
          WHERE connection_id = $1 AND org_id = $2
          ORDER BY captured_at DESC LIMIT 1`,
        [conn.id, req.orgId]),
      pool.query(
        `SELECT id, status, captured_at, metric_defs_version, error_detail
           FROM baseline_snapshots
          WHERE connection_id = $1 AND org_id = $2
          ORDER BY captured_at DESC LIMIT 3`,
        [conn.id, req.orgId]),
    ]);

    res.json({
      success: true,
      connection: conn,
      latestSchemaSnapshot: schemaRes.rows[0] || null,
      recentBaselines: baselineRes.rows,
    });
  } catch (err) {
    console.error('[crm-connections] detail error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /:id/schema ──────────────────────────────────────────────────────────

router.get('/:id/schema', async (req, res) => {
  try {
    const conn = await crmConnections.getConnection(req.orgId, req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'Connection not found' });

    const snap = await pool.query(
      `SELECT id, captured_at, schema, warnings
         FROM crm_schema_snapshots
        WHERE connection_id = $1 AND org_id = $2 AND status = 'frozen'
        ORDER BY captured_at DESC LIMIT 1`,
      [conn.id, req.orgId]);
    if (!snap.rows.length) {
      return res.status(404).json({ success: false, error: 'No frozen schema snapshot — run discovery first' });
    }
    res.json({ success: true, snapshot: snap.rows[0] });
  } catch (err) {
    console.error('[crm-connections] schema error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /:id/mapping-proposal ────────────────────────────────────────────────

router.get('/:id/mapping-proposal', async (req, res) => {
  try {
    const conn = await crmConnections.getConnection(req.orgId, req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'Connection not found' });

    const snap = await pool.query(
      `SELECT schema FROM crm_schema_snapshots
        WHERE connection_id = $1 AND org_id = $2 AND status = 'frozen'
        ORDER BY captured_at DESC LIMIT 1`,
      [conn.id, req.orgId]);
    if (!snap.rows.length) {
      return res.status(404).json({ success: false, error: 'No frozen schema snapshot — run discovery first' });
    }

    const stagesRes = await pool.query(
      `SELECT key, name, stage_type, sort_order, is_terminal
         FROM deal_stages WHERE org_id = $1
        ORDER BY sort_order ASC`,
      [req.orgId]);

    const proposal = proposeStageMap(
      snap.rows[0].schema.stage_defs || [],
      stagesRes.rows
    );
    res.json({
      success: true,
      currentStageMap: (conn.settings && conn.settings.stage_map) || {},
      ...proposal,
    });
  } catch (err) {
    console.error('[crm-connections] mapping-proposal error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /:id/stage-map (admin) ─────────────────────────────────────────────

router.patch('/:id/stage-map', requireRole('admin', 'owner'), async (req, res) => {
  const { stage_map } = req.body;
  if (!stage_map || typeof stage_map !== 'object' || Array.isArray(stage_map)) {
    return res.status(400).json({ success: false, error: 'stage_map must be an object { crmStage: gowarmKey }' });
  }

  try {
    const conn = await crmConnections.getConnection(req.orgId, req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'Connection not found' });

    // Every mapped key must exist as a deal stage in this org.
    const stagesRes = await pool.query(
      `SELECT key FROM deal_stages WHERE org_id = $1`, [req.orgId]);
    const valid = new Set(stagesRes.rows.map(r => r.key));
    const bad = Object.values(stage_map).filter(k => k != null && !valid.has(k));
    if (bad.length) {
      return res.status(400).json({
        success: false,
        error: `Unknown deal stage key(s): ${[...new Set(bad)].join(', ')}`,
      });
    }

    await pool.query(
      `UPDATE crm_connections
          SET settings = jsonb_set(settings, '{stage_map}', $1::jsonb),
              updated_at = NOW()
        WHERE id = $2 AND org_id = $3`,
      [JSON.stringify(stage_map), conn.id, req.orgId]);

    // Pointer-mode rows mirror into org_integrations so the live sync engine
    // resolves stages identically. Client-scoped rows (Phase 3) have no
    // org_integrations twin — nothing to mirror.
    if (conn.integration_id != null) {
      await pool.query(
        `UPDATE org_integrations
            SET settings = jsonb_set(settings, '{stage_map}', $1::jsonb),
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [JSON.stringify(stage_map), conn.integration_id, req.orgId]);
    }

    res.json({ success: true, message: 'Stage map approved', stage_map });
  } catch (err) {
    console.error('[crm-connections] stage-map error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /:id/baseline-config (admin) ───────────────────────────────────────

const CYCLE_CALCS = ['sum_dwell', 'first_entry'];
const BRANDINGS   = ['gowarm', 'white_label'];

router.patch('/:id/baseline-config', requireRole('admin', 'owner'), async (req, res) => {
  const updates = {};
  const b = req.body || {};
  const flags = [];

  if (b.history_months !== undefined) {
    const hm = parseInt(b.history_months, 10);
    if (!Number.isFinite(hm) || hm < 3 || hm > 36) {
      return res.status(400).json({ success: false, error: 'history_months must be 3–36' });
    }
    updates.history_months = hm;
  }
  if (b.cycle_calc !== undefined) {
    if (!CYCLE_CALCS.includes(b.cycle_calc)) {
      return res.status(400).json({ success: false, error: `cycle_calc must be one of ${CYCLE_CALCS.join(', ')}` });
    }
    updates.cycle_calc = b.cycle_calc;
  }
  if (b.min_cell_n !== undefined) {
    const n = parseInt(b.min_cell_n, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return res.status(400).json({ success: false, error: 'min_cell_n must be 1–100' });
    }
    updates.min_cell_n = n;
  }
  if (b.report !== undefined) {
    if (!b.report || !BRANDINGS.includes(b.report.branding)) {
      return res.status(400).json({ success: false, error: `report.branding must be one of ${BRANDINGS.join(', ')}` });
    }
    updates.report = { branding: b.report.branding };
    // White-label identity (2026_62): display name + optional logo for the
    // findings report. Falls back to client name / org name when omitted.
    if (b.report.branding === 'white_label') {
      if (b.report.label_name !== undefined) {
        const ln = String(b.report.label_name).trim();
        if (!ln || ln.length > 255) {
          return res.status(400).json({ success: false, error: 'report.label_name must be 1–255 chars' });
        }
        updates.report.label_name = ln;
      }
      if (b.report.label_logo_url !== undefined) {
        const lu = String(b.report.label_logo_url).trim();
        if (lu && !/^https:\/\//.test(lu)) {
          return res.status(400).json({ success: false, error: 'report.label_logo_url must be an https URL' });
        }
        if (lu) updates.report.label_logo_url = lu;
      }
    }
  }
  if (b.segment_axes !== undefined) {
    if (!Array.isArray(b.segment_axes) || b.segment_axes.some(a => !a || !a.object || !a.field)) {
      return res.status(400).json({ success: false, error: 'segment_axes must be [{ object, field, banding? }]' });
    }
    updates.segment_axes = b.segment_axes.map(a => ({
      object: a.object, field: a.field, ...(a.banding ? { banding: a.banding } : {}),
    }));
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, error: 'No valid baseline_config keys provided' });
  }

  try {
    const conn = await crmConnections.getConnection(req.orgId, req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'Connection not found' });

    // Fill-rate gate on segment axes (decision 3): any discovered field is
    // selectable, but low-fill axes are flagged so nobody presents a
    // 12%-populated segmentation to a CFO unknowingly.
    if (updates.segment_axes) {
      const snap = await pool.query(
        `SELECT schema FROM crm_schema_snapshots
          WHERE connection_id = $1 AND org_id = $2 AND status = 'frozen'
          ORDER BY captured_at DESC LIMIT 1`,
        [conn.id, req.orgId]);
      if (snap.rows.length) {
        const fields = snap.rows[0].schema.fields || {};
        for (const axis of updates.segment_axes) {
          const objFields = fields[axis.object] || fields[axis.object === 'Opportunity' ? 'deals' : axis.object] || [];
          const f = objFields.find(x => x.name === axis.field);
          if (f && f.fillRate != null && f.fillRate < SEGMENT_AXIS_FILL_FLOOR) {
            flags.push(`Axis ${axis.object}.${axis.field}: fill rate ${(f.fillRate * 100).toFixed(0)}% is below the ${SEGMENT_AXIS_FILL_FLOOR * 100}% floor — cells will be sparse${f.fillRateSampled ? ' (sampled)' : ''}`);
          }
        }
      }
    }

    const merged = { ...((conn.settings && conn.settings.baseline_config) || {}), ...updates };
    await pool.query(
      `UPDATE crm_connections
          SET settings = jsonb_set(settings, '{baseline_config}', $1::jsonb),
              updated_at = NOW()
        WHERE id = $2 AND org_id = $3`,
      [JSON.stringify(merged), conn.id, req.orgId]);

    res.json({ success: true, baseline_config: merged, flags });
  } catch (err) {
    console.error('[crm-connections] baseline-config error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
