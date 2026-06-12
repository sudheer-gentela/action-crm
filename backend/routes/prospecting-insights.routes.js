// ─────────────────────────────────────────────────────────────────────────────
// routes/prospecting-insights.routes.js
//
// Phase 4 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
//
// Mount (add to server.js next to the other prospecting routes):
//   app.use('/api/prospecting-insights', require('./routes/prospecting-insights.routes'));
//
// Endpoints:
//   GET  /api/prospecting-insights                 list (status=open|all)
//   GET  /api/prospecting-insights/:id             full lineage + breakdown
//   GET  /api/prospecting-insights/:id/evidence    hydrated raw rows (the
//        ?type=step_logs|prospects|delivery_events  double-click, D16)
//        &limit=25&offset=0
//   POST /api/prospecting-insights/:id/acknowledge
//
// Visibility: insights are org-level findings. Rule —
//   * admin/team scope: see everything
//   * solo scope (a rep): see org-wide insights + insights whose segment is
//     their own (segment.dim='owner_id' AND value in scope)
// Evidence hydration always re-checks org_id on every fetched row.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ReportingScopeService = require('../services/ReportingScopeService');

router.use(authenticateToken);
router.use(orgContext);

const EVIDENCE_TYPES = ['step_logs', 'prospects', 'delivery_events'];

async function loadInsightForViewer(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid insight id' }); return null; }
  const r = await pool.query(`SELECT * FROM prospecting_insights WHERE id = $1 AND org_id = $2`, [id, req.orgId]);
  if (r.rows.length === 0) { res.status(404).json({ error: 'Insight not found' }); return null; }
  const ins = r.rows[0];

  const scope = await ReportingScopeService.resolveReportingScope(req.user.userId, req.orgId, {});
  const seg = ins.segment || {};
  const ownerSegmented = seg.dim === 'owner_id';
  const visible = scope.scope !== 'solo' || !ownerSegmented ||
    scope.userIds.includes(parseInt(seg.value, 10));
  if (!visible) { res.status(404).json({ error: 'Insight not found' }); return null; }
  return ins;
}

// ── list ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const status = req.query.status === 'all' ? null : ['new', 'acknowledged'];
    const scope = await ReportingScopeService.resolveReportingScope(req.user.userId, req.orgId, {});

    const params = [req.orgId];
    let where = 'org_id = $1';
    if (status) { params.push(status); where += ` AND status = ANY($${params.length})`; }
    if (scope.scope === 'solo') {
      params.push(scope.userIds.map(String));
      where += ` AND (segment ->> 'dim' IS DISTINCT FROM 'owner_id' OR segment ->> 'value' = ANY($${params.length}))`;
    }

    const r = await pool.query(
      `SELECT id, metric, cause_code, segment, status,
              current_window_start, current_window_end,
              observed, baseline, observed_n, baseline_n, delta_rel,
              headline, impact_estimate, first_detected_at, last_seen_at
         FROM prospecting_insights
        WHERE ${where}
        ORDER BY (status = 'new') DESC, last_seen_at DESC
        LIMIT 50`,
      params
    );
    res.json({ insights: r.rows });
  } catch (err) {
    console.error('[prospecting-insights] list error:', err.message);
    res.status(500).json({ error: 'Failed to list insights' });
  }
});

// ── detail (drill level 1→2: lineage + segment breakdown) ───────────────────

router.get('/:id', async (req, res) => {
  try {
    const ins = await loadInsightForViewer(req, res);
    if (!ins) return;
    const ev = ins.evidence || {};
    res.json({
      ...ins,
      evidence: {
        breakdown: ev.breakdown || [],
        counts: {
          step_logs: (ev.step_log_ids || []).length,
          prospects: (ev.prospect_ids || []).length,
          delivery_events: (ev.delivery_event_ids || []).length,
        },
      },
    });
  } catch (err) {
    console.error('[prospecting-insights] detail error:', err.message);
    res.status(500).json({ error: 'Failed to load insight' });
  }
});

// ── evidence (drill level 3: the raw rows the engine reasoned over) ─────────

router.get('/:id/evidence', async (req, res) => {
  try {
    const ins = await loadInsightForViewer(req, res);
    if (!ins) return;

    const type = EVIDENCE_TYPES.includes(req.query.type) ? req.query.type : 'step_logs';
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const ev = ins.evidence || {};

    const idKey = { step_logs: 'step_log_ids', prospects: 'prospect_ids', delivery_events: 'delivery_event_ids' }[type];
    const allIds = (ev[idKey] || []).map(Number).filter(Number.isFinite);
    const pageIds = allIds.slice(offset, offset + limit);
    if (pageIds.length === 0) return res.json({ type, total: allIds.length, rows: [] });

    let rows;
    if (type === 'step_logs') {
      rows = (await pool.query(
        `SELECT ssl.id, ssl.fired_at, ssl.channel, ssl.status, ssl.subject,
                ssl.sequence_step_id, p.id AS prospect_id,
                COALESCE(p.first_name || ' ' || p.last_name, p.email) AS prospect_name,
                p.company_name, p.icp_score
           FROM sequence_step_logs ssl
           JOIN prospects p ON p.id = ssl.prospect_id AND p.org_id = ssl.org_id
          WHERE ssl.org_id = $1 AND ssl.id = ANY($2::bigint[])
          ORDER BY ssl.fired_at DESC`,
        [req.orgId, pageIds]
      )).rows;
    } else if (type === 'prospects') {
      rows = (await pool.query(
        `SELECT id, COALESCE(first_name || ' ' || last_name, email) AS name,
                email, company_name, title, stage, icp_score, campaign_id, owner_id
           FROM prospects
          WHERE org_id = $1 AND id = ANY($2::int[])`,
        [req.orgId, pageIds]
      )).rows;
    } else {
      rows = (await pool.query(
        `SELECT ede.id, ede.detected_at, ede.event_type, ede.smtp_code,
                ede.failed_recipient, ede.diagnostic_excerpt, ede.enrollment_stopped,
                ede.prospect_id, ede.step_log_id, ede.sender_account_id
           FROM email_delivery_events ede
          WHERE ede.org_id = $1 AND ede.id = ANY($2::bigint[])
          ORDER BY ede.detected_at DESC`,
        [req.orgId, pageIds]
      )).rows;
    }

    res.json({ type, total: allIds.length, offset, rows });
  } catch (err) {
    console.error('[prospecting-insights] evidence error:', err.message);
    res.status(500).json({ error: 'Failed to load evidence' });
  }
});

// ── acknowledge ──────────────────────────────────────────────────────────────

router.post('/:id/acknowledge', async (req, res) => {
  try {
    const ins = await loadInsightForViewer(req, res);
    if (!ins) return;
    const r = await pool.query(
      `UPDATE prospecting_insights
          SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $3
        WHERE id = $1 AND org_id = $2 AND status = 'new'
        RETURNING id, status, acknowledged_at`,
      [ins.id, req.orgId, req.user.userId]
    );
    if (r.rows.length === 0) {
      return res.status(409).json({ error: `Insight is '${ins.status}', only 'new' can be acknowledged` });
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[prospecting-insights] acknowledge error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge insight' });
  }
});

module.exports = router;
