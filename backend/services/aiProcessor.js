/**
 * AI Email Processor - Full Context Analysis with Template Support
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
   * Process email with full context
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
    
    // Simple template replacement (you can use Handlebars for production)
    const replacements = {
      '{{deal.name}}': data.context?.deal?.name || 'Unknown',
      '{{deal.stage}}': data.context?.deal?.stage || 'Unknown',
      '{{deal.value}}': data.context?.deal?.value || '0',
      '{{deal.expected_close_date}}': data.context?.deal?.expected_close_date || 'Not set',
      '{{deal.health}}': data.context?.deal?.health || 'Unknown',
      '{{contact.first_name}}': data.context?.contact?.first_name || '',
      '{{contact.last_name}}': data.context?.contact?.last_name || '',
      '{{contact.title}}': data.context?.contact?.title || '',
      '{{contact.role_type}}': data.context?.contact?.role_type || '',
      '{{account.name}}': data.context?.account?.name || '',
      '{{account.industry}}': data.context?.account?.industry || '',
      '{{email_thread_count}}': data.context?.emailThread?.length || 0,
      '{{meetings_count}}': data.context?.meetings?.length || 0,
      '{{current_email.subject}}': data.email?.subject || '',
      '{{current_email.from}}': data.email?.from_address || '',
      '{{current_email.body}}': data.email?.body || data.email?.body_preview || '',
      '{{email_thread}}': this.formatEmailThread(data.context?.emailThread || []),
      '{{meetings}}': this.formatMeetings(data.context?.meetings || []),
      '{{deal_history}}': this.formatDealHistory(data.context?.dealHistory || []),
      '{{playbook_goal}}': data.playbook?.deal_stages?.[data.context?.deal?.stage]?.goal || '',
      '{{playbook_next_step}}': data.playbook?.deal_stages?.[data.context?.deal?.stage]?.next_step || '',
      '{{playbook_timeline}}': data.playbook?.deal_stages?.[data.context?.deal?.stage]?.timeline || ''
    };
    
    Object.keys(replacements).forEach(key => {
      rendered = rendered.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacements[key]);
    });
    
    // Remove template conditionals (simple version)
    rendered = rendered.replace(/{{#if \w+}}[\s\S]*?{{\/if}}/g, match => {
      return match.includes('{{#if deal}}') && data.context?.deal ? match.replace(/{{#if deal}}|{{\/if}}/g, '') : '';
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
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Failed to parse AI response:', response);
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
