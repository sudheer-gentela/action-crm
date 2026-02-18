/**
 * Playbook Service
 * Reads sales playbook and generates actions from key_actions
 */

const db = require('../config/database');

class PlaybookService {
  /**
   * Get playbook for a specific user
   */
  static async getPlaybook(userId) {
    const result = await db.query(
      'SELECT * FROM user_playbooks WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    
    // Parse JSON fields - user_playbooks stores as playbook_data column
    const playbookData = typeof row.playbook_data === 'string' 
      ? JSON.parse(row.playbook_data)
      : row.playbook_data;
    
    return {
      ...row,
      deal_stages: playbookData?.deal_stages || playbookData,
      company_context: playbookData?.company_context
    };
  }
  
  /**
   * Get key actions for a specific stage
   */
  static async getStageActions(userId, stageName) {
    const playbook = await this.getPlaybook(userId);
    
    if (!playbook || !playbook.deal_stages) {
      return [];
    }
    
    // Handle both object and array formats
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
  
  /**
   * Classify action type based on action text
   * Uses keywords to determine email_send, meeting_schedule, document_prep, etc.
   */
  static classifyActionType(actionText) {
    const lower = actionText.toLowerCase();
    
    const patterns = {
      email_send: [
        'send', 'email', 'forward', 'share', 'provide', 
        'deliver', 'transmit', 'distribute'
      ],
      meeting_schedule: [
        'schedule', 'book', 'set up', 'arrange', 'meeting',
        'demo', 'call', 'presentation', 'walkthrough'
      ],
      document_prep: [
        'prepare', 'create', 'build', 'draft', 'customize',
        'develop', 'design', 'tailor'
      ],
      task_complete: [
        'complete', 'finish', 'approve', 'confirm', 'review',
        'validate', 'verify', 'check'
      ]
    };
    
    // Check each pattern
    for (const [type, keywords] of Object.entries(patterns)) {
      if (keywords.some(kw => lower.includes(kw))) {
        return type;
      }
    }
    
    return 'manual';
  }
  
  /**
   * Extract relevant keywords from action text
   */
  static extractKeywords(actionText) {
    const lower = actionText.toLowerCase();
    
    // Common keywords to look for
    const keywordCandidates = [
      // Documents
      'deck', 'presentation', 'slides', 'proposal', 'contract',
      'quote', 'pricing', 'roi', 'calculator', 'msa', 'sow',
      
      // Meetings
      'demo', 'demonstration', 'walkthrough', 'review', 'call',
      'discovery', 'qbr', 'kickoff', 'presentation',
      
      // Stages/Processes
      'security', 'legal', 'procurement', 'technical', 'executive',
      
      // Actions
      'send', 'schedule', 'customize', 'prepare', 'follow up',
      'invite', 'share', 'deliver'
    ];
    
    const found = keywordCandidates.filter(kw => lower.includes(kw));
    
    // Also extract key nouns/verbs from the text
    const words = actionText
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'from'].includes(w));
    
    // Combine and dedupe
    const keywords = [...new Set([...found, ...words.slice(0, 3)])];
    
    return keywords.slice(0, 5); // Max 5 keywords
  }
  
  /**
   * Determine if action requires external evidence
   * (i.e., interaction with prospect vs internal work)
   */
  static requiresExternalEvidence(actionType, actionText) {
    const lower = actionText.toLowerCase();
    
    // Email and meeting types usually require external evidence
    if (actionType === 'email_send' || actionType === 'meeting_schedule') {
      // Unless explicitly internal
      if (lower.includes('internal') || lower.includes('team') || lower.includes('preparation')) {
        return false;
      }
      return true;
    }
    
    // Document prep is usually internal
    if (actionType === 'document_prep') {
      // Unless explicitly for sending
      if (lower.includes('send') || lower.includes('deliver') || lower.includes('share')) {
        return true;
      }
      return false;
    }
    
    return false;
  }
  
  /**
   * Calculate suggested due date based on stage and action type
   */
  static suggestDueDays(stageName, actionType) {
    // Aggressive timelines
    const urgent = {
      email_send: 1,
      meeting_schedule: 2,
      document_prep: 2,
      task_complete: 3,
      manual: 5
    };
    
    // Moderate timelines
    const normal = {
      email_send: 2,
      meeting_schedule: 3,
      document_prep: 3,
      task_complete: 5,
      manual: 7
    };
    
    // Use urgent for later stages
    const lateStages = ['proposal', 'negotiation', 'closing', 'verbal'];
    const isLateStage = lateStages.some(s => 
      stageName.toLowerCase().includes(s)
    );
    
    return isLateStage ? urgent[actionType] : normal[actionType];
  }
  
  /**
   * Determine priority based on stage and action type
   */
  static suggestPriority(stageName, actionType) {
    const lateStages = ['proposal', 'negotiation', 'closing', 'verbal'];
    const isLateStage = lateStages.some(s => 
      stageName.toLowerCase().includes(s)
    );
    
    if (isLateStage) {
      return actionType === 'email_send' || actionType === 'meeting_schedule' 
        ? 'high' 
        : 'medium';
    }
    
    return 'medium';
  }
}

module.exports = PlaybookService;
