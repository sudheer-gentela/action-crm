/**
 * sessionAuthStore.js
 *
 * DROP-IN LOCATION: backend/services/whatsapp/sessionAuthStore.js
 *
 * A Baileys `AuthenticationState` backed by Postgres instead of the local
 * filesystem.
 *
 * WHY NOT useMultiFileAuthState
 *   Baileys ships useMultiFileAuthState(dir), which writes creds.json plus one
 *   file per Signal key to disk. Railway containers are ephemeral: the next
 *   deploy deletes that directory, the session dies, and someone has to find
 *   the handset and rescan a QR. Worse, it fails silently — capture just stops.
 *   This is the single most common way a first attempt at session capture dies,
 *   so it is worth solving before anything else works.
 *
 * ENCRYPTION
 *   Every value goes through services/credentials/encryption.js — the same
 *   AES-256-GCM helper behind org_whatsapp_accounts and org_twilio_accounts.
 *   This is a live WhatsApp identity, not a config blob. If AI_CREDS_KEY is
 *   unset we refuse to start rather than writing plaintext session keys.
 *
 * WRITE VOLUME
 *   keys.set() fires on essentially every message as the Signal ratchet
 *   advances. Each call is batched into ONE transaction. Do not add per-row
 *   triggers to whatsapp_session_auth.
 */

'use strict';

const { pool } = require('../../config/database');
const encryption = require('../credentials/encryption');

// Baileys is only present in the worker service's dependency tree. Requiring it
// lazily keeps this file importable from the API process (which reads session
// status but never opens a socket).
function baileys() {
  // eslint-disable-next-line global-require
  return require('@whiskeysockets/baileys');
}

/**
 * Build the { state, saveCreds, clear } triple Baileys expects.
 *
 * @param {number} sessionId  whatsapp_sessions.id
 */
async function usePostgresAuthState(sessionId) {
  const { initAuthCreds, BufferJSON, proto } = baileys();

  if (!encryption.isConfigured()) {
    throw new Error(
      'AI_CREDS_KEY is not configured — refusing to persist WhatsApp session keys in plaintext'
    );
  }

  const sid = parseInt(sessionId, 10);
  if (!Number.isInteger(sid)) throw new Error(`invalid sessionId: ${sessionId}`);

  // ── storage primitives ───────────────────────────────────────────────────

  const readOne = async (keyId) => {
    const { rows } = await pool.query(
      `SELECT value_ciphertext, value_iv, value_tag
         FROM whatsapp_session_auth
        WHERE session_id = $1 AND key_id = $2`,
      [sid, keyId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    try {
      const json = encryption.decrypt(r.value_ciphertext, r.value_iv, r.value_tag);
      return JSON.parse(json, BufferJSON.reviver);
    } catch (err) {
      // A key we cannot decrypt is worse than a key we do not have: Baileys
      // will re-request it, whereas a throw here aborts the whole connection.
      console.error(`[wa-session] undecryptable auth key ${keyId} on session ${sid}: ${err.message}`);
      return null;
    }
  };

  const readMany = async (keyIds) => {
    if (!keyIds.length) return {};
    const { rows } = await pool.query(
      `SELECT key_id, value_ciphertext, value_iv, value_tag
         FROM whatsapp_session_auth
        WHERE session_id = $1 AND key_id = ANY($2::text[])`,
      [sid, keyIds]
    );
    const out = {};
    for (const r of rows) {
      try {
        out[r.key_id] = JSON.parse(
          encryption.decrypt(r.value_ciphertext, r.value_iv, r.value_tag),
          BufferJSON.reviver
        );
      } catch (err) {
        console.error(`[wa-session] undecryptable auth key ${r.key_id}: ${err.message}`);
      }
    }
    return out;
  };

  /**
   * Write and delete in one transaction. Baileys hands us a whole batch and
   * treats it as atomic; a partial apply leaves the ratchet inconsistent and
   * produces "Bad MAC" decryption failures that look like a Baileys bug.
   */
  const writeBatch = async (upserts, deletes) => {
    if (!upserts.length && !deletes.length) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [keyId, value] of upserts) {
        const json = JSON.stringify(value, BufferJSON.replacer);
        const enc = encryption.encrypt(json);
        await client.query(
          `INSERT INTO whatsapp_session_auth
             (session_id, key_id, value_ciphertext, value_iv, value_tag, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (session_id, key_id) DO UPDATE SET
             value_ciphertext = EXCLUDED.value_ciphertext,
             value_iv         = EXCLUDED.value_iv,
             value_tag        = EXCLUDED.value_tag,
             updated_at       = now()`,
          [sid, keyId, enc.ciphertext, enc.iv, enc.tag]
        );
      }
      if (deletes.length) {
        await client.query(
          `DELETE FROM whatsapp_session_auth WHERE session_id = $1 AND key_id = ANY($2::text[])`,
          [sid, deletes]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already failed */ }
      throw err;
    } finally {
      client.release();
    }
  };

  // ── state ────────────────────────────────────────────────────────────────

  const creds = (await readOne('creds')) || initAuthCreds();

  const state = {
    creds,
    keys: {
      /**
       * @param {string} type  'pre-key' | 'session' | 'sender-key' |
       *                       'app-state-sync-key' | 'app-state-sync-version' |
       *                       'sender-key-memory'
       * @param {string[]} ids
       */
      get: async (type, ids) => {
        const keyIds = ids.map((id) => `${type}:${id}`);
        const found = await readMany(keyIds);
        const out = {};
        for (const id of ids) {
          let value = found[`${type}:${id}`];
          if (value === undefined) continue;
          // App-state sync keys must be rehydrated into their protobuf type or
          // Baileys throws when it tries to decrypt an app-state patch.
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[id] = value;
        }
        return out;
      },

      /**
       * @param {Record<string, Record<string, any>>} data
       *        A null value means "delete this key".
       */
      set: async (data) => {
        const upserts = [];
        const deletes = [];
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            const keyId = `${type}:${id}`;
            if (value == null) deletes.push(keyId);
            else upserts.push([keyId, value]);
          }
        }
        await writeBatch(upserts, deletes);
      },
    },
  };

  const saveCreds = async () => {
    await writeBatch([['creds', state.creds]], []);
  };

  /**
   * Wipe all key material for this session. Called when WhatsApp reports
   * loggedOut — the credentials are dead and keeping them means the next boot
   * retries with garbage instead of showing a QR.
   */
  const clear = async () => {
    await pool.query(`DELETE FROM whatsapp_session_auth WHERE session_id = $1`, [sid]);
  };

  return { state, saveCreds, clear };
}

module.exports = { usePostgresAuthState };
