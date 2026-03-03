/**
 * StrapEngine.js
 *
 * Core orchestrator for the STRAP framework. Manages the full lifecycle:
 *   createStrap(dealId, userId, orgId, opts)  — auto-identify hurdle + build strategy
 *   createManualStrap(dealId, userId, orgId, override) — human override with custom hurdle
 *   evaluateStrap(strapId, orgId)
 *   resolveStrap(strapId, orgId, ...)
 *   reassess(strapId, orgId)
 *   getActiveStrap(dealId, orgId)
 *   getHistory(dealId, orgId)
 *
 * Deal Team support:
 *   Any member of deal_team_members (or the deal owner) can create/resolve/reassess.
 *   Permission is checked via _assertDealAccess().
 *
 * Human Override:
 *   When source='manual', the system still runs auto-identification but stores
 *   its recommendation in auto_hurdle_type/auto_hurdle_title for comparison.
 *   The human's chosen hurdle is stored as the active hurdle.
 *   override_by and override_reason capture the who/why.
 *
 * Pattern:
 *   - db.query() for simple queries (matches actionCompletionDetector, actionConfig)
 *   - Static class methods (matches ActionsRulesEngine, ActionConfigService)
 *   - Error logging with emoji prefixes (matches actionsGenerator)
 *   - org_id on every query (matches all existing services)
 */

const db                    = require('../config/database');
const DealContextBuilder    = require('./DealContextBuilder');
const StrapHurdleIdentifier = require('./StrapHurdleIdentifier');
const StrapStrategyBuilder  = require('./StrapStrategyBuilder');

class StrapEngine {

  // ── Permission check ────────────────────────────────────────────────────

  /**
   * Verify that userId is the deal owner OR a deal team member.
   * Throws if no access.
   */
  static async _assertDealAccess(dealId, userId, orgId) {
    const result = await db.query(
      `SELECT 1 FROM deals WHERE id = $1 AND org_id = $2 AND (owner_id = $3 OR user_id = $3)
       UNION
       SELECT 1 FROM deal_team_members WHERE deal_id = $1 AND org_id = $2 AND user_id = $3`,
      [dealId, orgId, userId]
    );
    if (result.rows.length === 0) {
      throw new Error(`User ${userId} does not have access to deal ${dealId}`);
    }
  }

  // ── Create STRAP (auto) ─────────────────────────────────────────────────

  /**
   * Auto STRAP: system identifies hurdle → builds strategy → inserts STRAP + actions.
   */
  static async createStrap(dealId, userId, orgId, opts = {}) {
    try {
      console.log(`🎯 Creating auto STRAP for deal ${dealId}...`);

      await this._assertDealAccess(dealId, userId, orgId);

      // 1. Build context
      const context = await DealContextBuilder.build(dealId, userId, orgId);

      // 2. Identify hurdle
      const hurdle = StrapHurdleIdentifier.identify(context);
      console.log(`  🎯 Hurdle identified: [${hurdle.priority}] ${hurdle.type} — "${hurdle.title}"`);

      // 3. Build strategy
      const plan = await StrapStrategyBuilder.build(hurdle, context, { useAI: opts.useAI });
      console.log(`  📋 Strategy built with ${plan.actions.length} actions`);

      // 4. Insert
      return this._insertStrap({
        orgId, dealId, userId,
        source: 'auto',
        hurdle, plan, context,
        overrideBy: null,
        overrideReason: null,
        autoHurdleType: null,
        autoHurdleTitle: null,
      });

    } catch (error) {
      console.error(`❌ Error creating auto STRAP for deal ${dealId}:`, error.message);
      throw error;
    }
  }

  // ── Create STRAP (manual / human override) ──────────────────────────────

  /**
   * Human override: user chooses their own hurdle type + title.
   * System still runs auto-identification for comparison tracking.
   *
   * @param {number} dealId
   * @param {number} userId
   * @param {number} orgId
   * @param {object} override
   * @param {string} override.hurdleType    — one of the valid hurdle_type values
   * @param {string} override.hurdleTitle   — human-written hurdle description
   * @param {string} [override.hurdleParam] — optional health param
   * @param {string} [override.reason]      — why they chose this over the auto recommendation
   * @param {object} [opts]
   */
  static async createManualStrap(dealId, userId, orgId, override, opts = {}) {
    try {
      console.log(`🎯 Creating manual STRAP for deal ${dealId} (override by user ${userId})...`);

      await this._assertDealAccess(dealId, userId, orgId);

      // 1. Build context
      const context = await DealContextBuilder.build(dealId, userId, orgId);

      // 2. Run auto-identification anyway (for comparison tracking)
      const autoHurdle = StrapHurdleIdentifier.identify(context);
      console.log(`  🤖 Auto would have picked: [${autoHurdle.priority}] ${autoHurdle.type} — "${autoHurdle.title}"`);

      // 3. Build the human's chosen hurdle object
      const humanHurdle = {
        type:     override.hurdleType,
        param:    override.hurdleParam || null,
        title:    override.hurdleTitle,
        priority: 'MANUAL',
        evidence: {
          signal:          'human_override',
          override_reason: override.reason || null,
          auto_would_have: { type: autoHurdle.type, title: autoHurdle.title, priority: autoHurdle.priority },
        },
      };

      // 4. Build strategy for the human's hurdle
      const plan = await StrapStrategyBuilder.build(humanHurdle, context, { useAI: opts.useAI });
      console.log(`  📋 Strategy built with ${plan.actions.length} actions (for manual hurdle)`);

      // 5. Insert
      return this._insertStrap({
        orgId, dealId, userId,
        source: 'manual',
        hurdle: humanHurdle,
        plan, context,
        overrideBy:     userId,
        overrideReason: override.reason || null,
        autoHurdleType:  autoHurdle.type,
        autoHurdleTitle: autoHurdle.title,
      });

    } catch (error) {
      console.error(`❌ Error creating manual STRAP for deal ${dealId}:`, error.message);
      throw error;
    }
  }

  // ── Shared insert logic ─────────────────────────────────────────────────

  static async _insertStrap({ orgId, dealId, userId, source, hurdle, plan, context,
                               overrideBy, overrideReason, autoHurdleType, autoHurdleTitle }) {

    // Resolve any existing active STRAP
    const existing = await this.getActiveStrap(dealId, orgId);
    if (existing) {
      await db.query(
        `UPDATE deal_straps
         SET status = 'reassessed', outcome = 'Superseded by new STRAP generation',
             resolved_at = NOW(), resolved_by = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3`,
        [userId, existing.id, orgId]
      );
      console.log(`  ♻️  Previous STRAP #${existing.id} marked as reassessed`);
    }

    // Insert the new STRAP
    const strapResult = await db.query(
      `INSERT INTO deal_straps (
         org_id, deal_id, user_id, status, source,
         override_by, override_reason, auto_hurdle_type, auto_hurdle_title,
         hurdle_type, hurdle_param, hurdle_title, hurdle_evidence,
         strategy, strategy_hypothesis
       ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        orgId, dealId, userId, source,
        overrideBy || null,
        overrideReason || null,
        autoHurdleType || null,
        autoHurdleTitle || null,
        hurdle.type,
        hurdle.param || null,
        hurdle.title,
        JSON.stringify(hurdle.evidence),
        plan.strategy,
        plan.hypothesis,
      ]
    );
    const strap = strapResult.rows[0];

    // Link previous → new
    if (existing) {
      await db.query(
        'UPDATE deal_straps SET next_strap_id = $1 WHERE id = $2',
        [strap.id, existing.id]
      );
    }

    // Insert actions
    const insertedActions = [];
    for (const action of plan.actions) {
      try {
        const actionResult = await db.query(
          `INSERT INTO actions (
             org_id, user_id, type, title, description, action_type, priority,
             due_date, deal_id, contact_id, account_id,
             suggested_action, context, source, source_rule, health_param,
             keywords, deal_stage, requires_external_evidence,
             is_internal, next_step, status, strap_id, created_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             $12,$13,$14,$15,$16,
             $17,$18,$19,
             $20,$21,'yet_to_start',$22,NOW()
           ) RETURNING id`,
          [
            orgId, userId,
            action.type || action.action_type,
            action.title,
            action.description,
            action.action_type,
            action.priority || 'medium',
            action.due_date,
            action.deal_id    || null,
            action.contact_id || null,
            action.account_id || null,
            action.suggested_action || null,
            action.context          || null,
            'strap',
            action.source_rule      || null,
            action.health_param     || null,
            action.keywords         || null,
            action.deal_stage       || null,
            action.requires_external_evidence || false,
            action.next_step === 'internal_task',
            action.next_step || 'email',
            strap.id,
          ]
        );

        const actionId = actionResult.rows[0].id;

        await db.query(
          `INSERT INTO strap_actions (strap_id, action_id, sequence, is_gate, success_signal)
           VALUES ($1, $2, $3, $4, $5)`,
          [strap.id, actionId, action._sequence || 1, action._is_gate || false, action._success_signal || null]
        );

        insertedActions.push({ id: actionId, ...action });
      } catch (err) {
        console.error(`  ❌ Failed to insert STRAP action "${action.title}":`, err.message);
      }
    }

    console.log(`✅ STRAP #${strap.id} (${source}) created with ${insertedActions.length} actions for deal ${dealId}`);
    return { strap, actions: insertedActions };
  }

  // ── Get active STRAP ────────────────────────────────────────────────────

  static async getActiveStrap(dealId, orgId) {
    const result = await db.query(
      `SELECT ds.*,
         u_creator.first_name AS creator_first_name,
         u_creator.last_name  AS creator_last_name,
         u_override.first_name AS override_first_name,
         u_override.last_name  AS override_last_name,
         json_agg(
           json_build_object(
             'id',             sa.id,
             'action_id',      sa.action_id,
             'sequence',       sa.sequence,
             'is_gate',        sa.is_gate,
             'success_signal', sa.success_signal,
             'action_title',   a.title,
             'action_status',  a.status,
             'action_type',    a.action_type,
             'next_step',      a.next_step,
             'priority',       a.priority,
             'due_date',       a.due_date,
             'suggested_action', a.suggested_action,
             'completed',      a.completed
           ) ORDER BY sa.sequence
         ) FILTER (WHERE sa.id IS NOT NULL) AS actions
       FROM deal_straps ds
       LEFT JOIN strap_actions sa ON sa.strap_id = ds.id
       LEFT JOIN actions a ON a.id = sa.action_id
       LEFT JOIN users u_creator  ON u_creator.id = ds.user_id
       LEFT JOIN users u_override ON u_override.id = ds.override_by
       WHERE ds.deal_id = $1 AND ds.org_id = $2 AND ds.status = 'active'
       GROUP BY ds.id, u_creator.first_name, u_creator.last_name,
                u_override.first_name, u_override.last_name`,
      [dealId, orgId]
    );
    return result.rows[0] || null;
  }

  // ── Get STRAP history ───────────────────────────────────────────────────

  static async getHistory(dealId, orgId) {
    const result = await db.query(
      `SELECT ds.*,
         u_creator.first_name AS creator_first_name,
         u_creator.last_name  AS creator_last_name,
         json_agg(
           json_build_object(
             'action_id',      sa.action_id,
             'sequence',       sa.sequence,
             'action_title',   a.title,
             'action_status',  a.status,
             'completed',      a.completed
           ) ORDER BY sa.sequence
         ) FILTER (WHERE sa.id IS NOT NULL) AS actions
       FROM deal_straps ds
       LEFT JOIN strap_actions sa ON sa.strap_id = ds.id
       LEFT JOIN actions a ON a.id = sa.action_id
       LEFT JOIN users u_creator ON u_creator.id = ds.user_id
       WHERE ds.deal_id = $1 AND ds.org_id = $2
       GROUP BY ds.id, u_creator.first_name, u_creator.last_name
       ORDER BY ds.created_at DESC`,
      [dealId, orgId]
    );
    return result.rows;
  }

  // ── Resolve a STRAP ─────────────────────────────────────────────────────

  static async resolveStrap(strapId, orgId, status, outcome = null, outcomeSignals = null, resolvedBy = null, autoNext = null) {
    try {
      const strapResult = await db.query(
        'SELECT * FROM deal_straps WHERE id = $1 AND org_id = $2 AND status = $3',
        [strapId, orgId, 'active']
      );
      if (strapResult.rows.length === 0) {
        throw new Error(`Active STRAP #${strapId} not found`);
      }

      const strap = strapResult.rows[0];

      await db.query(
        `UPDATE deal_straps
         SET status = $1, outcome = $2, outcome_signals = $3, resolved_by = $4,
             resolved_at = NOW(), updated_at = NOW()
         WHERE id = $5 AND org_id = $6`,
        [status, outcome, outcomeSignals ? JSON.stringify(outcomeSignals) : null,
         resolvedBy || null, strapId, orgId]
      );

      console.log(`🎯 STRAP #${strapId} resolved as ${status} by user ${resolvedBy || 'system'}`);

      // Auto-create next STRAP
      const shouldAutoNext = autoNext !== null ? autoNext : (status === 'successful');
      if (shouldAutoNext) {
        try {
          const next = await this.createStrap(strap.deal_id, strap.user_id, orgId);
          console.log(`  ➡️  Next STRAP #${next.strap.id} auto-created`);
          return { resolved: true, nextStrap: next.strap };
        } catch (err) {
          console.error('  ⚠️  Auto-create next STRAP failed:', err.message);
        }
      }

      return { resolved: true, nextStrap: null };
    } catch (error) {
      console.error(`❌ Error resolving STRAP #${strapId}:`, error.message);
      throw error;
    }
  }

  // ── Reassess ────────────────────────────────────────────────────────────

  static async reassess(strapId, orgId, userId = null) {
    try {
      const strapResult = await db.query(
        'SELECT * FROM deal_straps WHERE id = $1 AND org_id = $2 AND status = $3',
        [strapId, orgId, 'active']
      );
      if (strapResult.rows.length === 0) {
        throw new Error(`Active STRAP #${strapId} not found`);
      }

      const strap = strapResult.rows[0];
      console.log(`♻️  Reassessing STRAP #${strapId} for deal ${strap.deal_id}...`);

      const context   = await DealContextBuilder.build(strap.deal_id, strap.user_id, orgId);
      const newHurdle = StrapHurdleIdentifier.identify(context);

      const sameHurdle = newHurdle.type === strap.hurdle_type &&
                         (newHurdle.param || null) === (strap.hurdle_param || null);

      if (sameHurdle) {
        console.log(`  🔄 Same hurdle — new strategy needed`);
        return this.resolveStrap(strapId, orgId, 'unsuccessful',
          'Reassessed: same hurdle, new strategy needed', null, userId, true);
      } else {
        console.log(`  🔀 Different hurdle: ${newHurdle.type} (was: ${strap.hurdle_type})`);
        return this.resolveStrap(strapId, orgId, 'reassessed',
          `Reassessed: hurdle changed from "${strap.hurdle_type}" to "${newHurdle.type}"`, null, userId, true);
      }
    } catch (error) {
      console.error(`❌ Error reassessing STRAP #${strapId}:`, error.message);
      throw error;
    }
  }

  // ── Get by ID ───────────────────────────────────────────────────────────

  static async getById(strapId, orgId) {
    const result = await db.query(
      `SELECT ds.*,
         u_creator.first_name AS creator_first_name,
         u_creator.last_name  AS creator_last_name,
         u_override.first_name AS override_first_name,
         u_override.last_name  AS override_last_name,
         json_agg(
           json_build_object(
             'id',             sa.id,
             'action_id',      sa.action_id,
             'sequence',       sa.sequence,
             'is_gate',        sa.is_gate,
             'success_signal', sa.success_signal,
             'action_title',   a.title,
             'action_status',  a.status,
             'action_type',    a.action_type,
             'next_step',      a.next_step,
             'priority',       a.priority,
             'due_date',       a.due_date,
             'suggested_action', a.suggested_action,
             'completed',      a.completed
           ) ORDER BY sa.sequence
         ) FILTER (WHERE sa.id IS NOT NULL) AS actions
       FROM deal_straps ds
       LEFT JOIN strap_actions sa ON sa.strap_id = ds.id
       LEFT JOIN actions a ON a.id = sa.action_id
       LEFT JOIN users u_creator  ON u_creator.id = ds.user_id
       LEFT JOIN users u_override ON u_override.id = ds.override_by
       WHERE ds.id = $1 AND ds.org_id = $2
       GROUP BY ds.id, u_creator.first_name, u_creator.last_name,
                u_override.first_name, u_override.last_name`,
      [strapId, orgId]
    );
    return result.rows[0] || null;
  }
}

module.exports = StrapEngine;
