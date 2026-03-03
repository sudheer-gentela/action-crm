/**
 * strap.routes.js
 *
 * Universal STRAP routes — entity-type aware.
 * Mounted at /api/straps in server.js.
 *
 * Routes:
 *   GET    /:entityType/:entityId          — active STRAP
 *   GET    /:entityType/:entityId/history  — timeline
 *   POST   /:entityType/:entityId/generate — auto generate
 *   POST   /:entityType/:entityId/override — manual override
 *   GET    /:strapId                       — by ID (numeric)
 *   PUT    /:strapId/resolve               — resolve
 *   PUT    /:strapId/reassess              — reassess
 */

const express = require('express');
const router  = express.Router();

const { authenticateToken } = require('../middleware/auth.middleware');
const { orgContext }        = require('../middleware/orgContext.middleware');
const StrapEngine           = require('../services/StrapEngine');

router.use(authenticateToken);
router.use(orgContext);

// ── Validation ──────────────────────────────────────────────────────────────

const VALID_ENTITY_TYPES = new Set(['deal', 'account', 'prospect', 'implementation']);

function validateEntityType(req, res, next) {
  const { entityType } = req.params;
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    return res.status(400).json({
      success: false,
      error: { message: `Invalid entity_type: "${entityType}". Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}` },
    });
  }
  next();
}

function parseEntityId(req, res, next) {
  const id = parseInt(req.params.entityId);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({
      success: false,
      error: { message: 'entityId must be a positive integer' },
    });
  }
  req.entityId = id;
  next();
}

function parseStrapId(req, res, next) {
  const id = parseInt(req.params.strapId);
  if (isNaN(id) || id <= 0) {
    return res.status(400).json({
      success: false,
      error: { message: 'strapId must be a positive integer' },
    });
  }
  req.strapId = id;
  next();
}

// ── Entity-scoped routes ────────────────────────────────────────────────────

// GET /api/straps/:entityType/:entityId — active STRAP
router.get('/:entityType/:entityId', validateEntityType, parseEntityId, async (req, res) => {
  try {
    const strap = await StrapEngine.getActive(req.params.entityType, req.entityId, req.orgId);
    res.json({ success: true, strap });
  } catch (err) {
    console.error('❌ GET active STRAP error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /api/straps/:entityType/:entityId/history — timeline
router.get('/:entityType/:entityId/history', validateEntityType, parseEntityId, async (req, res) => {
  try {
    const history = await StrapEngine.getHistory(req.params.entityType, req.entityId, req.orgId);
    res.json({ success: true, history });
  } catch (err) {
    console.error('❌ GET STRAP history error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /api/straps/:entityType/:entityId/generate — auto generate
router.post('/:entityType/:entityId/generate', validateEntityType, parseEntityId, async (req, res) => {
  try {
    const { useAI = true } = req.body;
    const result = await StrapEngine.generate(
      req.params.entityType, req.entityId, req.userId, req.orgId, { useAI }
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ STRAP generate error:', err.message);
    const status = err.message.includes('Access denied') ? 403 : 500;
    res.status(status).json({ success: false, error: { message: err.message } });
  }
});

// POST /api/straps/:entityType/:entityId/override — manual override
router.post('/:entityType/:entityId/override', validateEntityType, parseEntityId, async (req, res) => {
  try {
    const result = await StrapEngine.override(
      req.params.entityType, req.entityId, req.userId, req.orgId, req.body
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ STRAP override error:', err.message);
    const status = err.message.includes('Access denied') ? 403 : 500;
    res.status(status).json({ success: false, error: { message: err.message } });
  }
});

// ── STRAP-ID-scoped routes ──────────────────────────────────────────────────

// GET /api/straps/:strapId — by ID
router.get('/:strapId', parseStrapId, async (req, res) => {
  try {
    const strap = await StrapEngine.getById(req.strapId, req.orgId);
    if (!strap) {
      return res.status(404).json({ success: false, error: { message: 'STRAP not found' } });
    }
    res.json({ success: true, strap });
  } catch (err) {
    console.error('❌ GET STRAP by ID error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PUT /api/straps/:strapId/resolve
router.put('/:strapId/resolve', parseStrapId, async (req, res) => {
  try {
    const { resolutionType, note } = req.body;
    const result = await StrapEngine.resolve(req.strapId, req.userId, req.orgId, {
      resolutionType, note,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ STRAP resolve error:', err.message);
    const status = err.message.includes('Access denied') ? 403
                 : err.message.includes('not active') ? 409
                 : 500;
    res.status(status).json({ success: false, error: { message: err.message } });
  }
});

// PUT /api/straps/:strapId/reassess
router.put('/:strapId/reassess', parseStrapId, async (req, res) => {
  try {
    const result = await StrapEngine.reassess(req.strapId, req.userId, req.orgId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ STRAP reassess error:', err.message);
    const status = err.message.includes('Access denied') ? 403 : 500;
    res.status(status).json({ success: false, error: { message: err.message } });
  }
});

module.exports = router;
