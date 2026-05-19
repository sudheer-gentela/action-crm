/**
 * services/ai/CredentialsStore.js
 *
 * The ONLY module that touches ai_credentials.key_ciphertext.
 * Everything else (resolver, routes, UI) sees masked metadata only.
 *
 * Encryption: AES-256-GCM with a 32-byte master key from env (AI_CREDS_KEY).
 * In production, source this from KMS / Railway secret manager — never
 * commit it. If AI_CREDS_KEY is missing, the store refuses to write or
 * decrypt, and the resolver falls back to the platform env-var key.
 *
 * The plaintext API key never:
 *   - hits a log line
 *   - gets returned by an HTTP route
 *   - persists outside this module's call stack
 */

const crypto = require('crypto');
const db     = require('../../config/database');

const ALGO    = 'aes-256-gcm';
const IV_LEN  = 12;   // GCM standard
const TAG_LEN = 16;

function _masterKey() {
  const raw = process.env.AI_CREDS_KEY;
  if (!raw) return null;
  // Accept either 64-hex (preferred) or base64 32-byte key
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    console.error('[CredentialsStore] AI_CREDS_KEY must decode to 32 bytes (got ' + buf.length + ')');
    return null;
  }
  return buf;
}

function _encrypt(plaintext) {
  const key = _masterKey();
  if (!key) throw new Error('AI_CREDS_KEY not configured — cannot store credentials');
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { ciphertext: enc, iv, tag };
}

function _decrypt(ciphertext, iv, tag) {
  const key = _masterKey();
  if (!key) throw new Error('AI_CREDS_KEY not configured — cannot decrypt');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function _last4(plaintext) {
  return plaintext.slice(-4);
}

class CredentialsStore {

  /**
   * Store a new key. If an active key already exists for this scope+provider,
   * the old one is revoked first (so the unique partial index doesn't fire).
   *
   * @param {object} args
   * @param {number}      args.orgId
   * @param {number|null} args.userId       null = org-level key
   * @param {string}      args.provider
   * @param {string}      args.apiKey       PLAINTEXT — never logged
   * @param {string}      [args.label]
   * @param {string}      [args.endpointUrl]  required if provider.requiresEndpoint
   * @param {number}      [args.createdBy]
   * @returns {Promise<object>} masked credential metadata
   */
  static async store({ orgId, userId = null, provider, apiKey, label, endpointUrl, createdBy }) {
    if (!apiKey || typeof apiKey !== 'string') throw new Error('apiKey required');
    if (!provider) throw new Error('provider required');

    const { ciphertext, iv, tag } = _encrypt(apiKey);
    const last4 = _last4(apiKey);

    await db.query('BEGIN');
    try {
      // Revoke any existing active key for this scope+provider
      await db.query(
        `UPDATE ai_credentials
           SET status = 'revoked', updated_at = NOW()
         WHERE org_id = $1
           AND COALESCE(user_id, 0) = COALESCE($2::int, 0)
           AND provider = $3
           AND status = 'active'`,
        [orgId, userId, provider]
      );

      const result = await db.query(
        `INSERT INTO ai_credentials
           (org_id, user_id, provider, label, endpoint_url,
            key_ciphertext, key_iv, key_tag, key_last4,
            created_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
         RETURNING id, org_id, user_id, provider, label, endpoint_url,
                   key_last4, status, last_used_at, last_validated_at, created_at`,
        [orgId, userId, provider, label || null, endpointUrl || null,
         ciphertext, iv, tag, last4, createdBy || null]
      );

      await db.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }

  /**
   * Fetch the active API key (plaintext) for the given scope+provider.
   * Returns null if no key exists or AI_CREDS_KEY is missing.
   *
   * The plaintext is returned ONLY to AIClientResolver — which uses it
   * immediately to instantiate a client and then drops the reference.
   */
  static async getActive(orgId, userId, provider) {
    const result = await db.query(
      `SELECT id, key_ciphertext, key_iv, key_tag, endpoint_url
         FROM ai_credentials
        WHERE org_id = $1
          AND COALESCE(user_id, 0) = COALESCE($2::int, 0)
          AND provider = $3
          AND status = 'active'
        LIMIT 1`,
      [orgId, userId, provider]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    try {
      const apiKey = _decrypt(row.key_ciphertext, row.key_iv, row.key_tag);
      // Fire and forget — update last_used_at
      db.query(
        'UPDATE ai_credentials SET last_used_at = NOW() WHERE id = $1',
        [row.id]
      ).catch(() => {});
      return { apiKey, endpointUrl: row.endpoint_url, credentialId: row.id };
    } catch (err) {
      console.error('[CredentialsStore] Failed to decrypt key', row.id, err.message);
      // Mark the row as invalid so we don't keep trying
      db.query(
        `UPDATE ai_credentials SET status='invalid', last_validation_error=$2 WHERE id=$1`,
        [row.id, 'decryption_failed']
      ).catch(() => {});
      return null;
    }
  }

  /**
   * List credentials for the admin UI — masked metadata only.
   */
  static async list(orgId, userId = undefined) {
    const params = [orgId];
    let where = 'org_id = $1 AND status != \'revoked\'';
    if (userId === null) {
      where += ' AND user_id IS NULL';
    } else if (typeof userId === 'number') {
      params.push(userId);
      where += ` AND user_id = $${params.length}`;
    }
    const result = await db.query(
      `SELECT id, org_id, user_id, provider, label, endpoint_url,
              key_last4, status, last_used_at, last_validated_at,
              last_validation_error, created_at
         FROM ai_credentials
        WHERE ${where}
        ORDER BY created_at DESC`,
      params
    );
    return result.rows;
  }

  static async revoke(orgId, credentialId, userId = null) {
    // userId guard prevents user A from revoking org keys or user B's keys
    const where = userId === null
      ? 'id = $1 AND org_id = $2'
      : 'id = $1 AND org_id = $2 AND user_id = $3';
    const params = userId === null ? [credentialId, orgId] : [credentialId, orgId, userId];

    const result = await db.query(
      `UPDATE ai_credentials
         SET status = 'revoked', updated_at = NOW()
       WHERE ${where}
       RETURNING id`,
      params
    );
    return result.rows.length > 0;
  }

  static async markValidated(credentialId, ok, errorMessage = null) {
    await db.query(
      `UPDATE ai_credentials
         SET last_validated_at  = NOW(),
             last_validation_error = $2,
             status = CASE WHEN $3::boolean THEN 'active' ELSE 'invalid' END,
             updated_at = NOW()
       WHERE id = $1`,
      [credentialId, errorMessage, ok]
    );
  }

  static isConfigured() {
    return _masterKey() !== null;
  }

  /**
   * Decrypt a raw ai_credentials row that was fetched elsewhere.
   * Used by ModelDiscoveryService, which needs a provider key for discovery
   * but has no orgId/userId to call getActive() with.
   *
   * @param {object} row — must have key_ciphertext, key_iv, key_tag
   * @returns {string|null} plaintext API key, or null on failure
   */
  static decryptRow(row) {
    if (!row || !row.key_ciphertext || !row.key_iv || !row.key_tag) return null;
    try {
      return _decrypt(row.key_ciphertext, row.key_iv, row.key_tag);
    } catch (err) {
      console.error('[CredentialsStore] decryptRow failed:', err.message);
      return null;
    }
  }
}

module.exports = CredentialsStore;
