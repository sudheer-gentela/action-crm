// ─────────────────────────────────────────────────────────────────────────────
// playbooks.routes.js  —  Multi-playbook CRUD
// Mount in server.js: app.use('/api/playbooks', require('./routes/playbooks.routes'));
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const authenticateToken              = require('../middleware/auth.middleware');
const { orgContext, requireRole }    = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── GET / — list all playbooks for org ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, type, description, is_default, created_at, updated_at
       FROM playbooks
       WHERE org_id = $1
       ORDER BY is_default DESC, name ASC`,
      [req.orgId]
    );
    res.json({ playbooks: result.rows });
  } catch (err) {
    console.error('List playbooks error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── GET /:id — get one playbook with full content ─────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM playbooks WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    res.json({ playbook: result.rows[0] });
  } catch (err) {
    console.error('Get playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── GET /default — get the org default playbook ───────────────────────────────
// Used by AI services that need the fallback playbook
router.get('/default', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
      [req.orgId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'No default playbook found' } });
    }
    res.json({ playbook: result.rows[0] });
  } catch (err) {
    console.error('Get default playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST / — create new playbook (admin only) ─────────────────────────────────
router.post('/', adminOnly, async (req, res) => {
  try {
    const { name, type = 'custom', description = '', content = {}, is_default = false } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Playbook name is required' } });
    }

    const VALID_TYPES = ['market', 'product', 'custom'];
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: { message: `type must be one of: ${VALID_TYPES.join(', ')}` } });
    }

    // If this is being set as default, unset the current default first
    if (is_default) {
      await db.query(
        `UPDATE playbooks SET is_default = FALSE WHERE org_id = $1 AND is_default = TRUE`,
        [req.orgId]
      );
    }

    const result = await db.query(
      `INSERT INTO playbooks (org_id, name, type, description, content, is_default)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.orgId, name.trim(), type, description, JSON.stringify(content), is_default]
    );

    res.status(201).json({ playbook: result.rows[0] });
  } catch (err) {
    console.error('Create playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── PUT /:id — update playbook content + metadata (admin only) ────────────────
router.put('/:id', adminOnly, async (req, res) => {
  try {
    const { name, type, description, content } = req.body;

    // Confirm playbook belongs to this org
    const existing = await db.query(
      `SELECT id FROM playbooks WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    const VALID_TYPES = ['market', 'product', 'custom'];
    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: { message: `type must be one of: ${VALID_TYPES.join(', ')}` } });
    }

    const result = await db.query(
      `UPDATE playbooks
       SET name        = COALESCE($1, name),
           type        = COALESCE($2, type),
           description = COALESCE($3, description),
           content     = COALESCE($4, content),
           updated_at  = NOW()
       WHERE id = $5 AND org_id = $6
       RETURNING *`,
      [
        name?.trim() || null,
        type         || null,
        description  ?? null,
        content ? JSON.stringify(content) : null,
        req.params.id,
        req.orgId
      ]
    );

    res.json({ playbook: result.rows[0] });
  } catch (err) {
    console.error('Update playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── POST /:id/set-default — mark as org default (admin only) ─────────────────
router.post('/:id/set-default', adminOnly, async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id FROM playbooks WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }

    // Unset current default, set new one — do both in a transaction
    await db.query('BEGIN');
    await db.query(
      `UPDATE playbooks SET is_default = FALSE WHERE org_id = $1`,
      [req.orgId]
    );
    const result = await db.query(
      `UPDATE playbooks SET is_default = TRUE, updated_at = NOW()
       WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, req.orgId]
    );
    await db.query('COMMIT');

    res.json({ playbook: result.rows[0] });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Set default playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── DELETE /:id — delete playbook (admin only, blocks on default) ─────────────
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id, is_default FROM playbooks WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    if (existing.rows[0].is_default) {
      return res.status(400).json({
        error: { message: 'Cannot delete the default playbook. Set another playbook as default first.' }
      });
    }

    // Null out any deals pointing to this playbook (FK is ON DELETE SET NULL)
    await db.query(
      `DELETE FROM playbooks WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );

    res.json({ message: 'Playbook deleted' });
  } catch (err) {
    console.error('Delete playbook error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

module.exports = router;
