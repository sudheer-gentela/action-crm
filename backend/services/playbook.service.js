// ─────────────────────────────────────────────────────────────────────────────
// playbook.service.js
//
// Provides stage-aware playbook data to ActionsRulesEngine and actionsGenerator.
//
// KEY CHANGE: stage_guidance is now keyed by stage KEY (e.g. "qualified", "demo",
// "security_review") instead of stage_type (e.g. "evaluation"). This means each
// stage gets its own guidance regardless of whether multiple stages share a type.
//
// Resolution order:
//   1. Org default playbook — stage_guidance JSONB keyed by stage key
//   2. salesPlaybook.js fallback — already keyed by stage key, so no mapping needed
// ─────────────────────────────────────────────────────────────────────────────

const db             = require('../config/database');
const SALES_PLAYBOOK = require('../config/salesPlaybook');

class PlaybookService {

  // ── getStageGuidance ─────────────────────────────────────────────────────────
  // Returns the full guidance object for a given stage key from the org's
  // default playbook. Falls back to salesPlaybook.js if no DB entry found.
  //
  // stageKey: the deal_stages.key value (e.g. "qualified", "demo", "proposal")
  // userId:   deal owner — used to scope the org default playbook lookup

  static async getStageGuidance(userId, stageKey) {
    if (!stageKey) return null;

    try {
      const result = await db.query(
        `SELECT p.stage_guidance
         FROM playbooks p
         JOIN users u ON u.org_id = p.org_id
         WHERE u.id = $1 AND p.is_default = TRUE
         LIMIT 1`,
        [userId]
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

    // Fallback: salesPlaybook.js is already keyed by stage key
    return this._getFallbackGuidance(stageKey);
  }

  // ── getStageActions ──────────────────────────────────────────────────────────
  // Returns the key_actions array for a given stage key.
  // Called by actionsGenerator.buildContext().

  static async getStageActions(userId, stageKey) {
    if (!stageKey) return [];

    // Terminal stages have no key_actions — check common terminal keys
    // (is_terminal flag is also checked by the caller, but guard here too)
    if (['closed_won', 'closed_lost'].includes(stageKey)) return [];

    const guidance = await this.getStageGuidance(userId, stageKey);
    return guidance?.key_actions || [];
  }

  // ── getFullPlaybook ──────────────────────────────────────────────────────────
  // Returns the entire default playbook for an org.

  static async getFullPlaybook(userId, orgId) {
    try {
      const result = await db.query(
        `SELECT * FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
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

  // ── upsertStageGuidance ──────────────────────────────────────────────────────
  // Saves guidance for a single stage key into a playbook's stage_guidance JSONB.
  // Called by playbooks.routes.js PUT /:id/stages/:stageKey

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
  // Removes guidance for a stage key. Called when a stage key is renamed —
  // the cascade in deal-stages.routes.js should also call this to clean up
  // the old key's guidance entry.

  static async removeStageGuidance(playbookId, orgId, stageKey) {
    await db.query(
      `UPDATE playbooks
       SET stage_guidance = stage_guidance - $1,
           updated_at     = NOW()
       WHERE id = $2 AND org_id = $3`,
      [stageKey, playbookId, orgId]
    );
  }

  // ── classifyActionType ───────────────────────────────────────────────────────

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

  // ── suggestPriority ──────────────────────────────────────────────────────────
  // Uses stage_type for semantic priority hints since that's the stable
  // semantic signal (key can be anything the org names it).

  static suggestPriority(stageType, actionType) {
    const highPriorityTypes = ['negotiation', 'closing', 'proposal'];
    if (highPriorityTypes.includes(stageType)) return 'high';
    if (actionType === 'meeting_schedule') return 'high';
    if (actionType === 'email_send')       return 'medium';
    return 'medium';
  }

  // ── suggestDueDays ───────────────────────────────────────────────────────────

  static suggestDueDays(stageType, actionType) {
    const urgentTypes = { negotiation: 1, closing: 1, proposal: 2 };
    if (urgentTypes[stageType]) return urgentTypes[stageType];
    if (actionType === 'meeting_schedule') return 2;
    if (actionType === 'document_prep')    return 3;
    return 3;
  }

  // ── extractKeywords ──────────────────────────────────────────────────────────

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

  // ── requiresExternalEvidence ─────────────────────────────────────────────────

  static requiresExternalEvidence(actionType, actionText) {
    if (['email_send', 'meeting_schedule'].includes(actionType)) return true;
    const text = actionText.toLowerCase();
    return text.includes('send') || text.includes('schedule') || text.includes('meet');
  }

  // ── Private: fallback to salesPlaybook.js ────────────────────────────────────
  // salesPlaybook.js is already keyed by stage key — look up directly.

  static _getFallbackGuidance(stageKey) {
    if (SALES_PLAYBOOK.deal_stages?.[stageKey]) {
      return SALES_PLAYBOOK.deal_stages[stageKey];
    }
    return null;
  }
}

module.exports = PlaybookService;
