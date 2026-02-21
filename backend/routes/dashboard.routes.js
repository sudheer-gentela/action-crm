const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

router.get('/stats', async (req, res) => {
  try {
    const [openActions, activeDeals, pipelineValue, winRate] = await Promise.all([
      db.query(
        'SELECT COUNT(*) FROM actions WHERE org_id = $1 AND user_id = $2 AND completed = false',
        [req.orgId, req.user.userId]
      ),
      db.query(
        `SELECT COUNT(*) FROM deals
         WHERE org_id = $1 AND owner_id = $2 AND stage NOT IN ('closed_won', 'closed_lost')`,
        [req.orgId, req.user.userId]
      ),
      db.query(
        `SELECT SUM(value) FROM deals
         WHERE org_id = $1 AND owner_id = $2 AND stage NOT IN ('closed_won', 'closed_lost')`,
        [req.orgId, req.user.userId]
      ),
      db.query(
        `SELECT
           CASE WHEN COUNT(*) = 0 THEN 0
           ELSE ROUND((COUNT(*) FILTER (WHERE stage = 'closed_won')::DECIMAL / COUNT(*)) * 100)
           END as win_rate
         FROM deals
         WHERE org_id = $1 AND owner_id = $2 AND stage IN ('closed_won', 'closed_lost')`,
        [req.orgId, req.user.userId]
      ),
    ]);

    res.json({
      stats: {
        openActions:   parseInt(openActions.rows[0].count),
        activeDeals:   parseInt(activeDeals.rows[0].count),
        pipelineValue: parseFloat(pipelineValue.rows[0].sum || 0),
        winRate:       parseInt(winRate.rows[0].win_rate || 0)
      }
    });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch stats' } });
  }
});

module.exports = router;
