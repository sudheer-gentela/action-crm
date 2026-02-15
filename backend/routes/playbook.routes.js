/**
 * Playbook API Routes
 * Allows users to view and edit their sales playbook via UI
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get user's playbook (or default)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Try to load user-specific playbook from database
    const userPlaybookResult = await db.query(
      'SELECT playbook_data FROM user_playbooks WHERE user_id = $1',
      [userId]
    );

    let playbook;
    
    if (userPlaybookResult.rows.length > 0) {
      // User has customized playbook
      playbook = userPlaybookResult.rows[0].playbook_data;
    } else {
      // Load default playbook
      const SALES_PLAYBOOK = require('../config/salesPlaybook');
      playbook = SALES_PLAYBOOK;
    }

    res.json({
      success: true,
      playbook
    });

  } catch (error) {
    console.error('Error loading playbook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Save user's playbook
router.put('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { playbook } = req.body;

    if (!playbook) {
      return res.status(400).json({
        success: false,
        error: 'Playbook data is required'
      });
    }

    // Upsert user's playbook
    await db.query(
      `INSERT INTO user_playbooks (user_id, playbook_data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET playbook_data = $2, updated_at = NOW()`,
      [userId, JSON.stringify(playbook)]
    );

    res.json({
      success: true,
      message: 'Playbook saved successfully'
    });

  } catch (error) {
    console.error('Error saving playbook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Reset to default playbook
router.post('/reset', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    await db.query(
      'DELETE FROM user_playbooks WHERE user_id = $1',
      [userId]
    );

    const SALES_PLAYBOOK = require('../config/salesPlaybook');

    res.json({
      success: true,
      playbook: SALES_PLAYBOOK,
      message: 'Playbook reset to default'
    });

  } catch (error) {
    console.error('Error resetting playbook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
