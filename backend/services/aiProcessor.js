/**
 * AI Email Processor - Full Context Analysis with Template Support
 * CONSOLIDATED: Replaces claudeService.js - single AI processing engine
 */

const { Anthropic } = require('@anthropic-ai/sdk');
const db = require('../config/database');
const SALES_PLAYBOOK = require('../config/salesPlaybook');
const AI_PROMPTS = require('../config/aiPrompts');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

class AIProcessor {
  
  /**
   * SIMPLE EMAIL ANALYSIS (used by email queue processor)
   * Analyzes single email without full deal context
   * Returns: action_items, category, sentiment, etc.
   */
  static async analyzeEmailSimple(emailData) {
    const prompt = `You are an AI assistant that analyzes emails and extracts actionable information for a CRM system.

Analyze the following email:

From: ${emailData.from?.emailAddress?.name || emailData.from_address || 'Unknown'} <${emailData.from?.emailAddress?.address || emailData.from_address || 'unknown@email.com'}>
Subject: ${emailData.subject || 'No Subject'}
Date: ${emailData.receivedDateTime || emailData.sent_at || 'Unknown Date'}

Email Body:
${emailData.body?.content?.substring(0, 4000) || emailData.body?.substring(0, 4000) || emailData.bodyPreview || 'No content'}

Extract the following information and respond ONLY with valid JSON (no markdown, no backticks):

{
  "action_items": [
    {
      "description": "Clear, actionable description",
      "deadline": "ISO 8601 date or null if not mentioned",
      "priority": "high|medium|low",
      "estimated_effort": "Brief estimate like '30 minutes' or '2 hours'"
    }
  ],
  "key_contacts": ["email@example.com or contact names"],
  "category": "Sales|Support|Meeting Request|Follow-up|Task|Information|Other",
  "sentiment": "positive|neutral|negative|urgent",
  "priority": "high|medium|low",
  "summary": "1-2 sentence summary of the email",
  "requires_response": true or false,
  "suggested_actions": ["Brief action suggestions"]
}

Important:
- Only include action_items if there are clear, specific tasks mentioned
- Set requires_response to true if the email expects a reply
- Estimate priority based on urgency indicators, deadlines, and sender importance
- Return valid JSON only, no other text`;

    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });
      
      const responseText = message.content[0].text;
      
      // Clean and parse JSON
      const cleanedText = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      
      const analysis = JSON.parse(cleanedText);
      
      // Validate structure
      if (!analysis.action_items || !Array.isArray(analysis.action_items)) {
        analysis.action_items = [];
      }
      
      return analysis;
    } catch (error) {
      console.error('Claude analysis error:', error);
      
      // Return default structure on error
      return {
        action_items: [],
        key_contacts: [],
        category: 'Information',
        sentiment: 'neutral',
        priority: 'medium',
        summary: emailData.subject || 'Email analysis failed',
        requires_response: false,
        suggested_actions: [],
        error: error.message
      };
    }
  }
  
  /**
   * ADVANCED CONTEXT-AWARE EMAIL ANALYSIS (used by AI button)
   * Process email with full context: deal, contacts, history
   * Returns: strategic actions with confidence scores
   */
  static async processEmail(userId, emailId, source = 'outlook') {
    try {
      console.log(`🤖 AI Processing email ${emailId}...`);

      // Fetch email
      const email = await this.fetchEmail(userId, emailId);
      
      // Gather full context
      const context = await this.gatherFullContext(email, userId);
      
      // Get templates
      const promptTemplate = await this.getPromptTemplate(userId, 'email_analysis');
      const playbook = await this.getPlaybook(userId);
      
      // Build prompt from template
      const prompt = this.renderTemplate(promptTemplate, { email, context, playbook });
      
      // Call Claude
      const actions = await this.callClaude(prompt);
      
      // Save actions
      const saved = await this.saveActions(actions, userId, email, context);
      
      return { success: true, actions: saved };
      
    } catch (error) {
      console.error('AI processing error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Periodic deal health check
   */
  static async analyzeDeal(dealId, userId) {
    try {
      console.log(`🏥 Running health check on deal ${dealId}...`);

      const deal = await this.getDeal(dealId);
      const context = await this.gatherDealContext(dealId, userId);
      const promptTemplate = await this.getPromptTemplate(userId, 'deal_health_check');
      const playbook = await this.getPlaybook(userId);
      
      const prompt = this.renderTemplate(promptTemplate, { deal, context, playbook });
      const actions = await this.callClaude(prompt);
      const saved = await this.saveActions(actions, userId, { id: `deal-${dealId}` }, context);
      
      return { success: true, health_check: true, actions: saved };
      
    } catch (error) {
      console.error('Deal analysis error:', error);
      return { success: false, error: error.message };
    }
  }

  // ========== HELPER METHODS ==========

  static async fetchEmail(userId, emailId) {
    const result = await db.query('SELECT * FROM emails WHERE id = $1 AND user_id = $2', [emailId, userId]);
    return result.rows[0];
  }

  static async getDeal(dealId) {
    const result = await db.query('SELECT * FROM deals WHERE id = $1', [dealId]);
    return result.rows[0];
  }

  static async gatherFullContext(email, userId) {
    const context = { emailThread: [], meetings: [], dealHistory: [], contact: null, deal: null, account: null };
    
    try {
      // Find contact
      if (email.contact_id) {
        const contactResult = await db.query('SELECT * FROM contacts WHERE id = $1', [email.contact_id]);
        context.contact = contactResult.rows[0];
      }
      
      // Find deal
      if (email.deal_id) {
        const dealResult = await db.query('SELECT * FROM deals WHERE id = $1', [email.deal_id]);
        context.deal = dealResult.rows[0];
        
        // Get email thread
        const threadResult = await db.query(
          'SELECT * FROM emails WHERE deal_id = $1 ORDER BY sent_at ASC',
          [email.deal_id]
        );
        context.emailThread = threadResult.rows;
        
        // Get meetings
        const meetingsResult = await db.query(
          'SELECT * FROM meetings WHERE deal_id = $1 ORDER BY start_time DESC LIMIT 10',
          [email.deal_id]
        );
        context.meetings = meetingsResult.rows;
        
        // Get deal history
        const historyResult = await db.query(
          'SELECT * FROM deal_activities WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 20',
          [email.deal_id]
        );
        context.dealHistory = historyResult.rows;
      }
      
      // Get account
      if (context.contact?.account_id) {
        const accountResult = await db.query('SELECT * FROM accounts WHERE id = $1', [context.contact.account_id]);
        context.account = accountResult.rows[0];
      }
      
    } catch (error) {
      console.error('Context gathering error:', error);
    }
    
    return context;
  }

  static async gatherDealContext(dealId, userId) {
    // Similar to gatherFullContext but deal-centric
    return this.gatherFullContext({ deal_id: dealId }, userId);
  }

  static async getPlaybook(userId) {
    try {
      const result = await db.query('SELECT playbook_data FROM user_playbooks WHERE user_id = $1', [userId]);
      return result.rows.length > 0 ? result.rows[0].playbook_data : SALES_PLAYBOOK;
    } catch (error) {
      return SALES_PLAYBOOK;
    }
  }

  static async getPromptTemplate(userId, templateType) {
    try {
      const result = await db.query(
        'SELECT template_data FROM user_prompts WHERE user_id = $1 AND template_type = $2',
        [userId, templateType]
      );
      return result.rows.length > 0 ? result.rows[0].template_data : AI_PROMPTS[templateType];
    } catch (error) {
      return AI_PROMPTS[templateType];
    }
  }

  static renderTemplate(template, data) {
    let rendered = template;
    
    // ✅ FIXED: Handle PLACEHOLDER syntax from aiPrompts-FIXED.js
    const replacements = {
      'DEAL_NAME_PLACEHOLDER': data.context?.deal?.name || 'No active deal',
      'DEAL_STAGE_PLACEHOLDER': data.context?.deal?.stage || 'unknown',
      'DEAL_VALUE_PLACEHOLDER': data.context?.deal?.value || '0',
      'DEAL_CLOSE_DATE_PLACEHOLDER': data.context?.deal?.expected_close_date || 'Not set',
      'DEAL_HEALTH_PLACEHOLDER': data.context?.deal?.health || 'Unknown',
      'CONTACT_NAME_PLACEHOLDER': `${data.context?.contact?.first_name || ''} ${data.context?.contact?.last_name || ''}`.trim() || 'Unknown contact',
      'CONTACT_TITLE_PLACEHOLDER': data.context?.contact?.title || 'Unknown',
      'CONTACT_ROLE_PLACEHOLDER': data.context?.contact?.role_type || 'Unknown',
      'ACCOUNT_NAME_PLACEHOLDER': data.context?.account?.name || 'Unknown company',
      'ACCOUNT_INDUSTRY_PLACEHOLDER': data.context?.account?.industry || 'Unknown',
      'EMAIL_THREAD_PLACEHOLDER': this.formatEmailThread(data.context?.emailThread || []) || 'No previous emails',
      'MEETINGS_PLACEHOLDER': this.formatMeetings(data.context?.meetings || []) || 'No previous meetings',
      'DEAL_HISTORY_PLACEHOLDER': this.formatDealHistory(data.context?.dealHistory || []) || 'No deal history',
      'CURRENT_EMAIL_SUBJECT_PLACEHOLDER': data.email?.subject || 'No subject',
      'CURRENT_EMAIL_FROM_PLACEHOLDER': data.email?.from_address || 'Unknown sender',
      'CURRENT_EMAIL_BODY_PLACEHOLDER': data.email?.body || data.email?.body_preview || 'No content',
      'PLAYBOOK_GOAL_PLACEHOLDER': data.playbook?.deal_stages?.[data.context?.deal?.stage]?.goal || 'Move deal forward',
      'PLAYBOOK_NEXT_STEP_PLACEHOLDER': data.playbook?.deal_stages?.[data.context?.deal?.stage]?.next_step || 'Follow up',
      'PLAYBOOK_TIMELINE_PLACEHOLDER': data.playbook?.deal_stages?.[data.context?.deal?.stage]?.timeline || 'ASAP',
      'DAYS_IN_STAGE_PLACEHOLDER': data.context?.deal?.updated_at 
        ? Math.floor((Date.now() - new Date(data.context.deal.updated_at)) / (1000 * 60 * 60 * 24))
        : 0
    };
    
    // Replace all placeholders
    Object.keys(replacements).forEach(key => {
      const value = String(replacements[key]);
      rendered = rendered.split(key).join(value);
    });
    
    return rendered;
  }

  static formatEmailThread(thread) {
    return thread.map((e, i) => 
      `### Email ${i + 1} (${e.direction} on ${new Date(e.sent_at).toLocaleDateString()})\n` +
      `**Subject:** ${e.subject}\n**Body:** ${e.body_preview || e.body || 'No content'}\n`
    ).join('\n---\n');
  }

  static formatMeetings(meetings) {
    return meetings.map((m, i) =>
      `### Meeting ${i + 1}: ${m.title}\n` +
      `**When:** ${new Date(m.start_time).toLocaleDateString()}\n` +
      `**Notes:** ${m.notes || 'No notes'}\n`
    ).join('\n---\n');
  }

  static formatDealHistory(history) {
    return history.map(h => `- ${h.activity_type}: ${h.description}`).join('\n');
  }

  static async callClaude(prompt) {
    const message = await anthropic.messages.create({
      model: AI_PROMPTS.system_instructions.model,
      max_tokens: AI_PROMPTS.system_instructions.max_tokens,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const response = message.content[0].text;
    
    // ✅ ENHANCED: Better JSON extraction
    let cleaned = response.trim();
    
    // Remove any markdown code fences
    cleaned = cleaned.replace(/```json\n?/gi, '');
    cleaned = cleaned.replace(/```\n?/g, '');
    
    // ✅ NEW: Find the JSON array specifically
    const jsonMatch = cleaned.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    } else {
      // Try to extract from after any preamble
      const arrayStart = cleaned.indexOf('[');
      const arrayEnd = cleaned.lastIndexOf(']');
      if (arrayStart !== -1 && arrayEnd !== -1) {
        cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
      }
    }
    
    cleaned = cleaned.trim();
    
    try {
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      console.error('Cleaned response:', cleaned);
      console.error('Original response:', response);
      return [];
    }
  }

  static async saveActions(actions, userId, email, context) {
    const saved = [];
    
    for (const action of actions) {
      try {
        const result = await db.query(
          `INSERT INTO actions (
            user_id, type, title, description, action_type, priority,
            due_date, deal_id, contact_id, account_id,
            suggested_action, context, source, source_id, metadata, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
          RETURNING *`,
          [
            userId,
            action.action_type || 'follow_up',
            action.title,
            action.description,
            action.action_type || 'follow_up',
            action.priority || 'medium',
            action.due_date || new Date(Date.now() + 24 * 60 * 60 * 1000),
            context.deal?.id || null,
            context.contact?.id || null,
            context.account?.id || null,
            action.suggested_action,
            action.context,
            'ai_generated',
            email.id,
            JSON.stringify({ confidence: action.confidence, email_trigger: action.email_trigger })
          ]
        );
        saved.push(result.rows[0]);
      } catch (error) {
        console.error('Error saving action:', error);
      }
    }
    
    return saved;
  }
}

module.exports = AIProcessor;
