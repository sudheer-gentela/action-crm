/**
 * Calendar Routes - UPDATED with Outlook Sync
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { triggerCalendarSync, getCalendarSyncStatus } = require('../jobs/calendarSync');

router.use(authenticateToken);

/**
 * Get week view of meetings
 * GET /api/calendar/week
 */
router.get('/week', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await db.query(
      `SELECT m.*, d.name as deal_name, acc.name as account_name
       FROM meetings m
       LEFT JOIN deals d ON m.deal_id = d.id
       LEFT JOIN accounts acc ON d.account_id = acc.id
       WHERE m.user_id = $1 AND m.start_time BETWEEN $2 AND $3
       ORDER BY m.start_time`,
      [req.user.userId, startDate, endDate]
    );
    res.json({ meetings: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch calendar' } });
  }
});

/**
 * Trigger manual calendar sync from Outlook
 * POST /api/calendar/sync
 */
router.post('/sync', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { startDate, endDate, top } = req.body;
    
    console.log(`📅 Manual calendar sync triggered for user ${userId}`);
    
    const result = await triggerCalendarSync(userId, {
      startDate,
      endDate,
      top
    });
    
    if (!result.success) {
      return res.status(200).json({
        success: false,
        message: result.message || 'Calendar sync failed'
      });
    }
    
    res.json({
      success: true,
      message: 'Calendar sync completed',
      data: {
        found: result.eventsFound,
        stored: result.stored,
        skipped: result.skipped,
        failed: result.failed
      }
    });
    
  } catch (error) {
    console.error('❌ Calendar sync error:', error);
    
    // Handle specific error cases
    if (error.message.includes('No tokens found') || error.message.includes('Outlook not connected')) {
      return res.status(403).json({
        success: false,
        error: 'Outlook not connected',
        message: 'Please connect your Outlook account first',
        code: 'NOT_CONNECTED'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get calendar sync status and history
 * GET /api/calendar/sync/status
 */
router.get('/sync/status', async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const history = await getCalendarSyncStatus(userId);
    
    res.json({
      success: true,
      data: {
        lastSyncs: history
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching calendar sync status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
