/**
 * DealContextBuilder.js
 *
 * Gathers ALL inputs needed for action generation for a single deal:
 *   1. Deal (with health score breakdown)
 *   2. Account
 *   3. Contacts (with roles)
 *   4. Meetings
 *   5. Emails (deal-linked)
 *   6. Files / storage_files (deal-linked)
 *   7. Playbook (user's stage actions)
 *   8. Deal Health Config + Breakdown
 *
 * Returns a single `context` object consumed by ActionsRulesEngine and ActionsAIEnhancer.
 * Called once per deal — all downstream services receive this context, no extra DB calls.
 */

const db        = require('../config/database');
const PlaybookService = require('./playbook.service');

class DealContextBuilder {

  /**
   * Build full context for a deal.
   * @param {number} dealId
   * @param {number} userId
   * @returns {Promise<DealContext>}
   */
  static async build(dealId, userId) {
    const [
      deal,
      account,
      contacts,
      meetings,
      emails,
      files,
      playbook,
      healthConfig,
    ] = await Promise.all([
      this._getDeal(dealId),
      this._getAccount(dealId),
      this._getContacts(dealId),
      this._getMeetings(dealId),
      this._getEmails(dealId),
      this._getFiles(dealId, userId),
      this._getPlaybook(userId),
      this._getHealthConfig(userId),
    ]);

    if (!deal) throw new Error(`Deal ${dealId} not found`);

    // Parse health breakdown stored as JSON in deals table
    const healthBreakdown = deal.health_score_breakdown
      ? (typeof deal.health_score_breakdown === 'string'
          ? JSON.parse(deal.health_score_breakdown)
          : deal.health_score_breakdown)
      : null;

    // Get playbook stage actions for the deal's current stage
    const playbookStageActions = deal.stage
      ? await PlaybookService.getStageActions(userId, deal.stage).catch(() => [])
      : [];

    // Pre-compute derived signals useful to rules engine
    const derived = this._deriveSignals(deal, contacts, meetings, emails, files);

    return {
      deal,
      account,
      contacts,
      meetings,
      emails,
      files,
      playbook,
      playbookStageActions,
      healthConfig,
      healthBreakdown,
      healthScore:  deal.health_score  ?? null,
      healthStatus: deal.health        || 'unknown',
      userId,
      derived,
    };
  }

  // ── Derived signal helpers ────────────────────────────────────────────────

  static _deriveSignals(deal, contacts, meetings, emails, files) {
    const now = Date.now();

    // Meetings
    const completedMeetings   = meetings.filter(m => m.status === 'completed' || new Date(m.start_time) < new Date());
    const upcomingMeetings    = meetings.filter(m => m.status === 'scheduled' && new Date(m.start_time) > new Date());
    const lastMeeting         = completedMeetings.sort((a, b) => new Date(b.start_time) - new Date(a.start_time))[0] || null;
    const daysSinceLastMeeting = lastMeeting
      ? Math.floor((now - new Date(lastMeeting.start_time)) / 86400000)
      : null;

    // Emails
    const sentEmails     = emails.filter(e => e.direction === 'sent');
    const receivedEmails = emails.filter(e => e.direction === 'received');
    const lastEmail      = emails.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0] || null;
    const daysSinceLastEmail = lastEmail
      ? Math.floor((now - new Date(lastEmail.sent_at)) / 86400000)
      : null;
    const unansweredEmails = sentEmails.filter(e => {
      if (!e.sent_at) return false;
      const daysSince = Math.floor((now - new Date(e.sent_at)) / 86400000);
      return daysSince >= 3 && !receivedEmails.some(r => new Date(r.sent_at) > new Date(e.sent_at));
    });

    // Contacts by role
    const decisionMakers  = contacts.filter(c => ['decision_maker', 'economic_buyer'].includes(c.role_type));
    const champions       = contacts.filter(c => c.role_type === 'champion');
    const stakeholders    = contacts.filter(c => ['decision_maker','champion','influencer','economic_buyer','executive'].includes(c.role_type));

    // Files
    const processedFiles  = files.filter(f => f.processing_status === 'completed');
    const pendingFiles    = files.filter(f => f.processing_status === 'processing');
    const failedFiles     = files.filter(f => f.processing_status === 'failed');

    // Deal timing
    const daysInStage = deal.updated_at
      ? Math.floor((now - new Date(deal.updated_at)) / 86400000)
      : 0;
    const daysUntilClose = deal.close_date
      ? Math.ceil((new Date(deal.close_date) - now) / 86400000)
      : null;
    const isPastClose = daysUntilClose !== null && daysUntilClose < 0;
    const closingImminently = daysUntilClose !== null && daysUntilClose >= 0 && daysUntilClose <= 7;

    return {
      completedMeetings,
      upcomingMeetings,
      lastMeeting,
      daysSinceLastMeeting,
      sentEmails,
      receivedEmails,
      lastEmail,
      daysSinceLastEmail,
      unansweredEmails,
      decisionMakers,
      champions,
      stakeholders,
      processedFiles,
      pendingFiles,
      failedFiles,
      daysInStage,
      daysUntilClose,
      isPastClose,
      closingImminently,
      isHighValue: parseFloat(deal.value || 0) > 100000,
      isStagnant:  daysInStage > 14 && !['closed_won','closed_lost'].includes(deal.stage),
    };
  }

  // ── DB fetchers ───────────────────────────────────────────────────────────

  static async _getDeal(dealId) {
    const r = await db.query('SELECT * FROM deals WHERE id = $1', [dealId]);
    return r.rows[0] || null;
  }

  static async _getAccount(dealId) {
    const r = await db.query(
      `SELECT a.* FROM accounts a
       JOIN deals d ON d.account_id = a.id
       WHERE d.id = $1`,
      [dealId]
    );
    return r.rows[0] || null;
  }

  static async _getContacts(dealId) {
    const r = await db.query(
      `SELECT c.*, dc.role as deal_role
       FROM contacts c
       JOIN deal_contacts dc ON dc.contact_id = c.id
       WHERE dc.deal_id = $1`,
      [dealId]
    );
    return r.rows;
  }

  static async _getMeetings(dealId) {
    const r = await db.query(
      'SELECT * FROM meetings WHERE deal_id = $1 ORDER BY start_time DESC',
      [dealId]
    );
    return r.rows;
  }

  static async _getEmails(dealId) {
    const r = await db.query(
      'SELECT * FROM emails WHERE deal_id = $1 ORDER BY sent_at DESC',
      [dealId]
    );
    return r.rows;
  }

  static async _getFiles(dealId, userId) {
    const r = await db.query(
      `SELECT * FROM storage_files
       WHERE deal_id = $1 AND user_id = $2
       ORDER BY imported_at DESC`,
      [dealId, userId]
    );
    return r.rows;
  }

  static async _getPlaybook(userId) {
    try {
      return await PlaybookService.getPlaybook(userId);
    } catch {
      return null;
    }
  }

  static async _getHealthConfig(userId) {
    try {
      const r = await db.query(
        'SELECT * FROM deal_health_config WHERE user_id = $1',
        [userId]
      );
      return r.rows[0] || null;
    } catch {
      return null;
    }
  }
}

module.exports = DealContextBuilder;
