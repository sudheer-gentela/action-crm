/**
 * calendar.routes.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: backend/routes/calendar.routes.js
 *
 * Key changes from original:
 *   - POST /sync now accepts optional 'provider' in body ('outlook' | 'google')
 *   - Error messages are provider-aware
 *   - GET /week unchanged
 *   - GET /sync/status unchanged
 */

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
// Now accepts: { provider: 'outlook' | 'google', startDate, endDate, top }
router.post('/sync', async (req, res) => {
  try {
    const { startDate, endDate, top, provider } = req.body;

    // Validate provider
    const resolvedProvider = provider || 'outlook';
    if (!['outlook', 'google'].includes(resolvedProvider)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid provider. Use "outlook" or "google".',
      });
    }

    const providerLabel = resolvedProvider === 'google' ? 'Google Calendar' : 'Outlook Calendar';
    console.log(`📅 Manual ${providerLabel} sync triggered for user ${req.user.userId} org ${req.orgId}`);

    const result = await triggerCalendarSync(req.user.userId, {
      startDate,
      endDate,
      top,
      orgId: req.orgId,
      provider: resolvedProvider,
    });

    if (!result.success) {
      return res.status(200).json({
        success: false,
        message: result.message || `${providerLabel} sync failed`,
      });
    }

    res.json({
      success: true,
      message: `${providerLabel} sync completed`,
      data: {
        provider: resolvedProvider,
        found: result.eventsFound,
        stored: result.stored,
        skipped: result.skipped,
        failed: result.failed,
      },
    });
  } catch (error) {
    console.error('❌ Calendar sync error:', error);

    const provider = req.body.provider || 'outlook';
    const providerLabel = provider === 'google' ? 'Google' : 'Outlook';

    if (
      error.message.includes('No tokens found') ||
      error.message.includes('not connected') ||
      error.message.includes('Please reconnect')
    ) {
      return res.status(403).json({
        success: false,
        error: `${providerLabel} not connected`,
        message: `Please connect your ${providerLabel} account first`,
        code: 'NOT_CONNECTED',
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /sync/status ──────────────────────────────────────────
router.get('/sync/status', async (req, res) => {
  try {
    const history = await getCalendarSyncStatus(req.user.userId, req.orgId);
    res.json({ success: true, data: { lastSyncs: history } });
  } catch (error) {
    console.error('❌ Error fetching calendar sync status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
