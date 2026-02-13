const express = require('express');
const router = express.Router();
const { getAuthUrl, getTokenFromCode, getUserProfile } = require('../services/outlookService');
const { saveUserToken, deleteUserTokens } = require('../services/tokenService');
const { pool } = require('../config/database');

/**
 * Initiate Outlook OAuth flow
 * GET /api/outlook/connect
 * NO AUTH MIDDLEWARE - uses query param userId
 */
router.get('/connect', async (req, res) => {
  try {
    // ✅ Only use query param since no auth middleware
    const userId = req.query.userId;
    
    console.log('🔐 OAuth Connect Request:');
    console.log('   userId from query:', req.query.userId);
    console.log('   Final userId:', userId);
    
    if (!userId || userId === 'undefined' || userId === 'null') {
      console.error('❌ Invalid userId:', userId);
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }
    
    console.log('✅ Starting OAuth flow for user:', userId);
    
    const state = Buffer.from(JSON.stringify({
      userId: parseInt(userId),
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
      error: 'Failed to generate authorization URL',
      message: error.message
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
    
    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://action-crm.vercel.app';
    console.log('   Frontend URL:', frontendUrl);
    
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
    
    const tokenResponse = await getTokenFromCode(code);
    console.log('✅ Token exchange successful');
    
    await saveUserToken(userId, 'outlook', tokenResponse);
    console.log('✅ Tokens saved');
    
    const profile = await getUserProfile(userId);
    console.log('✅ User profile retrieved:', profile.mail || profile.userPrincipalName);
    
    await pool.query(
      `UPDATE users 
       SET outlook_email = $1, outlook_connected = true, updated_at = NOW()
       WHERE id = $2`,
      [profile.mail || profile.userPrincipalName, userId]
    );
    console.log('✅ User record updated');
    
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
 * NO AUTH MIDDLEWARE - uses query param userId
 */
router.get('/status', async (req, res) => {
  try {
    // ✅ Only use query param since no auth middleware
    const userId = req.query.userId;
    
    console.log('📊 Status check:');
    console.log('   userId from query:', req.query.userId);
    console.log('   Final userId:', userId);
    
    // ✅ Return graceful response instead of 400 error
    if (!userId || userId === 'undefined' || userId === 'null') {
      console.log('⚠️  No valid userId, returning not connected');
      return res.json({
        success: true,
        connected: false,
        email: null
      });
    }
    
    const result = await pool.query(
      `SELECT outlook_connected, outlook_email FROM users WHERE id = $1`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      console.log('⚠️  User not found, returning not connected');
      return res.json({ 
        success: true,
        connected: false,
        email: null
      });
    }
    
    const user = result.rows[0];
    
    console.log('✅ Status check result:', {
      connected: user.outlook_connected,
      email: user.outlook_email
    });
    
    res.json({
      success: true,
      connected: user.outlook_connected || false,
      email: user.outlook_email || null
    });
  } catch (error) {
    console.error('❌ Error checking status:', error);
    // ✅ Return graceful response on error
    res.json({ 
      success: true,
      connected: false,
      email: null,
      error: error.message
    });
  }
});

/**
 * Disconnect Outlook
 * POST /api/outlook/disconnect
 * NO AUTH MIDDLEWARE - uses body param userId
 */
router.post('/disconnect', async (req, res) => {
  try {
    // ✅ Only use body param since no auth middleware
    const userId = req.body.userId;
    
    if (!userId || userId === 'undefined' || userId === 'null') {
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
