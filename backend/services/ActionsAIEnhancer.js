/**
 * ActionsAIEnhancer.js
 *
 * Runs AFTER ActionsRulesEngine. Enhances actions with deal-specific context.
 *
 * Changes from previous version:
 *   - Uses context.stageType (semantic type e.g. 'evaluation') instead of
 *     deal.stage (raw key e.g. 'demo') in the AI prompt. This ensures the
 *     AI understands the sales phase correctly regardless of what the org
 *     has named the stage.
 *   - Includes playbookStageGuidance.goal and success_criteria in the prompt
 *     so the AI generates actions aligned with the org's playbook.
 *   - AI can override the fixed rule next_step with a context-aware channel.
 */

const { Anthropic } = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TokenTrackingService = require('./TokenTrackingService');

const VALID_NEXT_STEPS = ['email', 'call', 'whatsapp', 'linkedin', 'slack', 'document', 'internal_task'];

// Human-readable labels for stage types shown in the AI prompt
const STAGE_TYPE_LABELS = {
  awareness:   'Awareness / Top of Funnel',
  discovery:   'Discovery / Qualification',
  evaluation:  'Evaluation / Demo / POC',
  proposal:    'Proposal / Pricing',
  negotiation: 'Negotiation / Legal / Contract',
  closing:     'Closing / Final Approval',
  closed_won:  'Closed Won',
  closed_lost: 'Closed Lost',
  custom:      'Custom Stage',
};

class ActionsAIEnhancer {

  static async enhance(context, rulesActions, actionConfig) {
    if (!this._shouldRunAI(context, rulesActions, actionConfig)) return [];

    try {
      const prompt    = this._buildPrompt(context, rulesActions);
      const rawText   = await this._callClaude(prompt, context);
      const aiActions = this._parseResponse(rawText, context);
      console.log(`🤖 AI Enhancer: generated ${aiActions.length} additional actions for deal ${context.deal.id}`);
      return aiActions;
    } catch (err) {
      console.error(`❌ AI Enhancer error for deal ${context.deal.id}:`, err.message);
      return [];
    }
  }

  static _shouldRunAI(context, rulesActions, actionConfig) {
    if (!actionConfig?.ai_enhanced_generation) return false;
    if (actionConfig?.generation_mode === 'manual') return false;

    const { healthStatus, derived } = context;
    if (healthStatus === 'risk') return true;
    if (derived.isHighValue && healthStatus === 'watch' && rulesActions.length < 4) return true;
    if (healthStatus === 'watch' && rulesActions.length < 2) return true;
    if (derived.closingImminently && healthStatus !== 'healthy') return true;
    return false;
  }

  static _buildPrompt(context, rulesActions) {
    const {
      deal, contacts, meetings, emails, files,
      healthBreakdown, healthScore, healthStatus, derived,
      stageType, playbookStageGuidance,
    } = context;

    const stageLabel    = STAGE_TYPE_LABELS[stageType] || stageType;
    const playbookGoal  = playbookStageGuidance?.goal || 'Not specified';
    const successCriteria = (playbookStageGuidance?.success_criteria || []).join(', ') || 'Not specified';

    const existingTitles = rulesActions.map(a => `- ${a.title} [next_step: ${a.next_step}]`).join('\n');

    const emailSummary = emails.slice(0, 5).map(e =>
      `[${e.direction?.toUpperCase()}] ${new Date(e.sent_at).toLocaleDateString()} — ${e.subject || 'No subject'}: ${(e.body_preview || e.body || '').substring(0, 200)}`
    ).join('\n');

    const meetingSummary = meetings.slice(0, 3).map(m =>
      `${new Date(m.start_time).toLocaleDateString()} — ${m.title || 'Meeting'} (${m.status}): ${(m.notes || m.description || 'No notes').substring(0, 150)}`
    ).join('\n');

    const fileSummary = files.slice(0, 5).map(f =>
      `${f.file_name} (${f.category || 'unknown'})${f.ai_summary ? ': ' + f.ai_summary.substring(0, 150) : ''}`
    ).join('\n');

    const paramSummary = healthBreakdown?.params
      ? Object.entries(healthBreakdown.params)
          .filter(([, p]) => p.state === 'unknown' || (p.state === 'confirmed' && (p.impact || 0) < 0))
          .map(([k, p]) => `${k} (${p.label}): ${p.state}${p.evidence ? ' — ' + p.evidence.substring(0, 120) : ''}`)
          .join('\n')
      : 'No health breakdown available';

    const contactSummary = contacts.slice(0, 5).map(c =>
      `${c.first_name} ${c.last_name} — ${c.title || 'Unknown title'} (${c.role_type || 'unknown role'})`
    ).join('\n');

    const daysSinceMeeting = derived.daysSinceLastMeeting >= 999
      ? 'no meetings on record'
      : `${derived.daysSinceLastMeeting} days since last meeting`;

    return `You are a B2B sales strategy AI. Analyze this deal and generate ADDITIONAL actions the sales rep should take RIGHT NOW.

For each action, choose the most effective NEXT STEP channel based on the deal context:
- "email"         — send an email
- "call"          — make a phone call (use when emails are being ignored or urgency is high)
- "whatsapp"      — send a WhatsApp message (use when relationship is informal or email/call not working)
- "linkedin"      — send a LinkedIn message (use when you don't have direct contact or want a warm touch)
- "slack"         — internal Slack message (use for internal approvals, escalations, team coordination)
- "document"      — create or prepare a document (proposals, battlecards, ROI docs)
- "internal_task" — internal task with no customer contact (CRM updates, strategy review, prep work)

## DEAL
Name: ${deal.name}
Stage name: ${deal.stage}
Stage type: ${stageLabel}
Value: $${parseFloat(deal.value || 0).toLocaleString()}
Close date: ${deal.close_date ? new Date(deal.close_date).toLocaleDateString() : 'Not set'}
Days until close: ${derived.daysUntilClose ?? 'Unknown'}
Health: ${healthStatus?.toUpperCase()} (score: ${healthScore ?? 'N/A'}/100)
Days in current stage: ${derived.daysInStage}
Meeting cadence: ${daysSinceMeeting}
Days since last email: ${derived.daysSinceLastEmail >= 999 ? 'no emails on record' : derived.daysSinceLastEmail}

## PLAYBOOK GUIDANCE FOR THIS STAGE
Goal: ${playbookGoal}
Success criteria: ${successCriteria}

## CONTACTS (${contacts.length} total)
${contactSummary || 'None'}

## RECENT EMAILS
${emailSummary || 'No emails'}

## RECENT MEETINGS
${meetingSummary || 'No meetings'}

## FILES
${fileSummary || 'No files'}

## HEALTH SCORE GAPS
${paramSummary}

## ACTIONS ALREADY GENERATED (do NOT duplicate — but you CAN suggest a better next_step channel for existing ones if warranted)
${existingTitles || 'None yet'}

---

Generate 2-5 ADDITIONAL specific, actionable next steps that the rules engine missed.

Return ONLY a JSON array. No markdown. No preamble. Each item:
{
  "title": "Specific action title (max 80 chars)",
  "description": "Why this action matters now (1-2 sentences)",
  "action_type": "email_send|meeting_schedule|document_prep|task_complete|follow_up",
  "next_step": "email|call|whatsapp|linkedin|slack|document|internal_task",
  "priority": "high|medium|low",
  "due_days": 0-7,
  "suggested_action": "Specific how-to (1-2 sentences)",
  "confidence": 0.0-1.0,
  "reasoning": "What signal triggered this (1 sentence)"
}`;
  }

  static async _callClaude(prompt, context) {
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });

    // ── Token tracking (non-blocking) ────────────────────────
    if (message.usage && context?.deal) {
      TokenTrackingService.log({
        orgId:    context.deal.org_id || null,
        userId:   context.deal.owner_id || null,
        callType: 'ai_enhancement',
        model:    'claude-haiku-4-5-20251001',
        usage:    { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
        dealId:   context.deal.id || null,
      }).catch(() => {});
    }

    return message.content[0]?.text || '[]';
  }

  static _parseResponse(rawText, context) {
    try {
      let cleaned = rawText.trim()
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '');

      const start = cleaned.indexOf('[');
      const end   = cleaned.lastIndexOf(']');
      if (start === -1 || end === -1) return [];

      const parsed = JSON.parse(cleaned.substring(start, end + 1));
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(a => a.title && a.action_type && a.priority)
        .slice(0, 5)
        .map(a => {
          const due_date = new Date();
          due_date.setDate(due_date.getDate() + (parseInt(a.due_days) || 1));

          const next_step = VALID_NEXT_STEPS.includes(a.next_step) ? a.next_step : 'email';

          return {
            title:            a.title.substring(0, 255),
            description:      a.description || '',
            action_type:      a.action_type,
            type:             a.action_type,
            next_step,
            priority:         ['high', 'medium', 'low'].includes(a.priority) ? a.priority : 'medium',
            due_date,
            deal_id:          context.deal.id,
            contact_id:       null,
            account_id:       context.deal.account_id,
            suggested_action: a.suggested_action || null,
            context:          a.reasoning        || null,
            source:           'ai_generated',
            source_rule:      'ai_enhancer',
            metadata:         JSON.stringify({ confidence: a.confidence, reasoning: a.reasoning }),
          };
        });
    } catch (err) {
      console.error('❌ AI Enhancer: failed to parse response:', err.message);
      return [];
    }
  }
}

module.exports = ActionsAIEnhancer;
