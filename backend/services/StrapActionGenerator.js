/**
 * StrapActionGenerator.js
 *
 * Converts a STRAP's action_plan text into real action rows.
 *
 * For deal/account/implementation STRAPs → inserts into `actions` table
 * For prospect STRAPs → inserts into `prospecting_actions` table
 *
 * Each row gets:
 *   - strap_id FK pointing back to the STRAP
 *   - source = 'strap'
 *   - source_rule = 'strap_{hurdleType}'
 *   - Inferred next_step / channel from the step text
 *
 * Also creates junction rows in `strap_actions` for tracking.
 *
 * Public API:
 *   generate(strap, context, userId, orgId)  → { actions: [], count }
 *   deleteForStrap(strapId, orgId)           → deletes strap-linked actions
 */

const db = require('../config/database');
const { resolveForPlay } = require('./PlayRouteResolver');

// ── Channel / next_step inference from action text ───────────────────────────

const CHANNEL_PATTERNS = [
  { pattern: /\b(email|e-mail|send.*email|draft.*email|email.*to)\b/i, channel: 'email' },
  { pattern: /\b(call|phone|dial|voicemail|ring)\b/i,                  channel: 'call' },
  { pattern: /\b(linkedin|linked.in|LI\b|DM\b|InMail)\b/i,           channel: 'linkedin' },
  { pattern: /\b(whatsapp|whats.app|WA\b)\b/i,                        channel: 'whatsapp' },
  { pattern: /\b(slack|teams.message)\b/i,                             channel: 'slack' },
  { pattern: /\b(document|pdf|deck|presentation|prepare.*doc|write.*doc|one-pager|business.case|proposal|brief)\b/i, channel: 'document' },
  { pattern: /\b(meeting|schedule|book.*call|calendar|QBR|demo)\b/i,   channel: 'email' }, // meetings are typically scheduled via email
  { pattern: /\b(research|review|map|identify|check|analyze|pull)\b/i, channel: 'internal_task' },
];

function inferChannel(text) {
  for (const { pattern, channel } of CHANNEL_PATTERNS) {
    if (pattern.test(text)) return channel;
  }
  return 'internal_task'; // default: internal task
}

function isInternalChannel(channel) {
  return ['document', 'internal_task'].includes(channel);
}

// ── Parse action_plan text into discrete steps ───────────────────────────────

function parseActionPlan(actionPlanText) {
  if (!actionPlanText) return [];

  // Split by numbered lines: "1. ...", "2. ...", etc.
  const lines = actionPlanText
    .split(/\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const steps = [];
  let currentStep = null;

  for (const line of lines) {
    // Match numbered steps: "1. Do something" or "1) Do something"
    const match = line.match(/^(\d+)[.)]\s*(.+)/);
    if (match) {
      if (currentStep) steps.push(currentStep);
      currentStep = {
        stepNumber: parseInt(match[1]),
        text: match[2].trim(),
      };
    } else if (currentStep) {
      // Continuation of previous step
      currentStep.text += ' ' + line;
    } else {
      // Line without number — treat as step
      steps.push({
        stepNumber: steps.length + 1,
        text: line,
      });
    }
  }
  if (currentStep) steps.push(currentStep);

  return steps;
}

// ── Due date calculation ─────────────────────────────────────────────────────

function calculateDueDate(stepNumber, totalSteps, priority) {
  // Spread steps across a time window based on priority
  const windowDays = {
    critical: 5,
    high: 7,
    medium: 14,
    low: 21,
  };
  const window = windowDays[priority] || 10;
  const daysOffset = Math.ceil((stepNumber / totalSteps) * window);
  const due = new Date();
  due.setDate(due.getDate() + daysOffset);
  return due;
}

// ── Priority mapping ─────────────────────────────────────────────────────────
// First steps inherit STRAP priority; later steps step down

function stepPriority(strapPriority, stepNumber, totalSteps) {
  const priorities = ['critical', 'high', 'medium', 'low'];
  const baseIndex = priorities.indexOf(strapPriority);
  if (baseIndex === -1) return 'medium';

  // First half of steps: same priority. Second half: one level lower.
  const halfPoint = Math.ceil(totalSteps / 2);
  if (stepNumber <= halfPoint) return strapPriority;
  return priorities[Math.min(baseIndex + 1, priorities.length - 1)];
}

// ── Main generator ───────────────────────────────────────────────────────────

class StrapActionGenerator {

  /**
   * Generate real action rows from a STRAP's action_plan.
   *
   * @param {object} strap    - Full STRAP row (from db)
   * @param {object} context  - Entity context (deal, account, prospect, etc.)
   * @param {number} userId
   * @param {number} orgId
   * @returns {Promise<{ actions: object[], count: number }>}
   */
  static async generate(strap, context, userId, orgId) {
    if (!strap.action_plan) {
      console.log(`⚠️ STRAP #${strap.id}: no action_plan to generate actions from`);
      return { actions: [], count: 0 };
    }

    const steps = parseActionPlan(strap.action_plan);
    if (steps.length === 0) {
      console.log(`⚠️ STRAP #${strap.id}: action_plan parsed into 0 steps`);
      return { actions: [], count: 0 };
    }

    // Delete any existing strap-linked actions (in case of regeneration)
    await this.deleteForStrap(strap.id, orgId);

    const isProspect = strap.entity_type === 'prospect';
    const sourceRule = `strap_${strap.hurdle_type}`;
    const createdActions = [];

    // Resolve entity for routing context (best-effort, non-blocking)
    let entityForRouting = null;
    try {
      if (isProspect) {
        const r = await db.query('SELECT id, assigned_to FROM prospects WHERE id = $1', [strap.entity_id]);
        entityForRouting = r.rows[0] || null;
      } else if (strap.entity_type === 'deal' || strap.entity_type === 'implementation') {
        const r = await db.query('SELECT id, owner_id FROM deals WHERE id = $1', [strap.entity_id]);
        entityForRouting = r.rows[0] || null;
      }
    } catch (_) { /* non-blocking */ }

    // Resolve assignee via PlayRouteResolver — no play roles on STRAPs yet,
    // so this goes: entity owner → caller fallback.
    // Hook is in place for when STRAP plays gain role assignments.
    const assigneeIds = await resolveForPlay({
      orgId,
      roleKey:      null,
      roleId:       null,
      entity:       entityForRouting,
      entityType:   isProspect ? 'prospect' : 'deal',
      callerUserId: userId,
    });
    const assigneeUserId = assigneeIds[0] || userId;

    for (const step of steps) {
      try {
        const channel = inferChannel(step.text);
        const isInternal = isInternalChannel(channel);
        const dueDate = calculateDueDate(step.stepNumber, steps.length, strap.priority);
        const priority = stepPriority(strap.priority, step.stepNumber, steps.length);

        let actionId;
        let actionTable;

        if (isProspect) {
          // Insert into prospecting_actions
          const result = await db.query(
            `INSERT INTO prospecting_actions (
               org_id, user_id, prospect_id, strap_id,
               title, description, channel, priority, action_type,
               source, due_date, status,
               created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'strap',$10,'pending',NOW())
             RETURNING id`,
            [
              orgId, assigneeUserId, strap.entity_id, strap.id,
              step.text,
              `STRAP action step ${step.stepNumber}: ${strap.hurdle_title}`,
              channel,
              priority,
              'outreach',
              dueDate,
            ]
          );
          actionId = result.rows[0].id;
          actionTable = 'prospecting_actions';

        } else {
          // Insert into actions table (deals, accounts, implementations)
          const dealId = (strap.entity_type === 'deal' || strap.entity_type === 'implementation')
            ? strap.entity_id
            : (context?.deal?.id || null);

          const result = await db.query(
            `INSERT INTO actions (
               org_id, user_id, deal_id, strap_id,
               title, description, action_type, priority,
               next_step, is_internal,
               source, source_rule,
               due_date, status, created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'strap',$11,$12,'yet_to_start',NOW())
             RETURNING id`,
            [
              orgId, assigneeUserId, dealId, strap.id,
              step.text,
              `STRAP action step ${step.stepNumber}: ${strap.hurdle_title}`,
              isInternal ? 'document_prep' : 'follow_up',
              priority,
              channel,
              isInternal,
              sourceRule,
              dueDate,
            ]
          );
          actionId = result.rows[0].id;
          actionTable = 'actions';
        }

        // Create junction row in strap_actions
        await db.query(
          `INSERT INTO strap_actions (strap_id, action_table, action_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (strap_id, action_table, action_id) DO NOTHING`,
          [strap.id, actionTable, actionId]
        );

        createdActions.push({ id: actionId, table: actionTable, title: step.text, step: step.stepNumber });

        // Create calendar entry so this shows up in the assignee's CalendarView
        try {
          const startTime = new Date(dueDate);
          startTime.setHours(9, 0, 0, 0);
          const endTime = new Date(startTime);
          endTime.setMinutes(endTime.getMinutes() + 30);

          const channelLabel = {
            email: 'Email', call: 'Call', linkedin: 'LinkedIn',
            whatsapp: 'WhatsApp', document: 'Document Prep',
            internal_task: 'Task', slack: 'Slack',
          }[channel] || 'Task';

          const dealIdForCal = isProspect ? null
            : ((strap.entity_type === 'deal' || strap.entity_type === 'implementation')
                ? strap.entity_id
                : (context?.deal?.id || null));

          await db.query(
            `INSERT INTO meetings (
               org_id, user_id, deal_id,
               title, description,
               start_time, end_time,
               meeting_type, source, status,
               created_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'strap','scheduled',NOW())`,
            [
              orgId,
              assigneeUserId,
              dealIdForCal,
              `[STRAP ${channelLabel}] ${step.text}`,
              `Auto-created from STRAP action plan. Step ${step.stepNumber}: ${strap.hurdle_title}. Priority: ${priority}.`,
              startTime,
              endTime,
              channel === 'call' ? 'call' : channel === 'email' ? 'virtual' : 'task',
            ]
          );
        } catch (calErr) {
          // Calendar entry is best-effort
          console.error(`  📅 Calendar entry for step ${step.stepNumber} failed (non-blocking):`, calErr.message);
        }
      } catch (err) {
        console.error(`  ❌ STRAP action insert failed (step ${step.stepNumber}):`, err.message);
      }
    }

    console.log(`✅ STRAP #${strap.id}: generated ${createdActions.length} action(s) from ${steps.length} plan steps`);

    // ── AI Enhancement (optional, module-gated) ────────────────────────────
    // Runs only if ai_settings.modules.straps is enabled for this user+org.
    // Non-blocking — any failure just skips AI enhancements.
    try {
      const ActionConfigService = require('./actionConfig.service');
      const actionConfig = await ActionConfigService.getConfig(userId, orgId);
      if (ActionConfigService.isAiEnabledForModule(actionConfig, 'straps')) {
        const StrapAIEnhancer = require('./StrapAIEnhancer');
        const aiActions = await StrapAIEnhancer.enhance(strap, context, createdActions, orgId, userId);
        if (aiActions.length > 0) {
          console.log(`  🤖 STRAP AI: ${aiActions.length} additional action(s) for STRAP #${strap.id}`);
          for (const action of aiActions) {
            createdActions.push(action);
          }
        }
      }
    } catch (aiErr) {
      console.error(`  🤖 STRAP AI enhancement skipped (non-blocking):`, aiErr.message);
    }

    return { actions: createdActions, count: createdActions.length };
  }

  /**
   * Delete all actions linked to a STRAP.
   * Only deletes incomplete strap-sourced actions (preserves completed ones).
   */
  static async deleteForStrap(strapId, orgId) {
    // Get linked actions from junction table
    const junctionRows = await db.query(
      'SELECT action_table, action_id FROM strap_actions WHERE strap_id = $1',
      [strapId]
    );

    let deleted = 0;
    for (const row of junctionRows.rows) {
      try {
        if (row.action_table === 'actions') {
          const r = await db.query(
            `DELETE FROM actions
             WHERE id = $1 AND org_id = $2 AND source = 'strap'
               AND status IN ('yet_to_start', 'in_progress')
             RETURNING id`,
            [row.action_id, orgId]
          );
          if (r.rows.length > 0) deleted++;
        } else if (row.action_table === 'prospecting_actions') {
          const r = await db.query(
            `DELETE FROM prospecting_actions
             WHERE id = $1 AND org_id = $2 AND source = 'strap'
               AND status IN ('pending', 'in_progress')
             RETURNING id`,
            [row.action_id, orgId]
          );
          if (r.rows.length > 0) deleted++;
        }
      } catch (err) {
        console.error(`  ⚠️ Failed to delete strap action ${row.action_table}/${row.action_id}:`, err.message);
      }
    }

    // Clean up junction rows for deleted actions
    if (deleted > 0) {
      await db.query('DELETE FROM strap_actions WHERE strap_id = $1', [strapId]);
    }

    return deleted;
  }

  /**
   * Get progress for a STRAP: how many linked actions are completed.
   */
  static async getProgress(strapId) {
    const result = await db.query(
      'SELECT action_table, action_id FROM strap_actions WHERE strap_id = $1',
      [strapId]
    );

    if (result.rows.length === 0) {
      return { total: 0, completed: 0, inProgress: 0, pending: 0, percent: 0 };
    }

    let completed = 0;
    let inProgress = 0;
    let pending = 0;

    for (const row of result.rows) {
      let statusResult;
      if (row.action_table === 'actions') {
        statusResult = await db.query('SELECT status FROM actions WHERE id = $1', [row.action_id]);
      } else {
        statusResult = await db.query('SELECT status FROM prospecting_actions WHERE id = $1', [row.action_id]);
      }

      const status = statusResult.rows[0]?.status;
      if (!status) continue; // action was deleted
      if (status === 'completed') completed++;
      else if (status === 'in_progress') inProgress++;
      else pending++;
    }

    const total = completed + inProgress + pending;
    return {
      total,
      completed,
      inProgress,
      pending,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  /**
   * Check if all STRAP actions are complete — if so, auto-resolve the STRAP.
   * Called after any action status change.
   */
  static async checkAutoResolve(strapId, userId, orgId) {
    const progress = await this.getProgress(strapId);

    // Only auto-resolve if there are linked actions and all are done
    if (progress.total > 0 && progress.completed === progress.total) {
      const StrapEngine = require('./StrapEngine');
      const strap = await StrapEngine.getById(strapId, orgId);
      if (strap && strap.status === 'active') {
        await StrapEngine.resolve(strapId, userId, orgId, {
          resolutionType: 'auto_detected',
          note: `All ${progress.total} STRAP action(s) completed.`,
        });
        console.log(`✅ STRAP #${strapId} auto-resolved: all ${progress.total} actions completed`);
        return true;
      }
    }
    return false;
  }
}

module.exports = StrapActionGenerator;
