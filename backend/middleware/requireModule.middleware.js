// requireModule.middleware.js
// Gates routes behind organizations.settings.modules.<name>.
// Returns 404 (not 403) when disabled — module simply doesn't exist.

const { pool } = require('../config/database');

const _cache = new Map(); // `${orgId}:${module}` → { enabled, ts }
const TTL = 60_000;

const requireModule = (moduleName) => async (req, res, next) => {
  const orgId = req.orgId;
  const key   = `${orgId}:${moduleName}`;
  const hit   = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) {
    if (!hit.enabled) return res.status(404).json({ error: { message: 'Module not enabled' } });
    return next();
  }
  try {
    const r = await pool.query(
      `SELECT settings->'modules'->>$2 AS enabled FROM organizations WHERE id = $1`,
      [orgId, moduleName]
    );
    const enabled = r.rows[0]?.enabled === 'true';
    _cache.set(key, { enabled, ts: Date.now() });
    if (!enabled) return res.status(404).json({ error: { message: 'Module not enabled' } });
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

module.exports = requireModule;
