const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

// ── GET / ─────────────────────────────────────────────────────
router.get('/', authenticateToken, orgContext, async (req, res) => {
  try {
    const AI_PROMPTS = require('../config/aiPrompts');

    const result = await db.query(
      'SELECT template_type, template_data FROM user_prompts WHERE user_id = $1 AND org_id = $2',
      [req.user.userId, req.orgId]
    );

    const prompts = {
      email_analysis:    AI_PROMPTS.email_analysis,
      deal_health_check: AI_PROMPTS.deal_health_check
    };

    result.rows.forEach(row => {
      if (row.template_type === 'email_analysis' || row.template_type === 'deal_health_check') {
        prompts[row.template_type] = row.template_data;
      }
    });

    res.json({ success: true, prompts });
  } catch (error) {
    console.error('Error loading prompts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── PUT / ─────────────────────────────────────────────────────
router.put('/', authenticateToken, orgContext, async (req, res) => {
  try {
    const { prompts } = req.body;
    if (!prompts) {
      return res.status(400).json({ success: false, error: 'Prompts data is required' });
    }

    for (const templateType of ['email_analysis', 'deal_health_check']) {
      if (prompts[templateType]) {
        await db.query(
          `INSERT INTO user_prompts (user_id, org_id, template_type, template_data, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, org_id, template_type)
           DO UPDATE SET template_data = $4, updated_at = NOW()`,
          [req.user.userId, req.orgId, templateType, prompts[templateType]]
        );
      }
    }

    res.json({ success: true, message: 'Prompts saved successfully' });
  } catch (error) {
    console.error('Error saving prompts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /reset ───────────────────────────────────────────────
router.post('/reset', authenticateToken, orgContext, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_prompts WHERE user_id = $1 AND org_id = $2',
      [req.user.userId, req.orgId]
    );

    const AI_PROMPTS = require('../config/aiPrompts');

    res.json({
      success: true,
      prompts: {
        email_analysis:    AI_PROMPTS.email_analysis,
        deal_health_check: AI_PROMPTS.deal_health_check
      },
      message: 'Prompts reset to defaults'
    });
  } catch (error) {
    console.error('Error resetting prompts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
