/**
 * ActionsEngine - AI-Powered Action Generation System
 * Analyzes deals, contacts, emails, and meetings to generate smart next-step actions
 * 
 * 17 Smart Rules for Action Generation
 */

class ActionsEngine {
  /**
   * Main method to generate all actions based on current CRM data
   * @param {Object} data - { deals, contacts, emails, meetings, accounts }
   * @returns {Array} - Array of generated actions
   */
  static generateActions(data) {
    const { deals = [], contacts = [], emails = [], meetings = [], accounts = [] } = data;
    const actions = [];

    // Rule 1: New deals need discovery calls
    deals.forEach(deal => {
      if (deal.stage === 'qualified' && !this.hasMeeting(deal.id, meetings, 'discovery')) {
        actions.push({
          title: `Schedule discovery call with ${deal.name}`,
          description: `New qualified deal needs initial discovery call to understand requirements.`,
          action_type: 'meeting',
          priority: 'high',
          due_date: this.addDays(new Date(), 1),
          deal_id: deal.id,
          account_id: deal.account_id,
          suggested_action: 'Schedule a 30-minute discovery call to understand their needs and pain points.'
        });
      }
    });

    // Rule 2: Demo stage deals need demo scheduled
    deals.forEach(deal => {
      if (deal.stage === 'demo' && !this.hasMeeting(deal.id, meetings, 'demo')) {
        actions.push({
          title: `Schedule product demo for ${deal.name}`,
          description: `Deal is in demo stage but no demo meeting scheduled.`,
          action_type: 'meeting',
          priority: 'high',
          due_date: this.addDays(new Date(), 2),
          deal_id: deal.id,
          account_id: deal.account_id,
          suggested_action: 'Book a comprehensive product demo showcasing key features relevant to their needs.'
        });
      }
    });

    // Rule 3: Proposal stage needs follow-up
    deals.forEach(deal => {
      if (deal.stage === 'proposal') {
        const lastEmail = this.getLastEmail(deal.id, emails);
        const daysSinceLastEmail = lastEmail 
          ? this.daysSince(new Date(lastEmail.sent_at)) 
          : 999;

        if (daysSinceLastEmail > 3) {
          actions.push({
            title: `Follow up on proposal with ${deal.name}`,
            description: `Proposal sent ${daysSinceLastEmail} days ago with no follow-up.`,
            action_type: 'follow_up',
            priority: daysSinceLastEmail > 7 ? 'high' : 'medium',
            due_date: new Date(),
            deal_id: deal.id,
            account_id: deal.account_id,
            suggested_action: 'Send a follow-up email asking if they have any questions about the proposal.'
          });
        }
      }
    });

    // Rule 4: Negotiation stage needs check-in
    deals.forEach(deal => {
      if (deal.stage === 'negotiation') {
        actions.push({
          title: `Check negotiation status for ${deal.name}`,
          description: `Deal is in negotiation - check if there are any blockers.`,
          action_type: 'review',
          priority: 'high',
          due_date: this.addDays(new Date(), 1),
          deal_id: deal.id,
          account_id: deal.account_id,
          suggested_action: 'Review pricing, terms, and identify any remaining objections to address.'
        });
      }
    });

    // Rule 5: Stagnant deals need attention
    deals.forEach(deal => {
      if (deal.updated_at) {
        const daysSinceUpdate = this.daysSince(new Date(deal.updated_at));
        if (daysSinceUpdate > 14 && deal.stage !== 'closed_won' && deal.stage !== 'closed_lost') {
          actions.push({
            title: `Re-engage with ${deal.name}`,
            description: `No activity for ${daysSinceUpdate} days. Deal may be going cold.`,
            action_type: 'follow_up',
            priority: 'high',
            due_date: new Date(),
            deal_id: deal.id,
            account_id: deal.account_id,
            suggested_action: 'Reach out to re-establish contact and understand current priorities.'
          });
        }
      }
    });

    // Rule 6: High-value deals need extra attention
    deals.forEach(deal => {
      if (parseFloat(deal.value) > 100000) {
        const recentMeetings = meetings.filter(m => 
          m.deal_id === deal.id && 
          this.daysSince(new Date(m.start_time)) < 7
        );
        
        if (recentMeetings.length === 0) {
          actions.push({
            title: `High-value deal ${deal.name} needs touchpoint`,
            description: `$${parseFloat(deal.value).toLocaleString()} deal with no recent meetings.`,
            action_type: 'meeting',
            priority: 'high',
            due_date: this.addDays(new Date(), 2),
            deal_id: deal.id,
            account_id: deal.account_id,
            suggested_action: 'Schedule executive briefing or strategic planning session.'
          });
        }
      }
    });

    // Rule 7: Emails not opened need follow-up
    emails.forEach(email => {
      if (email.direction === 'sent' && !email.opened_at && email.deal_id) {
        const daysSinceSent = this.daysSince(new Date(email.sent_at));
        if (daysSinceSent > 3) {
          actions.push({
            title: `Email to ${email.to_address} not opened`,
            description: `Email "${email.subject}" sent ${daysSinceSent} days ago but not opened.`,
            action_type: 'follow_up',
            priority: 'medium',
            due_date: new Date(),
            deal_id: email.deal_id,
            contact_id: email.contact_id,
            suggested_action: 'Try a different approach - phone call or LinkedIn message.'
          });
        }
      }
    });

    // Rule 8: Completed meetings need follow-up
    meetings.forEach(meeting => {
      if (meeting.status === 'completed' && meeting.deal_id) {
        const daysSinceCompleted = this.daysSince(new Date(meeting.end_time));
        const hasFollowUpEmail = emails.some(e => 
          e.deal_id === meeting.deal_id && 
          new Date(e.sent_at) > new Date(meeting.end_time)
        );

        if (daysSinceCompleted < 2 && !hasFollowUpEmail) {
          actions.push({
            title: `Send follow-up after meeting: ${meeting.title}`,
            description: `Meeting completed ${daysSinceCompleted} day(s) ago - send recap and next steps.`,
            action_type: 'email',
            priority: 'high',
            due_date: new Date(),
            deal_id: meeting.deal_id,
            suggested_action: 'Send meeting recap with key discussion points and agreed next steps.'
          });
        }
      }
    });

    // Rule 9: Upcoming meetings need preparation
    meetings.forEach(meeting => {
      if (meeting.status === 'scheduled' && meeting.deal_id) {
        const daysUntilMeeting = this.daysUntil(new Date(meeting.start_time));
        if (daysUntilMeeting <= 1 && daysUntilMeeting >= 0) {
          actions.push({
            title: `Prepare for meeting: ${meeting.title}`,
            description: `Meeting scheduled for ${new Date(meeting.start_time).toLocaleDateString()}.`,
            action_type: 'review',
            priority: 'high',
            due_date: new Date(meeting.start_time),
            deal_id: meeting.deal_id,
            suggested_action: 'Review account history, prepare agenda, and confirm attendees.'
          });
        }
      }
    });

    // Rule 10: Low engagement contacts need re-engagement
    contacts.forEach(contact => {
      if (contact.engagement_level === 'low') {
        const contactEmails = emails.filter(e => e.contact_id === contact.id);
        const daysSinceLastEmail = contactEmails.length > 0
          ? this.daysSince(new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at)))))
          : 999;

        if (daysSinceLastEmail > 30) {
          actions.push({
            title: `Re-engage with ${contact.first_name} ${contact.last_name}`,
            description: `Low engagement contact - no communication in ${daysSinceLastEmail} days.`,
            action_type: 'follow_up',
            priority: 'medium',
            due_date: this.addDays(new Date(), 7),
            contact_id: contact.id,
            account_id: contact.account_id,
            suggested_action: 'Send personalized email with relevant industry insights or use case.'
          });
        }
      }
    });

    // Rule 11: Decision makers need regular touchpoints
    contacts.forEach(contact => {
      if (contact.role_type === 'decision_maker') {
        const contactEmails = emails.filter(e => e.contact_id === contact.id);
        const daysSinceLastContact = contactEmails.length > 0
          ? this.daysSince(new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at)))))
          : 999;

        if (daysSinceLastContact > 14) {
          actions.push({
            title: `Touch base with decision maker ${contact.first_name} ${contact.last_name}`,
            description: `Key decision maker - maintain regular communication.`,
            action_type: 'follow_up',
            priority: 'high',
            due_date: this.addDays(new Date(), 1),
            contact_id: contact.id,
            account_id: contact.account_id,
            suggested_action: 'Schedule executive briefing or share strategic insights relevant to their role.'
          });
        }
      }
    });

    // Rule 12: Deals approaching close date
    deals.forEach(deal => {
      if (deal.close_date && deal.stage !== 'closed_won' && deal.stage !== 'closed_lost') {
        const daysUntilClose = this.daysUntil(new Date(deal.close_date));
        if (daysUntilClose <= 7 && daysUntilClose >= 0) {
          actions.push({
            title: `Deal ${deal.name} closing in ${daysUntilClose} days`,
            description: `Close date approaching - ensure all steps completed.`,
            action_type: 'review',
            priority: 'high',
            due_date: new Date(),
            deal_id: deal.id,
            account_id: deal.account_id,
            suggested_action: 'Verify all paperwork ready, confirm decision makers aligned, address final concerns.'
          });
        }
      }
    });

    // Rule 13: Deals past close date
    deals.forEach(deal => {
      if (deal.close_date && deal.stage !== 'closed_won' && deal.stage !== 'closed_lost') {
        const daysPastClose = this.daysSince(new Date(deal.close_date));
        if (daysPastClose > 0) {
          actions.push({
            title: `Deal ${deal.name} is past close date`,
            description: `Close date was ${daysPastClose} days ago - update or close deal.`,
            action_type: 'review',
            priority: 'high',
            due_date: new Date(),
            deal_id: deal.id,
            account_id: deal.account_id,
            suggested_action: 'Update close date with new timeline or mark as closed lost if no longer viable.'
          });
        }
      }
    });

    // Rule 14: Low health deals need intervention
    deals.forEach(deal => {
      if (deal.health === 'at_risk') {
        actions.push({
          title: `Intervention needed for at-risk deal: ${deal.name}`,
          description: `Deal marked as at-risk - immediate action required.`,
          action_type: 'review',
          priority: 'high',
          due_date: new Date(),
          deal_id: deal.id,
          account_id: deal.account_id,
          suggested_action: 'Identify specific risks, schedule internal strategy session, escalate to management if needed.'
        });
      }
    });

    // Rule 15: Champions need nurturing
    contacts.forEach(contact => {
      if (contact.role_type === 'champion') {
        const contactEmails = emails.filter(e => e.contact_id === contact.id);
        const daysSinceLastEmail = contactEmails.length > 0
          ? this.daysSince(new Date(Math.max(...contactEmails.map(e => new Date(e.sent_at)))))
          : 999;

        if (daysSinceLastEmail > 7) {
          actions.push({
            title: `Nurture champion relationship with ${contact.first_name} ${contact.last_name}`,
            description: `Internal champion - keep them informed and engaged.`,
            action_type: 'follow_up',
            priority: 'medium',
            due_date: this.addDays(new Date(), 1),
            contact_id: contact.id,
            account_id: contact.account_id,
            suggested_action: 'Share ROI data, success stories, or insider tips to help them advocate internally.'
          });
        }
      }
    });

    // Rule 16: New accounts need introduction
    accounts.forEach(account => {
      if (account.created_at) {
        const daysSinceCreated = this.daysSince(new Date(account.created_at));
        const accountEmails = emails.filter(e => {
          const contact = contacts.find(c => c.id === e.contact_id);
          return contact && contact.account_id === account.id;
        });

        if (daysSinceCreated <= 3 && accountEmails.length === 0) {
          actions.push({
            title: `Send introduction email to ${account.name}`,
            description: `New account created - establish initial contact.`,
            action_type: 'email',
            priority: 'high',
            due_date: new Date(),
            account_id: account.id,
            suggested_action: 'Send personalized introduction highlighting how you can help solve their challenges.'
          });
        }
      }
    });

    // Rule 17: Emails opened but no reply
    emails.forEach(email => {
      if (email.direction === 'sent' && email.opened_at && !email.replied_at && email.deal_id) {
        const daysSinceOpened = this.daysSince(new Date(email.opened_at));
        if (daysSinceOpened > 2 && daysSinceOpened < 7) {
          actions.push({
            title: `Email opened but no reply from ${email.to_address}`,
            description: `Email opened ${daysSinceOpened} days ago - they're interested but haven't responded.`,
            action_type: 'follow_up',
            priority: 'medium',
            due_date: new Date(),
            deal_id: email.deal_id,
            contact_id: email.contact_id,
            suggested_action: 'Send gentle follow-up: "Just checking if you had any questions about my previous email."'
          });
        }
      }
    });

    return actions;
  }

  // Helper methods

  static hasMeeting(dealId, meetings, type = null) {
    return meetings.some(m => 
      m.deal_id === dealId && 
      (type ? m.meeting_type === type : true)
    );
  }

  static getLastEmail(dealId, emails) {
    const dealEmails = emails.filter(e => e.deal_id === dealId);
    if (dealEmails.length === 0) return null;
    return dealEmails.reduce((latest, email) => 
      new Date(email.sent_at) > new Date(latest.sent_at) ? email : latest
    );
  }

  static daysSince(date) {
    const now = new Date();
    const diffTime = Math.abs(now - date);
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }

  static daysUntil(date) {
    const now = new Date();
    const diffTime = date - now;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  static addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
}

module.exports = ActionsEngine;
