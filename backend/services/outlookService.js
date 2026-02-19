const { Client } = require('@microsoft/microsoft-graph-client');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios = require('axios');
const { getTokenByUserId, saveUserToken, refreshUserToken } = require('./tokenService');

const msalConfig = {
  auth: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  }
};

const cca = new ConfidentialClientApplication(msalConfig);

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
  'https://graph.microsoft.com/Files.Read',
];

/**
 * Get authorization URL for OAuth flow
 */
async function getAuthUrl(state) {
  const authCodeUrlParameters = {
    scopes: SCOPES,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    state: state,
    prompt: 'consent',
    responseMode: 'query',
    responseType: 'code'
  };
  return await cca.getAuthCodeUrl(authCodeUrlParameters);
}

/**
 * Exchange authorization code for tokens.
 * Uses direct HTTP POST to Microsoft's token endpoint instead of MSAL,
 * because MSAL's acquireTokenByCode() does not expose the refresh_token
 * in its response object — it only caches it internally.
 * Calling the endpoint directly gives us the refresh_token in plain JSON.
 */
async function getTokenFromCode(code) {
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    code:          code,
    redirect_uri:  process.env.MICROSOFT_REDIRECT_URI,
    grant_type:    'authorization_code',
    scope:         SCOPES.join(' '),
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const data = response.data;

  console.log('🔑 Direct token exchange — refresh_token present:', !!data.refresh_token);

  // Return in the same shape saveUserToken expects
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,   // ← this is what MSAL was hiding
    expiresOn:    new Date(Date.now() + data.expires_in * 1000),
    account:      null,
  };
}

/**
 * Get Microsoft Graph client for user
 */
async function getGraphClient(userId) {
  let tokenData = await getTokenByUserId(userId, 'outlook');
  
  // Check if token is expired
  const expiresAt = new Date(tokenData.expires_at);
  const now = new Date();
  
  if (now >= expiresAt) {
    // Refresh token
    tokenData = await refreshUserToken(userId, 'outlook');
  }
  
  return Client.init({
    authProvider: (done) => {
      done(null, tokenData.access_token);
    }
  });
}

/**
 * Fetch recent emails from Outlook
 */
async function fetchEmails(userId, options = {}) {
  try {
    const client = await getGraphClient(userId);
    
    const {
      top = 50,
      skip = 0,
      orderBy = 'receivedDateTime DESC',
      filter = null,
      since = null
    } = options;
    
    let query = client
      .api('/me/messages')
      .select([
        'id',
        'subject',
        'from',
        'toRecipients',
        'ccRecipients',
        'receivedDateTime',
        'bodyPreview',
        'body',
        'importance',
        'hasAttachments',
        'conversationId',
        'isRead',
        'categories'
      ].join(','))
      .top(top)
      .skip(skip)
      .orderby(orderBy);
    
    // Apply filters
    if (since) {
      const filterDate = new Date(since).toISOString();
      query = query.filter(`receivedDateTime gt ${filterDate}`);
    }
    
    if (filter) {
      query = query.filter(filter);
    }
    
    const result = await query.get();
    
    return {
      emails: result.value,
      hasMore: result['@odata.nextLink'] != null,
      nextLink: result['@odata.nextLink']
    };
  } catch (error) {
    console.error('Error fetching emails:', error);
    throw new Error(`Failed to fetch emails: ${error.message}`);
  }
}

/**
 * Fetch single email by ID
 */
async function fetchEmailById(userId, emailId) {
  try {
    const client = await getGraphClient(userId);
    
    const email = await client
      .api(`/me/messages/${emailId}`)
      .select([
        'id',
        'subject',
        'from',
        'toRecipients',
        'ccRecipients',
        'receivedDateTime',
        'body',
        'importance',
        'hasAttachments',
        'conversationId',
        'isRead',
        'categories'
      ].join(','))
      .get();
    
    return email;
  } catch (error) {
    console.error('Error fetching email by ID:', error);
    throw new Error(`Failed to fetch email: ${error.message}`);
  }
}

/**
 * Get user profile info
 */
async function getUserProfile(userId) {
  try {
    const client = await getGraphClient(userId);
    
    const profile = await client
      .api('/me')
      .select('id,displayName,mail,userPrincipalName')
      .get();
    
    return profile;
  } catch (error) {
    console.error('Error fetching user profile:', error);
    throw new Error(`Failed to fetch user profile: ${error.message}`);
  }
}

module.exports = {
  getAuthUrl,
  getTokenFromCode,
  fetchEmails,
  fetchEmailById,
  getUserProfile,
  SCOPES
};
