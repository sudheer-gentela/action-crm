/**
 * ImplementationHurdleIdentifier.js
 *
 * Identifies the highest-priority hurdle blocking implementation success.
 * Implementation STRAPs attach to deals in closed_won stage.
 * Uses DealContextBuilder context (same shape as deal context).
 *
 * Returns: { hurdleType, title, priority, evidence } or null.
 */

class ImplementationHurdleIdentifier {

  /**
   * @param {object} context - from DealContextBuilder (closed_won deal)
   * @returns {{ hurdleType: string, title: string, priority: string, evidence: string } | null}
   */
  static identify(context) {
    const { deal, contacts, derived } = context;

    const checks = [
      this._checkKickoffDelayed(deal, derived),
      this._checkStakeholderGap(deal, contacts),
      this._checkHandoffIncomplete(deal, derived, contacts),
      this._checkMilestoneBlocked(deal, derived),
      this._checkEscalationNeeded(deal, derived),
      this._checkAdoptionRisk(deal, derived),
    ];

    for (const result of checks) {
      if (result) return result;
    }

    return null;
  }

  // ── kickoff_delayed: won deal with no implementation kickoff ───────────────

  static _checkKickoffDelayed(deal, derived) {
    // Won deal with no meetings after close
    if (deal.stage === 'closed_won' && derived.completedMeetings.length === 0) {
      const daysSinceWon = derived.daysInStage || 0;
      if (daysSinceWon > 5) {
        return {
          hurdleType: 'kickoff_delayed',
          title: 'Implementation kickoff delayed',
          priority: 'critical',
          evidence: `Deal was won ${daysSinceWon} days ago but no meetings have been scheduled or completed. Kickoff is overdue.`,
        };
      }
    }
    return null;
  }

  // ── stakeholder_gap: missing key stakeholders ─────────────────────────────

  static _checkStakeholderGap(deal, contacts) {
    const roles = new Set(contacts.map(c => c.role_type).filter(Boolean));
    const criticalRoles = ['executive', 'it', 'security'];
    const missingCritical = criticalRoles.filter(r => !roles.has(r));

    // Only flag if we have very few contacts for implementation
    if (contacts.length < 3 && deal.stage === 'closed_won') {
      return {
        hurdleType: 'stakeholder_gap',
        title: 'Implementation missing key stakeholders',
        priority: 'high',
        evidence: `Only ${contacts.length} contact(s) linked. Implementation typically needs IT, security, and executive sponsor involvement.`,
      };
    }
    return null;
  }

  // ── handoff_incomplete: sales-to-CS handoff missing context ────────────────

  static _checkHandoffIncomplete(deal, derived, contacts) {
    // If deal was won recently and there's minimal documentation
    if (deal.stage === 'closed_won' && derived.daysInStage <= 14) {
      const hasNotes = deal.notes && deal.notes.length > 50;
      const hasFiles = derived.failedFiles !== undefined; // proxy: files panel exists
      if (!hasNotes && contacts.length <= 2) {
        return {
          hurdleType: 'handoff_incomplete',
          title: 'Sales handoff incomplete',
          priority: 'high',
          evidence: `Recently won deal with minimal notes and only ${contacts.length} contact(s). CS team needs more context for successful implementation.`,
        };
      }
    }
    return null;
  }

  // ── milestone_blocked: implementation milestone overdue ────────────────────

  static _checkMilestoneBlocked(deal, derived) {
    // Use staleness as a proxy for blocked milestones
    if (deal.stage === 'closed_won' && derived.daysSinceLastMeeting > 21 && derived.daysInStage > 21) {
      return {
        hurdleType: 'milestone_blocked',
        title: 'Implementation milestone may be blocked',
        priority: 'medium',
        evidence: `No meeting activity in ${derived.daysSinceLastMeeting} days during implementation phase.`,
      };
    }
    return null;
  }

  // ── escalation_needed: issue requiring executive attention ─────────────────

  static _checkEscalationNeeded(deal, derived) {
    // Multiple unanswered emails post-close suggests an issue
    if (deal.stage === 'closed_won' && derived.unansweredEmails.length >= 3) {
      return {
        hurdleType: 'escalation_needed',
        title: 'Escalation may be needed',
        priority: 'high',
        evidence: `${derived.unansweredEmails.length} unanswered emails during implementation. Customer may be blocked and needs executive escalation.`,
      };
    }
    return null;
  }

  // ── adoption_risk: low product adoption signals ───────────────────────────

  static _checkAdoptionRisk(deal, derived) {
    // Long time since close with no engagement
    if (deal.stage === 'closed_won' && derived.daysInStage > 45 && derived.daysSinceLastEmail > 30) {
      return {
        hurdleType: 'adoption_risk',
        title: 'Adoption risk detected',
        priority: 'medium',
        evidence: `Deal was won ${derived.daysInStage} days ago with no email engagement in ${derived.daysSinceLastEmail} days. Product adoption may be stalling.`,
      };
    }
    return null;
  }
}

module.exports = ImplementationHurdleIdentifier;
