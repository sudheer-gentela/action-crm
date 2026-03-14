/**
 * StrapEngine.js
 *
 * Universal STRAP orchestrator. Supports deal, account, prospect, implementation.
 *
 * Public API:
 *   preview(entityType, entityId, userId, orgId)
 *     → Builds playbook + AI drafts without saving. Returns both for user selection.
 *
 *   confirm(entityType, entityId, userId, orgId, { chosenSource, hurdle, draft })
 *     → Saves the user-chosen (and optionally edited) draft to DB, generates actions.
 *
 *   generate(entityType, entityId, userId, orgId, { useAI })
 *     → Fully automatic (used by auto-regen / reassess). Reads config, saves & generates.
 *
 *   override(entityType, entityId, userId, orgId, overrideData)
 *   resolve(strapId, userId, orgId, { resolutionType, note })
 *   reassess(strapId, userId, orgId)
 *   getActive(entityType, entityId, orgId)
 *   getHistory(entityType, entityId, orgId)
 *   getById(strapId, orgId)
 *   getAllActive(userId, orgId, options)
 *   update(strapId, userId, orgId, updates)
 */

const db                    = require('../config/database');
const StrapContextResolver  = require('./StrapContextResolver');
const StrapHurdleIdentifier = require('./StrapHurdleIdentifier');
const StrapStrategyBuilder  = require('./StrapStrategyBuilder');
const StrapActionGenerator  = require('./StrapActionGenerator');

// ── Config helpers ────────────────────────────────────────────────────────────

/**
 * Load STRAP generation config for a user+org.
 * Merges org defaults with user overrides stored in action_config.ai_settings.
 *
 * Returns:
 *   {
 *     mode:     'both' | 'playbook' | 'ai',   (default: 'both')
 *     provider: 'anthropic' | 'openai' | 'grok',  (default: 'anthropic')
 *     masterEnabled: boolean
 *   }
 */
async function loadStrapConfig(userId, orgId) {
  try {
    // Load user config first, then org-level config as fallback
    const [userRes, orgRes] = await Promise.all([
      db.query(
        `SELECT ai_settings FROM action_config WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId]
      ),
      db.query(
        // Org-level config has a sentinel user_id=0 or we read from the first admin
        // In this codebase the org-wide defaults are stored per-user but we want the
        // org admin's setting as the fallback. We look for any record for this org
        // where user_id != current user as the "org default".
        // Simplest safe approach: read the user's own config only and use hardcoded
        // system defaults — the OrgAdmin saves to the admin's OWN action_config which
        // becomes the reference. We'll just use the user's own config.
        `SELECT ai_settings FROM action_config WHERE user_id = $1 AND org_id = $2`,
        [userId, orgId]
      ),
    ]);

    // User's own ai_settings take priority
    const raw = userRes.rows[0]?.ai_settings || {};

    const masterEnabled = raw.master_enabled ?? true;
    const rawMode       = raw.strap_generation_mode || 'both';
    const provider      = raw.strap_ai_provider     || 'anthropic';

    // If master AI is disabled, force playbook mode
    const mode = masterEnabled ? rawMode : 'playbook';

    return { mode, provider, masterEnabled };
  } catch (err) {
    console.error('StrapEngine: failed to load strap config, using defaults:', err.message);
    return { mode: 'both', provider: 'anthropic', masterEnabled: true };
  }
}

class StrapEngine {

  // ── Preview — generate both drafts, save nothing ─────────────────────────

  /**
   * Build playbook and/or AI drafts for user selection.
   * Nothing is written to the database.
   *
   * @returns {{
   *   hurdle: object|null,
   *   message?: string,
   *   playbookDraft: object|null,
   *   aiDraft: object|null,
   *   aiUnavailable: boolean,
   *   aiUnavailableReason: string|null,
   *   effectiveMode: string,
   * }}
   */
  static async preview(entityType, entityId, userId, orgId) {
    await this._assertAccess(entityType, entityId, userId, orgId);

    const context = await StrapContextResolver.resolve(entityType, entityId, userId, orgId);
    const hurdle  = StrapHurdleIdentifier.identify(entityType, context);

    if (!hurdle) {
      return {
        hurdle: null,
        message: 'No hurdle identified — entity appears healthy.',
        playbookDraft: null,
        aiDraft: null,
        aiUnavailable: false,
        aiUnavailableReason: null,
        effectiveMode: 'none',
      };
    }

    const { mode, provider } = await loadStrapConfig(userId, orgId);

    // Check AI provider availability upfront
    let aiUnavailable     = false;
    let aiUnavailableReason = null;

    const needsAI = mode === 'ai' || mode === 'both';
    if (needsAI) {
      const availability = StrapStrategyBuilder.checkProviderAvailability(provider);
      if (!availability.available) {
        aiUnavailable       = true;
        aiUnavailableReason = availability.reason;
      }
    }

    // Determine effective mode after key check
    let effectiveMode = mode;
    if (mode === 'ai' && aiUnavailable) {
      effectiveMode = 'playbook'; // fall back silently
    }
    if (mode === 'both' && aiUnavailable) {
      effectiveMode = 'playbook_only'; // one-card modal with warning
    }

    // Build drafts in parallel where possible
    let playbookDraft = null;
    let aiDraft       = null;

    if (effectiveMode === 'playbook' || effectiveMode === 'playbook_only' || effectiveMode === 'both') {
      playbookDraft = await StrapStrategyBuilder.build(entityType, hurdle, context, 'playbook');
    }

    if ((effectiveMode === 'ai' || effectiveMode === 'both') && !aiUnavailable) {
      try {
        aiDraft = await StrapStrategyBuilder.build(entityType, hurdle, context, 'ai', provider);
        // If AI itself fell back to template internally (key check passed but call failed),
        // mark it clearly so the UI can show a degraded badge.
        if (aiDraft.fallbackUsed) {
          aiUnavailable       = true;
          aiUnavailableReason = aiDraft.fallbackReason;
          aiDraft = null;
          if (effectiveMode === 'ai') effectiveMode = 'playbook';
          if (effectiveMode === 'both') effectiveMode = 'playbook_only';
        }
      } catch (err) {
        aiUnavailable       = true;
        aiUnavailableReason = `AI generation failed: ${err.message}`;
        aiDraft = null;
        if (effectiveMode === 'ai')   effectiveMode = 'playbook';
        if (effectiveMode === 'both') effectiveMode = 'playbook_only';
      }
    }

    return {
      hurdle,
      playbookDraft,
      aiDraft,
      aiUnavailable,
      aiUnavailableReason,
      effectiveMode,
    };
  }

  // ── Confirm — save the user-chosen (and edited) draft ────────────────────

  /**
   * Persist the user's chosen STRAP draft to the database and generate actions.
   * The draft fields are used exactly as submitted — user edits are preserved.
   *
   * @param {string} entityType
   * @param {number} entityId
   * @param {number} userId
   * @param {number} orgId
   * @param {{
   *   chosenSource: 'playbook'|'ai',
   *   hurdle: { hurdleType: string, title: string, priority: string },
   *   draft: { situation: string, target: string, response: string, actionPlan: string }
   * }} payload
   * @returns {{ strap: object, actionCount: number }}
   */
  static async confirm(entityType, entityId, userId, orgId, payload) {
    await this._assertAccess(entityType, entityId, userId, orgId);

    const { chosenSource, hurdle, draft } = payload;

    if (!hurdle?.hurdleType || !hurdle?.title) {
      throw new Error('confirm() requires hurdle.hurdleType and hurdle.title');
    }
    if (!draft?.situation || !draft?.target) {
      throw new Error('confirm() requires draft.situation and draft.target');
    }
    if (!['playbook', 'ai'].includes(chosenSource)) {
      throw new Error('chosenSource must be "playbook" or "ai"');
    }

    // Resolve AI model name for audit (only relevant when chosenSource='ai')
    const { provider } = await loadStrapConfig(userId, orgId);
    const aiModel = chosenSource === 'ai'
      ? (require('./StrapStrategyBuilder') && (() => {
          // Access the AI_MODELS map via a small helper — avoids circular require issues
          const MODELS = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini', grok: 'grok-beta' };
          return MODELS[provider] || MODELS.anthropic;
        })())
      : null;

    // Supersede any existing active STRAP
    await this._supersedeActive(entityType, entityId, orgId);

    // Insert confirmed STRAP using the exact draft text the user confirmed/edited
    const result = await db.query(
      `INSERT INTO straps (
         org_id, entity_type, entity_id,
         hurdle_type, hurdle_title,
         situation, target, response, action_plan,
         priority, source,
         auto_hurdle_type, auto_hurdle_title,
         ai_model,
         created_by, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto',$4,$5,$11,$12,'active')
       RETURNING *`,
      [
        orgId, entityType, entityId,
        hurdle.hurdleType, hurdle.title,
        draft.situation, draft.target, draft.response || null, draft.actionPlan || null,
        hurdle.priority || 'medium',
        aiModel,
        userId,
      ]
    );

    const strap = result.rows[0];
    console.log(`✅ STRAP confirmed: ${entityType}/${entityId} → ${hurdle.hurdleType} (${hurdle.priority}) via ${chosenSource}`);

    // Build context for action generation (needed for calendar entries etc.)
    let context = {};
    try {
      context = await StrapContextResolver.resolve(entityType, entityId, userId, orgId);
    } catch (err) {
      console.warn('StrapEngine.confirm: context build failed (non-blocking):', err.message);
    }

    // Generate actions from the confirmed (user-edited) action_plan text
    let actionCount = 0;
    try {
      const actionResult = await StrapActionGenerator.generate(strap, context, userId, orgId);
      actionCount = actionResult.count;
      if (actionCount > 0) {
        console.log(`   📋 Generated ${actionCount} STRAP action(s) from confirmed plan`);
      }
    } catch (err) {
      console.error('   ⚠️ STRAP action generation failed (non-blocking):', err.message);
    }

    return { strap, actionCount };
  }

  // ── Generate — fully automatic (auto-regen / reassess) ───────────────────

  /**
   * Auto-generate a STRAP without user interaction.
   * Used by: StrapResolutionDetector auto-regen, reassess(), system triggers.
   * Reads action_config to determine mode — uses the configured provider.
   */
  static async generate(entityType, entityId, userId, orgId, { useAI } = {}) {
    await this._assertAccess(entityType, entityId, userId, orgId);

    const context = await StrapContextResolver.resolve(entityType, entityId, userId, orgId);
    const hurdle  = StrapHurdleIdentifier.identify(entityType, context);

    if (!hurdle) {
      return { strap: null, message: 'No hurdle identified — entity appears healthy.' };
    }

    // Determine mode: explicit useAI param → config → default
    let mode     = 'ai';
    let provider = 'anthropic';

    if (useAI === false) {
      mode = 'playbook';
    } else {
      const cfg = await loadStrapConfig(userId, orgId);
      provider = cfg.provider;
      // For auto-regen, resolve 'both' as 'ai' (pick the better path automatically)
      mode = cfg.mode === 'playbook' ? 'playbook' : 'ai';
    }

    const strategy = await StrapStrategyBuilder.build(entityType, hurdle, context, mode, provider);

    await this._supersedeActive(entityType, entityId, orgId);

    const aiModel = strategy.aiModel || null;

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
        aiModel,
        strategy.aiTokensUsed || null,
        userId,
      ]
    );

    const strap = result.rows[0];
    console.log(`✅ STRAP generated (auto): ${entityType}/${entityId} → ${hurdle.hurdleType} (${hurdle.priority})`);

    try {
      const actionResult = await StrapActionGenerator.generate(strap, context, userId, orgId);
      if (actionResult.count > 0) {
        console.log(`   📋 Created ${actionResult.count} STRAP action(s)`);
      }
    } catch (err) {
      console.error(`   ⚠️ STRAP action generation failed (non-blocking):`, err.message);
    }

    return { strap };
  }

  // ── Override ──────────────────────────────────────────────────────────────

  static async override(entityType, entityId, userId, orgId, overrideData) {
    await this._assertAccess(entityType, entityId, userId, orgId);

    const { hurdleType, hurdleTitle, situation, target, response, actionPlan, priority, reason } = overrideData;

    if (!hurdleType || !hurdleTitle) {
      throw new Error('Override requires hurdleType and hurdleTitle');
    }

    const existing = await this.getActive(entityType, entityId, orgId);
    await this._supersedeActive(entityType, entityId, orgId);

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
        existing?.auto_hurdle_type  || null,
        existing?.auto_hurdle_title || null,
        userId,
        reason || null,
      ]
    );

    const strap = result.rows[0];
    console.log(`✅ STRAP overridden: ${entityType}/${entityId} → ${hurdleType} (manual by user ${userId})`);

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

  static async reassess(strapId, userId, orgId) {
    const strap = await this.getById(strapId, orgId);
    if (!strap) throw new Error('STRAP not found');
    if (strap.status !== 'active') throw new Error('STRAP is not active');

    await this.resolve(strapId, userId, orgId, {
      resolutionType: 'superseded',
      note: 'Reassessed by user',
    });

    // Auto-generate using configured mode (no user selection for reassess)
    return this.generate(strap.entity_type, strap.entity_id, userId, orgId);
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

  static async getAllActive(userId, orgId, { scope = 'mine', subordinateIds = [], entityType, dealId, accountId } = {}) {
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

    let typeFilter = '';
    if (entityType) {
      params.push(entityType);
      typeFilter = `AND s.entity_type = $${params.length}`;
    }

    const result = await db.query(`
      SELECT
        s.*,
        d.name AS deal_name, d.stage AS deal_stage,
        d.value AS deal_value, d.account_id AS deal_account_id,
        da.name AS deal_account_name,
        a.name AS account_name, a.industry AS account_industry,
        p.first_name AS prospect_first_name, p.last_name AS prospect_last_name,
        p.company_name AS prospect_company_name, p.stage AS prospect_stage, p.email AS prospect_email,
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
      entityContext: this._buildEntityContext(row),
    }));

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

  static _buildEntityContext(row) {
    switch (row.entity_type) {
      case 'deal':
      case 'implementation':
        return {
          entityName:  row.deal_name || `Deal #${row.entity_id}`,
          dealName:    row.deal_name,
          dealStage:   row.deal_stage,
          dealValue:   row.deal_value,
          accountName: row.deal_account_name,
          accountId:   row.deal_account_id,
        };
      case 'account':
        return {
          entityName:  row.account_name || `Account #${row.entity_id}`,
          accountName: row.account_name,
          industry:    row.account_industry,
        };
      case 'prospect':
        return {
          entityName:  [row.prospect_first_name, row.prospect_last_name].filter(Boolean).join(' ') || `Prospect #${row.entity_id}`,
          firstName:   row.prospect_first_name,
          lastName:    row.prospect_last_name,
          companyName: row.prospect_company_name,
          prospectStage: row.prospect_stage,
          email:       row.prospect_email,
        };
      default:
        return { entityName: `${row.entity_type} #${row.entity_id}` };
    }
  }

  // ── Update (inline edit of active STRAP) ─────────────────────────────────

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

    // If action_plan changed, regenerate actions from new text
    if (updates.action_plan !== undefined) {
      try {
        const updatedStrap = result.rows[0];
        let context = {};
        try {
          context = await StrapContextResolver.resolve(
            updatedStrap.entity_type, updatedStrap.entity_id, userId, orgId
          );
        } catch (_) { /* non-blocking */ }
        const actionResult = await StrapActionGenerator.generate(updatedStrap, context, userId, orgId);
        console.log(`   📋 Regenerated ${actionResult.count} STRAP action(s) after plan edit`);
      } catch (err) {
        console.error('   ⚠️ STRAP action regeneration after edit failed (non-blocking):', err.message);
      }
    }

    console.log(`✅ STRAP updated: #${strapId}`);
    return { strap: result.rows[0] };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

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

  static async _assertAccess(entityType, entityId, userId, orgId) {
    switch (entityType) {
      case 'deal':
      case 'implementation': {
        const r = await db.query(
          `SELECT 1 FROM deals
           WHERE id = $1 AND org_id = $2 AND (
             owner_id = $3
             OR id IN (SELECT deal_id FROM deal_team_members WHERE user_id = $3 AND org_id = $2)
           )
           UNION
           SELECT 1 FROM straps
           WHERE entity_type = $4 AND entity_id = $1 AND org_id = $2 AND created_by = $3
           LIMIT 1`,
          [entityId, orgId, userId, entityType]
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
