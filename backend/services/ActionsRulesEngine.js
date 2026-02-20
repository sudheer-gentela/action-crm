/**
 * ActionsRulesEngine.js
 *
 * Pure rules-based action generation. Zero AI cost.
 * Replaces ActionsEngine.js with full coverage of all 8 inputs:
 *   - Deal (stage, value, close date, health score breakdown)
 *   - Account
 *   - Contacts (by role)
 *   - Meetings
 *   - Emails
 *   - Files / storage_files
 *   - Playbook (stage key_actions)
 *   - Deal Health Score (per-parameter breakdown → targeted actions)
 *
 * Receives a `context` object from DealContextBuilder.
 * Returns an array of action objects ready for DB insert.
 *
 * Rule groups:
 *   A. Health Score Parameter Rules  — targeted actions from breakdown params
 *   B. Deal Stage + Timing Rules     — stage-appropriate next steps
 *   C. Contact Engagement Rules      — role-based outreach
 *   D. Meeting Rules                 — prep, follow-up, cadence
 *   E. Email Rules                   — unanswered, unread, follow-up
 *   F. File Rules                    — missing docs, failed imports
 *   G. Playbook Rules                — stage key_actions not yet actioned
 */

const PlaybookService = require('./playbook.service');

class ActionsRulesEngine {

  /**
   * Generate all rule-based actions for a deal context.
   * @param {object} context — from DealContextBuilder.build()
   * @returns {Array<ActionCandidate>}
   */
  static generate(context) {
    const actions = [];

    this._healthParamRules(context, actions);
    this._dealStageRules(context, actions);
    this._contactRules(context, actions);
    this._meetingRules(context, actions);
    this._emailRules(context, actions);
    this._fileRules(context, actions);
    this._playbookRules(context, actions);

    // Deduplicate by title within this batch (same deal, same run)
    return this._deduplicate(actions);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // A. HEALTH SCORE PARAMETER RULES
  //    For each health param that is 'unknown' or a confirmed negative,
  //    emit a targeted action. This is what makes actions deal-specific.
  // ─────────────────────────────────────────────────────────────────────────

  static _healthParamRules(ctx, actions) {
    const { deal, healthBreakdown, healthStatus, derived } = ctx;
    if (!healthBreakdown || !healthBreakdown.params) return;

    const params = healthBreakdown.params;
    const dealName = deal.name || 'Deal';

    // ── Category 1: Close Date Credibility ──────────────────

    // 1a unknown → get buyer to confirm close date
    if (params['1a']?.state === 'unknown') {
      actions.push(this._action({
        title:           `Get buyer to confirm close date for ${dealName}`,
        description:     `Close date credibility is unconfirmed — no buyer signal yet. Ask directly in your next call or email.`,
        action_type:     'email_send',
        priority:        'high',
        due_days:        1,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Ask: "Are you still on track to make a decision by [close date]? Is there a specific internal event driving that timeline?"',
        health_param:    '1a',
        source_rule:     'health_1a_unknown',
      }));
    }

    // 1b confirmed → close date has slipped, discuss new timeline
    if (params['1b']?.state === 'confirmed') {
      const pushCount = params['1b']?.pushCount || 1;
      actions.push(this._action({
        title:           `Address repeated close date slippage on ${dealName}`,
        description:     `Close date has slipped ${pushCount} time${pushCount !== 1 ? 's' : ''}. Understand root cause and lock in a new credible date.`,
        action_type:     'meeting_schedule',
        priority:        'high',
        due_days:        1,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Schedule a candid check-in. Ask: "What changed? What would need to be true for you to move forward by [new date]?"',
        health_param:    '1b',
        source_rule:     'health_1b_slipped',
      }));
    }

    // 1c unknown → find out if there is a buyer event driving urgency
    if (params['1c']?.state === 'unknown') {
      actions.push(this._action({
        title:           `Identify urgency driver for ${dealName}`,
        description:     `No buyer event linked to close date. Find what's creating urgency on their side.`,
        action_type:     'email_send',
        priority:        'medium',
        due_days:        2,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Ask: "Is there a budget cycle, board meeting, or contract renewal that makes your [date] timeline important?"',
        health_param:    '1c',
        source_rule:     'health_1c_unknown',
      }));
    }

    // ── Category 2: Buyer Engagement & Power ─────────────────

    // 2a unknown → no economic buyer identified
    if (params['2a']?.state === 'unknown' || params['2a']?.state === 'absent') {
      actions.push(this._action({
        title:           `Identify economic buyer for ${dealName}`,
        description:     `No economic buyer or decision maker tagged on this deal. Without them, close risk is high.`,
        action_type:     'task_complete',
        priority:        'high',
        due_days:        2,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Ask your champion: "Who has final sign-off authority for a purchase of this size? Have you worked with them before on similar decisions?"',
        health_param:    '2a',
        source_rule:     'health_2a_no_buyer',
      }));
    }

    // 2b absent → exec meeting not held
    if (params['2b']?.state === 'absent' && derived.decisionMakers.length === 0) {
      actions.push(this._action({
        title:           `Get executive meeting scheduled for ${dealName}`,
        description:     `No exec-level meeting has been held. Deals without exec engagement close at significantly lower rates.`,
        action_type:     'meeting_schedule',
        priority:        'high',
        due_days:        3,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Ask champion to facilitate an intro: "Would it be possible to include [Exec Name] in our next call for a 15-minute executive briefing?"',
        health_param:    '2b',
        source_rule:     'health_2b_no_exec',
      }));
    }

    // 2c absent → not multi-threaded
    if (params['2c']?.state === 'absent') {
      const count = params['2c']?.count || 0;
      actions.push(this._action({
        title:           `Expand stakeholder coverage on ${dealName}`,
        description:     `Only ${count} stakeholder${count !== 1 ? 's' : ''} with meaningful roles. Single-threaded deals are high risk.`,
        action_type:     'task_complete',
        priority:        'medium',
        due_days:        5,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Map the buying committee with your champion. Identify who else needs to be involved: legal, IT, finance, end users.',
        health_param:    '2c',
        source_rule:     'health_2c_single_thread',
      }));
    }

    // ── Category 3: Process Completion ───────────────────────

    // 3a unknown → legal/procurement not engaged
    if (params['3a']?.state === 'unknown') {
      actions.push(this._action({
        title:           `Engage legal/procurement for ${dealName}`,
        description:     `Legal and procurement review not yet confirmed. For deals near close, this should be initiated now.`,
        action_type:     'email_send',
        priority:        'medium',
        due_days:        3,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Ask: "Has your procurement/legal team been looped in yet? What does their typical review process look like, and what do they need from us?"',
        health_param:    '3a',
        source_rule:     'health_3a_legal',
      }));
    }

    // 3b unknown → security/IT review not started
    if (params['3b']?.state === 'unknown') {
      actions.push(this._action({
        title:           `Initiate security/IT review for ${dealName}`,
        description:     `Security/IT review not yet confirmed. Proactively offering security documentation can accelerate this.`,
        action_type:     'email_send',
        priority:        'medium',
        due_days:        3,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Share your security pack/SOC2 report proactively. Ask: "Would it help if I sent our security documentation to your IT team directly?"',
        health_param:    '3b',
        source_rule:     'health_3b_security',
      }));
    }

    // 4c unknown → scope not explicitly approved
    if (params['4c']?.state === 'unknown') {
      actions.push(this._action({
        title:           `Get explicit scope sign-off for ${dealName}`,
        description:     `Scope has not been explicitly approved by the buyer. This is needed before legal/contract work begins.`,
        action_type:     'email_send',
        priority:        'medium',
        due_days:        3,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Send a scope summary email and ask for explicit confirmation: "Does this accurately reflect what we discussed? Any changes before we move to contracts?"',
        health_param:    '4c',
        source_rule:     'health_4c_scope',
      }));
    }

    // ── Category 4: Deal Size Realism ────────────────────────

    // 4a confirmed → deal is oversized vs segment
    if (params['4a']?.state === 'confirmed') {
      actions.push(this._action({
        title:           `Validate deal size realism for ${dealName}`,
        description:     `Deal value is ${params['4a'].ratio}× the segment average. Confirm the scope justifies this size to avoid late-stage repricing.`,
        action_type:     'task_complete',
        priority:        'medium',
        due_days:        5,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Review the deal with your manager. Confirm the scope, user count, and pricing are clearly documented and buyer-confirmed.',
        health_param:    '4a',
        source_rule:     'health_4a_oversized',
      }));
    }

    // ── Category 5: Competitive & Pricing Risk ───────────────

    // 5a confirmed → competitive deal
    if (params['5a']?.state === 'confirmed') {
      const compNames = (params['5a']?.competitors || []).map(c => c.name).join(', ');
      actions.push(this._action({
        title:           `Develop competitive counter-strategy for ${dealName}`,
        description:     `Competitive deal confirmed${compNames ? ` — competing against: ${compNames}` : ''}. Define your differentiation strategy.`,
        action_type:     'document_prep',
        priority:        'high',
        due_days:        2,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: `Prepare a competitive battlecard highlighting your unique advantages vs ${compNames || 'competitor'}. Share win stories from similar accounts.`,
        health_param:    '5a',
        source_rule:     'health_5a_competitive',
      }));
    }

    // 5b confirmed → price sensitivity flagged
    if (params['5b']?.state === 'confirmed') {
      actions.push(this._action({
        title:           `Address price sensitivity on ${dealName}`,
        description:     `Price sensitivity has been flagged. Build ROI case before it becomes a blocker.`,
        action_type:     'document_prep',
        priority:        'high',
        due_days:        2,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Prepare a tailored ROI/business case document. Quantify time savings, risk reduction, or revenue impact specific to this account.',
        health_param:    '5b',
        source_rule:     'health_5b_price',
      }));
    }

    // 5c confirmed → discount approval pending
    if (params['5c']?.state === 'confirmed') {
      actions.push(this._action({
        title:           `Resolve discount approval for ${dealName}`,
        description:     `Discount approval is pending. Unresolved pricing exceptions stall deals.`,
        action_type:     'task_complete',
        priority:        'high',
        due_days:        1,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Escalate discount approval internally. Set a deadline and communicate the timeline to the buyer to maintain momentum.',
        health_param:    '5c',
        source_rule:     'health_5c_discount',
      }));
    }

    // ── Category 6: Momentum & Activity ──────────────────────

    // 6a confirmed → no recent meeting
    if (params['6a']?.state === 'confirmed') {
      const days = params['6a']?.daysSinceLastMeeting;
      actions.push(this._action({
        title:           `Re-establish meeting cadence for ${dealName}`,
        description:     `No meeting in ${days} days — deal momentum is stalling.`,
        action_type:     'meeting_schedule',
        priority:        'high',
        due_days:        1,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Send a short email with 2-3 specific time slots: "I want to make sure we keep momentum — can we find 30 minutes this week?"',
        health_param:    '6a',
        source_rule:     'health_6a_no_meeting',
      }));
    }

    // 6b confirmed → slow email response
    if (params['6b']?.state === 'confirmed') {
      const avgH = params['6b']?.avgHours;
      actions.push(this._action({
        title:           `Re-engage unresponsive contact on ${dealName}`,
        description:     `Average email response time is ${avgH}h — significantly above normal. Engagement may be dropping.`,
        action_type:     'email_send',
        priority:        'medium',
        due_days:        1,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Try a different channel (phone/LinkedIn). Keep the message short and specific: "Quick question — are you still the right person to move this forward?"',
        health_param:    '6b',
        source_rule:     'health_6b_slow_response',
      }));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // B. DEAL STAGE + TIMING RULES
  // ─────────────────────────────────────────────────────────────────────────

  static _dealStageRules(ctx, actions) {
    const { deal, derived } = ctx;
    const { stage, name: dealName, id: dealId, account_id, close_date } = deal;

    // Stagnant deal
    if (derived.isStagnant) {
      actions.push(this._action({
        title:           `Re-engage stagnant deal: ${dealName}`,
        description:     `No stage progression in ${derived.daysInStage} days.`,
        action_type:     'follow_up',
        priority:        'high',
        due_days:        0,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Send a re-engagement email. Reference something relevant (new feature, industry news, their recent announcement) to make it timely.',
        source_rule:     'stagnant_deal',
      }));
    }

    // Closing imminently
    if (derived.closingImminently) {
      actions.push(this._action({
        title:           `${dealName} closes in ${derived.daysUntilClose} day${derived.daysUntilClose !== 1 ? 's' : ''} — final checklist`,
        description:     `Close date is imminent. Verify all steps are complete.`,
        action_type:     'task_complete',
        priority:        'high',
        due_days:        0,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Confirm: contract ready, decision makers aligned, procurement informed, implementation date agreed, success criteria documented.',
        source_rule:     'close_imminent',
      }));
    }

    // Past close date
    if (derived.isPastClose) {
      const overdue = Math.abs(derived.daysUntilClose);
      actions.push(this._action({
        title:           `${dealName} is ${overdue} day${overdue !== 1 ? 's' : ''} past close date`,
        description:     `Deal has passed its close date without closing. Update or escalate.`,
        action_type:     'task_complete',
        priority:        'high',
        due_days:        0,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Update close date with new forecast. If no clear path forward, discuss internally whether to re-qualify or close as lost.',
        source_rule:     'past_close_date',
      }));
    }

    // High value with no recent meeting
    if (derived.isHighValue && derived.daysSinceLastMeeting > 7) {
      actions.push(this._action({
        title:           `High-value deal ${dealName} needs executive touchpoint`,
        description:     `$${parseFloat(deal.value || 0).toLocaleString()} deal with no meeting in ${derived.daysSinceLastMeeting} days.`,
        action_type:     'meeting_schedule',
        priority:        'high',
        due_days:        2,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Schedule an executive briefing. For deals of this size, regular exec-to-exec contact is critical.',
        source_rule:     'high_value_no_meeting',
      }));
    }

    // Stage-specific rules
    if (stage === 'qualified' && derived.completedMeetings.length === 0) {
      actions.push(this._action({
        title:           `Schedule discovery call for ${dealName}`,
        description:     `Qualified deal with no discovery meeting yet.`,
        action_type:     'meeting_schedule',
        priority:        'high',
        due_days:        1,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Book a 45-minute discovery call. Prepare MEDDIC questions: Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion.',
        source_rule:     'stage_qualified_no_discovery',
      }));
    }

    if (stage === 'demo' && !derived.completedMeetings.some(m => (m.meeting_type || '').includes('demo'))) {
      actions.push(this._action({
        title:           `Schedule product demo for ${dealName}`,
        description:     `Deal is in demo stage but no demo meeting recorded.`,
        action_type:     'meeting_schedule',
        priority:        'high',
        due_days:        2,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Customise the demo to their stated use cases. Confirm attendees include at least one decision maker.',
        source_rule:     'stage_demo_no_demo',
      }));
    }

    if (stage === 'proposal' && derived.daysSinceLastEmail > 3) {
      actions.push(this._action({
        title:           `Follow up on proposal for ${dealName}`,
        description:     `Proposal stage with no email contact in ${derived.daysSinceLastEmail} days.`,
        action_type:     'email_send',
        priority:        derived.daysSinceLastEmail > 7 ? 'high' : 'medium',
        due_days:        0,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Send a short follow-up: "Just checking in on the proposal — do you have any questions, or is there anything I can clarify?"',
        source_rule:     'stage_proposal_followup',
      }));
    }

    if (stage === 'negotiation') {
      actions.push(this._action({
        title:           `Check negotiation blockers for ${dealName}`,
        description:     `Deal is in negotiation — identify and address any remaining blockers.`,
        action_type:     'task_complete',
        priority:        'high',
        due_days:        1,
        deal_id:         dealId,
        account_id,
        suggested_action: 'Review: Are there open pricing, legal, or scope issues? Who needs to approve? What is their internal process timeline?',
        source_rule:     'stage_negotiation_blockers',
      }));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // C. CONTACT ENGAGEMENT RULES
  // ─────────────────────────────────────────────────────────────────────────

  static _contactRules(ctx, actions) {
    const { deal, contacts, emails, derived } = ctx;

    // No contacts at all
    if (contacts.length === 0) {
      actions.push(this._action({
        title:           `Add contacts to deal: ${deal.name}`,
        description:     `This deal has no contacts. Actions and health scoring will be severely limited without contact data.`,
        action_type:     'task_complete',
        priority:        'high',
        due_days:        0,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Add at least one contact with a role (Champion, Decision Maker, or Influencer) to this deal.',
        source_rule:     'no_contacts',
      }));
      return;
    }

    // Decision makers not contacted recently
    derived.decisionMakers.forEach(contact => {
      const contactEmails = emails.filter(e => e.contact_id === contact.id);
      const daysSince = contactEmails.length > 0
        ? Math.floor((Date.now() - new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at)))) ) / 86400000)
        : 999;
      if (daysSince > 14) {
        actions.push(this._action({
          title:           `Touch base with ${contact.first_name} ${contact.last_name} (Decision Maker)`,
          description:     `Key decision maker — no contact in ${daysSince === 999 ? 'over 30' : daysSince} days.`,
          action_type:     'email_send',
          priority:        'high',
          due_days:        1,
          deal_id:         deal.id,
          contact_id:      contact.id,
          account_id:      deal.account_id,
          suggested_action: 'Send a personalised update. Reference their stated priorities and show how the deal addresses them.',
          source_rule:     'decision_maker_no_contact',
        }));
      }
    });

    // Champions not nurtured
    derived.champions.forEach(contact => {
      const contactEmails = emails.filter(e => e.contact_id === contact.id);
      const daysSince = contactEmails.length > 0
        ? Math.floor((Date.now() - new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at))))) / 86400000)
        : 999;
      if (daysSince > 7) {
        actions.push(this._action({
          title:           `Nurture champion ${contact.first_name} ${contact.last_name}`,
          description:     `Internal champion — keep them informed and equipped to advocate internally.`,
          action_type:     'email_send',
          priority:        'medium',
          due_days:        2,
          deal_id:         deal.id,
          contact_id:      contact.id,
          account_id:      deal.account_id,
          suggested_action: 'Share ROI data, reference stories, or talk tracks to help them justify the decision internally.',
          source_rule:     'champion_nurture',
        }));
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // D. MEETING RULES
  // ─────────────────────────────────────────────────────────────────────────

  static _meetingRules(ctx, actions) {
    const { deal, meetings, emails, derived } = ctx;

    // Upcoming meeting — prep needed
    derived.upcomingMeetings.forEach(meeting => {
      const daysUntil = Math.ceil((new Date(meeting.start_time) - Date.now()) / 86400000);
      if (daysUntil <= 1) {
        actions.push(this._action({
          title:           `Prepare for: ${meeting.title || 'Upcoming meeting'}`,
          description:     `Meeting tomorrow — prepare agenda and review deal history.`,
          action_type:     'task_complete',
          priority:        'high',
          due_days:        0,
          deal_id:         deal.id,
          account_id:      deal.account_id,
          suggested_action: 'Review last email thread, prepare 3 agenda items, confirm attendees, and know your ask/next step before entering the call.',
          source_rule:     'meeting_prep',
        }));
      }
    });

    // Recent completed meeting — follow-up needed
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
          title:           `Send follow-up for: ${meeting.title || 'Recent meeting'}`,
          description:     `Meeting completed recently — send recap with next steps.`,
          action_type:     'email_send',
          priority:        'high',
          due_days:        0,
          deal_id:         deal.id,
          account_id:      deal.account_id,
          suggested_action: 'Email recap: key decisions made, open items with owners, agreed next steps and dates.',
          source_rule:     'meeting_followup',
        }));
      });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // E. EMAIL RULES
  // ─────────────────────────────────────────────────────────────────────────

  static _emailRules(ctx, actions) {
    const { deal, derived } = ctx;

    // Unanswered sent emails
    derived.unansweredEmails.slice(0, 2).forEach(email => {
      const daysSince = Math.floor((Date.now() - new Date(email.sent_at)) / 86400000);
      actions.push(this._action({
        title:           `Follow up on unanswered email: "${(email.subject || '').substring(0, 50)}"`,
        description:     `Email sent ${daysSince} days ago with no reply. Try a different approach.`,
        action_type:     'follow_up',
        priority:        daysSince > 7 ? 'high' : 'medium',
        due_days:        0,
        deal_id:         deal.id,
        contact_id:      email.contact_id || null,
        account_id:      deal.account_id,
        suggested_action: 'Try phone or LinkedIn. Keep message short: "Just following up — still relevant for you?"',
        source_rule:     'unanswered_email',
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // F. FILE RULES
  // ─────────────────────────────────────────────────────────────────────────

  static _fileRules(ctx, actions) {
    const { deal, files, derived } = ctx;

    // No files at all for a deal past qualified stage
    const activeStages = ['demo', 'proposal', 'negotiation', 'closing'];
    if (files.length === 0 && activeStages.includes(deal.stage)) {
      actions.push(this._action({
        title:           `Upload relevant documents for ${deal.name}`,
        description:     `No files uploaded for this deal. Proposals, contracts, and meeting notes help AI generate better actions.`,
        action_type:     'document_prep',
        priority:        'medium',
        due_days:        3,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: 'Upload the proposal, any email attachments, or meeting transcripts to enable AI-assisted analysis.',
        source_rule:     'no_files',
      }));
    }

    // Failed file imports — may contain important signals
    derived.failedFiles.forEach(file => {
      actions.push(this._action({
        title:           `Retry failed file import: ${file.file_name}`,
        description:     `File "${file.file_name}" failed to process. It may contain signals affecting deal health.`,
        action_type:     'task_complete',
        priority:        'low',
        due_days:        5,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        suggested_action: `Re-import "${file.file_name}" from the Files view. If it keeps failing, check the file format.`,
        source_rule:     'failed_file',
      }));
    });

    // Deal in proposal/negotiation stage but no proposal document found
    if (['proposal', 'negotiation'].includes(deal.stage)) {
      const hasProposal = files.some(f =>
        f.category === 'document' &&
        /proposal|quote|pricing|sow|contract/i.test(f.file_name)
      );
      if (!hasProposal) {
        actions.push(this._action({
          title:           `Prepare proposal document for ${deal.name}`,
          description:     `Deal is in ${deal.stage} stage but no proposal document found.`,
          action_type:     'document_prep',
          priority:        'high',
          due_days:        2,
          deal_id:         deal.id,
          account_id:      deal.account_id,
          suggested_action: 'Create and upload a tailored proposal. Include scope, pricing, timeline, ROI summary, and implementation plan.',
          source_rule:     'no_proposal_doc',
        }));
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // G. PLAYBOOK RULES
  //    Generate actions for key_actions in the playbook for this stage
  //    that haven't been actioned yet (no matching open/complete action).
  // ─────────────────────────────────────────────────────────────────────────

  static _playbookRules(ctx, actions) {
    const { deal, playbookStageActions } = ctx;
    if (!playbookStageActions || playbookStageActions.length === 0) return;

    playbookStageActions.forEach(actionText => {
      const actionType = PlaybookService.classifyActionType(actionText);
      const priority   = PlaybookService.suggestPriority(deal.stage, actionType);
      const dueDays    = PlaybookService.suggestDueDays(deal.stage, actionType);
      const keywords   = PlaybookService.extractKeywords(actionText);

      actions.push(this._action({
        title:           actionText,
        description:     `Playbook action for ${deal.stage} stage`,
        action_type:     actionType,
        priority,
        due_days:        dueDays,
        deal_id:         deal.id,
        account_id:      deal.account_id,
        keywords,
        requires_external_evidence: PlaybookService.requiresExternalEvidence(actionType, actionText),
        deal_stage:      deal.stage,
        source_rule:     'playbook',
        source:          'playbook',   // override default 'auto_generated'
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build a normalised action candidate.
   * due_days is converted to an absolute due_date.
   */
  static _action({
    title, description, action_type, priority, due_days,
    deal_id = null, contact_id = null, account_id = null,
    suggested_action = null, health_param = null,
    keywords = null, requires_external_evidence = false,
    deal_stage = null, source_rule = 'rules', source = 'auto_generated',
  }) {
    const due_date = new Date();
    due_date.setDate(due_date.getDate() + (due_days || 0));

    return {
      title,
      description,
      action_type,
      type:   action_type,     // actions table has both 'type' and 'action_type'
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

  /** Remove exact title duplicates within a batch */
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
