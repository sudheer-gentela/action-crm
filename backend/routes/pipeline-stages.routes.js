// ─────────────────────────────────────────────────────────────────────────────
// pipeline-stages.routes.js
//
// Generic CRUD + reorder for custom pipeline stages.
// Each pipeline is keyed by a playbook type (e.g. 'customer_success').
// Deal stages and prospect stages keep their own dedicated routes/tables.
//
// Mount: app.use('/api/pipeline-stages', require('./routes/pipeline-stages.routes'));
//
// GET    /:pipeline           — list stages for a pipeline
// POST   /:pipeline           — create stage
// PUT    /:pipeline/:id       — update stage
// PATCH  /:pipeline/reorder   — reorder stages
// DELETE /:pipeline/:id       — delete/deactivate stage
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);
const adminOnly = requireRole('owner', 'admin');

const SELECT_COLS = `id, pipeline, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color`;

function isValidKey(key) {
  return typeof key === 'string' && /^[a-z0-9_]{1,100}$/.test(key);
}

function isValidPipeline(pipeline) {
  return typeof pipeline === 'string' && /^[a-z0-9_]{1,100}$/.test(pipeline);
}

// ── GET /:pipeline ──────────────────────────────────────────────────────────

router.get('/:pipeline', async (req, res) => {
  try {
    const { pipeline } = req.params;
    if (!isValidPipeline(pipeline)) {
      return res.status(400).json({ error: { message: 'Invalid pipeline key' } });
    }

    const result = await pool.query(
      `SELECT ${SELECT_COLS}
       FROM pipeline_stages
       WHERE org_id = $1 AND pipeline = $2
       ORDER BY sort_order ASC, id ASC`,
      [req.orgId, pipeline]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /:pipeline ─────────────────────────────────────────────────────────

router.post('/:pipeline', adminOnly, async (req, res) => {
  try {
    const { pipeline } = req.params;
    if (!isValidPipeline(pipeline)) {
      return res.status(400).json({ error: { message: 'Invalid pipeline key' } });
    }

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

    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    let resolvedOrder = sort_order;
    if (resolvedOrder == null) {
      const maxRow = await pool.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS max_order
         FROM pipeline_stages WHERE org_id = $1 AND pipeline = $2`,
        [req.orgId, pipeline]
      );
      resolvedOrder = parseInt(maxRow.rows[0].max_order) + 10;
    }

    const result = await pool.query(
      `INSERT INTO pipeline_stages (org_id, pipeline, key, name, stage_type, sort_order, is_active, is_terminal, is_system, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
       RETURNING ${SELECT_COLS}`,
      [req.orgId, pipeline, key, name.trim(), stage_type, resolvedOrder, is_active, is_terminal, color]
    );

    res.status(201).json({ stage: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: { message: 'A stage with that key already exists in this pipeline.' },
      });
    }
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PUT /:pipeline/:id ──────────────────────────────────────────────────────

router.put('/:pipeline/:id', adminOnly, async (req, res) => {
  try {
    const { pipeline, id } = req.params;
    const { key, name, stage_type, sort_order, is_active, is_terminal, color } = req.body;

    const current = await pool.query(
      `SELECT * FROM pipeline_stages WHERE id = $1 AND org_id = $2 AND pipeline = $3`,
      [id, req.orgId, pipeline]
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

    // Cascade key rename to entity tables for sales and prospecting pipelines
    if (newKey !== existing.key) {
      if (pipeline === 'sales') {
        await pool.query(
          `UPDATE deals SET stage = $1, updated_at = NOW() WHERE org_id = $2 AND stage = $3`,
          [newKey, req.orgId, existing.key]
        );
        await pool.query(
          `UPDATE actions SET deal_stage = $1 WHERE org_id = $2 AND deal_stage = $3`,
          [newKey, req.orgId, existing.key]
        );
      } else if (pipeline === 'prospecting') {
        await pool.query(
          `UPDATE prospects SET stage = $1, updated_at = NOW() WHERE org_id = $2 AND stage = $3`,
          [newKey, req.orgId, existing.key]
        );
      }
    }

    const updated = await pool.query(
      `UPDATE pipeline_stages
       SET
         key         = $1,
         name        = COALESCE($2, name),
         stage_type  = COALESCE($3, stage_type),
         sort_order  = COALESCE($4, sort_order),
         is_active   = COALESCE($5, is_active),
         is_terminal = COALESCE($6, is_terminal),
         color       = COALESCE($7, color),
         updated_at  = NOW()
       WHERE id = $8 AND org_id = $9 AND pipeline = $10
       RETURNING ${SELECT_COLS}`,
      [
        newKey,
        name        !== undefined ? name.trim() : null,
        stage_type  !== undefined ? stage_type  : null,
        sort_order  !== undefined ? sort_order  : null,
        is_active   !== undefined ? is_active   : null,
        is_terminal !== undefined ? is_terminal : null,
        color       !== undefined ? color       : null,
        id, req.orgId, pipeline,
      ]
    );

    res.json({ stage: updated.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: 'A stage with that key already exists' } });
    }
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PATCH /:pipeline/reorder ────────────────────────────────────────────────

router.patch('/:pipeline/reorder', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { pipeline } = req.params;
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: { message: 'order must be a non-empty array of stage IDs' } });
    }

    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        `UPDATE pipeline_stages SET sort_order = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3 AND pipeline = $4`,
        [(i + 1) * 10, order[i], req.orgId, pipeline]
      );
    }
    await client.query('COMMIT');

    const result = await pool.query(
      `SELECT ${SELECT_COLS} FROM pipeline_stages
       WHERE org_id = $1 AND pipeline = $2
       ORDER BY sort_order ASC, id ASC`,
      [req.orgId, pipeline]
    );
    res.json({ stages: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: err.message } });
  } finally {
    client.release();
  }
});

// ── DELETE /:pipeline/:id ───────────────────────────────────────────────────

router.delete('/:pipeline/:id', adminOnly, async (req, res) => {
  try {
    const { pipeline, id } = req.params;

    const stage = await pool.query(
      `SELECT key, name, is_system FROM pipeline_stages WHERE id = $1 AND org_id = $2 AND pipeline = $3`,
      [id, req.orgId, pipeline]
    );
    if (stage.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Stage not found' } });
    }
    const { name, is_system } = stage.rows[0];
    const { key } = stage.rows[0];

    if (is_system) {
      return res.status(403).json({
        error: { message: `"${name}" is a system stage. Deactivate it instead.` },
      });
    }

    // For sales pipeline — block delete if active deals exist in this stage
    if (pipeline === 'sales') {
      const activeDeals = await pool.query(
        `SELECT COUNT(*) AS count FROM deals WHERE org_id = $1 AND stage = $2 AND deleted_at IS NULL`,
        [req.orgId, key]
      );
      const count = parseInt(activeDeals.rows[0].count);
      if (count > 0) {
        return res.status(409).json({
          error: { message: `Cannot delete "${name}" — ${count} active deal${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} in this stage. Move them first, or deactivate instead.` },
        });
      }
      // Soft-delete if historical deals reference the key
      const totalDeals = await pool.query(
        `SELECT COUNT(*) AS count FROM deals WHERE org_id = $1 AND stage = $2`,
        [req.orgId, key]
      );
      if (parseInt(totalDeals.rows[0].count) > 0) {
        await pool.query(
          `UPDATE pipeline_stages SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND org_id = $2 AND pipeline = $3`,
          [id, req.orgId, pipeline]
        );
        return res.json({ message: `"${name}" deactivated (has historical deals).`, action: 'deactivated' });
      }
    }

    // For prospecting pipeline — block delete if active prospects exist
    if (pipeline === 'prospecting') {
      const activeProspects = await pool.query(
        `SELECT COUNT(*) AS count FROM prospects WHERE org_id = $1 AND stage = $2 AND deleted_at IS NULL`,
        [req.orgId, key]
      );
      const count = parseInt(activeProspects.rows[0].count);
      if (count > 0) {
        return res.status(409).json({
          error: { message: `Cannot delete "${name}" — ${count} active prospect${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} in this stage. Move them first, or deactivate instead.` },
        });
      }
      const totalProspects = await pool.query(
        `SELECT COUNT(*) AS count FROM prospects WHERE org_id = $1 AND stage = $2`,
        [req.orgId, key]
      );
      if (parseInt(totalProspects.rows[0].count) > 0) {
        await pool.query(
          `UPDATE pipeline_stages SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND org_id = $2 AND pipeline = $3`,
          [id, req.orgId, pipeline]
        );
        return res.json({ message: `"${name}" deactivated (has historical prospects).`, action: 'deactivated' });
      }
    }

    await pool.query(
      `DELETE FROM pipeline_stages WHERE id = $1 AND org_id = $2 AND pipeline = $3`,
      [id, req.orgId, pipeline]
    );
    res.json({ message: `"${name}" deleted.`, action: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
