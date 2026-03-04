const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext }       = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// ── Helper: verify deal belongs to this org and caller has access ─────────────
async function resolveDeal(req, res) {
  const result = await db.query(
    `SELECT id, user_id, org_id FROM deals WHERE id = $1 AND org_id = $2`,
    [req.params.dealId, req.orgId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: { message: 'Deal not found' } });
    return null;
  }
  return result.rows[0];
}

// ── Helper: caller is deal owner or org admin ────────────────────────────────
async function canManageTeam(req, deal) {
  if (deal.user_id === req.user.userId) return true;
  const r = await db.query(
    `SELECT role FROM users WHERE id = $1 AND org_id = $2`,
    [req.user.userId, req.orgId]
  );
  const role = r.rows[0]?.role;
  return role === 'admin' || role === 'owner';
}

// ── GET /:dealId/members — list team members ──────────────────────────────────
router.get('/:dealId/members', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const result = await db.query(
      `SELECT
         dtm.id,
         dtm.user_id,
         dtm.role_id,
         dtm.custom_role,
         dtm.created_at,
         u.first_name,
         u.last_name,
         u.email,
         dr.name  AS role_name,
         dr.key   AS role_key,
         dr.is_system AS role_is_system,
         ab.first_name AS added_by_first,
         ab.last_name  AS added_by_last
       FROM deal_team_members dtm
       JOIN users      u  ON u.id  = dtm.user_id
       LEFT JOIN org_roles  dr ON dr.id = dtm.role_id
       LEFT JOIN users      ab ON ab.id = dtm.added_by
       WHERE dtm.deal_id = $1 AND dtm.org_id = $2
       ORDER BY dtm.created_at`,
      [req.params.dealId, req.orgId]
    );

    res.json({
      members: result.rows.map(r => ({
        id:         r.id,
        userId:     r.user_id,
        name:       `${r.first_name} ${r.last_name}`.trim(),
        email:      r.email,
        roleId:     r.role_id,
        roleName:   r.custom_role || r.role_name || 'Team Member',
        roleKey:    r.role_key,
        customRole: r.custom_role,
        addedBy:    r.added_by_first ? `${r.added_by_first} ${r.added_by_last}`.trim() : null,
        addedAt:    r.created_at,
      }))
    });
  } catch (err) {
    console.error('Get deal team error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch deal team' } });
  }
});

// ── POST /:dealId/members — add a member ──────────────────────────────────────
router.post('/:dealId/members', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    if (!(await canManageTeam(req, deal))) {
      return res.status(403).json({ error: { message: 'Only the deal owner or org admin can manage the team' } });
    }

    const { userId, roleId, customRole } = req.body;
    if (!userId) {
      return res.status(400).json({ error: { message: 'userId is required' } });
    }

    // Verify the user being added belongs to this org
    const userCheck = await db.query(
      `SELECT id FROM users WHERE id = $1 AND org_id = $2`,
      [userId, req.orgId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(400).json({ error: { message: 'User is not a member of this organisation' } });
    }

    // Validate roleId belongs to this org if provided
    if (roleId) {
      const roleCheck = await db.query(
        `SELECT id FROM org_roles WHERE id = $1 AND org_id = $2 AND is_active = true`,
        [roleId, req.orgId]
      );
      if (roleCheck.rows.length === 0) {
        return res.status(400).json({ error: { message: 'Invalid role' } });
      }
    }

    const result = await db.query(
      `INSERT INTO deal_team_members (deal_id, org_id, user_id, role_id, custom_role, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (deal_id, user_id) DO UPDATE
         SET role_id = EXCLUDED.role_id,
             custom_role = EXCLUDED.custom_role
       RETURNING *`,
      [req.params.dealId, req.orgId, userId, roleId || null, customRole || null, req.user.userId]
    );

    // Fetch full member row with joins for the response
    const member = await db.query(
      `SELECT dtm.*, u.first_name, u.last_name, u.email, dr.name AS role_name, dr.key AS role_key
       FROM deal_team_members dtm
       JOIN users u ON u.id = dtm.user_id
       LEFT JOIN org_roles dr ON dr.id = dtm.role_id
       WHERE dtm.id = $1`,
      [result.rows[0].id]
    );
    const m = member.rows[0];

    res.status(201).json({
      member: {
        id:         m.id,
        userId:     m.user_id,
        name:       `${m.first_name} ${m.last_name}`.trim(),
        email:      m.email,
        roleId:     m.role_id,
        roleName:   m.custom_role || m.role_name || 'Team Member',
        roleKey:    m.role_key,
        customRole: m.custom_role,
        addedAt:    m.created_at,
      }
    });
  } catch (err) {
    console.error('Add deal team member error:', err);
    res.status(500).json({ error: { message: 'Failed to add team member' } });
  }
});

// ── PATCH /:dealId/members/:memberId — update role ───────────────────────────
router.patch('/:dealId/members/:memberId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    if (!(await canManageTeam(req, deal))) {
      return res.status(403).json({ error: { message: 'Only the deal owner or org admin can manage the team' } });
    }

    const { roleId, customRole } = req.body;

    const result = await db.query(
      `UPDATE deal_team_members
       SET role_id     = $1,
           custom_role = $2
       WHERE id = $3 AND deal_id = $4 AND org_id = $5
       RETURNING *`,
      [roleId || null, customRole || null, req.params.memberId, req.params.dealId, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Team member not found' } });
    }

    res.json({ success: true, member: result.rows[0] });
  } catch (err) {
    console.error('Update deal team member error:', err);
    res.status(500).json({ error: { message: 'Failed to update team member' } });
  }
});

// ── DELETE /:dealId/members/:memberId — remove a member ──────────────────────
router.delete('/:dealId/members/:memberId', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    if (!(await canManageTeam(req, deal))) {
      return res.status(403).json({ error: { message: 'Only the deal owner or org admin can manage the team' } });
    }

    const result = await db.query(
      `DELETE FROM deal_team_members
       WHERE id = $1 AND deal_id = $2 AND org_id = $3
       RETURNING id`,
      [req.params.memberId, req.params.dealId, req.orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Team member not found' } });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Remove deal team member error:', err);
    res.status(500).json({ error: { message: 'Failed to remove team member' } });
  }
});

// ── GET /:dealId/eligible — org members who can be added ────────────────────
// Returns org members not already on this deal's team
router.get('/:dealId/eligible', async (req, res) => {
  try {
    const deal = await resolveDeal(req, res);
    if (!deal) return;

    const result = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role AS org_role
       FROM users u
       WHERE u.org_id = $1
         AND u.id NOT IN (
           SELECT user_id FROM deal_team_members
           WHERE deal_id = $2
         )
       ORDER BY u.first_name, u.last_name`,
      [req.orgId, req.params.dealId]
    );

    res.json({
      users: result.rows.map(u => ({
        id:      u.id,
        name:    `${u.first_name} ${u.last_name}`.trim(),
        email:   u.email,
        orgRole: u.org_role,
      }))
    });
  } catch (err) {
    console.error('Get eligible members error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch eligible members' } });
  }
});

module.exports = router;
