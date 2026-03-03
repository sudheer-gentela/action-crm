/**
 * StrapStrategyBuilder.js
 *
 * Generates the full STRAP (Situation → Target → Response → Action Plan)
 * using AI (Claude Haiku) with entity-type-aware prompts.
 *
 * If AI generation fails or is disabled, falls back to rule-based templates.
 */

let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

const AI_MODEL = 'claude-haiku-4-5-20251001';

class StrapStrategyBuilder {

  /**
   * Build a full STRAP strategy.
   *
   * @param {string} entityType
   * @param {object} hurdle     - { hurdleType, title, priority, evidence }
   * @param {object} context    - entity-specific context
   * @param {boolean} useAI     - whether to use AI generation
   * @returns {Promise<{ situation, target, response, actionPlan, aiModel?, aiTokensUsed? }>}
   */
  static async build(entityType, hurdle, context, useAI = true) {
    if (useAI) {
      try {
        return await this._buildWithAI(entityType, hurdle, context);
      } catch (err) {
        console.error('⚠️ StrapStrategyBuilder AI failed, falling back to templates:', err.message);
      }
    }
    return this._buildFromTemplate(entityType, hurdle, context);
  }

  // ── AI Generation ─────────────────────────────────────────────────────────

  static async _buildWithAI(entityType, hurdle, context) {
    const prompt = this._buildPrompt(entityType, hurdle, context);

    const client = getClient();
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    // Parse the structured response
    const situation  = this._extractSection(text, 'SITUATION');
    const target     = this._extractSection(text, 'TARGET');
    const responseText = this._extractSection(text, 'RESPONSE');
    const actionPlan = this._extractSection(text, 'ACTION_PLAN');

    if (!situation || !target) {
      throw new Error('AI response missing required sections');
    }

    return {
      situation:    situation,
      target:       target,
      response:     responseText,
      actionPlan:   actionPlan,
      aiModel:      AI_MODEL,
      aiTokensUsed: tokensUsed,
    };
  }

  static _extractSection(text, tag) {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  }

  static _buildPrompt(entityType, hurdle, context) {
    const entitySummary = this._buildContextSummary(entityType, context);

    return `You are a sales strategy advisor. Generate a STRAP (Situation, Target, Response, Action Plan) for the following ${entityType} hurdle.

ENTITY TYPE: ${entityType}
HURDLE TYPE: ${hurdle.hurdleType}
HURDLE: ${hurdle.title}
PRIORITY: ${hurdle.priority}
EVIDENCE: ${hurdle.evidence}

CONTEXT:
${entitySummary}

Generate a concise, actionable STRAP. Use these XML tags exactly:

<SITUATION>1-2 sentences describing the current situation and why this hurdle matters.</SITUATION>
<TARGET>1 sentence defining the specific, measurable outcome to achieve.</TARGET>
<RESPONSE>2-3 sentences outlining the strategic approach to overcome this hurdle.</RESPONSE>
<ACTION_PLAN>3-5 numbered action items, each starting with a verb. Be specific and practical.</ACTION_PLAN>

Keep each section concise — this is for a busy sales rep. No fluff.`;
  }

  static _buildContextSummary(entityType, context) {
    switch (entityType) {
      case 'deal': {
        const d = context.deal || {};
        const parts = [
          `Deal: "${d.name}" — $${parseFloat(d.value || 0).toLocaleString()} — Stage: ${d.stage}`,
          `Health: ${d.health || 'unknown'} (score: ${d.health_score || 'N/A'})`,
          `Contacts: ${(context.contacts || []).length}`,
          `Days in stage: ${context.derived?.daysInStage || '?'}`,
        ];
        if (context.derived?.daysUntilClose !== null) {
          parts.push(`Days until close: ${context.derived.daysUntilClose}`);
        }
        return parts.join('\n');
      }

      case 'account': {
        const a = context.account || {};
        const d = context.derived || {};
        return [
          `Account: "${a.name}" — Industry: ${a.industry || 'unknown'}`,
          `Won deals: ${d.wonDealCount || 0} ($${(d.totalRevenue || 0).toLocaleString()})`,
          `Open deals: ${(d.openDeals || []).length}`,
          `Contacts: ${d.contactCount || 0} — Prospects: ${d.prospectCount || 0}`,
          `Days since last engagement: ${d.daysSinceLastEngagement || '?'}`,
        ].join('\n');
      }

      case 'prospect': {
        const p = context.prospect || {};
        const d = context.derived || {};
        return [
          `Prospect: ${p.first_name} ${p.last_name} — ${p.title || 'unknown title'} at ${p.company_name || 'unknown'}`,
          `Stage: ${p.stage} — ICP: ${p.icp_score || 'N/A'}/100`,
          `Outreach: ${p.outreach_count || 0} sent, ${p.response_count || 0} responses`,
          `Last outreach: ${d.daysSinceLastOutreach !== null ? d.daysSinceLastOutreach + 'd ago' : 'never'}`,
          d.isExistingCustomer ? 'Existing customer account' : (d.hasOpenDeal ? 'Active deal at account' : 'New prospect'),
        ].join('\n');
      }

      case 'implementation': {
        const d = context.deal || {};
        return [
          `Implementation: "${d.name}" — $${parseFloat(d.value || 0).toLocaleString()}`,
          `Won ${context.derived?.daysInStage || '?'} days ago`,
          `Contacts: ${(context.contacts || []).length}`,
          `Meetings since close: ${(context.derived?.completedMeetings || []).length}`,
        ].join('\n');
      }

      default:
        return 'No context available.';
    }
  }

  // ── Template Fallback ─────────────────────────────────────────────────────

  static _buildFromTemplate(entityType, hurdle, context) {
    const templates = TEMPLATES[entityType] || {};
    const template = templates[hurdle.hurdleType] || this._defaultTemplate(hurdle);
    return {
      situation:  template.situation(hurdle, context),
      target:     template.target(hurdle, context),
      response:   template.response(hurdle, context),
      actionPlan: template.actionPlan(hurdle, context),
    };
  }

  static _defaultTemplate(hurdle) {
    return {
      situation:  (h) => `${h.title}. ${h.evidence}`,
      target:     (h) => `Resolve the ${h.hurdleType.replace(/_/g, ' ')} hurdle within the next 5 business days.`,
      response:   (h) => `Address this ${h.priority}-priority issue by reviewing the situation and taking immediate corrective action.`,
      actionPlan: (h) => `1. Review the current state and evidence\n2. Identify the root cause\n3. Take corrective action\n4. Verify the hurdle is resolved`,
    };
  }
}

// ── Templates per entity_type + hurdle_type ─────────────────────────────────

const TEMPLATES = {
  deal: {
    close_date: {
      situation:  (h) => h.evidence,
      target:     (h) => 'Get a confirmed close date within 3 business days.',
      response:   () => 'Re-engage the buyer with urgency. Propose a concrete timeline and address any blockers preventing commitment.',
      actionPlan: () => '1. Send a direct email asking for updated timeline\n2. Offer a brief call to discuss any remaining concerns\n3. Prepare a mutual action plan with specific dates\n4. Escalate internally if no response within 48 hours',
    },
    buyer_engagement: {
      situation:  (h) => h.evidence,
      target:     () => 'Re-establish active communication within 5 business days.',
      response:   () => 'Try a multi-channel approach — combine email, phone, and social to break through the silence.',
      actionPlan: () => '1. Send a value-add email (share relevant content, not just a follow-up)\n2. Try calling at a different time of day\n3. Reach out to a secondary contact at the account\n4. Send a LinkedIn message referencing something relevant to their business',
    },
    process: {
      situation:  (h) => h.evidence,
      target:     () => 'Get a discovery or demo meeting on the calendar within 5 days.',
      response:   () => 'Propose specific meeting times with a clear agenda that demonstrates value.',
      actionPlan: () => '1. Draft a meeting invite with 2-3 time options\n2. Include a brief agenda focused on their business challenges\n3. Reference any prior conversations or context\n4. Follow up within 48 hours if no response',
    },
    deal_size: {
      situation:  (h) => h.evidence,
      target:     () => 'Identify and engage the decision maker within 7 days.',
      response:   () => 'Research the org chart and ask your champion for an introduction to the economic buyer.',
      actionPlan: () => '1. Research the buyer organization on LinkedIn\n2. Ask your primary contact for an intro to the decision maker\n3. Prepare an executive-level value proposition\n4. Request a brief intro call focused on business outcomes',
    },
    competitive: {
      situation:  (h) => h.evidence,
      target:     () => 'Neutralize the competitive threat within 7 days.',
      response:   () => 'Understand the competitive landscape, differentiate on unique strengths, and reinforce your champion.',
      actionPlan: () => '1. Research the competitor\'s strengths and weaknesses\n2. Prepare a competitive battlecard for this deal\n3. Share relevant case studies that highlight your differentiation\n4. Coach your champion with talk tracks for internal discussions',
    },
    momentum: {
      situation:  (h) => h.evidence,
      target:     () => 'Create a next step commitment within 3 business days.',
      response:   () => 'Introduce something new to reignite interest — a demo, case study, or executive alignment meeting.',
      actionPlan: () => '1. Share a relevant customer success story\n2. Propose a specific next step with a clear value proposition\n3. Consider involving a senior leader for credibility\n4. Set a hard follow-up deadline internally',
    },
    contact_coverage: {
      situation:  (h) => h.evidence,
      target:     () => 'Add at least one additional contact within 7 days.',
      response:   () => 'Multi-thread the deal by identifying and reaching out to additional stakeholders.',
      actionPlan: () => '1. Map the buying committee using LinkedIn or org chart\n2. Ask your primary contact who else is involved in the decision\n3. Reach out to at least one new stakeholder\n4. Add new contacts to the CRM with proper roles',
    },
    stage_progression: {
      situation:  (h) => h.evidence,
      target:     () => 'Advance the deal to the next stage within 10 days.',
      response:   () => 'Review stage exit criteria and systematically address any gaps.',
      actionPlan: () => '1. Review the playbook stage guidance for exit criteria\n2. Identify which criteria are unmet\n3. Create specific actions to address each gap\n4. Schedule a check-in to assess progress',
    },
  },

  account: {
    stale_account: {
      situation:  (h) => h.evidence,
      target:     () => 'Re-establish active engagement within 10 days.',
      response:   () => 'Launch a re-engagement campaign across multiple contacts at the account.',
      actionPlan: () => '1. Identify the 3 most recent contacts with engagement\n2. Send personalized check-in emails with value-add content\n3. Schedule a QBR or account review meeting\n4. Research recent company news to reference in outreach',
    },
    renewal_risk: {
      situation:  (h) => h.evidence,
      target:     () => 'Start an expansion/renewal conversation within 14 days.',
      response:   () => 'Proactively reach out to discuss value realized and expansion opportunities before renewal.',
      actionPlan: () => '1. Pull together a value summary of what the customer has achieved\n2. Identify expansion opportunities based on usage patterns\n3. Schedule a strategic review meeting\n4. Prepare renewal + expansion proposal options',
    },
    champion_gap: {
      situation:  (h) => h.evidence,
      target:     () => 'Identify and develop a new champion within 21 days.',
      response:   () => 'Map current stakeholders and identify who could become a champion.',
      actionPlan: () => '1. Review current contacts for champion potential\n2. Research if the original champion has moved roles/companies\n3. Build relationships with 2-3 potential champion candidates\n4. Provide exclusive value to earn champion status',
    },
    no_exec_relationship: {
      situation:  (h) => h.evidence,
      target:     () => 'Establish executive-level contact within 21 days.',
      response:   () => 'Leverage existing contacts for introductions and create executive-worthy content.',
      actionPlan: () => '1. Identify target executives via LinkedIn\n2. Ask existing contacts for introductions\n3. Prepare executive-level business case or insight\n4. Propose an executive alignment meeting',
    },
    expansion_blocked: {
      situation:  (h) => h.evidence,
      target:     () => 'Unblock the expansion deal within 14 days.',
      response:   () => 'Diagnose the root cause of the stall and address it directly.',
      actionPlan: () => '1. Review the stalled deal for specific blockers\n2. Contact the primary stakeholder to understand hesitation\n3. Address objections with targeted content or proof points\n4. Escalate internally if needed',
    },
    revenue_concentration: {
      situation:  (h) => h.evidence,
      target:     () => 'Identify at least one cross-sell opportunity within 30 days.',
      response:   () => 'Analyze the account for departments or use cases not yet served.',
      actionPlan: () => '1. Map all departments and their needs\n2. Identify overlapping product capabilities\n3. Create a targeted cross-sell proposal\n4. Engage new stakeholders in untapped areas',
    },
    whitespace: {
      situation:  (h) => h.evidence,
      target:     () => 'Expand contact coverage to at least 2 new departments within 30 days.',
      response:   () => 'Systematically map the account and identify entry points in new areas.',
      actionPlan: () => '1. Create an account map with known and unknown departments\n2. Ask existing contacts for introductions\n3. Research department-specific needs\n4. Develop tailored outreach for each new area',
    },
    single_product: {
      situation:  (h) => h.evidence,
      target:     () => 'Introduce awareness of a second product line within 30 days.',
      response:   () => 'Identify which additional products align with the customer\'s needs.',
      actionPlan: () => '1. Review the customer\'s current usage and needs\n2. Identify the best cross-sell product match\n3. Share relevant case studies from similar customers\n4. Propose a brief demo or overview session',
    },
  },

  prospect: {
    ghosting: {
      situation:  (h) => h.evidence,
      target:     () => 'Get a response or make a go/no-go decision within 7 days.',
      response:   () => 'Switch channels and approach. If still no response, consider deprioritizing.',
      actionPlan: () => '1. Try a completely different channel (phone, LinkedIn, etc.)\n2. Send a brief, direct "should I close the file?" breakup email\n3. Reach out to a different person at the same company\n4. If no response after 2 more attempts, move to nurture or disqualify',
    },
    conversion_ready: {
      situation:  (h) => h.evidence,
      target:     () => 'Convert to a qualified deal within 3 business days.',
      response:   () => 'Strike while the iron is hot — propose a meeting to discuss next steps.',
      actionPlan: () => '1. Send a meeting request with specific times\n2. Prepare a brief qualification framework\n3. Have a demo or proposal ready\n4. Create the deal in CRM as soon as meeting is confirmed',
    },
    stale_outreach: {
      situation:  (h) => h.evidence,
      target:     () => 'Resume outreach within 2 business days.',
      response:   () => 'Re-engage with fresh value — don\'t just send a "checking in" email.',
      actionPlan: () => '1. Research recent company news or trigger events\n2. Craft a personalized message referencing something new\n3. Send outreach via the most effective channel\n4. Schedule follow-up for 3 days out',
    },
    no_meeting: {
      situation:  (h) => h.evidence,
      target:     () => 'Get a meeting scheduled within 5 business days.',
      response:   () => 'Capitalize on the engagement by proposing a specific meeting with clear value.',
      actionPlan: () => '1. Propose 2-3 specific meeting times\n2. Include a clear agenda showing what they\'ll learn\n3. Make it easy to book (calendar link or one-click accept)\n4. Follow up within 48 hours if no response',
    },
    no_research: {
      situation:  (h) => h.evidence,
      target:     () => 'Complete research and document findings within 3 days.',
      response:   () => 'Do thorough research before outreach to ensure relevance and personalization.',
      actionPlan: () => '1. Research the company — recent news, financials, tech stack\n2. Research the contact — background, mutual connections, recent posts\n3. Document key findings in research notes\n4. Identify the best angle for initial outreach',
    },
    wrong_channel: {
      situation:  (h) => h.evidence,
      target:     () => 'Try an alternative channel within 3 days.',
      response:   () => 'Switch to a channel more likely to get a response based on the prospect\'s profile.',
      actionPlan: () => '1. Review which channels have been tried\n2. Research the prospect\'s preferred communication style\n3. Send outreach on the new channel\n4. Update preferred channel in CRM based on results',
    },
    multi_thread_needed: {
      situation:  (h) => h.evidence,
      target:     () => 'Identify and add at least one more entry point within 7 days.',
      response:   () => 'Research additional contacts at the company and begin parallel outreach.',
      actionPlan: () => '1. Search LinkedIn for 2-3 relevant contacts at the company\n2. Create new prospect records in CRM\n3. Begin outreach to secondary contacts\n4. Reference the primary prospect connection if appropriate',
    },
    low_icp: {
      situation:  (h) => h.evidence,
      target:     () => 'Make a keep/disqualify decision within 5 days.',
      response:   () => 'Evaluate whether the prospect is worth continued investment or should be deprioritized.',
      actionPlan: () => '1. Review ICP score breakdown for specific weak signals\n2. Check if any qualifying info is missing that could improve the score\n3. If score is accurate, consider moving to nurture\n4. Redirect time to higher-ICP prospects',
    },
  },

  implementation: {
    kickoff_delayed: {
      situation:  (h) => h.evidence,
      target:     () => 'Schedule an implementation kickoff within 3 business days.',
      response:   () => 'Urgently schedule the kickoff and ensure all stakeholders are invited.',
      actionPlan: () => '1. Send a kickoff meeting invite to all key stakeholders\n2. Prepare an implementation timeline and agenda\n3. Confirm the customer\'s project lead and contact info\n4. Share any pre-work materials before the meeting',
    },
    stakeholder_gap: {
      situation:  (h) => h.evidence,
      target:     () => 'Identify and engage all required stakeholders within 7 days.',
      response:   () => 'Map the implementation stakeholders and fill gaps immediately.',
      actionPlan: () => '1. Create a stakeholder map for implementation\n2. Identify missing roles (IT, security, exec sponsor)\n3. Request introductions from the project lead\n4. Schedule a stakeholder alignment meeting',
    },
    handoff_incomplete: {
      situation:  (h) => h.evidence,
      target:     () => 'Complete the sales-to-CS handoff within 5 days.',
      response:   () => 'Document all critical context and ensure the CS team has everything they need.',
      actionPlan: () => '1. Write comprehensive deal notes covering key decisions and expectations\n2. Schedule a formal handoff meeting between sales and CS\n3. Share all relevant documents and email threads\n4. Introduce the CS team to customer contacts',
    },
    milestone_blocked: {
      situation:  (h) => h.evidence,
      target:     () => 'Unblock the milestone within 7 days.',
      response:   () => 'Identify the blocker and address it with the appropriate stakeholder.',
      actionPlan: () => '1. Contact the customer project lead to identify the block\n2. Determine if the issue is internal or customer-side\n3. Escalate to the appropriate team if needed\n4. Update the implementation timeline and communicate changes',
    },
    escalation_needed: {
      situation:  (h) => h.evidence,
      target:     () => 'Escalate and resolve within 5 business days.',
      response:   () => 'Involve executive sponsors on both sides to break through the impasse.',
      actionPlan: () => '1. Brief your executive sponsor on the situation\n2. Request an executive-to-executive call\n3. Prepare a clear problem statement and proposed resolution\n4. Follow up daily until resolved',
    },
    adoption_risk: {
      situation:  (h) => h.evidence,
      target:     () => 'Re-engage the customer and assess adoption within 10 days.',
      response:   () => 'Proactively check on adoption and offer support to drive usage.',
      actionPlan: () => '1. Reach out to the customer success contact\n2. Review any available usage or adoption metrics\n3. Offer a training session or office hours\n4. Schedule a check-in call to discuss the experience',
    },
  },
};

module.exports = StrapStrategyBuilder;
