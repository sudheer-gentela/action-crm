const express = require('express');
const router = express.Router();
const { getAuthUrl, getTokenFromCode, getUserProfile } = require('../services/outlookService');
const { saveUserToken, deleteUserTokens } = require('../services/tokenService');
const { db } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');

/**
 * Initiate Outlook OAuth flow
 * GET /api/outlook/connect
 */
router.get('/connect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // Now guaranteed to exist from authenticateToken
    
    const state = Buffer.from(JSON.stringify({
      userId: userId,
      timestamp: Date.now()
    })).toString('base64');
    
    const authUrl = await getAuthUrl(state);
    
    res.json({ 
      success: true,
      authUrl 
    });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate authorization URL' 
    });
  }
});

/**
 * OAuth callback endpoint
 * GET /api/outlook/callback
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/?error=no_code`);
    }
    
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;
    
    if (!userId) {
      return res.redirect(`${process.env.FRONTEND_URL}/?error=invalid_state`);
    }
    
    const tokenResponse = await getTokenFromCode(code);
    await saveUserToken(userId, 'outlook', tokenResponse);
    
    const profile = await getUserProfile(userId);
    
    await db.query(
      `UPDATE users 
       SET outlook_email = $1, outlook_connected = true, updated_at = NOW()
       WHERE id = $2`,
      [profile.mail || profile.userPrincipalName, userId]
    );
    
    res.redirect(`${process.env.FRONTEND_URL}/?outlook_connected=true`);
  } catch (error) {
    console.error('Error in OAuth callback:', error);
    res.redirect(`${process.env.FRONTEND_URL}/?error=auth_failed`);
  }
});

/**
 * Get connection status
 * GET /api/outlook/status
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // Now guaranteed to exist from authenticateToken
    
    const result = await db.query(
      `SELECT outlook_connected, outlook_email FROM users WHERE id = $1`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }
    
    const user = result.rows[0];
    
    res.json({
      success: true,
      connected: user.outlook_connected || false,
      email: user.outlook_email || null
    });
  } catch (error) {
    console.error('Error checking status:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to check connection status' 
    });
  }
});

/**
 * Disconnect Outlook
 * POST /api/outlook/disconnect
 */
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // Now guaranteed to exist from authenticateToken
    
    await deleteUserTokens(userId, 'outlook');
    
    await db.query(
      `UPDATE users 
       SET outlook_connected = false, outlook_email = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    
    res.json({ 
      success: true,
      message: 'Outlook disconnected successfully' 
    });
  } catch (error) {
    console.error('Error disconnecting:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to disconnect Outlook' 
    });
  }
});

module.exports = router;
