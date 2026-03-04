// ─────────────────────────────────────────────────────────────────────────────
// org-roles.routes.js
//
// CRUD for organization org roles.
// Mount: app.use('/api/org-roles', require('./routes/org-roles.routes'));
//
// GET    /              — list all active roles for org
// GET    /all           — list all roles including inactive
// POST   /              — create a new role (admin)
// PATCH  /:id           — update a role (admin)
// DELETE /:id           — soft-delete (deactivate) a role (admin)
// POST   /reorder       — bulk reorder roles (admin)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken           = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);
const adminOnly = requireRole('owner', 'admin');

// ── GET / — active roles ────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, key, is_system, is_active, sort_order, created_at
       FROM org_roles
       WHERE org_id = $1 AND is_active = TRUE
       ORDER BY sort_order ASC, name ASC`,
      [req.orgId]
    );
    res.json({ roles: result.rows });
  } catch (err) {
    console.error('Get org roles error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch roles' } });
  }
});

// ── GET /all — all roles including inactive ─────────────────────────────────

router.get('/all', adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT dr.id, dr.name, dr.key, dr.is_system, dr.is_active, dr.sort_order, dr.created_at,
              COUNT(DISTINCT dtm.id) AS member_count,
              COUNT(DISTINCT ppr.id) AS play_count,
              COUNT(DISTINCT pbr.playbook_id) AS playbook_count
       FROM org_roles dr
       LEFT JOIN deal_team_members dtm ON dtm.role_id = dr.id
       LEFT JOIN playbook_play_roles ppr ON ppr.role_id = dr.id
       LEFT JOIN playbook_roles pbr ON pbr.role_id = dr.id
       WHERE dr.org_id = $1
       GROUP BY dr.id
       ORDER BY dr.sort_order ASC, dr.name ASC`,
      [req.orgId]
    );
    res.json({ roles: result.rows });
  } catch (err) {
    console.error('Get all org roles error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch roles' } });
  }
});

// ── POST / — create role ────────────────────────────────────────────────────

router.post('/', adminOnly, async (req, res) => {
  try {
    const { name, key } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Role name is required' } });
    }

    // Auto-generate key from name if not provided
    const roleKey = (key?.trim() || name.trim())
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');

    // Check for duplicate key
    const existing = await db.query(
      `SELECT id FROM org_roles WHERE org_id = $1 AND key = $2`,
      [req.orgId, roleKey]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { message: `A role with key "${roleKey}" already exists` } });
    }

    // Get next sort_order
    const maxSort = await db.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM org_roles WHERE org_id = $1`,
      [req.orgId]
    );

    const result = await db.query(
      `INSERT INTO org_roles (org_id, name, key, is_system, is_active, sort_order)
       VALUES ($1, $2, $3, FALSE, TRUE, $4)
       RETURNING *`,
      [req.orgId, name.trim(), roleKey, maxSort.rows[0].next_order]
    );

    res.status(201).json({ role: result.rows[0] });
  } catch (err) {
    console.error('Create org role error:', err);
    res.status(500).json({ error: { message: 'Failed to create role' } });
  }
});

// ── PATCH /:id — update role ────────────────────────────────────────────────

router.patch('/:id', adminOnly, async (req, res) => {
  try {
    const { name, is_active } = req.body;

    // Verify role belongs to org
    const check = await db.query(
      `SELECT id, is_system FROM org_roles WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Role not found' } });
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      sets.push(`name = $${idx}`);
      params.push(name.trim());
      idx++;
    }
    if (is_active !== undefined) {
      sets.push(`is_active = $${idx}`);
      params.push(is_active);
      idx++;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    params.push(req.params.id, req.orgId);
    const result = await db.query(
      `UPDATE org_roles SET ${sets.join(', ')}
       WHERE id = $${idx} AND org_id = $${idx + 1}
       RETURNING *`,
      params
    );

    res.json({ role: result.rows[0] });
  } catch (err) {
    console.error('Update org role error:', err);
    res.status(500).json({ error: { message: 'Failed to update role' } });
  }
});

// ── DELETE /:id — soft delete (deactivate) ──────────────────────────────────

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const check = await db.query(
      `SELECT id, is_system, name FROM org_roles WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Role not found' } });
    }

    // Check if role is in use
    const usage = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM deal_team_members WHERE role_id = $1) AS team_count,
        (SELECT COUNT(*) FROM playbook_play_roles WHERE role_id = $1) AS play_count`,
      [req.params.id]
    );
    const { team_count, play_count } = usage.rows[0];

    if (parseInt(team_count) > 0 || parseInt(play_count) > 0) {
      // Soft delete — deactivate instead of hard delete
      await db.query(
        `UPDATE org_roles SET is_active = FALSE WHERE id = $1 AND org_id = $2`,
        [req.params.id, req.orgId]
      );
      return res.json({
        success: true,
        soft_deleted: true,
        message: `Role "${check.rows[0].name}" deactivated (still used by ${team_count} team members and ${play_count} plays)`,
      });
    }

    // Hard delete if unused
    await db.query(
      `DELETE FROM org_roles WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json({ success: true, soft_deleted: false });
  } catch (err) {
    console.error('Delete org role error:', err);
    res.status(500).json({ error: { message: 'Failed to delete role' } });
  }
});

// ── POST /reorder — bulk reorder ────────────────────────────────────────────

router.post('/reorder', adminOnly, async (req, res) => {
  try {
    const { roleIds } = req.body;
    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ error: { message: 'roleIds array is required' } });
    }

    for (let i = 0; i < roleIds.length; i++) {
      await db.query(
        `UPDATE org_roles SET sort_order = $1 WHERE id = $2 AND org_id = $3`,
        [i, roleIds[i], req.orgId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Reorder org roles error:', err);
    res.status(500).json({ error: { message: 'Failed to reorder roles' } });
  }
});

module.exports = router;
