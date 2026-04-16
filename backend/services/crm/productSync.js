/**
 * crm/productSync.js
 *
 * DROP-IN LOCATION: backend/services/crm/productSync.js
 *
 * Syncs CRM product line items into GoWarm's:
 *   - product_catalog  (upserted by org_id + sku, or org_id + name if no sku)
 *   - deal_products    (upserted by deal_id + product_id)
 *
 * Key design decisions:
 *
 * 1. PRODUCT_CATALOG IS AN ORG-SCOPED REGISTRY.
 *    When a line item arrives, we check product_catalog by SKU first,
 *    then by name. If no match, we create a new catalog entry.
 *    This means the catalog auto-builds from CRM data without manual setup.
 *
 * 2. DEAL_PRODUCTS ARE REPLACED PER DEAL ON SYNC.
 *    Line items for a given deal are deleted and reinserted on each sync
 *    run that includes products for that deal. This is simpler than
 *    trying to diff individual line items, and product data doesn't
 *    change frequently enough to make the diff worthwhile.
 *    Exception: if getDealProducts() returns an empty array (could mean
 *    no products OR the CRM doesn't support products), we skip deletion
 *    to avoid wiping data that was manually entered.
 *
 * 3. TOTAL_VALUE IS A GENERATED COLUMN.
 *    deal_products.total_value is computed by Postgres as:
 *    quantity * unit_price * (1 - discount_pct / 100)
 *    We never write to it — just write quantity, unit_price, discount_pct.
 */

const { pool } = require('../../config/database');

/**
 * Sync product line items for a single deal.
 * Called by the orchestrator after each deal is upserted.
 *
 * @param {number} orgId
 * @param {number} gwDealId       - GoWarm deals.id
 * @param {string} dealCrmId      - CRM native deal ID
 * @param {object} adapter        - Initialised CRM adapter
 * @returns {{ synced: number, catalogCreated: number }}
 */
async function syncDealProducts(orgId, gwDealId, dealCrmId, adapter) {
  const lineItems = await adapter.getDealProducts(dealCrmId);

  // Empty array could mean "no products" or "products not enabled".
  // We can't tell the difference — skip to avoid wiping manual data.
  if (lineItems.length === 0) {
    return { synced: 0, catalogCreated: 0 };
  }

  let catalogCreated = 0;
  const productRows  = [];

  for (const item of lineItems) {
    try {
      const { productId, created } = await _upsertProductCatalog(orgId, item);
      if (created) catalogCreated++;

      productRows.push({
        productId,
        productName:     item.name,
        categoryName:    item.categoryName || null,
        quantity:        item.quantity,
        unitPrice:       item.unitPrice,
        discountPct:     item.discountPct,
        revenueType:     item.productType || 'one_time',
        contractTerm:    item.contractTerm || null,
        effectiveDate:   item.effectiveDate || null,
        renewalDate:     item.renewalDate || null,
        notes:           item.description || null,
        sortOrder:       productRows.length,
      });
    } catch (err) {
      console.error(`  ⚠️  [Products] deal ${gwDealId} item "${item.name}": ${err.message}`);
    }
  }

  if (productRows.length === 0) return { synced: 0, catalogCreated };

  // Replace line items for this deal in a single transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete existing line items for this deal (full replace strategy)
    await client.query(
      `DELETE FROM deal_products WHERE org_id = $1 AND deal_id = $2`,
      [orgId, gwDealId]
    );

    // Insert all new line items
    for (const row of productRows) {
      await client.query(`
        INSERT INTO deal_products (
          org_id, deal_id, product_id, product_name, category_name,
          quantity, unit_price, discount_pct, revenue_type,
          contract_term, effective_date, renewal_date,
          notes, sort_order, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14, NOW(), NOW()
        )
      `, [
        orgId, gwDealId, row.productId, row.productName, row.categoryName,
        row.quantity, row.unitPrice, row.discountPct, row.revenueType,
        row.contractTerm, row.effectiveDate, row.renewalDate,
        row.notes, row.sortOrder,
      ]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { synced: productRows.length, catalogCreated };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find or create a product_catalog entry for an org.
 * Match priority: SKU (exact) > name (case-insensitive).
 *
 * @param {number} orgId
 * @param {NormalizedLineItem} item
 * @returns {{ productId: number, created: boolean }}
 */
async function _upsertProductCatalog(orgId, item) {
  // Try SKU match first (strongest signal)
  if (item.sku) {
    const bysku = await pool.query(
      `SELECT id FROM product_catalog WHERE org_id = $1 AND sku = $2 LIMIT 1`,
      [orgId, item.sku]
    );
    if (bysku.rows.length > 0) {
      // Update list_price if different (CRM is source of truth)
      await pool.query(
        `UPDATE product_catalog SET list_price = $1, updated_at = NOW() WHERE id = $2`,
        [item.unitPrice, bysku.rows[0].id]
      );
      return { productId: bysku.rows[0].id, created: false };
    }
  }

  // Try name match
  const byname = await pool.query(
    `SELECT id FROM product_catalog WHERE org_id = $1 AND LOWER(name) = $2 LIMIT 1`,
    [orgId, item.name.toLowerCase().trim()]
  );
  if (byname.rows.length > 0) {
    return { productId: byname.rows[0].id, created: false };
  }

  // Not found — create a new catalog entry
  const insert = await pool.query(`
    INSERT INTO product_catalog (
      org_id, name, sku, product_type, billing_frequency,
      list_price, status, sort_order, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, NOW(), NOW())
    RETURNING id
  `, [
    orgId,
    item.name,
    item.sku || null,
    item.productType || 'one_time',
    item.billingFrequency || null,
    item.unitPrice,
  ]);

  return { productId: insert.rows[0].id, created: true };
}

module.exports = { syncDealProducts };
