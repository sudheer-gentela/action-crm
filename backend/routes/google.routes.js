// ─────────────────────────────────────────────────────────────────────────────
// routes/google.routes.js
//
// Google OAuth flow — connect, callback, status, disconnect.
// Mirrors outlook.routes.js patterns.
// Mount in server.js: app.use('/api/google', googleRoutes);
//
// ADDED: prospecting branch in /callback
//   When state contains mode=prospecting, saves to prospecting_sender_accounts
//   instead of oauth_tokens, then redirects to /?prospecting_sender_connected=true
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { getAuthUrl, getTokenFromCode, getUserProfile } = require('../services/googleService');
const { saveUserToken, deleteUserTokens } = require('../services/tokenService');
const { pool } = require('../config/database');

/**
 * Initiate Google OAuth flow
 * GET /api/google/connect?userId=123
 */
router.get('/connect', async (req, res) => {
  try {
    const userId = req.query.userId;

    console.log('🔐 Google OAuth Connect Request:');
    console.log('   userId:', userId);

    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const state = Buffer.from(JSON.stringify({
      userId: parseInt(userId),
      timestamp: Date.now(),
    })).toString('base64');

    const authUrl = getAuthUrl(state);

    console.log('✅ Google auth URL generated');
    res.json({ success: true, authUrl });
  } catch (error) {
    console.error('❌ Error generating Google auth URL:', error);
    res.status(500).json({ success: false, error: 'Failed to generate authorization URL', message: error.message });
  }
});

/**
 * OAuth callback
 * GET /api/google/callback
 *
 * Handles two modes:
 *   1. Standard (no mode in state)  → saves to oauth_tokens, redirects /?google_connected=true
 *   2. Prospecting (mode=prospecting in state) → saves to prospecting_sender_accounts,
 *      redirects /?prospecting_sender_connected=true
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://action-crm.vercel.app';

    console.log('📥 Google OAuth Callback received');

    if (oauthError) {
      console.error('❌ Google OAuth error:', oauthError);
      return res.redirect(`${frontendUrl}/?error=${oauthError}`);
    }

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/?error=missing_params`);
    }

    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (err) {
      return res.redirect(`${frontendUrl}/?error=invalid_state`);
    }

    const userId = stateData.userId;
    if (!userId) {
      return res.redirect(`${frontendUrl}/?error=invalid_state`);
    }

    console.log('🔄 Processing Google OAuth for user:', userId, '| mode:', stateData.mode || 'standard');

    const tokenResponse = await getTokenFromCode(code);
    console.log('✅ Google token exchange successful');

    // ── Prospecting mode ───────────────────────────────────────────────────────
    if (stateData.mode === 'prospecting') {
      const orgId = stateData.orgId;
      if (!orgId) {
        return res.redirect(`${frontendUrl}/?error=missing_org_id`);
      }

      // Get the email address from the token profile
      const profile = await getUserProfile(userId);
      const email   = profile.email;

      if (!email) {
        return res.redirect(`${frontendUrl}/?error=no_email_in_profile`);
      }

      console.log('📧 Saving prospecting sender account:', email, 'for user', userId);

      // Upsert: if this email was previously connected for prospecting, refresh tokens
      await pool.query(
        `INSERT INTO prospecting_sender_accounts
           (org_id, user_id, provider, email, label, access_token, refresh_token,
            expires_at, account_data, is_active, updated_at)
         VALUES ($1, $2, 'gmail', $3, $4, $5, $6, $7, $8, true, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, email) DO UPDATE
           SET access_token  = EXCLUDED.access_token,
               refresh_token = COALESCE(EXCLUDED.refresh_token, prospecting_sender_accounts.refresh_token),
               expires_at    = EXCLUDED.expires_at,
               account_data  = EXCLUDED.account_data,
               is_active     = true,
               label         = COALESCE(EXCLUDED.label, prospecting_sender_accounts.label),
               updated_at    = CURRENT_TIMESTAMP`,
        [
          orgId,
          userId,
          email,
          stateData.label || null,
          tokenResponse.access_token,
          tokenResponse.refresh_token || null,
          tokenResponse.expiry_date ? new Date(tokenResponse.expiry_date) : null,
          JSON.stringify({ email, scope: tokenResponse.scope || null }),
        ]
      );

      console.log('✅ Prospecting sender account saved for:', email);
      return res.redirect(`${frontendUrl}/?prospecting_sender_connected=true`);
    }

    // ── Standard mode ──────────────────────────────────────────────────────────
    await saveUserToken(userId, 'google', tokenResponse);
    console.log('✅ Google tokens saved');

    // Get profile
    const profile = await getUserProfile(userId);
    console.log('✅ Google profile retrieved:', profile.email);

    // Ensure gmail columns exist, then update — graceful if columns not yet added
    try {
      await pool.query(
        `UPDATE users SET gmail_connected = true, gmail_email = $1, updated_at = NOW() WHERE id = $2`,
        [profile.email, userId]
      );
    } catch (colErr) {
      // gmail_connected / gmail_email columns may not exist yet — add them
      console.warn('⚠️  Adding gmail columns to users table...');
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_connected BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_email VARCHAR(255)`);
      await pool.query(
        `UPDATE users SET gmail_connected = true, gmail_email = $1, updated_at = NOW() WHERE id = $2`,
        [profile.email, userId]
      );
    }

    console.log('✅ User record updated');
    res.redirect(`${frontendUrl}/?google_connected=true`);
  } catch (error) {
    console.error('❌ Error in Google OAuth callback:', error);
    const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'https://action-crm.vercel.app';
    res.redirect(`${frontendUrl}/?error=google_auth_failed&message=${encodeURIComponent(error.message)}`);
  }
});

/**
 * Get connection status
 * GET /api/google/status?userId=123
 */
router.get('/status', async (req, res) => {
  try {
    const userId = req.query.userId;

    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.json({ success: true, connected: false, email: null });
    }

    // Try to read gmail columns — graceful if they don't exist
    let result;
    try {
      result = await pool.query(
        `SELECT gmail_connected, gmail_email FROM users WHERE id = $1`,
        [userId]
      );
    } catch (e) {
      // Columns don't exist yet
      return res.json({ success: true, connected: false, email: null });
    }

    if (result.rows.length === 0) {
      return res.json({ success: true, connected: false, email: null });
    }

    const user = result.rows[0];
    res.json({
      success:   true,
      connected: user.gmail_connected || false,
      email:     user.gmail_email || null,
    });
  } catch (error) {
    console.error('❌ Error checking Google status:', error);
    res.json({ success: true, connected: false, email: null });
  }
});

/**
 * Disconnect Google
 * POST /api/google/disconnect
 */
router.post('/disconnect', async (req, res) => {
  try {
    const userId = req.body.userId;

    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    console.log('🗑️  Disconnecting Google for user:', userId);

    await deleteUserTokens(userId, 'google');

    try {
      await pool.query(
        `UPDATE users SET gmail_connected = false, gmail_email = NULL, updated_at = NOW() WHERE id = $1`,
        [userId]
      );
    } catch (e) {
      // columns may not exist
    }

    console.log('✅ Google disconnected successfully');
    res.json({ success: true, message: 'Google disconnected successfully' });
  } catch (error) {
    console.error('❌ Error disconnecting Google:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect Google' });
  }
});

module.exports = router;
