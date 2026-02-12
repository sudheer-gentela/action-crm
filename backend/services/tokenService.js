const { db } = require('../config/database');
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
  const query = `
    INSERT INTO oauth_tokens (
      user_id, provider, access_token, refresh_token, 
      expires_at, account_data, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (user_id, provider) 
    DO UPDATE SET
      access_token = $3,
      refresh_token = $4,
      expires_at = $5,
      account_data = $6,
      updated_at = NOW()
    RETURNING *
  `;
  
  const expiresAt = new Date(tokenData.expiresOn || Date.now() + 3600000);
  
  const values = [
    userId,
    provider,
    tokenData.accessToken,
    tokenData.refreshToken || null,
    expiresAt,
    JSON.stringify(tokenData.account || {})
  ];
  
  const result = await db.query(query, values);
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
  
  const result = await db.query(query, [userId, provider]);
  
  if (result.rows.length === 0) {
    throw new Error('No tokens found for user');
  }
  
  return result.rows[0];
}

/**
 * Refresh expired token
 */
async function refreshUserToken(userId, provider) {
  const currentToken = await getTokenByUserId(userId, provider);
  
  if (!currentToken.refresh_token) {
    throw new Error('No refresh token available');
  }
  
  try {
    const refreshRequest = {
      refreshToken: currentToken.refresh_token,
      scopes: [
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/User.Read',
        'offline_access'
      ]
    };
    
    const response = await cca.acquireTokenByRefreshToken(refreshRequest);
    
    // Save new tokens
    await saveUserToken(userId, provider, response);
    
    return await getTokenByUserId(userId, provider);
  } catch (error) {
    console.error('Token refresh error:', error);
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
  
  await db.query(query, [userId, provider]);
}

module.exports = {
  saveUserToken,
  getTokenByUserId,
  refreshUserToken,
  deleteUserTokens
};
