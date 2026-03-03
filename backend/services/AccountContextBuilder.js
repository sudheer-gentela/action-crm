/**
 * AccountContextBuilder.js
 *
 * Gathers ALL context needed for account-level STRAP hurdle identification:
 *   1. Account record
 *   2. All deals (won, lost, open) with this account
 *   3. All contacts with roles
 *   4. All prospects linked to this account
 *   5. Email history across all contacts
 *   6. Team engagement (who's touched this account)
 *   7. Derived signals for hurdle detection
 *
 * Follows the same pattern as DealContextBuilder and ProspectContextBuilder —
 * called once, all downstream services receive this context.
 */

const db = require('../config/database');

class AccountContextBuilder {

  /**
   * @param {number} accountId
   * @param {number} userId
   * @param {number} orgId
   * @returns {Promise<object>}
   */
  static async build(accountId, userId, orgId) {
    // ── 1. Load account ─────────────────────────────────────────
    const account = await this._getAccount(accountId, orgId);
    if (!account) throw new Error(`Account ${accountId} not found`);

    // ── 2. Parallel fetch ───────────────────────────────────────
    const [
      deals,
      contacts,
      prospects,
      emailHistory,
      teamEngagement,
    ] = await Promise.all([
      this._getDeals(accountId, orgId),
      this._getContacts(accountId, orgId),
      this._getProspects(accountId, orgId),
      this._getEmailHistory(accountId, orgId),
      this._getTeamEngagement(accountId, orgId),
    ]);

    // ── 3. Derive signals ───────────────────────────────────────
    const derived = this._deriveSignals(account, deals, contacts, prospects, emailHistory, teamEngagement);

    return {
      account,
      deals,
      contacts,
      prospects,
      emailHistory,
      teamEngagement,
      derived,
      userId,
      orgId,
    };
  }

  // ── Derived Signals ─────────────────────────────────────────────────────────

  static _deriveSignals(account, deals, contacts, prospects, emailHistory, teamEngagement) {
    const now = Date.now();
    const daysSince = (date) => date ? Math.floor((now - new Date(date)) / 86400000) : 999;

    // ── Deal breakdown ──────────────────────────────────────────
    const wonDeals  = deals.filter(d => d.stage === 'closed_won');
    const lostDeals = deals.filter(d => d.stage === 'closed_lost');
    const openDeals = deals.filter(d => !['closed_won', 'closed_lost'].includes(d.stage));
    const totalRevenue = wonDeals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);

    // ── Contact role analysis ───────────────────────────────────
    const executives = contacts.filter(c =>
      ['executive', 'economic_buyer', 'decision_maker'].includes(c.role_type)
    );
    const champions = contacts.filter(c => c.role_type === 'champion');

    // ── Engagement staleness ────────────────────────────────────
    const lastEmailDate = emailHistory.length > 0
      ? new Date(emailHistory[0].sent_at)
      : null;
    const daysSinceLastEmail = lastEmailDate ? daysSince(lastEmailDate) : 999;

    const lastDealActivity = deals.length > 0
      ? new Date(Math.max(...deals.map(d => new Date(d.updated_at))))
      : null;
    const daysSinceLastDealActivity = lastDealActivity ? daysSince(lastDealActivity) : 999;

    const daysSinceLastEngagement = Math.min(daysSinceLastEmail, daysSinceLastDealActivity);

    // ── Product lines (approximation via deal names/tags) ───────
    // For now, count distinct deal names as a proxy for product diversity
    const uniqueDealNames = new Set(wonDeals.map(d => (d.name || '').toLowerCase().trim()));

    // ── Renewal proximity ───────────────────────────────────────
    // Check for won deals with close dates approaching (within 90 days of anniversary)
    const renewalCandidates = wonDeals.filter(d => {
      if (!d.close_date) return false;
      const closeDate = new Date(d.close_date);
      const anniversary = new Date(closeDate);
      anniversary.setFullYear(anniversary.getFullYear() + 1);
      const daysUntilRenewal = Math.ceil((anniversary - now) / 86400000);
      return daysUntilRenewal >= 0 && daysUntilRenewal <= 90;
    });

    // ── Whitespace ──────────────────────────────────────────────
    // Departments/teams not yet penetrated — approximate by contact role diversity
    const uniqueRoles = new Set(contacts.map(c => c.role_type).filter(Boolean));

    // ── Expansion signals ───────────────────────────────────────
    const stalledExpansionDeals = openDeals.filter(d => {
      const daysInStage = daysSince(d.updated_at);
      return daysInStage > 30;
    });

    return {
      // Deals
      wonDeals,
      lostDeals,
      openDeals,
      totalRevenue,
      dealCount: deals.length,
      wonDealCount: wonDeals.length,

      // Contacts
      executives,
      champions,
      contactCount: contacts.length,
      uniqueRoles,

      // Prospects
      prospectCount: prospects.length,
      activeProspects: prospects.filter(p => !['converted', 'disqualified'].includes(p.stage)),

      // Engagement
      daysSinceLastEmail,
      daysSinceLastDealActivity,
      daysSinceLastEngagement,
      emailCount: emailHistory.length,

      // Team
      teamMembersEngaged: [...new Set(teamEngagement.map(e => e.user_id))].length,

      // Product/Revenue
      uniqueProductCount: uniqueDealNames.size,
      isSingleProduct: uniqueDealNames.size <= 1 && wonDeals.length > 0,
      revenueConcentrated: wonDeals.length === 1 && totalRevenue > 0,

      // Renewal
      renewalCandidates,
      hasUpcomingRenewal: renewalCandidates.length > 0,

      // Whitespace & Expansion
      hasWhitespace: uniqueRoles.size < 3 && contacts.length < 5,
      stalledExpansionDeals,
      hasExpansionBlocked: stalledExpansionDeals.length > 0,

      // Staleness
      isStale: daysSinceLastEngagement > 30,

      // Champion gap — check if any champion exists and has recent engagement
      hasChampionGap: champions.length === 0 && wonDeals.length > 0,
    };
  }

  // ── DB Fetchers ─────────────────────────────────────────────────────────────

  static async _getAccount(accountId, orgId) {
    const r = await db.query(
      'SELECT * FROM accounts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
      [accountId, orgId]
    );
    return r.rows[0] || null;
  }

  static async _getDeals(accountId, orgId) {
    const r = await db.query(
      `SELECT id, name, value, stage, owner_id, close_date, health, health_score,
              expected_close_date, created_at, updated_at
       FROM deals
       WHERE account_id = $1 AND org_id = $2 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 50`,
      [accountId, orgId]
    );
    return r.rows;
  }

  static async _getContacts(accountId, orgId) {
    const r = await db.query(
      `SELECT id, first_name, last_name, email, title, phone, role_type, engagement_level
       FROM contacts
       WHERE account_id = $1 AND org_id = $2 AND deleted_at IS NULL
       ORDER BY last_name ASC LIMIT 100`,
      [accountId, orgId]
    );
    return r.rows;
  }

  static async _getProspects(accountId, orgId) {
    const r = await db.query(
      `SELECT id, first_name, last_name, email, title, stage, icp_score,
              outreach_count, response_count, owner_id
       FROM prospects
       WHERE account_id = $1 AND org_id = $2 AND deleted_at IS NULL
       ORDER BY icp_score DESC NULLS LAST LIMIT 50`,
      [accountId, orgId]
    );
    return r.rows;
  }

  static async _getEmailHistory(accountId, orgId) {
    const r = await db.query(
      `SELECT e.id, e.subject, e.direction, e.sent_at, e.deal_id, e.contact_id
       FROM emails e
       JOIN contacts c ON e.contact_id = c.id
       WHERE c.account_id = $1 AND e.org_id = $2 AND e.deleted_at IS NULL
       ORDER BY e.sent_at DESC LIMIT 100`,
      [accountId, orgId]
    );
    return r.rows;
  }

  static async _getTeamEngagement(accountId, orgId) {
    const r = await db.query(
      `SELECT DISTINCT d.owner_id AS user_id,
              u.first_name, u.last_name, u.email,
              MAX(d.updated_at) AS last_engagement
       FROM deals d
       JOIN users u ON d.owner_id = u.id
       WHERE d.account_id = $1 AND d.org_id = $2
       GROUP BY d.owner_id, u.first_name, u.last_name, u.email
       ORDER BY last_engagement DESC LIMIT 20`,
      [accountId, orgId]
    );
    return r.rows;
  }
}

module.exports = AccountContextBuilder;
