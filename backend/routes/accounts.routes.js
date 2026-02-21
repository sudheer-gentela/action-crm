const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM accounts WHERE org_id = $1 AND owner_id = $2 ORDER BY name',
      [req.orgId, req.user.userId]
    );
    res.json({ accounts: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch accounts' } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, domain, industry, size, location, description } = req.body;
    const result = await db.query(
      `INSERT INTO accounts (org_id, name, domain, industry, size, location, description, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.orgId, name, domain, industry, size, location, description, req.user.userId]
    );
    res.status(201).json({ account: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to create account' } });
  }
});

module.exports = router;
