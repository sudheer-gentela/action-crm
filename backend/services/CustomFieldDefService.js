/**
 * services/CustomFieldDefService.js
 *
 * DROP-IN LOCATION: backend/services/CustomFieldDefService.js
 *
 * The org-level custom-field DEFINITION registry (custom_field_defs).
 * Definitions declare which custom columns exist, their type, and their scope:
 *   campaign_id NULL → org-level field (available on the entity and in every campaign)
 *   campaign_id SET  → campaign-only field (D6)
 *   target_entity    → 'account' | 'prospect' (also the value's promote destination)
 *
 * This module is the companion to CustomFieldService (which owns VALUES).
 * resolveDef() is the bridge: given an incoming value write, it finds the
 * governing definition (campaign-specific takes precedence over org-level),
 * so values can only be written against a defined field.
 *
 * No RLS on this table family — every query is scoped by explicit org_id.
 */

const { pool } = require('../config/database');

const VALID_TARGET = new Set(['account', 'prospect', 'contact', 'deal']);
const VALID_TYPE   = new Set(['text', 'number', 'date', 'boolean', 'picklist']);
// snake_case-ish: starts with a letter, then letters/digits/underscores, ≤100 chars.
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;

const UPDATABLE = new Set(['label', 'field_type', 'picklist_options', 'display_order', 'active']);

function validateForCreate({ targetEntity, fieldKey, fieldType, picklistOptions }) {
  if (!VALID_TARGET.has(targetEntity)) {
    throw new Error(`invalid target_entity "${targetEntity}" (expected account|prospect)`);
  }
  if (typeof fieldKey !== 'string' || !FIELD_KEY_RE.test(fieldKey)) {
    throw new Error('invalid field_key (use lowercase letters, digits, underscores; start with a letter; ≤100 chars)');
  }
  if (!VALID_TYPE.has(fieldType)) {
    throw new Error(`invalid field_type "${fieldType}"`);
  }
  if (fieldType === 'picklist' && picklistOptions != null && !Array.isArray(picklistOptions)) {
    throw new Error('picklist_options must be an array');
  }
}

/**
 * List definitions for an org.
 *   - Always includes org-level defs (campaign_id IS NULL).
 *   - If campaignId is provided, ALSO includes that campaign's campaign-only defs.
 *   - Optional targetEntity filter; inactive excluded unless includeInactive.
 */
async function listDefs({ orgId, targetEntity = null, campaignId = null, includeInactive = false, client }) {
  const exec = client || pool;
  const { rows } = await exec.query(`
    SELECT * FROM custom_field_defs
     WHERE org_id = $1
       AND ($2::text IS NULL OR target_entity = $2)
       AND (campaign_id IS NULL OR campaign_id = $3)
       AND ($4 = true OR active = true)
     ORDER BY campaign_id NULLS FIRST, display_order, field_key
  `, [orgId, targetEntity, campaignId, includeInactive]);
  return rows;
}

async function getDef({ orgId, id, client }) {
  const exec = client || pool;
  const { rows } = await exec.query(
    `SELECT * FROM custom_field_defs WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return rows[0] || null;
}

/**
 * Find the definition governing a value write.
 * Campaign-specific definition wins over the org-level one when both exist.
 * Returns the def row or null.
 */
async function resolveDef({ orgId, targetEntity, fieldKey, campaignId = null, client }) {
  const exec = client || pool;
  const { rows } = await exec.query(`
    SELECT * FROM custom_field_defs
     WHERE org_id = $1 AND target_entity = $2 AND field_key = $3 AND active = true
       AND (campaign_id IS NULL OR campaign_id = $4)
     ORDER BY (campaign_id IS NOT NULL) DESC   -- campaign-specific first
     LIMIT 1
  `, [orgId, targetEntity, fieldKey, campaignId]);
  return rows[0] || null;
}

async function createDef({ orgId, targetEntity, fieldKey, label = null, fieldType = 'text',
                           picklistOptions = [], displayOrder = 0, campaignId = null, client }) {
  validateForCreate({ targetEntity, fieldKey, fieldType, picklistOptions });
  const exec = client || pool;
  const { rows } = await exec.query(`
    INSERT INTO custom_field_defs
      (org_id, campaign_id, target_entity, field_key, label, field_type, picklist_options, display_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    RETURNING *
  `, [orgId, campaignId, targetEntity, fieldKey, label, fieldType,
      JSON.stringify(picklistOptions ?? []), displayOrder]);
  return rows[0];
}

/**
 * Update mutable fields of a definition: label, field_type, picklist_options,
 * display_order, active. field_key / target_entity / campaign_id are immutable
 * (changing them would orphan existing values).
 */
async function updateDef({ orgId, id, patch = {}, client }) {
  const exec = client || pool;

  const sets = [];
  const params = [];
  let i = 1;

  for (const [key, val] of Object.entries(patch)) {
    if (!UPDATABLE.has(key)) continue;
    if (key === 'field_type' && !VALID_TYPE.has(val)) {
      throw new Error(`invalid field_type "${val}"`);
    }
    if (key === 'picklist_options') {
      if (val != null && !Array.isArray(val)) throw new Error('picklist_options must be an array');
      sets.push(`picklist_options = $${i}::jsonb`);
      params.push(JSON.stringify(val ?? []));
    } else {
      sets.push(`${key} = $${i}`);
      params.push(val);
    }
    i++;
  }

  if (sets.length === 0) {
    return getDef({ orgId, id, client });
  }

  params.push(id, orgId);
  const { rows } = await exec.query(`
    UPDATE custom_field_defs
       SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${i} AND org_id = $${i + 1}
    RETURNING *
  `, params);
  return rows[0] || null;
}

/**
 * Soft-delete: deactivate a definition (active = false). Non-destructive —
 * existing values are retained. A hard delete + value purge is a deliberate
 * separate admin operation (not exposed here).
 */
async function deactivateDef({ orgId, id, client }) {
  const exec = client || pool;
  const { rows } = await exec.query(`
    UPDATE custom_field_defs SET active = false, updated_at = now()
     WHERE id = $1 AND org_id = $2
    RETURNING *
  `, [id, orgId]);
  return rows[0] || null;
}

module.exports = {
  listDefs,
  getDef,
  resolveDef,
  createDef,
  updateDef,
  deactivateDef,
  VALID_TARGET,
  VALID_TYPE,
  FIELD_KEY_RE,
};
