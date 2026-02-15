/**
 * AI Processing Routes
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const AIProcessor = require('../services/aiProcessor');

// Process single email with AI
router.post('/email/:emailId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { emailId } = req.params;
    
    const result = await AIProcessor.processEmail(userId, emailId);
    res.json(result);
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Analyze deal health
router.post('/deal/:dealId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { dealId } = req.params;
    
    const result = await AIProcessor.analyzeDeal(dealId, userId);
    res.json(result);
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
