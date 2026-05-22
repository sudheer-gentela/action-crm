/**
 * services/ai/CredentialsStore.js
 *
 * Manages encrypted API credentials in the `org_credentials` table
 * (previously `ai_credentials`, renamed in the Sprint-3 migration).
 *
 * Despite the file path saying `ai/`, this store handles credentials for
 * any purpose — 'ai' (LLM providers), 'enrichment' (CoreSignal, Apollo),
 * 'email', 'esign', etc. The path is kept to avoid touching 20+ import sites
 * across the codebase; the file is now purpose-agnostic internally.
 *
 * Public API:
 *   store({ orgId, userId, provider, apiKey, label, endpointUrl, createdBy, purpose })
 *   getActive(orgId, userId, provider, purpose = 'ai')   → { apiKey, endpointUrl, credentialId } | null
 *   list(orgId, userId = undefined, purpose = 'ai')      → masked metadata rows
 *   revoke(orgId, credentialId, userId = null)
 *   markValidated(credentialId, ok, errorMessage)
 *   isConfigured()                                       → true if AI_CREDS_KEY is set
 *   decryptRow(row)                                      → plaintext API key, or null
 *
 * Every method that takes a `purpose` parameter defaults to 'ai' so existing
 * LLM call sites don't need to be touched. New code paths (enrichment) pass
 * purpose explicitly.
 *
 * Encryption lives in services/credentials/encryption.js — shared with any
 * other credential-handling code so the crypto isn't duplicated.
 */

const db = require('../../config/database');
const { encrypt, decrypt, last4, isConfigured: encIsConfigured } = require('../credentials/encryption');

class CredentialsStore {

  /**
   * Store a new key. If an active key already exists for this scope+provider
   * (+purpose), the old one is revoked first so the unique partial index
   * doesn't fire.
   */
  static async store({ orgId, userId = null, provider, apiKey, label, endpointUrl, createdBy, purpose = 'ai' }) {
    if (!apiKey || typeof apiKey !== 'string') throw new Error('apiKey required');
    if (!provider) throw new Error('provider required');

    const { ciphertext, iv, tag } = encrypt(apiKey);
    const masked = last4(apiKey);

    await db.query('BEGIN');
    try {
      await db.query(
        `UPDATE org_credentials
           SET status = 'revoked', updated_at = NOW()
         WHERE org_id = $1
           AND purpose = $4
           AND COALESCE(user_id, 0) = COALESCE($2::int, 0)
           AND provider = $3
           AND status = 'active'`,
        [orgId, userId, provider, purpose]
      );

      const result = await db.query(
        `INSERT INTO org_credentials
           (org_id, user_id, provider, purpose, label, endpoint_url,
            key_ciphertext, key_iv, key_tag, key_last4,
            created_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
         RETURNING id, org_id, user_id, provider, purpose, label, endpoint_url,
                   key_last4, status, last_used_at, last_validated_at, created_at`,
        [orgId, userId, provider, purpose, label || null, endpointUrl || null,
         ciphertext, iv, tag, masked, createdBy || null]
      );

      await db.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }

  /**
   * Fetch the active API key (plaintext) for the given scope+provider+purpose.
   * Returns null if no key exists or AI_CREDS_KEY is missing.
   */
  static async getActive(orgId, userId, provider, purpose = 'ai') {
    const result = await db.query(
      `SELECT id, key_ciphertext, key_iv, key_tag, endpoint_url
         FROM org_credentials
        WHERE org_id  = $1
          AND purpose = $4
          AND COALESCE(user_id, 0) = COALESCE($2::int, 0)
          AND provider = $3
          AND status   = 'active'
        LIMIT 1`,
      [orgId, userId, provider, purpose]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    try {
      const apiKey = decrypt(row.key_ciphertext, row.key_iv, row.key_tag);
      db.query(
        'UPDATE org_credentials SET last_used_at = NOW() WHERE id = $1',
        [row.id]
      ).catch(() => {});
      return { apiKey, endpointUrl: row.endpoint_url, credentialId: row.id };
    } catch (err) {
      console.error('[CredentialsStore] Failed to decrypt key', row.id, err.message);
      db.query(
        `UPDATE org_credentials SET status='invalid', last_validation_error=$2 WHERE id=$1`,
        [row.id, 'decryption_failed']
      ).catch(() => {});
      return null;
    }
  }

  /**
   * List credentials for the admin UI — masked metadata only.
   * Pass `purpose=null` to list across all purposes (SuperAdmin-style view).
   */
  static async list(orgId, userId = undefined, purpose = 'ai') {
    const params = [orgId];
    const conds  = ['org_id = $1', "status != 'revoked'"];

    if (purpose !== null) {
      params.push(purpose);
      conds.push(`purpose = $${params.length}`);
    }
    if (userId === null) {
      conds.push('user_id IS NULL');
    } else if (typeof userId === 'number') {
      params.push(userId);
      conds.push(`user_id = $${params.length}`);
    }

    const result = await db.query(
      `SELECT id, org_id, user_id, provider, purpose, label, endpoint_url,
              key_last4, status, last_used_at, last_validated_at,
              last_validation_error, created_at
         FROM org_credentials
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at DESC`,
      params
    );
    return result.rows;
  }

  static async revoke(orgId, credentialId, userId = null) {
    const where = userId === null
      ? 'id = $1 AND org_id = $2'
      : 'id = $1 AND org_id = $2 AND user_id = $3';
    const params = userId === null ? [credentialId, orgId] : [credentialId, orgId, userId];

    const result = await db.query(
      `UPDATE org_credentials
         SET status = 'revoked', updated_at = NOW()
       WHERE ${where}
       RETURNING id`,
      params
    );
    return result.rows.length > 0;
  }

  static async markValidated(credentialId, ok, errorMessage = null) {
    await db.query(
      `UPDATE org_credentials
         SET last_validated_at  = NOW(),
             last_validation_error = $2,
             status = CASE WHEN $3::boolean THEN 'active' ELSE 'invalid' END,
             updated_at = NOW()
       WHERE id = $1`,
      [credentialId, errorMessage, ok]
    );
  }

  static isConfigured() {
    return encIsConfigured();
  }

  /**
   * Decrypt a raw org_credentials row that was fetched elsewhere.
   * Used by ModelDiscoveryService, which needs a provider key for discovery
   * but has no orgId/userId to call getActive() with.
   */
  static decryptRow(row) {
    if (!row || !row.key_ciphertext || !row.key_iv || !row.key_tag) return null;
    try {
      return decrypt(row.key_ciphertext, row.key_iv, row.key_tag);
    } catch (err) {
      console.error('[CredentialsStore] decryptRow failed:', err.message);
      return null;
    }
  }
}

module.exports = CredentialsStore;
