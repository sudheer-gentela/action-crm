/**
 * crm/customFieldSync.js
 *
 * DROP-IN LOCATION: backend/services/crm/customFieldSync.js
 *
 * Writes CRM field_map entries that have no matching standard GoWarm column
 * into the entity_custom_fields table, keyed by (org_id, entity_type, entity_id, field_key).
 *
 * How it fits into the sync pipeline:
 *   - The orchestrator calls syncCustomFields() after every entity upsert
 *     (account, contact, deal, prospect).
 *   - The SF adapter attaches a `customFieldValues` map on each normalized record
 *     for fields that went through _resolveField() but have no standard column.
 *   - This module writes those values into entity_custom_fields, replacing any
 *     prior value for the same field key on the same entity.
 *
 * entity_custom_fields table schema (already migrated in prod):
 *   id           SERIAL PRIMARY KEY
 *   org_id       INTEGER NOT NULL REFERENCES organizations(id)
 *   entity_type  TEXT NOT NULL   -- 'account' | 'contact' | 'deal' | 'prospect'
 *   entity_id    INTEGER NOT NULL  -- FK to the GoWarm entity row
 *   field_key    TEXT NOT NULL   -- gw_field value from field_map, e.g. 'arr', 'segment'
 *   field_value  TEXT            -- always stored as text; cast on read
 *   source       TEXT            -- 'crm_sync' | 'manual'
 *   created_at   TIMESTAMPTZ
 *   updated_at   TIMESTAMPTZ
 *   UNIQUE (org_id, entity_type, entity_id, field_key)
 *
 * Design decisions:
 *   1. FIELD_KEY is the gw_field value from field_map (already the org admin's
 *      chosen name for the field in GoWarm — no further transformation needed).
 *   2. ALL VALUES ARE STORED AS TEXT. The sync layer doesn't know the intended
 *      type — the frontend/API layer casts on read using the field_map config.
 *   3. NULL VALUES ARE WRITTEN. If SF sends null, we write null to entity_custom_fields.
 *      This means "no value" is explicit, not "never synced".
 *   4. SOURCE IS ALWAYS 'crm_sync' from this module. Manual edits from the
 *      GoWarm UI write 'manual'. This lets the UI distinguish CRM-owned fields.
 *   5. UPSERT STRATEGY: ON CONFLICT (org_id, entity_type, entity_id, field_key)
 *      DO UPDATE — same as all other CRM sync tables.
 */

const { pool } = require('../../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD COLUMN WHITELISTS
// Fields that ARE standard GoWarm columns on each entity table.
// Any gw_field in field_map that is NOT in this set is considered a custom
// field and belongs in entity_custom_fields instead.
// ─────────────────────────────────────────────────────────────────────────────

const STANDARD_FIELDS = {
  account: new Set([
    'name', 'domain', 'industry', 'size', 'location', 'description',
    'owner_id', 'website', 'phone', 'external_refs',
  ]),
  contact: new Set([
    'first_name', 'last_name', 'email', 'phone', 'title', 'location',
    'linkedin_url', 'account_id', 'user_id', 'reports_to_contact_id',
    'external_refs',
  ]),
  deal: new Set([
    'name', 'value', 'stage', 'expected_close_date', 'probability', 'notes',
    'account_id', 'owner_id', 'user_id', 'external_refs',
    'external_crm_type', 'external_crm_deal_id', 'external_crm_close_date',
  ]),
  prospect: new Set([
    'first_name', 'last_name', 'email', 'phone', 'title', 'location',
    'linkedin_url', 'company_name', 'company_domain', 'company_size',
    'company_industry', 'source', 'icp_score', 'account_id', 'stage',
    'owner_id', 'external_refs',
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine which field_map entries for a given entity are custom fields
 * (i.e. not mapped to any standard GoWarm column).
 *
 * Used by the SF adapter to know which fields to include in customFieldValues.
 * Called once at adapter init time per entity type so the adapter can build
 * the right SOQL queries and collect values efficiently.
 *
 * @param {Array}  fieldMap    - org_integrations.settings.field_map
 * @param {string} sfObject    - 'Account' | 'Contact' | 'Opportunity' | 'Lead'
 * @param {string} gwEntity    - 'account' | 'contact' | 'deal' | 'prospect'
 * @returns {Array<{ sf_field: string, gw_field: string }>}
 *   Only the entries that should go to entity_custom_fields.
 */
function getCustomFieldMappings(fieldMap, sfObject, gwEntity) {
  const standardSet = STANDARD_FIELDS[gwEntity] || new Set();
  return fieldMap.filter(m => {
    if (m.sf_object !== sfObject) return false;
    if (m.direction === 'gw_to_sf') return false; // write-back only — skip on inbound sync
    const bareField = m.gw_field.includes('.')
      ? m.gw_field.split('.').slice(1).join('.')
      : m.gw_field;
    return !standardSet.has(bareField);
  }).map(m => ({
    sf_field: m.sf_field,
    gw_field: m.gw_field.includes('.')
      ? m.gw_field.split('.').slice(1).join('.')
      : m.gw_field,
  }));
}

/**
 * Write custom field values for a single entity to entity_custom_fields.
 *
 * Called by the orchestrator after each entity upsert.
 * No-ops if customFieldValues is empty or the entity ID is null.
 *
 * @param {object} opts
 * @param {number}  opts.orgId           - Organization ID
 * @param {string}  opts.entityType      - 'account' | 'contact' | 'deal' | 'prospect'
 * @param {number}  opts.entityId        - GoWarm row ID of the upserted entity
 * @param {Object}  opts.customFieldValues - { [gw_field_key]: value } map from adapter
 * @returns {{ written: number }}
 */
async function syncCustomFields({ orgId, entityType, entityId, customFieldValues }) {
  if (!entityId || !customFieldValues || Object.keys(customFieldValues).length === 0) {
    return { written: 0 };
  }

  const entries = Object.entries(customFieldValues);
  let written = 0;

  for (const [fieldKey, rawValue] of entries) {
    try {
      // Store as text — null stays null, everything else is stringified
      const fieldValue = rawValue == null ? null : String(rawValue);

      await pool.query(`
        INSERT INTO entity_custom_fields
          (org_id, entity_type, entity_id, field_key, field_value, source, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, 'crm_sync', NOW(), NOW())
        ON CONFLICT (org_id, entity_type, entity_id, field_key)
        DO UPDATE SET
          field_value = EXCLUDED.field_value,
          source      = 'crm_sync',
          updated_at  = NOW()
      `, [orgId, entityType, entityId, fieldKey, fieldValue]);

      written++;
    } catch (err) {
      // Non-fatal per field — log and continue
      console.error(
        `  ⚠️  [CustomFields] org ${orgId} ${entityType} ${entityId} field "${fieldKey}": ${err.message}`
      );
    }
  }

  return { written };
}

/**
 * Bulk-read custom fields for a set of entity IDs.
 * Returns a map keyed by entity_id → { field_key: field_value }.
 * Used by API routes to hydrate entity responses with custom field data.
 *
 * @param {number}   orgId
 * @param {string}   entityType
 * @param {number[]} entityIds
 * @returns {Map<number, Object>}
 */
async function getCustomFieldsForEntities(orgId, entityType, entityIds) {
  const result = new Map();
  if (!entityIds || entityIds.length === 0) return result;

  const rows = await pool.query(`
    SELECT entity_id, field_key, field_value
    FROM entity_custom_fields
    WHERE org_id = $1
      AND entity_type = $2
      AND entity_id = ANY($3::int[])
    ORDER BY entity_id, field_key
  `, [orgId, entityType, entityIds]);

  for (const row of rows.rows) {
    if (!result.has(row.entity_id)) result.set(row.entity_id, {});
    result.get(row.entity_id)[row.field_key] = row.field_value;
  }

  return result;
}

module.exports = {
  getCustomFieldMappings,
  syncCustomFields,
  getCustomFieldsForEntities,
  STANDARD_FIELDS, // exported for tests
};
