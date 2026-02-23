// ─────────────────────────────────────────────────────────────────────────────
// playbook.service.js
//
// Provides stage-aware playbook data to ActionsRulesEngine and actionsGenerator.
// Resolution order:
//   1. Org default playbook (playbooks table, stage_guidance JSONB keyed by stage_type)
//   2. Hardcoded salesPlaybook.js (fallback — maps legacy stage keys to stage_types)
//
// user_playbooks table has been deprecated — all reads now use the playbooks table.
// ─────────────────────────────────────────────────────────────────────────────

const db            = require('../config/database');
const SALES_PLAYBOOK = require('../config/salesPlaybook');

// ── Legacy key → stage_type map (for salesPlaybook.js fallback) ───────────────
const LEGACY_KEY_TO_STAGE_TYPE = {
  qualified:   'discovery',
  demo:        'evaluation',
  proposal:    'proposal',
  negotiation: 'negotiation',
  closing:     'closing',
  closed_won:  'closed_won',
  closed_lost: 'closed_lost',
};

class PlaybookService {

  // ── getStageGuidance ─────────────────────────────────────────────────────────
  // Returns the full guidance object for a given stage_type from the org's
  // default playbook. Falls back to salesPlaybook.js if no DB entry found.
  //
  // stageType: one of the VALID_STAGE_TYPES enum values
  // userId:    deal owner — used to scope the org default playbook lookup

  static async getStageGuidance(userId, stageType) {
    try {
      // Look up the org's default playbook via the user's org_id
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
        if (parsed && parsed[stageType]) {
          return parsed[stageType];
        }
      }
    } catch (err) {
      console.error('PlaybookService.getStageGuidance DB error:', err.message);
    }

    // Fallback: map stage_type back to salesPlaybook.js key
    return this._getFallbackGuidance(stageType);
  }

  // ── getStageActions ──────────────────────────────────────────────────────────
  // Returns the key_actions array for a given stage_type.
  // Called by actionsGenerator.buildContext() and _playbookRules().
  //
  // Accepts both a stage_type (e.g. 'discovery') and a legacy stage key
  // (e.g. 'qualified') for backward compatibility during transition.

  static async getStageActions(userId, stageOrType) {
    // Normalise: if a legacy key is passed, convert to stage_type
    const stageType = LEGACY_KEY_TO_STAGE_TYPE[stageOrType] || stageOrType;

    // Terminal stages have no key_actions
    if (['closed_won', 'closed_lost'].includes(stageType)) return [];

    const guidance = await this.getStageGuidance(userId, stageType);
    return guidance?.key_actions || [];
  }

  // ── getFullPlaybook ──────────────────────────────────────────────────────────
  // Returns the entire playbook for a user (used by PlaybookEditor).

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
  // Saves guidance for a single stage_type into the org's default playbook.
  // Called by playbooks.routes.js PUT /:id/stages/:stageType

  static async upsertStageGuidance(playbookId, orgId, stageType, guidance) {
    const result = await db.query(
      `UPDATE playbooks
       SET stage_guidance = stage_guidance || $1::jsonb,
           updated_at     = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id, stage_guidance`,
      [JSON.stringify({ [stageType]: guidance }), playbookId, orgId]
    );
    if (result.rows.length === 0) throw new Error('Playbook not found');
    return result.rows[0];
  }

  // ── classifyActionType ───────────────────────────────────────────────────────
  // Infers action_type from playbook action text (unchanged from original).

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
    if (text.includes('research') || text.includes('identify') || text.includes('map') ||
        text.includes('review') || text.includes('record')) {
      return 'task_complete';
    }
    return 'task_complete';
  }

  // ── suggestPriority ──────────────────────────────────────────────────────────
  // Suggests priority based on stage_type (replaces legacy stage key version).

  static suggestPriority(stageOrType, actionType) {
    const stageType = LEGACY_KEY_TO_STAGE_TYPE[stageOrType] || stageOrType;
    const highPriorityStages = ['negotiation', 'closing', 'proposal'];
    if (highPriorityStages.includes(stageType)) return 'high';
    if (actionType === 'meeting_schedule') return 'high';
    if (actionType === 'email_send')       return 'medium';
    return 'medium';
  }

  // ── suggestDueDays ───────────────────────────────────────────────────────────

  static suggestDueDays(stageOrType, actionType) {
    const stageType = LEGACY_KEY_TO_STAGE_TYPE[stageOrType] || stageOrType;
    const urgentStages = { negotiation: 1, closing: 1, proposal: 2 };
    if (urgentStages[stageType]) return urgentStages[stageType];
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

  // ── Private: fallback to salesPlaybook.js ─────────────────────────────────────

  static _getFallbackGuidance(stageType) {
    // salesPlaybook.js is keyed by legacy stage names — map back
    const legacyKey = Object.entries(LEGACY_KEY_TO_STAGE_TYPE)
      .find(([, v]) => v === stageType)?.[0];

    if (legacyKey && SALES_PLAYBOOK.deal_stages?.[legacyKey]) {
      return SALES_PLAYBOOK.deal_stages[legacyKey];
    }

    return null;
  }
}

module.exports = PlaybookService;
