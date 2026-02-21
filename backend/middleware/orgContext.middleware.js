// ─────────────────────────────────────────────────────────────
// orgContext middleware
//
// PURPOSE:
//   Sits after authenticateToken on every route that touches
//   org-scoped data. Validates that the request carries a
//   valid org_id and makes it available as req.orgId.
//
// USAGE in route files:
//   const authenticateToken = require('../middleware/auth.middleware');
//   const { orgContext } = require('../middleware/orgContext.middleware');
//
//   router.get('/deals', authenticateToken, orgContext, async (req, res) => {
//     // req.orgId is guaranteed to be a valid integer here
//     const { rows } = await orgQuery(req.orgId, 'SELECT * FROM deals WHERE org_id = $1', [req.orgId]);
//   });
//
// HOW ORG_ID IS RESOLVED (in priority order):
//   1. JWT claim org_id  — standard path once JWT is updated
//   2. DB lookup         — fallback during transition period while
//                          old JWTs without org_id are still in use
//
// ─────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const orgContext = async (req, res, next) => {
  try {
    let orgId = null;

    // ── Path 1: org_id already in JWT (standard path) ────────
    if (req.user && req.user.org_id) {
      orgId = parseInt(req.user.org_id, 10);
    }

    // ── Path 2: Fallback — look up user's org from DB ─────────
    // Used during transition while old JWTs without org_id
    // are still valid. Remove this block after all sessions
    // have expired (typically 7–30 days after JWT update).
    if (!orgId && req.userId) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT org_id FROM org_users
           WHERE user_id = $1 AND is_active = TRUE
           ORDER BY joined_at ASC
           LIMIT 1`,
          [req.userId]
        );
        if (result.rows.length > 0) {
          orgId = result.rows[0].org_id;
        }
      } finally {
        client.release();
      }
    }

    // ── No org found — reject ─────────────────────────────────
    if (!orgId) {
      return res.status(401).json({
        error: { message: 'No organisation context. Please log in again.' }
      });
    }

    // ── Attach to request ─────────────────────────────────────
    // All route handlers use req.orgId — never req.body.org_id
    // or req.params.org_id (those can be spoofed).
    req.orgId = orgId;
    req.user  = { ...req.user, org_id: orgId }; // keep req.user in sync

    next();
  } catch (err) {
    console.error('orgContext middleware error:', err);
    return res.status(500).json({ error: { message: 'Internal server error' } });
  }
};

// ─────────────────────────────────────────────────────────────
// requireRole
//
// Optional additional guard. Use after orgContext when a route
// requires a specific role (admin-only operations etc.).
//
// Usage:
//   router.delete('/org/user/:id',
//     authenticateToken,
//     orgContext,
//     requireRole('admin'),
//     async (req, res) => { ... }
//   );
// ─────────────────────────────────────────────────────────────
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const { pool } = require('../config/database');
      const result = await pool.query(
        `SELECT role FROM org_users
         WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
        [req.userId, req.orgId]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: { message: 'Access denied' } });
      }

      const userRole = result.rows[0].role;
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: { message: `Requires role: ${allowedRoles.join(' or ')}` }
        });
      }

      req.userRole = userRole; // available downstream
      next();
    } catch (err) {
      console.error('requireRole middleware error:', err);
      return res.status(500).json({ error: { message: 'Internal server error' } });
    }
  };
};

module.exports = { orgContext, requireRole };
