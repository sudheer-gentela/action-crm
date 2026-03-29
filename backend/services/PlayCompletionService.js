/**
 * PlayCompletionService.js
 *
 * Shared next-play firing logic for all modules that use playbook plays.
 *
 * DROP-IN LOCATION: backend/services/PlayCompletionService.js
 *
 * ── What this service does ───────────────────────────────────────────────────
 *
 * When a playbook play action is marked complete in any module, this service
 * checks whether the next sequential play in the same playbook+stage should
 * fire automatically, and inserts it if so.
 *
 * Called from:
 *   - actionsGenerator.js          → deals
 *   - ContractActionsGenerator.js  → CLM
 *   - supportService.js            → cases
 *   - handover.service.js          → handovers (via completePlay)
 *   - prospectingActions.service.js → prospecting
 *
 * ── Next-play semantics ──────────────────────────────────────────────────────
 *
 * "Next play" means the play with the lowest sort_order > completed play's
 * sort_order in the same (playbook_id, stage_key, trigger_mode). Only plays
 * with trigger_mode = 'stage_change' or 'on_demand' are candidates — scheduled
 * plays fire on their own schedule and are excluded.
 *
 * The completed play's execution_type determines chaining behaviour:
 *   - 'sequential'  → fire the next play
 *   - 'parallel'    → do NOT chain; parallel plays run independently
 *
 * If the completed play itself is parallel, no next-play logic runs.
 * If the NEXT play is parallel, all parallel plays at that sort_order fire.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * All inserts into `actions` and `prospecting_actions` use
 * ON CONFLICT DO NOTHING on the Phase 1 unique indexes:
 *   actions:              UNIQUE (deal_id, playbook_play_id)
 *                         UNIQUE (case_id, playbook_play_id)
 *                         UNIQUE (contract_id, playbook_play_id)
 *   prospecting_actions:  UNIQUE (prospect_id, play_id)
 *
 * This means calling fireNextPlay() twice for the same entity+play is safe.
 *
 * ── Non-blocking design ──────────────────────────────────────────────────────
 *
 * All public methods catch and log errors internally. Callers do NOT need
 * try/catch — a next-play failure must never disrupt the completion itself.
 *
 * ── Public API ───────────────────────────────────────────────────────────────
 *
 *   fireNextPlay(module, entityId, completedPlayId, orgId, userId)
 *     module: 'deal' | 'contract' | 'case' | 'handover' | 'prospect'
 *     → { fired: boolean, nextPlayId: number|null, actionsInserted: number }
 *
 * Callers invoke this AFTER the completed status has been written to the DB.
 * The call is non-blocking — wrap in .catch(() => {}) at the call site.
 */

const db = require('../config/database');
const { resolveChannel } = require('./playbook.service');
const { resolveForPlay }  = require('./PlayRouteResolver');

// ── Module → entity FK column mapping ────────────────────────────────────────
// Maps module name to: the FK column in the relevant action table, and the
// table to insert into. This drives the INSERT query builder below.

const MODULE_CONFIG = {
  deal: {
    actionTable:  'actions',
    entityFkCol:  'deal_id',
    // Column in actions used for play deduplication (Phase 1 unique index)
    playFkCol:    'playbook_play_id',
    // How to load the entity for role resolution
    entityQuery:  'SELECT id, owner_id, account_id FROM deals WHERE id = $1',
    entityType:   'deal',
    ownerCol:     'owner_id',
  },
  contract: {
    actionTable:  'actions',
    entityFkCol:  'contract_id',
    playFkCol:    'playbook_play_id',
    entityQuery:  'SELECT id, owner_id FROM contracts WHERE id = $1',
    entityType:   'contract',
    ownerCol:     'owner_id',
  },
  case: {
    actionTable:  'actions',
    entityFkCol:  'case_id',
    playFkCol:    'playbook_play_id',
    entityQuery:  'SELECT id, assigned_to AS owner_id FROM cases WHERE id = $1',
    entityType:   'case',
    ownerCol:     'owner_id',
  },
  handover: {
    // Handovers write actions using deal_id FK (architectural decision #7).
    // entityId passed in for handovers IS the deal_id (from handover.deal_id).
    actionTable:  'actions',
    entityFkCol:  'deal_id',
    playFkCol:    'playbook_play_id',
    entityQuery:  'SELECT id, owner_id FROM deals WHERE id = $1',
    entityType:   'deal',   // roles resolved against the deal
    ownerCol:     'owner_id',
  },
  prospect: {
    actionTable:  'prospecting_actions',
    entityFkCol:  'prospect_id',
    playFkCol:    'play_id',            // prospecting_actions uses play_id, not playbook_play_id
    entityQuery:  'SELECT id, owner_id FROM prospects WHERE id = $1',
    entityType:   'prospect',
    ownerCol:     'owner_id',
  },
};

// ── Plays to exclude from chaining ───────────────────────────────────────────
// Scheduled plays fire on their own cron, not via play completion chaining.
const CHAINABLE_TRIGGER_MODES = new Set(['stage_change', 'on_demand']);

// ─────────────────────────────────────────────────────────────────────────────

class PlayCompletionService {

  /**
   * Fire the next sequential play after a completed play, if applicable.
   *
   * This is the single entry point. All module-specific differences are
   * handled via MODULE_CONFIG — the core logic is shared.
   *
   * @param {string} module          — 'deal'|'contract'|'case'|'handover'|'prospect'
   * @param {number} entityId        — deal_id, contract_id, case_id, prospect_id,
   *                                   OR deal_id (for handovers — see MODULE_CONFIG)
   * @param {number} completedPlayId — playbook_plays.id of the just-completed play
   * @param {number} orgId
   * @param {number} userId          — the user who completed the play (for role fallback)
   * @returns {Promise<{ fired: boolean, nextPlayId: number|null, actionsInserted: number }>}
   */
  static async fireNextPlay(module, entityId, completedPlayId, orgId, userId) {
    const config = MODULE_CONFIG[module];
    if (!config) {
      console.error(`[PlayCompletionService] Unknown module: "${module}"`);
      return { fired: false, nextPlayId: null, actionsInserted: 0 };
    }

    try {
      // 1. Load the completed play to get its playbook, stage, sort_order, execution_type
      const completedPlay = await this._loadPlay(completedPlayId, orgId);
      if (!completedPlay) {
        return { fired: false, nextPlayId: null, actionsInserted: 0 };
      }

      // 2. Parallel plays do not chain — they run independently
      if (completedPlay.execution_type === 'parallel') {
        return { fired: false, nextPlayId: null, actionsInserted: 0 };
      }

      // 3. Find the next sequential play(s)
      const nextPlays = await this._findNextPlays(completedPlay, orgId);
      if (nextPlays.length === 0) {
        return { fired: false, nextPlayId: null, actionsInserted: 0 };
      }

      // 4. Load entity for role resolution
      const entity = await this._loadEntity(config, entityId);
      if (!entity) {
        console.warn(`[PlayCompletionService] Entity not found: ${module}/${entityId}`);
        return { fired: false, nextPlayId: null, actionsInserted: 0 };
      }

      // 5. Insert actions for each next play
      let actionsInserted = 0;
      for (const nextPlay of nextPlays) {
        const count = await this._insertPlayAction(
          config, nextPlay, entityId, entity, orgId, userId
        );
        actionsInserted += count;
      }

      const firstNextPlayId = nextPlays[0].id;
      console.log(
        `[PlayCompletionService] ${module}/${entityId}: ` +
        `play #${completedPlayId} completed → fired ${nextPlays.length} next play(s) ` +
        `(first: #${firstNextPlayId}), inserted ${actionsInserted} action(s)`
      );

      return {
        fired:           actionsInserted > 0,
        nextPlayId:      firstNextPlayId,
        actionsInserted,
      };

    } catch (err) {
      console.error(
        `[PlayCompletionService] Error in ${module}/${entityId} for play #${completedPlayId}:`,
        err.message
      );
      return { fired: false, nextPlayId: null, actionsInserted: 0 };
    }
  }

  // ── Core helpers ────────────────────────────────────────────────────────────

  /**
   * Load a playbook_plays row by id, scoped to orgId for safety.
   */
  static async _loadPlay(playId, orgId) {
    const result = await db.query(
      `SELECT id, playbook_id, stage_key, sort_order,
              execution_type, trigger_mode, is_active,
              title, description, channel, priority,
              due_offset_days, suggested_action, fire_conditions
       FROM playbook_plays
       WHERE id = $1 AND org_id = $2`,
      [playId, orgId]
    );
    return result.rows[0] || null;
  }

  /**
   * Find the next play(s) to fire after the completed play.
   *
   * Rules:
   *   - Same playbook_id and stage_key
   *   - sort_order strictly greater than completed play's sort_order
   *   - is_active = true
   *   - trigger_mode is chainable (not 'scheduled')
   *   - Take all plays at the minimum sort_order found (handles parallel groups)
   *
   * @param {object} completedPlay — full play row from _loadPlay
   * @param {number} orgId
   * @returns {object[]} array of play rows (may be multiple if parallel)
   */
  static async _findNextPlays(completedPlay, orgId) {
    // Step 1: find the minimum sort_order above the completed play
    const nextOrderResult = await db.query(
      `SELECT MIN(sort_order) AS next_sort_order
       FROM playbook_plays
       WHERE org_id      = $1
         AND playbook_id = $2
         AND stage_key   = $3
         AND sort_order  > $4
         AND is_active   = TRUE
         AND trigger_mode = ANY($5::text[])`,
      [
        orgId,
        completedPlay.playbook_id,
        completedPlay.stage_key,
        completedPlay.sort_order,
        [...CHAINABLE_TRIGGER_MODES],
      ]
    );

    const nextSortOrder = nextOrderResult.rows[0]?.next_sort_order;
    if (nextSortOrder == null) return []; // no next play exists

    // Step 2: fetch all plays at that sort_order (handles parallel groups)
    const playsResult = await db.query(
      `SELECT id, playbook_id, stage_key, sort_order,
              execution_type, trigger_mode,
              title, description, channel, priority,
              due_offset_days, suggested_action, fire_conditions
       FROM playbook_plays
       WHERE org_id      = $1
         AND playbook_id = $2
         AND stage_key   = $3
         AND sort_order  = $4
         AND is_active   = TRUE
         AND trigger_mode = ANY($5::text[])
       ORDER BY id ASC`,
      [
        orgId,
        completedPlay.playbook_id,
        completedPlay.stage_key,
        nextSortOrder,
        [...CHAINABLE_TRIGGER_MODES],
      ]
    );

    return playsResult.rows;
  }

  /**
   * Load the entity row for role resolution.
   */
  static async _loadEntity(config, entityId) {
    try {
      const result = await db.query(config.entityQuery, [entityId]);
      return result.rows[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve assignees and insert an action row for a next play.
   * Uses ON CONFLICT DO NOTHING — safe to call multiple times.
   *
   * @returns {number} count of rows actually inserted (0 if conflict)
   */
  static async _insertPlayAction(config, play, entityId, entity, orgId, userId) {
    // Resolve role-based assignees
    const roles = Array.isArray(play.roles) ? play.roles : [];
    const primaryRole = roles.find(r => r.ownership_type === 'primary') || roles[0] || null;

    const assigneeIds = await resolveForPlay({
      orgId,
      roleKey:      primaryRole?.role_key || null,
      roleId:       primaryRole?.role_id  || null,
      entity,
      entityType:   config.entityType,
      callerUserId: entity[config.ownerCol] || userId,
    });

    const effectiveUserId = assigneeIds[0] || entity[config.ownerCol] || userId;
    if (!effectiveUserId) return 0;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (parseInt(play.due_offset_days) || 3));

    let inserted = 0;

    if (config.actionTable === 'prospecting_actions') {
      inserted = await this._insertProspectingAction(
        play, entityId, effectiveUserId, orgId, dueDate, config.playFkCol
      );
    } else {
      inserted = await this._insertAction(
        play, entityId, effectiveUserId, orgId, dueDate, config
      );
    }

    return inserted;
  }

  /**
   * Insert into `actions` table with ON CONFLICT DO NOTHING.
   * The unique index is UNIQUE (entityFkCol, playbook_play_id) from Phase 1.
   */
  static async _insertAction(play, entityId, userId, orgId, dueDate, config) {
    const { action_type, next_step, is_internal } = resolveChannel(play.channel);

    try {
      const result = await db.query(
        `INSERT INTO actions (
           org_id, user_id,
           ${config.entityFkCol},
           title, description,
           type, action_type, priority,
           next_step, is_internal,
           source, source_rule,
           playbook_play_id,
           due_date, status, created_at
         ) VALUES (
           $1, $2, $3,
           $4, $5,
           $6, $6, $7,
           $8, $9,
           'playbook', 'playbook_play',
           $10,
           $11, 'yet_to_start', NOW()
         )
         ON CONFLICT (${config.entityFkCol}, ${config.playFkCol})
         WHERE ${config.entityFkCol} IS NOT NULL AND ${config.playFkCol} IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          orgId, userId, entityId,
          play.title, play.description || null,
          action_type, play.priority || 'medium',
          next_step, is_internal || false,
          play.id,
          dueDate,
        ]
      );
      return result.rows.length > 0 ? 1 : 0;
    } catch (err) {
      console.error(
        `[PlayCompletionService] actions INSERT failed for play #${play.id}:`,
        err.message
      );
      return 0;
    }
  }

  /**
   * Insert into `prospecting_actions` table with ON CONFLICT DO NOTHING.
   * The unique index is UNIQUE (prospect_id, play_id) from Phase 1.
   */
  static async _insertProspectingAction(play, prospectId, userId, orgId, dueDate) {
    try {
      const result = await db.query(
        `INSERT INTO prospecting_actions (
           org_id, user_id, prospect_id,
           title, description,
           action_type, channel,
           priority, due_date,
           source, source_rule,
           suggested_action,
           play_id,
           status, created_at
         ) VALUES (
           $1, $2, $3,
           $4, $5,
           'playbook_play', 'general',
           $6, $7,
           'playbook', 'playbook_play',
           $8,
           $9,
           'pending', NOW()
         )
         ON CONFLICT (prospect_id, play_id)
         WHERE prospect_id IS NOT NULL AND play_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          orgId, userId, prospectId,
          play.title, play.description || null,
          play.priority || 'medium', dueDate,
          play.suggested_action || null,
          play.id,
        ]
      );
      return result.rows.length > 0 ? 1 : 0;
    } catch (err) {
      console.error(
        `[PlayCompletionService] prospecting_actions INSERT failed for play #${play.id}:`,
        err.message
      );
      return 0;
    }
  }
}

module.exports = PlayCompletionService;
