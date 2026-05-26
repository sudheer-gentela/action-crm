// services/AICostCatalogService.js
//
// Computes per-org accurate AI-cost estimates for each call_type the
// application uses. Resolves the same model and provider AIClientResolver
// resolves at runtime, so the numbers reflect what the org will actually
// pay — not list-price Haiku 4.5 numbers that may or may not match.
//
// Two sources of "typical token usage" feed the estimate:
//   1. Historical: median of input_tokens / output_tokens over the last
//      N days from ai_token_usage. Self-updating, accurate once an org
//      has used the feature a few times.
//   2. Fallback catalog: hardcoded best-guess numbers per call_type, used
//      when historical data is thin (< 5 samples). Numbers come from
//      reading the actual prompt templates and observed completions.
//
// Both are passed through TokenTrackingService.estimateCost, so the same
// pricing logic the runtime uses for billing is the same pricing logic
// the dashboard uses for projection. One source of truth on prices.
//
// Bundles roll up multi-call user actions:
//   - "research_full" = research_account + research_person (cold), or
//     just research_person (warm, when account research is cached).
//   - "outreach_first_touch" = prospecting_draft × 2 (one for email, one
//     for LinkedIn) — the OutreachSkillPanel "Generate" button fires both.

const db                   = require('../config/database');
const TokenTrackingService = require('./TokenTrackingService');
const AIClientResolver     = require('./ai/AIClientResolver');

// ── Fallback "typical" numbers ─────────────────────────────────────────
// Used when an org has fewer than MIN_SAMPLES historical calls of a given
// call_type. Numbers reflect the prompt templates in backend/config/aiPrompts.js
// plus typical observed completion length. Keep these honest — if you tune
// a prompt, update its row here.
//
// `is_cached` indicates the call benefits from Anthropic prompt caching
// (cacheSystem: true in the adapter). Set to false for call types that
// use free-text prompt templates, true for skill-runner calls (the skill
// bundle is byte-identical and far above the minimum cacheable size).
const FALLBACK_CATALOG = {
  // ── Research / enrichment ───────────────────────────────────────────
  research_account:       { typical_input: 1300, typical_output: 1000, is_cached: false },
  research_person:        { typical_input:  900, typical_output:  900, is_cached: false },
  prospecting_research:   { typical_input:  900, typical_output:  900, is_cached: false },

  // ── Skill-runner calls (cache-eligible — skill bundle is 20k+ tokens) ──
  prospecting_draft:      { typical_input:  500, typical_output:  500, cached_prefix: 20500, is_cached: true },
  outreach_email:         { typical_input:  500, typical_output:  500, cached_prefix: 20500, is_cached: true },
  outreach_linkedin:      { typical_input:  500, typical_output:  300, cached_prefix: 20500, is_cached: true },
  discovery_call_prep:    { typical_input:  500, typical_output:  800, cached_prefix: 18000, is_cached: true },

  // ── Inline AI features ──────────────────────────────────────────────
  action_generation:      { typical_input: 1500, typical_output:  600, is_cached: false },
  ai_enhancement:         { typical_input:  800, typical_output:  400, is_cached: false },
  email_analysis:         { typical_input: 1200, typical_output:  300, is_cached: false },
  deal_health_check:      { typical_input: 1500, typical_output:  500, is_cached: false },
  context_suggest:        { typical_input:  800, typical_output:  200, is_cached: false },
  agent_proposal:         { typical_input: 2000, typical_output:  800, is_cached: false },
};

// User-facing labels and descriptions for each call_type. Used by the
// dashboard. Anything not in this map falls back to a humanized version
// of the call_type itself.
const CALL_TYPE_META = {
  research_account:     { label: 'AI Research — Account',         desc: 'Per-account research notes (cached 30 days)' },
  research_person:      { label: 'AI Research — Prospect',        desc: 'Per-prospect research notes' },
  prospecting_research: { label: 'AI Research — Legacy',          desc: 'Legacy prospecting research (single-stage)' },
  prospecting_draft:    { label: 'Outreach Draft',                desc: 'First-touch email or LinkedIn note from the outreach skills' },
  outreach_email:       { label: 'Outreach Email Skill',          desc: 'outreach-email skill direct invocation' },
  outreach_linkedin:    { label: 'Outreach LinkedIn Skill',       desc: 'outreach-linkedin skill direct invocation' },
  discovery_call_prep:  { label: 'Discovery Call Prep',           desc: 'Pre-call briefing from the discovery-call-prep skill' },
  action_generation:    { label: 'Action Generation',             desc: 'AI-suggested next-best actions on deals' },
  ai_enhancement:       { label: 'AI Enhancement',                desc: 'Field-level rewrite/improve actions' },
  email_analysis:       { label: 'Email Analysis',                desc: 'Email sentiment + intent classification' },
  deal_health_check:    { label: 'Deal Health Check',             desc: 'AI-driven deal risk diagnostics' },
  context_suggest:      { label: 'Contextual Suggestions',        desc: 'In-page AI suggestions' },
  agent_proposal:       { label: 'Agent Proposal',                desc: 'Autonomous agent action proposals' },
};

const MIN_SAMPLES = 5;       // Below this, use the fallback catalog
const SAMPLE_DAYS = 30;      // Lookback window for historical median
const HISTORICAL_LOOKBACK_DAYS = 30;  // Lookback for "you ran this N times"

// Bundles — multi-call user actions surfaced as a single estimate
const BUNDLES = {
  research_full: {
    label:       'Generate Research Notes',
    desc:        'Full prospect research (account stage + person stage)',
    components:  ['research_account', 'research_person'],
    notes:       'Cold cost = both stages. Warm cost (account cached < 30 days) = person stage only.',
    warm_components: ['research_person'],
  },
  outreach_first_touch: {
    label:       'Generate Outreach Drafts',
    desc:        'First-touch email + LinkedIn connection note (two parallel skill calls)',
    components:  ['outreach_email', 'outreach_linkedin'],
    notes:       'Cold cost = both skills with cache writes. Warm cost = both skills with cache reads (typical when running a campaign back-to-back within 5 min).',
    // For cached skills, warm cost uses cache reads instead of writes.
    is_skill_bundle: true,
  },
};

class AICostCatalogService {

  /**
   * Main entry point. Returns the full cost-estimate object for an org.
   * Per-call-type rows include the resolved model and the cost projected
   * from either historical typical usage or the fallback catalog.
   *
   * Shape:
   *   {
   *     estimates: {
   *       <call_type>: {
   *         label, desc,
   *         provider, model,           // resolved per call_type for THIS org
   *         typical_input, typical_output,
   *         is_cached,                 // whether this call uses prompt caching
   *         cost_usd,                  // un-cached / first-call cost
   *         cached_cost_usd,           // cache-read cost (null if not cached)
   *         source,                    // 'historical' | 'fallback'
   *         sample_count,              // how many calls fed the median (0 if fallback)
   *         recent_calls,              // how many times this org has called it in HISTORICAL_LOOKBACK_DAYS
   *         recent_cost_usd,           // actual logged cost over the same window
   *       }, ...
   *     },
   *     bundles: {
   *       <bundle_id>: {
   *         label, desc, notes,
   *         components: [<call_type>, ...],
   *         cold_cost_usd, warm_cost_usd,
   *       }, ...
   *     },
   *     period: { lookback_days, generated_at },
   *   }
   */
  static async getCostEstimates(orgId, opts = {}) {
    const lookbackDays = opts.lookbackDays || HISTORICAL_LOOKBACK_DAYS;

    // Step 1 — resolve the model for each call_type. AIClientResolver does
    // org-level resolution when userId is null; that's what we want here
    // because the dashboard is an org-wide projection, not per-user.
    const callTypes = Object.keys(FALLBACK_CATALOG);
    const resolved = {};
    await Promise.all(callTypes.map(async (ct) => {
      try {
        const r = await AIClientResolver._resolveProviderAndModel(orgId, null, ct);
        resolved[ct] = { provider: r.provider, model: r.model };
      } catch (err) {
        console.warn(`AICostCatalog: resolve failed for ${ct}:`, err.message);
        resolved[ct] = { provider: null, model: null };
      }
    }));

    // Step 2 — pull historical medians from ai_token_usage in one query.
    // We use PERCENTILE_CONT(0.5) over the call_type's recent rows to get
    // the median input and output. Mean would be skewed by outliers (a
    // single very long completion); median is what we want.
    //
    // We also pull recent_calls and recent_cost_usd in the same query so
    // we can render "you ran this N times → $X" directly from one row.
    const historicalRes = await db.query(
      `SELECT call_type,
              COUNT(*)::int AS sample_count,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prompt_tokens)::int     AS median_input,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY completion_tokens)::int AS median_output,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day' * $2)::int AS recent_calls,
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day' * $2), 0)::float AS recent_cost_usd
         FROM ai_token_usage
        WHERE org_id = $1
          AND created_at >= NOW() - INTERVAL '1 day' * $3
        GROUP BY call_type`,
      [orgId, lookbackDays, SAMPLE_DAYS]
    );
    const historical = {};
    for (const row of historicalRes.rows) {
      historical[row.call_type] = row;
    }

    // Step 3 — compose per-call-type estimates.
    const estimates = {};
    for (const ct of callTypes) {
      const fallback = FALLBACK_CATALOG[ct];
      const hist     = historical[ct];
      const useHistorical = hist && hist.sample_count >= MIN_SAMPLES
        && hist.median_input  > 0
        && hist.median_output > 0;

      const typical_input  = useHistorical ? hist.median_input  : fallback.typical_input;
      const typical_output = useHistorical ? hist.median_output : fallback.typical_output;
      const cached_prefix  = fallback.cached_prefix || 0;
      const is_cached      = !!fallback.is_cached;

      const model = resolved[ct].model;

      // Cold cost: no cache benefit. Even for cache-eligible call types,
      // the first call after a cache expiry pays the full input rate (the
      // cache-creation rate is 1.25× of normal input, which is roughly the
      // same since the typical_input includes the prefix in the historical
      // case). We deliberately use the simple (input + output) cost here
      // so the number is comparable across cached/non-cached call types.
      const coldCost = TokenTrackingService.estimateCost(model, {
        input_tokens:                is_cached ? typical_input : (typical_input + cached_prefix),
        output_tokens:               typical_output,
        cache_creation_input_tokens: is_cached ? cached_prefix : 0,
        cache_read_input_tokens:     0,
      }) || 0;

      // Warm cost: only meaningful for cache-eligible call types. The
      // cached prefix bills at the much cheaper cache-read rate; the
      // per-call user payload bills at full input rate.
      const warmCost = is_cached
        ? (TokenTrackingService.estimateCost(model, {
            input_tokens:                typical_input,
            output_tokens:               typical_output,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens:     cached_prefix,
          }) || 0)
        : null;

      const meta = CALL_TYPE_META[ct] || { label: ct, desc: '' };

      estimates[ct] = {
        label:           meta.label,
        desc:            meta.desc,
        provider:        resolved[ct].provider,
        model:           resolved[ct].model,
        typical_input,
        typical_output,
        cached_prefix:   is_cached ? cached_prefix : null,
        is_cached,
        cost_usd:        coldCost,
        cached_cost_usd: warmCost,
        source:          useHistorical ? 'historical' : 'fallback',
        sample_count:    useHistorical ? hist.sample_count : 0,
        recent_calls:    hist?.recent_calls    || 0,
        recent_cost_usd: hist?.recent_cost_usd || 0,
      };
    }

    // Step 4 — compose bundles.
    const bundles = {};
    for (const [bundleId, b] of Object.entries(BUNDLES)) {
      const cold = b.components.reduce((sum, ct) => sum + (estimates[ct]?.cost_usd || 0), 0);

      // Warm cost has two interpretations depending on bundle type:
      //   - is_skill_bundle: cache reads on every component → use cached_cost_usd
      //   - Otherwise (e.g. research_full): warm = warm_components subset
      let warm = null;
      if (b.is_skill_bundle) {
        warm = b.components.reduce((sum, ct) => {
          const e = estimates[ct];
          return sum + (e?.cached_cost_usd ?? e?.cost_usd ?? 0);
        }, 0);
      } else if (b.warm_components) {
        warm = b.warm_components.reduce((sum, ct) => sum + (estimates[ct]?.cost_usd || 0), 0);
      }

      bundles[bundleId] = {
        label:         b.label,
        desc:          b.desc,
        notes:         b.notes,
        components:    b.components,
        cold_cost_usd: cold,
        warm_cost_usd: warm,
      };
    }

    return {
      estimates,
      bundles,
      period: {
        lookback_days:  lookbackDays,
        sample_days:    SAMPLE_DAYS,
        min_samples:    MIN_SAMPLES,
        generated_at:   new Date().toISOString(),
      },
    };
  }
}

module.exports = AICostCatalogService;
