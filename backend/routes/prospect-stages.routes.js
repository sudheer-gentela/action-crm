// ─────────────────────────────────────────────────────────────────────────────
// prospect-stages.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// CRUD + reorder for org-customisable prospect lifecycle stages.
// Mirrors deal-stages.routes.js with prospect-specific stage types and
// cascade logic for prospects.stage.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// Exact columns that exist in prospect_stages
const SELECT_COLS = `id, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color`;

function isValidKey(key) {
  return typeof key === 'string' && /^[a-z0-9_]{1,100}$/.test(key);
}

const VALID_STAGE_TYPES = [
  'targeting', 'research', 'outreach', 'engagement',
  'qualification', 'converted', 'disqualified', 'nurture', 'custom',
];

// ── GET /prospect-stages ──────────────────────────────────────────────────────
// Returns all stages for the org (admin view) or only active stages (everyone).

router.get('/', async (req, res) => {
  try {
    const isAdmin = ['owner', 'admin'].includes(req.orgRole);
    const activeFilter = isAdmin ? '' : 'AND is_active = TRUE';

    const result = await pool.query(
      `SELECT ${SELECT_COLS}
       FROM prospect_stages
       WHERE org_id = $1 ${activeFilter}
       ORDER BY sort_order ASC, id ASC`,
      [req.orgId]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /prospect-stages ─────────────────────────────────────────────────────

router.post('/', adminOnly, async (req, res) => {
  try {
    const {
      name,
      stage_type  = 'custom',
      sort_order,
      is_active   = true,
      is_terminal = false,
      color       = null,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'name is required' } });
    }
    if (!VALID_STAGE_TYPES.includes(stage_type)) {
      return res.status(400).json({
        error: { message: `stage_type must be one of: ${VALID_STAGE_TYPES.join(', ')}` },
      });
    }

    // Auto-generate key from name
    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    let resolvedOrder = sort_order;
    if (resolvedOrder == null) {
      const maxRow = await pool.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM prospect_stages WHERE org_id = $1`,
        [req.orgId]
      );
      resolvedOrder = parseInt(maxRow.rows[0].max_order) + 10;
    }

    const result = await pool.query(
      `INSERT INTO prospect_stages (org_id, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
       RETURNING ${SELECT_COLS}`,
      [req.orgId, key, name.trim(), stage_type, resolvedOrder, is_active, is_terminal, color]
    );

    res.status(201).json({ stage: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { message: `A stage with that key already exists. Try a different name.` },
      });
    }
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PUT /prospect-stages/:id ──────────────────────────────────────────────────
// Cascades key rename to prospects.stage in one transaction.

router.put('/:id', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { key, name, stage_type, sort_order, is_active, is_terminal, color } = req.body;

    const current = await client.query(
      `SELECT * FROM prospect_stages WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const existing = current.rows[0];

    const newKey = key !== undefined ? key.trim() : existing.key;
    if (newKey !== existing.key && !isValidKey(newKey)) {
      return res.status(400).json({
        error: { message: 'key must be lowercase letters, numbers, or underscores' },
      });
    }
    if (stage_type !== undefined && !VALID_STAGE_TYPES.includes(stage_type)) {
      return res.status(400).json({
        error: { message: `stage_type must be one of: ${VALID_STAGE_TYPES.join(', ')}` },
      });
    }

    await client.query('BEGIN');

    // Cascade key rename to prospects table
    if (newKey !== existing.key) {
      await client.query(
        `UPDATE prospects SET stage = $1, updated_at = NOW() WHERE org_id = $2 AND stage = $3`,
        [newKey, req.orgId, existing.key]
      );
      // Also cascade to prospecting_actions if they reference stage
      // (future-proofing for action filters)
    }

    const updated = await client.query(
      `UPDATE prospect_stages
       SET
         key         = $1,
         name        = COALESCE($2, name),
         stage_type  = COALESCE($3, stage_type),
         sort_order  = COALESCE($4, sort_order),
         is_active   = COALESCE($5, is_active),
         is_terminal = COALESCE($6, is_terminal),
         color       = COALESCE($7, color),
         updated_at  = NOW()
       WHERE id = $8 AND org_id = $9
       RETURNING ${SELECT_COLS}`,
      [
        newKey,
        name        !== undefined ? name.trim() : null,
        stage_type  !== undefined ? stage_type  : null,
        sort_order  !== undefined ? sort_order  : null,
        is_active   !== undefined ? is_active   : null,
        is_terminal !== undefined ? is_terminal : null,
        color       !== undefined ? color       : null,
        id,
        req.orgId,
      ]
    );

    await client.query('COMMIT');
    res.json({ stage: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: 'A stage with that key already exists' } });
    }
    res.status(500).json({ error: { message: err.message } });
  } finally {
    client.release();
  }
});

// ── PATCH /prospect-stages/reorder ────────────────────────────────────────────

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
        `UPDATE prospect_stages SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
        [(i + 1) * 10, order[i], req.orgId]
      );
    }
    await client.query('COMMIT');

    const result = await pool.query(
      `SELECT ${SELECT_COLS} FROM prospect_stages WHERE org_id = $1 ORDER BY sort_order ASC, id ASC`,
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

// ── DELETE /prospect-stages/:id ───────────────────────────────────────────────

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const stage = await pool.query(
      `SELECT key, name, is_system FROM prospect_stages WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (stage.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const { key, name, is_system } = stage.rows[0];

    // System stages cannot be hard-deleted, only deactivated
    if (is_system) {
      return res.status(403).json({
        error: { message: `"${name}" is a system stage. Deactivate it instead of deleting.` },
      });
    }

    // Check for active prospects in this stage
    const activeProspects = await pool.query(
      `SELECT COUNT(*) AS count FROM prospects WHERE org_id = $1 AND stage = $2 AND deleted_at IS NULL`,
      [req.orgId, key]
    );
    const count = parseInt(activeProspects.rows[0].count);
    if (count > 0) {
      return res.status(409).json({
        error: {
          message: `Cannot delete "${name}" — ${count} active prospect${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} in this stage. Move them first, or deactivate instead.`,
        },
      });
    }

    // If historical (deleted) prospects reference this key, soft-delete
    const totalProspects = await pool.query(
      `SELECT COUNT(*) AS count FROM prospects WHERE org_id = $1 AND stage = $2`,
      [req.orgId, key]
    );
    if (parseInt(totalProspects.rows[0].count) > 0) {
      await pool.query(
        `UPDATE prospect_stages SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [id, req.orgId]
      );
      return res.json({ message: `"${name}" deactivated (has historical prospects).`, action: 'deactivated' });
    }

    await pool.query(`DELETE FROM prospect_stages WHERE id = $1 AND org_id = $2`, [id, req.orgId]);
    res.json({ message: `"${name}" deleted.`, action: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
