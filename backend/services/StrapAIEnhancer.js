/**
 * StrapAIEnhancer.js
 *
 * Runs AFTER StrapActionGenerator. Given the STRAP details and already-generated
 * base actions, asks Claude to suggest any additional targeted actions that the
 * rule-based parser missed.
 *
 * Only called when ai_settings.modules.straps = true in action_config.
 * Non-blocking — any failure returns [] without disrupting STRAP generation.
 *
 * Output: array of action objects ready to insert into `actions` or
 * `prospecting_actions` depending on strap.entity_type.
 */

const { Anthropic } = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = require('../config/database');
const TokenTrackingService = require('./TokenTrackingService');

const VALID_CHANNELS = ['email', 'call', 'linkedin', 'whatsapp', 'slack', 'document', 'internal_task'];

class StrapAIEnhancer {

  static async enhance(strap, context, baseActions, orgId, userId) {
    try {
      const prompt = this._buildPrompt(strap, context, baseActions);
      const rawText = await this._callClaude(prompt, strap, orgId, userId);
      return this._parseAndInsert(rawText, strap, orgId, userId);
    } catch (err) {
      console.error('StrapAIEnhancer error:', err.message);
      return [];
    }
  }

  static _buildPrompt(strap, context, baseActions) {
    const entityLabel = strap.entity_type === 'prospect' ? 'Prospect' : 'Deal';
    const existingTitles = baseActions.map(a => `- ${a.title || a.text}`).join('\n');

    const contextSummary = context
      ? `Deal: ${context.deal?.name || 'N/A'} | Stage: ${context.deal?.stage || 'N/A'} | Health: ${context.deal?.health || 'N/A'}`
      : 'No deal context available';

    return `You are a sales AI assistant. A STRAP (Situation, Target, Response, Action Plan, Hurdle) has been created for a ${entityLabel}.

## STRAP Details
Hurdle Type: ${strap.hurdle_type || 'N/A'}
Hurdle Title: ${strap.hurdle_title || 'N/A'}
Situation: ${strap.situation || 'N/A'}
Target: ${strap.target || 'N/A'}
Response: ${strap.response || 'N/A'}
Priority: ${strap.priority || 'medium'}
${contextSummary}

## Action Plan (already parsed into these actions)
${existingTitles || 'No base actions generated'}

## Task
Identify 1-2 additional targeted actions not already covered above that would meaningfully help resolve this STRAP hurdle. Only add actions that are truly missing — don't duplicate what exists.

Respond ONLY with a JSON array. Each object:
{
  "title": "string (max 120 chars)",
  "description": "string — why this action matters for this specific STRAP",
  "channel": "email|call|linkedin|document|internal_task|slack",
  "priority": "high|medium|low",
  "due_days": number,
  "suggested_action": "string — specific tactical guidance for the rep"
}

If no additional actions are needed, return [].`;
  }

  static async _callClaude(prompt, strap, orgId, userId) {
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    });

    // Token tracking (non-blocking)
    if (message.usage) {
      TokenTrackingService.log({
        orgId,
        userId,
        callType: 'strap_ai_enhancement',
        model:    'claude-haiku-4-5-20251001',
        usage:    { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
      }).catch(() => {});
    }

    return message.content[0]?.text || '[]';
  }

  static async _parseAndInsert(rawText, strap, orgId, userId) {
    try {
      let cleaned = rawText.trim().replace(/```json\n?/gi, '').replace(/```\n?/g, '');
      const start = cleaned.indexOf('[');
      const end   = cleaned.lastIndexOf(']');
      if (start === -1 || end === -1) return [];

      const parsed = JSON.parse(cleaned.substring(start, end + 1));
      if (!Array.isArray(parsed) || parsed.length === 0) return [];

      const isProspect = strap.entity_type === 'prospect';
      const inserted = [];

      for (const a of parsed.slice(0, 2)) {
        if (!a.title) continue;
        const channel  = VALID_CHANNELS.includes(a.channel) ? a.channel : 'internal_task';
        const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium';
        const dueDate  = new Date();
        dueDate.setDate(dueDate.getDate() + (parseInt(a.due_days) || 2));

        try {
          if (isProspect) {
            const result = await db.query(
              `INSERT INTO prospecting_actions (
                 org_id, user_id, prospect_id, strap_id,
                 title, description, channel, priority, action_type,
                 source, suggested_action, due_date, status, created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ai_generated',$10,$11,'pending',NOW())
               RETURNING id, title`,
              [orgId, userId, strap.entity_id, strap.id,
               a.title.substring(0, 120), a.description || null,
               channel, priority, channel === 'document' ? 'document_prep' : 'follow_up',
               a.suggested_action || null, dueDate]
            );
            if (result.rows[0]) {
              // Add to strap_actions junction
              await db.query(
                `INSERT INTO strap_actions (strap_id, action_table, action_id)
                 VALUES ($1, 'prospecting_actions', $2) ON CONFLICT DO NOTHING`,
                [strap.id, result.rows[0].id]
              );
              inserted.push({ id: result.rows[0].id, title: result.rows[0].title });
            }
          } else {
            const result = await db.query(
              `INSERT INTO actions (
                 org_id, user_id, strap_id, deal_id, account_id,
                 type, action_type, title, description, priority,
                 next_step, source, source_rule, suggested_action,
                 due_date, status, created_at
               ) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,'ai_generated','strap_ai',$11,$12,'yet_to_start',NOW())
               RETURNING id, title`,
              [orgId, userId, strap.id,
               strap.entity_type === 'deal' ? strap.entity_id : null,
               strap.account_id || null,
               channel === 'document' ? 'document_prep' : 'follow_up',
               a.title.substring(0, 120), a.description || null,
               priority, channel,
               a.suggested_action || null, dueDate]
            );
            if (result.rows[0]) {
              await db.query(
                `INSERT INTO strap_actions (strap_id, action_table, action_id)
                 VALUES ($1, 'actions', $2) ON CONFLICT DO NOTHING`,
                [strap.id, result.rows[0].id]
              );
              inserted.push({ id: result.rows[0].id, title: result.rows[0].title });
            }
          }
        } catch (insertErr) {
          console.error(`StrapAIEnhancer insert failed for "${a.title}":`, insertErr.message);
        }
      }

      return inserted;
    } catch (err) {
      console.error('StrapAIEnhancer parse error:', err.message);
      return [];
    }
  }
}

module.exports = StrapAIEnhancer;
