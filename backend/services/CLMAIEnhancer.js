/**
 * CLMAIEnhancer.js
 *
 * Runs AFTER ContractActionsGenerator. Reviews the contract state and suggests
 * any critical actions the CLM play rules didn't produce.
 *
 * Only called when ai_settings.modules.clm = true in action_config.
 * CLM is off by default because plays are already well-structured —
 * AI is most useful for unusual contract situations (risky terms, edge cases).
 */

const AIClientResolver = require('./ai/AIClientResolver');
const db = require('../config/database');
const TokenTrackingService = require('./TokenTrackingService');

class CLMAIEnhancer {

  static async enhance(contract, orgId, userId) {
    try {
      const prompt   = this._buildPrompt(contract);
      const rawText  = await this._callClaude(prompt, contract, orgId, userId);
      const actions  = this._parse(rawText);
      return this._insert(actions, contract, orgId, userId);
    } catch (err) {
      console.error('CLMAIEnhancer error:', err.message);
      return 0;
    }
  }

  static _buildPrompt(contract) {
    const daysUntilExpiry = contract.expiry_date
      ? Math.ceil((new Date(contract.expiry_date) - Date.now()) / 86400000)
      : null;

    return `You are a contract lifecycle management AI. Review this contract and suggest 1-2 critical actions not typically covered by standard CLM plays.

## Contract
Title: ${contract.title || 'N/A'}
Type: ${contract.contract_type || 'N/A'}
Status: ${contract.status || 'N/A'}
Value: $${parseFloat(contract.value || 0).toLocaleString()}
${daysUntilExpiry !== null ? `Days Until Expiry: ${daysUntilExpiry}` : ''}
${contract.notes ? `Notes: ${contract.notes}` : ''}

Focus on non-standard situations: unusual terms, compliance risks, stakeholder gaps, or renewal complexity.
Only suggest actions if genuinely needed — return [] if standard plays are sufficient.

Respond ONLY with a JSON array:
[{
  "title": "string (max 100 chars)",
  "description": "string — why this action is critical for this contract",
  "next_step": "email|call|document|internal_task",
  "priority": "high|medium|low",
  "due_days": number
}]`;
  }

  static async _callClaude(prompt, contract, orgId, userId) {
    const { adapter, model, provider, keySource } =
      await AIClientResolver.resolve(orgId, userId, 'clm_ai_enhancement');

    const { text, usage } = await adapter.complete({
      model,
      prompt,
      maxTokens: 600,
    });

    if (usage) {
      TokenTrackingService.log({
        orgId, userId,
        callType: 'clm_ai_enhancement',
        model,
        provider,
        keySource,
        usage,
      }).catch(() => {});
    }

    return text || '[]';
  }

  static _parse(rawText) {
    try {
      const cleaned = rawText.trim().replace(/```json\n?/gi, '').replace(/```\n?/g, '');
      const start = cleaned.indexOf('[');
      const end   = cleaned.lastIndexOf(']');
      if (start === -1 || end === -1) return [];
      const parsed = JSON.parse(cleaned.substring(start, end + 1));
      return Array.isArray(parsed) ? parsed.slice(0, 2) : [];
    } catch {
      return [];
    }
  }

  static async _insert(actions, contract, orgId, userId) {
    let count = 0;
    const VALID_STEPS = ['email', 'call', 'document', 'internal_task'];

    for (const a of actions) {
      if (!a.title) continue;
      const next_step = VALID_STEPS.includes(a.next_step) ? a.next_step : 'internal_task';
      const priority  = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium';
      const dueDate   = new Date();
      dueDate.setDate(dueDate.getDate() + (parseInt(a.due_days) || 3));

      try {
        await db.query(
          `INSERT INTO actions (
             org_id, user_id, contract_id,
             type, action_type, title, description,
             priority, next_step, source, source_rule,
             due_date, status, created_at
           ) VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,'ai_generated','clm_ai',$9,'yet_to_start',NOW())`,
          [orgId, userId, contract.id,
           next_step === 'document' ? 'document_prep' : 'follow_up',
           a.title.substring(0, 120), a.description || null,
           priority, next_step, dueDate]
        );
        count++;
      } catch (err) {
        console.error(`CLMAIEnhancer insert failed for "${a.title}":`, err.message);
      }
    }
    return count;
  }
}

module.exports = CLMAIEnhancer;
