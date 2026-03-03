/**
 * ProspectHurdleIdentifier.js
 *
 * Identifies the highest-priority hurdle blocking prospect progression.
 * Hurdle types from the handoff spec — ordered by priority.
 *
 * Returns: { hurdleType, title, priority, evidence } or null.
 */

class ProspectHurdleIdentifier {

  /**
   * @param {object} context - from ProspectContextBuilder
   * @returns {{ hurdleType: string, title: string, priority: string, evidence: string } | null}
   */
  static identify(context) {
    const { prospect, derived, icpBreakdown, stageGuidance } = context;

    const checks = [
      this._checkGhosting(prospect, derived),
      this._checkConversionReady(prospect, derived),
      this._checkStaleOutreach(prospect, derived),
      this._checkNoMeeting(prospect, derived),
      this._checkNoResearch(prospect, derived),
      this._checkWrongChannel(prospect, derived),
      this._checkMultiThreadNeeded(prospect, derived),
      this._checkLowIcp(prospect, icpBreakdown),
    ];

    for (const result of checks) {
      if (result) return result;
    }

    return null;
  }

  // ── ghosting: 3+ outreach attempts with zero response ─────────────────────

  static _checkGhosting(prospect, derived) {
    if (derived.isGhosting) {
      return {
        hurdleType: 'ghosting',
        title: 'Prospect ghosting',
        priority: 'critical',
        evidence: `${prospect.outreach_count} outreach attempts with zero responses over ${derived.daysSinceLastOutreach || '?'} days.`,
      };
    }
    return null;
  }

  // ── conversion_ready: high engagement but still pre-deal ──────────────────

  static _checkConversionReady(prospect, derived) {
    if (derived.isHotLead && !['converted', 'qualified'].includes(prospect.stage)) {
      return {
        hurdleType: 'conversion_ready',
        title: 'Ready for conversion',
        priority: 'critical',
        evidence: `High engagement signals (${(derived.responseRate * 100).toFixed(0)}% response rate, responded ${derived.daysSinceLastResponse}d ago) but still in "${prospect.stage}" stage.`,
      };
    }
    return null;
  }

  // ── stale_outreach: no outreach in 14+ days ───────────────────────────────

  static _checkStaleOutreach(prospect, derived) {
    if (derived.isStale && !derived.isGhosting) {
      return {
        hurdleType: 'stale_outreach',
        title: 'Outreach gone stale',
        priority: 'high',
        evidence: `No outreach in ${derived.daysSinceLastOutreach} days. Prospect may lose awareness.`,
      };
    }
    return null;
  }

  // ── no_meeting: engaged prospect with no meeting scheduled ────────────────

  static _checkNoMeeting(prospect, derived) {
    if (derived.hasReplied && prospect.response_count >= 1) {
      // Check if prospect is in an engagement-ready stage
      const meetingStages = ['engaged', 'qualified', 'meeting_scheduled'];
      if (['engaged', 'qualified'].includes(prospect.stage)) {
        return {
          hurdleType: 'no_meeting',
          title: 'Engaged but no meeting',
          priority: 'high',
          evidence: `Prospect has responded ${prospect.response_count} time(s) and is in "${prospect.stage}" stage, but no meeting is scheduled.`,
        };
      }
    }
    return null;
  }

  // ── no_research: prospect in targeting/research stage with no notes ────────

  static _checkNoResearch(prospect, derived) {
    if (['targeting', 'research'].includes(prospect.stage) && !prospect.research_notes) {
      return {
        hurdleType: 'no_research',
        title: 'No research completed',
        priority: 'medium',
        evidence: `Prospect is in "${prospect.stage}" stage but has no research notes. Research is needed before outreach.`,
      };
    }
    return null;
  }

  // ── wrong_channel: low response rate on current channel ───────────────────

  static _checkWrongChannel(prospect, derived) {
    if (prospect.outreach_count >= 3 && derived.responseRate < 0.1 && prospect.preferred_channel) {
      return {
        hurdleType: 'wrong_channel',
        title: 'Channel not working',
        priority: 'medium',
        evidence: `${prospect.outreach_count} attempts via ${prospect.preferred_channel || 'current channel'} with ${(derived.responseRate * 100).toFixed(0)}% response rate. Consider switching channels.`,
      };
    }
    return null;
  }

  // ── multi_thread_needed: only one prospect at company ─────────────────────

  static _checkMultiThreadNeeded(prospect, derived) {
    if (derived.otherProspectsAtCompany.length === 0 && prospect.outreach_count >= 2) {
      return {
        hurdleType: 'multi_thread_needed',
        title: 'Single entry point',
        priority: 'medium',
        evidence: `Only one prospect at ${prospect.company_name || 'this company'}. Adding more entry points increases conversion probability.`,
      };
    }
    return null;
  }

  // ── low_icp: ICP score below threshold ────────────────────────────────────

  static _checkLowIcp(prospect, icpBreakdown) {
    if (prospect.icp_score !== null && prospect.icp_score !== undefined && prospect.icp_score < 30) {
      return {
        hurdleType: 'low_icp',
        title: 'Low ICP fit',
        priority: 'low',
        evidence: `ICP score is ${prospect.icp_score}/100. Consider disqualifying or deprioritizing this prospect.`,
      };
    }
    return null;
  }
}

module.exports = ProspectHurdleIdentifier;
