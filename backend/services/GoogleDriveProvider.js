/**
 * GoogleDriveProvider.js
 * Google Drive implementation of StorageProviderBase.
 * Token storage uses oauth_tokens table with provider = 'googledrive'.
 * Stays dormant until uncommented in StorageProviderFactory.js.
 */

const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
const StorageProviderBase  = require('./StorageProviderBase');
const { resolveCategory, assertSizeAllowed, extractTextFromBuffer } = require('./contentExtractor');
const { getTokenByUserId, saveUserToken } = require('./tokenService');

const GOOGLE_PROVIDER = 'googledrive';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

const GOOGLE_NATIVE_EXPORT_MAP = {
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

class GoogleDriveProvider extends StorageProviderBase {
  constructor() {
    super('googledrive', 'Google Drive');
  }

  async checkConnection(userId) {
    try {
      const accessToken = await this._getAccessToken(userId);
      await axios.get(`${DRIVE_BASE}/about`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { fields: 'user' },
      });
      return { connected: true, message: 'Google Drive connected.' };
    } catch (err) {
      if (err.message && err.message.includes('No tokens found')) {
        return { connected: false, requiresReauth: false, message: 'Google Drive not connected.', reauthUrl: '/api/auth/google' };
      }
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        return { connected: false, requiresReauth: true, message: 'Google Drive access expired. Please reconnect.', reauthUrl: '/api/auth/google' };
      }
      return { connected: false, message: err.message };
    }
  }

  getAuthUrl() { return '/api/auth/google'; }

  async listFiles(userId, folderId = null) {
    const accessToken = await this._getAccessToken(userId);
    const parentQuery = folderId ? `'${folderId}' in parents` : `'root' in parents`;
    const response = await axios.get(`${DRIVE_BASE}/files`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: `${parentQuery} and trashed = false`,
        fields: 'files(id,name,size,modifiedTime,mimeType,parents,webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
      },
    });
    return response.data.files.map((item) => this._normalize(item));
  }

  async searchFiles(userId, query) {
    const accessToken = await this._getAccessToken(userId);
    const response = await axios.get(`${DRIVE_BASE}/files`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id,name,size,modifiedTime,mimeType,parents,webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 50,
      },
    });
    return response.data.files
      .filter((item) => item.mimeType !== 'application/vnd.google-apps.folder')
      .map((item) => this._normalize(item));
  }

  async getFileMetadata(userId, fileId) {
    const accessToken = await this._getAccessToken(userId);
    const response = await axios.get(`${DRIVE_BASE}/files/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: 'id,name,size,modifiedTime,mimeType,parents,webViewLink' },
    });
    return this._normalize(response.data);
  }

  async extractFileContent(userId, fileId) {
    const meta = await this.getFileMetadata(userId, fileId);
    const accessToken = await this._getAccessToken(userId);
    const isGoogleNative = !!GOOGLE_NATIVE_EXPORT_MAP[meta.mimeType];
    const effectiveMimeType = isGoogleNative ? GOOGLE_NATIVE_EXPORT_MAP[meta.mimeType] : meta.mimeType;

    if (!isGoogleNative) assertSizeAllowed(meta.size, meta.name);

    const downloadUrl = isGoogleNative
      ? `${DRIVE_BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(effectiveMimeType)}`
      : `${DRIVE_BASE}/files/${fileId}?alt=media`;

    const downloadResponse = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(downloadResponse.data);
    if (isGoogleNative) assertSizeAllowed(buffer.length, meta.name);

    const rawText = await extractTextFromBuffer(buffer, effectiveMimeType, meta.name);

    return {
      fileId: meta.id, fileName: meta.name, fileType: effectiveMimeType,
      category: meta.category, rawText, characterCount: rawText.length,
      provider: this.providerId,
      fileRef: {
        provider: this.providerId, provider_file_id: meta.id,
        web_url: meta.webViewLink, file_name: meta.name,
        file_size: meta.size || buffer.length, mime_type: meta.mimeType,
        category: meta.category, last_modified_at: meta.lastModified,
      },
      metadata: {
        size: meta.size || buffer.length, lastModified: meta.lastModified,
        parentFolder: meta.parentFolder, wasExported: isGoogleNative,
      },
    };
  }

  async _getAccessToken(userId) {
    const tokenData = await getTokenByUserId(userId, GOOGLE_PROVIDER);
    const expiresAt = new Date(tokenData.expires_at);
    if (new Date() < expiresAt) return tokenData.access_token;

    if (!tokenData.refresh_token) {
      throw new Error('Google Drive token expired and no refresh token available. Please reconnect.');
    }

    const oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expiry_date: expiresAt.getTime(),
    });

    const { token: newAccessToken, res } = await oauth2Client.getAccessToken();
    await saveUserToken(userId, GOOGLE_PROVIDER, {
      accessToken: newAccessToken,
      refreshToken: tokenData.refresh_token,
      expiresOn: res && res.data && res.data.expiry_date
        ? new Date(res.data.expiry_date)
        : new Date(Date.now() + 3600000),
      account: tokenData.account_data || {},
    });
    return newAccessToken;
  }

  _normalize(item) {
    const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
    return {
      id: item.id, name: item.name, size: parseInt(item.size, 10) || 0,
      lastModified: item.modifiedTime, mimeType: isFolder ? null : item.mimeType,
      isFolder, childCount: 0, parentFolder: null,
      webViewLink: item.webViewLink || null,
      category: isFolder ? 'folder' : resolveCategory(item.mimeType),
      provider: this.providerId,
      isGoogleNative: !!GOOGLE_NATIVE_EXPORT_MAP[item.mimeType],
    };
  }
}

module.exports = GoogleDriveProvider;
