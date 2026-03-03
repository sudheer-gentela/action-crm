/**
 * AccountHurdleIdentifier.js
 *
 * Identifies the highest-priority hurdle blocking account expansion/health.
 * Hurdle types from the handoff spec — ordered by priority.
 *
 * Returns: { hurdleType, title, priority, evidence } or null.
 */

class AccountHurdleIdentifier {

  /**
   * @param {object} context - from AccountContextBuilder
   * @returns {{ hurdleType: string, title: string, priority: string, evidence: string } | null}
   */
  static identify(context) {
    const { account, derived } = context;

    const checks = [
      this._checkStaleAccount(account, derived),
      this._checkRenewalRisk(account, derived),
      this._checkChampionGap(account, derived),
      this._checkNoExecRelationship(account, derived),
      this._checkExpansionBlocked(account, derived),
      this._checkRevenueConcentration(account, derived),
      this._checkWhitespace(account, derived),
      this._checkSingleProduct(account, derived),
    ];

    for (const result of checks) {
      if (result) return result;
    }

    return null;
  }

  // ── stale_account: no engagement in 30+ days ──────────────────────────────

  static _checkStaleAccount(account, derived) {
    if (derived.isStale && derived.wonDealCount > 0) {
      return {
        hurdleType: 'stale_account',
        title: 'Account gone dark',
        priority: 'critical',
        evidence: `No engagement in ${derived.daysSinceLastEngagement} days across ${derived.contactCount} contacts. Customer may be at risk.`,
      };
    }
    return null;
  }

  // ── renewal_risk: contract approaching renewal with no expansion ───────────

  static _checkRenewalRisk(account, derived) {
    if (derived.hasUpcomingRenewal && derived.openDeals.length === 0) {
      return {
        hurdleType: 'renewal_risk',
        title: 'Renewal approaching with no expansion',
        priority: 'critical',
        evidence: `${derived.renewalCandidates.length} deal(s) approaching renewal anniversary with no active expansion conversation.`,
      };
    }
    return null;
  }

  // ── champion_gap: original champion left or disengaged ────────────────────

  static _checkChampionGap(account, derived) {
    if (derived.hasChampionGap) {
      return {
        hurdleType: 'champion_gap',
        title: 'No champion identified',
        priority: 'high',
        evidence: `Account has ${derived.wonDealCount} won deal(s) but no contact with champion role. Original champion may have left.`,
      };
    }
    return null;
  }

  // ── no_exec_relationship: no executive-level contact ──────────────────────

  static _checkNoExecRelationship(account, derived) {
    if (derived.executives.length === 0 && derived.wonDealCount > 0) {
      return {
        hurdleType: 'no_exec_relationship',
        title: 'No executive relationship',
        priority: 'high',
        evidence: `No executive, economic buyer, or decision maker contact linked to this account despite ${derived.wonDealCount} won deal(s).`,
      };
    }
    return null;
  }

  // ── expansion_blocked: open expansion deal stalled ────────────────────────

  static _checkExpansionBlocked(account, derived) {
    if (derived.hasExpansionBlocked) {
      const stalled = derived.stalledExpansionDeals[0];
      return {
        hurdleType: 'expansion_blocked',
        title: 'Expansion deal stalled',
        priority: 'high',
        evidence: `Open deal "${stalled.name}" has been idle for 30+ days. Expansion momentum is at risk.`,
      };
    }
    return null;
  }

  // ── revenue_concentration: all revenue from one deal ──────────────────────

  static _checkRevenueConcentration(account, derived) {
    if (derived.revenueConcentrated) {
      return {
        hurdleType: 'revenue_concentration',
        title: 'Revenue concentrated in single deal',
        priority: 'medium',
        evidence: `All $${derived.totalRevenue.toLocaleString()} revenue comes from a single deal. Diversification is needed.`,
      };
    }
    return null;
  }

  // ── whitespace: departments/teams not yet penetrated ──────────────────────

  static _checkWhitespace(account, derived) {
    if (derived.hasWhitespace && derived.wonDealCount > 0) {
      return {
        hurdleType: 'whitespace',
        title: 'Untapped departments',
        priority: 'medium',
        evidence: `Only ${derived.contactCount} contact(s) with ${derived.uniqueRoles.size} role type(s). Significant whitespace remains.`,
      };
    }
    return null;
  }

  // ── single_product: customer using only one product/service line ───────────

  static _checkSingleProduct(account, derived) {
    if (derived.isSingleProduct) {
      return {
        hurdleType: 'single_product',
        title: 'Single product line',
        priority: 'low',
        evidence: `Customer has only one distinct product/deal. Cross-sell opportunities likely exist.`,
      };
    }
    return null;
  }
}

module.exports = AccountHurdleIdentifier;
