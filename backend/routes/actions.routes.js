const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const ActionsGenerator = require('../services/actionsGenerator');
const ActionConfigService = require('../services/actionConfig.service');
const ActionCompletionDetector = require('../services/actionCompletionDetector.service');

// All routes require authentication
router.use(authenticateToken);

// Get all actions for the current user
router.get('/', async (req, res) => {
  try {
    const { completed, priority } = req.query;
    
    let query = `
      SELECT 
        a.*,
        d.name as deal_name,
        d.value as deal_value,
        d.stage as deal_stage,
        c.first_name as contact_first_name,
        c.last_name as contact_last_name,
        acc.name as account_name
      FROM actions a
      LEFT JOIN deals d ON a.deal_id = d.id
      LEFT JOIN contacts c ON a.contact_id = c.id
      LEFT JOIN accounts acc ON d.account_id = acc.id
      WHERE a.user_id = $1
    `;
    
    const params = [req.user.userId];
    
    if (completed !== undefined) {
      query += ` AND a.completed = $${params.length + 1}`;
      params.push(completed === 'true');
    }
    
    if (priority) {
      query += ` AND a.priority = $${params.length + 1}`;
      params.push(priority);
    }
    
    query += ' ORDER BY CASE a.priority WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, a.due_date ASC NULLS LAST';
    
    const result = await db.query(query, params);
    
    res.json({
      actions: result.rows.map(row => ({
        id: row.id,
        type: row.type,
        priority: row.priority,
        title: row.title,
        description: row.description,
        context: row.context,
        dueDate: row.due_date,
        completed: row.completed,
        completedAt: row.completed_at,
        deal: row.deal_id ? {
          id: row.deal_id,
          name: row.deal_name,
          value: parseFloat(row.deal_value),
          stage: row.deal_stage,
          account: row.account_name
        } : null,
        contact: row.contact_id ? {
          id: row.contact_id,
          firstName: row.contact_first_name,
          lastName: row.contact_last_name
        } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });
  } catch (error) {
    console.error('Get actions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch actions' } });
  }
});

// NEW: Manual action generation endpoint
router.post('/generate', async (req, res) => {
  try {
    console.log('🤖 Manual action generation triggered by user:', req.user.userId);
    const result = await ActionsGenerator.generateAll();
    
    if (result.success) {
      res.json({
        success: true,
        message: `Generated ${result.inserted} actions`,
        generated: result.generated,
        inserted: result.inserted
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to generate actions',
        error: result.error
      });
    }
  } catch (error) {
    console.error('Error in /generate endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get single action
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
        a.*,
        d.name as deal_name,
        d.value as deal_value,
        d.stage as deal_stage,
        c.first_name as contact_first_name,
        c.last_name as contact_last_name,
        acc.name as account_name
      FROM actions a
      LEFT JOIN deals d ON a.deal_id = d.id
      LEFT JOIN contacts c ON a.contact_id = c.id
      LEFT JOIN accounts acc ON d.account_id = acc.id
      WHERE a.id = $1 AND a.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }
    
    const row = result.rows[0];
    res.json({
      action: {
        id: row.id,
        type: row.type,
        priority: row.priority,
        title: row.title,
        description: row.description,
        context: row.context,
        dueDate: row.due_date,
        completed: row.completed,
        deal: row.deal_id ? {
          id: row.deal_id,
          name: row.deal_name,
          value: parseFloat(row.deal_value),
          stage: row.deal_stage,
          account: row.account_name
        } : null,
        contact: row.contact_id ? {
          id: row.contact_id,
          firstName: row.contact_first_name,
          lastName: row.contact_last_name
        } : null
      }
    });
  } catch (error) {
    console.error('Get action error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch action' } });
  }
});

// Create new action
router.post('/', async (req, res) => {
  try {
    const { dealId, contactId, type, priority, title, description, context, dueDate } = req.body;
    
    const result = await db.query(
      `INSERT INTO actions (user_id, deal_id, contact_id, type, priority, title, description, context, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.userId, dealId, contactId, type, priority || 'medium', title, description, context, dueDate]
    );
    
    res.status(201).json({ action: result.rows[0] });
  } catch (error) {
    console.error('Create action error:', error);
    res.status(500).json({ error: { message: 'Failed to create action' } });
  }
});

// Update action
router.put('/:id', async (req, res) => {
  try {
    const { priority, title, description, context, dueDate, completed } = req.body;
    
    const result = await db.query(
      `UPDATE actions 
       SET priority = COALESCE($1, priority),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           context = COALESCE($4, context),
           due_date = COALESCE($5, due_date),
           completed = COALESCE($6, completed),
           completed_at = CASE WHEN $6 = true THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [priority, title, description, context, dueDate, completed, req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }
    
    res.json({ action: result.rows[0] });
  } catch (error) {
    console.error('Update action error:', error);
    res.status(500).json({ error: { message: 'Failed to update action' } });
  }
});

// Delete action
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM actions WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }
    
    res.json({ message: 'Action deleted successfully' });
  } catch (error) {
    console.error('Delete action error:', error);
    res.status(500).json({ error: { message: 'Failed to delete action' } });
  }
});

// Mark action as completed
router.patch('/:id/complete', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE actions 
       SET completed = true, 
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Action not found' } });
    }
    
    res.json({ action: result.rows[0] });
  } catch (error) {
    console.error('Complete action error:', error);
    res.status(500).json({ error: { message: 'Failed to complete action' } });
  }
});

// ========== NEW: ACTION CONFIGURATION ENDPOINTS ==========

// Get user's action configuration
router.get('/config', async (req, res) => {
  try {
    console.log('📋 GET /config called for user:', req.user.userId);
    
    if (!req.user || !req.user.userId) {
      console.error('❌ No user ID in request');
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    
    console.log('📋 Fetching config from ActionConfigService...');
    const config = await ActionConfigService.getConfig(req.user.userId);
    
    console.log('✅ Config fetched successfully:', config ? 'Found' : 'Not found');
    res.json({ config });
  } catch (error) {
    console.error('❌ Get action config error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: { 
        message: 'Failed to fetch config',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      } 
    });
  }
});

// Update user's action configuration
router.put('/config', async (req, res) => {
  try {
    const config = await ActionConfigService.updateConfig(req.user.userId, req.body);
    res.json({ config });
  } catch (error) {
    console.error('Update action config error:', error);
    res.status(500).json({ error: { message: 'Failed to update config' } });
  }
});

// Get suggestions for an action
router.get('/:id/suggestions', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM action_suggestions 
       WHERE action_id = $1 AND user_id = $2 AND status = 'pending'
       ORDER BY confidence DESC`,
      [req.params.id, req.user.userId]
    );
    res.json({ suggestions: result.rows });
  } catch (error) {
    console.error('Get suggestions error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch suggestions' } });
  }
});

// Accept a suggestion (mark action as complete)
router.post('/suggestions/:id/accept', async (req, res) => {
  try {
    await ActionCompletionDetector.acceptSuggestion(req.params.id, req.user.userId);
    res.json({ success: true, message: 'Suggestion accepted and action completed' });
  } catch (error) {
    console.error('Accept suggestion error:', error);
    res.status(500).json({ error: { message: 'Failed to accept suggestion' } });
  }
});

// Dismiss a suggestion
router.post('/suggestions/:id/dismiss', async (req, res) => {
  try {
    await ActionCompletionDetector.dismissSuggestion(req.params.id, req.user.userId);
    res.json({ success: true, message: 'Suggestion dismissed' });
  } catch (error) {
    console.error('Dismiss suggestion error:', error);
    res.status(500).json({ error: { message: 'Failed to dismiss suggestion' } });
  }
});

module.exports = router;
