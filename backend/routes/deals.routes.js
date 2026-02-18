const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const ActionsGenerator = require('../services/actionsGenerator');
const ActionConfigService = require('../services/actionConfig.service');

router.use(authenticateToken);

// Get all deals for the current user
router.get('/', async (req, res) => {
  try {
    const { stage, health } = req.query;
    
    let query = `
      SELECT 
        d.*,
        acc.name as account_name,
        acc.domain as account_domain,
        u.first_name as owner_first_name,
        u.last_name as owner_last_name,
        json_agg(
          json_build_object(
            'id', c.id,
            'firstName', c.first_name,
            'lastName', c.last_name,
            'email', c.email,
            'title', c.title,
            'role', dc.role
          )
        ) FILTER (WHERE c.id IS NOT NULL) as contacts
      FROM deals d
      LEFT JOIN accounts acc ON d.account_id = acc.id
      LEFT JOIN users u ON d.owner_id = u.id
      LEFT JOIN deal_contacts dc ON d.id = dc.deal_id
      LEFT JOIN contacts c ON dc.contact_id = c.id
      WHERE d.owner_id = $1
    `;
    
    const params = [req.user.userId];
    
    if (stage) {
      query += ` AND d.stage = $${params.length + 1}`;
      params.push(stage);
    }
    
    if (health) {
      query += ` AND d.health = $${params.length + 1}`;
      params.push(health);
    }
    
    query += ' GROUP BY d.id, acc.id, u.id ORDER BY d.expected_close_date ASC';
    
    const result = await db.query(query, params);
    
    res.json({
      deals: result.rows.map(row => ({
        id: row.id,
        user_id: row.owner_id, // ✅ Added for frontend compatibility
        account_id: row.account_id, // ✅ Keep original field
        name: row.name,
        value: parseFloat(row.value),
        stage: row.stage,
        health: row.health,
        expected_close_date: row.expected_close_date, // ✅ Use snake_case
        probability: row.probability,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        // ✅ Add account object for frontend
        account: row.account_name ? {
          id: row.account_id,
          name: row.account_name,
          domain: row.account_domain
        } : null,
        owner: {
          first_name: row.owner_first_name,
          last_name: row.owner_last_name
        },
        contacts: row.contacts || []
      }))
    });
  } catch (error) {
    console.error('Get deals error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch deals' } });
  }
});

// Get single deal with full details
router.get('/:id', async (req, res) => {
  try {
    const dealQuery = await db.query(
      `SELECT 
        d.*,
        acc.name as account_name,
        acc.domain as account_domain,
        acc.industry as account_industry,
        acc.size as account_size,
        u.first_name as owner_first_name,
        u.last_name as owner_last_name
      FROM deals d
      LEFT JOIN accounts acc ON d.account_id = acc.id
      LEFT JOIN users u ON d.owner_id = u.id
      WHERE d.id = $1 AND d.owner_id = $2`,
      [req.params.id, req.user.userId]
    );
    
    if (dealQuery.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }
    
    const deal = dealQuery.rows[0];
    
    // Get contacts
    const contactsQuery = await db.query(
      `SELECT c.*, dc.role
       FROM contacts c
       JOIN deal_contacts dc ON c.id = dc.contact_id
       WHERE dc.deal_id = $1`,
      [req.params.id]
    );
    
    // Get recent activities
    const activitiesQuery = await db.query(
      `SELECT *
       FROM deal_activities
       WHERE deal_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.params.id]
    );
    
    res.json({
      deal: {
        id: deal.id,
        user_id: deal.owner_id, // ✅ Added for consistency
        account_id: deal.account_id, // ✅ Keep original field
        name: deal.name,
        value: parseFloat(deal.value),
        stage: deal.stage,
        health: deal.health,
        expected_close_date: deal.expected_close_date, // ✅ Use snake_case
        probability: deal.probability,
        notes: deal.notes,
        created_at: deal.created_at,
        updated_at: deal.updated_at,
        // ✅ Add account object
        account: deal.account_name ? {
          id: deal.account_id,
          name: deal.account_name,
          domain: deal.account_domain,
          industry: deal.account_industry,
          size: deal.account_size
        } : null,
        owner: {
          first_name: deal.owner_first_name,
          last_name: deal.owner_last_name
        },
        contacts: contactsQuery.rows,
        activities: activitiesQuery.rows
      }
    });
  } catch (error) {
    console.error('Get deal error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch deal' } });
  }
});

// Create new deal
router.post('/', async (req, res) => {
  try {
    const { accountId, name, value, stage, health, expectedCloseDate, probability, notes } = req.body;
    
    const result = await db.query(
      `INSERT INTO deals (account_id, owner_id, name, value, stage, health, expected_close_date, original_close_date, probability, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)
       RETURNING *`,
      [accountId, req.user.userId, name, value, stage || 'qualified', health || 'healthy', expectedCloseDate, probability || 50, notes]
    );
    
    const newDeal = result.rows[0];
    
    // Log activity
    await db.query(
      `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
       VALUES ($1, $2, 'deal_created', 'Deal created')`,
      [newDeal.id, req.user.userId]
    );
    
    // 🤖 AUTO-GENERATE ACTIONS (non-blocking)
    ActionsGenerator.generateForDeal(newDeal.id).catch(err => 
      console.error('Error auto-generating actions for new deal:', err)
    );
    
    res.status(201).json({ deal: newDeal });
  } catch (error) {
    console.error('Create deal error:', error);
    res.status(500).json({ error: { message: 'Failed to create deal' } });
  }
});

// Update deal
router.put('/:id', async (req, res) => {
  try {
    const { name, value, stage, health, expectedCloseDate, probability, notes } = req.body;
    
    // Get current deal to check for stage change
    const currentDeal = await db.query(
      'SELECT stage, value, expected_close_date, close_date_push_count, original_close_date FROM deals WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.userId]
    );
    
    if (currentDeal.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }

    const current = currentDeal.rows[0];

    // Detect close date push (new date is later than current)
    let closeDatePushIncrement = 0;
    if (expectedCloseDate && current.expected_close_date) {
      const newDate = new Date(expectedCloseDate);
      const oldDate = new Date(current.expected_close_date);
      if (newDate > oldDate) closeDatePushIncrement = 1;
    }
    
    const result = await db.query(
      `UPDATE deals 
       SET name = COALESCE($1, name),
           value = COALESCE($2, value),
           stage = COALESCE($3, stage),
           health = COALESCE($4, health),
           expected_close_date = COALESCE($5, expected_close_date),
           probability = COALESCE($6, probability),
           notes = COALESCE($7, notes),
           close_date_push_count = close_date_push_count + $10,
           updated_at = CURRENT_TIMESTAMP,
           closed_at = CASE WHEN $3 IN ('closed_won', 'closed_lost') THEN CURRENT_TIMESTAMP ELSE closed_at END
       WHERE id = $8 AND owner_id = $9
       RETURNING *`,
      [name, value, stage, health, expectedCloseDate, probability, notes, req.params.id, req.user.userId, closeDatePushIncrement]
    );
    
    // Log stage change
    if (stage && stage !== current.stage) {
      await db.query(
        `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
         VALUES ($1, $2, 'stage_change', $3)`,
        [req.params.id, req.user.userId, `Stage changed from ${current.stage} to ${stage}`]
      );
      
      // ✨ NEW: Generate playbook actions on stage change
      try {
        const config = await ActionConfigService.getConfig(req.user.userId);
        if (config.generate_on_stage_change) {
          await ActionsGenerator.generateForStageChange(
            req.params.id,
            stage,
            req.user.userId
          );
          console.log(`📘 Generated playbook actions for stage: ${stage}`);
        }
      } catch (err) {
        console.error('Error generating playbook actions on stage change:', err);
        // Don't fail the deal update if action generation fails
      }
    }

    // Log close date push
    if (closeDatePushIncrement > 0) {
      await db.query(
        `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
         VALUES ($1, $2, 'close_date_pushed', $3)`,
        [req.params.id, req.user.userId,
         `Close date pushed from ${new Date(current.expected_close_date).toLocaleDateString()} to ${new Date(expectedCloseDate).toLocaleDateString()} (push #${(current.close_date_push_count || 0) + 1})`]
      );
    }

    // Log value change to deal_value_history
    if (value !== undefined && value !== null && parseFloat(value) !== parseFloat(current.value)) {
      await db.query(
        `INSERT INTO deal_value_history (deal_id, user_id, old_value, new_value)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, req.user.userId, current.value, value]
      );
    }
    
    // 🤖 AUTO-GENERATE ACTIONS (non-blocking)
    ActionsGenerator.generateForDeal(req.params.id).catch(err => 
      console.error('Error auto-generating actions for updated deal:', err)
    );
    
    res.json({ deal: result.rows[0] });
  } catch (error) {
    console.error('Update deal error:', error);
    res.status(500).json({ error: { message: 'Failed to update deal' } });
  }
});

// Delete deal
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM deals WHERE id = $1 AND owner_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Deal not found' } });
    }
    
    res.json({ message: 'Deal deleted successfully' });
  } catch (error) {
    console.error('Delete deal error:', error);
    res.status(500).json({ error: { message: 'Failed to delete deal' } });
  }
});

// Add contact to deal
router.post('/:id/contacts', async (req, res) => {
  try {
    const { contactId, role } = req.body;
    
    await db.query(
      'INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [req.params.id, contactId, role || 'secondary']
    );
    
    // Log activity
    await db.query(
      `INSERT INTO deal_activities (deal_id, user_id, activity_type, description)
       VALUES ($1, $2, 'contact_added', 'Contact added to deal')`,
      [req.params.id, req.user.userId]
    );
    
    res.status(201).json({ message: 'Contact added to deal' });
  } catch (error) {
    console.error('Add contact to deal error:', error);
    res.status(500).json({ error: { message: 'Failed to add contact' } });
  }
});

// Get pipeline summary
router.get('/pipeline/summary', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        stage,
        COUNT(*) as count,
        SUM(value) as total_value
       FROM deals
       WHERE owner_id = $1 AND stage NOT IN ('closed_won', 'closed_lost')
       GROUP BY stage
       ORDER BY CASE stage
         WHEN 'qualified' THEN 1
         WHEN 'demo' THEN 2
         WHEN 'proposal' THEN 3
         WHEN 'negotiation' THEN 4
         ELSE 5
       END`,
      [req.user.userId]
    );
    
    res.json({
      pipeline: result.rows.map(row => ({
        stage: row.stage,
        count: parseInt(row.count),
        totalValue: parseFloat(row.total_value)
      }))
    });
  } catch (error) {
    console.error('Get pipeline summary error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch pipeline summary' } });
  }
});

module.exports = router;
