/**
 * services/ListSignalIngestService.js
 *
 * DROP-IN LOCATION: backend/services/ListSignalIngestService.js
 *
 * Motion-1 adapter — Apollo/ZoomInfo LIST INGEST (Phase 6). Turns the
 * QUALIFIER columns of an imported list into normalized signals (source='list')
 * on the row's account/prospect, via SignalService. The rep's contact data
 * (email/phone/name) is handled by the existing /prospects/bulk path — this
 * service is ONLY about the signals the list carries ("qualifiers are ingested
 * from the list, not re-derived", §4).
 *
 * DESIGN FIT:
 *   - Mirrors writeRowCustomFields in the bulk-import route: same per-row hook,
 *     same (prospectId, accountId) keying, same "blank cells never write, a
 *     failure logs but never fails the row" contract. The route calls
 *     ingestRowSignals(row, prospectId, accountId, mapping) right where it
 *     already calls writeRowCustomFields.
 *   - CSV is parsed CLIENT-SIDE and posted as JSON (the NetworkConnectionIngest
 *     / prospects-bulk convention) — this service never parses CSV.
 *   - Every written signal carries source='list', observed_at (the import
 *     time, or a per-mapping observed column if provided), and confidence
 *     (default 'high' — list facts are vendor-stated). Reconciliation +
 *     freshness are enforced downstream by SignalService (P1): a fresh rep
 *     value already on the entity is never clobbered by a list write.
 *   - After a batch, callers trigger SignalActionSurfacer.reevalOnCapture so
 *     the queue reflects the new signals (§6: "re-evaluated on fresh capture").
 *
 * The mapping shape is one entry per column:
 *   { column, signal_key, entity, value_type, confidence?, observed_column? }
 * value_type ∈ date|number|boolean|string|set. Coercion is deliberately
 * forgiving (blanks and unparseable cells are skipped, never written as false
 * — the unknown-never-false rule starts at ingest).
 */

const SignalService = require('./SignalService');

const VALID_ENTITIES = new Set(['account', 'prospect']);
const VALID_VALUE_TYPES = new Set(['date', 'number', 'boolean', 'string', 'set']);
const SIGNAL_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;

// Truthy/falsey tokens for boolean coercion (list exports vary wildly).
const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1', 't']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0', 'f']);

// ─────────────────────────────────────────────────────────────────────────────
// Mapping validation (shape-only, like cleanTargeting)
// ─────────────────────────────────────────────────────────────────────────────

function cleanMappingEntry(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const column = typeof m.column === 'string' ? m.column.trim() : '';
  const signalKey = typeof m.signal_key === 'string' ? m.signal_key.trim() : '';
  const entity = typeof m.entity === 'string' ? m.entity.trim() : '';
  const valueType = typeof m.value_type === 'string' ? m.value_type.trim() : 'string';
  if (!column || !SIGNAL_KEY_RE.test(signalKey)) return null;
  if (!VALID_ENTITIES.has(entity)) return null;
  if (!VALID_VALUE_TYPES.has(valueType)) return null;
  const confidence = ['high', 'medium', 'low'].includes(m.confidence) ? m.confidence : 'high';
  const out = { column, signal_key: signalKey, entity, value_type: valueType, confidence };
  if (typeof m.observed_column === 'string' && m.observed_column.trim()) {
    out.observed_column = m.observed_column.trim();
  }
  return out;
}

function cleanMappings(v) {
  if (!Array.isArray(v)) return [];
  return v.map(cleanMappingEntry).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell coercion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a raw cell to the mapped value_type. Returns { ok, value } — ok=false
 * means "skip this cell" (blank or unparseable ⇒ no signal written, never a
 * false value). This is where the unknown-never-false guarantee begins.
 */
function coerceCell(raw, valueType) {
  if (raw === undefined || raw === null) return { ok: false };
  const s = String(raw).trim();
  if (s === '') return { ok: false };

  switch (valueType) {
    case 'string':
      return { ok: true, value: s };

    case 'number': {
      // Strip commas / currency symbols / whitespace.
      const n = Number(s.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }

    case 'boolean': {
      const t = s.toLowerCase();
      if (TRUE_TOKENS.has(t)) return { ok: true, value: true };
      if (FALSE_TOKENS.has(t)) return { ok: true, value: false };
      return { ok: false }; // ambiguous → skip (don't guess false)
    }

    case 'date': {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return { ok: false };
      // Store as ISO date string — evaluator's coerceDate reads it back.
      return { ok: true, value: d.toISOString() };
    }

    case 'set': {
      // Split on comma / semicolon / pipe into a de-duped string array.
      const parts = s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
      const uniq = [...new Set(parts)];
      return uniq.length ? { ok: true, value: uniq } : { ok: false };
    }

    default:
      return { ok: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: row + mapping → signal write specs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert ONE list row into signal write specs, given the resolved entity ids.
 * Pure — no DB. Header-casing tolerant (matches the client-parser convention:
 * a mapping column "Latest Funding Date" also matches "latest funding date"
 * or "latest_funding_date" keys in the row object).
 *
 * @param {object} row          - the parsed list row (column → cell)
 * @param {object} ids          - { accountId, prospectId }
 * @param {object[]} mappings    - cleaned mapping entries
 * @param {Date}  [now]          - default observed_at
 * @returns {Array<{entityType, entityId, key, value, source, observedAt, confidence}>}
 */
function mapRowToSignals(row, ids, mappings, now = new Date()) {
  if (!row || typeof row !== 'object') return [];
  const specs = [];

  // Build a case/format-insensitive lookup of the row's cells once.
  const cellIndex = buildCellIndex(row);

  for (const m of mappings) {
    const entityId = m.entity === 'account' ? ids.accountId : ids.prospectId;
    if (!entityId) continue; // no such entity for this row → skip

    const raw = lookupCell(cellIndex, m.column);
    const { ok, value } = coerceCell(raw, m.value_type);
    if (!ok) continue; // blank / unparseable → no signal (unknown, not false)

    // Optional per-mapping observed date column (e.g. a "Signal Date" column);
    // else the import time.
    let observedAt = now;
    if (m.observed_column) {
      const obsRaw = lookupCell(cellIndex, m.observed_column);
      const obs = coerceCell(obsRaw, 'date');
      if (obs.ok) observedAt = new Date(obs.value);
    }

    specs.push({
      entityType: m.entity,
      entityId,
      key: m.signal_key,
      value,
      source: 'list',
      observedAt,
      confidence: m.confidence || 'high',
    });
  }
  return specs;
}

// Normalize a header/key for tolerant matching: lowercase, collapse
// non-alphanumerics to nothing. "Latest Funding Date" / "latest_funding_date"
// / "latestFundingDate" all fold to "latestfundingdate".
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildCellIndex(row) {
  const idx = new Map();
  for (const [k, v] of Object.entries(row)) {
    if (k === 'customFields') continue; // reserved by the bulk-import path
    idx.set(normKey(k), v);
  }
  return idx;
}

function lookupCell(cellIndex, column) {
  return cellIndex.has(normKey(column)) ? cellIndex.get(normKey(column)) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB: write a row's signals (the bulk-import hook)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the list-derived signals for ONE imported row. Slots into the bulk
 * import loop next to writeRowCustomFields:
 *
 *   await ListSignalIngestService.ingestRowSignals({
 *     orgId, row, accountId, prospectId, mappings, client: db,
 *   });
 *
 * A per-signal write failure is logged, never throws (the prospect/account is
 * already persisted — same contract as CF writes).
 *
 * @returns {Promise<{ written: number, skipped: number }>}
 */
async function ingestRowSignals({ orgId, row, accountId, prospectId, mappings, now, client }) {
  const cleaned = cleanMappings(mappings);
  if (cleaned.length === 0) return { written: 0, skipped: 0 };

  const specs = mapRowToSignals(row, { accountId, prospectId }, cleaned, now || new Date());
  let written = 0;
  let skipped = 0;
  for (const spec of specs) {
    try {
      const res = await SignalService.writeSignal({ ...spec, orgId, client });
      if (res.written) written += 1; else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.warn(`[ListSignalIngest] signal write failed (${spec.entityType}.${spec.key}):`, err.message);
    }
  }
  return { written, skipped };
}

/**
 * Batch entry point for a standalone list ingest (not piggybacking the bulk
 * import) — e.g. a "pull from datasource" flow (P9) or a dedicated list-signal
 * upload. Each item is { row, accountId, prospectId }. Returns totals + the set
 * of touched entities so the caller can drive SignalActionSurfacer.reevalOnCapture.
 *
 * @returns {Promise<{ written, skipped, touched: Array<{entityType, entityId}> }>}
 */
async function ingestRows({ orgId, items, mappings, now, client }) {
  const cleaned = cleanMappings(mappings);
  let written = 0;
  let skipped = 0;
  const touchedSet = new Set();

  for (const item of items || []) {
    const specs = mapRowToSignals(item.row, { accountId: item.accountId, prospectId: item.prospectId }, cleaned, now || new Date());
    for (const spec of specs) {
      try {
        const res = await SignalService.writeSignal({ ...spec, orgId, client });
        if (res.written) {
          written += 1;
          touchedSet.add(`${spec.entityType}:${spec.entityId}`);
        } else {
          skipped += 1;
        }
      } catch (err) {
        skipped += 1;
        console.warn(`[ListSignalIngest] signal write failed (${spec.entityType}.${spec.key}):`, err.message);
      }
    }
  }

  const touched = [...touchedSet].map((t) => {
    const [entityType, entityId] = t.split(':');
    return { entityType, entityId: parseInt(entityId, 10) };
  });
  return { written, skipped, touched };
}

module.exports = {
  ingestRowSignals,
  ingestRows,
  mapRowToSignals,
  coerceCell,
  cleanMappings,
  cleanMappingEntry,
  VALID_VALUE_TYPES,
};
