// ─────────────────────────────────────────────────────────────────────────────
// contactRoles.service.js
//
// Configurable roles for EXTERNAL project people, per side.
//
// A sibling to org_roles, not an extension of it. org_roles is routable — the
// deal_roles view is an unfiltered SELECT over it, and PlayRouteResolver /
// PlaybookPlayService / ContractActionsGenerator route work to a role and then
// resolve an assignee among USERS. A customer or vendor role can never have a
// user assignee, so putting them in the same table would let a playbook route a
// play into the void.
//
// Shape deliberately mirrors org_roles (key, name, is_system, is_active,
// sort_order) so the admin screen and these routes look like the existing
// org-roles ones.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const SIDES = ['customer', 'vendor', 'partner'];

// Seeded for every org by the 2026_93 migration and by orgSeed for new orgs.
// is_system means "application logic keys on this" — renameable, not deletable.
const DEFAULTS = [
  { side: 'customer', key: 'implementation_lead',  name: 'Implementation Lead',  is_system: false, sort_order: 10 },
  { side: 'customer', key: 'day_to_day_admin',     name: 'Day-to-day Admin',     is_system: false, sort_order: 20 },
  { side: 'customer', key: 'go_live_approver',     name: 'Go-live Approver',     is_system: true,  sort_order: 30 },
  { side: 'customer', key: 'exec_sponsor',         name: 'Executive Sponsor',    is_system: false, sort_order: 40 },
  { side: 'customer', key: 'technical_lead',       name: 'Technical Lead',       is_system: false, sort_order: 50 },
  { side: 'customer', key: 'other',                name: 'Other',                is_system: true,  sort_order: 60 },

  { side: 'vendor',   key: 'engagement_lead',      name: 'Engagement Lead',      is_system: false, sort_order: 10 },
  { side: 'vendor',   key: 'technical_consultant', name: 'Technical Consultant', is_system: false, sort_order: 20 },
  { side: 'vendor',   key: 'account_manager',      name: 'Account Manager',      is_system: false, sort_order: 30 },
  { side: 'vendor',   key: 'support_contact',      name: 'Support Contact',      is_system: false, sort_order: 40 },
  { side: 'vendor',   key: 'other',                name: 'Other',                is_system: true,  sort_order: 50 },

  { side: 'partner',  key: 'partner_principal',    name: 'Partner Principal',    is_system: false, sort_order: 10 },
  { side: 'partner',  key: 'solution_architect',   name: 'Solution Architect',   is_system: false, sort_order: 20 },
  { side: 'partner',  key: 'delivery_lead',        name: 'Delivery Lead',        is_system: false, sort_order: 30 },
  { side: 'partner',  key: 'commercial_contact',   name: 'Commercial Contact',   is_system: false, sort_order: 40 },
  { side: 'partner',  key: 'other',                name: 'Other',                is_system: true,  sort_order: 50 },
];

const slugify = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function assertSide(side) {
  if (!SIDES.includes(side)) {
    throw Object.assign(new Error(`side must be one of: ${SIDES.join(', ')}`), { status: 400 });
  }
}

/**
 * Seed the defaults for one org. Used by orgSeed for new orgs; the migration
 * does the same for existing ones. DO NOTHING on conflict so a re-run never
 * undoes a rename the customer has already made.
 *
 * Takes an optional client so it can join an existing provisioning transaction.
 */
async function seedDefaults(orgId, client = pool) {
  for (const r of DEFAULTS) {
    await client.query(
      `INSERT INTO contact_roles (org_id, side, key, name, is_system, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, side, key) DO NOTHING`,
      [orgId, r.side, r.key, r.name, r.is_system, r.sort_order]
    );
  }
}

async function list(orgId, { side = null, includeInactive = false } = {}) {
  if (side) assertSide(side);
  const { rows } = await pool.query(
    `SELECT id, side, key, name, is_system, is_active, sort_order
       FROM contact_roles
      WHERE org_id = $1
        AND ($2::text IS NULL OR side = $2)
        AND ($3::boolean OR is_active)
      ORDER BY side, sort_order, name`,
    [orgId, side, includeInactive]
  );
  return { roles: rows };
}

/**
 * Validate a role key before it is written onto project_contacts or
 * deal_contacts.
 *
 * The fixed CHECK constraint was dropped in 2026_93 because roles are
 * configurable now, so this is the only thing standing between a typo and a
 * label nobody can render. Falls back to 'other' rather than throwing when the
 * caller passes nothing, which is what the old column default did.
 *
 * If the org has no seeded roles at all — a provisioning gap — this seeds them
 * rather than blocking the user on a screen they are already halfway through.
 */
async function resolveRoleKey(orgId, side, roleKey) {
  assertSide(side);
  const raw = String(roleKey || '').trim();
  const key = slugify(raw) || 'other';

  // Match on the key OR the display name. A caller may legitimately send
  // either — the picker sends the key, but a CSV import or an older client
  // sends the label, and the two are not always the same string: the seeded
  // key 'exec_sponsor' has the name 'Executive Sponsor', which slugifies to
  // 'executive_sponsor' and would never match on key alone.
  const { rows } = await pool.query(
    `SELECT key FROM contact_roles
      WHERE org_id = $1 AND side = $2 AND is_active
        AND (key = $3 OR lower(name) = lower($4))
      LIMIT 1`,
    [orgId, side, key, raw]
  );
  if (rows.length) return rows[0].key;

  const { rows: any } = await pool.query(
    `SELECT 1 FROM contact_roles WHERE org_id = $1 AND side = $2 LIMIT 1`, [orgId, side]);
  if (!any.length) {
    await seedDefaults(orgId);
    const { rows: retry } = await pool.query(
      `SELECT key FROM contact_roles
        WHERE org_id = $1 AND side = $2 AND is_active
          AND (key = $3 OR lower(name) = lower($4))
        LIMIT 1`,
      [orgId, side, key, raw]);
    if (retry.length) return retry[0].key;
  }

  throw Object.assign(
    new Error(`"${roleKey}" is not a configured ${side} role. Add it in Settings → Contact roles.`),
    { status: 400 }
  );
}

async function create(orgId, { side, name, sortOrder }) {
  assertSide(side);
  const label = String(name || '').trim();
  if (!label) throw Object.assign(new Error('Role name is required'), { status: 400 });
  const key = slugify(label);
  if (!key) throw Object.assign(new Error('Role name must contain letters or numbers'), { status: 400 });

  const { rows } = await pool.query(
    `INSERT INTO contact_roles (org_id, side, key, name, sort_order)
     VALUES ($1,$2,$3,$4,COALESCE($5, (SELECT COALESCE(MAX(sort_order),0)+10 FROM contact_roles WHERE org_id=$1 AND side=$2)))
     ON CONFLICT (org_id, side, key)
       DO UPDATE SET name = EXCLUDED.name, is_active = true
     RETURNING id, side, key, name, is_system, is_active, sort_order`,
    [orgId, side, key, label, sortOrder ?? null]
  );
  return { role: rows[0] };
}

/** Rename or deactivate. The key is never rewritten — rows already point at it. */
async function update(orgId, id, patch = {}) {
  const sets = [];
  const vals = [id, orgId];

  if (patch.name !== undefined) {
    const label = String(patch.name || '').trim();
    if (!label) throw Object.assign(new Error('Role name cannot be blank'), { status: 400 });
    vals.push(label); sets.push(`name = $${vals.length}`);
  }
  if (patch.isActive !== undefined) {
    // A system role can be renamed but not switched off — logic keys on it.
    vals.push(!!patch.isActive); sets.push(`is_active = CASE WHEN is_system THEN true ELSE $${vals.length} END`);
  }
  if (patch.sortOrder !== undefined) {
    vals.push(parseInt(patch.sortOrder, 10) || 0); sets.push(`sort_order = $${vals.length}`);
  }
  if (!sets.length) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  const { rows } = await pool.query(
    `UPDATE contact_roles SET ${sets.join(', ')}
      WHERE id = $1 AND org_id = $2
      RETURNING id, side, key, name, is_system, is_active, sort_order`,
    vals
  );
  if (!rows.length) throw Object.assign(new Error('Role not found'), { status: 404 });
  return { role: rows[0] };
}

/**
 * Deactivate rather than delete when the role is in use — existing
 * project_contacts / deal_contacts rows hold the key as plain text and would
 * otherwise render as a label nobody can resolve.
 */
async function remove(orgId, id) {
  const { rows: [r] } = await pool.query(
    `SELECT side, key, is_system FROM contact_roles WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!r) throw Object.assign(new Error('Role not found'), { status: 404 });
  if (r.is_system) {
    throw Object.assign(new Error(`"${r.key}" is used by the product itself. You can rename it, but not remove it.`), { status: 400 });
  }

  const { rows: [used] } = await pool.query(
    `SELECT (SELECT count(*) FROM project_contacts WHERE org_id = $1 AND side = $2 AND role = $3)
          + (SELECT count(*) FROM deal_contacts dc JOIN deals d ON d.id = dc.deal_id
              WHERE d.org_id = $1 AND $2 = 'customer' AND dc.role = $3) AS n`,
    [orgId, r.side, r.key]
  );

  if (Number(used.n) > 0) {
    await pool.query(`UPDATE contact_roles SET is_active = false WHERE id = $1 AND org_id = $2`, [id, orgId]);
    return { deactivated: true, inUse: Number(used.n) };
  }
  await pool.query(`DELETE FROM contact_roles WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return { deleted: true };
}

async function reorder(orgId, side, orderedIds = []) {
  assertSide(side);
  for (let i = 0; i < orderedIds.length; i += 1) {
    await pool.query(
      `UPDATE contact_roles SET sort_order = $3 WHERE id = $1 AND org_id = $2 AND side = $4`,
      [orderedIds[i], orgId, (i + 1) * 10, side]
    );
  }
  return list(orgId, { side });
}

module.exports = { SIDES, DEFAULTS, seedDefaults, list, resolveRoleKey, create, update, remove, reorder };
