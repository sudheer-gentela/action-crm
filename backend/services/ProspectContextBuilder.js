// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// ProspectContextBuilder.js
//
// Gathers ALL inputs needed for prospecting action generation and outreach
// composition for a single prospect:
//
//   1. Prospect record (with ICP score, stage, engagement tracking)
//   2. Account (if linked, or matched by company_domain)
//   3. Account history \u2014 past deals, contacts, team relationships
//   4. Email history \u2014 any emails to/from this prospect's email
//   5. Other prospects at the same company
//   6. Playbook stage guidance for current stage
//   7. ICP score breakdown
//   8. Derived signals (engagement velocity, staleness, relationship strength)
//
// Returns a single `context` object consumed by:
//   - Outreach Composer (AI-generated messages)
//   - Prospecting Actions Generator (action creation)
//   - Prospect Detail Panel (context display)
//
// Follows the same pattern as DealContextBuilder \u2014 called once per prospect,
// all downstream services receive this context, no extra DB calls.
// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const db              = require('../config/database');
const IcpScoringService = require('./icpScoring.service');

class ProspectContextBuilder {

  /**
   * Build full context for a prospect.
   * @param {number} prospectId
   * @param {number} userId   \u2014 the requesting user
   * @param {number} orgId
   * @returns {Promise<ProspectContext>}
   */
  static async build(prospectId, userId, orgId, config = {}) {
    // \u2500\u2500 1. Load prospect \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const prospect = await this._getProspect(prospectId, orgId);
    if (!prospect) throw new Error(`Prospect ${prospectId} not found`);

    // \u2500\u2500 2. Parallel fetch all context sources \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const [
      account,
      accountDeals,
      accountContacts,
      teamEngagement,
      emailHistory,
      siblingProspects,
      prospectActivities,
      prospectActions,
      playbook,
      stageGuidance,
      icpBreakdown,
    ] = await Promise.all([
      this._getAccount(prospect, orgId),
      this._getAccountDeals(prospect, orgId),
      this._getAccountContacts(prospect, orgId),
      this._getTeamEngagement(prospect, orgId),
      this._getEmailHistory(prospect, orgId),
      this._getSiblingProspects(prospect, orgId),
      this._getActivities(prospectId),
      this._getActions(prospectId, orgId),
      this._getPlaybook(prospect.playbook_id, orgId),
      this._getStageGuidance(prospect.playbook_id, prospect.stage, orgId),
      IcpScoringService.score(prospect, orgId).catch(() => null),
    ]);

    // \u2500\u2500 3. Derive signals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const derived = this._deriveSignals(
      prospect, account, accountDeals, accountContacts,
      teamEngagement, emailHistory, siblingProspects,
      prospectActions, prospectActivities,
      config
    );

    // \u2500\u2500 4. Build the outreach context summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const outreachContext = this._buildOutreachContext(
      prospect, account, derived, stageGuidance
    );

    return {
      prospect,
      account,
      accountDeals,
      accountContacts,
      teamEngagement,
      emailHistory,
      siblingProspects,
      prospectActivities,
      prospectActions,
      playbook,
      stageGuidance,
      icpBreakdown,
      icpScore: prospect.icp_score,
      derived,
      outreachContext,
      userId,
      orgId,
    };
  }

  // \u2500\u2500 Derived Signals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  static _deriveSignals(
    prospect, account, accountDeals, accountContacts,
    teamEngagement, emailHistory, siblingProspects,
    prospectActions, prospectActivities,
    config = {}
  ) {
    const now = Date.now();

    // \u2500\u2500 Engagement velocity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const daysSinceLastOutreach = prospect.last_outreach_at
      ? Math.floor((now - new Date(prospect.last_outreach_at)) / 86400000)
      : null;

    const daysSinceLastResponse = prospect.last_response_at
      ? Math.floor((now - new Date(prospect.last_response_at)) / 86400000)
      : null;

    const daysSinceCreated = prospect.created_at
      ? Math.floor((now - new Date(prospect.created_at)) / 86400000)
      : 0;

    const responseRate = prospect.outreach_count > 0
      ? (prospect.response_count / prospect.outreach_count)
      : 0;

    const ghostingDays = config.ghosting_days ?? 5;
    const isGhosting = prospect.outreach_count >= 3
      && prospect.response_count === 0
      && daysSinceLastOutreach !== null
      && daysSinceLastOutreach > ghostingDays;

    const staleDays = config.stale_days ?? 14;
    const isStale = daysSinceLastOutreach !== null && daysSinceLastOutreach > staleDays;
    const hotLeadDays = config.hot_lead_response_days ?? 3;
    const isHotLead = responseRate > 0.3 && daysSinceLastResponse !== null && daysSinceLastResponse <= hotLeadDays;

    // \u2500\u2500 Email signals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const sentEmails = emailHistory.filter(e => e.direction === 'sent');
    const receivedEmails = emailHistory.filter(e => e.direction === 'received');
    const lastEmail = emailHistory[0] || null; // already sorted DESC
    const hasReplied = receivedEmails.length > 0;
    const unansweredCount = sentEmails.filter(e => {
      const sentDate = new Date(e.sent_at);
      return !receivedEmails.some(r => new Date(r.sent_at) > sentDate);
    }).length;

    // \u2500\u2500 Account relationship strength \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const hasExistingAccount = !!account;
    const pastDealsWon = accountDeals.filter(d => d.stage === 'closed_won');
    const pastDealsLost = accountDeals.filter(d => d.stage === 'closed_lost');
    const openDeals = accountDeals.filter(d => !['closed_won', 'closed_lost'].includes(d.stage));
    const totalAccountRevenue = pastDealsWon.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);

    const isExistingCustomer = pastDealsWon.length > 0;
    const isLostAccount = pastDealsLost.length > 0 && pastDealsWon.length === 0;
    const hasOpenDeal = openDeals.length > 0;

    const knownContactCount = accountContacts.length;
    const teamMembersEngaged = [...new Set(teamEngagement.map(e => e.user_id))].length;

    // \u2500\u2500 Sibling prospects \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const otherProspectsAtCompany = siblingProspects.filter(p => p.id !== prospect.id);
    const convertedSiblings = otherProspectsAtCompany.filter(p => p.stage === 'converted');
    const engagedSiblings = otherProspectsAtCompany.filter(p =>
      ['engaged', 'qualified', 'converted'].includes(p.stage)
    );

    // \u2500\u2500 Action signals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const pendingActions = prospectActions.filter(a => a.status === 'pending');
    const completedActions = prospectActions.filter(a => a.status === 'completed');
    const overdueActions = pendingActions.filter(a =>
      a.due_date && new Date(a.due_date) < new Date()
    );

    return {
      // Engagement
      daysSinceLastOutreach,
      daysSinceLastResponse,
      daysSinceCreated,
      responseRate,
      isGhosting,
      isStale,
      isHotLead,

      // Emails
      sentEmailCount: sentEmails.length,
      receivedEmailCount: receivedEmails.length,
      lastEmail,
      hasReplied,
      unansweredCount,

      // Account relationship
      hasExistingAccount,
      isExistingCustomer,
      isLostAccount,
      hasOpenDeal,
      pastDealsWon,
      pastDealsLost,
      openDeals,
      totalAccountRevenue,
      knownContactCount,
      teamMembersEngaged,

      // Siblings
      otherProspectsAtCompany,
      convertedSiblings,
      engagedSiblings,

      // Actions
      pendingActions,
      completedActions,
      overdueActions,
    };
  }

  // \u2500\u2500 Outreach Context Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Produces a human-readable (and AI-consumable) summary of everything known
  // about this prospect. Used by the Outreach Composer for AI-generated messages.

  static _buildOutreachContext(prospect, account, derived, stageGuidance) {
    const parts = [];

    // \u2500\u2500 Who they are \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    parts.push(`**Prospect:** ${prospect.first_name} ${prospect.last_name}, ${prospect.title || 'unknown title'} at ${prospect.company_name || 'unknown company'}`);

    if (prospect.company_industry) parts.push(`**Industry:** ${prospect.company_industry}`);
    if (prospect.company_size) parts.push(`**Company size:** ${prospect.company_size} employees`);
    if (prospect.location) parts.push(`**Location:** ${prospect.location}`);

    // \u2500\u2500 Current stage + goal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    parts.push(`**Stage:** ${prospect.stage}${stageGuidance?.goal ? ` \u2014 Goal: ${stageGuidance.goal}` : ''}`);
    if (stageGuidance?.timeline) parts.push(`**Timeline target:** ${stageGuidance.timeline}`);

    // \u2500\u2500 Research notes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (prospect.research_notes) {
      parts.push(`**Research notes:** ${prospect.research_notes}`);
    }

    // \u2500\u2500 Account relationship \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (derived.isExistingCustomer) {
      parts.push(`**\u26a1 Existing customer:** ${derived.pastDealsWon.length} deal(s) won, $${derived.totalAccountRevenue.toLocaleString()} total revenue`);
    } else if (derived.isLostAccount) {
      const lastLoss = derived.pastDealsLost[0];
      parts.push(`**\u26a0\ufe0f Previously lost:** Lost deal "${lastLoss?.name || 'unknown'}"${lastLoss?.stage ? ` at ${lastLoss.stage}` : ''}`);
    } else if (derived.hasOpenDeal) {
      const openDeal = derived.openDeals[0];
      parts.push(`**\ud83d\udccb Active deal:** "${openDeal.name}" at ${openDeal.stage} stage ($${parseFloat(openDeal.value || 0).toLocaleString()})`);
    }

    // \u2500\u2500 Team engagement \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (derived.teamMembersEngaged > 0) {
      parts.push(`**Team engaged:** ${derived.teamMembersEngaged} team member(s) have interacted with this account`);
    }
    if (derived.knownContactCount > 0) {
      parts.push(`**Known contacts:** ${derived.knownContactCount} contact(s) at this account in CRM`);
    }

    // \u2500\u2500 Engagement history \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const engagementParts = [];
    if (prospect.outreach_count > 0) engagementParts.push(`${prospect.outreach_count} outreach touches`);
    if (prospect.response_count > 0) engagementParts.push(`${prospect.response_count} responses`);
    if (derived.daysSinceLastOutreach !== null) engagementParts.push(`last outreach ${derived.daysSinceLastOutreach}d ago`);
    if (derived.daysSinceLastResponse !== null) engagementParts.push(`last response ${derived.daysSinceLastResponse}d ago`);
    if (engagementParts.length) parts.push(`**Engagement:** ${engagementParts.join(', ')}`);

    // \u2500\u2500 Flags \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (derived.isGhosting) parts.push(`**\ud83d\udd07 Ghosting:** ${prospect.outreach_count} touches with no response`);
    if (derived.isHotLead) parts.push(`**\ud83d\udd25 Hot lead:** High response rate, responded recently`);
    if (derived.hasReplied) parts.push(`**\u2705 Has replied:** ${derived.receivedEmailCount} email(s) received`);
    if (derived.overdueActions.length > 0) parts.push(`**\u23f0 Overdue actions:** ${derived.overdueActions.length} action(s) past due`);

    // \u2500\u2500 Sibling prospects \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (derived.otherProspectsAtCompany.length > 0) {
      const names = derived.otherProspectsAtCompany.map(p => `${p.first_name} ${p.last_name} (${p.stage})`).join(', ');
      parts.push(`**Other prospects at company:** ${names}`);
    }

    // \u2500\u2500 ICP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (prospect.icp_score) parts.push(`**ICP score:** ${prospect.icp_score}/100`);

    // \u2500\u2500 Preferred channel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    if (prospect.preferred_channel) parts.push(`**Preferred channel:** ${prospect.preferred_channel}`);

    return parts.join('\
');
  }

  // \u2500\u2500 DB Fetchers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  static async _getProspect(prospectId, orgId) {
    const r = await db.query(
      'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [prospectId, orgId]
    );
    return r.rows[0] || null;
  }

  // Get the account either by direct link or by domain match
  static async _getAccount(prospect, orgId) {
    // Direct link first
    if (prospect.account_id) {
      const r = await db.query(
        'SELECT * FROM accounts WHERE id = $1 AND org_id = $2',
        [prospect.account_id, orgId]
      );
      if (r.rows[0]) return r.rows[0];
    }

    // Fallback: match by company_domain
    if (prospect.company_domain) {
      const r = await db.query(
        'SELECT * FROM accounts WHERE org_id = $1 AND LOWER(domain) = LOWER($2) LIMIT 1',
        [orgId, prospect.company_domain]
      );
      if (r.rows[0]) return r.rows[0];
    }

    return null;
  }

  // Past and current deals with this account
  static async _getAccountDeals(prospect, orgId) {
    const accountId = prospect.account_id;
    if (!accountId && !prospect.company_domain) return [];

    let query, params;
    if (accountId) {
      query = `SELECT id, name, value, stage, owner_id, close_date, created_at, updated_at
               FROM deals WHERE account_id = $1 AND org_id = $2
               ORDER BY created_at DESC LIMIT 20`;
      params = [accountId, orgId];
    } else {
      // Match by domain through accounts
      query = `SELECT d.id, d.name, d.value, d.stage, d.owner_id, d.close_date, d.created_at, d.updated_at
               FROM deals d
               JOIN accounts a ON d.account_id = a.id
               WHERE a.org_id = $1 AND LOWER(a.domain) = LOWER($2)
               ORDER BY d.created_at DESC LIMIT 20`;
      params = [orgId, prospect.company_domain];
    }

    const r = await db.query(query, params);
    return r.rows;
  }

  // Known contacts at this account
  static async _getAccountContacts(prospect, orgId) {
    const accountId = prospect.account_id;
    if (!accountId && !prospect.company_domain) return [];

    let query, params;
    if (accountId) {
      query = `SELECT id, first_name, last_name, email, title, phone
               FROM contacts WHERE account_id = $1 AND org_id = $2
               ORDER BY last_name ASC LIMIT 50`;
      params = [accountId, orgId];
    } else {
      query = `SELECT c.id, c.first_name, c.last_name, c.email, c.title, c.phone
               FROM contacts c
               JOIN accounts a ON c.account_id = a.id
               WHERE a.org_id = $1 AND LOWER(a.domain) = LOWER($2)
               ORDER BY c.last_name ASC LIMIT 50`;
      params = [orgId, prospect.company_domain];
    }

    const r = await db.query(query, params);
    return r.rows;
  }

  // Team members who have engaged with this account (via deals, emails, activities)
  static async _getTeamEngagement(prospect, orgId) {
    const accountId = prospect.account_id;
    if (!accountId) return [];

    const r = await db.query(
      `SELECT DISTINCT d.owner_id AS user_id,
              u.first_name, u.last_name, u.email,
              MAX(d.updated_at) AS last_engagement
       FROM deals d
       JOIN users u ON d.owner_id = u.id
       WHERE d.account_id = $1 AND d.org_id = $2
       GROUP BY d.owner_id, u.first_name, u.last_name, u.email
       ORDER BY last_engagement DESC LIMIT 10`,
      [accountId, orgId]
    );
    return r.rows;
  }

  // Email history with this specific person
  static async _getEmailHistory(prospect, orgId) {
    if (!prospect.email) return [];

    const r = await db.query(
      `SELECT id, subject, direction, sent_at, LEFT(body, 300) AS body_snippet,
              deal_id, contact_id
       FROM emails
       WHERE org_id = $1
         AND (LOWER(to_address) = LOWER($2) OR LOWER(from_address) = LOWER($2))
       ORDER BY sent_at DESC LIMIT 30`,
      [orgId, prospect.email]
    );
    return r.rows;
  }

  // Other prospects at the same company
  static async _getSiblingProspects(prospect, orgId) {
    const conditions = [];
    const params = [orgId, prospect.id];
    let pIdx = 3;

    if (prospect.account_id) {
      conditions.push(`account_id = $${pIdx}`);
      params.push(prospect.account_id);
      pIdx++;
    }
    if (prospect.company_domain) {
      conditions.push(`LOWER(company_domain) = LOWER($${pIdx})`);
      params.push(prospect.company_domain);
      pIdx++;
    }
    if (prospect.company_name) {
      conditions.push(`LOWER(company_name) = LOWER($${pIdx})`);
      params.push(prospect.company_name);
      pIdx++;
    }

    if (conditions.length === 0) return [];

    const r = await db.query(
      `SELECT id, first_name, last_name, title, stage, email, icp_score,
              outreach_count, response_count, owner_id
       FROM prospects
       WHERE org_id = $1 AND id != $2 AND deleted_at IS NULL
         AND (${conditions.join(' OR ')})
       ORDER BY icp_score DESC NULLS LAST LIMIT 20`,
      params
    );
    return r.rows;
  }

  // Prospect activities (timeline)
  static async _getActivities(prospectId) {
    const r = await db.query(
      `SELECT id, activity_type, description, metadata, created_at
       FROM prospecting_activities
       WHERE prospect_id = $1
       ORDER BY created_at DESC LIMIT 30`,
      [prospectId]
    );
    return r.rows;
  }

  // Prospect actions
  static async _getActions(prospectId, orgId) {
    const r = await db.query(
      `SELECT id, title, action_type, channel, status, priority,
              due_date, completed_at, sequence_step, source
       FROM prospecting_actions
       WHERE prospect_id = $1 AND org_id = $2
       ORDER BY sequence_step ASC, created_at ASC`,
      [prospectId, orgId]
    );
    return r.rows;
  }

  // Get the assigned playbook
  static async _getPlaybook(playbookId, orgId) {
    if (!playbookId) return null;
    try {
      const r = await db.query(
        'SELECT * FROM playbooks WHERE id = $1 AND org_id = $2',
        [playbookId, orgId]
      );
      if (r.rows[0]) {
        const row = r.rows[0];
        return {
          ...row,
          stage_guidance: typeof row.stage_guidance === 'string'
            ? JSON.parse(row.stage_guidance) : (row.stage_guidance || {}),
          content: typeof row.content === 'string'
            ? JSON.parse(row.content) : (row.content || {}),
        };
      }
    } catch (err) {
      console.error('ProspectContextBuilder._getPlaybook error:', err.message);
    }
    return null;
  }

  // Get stage guidance for the prospect's current stage
  static async _getStageGuidance(playbookId, stageKey, orgId) {
    if (!playbookId || !stageKey) return null;
    try {
      const r = await db.query(
        'SELECT stage_guidance FROM playbooks WHERE id = $1 AND org_id = $2',
        [playbookId, orgId]
      );
      if (r.rows[0]) {
        const guidance = typeof r.rows[0].stage_guidance === 'string'
          ? JSON.parse(r.rows[0].stage_guidance)
          : (r.rows[0].stage_guidance || {});
        return guidance[stageKey] || null;
      }
    } catch (err) {
      console.error('ProspectContextBuilder._getStageGuidance error:', err.message);
    }
    return null;
  }
}

module.exports = ProspectContextBuilder;
