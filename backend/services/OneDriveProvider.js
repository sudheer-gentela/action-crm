/**
 * OneDriveProvider.js
 * Microsoft OneDrive implementation of StorageProviderBase.
 * Reuses existing Outlook OAuth tokens (provider = 'outlook' in oauth_tokens).
 */

const axios = require('axios');
const StorageProviderBase  = require('./StorageProviderBase');
const { resolveCategory, assertSizeAllowed, extractTextFromBuffer } = require('./contentExtractor');
const { getTokenByUserId, refreshUserToken } = require('./oauthTokenService');

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
        parent_folder_id: meta.parentFolderId || null,
      },
      metadata: {
        size:         meta.size,
        lastModified: meta.lastModified,
        parentFolder: meta.parentFolder,
      },
    };
  }

  // Graph's simple upload tops out at 4 MB. WhatsApp video routinely exceeds
  // that, so anything larger goes through a resumable upload session.
  static get SIMPLE_UPLOAD_LIMIT() { return 4 * 1024 * 1024; }

  /**
   * Write bytes into an existing folder in the caller's own OneDrive.
   *
   * Verified against the live API with Files.ReadWrite only — a 201 into a
   * hand-made folder, and a colleague the folder was shared with could see the
   * result. That is what makes Files.ReadWrite sufficient and Files.ReadWrite.All
   * unnecessary: we write into the STORAGE ACCOUNT'S OWN drive, not into a
   * folder shared with it. Writing into someone else's shared folder is the
   * case that needs .All, and this deliberately does not do that.
   */
  async uploadFile(userId, folderId, fileName, mimeType, buffer) {
    const accessToken = await this._getAccessToken(userId);
    const safeName = encodeURIComponent(fileName);

    if (buffer.length <= OneDriveProvider.SIMPLE_UPLOAD_LIMIT) {
      const res = await axios.put(
        `${GRAPH_BASE}/me/drive/items/${folderId}:/${safeName}:/content`,
        buffer,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': mimeType || 'application/octet-stream',
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }
      );
      return this._normalize(res.data);
    }

    // ── Resumable session for anything larger ──
    const session = await axios.post(
      `${GRAPH_BASE}/me/drive/items/${folderId}:/${safeName}:/createUploadSession`,
      { item: { '@microsoft.graph.conflictBehavior': 'rename' } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    const uploadUrl = session.data.uploadUrl;

    // Graph requires each chunk to be a multiple of 320 KiB, except the last.
    const CHUNK = 5 * 320 * 1024;   // 1.6 MB
    let last = null;
    for (let start = 0; start < buffer.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, buffer.length) - 1;
      const slice = buffer.subarray(start, end + 1);
      last = await axios.put(uploadUrl, slice, {
        headers: {
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        // 202 is returned for every chunk but the last; only the final PUT
        // returns 200/201 with the item.
        validateStatus: (st) => st === 200 || st === 201 || st === 202,
      });
    }
    return this._normalize(last.data);
  }

  /** Delete a file this app created — the undo behind "Remove". */
  async deleteFile(userId, fileId) {
    const accessToken = await this._getAccessToken(userId);
    await axios.delete(`${GRAPH_BASE}/me/drive/items/${fileId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return true;
  }

  /** One step up the folder tree. See GoogleDriveProvider.getParentFolderId. */
  async getParentFolderId(userId, itemId) {
    const accessToken = await this._getAccessToken(userId);
    try {
      const res = await axios.get(`${GRAPH_BASE}/me/drive/items/${itemId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { $select: 'parentReference' },
      });
      const ref = res.data && res.data.parentReference;
      // Graph reports the drive root as a parent with no id worth walking past.
      return (ref && ref.id) || null;
    } catch (err) {
      if (err.response && [401, 403, 404].includes(err.response.status)) return null;
      throw err;
    }
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
      // parentFolder stays the NAME — extractFileContent's metadata block
      // already returns it and changing it would break that caller. The id is
      // added alongside it, which is what folder mapping needs.
      parentFolder:   (item.parentReference && item.parentReference.name) || null,
      parentFolderId: (item.parentReference && item.parentReference.id)   || null,
      webUrl:       item.webUrl || null,
      category:     item.folder ? 'folder' : resolveCategory(mimeType),
      provider:     this.providerId,
    };
  }
}

module.exports = OneDriveProvider;
