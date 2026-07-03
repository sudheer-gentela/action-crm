/**
 * services/SignalService.js
 *
 * DROP-IN LOCATION: backend/services/SignalService.js
 *
 * The SINGLE writer/reader for normalized signal VALUES (entity_signals) —
 * Phase 1 of Signal-Based Campaigns. Every adapter — list ingest (P6),
 * activity webhooks (P8), BYOK enrichment (P9), the extension (P10), rep
 * on-page validations (P7) — writes through writeSignal()/writeSignals();
 * every consumer (prioritization, targeting, the Work panel) reads through
 * readByEntity()/readSignal(). Mirrors the CustomFieldService single-writer
 * precedent (D1 of the custom-fields design).
 *
 * The record is exactly the settled primitive (D5/D14):
 *   { entity(account|prospect, id), key, value, source, observed_at, confidence }
 * with ONE current row per (org, entity, key) — no transition log (D11).
 *
 * RECONCILIATION (D14 — "rep corrections override vendor data locally"):
 *   Precedence on write, in order:
 *     1. source='rep' always wins — a rep write replaces anything.
 *     2. A stored source='rep' row is NEVER overwritten by a non-rep write
 *        (the vendor observation is dropped; write returns
 *        { written:false, reason:'rep_override' }).
 *     3. Among non-rep writes, FRESHER WINS: an incoming observed_at older
 *        than the stored observed_at is dropped ({ written:false,
 *        reason:'stale_incoming' }); ties go to higher confidence.
 *   `force:true` bypasses all of this (admin/repair path only).
 *
 * FRESHNESS (D14 — "stale/low-confidence → unknown, never false"):
 *   Reads join signal_defs for ttl_days. Past TTL a row's state becomes
 *   'unknown' and its `value` is withheld (returned as `staleValue` so the
 *   Work panel can show "we last saw X on <date> — confirm on the page").
 *   Rows are NOT deleted at TTL: observed_at + the old value are exactly what
 *   the re-capture and confirm-on-page flows need. Consumers must branch on
 *   `state`, never treat unknown as false (no silent drops).
 *
 * `value` is jsonb — heterogeneous by design (boolean / number / string /
 * array-for-set / {lat,lng}-for-geo). Predicate evaluation happens in the
 * campaign layer (P5), not here.
 *
 * No RLS on entity_signals — every query passes org_id explicitly.
 * All methods accept an optional `client` (pg client) for caller transactions.
 */

const { pool } = require('../config/database');

const VALID_ENTITY_TYPES = new Set(['account', 'prospect']);
const VALID_CONFIDENCE   = new Set(['high', 'medium', 'low']);

// Canonical adapter names (documented, not CHECKed — new adapters need no
// migration). 'rep' is special-cased by reconciliation.
const KNOWN_SOURCES = new Set(['list', 'enrichment', 'extension', 'webhook', 'rep', 'dataset', 'system']);

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertEntity(entityType, entityId) {
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new Error(`SignalService: invalid entity_type "${entityType}" (account|prospect)`);
  }
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw new Error('SignalService: entityId must be a positive integer');
  }
}

function toDate(v) {
  if (v == null) return new Date();
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`SignalService: invalid observed_at "${v}"`);
  return d;
}

function isStale(observedAt, ttlDays, now = new Date()) {
  if (ttlDays == null) return false; // no TTL → never stale
  const ageMs = now.getTime() - new Date(observedAt).getTime();
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}

/**
 * Shape a stored row (already joined with its def's ttl_days) into the read
 * contract. Freshness applied here — 'unknown', never false.
 */
function rowToSignal(row, now = new Date()) {
  const stale = isStale(row.observed_at, row.ttl_days, now);
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    key: row.key,
    state: stale ? 'unknown' : 'known',
    value: stale ? null : row.value,
    staleValue: stale ? row.value : undefined, // last-seen, for confirm-on-page
    source: row.source,
    observedAt: row.observed_at,
    confidence: row.confidence,
    signalDefId: row.signal_def_id,
    ttlDays: row.ttl_days,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert one signal, applying reconciliation.
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {string}  opts.entityType   - 'account' | 'prospect'
 * @param {number}  opts.entityId
 * @param {string}  opts.key
 * @param {*}       opts.value        - any JSON-serializable value
 * @param {string}  opts.source       - adapter name; 'rep' has override power
 * @param {Date|string} [opts.observedAt=now]
 * @param {string} [opts.confidence]  - high|medium|low; defaults: rep→high, else medium
 * @param {boolean} [opts.force=false] - bypass reconciliation (repair path)
 * @param {object} [opts.client]
 * @returns {Promise<{written: boolean, reason?: string, signal?: object}>}
 */
async function writeSignal(opts) {
  const {
    orgId, entityType, entityId, key, value, source,
    observedAt, confidence, force = false, client,
  } = opts || {};

  if (!orgId || !key || !source) {
    throw new Error('SignalService.writeSignal: orgId, key, source are required');
  }
  assertEntity(entityType, entityId);

  const effConfidence = confidence || (source === 'rep' ? 'high' : 'medium');
  if (!VALID_CONFIDENCE.has(effConfidence)) {
    throw new Error(`SignalService.writeSignal: invalid confidence "${effConfidence}"`);
  }
  if (!KNOWN_SOURCES.has(source)) {
    // Not fatal (free-text by design), but loud: catches adapter typos early.
    console.warn(`SignalService.writeSignal: unrecognized source "${source}" (known: ${[...KNOWN_SOURCES].join(', ')})`);
  }

  const effObservedAt = toDate(observedAt);
  const exec = client || pool;

  // ── Reconciliation gate (skipped for rep writes and force) ────────────────
  if (!force && source !== 'rep') {
    const { rows: existingRows } = await exec.query(
      `SELECT source, observed_at, confidence FROM entity_signals
        WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3 AND key = $4`,
      [orgId, entityType, entityId, key]
    );
    const existing = existingRows[0];
    if (existing) {
      // Rule 2: rep-written rows are never clobbered by vendors.
      if (existing.source === 'rep') {
        return { written: false, reason: 'rep_override' };
      }
      // Rule 3: fresher wins; ties → higher confidence.
      const existingAt = new Date(existing.observed_at).getTime();
      const incomingAt = effObservedAt.getTime();
      if (incomingAt < existingAt) {
        return { written: false, reason: 'stale_incoming' };
      }
      if (incomingAt === existingAt
          && CONFIDENCE_RANK[effConfidence] < CONFIDENCE_RANK[existing.confidence]) {
        return { written: false, reason: 'lower_confidence' };
      }
    }
  }

  // ── Upsert (signal_def_id resolved loosely by key; NULL if uncatalogued) ──
  const { rows } = await exec.query(
    `
    INSERT INTO entity_signals
      (org_id, entity_type, entity_id, key, signal_def_id, value, source, observed_at, confidence)
    VALUES ($1, $2, $3, $4::varchar,
            (SELECT id FROM signal_defs WHERE org_id = $1 AND key = $4::varchar),
            $5, $6, $7, $8)
    ON CONFLICT (org_id, entity_type, entity_id, key)
    DO UPDATE SET
      value         = EXCLUDED.value,
      source        = EXCLUDED.source,
      observed_at   = EXCLUDED.observed_at,
      confidence    = EXCLUDED.confidence,
      signal_def_id = EXCLUDED.signal_def_id
    RETURNING *
    `,
    [orgId, entityType, entityId, key,
     value === undefined ? null : JSON.stringify(value),
     source, effObservedAt, effConfidence]
  );

  // Re-shape without TTL context (write path doesn't join defs).
  const row = rows[0];
  return {
    written: true,
    signal: rowToSignal({ ...row, ttl_days: null }),
  };
}

/**
 * Batch write (one adapter payload → many signals). Each item follows the
 * writeSignal contract minus orgId/client. Runs sequentially inside the
 * caller's transaction if a client is passed; reconciliation applies per row.
 *
 * @returns {Promise<{written: number, skipped: Array<{key, entityType, entityId, reason}>}>}
 */
async function writeSignals({ orgId, signals, client }) {
  if (!orgId) throw new Error('SignalService.writeSignals: orgId is required');
  if (!Array.isArray(signals) || signals.length === 0) return { written: 0, skipped: [] };

  let written = 0;
  const skipped = [];
  for (const s of signals) {
    const res = await writeSignal({ ...s, orgId, client });
    if (res.written) written += 1;
    else skipped.push({ key: s.key, entityType: s.entityType, entityId: s.entityId, reason: res.reason });
  }
  return { written, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All signals for one entity, freshness-resolved (state known|unknown).
 * Optional keys filter. Ordered newest-observed first.
 */
async function readByEntity({ orgId, entityType, entityId, keys = null, client }) {
  if (!orgId) throw new Error('SignalService.readByEntity: orgId is required');
  assertEntity(entityType, entityId);
  const exec = client || pool;

  const params = [orgId, entityType, entityId];
  let keyFilter = '';
  if (Array.isArray(keys) && keys.length > 0) {
    params.push(keys);
    keyFilter = `AND es.key = ANY($${params.length}::varchar[])`;
  }

  const { rows } = await exec.query(
    `
    SELECT es.*, sd.ttl_days
      FROM entity_signals es
      LEFT JOIN signal_defs sd
        ON sd.org_id = es.org_id AND sd.key = es.key
     WHERE es.org_id = $1 AND es.entity_type = $2 AND es.entity_id = $3
       ${keyFilter}
     ORDER BY es.observed_at DESC
    `,
    params
  );

  const now = new Date();
  return rows.map((r) => rowToSignal(r, now));
}

/** One signal (freshness-resolved) or null. */
async function readSignal({ orgId, entityType, entityId, key, client }) {
  if (!key) throw new Error('SignalService.readSignal: key is required');
  const signals = await readByEntity({ orgId, entityType, entityId, keys: [key], client });
  return signals[0] || null;
}

/**
 * Batch read for MANY entities of one type (the Target-stage pool pass, P5:
 * score a whole campaign pool without N queries).
 * Returns Map(entityId → signal[]), freshness-resolved.
 */
async function readForEntities({ orgId, entityType, entityIds, keys = null, client }) {
  if (!orgId) throw new Error('SignalService.readForEntities: orgId is required');
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new Error(`SignalService.readForEntities: invalid entity_type "${entityType}"`);
  }
  if (!Array.isArray(entityIds) || entityIds.length === 0) return new Map();
  const exec = client || pool;

  const params = [orgId, entityType, entityIds];
  let keyFilter = '';
  if (Array.isArray(keys) && keys.length > 0) {
    params.push(keys);
    keyFilter = `AND es.key = ANY($${params.length}::varchar[])`;
  }

  const { rows } = await exec.query(
    `
    SELECT es.*, sd.ttl_days
      FROM entity_signals es
      LEFT JOIN signal_defs sd
        ON sd.org_id = es.org_id AND sd.key = es.key
     WHERE es.org_id = $1 AND es.entity_type = $2 AND es.entity_id = ANY($3::int[])
       ${keyFilter}
     ORDER BY es.entity_id, es.observed_at DESC
    `,
    params
  );

  const now = new Date();
  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
    byEntity.get(r.entity_id).push(rowToSignal(r, now));
  }
  return byEntity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────

/** Remove one signal row (rep "that's wrong, and unknown is the truth" path). */
async function deleteSignal({ orgId, entityType, entityId, key, client }) {
  if (!orgId || !key) throw new Error('SignalService.deleteSignal: orgId and key are required');
  assertEntity(entityType, entityId);
  const exec = client || pool;
  const { rows } = await exec.query(
    `DELETE FROM entity_signals
      WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3 AND key = $4
      RETURNING id`,
    [orgId, entityType, entityId, key]
  );
  return { deleted: rows.length };
}

module.exports = {
  writeSignal,
  writeSignals,
  readByEntity,
  readSignal,
  readForEntities,
  deleteSignal,
  // exported for tests / reuse
  isStale,
  rowToSignal,
  VALID_ENTITY_TYPES,
  VALID_CONFIDENCE,
  KNOWN_SOURCES,
};
