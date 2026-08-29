// ─────────────────────────────────────────────────────────────────────────────
// moduleAccess.service.js
//
// Per-user module access on top of the org-level module entitlements
// (organizations.settings.modules). Effective access = org enabled AND user grant.
//
// No admin bypass: admins/owners are simply granted every org-enabled module
// (via backfill and grantAllEnabledToAdmins on module-enable).
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');

const MODULE_KEYS = ['prospecting', 'contracts', 'handovers', 'service', 'agency','dailywork'];

// small cache, mirroring requireModule's 60s TTL
const _cache = new Map();
const TTL = 60 * 1000;
const key = (o, u) => `${o}:${u}`;
function invalidate(orgId, userId) {
  if (orgId && userId) _cache.delete(key(orgId, userId));
  else _cache.clear();
}

// Modules the ORG currently has enabled (allowed && enabled), legacy-safe.
async function orgEnabledModules(orgId) {
  const { rows } = await pool.query(
    `SELECT settings->'modules' AS modules FROM organizations WHERE id = $1`, [orgId]);
  const raw = rows[0]?.modules || {};
  const out = [];
  for (const [k, v] of Object.entries(raw)) {
    const on = (v && typeof v === 'object') ? (!!v.allowed && !!v.enabled)
             : (v === true || v === 'true' || v === 1 || v === '1');
    if (on) out.push(k);
  }
  return out;
}

// The set of module keys granted to a user (cached).
async function userModules(orgId, userId) {
  const hit = _cache.get(key(orgId, userId));
  if (hit && Date.now() - hit.ts < TTL) return hit.set;
  const { rows } = await pool.query(
    `SELECT module_key FROM user_module_access WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  const set = new Set(rows.map(r => r.module_key));
  _cache.set(key(orgId, userId), { set, ts: Date.now() });
  return set;
}

async function hasModule(orgId, userId, moduleKey) {
  const set = await userModules(orgId, userId);
  return set.has(moduleKey);
}

// Effective (what the user actually sees): org-enabled ∩ user-granted.
async function effectiveModules(orgId, userId) {
  const [enabled, granted] = await Promise.all([orgEnabledModules(orgId), userModules(orgId, userId)]);
  return enabled.filter(k => granted.has(k));
}

// Replace a user's grant set (admin action). Only accepts known keys.
async function setUserModules(orgId, userId, moduleKeys, grantedBy) {
  const keys = [...new Set((moduleKeys || []).filter(k => MODULE_KEYS.includes(k)))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_module_access WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    for (const k of keys) {
      await client.query(
        `INSERT INTO user_module_access (org_id, user_id, module_key, granted_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [orgId, userId, k, grantedBy]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  invalidate(orgId, userId);
  return { modules: keys };
}

// Grant specific modules to a user (additive).
async function grant(orgId, userId, moduleKeys, grantedBy) {
  for (const k of (moduleKeys || []).filter(k => MODULE_KEYS.includes(k))) {
    await pool.query(
      `INSERT INTO user_module_access (org_id, user_id, module_key, granted_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [orgId, userId, k, grantedBy]);
  }
  invalidate(orgId, userId);
}

// Grant a single user all modules the org currently has enabled. Used by the
// generic user-creation paths (superadmin add/create, registration) so a new
// member isn't locked out. Project-scoped provisioning grants specific modules
// instead of calling this.
async function grantAllEnabledToUser(orgId, userId) {
  const enabled = await orgEnabledModules(orgId);
  if (enabled.length) await grant(orgId, userId, enabled, null);
}

// Keep admins/owners on ALL org-enabled modules (called after a module is enabled).
async function grantAllEnabledToAdmins(orgId) {
  const enabled = await orgEnabledModules(orgId);
  if (!enabled.length) return;
  const { rows } = await pool.query(
    `SELECT user_id FROM org_users WHERE org_id = $1 AND is_active = TRUE AND role IN ('admin','owner')`, [orgId]);
  for (const r of rows) await grant(orgId, r.user_id, enabled, null);
}

module.exports = {
  MODULE_KEYS, orgEnabledModules, userModules, hasModule, effectiveModules,
  setUserModules, grant, grantAllEnabledToUser, grantAllEnabledToAdmins, invalidate,
};
