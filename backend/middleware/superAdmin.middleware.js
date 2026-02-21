// ─────────────────────────────────────────────────────────────────────────────
// superAdmin.middleware.js
//
// Guards platform-level routes that only ActionCRM super admins can access.
//
// USAGE — stack after authenticateToken (no orgContext needed — super admins
// operate across orgs and don't belong to a single org context):
//
//   router.get('/super/orgs',
//     authenticateToken,
//     requireSuperAdmin,
//     async (req, res) => { ... }
//   );
//
// IMPERSONATION — super admins can act "on behalf of" an org for support.
// Set req.impersonatingOrgId when the route needs org-scoped data access.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

// ── Main guard ────────────────────────────────────────────────────────────────
const requireSuperAdmin = async (req, res, next) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    const result = await pool.query(
      `SELECT id FROM super_admins
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      // Log the unauthorised attempt — useful for security monitoring
      console.warn(`[SUPER_ADMIN] Unauthorised access attempt by user ${req.userId} — ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ error: { message: 'Super admin access required' } });
    }

    req.isSuperAdmin = true;
    next();
  } catch (err) {
    console.error('requireSuperAdmin error:', err);
    return res.status(500).json({ error: { message: 'Internal server error' } });
  }
};

// ── Audit logger — call this inside route handlers for important actions ──────
const auditLog = async (req, action, targetType, targetId, payload = {}) => {
  try {
    await pool.query(
      `INSERT INTO super_admin_audit_log
         (super_admin_id, action, target_type, target_id, payload, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.userId,
        action,
        targetType,
        targetId,
        JSON.stringify(payload),
        req.ip || req.connection?.remoteAddress || null,
      ]
    );
  } catch (err) {
    // Non-fatal — log but don't crash the request
    console.error('[AUDIT LOG] Failed to write audit entry:', err.message);
  }
};

module.exports = { requireSuperAdmin, auditLog };
