/**
 * CasesRulesEngine.js
 *
 * Pure diagnostic rules for the Cases (Support) module.
 *
 * Contract (mirrors ActionsRulesEngine pattern):
 *   - Takes a pre-built context object. NO database calls inside this file.
 *   - Returns an array of action-shape objects for every rule that fires.
 *   - Callers (supportService.runNightlySweep) pass the results to
 *     ActionPersister.upsertDiagnosticAlert() one at a time, then call
 *     ActionPersister.resolveStaleDiagnostics() with the fired source_rules.
 *
 * Context shape (built by supportService.buildCaseContext):
 * {
 *   case: {
 *     id, org_id, case_number, status, priority,
 *     assigned_to,
 *     response_due_at, resolution_due_at,
 *     first_responded_at, resolved_at, closed_at,
 *     response_breached, resolution_breached,
 *     created_at, updated_at,
 *   },
 *   derived: {
 *     daysSinceLastActivity,    // days since last note or status change
 *     daysSincePendingCustomer, // days in pending_customer (null if not in that status)
 *   },
 * }
 *
 * Rules catalogue:
 *   case_unassigned          assigned_to IS NULL
 *   case_no_response         first_responded_at IS NULL AND now > response_due_at
 *   case_resolution_overdue  resolved_at IS NULL AND now > resolution_due_at
 *   case_stale               no activity > 5 days (non-closed, non-pending)
 *   case_pending_too_long    pending_customer > 7 days
 *   case_escalation_needed   priority = critical AND resolution_breached = true
 */

'use strict';

// ── Default thresholds (overridden by org config passed into evaluate()) ──────

const DEFAULT_STALE_DAYS            = 5;
const DEFAULT_PENDING_TOO_LONG_DAYS = 7;

// Terminal statuses — no diagnostic rules fire for these
const TERMINAL_STATUSES = new Set(['resolved', 'closed']);

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Evaluate all diagnostic rules for a single case.
 *
 * @param {object} ctx  — context object built by supportService.buildCaseContext()
 * @returns {Array<{sourceRule, title, description, priority, nextStep}>}
 */
function evaluate(ctx, config = {}) {
  const { case: c, derived } = ctx;

  const STALE_DAYS            = config.stale_days            ?? DEFAULT_STALE_DAYS;
  const PENDING_TOO_LONG_DAYS = config.pending_too_long_days ?? DEFAULT_PENDING_TOO_LONG_DAYS;

  if (TERMINAL_STATUSES.has(c.status)) return [];

  const now   = new Date();
  const fired = [];

  // ── case_unassigned ───────────────────────────────────────────────────────
  // No agent assigned — case cannot progress, SLA clock is running.
  if (c.assigned_to == null) {
    fired.push({
      sourceRule:  'case_unassigned',
      title:       'Case has no assigned agent',
      description: `Case ${c.case_number || c.id} is unassigned. Assign an agent to ensure the case is actioned and SLA is met.`,
      priority:    'high',
      nextStep:    'internal_task',
    });
  }

  // ── case_no_response ──────────────────────────────────────────────────────
  // SLA response window passed with no first response logged.
  if (
    c.first_responded_at == null &&
    c.response_due_at    != null &&
    now > new Date(c.response_due_at)
  ) {
    const hoursOverdue = Math.round(
      (now - new Date(c.response_due_at)) / (1000 * 60 * 60)
    );
    fired.push({
      sourceRule:  'case_no_response',
      title:       'First response SLA breached',
      description: `No first response has been sent on case ${c.case_number || c.id}. The SLA response window passed ${hoursOverdue} hour${hoursOverdue !== 1 ? 's' : ''} ago. Contact the customer immediately.`,
      priority:    'high',
      nextStep:    'email',
    });
  }

  // ── case_resolution_overdue ───────────────────────────────────────────────
  // Resolution deadline passed, case still unresolved.
  if (
    c.resolved_at       == null &&
    c.closed_at         == null &&
    c.resolution_due_at != null &&
    now > new Date(c.resolution_due_at)
  ) {
    const hoursOverdue = Math.round(
      (now - new Date(c.resolution_due_at)) / (1000 * 60 * 60)
    );
    fired.push({
      sourceRule:  'case_resolution_overdue',
      title:       'Resolution SLA breached',
      description: `Case ${c.case_number || c.id} has not been resolved. The resolution SLA passed ${hoursOverdue} hour${hoursOverdue !== 1 ? 's' : ''} ago. Escalate or resolve now.`,
      priority:    'high',
      nextStep:    'internal_task',
    });
  }

  // ── case_stale ────────────────────────────────────────────────────────────
  // No note or status change in > STALE_DAYS days.
  // Excluded for pending_customer — that status has its own rule below.
  if (
    c.status !== 'pending_customer' &&
    derived.daysSinceLastActivity != null &&
    derived.daysSinceLastActivity > STALE_DAYS
  ) {
    fired.push({
      sourceRule:  'case_stale',
      title:       `Case stale for ${derived.daysSinceLastActivity} days`,
      description: `No activity has been recorded on case ${c.case_number || c.id} in ${derived.daysSinceLastActivity} days. Add an update or move the case forward.`,
      priority:    'medium',
      nextStep:    'internal_task',
    });
  }

  // ── case_pending_too_long ─────────────────────────────────────────────────
  // Case has been waiting on customer response for > PENDING_TOO_LONG_DAYS.
  if (
    c.status === 'pending_customer' &&
    derived.daysSincePendingCustomer != null &&
    derived.daysSincePendingCustomer > PENDING_TOO_LONG_DAYS
  ) {
    fired.push({
      sourceRule:  'case_pending_too_long',
      title:       `Pending customer response for ${derived.daysSincePendingCustomer} days`,
      description: `Case ${c.case_number || c.id} has been waiting on the customer for ${derived.daysSincePendingCustomer} days with no reply. Follow up to prevent the case going cold.`,
      priority:    'medium',
      nextStep:    'email',
    });
  }

  // ── case_escalation_needed ────────────────────────────────────────────────
  // Critical priority + resolution SLA already breached → escalate now.
  if (c.priority === 'critical' && c.resolution_breached === true) {
    fired.push({
      sourceRule:  'case_escalation_needed',
      title:       'Critical case requires management escalation',
      description: `Case ${c.case_number || c.id} is critical priority and has breached its resolution SLA. Escalate to management and loop in senior support immediately.`,
      priority:    'critical',
      nextStep:    'internal_task',
    });
  }

  return fired;
}

module.exports = { evaluate };
