/**
 * playbook.service.js
 *
 * Playbook data access + condition evaluation for conditional play firing.
 *
 * KEY ADDITIONS (Phase 1):
 *   - getPlaysForStage(orgId, stageKey) — fetches structured plays (not key_action strings)
 *   - evaluateConditions(conditions, context) — pure function, zero DB calls
 *     evaluates fire_conditions array against deal context object
 *
 * EXISTING METHODS retained unchanged:
 *   - getStageActions, getStageGuidance, getDefaultGuidance
 *   - classifyActionType, suggestPriority, suggestDueDays
 *   - extractKeywords, requiresExternalEvidence
 *   - upsertStageGuidance
 */

const db = require('../config/database');

// ── Condition evaluator ───────────────────────────────────────────────────────
//
// Supported condition types and their context lookups:
//
//  { type: 'no_meeting_this_stage' }
//    → no completed meeting since deal.stage_changed_at
//
//  { type: 'meeting_not_scheduled' }
//    → no upcoming (status=scheduled, future) meeting on the deal
//
//  { type: 'no_email_since_meeting' }
//    → no outbound email sent after the last completed meeting
//
//  { type: 'no_contact_role', role: 'decision_maker' }
//    → no contact with that role_type on the deal's account
//
//  { type: 'no_file_matching', pattern: 'proposal|quote' }
//    → no file whose file_name matches the regex pattern
//
//  { type: 'days_in_stage', operator: '>', value: 7 }
//    → derived.daysInStage > 7  (operator: '>' | '>=' | '<' | '<=')
//
//  { type: 'days_until_close', operator: '<', value: 14 }
//    → derived.daysUntilClose < 14
//
//  { type: 'health_param_state', param: '2a', state: 'absent' }
//    → healthBreakdown.params['2a'].state === 'absent'
//
// All conditions are AND-ed: every condition must pass for the play to fire.
// Empty array = fire unconditionally (safe default for unconfigured plays).

function evaluateConditions(conditions, context) {
  if (!conditions || conditions.length === 0) return true;

  const { deal, derived, contacts, emails, files, healthBreakdown } = context;

  for (const cond of conditions) {
    switch (cond.type) {

      case 'no_meeting_this_stage': {
        // True (should fire) when NO completed meeting exists since stage entry
        const stageEntryDate = deal.stage_changed_at ? new Date(deal.stage_changed_at) : new Date(0);
        const hasMeetingThisStage = derived.completedMeetings.some(
          m => new Date(m.start_time) >= stageEntryDate
        );
        if (hasMeetingThisStage) return false;
        break;
      }

      case 'meeting_not_scheduled': {
        // True when no upcoming meeting is booked
        if (derived.upcomingMeetings.length > 0) return false;
        break;
      }

      case 'no_email_since_meeting': {
        // True when no outbound email has been sent after the last completed meeting
        const lastMeeting = derived.completedMeetings[0];
        if (lastMeeting) {
          const meetingTime = new Date(lastMeeting.start_time);
          const hasFollowUp = emails.some(
            e => e.direction === 'sent' && new Date(e.sent_at) > meetingTime
          );
          if (hasFollowUp) return false;
        }
        break;
      }

      case 'no_contact_role': {
        // True when no contact with the specified role exists
        const role = cond.role || '';
        const roleVariants = {
          decision_maker: ['decision_maker', 'economic_buyer'],
          champion:       ['champion'],
          executive:      ['executive', 'decision_maker', 'economic_buyer'],
          influencer:     ['influencer'],
        };
        const acceptedRoles = roleVariants[role] || [role];
        const hasRole = contacts.some(c => acceptedRoles.includes(c.role_type));
        if (hasRole) return false;
        break;
      }

      case 'no_file_matching': {
        // True when no file matches the provided regex pattern
        const pattern = cond.pattern || '';
        if (pattern) {
          try {
            const regex = new RegExp(pattern, 'i');
            const hasFile = files.some(f => regex.test(f.file_name || ''));
            if (hasFile) return false;
          } catch (_) {
            // Invalid regex — treat as condition passed (don't block play)
          }
        }
        break;
      }

      case 'days_in_stage': {
        const val = Number(cond.value ?? 0);
        const days = derived.daysInStage ?? 0;
        if (!compareValues(days, cond.operator || '>', val)) return false;
        break;
      }

      case 'days_until_close': {
        if (derived.daysUntilClose === null) break; // no close date — condition skipped
        const val = Number(cond.value ?? 0);
        if (!compareValues(derived.daysUntilClose, cond.operator || '<', val)) return false;
        break;
      }

      case 'health_param_state': {
        const param = cond.param;
        const expectedState = cond.state;
        if (param && expectedState && healthBreakdown?.params) {
          const actualState = healthBreakdown.params[param]?.state;
          if (actualState !== expectedState) return false;
        }
        break;
      }

      default:
        // Unknown condition type — skip (don't block the play)
        break;
    }
  }

  return true; // all conditions passed
}

function compareValues(actual, operator, expected) {
  switch (operator) {
    case '>':  return actual >  expected;
    case '>=': return actual >= expected;
    case '<':  return actual <  expected;
    case '<=': return actual <= expected;
    case '=':
    case '==': return actual === expected;
    default:   return actual >  expected;
  }
}

// ── PlaybookService class ─────────────────────────────────────────────────────

class PlaybookService {

  // ── Phase 1: Get structured plays for a stage ──────────────────────────────
  // Returns plays with fire_conditions, channel, priority, due_offset_days,
  // suggested_action, and role assignments — replacing the key_action string array.

  static async getPlaysForStage(orgId, stageKey) {
    if (!orgId || !stageKey) return [];
    try {
      const result = await db.query(
        `SELECT
           pp.id,
           pp.title,
           pp.description,
           pp.channel,
           pp.priority,
           pp.due_offset_days,
           pp.execution_type,
           pp.depends_on,
           pp.is_gate,
           pp.unlocks_play_id,
           pp.fire_conditions,
           pp.suggested_action,
           COALESCE(
             json_agg(
               json_build_object(
                 'role_id',        ppr.role_id,
                 'ownership_type', ppr.ownership_type,
                 'role_name',      dr.name
               )
             ) FILTER (WHERE ppr.role_id IS NOT NULL),
             '[]'
           ) AS roles
         FROM playbook_plays pp
         LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
         LEFT JOIN org_roles dr ON dr.id = ppr.role_id
         WHERE pp.org_id = $1
           AND pp.stage_key = $2
           AND pp.is_active = true
         GROUP BY pp.id
         ORDER BY pp.sort_order ASC, pp.id ASC`,
        [orgId, stageKey]
      );
      return result.rows.map(r => ({
        ...r,
        fire_conditions: typeof r.fire_conditions === 'string'
          ? JSON.parse(r.fire_conditions)
          : (r.fire_conditions || []),
        roles: typeof r.roles === 'string' ? JSON.parse(r.roles) : (r.roles || []),
        depends_on: Array.isArray(r.depends_on) ? r.depends_on : [],
      }));
    } catch (err) {
      console.error('PlaybookService.getPlaysForStage error:', err.message);
      return [];
    }
  }

  // ── Expose evaluateConditions as a static method ───────────────────────────

  static evaluateConditions(conditions, context) {
    return evaluateConditions(conditions, context);
  }

  // ── Existing methods (unchanged) ──────────────────────────────────────────

  static async getStageActions(orgId, stageKey) {
    if (!orgId || !stageKey) return [];
    try {
      const result = await db.query(
        `SELECT stage_guidance FROM playbooks
         WHERE org_id = $1 AND is_default = true AND type = 'sales'
         LIMIT 1`,
        [orgId]
      );
      if (result.rows.length === 0) return [];
      const raw = result.rows[0].stage_guidance;
      const guidance = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      const stageData = guidance[stageKey];
      if (!stageData) return [];
      const keyActions = stageData.key_actions || [];
      // Support both legacy string[] and new object[] formats
      return keyActions.map(a => (typeof a === 'string' ? a : a.title || '')).filter(Boolean);
    } catch (err) {
      console.error('PlaybookService.getStageActions error:', err.message);
      return [];
    }
  }

  static async getStageGuidance(orgId, stageKey) {
    if (!orgId || !stageKey) return null;
    try {
      const result = await db.query(
        `SELECT stage_guidance FROM playbooks
         WHERE org_id = $1 AND is_default = true AND type = 'sales'
         LIMIT 1`,
        [orgId]
      );
      if (result.rows.length === 0) return null;
      const raw = result.rows[0].stage_guidance;
      const guidance = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      return guidance[stageKey] || null;
    } catch (err) {
      console.error('PlaybookService.getStageGuidance error:', err.message);
      return null;
    }
  }

  static async upsertStageGuidance(playbookId, orgId, stageKey, guidanceData) {
    const result = await db.query(
      `UPDATE playbooks
       SET stage_guidance = jsonb_set(
         COALESCE(stage_guidance, '{}'),
         $1::text[],
         $2::jsonb,
         true
       ),
       updated_at = NOW()
       WHERE id = $3 AND org_id = $4
       RETURNING stage_guidance`,
      [
        `{${stageKey}}`,
        JSON.stringify(guidanceData),
        playbookId,
        orgId,
      ]
    );
    return result.rows[0];
  }

  static classifyActionType(text) {
    const t = text.toLowerCase();
    if (/\b(schedule|book|set up|arrange).*(meeting|call|demo|session|presentation)/i.test(t)) return 'meeting_schedule';
    if (/\b(send|write|draft|follow[\s-]?up|email|reply|respond)/i.test(t)) return 'email_send';
    if (/\b(prepare|create|build|develop|write|draft).*(document|proposal|deck|presentation|brief|plan|report)/i.test(t)) return 'document_prep';
    if (/\b(review|analyse|assess|evaluate|check|audit|score)/i.test(t)) return 'review';
    if (/\b(call|phone|ring|dial)/i.test(t)) return 'meeting_schedule';
    if (/\b(identify|find|research|discover|map|list)/i.test(t)) return 'task_complete';
    if (/\b(update|log|record|confirm|close|resolve)/i.test(t)) return 'task_complete';
    if (/\b(introduce|connect|handover|transition)/i.test(t)) return 'email_send';
    return 'follow_up';
  }

  static suggestPriority(stageOrType, actionType) {
    const stage = (stageOrType || '').toLowerCase();
    if (['negotiation', 'closing', 'closed_won'].some(s => stage.includes(s))) {
      return actionType === 'meeting_schedule' ? 'critical' : 'high';
    }
    if (['proposal', 'evaluation'].some(s => stage.includes(s))) {
      return actionType === 'meeting_schedule' ? 'high' : 'medium';
    }
    if (actionType === 'meeting_schedule') return 'high';
    if (actionType === 'document_prep')    return 'medium';
    return 'medium';
  }

  static suggestDueDays(stageOrType, actionType) {
    const stage = (stageOrType || '').toLowerCase();
    if (['negotiation', 'closing'].some(s => stage.includes(s))) return 1;
    if (actionType === 'meeting_schedule') return 2;
    if (actionType === 'email_send')       return 1;
    if (actionType === 'document_prep')    return 3;
    if (actionType === 'review')           return 2;
    return 3;
  }

  static extractKeywords(text) {
    const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'will', 'your', 'their', 'about']);
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
      .slice(0, 10);
  }

  static requiresExternalEvidence(actionType, text) {
    if (['email_send', 'meeting_schedule', 'follow_up'].includes(actionType)) return true;
    if (/\b(send|call|meet|email|schedule|contact)/i.test(text)) return true;
    return false;
  }
}

module.exports = PlaybookService;
