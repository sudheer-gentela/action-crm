// ─────────────────────────────────────────────────────────────────────────────
// playbook.service.js
//
// Provides stage-aware playbook data to ActionsRulesEngine and actionsGenerator.
//
// CHANGES FROM PREVIOUS VERSION:
//   - getStageGuidance(orgId, stageKey)  — was getStageGuidance(userId, stageKey)
//   - getStageActions(orgId, stageKey)   — was getStageActions(userId, stageKey)
//   - getFullPlaybook(orgId)             — was getFullPlaybook(userId, orgId)
//   - All three now query playbooks directly by org_id — no JOIN through users.
//   - getCLMPlaybook(orgId)              — NEW: returns the CLM playbook plays
//     for ContractActionsGenerator.
//   - salesPlaybook.js fallback is retained until every org has a seeded
//     sales playbook in the DB.
// ─────────────────────────────────────────────────────────────────────────────

const db             = require('../config/database');
const SALES_PLAYBOOK = require('../config/salesPlaybook');

class PlaybookService {

  // ── getStageGuidance ─────────────────────────────────────────────────────────
  // Returns the full guidance object for a given stage key from the org's
  // default SALES playbook. Falls back to salesPlaybook.js if no DB entry found.

  static async getStageGuidance(orgId, stageKey) {
    if (!stageKey || !orgId) return null;

    try {
      const result = await db.query(
        `SELECT stage_guidance
         FROM playbooks
         WHERE org_id = $1
           AND is_default = TRUE
           AND type != 'clm'
         LIMIT 1`,
        [orgId]
      );

      if (result.rows.length > 0) {
        const guidance = result.rows[0].stage_guidance;
        const parsed   = typeof guidance === 'string' ? JSON.parse(guidance) : guidance;
        if (parsed && parsed[stageKey]) {
          return parsed[stageKey];
        }
      }
    } catch (err) {
      console.error('PlaybookService.getStageGuidance DB error:', err.message);
    }

    return this._getFallbackGuidance(stageKey);
  }

  // ── getStageActions ──────────────────────────────────────────────────────────
  // Returns the key_actions array for a given stage key.

  static async getStageActions(orgId, stageKey) {
    if (!stageKey || !orgId) return [];
    if (['closed_won', 'closed_lost'].includes(stageKey)) return [];

    const guidance = await this.getStageGuidance(orgId, stageKey);
    return guidance?.key_actions || [];
  }

  // ── getFullPlaybook ──────────────────────────────────────────────────────────
  // Returns the entire default sales playbook for an org.

  static async getFullPlaybook(orgId) {
    if (!orgId) return null;
    try {
      const result = await db.query(
        `SELECT * FROM playbooks
         WHERE org_id = $1
           AND is_default = TRUE
           AND type != 'clm'
         LIMIT 1`,
        [orgId]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          ...row,
          stage_guidance: typeof row.stage_guidance === 'string'
            ? JSON.parse(row.stage_guidance)
            : (row.stage_guidance || {}),
          content: typeof row.content === 'string'
            ? JSON.parse(row.content)
            : (row.content || {}),
        };
      }
    } catch (err) {
      console.error('PlaybookService.getFullPlaybook error:', err.message);
    }
    return null;
  }

  // ── getCLMPlaybook ───────────────────────────────────────────────────────────
  // Returns all active plays from the org's CLM playbook, ordered by sort_order.
  // Used exclusively by ContractActionsGenerator.
  //
  // Returns array of playbook_plays rows:
  //   { id, stage_key, title, description, channel, priority,
  //     due_offset_days, execution_type, sort_order }

  static async getCLMPlays(orgId) {
    if (!orgId) return [];
    try {
      const result = await db.query(
        `SELECT pp.id, pp.stage_key, pp.title, pp.description,
                pp.channel, pp.priority, pp.due_offset_days,
                pp.execution_type, pp.sort_order
         FROM playbook_plays pp
         JOIN playbooks pb ON pb.id = pp.playbook_id
         WHERE pb.org_id   = $1
           AND pb.type     = 'clm'
           AND pp.is_active = TRUE
           AND pp.execution_type = 'auto'
         ORDER BY pp.sort_order ASC`,
        [orgId]
      );
      return result.rows;
    } catch (err) {
      console.error('PlaybookService.getCLMPlays error:', err.message);
      return [];
    }
  }

  // ── upsertStageGuidance ──────────────────────────────────────────────────────

  static async upsertStageGuidance(playbookId, orgId, stageKey, guidance) {
    const result = await db.query(
      `UPDATE playbooks
       SET stage_guidance = stage_guidance || $1::jsonb,
           updated_at     = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id, stage_guidance`,
      [JSON.stringify({ [stageKey]: guidance }), playbookId, orgId]
    );
    if (result.rows.length === 0) throw new Error('Playbook not found');
    return result.rows[0];
  }

  // ── removeStageGuidance ──────────────────────────────────────────────────────

  static async removeStageGuidance(playbookId, orgId, stageKey) {
    await db.query(
      `UPDATE playbooks
       SET stage_guidance = stage_guidance - $1,
           updated_at     = NOW()
       WHERE id = $2 AND org_id = $3`,
      [stageKey, playbookId, orgId]
    );
  }

  // ── Utility methods (used by ActionsRulesEngine) ─────────────────────────────

  static classifyActionType(actionText) {
    const text = actionText.toLowerCase();
    if (text.includes('schedule') || text.includes('meeting') || text.includes('call')) {
      return 'meeting_schedule';
    }
    if (text.includes('send') || text.includes('email') || text.includes('follow')) {
      return 'email_send';
    }
    if (text.includes('prepare') || text.includes('document') || text.includes('proposal') ||
        text.includes('create') || text.includes('draft')) {
      return 'document_prep';
    }
    return 'task_complete';
  }

  static suggestPriority(stageType, actionType) {
    const highPriorityTypes = ['negotiation', 'closing', 'proposal'];
    if (highPriorityTypes.includes(stageType)) return 'high';
    if (actionType === 'meeting_schedule') return 'high';
    if (actionType === 'email_send')       return 'medium';
    return 'medium';
  }

  static suggestDueDays(stageType, actionType) {
    const urgentTypes = { negotiation: 1, closing: 1, proposal: 2 };
    if (urgentTypes[stageType]) return urgentTypes[stageType];
    if (actionType === 'meeting_schedule') return 2;
    if (actionType === 'document_prep')    return 3;
    return 3;
  }

  static extractKeywords(actionText) {
    const keywords = [];
    const text = actionText.toLowerCase();
    const map = {
      schedule: 'scheduling', meeting: 'meeting', call: 'call',
      email: 'email', send: 'email', proposal: 'proposal',
      document: 'documentation', research: 'research',
      identify: 'identification', roi: 'roi', demo: 'demonstration',
    };
    Object.entries(map).forEach(([k, v]) => {
      if (text.includes(k) && !keywords.includes(v)) keywords.push(v);
    });
    return keywords.length ? keywords.join(',') : null;
  }

  static requiresExternalEvidence(actionType, actionText) {
    if (['email_send', 'meeting_schedule'].includes(actionType)) return true;
    const text = actionText.toLowerCase();
    return text.includes('send') || text.includes('schedule') || text.includes('meet');
  }

  // ── Private fallback ─────────────────────────────────────────────────────────

  static _getFallbackGuidance(stageKey) {
    if (SALES_PLAYBOOK.deal_stages?.[stageKey]) {
      return SALES_PLAYBOOK.deal_stages[stageKey];
    }
    return null;
  }
}

module.exports = PlaybookService;
