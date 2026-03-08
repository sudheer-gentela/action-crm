/**
 * EsignProviderBase.js
 * Abstract base class that every e-signature provider must implement.
 * Mirrors the StorageProviderBase pattern used for cloud storage providers.
 *
 * DROP-IN LOCATION: backend/services/EsignProviderBase.js
 */

class EsignProviderBase {
  constructor(providerId, displayName) {
    if (new.target === EsignProviderBase) {
      throw new Error('EsignProviderBase is abstract and cannot be instantiated directly.');
    }
    this.providerId   = providerId;
    this.displayName  = displayName;
  }

  /**
   * Validate stored credentials by making a lightweight API call.
   * Returns { valid: true } or { valid: false, message: '...' }
   */
  async validateCredentials(credentials) {
    throw new Error(`${this.constructor.name} must implement validateCredentials()`);
  }

  /**
   * Exchange an authorization code for access + refresh tokens (OAuth flow).
   * Returns { access_token, refresh_token, expires_in }
   */
  async exchangeCodeForTokens(code, credentials) {
    throw new Error(`${this.constructor.name} must implement exchangeCodeForTokens()`);
  }

  /**
   * Refresh an expired access token using the stored refresh token.
   * Returns { access_token, expires_in }
   */
  async refreshAccessToken(credentials) {
    throw new Error(`${this.constructor.name} must implement refreshAccessToken()`);
  }

  /**
   * Send a signing request for a contract to all signatories.
   * @param {object} credentials  - org-level provider credentials from settings
   * @param {object} contract     - { id, title, documentUrl }
   * @param {Array}  signatories  - [{ name, email, role }]
   * Returns { requestId, signingUrls: [{ email, url }] } or throws on failure.
   */
  async sendSigningRequest(credentials, contract, signatories) {
    throw new Error(`${this.constructor.name} must implement sendSigningRequest()`);
  }

  /**
   * Cancel / void an in-progress signing request at the provider.
   * Called when a contract is recalled or voided in ActionCRM.
   * @param {object} credentials  - org-level provider credentials
   * @param {string} requestId    - the provider's request/envelope ID stored on the contract
   */
  async cancelSigningRequest(credentials, requestId) {
    throw new Error(`${this.constructor.name} must implement cancelSigningRequest()`);
  }

  /**
   * Parse an inbound webhook payload from the provider into a
   * normalised ActionCRM event object.
   * Returns:
   *   { event: 'completed', requestId, signedDocumentUrl } — all parties signed
   *   { event: 'declined',  requestId, declinedBy }        — a signer declined
   *   { event: 'viewed',    requestId, viewedBy }           — informational
   *   { event: 'unknown' }                                  — ignore / log only
   */
  parseWebhookPayload(rawBody, headers) {
    throw new Error(`${this.constructor.name} must implement parseWebhookPayload()`);
  }
}

module.exports = EsignProviderBase;
