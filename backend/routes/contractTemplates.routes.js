// contractTemplates.routes.js
// CLM: Master template management (admin upload, team download).
// IMPORTANT — Mount in server.js BEFORE the contracts router:
//   app.use('/api/contracts/templates', contractTemplatesRouter);
//   app.use('/api/contracts', contractsRouter);

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const auth    = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(auth);
router.use(orgContext);

const VALID_TYPES = ['nda', 'msa', 'sow', 'order_form', 'amendment', 'custom'];

// GET /api/contracts/templates — all active templates for org
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ct.*, u.first_name, u.last_name
       FROM contract_templates ct
       LEFT JOIN users u ON u.id = ct.uploaded_by
       WHERE ct.org_id = $1 AND ct.is_active = TRUE
       ORDER BY ct.contract_type, ct.created_at DESC`,
      [req.orgId]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: 'Failed to fetch templates' } });
  }
});

// GET /api/contracts/templates/by-type/:contractType — templates for one type
router.get('/by-type/:contractType', async (req, res) => {
  try {
    const { contractType } = req.params;
    const r = await pool.query(
      `SELECT ct.*, u.first_name, u.last_name
       FROM contract_templates ct
       LEFT JOIN users u ON u.id = ct.uploaded_by
       WHERE ct.org_id = $1 AND ct.contract_type = $2 AND ct.is_active = TRUE
       ORDER BY ct.created_at DESC`,
      [req.orgId, contractType]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch templates' } });
  }
});

// POST /api/contracts/templates — upload new template (admin/owner only)
router.post('/', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const { contractType, name, description, fileUrl, fileName, fileSize } = req.body;

    if (!contractType || !VALID_TYPES.includes(contractType)) {
      return res.status(400).json({ error: { message: `contractType must be one of: ${VALID_TYPES.join(', ')}` } });
    }
    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'name is required' } });
    }
    if (!fileUrl?.trim()) {
      return res.status(400).json({ error: { message: 'fileUrl is required' } });
    }

    const r = await pool.query(
      `INSERT INTO contract_templates
         (org_id, contract_type, name, description, file_url, file_name, file_size, is_active, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
       RETURNING *`,
      [
        req.orgId,
        contractType,
        name.trim(),
        description?.trim() || null,
        fileUrl.trim(),
        fileName?.trim() || null,
        fileSize || null,
        req.userId,
      ]
    );
    res.status(201).json({ template: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: 'Failed to create template' } });
  }
});

// PUT /api/contracts/templates/:id — update template metadata (admin/owner only)
router.put('/:id', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const { name, description, fileUrl, fileName, fileSize, isActive } = req.body;
    const r = await pool.query(
      `UPDATE contract_templates SET
         name        = COALESCE($3, name),
         description = COALESCE($4, description),
         file_url    = COALESCE($5, file_url),
         file_name   = COALESCE($6, file_name),
         file_size   = COALESCE($7, file_size),
         is_active   = COALESCE($8, is_active),
         updated_at  = NOW()
       WHERE id = $1 AND org_id = $2
       RETURNING *`,
      [
        parseInt(req.params.id, 10),
        req.orgId,
        name?.trim() || null,
        description?.trim() || null,
        fileUrl?.trim() || null,
        fileName?.trim() || null,
        fileSize || null,
        isActive ?? null,
      ]
    );
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ template: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update template' } });
  }
});

// DELETE /api/contracts/templates/:id — soft-delete (admin/owner only)
router.delete('/:id', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE contract_templates SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND org_id = $2
       RETURNING id`,
      [parseInt(req.params.id, 10), req.orgId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete template' } });
  }
});

module.exports = router;
