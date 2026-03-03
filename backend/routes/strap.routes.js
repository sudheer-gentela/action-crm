/**
 * strap.routes.js
 *
 * API routes for the STRAP framework.
 * Follows conventions from deals.routes.js and actions.routes.js:
 *   - router.use(authenticateToken, orgContext) at top
 *   - req.userId, req.orgId from middleware
 *   - JSON responses with { success, ... } shape
 *   - Try/catch with 500 error responses
 */

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const StrapEngine       = require('../services/StrapEngine');

router.use(authenticateToken);
router.use(orgContext);

// ── GET /api/straps/deal/:dealId ──────────────────────────────
// Get the active STRAP for a deal

router.get('/deal/:dealId', async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    const strap  = await StrapEngine.getActiveStrap(dealId, req.orgId);

    res.json({
      success:   true,
      strap:     strap || null,
      hasActive: !!strap,
    });
  } catch (error) {
    console.error('GET /straps/deal/:dealId error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/straps/deal/:dealId/history ──────────────────────
// Full STRAP timeline for a deal

router.get('/deal/:dealId/history', async (req, res) => {
  try {
    const dealId  = parseInt(req.params.dealId);
    const history = await StrapEngine.getHistory(dealId, req.orgId);

    res.json({
      success: true,
      straps:  history,
      count:   history.length,
    });
  } catch (error) {
    console.error('GET /straps/deal/:dealId/history error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/straps/deal/:dealId/generate ────────────────────
// Auto STRAP: system identifies hurdle, builds strategy, creates actions

router.post('/deal/:dealId/generate', async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    const useAI  = req.body.useAI !== false;

    const result = await StrapEngine.createStrap(dealId, req.userId, req.orgId, { useAI });

    res.json({
      success: true,
      strap:   result.strap,
      actions: result.actions.map(a => ({
        id:         a.id,
        title:      a.title,
        actionType: a.action_type,
        nextStep:   a.next_step,
        priority:   a.priority,
        dueDate:    a.due_date,
        sequence:   a._sequence,
        isGate:     a._is_gate,
      })),
    });
  } catch (error) {
    console.error('POST /straps/deal/:dealId/generate error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/straps/deal/:dealId/override ────────────────────
// Manual STRAP: human chooses their own hurdle (override)
//
// Body: {
//   hurdleType:  'buyer_engagement',        — required
//   hurdleTitle: 'Need to reach CFO',       — required
//   hurdleParam: '2a',                      — optional
//   reason:      'I know from a call...',   — optional but encouraged
//   useAI:       true                       — optional, default true
// }

router.post('/deal/:dealId/override', async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    const { hurdleType, hurdleTitle, hurdleParam, reason, useAI } = req.body;

    if (!hurdleType || !hurdleTitle) {
      return res.status(400).json({ error: 'hurdleType and hurdleTitle are required' });
    }

    const validTypes = [
      'close_date', 'buyer_engagement', 'process', 'deal_size',
      'competitive', 'momentum', 'contact_coverage', 'stage_progression',
    ];
    if (!validTypes.includes(hurdleType)) {
      return res.status(400).json({ error: `Invalid hurdleType. Must be one of: ${validTypes.join(', ')}` });
    }

    const result = await StrapEngine.createManualStrap(
      dealId, req.userId, req.orgId,
      { hurdleType, hurdleTitle, hurdleParam, reason },
      { useAI: useAI !== false }
    );

    res.json({
      success: true,
      strap:   result.strap,
      source:  'manual',
      autoRecommendation: {
        hurdleType:  result.strap.auto_hurdle_type,
        hurdleTitle: result.strap.auto_hurdle_title,
      },
      actions: result.actions.map(a => ({
        id:         a.id,
        title:      a.title,
        actionType: a.action_type,
        nextStep:   a.next_step,
        priority:   a.priority,
        dueDate:    a.due_date,
      })),
    });
  } catch (error) {
    console.error('POST /straps/deal/:dealId/override error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── GET /api/straps/:strapId ──────────────────────────────────

router.get('/:strapId', async (req, res) => {
  try {
    const strapId = parseInt(req.params.strapId);
    const strap   = await StrapEngine.getById(strapId, req.orgId);
    if (!strap) return res.status(404).json({ error: 'STRAP not found' });
    res.json({ success: true, strap });
  } catch (error) {
    console.error('GET /straps/:strapId error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /api/straps/:strapId/resolve ──────────────────────────

router.put('/:strapId/resolve', async (req, res) => {
  try {
    const strapId = parseInt(req.params.strapId);
    const { status, outcome, outcomeSignals, autoNext } = req.body;

    if (!['successful', 'unsuccessful'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "successful" or "unsuccessful"' });
    }

    const result = await StrapEngine.resolveStrap(
      strapId, req.orgId, status, outcome || null,
      outcomeSignals || null, req.userId, autoNext
    );

    res.json({
      success:   true,
      resolved:  result.resolved,
      nextStrap: result.nextStrap || null,
    });
  } catch (error) {
    console.error('PUT /straps/:strapId/resolve error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── PUT /api/straps/:strapId/reassess ─────────────────────────

router.put('/:strapId/reassess', async (req, res) => {
  try {
    const strapId = parseInt(req.params.strapId);
    const result  = await StrapEngine.reassess(strapId, req.orgId, req.userId);

    res.json({
      success:   true,
      resolved:  result.resolved,
      nextStrap: result.nextStrap || null,
    });
  } catch (error) {
    console.error('PUT /straps/:strapId/reassess error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
