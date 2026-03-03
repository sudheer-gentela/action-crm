/**
 * StrapEngine.js
 *
 * Universal STRAP orchestrator. Supports deal, account, prospect, implementation.
 * One engine, one table — entity-specific logic lives in hurdle identifiers
 * and context builders.
 *
 * Public API:
 *   generate(entityType, entityId, userId, orgId, { useAI })
 *   override(entityType, entityId, userId, orgId, overrideData)
 *   resolve(strapId, userId, orgId, { resolutionType, note })
 *   reassess(strapId, userId, orgId)
 *   getActive(entityType, entityId, orgId)
 *   getHistory(entityType, entityId, orgId)
 *   getById(strapId, orgId)
 */

const db                    = require('../config/database');
const StrapContextResolver  = require('./StrapContextResolver');
const StrapHurdleIdentifier = require('./StrapHurdleIdentifier');
const StrapStrategyBuilder  = require('./StrapStrategyBuilder');

class StrapEngine {

  // ── Generate ────────────────────────────────────────────────────────────────

  /**
   * Auto-generate a STRAP for an entity.
   * Supersedes any existing active STRAP for that entity.
   */
  static async generate(entityType, entityId, userId, orgId, { useAI = true } = {}) {
    // 1. Assert access
    await this._assertAccess(entityType, entityId, userId, orgId);

    // 2. Build context
    const context = await StrapContextResolver.resolve(entityType, entityId, userId, orgId);

    // 3. Identify hurdle
    const hurdle = StrapHurdleIdentifier.identify(entityType, context);
    if (!hurdle) {
      return { strap: null, message: 'No hurdle identified — entity appears healthy.' };
    }

    // 4. Build strategy
    const strategy = await StrapStrategyBuilder.build(entityType, hurdle, context, useAI);

    // 5. Supersede any existing active STRAP
    await this._supersedeActive(entityType, entityId, orgId);

    // 6. Insert new STRAP
    const result = await db.query(
      `INSERT INTO straps (
         org_id, entity_type, entity_id,
         hurdle_type, hurdle_title,
         situation, target, response, action_plan,
         priority, source,
         auto_hurdle_type, auto_hurdle_title,
         ai_model, ai_tokens_used,
         created_by, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto',$4,$5,$11,$12,$13,'active')
       RETURNING *`,
      [
        orgId, entityType, entityId,
        hurdle.hurdleType, hurdle.title,
        strategy.situation, strategy.target, strategy.response, strategy.actionPlan,
        hurdle.priority,
        strategy.aiModel || null,
        strategy.aiTokensUsed || null,
        userId,
      ]
    );

    const strap = result.rows[0];
    console.log(`✅ STRAP generated: ${entityType}/${entityId} → ${hurdle.hurdleType} (${hurdle.priority})`);

    return { strap };
  }

  // ── Override ──────────────────────────────────────────────────────────────

  /**
   * Manually override the current STRAP with a user-specified hurdle.
   */
  static async override(entityType, entityId, userId, orgId, overrideData) {
    await this._assertAccess(entityType, entityId, userId, orgId);

    const { hurdleType, hurdleTitle, situation, target, response, actionPlan, priority, reason } = overrideData;

    if (!hurdleType || !hurdleTitle) {
      throw new Error('Override requires hurdleType and hurdleTitle');
    }

    // Get existing auto STRAP data (if any) for tracking
    const existing = await this.getActive(entityType, entityId, orgId);

    // Supersede existing
    await this._supersedeActive(entityType, entityId, orgId);

    // Insert manual override
    const result = await db.query(
      `INSERT INTO straps (
         org_id, entity_type, entity_id,
         hurdle_type, hurdle_title,
         situation, target, response, action_plan,
         priority, source,
         auto_hurdle_type, auto_hurdle_title,
         override_by, override_reason, override_at,
         created_by, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11,$12,$13,$14,NOW(),$13,'active')
       RETURNING *`,
      [
        orgId, entityType, entityId,
        hurdleType, hurdleTitle,
        situation || null, target || null, response || null, actionPlan || null,
        priority || 'medium',
        existing?.auto_hurdle_type || null,
        existing?.auto_hurdle_title || null,
        userId,
        reason || null,
      ]
    );

    const strap = result.rows[0];
    console.log(`✅ STRAP overridden: ${entityType}/${entityId} → ${hurdleType} (manual by user ${userId})`);

    return { strap };
  }

  // ── Resolve ───────────────────────────────────────────────────────────────

  /**
   * Mark a STRAP as resolved.
   */
  static async resolve(strapId, userId, orgId, { resolutionType = 'manual', note = null } = {}) {
    const strap = await this.getById(strapId, orgId);
    if (!strap) throw new Error('STRAP not found');
    if (strap.status !== 'active') throw new Error('STRAP is not active');

    await this._assertAccess(strap.entity_type, strap.entity_id, userId, orgId);

    const result = await db.query(
      `UPDATE straps SET
         status = 'resolved',
         resolved_by = $1,
         resolved_at = NOW(),
         resolution_type = $2,
         resolution_note = $3
       WHERE id = $4 AND org_id = $5
       RETURNING *`,
      [userId, resolutionType, note, strapId, orgId]
    );

    console.log(`✅ STRAP resolved: #${strapId} (${resolutionType})`);
    return { strap: result.rows[0] };
  }

  // ── Reassess ──────────────────────────────────────────────────────────────

  /**
   * Re-evaluate: resolve the current STRAP and generate a fresh one.
   */
  static async reassess(strapId, userId, orgId) {
    const strap = await this.getById(strapId, orgId);
    if (!strap) throw new Error('STRAP not found');
    if (strap.status !== 'active') throw new Error('STRAP is not active');

    // Resolve current with 'superseded' type
    await this.resolve(strapId, userId, orgId, {
      resolutionType: 'superseded',
      note: 'Reassessed by user',
    });

    // Generate fresh
    return this.generate(strap.entity_type, strap.entity_id, userId, orgId, { useAI: true });
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  static async getActive(entityType, entityId, orgId) {
    const result = await db.query(
      `SELECT * FROM straps
       WHERE entity_type = $1 AND entity_id = $2 AND org_id = $3 AND status = 'active'
       LIMIT 1`,
      [entityType, entityId, orgId]
    );
    return result.rows[0] || null;
  }

  static async getHistory(entityType, entityId, orgId) {
    const result = await db.query(
      `SELECT * FROM straps
       WHERE entity_type = $1 AND entity_id = $2 AND org_id = $3
       ORDER BY created_at DESC
       LIMIT 20`,
      [entityType, entityId, orgId]
    );
    return result.rows;
  }

  static async getById(strapId, orgId) {
    const result = await db.query(
      'SELECT * FROM straps WHERE id = $1 AND org_id = $2',
      [strapId, orgId]
    );
    return result.rows[0] || null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Supersede any active STRAP for the given entity.
   */
  static async _supersedeActive(entityType, entityId, orgId) {
    await db.query(
      `UPDATE straps SET
         status = 'superseded',
         resolved_at = NOW(),
         resolution_type = 'superseded'
       WHERE entity_type = $1 AND entity_id = $2 AND org_id = $3 AND status = 'active'`,
      [entityType, entityId, orgId]
    );
  }

  /**
   * Assert that the user has access to the given entity.
   * - Deals: owner or deal_team_member
   * - Accounts: owner or any deal_team_member on account's deals
   * - Prospects: owner
   * - Implementation: same as deal
   */
  static async _assertAccess(entityType, entityId, userId, orgId) {
    switch (entityType) {
      case 'deal':
      case 'implementation': {
        const r = await db.query(
          `SELECT 1 FROM deals
           WHERE id = $1 AND org_id = $2 AND (
             owner_id = $3
             OR id IN (SELECT deal_id FROM deal_team_members WHERE user_id = $3 AND org_id = $2)
           )`,
          [entityId, orgId, userId]
        );
        if (r.rows.length === 0) throw new Error('Access denied: not deal owner or team member');
        break;
      }

      case 'account': {
        const r = await db.query(
          `SELECT 1 FROM accounts
           WHERE id = $1 AND org_id = $2 AND (
             owner_id = $3
             OR id IN (
               SELECT account_id FROM deals
               WHERE org_id = $2 AND (
                 owner_id = $3
                 OR id IN (SELECT deal_id FROM deal_team_members WHERE user_id = $3 AND org_id = $2)
               )
             )
           )`,
          [entityId, orgId, userId]
        );
        if (r.rows.length === 0) throw new Error('Access denied: not account owner or related deal team member');
        break;
      }

      case 'prospect': {
        const r = await db.query(
          'SELECT 1 FROM prospects WHERE id = $1 AND org_id = $2 AND owner_id = $3',
          [entityId, orgId, userId]
        );
        if (r.rows.length === 0) throw new Error('Access denied: not prospect owner');
        break;
      }

      default:
        throw new Error(`Unknown entity_type: ${entityType}`);
    }
  }
}

module.exports = StrapEngine;
