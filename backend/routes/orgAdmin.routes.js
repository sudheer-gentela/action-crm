// ─────────────────────────────────────────────────────────────────────────────
// orgAdmin.routes.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── Org Profile ───────────────────────────────────────────────────────────────

router.get('/profile', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, status, plan, max_users, created_at FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    res.json({ org: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.patch('/profile', adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Name is required' } });
    }
    const result = await pool.query(
      `UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id, name`,
      [name.trim(), req.orgId]
    );
    res.json({ org: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Members ───────────────────────────────────────────────────────────────────

router.get('/members', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ou.user_id, ou.role, ou.is_active, ou.joined_at,
        u.email,
        u.first_name || ' ' || u.last_name AS name,
        (SELECT COUNT(*) FROM actions a
         WHERE a.user_id = ou.user_id AND a.org_id = ou.org_id) AS action_count
      FROM org_users ou
      JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1
      ORDER BY ou.role, u.first_name
    `, [req.orgId]);

    res.json({ members: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.patch('/members/:userId', adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role }   = req.body;

    const VALID_ROLES = ['owner', 'admin', 'member', 'viewer'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: { message: `Role must be one of: ${VALID_ROLES.join(', ')}` } });
    }

    if (role === 'owner') {
      const callerRole = await pool.query(
        `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`,
        [req.orgId, req.userId]
      );
      if (callerRole.rows[0]?.role !== 'owner') {
        return res.status(403).json({ error: { message: 'Only owners can promote to owner' } });
      }
    }

    const currentRole = await pool.query(
      `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`,
      [req.orgId, userId]
    );
    if (currentRole.rows[0]?.role === 'owner' && role !== 'owner') {
      const ownerCount = await pool.query(
        `SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND role = 'owner' AND is_active = TRUE`,
        [req.orgId]
      );
      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: { message: 'Cannot change the role of the last owner' } });
      }
    }

    const result = await pool.query(`
      UPDATE org_users SET role = $1
      WHERE org_id = $2 AND user_id = $3
      RETURNING *
    `, [role, req.orgId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Member not found in this org' } });
    }
    res.json({ membership: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/members/:userId', adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;

    if (parseInt(userId) === req.userId) {
      return res.status(400).json({ error: { message: 'You cannot remove yourself' } });
    }

    const targetRole = await pool.query(
      `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
      [req.orgId, userId]
    );
    if (targetRole.rows[0]?.role === 'owner') {
      const ownerCount = await pool.query(
        `SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND role = 'owner' AND is_active = TRUE`,
        [req.orgId]
      );
      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: { message: 'Cannot remove the last owner' } });
      }
    }

    await pool.query(
      `UPDATE org_users SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
      [req.orgId, userId]
    );
    res.json({ message: 'Member deactivated' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Invitations ───────────────────────────────────────────────────────────────

router.get('/invitations', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT oi.*, u.email AS invited_by_email
      FROM   org_invitations oi
      LEFT JOIN users u ON u.id = oi.invited_by
      WHERE  oi.org_id = $1
      ORDER  BY oi.created_at DESC
    `, [req.orgId]);
    res.json({ invitations: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/invitations', adminOnly, async (req, res) => {
  try {
    const { email, role = 'member', message = '' } = req.body;

    if (!email?.trim()) {
      return res.status(400).json({ error: { message: 'Email is required' } });
    }

    const existing = await pool.query(`
      SELECT ou.user_id FROM org_users ou
      JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1 AND u.email = $2 AND ou.is_active = TRUE
    `, [req.orgId, email.trim()]);

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: { message: 'This person is already a member of your org' } });
    }

    const [countRow, orgRow] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE`, [req.orgId]),
      pool.query(`SELECT max_users FROM organizations WHERE id = $1`, [req.orgId]),
    ]);
    if (parseInt(countRow.rows[0].count) >= parseInt(orgRow.rows[0].max_users)) {
      return res.status(400).json({ error: { message: 'You have reached your user seat limit. Contact support to upgrade.' } });
    }

    const token   = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await pool.query(`
      INSERT INTO org_invitations
        (org_id, invited_by, email, role, message, token, expires_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
    `, [req.orgId, req.userId, email.trim(), role, message, token, expires]);

    res.status(201).json({ invitation: result.rows[0], token });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/invitations/:id', adminOnly, async (req, res) => {
  try {
    await pool.query(
      `UPDATE org_invitations SET status = 'cancelled' WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json({ message: 'Invitation cancelled' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', adminOnly, async (req, res) => {
  try {
    const [members, deals, actions, invites] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_active = TRUE)  AS active,
          COUNT(*) FILTER (WHERE is_active = FALSE) AS inactive
        FROM org_users WHERE org_id = $1
      `, [req.orgId]),
      pool.query(`SELECT COUNT(*) AS total FROM deals WHERE org_id = $1`, [req.orgId]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
          COUNT(*) FILTER (WHERE status = 'pending')                      AS pending
        FROM actions WHERE org_id = $1
      `, [req.orgId]),
      pool.query(`SELECT COUNT(*) AS total FROM org_invitations WHERE org_id = $1 AND status = 'pending'`, [req.orgId]),
    ]);

    res.json({
      members:     members.rows[0],
      deals:       deals.rows[0],
      actions:     actions.rows[0],
      invitations: invites.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
