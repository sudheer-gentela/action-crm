/**
 * StrapStrategyBuilder.js
 *
 * Takes a hurdle + DealContext, produces strategy text and testable hypothesis.
 * Has rule-based templates with optional AI enhancement.
 *
 * Pattern: static class methods (matches ActionsRulesEngine, ActionConfigService).
 * AI calls: lazy-init Anthropic client (matches actionCompletionDetector.service.js).
 */

let anthropic = null;
function getAnthropic() {
  if (!anthropic) {
    const { Anthropic } = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ── Strategy templates per hurdle type ─────────────────────────────────────

const STRATEGY_TEMPLATES = {

  buyer_engagement: {
    strategy:   'Leverage existing champion or highest-seniority contact to broker introduction to the economic buyer. If no champion exists, use the most engaged contact to map the buying committee.',
    hypothesis: 'If {champion_or_contact} makes an introduction, we can schedule an executive meeting within 2 weeks.',
    actions: [
      { title: 'Identify who can introduce you to the economic buyer', action_type: 'task_complete', next_step: 'internal_task', due_days: 1, is_gate: true },
      { title: 'Request introduction via champion/highest contact', action_type: 'email_send', next_step: 'email', due_days: 2 },
      { title: 'Schedule executive briefing meeting', action_type: 'meeting_schedule', next_step: 'email', due_days: 5 },
    ],
  },

  competitive: {
    strategy:   'Build differentiation narrative and ensure key stakeholders understand our unique value before the competitor solidifies their position.',
    hypothesis: 'If we deliver a tailored competitive analysis to {decision_maker}, we can shift the evaluation criteria in our favour.',
    actions: [
      { title: 'Prepare competitive differentiation document', action_type: 'document_prep', next_step: 'document', due_days: 2, is_gate: true },
      { title: 'Share differentiation materials with key stakeholders', action_type: 'email_send', next_step: 'email', due_days: 3 },
      { title: 'Schedule call to address competitive concerns directly', action_type: 'meeting_schedule', next_step: 'email', due_days: 5 },
    ],
  },

  close_date: {
    strategy:   'Validate timeline by identifying and confirming the buyer event or internal deadline driving the purchase. If close date has slipped, address root cause directly.',
    hypothesis: 'If the buyer confirms a specific internal deadline by {due_date}, the close date becomes credible.',
    actions: [
      { title: 'Ask buyer what internal event drives their timeline', action_type: 'email_send', next_step: 'email', due_days: 1, is_gate: true },
      { title: 'Confirm revised close date with buyer commitment', action_type: 'follow_up', next_step: 'call', due_days: 3 },
    ],
  },

  contact_coverage: {
    strategy:   'Map the buying committee and create reasons for multi-stakeholder engagement — workshop, technical review, or executive briefing.',
    hypothesis: 'If we add {n} new stakeholders with meaningful roles within 2 weeks, single-threaded risk is mitigated.',
    actions: [
      { title: 'Map the full buying committee with your champion', action_type: 'task_complete', next_step: 'internal_task', due_days: 2, is_gate: true },
      { title: 'Request introductions to missing stakeholders', action_type: 'email_send', next_step: 'email', due_days: 3 },
      { title: 'Schedule multi-stakeholder working session', action_type: 'meeting_schedule', next_step: 'email', due_days: 7 },
    ],
  },

  momentum: {
    strategy:   'Re-engage through a value-add touchpoint tied to a specific buyer concern or recent development — not a generic "checking in" email.',
    hypothesis: 'If a new meeting is scheduled or meaningful email exchange resumes within 1 week, momentum is restored.',
    actions: [
      { title: 'Send value-add outreach tied to buyer\'s known concern', action_type: 'email_send', next_step: 'email', due_days: 0, is_gate: true },
      { title: 'Follow up via phone if no response within 3 days', action_type: 'follow_up', next_step: 'call', due_days: 3 },
      { title: 'Propose a specific meeting agenda to re-engage', action_type: 'meeting_schedule', next_step: 'email', due_days: 5 },
    ],
  },

  process: {
    strategy:   'Proactively initiate the outstanding process step (legal review, security questionnaire) to prevent late-stage delays.',
    hypothesis: 'If legal/security engagement is initiated this week, the process step will not delay close.',
    actions: [
      { title: 'Identify the specific process requirement and owner', action_type: 'task_complete', next_step: 'internal_task', due_days: 1, is_gate: true },
      { title: 'Send process initiation request to buyer\'s team', action_type: 'email_send', next_step: 'email', due_days: 2 },
      { title: 'Schedule process review meeting if needed', action_type: 'meeting_schedule', next_step: 'email', due_days: 5 },
    ],
  },

  deal_size: {
    strategy:   'Validate scope and deal value with the buyer. If scope creep or reduction signals are present, re-align expectations.',
    hypothesis: 'If scope and pricing are confirmed in writing by {due_date}, deal size risk is mitigated.',
    actions: [
      { title: 'Review scope agreement with buyer', action_type: 'email_send', next_step: 'email', due_days: 2, is_gate: true },
      { title: 'Confirm pricing and terms in writing', action_type: 'document_prep', next_step: 'document', due_days: 4 },
    ],
  },

  stage_progression: {
    strategy:   'Complete the outstanding stage requirements per the playbook to unlock progression to the next stage.',
    hypothesis: 'If the outstanding stage deliverable is completed, the deal can advance.',
    actions: [
      { title: 'Identify the specific deliverable blocking stage progression', action_type: 'task_complete', next_step: 'internal_task', due_days: 1, is_gate: true },
      { title: 'Complete and deliver the required document/action', action_type: 'document_prep', next_step: 'document', due_days: 3 },
    ],
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

class StrapStrategyBuilder {

  /**
   * Build strategy + actions for a hurdle.
   * @param {object} hurdle  — from StrapHurdleIdentifier.identify()
   * @param {object} context — DealContext
   * @param {object} [opts]  — { useAI: true, actionConfig: null }
   * @returns {Promise<{ strategy: string, hypothesis: string, actions: Array }>}
   */
  static async build(hurdle, context, opts = {}) {
    const template = STRATEGY_TEMPLATES[hurdle.type] || STRATEGY_TEMPLATES.momentum;
    const { deal, contacts, derived } = context;
    const dealName = deal.name || 'Deal';

    // Personalize template placeholders
    let strategy   = template.strategy;
    let hypothesis = template.hypothesis;

    // Fill in contact references
    const champion   = (contacts || []).find(c => c.role_type === 'champion');
    const topContact = (contacts || []).sort((a, b) => {
      const rank = { executive: 0, economic_buyer: 1, decision_maker: 2, champion: 3, influencer: 4 };
      return (rank[a.role_type] ?? 5) - (rank[b.role_type] ?? 5);
    })[0];

    const contactName = champion
      ? `${champion.first_name} ${champion.last_name}`.trim()
      : topContact
        ? `${topContact.first_name} ${topContact.last_name}`.trim()
        : 'your primary contact';

    hypothesis = hypothesis
      .replace('{champion_or_contact}', contactName)
      .replace('{decision_maker}', contactName)
      .replace('{n}', '2-3')
      .replace('{due_date}', new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));

    // Build action objects (match actionsGenerator.insertAction format)
    const actions = template.actions.map((tmpl, idx) => {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (tmpl.due_days || 0));

      return {
        title:            tmpl.title,
        description:      `STRAP action for: ${hurdle.title}`,
        action_type:      tmpl.action_type,
        type:             tmpl.action_type,
        next_step:        tmpl.next_step,
        priority:         idx === 0 ? 'high' : 'medium',
        due_date:         dueDate,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        contact_id:       topContact?.id || null,
        suggested_action: null, // AI will fill this if enabled
        source:           'strap',
        source_rule:      `strap_${hurdle.type}`,
        health_param:     hurdle.param || null,
        deal_stage:       deal.stage_type || deal.stage,
        keywords:         null,
        requires_external_evidence: tmpl.next_step !== 'internal_task',
        // STRAP-specific fields (used by StrapEngine, not inserted directly)
        _sequence:        idx + 1,
        _is_gate:         tmpl.is_gate || false,
        _success_signal:  null, // AI will fill this if enabled
      };
    });

    // Optionally enhance with AI
    const useAI = opts.useAI !== false && process.env.ANTHROPIC_API_KEY;
    if (useAI) {
      try {
        const aiResult = await this._enhanceWithAI(hurdle, context, strategy, hypothesis, actions);
        if (aiResult) {
          strategy   = aiResult.strategy   || strategy;
          hypothesis = aiResult.hypothesis || hypothesis;
          // Merge AI suggested_action and success_signal into actions
          (aiResult.actions || []).forEach((aiAction, idx) => {
            if (actions[idx]) {
              actions[idx].suggested_action = aiAction.suggested_action || actions[idx].suggested_action;
              actions[idx]._success_signal  = aiAction.success_signal   || actions[idx]._success_signal;
            }
          });
        }
      } catch (err) {
        console.error('🎯 StrapStrategyBuilder AI enhancement failed, using templates:', err.message);
      }
    }

    return { strategy, hypothesis, actions };
  }

  // ── AI Enhancement ─────────────────────────────────────────────

  static async _enhanceWithAI(hurdle, context, baseStrategy, baseHypothesis, actions) {
    const { deal, contacts, derived, healthBreakdown } = context;
    const client = getAnthropic();

    const contactSummary = (contacts || []).slice(0, 5).map(c =>
      `${c.first_name} ${c.last_name} (${c.role_type || 'unknown role'}, ${c.title || 'no title'})`
    ).join('; ');

    const prompt = `You are a sales strategy advisor for a CRM system. Given the deal context and identified hurdle, personalize the strategy.

DEAL: ${deal.name}
Stage: ${deal.stage} | Value: $${parseFloat(deal.value || 0).toLocaleString()} | Health: ${deal.health_score}/100 (${deal.health})
Account: ${context.account?.name || 'Unknown'}
Contacts: ${contactSummary || 'None'}
Days in stage: ${derived.daysInStage} | Days until close: ${derived.daysUntilClose ?? 'unknown'}

HURDLE (${hurdle.priority}): ${hurdle.title}
Evidence: ${JSON.stringify(hurdle.evidence)}

BASE STRATEGY: ${baseStrategy}
BASE HYPOTHESIS: ${baseHypothesis}

PLANNED ACTIONS:
${actions.map((a, i) => `${i + 1}. ${a.title}`).join('\n')}

Reply ONLY with valid JSON (no markdown, no backticks):
{
  "strategy": "personalized 2-3 sentence strategy for THIS specific deal",
  "hypothesis": "testable hypothesis with specific names/dates",
  "actions": [
    { "suggested_action": "specific what-to-say/do guidance for action 1", "success_signal": "what evidence means action 1 worked" },
    { "suggested_action": "...", "success_signal": "..." }
  ]
}`;

    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });

    const text    = message.content[0]?.text || '{}';
    const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  }
}

module.exports = StrapStrategyBuilder;
