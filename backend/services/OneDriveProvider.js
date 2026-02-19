/**
 * OneDriveProvider.js
 * Microsoft OneDrive implementation of StorageProviderBase.
 * Reuses existing Outlook OAuth tokens (provider = 'outlook' in oauth_tokens).
 */

const axios = require('axios');
const StorageProviderBase  = require('./StorageProviderBase');
const { resolveCategory, assertSizeAllowed, extractTextFromBuffer } = require('./contentExtractor');
const { getTokenByUserId, refreshUserToken } = require('./tokenService');

const MICROSOFT_PROVIDER = 'outlook';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

class OneDriveProvider extends StorageProviderBase {
  constructor() {
    super('onedrive', 'OneDrive');
  }

  async checkConnection(userId) {
    try {
      const accessToken = await this._getAccessToken(userId);
      await axios.get(`${GRAPH_BASE}/me/drive`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { $select: 'id' },
      });
      return { connected: true, message: 'OneDrive accessible via your Microsoft account.' };
    } catch (err) {
      if (err.message && err.message.includes('No tokens found')) {
        return {
          connected: false,
          requiresReauth: false,
          message: 'Microsoft account not connected. Please connect your Outlook account first.',
          reauthUrl: '/api/auth/outlook',
        };
      }
      if (err.response && (err.response.status === 403 || err.response.status === 401)) {
        return {
          connected: false,
          requiresReauth: true,
          message: 'OneDrive access not yet granted. Please reconnect your Microsoft account.',
          reauthUrl: '/api/auth/outlook/reauth',
        };
      }
      return { connected: false, message: err.message };
    }
  }

  getAuthUrl() {
    return '/api/auth/outlook/reauth';
  }

  async listFiles(userId, folderId = null) {
    const accessToken = await this._getAccessToken(userId);
    const url = folderId
      ? `${GRAPH_BASE}/me/drive/items/${folderId}/children`
      : `${GRAPH_BASE}/me/drive/root/children`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        $select: 'id,name,size,lastModifiedDateTime,file,folder,parentReference,webUrl',
        $top: 100,
        $orderby: 'lastModifiedDateTime desc',
      },
    });
    return response.data.value.map((item) => this._normalize(item));
  }

  async searchFiles(userId, query) {
    const accessToken = await this._getAccessToken(userId);
    const response = await axios.get(
      `${GRAPH_BASE}/me/drive/root/search(q='${encodeURIComponent(query)}')`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          $select: 'id,name,size,lastModifiedDateTime,file,folder,parentReference,webUrl',
          $top: 50,
        },
      }
    );
    return response.data.value
      .filter((item) => item.file)
      .map((item) => this._normalize(item));
  }

  async getFileMetadata(userId, fileId) {
    const accessToken = await this._getAccessToken(userId);
    const response = await axios.get(`${GRAPH_BASE}/me/drive/items/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { $select: 'id,name,size,lastModifiedDateTime,file,parentReference,webUrl' },
    });
    return this._normalize(response.data);
  }

  async extractFileContent(userId, fileId) {
    const meta = await this.getFileMetadata(userId, fileId);

    if (!meta.mimeType) {
      throw new Error(`File "${meta.name}" has no recognized MIME type.`);
    }
    assertSizeAllowed(meta.size, meta.name);

    const accessToken = await this._getAccessToken(userId);
    const downloadResponse = await axios.get(
      `${GRAPH_BASE}/me/drive/items/${fileId}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` }, responseType: 'arraybuffer' }
    );

    const buffer  = Buffer.from(downloadResponse.data);
    const rawText = await extractTextFromBuffer(buffer, meta.mimeType, meta.name);

    return {
      fileId:         meta.id,
      fileName:       meta.name,
      fileType:       meta.mimeType,
      category:       meta.category,
      rawText,
      characterCount: rawText.length,
      provider:       this.providerId,
      fileRef: {
        provider:         this.providerId,
        provider_file_id: meta.id,
        web_url:          meta.webUrl,
        file_name:        meta.name,
        file_size:        meta.size,
        mime_type:        meta.mimeType,
        category:         meta.category,
        last_modified_at: meta.lastModified,
      },
      metadata: {
        size:         meta.size,
        lastModified: meta.lastModified,
        parentFolder: meta.parentFolder,
      },
    };
  }

  async _getAccessToken(userId) {
    let tokenData = await getTokenByUserId(userId, MICROSOFT_PROVIDER);
    if (new Date() >= new Date(tokenData.expires_at)) {
      tokenData = await refreshUserToken(userId, MICROSOFT_PROVIDER);
    }
    return tokenData.access_token;
  }

  _normalize(item) {
    const mimeType = item.file ? item.file.mimeType : null;
    return {
      id:           item.id,
      name:         item.name,
      size:         item.size || 0,
      lastModified: item.lastModifiedDateTime,
      mimeType,
      isFolder:     !!item.folder,
      childCount:   (item.folder && item.folder.childCount) || 0,
      parentFolder: (item.parentReference && item.parentReference.name) || null,
      webUrl:       item.webUrl || null,
      category:     item.folder ? 'folder' : resolveCategory(mimeType),
      provider:     this.providerId,
    };
  }
}

module.exports = OneDriveProvider;
