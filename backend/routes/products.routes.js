// ═══════════════════════════════════════════════════════════════════
// routes/products.routes.js — Product Catalog + Deal Products
//
// Uses recursive product_groups tree instead of flat categories.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }   = require('../middleware/orgContext.middleware');
const { pool }         = require('../config/database');

router.use(authenticateToken, orgContext);

// ─────────────────────────────────────────────────────────────────
// HELPER: Build full path for a group (breadcrumb)
// ─────────────────────────────────────────────────────────────────
async function getGroupPath(orgId, groupId) {
  if (!groupId) return null;
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, name, 1 AS depth
       FROM product_groups WHERE id = $1 AND org_id = $2
       UNION ALL
       SELECT g.id, g.parent_id, g.name, a.depth + 1
       FROM product_groups g JOIN ancestors a ON g.id = a.parent_id
     )
     SELECT name FROM ancestors ORDER BY depth DESC`,
    [groupId, orgId]
  );
  return rows.map(r => r.name).join(' > ');
}

// ─────────────────────────────────────────────────────────────────
// PRODUCT GROUPS (recursive tree)
// ─────────────────────────────────────────────────────────────────

router.get('/groups', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.*,
              (SELECT COUNT(*)::int FROM product_catalog p WHERE p.group_id = g.id AND p.org_id = g.org_id) AS product_count
       FROM product_groups g
       WHERE g.org_id = $1
       ORDER BY g.sort_order, g.name`,
      [req.orgId]
    );
    res.json({ success: true, data: { groups: rows } });
  } catch (err) {
    console.error('GET /products/groups error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to load groups' } });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const { name, description, parent_id, level_label, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: { message: 'Name is required' } });
    if (parent_id) {
      const { rows: parentRows } = await pool.query(
        `SELECT id FROM product_groups WHERE id = $1 AND org_id = $2`, [parent_id, req.orgId]
      );
      if (!parentRows.length) return res.status(400).json({ success: false, error: { message: 'Parent group not found' } });
    }
    const { rows } = await pool.query(
      `INSERT INTO product_groups (org_id, parent_id, name, description, level_label, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.orgId, parent_id || null, name.trim(), description || null, level_label || 'Category', sort_order || 0]
    );
    res.status(201).json({ success: true, data: { group: rows[0] } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: { message: 'Group name already exists at this level' } });
    console.error('POST /products/groups error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to create group' } });
  }
});

router.put('/groups/:id', async (req, res) => {
  try {
    const { name, description, parent_id, level_label, sort_order, is_active } = req.body;
    if (parent_id && parseInt(parent_id) === parseInt(req.params.id)) {
      return res.status(400).json({ success: false, error: { message: 'A group cannot be its own parent' } });
    }
    const setParts = [];
    const vals = [];
    let idx = 1;
    if (name !== undefined)        { setParts.push(`name = $${idx++}`);        vals.push(name.trim()); }
    if (description !== undefined)  { setParts.push(`description = $${idx++}`); vals.push(description || null); }
    if (parent_id !== undefined)    { setParts.push(`parent_id = $${idx++}`);   vals.push(parent_id || null); }
    if (level_label !== undefined)  { setParts.push(`level_label = $${idx++}`); vals.push(level_label); }
    if (sort_order !== undefined)   { setParts.push(`sort_order = $${idx++}`);  vals.push(sort_order); }
    if (is_active !== undefined)    { setParts.push(`is_active = $${idx++}`);   vals.push(is_active); }
    if (setParts.length === 0) return res.status(400).json({ success: false, error: { message: 'Nothing to update' } });
    vals.push(req.params.id, req.orgId);
    const { rows } = await pool.query(
      `UPDATE product_groups SET ${setParts.join(', ')} WHERE id = $${idx++} AND org_id = $${idx} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Group not found' } });
    res.json({ success: true, data: { group: rows[0] } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: { message: 'Group name already exists at this level' } });
    console.error('PUT /products/groups/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to update group' } });
  }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    const { rows: children } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM product_groups WHERE parent_id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (children[0].cnt > 0) {
      return res.status(409).json({ success: false, error: { message: `Has ${children[0].cnt} child group(s). Remove or move them first.` } });
    }
    const { rows: prods } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM product_catalog WHERE group_id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (prods[0].cnt > 0) {
      return res.status(409).json({ success: false, error: { message: `Has ${prods[0].cnt} product(s). Move them first.` } });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM product_groups WHERE id = $1 AND org_id = $2`, [req.params.id, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: { message: 'Group not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /products/groups/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to delete group' } });
  }
});

// ─────────────────────────────────────────────────────────────────
// PRODUCT CATALOG
// ─────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const statusFilter = req.query.status;
    let sql = `
      SELECT p.*, g.name AS group_name, g.parent_id AS group_parent_id, g.level_label AS group_level_label
      FROM product_catalog p
      LEFT JOIN product_groups g ON g.id = p.group_id
      WHERE p.org_id = $1
    `;
    const params = [req.orgId];
    if (statusFilter) { sql += ` AND p.status = $2`; params.push(statusFilter); }
    sql += ` ORDER BY g.sort_order NULLS LAST, g.name NULLS LAST, p.sort_order, p.name`;
    const { rows } = await pool.query(sql, params);
    res.json({ success: true, data: { products: rows } });
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to load products' } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, sku, description, group_id, product_type, billing_frequency,
            fee_type, list_price, is_taxable, status, sort_order, unit_label } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: { message: 'Product name is required' } });
    const { rows } = await pool.query(
      `INSERT INTO product_catalog
        (org_id, name, sku, description, group_id, product_type, billing_frequency,
         fee_type, list_price, is_taxable, status, sort_order, unit_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [req.orgId, name.trim(), sku?.trim() || null, description || null,
       group_id || null, product_type || 'one_time',
       billing_frequency || null, fee_type || null,
       list_price || 0, is_taxable ?? false, status || 'active', sort_order || 0,
       unit_label?.trim() || null]
    );
    res.status(201).json({ success: true, data: { product: rows[0] } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: { message: 'SKU already exists in your org' } });
    console.error('POST /products error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to create product' } });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, sku, description, group_id, product_type, billing_frequency,
            fee_type, list_price, is_taxable, status, sort_order, unit_label } = req.body;
    const { rows } = await pool.query(
      `UPDATE product_catalog SET
        name = COALESCE($1, name), sku = $2, description = $3, group_id = $4,
        product_type = COALESCE($5, product_type), billing_frequency = $6,
        fee_type = $7, list_price = COALESCE($8, list_price),
        is_taxable = COALESCE($9, is_taxable), status = COALESCE($10, status),
        sort_order = COALESCE($11, sort_order), unit_label = $12
       WHERE id = $13 AND org_id = $14 RETURNING *`,
      [name?.trim(), sku?.trim() || null, description ?? null, group_id || null,
       product_type, billing_frequency || null, fee_type || null, list_price, is_taxable,
       status, sort_order, unit_label?.trim() || null, req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Product not found' } });
    res.json({ success: true, data: { product: rows[0] } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: { message: 'SKU already exists in your org' } });
    console.error('PUT /products/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to update product' } });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { rows: usageRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM deal_products WHERE product_id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (usageRows[0].cnt > 0) {
      return res.status(409).json({
        success: false,
        error: { message: `Cannot delete — product is on ${usageRows[0].cnt} deal(s). Set status to "sunset" instead.` }
      });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM product_catalog WHERE id = $1 AND org_id = $2`, [req.params.id, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: { message: 'Product not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /products/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to delete product' } });
  }
});

// ─────────────────────────────────────────────────────────────────
// DEAL PRODUCTS (LINE ITEMS)
// ─────────────────────────────────────────────────────────────────

router.get('/deals/:dealId/items', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dp.*, pc.sku, pc.status AS catalog_status, pc.unit_label
       FROM deal_products dp
       LEFT JOIN product_catalog pc ON pc.id = dp.product_id
       WHERE dp.deal_id = $1 AND dp.org_id = $2
       ORDER BY dp.sort_order, dp.created_at`,
      [req.params.dealId, req.orgId]
    );
    const totals = rows.reduce((acc, r) => {
      const val = parseFloat(r.total_value) || 0;
      acc.total += val;
      if (r.revenue_type === 'recurring') acc.recurring += val; else acc.one_time += val;
      return acc;
    }, { total: 0, one_time: 0, recurring: 0 });
    res.json({ success: true, data: { items: rows, totals } });
  } catch (err) {
    console.error('GET /products/deals/:dealId/items error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to load deal products' } });
  }
});

router.post('/deals/:dealId/items', async (req, res) => {
  try {
    const { product_id, product_name, quantity, unit_price, discount_pct,
            contract_term, effective_date, renewal_date, revenue_type, notes, sort_order } = req.body;
    let resolvedName = product_name, resolvedPrice = unit_price, resolvedType = revenue_type;
    let resolvedGroupPath = null, resolvedCatName = null;
    if (product_id) {
      const { rows: catRows } = await pool.query(
        `SELECT p.name, p.list_price, p.product_type, g.name AS group_name, p.group_id
         FROM product_catalog p LEFT JOIN product_groups g ON g.id = p.group_id
         WHERE p.id = $1 AND p.org_id = $2`,
        [product_id, req.orgId]
      );
      if (catRows.length) {
        resolvedName     = resolvedName  || catRows[0].name;
        resolvedPrice    = resolvedPrice ?? catRows[0].list_price;
        resolvedType     = resolvedType  || catRows[0].product_type;
        resolvedCatName  = catRows[0].group_name || null;
        resolvedGroupPath = await getGroupPath(req.orgId, catRows[0].group_id);
      }
    }
    if (!resolvedName?.trim()) return res.status(400).json({ success: false, error: { message: 'Product name is required' } });
    const { rows } = await pool.query(
      `INSERT INTO deal_products
        (org_id, deal_id, product_id, product_name, category_name, group_path, quantity, unit_price, discount_pct,
         contract_term, effective_date, renewal_date, revenue_type, notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [req.orgId, req.params.dealId, product_id || null, resolvedName.trim(),
       resolvedCatName, resolvedGroupPath,
       quantity || 1, resolvedPrice || 0, discount_pct || 0,
       contract_term || null, effective_date || null, renewal_date || null,
       resolvedType || 'one_time', notes || null, sort_order || 0]
    );
    res.status(201).json({ success: true, data: { item: rows[0] } });
  } catch (err) {
    console.error('POST /products/deals/:dealId/items error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to add line item' } });
  }
});

router.put('/deals/:dealId/items/:itemId', async (req, res) => {
  try {
    const { product_name, quantity, unit_price, discount_pct,
            contract_term, effective_date, renewal_date, revenue_type, notes, sort_order } = req.body;
    const { rows } = await pool.query(
      `UPDATE deal_products SET
        product_name = COALESCE($1, product_name), quantity = COALESCE($2, quantity),
        unit_price = COALESCE($3, unit_price), discount_pct = COALESCE($4, discount_pct),
        contract_term = $5, effective_date = $6, renewal_date = $7,
        revenue_type = COALESCE($8, revenue_type), notes = $9, sort_order = COALESCE($10, sort_order)
       WHERE id = $11 AND deal_id = $12 AND org_id = $13 RETURNING *`,
      [product_name?.trim(), quantity, unit_price, discount_pct,
       contract_term || null, effective_date || null, renewal_date || null,
       revenue_type, notes ?? null, sort_order,
       req.params.itemId, req.params.dealId, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Line item not found' } });
    res.json({ success: true, data: { item: rows[0] } });
  } catch (err) {
    console.error('PUT /products/deals/:dealId/items/:itemId error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to update line item' } });
  }
});

router.delete('/deals/:dealId/items/:itemId', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM deal_products WHERE id = $1 AND deal_id = $2 AND org_id = $3`,
      [req.params.itemId, req.params.dealId, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: { message: 'Line item not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /products/deals/:dealId/items/:itemId error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to delete line item' } });
  }
});

router.post('/deals/:dealId/items/sync-value', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(total_value), 0)::numeric(16,2) AS total
       FROM deal_products WHERE deal_id = $1 AND org_id = $2`,
      [req.params.dealId, req.orgId]
    );
    const total = parseFloat(rows[0].total);
    await pool.query(`UPDATE deals SET value = $1 WHERE id = $2 AND org_id = $3`, [total, req.params.dealId, req.orgId]);
    res.json({ success: true, data: { deal_value: total } });
  } catch (err) {
    console.error('POST /products/deals/:dealId/items/sync-value error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to sync deal value' } });
  }
});

module.exports = router;
