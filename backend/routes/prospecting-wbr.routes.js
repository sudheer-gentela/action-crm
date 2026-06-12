// ─────────────────────────────────────────────────────────────────────────────
// routes/prospecting-wbr.routes.js
//
// Phase 4 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
//
// Mount (add to server.js next to the other prospecting routes):
//   app.use('/api/prospecting-wbr', require('./routes/prospecting-wbr.routes'));
//
// Endpoint:
//   GET /api/prospecting-wbr/frame
//     ?metrics=sends,reply_rate,...     optional, defaults to registry set
//     &userIds=1,2&depth=all            optional viewer narrowing (scoped)
//     &campaignIds=1,2                  optional
//     &sequenceIds=1,2                  optional
//     &channel=email&fitBand=high       optional
//
// Returns the full WBR frame: W-4..W-1 + WoW, MTD/QTD/YTD each with
// same-days-elapsed prior-year comparables. All visibility is enforced by
// intersecting requested userIds with ReportingScopeService — identical
// auth pattern to routes/reporting.routes.js.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ReportingScopeService = require('../services/ReportingScopeService');
const MetricFrameService = require('../services/MetricFrameService');

router.use(authenticateToken);
router.use(orgContext);

function parseIntList(v) {
  if (!v) return null;
  const arr = String(v).split(',').map((x) => parseInt(x.trim(), 10)).filter(Number.isInteger);
  return arr.length ? arr : null;
}

router.get('/frame', async (req, res) => {
  try {
    const viewerId = req.user.userId;
    const orgId = req.orgId;

    const scope = await ReportingScopeService.resolveReportingScope(viewerId, orgId, {
      depth: req.query.depth,
      explicitUserIds: parseIntList(req.query.userIds),
    });

    const metrics = req.query.metrics
      ? String(req.query.metrics).split(',').map((s) => s.trim()).filter(Boolean)
      : null;

    const frame = await MetricFrameService.getFrame(orgId, {
      module: 'prospecting',
      metrics,
      filters: {
        ownerIds: scope.userIds,                       // scope is the gate
        campaignIds: parseIntList(req.query.campaignIds),
        sequenceIds: parseIntList(req.query.sequenceIds),
        channel: req.query.channel || null,
        fitBand: req.query.fitBand || null,
      },
    });

    res.json({ scope: { type: scope.scope, userIds: scope.userIds }, ...frame });
  } catch (err) {
    console.error('[prospecting-wbr] frame error:', err.message);
    res.status(500).json({ error: 'Failed to compute WBR frame' });
  }
});

module.exports = router;
