const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

// ── GET / ─────────────────────────────────────────────────────
router.get('/', authenticateToken, orgContext, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT playbook_data FROM user_playbooks WHERE user_id = $1 AND org_id = $2',
      [req.user.userId, req.orgId]
    );

    const playbook = result.rows.length > 0
      ? result.rows[0].playbook_data
      : require('../config/salesPlaybook');

    res.json({ success: true, playbook });
  } catch (error) {
    console.error('Error loading playbook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── PUT / ─────────────────────────────────────────────────────
router.put('/', authenticateToken, orgContext, async (req, res) => {
  try {
    const { playbook } = req.body;
    if (!playbook) {
      return res.status(400).json({ success: false, error: 'Playbook data is required' });
    }

    await db.query(
      `INSERT INTO user_playbooks (user_id, org_id, playbook_data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, org_id)
       DO UPDATE SET playbook_data = $3, updated_at = NOW()`,
      [req.user.userId, req.orgId, JSON.stringify(playbook)]
    );

    res.json({ success: true, message: 'Playbook saved successfully' });
  } catch (error) {
    console.error('Error saving playbook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /reset ───────────────────────────────────────────────
router.post('/reset', authenticateToken, orgContext, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_playbooks WHERE user_id = $1 AND org_id = $2',
      [req.user.userId, req.orgId]
    );

    res.json({
      success:  true,
      playbook: require('../config/salesPlaybook'),
      message:  'Playbook reset to default'
    });
  } catch (error) {
    console.error('Error resetting playbook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
