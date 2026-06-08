// ============================================================================
// services/FitGate.js
//
// Rule-based, hard pass/fail fit gate. This is the gate the model is NOT
// trusted to enforce on itself: even when its own reasoning says "this prospect
// is out of ICP" it will still draft a full sequence, so fit is decided here,
// in code, BEFORE the model call.
//
// Pure / dependency-free: no DB, no network, no composite icp_score. It reuses
// the *idea* of icpScoring._evaluateRule's matching but interprets matches as
// hard pass/fail, never as points.
//
// Public API:
//   assessFit(facts, fitRules) -> { verdict, score, reasons[], known[], unknown[] }
//
//   facts = { title, function, seniority, industry, size, location, decision_maker }
//     function/seniority come from ProspectClassifier; industry/size from the
//     ENRICHED ACCOUNT (accounts.industry / accounts.size), not the sparse
//     prospects.company_* columns.
//
//   fitRules = [
//     { field, match: 'contains_any'|'contains_text'|'one_of', values: [...],
//       requirement: 'must' | 'should' | 'exclude', label }
//   ]
//
// Verdict logic:
//   any 'exclude' rule MATCHES on a KNOWN field   -> disqualified
//   any 'must'    rule FAILS    on a KNOWN field   -> disqualified
//   any 'must'    rule field is UNKNOWN            -> weak  (route to review)
//   any 'should'  rule fails or is UNKNOWN         -> weak
//   all clear                                      -> strong
//
// The THIRD state (unknown) is load-bearing: a missing/unknown field NEVER
// auto-passes and NEVER auto-fails. It pushes the field name to unknown[] and
// downgrades to weak. (This is the exact opposite of the scorer's empty-target
// auto-match bug.)
// ============================================================================

'use strict';

// Default fit rules for the current ICP (CEO/CRO — small B2B SaaS), with
// founder-led companies IN ICP (function 'must' includes exec_founder per the
// founder's confirmation). The Fintech/Staffing/etc. exclude is what filters a
// founder/CEO at a non-fit company once the account is enriched.
const DEFAULT_FIT_RULES = [
  { field: 'function',  match: 'one_of',       values: ['revenue', 'sales', 'exec_founder'],                          requirement: 'must',    label: 'Revenue/sales/founder function' },
  { field: 'seniority', match: 'one_of',       values: ['c_level', 'vp', 'director'],                                 requirement: 'must',    label: 'Decision-maker seniority' },
  { field: 'industry',  match: 'contains_any', values: ['SaaS', 'Software', 'B2B', 'Technology'],                     requirement: 'should',  label: 'B2B SaaS industry' },
  { field: 'size',      match: 'one_of',       values: ['1-10', '11-50', '51-200'],                                   requirement: 'should',  label: 'Small company' },
  { field: 'industry',  match: 'contains_any', values: ['Banking', 'Fintech', 'Staffing', 'Consulting', 'IT Services'], requirement: 'exclude', label: 'Out-of-ICP industry' },
];

// A field value is "unknown" when it is null/undefined/'' or the literal
// classifier sentinel 'unknown'. Booleans (decision_maker) are always known.
function isUnknownValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'boolean') return false;
  const s = String(v).trim();
  return s === '' || s.toLowerCase() === 'unknown';
}

// Match a known field value against a rule's target values. Mirrors the scorer
// semantics: one_of = exact (case-insensitive) equality to any target;
// contains_any / contains_text = case-insensitive substring containment.
function matchRule(matchType, value, values) {
  const targets = Array.isArray(values) ? values : [];
  if (targets.length === 0) return false;   // empty target set never matches
  const v = String(value).toLowerCase().trim();

  switch (matchType) {
    case 'one_of':
      return targets.some(t => v === String(t).toLowerCase().trim());
    case 'contains_any':
    case 'contains_text':
      return targets.some(t => {
        const tt = String(t).toLowerCase().trim();
        return tt !== '' && v.includes(tt);
      });
    default:
      return false;
  }
}

function quote(v) {
  return v === null || v === undefined ? '∅' : `'${v}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveFitRules — layer fit-rule sets into one effective set.
//
// Additive with later layers prevailing: starting from the built-in defaults,
// each subsequent layer (org → user → campaign) OVERRIDES an earlier rule that
// shares the same (field + requirement) key, and ADDS rules with new keys. So a
// user can retune one dimension (e.g. the size band) or add an exclude while
// inheriting the rest of the org/default ICP. Pass layers most-general first:
//   resolveFitRules([DEFAULT_FIT_RULES, orgRules, userRules, campaignRules])
// Empty/absent layers are skipped. Returns a fresh array (never mutates input).
// ─────────────────────────────────────────────────────────────────────────────
function ruleKey(r) {
  return `${r.field}|${r.requirement}`;
}

function resolveFitRules(layers) {
  const merged = new Map();   // key -> rule, insertion order preserved
  const ordered = [];
  const apply = (rules) => {
    if (!Array.isArray(rules)) return;
    for (const r of rules) {
      if (!r || typeof r !== 'object' || !r.field || !r.requirement) continue;
      const k = ruleKey(r);
      if (!merged.has(k)) ordered.push(k);
      merged.set(k, r);
    }
  };
  for (const layer of (Array.isArray(layers) ? layers : [])) apply(layer);
  return ordered.map(k => merged.get(k));
}

function assessFit(facts, fitRules) {
  const f = facts || {};
  const rules = Array.isArray(fitRules) && fitRules.length ? fitRules : DEFAULT_FIT_RULES;

  const reasons = [];
  const knownSet = new Set();
  const unknownSet = new Set();

  let disqualified = false;
  let weak = false;

  // For the optional informational score: fraction of KNOWN must+should rules
  // that passed. Excludes are not counted toward score.
  let scorable = 0;
  let scored = 0;

  for (const rule of rules) {
    const field = rule.field;
    const requirement = rule.requirement || 'should';
    const label = rule.label || field;
    const value = f[field];

    if (isUnknownValue(value)) {
      unknownSet.add(field);
      if (requirement === 'must') {
        weak = true;
        reasons.push(`weak: ${field} unknown — enrich to evaluate '${label}' (must)`);
      } else if (requirement === 'should') {
        weak = true;
        reasons.push(`weak: ${field} unknown — enrich to evaluate '${label}' (should)`);
      } else {
        // exclude on an unknown field cannot fire — no opinion.
        reasons.push(`note: ${field} unknown — exclude '${label}' not evaluated`);
      }
      continue;
    }

    knownSet.add(field);
    const matched = matchRule(rule.match, value, rule.values);

    if (requirement === 'exclude') {
      if (matched) {
        disqualified = true;
        reasons.push(`disqualified: ${field} ${quote(value)} matched exclude rule (${label})`);
      } else {
        reasons.push(`ok: ${field} ${quote(value)} did not match exclude rule (${label})`);
      }
      continue;
    }

    // must / should
    scorable += 1;
    if (matched) {
      scored += 1;
      reasons.push(`ok: ${field} ${quote(value)} satisfied ${requirement} rule (${label})`);
    } else if (requirement === 'must') {
      disqualified = true;
      reasons.push(`disqualified: ${field} ${quote(value)} failed must rule (${label})`);
    } else {
      weak = true;
      reasons.push(`weak: ${field} ${quote(value)} failed should rule (${label})`);
    }
  }

  const verdict = disqualified ? 'disqualified' : (weak ? 'weak' : 'strong');
  const score = scorable > 0 ? Math.round((scored / scorable) * 100) : null;

  return {
    verdict,
    score,                       // informational only — NOT a gate input
    reasons,
    known: [...knownSet],
    unknown: [...unknownSet],
  };
}

module.exports = {
  assessFit,
  resolveFitRules,
  DEFAULT_FIT_RULES,
  // exported for unit testing
  matchRule,
  isUnknownValue,
};
