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
const { getTokenByUserId, saveUserToken } = require('./oauthTokenService');

const GOOGLE_PROVIDER = 'google';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

// Drive v3 defaults to My Drive only. Every file-level call needs
// supportsAllDrives; every listing also needs includeItemsFromAllDrives.
// Omitting them does not error — it silently returns nothing, or 404s on an
// item that plainly exists, which is the worst shape a bug can take.
const SHARED_DRIVE_PARAMS = { supportsAllDrives: true, includeItemsFromAllDrives: true };

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
        fields: 'files(id,name,size,modifiedTime,mimeType,parents,webViewLink,driveId)',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        // Without these three, every call here is scoped to the caller's My
        // Drive and a Shared Drive is invisible — which matters because a
        // Shared Drive is the right home for project folders: the drive owns
        // the files, so they survive the uploader leaving the company.
        ...SHARED_DRIVE_PARAMS,
        corpora: 'allDrives',
      },
    });
    return response.data.files.map((item) => this._normalize(item));
  }

  /**
   * Shared Drives the caller can see, shaped like folders so the picker can
   * navigate into them.
   *
   * They are NOT files and never appear in a files.list, so without this a user
   * cannot reach a Shared Drive folder at all — and therefore cannot map one to
   * a project.
   */
  async listSharedDrives(userId) {
    const accessToken = await this._getAccessToken(userId);
    try {
      const res = await axios.get(`${DRIVE_BASE}/drives`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { pageSize: 100, fields: 'drives(id,name)' },
      });
      return (res.data.drives || []).map(d => ({
        id: d.id, name: d.name, size: 0, mimeType: 'application/vnd.google-apps.folder',
        category: 'folder', isFolder: true, childCount: 0,
        parentFolder: null, parentFolderId: null,
        modifiedTime: null, lastModified: null, webViewLink: null,
        isSharedDrive: true,
      }));
    } catch (err) {
      // A user with no Shared Drives, or a personal account, is not an error.
      console.warn('[GoogleDrive] Could not list shared drives:', err.message);
      return [];
    }
  }

  async searchFiles(userId, query) {
    const accessToken = await this._getAccessToken(userId);
    const response = await axios.get(`${DRIVE_BASE}/files`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id,name,size,modifiedTime,mimeType,parents,webViewLink,driveId)',
        orderBy: 'modifiedTime desc',
        pageSize: 50,
        ...SHARED_DRIVE_PARAMS,
        corpora: 'allDrives',
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
      params: { fields: 'id,name,size,modifiedTime,mimeType,parents,webViewLink,driveId',
                ...SHARED_DRIVE_PARAMS },
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
      params: SHARED_DRIVE_PARAMS,
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
        parent_folder_id: meta.parentFolderId || null,
      },
      metadata: {
        size: meta.size || buffer.length, lastModified: meta.lastModified,
        parentFolder: meta.parentFolder, wasExported: isGoogleNative,
      },
    };
  }

  /**
   * One step up the folder tree. The generic walk that builds
   * storage_files.folder_path lives in storageFileService so the loop is not
   * written twice — a provider only has to answer "who is this item's parent".
   * Returns null at the root, or when the caller cannot see the parent.
   */
  async getParentFolderId(userId, itemId) {
    const accessToken = await this._getAccessToken(userId);
    try {
      const res = await axios.get(`${DRIVE_BASE}/files/${itemId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        // Without supportsAllDrives this 404s on a Shared Drive item, the walk
        // stops, folder_path stays null, and folder mapping silently never
        // matches. A quiet failure, which is why it is called out here.
        params: { fields: 'parents', ...SHARED_DRIVE_PARAMS },
      });
      return (res.data && res.data.parents && res.data.parents[0]) || null;
    } catch (err) {
      if (err.response && [401, 403, 404].includes(err.response.status)) return null;
      throw err;
    }
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
      // Present when the item lives in a Shared Drive rather than My Drive.
      driveId: item.driveId || null,
      // Drive already returns `parents` in every fields= list below; it was
      // being discarded here. Surfacing it populates storage_files.folder_id at
      // import with no extra API call.
      parentFolderId: (item.parents && item.parents[0]) || null,
      webViewLink: item.webViewLink || null,
      category: isFolder ? 'folder' : resolveCategory(item.mimeType),
      provider: this.providerId,
      isGoogleNative: !!GOOGLE_NATIVE_EXPORT_MAP[item.mimeType],
    };
  }
}

module.exports = GoogleDriveProvider;
