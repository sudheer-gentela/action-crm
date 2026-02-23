// ─────────────────────────────────────────────────────────────────────────────
// deal-stages.routes.js
// Mount in server.js: app.use('/api/deal-stages', require('./routes/deal-stages.routes'));
//
// Org admins can:
//   - List all stages for their org
//   - Create custom stages (immutable key, mutable name)
//   - Rename stages (name only — key and stage_type are immutable after creation)
//   - Toggle active/inactive
//   - Reorder stages
//   - Delete custom stages (blocked if any deals are in that stage)
//
// System stages (seeded by migration) cannot be deleted.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken    = require('../middleware/auth.middleware');
const { orgContext }       = require('../middleware/orgContext.middleware');

router.use(authenticateToken);
router.use(orgContext);

// Valid stage_type enum — must match migration CHECK constraint
const VALID_STAGE_TYPES = [
  'awareness', 'discovery', 'evaluation', 'proposal',
  'negotiation', 'closing', 'closed_won', 'closed_lost', 'custom',
];

// ── Helper: org admin guard ───────────────────────────────────────────────────
async function requireOrgAdmin(req, res, next) {
  try {
    const result = await db.query(
      'SELECT role FROM users WHERE id = $1 AND org_id = $2',
      [req.user.userId, req.orgId]
    );
    const role = result.rows[0]?.role;
    if (role !== 'admin' && role !== 'owner') {
      return res.status(403).json({ error: { message: 'Org admin access required' } });
    }
    next();
  } catch (err) {
    console.error('requireOrgAdmin error:', err);
    res.status(500).json({ error: { message: 'Failed to verify permissions' } });
  }
}

// ── Helper: generate immutable key from name ──────────────────────────────────
function generateKey(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now();
}

// ── GET / — list all stages for this org ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         id, name, key, stage_type, is_terminal,
         sort_order, is_system, is_active, created_at, updated_at
       FROM deal_stages
       WHERE org_id = $1
       ORDER BY sort_order ASC, name ASC`,
      [req.orgId]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    console.error('Get deal stages error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch deal stages' } });
  }
});

// ── GET /active — active stages only (used by DealForm, DealsView) ───────────
router.get('/active', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, key, stage_type, is_terminal, sort_order, is_system
       FROM deal_stages
       WHERE org_id = $1 AND is_active = TRUE
       ORDER BY sort_order ASC, name ASC`,
      [req.orgId]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    console.error('Get active deal stages error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch active deal stages' } });
  }
});

// ── POST / — create a custom stage (admin only) ───────────────────────────────
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const { name, stage_type = 'custom', is_terminal = false } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Stage name is required' } });
    }

    if (!VALID_STAGE_TYPES.includes(stage_type)) {
      return res.status(400).json({
        error: { message: `stage_type must be one of: ${VALID_STAGE_TYPES.join(', ')}` }
      });
    }

    const key = generateKey(name);

    const result = await db.query(
      `INSERT INTO deal_stages
         (org_id, name, key, stage_type, is_terminal, is_system, is_active, sort_order)
       VALUES (
         $1, $2, $3, $4, $5, FALSE, TRUE,
         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM deal_stages WHERE org_id = $1)
       )
       RETURNING *`,
      [req.orgId, name.trim(), key, stage_type, !!is_terminal]
    );

    res.status(201).json({ stage: result.rows[0] });
  } catch (err) {
    console.error('Create deal stage error:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: { message: 'A stage with that name already exists' } });
    }
    res.status(500).json({ error: { message: 'Failed to create deal stage' } });
  }
});

// ── PATCH /:id — rename, toggle active, toggle is_terminal (admin only) ───────
// key and stage_type are intentionally not patchable — immutable after creation.
router.patch('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const { name, is_active, is_terminal } = req.body;

    const check = await db.query(
      'SELECT * FROM deal_stages WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const stage = check.rows[0];

    // System stages: name editable, other fields editable — only deletion is blocked
    const result = await db.query(
      `UPDATE deal_stages
       SET name        = COALESCE($1, name),
           is_active   = COALESCE($2, is_active),
           is_terminal = COALESCE($3, is_terminal),
           updated_at  = NOW()
       WHERE id = $4 AND org_id = $5
       RETURNING *`,
      [
        name?.trim() || null,
        is_active   !== undefined ? is_active   : null,
        is_terminal !== undefined ? is_terminal : null,
        req.params.id,
        req.orgId,
      ]
    );

    res.json({ stage: result.rows[0] });
  } catch (err) {
    console.error('Update deal stage error:', err);
    res.status(500).json({ error: { message: 'Failed to update deal stage' } });
  }
});

// ── POST /reorder — bulk sort_order update (admin only) ──────────────────────
// Body: { order: [ { id: uuid, sort_order: int }, ... ] }
router.post('/reorder', requireOrgAdmin, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: { message: 'order array is required' } });
    }

    // Validate all ids belong to this org before updating
    const ids = order.map(o => o.id);
    const check = await db.query(
      'SELECT id FROM deal_stages WHERE id = ANY($1::uuid[]) AND org_id = $2',
      [ids, req.orgId]
    );
    if (check.rows.length !== ids.length) {
      return res.status(400).json({ error: { message: 'One or more stage IDs not found in this org' } });
    }

    await db.query('BEGIN');
    for (const { id, sort_order } of order) {
      await db.query(
        'UPDATE deal_stages SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3',
        [sort_order, id, req.orgId]
      );
    }
    await db.query('COMMIT');

    const result = await db.query(
      `SELECT id, name, key, stage_type, is_terminal, sort_order, is_system, is_active
       FROM deal_stages WHERE org_id = $1 ORDER BY sort_order ASC`,
      [req.orgId]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Reorder deal stages error:', err);
    res.status(500).json({ error: { message: 'Failed to reorder stages' } });
  }
});

// ── DELETE /:id — custom stages only (admin only) ─────────────────────────────
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const check = await db.query(
      'SELECT is_system, name, key FROM deal_stages WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const stage = check.rows[0];

    if (stage.is_system) {
      return res.status(400).json({
        error: { message: 'System stages cannot be deleted. You can deactivate them instead.' }
      });
    }

    // Block deletion if any active deals are in this stage
    const dealsInStage = await db.query(
      `SELECT COUNT(*) AS count FROM deals
       WHERE org_id = $1 AND stage = $2 AND deleted_at IS NULL`,
      [req.orgId, stage.key]
    );
    const dealCount = parseInt(dealsInStage.rows[0].count);
    if (dealCount > 0) {
      return res.status(400).json({
        error: {
          message: `Cannot delete stage "${stage.name}" — ${dealCount} deal${dealCount !== 1 ? 's are' : ' is'} currently in this stage. Move or close them first.`
        }
      });
    }

    await db.query(
      'DELETE FROM deal_stages WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Delete deal stage error:', err);
    res.status(500).json({ error: { message: 'Failed to delete deal stage' } });
  }
});

module.exports = router;
