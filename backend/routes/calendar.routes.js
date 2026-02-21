const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const { triggerCalendarSync, getCalendarSyncStatus } = require('../jobs/calendarSync');

router.use(authenticateToken);
router.use(orgContext);

// ── GET /week ─────────────────────────────────────────────────
router.get('/week', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await db.query(
      `SELECT m.*, d.name as deal_name, acc.name as account_name
       FROM meetings m
       LEFT JOIN deals    d   ON m.deal_id    = d.id
       LEFT JOIN accounts acc ON d.account_id = acc.id
       WHERE m.org_id = $1 AND m.user_id = $2
         AND m.start_time BETWEEN $3 AND $4
       ORDER BY m.start_time`,
      [req.orgId, req.user.userId, startDate, endDate]
    );
    res.json({ meetings: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch calendar' } });
  }
});

// ── POST /sync ────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    const { startDate, endDate, top } = req.body;
    console.log(`📅 Manual calendar sync triggered for user ${req.user.userId} org ${req.orgId}`);

    const result = await triggerCalendarSync(req.user.userId, { startDate, endDate, top });

    if (!result.success) {
      return res.status(200).json({ success: false, message: result.message || 'Calendar sync failed' });
    }

    res.json({
      success: true,
      message: 'Calendar sync completed',
      data: { found: result.eventsFound, stored: result.stored, skipped: result.skipped, failed: result.failed }
    });
  } catch (error) {
    console.error('❌ Calendar sync error:', error);
    if (error.message.includes('No tokens found') || error.message.includes('Outlook not connected')) {
      return res.status(403).json({
        success: false, error: 'Outlook not connected',
        message: 'Please connect your Outlook account first', code: 'NOT_CONNECTED'
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /sync/status ──────────────────────────────────────────
router.get('/sync/status', async (req, res) => {
  try {
    const history = await getCalendarSyncStatus(req.user.userId);
    res.json({ success: true, data: { lastSyncs: history } });
  } catch (error) {
    console.error('❌ Error fetching calendar sync status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
