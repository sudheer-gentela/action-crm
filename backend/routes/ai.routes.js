const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const AIProcessor = require('../services/aiProcessor');

// ── POST /email/:emailId ──────────────────────────────────────
router.post('/email/:emailId', authenticateToken, orgContext, async (req, res) => {
  try {
    const result = await AIProcessor.processEmail(req.user.userId, req.params.emailId, req.orgId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /deal/:dealId ────────────────────────────────────────
router.post('/deal/:dealId', authenticateToken, orgContext, async (req, res) => {
  try {
    const result = await AIProcessor.analyzeDeal(req.params.dealId, req.user.userId, req.orgId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
