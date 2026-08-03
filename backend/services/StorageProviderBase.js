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
}

module.exports = StorageProviderBase;
