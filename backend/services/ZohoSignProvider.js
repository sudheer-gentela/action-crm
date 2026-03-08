/**
 * ZohoSignProvider.js
 *
 * DROP-IN LOCATION: backend/services/ZohoSignProvider.js
 *
 * Zoho Sign adapter. Handles OAuth token management, sending signing requests,
 * and parsing inbound webhooks.
 *
 * ── Key design change from v1 ────────────────────────────────────────────
 * This provider no longer writes refreshed tokens to the DB directly.
 * Instead it calls onTokenRefresh(newTokens) — a callback supplied by
 * signatureService — which knows whether to write to organizations.settings
 * (BYOL) or to platform_esign_tokens (platform default).
 * This keeps the provider completely agnostic about where credentials live.
 *
 * ── Zoho Sign API reference ──────────────────────────────────────────────
 * https://www.zoho.com/sign/api/
 *
 * ── Zoho Sign rate limits ────────────────────────────────────────────────
 * 50 API calls/minute · 25 recipients/request · 40MB envelope · 25MB document
 *
 * ── Zoho Sign credit model ───────────────────────────────────────────────
 * 1 credit = 1 completed signed document ($0.20 on API-only plan)
 * Credits are consumed when the request is SENT, not when it completes.
 * Voided/expired requests still consume a credit.
 *
 * ── Environment ──────────────────────────────────────────────────────────
 * No env vars needed — credentials are passed in per-call via the credentials
 * argument (either from organizations.settings.esign or Railway env vars,
 * resolved by signatureService before calling this adapter).
 */

const https = require('https');
const EsignProviderBase = require('./EsignProviderBase');

const ZOHO_ACCOUNTS_BASE = 'https://accounts.zoho.com';
const ZOHO_SIGN_BASE     = 'https://sign.zoho.com/api/v1';

// Refresh the token if it expires within 5 minutes
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

class ZohoSignProvider extends EsignProviderBase {
  constructor() {
    super('zoho', 'Zoho Sign');
  }

  // ── Internal HTTP helpers ─────────────────────────────────────────────

  _request(method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const urlObj  = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              const err = new Error(
                parsed.message || parsed.error || `Zoho Sign API error ${res.statusCode}`
              );
              err.status        = res.statusCode;
              err.zohoCode      = parsed.code;
              err.zohoResponse  = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Failed to parse Zoho Sign response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  _formPost(url, params) {
    return new Promise((resolve, reject) => {
      const body    = new URLSearchParams(params).toString();
      const urlObj  = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              return reject(new Error(
                `Zoho OAuth error: ${parsed.error} — ${parsed.error_description || ''}`
              ));
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Failed to parse Zoho OAuth response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── OAuth ─────────────────────────────────────────────────────────────

  /**
   * Build the Zoho OAuth URL to redirect the user to.
   * scope: read + write for Zoho Sign documents only.
   * access_type: offline ensures we get a refresh_token.
   * prompt: consent forces a refresh_token every time (avoids the "only on first auth" gotcha).
   */
  getAuthUrl(clientId, redirectUri) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      scope:         'ZohoSign.documents.ALL,ZohoSign.templates.READ',
      redirect_uri:  redirectUri,
      access_type:   'offline',
      prompt:        'consent',
    });
    return `${ZOHO_ACCOUNTS_BASE}/oauth/v2/auth?${params}`;
  }

  /**
   * Exchange the one-time authorisation code for access + refresh tokens.
   * Returns { access_token, refresh_token, token_expiry }
   */
  async exchangeCodeForTokens(code, credentials) {
    const result = await this._formPost(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
      grant_type:    'authorization_code',
      client_id:     credentials.client_id,
      client_secret: credentials.client_secret,
      redirect_uri:  credentials.redirect_uri,
      code,
    });
    return {
      access_token:  result.access_token,
      refresh_token: result.refresh_token,
      token_expiry:  Date.now() + (result.expires_in * 1000),
    };
  }

  /**
   * Refresh an expired access token.
   * Returns { access_token, token_expiry } — refresh_token is unchanged.
   */
  async refreshAccessToken(credentials) {
    const result = await this._formPost(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
      grant_type:    'refresh_token',
      client_id:     credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
    });
    return {
      access_token: result.access_token,
      token_expiry: Date.now() + (result.expires_in * 1000),
    };
  }

  _isTokenExpired(credentials) {
    if (!credentials.token_expiry) return true;
    return Date.now() >= (credentials.token_expiry - TOKEN_EXPIRY_BUFFER_MS);
  }

  /**
   * Returns a valid access token, refreshing if needed.
   * Calls onTokenRefresh(newTokens) after refreshing so the caller can
   * persist the new token — this provider does NOT write to the DB itself.
   *
   * @param {object}   credentials     - current credential set
   * @param {Function} onTokenRefresh  - async (newTokens) => void — supplied by signatureService
   */
  async _getValidToken(credentials, onTokenRefresh) {
    if (!this._isTokenExpired(credentials)) {
      return credentials.access_token;
    }

    if (!credentials.refresh_token) {
      throw Object.assign(
        new Error('Zoho Sign access token expired and no refresh token available — please reconnect'),
        { status: 401, code: 'ESIGN_TOKEN_EXPIRED' }
      );
    }

    console.log('[ZohoSign] Access token expired — refreshing');
    const refreshed = await this.refreshAccessToken(credentials);

    // Persist via the callback — provider doesn't care where tokens are stored
    if (typeof onTokenRefresh === 'function') {
      await onTokenRefresh(refreshed).catch(err => {
        console.error('[ZohoSign] Failed to persist refreshed token:', err.message);
      });
    }

    // Update the in-memory credentials object so this request can continue
    credentials.access_token = refreshed.access_token;
    credentials.token_expiry = refreshed.token_expiry;

    return refreshed.access_token;
  }

  // ── EsignProviderBase implementation ─────────────────────────────────

  /**
   * Validate stored credentials with a lightweight API call.
   */
  async validateCredentials(credentials) {
    try {
      if (!credentials.access_token) {
        return { valid: false, message: 'No access token — please connect your Zoho Sign account' };
      }
      await this._request('GET', `${ZOHO_SIGN_BASE}/accounts`, {
        headers: { Authorization: `Zoho-oauthtoken ${credentials.access_token}` },
      });
      return { valid: true };
    } catch (err) {
      return { valid: false, message: err.message };
    }
  }

  /**
   * Send a signing request to all signatories.
   *
   * Zoho Sign model:
   *   - Each signatory = one "action" with action_type SIGN
   *   - is_sequential: false → all receive simultaneously (change to true for ordered signing)
   *   - reminder_period: 3 → automatic reminder every 3 days
   *   - expiration_days: 30 → request expires after 30 days
   *
   * Returns { requestId }
   */
  async sendSigningRequest(orgId, credentials, contract, signatories, onTokenRefresh) {
    if (!signatories?.length) {
      throw Object.assign(
        new Error('Cannot send for signature — no signatories added to this contract'),
        { status: 400 }
      );
    }

    const token = await this._getValidToken(credentials, onTokenRefresh);

    const actions = signatories.map((s, index) => ({
      recipient_name:   s.name,
      recipient_email:  s.email,
      action_type:      'SIGN',
      signing_order:    index + 1,
      verify_recipient: false,    // set true to require OTP (consumes extra credits)
      private_notes:    s.role ? `Role: ${s.role}` : '',
    }));

    const payload = {
      requests: {
        request_name:    contract.title,
        actions,
        notes:           `ActionCRM Contract #${contract.id}`,
        expiration_days: 30,
        is_sequential:   false,
        email_reminders: true,
        reminder_period: 3,
      },
    };

    const result = await this._request('POST', `${ZOHO_SIGN_BASE}/requests`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      body:    payload,
    });

    const requestId = result.requests?.request_id;
    if (!requestId) {
      throw new Error(
        'Zoho Sign did not return a request_id — check your credentials and Zoho account status'
      );
    }

    return { requestId };
  }

  /**
   * Revoke an in-progress signing request.
   * Called when a contract is recalled or voided in ActionCRM.
   * Non-fatal by convention — signatureService wraps this in try/catch.
   */
  async cancelSigningRequest(orgId, credentials, requestId, onTokenRefresh) {
    const token = await this._getValidToken(credentials, onTokenRefresh);
    await this._request('POST', `${ZOHO_SIGN_BASE}/requests/${requestId}/revoke`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      body:    { requests: { notes: 'Cancelled from ActionCRM' } },
    });
  }

  /**
   * Parse an inbound Zoho Sign webhook into a normalised ActionCRM event.
   *
   * Zoho Sign sends webhook events as:
   *   Content-Type: application/x-www-form-urlencoded
   *   Body:         payload=<url-encoded-json>
   *
   * Event types we handle:
   *   completed → all parties signed → move contract to 'signed'
   *   declined  → a signer declined → log, notify owner
   *   recalled  → revoked externally → log only
   *   expired   → signing window closed → log only
   */
  parseWebhookPayload(rawBody) {
    try {
      let data;

      if (Buffer.isBuffer(rawBody)) rawBody = rawBody.toString('utf8');

      if (typeof rawBody === 'string' && rawBody.startsWith('payload=')) {
        data = JSON.parse(decodeURIComponent(rawBody.slice('payload='.length)));
      } else if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) {
        data = rawBody;
      } else {
        data = JSON.parse(rawBody);
      }

      const requestId  = data.requests?.request_id;
      const eventType  = data.requests?.request_status;

      if (!requestId) {
        console.warn('[ZohoSign] Webhook received with no request_id — ignoring');
        return { event: 'unknown' };
      }

      switch (eventType) {
        case 'completed':
          return {
            event:             'completed',
            requestId,
            signedDocumentUrl: data.requests?.document_fields?.[0]?.document_url || null,
          };

        case 'declined':
          return {
            event:      'declined',
            requestId,
            declinedBy: data.requests?.actions?.find(
              a => a.action_status === 'DECLINED'
            )?.recipient_email || null,
          };

        case 'recalled':
          return { event: 'recalled', requestId };

        case 'expired':
          return { event: 'expired', requestId };

        default:
          // viewed, bounced, etc — informational only
          return { event: 'unknown', requestId, rawEventType: eventType };
      }
    } catch (err) {
      console.error('[ZohoSign] Failed to parse webhook payload:', err.message);
      return { event: 'unknown' };
    }
  }
}

module.exports = ZohoSignProvider;
