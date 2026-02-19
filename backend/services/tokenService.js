const { pool } = require('../config/database');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  }
};

const cca = new ConfidentialClientApplication(msalConfig);

/**
 * Save OAuth tokens to database
 */
async function saveUserToken(userId, provider, tokenData) {
  console.log('💾 Saving tokens for user:', userId);
  console.log('📝 Token data keys:', Object.keys(tokenData));
  console.log('📝 Full token structure:', JSON.stringify(tokenData, null, 2));
  
  const query = `
    INSERT INTO oauth_tokens (
      user_id, provider, access_token, refresh_token, 
      expires_at, account_data, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (user_id, provider) 
    DO UPDATE SET
      access_token = $3,
      refresh_token = COALESCE($4, oauth_tokens.refresh_token),
      expires_at = $5,
      account_data = $6,
      updated_at = NOW()
    RETURNING *
  `;
  
  const expiresAt = new Date(tokenData.expiresOn || Date.now() + 3600000);
  
  // Extract refresh token - check multiple possible locations
  const refreshToken = tokenData.refreshToken || 
                       tokenData.refresh_token || 
                       tokenData.account?.idTokenClaims?.refresh_token || 
                       null;
  
  console.log('🔑 Access token:', tokenData.accessToken ? 'Present ✓' : 'Missing ✗');
  console.log('🔄 Refresh token:', refreshToken ? 'Present ✓' : 'Missing ✗');
  console.log('⏰ Expires at:', expiresAt);
  
  if (!refreshToken) {
    console.error('❌ WARNING: No refresh token found in response!');
    console.error('❌ This means token will expire and user will need to reconnect');
    console.error('❌ Token response structure:', JSON.stringify(tokenData, null, 2));
  }
  
  const values = [
    userId,
    provider,
    tokenData.accessToken,
    refreshToken,
    expiresAt,
    JSON.stringify(tokenData.account || {})
  ];
  
  const result = await pool.query(query, values);
  
  if (result.rows[0].refresh_token) {
    console.log('✅ SUCCESS: Refresh token saved to database');
  } else {
    console.log('❌ FAILED: No refresh token in database');
  }
  
  return result.rows[0];
}

/**
 * Get token by user ID and provider
 */
async function getTokenByUserId(userId, provider) {
  const query = `
    SELECT * FROM oauth_tokens 
    WHERE user_id = $1 AND provider = $2
  `;
  
  const result = await pool.query(query, [userId, provider]);
  
  if (result.rows.length === 0) {
    throw new Error('No tokens found for user. Please reconnect your Outlook account.');
  }
  
  const token = result.rows[0];
  console.log('🔍 Retrieved token for user:', userId);
  console.log('🔄 Has refresh token:', token.refresh_token ? 'Yes' : 'No');
  
  return token;
}

/**
 * Refresh expired token.
 * Uses direct HTTP POST instead of MSAL acquireTokenByRefreshToken,
 * because MSAL does not reliably expose the new refresh_token in its response.
 */
async function refreshUserToken(userId, provider) {
  const currentToken = await getTokenByUserId(userId, provider);

  if (!currentToken.refresh_token) {
    console.error('❌ No refresh token available for user:', userId);
    throw new Error('No refresh token available. Please reconnect your Outlook account.');
  }

  try {
    console.log('🔄 Refreshing token for user:', userId);

    const tenantId = process.env.MICROSOFT_TENANT_ID;
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const scopes = [
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Calendars.Read',
      'https://graph.microsoft.com/User.Read',
      'https://graph.microsoft.com/Files.Read',
      'offline_access',
    ].join(' ');

    const params = new URLSearchParams({
      client_id:     process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: currentToken.refresh_token,
      grant_type:    'refresh_token',
      scope:         scopes,
    });

    const response = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data;
    console.log('✅ Token refreshed successfully');
    console.log('🔄 New refresh_token present:', !!data.refresh_token);

    const newTokenData = {
      accessToken:  data.access_token,
      // Microsoft may rotate the refresh token; preserve the old one if no new one returned
      refreshToken: data.refresh_token || currentToken.refresh_token,
      expiresOn:    new Date(Date.now() + data.expires_in * 1000),
      account:      null,
    };

    await saveUserToken(userId, provider, newTokenData);
    return await getTokenByUserId(userId, provider);

  } catch (error) {
    console.error('❌ Token refresh error:', error.response?.data || error.message);

    const errData = error.response?.data || {};
    if (errData.error === 'invalid_grant' || (error.message && error.message.includes('AADSTS'))) {
      throw new Error('Token expired. Please reconnect your Outlook account.');
    }

    throw new Error(`Failed to refresh token: ${error.message}`);
  }
}

/**
 * Delete user tokens
 */
async function deleteUserTokens(userId, provider) {
  const query = `
    DELETE FROM oauth_tokens 
    WHERE user_id = $1 AND provider = $2
  `;
  
  await pool.query(query, [userId, provider]);
  console.log('🗑️  Tokens deleted for user:', userId);
}

module.exports = {
  saveUserToken,
  getTokenByUserId,
  refreshUserToken,
  deleteUserTokens
};
