/**
 * actionsGenerator.js
 *
 * Orchestrates the full action generation pipeline for a user's deals.
 *
 * Pipeline (per deal):
 *   1. DealContextBuilder  — gather all 8 inputs in one DB round-trip
 *   2. ActionsRulesEngine  — fast, zero-cost rules covering all inputs
 *   3. ActionsAIEnhancer   — Claude (Haiku), only for risk/watch deals
 *   4. DB upsert           — smart deduplication, preserve manual actions
 *
 * Key changes from previous version:
 *   - Scoped to userId (never crosses users)
 *   - No blind DELETE — upserts by source_rule so manual/completed actions preserved
 *   - Playbook actions saved with source='playbook'
 *   - AI actions saved with source='ai_generated'
 */

const db                  = require('../config/database');
const DealContextBuilder  = require('./DealContextBuilder');
const ActionsRulesEngine  = require('./ActionsRulesEngine');
const ActionsAIEnhancer   = require('./ActionsAIEnhancer');
const ActionConfigService = require('./actionConfig.service');

class ActionsGenerator {

  // ── Public API ────────────────────────────────────────────────────────────

  static async generateAll(userId) {
    console.log('🤖 ActionsGenerator.generateAll — userId:', userId);

    const config = await ActionConfigService.getConfig(userId);
    if (config.generation_mode === 'manual') {
      return { success: true, generated: 0, inserted: 0, skipped: 0 };
    }

    const dealsResult = await db.query(
      `SELECT id FROM deals
       WHERE owner_id = $1
         AND deleted_at IS NULL
         AND stage NOT IN ('closed_won', 'closed_lost')
       ORDER BY health_score ASC NULLS LAST`,
      [userId]
    );

    const dealIds = dealsResult.rows.map(r => r.id);
    console.log('📊 Processing', dealIds.length, 'active deals');

    let totalInserted = 0, totalGenerated = 0, skipped = 0;

    for (const dealId of dealIds) {
      try {
        const { generated, inserted } = await this._processDeal(dealId, userId, config);
        totalGenerated += generated;
        totalInserted  += inserted;
      } catch (err) {
        console.error('❌ Error processing deal', dealId, ':', err.message);
        skipped++;
      }
    }

    console.log('✅ generateAll complete — generated:', totalGenerated, 'inserted:', totalInserted, 'skipped:', skipped);
    return { success: true, generated: totalGenerated, inserted: totalInserted, skipped };
  }

  static async generateForDeal(dealId, userId) {
    const config = await ActionConfigService.getConfig(userId);
    if (config.generation_mode === 'manual') return { generated: 0, inserted: 0 };
    return this._processDeal(dealId, userId, config);
  }

  static async generateForStageChange(dealId, newStage, userId) {
    console.log('📘 Stage change: deal', dealId, '→', newStage);
    // Remove stale stage actions (keep manual + ai + completed)
    await db.query(
      `DELETE FROM actions
       WHERE deal_id = $1 AND user_id = $2
         AND source IN ('auto_generated', 'playbook')
         AND completed = false`,
      [dealId, userId]
    );
    return this.generateForDeal(dealId, userId);
  }

  static async generateForEmail(emailId, userId) {
    const r = await db.query('SELECT deal_id FROM emails WHERE id = $1', [emailId]);
    if (!r.rows[0]?.deal_id) return;
    return this.generateForDeal(r.rows[0].deal_id, userId);
  }

  static async generateForMeeting(meetingId, userId) {
    const r = await db.query('SELECT deal_id FROM meetings WHERE id = $1', [meetingId]);
    if (!r.rows[0]?.deal_id) return;
    return this.generateForDeal(r.rows[0].deal_id, userId);
  }

  static async generateForFile(storageFileId, userId) {
    const r = await db.query('SELECT deal_id FROM storage_files WHERE id = $1', [storageFileId]);
    if (!r.rows[0]?.deal_id) return;
    return this.generateForDeal(r.rows[0].deal_id, userId);
  }

  // ── Core pipeline ─────────────────────────────────────────────────────────

  static async _processDeal(dealId, userId, config) {
    const context      = await DealContextBuilder.build(dealId, userId);
    const rulesActions = ActionsRulesEngine.generate(context);
    console.log('  📏 Rules:', rulesActions.length, 'actions for deal', dealId, '(' + context.deal.name + ')');

    const aiActions = await ActionsAIEnhancer.enhance(context, rulesActions, config);
    console.log('  🤖 AI:', aiActions.length, 'additional actions for deal', dealId);

    const inserted = await this._upsertActions([...rulesActions, ...aiActions], userId, context);
    return { generated: rulesActions.length + aiActions.length, inserted };
  }

  // ── DB upsert with deduplication ──────────────────────────────────────────

  static async _upsertActions(actions, userId, context) {
    if (actions.length === 0) return 0;

    const existing = await db.query(
      `SELECT source_rule, title FROM actions
       WHERE deal_id = $1 AND user_id = $2
         AND completed = false
         AND source IN ('auto_generated', 'playbook', 'ai_generated')`,
      [context.deal.id, userId]
    );

    const existingRules  = new Set(existing.rows.map(r => r.source_rule).filter(Boolean));
    const existingTitles = new Set(existing.rows.map(r => r.title.toLowerCase().trim()));

    let inserted = 0;

    for (const action of actions) {
      try {
        if (action.source_rule && existingRules.has(action.source_rule)) continue;
        if (existingTitles.has(action.title.toLowerCase().trim())) continue;

        await db.query(
          `INSERT INTO actions (
            user_id, deal_id, contact_id, account_id,
            type, action_type, title, description,
            priority, due_date,
            suggested_action, context,
            keywords, deal_stage, requires_external_evidence,
            health_param, source, source_rule, metadata,
            completed, created_at
          ) VALUES (
            $1,$2,$3,$4, $5,$6,$7,$8, $9,$10,
            $11,$12, $13,$14,$15, $16,$17,$18,$19,
            false, NOW()
          )`,
          [
            userId,
            action.deal_id || null,
            action.contact_id || null,
            action.account_id || null,
            action.type || action.action_type,
            action.action_type,
            action.title,
            action.description || null,
            action.priority || 'medium',
            action.due_date,
            action.suggested_action || null,
            action.context || null,
            action.keywords ? JSON.stringify(action.keywords) : null,
            action.deal_stage || context.deal.stage || null,
            action.requires_external_evidence || false,
            action.health_param || null,
            action.source || 'auto_generated',
            action.source_rule || null,
            action.metadata || null,
          ]
        );

        inserted++;
        existingRules.add(action.source_rule);
        existingTitles.add(action.title.toLowerCase().trim());

      } catch (err) {
        if (err.code !== '23505') {
          console.error('❌ Failed to insert action "' + action.title + '":', err.message);
        }
      }
    }

    return inserted;
  }
}

module.exports = ActionsGenerator;
