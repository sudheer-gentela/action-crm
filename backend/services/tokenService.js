const { pool } = require('../config/database');
const { ConfidentialClientApplication } = require('@azure/msal-node');

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
 * Refresh expired token
 */
async function refreshUserToken(userId, provider) {
  const currentToken = await getTokenByUserId(userId, provider);
  
  if (!currentToken.refresh_token) {
    console.error('❌ No refresh token available for user:', userId);
    throw new Error('No refresh token available. Please reconnect your Outlook account.');
  }
  
  try {
    console.log('🔄 Refreshing token for user:', userId);
    
    const refreshRequest = {
      refreshToken: currentToken.refresh_token,
      scopes: [
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/Calendars.Read',  // ✅ Include calendar scope
        'https://graph.microsoft.com/User.Read',
        'offline_access'
      ]
    };
    
    const response = await cca.acquireTokenByRefreshToken(refreshRequest);
    console.log('✅ Token refreshed successfully');
    
    // Save new tokens (preserve refresh token if new one not provided)
    const newTokenData = {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken || currentToken.refresh_token,
      expiresOn: response.expiresOn,
      account: response.account
    };
    
    await saveUserToken(userId, provider, newTokenData);
    
    return await getTokenByUserId(userId, provider);
  } catch (error) {
    console.error('❌ Token refresh error:', error);
    
    // If refresh fails, the token is invalid - user needs to reconnect
    if (error.errorCode === 'invalid_grant' || error.message.includes('AADSTS')) {
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
