/**
 * AgentObserver.js
 *
 * Intelligence layer that observes outputs from the existing AI pipeline
 * (action generation, email analysis, health scoring) and generates
 * agent proposals when it detects opportunities for CRM mutations.
 *
 * INTEGRATION POINTS (post-hooks):
 *   - actionsGenerator.js → onActionsGenerated(dealId, actions, context)
 *   - aiProcessor.js      → onEmailReceived(emailId, analysis, orgId, userId)
 *   - dealHealthService.js → onHealthScoreChanged(dealId, oldScore, newScore, orgId, userId)
 *
 * Each observer method is non-blocking and never throws — failures are
 * logged but don't crash the calling pipeline.
 */

const AgentProposalService = require('./AgentProposalService');
const StrapResolutionDetector = require('./StrapResolutionDetector');

class AgentObserver {

  /**
   * Called after actionsGenerator.js produces actions for a deal.
   * Examines the actions + deal context to propose CRM mutations.
   *
   * @param {number} dealId
   * @param {Array}  actions  - generated action objects
   * @param {object} context  - deal context from DealContextBuilder
   * @param {number} orgId
   * @param {number} userId   - deal owner
   */
  static async onActionsGenerated(dealId, actions, context, orgId, userId) {
    try {
      if (!dealId || !orgId || !userId) return;

      // Gate check once — skip if framework is off
      const gate = await AgentProposalService.isEnabled(orgId, userId);
      if (!gate.enabled) return;

      for (const action of (actions || [])) {
        await this._analyzeActionForProposals(action, dealId, context, orgId, userId);
      }

      // STRAP hook: check if generated actions resolve an active STRAP hurdle
      StrapResolutionDetector.checkFromEmail(dealId, orgId, userId)
        .catch(err => console.error('🎯 STRAP resolution check error:', err.message));

    } catch (err) {
      console.error('AgentObserver.onActionsGenerated error:', err.message);
    }
  }

  /**
   * Called after aiProcessor.processEmail() completes.
   * Looks for contact creation opportunities and follow-up drafts.
   *
   * @param {number} emailId
   * @param {object} analysis - { actions, contacts_mentioned, sentiment, summary, ... }
   * @param {number} orgId
   * @param {number} userId
   * @param {number} [dealId]
   */
  static async onEmailReceived(emailId, analysis, orgId, userId, dealId = null) {
    try {
      if (!orgId || !userId) return;

      const gate = await AgentProposalService.isEnabled(orgId, userId);
      if (!gate.enabled) return;

      // 1. Propose contact creation for new people mentioned in emails
      if (analysis?.contacts_mentioned?.length) {
        for (const contact of analysis.contacts_mentioned) {
          if (contact.email && contact.name) {
            const nameParts = contact.name.split(' ');
            await AgentProposalService.createProposal({
              orgId, userId, proposalType: 'create_contact',
              payload: {
                first_name:      nameParts[0] || contact.name,
                last_name:       nameParts.slice(1).join(' ') || '',
                email:           contact.email,
                title:           contact.title || null,
                role_type:       contact.role_type || null,
                account_id:      null,
                source_evidence: `Mentioned in email #${emailId}`,
              },
              reasoning: `New contact "${contact.name}" (${contact.email}) discovered in email analysis. They appear to be involved in the deal conversation.`,
              confidence: contact.confidence || 0.65,
              source: 'ai_processor',
              sourceContext: { email_id: emailId, trigger: 'email_contact_discovery' },
              dealId,
            });
          }
        }
      }

      // 2. Propose follow-up email draft if analysis suggests urgency
      if (analysis?.urgency === 'high' && analysis?.suggested_reply) {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'draft_email',
          payload: {
            deal_id:    dealId,
            subject:    analysis.suggested_reply.subject || 'Follow-up',
            body:       analysis.suggested_reply.body || '',
            to_address: analysis.from_address || null,
          },
          reasoning: `Email analysis detected high urgency. A prompt follow-up is recommended to maintain momentum.`,
          confidence: 0.70,
          source: 'ai_processor',
          sourceContext: { email_id: emailId, trigger: 'urgent_reply_needed', sentiment: analysis.sentiment },
          dealId,
        });
      }

      // STRAP hook: email may resolve an active STRAP hurdle (momentum, close_date, competitive)
      if (dealId) {
        StrapResolutionDetector.checkFromEmail(dealId, orgId, userId)
          .catch(err => console.error('🎯 STRAP email resolution check error:', err.message));
      }

    } catch (err) {
      console.error('AgentObserver.onEmailReceived error:', err.message);
    }
  }

  /**
   * Called when a deal's health score changes significantly.
   * Proposes risk flags and stage changes when warranted.
   *
   * @param {number} dealId
   * @param {number|string} oldScore
   * @param {number|string} newScore
   * @param {object} params   - { health_params, orgId, userId }
   */
  static async onHealthScoreChanged(dealId, oldScore, newScore, params = {}) {
    try {
      const { orgId, userId } = params;
      if (!orgId || !userId || !dealId) return;

      const gate = await AgentProposalService.isEnabled(orgId, userId);
      if (!gate.enabled) return;

      const oldNum = parseFloat(oldScore) || 0;
      const newNum = parseFloat(newScore) || 0;

      // Significant decline — flag risk
      if (oldNum > 0 && newNum < oldNum && (oldNum - newNum) >= 15) {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'flag_risk',
          payload: {
            deal_id:    dealId,
            signal_key: 'health_decline',
            reason:     `Deal health dropped significantly from ${oldNum} to ${newNum}. Review recommended.`,
          },
          reasoning: `Health score declined by ${oldNum - newNum} points (${oldNum} → ${newNum}). This level of decline typically indicates a deal at risk and warrants immediate attention.`,
          confidence: Math.min(0.95, 0.6 + ((oldNum - newNum) / 100)),
          source: 'rules_engine',
          sourceContext: {
            trigger: 'health_score_decline',
            old_score: oldNum,
            new_score: newNum,
            health_params: params.health_params || null,
          },
          dealId,
        });
      }

      // Health recovered above threshold — propose stage advance
      if (newNum >= 75 && oldNum < 75) {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'update_deal_stage',
          payload: {
            deal_id:        dealId,
            current_stage:  params.current_stage || null,
            proposed_stage: params.next_stage || null,
            reason:         `Deal health recovered to ${newNum}. Consider advancing the deal stage.`,
          },
          reasoning: `Deal health crossed the 75-point threshold (${oldNum} → ${newNum}), suggesting the deal is progressing well. A stage advancement may be warranted.`,
          confidence: 0.55,
          source: 'rules_engine',
          sourceContext: { trigger: 'health_recovery', old_score: oldNum, new_score: newNum },
          dealId,
        });
      }

      // STRAP hook: health score change may resolve active STRAP
      StrapResolutionDetector.checkFromHealthChange(dealId, orgId, userId, oldNum, newNum)
        .catch(err => console.error('🎯 STRAP health resolution check error:', err.message));

    } catch (err) {
      console.error('AgentObserver.onHealthScoreChanged error:', err.message);
    }
  }

  // ── Private analysis ───────────────────────────────────────────────────────

  /**
   * Analyze a single generated action for proposal opportunities.
   */
  static async _analyzeActionForProposals(action, dealId, context, orgId, userId) {
    try {
      const type    = (action.type || '').toLowerCase();
      const rule    = (action.source_rule || action.sourceRule || '').toLowerCase();
      const health  = (action.health_param || action.healthParam || '').toLowerCase();

      // Rule: unanswered email → propose draft follow-up
      if (rule === 'unanswered_email' || type === 'unanswered_email') {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'draft_email',
          payload: {
            deal_id: dealId,
            subject: `Re: Follow-up${context?.deal?.name ? ' — ' + context.deal.name : ''}`,
            body:    '',  // Will be generated by AI when user opens the proposal
            contact_id: action.contact_id || null,
          },
          reasoning: action.description || 'Email has gone unanswered — a follow-up is recommended to re-engage the prospect.',
          confidence: 0.70,
          source: 'rules_engine',
          sourceContext: { trigger: 'unanswered_email', source_rule: rule, action_type: type },
          dealId,
          actionId: action.id || null,
        });
      }

      // Rule: high value deal with no meetings → propose meeting
      if (rule === 'high_value_no_meeting') {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'schedule_meeting',
          payload: {
            deal_id:      dealId,
            title:        `Discovery Call — ${context?.deal?.name || 'Deal'}`,
            description:  'High-value deal needs a meeting to progress.',
            meeting_type: 'virtual',
          },
          reasoning: action.description || 'High-value deal has no meetings scheduled. A discovery or demo call would help advance the deal.',
          confidence: 0.65,
          source: 'rules_engine',
          sourceContext: { trigger: 'high_value_no_meeting', deal_value: context?.deal?.value },
          dealId,
          actionId: action.id || null,
        });
      }

      // Rule: decision maker with no contact → propose contact creation
      if (rule === 'decision_maker_no_contact') {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'create_contact',
          payload: {
            first_name:      '',
            last_name:       '',
            email:           '',
            role_type:       'decision_maker',
            account_id:      context?.deal?.account_id || null,
            source_evidence: 'Identified missing decision maker contact from deal analysis.',
          },
          reasoning: 'No decision maker contact is linked to this deal. Adding one is critical for progressing through later stages.',
          confidence: 0.60,
          source: 'rules_engine',
          sourceContext: { trigger: 'decision_maker_missing' },
          dealId,
          actionId: action.id || null,
        });
      }

      // Rule: stagnant deal → propose risk flag
      if (rule === 'stagnant_deal') {
        await AgentProposalService.createProposal({
          orgId, userId, proposalType: 'flag_risk',
          payload: {
            deal_id:    dealId,
            signal_key: 'stagnant_deal',
            reason:     action.description || 'Deal has not progressed — may be at risk.',
          },
          reasoning: 'Deal has been in the same stage for an extended period with no recent activity. This is a common indicator of a deal at risk.',
          confidence: 0.75,
          source: 'rules_engine',
          sourceContext: { trigger: 'stagnant_deal' },
          dealId,
          actionId: action.id || null,
        });
      }

    } catch (err) {
      console.error('AgentObserver._analyzeActionForProposals error:', err.message);
    }
  }
}

module.exports = AgentObserver;
