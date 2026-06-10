// ============================================================================
// config/prospectingConfigSchema.js
//
// THE source of truth for the shape of `prospecting_config`. This config is
// read by services/SkillContextService.js (buildOrgContext) and written by
// routes/prospecting-config.routes.js + routes/prospecting-campaigns.routes.js
// (the campaign config endpoints). Keep this file and buildOrgContext in
// sync — if a field is added here it must be consumed there, and vice versa.
//
// Three stores:
//   ORG       — organizations.settings.prospecting_config
//   CAMPAIGN  — prospecting_campaigns.prospecting_config_override
//   USER      — user_preferences.preferences.prospecting_config
//
// ─── ORG-LEVEL SHAPE ─────────────────────────────────────────────────────────
//   {
//     pitch:                        string         // short narrative pitch the
//                                                  // skill paraphrases as the
//                                                  // email's bridge framing
//     products:                     Product[]      // priority order; skill
//                                                  // anchors to products[0]
//     default_value_props:          string[]
//     default_target_personas:      string[]
//     default_case_study_summaries: CaseStudy[]    // structured — see below
//     hook_preferences: {
//       preferred_categories: string[]   // ordered list of HOOK_CATEGORIES
//     }
//     guardrails: {
//       banned_phrasings:     string[]
//       required_disclaimers: string[]
//     }
//   }
//
//   Product = { name: string, one_liner: string }
//     - `name` is the human-readable product label (e.g. "Aquarient Data Services")
//     - `one_liner` is the model-facing pitch sentence the skill paraphrases
//
//   CaseStudy = {
//     id:             string,    // opaque, stable, generated once
//     customer:       string,    // human label, e.g. "an energy management firm"
//     their_problem:  string,    // what was broken before we engaged
//     what_we_did:    string,    // the concrete work we did
//     outcome:        string,    // the result (qualitative or quantitative)
//   }
//     - `id` is opaque and stable (e.g. "cs_a1b2c3"), generated once at
//       creation, never changed. It is the key user-level exclusion uses.
//     - All four content fields are independent. The skill may reference any
//       combination in any given email — `their_problem` in the opener,
//       `outcome` in the bridge, etc.
//
// ─── CAMPAIGN-LEVEL SHAPE ────────────────────────────────────────────────────
// Same field set as ORG. Every field is independently optional — leaving a
// field empty/absent means "inherit from org" for that field. Non-empty
// fields REPLACE the org value for pitch / products / value_props /
// target_personas / case_studies / hook_preferences. Guardrails are additive —
// campaign values are unioned with org values; campaigns never loosen org
// restrictions.
//
// ─── USER-LEVEL SHAPE ────────────────────────────────────────────────────────
//   {
//     custom_products:           Product[]           // structured
//     custom_value_props:        string[]
//     custom_target_personas:    string[]
//     custom_case_studies:       CaseStudy[]         // structured
//     custom_competitors:        string[]
//     excluded_products:         string[]            // match by product NAME
//     excluded_value_props:      string[]
//     excluded_target_personas:  string[]
//     excluded_case_studies:     string[]            // case study IDs OR customer names
//     excluded_competitors:      string[]            // competitor names
//     rep: {
//       title_for_signature:   string
//       email_signature_block: string
//     }
//     voice: {
//       avoid_phrases: string[]
//     }
//     hook_preferences: {
//       preferred_categories: string[]   // per-rep override; ordered
//     }
//   }
//
// ─── SCHEMA EVOLUTION (this file) ────────────────────────────────────────────
// v2: products promoted from string[] to Product[]; CaseStudy.summary dropped,
//     replaced by three fields: their_problem, what_we_did, outcome.
//
// Validation is STRICT on new writes:
//   - Products without a `name` are dropped (a one_liner with no name is junk).
//   - Case studies without a `customer` AND without any content field are dropped.
//   - Legacy-shape entries (string product / {customer, summary} case study)
//     are also dropped silently. This is intentional — there is no legacy data
//     in any store as of the v2 cutover. If you find this file in 6 months and
//     need to migrate something, write a one-off migration script; don't relax
//     this sanitizer.
// ============================================================================

const crypto = require('crypto');

// Valid hook categories — must match the outreach-email / outreach-linkedin
// SKILL.md output format enums.
const HOOK_CATEGORIES = [
  'prospect_post', 'prospect_comment', 'account_post',
  'account_event', 'tech_stack', 'role_curiosity',
];

// ── Enums for the org-configurable enforcement surfaces (fit gate + title
// classifier + caps). Kept here (not imported from ProspectClassifier/FitGate)
// so the sanitizer has no service dependency. Must stay in sync with
// ProspectClassifier's function/seniority enums and FitGate's rule shape.
const CLASSIFIER_FUNCTION_VALUES  = ['revenue', 'sales', 'marketing', 'exec_founder', 'ops', 'product', 'other'];
const CLASSIFIER_SENIORITY_VALUES = ['c_level', 'vp', 'director', 'manager', 'ic'];
const CLASSIFIER_MATCH_MODES      = ['word', 'substring'];   // how a keyword compiles to regex
const FIT_MATCH_TYPES             = ['one_of', 'contains_any', 'contains_text'];
const FIT_REQUIREMENTS            = ['must', 'should', 'exclude'];
const EMAIL_CAP_INTENTS           = ['default', 'first_touch', 'follow_up', 'breakup'];
const LINKEDIN_CAP_INTENTS        = ['default', 'connection_request', 'post_accept', 'nurture_dm'];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Coerce anything into a clean array of non-empty trimmed strings.
function cleanStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map(x => (typeof x === 'string' ? x.trim() : ''))
    .filter(x => x.length > 0);
}

// Filter a string array down to valid hook categories, preserving order.
function cleanHookCategories(v) {
  return cleanStringArray(v).filter(x => HOOK_CATEGORIES.includes(x));
}

// Pitch: a short free-text narrative ("what we say to this audience and why").
// Trimmed and hard-capped — the skill paraphrases it, so a multi-page pitch
// only burns tokens without improving output. Empty/invalid sanitizes to ''
// which the resolver in buildOrgContext reads as "inherit" (campaign) or
// "absent" (org).
const PITCH_MAX_CHARS = 2000;
function cleanPitch(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  return s.length > PITCH_MAX_CHARS ? s.slice(0, PITCH_MAX_CHARS).trim() : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Products (v2: structured)
// ─────────────────────────────────────────────────────────────────────────────
function cleanProduct(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const name      = typeof p.name      === 'string' ? p.name.trim()      : '';
  const oneLiner  = typeof p.one_liner === 'string' ? p.one_liner.trim() : '';
  // A product MUST have a name. Drop nameless entries silently — a one_liner
  // without a name is unanchored content the skill can't reference cleanly.
  if (!name) return null;
  return { name, one_liner: oneLiner };
}

function cleanProductArray(v) {
  if (!Array.isArray(v)) return [];
  // De-dupe by name (case-insensitive trim).
  const seen = new Set();
  const out = [];
  for (const item of v) {
    const cleaned = cleanProduct(item);
    if (!cleaned) continue;
    const key = cleaned.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case studies (v2: structured, four content fields, no summary)
// ─────────────────────────────────────────────────────────────────────────────
function newCaseStudyId() {
  return 'cs_' + crypto.randomBytes(4).toString('hex');
}

// Normalize one case study object. Preserves a valid id; mints one when missing.
// A case study MUST have at least one of the three content fields
// (their_problem, what_we_did, outcome) to be kept. Entries with only a
// customer name and no content are dropped — there is nothing for the skill
// to anchor to.
//
// Legacy `{customer, summary}` entries (pre-v2 schema) are dropped: the
// `summary` field is not preserved or auto-migrated. This is intentional —
// see file header. To migrate legacy data, write a one-off script that
// promotes `summary` to one of the three new fields before save.
function cleanCaseStudy(cs) {
  if (!cs || typeof cs !== 'object') return null;
  const customer     = typeof cs.customer      === 'string' ? cs.customer.trim()      : '';
  const theirProblem = typeof cs.their_problem === 'string' ? cs.their_problem.trim() : '';
  const whatWeDid    = typeof cs.what_we_did   === 'string' ? cs.what_we_did.trim()   : '';
  const outcome      = typeof cs.outcome       === 'string' ? cs.outcome.trim()       : '';

  // Must have at least one content field. A customer name alone is not enough
  // — there is nothing for the skill to reference.
  if (!theirProblem && !whatWeDid && !outcome) return null;

  const id = (typeof cs.id === 'string' && /^cs_[a-z0-9]+$/.test(cs.id))
    ? cs.id
    : newCaseStudyId();
  return {
    id,
    customer,
    their_problem: theirProblem,
    what_we_did:   whatWeDid,
    outcome,
  };
}



function cleanCaseStudyArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(cleanCaseStudy).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fit rules (org-configurable hard gate). Each rule must be coherent or it is
// dropped — a malformed rule must never silently widen or block the gate.
//   { field, match: one_of|contains_any|contains_text, values: string[],
//     requirement: must|should|exclude, label? }
// An empty/invalid array sanitizes to [] which the resolver reads as "inherit".
// ─────────────────────────────────────────────────────────────────────────────
function cleanFitRule(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const field = typeof r.field === 'string' ? r.field.trim() : '';
  const match = typeof r.match === 'string' ? r.match.trim() : '';
  const requirement = typeof r.requirement === 'string' ? r.requirement.trim() : '';
  const values = cleanStringArray(r.values);
  if (!field) return null;
  if (!FIT_MATCH_TYPES.includes(match)) return null;
  if (!FIT_REQUIREMENTS.includes(requirement)) return null;
  if (values.length === 0) return null;             // a rule with no values can't match
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : field;
  return { field, match, values, requirement, label };
}

function cleanFitRules(v) {
  if (!Array.isArray(v)) return [];
  return v.map(cleanFitRule).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Title classifier (org/user-configurable function + seniority maps).
//
// The config surface is KEYWORDS, not regex — keywords are human-editable and
// the classifier compiles them to word/substring regex at match time (see
// ProspectClassifier.compilePattern). Each rule:
//   { patterns: string[], value: <enum>, match?: 'word'|'substring' }
// Rules are evaluated in order, first match wins, and sit ABOVE the built-in
// defaults (additive: config rules are tried before defaults; user before org).
// ─────────────────────────────────────────────────────────────────────────────
function cleanClassifierRule(r, allowedValues) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const patterns = cleanStringArray(r.patterns);
  const value = typeof r.value === 'string' ? r.value.trim() : '';
  if (patterns.length === 0) return null;
  if (!allowedValues.includes(value)) return null;
  const match = CLASSIFIER_MATCH_MODES.includes(r.match) ? r.match : 'word';
  return { patterns, value, match };
}

function cleanClassifierRules(v, allowedValues) {
  if (!Array.isArray(v)) return [];
  return v.map(r => cleanClassifierRule(r, allowedValues)).filter(Boolean);
}

function cleanDecisionMaker(input) {
  const dm = (input && typeof input === 'object') ? input : {};
  const seniorities = cleanStringArray(dm.seniorities).filter(s => CLASSIFIER_SENIORITY_VALUES.includes(s));
  const functions   = cleanStringArray(dm.functions).filter(f => CLASSIFIER_FUNCTION_VALUES.includes(f));
  // Empty arrays mean "inherit the built-in decision_maker definition".
  return { seniorities, functions };
}

function cleanTitleClassifier(input) {
  const c = (input && typeof input === 'object') ? input : {};
  return {
    function_rules:  cleanClassifierRules(c.function_rules,  CLASSIFIER_FUNCTION_VALUES),
    seniority_rules: cleanClassifierRules(c.seniority_rules, CLASSIFIER_SENIORITY_VALUES),
    decision_maker:  cleanDecisionMaker(c.decision_maker),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outreach caps (org/user-configurable length limits). Email caps are word
// counts per intent; LinkedIn caps are character counts per intent. Absent /
// invalid entries are dropped and the validator falls back to its built-ins.
// ─────────────────────────────────────────────────────────────────────────────
function posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function cleanEmailCapEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  for (const k of ['bodyWords', 'subjectWords', 'previewWords']) {
    const n = posInt(e[k]);
    if (n != null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

function cleanOutreachCaps(input) {
  const c = (input && typeof input === 'object') ? input : {};
  const emailIn = (c.email && typeof c.email === 'object') ? c.email : {};
  const liIn    = (c.linkedin && typeof c.linkedin === 'object') ? c.linkedin : {};
  const email = {};
  for (const intent of EMAIL_CAP_INTENTS) {
    const cleaned = cleanEmailCapEntry(emailIn[intent]);
    if (cleaned) email[intent] = cleaned;
  }
  const linkedin = {};
  for (const intent of LINKEDIN_CAP_INTENTS) {
    const n = posInt(liIn[intent]);
    if (n != null) linkedin[intent] = n;
  }
  return { email, linkedin };
}

function cleanRecencyDays(v) {
  const n = posInt(v);
  if (n == null) return null;
  return Math.min(n, 365);     // hard ceiling; null means "inherit / default"
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeOrgConfig — takes arbitrary input, returns a clean org config object.
// Always returns the full shape (empty arrays/objects rather than missing
// keys) so buildOrgContext never has to null-guard.
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeOrgConfig(input) {
  const c = (input && typeof input === 'object') ? input : {};
  const g = (c.guardrails && typeof c.guardrails === 'object') ? c.guardrails : {};
  const hp = (c.hook_preferences && typeof c.hook_preferences === 'object')
    ? c.hook_preferences : {};
  return {
    pitch:                        cleanPitch(c.pitch),
    products:                     cleanProductArray(c.products),
    default_value_props:          cleanStringArray(c.default_value_props),
    default_target_personas:      cleanStringArray(c.default_target_personas),
    default_case_study_summaries: cleanCaseStudyArray(c.default_case_study_summaries),
    hook_preferences: {
      preferred_categories: cleanHookCategories(hp.preferred_categories),
    },
    guardrails: {
      banned_phrasings:     cleanStringArray(g.banned_phrasings),
      required_disclaimers: cleanStringArray(g.required_disclaimers),
    },
    // Org-configurable enforcement surfaces (additive; user layer prevails over
    // these, which prevail over built-in defaults). Empty/absent = inherit.
    fit_rules:         cleanFitRules(c.fit_rules),
    title_classifier:  cleanTitleClassifier(c.title_classifier),
    outreach_caps:     cleanOutreachCaps(c.outreach_caps),
    hook_recency_days: cleanRecencyDays(c.hook_recency_days),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeCampaignConfig — same shape as org, but every section is
// independently optional. We still always emit the full shape (arrays default
// to []); the resolver in buildOrgContext distinguishes "empty array" from
// "absent override" by reading from the raw stored JSONB before normalizing.
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeCampaignConfig(input) {
  // Reuse the org sanitizer — identical shape, same validation. The
  // semantics ("empty array means inherit") live in buildOrgContext.
  return sanitizeOrgConfig(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeUserConfig — same idea for the per-user override config.
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeUserConfig(input) {
  const c = (input && typeof input === 'object') ? input : {};
  const rep   = (c.rep   && typeof c.rep   === 'object') ? c.rep   : {};
  const voice = (c.voice && typeof c.voice === 'object') ? c.voice : {};
  const hp    = (c.hook_preferences && typeof c.hook_preferences === 'object')
    ? c.hook_preferences : {};

  return {
    custom_products:          cleanProductArray(c.custom_products),
    custom_value_props:       cleanStringArray(c.custom_value_props),
    custom_target_personas:   cleanStringArray(c.custom_target_personas),
    custom_case_studies:      cleanCaseStudyArray(c.custom_case_studies),
    custom_competitors:       cleanStringArray(c.custom_competitors),
    excluded_products:        cleanStringArray(c.excluded_products),
    excluded_value_props:     cleanStringArray(c.excluded_value_props),
    excluded_target_personas: cleanStringArray(c.excluded_target_personas),
    excluded_case_studies:    cleanStringArray(c.excluded_case_studies),
    excluded_competitors:     cleanStringArray(c.excluded_competitors),
    rep: {
      title_for_signature:   typeof rep.title_for_signature   === 'string' ? rep.title_for_signature.trim()   : '',
      email_signature_block: typeof rep.email_signature_block === 'string' ? rep.email_signature_block.trim() : '',
    },
    voice: {
      avoid_phrases: cleanStringArray(voice.avoid_phrases),
    },
    hook_preferences: {
      preferred_categories: cleanHookCategories(hp.preferred_categories),
    },
    // User-level overrides of the enforcement surfaces. These take precedence
    // over the org defaults (and built-ins) per the resolver in
    // SkillContextService. Empty/absent = fall back to org/built-in.
    fit_rules:         cleanFitRules(c.fit_rules),
    title_classifier:  cleanTitleClassifier(c.title_classifier),
    outreach_caps:     cleanOutreachCaps(c.outreach_caps),
    hook_recency_days: cleanRecencyDays(c.hook_recency_days),
  };
}

// Empty defaults — handed to the UI when no config exists yet.
function emptyOrgConfig()      { return sanitizeOrgConfig(null); }
function emptyCampaignConfig() { return sanitizeCampaignConfig(null); }
function emptyUserConfig()     { return sanitizeUserConfig(null); }

module.exports = {
  HOOK_CATEGORIES,
  sanitizeOrgConfig,
  sanitizeCampaignConfig,
  sanitizeUserConfig,
  emptyOrgConfig,
  emptyCampaignConfig,
  emptyUserConfig,
  newCaseStudyId,
  // Exported for tests and downstream consumers that need them directly:
  cleanProduct,
  cleanProductArray,
  cleanCaseStudy,
  cleanCaseStudyArray,
  cleanPitch,
};
