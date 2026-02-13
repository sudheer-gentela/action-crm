const express = require('express');
const router = express.Router();
const { getAuthUrl, getTokenFromCode, getUserProfile } = require('../services/outlookService');
const { saveUserToken, deleteUserTokens } = require('../services/tokenService');
const { pool } = require('../config/database');

/**
 * Initiate Outlook OAuth flow
 * GET /api/outlook/connect
 */
router.get('/connect', async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }
    
    console.log('🔐 Starting OAuth flow for user:', userId);
    
    const state = Buffer.from(JSON.stringify({
      userId: userId,
      timestamp: Date.now()
    })).toString('base64');
    
    const authUrl = await getAuthUrl(state);
    
    console.log('✅ Auth URL generated successfully');
    
    res.json({ 
      success: true,
      authUrl 
    });
  } catch (error) {
    console.error('❌ Error generating auth URL:', error);
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
    const { code, state, error: oauthError, error_description } = req.query;
    
    console.log('📥 OAuth Callback received');
    console.log('   Code:', code ? 'Present' : 'Missing');
    console.log('   State:', state ? 'Present' : 'Missing');
    console.log('   Error:', oauthError || 'None');
    
    // Get frontend URL from environment
    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://action-crm.vercel.app';
    console.log('   Frontend URL:', frontendUrl);
    
    // Handle OAuth errors
    if (oauthError) {
      console.error('❌ OAuth error:', oauthError, error_description);
      return res.redirect(`${frontendUrl}/?error=${oauthError}&message=${encodeURIComponent(error_description || 'OAuth failed')}`);
    }
    
    if (!code) {
      console.error('❌ No authorization code received');
      return res.redirect(`${frontendUrl}/?error=no_code`);
    }
    
    if (!state) {
      console.error('❌ No state parameter received');
      return res.redirect(`${frontendUrl}/?error=no_state`);
    }
    
    // Decode state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
      console.log('✅ State decoded:', stateData);
    } catch (err) {
      console.error('❌ Failed to decode state:', err);
      return res.redirect(`${frontendUrl}/?error=invalid_state`);
    }
    
    const userId = stateData.userId;
    
    if (!userId) {
      console.error('❌ No userId in state');
      return res.redirect(`${frontendUrl}/?error=invalid_state`);
    }
    
    console.log('🔄 Processing OAuth for user:', userId);
    
    // Exchange code for tokens
    const tokenResponse = await getTokenFromCode(code);
    console.log('✅ Token exchange successful');
    
    // Save tokens
    await saveUserToken(userId, 'outlook', tokenResponse);
    console.log('✅ Tokens saved');
    
    // Get user profile
    const profile = await getUserProfile(userId);
    console.log('✅ User profile retrieved:', profile.mail || profile.userPrincipalName);
    
    // Update user record
    await pool.query(
      `UPDATE users 
       SET outlook_email = $1, outlook_connected = true, updated_at = NOW()
       WHERE id = $2`,
      [profile.mail || profile.userPrincipalName, userId]
    );
    console.log('✅ User record updated');
    
    // Redirect to frontend with success
    console.log('🔀 Redirecting to:', `${frontendUrl}/?outlook_connected=true`);
    res.redirect(`${frontendUrl}/?outlook_connected=true`);
    
  } catch (error) {
    console.error('❌ Error in OAuth callback:', error);
    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://action-crm.vercel.app';
    res.redirect(`${frontendUrl}/?error=auth_failed&message=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Get connection status
 * GET /api/outlook/status
 */
router.get('/status', async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }
    
    const result = await pool.query(
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
    console.error('❌ Error checking status:', error);
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
router.post('/disconnect', async (req, res) => {
  try {
    const userId = req.user?.id || req.body.userId;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }
    
    console.log('🗑️  Disconnecting Outlook for user:', userId);
    
    await deleteUserTokens(userId, 'outlook');
    
    await pool.query(
      `UPDATE users 
       SET outlook_connected = false, outlook_email = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
    
    console.log('✅ Outlook disconnected successfully');
    
    res.json({ 
      success: true,
      message: 'Outlook disconnected successfully' 
    });
  } catch (error) {
    console.error('❌ Error disconnecting:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to disconnect Outlook' 
    });
  }
});

module.exports = router;
