const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM accounts WHERE owner_id = $1 ORDER BY name',
      [req.user.userId]
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
      `INSERT INTO accounts (name, domain, industry, size, location, description, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, domain, industry, size, location, description, req.user.userId]
    );
    res.status(201).json({ account: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to create account' } });
  }
});

module.exports = router;
