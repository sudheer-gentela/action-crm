/**
 * DealHurdleIdentifier.js
 *
 * Identifies the highest-priority hurdle blocking a deal.
 * Extracted from the original StrapHurdleIdentifier — same P0–P7 hierarchy.
 *
 * Returns: { hurdleType, title, priority, evidence } or null if no hurdle found.
 */

class DealHurdleIdentifier {

  /**
   * @param {object} context - from DealContextBuilder
   * @returns {{ hurdleType: string, title: string, priority: string, evidence: string } | null}
   */
  static identify(context) {
    const { deal, contacts, derived, healthBreakdown } = context;

    // Ordered P0 (most critical) → P7 (lowest). First match wins.
    const checks = [
      this._checkCloseDate(deal, derived),
      this._checkBuyerEngagement(deal, derived, contacts),
      this._checkProcess(deal, derived, healthBreakdown),
      this._checkDealSize(deal, derived),
      this._checkCompetitive(deal, healthBreakdown),
      this._checkMomentum(deal, derived),
      this._checkContactCoverage(deal, derived, contacts),
      this._checkStageProgression(deal, derived),
    ];

    for (const result of checks) {
      if (result) return result;
    }

    return null;
  }

  // ── P0: Close Date ────────────────────────────────────────────────────────

  static _checkCloseDate(deal, derived) {
    if (derived.isPastClose) {
      return {
        hurdleType: 'close_date',
        title: 'Close date has passed',
        priority: 'critical',
        evidence: `Expected close was ${new Date(deal.expected_close_date || deal.close_date).toLocaleDateString()} — ${Math.abs(derived.daysUntilClose)} days overdue.`,
      };
    }
    if (derived.closingImminently) {
      return {
        hurdleType: 'close_date',
        title: 'Close date imminent with gaps',
        priority: 'critical',
        evidence: `Closing in ${derived.daysUntilClose} day(s) — ensure all steps are complete.`,
      };
    }
    return null;
  }

  // ── P1: Buyer Engagement ──────────────────────────────────────────────────

  static _checkBuyerEngagement(deal, derived, contacts) {
    if (derived.daysSinceLastEmail > 14 && derived.daysSinceLastMeeting > 14) {
      return {
        hurdleType: 'buyer_engagement',
        title: 'Buyer gone silent',
        priority: 'critical',
        evidence: `No email in ${derived.daysSinceLastEmail}d, no meeting in ${derived.daysSinceLastMeeting}d. Engagement has stalled.`,
      };
    }
    if (derived.unansweredEmails.length >= 2) {
      return {
        hurdleType: 'buyer_engagement',
        title: 'Multiple unanswered emails',
        priority: 'high',
        evidence: `${derived.unansweredEmails.length} sent emails with no response.`,
      };
    }
    return null;
  }

  // ── P2: Process ───────────────────────────────────────────────────────────

  static _checkProcess(deal, derived, healthBreakdown) {
    // No meetings at all in a deal that's been open > 7 days
    if (derived.completedMeetings.length === 0 && derived.daysInStage > 7) {
      return {
        hurdleType: 'process',
        title: 'No meetings conducted',
        priority: 'high',
        evidence: `Deal has been open ${derived.daysInStage} days with zero meetings completed.`,
      };
    }
    return null;
  }

  // ── P3: Deal Size ─────────────────────────────────────────────────────────

  static _checkDealSize(deal, derived) {
    if (derived.isHighValue && derived.decisionMakers.length === 0) {
      return {
        hurdleType: 'deal_size',
        title: 'High-value deal missing decision maker',
        priority: 'high',
        evidence: `Deal valued at $${parseFloat(deal.value || 0).toLocaleString()} has no decision maker contact linked.`,
      };
    }
    return null;
  }

  // ── P4: Competitive ───────────────────────────────────────────────────────

  static _checkCompetitive(deal, healthBreakdown) {
    const competitive = deal.competitive_deal_ai || healthBreakdown?.competitive;
    if (competitive && competitive !== 'none') {
      return {
        hurdleType: 'competitive',
        title: 'Competitive threat detected',
        priority: 'high',
        evidence: `Competitive signal detected: ${typeof competitive === 'string' ? competitive : 'active competition identified'}.`,
      };
    }
    return null;
  }

  // ── P5: Momentum ──────────────────────────────────────────────────────────

  static _checkMomentum(deal, derived) {
    if (derived.isStagnant) {
      return {
        hurdleType: 'momentum',
        title: 'Deal momentum stalled',
        priority: 'medium',
        evidence: `Deal has been in "${deal.stage}" for ${derived.daysInStage} days with no stage change.`,
      };
    }
    return null;
  }

  // ── P6: Contact Coverage ──────────────────────────────────────────────────

  static _checkContactCoverage(deal, derived, contacts) {
    if (contacts.length <= 1) {
      return {
        hurdleType: 'contact_coverage',
        title: 'Single-threaded deal',
        priority: 'medium',
        evidence: `Only ${contacts.length} contact(s) linked. Multi-threading is recommended to reduce risk.`,
      };
    }
    if (derived.champions.length === 0) {
      return {
        hurdleType: 'contact_coverage',
        title: 'No champion identified',
        priority: 'medium',
        evidence: 'No contact with "champion" role is linked to this deal.',
      };
    }
    return null;
  }

  // ── P7: Stage Progression ─────────────────────────────────────────────────

  static _checkStageProgression(deal, derived) {
    if (derived.daysInStage > 21 && !derived.isStagnant) {
      return {
        hurdleType: 'stage_progression',
        title: 'Slow stage progression',
        priority: 'low',
        evidence: `Deal has been in "${deal.stage}" for ${derived.daysInStage} days. Consider what's needed to advance.`,
      };
    }
    return null;
  }
}

module.exports = DealHurdleIdentifier;
