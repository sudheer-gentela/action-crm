const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

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

module.exports = router;
