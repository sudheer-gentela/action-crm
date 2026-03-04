// ─────────────────────────────────────────────────────────────────────────────
// playbook-plays.routes.js
//
// CRUD for playbook play definitions (template layer).
// Mount: app.use('/api/playbook-plays', require('./routes/playbook-plays.routes'));
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken           = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);
const adminOnly = requireRole('owner', 'admin');

// ── GET /playbook/:playbookId/stages/:stageKey ──────────────────────────────
// List all plays for a stage

router.get('/playbook/:playbookId/stages/:stageKey', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pp.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'role_id', ppr.role_id,
                    'role_name', dr.name,
                    'role_key', dr.key,
                    'ownership_type', ppr.ownership_type
                  )
                ) FILTER (WHERE ppr.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM playbook_plays pp
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN deal_roles dr ON dr.id = ppr.role_id
       WHERE pp.playbook_id = $1 AND pp.stage_key = $2 AND pp.org_id = $3
       GROUP BY pp.id
       ORDER BY pp.sort_order ASC`,
      [req.params.playbookId, req.params.stageKey, req.orgId]
    );

    res.json({
      plays: result.rows.map(r => ({
        ...r,
        roles: typeof r.roles === 'string' ? JSON.parse(r.roles) : r.roles,
      }))
    });
  } catch (err) {
    console.error('Get plays error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch plays' } });
  }
});

// ── GET /playbook/:playbookId/all ───────────────────────────────────────────
// All plays across all stages (for full playbook view)

router.get('/playbook/:playbookId/all', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pp.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'role_id', ppr.role_id,
                    'role_name', dr.name,
                    'role_key', dr.key,
                    'ownership_type', ppr.ownership_type
                  )
                ) FILTER (WHERE ppr.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM playbook_plays pp
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN deal_roles dr ON dr.id = ppr.role_id
       WHERE pp.playbook_id = $1 AND pp.org_id = $2
       GROUP BY pp.id
       ORDER BY pp.stage_key, pp.sort_order ASC`,
      [req.params.playbookId, req.orgId]
    );

    // Group by stage
    const byStage = {};
    for (const row of result.rows) {
      if (!byStage[row.stage_key]) byStage[row.stage_key] = [];
      byStage[row.stage_key].push({
        ...row,
        roles: typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles,
      });
    }

    res.json({ plays: byStage });
  } catch (err) {
    console.error('Get all plays error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch plays' } });
  }
});

// ── POST / ──────────────────────────────────────────────────────────────────
// Create a new play

router.post('/', adminOnly, async (req, res) => {
  try {
    const {
      playbookId, stageKey, title, description, channel,
      sortOrder, executionType, dependsOn, isGate,
      dueOffsetDays, priority, roleIds
    } = req.body;

    if (!playbookId || !stageKey || !title) {
      return res.status(400).json({ error: { message: 'playbookId, stageKey, and title are required' } });
    }

    // Verify playbook belongs to org
    const pbCheck = await db.query(
      `SELECT id FROM playbooks WHERE id = $1 AND org_id = $2`, [playbookId, req.orgId]
    );
    if (pbCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    // Auto sort_order if not specified
    let order = sortOrder;
    if (order == null) {
      const maxResult = await db.query(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
         FROM playbook_plays WHERE playbook_id = $1 AND stage_key = $2`,
        [playbookId, stageKey]
      );
      order = maxResult.rows[0].next_order;
    }

    const result = await db.query(
      `INSERT INTO playbook_plays (
         playbook_id, org_id, stage_key,
         title, description, channel,
         sort_order, execution_type, depends_on, is_gate,
         due_offset_days, priority
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        playbookId, req.orgId, stageKey,
        title, description || null, channel || null,
        order, executionType || 'parallel', dependsOn || null, isGate || false,
        dueOffsetDays || 3, priority || 'medium'
      ]
    );

    const play = result.rows[0];

    // Set role co-owners
    if (roleIds && roleIds.length > 0) {
      for (const roleId of roleIds) {
        await db.query(
          `INSERT INTO playbook_play_roles (play_id, role_id, ownership_type)
           VALUES ($1, $2, 'co_owner') ON CONFLICT DO NOTHING`,
          [play.id, roleId]
        );
      }
    }

    // Fetch with roles
    const full = await db.query(
      `SELECT pp.*,
              COALESCE(
                json_agg(
                  json_build_object('role_id', ppr.role_id, 'role_name', dr.name, 'role_key', dr.key, 'ownership_type', ppr.ownership_type)
                ) FILTER (WHERE ppr.id IS NOT NULL), '[]'
              ) AS roles
       FROM playbook_plays pp
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN deal_roles dr ON dr.id = ppr.role_id
       WHERE pp.id = $1
       GROUP BY pp.id`,
      [play.id]
    );

    res.status(201).json({
      play: {
        ...full.rows[0],
        roles: typeof full.rows[0].roles === 'string' ? JSON.parse(full.rows[0].roles) : full.rows[0].roles,
      }
    });
  } catch (err) {
    console.error('Create play error:', err);
    res.status(500).json({ error: { message: 'Failed to create play' } });
  }
});

// ── PATCH /:playId ──────────────────────────────────────────────────────────
// Update a play definition

router.patch('/:playId', adminOnly, async (req, res) => {
  try {
    const {
      title, description, channel, sortOrder, executionType,
      dependsOn, isGate, dueOffsetDays, priority, isActive
    } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    const addSet = (col, val) => {
      if (val !== undefined) {
        sets.push(`${col} = $${idx}`);
        params.push(val);
        idx++;
      }
    };

    addSet('title', title);
    addSet('description', description);
    addSet('channel', channel);
    addSet('sort_order', sortOrder);
    addSet('execution_type', executionType);
    addSet('depends_on', dependsOn);
    addSet('is_gate', isGate);
    addSet('due_offset_days', dueOffsetDays);
    addSet('priority', priority);
    addSet('is_active', isActive);

    if (sets.length === 0) {
      return res.status(400).json({ error: { message: 'No fields to update' } });
    }

    sets.push(`updated_at = NOW()`);

    params.push(req.params.playId, req.orgId);
    const result = await db.query(
      `UPDATE playbook_plays SET ${sets.join(', ')}
       WHERE id = $${idx} AND org_id = $${idx + 1}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Play not found' } });
    }

    res.json({ play: result.rows[0] });
  } catch (err) {
    console.error('Update play error:', err);
    res.status(500).json({ error: { message: 'Failed to update play' } });
  }
});

// ── PUT /:playId/roles ──────────────────────────────────────────────────────
// Replace all role assignments for a play

router.put('/:playId/roles', adminOnly, async (req, res) => {
  try {
    const { roles } = req.body;  // [{ roleId, ownershipType }]

    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: { message: 'roles array is required' } });
    }

    // Verify play belongs to org
    const check = await db.query(
      `SELECT id FROM playbook_plays WHERE id = $1 AND org_id = $2`,
      [req.params.playId, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Play not found' } });
    }

    // Clear existing
    await db.query(`DELETE FROM playbook_play_roles WHERE play_id = $1`, [req.params.playId]);

    // Insert new
    for (const r of roles) {
      await db.query(
        `INSERT INTO playbook_play_roles (play_id, role_id, ownership_type)
         VALUES ($1, $2, $3)`,
        [req.params.playId, r.roleId, r.ownershipType || 'co_owner']
      );
    }

    // Return updated
    const result = await db.query(
      `SELECT ppr.*, dr.name AS role_name, dr.key AS role_key
       FROM playbook_play_roles ppr
       JOIN deal_roles dr ON dr.id = ppr.role_id
       WHERE ppr.play_id = $1`,
      [req.params.playId]
    );

    res.json({ roles: result.rows });
  } catch (err) {
    console.error('Set play roles error:', err);
    res.status(500).json({ error: { message: 'Failed to set roles' } });
  }
});

// ── DELETE /:playId ─────────────────────────────────────────────────────────

router.delete('/:playId', adminOnly, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM playbook_plays WHERE id = $1 AND org_id = $2 RETURNING id`,
      [req.params.playId, req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Play not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete play error:', err);
    res.status(500).json({ error: { message: 'Failed to delete play' } });
  }
});

// ── POST /reorder ───────────────────────────────────────────────────────────
// Bulk reorder plays within a stage
// Body: { playbookId, stageKey, playIds: [3, 1, 4, 2] }

router.post('/reorder', adminOnly, async (req, res) => {
  try {
    const { playbookId, stageKey, playIds } = req.body;

    if (!playbookId || !stageKey || !Array.isArray(playIds)) {
      return res.status(400).json({ error: { message: 'playbookId, stageKey, and playIds are required' } });
    }

    for (let i = 0; i < playIds.length; i++) {
      await db.query(
        `UPDATE playbook_plays SET sort_order = $1, updated_at = NOW()
         WHERE id = $2 AND playbook_id = $3 AND stage_key = $4 AND org_id = $5`,
        [i, playIds[i], playbookId, stageKey, req.orgId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Reorder plays error:', err);
    res.status(500).json({ error: { message: 'Failed to reorder plays' } });
  }
});

module.exports = router;
