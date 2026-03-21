// requireModule.middleware.js
//
// Gates routes behind organizations.settings.modules.<name>.
// Returns 404 (not 403) when disabled — module simply doesn't exist for the user.
//
// Two-tier permission model:
//
//   allowed  — set by super admins. Controls whether the org CAN activate this module.
//   enabled  — set by org admins.  Controls whether the org HAS activated this module.
//
//   A module is accessible only when BOTH allowed AND enabled are true.
//
// Storage shape (new):
//   settings.modules.prospecting = { allowed: true, enabled: true }
//
// Backward-compatible legacy shape (migrated orgs, treated as allowed+enabled):
//   settings.modules.prospecting = true   ← read as allowed=true, enabled=true
//   settings.modules.prospecting = "true" ← same
//   settings.modules.prospecting = false  ← read as allowed=false, enabled=false
//
// The cache key and TTL are unchanged so invalidation via requireModule.invalidate()
// continues to work without any changes at call sites.

const { pool } = require('../config/database');

const _cache = new Map(); // `${orgId}:${module}` → { enabled, ts }
const TTL = 60_000;

/**
 * Parse the raw JSONB value for a single module into { allowed, enabled }.
 * Handles all three shapes:
 *   - Object: { allowed: bool, enabled: bool }
 *   - Boolean true/false (legacy scalar)
 *   - String "true"/"false" (legacy — jsonb ->> returns text)
 *   - null / undefined → not provisioned, treat as denied
 */
function parseModuleValue(raw) {
  if (raw === null || raw === undefined) {
    return { allowed: false, enabled: false };
  }

  // Object shape (new format coming from jsonb column as parsed JS object)
  if (typeof raw === 'object') {
    return {
      allowed: raw.allowed === true,
      enabled: raw.enabled === true,
    };
  }

  // String from jsonb ->> operator or JSON.stringify
  if (typeof raw === 'string') {
    // Try parsing as JSON first (covers '{"allowed":true,"enabled":true}')
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          allowed: parsed.allowed === true,
          enabled: parsed.enabled === true,
        };
      }
      // Parsed to a boolean scalar
      const b = parsed === true;
      return { allowed: b, enabled: b };
    } catch {
      // Plain string "true" / "false"
      const b = raw === 'true';
      return { allowed: b, enabled: b };
    }
  }

  // Boolean scalar (legacy)
  if (typeof raw === 'boolean') {
    return { allowed: raw, enabled: raw };
  }

  return { allowed: false, enabled: false };
}

const requireModule = (moduleName) => async (req, res, next) => {
  const orgId = req.orgId;
  const key   = `${orgId}:${moduleName}`;
  const hit   = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) {
    if (!hit.enabled) return res.status(404).json({ error: { message: 'Module not enabled' } });
    return next();
  }
  try {
    // Use -> (not ->>) so we get the raw JSON value, allowing us to distinguish
    // the new object shape from the legacy scalar shape.
    const r = await pool.query(
      `SELECT settings->'modules'->$2 AS module_val FROM organizations WHERE id = $1`,
      [orgId, moduleName]
    );
    const raw    = r.rows[0]?.module_val ?? null;
    const { allowed, enabled } = parseModuleValue(raw);

    // A module is accessible only when the platform has provisioned it (allowed)
    // AND the org admin has turned it on (enabled).
    const accessible = allowed && enabled;

    _cache.set(key, { enabled: accessible, ts: Date.now() });
    if (!accessible) return res.status(404).json({ error: { message: 'Module not enabled' } });
    next();
  } catch (err) {
    console.error('requireModule:', err.message);
    next(); // fail open on infra error
  }
};

requireModule.invalidate = (orgId, moduleName) => {
  if (orgId && moduleName) _cache.delete(`${orgId}:${moduleName}`);
  else _cache.clear();
};

/**
 * Read the full module state for an org (used by profile endpoints).
 * Returns { prospecting: { allowed, enabled }, contracts: { ... }, ... }
 * Always returns an object — missing keys default to { allowed: false, enabled: false }.
 */
requireModule.getOrgModules = async (orgId) => {
  const MODULE_KEYS = ['prospecting', 'contracts', 'handovers', 'service', 'agency'];
  try {
    const r = await pool.query(
      `SELECT settings->'modules' AS modules FROM organizations WHERE id = $1`,
      [orgId]
    );
    const raw = r.rows[0]?.modules || {};
    const result = {};
    for (const key of MODULE_KEYS) {
      result[key] = parseModuleValue(raw[key] ?? null);
    }
    return result;
  } catch {
    const result = {};
    for (const key of MODULE_KEYS) result[key] = { allowed: false, enabled: false };
    return result;
  }
};

module.exports = requireModule;
