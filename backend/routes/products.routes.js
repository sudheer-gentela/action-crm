// ═══════════════════════════════════════════════════════════════════
// routes/products.routes.js — Product Catalog + Deal Products
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext }   = require('../middleware/orgContext.middleware');
const { pool }         = require('../config/database');

router.use(authenticateToken, orgContext);

// ─────────────────────────────────────────────────────────────────
// PRODUCT CATEGORIES
// ─────────────────────────────────────────────────────────────────

router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM product_categories WHERE org_id = $1 ORDER BY sort_order, name`,
      [req.orgId]
    );
    res.json({ success: true, data: { categories: rows } });
  } catch (err) {
    console.error('GET /products/categories error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to load categories' } });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { name, description, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: { message: 'Name is required' } });
    const { rows } = await pool.query(
      `INSERT INTO product_categories (org_id, name, description, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.orgId, name.trim(), description || null, sort_order || 0]
    );
    res.status(201).json({ success: true, data: { category: rows[0] } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: { message: 'Category name already exists' } });
    console.error('POST /products/categories error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to create category' } });
  }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const { name, description, sort_order } = req.body;
    const { rows } = await pool.query(
      `UPDATE product_categories SET name = COALESCE($1, name), description = $2, sort_order = COALESCE($3, sort_order)
       WHERE id = $4 AND org_id = $5 RETURNING *`,
      [name?.trim(), description ?? null, sort_order, req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Category not found' } });
    res.json({ success: true, data: { category: rows[0] } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: { message: 'Category name already exists' } });
    console.error('PUT /products/categories/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to update category' } });
  }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM product_categories WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ success: false, error: { message: 'Category not found' } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /products/categories/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to delete category' } });
  }
});

// ─────────────────────────────────────────────────────────────────
// PRODUCT CATALOG
// ─────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const statusFilter = req.query.status;
    let sql = `
      SELECT p.*, c.name AS category_name
      FROM product_catalog p
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE p.org_id = $1
    `;
    const params = [req.orgId];
    if (statusFilter) { sql += ` AND p.status = $2`; params.push(statusFilter); }
    sql += ` ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, p.sort_order, p.name`;
    const { rows } = await pool.query(sql, params);
    res.json({ success: true, data: { products: rows } });
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to load products' } });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM product_catalog p
       LEFT JOIN product_categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { message: 'Product not found' } });
    res.json({ success: true, data: { product: rows[0] } });
  } catch (err) {
    console.error('GET /products/:id error:', err);
    res.status(500).json({ success: false, error: { message: 'Failed to load product' } });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, sku, description, category_id, product_type, billing_frequency,
            fee_type, list_price, is_taxable, status, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, error: { message: 'Product name is required' } });
    const { rows } = await pool.query(
      `INSERT INTO product_catalog
        (org_id, name, sku, description, category_id, product_type, billing_frequency,
         fee_type, list_price, is_taxable, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.orgId, name.trim(), sku?.trim() || null, description || null,
       category_id || null, product_type || 'one_time',
       billing_frequency || null, fee_type || null,
       list_price || 0, is_taxable ?? false, status || 'active', sort_order || 0]
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
    const { name, sku, description, category_id, product_type, billing_frequency,
            fee_type, list_price, is_taxable, status, sort_order } = req.body;
    const { rows } = await pool.query(
      `UPDATE product_catalog SET
        name = COALESCE($1, name), sku = $2, description = $3, category_id = $4,
        product_type = COALESCE($5, product_type), billing_frequency = $6,
        fee_type = $7, list_price = COALESCE($8, list_price),
        is_taxable = COALESCE($9, is_taxable), status = COALESCE($10, status),
        sort_order = COALESCE($11, sort_order)
       WHERE id = $12 AND org_id = $13 RETURNING *`,
      [name?.trim(), sku?.trim() || null, description ?? null, category_id || null,
       product_type, billing_frequency || null, fee_type || null, list_price, is_taxable,
       status, sort_order, req.params.id, req.orgId]
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
      `SELECT dp.*, pc.sku, pc.status AS catalog_status
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
    let resolvedName = product_name, resolvedPrice = unit_price, resolvedType = revenue_type, resolvedCatName = null;
    if (product_id) {
      const { rows: catRows } = await pool.query(
        `SELECT p.name, p.list_price, p.product_type, c.name AS category_name
         FROM product_catalog p LEFT JOIN product_categories c ON c.id = p.category_id
         WHERE p.id = $1 AND p.org_id = $2`,
        [product_id, req.orgId]
      );
      if (catRows.length) {
        resolvedName    = resolvedName  || catRows[0].name;
        resolvedPrice   = resolvedPrice ?? catRows[0].list_price;
        resolvedType    = resolvedType  || catRows[0].product_type;
        resolvedCatName = catRows[0].category_name || null;
      }
    }
    if (!resolvedName?.trim()) return res.status(400).json({ success: false, error: { message: 'Product name is required' } });
    const { rows } = await pool.query(
      `INSERT INTO deal_products
        (org_id, deal_id, product_id, product_name, category_name, quantity, unit_price, discount_pct,
         contract_term, effective_date, renewal_date, revenue_type, notes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [req.orgId, req.params.dealId, product_id || null, resolvedName.trim(), resolvedCatName,
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
       contract_term ?? null, effective_date ?? null, renewal_date ?? null,
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
