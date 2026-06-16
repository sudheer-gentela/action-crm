/**
 * services/CustomFieldImportService.js
 *
 * DROP-IN LOCATION: backend/services/CustomFieldImportService.js
 *
 * Phase C — bulk-seed DURABLE custom field values onto existing prospects /
 * accounts from parsed CSV rows. (The frontend parses the CSV to JSON and POSTs
 * rows, matching the existing /bulk convention — no server-side CSV parsing.)
 *
 * Flow per run:
 *   1. Resolve each mapped column to its governing definition
 *      (create missing defs only when createDefs=true and not a dry run).
 *   2. Match each row to an existing entity by a chosen key (one batched query).
 *   3. For each matched row × resolved column, cast per the def's type and
 *      upsert a durable value (campaign_id NULL) via CustomFieldService,
 *      source='csv'. Re-runs upsert in place (no dupes — partial unique index).
 *
 * dryRun (default true) writes nothing and returns the same summary with
 * "planned" counts + cast warnings + which defs would be created. This mirrors
 * the /bulk-preflight convention and the project's dry-run-first rule.
 *
 * Entity support is config-driven (ENTITY_CFG): adding contact/deal/contract
 * later is a config entry + widening the def/route allow-lists.
 */

const { pool } = require('../config/database');
const Defs = require('./CustomFieldDefService');
const CF   = require('./CustomFieldService');

const MAX_ROWS = 1000;

// Which table + match keys each entity exposes. Text keys match case-insensitively.
const ENTITY_CFG = {
  prospect: {
    table: 'prospects',
    match: { id: { col: 'id', numeric: true }, email: { col: 'email' }, linkedin_url: { col: 'linkedin_url' } },
  },
  account: {
    table: 'accounts',
    match: { id: { col: 'id', numeric: true }, domain: { col: 'domain' }, name: { col: 'name' } },
  },
  contact: {
    table: 'contacts',
    match: { id: { col: 'id', numeric: true }, email: { col: 'email' }, linkedin_url: { col: 'linkedin_url' } },
  },
  deal: {
    table: 'deals',
    match: { id: { col: 'id', numeric: true }, external_crm_deal_id: { col: 'external_crm_deal_id' }, name: { col: 'name' } },
  },
};

function normKey(v, numeric) {
  if (v === null || v === undefined) return null;
  if (numeric) { const n = parseInt(v, 10); return Number.isInteger(n) ? n : null; }
  const s = String(v).trim().toLowerCase();
  return s === '' ? null : s;
}

/**
 * Build the entity lookup map: normalized match-key → entity_id.
 * One batched query over the entity table, org-scoped, excluding soft-deleted.
 */
async function buildMatchMap({ orgId, entityCfg, matchSpec, keys, exec }) {
  const map = new Map();
  const distinct = [...new Set(keys.filter(k => k !== null))];
  if (distinct.length === 0) return map;

  const col = matchSpec.col;
  const selector = matchSpec.numeric ? col : `LOWER(${col})`;
  const { rows } = await exec.query(
    `SELECT id, ${col} AS k
       FROM ${entityCfg.table}
      WHERE org_id = $1
        AND deleted_at IS NULL
        AND ${selector} = ANY($2)`,
    [orgId, distinct]
  );
  for (const r of rows) {
    const norm = matchSpec.numeric ? r.k : String(r.k).trim().toLowerCase();
    if (!map.has(norm)) map.set(norm, r.id); // first wins on ambiguous keys
  }
  return map;
}

/**
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {string}  opts.targetEntity   - 'account' | 'prospect'
 * @param {Array<object>} opts.rows      - parsed CSV rows (objects keyed by header)
 * @param {string}  opts.matchBy         - which key column to match on (per ENTITY_CFG)
 * @param {Array<{column,fieldKey,fieldType?,label?}>} opts.columnMap
 * @param {boolean} [opts.createDefs=false] - auto-create missing defs (commit only)
 * @param {boolean} [opts.dryRun=true]
 * @param {?number} [opts.campaignId=null]  - null = durable (default); set = campaign-scoped seed
 * @param {object}  [opts.client]
 * @returns {Promise<object>} summary
 */
async function runImport(opts) {
  const {
    orgId, targetEntity, rows, matchBy, columnMap,
    createDefs = false, dryRun = true, campaignId = null, client,
  } = opts;

  const exec = client || pool;
  const cfg = ENTITY_CFG[targetEntity];
  if (!cfg) throw new Error(`unsupported targetEntity "${targetEntity}"`);
  const matchSpec = cfg.match[matchBy];
  if (!matchSpec) throw new Error(`unsupported matchBy "${matchBy}" for ${targetEntity} (expected: ${Object.keys(cfg.match).join(', ')})`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be a non-empty array');
  if (rows.length > MAX_ROWS) throw new Error(`Maximum ${MAX_ROWS} rows per import`);
  if (!Array.isArray(columnMap) || columnMap.length === 0) throw new Error('columnMap must be a non-empty array');

  // ── 1. Resolve / (optionally) create definitions for each mapped column ──
  const defsResolved = [];
  const colToDef = new Map(); // column → def row (only resolved/active ones)
  for (const m of columnMap) {
    if (!m || !m.column || !m.fieldKey) {
      defsResolved.push({ column: m && m.column, fieldKey: m && m.fieldKey, action: 'invalid_mapping' });
      continue;
    }
    let def = await Defs.resolveDef({ orgId, targetEntity, fieldKey: m.fieldKey, campaignId, client: exec });
    if (def) {
      colToDef.set(m.column, def);
      defsResolved.push({ column: m.column, fieldKey: m.fieldKey, defId: def.id, fieldType: def.field_type, action: 'existing' });
    } else if (createDefs && !dryRun) {
      def = await Defs.createDef({
        orgId, targetEntity, fieldKey: m.fieldKey,
        label: m.label ?? m.column, fieldType: m.fieldType || 'text',
        campaignId, client: exec,
      });
      colToDef.set(m.column, def);
      defsResolved.push({ column: m.column, fieldKey: m.fieldKey, defId: def.id, fieldType: def.field_type, action: 'created' });
    } else {
      const wouldCreate = createDefs; // dry run + createDefs → preview as if created
      defsResolved.push({
        column: m.column, fieldKey: m.fieldKey,
        action: wouldCreate ? 'would_create' : 'missing_def',
      });
      // Let the preview loop plan values + flag cast issues for would-create
      // columns, using the column map's declared type (no def exists yet).
      if (wouldCreate) {
        colToDef.set(m.column, {
          id: null, field_key: m.fieldKey,
          field_type: m.fieldType || 'text', label: m.label ?? m.column,
        });
      }
    }
  }

  // ── 2. Match rows to entities (batched) ──
  const rowKeys = rows.map(r => normKey(r[matchBy], matchSpec.numeric));
  const matchMap = await buildMatchMap({ orgId, entityCfg: cfg, matchSpec, keys: rowKeys, exec });

  // ── 3. Walk rows ──
  let matched = 0, unmatched = 0, valuesWritten = 0, valuesPlanned = 0;
  const unmatchedKeys = [];
  const castWarnings = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = rowKeys[i];
    const entityId = key === null ? undefined : matchMap.get(key);

    if (!entityId) {
      unmatched++;
      if (unmatchedKeys.length < 50) unmatchedKeys.push(row[matchBy] ?? null);
      continue;
    }
    matched++;

    for (const [column, def] of colToDef.entries()) {
      const raw = row[column];
      if (raw === undefined) continue; // column absent in this row → skip (don't null it)

      // Detect lossy casts so the preview can warn (e.g. "abc" into a number).
      const { value: cast } = CF.castForWrite(def.field_type, raw);
      if (cast === null && raw !== null && raw !== undefined && String(raw).trim() !== '') {
        if (castWarnings.length < 100) {
          castWarnings.push({ row: i, column, fieldKey: def.field_key, value: raw, reason: `not a valid ${def.field_type}` });
        }
      }

      if (dryRun) { valuesPlanned++; continue; }

      await CF.writeValue({
        orgId, entityType: targetEntity, entityId,
        fieldKey: def.field_key, fieldType: def.field_type,
        fieldLabel: def.label, fieldDefId: def.id,
        value: raw, campaignId, source: 'csv', client: exec,
      });
      valuesWritten++;
    }
  }

  return {
    dryRun, targetEntity, matchBy, scope: campaignId == null ? 'durable' : 'campaign',
    campaignId: campaignId ?? null,
    totalRows: rows.length,
    matched, unmatched,
    unmatchedKeysSample: unmatchedKeys,
    valuesWritten, valuesPlanned,
    defsResolved,
    castWarnings,
  };
}

module.exports = { runImport, ENTITY_CFG, MAX_ROWS };
