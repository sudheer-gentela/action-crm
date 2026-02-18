/**
 * Action Completion Detector
 * Analyzes emails and meetings to detect action completions
 * Supports rules-only, AI-only, and hybrid modes
 */

const db = require('../config/database');
const ActionConfigService = require('./actionConfig.service');

class ActionCompletionDetector {
  /**
   * Detect completion from a sent/received email
   */
  static async detectFromEmail(emailId, userId) {
    const config = await ActionConfigService.getConfig(userId);
    
    // Check if email detection is enabled
    if (config.detection_mode === 'manual' || !config.detect_from_emails) {
      return;
    }
    
    // Using db.query instead of pool
    try {
      // Get email details
      const emailResult = await db.query(
        'SELECT * FROM emails WHERE id = $1',
        [emailId]
      );
      
      if (emailResult.rows.length === 0) return;
      const email = emailResult.rows[0];
      
      if (!email.deal_id) return; // Email not linked to deal
      
      // Get open actions for this deal
      const actionsResult = await db.query(
        `SELECT * FROM actions 
         WHERE deal_id = $1 AND completed = false AND user_id = $2`,
        [email.deal_id, userId]
      );
      
      for (const action of actionsResult.rows) {
        const result = await this.analyze(action, email, 'email', config);
        
        if (result && result.confidence >= config.confidence_threshold) {
          if (result.confidence >= config.auto_complete_threshold) {
            // Auto-complete without suggestion
            await this.completeAction(action.id, result);
          } else {
            // Create suggestion for user review
            await this.createSuggestion(action.id, email.id, 'email', result, userId);
          }
        }
      }
    } finally {
      
    }
  }
  
  /**
   * Detect completion from a scheduled/completed meeting
   */
  static async detectFromMeeting(meetingId, userId) {
    const config = await ActionConfigService.getConfig(userId);
    
    if (config.detection_mode === 'manual' || !config.detect_from_meetings) {
      return;
    }
    
    // Using db.query instead of pool
    try {
      const meetingResult = await db.query(
        'SELECT * FROM meetings WHERE id = $1',
        [meetingId]
      );
      
      if (meetingResult.rows.length === 0) return;
      const meeting = meetingResult.rows[0];
      
      if (!meeting.deal_id) return;
      
      const actionsResult = await db.query(
        `SELECT * FROM actions 
         WHERE deal_id = $1 AND completed = false AND user_id = $2`,
        [meeting.deal_id, userId]
      );
      
      for (const action of actionsResult.rows) {
        const result = await this.analyze(action, meeting, 'meeting', config);
        
        if (result && result.confidence >= config.confidence_threshold) {
          if (result.confidence >= config.auto_complete_threshold) {
            await this.completeAction(action.id, result);
          } else {
            await this.createSuggestion(action.id, meeting.id, 'meeting', result, userId);
          }
        }
      }
    } finally {
      
    }
  }
  
  /**
   * Analyze whether evidence completes an action
   */
  static async analyze(action, evidence, evidenceType, config) {
    const mode = config.detection_mode;
    
    if (mode === 'rules_only') {
      return this.analyzeWithRules(action, evidence, evidenceType);
    }
    
    if (mode === 'ai_only') {
      return this.analyzeWithAI(action, evidence, evidenceType);
    }
    
    if (mode === 'hybrid') {
      // Try rules first
      const rulesResult = this.analyzeWithRules(action, evidence, evidenceType);
      
      // If confidence is very low or very high, trust rules
      if (rulesResult.confidence < 40 || rulesResult.confidence > 90) {
        rulesResult.detection_source = 'rules';
        return rulesResult;
      }
      
      // Ambiguous case - use AI
      const aiResult = await this.analyzeWithAI(action, evidence, evidenceType);
      aiResult.detection_source = 'ai';
      return aiResult;
    }
    
    return null;
  }
  
  /**
   * Rules-based analysis (fast, no AI cost)
   */
  static analyzeWithRules(action, evidence, evidenceType) {
    let score = 0;
    const weights = {
      keyword_match: 30,
      attachment_type: 20,
      external_recipient: 20,
      type_match: 15,
      timing: 10,
      no_negation: 5
    };
    
    const flags = [];
    
    // Build searchable text
    let searchText = '';
    if (evidenceType === 'email') {
      searchText = `${evidence.subject || ''} ${evidence.body || ''}`.toLowerCase();
    } else if (evidenceType === 'meeting') {
      searchText = `${evidence.title || ''} ${evidence.description || ''}`.toLowerCase();
    }
    
    // 1. Keyword matching
    if (action.keywords && action.keywords.length > 0) {
      const matches = action.keywords.filter(kw => 
        searchText.includes(kw.toLowerCase())
      );
      score += weights.keyword_match * (matches.length / action.keywords.length);
    }
    
    // 2. Attachment type (for email actions)
    if (evidenceType === 'email' && action.action_type === 'email_send') {
      // Check if email has attachments
      if (evidence.has_attachments) {
        score += weights.attachment_type;
      }
    }
    
    // 3. External recipient check (for actions requiring external evidence)
    if (action.requires_external_evidence && evidenceType === 'email') {
      // Check if email was sent externally
      const direction = evidence.direction;
      if (direction === 'sent') {
        score += weights.external_recipient;
      } else {
        flags.push('internal_only');
        score -= 20; // Big penalty for internal emails on external actions
      }
    }
    
    // 4. Action type alignment
    if (action.action_type === 'email_send' && evidenceType === 'email') {
      score += weights.type_match;
    } else if (action.action_type === 'meeting_schedule' && evidenceType === 'meeting') {
      score += weights.type_match;
    }
    
    // 5. Negation detection
    const negationWords = ['discuss', 'planning', 'thinking about', 'considering', 'not yet', 'prepare to'];
    const hasNegation = negationWords.some(word => searchText.includes(word));
    
    if (hasNegation) {
      flags.push('negation_detected');
      score -= 15;
    } else {
      score += weights.no_negation;
    }
    
    const confidence = Math.max(0, Math.min(100, Math.round(score)));
    
    return {
      completes_action: confidence >= 60,
      confidence,
      reasoning: `Rules-based analysis: ${confidence}% confidence`,
      evidence: this.extractEvidence(evidence, evidenceType),
      flags,
      detection_source: 'rules'
    };
  }
  
  /**
   * AI-based analysis (uses Claude API via prompt)
   * NOTE: This requires Anthropic API integration - placeholder for now
   */
  static async analyzeWithAI(action, evidence, evidenceType) {
    // TODO: Implement AI analysis using Anthropic API
    // For now, fall back to rules
    console.log('⚠️ AI analysis not yet implemented, using rules fallback');
    return this.analyzeWithRules(action, evidence, evidenceType);
    
    /* FUTURE IMPLEMENTATION:
    const prompt = await this.buildPrompt(action, evidence, evidenceType);
    const response = await callAnthropicAPI(prompt);
    return JSON.parse(response);
    */
  }
  
  /**
   * Extract evidence snippet from email or meeting
   */
  static extractEvidence(evidence, evidenceType) {
    if (evidenceType === 'email') {
      const subject = evidence.subject || '';
      const snippet = evidence.body ? evidence.body.substring(0, 100) : '';
      return `${subject} - ${snippet}${snippet.length === 100 ? '...' : ''}`;
    } else if (evidenceType === 'meeting') {
      return evidence.title || '';
    }
    return '';
  }
  
  /**
   * Complete an action with evidence
   */
  static async completeAction(actionId, analysis) {
    await db.query(
      `UPDATE actions 
       SET completed = true,
           auto_completed = true,
           completion_confidence = $1,
           completion_evidence = $2,
           completed_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [
        analysis.confidence,
        JSON.stringify({
          reasoning: analysis.reasoning,
          evidence: analysis.evidence,
          flags: analysis.flags,
          source: analysis.detection_source
        }),
        actionId
      ]
    );
    
    console.log(`✅ Auto-completed action ${actionId} with ${analysis.confidence}% confidence`);
  }
  
  /**
   * Create a suggestion for user to review
   */
  static async createSuggestion(actionId, evidenceId, evidenceType, analysis, userId) {
    await db.query(
      `INSERT INTO action_suggestions (
        action_id, user_id, evidence_type, evidence_id, 
        evidence_snippet, confidence, reasoning, detection_source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        actionId,
        userId,
        evidenceType,
        evidenceId,
        analysis.evidence,
        analysis.confidence,
        analysis.reasoning,
        analysis.detection_source
      ]
    );
    
    // Add to pending_suggestions array on action
    await db.query(
      `UPDATE actions 
       SET pending_suggestions = COALESCE(pending_suggestions, '{}') || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          id: evidenceId,
          type: evidenceType,
          confidence: analysis.confidence,
          snippet: analysis.evidence
        }),
        actionId
      ]
    );
    
    console.log(`💡 Created suggestion for action ${actionId} with ${analysis.confidence}% confidence`);
  }
  
  /**
   * Accept a suggestion (user confirms it completes the action)
   */
  static async acceptSuggestion(suggestionId, userId) {
    // Using db.query instead of pool
    try {
      // Get suggestion
      const suggResult = await db.query(
        'SELECT * FROM action_suggestions WHERE id = $1 AND user_id = $2',
        [suggestionId, userId]
      );
      
      if (suggResult.rows.length === 0) {
        throw new Error('Suggestion not found');
      }
      
      const suggestion = suggResult.rows[0];
      
      // Complete the action
      await db.query(
        `UPDATE actions 
         SET completed = true,
             auto_completed = false,
             completion_confidence = $1,
             completion_evidence = $2,
             completed_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [
          suggestion.confidence,
          JSON.stringify({
            type: suggestion.evidence_type,
            id: suggestion.evidence_id,
            snippet: suggestion.evidence_snippet,
            source: 'user_accepted_suggestion'
          }),
          suggestion.action_id
        ]
      );
      
      // Mark suggestion as accepted
      await db.query(
        `UPDATE action_suggestions 
         SET status = 'accepted', resolved_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [suggestionId]
      );
      
      console.log(`✅ User accepted suggestion ${suggestionId} for action ${suggestion.action_id}`);
    } finally {
      
    }
  }
  
  /**
   * Dismiss a suggestion (user says it doesn't complete the action)
   */
  static async dismissSuggestion(suggestionId, userId) {
    // Using db.query instead of pool
    try {
      await db.query(
        `UPDATE action_suggestions 
         SET status = 'dismissed', resolved_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2`,
        [suggestionId, userId]
      );
      
      console.log(`❌ User dismissed suggestion ${suggestionId}`);
    } finally {
      
    }
  }
}

module.exports = ActionCompletionDetector;
