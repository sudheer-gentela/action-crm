/**
 * ProspectDiagnosticsEngine.js
 *
 * Writes ProspectHurdleIdentifier results as diagnostic alert rows
 * in `prospecting_actions` (Type A actions — source = 'auto_generated').
 *
 * This is the prospecting equivalent of ActionsRulesEngine (deals) and
 * CasesRulesEngine (cases). It follows the same upsert + resolve pattern
 * established in Phase 1.
 *
 * Called by:
 *   - prospectingActions.service.runNightlySweep()  — nightly, per-org
 *
 * Hurdle → source_rule mapping:
 *   ghosting            → prospect_ghosting
 *   conversion_ready    → prospect_conversion_ready
 *   stale_outreach      → prospect_stale_outreach
 *   no_meeting          → prospect_no_meeting
 *   no_research         → prospect_no_research
 *   wrong_channel       → prospect_wrong_channel
 *   multi_thread_needed → prospect_multi_thread
 *   low_icp             → prospect_low_icp
 *
 * Priority → due_date offset (days):
 *   critical  → 1
 *   high      → 3
 *   medium    → 7
 *   low       → 14
 *
 * DB requirement: unique partial index on prospecting_actions must exist:
 *   UNIQUE (prospect_id, source_rule) WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
 *   (added by migration_upsert_constraints.sql from Phase 1)
 */

const db                       = require('../config/database');
const ProspectContextBuilder   = require('./ProspectContextBuilder');
const ProspectHurdleIdentifier = require('./ProspectHurdleIdentifier');

// ── source_rule mapping ───────────────────────────────────────────────────────

const HURDLE_TO_SOURCE_RULE = {
  ghosting:            'prospect_ghosting',
  conversion_ready:    'prospect_conversion_ready',
  stale_outreach:      'prospect_stale_outreach',
  no_meeting:          'prospect_no_meeting',
  no_research:         'prospect_no_research',
  wrong_channel:       'prospect_wrong_channel',
  multi_thread_needed: 'prospect_multi_thread',
  low_icp:             'prospect_low_icp',
};

const DUE_OFFSET_BY_PRIORITY = {
  critical: 1,
  high:     3,
  medium:   7,
  low:      14,
};

// Stages where we skip diagnostics entirely (terminal / inactive)
const SKIP_STAGES = new Set(['converted', 'disqualified', 'archived']);

// ─────────────────────────────────────────────────────────────────────────────

class ProspectDiagnosticsEngine {

  /**
   * Run all diagnostic rules for a single prospect.
   * Upserts matching alerts. Resolves alerts whose condition has cleared.
   *
   * @param {number} prospectId
   * @param {number} orgId
   * @param {number} systemUserId  — org's system/bot user id for DB writes
   * @returns {{ upserted: number, resolved: number, skipped: boolean }}
   */
  static async runForProspect(prospectId, orgId, systemUserId) {
    // Build context (same as outreach composer — no extra DB calls downstream)
    let context;
    try {
      context = await ProspectContextBuilder.build(prospectId, systemUserId, orgId);
    } catch (err) {
      console.error(`[ProspectDiagnosticsEngine] Context build failed for prospect ${prospectId}:`, err.message);
      return { upserted: 0, resolved: 0, skipped: true };
    }

    const { prospect } = context;

    // Skip terminal stages — no point alerting on a closed/converted prospect
    if (SKIP_STAGES.has(prospect.stage)) {
      return { upserted: 0, resolved: 0, skipped: true };
    }

    // Identify ALL active hurdles for this prospect
    const hurdles = ProspectHurdleIdentifier.identifyAll(context);
    const firedSourceRules = [];

    let upserted = 0;

    for (const hurdle of hurdles) {
      const sourceRule = HURDLE_TO_SOURCE_RULE[hurdle.hurdleType];
      if (!sourceRule) continue; // safety — unmapped hurdle

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (DUE_OFFSET_BY_PRIORITY[hurdle.priority] || 7));

      try {
        const result = await db.query(
          `INSERT INTO prospecting_actions (
             org_id, user_id, prospect_id,
             title, description,
             action_type, channel,
             priority, due_date,
             source, source_rule,
             suggested_action,
             status
           ) VALUES (
             $1, $2, $3,
             $4, $5,
             'diagnostic', 'general',
             $6, $7,
             'auto_generated', $8,
             $9,
             'pending'
           )
           ON CONFLICT (prospect_id, source_rule)
           WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
           DO UPDATE SET
             title        = EXCLUDED.title,
             description  = EXCLUDED.description,
             priority     = EXCLUDED.priority,
             due_date     = EXCLUDED.due_date,
             updated_at   = NOW()
           -- Preserve: created_at, status (snooze / in_progress / completed)
           RETURNING id, (xmax = 0) AS inserted`,
          [
            orgId, systemUserId, prospect.id,
            hurdle.title, hurdle.evidence,
            hurdle.priority, dueDate,
            sourceRule,
            null, // suggested_action — diagnostics don't have a templated action body
          ]
        );

        if (result.rows[0]) upserted++;
        firedSourceRules.push(sourceRule);
      } catch (err) {
        console.error(
          `[ProspectDiagnosticsEngine] Upsert failed for prospect ${prospectId} rule ${sourceRule}:`,
          err.message
        );
      }
    }

    // Resolve alerts whose condition has now cleared
    const resolved = await this._resolveStale(prospect.id, orgId, firedSourceRules);

    return { upserted, resolved, skipped: false };
  }

  // ── Resolve stale diagnostic alerts ──────────────────────────────────────

  /**
   * Auto-complete any diagnostic alert for this prospect whose source_rule
   * was NOT in the current fired set (condition has cleared).
   *
   * Only resolves Type A rows (source = 'auto_generated').
   * Never touches playbook tasks (source = 'playbook') or STRAP actions (source = 'strap').
   * Never resolves snoozed or in_progress rows — reps manage those manually.
   *
   * @param {number} prospectId
   * @param {number} orgId
   * @param {string[]} firedSourceRules
   * @returns {number} count of rows resolved
   */
  static async _resolveStale(prospectId, orgId, firedSourceRules) {
    try {
      const result = await db.query(
        `UPDATE prospecting_actions
         SET
           status          = 'completed',
           auto_completed  = true,
           completed_at    = NOW(),
           updated_at      = NOW()
         WHERE
           prospect_id = $1
           AND org_id  = $2
           AND source  = 'auto_generated'
           AND status  = 'pending'
           AND source_rule IS NOT NULL
           ${firedSourceRules.length > 0
             ? `AND source_rule != ALL($3::text[])`
             : '-- no fired rules, resolve all auto_generated pending'
           }`,
        firedSourceRules.length > 0
          ? [prospectId, orgId, firedSourceRules]
          : [prospectId, orgId]
      );
      return result.rowCount || 0;
    } catch (err) {
      console.error(
        `[ProspectDiagnosticsEngine] Resolve stale failed for prospect ${prospectId}:`,
        err.message
      );
      return 0;
    }
  }
}

module.exports = ProspectDiagnosticsEngine;
