// ─────────────────────────────────────────────────────────────────────────────
// teamDimensions.service.js
//
// CRUD for the team_dimensions table — org-configurable vocabulary that
// drives dimension pickers in both the internal Teams config and the
// customer-side Account Teams panel.
//
// System dimensions (is_system = true) can be renamed and toggled but
// never deleted. Custom dimensions can be fully managed.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

// ── Row formatter ─────────────────────────────────────────────────────────────

function fmt(row) {
  if (!row) return null;
  return {
    id:         row.id,
    orgId:      row.org_id,
    key:        row.key,
    name:       row.name,
    appliesTo:  row.applies_to,
    isSystem:   row.is_system,
    isActive:   row.is_active,
    sortOrder:  row.sort_order,
    createdAt:  row.created_at,
  };
}

// ── list ─────────────────────────────────────────────────────────────────────

/**
 * List dimensions for an org, optionally filtered by appliesTo.
 * Always returns system + custom dimensions, ordered by sort_order.
 *
 * @param {number} orgId
 * @param {{ appliesTo?: 'internal'|'customer'|'both', activeOnly?: boolean }} opts
 */
async function list(orgId, { appliesTo, activeOnly = true } = {}) {
  const params = [orgId];
  const conditions = ['org_id = $1'];

  if (activeOnly) {
    conditions.push('is_active = TRUE');
  }

  if (appliesTo) {
    // 'both' rows appear in all filtered views
    params.push(appliesTo);
    conditions.push(`(applies_to = $${params.length} OR applies_to = 'both')`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM team_dimensions
     WHERE ${conditions.join(' AND ')}
     ORDER BY sort_order ASC, name ASC`,
    params
  );

  return rows.map(fmt);
}

// ── create ────────────────────────────────────────────────────────────────────

/**
 * Create a new custom dimension. System dimensions are seeded only by
 * orgSeed.service.js and cannot be created via this path.
 *
 * @param {number} orgId
 * @param {{ key: string, name: string, appliesTo?: string, sortOrder?: number }} data
 */
async function create(orgId, data) {
  const { key, name, appliesTo = 'both', sortOrder } = data;

  if (!key || !name) throw Object.assign(new Error('key and name are required'), { status: 400 });

  // Derive sort_order — append after current max if not supplied
  let order = sortOrder;
  if (order === undefined || order === null) {
    const maxResult = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM team_dimensions WHERE org_id = $1',
      [orgId]
    );
    order = maxResult.rows[0].next;
  }

  const { rows } = await pool.query(
    `INSERT INTO team_dimensions (org_id, key, name, applies_to, is_system, sort_order)
     VALUES ($1, $2, $3, $4, FALSE, $5)
     RETURNING *`,
    [orgId, key.toLowerCase().replace(/\s+/g, '_'), name.trim(), appliesTo, order]
  );

  return fmt(rows[0]);
}

// ── update ────────────────────────────────────────────────────────────────────

/**
 * Rename a dimension and/or change its appliesTo / sortOrder.
 * The key field is immutable once created.
 *
 * @param {number} orgId
 * @param {number} id
 * @param {{ name?: string, appliesTo?: string, sortOrder?: number }} data
 */
async function update(orgId, id, data) {
  const existing = await _get(orgId, id);

  const name      = data.name      ?? existing.name;
  const appliesTo = data.appliesTo ?? existing.appliesTo;
  const sortOrder = data.sortOrder ?? existing.sortOrder;

  const { rows } = await pool.query(
    `UPDATE team_dimensions
     SET name = $1, applies_to = $2, sort_order = $3
     WHERE id = $4 AND org_id = $5
     RETURNING *`,
    [name.trim(), appliesTo, sortOrder, id, orgId]
  );

  if (rows.length === 0) throw Object.assign(new Error('Dimension not found'), { status: 404 });
  return fmt(rows[0]);
}

// ── toggle active ─────────────────────────────────────────────────────────────

/**
 * Activate or deactivate a dimension.
 * System dimensions can be deactivated but not deleted.
 *
 * @param {number} orgId
 * @param {number} id
 * @param {boolean} isActive
 */
async function toggle(orgId, id, isActive) {
  const { rows } = await pool.query(
    `UPDATE team_dimensions
     SET is_active = $1
     WHERE id = $2 AND org_id = $3
     RETURNING *`,
    [isActive, id, orgId]
  );

  if (rows.length === 0) throw Object.assign(new Error('Dimension not found'), { status: 404 });
  return fmt(rows[0]);
}

// ── remove ────────────────────────────────────────────────────────────────────

/**
 * Hard-delete a custom dimension. Blocked for system dimensions.
 *
 * @param {number} orgId
 * @param {number} id
 */
async function remove(orgId, id) {
  const existing = await _get(orgId, id);

  if (existing.isSystem) {
    throw Object.assign(
      new Error('System dimensions cannot be deleted. Deactivate instead.'),
      { status: 400 }
    );
  }

  await pool.query(
    'DELETE FROM team_dimensions WHERE id = $1 AND org_id = $2',
    [id, orgId]
  );

  return { deleted: true, id };
}

// ── seedDefaults ──────────────────────────────────────────────────────────────

/**
 * Called by orgSeed.service.js on org creation.
 * Inserts system dimensions idempotently — safe to call multiple times.
 *
 * @param {number} orgId
 * @param {object} client  — pg client from withOrgTransaction
 */
async function seedDefaults(orgId, client) {
  const q = client ? client.query.bind(client) : pool.query.bind(pool);

  const defaults = [
    { key: 'function',     name: 'Function',     applies_to: 'both',     sort_order: 10 },
    { key: 'geography',    name: 'Geography',     applies_to: 'both',     sort_order: 20 },
    { key: 'project',      name: 'Project',       applies_to: 'both',     sort_order: 30 },
    { key: 'executive',    name: 'Executive',     applies_to: 'customer', sort_order: 40 },
    { key: 'buying_group', name: 'Buying Group',  applies_to: 'customer', sort_order: 50 },
    { key: 'custom',       name: 'Custom',        applies_to: 'both',     sort_order: 60 },
  ];

  for (const d of defaults) {
    await q(
      `INSERT INTO team_dimensions (org_id, key, name, applies_to, is_system, sort_order)
       VALUES ($1, $2, $3, $4, TRUE, $5)
       ON CONFLICT (org_id, key) DO NOTHING`,
      [orgId, d.key, d.name, d.applies_to, d.sort_order]
    );
  }
}

// ── private helpers ───────────────────────────────────────────────────────────

async function _get(orgId, id) {
  const { rows } = await pool.query(
    'SELECT * FROM team_dimensions WHERE id = $1 AND org_id = $2',
    [id, orgId]
  );
  if (rows.length === 0) throw Object.assign(new Error('Dimension not found'), { status: 404 });
  return fmt(rows[0]);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { list, create, update, toggle, remove, seedDefaults };
