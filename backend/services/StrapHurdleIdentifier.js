/**
 * StrapHurdleIdentifier.js
 *
 * Pure function module — takes a DealContext (from DealContextBuilder or
 * actionsGenerator.buildContext), returns the single highest-priority hurdle.
 *
 * Uses a P0–P7 priority hierarchy. The first qualifying hurdle wins.
 * No DB access — entirely deterministic and testable.
 *
 * Returns: { type, param, title, evidence, priority }
 *   type     — one of: close_date, buyer_engagement, process, deal_size,
 *              competitive, momentum, contact_coverage, stage_progression
 *   param    — health param key (e.g. '1a', '2c') or null
 *   title    — human-readable hurdle description
 *   evidence — structured data supporting the identification
 *   priority — P0–P7 string for debugging/logging
 */

class StrapHurdleIdentifier {

  /**
   * Identify the single biggest hurdle for a deal.
   * @param {object} context — DealContext from DealContextBuilder / actionsGenerator.buildContext
   * @returns {{ type: string, param: string|null, title: string, evidence: object, priority: string }}
   */
  static identify(context) {
    const { deal, derived, healthBreakdown, contacts } = context;
    const params   = healthBreakdown?.params || {};
    const dealName = deal.name || 'Deal';

    // ── P0: Existential threats ───────────────────────────────────
    if (derived.isPastClose) {
      return this._hurdle({
        type:     'close_date',
        param:    null,
        title:    `${dealName} is past its close date`,
        priority: 'P0',
        evidence: {
          signal:         'past_close_date',
          daysUntilClose: derived.daysUntilClose,
          closeDate:      deal.close_date || deal.expected_close_date,
        },
      });
    }

    if (derived.isStagnant) {
      return this._hurdle({
        type:     'momentum',
        param:    null,
        title:    `${dealName} has stalled — no progress in ${derived.daysInStage} days`,
        priority: 'P0',
        evidence: {
          signal:              'stagnant_deal',
          daysInStage:         derived.daysInStage,
          daysSinceLastMeeting: derived.daysSinceLastMeeting,
          daysSinceLastEmail:  derived.daysSinceLastEmail,
          stage:               deal.stage,
        },
      });
    }

    // ── P1: No decision maker access ──────────────────────────────
    const noEconBuyer = params['2a']?.state === 'unknown' || params['2a']?.state === 'absent';
    const noDMs       = (derived.decisionMakers || []).length === 0;

    if (noEconBuyer && noDMs) {
      return this._hurdle({
        type:     'buyer_engagement',
        param:    '2a',
        title:    `No economic buyer or decision maker identified on ${dealName}`,
        priority: 'P1',
        evidence: {
          signal:          'no_decision_maker',
          param_2a_state:  params['2a']?.state,
          contactCount:    (contacts || []).length,
          decisionMakers:  [],
          dealValue:       deal.value,
        },
      });
    }

    // ── P2: Competitive threat unaddressed ────────────────────────
    const hasCompetitor     = deal.competitive_deal_ai || deal.competitive_deal_user;
    const competitiveParam  = params['5a']?.state;
    const priceParam        = params['5b']?.state;
    const discountParam     = params['5c']?.state;
    const competitiveUnaddr = hasCompetitor && competitiveParam !== 'confirmed';

    if (competitiveUnaddr || priceParam === 'confirmed' || discountParam === 'confirmed') {
      return this._hurdle({
        type:     'competitive',
        param:    hasCompetitor ? '5a' : (priceParam === 'confirmed' ? '5b' : '5c'),
        title:    hasCompetitor
          ? `Active competitor detected on ${dealName} — differentiation needed`
          : `Pricing concern flagged on ${dealName}`,
        priority: 'P2',
        evidence: {
          signal:               hasCompetitor ? 'competitive_threat' : 'price_sensitivity',
          competitive_deal_ai:  deal.competitive_deal_ai,
          competitors:          deal.competitive_competitors,
          param_5a:             params['5a'],
          param_5b:             params['5b'],
          param_5c:             params['5c'],
        },
      });
    }

    // ── P3: Close date not credible ───────────────────────────────
    const closeUnconfirmed = params['1a']?.state === 'unknown';
    const closeSlipped     = params['1b']?.state === 'confirmed';
    const noBuyerEvent     = params['1c']?.state === 'unknown';

    if (closeSlipped) {
      const pushCount = params['1b']?.pushCount || 1;
      return this._hurdle({
        type:     'close_date',
        param:    '1b',
        title:    `Close date has slipped ${pushCount} time${pushCount !== 1 ? 's' : ''} on ${dealName}`,
        priority: 'P3',
        evidence: {
          signal:     'close_date_slipped',
          pushCount,
          closeDate:  deal.close_date || deal.expected_close_date,
          param_1a:   params['1a'],
          param_1b:   params['1b'],
          param_1c:   params['1c'],
        },
      });
    }

    if (closeUnconfirmed) {
      return this._hurdle({
        type:     'close_date',
        param:    '1a',
        title:    `Close date on ${dealName} is not buyer-confirmed`,
        priority: 'P3',
        evidence: {
          signal:    'close_date_unconfirmed',
          closeDate: deal.close_date || deal.expected_close_date,
          param_1a:  params['1a'],
          param_1c:  params['1c'],
        },
      });
    }

    // ── P4: Single-threaded / low stakeholder coverage ────────────
    const singleThreaded = params['2c']?.state === 'absent';
    const stakeholderCount = (derived.stakeholders || []).length;

    if (singleThreaded || stakeholderCount < 2) {
      return this._hurdle({
        type:     'contact_coverage',
        param:    '2c',
        title:    `Only ${stakeholderCount} stakeholder${stakeholderCount !== 1 ? 's' : ''} on ${dealName} — single-threaded risk`,
        priority: 'P4',
        evidence: {
          signal:          'single_threaded',
          stakeholderCount,
          param_2c:        params['2c'],
          contacts:        (contacts || []).map(c => ({
            name: `${c.first_name} ${c.last_name}`,
            role: c.role_type || c.deal_role,
          })),
        },
      });
    }

    // ── P5: Momentum loss ─────────────────────────────────────────
    const noRecentMeeting = (derived.daysSinceLastMeeting || 999) > 14;
    const noRecentEmail   = (derived.daysSinceLastEmail || 999) > 10;
    const noUpcoming      = (derived.upcomingMeetings || []).length === 0;
    const slowResponse    = params['6b']?.state === 'confirmed';

    if ((noRecentMeeting && noRecentEmail && noUpcoming) || slowResponse) {
      return this._hurdle({
        type:     'momentum',
        param:    slowResponse ? '6b' : '6a',
        title:    slowResponse
          ? `Buyer response time is slowing on ${dealName}`
          : `No recent engagement on ${dealName} — ${derived.daysSinceLastMeeting || '?'}d since last meeting`,
        priority: 'P5',
        evidence: {
          signal:               slowResponse ? 'slow_response' : 'momentum_loss',
          daysSinceLastMeeting: derived.daysSinceLastMeeting,
          daysSinceLastEmail:   derived.daysSinceLastEmail,
          upcomingMeetings:     (derived.upcomingMeetings || []).length,
          param_6a:             params['6a'],
          param_6b:             params['6b'],
        },
      });
    }

    // ── P6: Process blockers ──────────────────────────────────────
    const legalNotEngaged    = params['3a']?.state === 'unknown' || params['3a']?.state === 'absent';
    const securityNotEngaged = params['3b']?.state === 'unknown' || params['3b']?.state === 'absent';

    if (legalNotEngaged && derived.closingImminently) {
      return this._hurdle({
        type:     'process',
        param:    '3a',
        title:    `Legal/procurement not engaged on ${dealName} — closing imminently`,
        priority: 'P6',
        evidence: {
          signal:        'legal_not_engaged',
          daysUntilClose: derived.daysUntilClose,
          param_3a:      params['3a'],
          param_3b:      params['3b'],
        },
      });
    }

    if (securityNotEngaged && derived.closingImminently) {
      return this._hurdle({
        type:     'process',
        param:    '3b',
        title:    `Security review not initiated on ${dealName} — closing imminently`,
        priority: 'P6',
        evidence: {
          signal:        'security_not_engaged',
          daysUntilClose: derived.daysUntilClose,
          param_3a:      params['3a'],
          param_3b:      params['3b'],
        },
      });
    }

    // ── P7: Stage-specific gap ────────────────────────────────────
    const guidance      = context.playbookStageGuidance;
    const stageActions  = context.playbookStageActions || [];
    const existingActions = context.existingActions || []; // if provided

    if (guidance?.requires_proposal_doc) {
      const files = context.files || [];
      const hasProposal = files.some(f =>
        f.category === 'document' &&
        /proposal|quote|pricing|sow|contract/i.test(f.file_name)
      );
      if (!hasProposal) {
        return this._hurdle({
          type:     'stage_progression',
          param:    null,
          title:    `Proposal document required for ${deal.stage} stage on ${dealName}`,
          priority: 'P7',
          evidence: {
            signal:    'no_proposal_doc',
            stage:     deal.stage,
            stageType: deal.stage_type,
            guidance:  { goal: guidance.goal, timeline: guidance.timeline },
          },
        });
      }
    }

    // ── Fallback: use lowest health category score ────────────────
    return this._hurdleFromLowestCategory(context);
  }

  // ── Helpers ─────────────────────────────────────────────────────

  static _hurdle({ type, param, title, priority, evidence }) {
    return { type, param, title, priority, evidence };
  }

  /**
   * Fallback: find the lowest-scoring health category and create a hurdle from it.
   */
  static _hurdleFromLowestCategory(context) {
    const { deal, healthBreakdown } = context;
    const dealName   = deal.name || 'Deal';
    const categories = healthBreakdown?.categories || {};

    const CATEGORY_MAP = {
      '1': { type: 'close_date',        label: 'Close Date Credibility' },
      '2': { type: 'buyer_engagement',   label: 'Buyer Engagement & Power' },
      '3': { type: 'process',            label: 'Process Completion' },
      '4': { type: 'deal_size',          label: 'Deal Size Realism' },
      '5': { type: 'competitive',        label: 'Competitive Risk' },
      '6': { type: 'momentum',           label: 'Momentum' },
    };

    let lowestKey   = null;
    let lowestScore = 101;

    for (const [key, cat] of Object.entries(categories)) {
      if (cat.score < lowestScore) {
        lowestScore = cat.score;
        lowestKey   = key;
      }
    }

    if (lowestKey && CATEGORY_MAP[lowestKey]) {
      const mapped = CATEGORY_MAP[lowestKey];
      return this._hurdle({
        type:     mapped.type,
        param:    null,
        title:    `Weakest area on ${dealName}: ${mapped.label} (score: ${lowestScore}/100)`,
        priority: 'P7',
        evidence: {
          signal:        'lowest_health_category',
          categoryKey:   lowestKey,
          categoryLabel: mapped.label,
          categoryScore: lowestScore,
          healthScore:   deal.health_score,
        },
      });
    }

    // Absolute fallback — no health data at all
    return this._hurdle({
      type:     'momentum',
      param:    null,
      title:    `Insufficient data to assess ${dealName} — initial engagement needed`,
      priority: 'P7',
      evidence: { signal: 'no_health_data', healthScore: deal.health_score },
    });
  }
}

module.exports = StrapHurdleIdentifier;
