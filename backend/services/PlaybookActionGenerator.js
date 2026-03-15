/**
 * PlaybookActionGenerator.js
 *
 * Shared core service for generating actions from playbook plays.
 * Works across all entity types (deal, prospect, contract, case, handover).
 *
 * Two modes:
 *   'template' — deterministic: maps playbook_plays directly to action rows
 *   'ai'       — sends entity context + plays to Claude, gets back enriched actions
 *
 * This service DOES NOT insert anything into the DB.
 * Call ActionWriter.write() with the returned actions to persist them.
 *
 * Usage:
 *   const { actions, playbookId, playbookName } =
 *     await PlaybookActionGenerator.generate({
 *       entityType: 'deal',
 *       context,          // from DealContextBuilder / ProspectContextBuilder etc.
 *       playbookId,       // optional — resolved from context or org default if omitted
 *       stageKey,         // current stage key
 *       mode: 'template', // 'template' | 'ai'
 *       orgId,
 *       userId,
 *     });
 */

'use strict';

const PlaybookService = require('./playbook.service');
const db              = require('../config/database');

// ── Channel → action_type mapping ────────────────────────────────────────────
// Maps playbook_plays.channel to actions.action_type / actions.next_step
const CHANNEL_MAP = {
  email:         { action_type: 'email_send',       next_step: 'email'         },
  call:          { action_type: 'meeting_schedule',  next_step: 'call'          },
  meeting:       { action_type: 'meeting_schedule',  next_step: 'call'          },
  document:      { action_type: 'document_prep',     next_step: 'document'      },
  internal_task: { action_type: 'task_complete',     next_step: 'internal_task' },
  linkedin:      { action_type: 'follow_up',         next_step: 'linkedin'      },
  whatsapp:      { action_type: 'follow_up',         next_step: 'whatsapp'      },
  slack:         { action_type: 'task_complete',     next_step: 'slack'         },
  phone:         { action_type: 'meeting_schedule',  next_step: 'call'          },
  sms:           { action_type: 'follow_up',         next_step: 'email'         }, // sms not in actions CHECK — map to email
};

const DEFAULT_CHANNEL = { action_type: 'task_complete', next_step: 'email' };

function resolveChannel(channel) {
  return CHANNEL_MAP[channel] || DEFAULT_CHANNEL;
}

// ── Valid next_step values for actions table ──────────────────────────────────
const VALID_NEXT_STEPS = new Set(['email', 'call', 'whatsapp', 'linkedin', 'slack', 'document', 'internal_task']);

// ── Valid channel values for prospecting_actions ──────────────────────────────
const VALID_PROSPECT_CHANNELS = new Set(['email', 'linkedin', 'phone', 'sms', 'whatsapp']);

function resolveProspectChannel(channel) {
  if (VALID_PROSPECT_CHANNELS.has(channel)) return channel;
  if (channel === 'call' || channel === 'meeting') return 'phone';
  return null; // nullable in prospecting_actions
}

// ── AI model config ───────────────────────────────────────────────────────────
const AI_MODEL = 'claude-haiku-4-5-20251001';

// ── Module-specific prompt context builders ───────────────────────────────────

function buildEntitySummary(entityType, context) {
  switch (entityType) {
    case 'deal': {
      const { deal, contacts, derived } = context;
      return [
        `Deal: ${deal.name}`,
        `Stage: ${deal.stage}`,
        `Value: $${parseFloat(deal.value || 0).toLocaleString()}`,
        `Close date: ${deal.close_date ? new Date(deal.close_date).toLocaleDateString() : 'Not set'}`,
        `Days in stage: ${derived?.daysInStage ?? 'unknown'}`,
        `Days until close: ${derived?.daysUntilClose ?? 'unknown'}`,
        `Health: ${context.healthStatus || 'unknown'} (score: ${context.healthScore ?? 'N/A'})`,
        `Contacts: ${contacts?.length ?? 0} (${derived?.decisionMakers?.length ?? 0} decision makers, ${derived?.champions?.length ?? 0} champions)`,
        `Last meeting: ${derived?.daysSinceLastMeeting != null ? derived.daysSinceLastMeeting + ' days ago' : 'none on record'}`,
        `Last email: ${derived?.daysSinceLastEmail != null ? derived.daysSinceLastEmail + ' days ago' : 'none on record'}`,
      ].join('\n');
    }

    case 'prospect': {
      const { prospect, derived } = context;
      return [
        `Prospect: ${prospect.first_name} ${prospect.last_name} at ${prospect.company_name || 'unknown company'}`,
        `Title: ${prospect.title || 'unknown'}`,
        `Stage: ${prospect.stage}`,
        `ICP Score: ${prospect.icp_score ?? 'not scored'}`,
        `Outreach count: ${prospect.outreach_count || 0}`,
        `Response count: ${prospect.response_count || 0}`,
        `Response rate: ${derived?.responseRate != null ? Math.round(derived.responseRate * 100) + '%' : 'N/A'}`,
        `Last outreach: ${derived?.daysSinceLastOutreach != null ? derived.daysSinceLastOutreach + ' days ago' : 'none on record'}`,
        `Ghosting: ${derived?.isGhosting ? 'yes' : 'no'}`,
        `Existing customer: ${derived?.isExistingCustomer ? 'yes' : 'no'}`,
      ].join('\n');
    }

    case 'contract': {
      const { contract } = context;
      const daysToExpiry = contract.expiry_date
        ? Math.ceil((new Date(contract.expiry_date) - Date.now()) / 86400000)
        : null;
      return [
        `Contract: ${contract.title || 'Contract #' + contract.id}`,
        `Type: ${contract.contract_type || 'unknown'}`,
        `Status: ${contract.status}${contract.review_sub_status ? ' / ' + contract.review_sub_status : ''}`,
        `Value: ${contract.value ? '$' + parseFloat(contract.value).toLocaleString() : 'not set'}`,
        `Expiry: ${contract.expiry_date ? new Date(contract.expiry_date).toLocaleDateString() + (daysToExpiry !== null ? ' (' + daysToExpiry + ' days)' : '') : 'not set'}`,
        `Owner: user_id ${contract.owner_id}`,
        `Legal assignee: ${contract.legal_assignee_id ? 'user_id ' + contract.legal_assignee_id : 'none'}`,
      ].join('\n');
    }

    case 'case': {
      const { caseRecord } = context;
      return [
        `Case: ${caseRecord.title || 'Case #' + caseRecord.id}`,
        `Status: ${caseRecord.status}`,
        `Priority: ${caseRecord.priority}`,
        `Account: ${context.account?.name || 'unknown'}`,
        `SLA tier: ${caseRecord.sla_tier_id ? 'tier ' + caseRecord.sla_tier_id : 'default'}`,
        `Response breached: ${caseRecord.response_breached ? 'yes' : 'no'}`,
        `Resolution breached: ${caseRecord.resolution_breached ? 'yes' : 'no'}`,
        `Days open: ${caseRecord.created_at ? Math.floor((Date.now() - new Date(caseRecord.created_at)) / 86400000) : 'unknown'}`,
      ].join('\n');
    }

    case 'handover': {
      const { handover, deal } = context;
      return [
        `Handover for deal: ${deal?.name || 'Deal #' + handover.deal_id}`,
        `Status: ${handover.status}`,
        `Go-live date: ${handover.go_live_date ? new Date(handover.go_live_date).toLocaleDateString() : 'not set'}`,
        `Contract value: ${handover.contract_value ? '$' + parseFloat(handover.contract_value).toLocaleString() : 'not set'}`,
      ].join('\n');
    }

    default:
      return `Entity type: ${entityType}`;
  }
}

function buildStageGuidanceSummary(context) {
  const guidance = context.playbookStageGuidance || context.stageGuidance || null;
  if (!guidance) return 'No stage guidance configured.';
  const parts = [];
  if (guidance.goal)             parts.push(`Goal: ${guidance.goal}`);
  if (guidance.timeline)         parts.push(`Timeline: ${guidance.timeline}`);
  if (guidance.success_criteria?.length) parts.push(`Success criteria: ${guidance.success_criteria.join(', ')}`);
  if (guidance.key_actions?.length)      parts.push(`Key actions: ${guidance.key_actions.join(', ')}`);
  return parts.join('\n') || 'No stage guidance configured.';
}

function buildPlaysSummary(plays) {
  if (!plays || plays.length === 0) return 'No plays defined for this stage.';
  return plays.map((p, i) =>
    `${i + 1}. ${p.title}${p.channel ? ' [' + p.channel + ']' : ''}${p.description ? ': ' + p.description : ''}`
  ).join('\n');
}

// ── Main class ────────────────────────────────────────────────────────────────

class PlaybookActionGenerator {

  /**
   * Generate action rows from a playbook for an entity.
   *
   * @param {object} params
   * @param {string} params.entityType     — 'deal' | 'prospect' | 'contract' | 'case' | 'handover'
   * @param {object} params.context        — from the entity's context builder
   * @param {number} [params.playbookId]   — explicit playbook id; resolved from context if omitted
   * @param {string} params.stageKey       — current stage key
   * @param {'template'|'ai'} params.mode  — generation mode
   * @param {number} params.orgId
   * @param {number} params.userId
   *
   * @returns {Promise<{
   *   actions:      ActionRow[],
   *   playbookId:   number,
   *   playbookName: string,
   *   mode:         string,
   *   playCount:    number,
   * }>}
   */
  static async generate({ entityType, context, playbookId, stageKey, mode = 'template', orgId, userId }) {

    // ── 1. Resolve playbook ───────────────────────────────────────────────────
    let resolvedPlaybookId = playbookId
      || context?.playbookId
      || context?.playbook?.id
      || null;

    if (!resolvedPlaybookId) {
      const pb = await PlaybookService.getDefaultPlaybookForEntity(orgId, entityType);
      resolvedPlaybookId = pb?.id || null;
    }

    if (!resolvedPlaybookId) {
      console.warn(`[PlaybookActionGenerator] No playbook found for entityType=${entityType} org=${orgId}`);
      return { actions: [], playbookId: null, playbookName: null, mode, playCount: 0 };
    }

    // ── 2. Load playbook config + plays ───────────────────────────────────────
    const [playbook, plays] = await Promise.all([
      PlaybookService.getPlaybookById(resolvedPlaybookId, orgId),
      PlaybookService.getPlaysForStage(orgId, resolvedPlaybookId, stageKey),
    ]);

    if (!playbook) {
      console.warn(`[PlaybookActionGenerator] Playbook ${resolvedPlaybookId} not found for org ${orgId}`);
      return { actions: [], playbookId: resolvedPlaybookId, playbookName: null, mode, playCount: 0 };
    }

    const playbookName = playbook.name;

    if (plays.length === 0) {
      console.warn(`[PlaybookActionGenerator] No active plays for playbook ${resolvedPlaybookId} stage=${stageKey}`);
      return { actions: [], playbookId: resolvedPlaybookId, playbookName, mode, playCount: 0 };
    }

    // Check AI toggle on playbook
    const effectiveMode = (mode === 'ai' && playbook.enable_ai_actions === false) ? 'template' : mode;

    // ── 3. Generate actions ───────────────────────────────────────────────────
    let actions = [];
    if (effectiveMode === 'ai') {
      actions = await this._generateWithAI(entityType, context, plays, playbook, stageKey, orgId, userId);
      // Fallback to template if AI returns nothing
      if (actions.length === 0) {
        console.warn(`[PlaybookActionGenerator] AI returned no actions — falling back to template`);
        actions = this._generateFromTemplate(entityType, context, plays, playbook, stageKey, userId);
      }
    } else {
      actions = this._generateFromTemplate(entityType, context, plays, playbook, stageKey, userId);
    }

    // Stamp playbook metadata on every action
    actions = actions.map(a => ({ ...a, playbook_id: resolvedPlaybookId, playbook_name: playbookName }));

    return { actions, playbookId: resolvedPlaybookId, playbookName, mode: effectiveMode, playCount: plays.length };
  }

  // ── Template mode ─────────────────────────────────────────────────────────

  static _generateFromTemplate(entityType, context, plays, playbook, stageKey, userId) {
    const isProspect = entityType === 'prospect';
    const now = new Date();

    return plays.map(play => {
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + (parseInt(play.due_offset_days) || 3));

      if (isProspect) {
        // prospecting_actions shape
        return {
          _table:          'prospecting_actions',
          title:           play.title,
          description:     play.description || null,
          action_type:     'playbook_play',
          channel:         resolveProspectChannel(play.channel),
          priority:        play.priority || 'medium',
          due_date:        dueDate,
          source:          'playbook',
          source_rule:     'playbook_play',
          suggested_action: play.suggested_action || null,
          playbook_play_id: play.id,
          user_id:         userId,
        };
      } else {
        // actions table shape
        const { action_type, next_step } = resolveChannel(play.channel);
        return {
          _table:           'actions',
          title:            play.title,
          description:      play.description || null,
          action_type,
          type:             action_type,
          next_step,
          priority:         play.priority || 'medium',
          due_date:         dueDate,
          deal_stage:       entityType === 'deal' ? stageKey : null,
          source:           'playbook',
          source_rule:      'playbook_play',
          suggested_action: play.suggested_action || null,
          playbook_play_id: play.id,
          is_internal:      next_step === 'internal_task' || next_step === 'document' || next_step === 'slack',
        };
      }
    });
  }

  // ── AI mode ───────────────────────────────────────────────────────────────

  static async _generateWithAI(entityType, context, plays, playbook, stageKey, orgId, userId) {
    try {
      const prompt = await this._buildPrompt(entityType, context, plays, playbook, stageKey, orgId);
      const rawText = await this._callClaude(prompt, orgId, userId, entityType);
      return this._parseAIResponse(rawText, entityType, context, plays, stageKey, userId);
    } catch (err) {
      console.error(`[PlaybookActionGenerator] AI generation error for ${entityType}:`, err.message);
      return [];
    }
  }

  static async _buildPrompt(entityType, context, plays, playbook, stageKey, orgId) {
    // Check for org-level prompt override in prompts table
    let systemPromptOverride = null;
    try {
      const promptResult = await db.query(
        `SELECT prompt_text FROM prompts
         WHERE org_id = $1 AND type = 'playbook_action_generation' AND entity_type = $2
         LIMIT 1`,
        [orgId, entityType]
      );
      systemPromptOverride = promptResult.rows[0]?.prompt_text || null;
    } catch (_) { /* prompts table may not have entity_type column yet — non-blocking */ }

    const entitySummary   = buildEntitySummary(entityType, context);
    const guidanceSummary = buildStageGuidanceSummary(context);
    const playsSummary    = buildPlaysSummary(plays);

    const moduleInstructions = {
      deal:     'You are a B2B sales coach. Generate specific, actionable next steps for this deal.',
      prospect: 'You are a B2B outreach specialist. Generate specific, actionable next steps to engage this prospect.',
      contract: 'You are a CLM specialist. Generate specific, actionable next steps to advance this contract.',
      case:     'You are a customer support manager. Generate specific, actionable next steps to resolve this case.',
      handover: 'You are an implementation manager. Generate specific, actionable next steps for this sales-to-implementation handover.',
    };

    const channelInstructions = entityType === 'prospect'
      ? `For each action, choose the most effective channel:
- "email"    — send an email
- "phone"    — make a phone call  
- "linkedin" — LinkedIn message
- "whatsapp" — WhatsApp message
- "sms"      — text message`
      : `For each action, choose the most effective next_step:
- "email"         — send an email
- "call"          — make a phone call
- "linkedin"      — LinkedIn message
- "whatsapp"      — WhatsApp message
- "document"      — create or prepare a document
- "internal_task" — internal task with no customer contact
- "slack"         — internal Slack message`;

    return systemPromptOverride || `${moduleInstructions[entityType] || moduleInstructions.deal}

${channelInstructions}

## ENTITY
${entitySummary}

## STAGE: ${stageKey}
${guidanceSummary}

## PLAYS DEFINED FOR THIS STAGE (use these as the basis — enrich with specific context)
${playsSummary}

---

For each play listed above, generate one specific action enriched with context from the entity details.
You may also add 1-2 additional actions not covered by the plays if the entity context clearly warrants it.

Return ONLY a JSON array. No markdown. No preamble. Each item:
{
  "title":             "Specific action title (max 80 chars)",
  "description":       "Why this action matters now for this specific entity (1-2 sentences)",
  "action_type":       "email_send|meeting_schedule|document_prep|task_complete|follow_up",
  "channel":           "${entityType === 'prospect' ? 'email|phone|linkedin|whatsapp|sms' : 'email|call|linkedin|whatsapp|document|internal_task|slack'}",
  "priority":          "high|medium|low",
  "due_days":          0-14,
  "suggested_action":  "Specific how-to instruction (1-2 sentences)",
  "play_index":        0-based index of the play this action corresponds to (-1 if additional)
}`;
  }

  static async _callClaude(prompt, orgId, userId, entityType) {
    const { Anthropic } = require('@anthropic-ai/sdk');
    const TokenTrackingService = require('./TokenTrackingService');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model:      AI_MODEL,
      max_tokens: 2000,
      messages:   [{ role: 'user', content: prompt }],
    });

    // Track token usage (non-blocking)
    if (response.usage) {
      TokenTrackingService.log({
        orgId,
        userId,
        callType: 'playbook_action_generation',
        model:    AI_MODEL,
        usage:    { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
        metadata: { entityType },
      }).catch(() => {});
    }

    return response.content[0]?.text || '[]';
  }

  static _parseAIResponse(rawText, entityType, context, plays, stageKey, userId) {
    try {
      let cleaned = rawText.trim()
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '');

      const start = cleaned.indexOf('[');
      const end   = cleaned.lastIndexOf(']');
      if (start === -1 || end === -1) return [];

      const parsed = JSON.parse(cleaned.substring(start, end + 1));
      if (!Array.isArray(parsed)) return [];

      const isProspect = entityType === 'prospect';
      const now        = new Date();

      return parsed
        .filter(a => a.title && a.action_type)
        .slice(0, plays.length + 3) // max plays + 3 bonus
        .map(a => {
          const dueDate = new Date(now);
          dueDate.setDate(dueDate.getDate() + (parseInt(a.due_days) || 3));

          // Link back to play if index provided
          const play = (a.play_index >= 0 && plays[a.play_index]) ? plays[a.play_index] : null;

          if (isProspect) {
            const channel = VALID_PROSPECT_CHANNELS.has(a.channel) ? a.channel : null;
            return {
              _table:           'prospecting_actions',
              title:            a.title.substring(0, 255),
              description:      a.description || null,
              action_type:      'playbook_play',
              channel,
              priority:         ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium',
              due_date:         dueDate,
              source:           'ai_generated',
              source_rule:      'playbook_ai',
              suggested_action: a.suggested_action || null,
              playbook_play_id: play?.id || null,
              user_id:          userId,
            };
          } else {
            const channelKey = a.channel || 'email';
            const { action_type, next_step } = resolveChannel(channelKey);
            const safeNextStep = VALID_NEXT_STEPS.has(next_step) ? next_step : 'email';
            return {
              _table:           'actions',
              title:            a.title.substring(0, 255),
              description:      a.description || null,
              action_type:      a.action_type || action_type,
              type:             a.action_type || action_type,
              next_step:        safeNextStep,
              priority:         ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium',
              due_date:         dueDate,
              deal_stage:       entityType === 'deal' ? stageKey : null,
              source:           'ai_generated',
              source_rule:      'playbook_ai',
              suggested_action: a.suggested_action || null,
              playbook_play_id: play?.id || null,
              is_internal:      safeNextStep === 'internal_task' || safeNextStep === 'document' || safeNextStep === 'slack',
            };
          }
        });

    } catch (err) {
      console.error('[PlaybookActionGenerator] Failed to parse AI response:', err.message);
      return [];
    }
  }
}

module.exports = PlaybookActionGenerator;
