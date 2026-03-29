/**
 * ActionPersister.js
 *
 * Single shared module for all action persistence across every module.
 * No service file should ever write raw INSERT/DELETE directly to the
 * actions or prospecting_actions tables for auto-generated content.
 *
 * Three methods covering the two action types:
 *
 *   upsertDiagnosticAlert(params)
 *     → Type A: condition-based alerts. Inserts on first occurrence,
 *       updates title/description/due_date on subsequent nightly runs.
 *       Preserves created_at (age tracking) and status (snooze/in_progress).
 *       Requires: uq_actions_*_source_rule unique index to exist.
 *
 *   resolveStaleDiagnostics(params)
 *     → Marks as completed any diagnostic alerts whose conditions are no
 *       longer true. Sets auto_completed=true so UI can distinguish from
 *       manual completion. Preserves the row for audit history.
 *
 *   writePlaybookTask(params)
 *     → Type B: playbook play tasks. Inserts once on stage entry.
 *       ON CONFLICT (entity_fk, playbook_play_id) DO NOTHING means
 *       re-runs on the same stage are silently ignored.
 *       Delegates to ActionWriter for prospecting_actions.
 *
 * Ecosystem routing:
 *   entityType 'deal' | 'contract' | 'case' | 'handover' → actions table
 *   entityType 'prospect'                                  → prospecting_actions table
 *
 * Dependencies:
 *   DB unique indexes from migration_upsert_constraints.sql must exist.
 *   ActionWriter.js for playbook task writes (avoids duplicating that logic).
 */

'use strict';

const db           = require('../config/database');
const ActionWriter = require('./ActionWriter');

// ── FK column map — actions table ─────────────────────────────────────────────
const FK_COLUMN = {
  deal:      'deal_id',
  handover:  'deal_id',   // handover actions stored against deal_id
  contract:  'contract_id',
  case:      'case_id',
};

// ── Unique index column map — for ON CONFLICT targeting ───────────────────────
// Must match the indexes created in migration_upsert_constraints.sql exactly.
const UPSERT_CONFLICT_COLS = {
  deal:      '(deal_id, source_rule)     WHERE deal_id IS NOT NULL AND source_rule IS NOT NULL',
  handover:  '(deal_id, source_rule)     WHERE deal_id IS NOT NULL AND source_rule IS NOT NULL',
  contract:  '(contract_id, source_rule) WHERE contract_id IS NOT NULL AND source_rule IS NOT NULL',
  case:      '(case_id, source_rule)     WHERE case_id IS NOT NULL AND source_rule IS NOT NULL',
};

const PLAY_CONFLICT_COLS = {
  deal:      '(deal_id, playbook_play_id)      WHERE deal_id IS NOT NULL AND playbook_play_id IS NOT NULL',
  handover:  '(deal_id, playbook_play_id)      WHERE deal_id IS NOT NULL AND playbook_play_id IS NOT NULL',
  contract:  '(contract_id, playbook_play_id)  WHERE contract_id IS NOT NULL AND playbook_play_id IS NOT NULL',
  case:      '(case_id, playbook_play_id)      WHERE case_id IS NOT NULL AND playbook_play_id IS NOT NULL',
};

// ── Valid values from DB CHECK constraints ────────────────────────────────────
const VALID_NEXT_STEPS = new Set([
  'email', 'call', 'whatsapp', 'linkedin', 'slack', 'document', 'internal_task',
]);

const VALID_STATUS = new Set([
  'yet_to_start', 'in_progress', 'completed', 'snoozed',
]);

class ActionPersister {

  // ══════════════════════════════════════════════════════════════════════════
  // upsertDiagnosticAlert
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Upsert a single diagnostic alert for an entity.
   *
   * On INSERT: creates fresh row with created_at = NOW().
   * On CONFLICT: updates title, description, due_date, updated_at only.
   *   - created_at is NOT touched — age is preserved.
   *   - status is NOT touched — snooze/in_progress is preserved.
   *
   * @param {object} params
   * @param {string}  params.entityType   — 'deal'|'contract'|'case'|'handover'|'prospect'
   * @param {number}  params.entityId
   * @param {string}  params.sourceRule   — e.g. 'health_2a_no_buyer', 'clm_expiring_soon'
   * @param {string}  params.title
   * @param {string}  [params.description]
   * @param {string}  [params.actionType] — defaults to 'task_complete'
   * @param {string}  [params.priority]   — defaults to 'medium'
   * @param {Date}    [params.dueDate]
   * @param {string}  [params.nextStep]   — defaults to 'email'
   * @param {boolean} [params.isInternal] — defaults to false
   * @param {string}  [params.suggestedAction]
   * @param {string}  [params.healthParam]
   * @param {string}  [params.dealStage]
   * @param {number}  [params.dealId]     — explicit deal_id override (for handovers)
   * @param {number}  [params.accountId]
   * @param {number}  [params.contactId]
   * @param {number}  params.orgId
   * @param {number}  params.userId
   * @returns {Promise<number|null>}  inserted/updated row id, or null on skip
   */
  static async upsertDiagnosticAlert(params) {
    const {
      entityType, entityId, sourceRule,
      title, description = null,
      actionType = 'task_complete',
      priority = 'medium',
      dueDate = null,
      nextStep = 'email',
      isInternal = false,
      suggestedAction = null,
      healthParam = null,
      dealStage = null,
      accountId = null,
      contactId = null,
      orgId, userId,
    } = params;

    // Explicit dealId override — used when entityType='handover' passes its deal_id
    const explicitDealId = params.dealId || null;

    if (entityType === 'prospect') {
      return this._upsertProspectDiagnostic(params);
    }

    const fkCol     = FK_COLUMN[entityType];
    const fkValue   = explicitDealId || entityId;
    const safeNext  = VALID_NEXT_STEPS.has(nextStep) ? nextStep : 'email';
    const conflictCols = UPSERT_CONFLICT_COLS[entityType];

    if (!fkCol || !conflictCols) {
      console.error(`[ActionPersister] Unknown entityType for upsert: ${entityType}`);
      return null;
    }

    // Resolve deal_id for non-deal entities that still need it for linking
    const dealId = (entityType === 'deal' || entityType === 'handover')
      ? fkValue
      : (params.dealId || null);

    try {
      const result = await db.query(
        `INSERT INTO actions (
           org_id, user_id,
           ${fkCol},
           deal_id, account_id, contact_id,
           type, action_type,
           title, description,
           priority, due_date,
           next_step, is_internal,
           source, source_rule,
           suggested_action, health_param, deal_stage,
           status, created_at, updated_at
         ) VALUES (
           $1, $2,
           $3,
           $4, $5, $6,
           $7, $7,
           $8, $9,
           $10, $11,
           $12, $13,
           'auto_generated', $14,
           $15, $16, $17,
           'yet_to_start', NOW(), NOW()
         )
         ON CONFLICT ${conflictCols}
         DO UPDATE SET
           title            = EXCLUDED.title,
           description      = EXCLUDED.description,
           due_date         = EXCLUDED.due_date,
           priority         = EXCLUDED.priority,
           suggested_action = EXCLUDED.suggested_action,
           updated_at       = NOW()
           -- created_at intentionally NOT updated — preserves alert age
           -- status intentionally NOT updated — preserves snooze/in_progress
         RETURNING id`,
        [
          orgId, userId,
          fkValue,
          dealId, accountId, contactId,
          actionType,
          title, description,
          priority, dueDate,
          safeNext, isInternal,
          sourceRule,
          suggestedAction, healthParam, dealStage,
        ]
      );
      return result.rows[0]?.id ?? null;
    } catch (err) {
      console.error(`[ActionPersister] upsertDiagnosticAlert failed (${entityType}/${entityId} rule=${sourceRule}):`, err.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // resolveStaleDiagnostics
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Auto-complete any diagnostic alerts for this entity whose source_rule
   * was NOT in the set of rules that fired this nightly run.
   *
   * This is how conditions that are no longer true get cleaned up without
   * deleting the row — the history is preserved, the rep's queue is cleared.
   *
   * @param {object}   params
   * @param {string}   params.entityType    — 'deal'|'contract'|'case'|'handover'|'prospect'
   * @param {number}   params.entityId
   * @param {string[]} params.firedRules    — source_rule values that ARE still true
   * @param {number}   params.orgId
   * @returns {Promise<number>}  count of rows resolved
   */
  static async resolveStaleDiagnostics({ entityType, entityId, firedRules, orgId }) {
    if (entityType === 'prospect') {
      return this._resolveProspectStaleDiagnostics({ entityId, firedRules, orgId });
    }

    const fkCol = FK_COLUMN[entityType];
    if (!fkCol) {
      console.error(`[ActionPersister] Unknown entityType for resolve: ${entityType}`);
      return 0;
    }

    // fkValue: for handovers the entityId IS the deal_id
    const fkValue = entityId;

    // Nothing fired means all diagnostics should be resolved
    const rulesList = firedRules && firedRules.length > 0 ? firedRules : null;

    try {
      let query, queryParams;

      if (rulesList) {
        query = `
          UPDATE actions SET
            status         = 'completed',
            auto_completed = true,
            completed_at   = NOW(),
            updated_at     = NOW()
          WHERE ${fkCol}   = $1
            AND org_id     = $2
            AND source     = 'auto_generated'
            AND source_rule IS NOT NULL
            AND source_rule != ALL($3::text[])
            AND status     != 'completed'
          RETURNING id`;
        queryParams = [fkValue, orgId, rulesList];
      } else {
        query = `
          UPDATE actions SET
            status         = 'completed',
            auto_completed = true,
            completed_at   = NOW(),
            updated_at     = NOW()
          WHERE ${fkCol}   = $1
            AND org_id     = $2
            AND source     = 'auto_generated'
            AND source_rule IS NOT NULL
            AND status     != 'completed'
          RETURNING id`;
        queryParams = [fkValue, orgId];
      }

      const result = await db.query(query, queryParams);
      return result.rowCount ?? 0;
    } catch (err) {
      console.error(`[ActionPersister] resolveStaleDiagnostics failed (${entityType}/${entityId}):`, err.message);
      return 0;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // writePlaybookTask
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Write a playbook task (Type B) for an entity.
   *
   * Delegates to ActionWriter which already uses ON CONFLICT DO NOTHING.
   * With the unique indexes now in place, that conflict is properly detectable.
   *
   * @param {object}     params
   * @param {string}     params.entityType
   * @param {number}     params.entityId
   * @param {object[]}   params.actions      — from PlaybookActionGenerator.generate()
   * @param {number}     params.playbookId
   * @param {string}     params.playbookName
   * @param {number}     params.orgId
   * @param {number}     params.userId
   * @returns {Promise<{ inserted: number, skipped: number, ids: number[] }>}
   */
  static async writePlaybookTask(params) {
    return ActionWriter.write(params);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private — prospecting_actions variants
  // ══════════════════════════════════════════════════════════════════════════

  static async _upsertProspectDiagnostic(params) {
    const {
      entityId: prospectId,
      sourceRule, title, description = null,
      actionType = 'outreach',
      priority = 'medium',
      dueDate = null,
      suggestedAction = null,
      orgId, userId,
    } = params;

    // prospecting_actions channel CHECK: email|linkedin|phone|sms|whatsapp
    // Diagnostic alerts default to null channel (no specific channel required)
    try {
      const result = await db.query(
        `INSERT INTO prospecting_actions (
           org_id, user_id, prospect_id,
           title, description,
           action_type,
           priority, due_date,
           source, source_rule,
           suggested_action,
           status, created_at, updated_at
         ) VALUES (
           $1, $2, $3,
           $4, $5,
           $6,
           $7, $8,
           'auto_generated', $9,
           $10,
           'pending', NOW(), NOW()
         )
         ON CONFLICT (prospect_id, source_rule)
           WHERE prospect_id IS NOT NULL AND source_rule IS NOT NULL
         DO UPDATE SET
           title            = EXCLUDED.title,
           description      = EXCLUDED.description,
           due_date         = EXCLUDED.due_date,
           priority         = EXCLUDED.priority,
           suggested_action = EXCLUDED.suggested_action,
           updated_at       = NOW()
         RETURNING id`,
        [
          orgId, userId, prospectId,
          title, description,
          actionType,
          priority, dueDate,
          sourceRule,
          suggestedAction,
        ]
      );
      return result.rows[0]?.id ?? null;
    } catch (err) {
      console.error(`[ActionPersister] _upsertProspectDiagnostic failed (prospect/${prospectId} rule=${sourceRule}):`, err.message);
      return null;
    }
  }

  static async _resolveProspectStaleDiagnostics({ entityId: prospectId, firedRules, orgId }) {
    const rulesList = firedRules && firedRules.length > 0 ? firedRules : null;

    try {
      let query, queryParams;

      if (rulesList) {
        query = `
          UPDATE prospecting_actions SET
            status       = 'completed',
            completed_at = NOW(),
            updated_at   = NOW()
          WHERE prospect_id  = $1
            AND org_id       = $2
            AND source       = 'auto_generated'
            AND source_rule IS NOT NULL
            AND source_rule != ALL($3::text[])
            AND status NOT IN ('completed', 'skipped')
          RETURNING id`;
        queryParams = [prospectId, orgId, rulesList];
      } else {
        query = `
          UPDATE prospecting_actions SET
            status       = 'completed',
            completed_at = NOW(),
            updated_at   = NOW()
          WHERE prospect_id  = $1
            AND org_id       = $2
            AND source       = 'auto_generated'
            AND source_rule IS NOT NULL
            AND status NOT IN ('completed', 'skipped')
          RETURNING id`;
        queryParams = [prospectId, orgId];
      }

      const result = await db.query(query, queryParams);
      return result.rowCount ?? 0;
    } catch (err) {
      console.error(`[ActionPersister] _resolveProspectStaleDiagnostics failed (prospect/${prospectId}):`, err.message);
      return 0;
    }
  }
}

module.exports = ActionPersister;
