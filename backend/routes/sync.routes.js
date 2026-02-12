const express = require('express');
const router = express.Router();
const { triggerSync, getSyncStatus } = require('../jobs/syncScheduler');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

/**
 * Trigger manual email sync
 * POST /api/sync/trigger
 */
router.post('/trigger', async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const result = await triggerSync(userId, 'email');
    
    res.json({
      success: true,
      message: 'Sync triggered',
      data: result
    });
  } catch (error) {
    console.error('Error triggering sync:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * Get sync history
 * GET /api/sync/status
 */
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const status = await getSyncStatus(userId);
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

module.exports = router;
