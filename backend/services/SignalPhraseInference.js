/**
 * services/SignalPhraseInference.js
 *
 * DROP-IN LOCATION: backend/services/SignalPhraseInference.js
 *
 * Light Inference for rep-created role-relative signals (Q-B, product decision:
 * "Literal or Light Inference, not more"). When a rep types a signal label in
 * plain words — "New CFO hired", "VP of Sales just started" — this detects the
 * embedded ROLE TITLE using the P2 taxonomy matcher (titleRoleFor) and proposes
 * a tokenized, function-general version ("New {leader} hired") plus the function
 * it matched. The rep confirms; nothing is auto-applied (design: "surface the
 * question / show how the interpretation is being done").
 *
 * Deliberately NOT natural-language parsing — it only recognizes titles already
 * in the function taxonomy's keyword lists, so it can't mis-scope in surprising
 * ways. If a title is ambiguous across functions (e.g. a keyword shared by two
 * functions), all candidate functions are returned so the UI can ask.
 *
 * Pure w.r.t. inference (operates on a provided taxonomy); one convenience
 * async wrapper loads the org taxonomy and runs it.
 */

const FunctionTaxonomy = require('./FunctionTaxonomyService');

// Placeholder tokens by role key (matches FunctionTaxonomy PLACEHOLDER_KEYS).
const ROLE_TOKEN = {
  leader: '{leader}',
  head: '{head}',
  team: '{team}',
  hire: '{hire}',
  tool: '{tool}',
};

/**
 * Given a label and the org's effective functions, find title matches and
 * propose a tokenization.
 *
 * @param {string} label
 * @param {Array}  functions - FunctionTaxonomy.listFunctions() output
 * @returns {{
 *   hasSuggestion: boolean,
 *   tokenizedLabel: string|null,     // label with the matched phrase → token
 *   role: string|null,               // 'leader' | 'head' | ...
 *   matchedPhrase: string|null,      // the exact substring replaced
 *   functions: string[],             // candidate function keys (>1 = ambiguous)
 *   ambiguous: boolean,
 *   preview: object                  // { functionKey: resolvedLabel } for each candidate
 * }}
 */
function infer(label, functions) {
  const empty = {
    hasSuggestion: false, tokenizedLabel: null, role: null,
    matchedPhrase: null, functions: [], ambiguous: false, preview: {},
  };
  if (typeof label !== 'string' || !label.trim() || !Array.isArray(functions) || functions.length === 0) {
    return empty;
  }
  // If the rep already used a token, nothing to infer.
  if (/\{(leader|head|team|hire|tool)\}/i.test(label)) return empty;

  const lower = label.toLowerCase();

  // Find the LONGEST matching keyword across all functions/roles — longest wins
  // so "chief revenue officer" beats a stray "sales". Track every function that
  // matches the winning phrase (ambiguity).
  let best = null; // { phrase, role, start, functions:Set }
  for (const fn of functions) {
    const placeholders = fn.placeholders || {};
    for (const [roleKey, ph] of Object.entries(placeholders)) {
      if (!ph || !Array.isArray(ph.keywords)) continue;
      for (const kw of ph.keywords) {
        const idx = lower.indexOf(kw.toLowerCase());
        if (idx === -1) continue;
        // Require a word-ish boundary so "hr" doesn't match inside "hire".
        if (!boundedMatch(lower, kw.toLowerCase(), idx)) continue;
        const len = kw.length;
        if (!best || len > best.phrase.length) {
          best = { phrase: label.slice(idx, idx + len), role: roleKey, start: idx, functions: new Set([fn.key]) };
        } else if (len === best.phrase.length && best.role === roleKey
                   && label.slice(idx, idx + len).toLowerCase() === best.phrase.toLowerCase()) {
          best.functions.add(fn.key);
        }
      }
    }
  }

  if (!best) return empty;

  const token = ROLE_TOKEN[best.role];
  const tokenizedLabel = label.slice(0, best.start) + token + label.slice(best.start + best.phrase.length);
  const candidateKeys = [...best.functions];

  // Build a resolved preview per candidate function so the UI can show exactly
  // how the tokenized label will read.
  const preview = {};
  for (const key of candidateKeys) {
    const fn = functions.find((f) => f.key === key);
    preview[key] = fn ? FunctionTaxonomy.resolveText(tokenizedLabel, fn) : tokenizedLabel;
  }

  return {
    hasSuggestion: true,
    tokenizedLabel,
    role: best.role,
    matchedPhrase: best.phrase,
    functions: candidateKeys,
    ambiguous: candidateKeys.length > 1,
    preview,
  };
}

// A keyword match is "bounded" if the chars just before/after aren't
// word characters — so 'hr' matches "VP HR" but not "hire" / "thruput".
function boundedMatch(haystack, kw, idx) {
  const before = idx > 0 ? haystack[idx - 1] : ' ';
  const after = haystack[idx + kw.length] || ' ';
  const isWord = (ch) => /[a-z0-9]/.test(ch);
  return !isWord(before) && !isWord(after);
}

/** Convenience: load the org taxonomy and infer. */
async function inferForOrg({ orgId, label, client }) {
  const functions = await FunctionTaxonomy.listFunctions({ orgId, client });
  return infer(label, functions);
}

module.exports = { infer, inferForOrg, ROLE_TOKEN };
