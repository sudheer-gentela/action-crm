/**
 * services/CampaignSignalEngine.js
 *
 * DROP-IN LOCATION: backend/services/CampaignSignalEngine.js
 *
 * The heart of Phase 5: evaluate a campaign's Target Criteria against a
 * prospect (and its account) to produce a verdict —
 *
 *   { qualifies, priority, priorityScore, whyNow, activeTrigger,
 *     confirmations[], filterResults[], prioritizerResults[] }
 *
 * Composes P1–P4:
 *   - targeting block comes from the campaign's prospecting_config_override
 *     (P3 cleanTargeting: { filters[], prioritizers[], function_key? })
 *   - signal VALUES via SignalService.readForEntities (P1, freshness-resolved)
 *   - each criterion evaluated by SignalPredicateEvaluator (P5, 3-valued)
 *   - role-relative hooks/labels resolved via FunctionTaxonomy against the
 *     campaign's single function_key (P2; per-criterion pinning deferred by
 *     product decision — the criterion.function_key field is respected if
 *     present but the UI sets one campaign function for now)
 *
 * MEMBERSHIP (filters), per D14 / §6:
 *   - a filter that PASSES is satisfied
 *   - a filter that is UNKNOWN does NOT drop the prospect — it becomes a
 *     Work-time confirmation (added to `confirmations`); the prospect stays a
 *     candidate (qualifies stays true on account of unknowns)
 *   - a filter that FAILS (fresh signal, predicate false) disqualifies
 *   So: qualifies = no filter returned 'fail'. Unknowns are surfaced, never
 *   silently excluded (the expensive Filter error the design warns about).
 *
 * PRIORITY (prioritizers), per §6:
 *   - "the strongest active trigger, by priority order, determines how high a
 *     contact sits." Rep-authored order = intent: earlier prioritizers are
 *     stronger. The first prioritizer that evaluates to PASS is the active
 *     trigger; its rank sets the score, and its hook (criterion.hook →
 *     signal default_hook → campaign angle) is the why-now.
 *   - unknown/failed prioritizers contribute nothing (a Prioritize miss is
 *     cheap — no rank bump, no drop).
 *   - no active trigger ⇒ base priority; the campaign angle is the why-now.
 *
 * Never reads or writes prospect.stage. Pure w.r.t. the DB except the single
 * signal read; everything else is computation over the passed-in campaign +
 * function.
 */

const SignalService = require('./SignalService');
const FunctionTaxonomy = require('./FunctionTaxonomyService');
const { evaluate, PASS, FAIL, UNKNOWN } = require('./SignalPredicateEvaluator');

// Rep-facing priority buckets (prospecting_actions.priority is text).
// Derived from the active trigger's RANK (its position in the prioritizer list)
// so the strongest-active-trigger rule maps onto the existing enum.
const PRIORITY_BUCKETS = ['high', 'medium', 'low'];

/**
 * Map an active-trigger rank (0 = strongest) + total prioritizer count to a
 * priority bucket. Top third → high, middle → medium, rest → low. With ≤3
 * prioritizers, rank 0 = high, 1 = medium, 2 = low.
 */
function rankToBucket(rank, total) {
  if (rank == null) return 'low';           // no active trigger
  if (total <= 1) return 'high';
  const third = total / 3;
  if (rank < third) return 'high';
  if (rank < 2 * third) return 'medium';
  return 'low';
}

// A monotone numeric score for ordering the queue (higher = more urgent).
// Encodes: has-active-trigger dominates; among those, earlier rank wins;
// ties broken by how many prioritizers are active (more corroboration = higher).
function computeScore({ activeRank, totalPrioritizers, activeCount }) {
  if (activeRank == null) return 0;
  const rankScore = (totalPrioritizers - activeRank) * 100; // earlier rank → bigger
  return rankScore + activeCount;                            // corroboration tiebreak
}

/**
 * Resolve a criterion/signal into a display label + hook against a function.
 * criterion.function_key (if set) wins over the campaign function (forward-compat
 * with per-criterion pinning); otherwise the campaign function is used.
 */
function resolveHook(criterion, def, campaignFn, functionsByKey, campaignAngle) {
  // hook precedence: criterion-level hook → signal default_hook → campaign angle
  const rawHook = (criterion && criterion.hook)
    || (def && def.defaultHook)
    || campaignAngle
    || null;
  if (!rawHook) return null;
  // Resolve any {leader}/{team}/… tokens in the hook against the right function.
  const fn = (criterion && criterion.function_key && functionsByKey.get(criterion.function_key))
    || campaignFn
    || null;
  return fn ? FunctionTaxonomy.resolveText(rawHook, fn) : rawHook;
}

/**
 * Evaluate a campaign's targeting against ONE prospect (+ its account).
 *
 * @param {object} opts
 * @param {number}  opts.orgId
 * @param {object}  opts.campaign     - row with { id, prospecting_config_override, solution/angle? }
 * @param {object}  opts.prospect     - row with { id, account_id, title? }
 * @param {object} [opts.targeting]   - pre-extracted targeting block (else read from campaign override)
 * @param {object} [opts.now]         - injectable clock
 * @param {object} [opts.client]      - pg client for txn
 * @returns {Promise<object>} verdict
 */
async function evaluateProspect({ orgId, campaign, prospect, targeting, now, client }) {
  if (!orgId) throw new Error('CampaignSignalEngine: orgId is required');
  if (!campaign || !prospect) throw new Error('CampaignSignalEngine: campaign and prospect are required');

  const tgt = targeting || extractTargeting(campaign);
  const filters = Array.isArray(tgt.filters) ? tgt.filters : [];
  const prioritizers = Array.isArray(tgt.prioritizers) ? tgt.prioritizers : [];
  const campaignAngle = campaign.angle || campaign.solution || null;

  // Resolve the campaign function once (for hook/label resolution).
  const functionsByKey = new Map();
  let campaignFn = null;
  if (tgt.function_key) {
    campaignFn = await FunctionTaxonomy.getFunction({ orgId, key: tgt.function_key, client });
    if (campaignFn) functionsByKey.set(campaignFn.key, campaignFn);
  }
  // Also load any per-criterion functions referenced (forward-compat).
  const extraFnKeys = new Set(
    [...filters, ...prioritizers]
      .map((c) => c.function_key)
      .filter((k) => k && !functionsByKey.has(k))
  );
  for (const key of extraFnKeys) {
    const fn = await FunctionTaxonomy.getFunction({ orgId, key, client });
    if (fn) functionsByKey.set(key, fn);
  }

  // Collect every signal key we need, read prospect + account signals in bulk.
  const keys = [...new Set([...filters, ...prioritizers].map((c) => c.signal_key))];
  const [prospectSignals, accountSignals] = await Promise.all([
    keys.length ? SignalService.readByEntity({ orgId, entityType: 'prospect', entityId: prospect.id, keys, client }) : [],
    (keys.length && prospect.account_id)
      ? SignalService.readByEntity({ orgId, entityType: 'account', entityId: prospect.account_id, keys, client })
      : [],
  ]);
  // Signal lookup: prospect-level wins over account-level for the same key
  // (the more specific observation about the person beats the company fact).
  const signalByKey = new Map();
  for (const s of accountSignals) signalByKey.set(s.key, s);
  for (const s of prospectSignals) signalByKey.set(s.key, s);

  // Signal defs (for hooks + labels) — batch.
  const SignalRegistry = require('./SignalRegistryService');
  const defsByKey = await SignalRegistry.getDefsByKeys({ orgId, keys, client });

  // ── Filters → membership ──────────────────────────────────────────────────
  const filterResults = [];
  const confirmations = [];
  let disqualified = false;
  for (const c of filters) {
    const sig = signalByKey.get(c.signal_key) || null;
    const verdict = evaluate(c, sig, { now });
    filterResults.push({ signalKey: c.signal_key, label: c.label, verdict });
    if (verdict === FAIL) {
      disqualified = true;
    } else if (verdict === UNKNOWN) {
      // Becomes a Work-time confirmation — the prospect is NOT dropped.
      const def = defsByKey.get(c.signal_key) || null;
      const fn = (c.function_key && functionsByKey.get(c.function_key)) || campaignFn || null;
      const label = fn ? FunctionTaxonomy.resolveText(c.label || c.signal_key, fn) : (c.label || c.signal_key);
      confirmations.push({ signalKey: c.signal_key, label, reason: sig ? 'stale' : 'never_observed' });
    }
  }
  const qualifies = !disqualified;

  // ── Prioritizers → strongest active trigger ───────────────────────────────
  const prioritizerResults = [];
  let activeRank = null;
  let activeTrigger = null;
  let activeCount = 0;
  prioritizers.forEach((c, idx) => {
    const sig = signalByKey.get(c.signal_key) || null;
    const verdict = evaluate(c, sig, { now });
    prioritizerResults.push({ signalKey: c.signal_key, label: c.label, verdict, rank: idx });
    if (verdict === PASS) {
      activeCount += 1;
      if (activeRank == null) {            // first (strongest) active trigger
        activeRank = idx;
        activeTrigger = c;
      }
    }
  });

  const priority = qualifies ? rankToBucket(activeRank, prioritizers.length) : 'low';
  const priorityScore = qualifies
    ? computeScore({ activeRank, totalPrioritizers: prioritizers.length, activeCount })
    : 0;

  // ── Why-now hook ──────────────────────────────────────────────────────────
  const whyNow = activeTrigger
    ? resolveHook(activeTrigger, defsByKey.get(activeTrigger.signal_key), campaignFn, functionsByKey, campaignAngle)
    : (campaignAngle
        ? (campaignFn ? FunctionTaxonomy.resolveText(campaignAngle, campaignFn) : campaignAngle)
        : null);

  return {
    prospectId: prospect.id,
    qualifies,
    priority,
    priorityScore,
    whyNow,
    activeTrigger: activeTrigger
      ? { signalKey: activeTrigger.signal_key, label: activeTrigger.label, rank: activeRank }
      : null,
    confirmations,
    filterResults,
    prioritizerResults,
  };
}

/**
 * Extract the sanitized targeting block from a campaign row's config override.
 * Tolerates the override being null / a JSON string / already-parsed object.
 */
function extractTargeting(campaign) {
  let override = campaign.prospecting_config_override;
  if (!override) return { filters: [], prioritizers: [] };
  if (typeof override === 'string') {
    try { override = JSON.parse(override); } catch { return { filters: [], prioritizers: [] }; }
  }
  const t = override.targeting;
  if (!t || typeof t !== 'object') return { filters: [], prioritizers: [] };
  return {
    filters: Array.isArray(t.filters) ? t.filters : [],
    prioritizers: Array.isArray(t.prioritizers) ? t.prioritizers : [],
    function_key: t.function_key || null,
  };
}

module.exports = {
  evaluateProspect,
  extractTargeting,
  rankToBucket,
  computeScore,
  PRIORITY_BUCKETS,
};
