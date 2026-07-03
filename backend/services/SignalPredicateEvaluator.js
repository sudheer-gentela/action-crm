/**
 * services/SignalPredicateEvaluator.js
 *
 * DROP-IN LOCATION: backend/services/SignalPredicateEvaluator.js
 *
 * Pure evaluation of ONE targeting criterion against ONE entity signal —
 * Phase 5 of Signal-Based Campaigns. No DB, no side effects; the campaign
 * engine (CampaignSignalEngine) reads signals and calls this per criterion.
 *
 * The operators are exactly prospectingConfigSchema.TARGETING_OPERATORS
 * (is_true | is_false | one_of | gte | lte | within_days | in_geo | exists),
 * and the criterion shape is what cleanTargeting emits:
 *   { signal_key, role, predicate: { operator, value? }, label, function_key? }
 *
 * THE CENTRAL RULE (D14): three-valued logic, unknown is NEVER false.
 *   - A missing signal, or one whose freshness state is 'unknown' (past TTL),
 *     evaluates to 'unknown' — not 'fail'. The campaign layer decides what
 *     unknown means per role: an unknown FILTER becomes a Work-time
 *     confirmation (the prospect stays a candidate), never a silent drop; an
 *     unknown PRIORITIZE simply contributes no rank bump.
 *   - Only a signal we actually have, that is fresh, and that the predicate
 *     tests false, returns 'fail'.
 *
 * Returns one of: 'pass' | 'fail' | 'unknown'.
 *
 * `signal` here is the SignalService read shape:
 *   { state: 'known'|'unknown', value, staleValue, observedAt, ... } | null
 */

const PASS = 'pass';
const FAIL = 'fail';
const UNKNOWN = 'unknown';

// within_days needs an observed date; these operators read observedAt.
const RECENCY_OPERATORS = new Set(['within_days']);

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asArray(v) {
  return Array.isArray(v) ? v : (v == null ? [] : [v]);
}

// Case-insensitive membership for set predicates (one_of, in_geo).
function includesCI(haystack, needleList) {
  const hay = asArray(haystack).map((x) => String(x).trim().toLowerCase());
  const needles = asArray(needleList).map((x) => String(x).trim().toLowerCase());
  return hay.some((h) => needles.includes(h));
}

/**
 * @param {object} criterion  - cleanTargeting criterion ({ predicate, ... })
 * @param {object|null} signal - SignalService read shape, or null if absent
 * @param {object} [opts]
 * @param {Date}   [opts.now]  - injectable clock for within_days
 * @returns {'pass'|'fail'|'unknown'}
 */
function evaluate(criterion, signal, opts = {}) {
  const predicate = criterion && criterion.predicate;
  if (!predicate || !predicate.operator) return UNKNOWN; // malformed → don't drop
  const op = predicate.operator;

  // No signal at all, or freshness resolved it to unknown ⇒ unknown (never false).
  const haveValue = signal && signal.state === 'known' && signal.value != null;

  // 'exists' is special: it asks only whether we HAVE a fresh value.
  if (op === 'exists') {
    return haveValue ? PASS : UNKNOWN;
    // Note: absence is unknown, not fail — we can't prove a thing is absent,
    // only that we haven't observed it. A rep confirms on the page.
  }

  if (!haveValue) return UNKNOWN;
  const value = signal.value;

  switch (op) {
    case 'is_true':
      return value === true ? PASS : (value === false ? FAIL : UNKNOWN);

    case 'is_false':
      return value === false ? PASS : (value === true ? FAIL : UNKNOWN);

    case 'one_of':
      return includesCI(value, predicate.value) ? PASS : FAIL;

    case 'in_geo':
      return includesCI(value, predicate.value) ? PASS : FAIL;

    case 'gte': {
      const n = asNumber(value); const t = asNumber(predicate.value);
      if (n == null || t == null) return UNKNOWN;
      return n >= t ? PASS : FAIL;
    }

    case 'lte': {
      const n = asNumber(value); const t = asNumber(predicate.value);
      if (n == null || t == null) return UNKNOWN;
      return n <= t ? PASS : FAIL;
    }

    case 'within_days': {
      // Event recency: the signal's observed_at (or a value that is itself a
      // date) must be within N days of now. Prefer an explicit date in value;
      // fall back to observedAt (when the fact was recorded).
      const days = asNumber(predicate.value);
      if (days == null) return UNKNOWN;
      const now = opts.now instanceof Date ? opts.now : new Date();
      const ref = coerceDate(value) || coerceDate(signal.observedAt);
      if (!ref) return UNKNOWN;
      const ageDays = (now.getTime() - ref.getTime()) / 86400000;
      if (ageDays < 0) return PASS; // future-dated event: treat as within window
      return ageDays <= days ? PASS : FAIL;
    }

    default:
      return UNKNOWN; // unrecognized operator → don't drop
  }
}

// Best-effort date coercion: accepts Date, ISO string, epoch ms, or an object
// with a { date } / { at } field (common enrichment shapes). Returns null if
// not date-like.
function coerceDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof v === 'string') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof v === 'object') {
    const cand = v.date || v.at || v.observed_at || v.timestamp;
    if (cand) return coerceDate(cand);
  }
  return null;
}

module.exports = {
  evaluate,
  coerceDate,
  PASS,
  FAIL,
  UNKNOWN,
  RECENCY_OPERATORS,
};
