/**
 * sessionAuthStore.js
 *
 * DROP-IN LOCATION: backend/services/whatsapp/sessionAuthStore.js
 *
 * A Baileys `AuthenticationState` backed by the GoWarmCRM API rather than a
 * direct database connection.
 *
 * WHY NOT TALK TO POSTGRES DIRECTLY
 *   The worker used to open its own pool. That gave it a second thing that
 *   could fail — and on Railway it did: a new service could not resolve
 *   *.railway.internal, so the worker was healthy, the API was healthy, and
 *   capture was dead in between. Routing key material over the HTTPS channel
 *   the worker already depends on removes that failure mode entirely.
 *
 *   It also shrinks the worker's blast radius: no AI_CREDS_KEY, no database
 *   credentials, no connection pool. If the worker host is ever compromised,
 *   the attacker gets a session-scoped API token, not the database.
 *
 * WHY NOT useMultiFileAuthState
 *   Baileys ships useMultiFileAuthState(dir), which writes creds and Signal
 *   keys to local disk. Railway containers are ephemeral: the next deploy wipes
 *   them, the session dies, and someone must find the handset and rescan.
 *   Worse, it fails silently — capture just stops.
 *
 * SERIALISATION
 *   Values are serialised HERE with Baileys' BufferJSON (which round-trips
 *   Buffers losslessly) and sent as opaque strings. The API encrypts and stores
 *   them without ever parsing them — it has no need to know Signal's shapes,
 *   and no reason to depend on Baileys.
 *
 * WRITE VOLUME
 *   keys.set() fires on essentially every message as the ratchet advances. Each
 *   call is one batched request, not one per key.
 */

'use strict';

// Baileys lives in the worker's dependency tree only. Lazy-required so the API
// process can import sibling modules without pulling in the socket library.
function baileys() {
  // eslint-disable-next-line global-require
  return require('@whiskeysockets/baileys');
}

/**
 * @param {number} sessionId  whatsapp_sessions.id
 * @param {{ apiUrl: string, workerSecret: string }} opts
 */
async function useRemoteAuthState(sessionId, { apiUrl, workerSecret } = {}) {
  const { initAuthCreds, BufferJSON, proto } = baileys();

  if (!apiUrl || !workerSecret) {
    throw new Error('useRemoteAuthState requires apiUrl and workerSecret');
  }

  const sid = parseInt(sessionId, 10);
  if (!Number.isInteger(sid)) throw new Error(`invalid sessionId: ${sessionId}`);

  const call = async (path, body) => {
    const res = await fetch(`${apiUrl}/api/whatsapp-session${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify({ sessionId: sid, ...body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`auth${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  };

  // ── reads ────────────────────────────────────────────────────────────────

  const readMany = async (keyIds) => {
    if (!keyIds.length) return {};
    const { values } = await call('/internal/auth/get', { keyIds });
    const out = {};
    for (const [keyId, raw] of Object.entries(values || {})) {
      try {
        out[keyId] = JSON.parse(raw, BufferJSON.reviver);
      } catch (err) {
        console.error(`[wa-session] unparseable auth key ${keyId}: ${err.message}`);
      }
    }
    return out;
  };

  // ── writes ───────────────────────────────────────────────────────────────

  const writeBatch = async (upserts, deletes) => {
    if (!upserts.length && !deletes.length) return;
    await call('/internal/auth/set', {
      upserts: upserts.map(([keyId, value]) => [keyId, JSON.stringify(value, BufferJSON.replacer)]),
      deletes,
    });
  };

  // ── state ────────────────────────────────────────────────────────────────

  const existing = await readMany(['creds']);
  const creds = existing.creds || initAuthCreds();

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
        const found = await readMany(ids.map((id) => `${type}:${id}`));
        const out = {};
        for (const id of ids) {
          let value = found[`${type}:${id}`];
          if (value === undefined) continue;
          // App-state sync keys must be rehydrated into their protobuf type, or
          // Baileys throws when decrypting an app-state patch.
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
   * loggedOut — the credentials are dead, and keeping them means the next boot
   * retries with garbage instead of showing a QR.
   */
  const clear = async () => {
    await call('/internal/auth/clear', {});
  };

  return { state, saveCreds, clear };
}

module.exports = { useRemoteAuthState };
