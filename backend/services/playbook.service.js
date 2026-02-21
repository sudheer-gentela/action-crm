/**
 * Playbook Service
 * Reads sales playbook and generates actions from key_actions
 *
 * MULTI-ORG: getPlaybook(userId, orgId) and getStageActions(userId, orgId, stageName)
 * now include org_id in their queries. user_playbooks has UNIQUE(user_id, org_id)
 * so a user can have different playbooks in different orgs.
 *
 * All pure-logic static helpers (classifyActionType, extractKeywords,
 * requiresExternalEvidence, suggestDueDays, suggestPriority) are unchanged.
 */

const db = require('../config/database');

class PlaybookService {

  /**
   * Get playbook for a specific user in a specific org.
   * @param {number} userId
   * @param {number} orgId
   */
  static async getPlaybook(userId, orgId) {
    const result = await db.query(
      'SELECT * FROM user_playbooks WHERE user_id = $1 AND org_id = $2',
      [userId, orgId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    const playbookData = typeof row.playbook_data === 'string'
      ? JSON.parse(row.playbook_data)
      : row.playbook_data;

    return {
      ...row,
      deal_stages:     playbookData?.deal_stages || playbookData,
      company_context: playbookData?.company_context,
    };
  }

  /**
   * Get key actions for a specific stage.
   * @param {number} userId
   * @param {number} orgId
   * @param {string} stageName
   */
  static async getStageActions(userId, orgId, stageName) {
    const playbook = await this.getPlaybook(userId, orgId);

    if (!playbook || !playbook.deal_stages) {
      return [];
    }

    let stageData;
    if (Array.isArray(playbook.deal_stages)) {
      stageData = playbook.deal_stages.find(s =>
        s.name === stageName || s.id === stageName
      );
    } else {
      stageData = playbook.deal_stages[stageName];
    }

    if (!stageData || !stageData.key_actions) {
      return [];
    }

    return stageData.key_actions;
  }

  // ── Pure-logic helpers (no DB — unchanged) ────────────────────────────────

  static classifyActionType(actionText) {
    const lower = actionText.toLowerCase();

    const patterns = {
      email_send:       ['send', 'email', 'forward', 'share', 'provide', 'deliver', 'transmit', 'distribute'],
      meeting_schedule: ['schedule', 'book', 'set up', 'arrange', 'meeting', 'demo', 'call', 'presentation', 'walkthrough'],
      document_prep:    ['prepare', 'create', 'build', 'draft', 'customize', 'develop', 'design', 'tailor'],
      task_complete:    ['complete', 'finish', 'approve', 'confirm', 'review', 'validate', 'verify', 'check'],
    };

    for (const [type, keywords] of Object.entries(patterns)) {
      if (keywords.some(kw => lower.includes(kw))) return type;
    }

    return 'manual';
  }

  static extractKeywords(actionText) {
    const lower = actionText.toLowerCase();

    const keywordCandidates = [
      'deck', 'presentation', 'slides', 'proposal', 'contract',
      'quote', 'pricing', 'roi', 'calculator', 'msa', 'sow',
      'demo', 'demonstration', 'walkthrough', 'review', 'call',
      'discovery', 'qbr', 'kickoff',
      'security', 'legal', 'procurement', 'technical', 'executive',
      'send', 'schedule', 'customize', 'prepare', 'follow up',
      'invite', 'share', 'deliver',
    ];

    const found = keywordCandidates.filter(kw => lower.includes(kw));

    const words = actionText
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'from'].includes(w));

    return [...new Set([...found, ...words.slice(0, 3)])].slice(0, 5);
  }

  static requiresExternalEvidence(actionType, actionText) {
    const lower = actionText.toLowerCase();

    if (actionType === 'email_send' || actionType === 'meeting_schedule') {
      if (lower.includes('internal') || lower.includes('team') || lower.includes('preparation')) {
        return false;
      }
      return true;
    }

    if (actionType === 'document_prep') {
      if (lower.includes('send') || lower.includes('deliver') || lower.includes('share')) {
        return true;
      }
      return false;
    }

    return false;
  }

  static suggestDueDays(stageName, actionType) {
    const urgent = { email_send: 1, meeting_schedule: 2, document_prep: 2, task_complete: 3, manual: 5 };
    const normal = { email_send: 2, meeting_schedule: 3, document_prep: 3, task_complete: 5, manual: 7 };
    const lateStages = ['proposal', 'negotiation', 'closing', 'verbal'];
    return lateStages.some(s => stageName.toLowerCase().includes(s))
      ? urgent[actionType]
      : normal[actionType];
  }

  static suggestPriority(stageName, actionType) {
    const lateStages = ['proposal', 'negotiation', 'closing', 'verbal'];
    if (lateStages.some(s => stageName.toLowerCase().includes(s))) {
      return (actionType === 'email_send' || actionType === 'meeting_schedule') ? 'high' : 'medium';
    }
    return 'medium';
  }
}

module.exports = PlaybookService;
