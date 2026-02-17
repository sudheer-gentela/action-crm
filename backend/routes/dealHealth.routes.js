/**
 * Deal Health Config & Competitors Routes
 * GET/PUT /api/health-config
 * GET/POST/PUT/DELETE /api/competitors
 * POST /api/deals/:id/score
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const auth = require('../middleware/auth.middleware');
const { scoreDeal } = require('../services/dealHealthService');

router.use(auth);

// ── Health Config ────────────────────────────────────────────

// GET current user's health config
router.get('/health-config', async (req, res) => {
  try {
    let r = await db.query(
      'SELECT * FROM deal_health_config WHERE user_id = $1',
      [req.user.userId]
    );

    if (r.rows.length === 0) {
      r = await db.query(
        'INSERT INTO deal_health_config (user_id) VALUES ($1) RETURNING *',
        [req.user.userId]
      );
    }

    const row = r.rows[0];
    res.json({ config: parseConfig(row) });
  } catch (err) {
    console.error('Get health config error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch config' } });
  }
});

// PUT update health config
router.put('/health-config', async (req, res) => {
  try {
    const {
      aiEnabled,
      paramsEnabled,
      weightCloseDate, weightBuyerEngagement, weightProcess,
      weightDealSize, weightCompetitive, weightMomentum,
      paramWeights, thresholdHealthy, thresholdWatch,
      execTitles, legalTitles, procurementTitles, securityTitles,
      segmentAvgSmb, segmentAvgMidmarket, segmentAvgEnterprise,
      segmentSizeMultiplier, noMeetingDays, responseTimeMultiplier,
      multiThreadMinContacts
    } = req.body;

    // Validate category weights sum to 100
    const total = (weightCloseDate || 0) + (weightBuyerEngagement || 0) +
                  (weightProcess || 0) + (weightDealSize || 0) +
                  (weightCompetitive || 0) + (weightMomentum || 0);
    if (total !== 100) {
      return res.status(400).json({ error: { message: `Category weights must sum to 100 (got ${total})` } });
    }

    const r = await db.query(
      `INSERT INTO deal_health_config (
        user_id,
        ai_enabled, params_enabled,
        weight_close_date, weight_buyer_engagement, weight_process,
        weight_deal_size, weight_competitive, weight_momentum,
        param_weights, threshold_healthy, threshold_watch,
        exec_titles, legal_titles, procurement_titles, security_titles,
        segment_avg_smb, segment_avg_midmarket, segment_avg_enterprise,
        segment_size_multiplier, no_meeting_days, response_time_multiplier,
        multi_thread_min_contacts, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        ai_enabled               = EXCLUDED.ai_enabled,
        params_enabled           = EXCLUDED.params_enabled,
        weight_close_date        = EXCLUDED.weight_close_date,
        weight_buyer_engagement  = EXCLUDED.weight_buyer_engagement,
        weight_process           = EXCLUDED.weight_process,
        weight_deal_size         = EXCLUDED.weight_deal_size,
        weight_competitive       = EXCLUDED.weight_competitive,
        weight_momentum          = EXCLUDED.weight_momentum,
        param_weights            = EXCLUDED.param_weights,
        threshold_healthy        = EXCLUDED.threshold_healthy,
        threshold_watch          = EXCLUDED.threshold_watch,
        exec_titles              = EXCLUDED.exec_titles,
        legal_titles             = EXCLUDED.legal_titles,
        procurement_titles       = EXCLUDED.procurement_titles,
        security_titles          = EXCLUDED.security_titles,
        segment_avg_smb          = EXCLUDED.segment_avg_smb,
        segment_avg_midmarket    = EXCLUDED.segment_avg_midmarket,
        segment_avg_enterprise   = EXCLUDED.segment_avg_enterprise,
        segment_size_multiplier  = EXCLUDED.segment_size_multiplier,
        no_meeting_days          = EXCLUDED.no_meeting_days,
        response_time_multiplier = EXCLUDED.response_time_multiplier,
        multi_thread_min_contacts = EXCLUDED.multi_thread_min_contacts,
        ai_enabled_updated_at    = CASE WHEN EXCLUDED.ai_enabled != deal_health_config.ai_enabled THEN NOW() ELSE deal_health_config.ai_enabled_updated_at END,
        updated_at               = NOW()
      RETURNING *`,
      [
        req.user.userId,
        aiEnabled !== false,
        JSON.stringify(paramsEnabled || {}),
        weightCloseDate, weightBuyerEngagement, weightProcess,
        weightDealSize, weightCompetitive, weightMomentum,
        JSON.stringify(paramWeights),
        thresholdHealthy, thresholdWatch,
        JSON.stringify(execTitles), JSON.stringify(legalTitles),
        JSON.stringify(procurementTitles), JSON.stringify(securityTitles),
        segmentAvgSmb, segmentAvgMidmarket, segmentAvgEnterprise,
        segmentSizeMultiplier, noMeetingDays, responseTimeMultiplier,
        multiThreadMinContacts
      ]
    );

    res.json({ config: parseConfig(r.rows[0]), message: 'Config saved' });
  } catch (err) {
    console.error('Save health config error:', err);
    res.status(500).json({ error: { message: 'Failed to save config' } });
  }
});

// ── Competitors ──────────────────────────────────────────────

// GET all competitors
router.get('/competitors', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM competitors WHERE user_id = $1 ORDER BY name ASC',
      [req.user.userId]
    );
    res.json({ competitors: r.rows.map(parseCompetitor) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch competitors' } });
  }
});

// POST create competitor
router.post('/competitors', async (req, res) => {
  try {
    const { name, aliases, website, notes } = req.body;
    if (!name) return res.status(400).json({ error: { message: 'Name required' } });

    const r = await db.query(
      `INSERT INTO competitors (user_id, name, aliases, website, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.userId, name, JSON.stringify(aliases || []), website, notes]
    );
    res.status(201).json({ competitor: parseCompetitor(r.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create competitor' } });
  }
});

// PUT update competitor
router.put('/competitors/:id', async (req, res) => {
  try {
    const { name, aliases, website, notes } = req.body;
    const r = await db.query(
      `UPDATE competitors
       SET name=$1, aliases=$2, website=$3, notes=$4, updated_at=NOW()
       WHERE id=$5 AND user_id=$6 RETURNING *`,
      [name, JSON.stringify(aliases || []), website, notes, req.params.id, req.user.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ competitor: parseCompetitor(r.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update competitor' } });
  }
});

// DELETE competitor
router.delete('/competitors/:id', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM competitors WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.userId]
    );
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete competitor' } });
  }
});

// ── Deal Scoring ─────────────────────────────────────────────

// POST score a specific deal
router.post('/deals/:id/score', async (req, res) => {
  try {
    const result = await scoreDeal(req.params.id, req.user.userId);
    res.json({ result });
  } catch (err) {
    console.error('Score deal error:', err);
    res.status(500).json({ error: { message: 'Failed to score deal' } });
  }
});

// POST score all deals for user
router.post('/deals/score-all', async (req, res) => {
  try {
    const deals = await db.query(
      'SELECT id FROM deals WHERE owner_id = $1 AND stage NOT IN ($2,$3)',
      [req.user.userId, 'closed_won', 'closed_lost']
    );

    const results = [];
    for (const deal of deals.rows) {
      try {
        const r = await scoreDeal(deal.id, req.user.userId);
        results.push(r);
      } catch (e) {
        results.push({ dealId: deal.id, error: e.message });
      }
    }

    res.json({ scored: results.length, results });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to score deals' } });
  }
});

// ── Deal signal flags (manual) ───────────────────────────────

router.patch('/deals/:id/signals', async (req, res) => {
  try {
    const allowed = [
      'close_date_user_confirmed', 'buyer_event_user_confirmed',
      'buyer_event_description', 'economic_buyer_contact_id',
      'legal_engaged_user', 'security_review_user',
      'scope_approved_user', 'competitive_deal_user',
      'price_sensitivity_user', 'discount_pending_user'
    ];

    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: { message: 'No valid fields' } });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await db.query(
      `UPDATE deals SET ${setClauses}, updated_at = NOW()
       WHERE id = $1 AND owner_id = ${Object.keys(updates).length + 2}
       RETURNING id, health, health_score, ${Object.keys(updates).join(', ')}`,
      [req.params.id, ...Object.values(updates), req.user.userId]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Deal not found' } });

    // Re-score after signal change
    const scored = await scoreDeal(req.params.id, req.user.userId);
    res.json({ deal: r.rows[0], scored });
  } catch (err) {
    console.error('Update signals error:', err);
    res.status(500).json({ error: { message: 'Failed to update signals' } });
  }
});

// ── Helpers ──────────────────────────────────────────────────

function parseConfig(row) {
  const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
  return {
    ...row,
    param_weights:       parse(row.param_weights),
    params_enabled:      parse(row.params_enabled),
    exec_titles:         parse(row.exec_titles),
    legal_titles:        parse(row.legal_titles),
    procurement_titles:  parse(row.procurement_titles),
    security_titles:     parse(row.security_titles),
  };
}

function parseCompetitor(row) {
  return {
    ...row,
    aliases: typeof row.aliases === 'string' ? JSON.parse(row.aliases) : row.aliases
  };
}

module.exports = router;
