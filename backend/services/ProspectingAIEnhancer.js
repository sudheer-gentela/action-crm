/**
 * ProspectingAIEnhancer.js
 *
 * Optional AI layer on top of prospecting action generation.
 * Activated when ai_settings.modules.prospecting = true in action_config.
 * Default is OFF — prospecting actions are typically straightforward enough
 * that the plays cover them. Enable for high-value target accounts where
 * personalised AI suggestions add real value.
 *
 * Inserts up to 2 additional prospecting_actions with source = 'ai_generated'.
 */

const { Anthropic } = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = require('../config/database');
const TokenTrackingService = require('./TokenTrackingService');

class ProspectingAIEnhancer {

  static async enhance(prospect, orgId, userId) {
    try {
      const prompt  = this._buildPrompt(prospect);
      const rawText = await this._callClaude(prompt, prospect, orgId, userId);
      return this._parseAndInsert(rawText, prospect, orgId, userId);
    } catch (err) {
      console.error('ProspectingAIEnhancer error:', err.message);
      return 0;
    }
  }

  static _buildPrompt(prospect) {
    return `You are a B2B sales AI assistant. Suggest 1-2 highly specific, personalised prospecting actions for this prospect that go beyond standard outreach sequences.

## Prospect
Name: ${prospect.first_name} ${prospect.last_name}
Company: ${prospect.company_name || 'N/A'}
Industry: ${prospect.company_industry || 'N/A'}
Stage: ${prospect.stage}
Preferred Channel: ${prospect.preferred_channel || 'email'}
${prospect.research_notes ? `Research Notes: ${prospect.research_notes}` : ''}

Focus on personalisation opportunities, trigger events, or stakeholder engagement angles that a generic sequence would miss.
Only suggest if genuinely valuable — return [] if standard actions are sufficient.

Respond ONLY with a JSON array:
[{
  "title": "string (max 120 chars, specific and actionable)",
  "description": "string — why this personalised action matters",
  "channel": "email|call|linkedin|whatsapp",
  "priority": "high|medium|low",
  "due_days": number,
  "suggested_action": "string — specific tactical wording or approach for the rep"
}]`;
  }

  static async _callClaude(prompt, prospect, orgId, userId) {
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });
    if (message.usage) {
      TokenTrackingService.log({
        orgId, userId,
        callType: 'prospecting_ai_enhancement',
        model:    'claude-haiku-4-5-20251001',
        usage:    { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
      }).catch(() => {});
    }
    return message.content[0]?.text || '[]';
  }

  static async _parseAndInsert(rawText, prospect, orgId, userId) {
    try {
      const cleaned = rawText.trim().replace(/```json\n?/gi, '').replace(/```\n?/g, '');
      const start = cleaned.indexOf('[');
      const end   = cleaned.lastIndexOf(']');
      if (start === -1 || end === -1) return 0;
      const parsed = JSON.parse(cleaned.substring(start, end + 1));
      if (!Array.isArray(parsed) || parsed.length === 0) return 0;

      const VALID_CHANNELS = ['email', 'call', 'linkedin', 'whatsapp', 'slack'];
      let count = 0;

      for (const a of parsed.slice(0, 2)) {
        if (!a.title) continue;
        const channel  = VALID_CHANNELS.includes(a.channel) ? a.channel : 'email';
        const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium';
        const dueDate  = new Date();
        dueDate.setDate(dueDate.getDate() + (parseInt(a.due_days) || 2));

        try {
          await db.query(
            `INSERT INTO prospecting_actions
             (org_id, user_id, prospect_id, title, description, action_type, channel,
              status, priority, due_date, source, suggested_action, ai_context, metadata)
             VALUES ($1,$2,$3,$4,$5,'outreach',$6,'pending',$7,$8,'ai_generated',$9,$10,$11)`,
            [
              orgId, userId, prospect.id,
              a.title.substring(0, 120),
              a.description || null,
              channel, priority, dueDate,
              a.suggested_action || null,
              JSON.stringify({ stage: prospect.stage, playbook_id: prospect.playbook_id }),
              JSON.stringify({ generated_from: 'ai_enhancer', stage_key: prospect.stage }),
            ]
          );
          count++;
        } catch (err) {
          console.error(`ProspectingAIEnhancer insert failed for "${a.title}":`, err.message);
        }
      }
      return count;
    } catch (err) {
      console.error('ProspectingAIEnhancer parse error:', err.message);
      return 0;
    }
  }
}

module.exports = ProspectingAIEnhancer;
