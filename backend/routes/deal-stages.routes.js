// ─────────────────────────────────────────────────────────────────────────────
// deal-stages.routes.js
// Org-admin–only management of deal stages.
//
// Key design decision: deals.stage stores the key string (VARCHAR 50).
// To allow key renames without orphaning deals, a PUT that changes the key
// runs a cascading UPDATE on deals inside the same transaction.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── Validation helpers ────────────────────────────────────────────────────────

// Keys must be lowercase, alphanumeric + underscores, 1-50 chars.
// This matches the VARCHAR(50) column and keeps keys safe for use as
// identifiers in playbooks / rules engine.
function isValidKey(key) {
  return typeof key === 'string' && /^[a-z0-9_]{1,50}$/.test(key);
}

const VALID_STAGE_TYPES = ['pipeline', 'won', 'lost', 'custom'];

// ── GET /deal-stages ──────────────────────────────────────────────────────────
// Returns all stages for this org, ordered by sort_order.

router.get('/', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, key, name, stage_type, sort_order, is_active, is_terminal, color, description
       FROM deal_stages
       WHERE org_id = $1
       ORDER BY sort_order ASC, id ASC`,
      [req.orgId]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /deal-stages ─────────────────────────────────────────────────────────
// Creates a new stage. Key must be unique within the org.

router.post('/', adminOnly, async (req, res) => {
  try {
    const {
      key,
      name,
      stage_type  = 'pipeline',
      sort_order,
      is_active   = true,
      is_terminal = false,
      color       = null,
      description = null,
    } = req.body;

    if (!key?.trim()) {
      return res.status(400).json({ error: { message: 'key is required' } });
    }
    if (!isValidKey(key)) {
      return res.status(400).json({
        error: { message: 'key must be lowercase letters, numbers, or underscores (max 50 chars)' },
      });
    }
    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'name is required' } });
    }
    if (!VALID_STAGE_TYPES.includes(stage_type)) {
      return res.status(400).json({
        error: { message: `stage_type must be one of: ${VALID_STAGE_TYPES.join(', ')}` },
      });
    }

    // Determine sort_order: caller can specify; otherwise append after current max.
    let resolvedOrder = sort_order;
    if (resolvedOrder == null) {
      const maxRow = await pool.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM deal_stages WHERE org_id = $1`,
        [req.orgId]
      );
      resolvedOrder = parseInt(maxRow.rows[0].max_order) + 10;
    }

    const result = await pool.query(
      `INSERT INTO deal_stages
         (org_id, key, name, stage_type, sort_order, is_active, is_terminal, color, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, key, name, stage_type, sort_order, is_active, is_terminal, color, description`,
      [
        req.orgId,
        key.trim(),
        name.trim(),
        stage_type,
        resolvedOrder,
        is_active,
        is_terminal,
        color,
        description,
      ]
    );

    res.status(201).json({ stage: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation — UNIQUE(org_id, key)
      return res.status(409).json({
        error: { message: `A stage with key "${req.body.key}" already exists in this organisation` },
      });
    }
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PUT /deal-stages/:id ──────────────────────────────────────────────────────
// Updates a stage. If the key changes, cascades the rename to deals.stage and
// actions.deal_stage in the same transaction so nothing is orphaned.

router.put('/:id', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      key,
      name,
      stage_type,
      sort_order,
      is_active,
      is_terminal,
      color,
      description,
    } = req.body;

    // Load the current row first so we know the old key.
    const current = await client.query(
      `SELECT * FROM deal_stages WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const existing = current.rows[0];

    // Validate the incoming key if it's being changed.
    const newKey = key !== undefined ? key.trim() : existing.key;
    if (newKey !== existing.key) {
      if (!isValidKey(newKey)) {
        return res.status(400).json({
          error: { message: 'key must be lowercase letters, numbers, or underscores (max 50 chars)' },
        });
      }
    }

    if (stage_type !== undefined && !VALID_STAGE_TYPES.includes(stage_type)) {
      return res.status(400).json({
        error: { message: `stage_type must be one of: ${VALID_STAGE_TYPES.join(', ')}` },
      });
    }

    await client.query('BEGIN');

    // ── Cascade key rename ────────────────────────────────────────────────────
    // If the key is changing we update every row that currently stores the old
    // key string. This keeps deals.stage and actions.deal_stage consistent
    // without requiring a schema change or FK column.
    if (newKey !== existing.key) {
      await client.query(
        `UPDATE deals
         SET stage = $1, updated_at = NOW()
         WHERE org_id = $2 AND stage = $3`,
        [newKey, req.orgId, existing.key]
      );

      // actions.deal_stage is a denormalized snapshot — update it too.
      await client.query(
        `UPDATE actions
         SET deal_stage = $1
         WHERE org_id = $2 AND deal_stage = $3`,
        [newKey, req.orgId, existing.key]
      );
    }

    // ── Update the stage row itself ───────────────────────────────────────────
    const updated = await client.query(
      `UPDATE deal_stages
       SET
         key         = $1,
         name        = COALESCE($2, name),
         stage_type  = COALESCE($3, stage_type),
         sort_order  = COALESCE($4, sort_order),
         is_active   = COALESCE($5, is_active),
         is_terminal = COALESCE($6, is_terminal),
         color       = COALESCE($7, color),
         description = COALESCE($8, description)
       WHERE id = $9 AND org_id = $10
       RETURNING id, key, name, stage_type, sort_order, is_active, is_terminal, color, description`,
      [
        newKey,
        name        !== undefined ? name.trim()  : null,
        stage_type  !== undefined ? stage_type   : null,
        sort_order  !== undefined ? sort_order   : null,
        is_active   !== undefined ? is_active    : null,
        is_terminal !== undefined ? is_terminal  : null,
        color       !== undefined ? color        : null,
        description !== undefined ? description  : null,
        id,
        req.orgId,
      ]
    );

    await client.query('COMMIT');
    res.json({ stage: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({
        error: { message: `A stage with that key already exists in this organisation` },
      });
    }
    res.status(500).json({ error: { message: err.message } });
  } finally {
    client.release();
  }
});

// ── PATCH /deal-stages/reorder ────────────────────────────────────────────────
// Accepts an ordered array of stage IDs and reassigns sort_order values.
// Body: { order: [id1, id2, id3, ...] }

router.patch('/reorder', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: { message: 'order must be a non-empty array of stage IDs' } });
    }

    await client.query('BEGIN');

    for (let i = 0; i < order.length; i++) {
      await client.query(
        `UPDATE deal_stages SET sort_order = $1 WHERE id = $2 AND org_id = $3`,
        [(i + 1) * 10, order[i], req.orgId]
      );
    }

    await client.query('COMMIT');

    // Return the full updated list so the frontend can re-render without a
    // second round-trip.
    const result = await pool.query(
      `SELECT id, key, name, stage_type, sort_order, is_active, is_terminal, color, description
       FROM deal_stages
       WHERE org_id = $1
       ORDER BY sort_order ASC, id ASC`,
      [req.orgId]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: err.message } });
  } finally {
    client.release();
  }
});

// ── DELETE /deal-stages/:id ───────────────────────────────────────────────────
// Prevents deletion if any active (non-deleted) deals are on this stage.
// Soft-deletion is done by setting is_active = false rather than removing the
// row, which would otherwise orphan historical deal records.

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const stage = await pool.query(
      `SELECT key, name FROM deal_stages WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (stage.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const { key, name } = stage.rows[0];

    // Block hard delete if live deals use this stage.
    const dealCount = await pool.query(
      `SELECT COUNT(*) AS count
       FROM deals
       WHERE org_id = $1 AND stage = $2 AND deleted_at IS NULL`,
      [req.orgId, key]
    );
    const count = parseInt(dealCount.rows[0].count);
    if (count > 0) {
      return res.status(409).json({
        error: {
          message: `Cannot delete stage "${name}" — ${count} active deal${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} currently in this stage. Move or close those deals first, or deactivate the stage instead.`,
        },
      });
    }

    // Also check total_count (including deleted deals) to decide hard vs soft.
    const totalCount = await pool.query(
      `SELECT COUNT(*) AS count FROM deals WHERE org_id = $1 AND stage = $2`,
      [req.orgId, key]
    );
    const totalDeals = parseInt(totalCount.rows[0].count);

    if (totalDeals > 0) {
      // Historical deals reference this key — soft delete to preserve history.
      await pool.query(
        `UPDATE deal_stages SET is_active = FALSE WHERE id = $1 AND org_id = $2`,
        [id, req.orgId]
      );
      return res.json({
        message: `Stage "${name}" deactivated (it has historical deal records and cannot be permanently deleted).`,
        action: 'deactivated',
      });
    }

    // No deals ever used this stage — safe to hard delete.
    await pool.query(
      `DELETE FROM deal_stages WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    res.json({ message: `Stage "${name}" deleted.`, action: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
