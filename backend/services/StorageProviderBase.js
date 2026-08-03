/**
 * StorageProviderBase.js
 * Abstract base class that every cloud storage provider must implement.
 */

class StorageProviderBase {
  constructor(providerId, displayName) {
    if (new.target === StorageProviderBase) {
      throw new Error('StorageProviderBase is abstract and cannot be instantiated directly.');
    }
    this.providerId = providerId;
    this.displayName = displayName;
  }

  async checkConnection(userId) {
    throw new Error(`${this.constructor.name} must implement checkConnection()`);
  }

  getAuthUrl(userId, options = {}) {
    throw new Error(`${this.constructor.name} must implement getAuthUrl()`);
  }

  async listFiles(userId, folderId = null) {
    throw new Error(`${this.constructor.name} must implement listFiles()`);
  }

  async searchFiles(userId, query) {
    throw new Error(`${this.constructor.name} must implement searchFiles()`);
  }

  async getFileMetadata(userId, fileId) {
    throw new Error(`${this.constructor.name} must implement getFileMetadata()`);
  }

  async extractFileContent(userId, fileId) {
    throw new Error(`${this.constructor.name} must implement extractFileContent()`);
  }

  /**
   * Provider id of this item's immediate parent folder, or null at the root.
   * Every provider must answer this; the tree walk that turns it into an
   * ancestor chain is provider-agnostic and lives in storageFileService.
   */
  async getParentFolderId(userId, itemId) {
    throw new Error(`${this.constructor.name} must implement getParentFolderId()`);
  }

  /**
   * Write bytes into an existing folder and return a normalised file record.
   *
   * The file inherits that folder's sharing, which is what lets the project
   * team see it without GoWarm managing permissions of its own.
   *
   * @param {number} userId        whose credential writes — for WhatsApp media
   *                               this is the org storage account, not a person
   * @param {string} folderId      destination, already mapped to the project
   * @param {Buffer} buffer
   * @returns {Promise<object>}    { id, name, size, mimeType, webViewLink, parentFolderId }
   */
  async uploadFile(userId, folderId, fileName, mimeType, buffer) {
    throw new Error(`${this.constructor.name} must implement uploadFile()`);
  }

  /**
   * Same, with a token supplied by the caller rather than resolved from a user.
   * Needed because WhatsApp capture runs from a webhook with no signed-in user
   * and its credential lives in org_storage_accounts.
   */
  async uploadFileWithToken(accessToken, folderId, fileName, mimeType, buffer) {
    throw new Error(`${this.constructor.name} must implement uploadFileWithToken()`);
  }

  async deleteFileWithToken(accessToken, fileId) {
    throw new Error(`${this.constructor.name} must implement deleteFileWithToken()`);
  }
}

module.exports = StorageProviderBase;
