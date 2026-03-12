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
      email_analysis:              AI_PROMPTS.email_analysis,
      deal_health_check:           AI_PROMPTS.deal_health_check,
      prospecting_research_account: AI_PROMPTS.prospecting_research_account || '',
      prospecting_research:        AI_PROMPTS.prospecting_research || '',
      prospecting_draft:           AI_PROMPTS.prospecting_draft    || '',
    };

    const ALLOWED_TYPES = [
      'email_analysis', 'deal_health_check',
      'prospecting_research_account', 'prospecting_research', 'prospecting_draft',
    ];
    result.rows.forEach(row => {
      if (ALLOWED_TYPES.includes(row.template_type)) {
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

    for (const templateType of ['email_analysis', 'deal_health_check', 'prospecting_research_account', 'prospecting_research', 'prospecting_draft']) {
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


// ── Org-level prospecting prompts (admin only) ────────────────────────────────
// Stored in the `prompts` table with user_id = NULL.
// These are the org defaults; user_prompts rows override per-user.

function adminOnly(req, res, next) {
  const role = req.user?.role || req.orgRole;
  if (!['admin', 'owner'].includes(role)) {
    return res.status(403).json({ error: { message: 'Admin access required' } });
  }
  next();
}

const ORG_PROMPT_KEYS = ['prospecting_research_account', 'prospecting_research', 'prospecting_draft'];

// GET /api/prompts/org/prospecting — returns org-level templates
router.get('/org/prospecting', authenticateToken, orgContext, async (req, res) => {
  try {
    const AI_PROMPTS = require('../config/aiPrompts');
    const result = await db.query(
      `SELECT key, template FROM prompts
       WHERE org_id = $1 AND user_id IS NULL AND key = ANY($2::text[])`,
      [req.orgId, ORG_PROMPT_KEYS]
    );
    const prompts = {
      prospecting_research_account: AI_PROMPTS.prospecting_research_account || '',
      prospecting_research:         AI_PROMPTS.prospecting_research || '',
      prospecting_draft:            AI_PROMPTS.prospecting_draft    || '',
    };
    result.rows.forEach(row => { prompts[row.key] = row.template; });
    res.json({ success: true, prompts });
  } catch (error) {
    console.error('GET /prompts/org/prospecting error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/prompts/org/prospecting — upserts org-level templates (admin only)
router.put('/org/prospecting', authenticateToken, orgContext, adminOnly, async (req, res) => {
  try {
    const { prompts } = req.body;
    if (!prompts) return res.status(400).json({ success: false, error: 'prompts required' });

    for (const key of ORG_PROMPT_KEYS) {
      if (prompts[key] === '') {
        // Empty string = delete org override, fall back to system default
        await db.query(
          `DELETE FROM prompts WHERE org_id = $1 AND user_id IS NULL AND key = $2`,
          [req.orgId, key]
        );
      } else if (prompts[key]) {
        await db.query(
          `INSERT INTO prompts (org_id, user_id, key, template)
           VALUES ($1, NULL, $2, $3)
           ON CONFLICT (user_id, org_id, key) DO UPDATE
           SET template = $3, updated_at = CURRENT_TIMESTAMP`,
          [req.orgId, key, prompts[key]]
        );
      }
    }
    res.json({ success: true, message: 'Org prompts saved' });
  } catch (error) {
    console.error('PUT /prompts/org/prospecting error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/prompts/user/prospecting — returns current user's prompt overrides
router.get('/user/prospecting', authenticateToken, orgContext, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT template_type, template_data FROM user_prompts
       WHERE user_id = $1 AND org_id = $2 AND template_type = ANY($3::text[])`,
      [req.user.userId, req.orgId, ORG_PROMPT_KEYS]
    );
    const prompts = {};
    result.rows.forEach(row => { prompts[row.template_type] = row.template_data; });
    res.json({ success: true, prompts });
  } catch (error) {
    console.error('GET /prompts/user/prospecting error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/prompts/user/prospecting — upserts user's prompt overrides
router.put('/user/prospecting', authenticateToken, orgContext, async (req, res) => {
  try {
    const { prompts } = req.body;
    if (!prompts) return res.status(400).json({ success: false, error: 'prompts required' });

    for (const key of ORG_PROMPT_KEYS) {
      if (prompts[key] === '') {
        // Empty = delete override, fall back to org/system default
        await db.query(
          `DELETE FROM user_prompts WHERE user_id = $1 AND org_id = $2 AND template_type = $3`,
          [req.user.userId, req.orgId, key]
        );
      } else if (prompts[key]) {
        await db.query(
          `INSERT INTO user_prompts (user_id, org_id, template_type, template_data)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, org_id, template_type)
           DO UPDATE SET template_data = $4, updated_at = NOW()`,
          [req.user.userId, req.orgId, key, prompts[key]]
        );
      }
    }
    res.json({ success: true, message: 'User prompts saved' });
  } catch (error) {
    console.error('PUT /prompts/user/prospecting error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

