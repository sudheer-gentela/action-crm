/**
 * Prompts API Routes
 * Allows users to view and edit their AI prompt templates via UI
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

// Get user's prompts (or defaults)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Load default prompts
    const AI_PROMPTS = require('../config/aiPrompts');
    
    // Try to load user-specific prompts from database
    const userPromptsResult = await db.query(
      'SELECT template_type, template_data FROM user_prompts WHERE user_id = $1',
      [userId]
    );

    // Start with defaults
    const prompts = {
      email_analysis: AI_PROMPTS.email_analysis,
      deal_health_check: AI_PROMPTS.deal_health_check
    };
    
    // Override with user customizations if they exist
    userPromptsResult.rows.forEach(row => {
      if (row.template_type === 'email_analysis' || row.template_type === 'deal_health_check') {
        prompts[row.template_type] = row.template_data;
      }
    });

    res.json({
      success: true,
      prompts
    });

  } catch (error) {
    console.error('Error loading prompts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Save user's prompts
router.put('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { prompts } = req.body;

    if (!prompts) {
      return res.status(400).json({
        success: false,
        error: 'Prompts data is required'
      });
    }

    // Save each prompt template
    const templateTypes = ['email_analysis', 'deal_health_check'];
    
    for (const templateType of templateTypes) {
      if (prompts[templateType]) {
        await db.query(
          `INSERT INTO user_prompts (user_id, template_type, template_data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, template_type) 
           DO UPDATE SET template_data = $3, updated_at = NOW()`,
          [userId, templateType, prompts[templateType]]
        );
      }
    }

    res.json({
      success: true,
      message: 'Prompts saved successfully'
    });

  } catch (error) {
    console.error('Error saving prompts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Reset to default prompts
router.post('/reset', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Delete user's custom prompts
    await db.query(
      'DELETE FROM user_prompts WHERE user_id = $1',
      [userId]
    );

    // Load defaults
    const AI_PROMPTS = require('../config/aiPrompts');

    res.json({
      success: true,
      prompts: {
        email_analysis: AI_PROMPTS.email_analysis,
        deal_health_check: AI_PROMPTS.deal_health_check
      },
      message: 'Prompts reset to defaults'
    });

  } catch (error) {
    console.error('Error resetting prompts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
