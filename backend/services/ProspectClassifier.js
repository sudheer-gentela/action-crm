// ============================================================================
// services/ProspectClassifier.js
//
// Pure, dependency-free title classifier. The single highest-signal fitment
// dimension (function + seniority) is derivable from the prospect's title with
// zero external data, so it must never depend on enrichment, DB, or network.
//
// Public API:
//   classifyTitle(title) -> { function, seniority, decision_maker }
//
//   seniority : 'c_level' | 'vp' | 'director' | 'manager' | 'ic' | 'unknown'
//   function  : 'revenue' | 'sales' | 'marketing' | 'exec_founder'
//             | 'ops' | 'product' | 'other' | 'unknown'
//   decision_maker : boolean  (C-suite / VP / Head-of / Founder)
//
// 'unknown' is a deliberate THIRD state for both function and seniority: when
// there is no title (or nothing recognizable), the gate must treat the field as
// unknown rather than as a known value. Never invent a classification.
//
// Case-insensitive. Ordered checks — more specific titles are matched before
// generic ones (e.g. "managing director" before plain "director"; founder/CEO
// before the generic exec words).
// ============================================================================

'use strict';

function norm(title) {
  if (title == null) return '';
  return String(title).toLowerCase().trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Seniority. Ordered most-senior → least-senior. "head of" is a director-level
// signal. "managing director" is matched as c_level before the plain director
// rule can grab the word "director".
// ─────────────────────────────────────────────────────────────────────────────
function classifySeniority(t) {
  if (!t) return 'unknown';

  // C-suite: spelled-out "chief ... officer", common CxO acronyms, and the
  // founder/owner/president family (which are also c-level by authority).
  if (
    /\bchief\b/.test(t) ||
    /\bc[eorftpidm]o\b/.test(t) ||                 // ceo cfo cro cto cpo cio cmo cdo (2-letter middle)
    /\b(cco|ciso|chro|cino|cgo|cso|cxo)\b/.test(t) ||
    /\b(founder|co-?founder|owner|president|proprietor)\b/.test(t) ||
    /\bmanaging director\b/.test(t) ||
    /\bmanaging partner\b/.test(t)
  ) {
    return 'c_level';
  }

  if (/\b(svp|evp|vp|vice president)\b/.test(t)) return 'vp';
  if (/\b(director|head of|head,)\b/.test(t) || /\bhead$/.test(t)) return 'director';
  if (/\b(manager|mgr)\b/.test(t)) return 'manager';

  // Anything else that is a recognizable working title is an individual
  // contributor; a blank/garbage title already returned 'unknown' above.
  return 'ic';
}

// ─────────────────────────────────────────────────────────────────────────────
// Function. Ordered: founder/exec family first (so a "CEO & Founder" is
// exec_founder, not swept up by a stray "sales" token), then the revenue/sales
// split, then marketing / product / ops, then a catch-all of recognized-but-
// out-of-ICP functions ('other'), then 'unknown'.
//
// revenue vs sales is a reporting nicety only — the default fit rule accepts
// either via one_of. CRO / "chief revenue" / "revenue" / CCO -> revenue.
// Sales / AE / SDR / BDR / business development / growth -> sales.
// ─────────────────────────────────────────────────────────────────────────────
function classifyFunction(t) {
  if (!t) return 'unknown';

  // Founder / owner / top-of-house executive. Explicitly per the handover:
  // CEO, Founder, Co-Founder, President, Owner, Managing Director, Proprietor.
  if (
    /\b(founder|co-?founder|owner|proprietor)\b/.test(t) ||
    /\bceo\b/.test(t) || /\bchief executive\b/.test(t) ||
    /\bpresident\b/.test(t) ||
    /\bmanaging director\b/.test(t)
  ) {
    return 'exec_founder';
  }

  // Revenue (chief revenue / commercial / customer officer family).
  if (
    /\bcro\b/.test(t) || /\bchief revenue\b/.test(t) ||
    /\bcco\b/.test(t) || /\bchief commercial\b/.test(t) || /\bchief customer\b/.test(t) ||
    /\brevenue\b/.test(t)
  ) {
    return 'revenue';
  }

  // Sales.
  if (
    /\bsales\b/.test(t) ||
    /\b(account exec|account executive|\bae\b)\b/.test(t) ||
    /\b(sdr|bdr)\b/.test(t) ||
    /\bbusiness development\b/.test(t) || /\bbiz dev\b/.test(t) ||
    /\bgrowth\b/.test(t)
  ) {
    return 'sales';
  }

  // Marketing.
  if (
    /\bcmo\b/.test(t) || /\bchief marketing\b/.test(t) ||
    /\bmarketing\b/.test(t) || /\bdemand gen\b/.test(t) ||
    /\bbrand\b/.test(t) || /\bcontent\b/.test(t)
  ) {
    return 'marketing';
  }

  // Product.
  if (
    /\bcpo\b/.test(t) || /\bchief product\b/.test(t) ||
    /\bproduct\b/.test(t) || /\b(pm|product manager)\b/.test(t)
  ) {
    return 'product';
  }

  // Operations (incl. COO, RevOps, Sales Ops). COO is c_level by seniority but
  // an ops function per the handover's explicit exec_founder list (COO not in
  // it). RevOps/SalesOps land here too.
  if (
    /\bcoo\b/.test(t) || /\bchief operating\b/.test(t) ||
    /\boperations\b/.test(t) || /\bops\b/.test(t) ||
    /\brevops\b/.test(t) || /\brev ops\b/.test(t) ||
    /\bsales ops\b/.test(t) || /\bsales operations\b/.test(t)
  ) {
    return 'ops';
  }

  // Recognized but out-of-ICP functions: engineering, finance, people/HR,
  // legal, IT, etc. Known (not 'unknown') so the gate evaluates rules against a
  // concrete non-matching value rather than treating the field as missing.
  if (
    /\b(cto|cio|ciso|chief technology|chief information)\b/.test(t) ||
    /\b(engineer|engineering|developer|architect|technical|technology)\b/.test(t) ||
    /\b(cfo|chief financial|finance|controller|accounting|treasur)\b/.test(t) ||
    /\b(chro|people|human resources|\bhr\b|talent|recruit)\b/.test(t) ||
    /\b(legal|counsel|attorney|compliance)\b/.test(t) ||
    /\b(\bit\b|information technology|infosec|security)\b/.test(t) ||
    /\b(data|analytics|research|design|support|success|customer service)\b/.test(t)
  ) {
    return 'other';
  }

  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision-maker: C-suite / VP / Head-of(director) / Founder. Mirrors the
// seniority 'must' band {c_level, vp, director} plus the founder function.
// ─────────────────────────────────────────────────────────────────────────────
function isDecisionMaker(seniority, fn) {
  return (
    seniority === 'c_level' ||
    seniority === 'vp' ||
    seniority === 'director' ||
    fn === 'exec_founder'
  );
}

function classifyTitle(title) {
  const t = norm(title);
  const seniority = classifySeniority(t);
  const fn        = classifyFunction(t);
  return {
    function: fn,
    seniority,
    decision_maker: isDecisionMaker(seniority, fn),
  };
}

module.exports = {
  classifyTitle,
  // exported for unit testing
  classifySeniority,
  classifyFunction,
  isDecisionMaker,
};
