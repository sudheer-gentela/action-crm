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
//   CAMPAIGN  — prospecting_campaigns.prospecting_config_override (new in Slice 1)
//   USER      — user_preferences.preferences.prospecting_config
//
// ─── ORG-LEVEL SHAPE ─────────────────────────────────────────────────────────
//   {
//     products:                     string[]      // priority order; skill
//                                                  // anchors to products[0]
//     default_value_props:          string[]
//     default_target_personas:      string[]
//     default_case_study_summaries: CaseStudy[]    // structured — see below
//     hook_preferences: {
//       preferred_categories: string[]   // org default; ordered; (Slice 1)
//     }
//     guardrails: {
//       banned_phrasings:     string[]
//       required_disclaimers: string[]
//     }
//   }
//   CaseStudy = { id: string, customer: string, summary: string }
//     - `id` is opaque and stable (e.g. "cs_a1b2c3"), generated once at
//       creation, never changed. It is the key user-level exclusion uses.
//     - `customer` is the human-readable label shown in every UI.
//
// ─── CAMPAIGN-LEVEL SHAPE (Slice 1) ──────────────────────────────────────────
// Same field set as ORG. Every field is independently optional — leaving a
// field empty/absent means "inherit from org" for that field. Non-empty
// fields REPLACE the org value for products / value_props / target_personas /
// case_studies / hook_preferences. Guardrails are additive — campaign values
// are unioned with org values; campaigns never loosen org restrictions.
//   {
//     products?:                     string[]
//     default_value_props?:          string[]
//     default_target_personas?:      string[]
//     default_case_study_summaries?: CaseStudy[]
//     hook_preferences?: { preferred_categories: string[] }
//     guardrails?: {
//       banned_phrasings?:     string[]   // unioned
//       required_disclaimers?: string[]   // unioned
//     }
//   }
//
// ─── USER-LEVEL SHAPE ────────────────────────────────────────────────────────
//   {
//     custom_products:           string[]
//     custom_value_props:        string[]
//     custom_target_personas:    string[]
//     custom_case_studies:       CaseStudy[]
//     custom_competitors:        string[]
//     excluded_products:         string[]    // match org product strings
//     excluded_value_props:      string[]
//     excluded_target_personas:  string[]
//     excluded_case_studies:     string[]    // case study IDs OR customer names
//     excluded_competitors:      string[]    // competitor names
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
// ============================================================================

const crypto = require('crypto');

// Valid hook categories — must match the outreach-personalization SKILL.md
// Output format enum.
const HOOK_CATEGORIES = [
  'prospect_post', 'prospect_comment', 'account_post',
  'account_event', 'tech_stack', 'role_curiosity',
];

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

// Generate an opaque, stable case-study id.
function newCaseStudyId() {
  return 'cs_' + crypto.randomBytes(4).toString('hex');
}

// Normalize one case study object. Preserves an existing valid id; mints a new
// one when missing. Drops entries with no customer AND no summary.
function cleanCaseStudy(cs) {
  if (!cs || typeof cs !== 'object') return null;
  const customer = typeof cs.customer === 'string' ? cs.customer.trim() : '';
  const summary  = typeof cs.summary  === 'string' ? cs.summary.trim()  : '';
  if (!customer && !summary) return null;
  const id = (typeof cs.id === 'string' && /^cs_[a-z0-9]+$/.test(cs.id))
    ? cs.id
    : newCaseStudyId();
  return { id, customer, summary };
}

function cleanCaseStudyArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(cleanCaseStudy).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeOrgConfig — takes arbitrary input, returns a clean org config object.
// Always returns the full shape (empty arrays/objects rather than missing
// keys) so buildOrgContext never has to null-guard.
//
// Slice 1: added top-level hook_preferences.preferred_categories so the org
// can set a default ordering. Previously this field only existed at the user
// level.
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeOrgConfig(input) {
  const c = (input && typeof input === 'object') ? input : {};
  const g = (c.guardrails && typeof c.guardrails === 'object') ? c.guardrails : {};
  const hp = (c.hook_preferences && typeof c.hook_preferences === 'object')
    ? c.hook_preferences : {};
  return {
    products:                     cleanStringArray(c.products),
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeCampaignConfig — same shape as org, but every section is
// independently optional. We still always emit the full shape (arrays default
// to []); the resolver in buildOrgContext distinguishes "empty array" from
// "absent override" by reading from the raw stored JSONB before normalizing.
//
// The wire format from the UI is exactly the same as org config — the UI
// passes whatever the user typed. We do not introduce "null fields mean
// inherit" sentinels in the stored JSON because that's brittle across
// JS/JSONB round-trips. Instead, EMPTY arrays mean inherit (no override for
// that field), and NON-EMPTY arrays replace.
//
// The single exception: if a campaign should fall back to ZERO products/
// personas/etc (i.e. explicitly clear, not inherit), the campaign owner can
// instead just delete the entire override (set the column to NULL via the
// PUT endpoint's "clear" path). This is a deliberate simplicity tradeoff
// for Slice 1.
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
    custom_products:          cleanStringArray(c.custom_products),
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
};
