const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM proposals WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId]
    );
    res.json({ proposals: result.rows });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to fetch proposals' } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { dealId, pricingTier, numUsers, contractLength, annualValue, implementationFee, discountPercent, paymentTerms } = req.body;
    
    const totalValue = parseFloat(annualValue) + parseFloat(implementationFee || 0);
    
    const result = await db.query(
      `INSERT INTO proposals (deal_id, user_id, pricing_tier, num_users, contract_length, annual_value, implementation_fee, discount_percent, total_value, payment_terms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [dealId, req.user.userId, pricingTier, numUsers, contractLength, annualValue, implementationFee, discountPercent, totalValue, paymentTerms]
    );
    
    res.status(201).json({ proposal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: { message: 'Failed to create proposal' } });
  }
});

module.exports = router;
