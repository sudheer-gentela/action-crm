const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext }       = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: org-admin guard ───────────────────────────────────────────────────
async function requireOrgAdmin(req, res, next) {
  const result = await db.query(
    `SELECT role FROM users WHERE id = $1 AND org_id = $2`,
    [req.user.userId, req.orgId]
  );
  const role = result.rows[0]?.role;
  if (role !== 'admin' && role !== 'owner') {
    return res.status(403).json({ error: { message: 'Org admin access required' } });
  }
  next();
}

// ── GET / — list all active roles for this org ────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, key, is_system, is_active, sort_order
       FROM deal_roles
       WHERE org_id = $1
       ORDER BY sort_order, name`,
      [req.orgId]
    );
    res.json({ roles: result.rows });
  } catch (err) {
    console.error('Get deal roles error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch deal roles' } });
  }
});

// ── POST / — create a custom role (org admin only) ────────────────────────────
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Role name is required' } });
    }

    // Generate a url-safe key from the name
    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now();

    const result = await db.query(
      `INSERT INTO deal_roles (org_id, name, key, is_system, is_active, sort_order)
       VALUES ($1, $2, $3, false, true,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM deal_roles WHERE org_id = $1))
       RETURNING *`,
      [req.orgId, name.trim(), key]
    );
    res.status(201).json({ role: result.rows[0] });
  } catch (err) {
    console.error('Create deal role error:', err);
    res.status(500).json({ error: { message: 'Failed to create deal role' } });
  }
});

// ── PATCH /:id — rename or toggle active (org admin only) ─────────────────────
router.patch('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const { name, is_active } = req.body;

    // Fetch current role to guard system roles
    const check = await db.query(
      `SELECT * FROM deal_roles WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Role not found' } });
    }
    const role = check.rows[0];

    // System roles: cannot be renamed, only toggled
    if (role.is_system && name && name.trim() !== role.name) {
      return res.status(400).json({ error: { message: 'System roles cannot be renamed' } });
    }

    const result = await db.query(
      `UPDATE deal_roles
       SET name      = COALESCE($1, name),
           is_active = COALESCE($2, is_active)
       WHERE id = $3 AND org_id = $4
       RETURNING *`,
      [
        role.is_system ? null : name?.trim() || null,
        is_active !== undefined ? is_active : null,
        req.params.id,
        req.orgId,
      ]
    );
    res.json({ role: result.rows[0] });
  } catch (err) {
    console.error('Update deal role error:', err);
    res.status(500).json({ error: { message: 'Failed to update deal role' } });
  }
});

// ── DELETE /:id — delete custom role only (org admin only) ───────────────────
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const check = await db.query(
      `SELECT is_system FROM deal_roles WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Role not found' } });
    }
    if (check.rows[0].is_system) {
      return res.status(400).json({ error: { message: 'System roles cannot be deleted. You can deactivate them instead.' } });
    }

    // Null out role_id on any team members using this role before deleting
    await db.query(
      `UPDATE deal_team_members SET role_id = NULL WHERE role_id = $1`,
      [req.params.id]
    );
    await db.query(
      `DELETE FROM deal_roles WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Delete deal role error:', err);
    res.status(500).json({ error: { message: 'Failed to delete deal role' } });
  }
});

module.exports = router;
