/**
 * services/FunctionTaxonomyService.js
 *
 * DROP-IN LOCATION: backend/services/FunctionTaxonomyService.js
 *
 * The org-configurable FUNCTION TAXONOMY — Phase 2 of Signal-Based Campaigns
 * (design §3, D7/D8). Every role-relative surface resolves against this:
 * the Signal Catalog's per-function column (P4), Target Profiles' function
 * tags (P3), scope='target_role' signal resolution (D7), and the SignalBuilder
 * "which role does this captured person play?" question (P5).
 *
 * Each function defines five placeholders:
 *   { leader, head, team, hire, tool }
 * e.g. finance = { CFO, "finance head", finance team, "FP&A / Controllers", ERP }.
 * A placeholder is { label, keywords[] } — `label` renders in resolved signal
 * text ("New {leader} hired" → "New CFO hired"); `keywords` drive title
 * matching. FULL leader titles live in keywords, never a bare ambiguous
 * acronym — the CPO collision (Chief Procurement / Product / People Officer)
 * is avoided by construction: 'cpo' appears in NO default keyword list.
 *
 * STORAGE (merge-over-defaults, the NetworkJobChangeConfig pattern):
 *   - SYSTEM_FUNCTIONS below ship in code — sales, finance, procurement,
 *     product, marketing, hr. Zero DB rows ⇒ an org sees these untouched.
 *   - org_functions rows (2026_37) are DELTAS: a row keyed like a system
 *     function partially overrides it (label and/or individual placeholders,
 *     or active=false to hide it); a row with a new key ADDS a function
 *     ("legal" → GC / legal team / paralegals / CLM) and every screen
 *     supports it.
 *
 * DECOUPLED from CLASSIFIER_FUNCTION_VALUES (D8): that enum in
 * prospectingConfigSchema stays load-bearing for FitGate/ICP and is not
 * imported here. The taxonomy feeds ProspectClassifier.classifyTitle only
 * via buildClassifierRules() — explicit config rules, no shared enum. The
 * keyword→regex compiler IS shared (ProspectClassifier.compilePattern:
 * escaped, word-boundary, ReDoS-safe) so matching semantics stay identical
 * everywhere.
 *
 * No RLS on org_functions — every query passes org_id explicitly.
 * All DB methods accept an optional `client` (pg client) for caller
 * transactions.
 */

const { pool } = require('../config/database');
const { compilePattern } = require('./ProspectClassifier');

const PLACEHOLDER_KEYS = ['leader', 'head', 'team', 'hire', 'tool'];

// Person-placeholders only, most-specific first — titleRoleFor() stops at the
// first hit. 'tool' is not a person and never title-matches.
const TITLE_MATCH_ORDER = ['leader', 'head', 'hire', 'team'];

// Same key discipline as signal_defs.key / custom_field_defs.field_key.
const FUNCTION_KEY_RE = /^[a-z][a-z0-9_]{0,99}$/;

// ─────────────────────────────────────────────────────────────────────────────
// System defaults (§3): sales, finance, procurement, product, marketing, hr.
// Keywords are matched word-boundary via ProspectClassifier.compilePattern —
// so 'finance' does NOT match "financial analyst" (that's a `hire` keyword).
// NOTE the collision rule: procurement/product leaders carry ONLY full titles;
// 'chro' is safe (unambiguous) but 'cpo' appears nowhere.
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_FUNCTIONS = [
  {
    key: 'sales',
    label: 'Sales',
    placeholders: {
      leader: { label: 'CRO',              keywords: ['cro', 'chief revenue officer', 'chief sales officer'] },
      head:   { label: 'sales head',       keywords: ['head of sales', 'vp sales', 'vp of sales', 'svp sales', 'sales director', 'director of sales'] },
      team:   { label: 'sales team',       keywords: ['sales', 'business development', 'inside sales'] },
      hire:   { label: 'AEs / SDRs',       keywords: ['account executive', 'sdr', 'bdr', 'sales development', 'account manager'] },
      tool:   { label: 'CRM',              keywords: ['crm', 'salesforce', 'hubspot'] },
    },
  },
  {
    key: 'finance',
    label: 'Finance',
    placeholders: {
      leader: { label: 'CFO',              keywords: ['cfo', 'chief financial officer'] },
      head:   { label: 'finance head',     keywords: ['head of finance', 'vp finance', 'vp of finance', 'finance director', 'director of finance'] },
      team:   { label: 'finance team',     keywords: ['finance', 'accounting', 'fp&a'] },
      hire:   { label: 'FP&A / Controllers', keywords: ['financial analyst', 'controller', 'accountant', 'fp&a analyst'] },
      tool:   { label: 'ERP',              keywords: ['erp', 'netsuite', 'sap', 'oracle financials', 'workday financials'] },
    },
  },
  {
    key: 'procurement',
    label: 'Procurement',
    placeholders: {
      // Full title ONLY — 'cpo' is the collision acronym (§3).
      leader: { label: 'Chief Procurement Officer', keywords: ['chief procurement officer'] },
      head:   { label: 'procurement head', keywords: ['head of procurement', 'vp procurement', 'vp of procurement', 'procurement director', 'director of procurement', 'head of sourcing'] },
      team:   { label: 'procurement team', keywords: ['procurement', 'sourcing', 'purchasing', 'vendor management'] },
      hire:   { label: 'buyers / category managers', keywords: ['buyer', 'category manager', 'sourcing manager', 'procurement analyst'] },
      tool:   { label: 'procure-to-pay suite', keywords: ['coupa', 'ariba', 'ivalua', 'procure-to-pay', 'p2p'] },
    },
  },
  {
    key: 'product',
    label: 'Product',
    placeholders: {
      // Full title ONLY — 'cpo' is the collision acronym (§3).
      leader: { label: 'Chief Product Officer', keywords: ['chief product officer'] },
      head:   { label: 'product head',     keywords: ['head of product', 'vp product', 'vp of product', 'product director', 'director of product'] },
      team:   { label: 'product team',     keywords: ['product management', 'product'] },
      hire:   { label: 'PMs',              keywords: ['product manager', 'product owner', 'associate product manager'] },
      tool:   { label: 'product stack',    keywords: ['jira', 'productboard', 'amplitude', 'mixpanel', 'pendo'] },
    },
  },
  {
    key: 'marketing',
    label: 'Marketing',
    placeholders: {
      leader: { label: 'CMO',              keywords: ['cmo', 'chief marketing officer'] },
      head:   { label: 'marketing head',   keywords: ['head of marketing', 'vp marketing', 'vp of marketing', 'marketing director', 'director of marketing'] },
      team:   { label: 'marketing team',   keywords: ['marketing', 'demand generation', 'demand gen', 'growth marketing'] },
      hire:   { label: 'demand gen / content', keywords: ['demand gen', 'demand generation', 'content marketing', 'growth marketer', 'seo'] },
      tool:   { label: 'marketing automation platform', keywords: ['marketo', 'pardot', 'eloqua', 'marketing automation'] },
    },
  },
  {
    key: 'hr',
    label: 'HR / People',
    placeholders: {
      // 'chro' is unambiguous and allowed; 'cpo' (Chief People Officer) is not.
      leader: { label: 'Chief People Officer', keywords: ['chief people officer', 'chief human resources officer', 'chro'] },
      head:   { label: 'people head',      keywords: ['head of people', 'head of hr', 'vp people', 'vp of people', 'vp hr', 'vp of human resources', 'hr director', 'people director'] },
      team:   { label: 'people team',      keywords: ['human resources', 'people operations', 'people ops', 'hr'] },
      hire:   { label: 'recruiters / HRBPs', keywords: ['recruiter', 'talent acquisition', 'hrbp', 'hr business partner', 'people partner'] },
      tool:   { label: 'HRIS',             keywords: ['hris', 'workday', 'bamboohr', 'rippling', 'gusto'] },
    },
  },
];

const SYSTEM_BY_KEY = new Map(SYSTEM_FUNCTIONS.map((f) => [f.key, f]));

// ─────────────────────────────────────────────────────────────────────────────
// Sanitization (mirrors the prospectingConfigSchema clean* style: coerce,
// trim, drop junk silently; never throw on shape, only on identity)
// ─────────────────────────────────────────────────────────────────────────────

function cleanStringArray(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const x of v) {
    const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Sanitize a PARTIAL placeholders object: keep only known placeholder keys,
 * each as { label, keywords[] }. A placeholder without a usable label is
 * dropped (a keyword list with no display label is unrenderable). Missing
 * keywords default to the lowercased label.
 */
function cleanPlaceholders(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const key of PLACEHOLDER_KEYS) {
    const raw = v[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label) continue;
    let keywords = cleanStringArray(raw.keywords);
    if (keywords.length === 0) keywords = [label.toLowerCase()];
    out[key] = { label, keywords };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge (delta row over system default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge one org delta row over its system default (per-placeholder, the
 * NetworkJobChangeConfig partial-over-defaults semantic).
 * Returns the EFFECTIVE function:
 *   { key, label, placeholders(all present keys), active,
 *     source: 'system' | 'system_modified' | 'custom' }
 */
function mergeFunction(systemFn, orgRow) {
  if (!orgRow) {
    return { ...systemFn, placeholders: { ...systemFn.placeholders }, active: true, source: 'system' };
  }

  const overrides = cleanPlaceholders(orgRow.placeholders);

  if (!systemFn) {
    // Org-added function — the row IS the definition.
    return {
      key: orgRow.key,
      label: orgRow.label || orgRow.key,
      placeholders: overrides,
      active: orgRow.active,
      source: 'custom',
    };
  }

  const placeholders = {};
  for (const key of PLACEHOLDER_KEYS) {
    if (overrides[key]) placeholders[key] = overrides[key];
    else if (systemFn.placeholders[key]) placeholders[key] = systemFn.placeholders[key];
  }

  return {
    key: systemFn.key,
    label: orgRow.label || systemFn.label,
    placeholders,
    active: orgRow.active,
    source: 'system_modified',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read (merged)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The org's EFFECTIVE taxonomy: system defaults merged with org deltas, plus
 * org-added functions. Inactive (hidden) functions excluded unless
 * includeInactive. Order: system order first, then org-added by label.
 */
async function listFunctions({ orgId, includeInactive = false, client } = {}) {
  if (!orgId) throw new Error('FunctionTaxonomyService.listFunctions: orgId is required');
  const exec = client || pool;

  const { rows } = await exec.query(
    'SELECT * FROM org_functions WHERE org_id = $1',
    [orgId]
  );
  const deltaByKey = new Map(rows.map((r) => [r.key, r]));

  const out = [];
  for (const sys of SYSTEM_FUNCTIONS) {
    const merged = mergeFunction(sys, deltaByKey.get(sys.key));
    deltaByKey.delete(sys.key);
    if (merged.active || includeInactive) out.push(merged);
  }

  const added = [];
  for (const row of deltaByKey.values()) {
    const merged = mergeFunction(null, row);
    if (merged.active || includeInactive) added.push(merged);
  }
  added.sort((a, b) => a.label.localeCompare(b.label));

  return out.concat(added);
}

/** One effective function by key (null if absent or hidden). */
async function getFunction({ orgId, key, includeInactive = false, client }) {
  if (!orgId || !key) throw new Error('FunctionTaxonomyService.getFunction: orgId and key are required');
  const all = await listFunctions({ orgId, includeInactive, client });
  return all.find((f) => f.key === key) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write (deltas)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create/patch a function delta (Settings → Functions editor, P2 surface).
 *   - key matching a system function ⇒ partial override (label/placeholders
 *     may each be omitted to inherit).
 *   - new key ⇒ org-added function; label required.
 * Placeholders passed here are stored AS THE DELTA (only the keys provided);
 * merge happens at read time, so a later change to a system default flows
 * through untouched placeholder keys automatically.
 */
async function upsertFunction({ orgId, key, label = null, placeholders = null, createdBy = null, client }) {
  if (!orgId) throw new Error('FunctionTaxonomyService.upsertFunction: orgId is required');
  if (typeof key !== 'string' || !FUNCTION_KEY_RE.test(key)) {
    throw new Error('invalid function key (lowercase letters, digits, underscores; start with a letter; ≤100 chars)');
  }

  const isSystem = SYSTEM_BY_KEY.has(key);
  const cleanLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
  if (!isSystem && !cleanLabel) {
    throw new Error(`function "${key}" is not a system function — a label is required to add it`);
  }
  const cleanPh = placeholders == null ? null : cleanPlaceholders(placeholders);

  const exec = client || pool;
  const { rows } = await exec.query(
    `
    INSERT INTO org_functions (org_id, key, label, placeholders, created_by)
    VALUES ($1, $2::varchar, $3, COALESCE($4::jsonb, '{}'::jsonb), $5)
    ON CONFLICT (org_id, key)
    DO UPDATE SET
      label        = COALESCE($3, org_functions.label),
      placeholders = COALESCE($4::jsonb, org_functions.placeholders),
      active       = true
    RETURNING *
    `,
    [orgId, key, cleanLabel, cleanPh == null ? null : JSON.stringify(cleanPh), createdBy]
  );

  return mergeFunction(SYSTEM_BY_KEY.get(key) || null, rows[0]);
}

/**
 * Hide a function for this org (system fn ⇒ writes/updates a delta row with
 * active=false; org-added fn ⇒ deactivates its row). Soft always — signals
 * and profiles may reference the key.
 */
async function deactivateFunction({ orgId, key, client }) {
  if (!orgId || !key) throw new Error('FunctionTaxonomyService.deactivateFunction: orgId and key are required');
  const exec = client || pool;
  const { rows } = await exec.query(
    `
    INSERT INTO org_functions (org_id, key, active)
    VALUES ($1, $2::varchar, false)
    ON CONFLICT (org_id, key) DO UPDATE SET active = false
    RETURNING *
    `,
    [orgId, key]
  );
  return mergeFunction(SYSTEM_BY_KEY.get(key) || null, rows[0]);
}

/** Un-hide (re-activate) a function. */
async function restoreFunction({ orgId, key, client }) {
  if (!orgId || !key) throw new Error('FunctionTaxonomyService.restoreFunction: orgId and key are required');
  const exec = client || pool;
  const { rows } = await exec.query(
    'UPDATE org_functions SET active = true WHERE org_id = $1 AND key = $2 RETURNING *',
    [orgId, key]
  );
  // No delta row = a system default that was never touched = already active.
  return mergeFunction(SYSTEM_BY_KEY.get(key) || null, rows[0] || null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (D7: scope='target_role' resolves {leader}/{team}/{tool} per fn)
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_TOKEN_RE = /\{(leader|head|team|hire|tool)\}/gi;

/**
 * Resolve {leader}/{head}/{team}/{hire}/{tool} tokens in a template against
 * one EFFECTIVE function (from listFunctions/getFunction). Pure. Tokens with
 * no placeholder in the function are left intact (visible, not silently
 * blanked — the catalog screen renders them as unresolved).
 *
 *   resolveText('New {leader} hired recently', financeFn)
 *     → 'New CFO hired recently'
 */
function resolveText(template, fn) {
  if (typeof template !== 'string' || !template) return template || '';
  const placeholders = (fn && fn.placeholders) || {};
  return template.replace(PLACEHOLDER_TOKEN_RE, (token, name) => {
    const ph = placeholders[name.toLowerCase()];
    return ph && ph.label ? ph.label : token;
  });
}

/** True if a signal label/template contains any role-relative token. */
function hasPlaceholders(template) {
  if (typeof template !== 'string') return false;
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;
  return PLACEHOLDER_TOKEN_RE.test(template);
}

/**
 * Which ROLE does a title play for this function? (The SignalBuilder /
 * target-role question, P5: "is this captured person the finance {leader}?")
 * Pure. Checks person placeholders most-specific-first (leader → head → hire
 * → team); 'tool' never matches a title. Returns the placeholder key or null.
 * Matching uses ProspectClassifier.compilePattern — escaped, word-boundary,
 * identical semantics to classifier keyword rules.
 */
function titleRoleFor(title, fn) {
  if (title == null || !fn || !fn.placeholders) return null;
  const t = String(title).toLowerCase().trim();
  if (!t) return null;

  for (const roleKey of TITLE_MATCH_ORDER) {
    const ph = fn.placeholders[roleKey];
    if (!ph || !Array.isArray(ph.keywords)) continue;
    for (const kw of ph.keywords) {
      const re = compilePattern(kw);
      if (re && re.test(t)) return roleKey;
    }
  }
  return null;
}

/**
 * Bridge to ProspectClassifier (D8 — explicit rules, no shared enum):
 * config `function_rules` that make classifyTitle answer "does this title
 * belong to <fn.key>?" — pass as
 *   classifyTitle(title, { function_rules: buildClassifierRules(fn) })
 * and check result.function === fn.key. Person placeholders only.
 */
function buildClassifierRules(fn) {
  if (!fn || !fn.placeholders) return [];
  const patterns = [];
  const seen = new Set();
  for (const roleKey of TITLE_MATCH_ORDER) {
    const ph = fn.placeholders[roleKey];
    if (!ph || !Array.isArray(ph.keywords)) continue;
    for (const kw of ph.keywords) {
      if (seen.has(kw)) continue;
      seen.add(kw);
      patterns.push(kw);
    }
  }
  return patterns.length ? [{ patterns, value: fn.key, match: 'word' }] : [];
}

module.exports = {
  listFunctions,
  getFunction,
  upsertFunction,
  deactivateFunction,
  restoreFunction,
  resolveText,
  hasPlaceholders,
  titleRoleFor,
  buildClassifierRules,
  // exported for tests / reuse
  mergeFunction,
  cleanPlaceholders,
  SYSTEM_FUNCTIONS,
  PLACEHOLDER_KEYS,
};
