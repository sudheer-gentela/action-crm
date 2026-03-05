// routes/notifications.routes.js
// In-app notification inbox.
// Mount in server.js: app.use('/api/notifications', require('./routes/notifications.routes'));

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }    = require('../middleware/orgContext.middleware');
const escalationService = require('../services/escalationService');

router.use(authenticateToken);
router.use(orgContext);

/**
 * GET /api/notifications
 * Returns notifications for the current user.
 * Query params:
 *   unread=true   — only unread
 *   limit=30      — max results (default 30, max 100)
 *   offset=0
 */
router.get('/', async (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const limit      = Math.min(parseInt(req.query.limit)  || 30, 100);
    const offset     = parseInt(req.query.offset) || 0;

    const result = await escalationService.getNotifications(
      req.user.userId,
      { unreadOnly, limit, offset }
    );

    res.json(result);
  } catch (err) {
    console.error('GET /notifications error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/notifications/read
 * Mark notifications as read.
 * Body: { ids: [1, 2, 3] }  — specific IDs
 *       {}                   — marks ALL unread as read
 */
router.patch('/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    await escalationService.markNotificationsRead(req.user.userId, ids);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /notifications/read error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read.
 */
router.patch('/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await escalationService.markNotificationsRead(req.user.userId, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /notifications/:id/read error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
