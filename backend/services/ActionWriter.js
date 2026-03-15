/**
 * ActionWriter.js
 *
 * Routes generated action rows to the correct DB table with the correct
 * foreign keys based on entity type.
 *
 * Called after PlaybookActionGenerator.generate() to persist the results.
 *
 * Usage:
 *   const result = await ActionWriter.write({
 *     entityType: 'deal',
 *     entityId:   42,
 *     actions,        // from PlaybookActionGenerator.generate()
 *     playbookId,
 *     playbookName,
 *     orgId,
 *     userId,
 *     deduplicateSource: 'playbook', // optional — skip inserts if matching source exists
 *   });
 *   // result: { inserted, skipped, ids }
 */

'use strict';

const db = require('../config/database');

// ── next_step CHECK constraint values ────────────────────────────────────────
const VALID_NEXT_STEPS = new Set([
  'email', 'call', 'whatsapp', 'linkedin', 'slack', 'document', 'internal_task',
]);

// ── prospecting_actions channel CHECK values ─────────────────────────────────
const VALID_PROSPECT_CHANNELS = new Set([
  'email', 'linkedin', 'phone', 'sms', 'whatsapp',
]);

class ActionWriter {

  /**
   * Persist generated action rows to the correct table.
   *
   * @param {object} params
   * @param {string}        params.entityType     — 'deal'|'prospect'|'contract'|'case'|'handover'
   * @param {number}        params.entityId       — id of the entity
   * @param {ActionRow[]}   params.actions        — from PlaybookActionGenerator.generate()
   * @param {number}        params.playbookId     — stamped on every row
   * @param {string}        params.playbookName   — stamped on every row
   * @param {number}        params.orgId
   * @param {number}        params.userId         — assignee for the actions
   * @param {string|null}   [params.deduplicateSource] — if set, skip rows where
   *                        an action with this source + same playbook_play_id already exists
   *
   * @returns {Promise<{ inserted: number, skipped: number, ids: number[] }>}
   */
  static async write({ entityType, entityId, actions, playbookId, playbookName, orgId, userId, deduplicateSource = null }) {
    if (!actions || actions.length === 0) {
      return { inserted: 0, skipped: 0, ids: [] };
    }

    // Build deduplication set if requested
    const existingPlayIds = new Set();
    if (deduplicateSource && playbookId) {
      try {
        const existing = await this._loadExistingPlayIds(entityType, entityId, orgId, deduplicateSource);
        existing.forEach(id => existingPlayIds.add(id));
      } catch (err) {
        console.warn('[ActionWriter] dedup lookup failed (non-blocking):', err.message);
      }
    }

    let inserted = 0;
    let skipped  = 0;
    const ids    = [];

    for (const action of actions) {
      // Skip if we already have an action from this play
      if (deduplicateSource && action.playbook_play_id && existingPlayIds.has(action.playbook_play_id)) {
        skipped++;
        continue;
      }

      try {
        let insertedId = null;

        if (entityType === 'prospect') {
          insertedId = await this._insertProspectingAction(action, entityId, orgId, userId, playbookId, playbookName);
        } else {
          insertedId = await this._insertAction(action, entityType, entityId, orgId, userId, playbookId, playbookName);
        }

        if (insertedId) {
          ids.push(insertedId);
          inserted++;
          // Track the play_id so subsequent dedup works within same batch
          if (action.playbook_play_id) existingPlayIds.add(action.playbook_play_id);
        }
      } catch (err) {
        console.error(`[ActionWriter] Insert failed for "${action.title}" (${entityType} ${entityId}):`, err.message);
        skipped++;
      }
    }

    return { inserted, skipped, ids };
  }

  // ── Insert into actions table ─────────────────────────────────────────────

  static async _insertAction(action, entityType, entityId, orgId, userId, playbookId, playbookName) {
    // Resolve entity-specific FK column
    const fkCol   = this._getFKColumn(entityType);
    const fkValue = entityId;

    // Ensure next_step passes the CHECK constraint
    const nextStep = VALID_NEXT_STEPS.has(action.next_step) ? action.next_step : 'email';

    const result = await db.query(
      `INSERT INTO actions (
         org_id, user_id,
         type, action_type, title, description,
         priority, due_date, next_step, is_internal,
         source, source_rule,
         suggested_action, deal_stage,
         playbook_play_id, playbook_id, playbook_name,
         ${fkCol},
         status, created_at
       ) VALUES (
         $1, $2,
         $3, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11,
         $12, $13,
         $14, $15, $16,
         $17,
         'yet_to_start', NOW()
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        orgId,
        action.user_id || userId,
        action.action_type || 'task_complete',
        action.title,
        action.description || null,
        action.priority || 'medium',
        action.due_date || null,
        nextStep,
        action.is_internal || false,
        action.source || 'playbook',
        action.source_rule || 'playbook_play',
        action.suggested_action || null,
        action.deal_stage || null,
        action.playbook_play_id || null,
        playbookId   || action.playbook_id   || null,
        playbookName || action.playbook_name || null,
        fkValue,
      ]
    );

    return result.rows[0]?.id || null;
  }

  // ── Insert into prospecting_actions table ─────────────────────────────────

  static async _insertProspectingAction(action, prospectId, orgId, userId, playbookId, playbookName) {
    const channel = VALID_PROSPECT_CHANNELS.has(action.channel) ? action.channel : null;

    const result = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id,
         title, description,
         action_type, channel,
         priority, due_date,
         source, source_rule,
         suggested_action,
         playbook_id, play_id, playbook_name,
         status, created_at
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         $6, $7,
         $8, $9,
         $10, $11,
         $12,
         $13, $14, $15,
         'pending', NOW()
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        orgId,
        action.user_id || userId,
        prospectId,
        action.title,
        action.description || null,
        action.action_type || 'playbook_play',
        channel,
        action.priority || 'medium',
        action.due_date || null,
        action.source || 'playbook',
        action.source_rule || 'playbook_play',
        action.suggested_action || null,
        playbookId   || action.playbook_id   || null,
        action.playbook_play_id              || null,
        playbookName || action.playbook_name || null,
      ]
    );

    return result.rows[0]?.id || null;
  }

  // ── Load existing play_ids for deduplication ──────────────────────────────

  static async _loadExistingPlayIds(entityType, entityId, orgId, source) {
    if (entityType === 'prospect') {
      const r = await db.query(
        `SELECT play_id FROM prospecting_actions
         WHERE prospect_id = $1 AND org_id = $2 AND source = $3
           AND play_id IS NOT NULL AND status != 'skipped'`,
        [entityId, orgId, source]
      );
      return r.rows.map(r => r.play_id);
    }

    const fkCol = this._getFKColumn(entityType);
    const r = await db.query(
      `SELECT playbook_play_id FROM actions
       WHERE ${fkCol} = $1 AND org_id = $2 AND source = $3
         AND playbook_play_id IS NOT NULL
         AND status NOT IN ('completed')`,
      [entityId, orgId, source]
    );
    return r.rows.map(r => r.playbook_play_id);
  }

  // ── FK column resolver ────────────────────────────────────────────────────

  static _getFKColumn(entityType) {
    switch (entityType) {
      case 'deal':     return 'deal_id';
      case 'handover': return 'deal_id';  // handover actions go on the deal record
      case 'contract': return 'contract_id';
      case 'case':     return 'case_id';
      default:
        throw new Error(`[ActionWriter] Unknown entityType: ${entityType}`);
    }
  }
}

module.exports = ActionWriter;
