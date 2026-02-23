/**
 * ActionsRulesEngine.js
 *
 * Pure rules-based action generation. Zero AI cost.
 *
 * STAGE STRATEGY (Option B — Playbook-Driven):
 *   Stage-specific rules have been removed from this engine.
 *   All stage-specific intelligence now flows through:
 *     1. context.playbookStageActions  — key_actions from the org's playbook
 *                                        for the deal's current stage KEY
 *     2. context.playbookStageGuidance — full guidance object (goal, timeline,
 *                                        requires_proposal_doc, etc.)
 *     3. ActionsAIEnhancer             — uses stage_type as semantic context
 *
 *   This means orgs can name their stages anything they want. The rules engine
 *   operates on deal health, contacts, meetings, emails, and files — none of
 *   which depend on stage names.
 *
 *   The only stage-aware logic retained here is:
 *     - _fileRules: reads playbookStageGuidance.requires_proposal_doc (data-driven)
 *     - _fileRules: reads playbookStageGuidance.active_stage (data-driven)
 *     - Stagnant / imminent close / past close — timing rules, not stage-name rules
 *
 * Each action carries both:
 *   action_type — the GOAL (meeting_schedule, document_prep, etc.)
 *   next_step   — the IMMEDIATE ACTION to take right now
 *                 one of: email | call | whatsapp | linkedin | slack | document | internal_task
 */

const PlaybookService = require('./playbook.service');

// ── next_step per source_rule ─────────────────────────────────────────────────
const RULE_NEXT_STEP = {
  // Health params
  health_1a_unknown:        'email',
  health_1b_slipped:        'call',
  health_1c_unknown:        'email',
  health_2a_no_buyer:       'email',
  health_2b_no_exec:        'email',
  health_2c_single_thread:  'internal_task',
  health_3a_legal:          'email',
  health_3b_security:       'email',
  health_4c_scope:          'email',
  health_4a_oversized:      'internal_task',
  health_5a_competitive:    'document',
  health_5b_price:          'document',
  health_5c_discount:       'slack',
  health_6a_no_meeting:     'email',
  health_6b_slow_response:  'call',

  // Deal timing rules (stage-name-agnostic)
  stagnant_deal:            'email',
  close_imminent:           'internal_task',
  past_close_date:          'internal_task',
  high_value_no_meeting:    'email',

  // Contact rules
  no_contacts:              'internal_task',
  decision_maker_no_contact:'email',
  champion_nurture:         'email',

  // Meeting rules
  meeting_prep:             'internal_task',
  meeting_followup:         'email',

  // Email rules
  unanswered_email:         'call',

  // File rules
  no_files:                 'internal_task',
  failed_file:              'internal_task',
  no_proposal_doc:          'document',

  // Playbook-driven (AI Enhancer can override per-deal)
  playbook:                 'email',
};

class ActionsRulesEngine {

  static generate(context) {
    const actions = [];
    this._healthParamRules(context, actions);
    this._dealTimingRules(context, actions);
    this._contactRules(context, actions);
    this._meetingRules(context, actions);
    this._emailRules(context, actions);
    this._fileRules(context, actions);
    this._playbookRules(context, actions);
    return this._deduplicate(actions);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // A. HEALTH SCORE PARAMETER RULES
  // Unchanged — all health rules are parameter-driven, not stage-name-driven.
  // ─────────────────────────────────────────────────────────────────────────

  static _healthParamRules(ctx, actions) {
    const { deal, healthBreakdown, derived } = ctx;
    if (!healthBreakdown?.params) return;
    const params   = healthBreakdown.params;
    const dealName = deal.name || 'Deal';

    if (params['1a']?.state === 'unknown') {
      actions.push(this._action({
        title:            `Get buyer to confirm close date for ${dealName}`,
        description:      `Close date credibility is unconfirmed — no buyer signal yet.`,
        action_type:      'email_send',
        priority:         'high',
        due_days:         1,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Ask: "Are you still on track to make a decision by [close date]? Is there a specific internal event driving that timeline?"',
        health_param:     '1a',
        source_rule:      'health_1a_unknown',
      }));
    }

    if (params['1b']?.state === 'confirmed') {
      const pushCount = params['1b']?.pushCount || 1;
      actions.push(this._action({
        title:            `Address repeated close date slippage on ${dealName}`,
        description:      `Close date has slipped ${pushCount} time${pushCount !== 1 ? 's' : ''}. Understand root cause and lock in a new credible date.`,
        action_type:      'meeting_schedule',
        priority:         'high',
        due_days:         1,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Call them directly. Ask: "What changed? What would need to be true for you to move forward by [new date]?"',
        health_param:     '1b',
        source_rule:      'health_1b_slipped',
      }));
    }

    if (params['1c']?.state === 'unknown') {
      actions.push(this._action({
        title:            `Identify urgency driver for ${dealName}`,
        description:      `No buyer event linked to close date. Find what's creating urgency on their side.`,
        action_type:      'email_send',
        priority:         'medium',
        due_days:         2,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Ask: "Is there a budget cycle, board meeting, or contract renewal that makes your [date] timeline important?"',
        health_param:     '1c',
        source_rule:      'health_1c_unknown',
      }));
    }

    if (params['2a']?.state === 'unknown' || params['2a']?.state === 'absent') {
      actions.push(this._action({
        title:            `Identify economic buyer for ${dealName}`,
        description:      `No economic buyer or decision maker tagged on this deal. Without them, close risk is high.`,
        action_type:      'task_complete',
        priority:         'high',
        due_days:         2,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Ask your champion: "Who has final sign-off authority for a purchase of this size?"',
        health_param:     '2a',
        source_rule:      'health_2a_no_buyer',
      }));
    }

    if (params['2b']?.state === 'absent' && derived.decisionMakers.length === 0) {
      actions.push(this._action({
        title:            `Get executive meeting scheduled for ${dealName}`,
        description:      `No exec-level meeting has been held. Deals without exec engagement close at significantly lower rates.`,
        action_type:      'meeting_schedule',
        priority:         'high',
        due_days:         3,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Email champion: "Would it be possible to include [Exec Name] in our next call for a 15-minute executive briefing?"',
        health_param:     '2b',
        source_rule:      'health_2b_no_exec',
      }));
    }

    if (params['2c']?.state === 'absent') {
      const count = params['2c']?.count || 0;
      actions.push(this._action({
        title:            `Expand stakeholder coverage on ${dealName}`,
        description:      `Only ${count} stakeholder${count !== 1 ? 's' : ''} with meaningful roles. Single-threaded deals are high risk.`,
        action_type:      'task_complete',
        priority:         'medium',
        due_days:         5,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Map the buying committee with your champion. Identify who else needs to be involved: legal, IT, finance, end users.',
        health_param:     '2c',
        source_rule:      'health_2c_single_thread',
      }));
    }

    if (params['3a']?.state === 'unknown') {
      actions.push(this._action({
        title:            `Engage legal/procurement for ${dealName}`,
        description:      `Legal and procurement review not yet confirmed.`,
        action_type:      'email_send',
        priority:         'medium',
        due_days:         3,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Ask: "Has your procurement/legal team been looped in yet? What do they need from us?"',
        health_param:     '3a',
        source_rule:      'health_3a_legal',
      }));
    }

    if (params['3b']?.state === 'unknown') {
      actions.push(this._action({
        title:            `Initiate security/IT review for ${dealName}`,
        description:      `Security/IT review not yet confirmed. Proactively offering security documentation can accelerate this.`,
        action_type:      'email_send',
        priority:         'medium',
        due_days:         3,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Share your security pack/SOC2 report proactively. Ask: "Would it help if I sent our security documentation to your IT team directly?"',
        health_param:     '3b',
        source_rule:      'health_3b_security',
      }));
    }

    if (params['4c']?.state === 'unknown') {
      actions.push(this._action({
        title:            `Get explicit scope sign-off for ${dealName}`,
        description:      `Scope has not been explicitly approved by the buyer.`,
        action_type:      'email_send',
        priority:         'medium',
        due_days:         3,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Send a scope summary email: "Does this accurately reflect what we discussed? Any changes before we move to contracts?"',
        health_param:     '4c',
        source_rule:      'health_4c_scope',
      }));
    }

    if (params['4a']?.state === 'confirmed') {
      actions.push(this._action({
        title:            `Validate deal size realism for ${dealName}`,
        description:      `Deal value is ${params['4a'].ratio}× the segment average. Confirm scope justifies this size.`,
        action_type:      'task_complete',
        priority:         'medium',
        due_days:         5,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Review the deal with your manager. Confirm scope, user count, and pricing are clearly documented.',
        health_param:     '4a',
        source_rule:      'health_4a_oversized',
      }));
    }

    if (params['5a']?.state === 'confirmed') {
      const compNames = (params['5a']?.competitors || []).map(c => c.name).join(', ');
      actions.push(this._action({
        title:            `Develop competitive counter-strategy for ${dealName}`,
        description:      `Competitive deal confirmed${compNames ? ` — competing against: ${compNames}` : ''}.`,
        action_type:      'document_prep',
        priority:         'high',
        due_days:         2,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: `Prepare a competitive battlecard vs ${compNames || 'competitor'}. Share win stories from similar accounts.`,
        health_param:     '5a',
        source_rule:      'health_5a_competitive',
      }));
    }

    if (params['5b']?.state === 'confirmed') {
      actions.push(this._action({
        title:            `Address price sensitivity on ${dealName}`,
        description:      `Price sensitivity flagged. Build ROI case before it becomes a blocker.`,
        action_type:      'document_prep',
        priority:         'high',
        due_days:         2,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Prepare a tailored ROI/business case. Quantify time savings, risk reduction, or revenue impact.',
        health_param:     '5b',
        source_rule:      'health_5b_price',
      }));
    }

    if (params['5c']?.state === 'confirmed') {
      actions.push(this._action({
        title:            `Resolve discount approval for ${dealName}`,
        description:      `Discount approval pending. Unresolved pricing exceptions stall deals.`,
        action_type:      'task_complete',
        priority:         'high',
        due_days:         1,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Message your manager on Slack to escalate discount approval. Set a deadline and communicate timeline to buyer.',
        health_param:     '5c',
        source_rule:      'health_5c_discount',
      }));
    }

    if (params['6a']?.state === 'confirmed') {
      const days = params['6a']?.daysSinceLastMeeting;
      actions.push(this._action({
        title:            `Re-establish meeting cadence for ${dealName}`,
        description:      `No meeting in ${days ?? 'many'} days — deal momentum is stalling.`,
        action_type:      'meeting_schedule',
        priority:         'high',
        due_days:         1,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Send 2-3 specific time slots: "I want to make sure we keep momentum — can we find 30 minutes this week?"',
        health_param:     '6a',
        source_rule:      'health_6a_no_meeting',
      }));
    }

    if (params['6b']?.state === 'confirmed') {
      const avgH = params['6b']?.avgHours;
      actions.push(this._action({
        title:            `Re-engage unresponsive contact on ${dealName}`,
        description:      `Average email response time is ${avgH}h — significantly above normal.`,
        action_type:      'email_send',
        priority:         'medium',
        due_days:         1,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Switch channel — call them directly. Short message: "Quick question — are you still the right person to move this forward?"',
        health_param:     '6b',
        source_rule:      'health_6b_slow_response',
      }));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // B. DEAL TIMING RULES
  //
  // Renamed from _dealStageRules. These rules fire on timing signals
  // (stagnant, imminent close, past close, high value) — none depend on
  // stage names. Stage-specific actions (schedule discovery call, send
  // proposal follow-up, etc.) are now entirely handled by _playbookRules.
  // ─────────────────────────────────────────────────────────────────────────

  static _dealTimingRules(ctx, actions) {
    const { deal, derived } = ctx;
    const { name: dealName, id: dealId, account_id } = deal;

    if (derived.isStagnant) {
      actions.push(this._action({
        title:            `Re-engage stagnant deal: ${dealName}`,
        description:      `No stage progression in ${derived.daysInStage} days.`,
        action_type:      'follow_up',
        priority:         'high',
        due_days:         0,
        deal_id:          dealId,
        account_id,
        suggested_action: 'Send a re-engagement email. Reference something relevant (new feature, industry news, their recent announcement) to make it timely.',
        source_rule:      'stagnant_deal',
      }));
    }

    if (derived.closingImminently) {
      actions.push(this._action({
        title:            `${dealName} closes in ${derived.daysUntilClose} day${derived.daysUntilClose !== 1 ? 's' : ''} — final checklist`,
        description:      `Close date is imminent. Verify all steps are complete.`,
        action_type:      'task_complete',
        priority:         'high',
        due_days:         0,
        deal_id:          dealId,
        account_id,
        suggested_action: 'Confirm: contract ready, decision makers aligned, procurement informed, implementation date agreed, success criteria documented.',
        source_rule:      'close_imminent',
      }));
    }

    if (derived.isPastClose) {
      const overdue = Math.abs(derived.daysUntilClose);
      actions.push(this._action({
        title:            `${dealName} is ${overdue} day${overdue !== 1 ? 's' : ''} past close date`,
        description:      `Deal has missed its close date. Update the forecast or drive to close immediately.`,
        action_type:      'task_complete',
        priority:         'high',
        due_days:         0,
        deal_id:          dealId,
        account_id,
        suggested_action: 'Call the decision maker today. Either get a firm new close date with written commitment, or update the CRM to reflect the new reality.',
        source_rule:      'past_close_date',
      }));
    }

    if (derived.isHighValue && derived.completedMeetings.length === 0) {
      const meetingDisplay = derived.daysSinceLastMeeting >= 999
        ? 'no meetings on record'
        : `${derived.daysSinceLastMeeting} days since last meeting`;
      actions.push(this._action({
        title:            `High-value deal ${dealName} needs executive touchpoint`,
        description:      `$${parseFloat(deal.value || 0).toLocaleString()} deal with ${meetingDisplay}.`,
        action_type:      'meeting_schedule',
        priority:         'high',
        due_days:         2,
        deal_id:          dealId,
        account_id,
        suggested_action: 'Email to schedule an executive briefing. For deals of this size, regular exec-to-exec contact is critical.',
        source_rule:      'high_value_no_meeting',
      }));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // C. CONTACT ENGAGEMENT RULES — unchanged
  // ─────────────────────────────────────────────────────────────────────────

  static _contactRules(ctx, actions) {
    const { deal, contacts, emails, derived } = ctx;

    if (contacts.length === 0) {
      actions.push(this._action({
        title:            `Add contacts to deal: ${deal.name}`,
        description:      `This deal has no contacts. Actions and health scoring will be severely limited.`,
        action_type:      'task_complete',
        priority:         'high',
        due_days:         0,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Add at least one contact with a role (Champion, Decision Maker, or Influencer) to this deal.',
        source_rule:      'no_contacts',
      }));
      return;
    }

    derived.decisionMakers.forEach(contact => {
      const contactEmails = emails.filter(e => e.contact_id === contact.id);
      const daysSince = contactEmails.length > 0
        ? Math.floor((Date.now() - new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at))))) / 86400000)
        : 999;
      if (daysSince > 14) {
        actions.push(this._action({
          title:            `Touch base with ${contact.first_name} ${contact.last_name} (Decision Maker)`,
          description:      `Key decision maker — no contact in ${daysSince >= 999 ? 'over 30' : daysSince} days.`,
          action_type:      'email_send',
          priority:         'high',
          due_days:         1,
          deal_id:          deal.id,
          contact_id:       contact.id,
          account_id:       deal.account_id,
          suggested_action: 'Send a personalised update. Reference their stated priorities and show how the deal addresses them.',
          source_rule:      'decision_maker_no_contact',
        }));
      }
    });

    derived.champions.forEach(contact => {
      const contactEmails = emails.filter(e => e.contact_id === contact.id);
      const daysSince = contactEmails.length > 0
        ? Math.floor((Date.now() - new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at))))) / 86400000)
        : 999;
      if (daysSince > 7) {
        actions.push(this._action({
          title:            `Nurture champion ${contact.first_name} ${contact.last_name}`,
          description:      `Internal champion — keep them informed and equipped to advocate internally.`,
          action_type:      'email_send',
          priority:         'medium',
          due_days:         2,
          deal_id:          deal.id,
          contact_id:       contact.id,
          account_id:       deal.account_id,
          suggested_action: 'Share ROI data, reference stories, or talk tracks to help them justify the decision internally.',
          source_rule:      'champion_nurture',
        }));
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // D. MEETING RULES — unchanged
  // ─────────────────────────────────────────────────────────────────────────

  static _meetingRules(ctx, actions) {
    const { deal, emails, derived } = ctx;

    derived.upcomingMeetings.forEach(meeting => {
      const daysUntil = Math.ceil((new Date(meeting.start_time) - Date.now()) / 86400000);
      if (daysUntil <= 1) {
        actions.push(this._action({
          title:            `Prepare for: ${meeting.title || 'Upcoming meeting'}`,
          description:      `Meeting in ${daysUntil <= 0 ? 'less than a day' : 'tomorrow'} — prepare agenda and review deal history.`,
          action_type:      'task_complete',
          priority:         'high',
          due_days:         0,
          deal_id:          deal.id,
          account_id:       deal.account_id,
          suggested_action: 'Review last email thread, prepare 3 agenda items, confirm attendees, and know your ask/next step before entering the call.',
          source_rule:      'meeting_prep',
        }));
      }
    });

    derived.completedMeetings
      .filter(meeting => {
        const daysSince = Math.floor((Date.now() - new Date(meeting.start_time)) / 86400000);
        const hasFollowUp = emails.some(e =>
          e.direction === 'sent' && new Date(e.sent_at) > new Date(meeting.start_time)
        );
        return daysSince <= 2 && !hasFollowUp;
      })
      .forEach(meeting => {
        actions.push(this._action({
          title:            `Send follow-up for: ${meeting.title || 'Recent meeting'}`,
          description:      `Meeting completed recently — send recap with next steps.`,
          action_type:      'email_send',
          priority:         'high',
          due_days:         0,
          deal_id:          deal.id,
          account_id:       deal.account_id,
          suggested_action: 'Email recap: key decisions made, open items with owners, agreed next steps and dates.',
          source_rule:      'meeting_followup',
        }));
      });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // E. EMAIL RULES — unchanged
  // ─────────────────────────────────────────────────────────────────────────

  static _emailRules(ctx, actions) {
    const { deal, derived } = ctx;

    derived.unansweredEmails.slice(0, 2).forEach(email => {
      const daysSince = Math.floor((Date.now() - new Date(email.sent_at)) / 86400000);
      const switchToCall = daysSince > 7;
      actions.push(this._action({
        title:            `Follow up on unanswered email: "${(email.subject || '').substring(0, 50)}"`,
        description:      `Email sent ${daysSince} days ago with no reply.`,
        action_type:      'follow_up',
        priority:         switchToCall ? 'high' : 'medium',
        due_days:         0,
        deal_id:          deal.id,
        contact_id:       email.contact_id || null,
        account_id:       deal.account_id,
        suggested_action: switchToCall
          ? 'Email has been ignored — switch to a phone call. Keep it short: "Just following up on my email from last week — still relevant for you?"'
          : 'Send one more short follow-up email: "Just following up — still relevant for you?"',
        source_rule:      'unanswered_email',
        _next_step_override: switchToCall ? 'call' : 'email',
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // F. FILE RULES
  //
  // Previously hardcoded stage name lists. Now reads from playbookStageGuidance:
  //   - requires_proposal_doc: boolean — whether this stage needs a proposal doc
  //   - is_active_stage:       boolean — whether to prompt for file uploads
  //
  // Falls back to safe defaults if guidance is not available.
  // ─────────────────────────────────────────────────────────────────────────

  static _fileRules(ctx, actions) {
    const { deal, files, derived, playbookStageGuidance } = ctx;

    // Determine file-related flags from playbook guidance (data-driven)
    // is_terminal stages (closed_won, closed_lost) have no guidance — skip
    const requiresProposalDoc = playbookStageGuidance?.requires_proposal_doc ?? false;
    const isActiveStage       = !['closed_won', 'closed_lost'].includes(deal.stage_type);

    if (files.length === 0 && isActiveStage) {
      actions.push(this._action({
        title:            `Upload relevant documents for ${deal.name}`,
        description:      `No files uploaded for this deal. Proposals, contracts, and meeting notes help AI generate better actions.`,
        action_type:      'document_prep',
        priority:         'medium',
        due_days:         3,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: 'Upload the proposal, any email attachments, or meeting transcripts to enable AI-assisted analysis.',
        source_rule:      'no_files',
      }));
    }

    derived.failedFiles.forEach(file => {
      actions.push(this._action({
        title:            `Retry failed file import: ${file.file_name}`,
        description:      `File "${file.file_name}" failed to process. It may contain signals affecting deal health.`,
        action_type:      'task_complete',
        priority:         'low',
        due_days:         5,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        suggested_action: `Re-import "${file.file_name}" from the Files view. If it keeps failing, check the file format.`,
        source_rule:      'failed_file',
      }));
    });

    if (requiresProposalDoc) {
      const hasProposal = files.some(f =>
        f.category === 'document' &&
        /proposal|quote|pricing|sow|contract/i.test(f.file_name)
      );
      if (!hasProposal) {
        actions.push(this._action({
          title:            `Prepare proposal document for ${deal.name}`,
          description:      `This stage requires a proposal document but none has been uploaded.`,
          action_type:      'document_prep',
          priority:         'high',
          due_days:         2,
          deal_id:          deal.id,
          account_id:       deal.account_id,
          suggested_action: 'Create and upload a tailored proposal: scope, pricing, timeline, ROI summary, and implementation plan.',
          source_rule:      'no_proposal_doc',
        }));
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // G. PLAYBOOK RULES
  //
  // Converts the key_actions array from the stage's playbook guidance into
  // individual actions. This is where stage-specific intelligence now lives.
  // The playbookStageActions array is populated in actionsGenerator.buildContext()
  // by calling PlaybookService.getStageActions(userId, deal.stage) — keyed by
  // stage KEY (e.g. "demo"), not stage_type.
  // ─────────────────────────────────────────────────────────────────────────

  static _playbookRules(ctx, actions) {
    const { deal, playbookStageActions, playbookStageGuidance } = ctx;
    if (!playbookStageActions?.length) return;

    playbookStageActions.forEach(actionText => {
      const actionType = PlaybookService.classifyActionType(actionText);
      const priority   = PlaybookService.suggestPriority(deal.stage_type || deal.stage, actionType);
      const dueDays    = PlaybookService.suggestDueDays(deal.stage_type || deal.stage, actionType);
      const keywords   = PlaybookService.extractKeywords(actionText);

      actions.push(this._action({
        title:            actionText,
        description:      playbookStageGuidance?.goal
                            ? `Playbook action — stage goal: ${playbookStageGuidance.goal}`
                            : `Playbook action for ${deal.stage_type || deal.stage} stage`,
        action_type:      actionType,
        priority,
        due_days:         dueDays,
        deal_id:          deal.id,
        account_id:       deal.account_id,
        keywords,
        requires_external_evidence: PlaybookService.requiresExternalEvidence(actionType, actionText),
        deal_stage:       deal.stage_type || deal.stage,
        source_rule:      'playbook',
        source:           'playbook',
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers — unchanged
  // ─────────────────────────────────────────────────────────────────────────

  static _action({
    title, description, action_type, priority, due_days,
    deal_id = null, contact_id = null, account_id = null,
    suggested_action = null, health_param = null,
    keywords = null, requires_external_evidence = false,
    deal_stage = null, source_rule = 'rules', source = 'auto_generated',
    _next_step_override = null,
  }) {
    const due_date = new Date();
    due_date.setDate(due_date.getDate() + (due_days || 0));

    const next_step = _next_step_override
      || RULE_NEXT_STEP[source_rule]
      || this._inferNextStep(action_type);

    return {
      title,
      description,
      action_type,
      type: action_type,
      next_step,
      priority,
      due_date,
      deal_id,
      contact_id,
      account_id,
      suggested_action,
      health_param,
      keywords,
      requires_external_evidence,
      deal_stage,
      source,
      source_rule,
    };
  }

  static _inferNextStep(action_type) {
    switch (action_type) {
      case 'email_send':
      case 'email':
      case 'follow_up':
      case 'meeting_schedule': return 'email';
      case 'document_prep':
      case 'document':         return 'document';
      case 'task_complete':
      case 'review':
      case 'meeting_prep':     return 'internal_task';
      default:                 return 'email';
    }
  }

  static _deduplicate(actions) {
    const seen = new Set();
    return actions.filter(a => {
      const key = a.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = ActionsRulesEngine;
