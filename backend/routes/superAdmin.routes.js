// ─────────────────────────────────────────────────────────────────────────────
// superAdmin.routes.js
//
// Mount in server.js:
//   app.use('/api/super', require('./routes/superAdmin.routes'));
//
// All routes require: authenticateToken + requireSuperAdmin
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { requireSuperAdmin, auditLog } = require('../middleware/superAdmin.middleware');

// Apply auth + super admin guard to ALL routes in this file
router.use(authenticateToken, requireSuperAdmin);

// ═════════════════════════════════════════════════════════════════════════════
// PLATFORM STATS (dashboard overview)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/stats', async (req, res) => {
  try {
    const [orgStats, userStats, activityStats] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                            AS total_orgs,
          COUNT(*) FILTER (WHERE status = 'active')          AS active_orgs,
          COUNT(*) FILTER (WHERE status = 'suspended')       AS suspended_orgs,
          COUNT(*) FILTER (WHERE status = 'trial')           AS trial_orgs,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_orgs_30d
        FROM organizations
      `),
      pool.query(`
        SELECT
          COUNT(*)                                                       AS total_users,
          COUNT(*) FILTER (WHERE ou.is_active = TRUE)                   AS active_users,
          COUNT(DISTINCT ou.user_id) FILTER (WHERE ou.joined_at > now() - interval '30 days') AS new_users_30d
        FROM org_users ou
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS actions_24h,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')   AS actions_7d
        FROM actions
      `),
    ]);

    res.json({
      orgs:     orgStats.rows[0],
      users:    userStats.rows[0],
      activity: activityStats.rows[0],
    });
  } catch (err) {
    console.error('GET /super/stats error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ORGANISATIONS — CRUD
// ═════════════════════════════════════════════════════════════════════════════

// List all orgs with member count
router.get('/orgs', async (req, res) => {
  try {
    const { search = '', status = '', plan = '', page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ['1=1'];
    const params     = [];
    let   p          = 1;

    if (search) {
      conditions.push(`o.name ILIKE $${p++}`);
      params.push(`%${search}%`);
    }
    if (status) {
      conditions.push(`o.status = $${p++}`);
      params.push(status);
    }
    if (plan) {
      conditions.push(`o.plan = $${p++}`);
      params.push(plan);
    }

    const where = conditions.join(' AND ');

    const [rows, countRow] = await Promise.all([
      pool.query(`
        SELECT
          o.id, o.name, o.status, o.plan, o.max_users,
          o.notes, o.created_at, o.suspended_at,
          COUNT(ou.user_id) FILTER (WHERE ou.is_active = TRUE) AS member_count,
          MAX(CASE WHEN ou.role = 'owner' THEN u.email END)    AS owner_email
        FROM organizations o
        LEFT JOIN org_users ou ON ou.org_id = o.id
        LEFT JOIN users u      ON u.id = ou.user_id AND ou.role = 'owner'
        WHERE ${where}
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT $${p++} OFFSET $${p++}
      `, [...params, parseInt(limit), offset]),

      pool.query(`
        SELECT COUNT(*) AS total FROM organizations o WHERE ${where}
      `, params),
    ]);

    res.json({
      orgs:  rows.rows,
      total: parseInt(countRow.rows[0].total),
      page:  parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('GET /super/orgs error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Get single org with full detail
router.get('/orgs/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;

    const [org, members, integrations] = await Promise.all([
      pool.query(`
        SELECT o.*, u.email AS suspended_by_email
        FROM   organizations o
        LEFT JOIN users u ON u.id = o.suspended_by
        WHERE  o.id = $1
      `, [orgId]),

      pool.query(`
        SELECT ou.user_id, ou.role, ou.is_active, ou.joined_at,
               u.email, u.first_name || ' ' || u.last_name AS name
        FROM   org_users ou
        JOIN   users u ON u.id = ou.user_id
        WHERE  ou.org_id = $1
        ORDER  BY ou.role, u.first_name
      `, [orgId]),

      pool.query(`
        SELECT provider, is_active, created_at
        FROM   org_integrations
        WHERE  org_id = $1
      `, [orgId]),
    ]);

    if (org.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    res.json({ org: org.rows[0], members: members.rows, integrations: integrations.rows });
  } catch (err) {
    console.error(`GET /super/orgs/${req.params.orgId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Create a new org
router.post('/orgs', async (req, res) => {
  try {
    const { name, plan = 'free', max_users = 10, notes = '' } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Organisation name is required' } });
    }

    const result = await pool.query(`
      INSERT INTO organizations (name, plan, max_users, notes, status, created_at)
      VALUES ($1, $2, $3, $4, 'active', now())
      RETURNING *
    `, [name.trim(), plan, max_users, notes]);

    await auditLog(req, 'create_org', 'org', result.rows[0].id, { name, plan });
    res.status(201).json({ org: result.rows[0] });
  } catch (err) {
    console.error('POST /super/orgs error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Update org details
router.patch('/orgs/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { name, plan, max_users, notes, status } = req.body;

    const result = await pool.query(`
      UPDATE organizations
      SET
        name      = COALESCE($1, name),
        plan      = COALESCE($2, plan),
        max_users = COALESCE($3, max_users),
        notes     = COALESCE($4, notes),
        status    = COALESCE($5, status)
      WHERE id = $6
      RETURNING *
    `, [name, plan, max_users, notes, status, orgId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    await auditLog(req, 'update_org', 'org', parseInt(orgId), req.body);
    res.json({ org: result.rows[0] });
  } catch (err) {
    console.error(`PATCH /super/orgs/${req.params.orgId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Suspend / unsuspend org
router.post('/orgs/:orgId/suspend', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { suspend, reason } = req.body; // suspend: true|false

    const result = await pool.query(`
      UPDATE organizations
      SET
        status       = $1,
        suspended_at = $2,
        suspended_by = $3,
        notes        = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE notes END
      WHERE id = $5
      RETURNING *
    `, [
      suspend ? 'suspended' : 'active',
      suspend ? new Date() : null,
      suspend ? req.userId : null,
      reason || null,
      orgId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    await auditLog(req, suspend ? 'suspend_org' : 'unsuspend_org', 'org', parseInt(orgId), { reason });
    res.json({ org: result.rows[0] });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/suspend error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// USERS WITHIN AN ORG (super admin view — can add users to any org)
// ═════════════════════════════════════════════════════════════════════════════

// Add existing user to org
router.post('/orgs/:orgId/users', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, role = 'member' } = req.body;

    const userResult = await pool.query(
      'SELECT id, email, name FROM users WHERE email = $1', [email]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found. They must register first.' } });
    }

    const user = userResult.rows[0];

    // Check seat limit
    const [countRow, orgRow] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE', [orgId]),
      pool.query('SELECT max_users FROM organizations WHERE id = $1', [orgId]),
    ]);
    if (parseInt(countRow.rows[0].count) >= parseInt(orgRow.rows[0].max_users)) {
      return res.status(400).json({ error: { message: 'Org has reached its user seat limit' } });
    }

    await pool.query(`
      INSERT INTO org_users (org_id, user_id, role, is_active, joined_at)
      VALUES ($1, $2, $3, TRUE, now())
      ON CONFLICT (org_id, user_id) DO UPDATE
        SET role = $3, is_active = TRUE
    `, [orgId, user.id, role]);

    await auditLog(req, 'add_user_to_org', 'user', user.id, { orgId, role });
    res.status(201).json({ message: 'User added', user: { ...user, role } });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/users error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Update a user's role in an org
router.patch('/orgs/:orgId/users/:userId', async (req, res) => {
  try {
    const { orgId, userId } = req.params;
    const { role, is_active } = req.body;

    // Prevent removing the last owner
    if (role && role !== 'owner') {
      const ownerCheck = await pool.query(
        `SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND role = 'owner' AND is_active = TRUE AND user_id != $2`,
        [orgId, userId]
      );
      const currentRole = await pool.query(
        `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [orgId, userId]
      );
      if (currentRole.rows[0]?.role === 'owner' && parseInt(ownerCheck.rows[0].count) === 0) {
        return res.status(400).json({ error: { message: 'Cannot change role of the last owner. Promote another user to owner first.' } });
      }
    }

    const result = await pool.query(`
      UPDATE org_users
      SET
        role      = COALESCE($1, role),
        is_active = COALESCE($2, is_active)
      WHERE org_id = $3 AND user_id = $4
      RETURNING *
    `, [role, is_active, orgId, userId]);

    await auditLog(req, 'update_user_in_org', 'user', parseInt(userId), { orgId, role, is_active });
    res.json({ membership: result.rows[0] });
  } catch (err) {
    console.error(`PATCH /super/orgs/${req.params.orgId}/users/${req.params.userId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Remove user from org
router.delete('/orgs/:orgId/users/:userId', async (req, res) => {
  try {
    const { orgId, userId } = req.params;

    await pool.query(
      `UPDATE org_users SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId]
    );

    await auditLog(req, 'remove_user_from_org', 'user', parseInt(userId), { orgId });
    res.json({ message: 'User removed from org' });
  } catch (err) {
    console.error(`DELETE /super/orgs/${req.params.orgId}/users/${req.params.userId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// IMPERSONATION — super admin borrows org context for support
// ═════════════════════════════════════════════════════════════════════════════

router.post('/orgs/:orgId/impersonate', async (req, res) => {
  try {
    const { orgId } = req.params;

    const orgResult = await pool.query(
      'SELECT id, name, status FROM organizations WHERE id = $1', [orgId]
    );
    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    await auditLog(req, 'impersonate_org', 'org', parseInt(orgId), {});

    // Return a support context token (the frontend stores this separately
    // and sends it as X-Support-Org-Id header — handled in orgContext middleware)
    res.json({
      message:         `Now supporting org: ${orgResult.rows[0].name}`,
      supportOrgId:    orgResult.rows[0].id,
      supportOrgName:  orgResult.rows[0].name,
    });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/impersonate error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SUPER ADMINS — manage who has platform-level access
// ═════════════════════════════════════════════════════════════════════════════

router.get('/admins', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sa.id, sa.user_id, sa.granted_at, sa.revoked_at, sa.notes,
             u.email, u.first_name || ' ' || u.last_name AS name,
             g.email AS granted_by_email
      FROM   super_admins sa
      JOIN   users u  ON u.id  = sa.user_id
      LEFT JOIN users g ON g.id = sa.granted_by
      ORDER  BY sa.granted_at DESC
    `);
    res.json({ admins: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/admins', async (req, res) => {
  try {
    const { email, notes = '' } = req.body;
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const result = await pool.query(`
      INSERT INTO super_admins (user_id, granted_by, notes)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL, granted_by = $2, notes = $3
      RETURNING *
    `, [userResult.rows[0].id, req.userId, notes]);

    await auditLog(req, 'grant_super_admin', 'user', userResult.rows[0].id, { email });
    res.status(201).json({ admin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/admins/:userId', async (req, res) => {
  try {
    if (parseInt(req.params.userId) === req.userId) {
      return res.status(400).json({ error: { message: 'Cannot revoke your own super admin access' } });
    }

    await pool.query(
      `UPDATE super_admins SET revoked_at = now() WHERE user_id = $1`,
      [req.params.userId]
    );

    await auditLog(req, 'revoke_super_admin', 'user', parseInt(req.params.userId), {});
    res.json({ message: 'Super admin access revoked' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═════════════════════════════════════════════════════════════════════════════

router.get('/audit', async (req, res) => {
  try {
    const { page = 1, limit = 50, admin_id, action } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (admin_id) { conditions.push(`sal.super_admin_id = $${p++}`); params.push(admin_id); }
    if (action)   { conditions.push(`sal.action = $${p++}`);         params.push(action); }

    const where = conditions.join(' AND ');

    const result = await pool.query(`
      SELECT sal.*, u.email AS admin_email, u.first_name || ' ' || u.last_name AS admin_name
      FROM   super_admin_audit_log sal
      JOIN   users u ON u.id = sal.super_admin_id
      WHERE  ${where}
      ORDER  BY sal.created_at DESC
      LIMIT  $${p++} OFFSET $${p++}
    `, [...params, parseInt(limit), offset]);

    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
