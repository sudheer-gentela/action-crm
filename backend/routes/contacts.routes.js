const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

router.use(authenticateToken);

// Get all contacts
router.get('/', async (req, res) => {
  try {
    const { roleType, engagementLevel } = req.query;
    
    let query = `
      SELECT 
        c.*,
        acc.name as account_name,
        acc.id as account_id,
        json_agg(
          json_build_object('id', d.id, 'name', d.name, 'value', d.value, 'stage', d.stage)
        ) FILTER (WHERE d.id IS NOT NULL) as deals
      FROM contacts c
      LEFT JOIN accounts acc ON c.account_id = acc.id
      LEFT JOIN deal_contacts dc ON c.id = dc.contact_id
      LEFT JOIN deals d ON dc.deal_id = d.id AND d.owner_id = $1
      WHERE acc.owner_id = $1 OR EXISTS (
        SELECT 1 FROM deal_contacts dc2 
        JOIN deals d2 ON dc2.deal_id = d2.id 
        WHERE dc2.contact_id = c.id AND d2.owner_id = $1
      )
    `;
    
    const params = [req.user.userId];
    
    if (roleType) {
      query += ` AND c.role_type = $${params.length + 1}`;
      params.push(roleType);
    }
    
    if (engagementLevel) {
      query += ` AND c.engagement_level = $${params.length + 1}`;
      params.push(engagementLevel);
    }
    
    query += ' GROUP BY c.id, acc.id ORDER BY c.last_contact_date DESC NULLS LAST';
    
    const result = await db.query(query, params);
    
    res.json({
      contacts: result.rows.map(row => ({
        ...row,
        account: { id: row.account_id, name: row.account_name },
        deals: row.deals || []
      }))
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch contacts' } });
  }
});

// Get single contact with full details
router.get('/:id', async (req, res) => {
  try {
    const contactQuery = await db.query(
      `SELECT c.*, acc.name as account_name, acc.id as account_id
       FROM contacts c
       LEFT JOIN accounts acc ON c.account_id = acc.id
       WHERE c.id = $1`,
      [req.params.id]
    );
    
    if (contactQuery.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }
    
    const contact = contactQuery.rows[0];
    
    // Get activities
    const activitiesQuery = await db.query(
      `SELECT * FROM contact_activities 
       WHERE contact_id = $1 
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );
    
    // Get conversation starters
    const startersQuery = await db.query(
      `SELECT * FROM conversation_starters 
       WHERE contact_id = $1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       ORDER BY relevance_score DESC LIMIT 5`,
      [req.params.id]
    );
    
    res.json({
      contact: {
        ...contact,
        account: { id: contact.account_id, name: contact.account_name },
        activities: activitiesQuery.rows,
        conversationStarters: startersQuery.rows
      }
    });
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch contact' } });
  }
});

// Create contact
router.post('/', async (req, res) => {
  try {
    const { accountId, firstName, lastName, email, phone, title, roleType, location, linkedinUrl, notes } = req.body;
    
    const result = await db.query(
      `INSERT INTO contacts (account_id, first_name, last_name, email, phone, title, role_type, location, linkedin_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [accountId, firstName, lastName, email, phone, title, roleType, location, linkedinUrl, notes]
    );
    
    res.status(201).json({ contact: result.rows[0] });
  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({ error: { message: 'Failed to create contact' } });
  }
});

// Update contact
router.put('/:id', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, title, roleType, engagementLevel, location, linkedinUrl, notes } = req.body;
    
    const result = await db.query(
      `UPDATE contacts 
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           title = COALESCE($5, title),
           role_type = COALESCE($6, role_type),
           engagement_level = COALESCE($7, engagement_level),
           location = COALESCE($8, location),
           linkedin_url = COALESCE($9, linkedin_url),
           notes = COALESCE($10, notes),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 RETURNING *`,
      [firstName, lastName, email, phone, title, roleType, engagementLevel, location, linkedinUrl, notes, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Contact not found' } });
    }
    
    res.json({ contact: result.rows[0] });
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: { message: 'Failed to update contact' } });
  }
});

// Log contact activity
router.post('/:id/activities', async (req, res) => {
  try {
    const { activityType, description, metadata } = req.body;
    
    await db.query(
      `INSERT INTO contact_activities (contact_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.user.userId, activityType, description, metadata]
    );
    
    // Update last contact date
    await db.query(
      'UPDATE contacts SET last_contact_date = CURRENT_TIMESTAMP WHERE id = $1',
      [req.params.id]
    );
    
    res.status(201).json({ message: 'Activity logged' });
  } catch (error) {
    console.error('Log activity error:', error);
    res.status(500).json({ error: { message: 'Failed to log activity' } });
  }
});

module.exports = router;
