/**
 * services/SignalRegistryService.js
 *
 * DROP-IN LOCATION: backend/services/SignalRegistryService.js
 *
 * The org-shared SIGNAL CATALOG (signal_defs) — Phase 1 of Signal-Based
 * Campaigns. Companion to SignalService (which owns VALUES in entity_signals),
 * mirroring the CustomFieldDefService / CustomFieldService split.
 *
 * A signal definition carries the six dimensions of the settled model (D5):
 *   capability     — filter | prioritize | both        (rep-visible)
 *   scope          — company | target_role             (rep-visible)
 *   function_tags  — [] = "Any", else ['finance', ...] (rep-visible, D6)
 *   predicate_type — set | number | recency | geo | boolean (rep-visible)
 *   reliability    — high | medium | low               (INFERRED, hidden, D9)
 *   source_kind    — list | enrich | harvest | dataset | rep_validate
 *                                                      (INFERRED, hidden, D9)
 *
 * The two invisible rules live HERE, at definition time:
 *
 *   RULE 1 — cost-of-error sets the max role. A Filter error silently drops a
 *   good company; a Prioritize error just forgoes a ranking bump. So
 *   reliability='low' caps capability at 'prioritize' (clampCapability).
 *   Rep-created signals (createRepSignal) get source_kind='rep_validate' →
 *   reliability='low' → Prioritize-only + confirm-on-page, automatically.
 *
 *   RULE 2 — source decides gaps. source_kind is stored so the Target stage
 *   (P5/P6) can derive which needed signals the campaign's entry source can't
 *   supply; those become Work-stage confirmations. Nothing to compute here —
 *   just keep the dimension honest.
 *
 * Org-shared catalog (D10): every row is org-scoped; both the Settings home
 * and the in-flow "+ Create" write through createDef/createRepSignal. Rows
 * with created_by set render as "rep-added".
 *
 * No RLS on this table family — every query passes org_id explicitly.
 * All methods accept an optional `client` (pg client) for caller transactions.
 */

const { pool } = require('../config/database');

const VALID_CAPABILITY  = new Set(['filter', 'prioritize', 'both']);
const VALID_SCOPE       = new Set(['company', 'target_role']);
const VALID_PREDICATE   = new Set(['set', 'number', 'recency', 'geo', 'boolean']);
const VALID_RELIABILITY = new Set(['high', 'medium', 'low']);
const VALID_SOURCE_KIND = new Set(['list', 'enrich', 'harvest', 'dataset', 'rep_validate']);

// Same key discipline as custom_field_defs.field_key.
const SIGNAL_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;

// Fields updateDef() may touch. key/created_by are immutable; reliability and
// source_kind change only via the dedicated setInferred() (admin/system path).
const UPDATABLE = new Set([
  'label', 'description', 'capability', 'scope', 'function_tags',
  'predicate_type', 'ttl_days', 'default_hook', 'active',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Inference (the hidden dimensions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * source_kind → default reliability.
 * Calibration: list/dataset facts are vendor-stated and dependable (funding,
 * hiring, tech install) → high/medium; harvest (extension/page reads) drifts →
 * medium; rep_validate starts low until confirmed on the page.
 */
const RELIABILITY_BY_SOURCE_KIND = {
  list:         'high',
  enrich:       'high',
  dataset:      'medium',
  harvest:      'medium',
  rep_validate: 'low',
};

function inferReliability(sourceKind) {
  return RELIABILITY_BY_SOURCE_KIND[sourceKind] || 'low';
}

/**
 * RULE 1 — clamp capability to what reliability allows.
 * low reliability → 'prioritize' only (may not filter, alone or otherwise).
 */
function clampCapability(requested, reliability) {
  if (reliability === 'low' && requested !== 'prioritize') return 'prioritize';
  return requested;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function validateForCreate({ key, label, capability, scope, predicateType, functionTags, sourceKind, reliability, ttlDays }) {
  if (typeof key !== 'string' || !SIGNAL_KEY_RE.test(key)) {
    throw new Error('invalid signal key (lowercase letters, digits, underscores; start with a letter; ≤100 chars)');
  }
  if (typeof label !== 'string' || !label.trim()) {
    throw new Error('label is required');
  }
  if (!VALID_CAPABILITY.has(capability)) {
    throw new Error(`invalid capability "${capability}" (filter|prioritize|both)`);
  }
  if (!VALID_SCOPE.has(scope)) {
    throw new Error(`invalid scope "${scope}" (company|target_role)`);
  }
  if (!VALID_PREDICATE.has(predicateType)) {
    throw new Error(`invalid predicate_type "${predicateType}" (set|number|recency|geo|boolean)`);
  }
  if (!VALID_SOURCE_KIND.has(sourceKind)) {
    throw new Error(`invalid source_kind "${sourceKind}"`);
  }
  if (!VALID_RELIABILITY.has(reliability)) {
    throw new Error(`invalid reliability "${reliability}"`);
  }
  if (functionTags != null && !Array.isArray(functionTags)) {
    throw new Error('function_tags must be an array (empty = Any)');
  }
  if (ttlDays != null && (!Number.isInteger(ttlDays) || ttlDays <= 0)) {
    throw new Error('ttl_days must be a positive integer or null');
  }
}

function rowToDef(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    key: row.key,
    label: row.label,
    description: row.description,
    capability: row.capability,
    scope: row.scope,
    functionTags: Array.isArray(row.function_tags) ? row.function_tags : [],
    predicateType: row.predicate_type,
    reliability: row.reliability,
    sourceKind: row.source_kind,
    ttlDays: row.ttl_days,
    defaultHook: row.default_hook,
    createdBy: row.created_by,
    repAdded: row.created_by != null,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a signal definition (admin / system path — caller may pass the
 * hidden dimensions explicitly; anything omitted is inferred).
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {string}  opts.key
 * @param {string}  opts.label
 * @param {string} [opts.description]
 * @param {string} [opts.capability='prioritize']  - filter|prioritize|both (clamped by RULE 1)
 * @param {string} [opts.scope='company']          - company|target_role
 * @param {string[]} [opts.functionTags=[]]        - [] = Any (D6)
 * @param {string} [opts.predicateType='boolean']
 * @param {string} [opts.sourceKind='rep_validate']
 * @param {string} [opts.reliability]              - defaults from sourceKind
 * @param {number|null} [opts.ttlDays]
 * @param {string} [opts.defaultHook]              - why-now hook (Prioritize)
 * @param {number} [opts.createdBy]                - user id; set ⇒ "rep-added"
 * @param {object} [opts.client]
 * @returns {Promise<object>} the created def (camelCase)
 */
async function createDef(opts) {
  const {
    orgId, key, label, description = null,
    capability = 'prioritize', scope = 'company',
    functionTags = [], predicateType = 'boolean',
    sourceKind = 'rep_validate',
    reliability = inferReliability(sourceKind),
    ttlDays = null, defaultHook = null, createdBy = null,
    client,
  } = opts || {};

  if (!orgId) throw new Error('SignalRegistryService.createDef: orgId is required');
  validateForCreate({ key, label, capability, scope, predicateType, functionTags, sourceKind, reliability, ttlDays });

  const effectiveCapability = clampCapability(capability, reliability);
  const exec = client || pool;

  const { rows } = await exec.query(
    `
    INSERT INTO signal_defs
      (org_id, key, label, description, capability, scope, function_tags,
       predicate_type, reliability, source_kind, ttl_days, default_hook, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (org_id, key) DO NOTHING
    RETURNING *
    `,
    [
      orgId, key, label.trim(), description, effectiveCapability, scope,
      JSON.stringify(functionTags), predicateType, reliability, sourceKind,
      ttlDays, defaultHook, createdBy,
    ]
  );

  if (rows.length === 0) {
    throw new Error(`signal "${key}" already exists in this org's catalog`);
  }
  return rowToDef(rows[0]);
}

/**
 * Rep-simple create (the in-flow "+ Create" and the Settings quick form, D10).
 * The rep answers plain questions; everything hidden is inferred:
 *   source_kind='rep_validate' → reliability='low' → capability clamped to
 *   'prioritize' + confirm-on-page (RULE 1), regardless of what was asked.
 */
async function createRepSignal({ orgId, userId, key, label, description = null, capability = 'prioritize', scope = 'company', functionTags = [], predicateType = 'boolean', ttlDays = null, defaultHook = null, client }) {
  if (!userId) throw new Error('SignalRegistryService.createRepSignal: userId is required');
  return createDef({
    orgId, key, label, description, capability, scope, functionTags,
    predicateType, ttlDays, defaultHook,
    sourceKind: 'rep_validate',           // ⇒ reliability 'low' ⇒ Prioritize-only
    createdBy: userId,
    client,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List the org's catalog. Optional filters:
 *   functionTag     — only defs offered in this function (tag match OR tags=[]=Any)
 *   capability      — 'filter' returns filter+both; 'prioritize' returns prioritize+both
 *   includeInactive — retired defs excluded by default
 */
async function listDefs({ orgId, functionTag = null, capability = null, includeInactive = false, client } = {}) {
  if (!orgId) throw new Error('SignalRegistryService.listDefs: orgId is required');
  const exec = client || pool;

  const where = ['org_id = $1'];
  const params = [orgId];

  if (!includeInactive) where.push('active = true');

  if (functionTag) {
    params.push(JSON.stringify([functionTag]));
    where.push(`(function_tags = '[]'::jsonb OR function_tags @> $${params.length}::jsonb)`);
  }

  if (capability === 'filter' || capability === 'prioritize') {
    params.push(capability);
    where.push(`(capability = $${params.length} OR capability = 'both')`);
  }

  const { rows } = await exec.query(
    `SELECT * FROM signal_defs WHERE ${where.join(' AND ')} ORDER BY label ASC`,
    params
  );
  return rows.map(rowToDef);
}

/** Fetch one def by key (null if absent). */
async function getDef({ orgId, key, client }) {
  if (!orgId || !key) throw new Error('SignalRegistryService.getDef: orgId and key are required');
  const exec = client || pool;
  const { rows } = await exec.query(
    'SELECT * FROM signal_defs WHERE org_id = $1 AND key = $2',
    [orgId, key]
  );
  return rowToDef(rows[0]);
}

/** Batch fetch defs by key → Map(key → def). Used by SignalService reads. */
async function getDefsByKeys({ orgId, keys, client }) {
  if (!orgId) throw new Error('SignalRegistryService.getDefsByKeys: orgId is required');
  if (!Array.isArray(keys) || keys.length === 0) return new Map();
  const exec = client || pool;
  const { rows } = await exec.query(
    'SELECT * FROM signal_defs WHERE org_id = $1 AND key = ANY($2::varchar[])',
    [orgId, keys]
  );
  const map = new Map();
  for (const row of rows) map.set(row.key, rowToDef(row));
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update / retire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Patch an existing def (rep-visible dimensions only — see UPDATABLE).
 * capability is re-clamped against stored reliability (RULE 1 can't be
 * escaped by edit).
 */
async function updateDef({ orgId, key, patch, client }) {
  if (!orgId || !key) throw new Error('SignalRegistryService.updateDef: orgId and key are required');
  if (!patch || typeof patch !== 'object') throw new Error('SignalRegistryService.updateDef: patch object required');

  const exec = client || pool;
  const existing = await getDef({ orgId, key, client });
  if (!existing) throw new Error(`signal "${key}" not found in this org's catalog`);

  const sets = [];
  const params = [orgId, key];

  for (const [field, raw] of Object.entries(patch)) {
    if (!UPDATABLE.has(field)) continue;
    let value = raw;

    if (field === 'capability') {
      if (!VALID_CAPABILITY.has(value)) throw new Error(`invalid capability "${value}"`);
      value = clampCapability(value, existing.reliability);
    } else if (field === 'scope' && !VALID_SCOPE.has(value)) {
      throw new Error(`invalid scope "${value}"`);
    } else if (field === 'predicate_type' && !VALID_PREDICATE.has(value)) {
      throw new Error(`invalid predicate_type "${value}"`);
    } else if (field === 'function_tags') {
      if (!Array.isArray(value)) throw new Error('function_tags must be an array');
      value = JSON.stringify(value);
    } else if (field === 'ttl_days' && value != null && (!Number.isInteger(value) || value <= 0)) {
      throw new Error('ttl_days must be a positive integer or null');
    }

    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }

  if (sets.length === 0) return existing;

  const { rows } = await exec.query(
    `UPDATE signal_defs SET ${sets.join(', ')} WHERE org_id = $1 AND key = $2 RETURNING *`,
    params
  );
  return rowToDef(rows[0]);
}

/**
 * Admin/system-only: adjust the hidden dimensions (e.g. trust recalibration
 * from per-field sampling, D14). Re-clamps capability if reliability drops.
 */
async function setInferred({ orgId, key, reliability = null, sourceKind = null, client }) {
  if (!orgId || !key) throw new Error('SignalRegistryService.setInferred: orgId and key are required');
  if (reliability != null && !VALID_RELIABILITY.has(reliability)) throw new Error(`invalid reliability "${reliability}"`);
  if (sourceKind != null && !VALID_SOURCE_KIND.has(sourceKind)) throw new Error(`invalid source_kind "${sourceKind}"`);

  const exec = client || pool;
  const existing = await getDef({ orgId, key, client });
  if (!existing) throw new Error(`signal "${key}" not found in this org's catalog`);

  const nextReliability = reliability || existing.reliability;
  const nextSourceKind  = sourceKind || existing.sourceKind;
  const nextCapability  = clampCapability(existing.capability, nextReliability);

  const { rows } = await exec.query(
    `UPDATE signal_defs
        SET reliability = $3, source_kind = $4, capability = $5
      WHERE org_id = $1 AND key = $2
      RETURNING *`,
    [orgId, key, nextReliability, nextSourceKind, nextCapability]
  );
  return rowToDef(rows[0]);
}

/** Soft-retire (catalog rows are referenced by campaigns; never hard-delete). */
async function retireDef({ orgId, key, client }) {
  return updateDef({ orgId, key, patch: { active: false }, client });
}

module.exports = {
  createDef,
  createRepSignal,
  listDefs,
  getDef,
  getDefsByKeys,
  updateDef,
  setInferred,
  retireDef,
  // exported for tests / reuse
  inferReliability,
  clampCapability,
  VALID_CAPABILITY,
  VALID_SCOPE,
  VALID_PREDICATE,
  VALID_RELIABILITY,
  VALID_SOURCE_KIND,
};
