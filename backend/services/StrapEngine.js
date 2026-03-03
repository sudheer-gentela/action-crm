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
const StrapActionGenerator  = require('./StrapActionGenerator');

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

    // Generate real action rows from the action plan
    try {
      const actionResult = await StrapActionGenerator.generate(strap, context, userId, orgId);
      if (actionResult.count > 0) {
        console.log(`   📋 Created ${actionResult.count} STRAP action(s) in ${strap.entity_type === 'prospect' ? 'prospecting_actions' : 'actions'} table`);
      }
    } catch (err) {
      console.error(`   ⚠️ STRAP action generation failed (non-blocking):`, err.message);
    }

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

    // Generate real action rows from the action plan (if provided)
    if (actionPlan) {
      try {
        const actionResult = await StrapActionGenerator.generate(strap, {}, userId, orgId);
        if (actionResult.count > 0) {
          console.log(`   📋 Created ${actionResult.count} STRAP action(s) from manual override`);
        }
      } catch (err) {
        console.error(`   ⚠️ STRAP action generation failed (non-blocking):`, err.message);
      }
    }

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

  // ── Get all active STRAPs for the user's scope ────────────────────────────

  /**
   * Returns all active STRAPs visible to the user, enriched with entity context.
   * Supports scope: mine | team | org.
   * Optional filters: entityType, dealId, accountId.
   */
  static async getAllActive(userId, orgId, { scope = 'mine', subordinateIds = [], entityType, dealId, accountId } = {}) {
    // Build owner filter based on scope
    let ownerFilter = '';
    const params = [orgId];

    if (scope === 'team' && subordinateIds.length > 0) {
      const teamIds = [userId, ...subordinateIds];
      params.push(teamIds);
      ownerFilter = `AND s.created_by = ANY($${params.length}::int[])`;
    } else if (scope === 'org') {
      // no owner filter
    } else {
      params.push(userId);
      ownerFilter = `AND s.created_by = $${params.length}`;
    }

    // Optional entity type filter
    let typeFilter = '';
    if (entityType) {
      params.push(entityType);
      typeFilter = `AND s.entity_type = $${params.length}`;
    }

    // Fetch active STRAPs with entity context via LEFT JOINs
    const result = await db.query(`
      SELECT
        s.*,
        -- Deal context
        d.name AS deal_name, d.stage AS deal_stage,
        d.value AS deal_value, d.account_id AS deal_account_id,
        da.name AS deal_account_name,
        -- Account context
        a.name AS account_name, a.industry AS account_industry,
        -- Prospect context
        p.first_name AS prospect_first_name, p.last_name AS prospect_last_name,
        p.company_name AS prospect_company_name, p.stage AS prospect_stage, p.email AS prospect_email,
        -- Creator name
        u.first_name || ' ' || u.last_name AS created_by_name
      FROM straps s
      LEFT JOIN deals d ON s.entity_type IN ('deal','implementation') AND s.entity_id = d.id
      LEFT JOIN accounts da ON d.account_id = da.id
      LEFT JOIN accounts a ON s.entity_type = 'account' AND s.entity_id = a.id
      LEFT JOIN prospects p ON s.entity_type = 'prospect' AND s.entity_id = p.id
      LEFT JOIN users u ON s.created_by = u.id
      WHERE s.org_id = $1
        AND s.status = 'active'
        ${ownerFilter}
        ${typeFilter}
      ORDER BY
        CASE s.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        s.created_at DESC
    `, params);

    let straps = result.rows.map(row => ({
      ...row,
      // Build entity context object
      entityContext: this._buildEntityContext(row),
    }));

    // Post-filter by dealId or accountId if provided
    if (dealId) {
      const did = parseInt(dealId);
      straps = straps.filter(s =>
        (s.entity_type === 'deal' && s.entity_id === did) ||
        (s.entity_type === 'implementation' && s.entity_id === did) ||
        (s.entity_type === 'account' && s.deal_account_id === did)
      );
    }
    if (accountId) {
      const aid = parseInt(accountId);
      straps = straps.filter(s =>
        (s.entity_type === 'account' && s.entity_id === aid) ||
        (s.entity_type === 'deal' && s.deal_account_id === aid)
      );
    }

    return straps;
  }

  /**
   * Build a unified entity context object for a STRAP row.
   */
  static _buildEntityContext(row) {
    switch (row.entity_type) {
      case 'deal':
      case 'implementation':
        return {
          entityName: row.deal_name || `Deal #${row.entity_id}`,
          dealName: row.deal_name,
          dealStage: row.deal_stage,
          dealValue: row.deal_value,
          accountName: row.deal_account_name,
          accountId: row.deal_account_id,
        };
      case 'account':
        return {
          entityName: row.account_name || `Account #${row.entity_id}`,
          accountName: row.account_name,
          industry: row.account_industry,
        };
      case 'prospect':
        return {
          entityName: [row.prospect_first_name, row.prospect_last_name].filter(Boolean).join(' ') || `Prospect #${row.entity_id}`,
          firstName: row.prospect_first_name,
          lastName: row.prospect_last_name,
          companyName: row.prospect_company_name,
          prospectStage: row.prospect_stage,
          email: row.prospect_email,
        };
      default:
        return { entityName: `${row.entity_type} #${row.entity_id}` };
    }
  }

  // ── Update STRAP fields (partial edit) ─────────────────────────────────────

  /**
   * Partially update an active STRAP's content fields.
   * Allows editing situation, target, response, action_plan, hurdle_title, priority.
   */
  static async update(strapId, userId, orgId, updates) {
    const strap = await this.getById(strapId, orgId);
    if (!strap) throw new Error('STRAP not found');
    if (strap.status !== 'active') throw new Error('STRAP is not active');

    await this._assertAccess(strap.entity_type, strap.entity_id, userId, orgId);

    const allowedFields = ['situation', 'target', 'response', 'action_plan', 'hurdle_title', 'priority'];
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = $${idx}`);
        values.push(updates[field]);
        idx++;
      }
    }

    if (setClauses.length === 0) throw new Error('No valid fields to update');

    values.push(strapId, orgId);
    const result = await db.query(
      `UPDATE straps SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND org_id = $${idx + 1}
       RETURNING *`,
      values
    );

    console.log(`✅ STRAP updated: #${strapId} (fields: ${setClauses.map(c => c.split(' ')[0]).join(', ')})`);
    return { strap: result.rows[0] };
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
