/**
 * StorageProviderBase.js
 *
 * Abstract base class (interface) that every cloud storage provider must implement.
 * OneDriveProvider and GoogleDriveProvider both extend this.
 *
 * The processor, routes, and frontend never import a provider directly —
 * they always go through StorageProviderFactory, which resolves the correct
 * implementation per user at runtime.
 *
 * ADDING A NEW PROVIDER (e.g. Dropbox):
 *   1. Create services/storage/DropboxProvider.js extending this class
 *   2. Register it in StorageProviderFactory.js
 *   3. Done — no changes needed anywhere else.
 */

class StorageProviderBase {
  /**
   * @param {string} providerId - Unique identifier e.g. 'onedrive' | 'googledrive'
   * @param {string} displayName - Human-readable name e.g. 'OneDrive' | 'Google Drive'
   */
  constructor(providerId, displayName) {
    if (new.target === StorageProviderBase) {
      throw new Error('StorageProviderBase is abstract and cannot be instantiated directly.');
    }
    this.providerId = providerId;
    this.displayName = displayName;
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Check whether the user has valid credentials for this provider.
   * Should NOT throw — return a status object instead.
   *
   * @param {string} userId
   * @returns {Promise<{ connected: boolean, requiresReauth?: boolean, reauthUrl?: string, message: string }>}
   */
  async checkConnection(userId) {
    throw new Error(`${this.constructor.name} must implement checkConnection()`);
  }

  /**
   * Return the OAuth URL to initiate (or re-initiate) authorization.
   * Used by the frontend connect/reconnect flow.
   *
   * @param {string} userId
   * @param {Object} [options]
   * @returns {string} Full OAuth redirect URL
   */
  getAuthUrl(userId, options = {}) {
    throw new Error(`${this.constructor.name} must implement getAuthUrl()`);
  }

  // ── File browsing ──────────────────────────────────────────────────────────

  /**
   * List files and folders in a given folder (or root if folderId is null).
   *
   * @param {string} userId
   * @param {string|null} folderId
   * @returns {Promise<NormalizedFile[]>}
   */
  async listFiles(userId, folderId = null) {
    throw new Error(`${this.constructor.name} must implement listFiles()`);
  }

  /**
   * Search files by keyword across the user's entire drive.
   *
   * @param {string} userId
   * @param {string} query
   * @returns {Promise<NormalizedFile[]>}
   */
  async searchFiles(userId, query) {
    throw new Error(`${this.constructor.name} must implement searchFiles()`);
  }

  /**
   * Get metadata for a single file by its provider-specific ID.
   *
   * @param {string} userId
   * @param {string} fileId
   * @returns {Promise<NormalizedFile>}
   */
  async getFileMetadata(userId, fileId) {
    throw new Error(`${this.constructor.name} must implement getFileMetadata()`);
  }

  // ── Content extraction ─────────────────────────────────────────────────────

  /**
   * Download a file and extract its plain text content.
   * Implementations handle provider-specific download logic
   * (e.g. Google native formats require export API calls).
   *
   * @param {string} userId
   * @param {string} fileId
   * @returns {Promise<ExtractedContent>}
   */
  async extractFileContent(userId, fileId) {
    throw new Error(`${this.constructor.name} must implement extractFileContent()`);
  }
}

/**
 * @typedef {Object} NormalizedFile
 * Canonical file/folder object returned by all providers.
 * The frontend and processor always receive this shape — never raw API responses.
 *
 * @property {string}      id             - Provider-specific file/folder ID
 * @property {string}      name           - Display name
 * @property {number}      size           - Size in bytes (0 for folders and Google native files)
 * @property {string}      lastModified   - ISO 8601 timestamp
 * @property {string|null} mimeType       - MIME type (null for folders)
 * @property {boolean}     isFolder       - True if this is a folder/directory
 * @property {number}      childCount     - Number of children (folders only)
 * @property {string|null} parentFolder   - Parent folder name (display only)
 * @property {'transcript'|'document'|'email'|'folder'} category - Inferred content category
 * @property {string}      provider       - Provider ID e.g. 'onedrive'
 */

/**
 * @typedef {Object} ExtractedContent
 * Canonical content object returned by extractFileContent().
 * The processor pipeline always receives this shape.
 *
 * @property {string} fileId
 * @property {string} fileName
 * @property {string} fileType        - MIME type
 * @property {'transcript'|'document'|'email'} category
 * @property {string} rawText         - Extracted plain text
 * @property {number} characterCount
 * @property {string} provider        - Provider ID
 * @property {Object} metadata        - { size, lastModified, parentFolder }
 */

module.exports = StorageProviderBase;
