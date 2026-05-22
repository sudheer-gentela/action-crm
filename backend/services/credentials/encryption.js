/**
 * services/credentials/encryption.js
 *
 * Shared encryption primitives for any credential-storage purpose
 * (ai, enrichment, email, esign, ...). Extracted from
 * services/ai/CredentialsStore.js so the enrichment side can reuse the
 * exact same crypto without duplicating it.
 *
 * Encryption: AES-256-GCM with a 32-byte master key from env (AI_CREDS_KEY).
 * In production, source this from KMS / Railway secret manager — never
 * commit it. If AI_CREDS_KEY is missing, encrypt() throws and the table
 * is effectively read-only until configured.
 *
 * The plaintext API key never:
 *   - hits a log line
 *   - gets returned by an HTTP route
 *   - persists outside this module's call stack
 *
 * Why the env-var is still called AI_CREDS_KEY despite being purpose-
 * agnostic now: rotating the key name in production would require a
 * synchronized re-encrypt of every row. Not worth it. The name is internal.
 */

const crypto = require('crypto');

const ALGO    = 'aes-256-gcm';
const IV_LEN  = 12;   // GCM standard
const TAG_LEN = 16;

function masterKey() {
  const raw = process.env.AI_CREDS_KEY;
  if (!raw) return null;
  // Accept either 64-hex (preferred) or base64 32-byte key
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    console.error('[credentials/encryption] AI_CREDS_KEY must decode to 32 bytes (got ' + buf.length + ')');
    return null;
  }
  return buf;
}

function encrypt(plaintext) {
  const key = masterKey();
  if (!key) throw new Error('AI_CREDS_KEY not configured — cannot store credentials');
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { ciphertext: enc, iv, tag };
}

function decrypt(ciphertext, iv, tag) {
  const key = masterKey();
  if (!key) throw new Error('AI_CREDS_KEY not configured — cannot decrypt');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function last4(plaintext) {
  return plaintext.slice(-4);
}

function isConfigured() {
  return masterKey() !== null;
}

module.exports = {
  encrypt,
  decrypt,
  last4,
  isConfigured,
  // Re-exported for tests/inspection only — do not call from app code.
  _masterKey: masterKey,
};
