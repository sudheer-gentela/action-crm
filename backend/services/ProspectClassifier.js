// ============================================================================
// services/ProspectClassifier.js
//
// Title classifier. Pure / dependency-free: no DB, no network. The single
// highest-signal fitment dimension (function + seniority) is derived from the
// title with zero external data and must never depend on enrichment.
//
// Org/user-configurable: callers may pass a classifierConfig whose keyword
// rules are evaluated BEFORE the built-in defaults (additive — config rules sit
// on top, first match wins; the SkillContextService resolver stacks user rules
// above org rules above these defaults). The config surface is KEYWORDS, not
// regex: each keyword is compiled here to a word-boundary (or substring) regex,
// so a non-technical operator edits plain phrases and can preview the result
// (see classifyTitleTrace) and correct the keywords until the output is right.
//
// Public API:
//   classifyTitle(title, classifierConfig?) -> { function, seniority, decision_maker }
//   classifyTitleTrace(title, classifierConfig?) -> { ...above, trace }
//     trace exposes which layer/rule/keyword matched and the compiled regex,
//     so a config UI can show "your keyword 'head of growth' compiled to
//     \\bhead of growth\\b and matched".
//
//   seniority : 'c_level' | 'vp' | 'director' | 'manager' | 'ic' | 'unknown'
//   function  : 'revenue' | 'sales' | 'marketing' | 'exec_founder'
//             | 'ops' | 'product' | 'other' | 'unknown'
//   decision_maker : boolean
//
// 'unknown' is the deliberate THIRD state (no/unrecognized title) the fit gate
// treats as missing rather than as a value.
//
// classifierConfig shape (all optional; absent => built-in defaults only):
//   {
//     function_rules:  [ { patterns: string[], value: <fn enum>,  match?: 'word'|'substring' } ],
//     seniority_rules: [ { patterns: string[], value: <sen enum>, match?: 'word'|'substring' } ],
//     decision_maker:  { seniorities: <sen enum>[], functions: <fn enum>[] }
//   }
// ============================================================================

'use strict';

function norm(title) {
  if (title == null) return '';
  return String(title).toLowerCase().trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in default rules. Ordered, first-match-wins. Each entry's regex is the
// OR of that category's keyword alternatives — kept identical to the previous
// if-ladder so the zero-config path is byte-for-byte unchanged in behaviour.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_FUNCTION_RULES = [
  { value: 'exec_founder', re: /\b(founder|co-?founder|owner|proprietor)\b|\bceo\b|\bchief executive\b|\bpresident\b|\bmanaging director\b/ },
  { value: 'revenue',      re: /\bcro\b|\bchief revenue\b|\bcco\b|\bchief commercial\b|\bchief customer\b|\brevenue\b/ },
  { value: 'sales',        re: /\bsales\b|\baccount exec(utive)?\b|\bae\b|\bsdr\b|\bbdr\b|\bbusiness development\b|\bbiz dev\b|\bgrowth\b/ },
  { value: 'marketing',    re: /\bcmo\b|\bchief marketing\b|\bmarketing\b|\bdemand gen\b|\bbrand\b|\bcontent\b/ },
  { value: 'product',      re: /\bcpo\b|\bchief product\b|\bproduct\b|\bpm\b|\bproduct manager\b/ },
  { value: 'ops',          re: /\bcoo\b|\bchief operating\b|\boperations\b|\bops\b|\brevops\b|\brev ops\b|\bsales ops\b|\bsales operations\b/ },
  { value: 'other',        re: /\b(cto|cio|ciso|chief technology|chief information)\b|\b(engineer|engineering|developer|architect|technical|technology)\b|\b(cfo|chief financial|finance|controller|accounting|treasur)\b|\b(chro|people|human resources|hr|talent|recruit)\b|\b(legal|counsel|attorney|compliance)\b|\b(it|information technology|infosec|security)\b|\b(data|analytics|research|design|support|success|customer service)\b/ },
];

const DEFAULT_SENIORITY_RULES = [
  { value: 'c_level',  re: /\bchief\b|\bc[eorftpidm]o\b|\b(cco|ciso|chro|cino|cgo|cso|cxo)\b|\b(founder|co-?founder|owner|president|proprietor)\b|\bmanaging director\b|\bmanaging partner\b/ },
  { value: 'vp',       re: /\b(svp|evp|vp|vice president)\b/ },
  { value: 'director', re: /\b(director|head of|head,)\b|\bhead$/ },
  { value: 'manager',  re: /\b(manager|mgr)\b/ },
];

const DEFAULT_DM_SENIORITIES = ['c_level', 'vp', 'director'];
const DEFAULT_DM_FUNCTIONS   = ['exec_founder'];

// ─────────────────────────────────────────────────────────────────────────────
// Keyword -> regex compilation. Keywords are escaped (no ReDoS / no invalid
// regex from operator input) and wrapped in word boundaries by default, or
// matched as a substring when the rule asks for it.
// ─────────────────────────────────────────────────────────────────────────────
function escapeRe(s) {
  return String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePattern(pattern, match) {
  const esc = escapeRe(pattern);
  if (!esc) return null;
  try {
    return match === 'substring'
      ? new RegExp(esc, 'i')
      : new RegExp('\\b' + esc + '\\b', 'i');
  } catch (_) {
    return null;   // defensive: escaped input should never throw
  }
}

// Compile a config rule list into [{ value, patterns:[{keyword, re}] }].
function compileConfigRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const value = typeof rule.value === 'string' ? rule.value : null;
    const kws = Array.isArray(rule.patterns) ? rule.patterns : [];
    if (!value || kws.length === 0) continue;
    const patterns = [];
    for (const kw of kws) {
      const re = compilePattern(kw, rule.match);
      if (re) patterns.push({ keyword: String(kw).trim(), re });
    }
    if (patterns.length) out.push({ value, patterns });
  }
  return out;
}

// Evaluate compiled CONFIG rules first, then built-in DEFAULT rules. Returns a
// trace object describing the winning match (or the fallback).
function evaluateOrdered(t, configRules, defaultRules, emptyValue, noMatchValue) {
  if (!t) return { value: emptyValue, source: 'empty', keyword: null, regex: null };

  for (const rule of configRules) {
    for (const p of rule.patterns) {
      if (p.re.test(t)) {
        return { value: rule.value, source: 'config', keyword: p.keyword, regex: p.re.source };
      }
    }
  }
  for (const rule of defaultRules) {
    if (rule.re.test(t)) {
      return { value: rule.value, source: 'default', keyword: null, regex: rule.re.source };
    }
  }
  return { value: noMatchValue, source: 'none', keyword: null, regex: null };
}

function resolveDmSets(dm) {
  const cfg = (dm && typeof dm === 'object') ? dm : {};
  const sen = Array.isArray(cfg.seniorities) && cfg.seniorities.length ? cfg.seniorities : DEFAULT_DM_SENIORITIES;
  const fns = Array.isArray(cfg.functions)   && cfg.functions.length   ? cfg.functions   : DEFAULT_DM_FUNCTIONS;
  return { seniorities: sen, functions: fns };
}

function classifyTitleTrace(title, classifierConfig) {
  const t = norm(title);
  const cfg = (classifierConfig && typeof classifierConfig === 'object') ? classifierConfig : {};

  const fnConfig  = compileConfigRules(cfg.function_rules);
  const senConfig = compileConfigRules(cfg.seniority_rules);

  const fnT  = evaluateOrdered(t, fnConfig,  DEFAULT_FUNCTION_RULES,  'unknown', 'unknown');
  const senT = evaluateOrdered(t, senConfig, DEFAULT_SENIORITY_RULES, 'unknown', 'ic');

  const dm = resolveDmSets(cfg.decision_maker);
  const decision_maker = dm.seniorities.includes(senT.value) || dm.functions.includes(fnT.value);

  return {
    function: fnT.value,
    seniority: senT.value,
    decision_maker,
    trace: {
      function:  fnT,
      seniority: senT,
      decision_maker: { ...dm, result: decision_maker },
    },
  };
}

function classifyTitle(title, classifierConfig) {
  const r = classifyTitleTrace(title, classifierConfig);
  return { function: r.function, seniority: r.seniority, decision_maker: r.decision_maker };
}

module.exports = {
  classifyTitle,
  classifyTitleTrace,
  // exported for unit testing / config tooling
  compilePattern,
  compileConfigRules,
  DEFAULT_FUNCTION_RULES,
  DEFAULT_SENIORITY_RULES,
  DEFAULT_DM_SENIORITIES,
  DEFAULT_DM_FUNCTIONS,
};
