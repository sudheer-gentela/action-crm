/**
 * services/CustomFieldService.js
 *
 * DROP-IN LOCATION: backend/services/CustomFieldService.js
 *
 * The SINGLE writer/reader for custom field VALUES (design decision D1).
 * Every source — manual API edits, CSV import, AI research, and (Phase F)
 * CRM sync — goes through writeValue()/promote(); every consumer reads through
 * readValues(). This module owns:
 *   - typed casting between JS values and the value_text/number/date/bool columns,
 *     driven by the field's `field_type`,
 *   - the partial-index-aware upsert (durable plane vs campaign plane, D4/D7),
 *   - the promote operation (campaign-scoped → durable twin on the same entity).
 *
 * Scope model (see custom_fields_design_handoff.md):
 *   campaignId == null  → DURABLE value, lives on the prospect/account itself.
 *   campaignId == <id>  → CAMPAIGN-SCOPED value, local to that campaign.
 *   promote(...)        → writes the campaignId=null twin on the same entity.
 *
 * Storage notes:
 *   - entity_custom_fields has NO RLS in prod; it is scoped by explicit org_id.
 *     Every query here passes org_id explicitly.
 *   - All methods accept an optional `client` (a pg client from
 *     withOrgTransaction) so callers can run inside their own transaction.
 *     When omitted, the shared pool is used.
 */

const { pool } = require('../config/database');

const VALID_ENTITY_TYPES = new Set(['account', 'prospect', 'contact', 'deal']);
const VALID_FIELD_TYPES  = new Set(['text', 'number', 'date', 'boolean', 'picklist']);

// field_type → the value_* column that holds it.
const TYPE_COLUMN = {
  text:     'value_text',
  picklist: 'value_text',
  number:   'value_number',
  date:     'value_date',
  boolean:  'value_bool',
};

const ALL_VALUE_COLUMNS = ['value_text', 'value_number', 'value_date', 'value_bool'];

// ─────────────────────────────────────────────────────────────────────────────
// Casting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a raw JS value into the typed column for a given field_type.
 * Returns { column, value } where value is null-safe and DB-ready.
 * Throws on an unknown field_type so bad definitions fail loudly at write time.
 */
function castForWrite(fieldType, raw) {
  if (!VALID_FIELD_TYPES.has(fieldType)) {
    throw new Error(`CustomFieldService: unknown field_type "${fieldType}"`);
  }
  const column = TYPE_COLUMN[fieldType];

  if (raw === null || raw === undefined || raw === '') {
    return { column, value: null };
  }

  switch (fieldType) {
    case 'text':
    case 'picklist':
      return { column, value: String(raw) };

    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
      return { column, value: Number.isFinite(n) ? n : null };
    }

    case 'date': {
      // Accept Date or ISO-ish string; store as YYYY-MM-DD (the column is `date`).
      const d = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(d.getTime())) return { column, value: null };
      return { column, value: d.toISOString().slice(0, 10) };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { column, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['true', 't', 'yes', 'y', '1'].includes(s))  return { column, value: true };
      if (['false', 'f', 'no', 'n', '0'].includes(s)) return { column, value: false };
      return { column, value: null };
    }

    default:
      return { column, value: null };
  }
}

/**
 * Read the typed value back out of a row as a native JS value.
 */
function castForRead(fieldType, row) {
  switch (fieldType) {
    case 'number':  return row.value_number === null ? null : Number(row.value_number);
    case 'date':    return row.value_date; // pg returns a Date for `date`
    case 'boolean': return row.value_bool;
    case 'text':
    case 'picklist':
    default:        return row.value_text;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a single custom field value (durable or campaign-scoped).
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {string}  opts.entityType  - 'account' | 'prospect' | 'contact' | 'deal'
 * @param {number}  opts.entityId
 * @param {string}  opts.fieldKey
 * @param {string}  opts.fieldType   - drives the target column + cast
 * @param {*}       opts.value       - raw JS value (cast per fieldType)
 * @param {?number} [opts.campaignId=null] - null = durable, set = campaign-scoped
 * @param {string}  [opts.source='manual'] - manual | csv | ai_research | crm_sync
 * @param {?number} [opts.fieldDefId=null]
 * @param {?string} [opts.fieldLabel=null]
 * @param {object}  [opts.client]    - optional pg client (for caller transactions)
 * @returns {Promise<object>} the upserted row
 */
async function writeValue(opts) {
  const {
    orgId, entityType, entityId, fieldKey, fieldType, value,
    campaignId = null, source = 'manual', fieldDefId = null, fieldLabel = null,
    client,
  } = opts;

  if (!orgId || !entityType || !entityId || !fieldKey) {
    throw new Error('CustomFieldService.writeValue: orgId, entityType, entityId, fieldKey are required');
  }
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new Error(`CustomFieldService.writeValue: invalid entityType "${entityType}"`);
  }

  const exec = client || pool;
  const { column, value: castValue } = castForWrite(fieldType, value);

  // Build the value_* assignment list: chosen column gets the value, others NULL.
  const valueCols = ALL_VALUE_COLUMNS.map(c => (c === column ? castValue : null));

  // The conflict target must match the relevant PARTIAL unique index, including
  // its predicate (durable plane vs campaign plane). See migration 2026_28.
  const isDurable = campaignId === null || campaignId === undefined;
  const conflictTarget = isDurable
    ? '(org_id, entity_type, entity_id, field_key) WHERE campaign_id IS NULL'
    : '(org_id, entity_type, entity_id, field_key, campaign_id) WHERE campaign_id IS NOT NULL';

  const sql = `
    INSERT INTO entity_custom_fields
      (org_id, entity_type, entity_id, field_key, field_label, field_type,
       value_text, value_number, value_date, value_bool,
       source, field_def_id, campaign_id, created_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
    ON CONFLICT ${conflictTarget}
    DO UPDATE SET
      field_label  = EXCLUDED.field_label,
      field_type   = EXCLUDED.field_type,
      value_text   = EXCLUDED.value_text,
      value_number = EXCLUDED.value_number,
      value_date   = EXCLUDED.value_date,
      value_bool   = EXCLUDED.value_bool,
      source       = EXCLUDED.source,
      field_def_id = EXCLUDED.field_def_id,
      updated_at   = now()
    RETURNING *
  `;
  const params = [
    orgId, entityType, entityId, fieldKey, fieldLabel, fieldType,
    valueCols[0], valueCols[1], valueCols[2], valueCols[3],
    source, fieldDefId, isDurable ? null : campaignId,
  ];

  const { rows } = await exec.query(sql, params);
  return rows[0];
}

/**
 * Promote a campaign-scoped value to a durable value on the SAME entity.
 * Reads the campaign-scoped row, then upserts the campaign_id=null twin.
 * No-ops (returns null) if the campaign-scoped value doesn't exist.
 */
async function promote(opts) {
  const { orgId, entityType, entityId, fieldKey, campaignId, source = 'manual', client } = opts;
  if (!campaignId) {
    throw new Error('CustomFieldService.promote: campaignId is required (the source scope)');
  }
  const exec = client || pool;

  const { rows } = await exec.query(`
    SELECT field_type, field_label, field_def_id,
           value_text, value_number, value_date, value_bool
      FROM entity_custom_fields
     WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3
       AND field_key = $4 AND campaign_id = $5
     LIMIT 1
  `, [orgId, entityType, entityId, fieldKey, campaignId]);

  if (rows.length === 0) return null;
  const src = rows[0];

  return writeValue({
    orgId, entityType, entityId, fieldKey,
    fieldType:  src.field_type,
    value:      castForRead(src.field_type, src),
    fieldLabel: src.field_label,
    fieldDefId: src.field_def_id,
    campaignId: null,            // durable twin
    source,                      // who promoted (e.g. 'manual')
    client,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read custom field values for a set of entity IDs, returning native JS values.
 *
 * Scope control:
 *   - includeDurable=true  (default) → include campaign_id IS NULL rows
 *   - campaignId set        → ALSO include campaign_id = campaignId rows
 * Both can be true: that's the campaign-view read (durable baseline + scoped),
 * each row tagged with `scope` ('durable' | 'campaign') and `source`.
 *
 * @returns {Promise<Map<number, Array<{field_key, value, field_type, scope, source, field_def_id, campaign_id}>>>}
 */
async function readValues(opts) {
  const {
    orgId, entityType, entityIds,
    campaignId = null, includeDurable = true,
    client,
  } = opts;

  const result = new Map();
  if (!Array.isArray(entityIds) || entityIds.length === 0) return result;
  if (!includeDurable && campaignId === null) return result; // nothing requested

  const exec = client || pool;

  const scopeConds = [];
  const params = [orgId, entityType, entityIds];
  if (includeDurable) scopeConds.push('campaign_id IS NULL');
  if (campaignId !== null && campaignId !== undefined) {
    params.push(campaignId);
    scopeConds.push(`campaign_id = $${params.length}`);
  }

  const { rows } = await exec.query(`
    SELECT entity_id, field_key, field_type, source, field_def_id, campaign_id,
           value_text, value_number, value_date, value_bool
      FROM entity_custom_fields
     WHERE org_id = $1 AND entity_type = $2 AND entity_id = ANY($3::int[])
       AND (${scopeConds.join(' OR ')})
     ORDER BY entity_id, field_key, campaign_id NULLS FIRST
  `, params);

  for (const row of rows) {
    if (!result.has(row.entity_id)) result.set(row.entity_id, []);
    result.get(row.entity_id).push({
      field_key:    row.field_key,
      field_type:   row.field_type,
      value:        castForRead(row.field_type, row),
      scope:        row.campaign_id === null ? 'durable' : 'campaign',
      source:       row.source,
      field_def_id: row.field_def_id,
      campaign_id:  row.campaign_id,
    });
  }
  return result;
}

/**
 * Delete a single custom field value (durable or campaign-scoped) on an entity.
 * campaignId == null → the durable value; set → that campaign's value.
 * @returns {Promise<{deleted:number}>}
 */
async function deleteValue(opts) {
  const { orgId, entityType, entityId, fieldKey, campaignId = null, client } = opts;
  if (!orgId || !entityType || !entityId || !fieldKey) {
    throw new Error('CustomFieldService.deleteValue: orgId, entityType, entityId, fieldKey are required');
  }
  const exec = client || pool;
  const isDurable = campaignId === null || campaignId === undefined;
  const sql = `
    DELETE FROM entity_custom_fields
     WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3 AND field_key = $4
       AND ${isDurable ? 'campaign_id IS NULL' : 'campaign_id = $5'}
    RETURNING id
  `;
  const params = isDurable
    ? [orgId, entityType, entityId, fieldKey]
    : [orgId, entityType, entityId, fieldKey, campaignId];
  const { rows } = await exec.query(sql, params);
  return { deleted: rows.length };
}

module.exports = {
  writeValue,
  promote,
  readValues,
  deleteValue,
  // exported for tests / reuse
  castForWrite,
  castForRead,
  VALID_ENTITY_TYPES,
  VALID_FIELD_TYPES,
};
