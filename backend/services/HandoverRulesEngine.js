/**
 * HandoverRulesEngine.js
 *
 * Pure diagnostic rules for the Sales → Implementation Handover module.
 *
 * Contract (mirrors ActionsRulesEngine / CasesRulesEngine pattern):
 *   - Takes a pre-built context object. NO database calls inside this file.
 *   - Returns an array of action-shape objects for every rule that fires.
 *   - Callers (handover.service.runNightlySweep) pass the results to
 *     ActionPersister.upsertDiagnosticAlert() one at a time, then call
 *     ActionPersister.resolveStaleDiagnostics() with the fired source_rules.
 *
 * Persistence note (architectural decision — Section 13 point 7 of handover doc):
 *   Handover diagnostic alerts are written to the `actions` table using
 *   deal_id as the FK (not handover_id — no such FK exists on actions).
 *   All source_rule values are prefixed `handover_` to distinguish them from
 *   deal diagnostics on the same deal_id.
 *   ActionPersister already handles this: entityType='handover' maps to deal_id.
 *
 * Context shape (built by handover.service.buildHandoverContext):
 * {
 *   handover: {
 *     id, org_id, deal_id, account_id,
 *     assigned_service_owner_id,
 *     status,                         // draft|submitted|acknowledged|in_progress
 *     go_live_date,                   // date | null
 *     commercial_terms_summary,       // text | null
 *     submitted_at,                   // timestamptz | null
 *     acknowledged_at,                // timestamptz | null
 *     created_at, updated_at,
 *   },
 *   derived: {
 *     daysSinceCreated,               // integer
 *     daysSinceLastActivity,          // integer — days since updated_at
 *     hasKickoffMeeting,              // boolean — meeting with handover_id linked
 *     overdueCommitments,             // commitment rows with due_date < today
 *     missingRequiredRoles,           // string[] — required handover_role values absent
 *     briefIsComplete,                // boolean — all required brief fields populated
 *   },
 * }
 *
 * Rules catalogue:
 *   handover_no_kickoff          created > 5 days, no kickoff meeting found
 *   handover_commitment_overdue  ≥1 commitment with due_date in the past
 *   handover_stakeholder_gap     required role(s) missing in stakeholders
 *   handover_stalled             no activity on handover > 7 days
 *   handover_incomplete_brief    go_live_date set but brief fields empty
 */

'use strict';

// ── Thresholds ────────────────────────────────────────────────────────────────

const NO_KICKOFF_DAYS  = 5;   // days after creation before no-kickoff rule fires
const STALLED_DAYS     = 7;   // days with no activity before stalled rule fires

// Roles that must be present in sales_handover_stakeholders for a complete handover.
// 'other' is intentionally excluded — it is a catch-all, not a required role.
const REQUIRED_STAKEHOLDER_ROLES = [
  'implementation_lead',
  'day_to_day_admin',
  'go_live_approver',
];

// Statuses where diagnostic rules are active.
// 'draft' is excluded — handover is not yet formally active.
const ACTIVE_STATUSES = new Set(['submitted', 'acknowledged', 'in_progress']);

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Evaluate all diagnostic rules for a single handover.
 *
 * @param {object} ctx  — context built by handover.service.buildHandoverContext()
 * @returns {Array<{sourceRule, title, description, priority, nextStep}>}
 */
function evaluate(ctx) {
  const { handover: h, derived } = ctx;

  // Only fire rules on active handovers (submitted → in_progress).
  // Draft handovers are incomplete by design; in_progress is terminal for us
  // but still needs monitoring until the implementation module takes over.
  if (!ACTIVE_STATUSES.has(h.status)) return [];

  const now   = new Date();
  const fired = [];

  // ── handover_no_kickoff ───────────────────────────────────────────────────
  // Handover has been active for > NO_KICKOFF_DAYS with no kickoff meeting
  // linked in the meetings table.
  if (
    derived.daysSinceCreated > NO_KICKOFF_DAYS &&
    derived.hasKickoffMeeting === false
  ) {
    fired.push({
      sourceRule:  'handover_no_kickoff',
      title:       'No kickoff meeting scheduled',
      description: `This handover was created ${derived.daysSinceCreated} days ago but no kickoff meeting has been recorded. Schedule the implementation kickoff to get the customer onboarded.`,
      priority:    'high',
      nextStep:    'internal_task',
    });
  }

  // ── handover_commitment_overdue ───────────────────────────────────────────
  // One or more commitments in sales_handover_commitments have a due_date
  // that has passed. Requires the due_date column added in migration_phase2.sql.
  if (derived.overdueCommitments && derived.overdueCommitments.length > 0) {
    const count = derived.overdueCommitments.length;
    const types = [...new Set(derived.overdueCommitments.map(c => c.commitment_type))].join(', ');
    fired.push({
      sourceRule:  'handover_commitment_overdue',
      title:       `${count} overdue commitment${count !== 1 ? 's' : ''}`,
      description: `${count} sales commitment${count !== 1 ? 's' : ''} (${types}) ${count !== 1 ? 'are' : 'is'} past the agreed due date. Review these commitments with the service team and update or resolve them.`,
      priority:    'high',
      nextStep:    'internal_task',
    });
  }

  // ── handover_stakeholder_gap ──────────────────────────────────────────────
  // One or more required stakeholder roles are absent from
  // sales_handover_stakeholders. Implementation cannot proceed without
  // knowing who the day-to-day admin, implementation lead, and approver are.
  if (derived.missingRequiredRoles && derived.missingRequiredRoles.length > 0) {
    const missing = derived.missingRequiredRoles
      .map(r => r.replace(/_/g, ' '))
      .join(', ');
    fired.push({
      sourceRule:  'handover_stakeholder_gap',
      title:       'Required stakeholder roles missing',
      description: `The following stakeholder roles have not been filled: ${missing}. Add the relevant contacts before handover can be fully completed.`,
      priority:    'medium',
      nextStep:    'internal_task',
    });
  }

  // ── handover_stalled ─────────────────────────────────────────────────────
  // No update to the handover record in > STALLED_DAYS days.
  // Indicates the sales → service transition may have been forgotten.
  if (
    derived.daysSinceLastActivity != null &&
    derived.daysSinceLastActivity > STALLED_DAYS
  ) {
    fired.push({
      sourceRule:  'handover_stalled',
      title:       `Handover stalled for ${derived.daysSinceLastActivity} days`,
      description: `No progress has been recorded on this handover in ${derived.daysSinceLastActivity} days. Check in with the service owner and move the handover forward.`,
      priority:    'medium',
      nextStep:    'internal_task',
    });
  }

  // ── handover_incomplete_brief ─────────────────────────────────────────────
  // Handover has a go-live date set (i.e. the clock is running) but the brief
  // is not complete. The service team cannot prepare without key information.
  if (h.go_live_date != null && derived.briefIsComplete === false) {
    fired.push({
      sourceRule:  'handover_incomplete_brief',
      title:       'Handover brief is incomplete',
      description: `A go-live date is set but the handover brief is missing required information. Complete the commercial summary and ensure all key fields are filled before the service team begins onboarding.`,
      priority:    'high',
      nextStep:    'internal_task',
    });
  }

  return fired;
}

// ── Exported helpers (used by context builder) ────────────────────────────────

/**
 * The canonical list of required stakeholder roles.
 * Exported so buildHandoverContext can use the same list without duplication.
 */
const REQUIRED_ROLES = REQUIRED_STAKEHOLDER_ROLES;

module.exports = { evaluate, REQUIRED_ROLES };
