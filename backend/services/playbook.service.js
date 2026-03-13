// playbookService.js
// Shared playbook service — works across all modules (deals, cases, contracts, prospects).
//
// Responsibilities:
//   resolvePlaybook()    — find the right playbook for an entity (explicit or type default)
//   getStagesForPlaybook() — fetch stages from pipeline_stages table
//   getPlaysForStage()   — fetch active plays for a specific playbook stage (read-only)
//   firePlaybookPlays()  — evaluate plays and insert into the module's play instances table
//
// Each module calls this service instead of implementing its own play-firing logic.

'use strict';

const db = require('../config/database');

// ── Play instances config per entity type ────────────────────────────────────
// Maps entityType → { table, entityColumn }
// Add new modules here as they are built.
const ENTITY_CONFIG = {
  deal:     { table: 'deal_play_instances', entityColumn: 'deal_id'     },
  case:     { table: 'case_plays',          entityColumn: 'case_id'     },
  contract: { table: 'contract_plays',      entityColumn: 'contract_id' },
  prospect: { table: 'prospecting_actions', entityColumn: 'prospect_id' },
};

// ── resolvePlaybook ──────────────────────────────────────────────────────────
// Returns the playbook_id to use for an entity.
//   1. If the entity has an explicit playbook_id set — use it
//   2. Otherwise find the default playbook for that type in the org
//
// params:
//   orgId      {number}
//   playbookId {number|null}  — from entity row (e.g. cases.playbook_id)
//   type       {string}       — playbook type ('service', 'clm', 'sales', ...)
//
// returns: {number|null} resolved playbook id
async function resolvePlaybook(orgId, playbookId, type) {
  if (playbookId) return playbookId;

  const result = await db.query(
    `SELECT id FROM playbooks
     WHERE org_id = $1 AND type = $2 AND is_default = true
     LIMIT 1`,
    [orgId, type]
  );
  return result.rows[0]?.id || null;
}

// ── getStagesForPlaybook ─────────────────────────────────────────────────────
// Returns ordered active non-terminal stages for a playbook from pipeline_stages.
// All types use pipeline_stages — sales legacy types map to pipeline='sales',
// prospecting to pipeline='prospecting', all others use the type key directly.
//
// returns: Array<{ key, name, sort_order, is_active, is_terminal }>
const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];

async function getStagesForPlaybook(orgId, playbookId, playbookType) {
  const pipeline = !playbookType || SALES_LEGACY_TYPES.includes(playbookType) ? 'sales'
    : playbookType === 'prospecting' ? 'prospecting'
    : playbookType; // clm, service, handover_s2i, or any custom type

  const result = await db.query(
    `SELECT key, name, sort_order, is_active, is_terminal
     FROM pipeline_stages
     WHERE org_id = $1 AND pipeline = $2 AND is_active = true AND is_terminal = false
     ORDER BY sort_order`,
    [orgId, pipeline]
  );
  return result.rows;
}

// ── getPlaysForStage ─────────────────────────────────────────────────────────
// Read-only fetch of active plays for a specific playbook + stage.
// Used by DealContextBuilder to supply stage play context to the STRAP AI prompt.
// Does NOT insert or fire anything.
//
// params:
//   orgId      {number}
//   playbookId {number|null}  — if null, returns []
//   stageKey   {string}       — the stage key to fetch plays for
//
// returns: Array<{ id, title, execution_type, due_offset_days, is_gate }>
async function getPlaysForStage(orgId, playbookId, stageKey) {
  if (!playbookId) return [];

  const result = await db.query(
    `SELECT id, title, execution_type, due_offset_days, is_gate
     FROM playbook_plays
     WHERE playbook_id = $1 AND stage_key = $2 AND is_active = true
     ORDER BY id`,
    [playbookId, stageKey]
  );
  return result.rows;
}

// ── evaluateConditions ───────────────────────────────────────────────────────
// Returns true if all fire conditions pass for the given context.
// Context shape varies by entity type — each module passes what it knows.
// Empty conditions = always fire.
function evaluateConditions(conditions, context) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;

  return conditions.every(cond => {
    try {
      switch (cond.type) {
        // ── Deal / Sales conditions ───────────────────────────────────────
        case 'no_meeting_this_stage':
          return !context.hadMeetingThisStage;

        case 'meeting_not_scheduled':
          return !context.hasMeetingScheduled;

        case 'no_email_since_meeting':
          return context.hadMeeting && !context.hasEmailSinceMeeting;

        case 'no_contact_role':
          return !(context.contactRoles || []).includes(cond.role);

        case 'no_file_matching':
          return !(context.fileNames || []).some(n =>
            new RegExp(cond.pattern || '', 'i').test(n)
          );

        case 'days_in_stage': {
          const days = context.daysInStage ?? 0;
          return applyOperator(cond.operator, days, cond.value);
        }

        case 'days_until_close': {
          const days = context.daysUntilClose ?? 999;
          return applyOperator(cond.operator, days, cond.value);
        }

        case 'health_param_state':
          return (context.healthParams || {})[cond.param] === cond.state;

        // ── Case / Service conditions ─────────────────────────────────────
        case 'priority_is':
          return context.priority === cond.value;

        case 'sla_tier_is':
          return String(context.slaTierId) === String(cond.value);

        case 'response_breached':
          return context.responseBreached === true;

        case 'resolution_breached':
          return context.resolutionBreached === true;

        // ── Contract / CLM conditions ─────────────────────────────────────
        case 'contract_value_above':
          return (context.contractValue || 0) > (cond.value || 0);

        case 'arr_impact':
          return context.arrImpact === true;

        // ── Prospect conditions ───────────────────────────────────────────
        case 'icp_score_above':
          return (context.icpScore || 0) > (cond.value || 0);

        case 'outreach_count_above':
          return (context.outreachCount || 0) > (cond.value || 0);

        default:
          // Unknown condition type — don't block the play
          return true;
      }
    } catch {
      return true; // evaluation error — don't block
    }
  });
}

function applyOperator(op, actual, expected) {
  switch (op) {
    case '>':  return actual >  expected;
    case '>=': return actual >= expected;
    case '<':  return actual <  expected;
    case '<=': return actual <= expected;
    default:   return true;
  }
}

// ── buildDueAt ───────────────────────────────────────────────────────────────
// Calculates due_at from due_offset_days. Falls back to 3 days.
function buildDueAt(dueOffsetDays) {
  const days = parseInt(dueOffsetDays) || 3;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// ── firePlaybookPlays ────────────────────────────────────────────────────────
// Core method — fires plays for an entity when it enters a stage.
//
// params: {
//   orgId        {number}
//   playbookId   {number}   — already resolved (use resolvePlaybook first)
//   stageKey     {string}   — the stage/status the entity just entered
//   entityType   {string}   — 'deal' | 'case' | 'contract' | 'prospect'
//   entityId     {number}   — id of the atomic unit
//   context      {object}   — module-specific fields for condition evaluation
//   assignedTo   {number|null} — default user to assign plays to
// }
//
// returns: { fired: number, skipped: number }
async function firePlaybookPlays({ orgId, playbookId, stageKey, entityType, entityId, context = {}, assignedTo = null }) {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) throw new Error(`Unknown entityType: ${entityType}`);

  // Fetch all active plays for this playbook + stage
  const playsResult = await db.query(
    `SELECT pp.id, pp.title, pp.fire_conditions, pp.due_offset_days,
            pp.execution_type, pp.is_gate, pp.is_active
     FROM playbook_plays pp
     WHERE pp.playbook_id = $1
       AND pp.stage_key   = $2
       AND pp.is_active   = true`,
    [playbookId, stageKey]
  );

  const plays = playsResult.rows;
  if (plays.length === 0) return { fired: 0, skipped: 0 };

  let fired = 0;
  let skipped = 0;

  for (const play of plays) {
    const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];

    if (!evaluateConditions(conditions, context)) {
      skipped++;
      continue;
    }

    const dueAt = buildDueAt(play.due_offset_days);

    try {
      if (entityType === 'prospect') {
        // prospecting_actions has a different shape — map to its columns
        await db.query(
          `INSERT INTO prospecting_actions
             (org_id, prospect_id, playbook_id, play_id, title, action_type,
              status, priority, due_date, source)
           VALUES ($1, $2, $3, $4, $5, 'playbook_play', 'pending', 'medium', $6, 'playbook')`,
          [orgId, entityId, playbookId, play.id, play.title, dueAt]
        );
      } else {
        // deal_play_instances, case_plays, contract_plays — all share same shape
        await db.query(
          `INSERT INTO ${cfg.table}
             (org_id, ${cfg.entityColumn}, playbook_id, play_id, stage_key,
              status, assigned_to, due_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
          [orgId, entityId, playbookId, play.id, stageKey, assignedTo, dueAt]
        );
      }
      fired++;
    } catch (err) {
      // Log but don't block — play firing is non-critical
      console.error(`[playbookService] Failed to fire play ${play.id} for ${entityType} ${entityId}:`, err.message);
    }
  }

  return { fired, skipped };
}

// ── fireForEntity ────────────────────────────────────────────────────────────
// Convenience wrapper — resolves the playbook automatically from the entity
// row and fires plays. Modules call this instead of resolvePlaybook + firePlaybookPlays.
//
// params: {
//   orgId        {number}
//   playbookType {string}       — 'service' | 'clm' | 'sales' | 'prospecting' | ...
//   playbookId   {number|null}  — from entity row, null = use type default
//   stageKey     {string}
//   entityType   {string}
//   entityId     {number}
//   context      {object}
//   assignedTo   {number|null}
// }
async function fireForEntity({ orgId, playbookType, playbookId, stageKey, entityType, entityId, context = {}, assignedTo = null }) {
  try {
    const resolvedId = await resolvePlaybook(orgId, playbookId, playbookType);
    if (!resolvedId) {
      console.warn(`[playbookService] No playbook found for type=${playbookType} org=${orgId} — skipping play fire`);
      return { fired: 0, skipped: 0 };
    }
    return await firePlaybookPlays({ orgId, playbookId: resolvedId, stageKey, entityType, entityId, context, assignedTo });
  } catch (err) {
    // Non-blocking — log and continue
    console.error(`[playbookService] fireForEntity error (${entityType} ${entityId}):`, err.message);
    return { fired: 0, skipped: 0 };
  }
}

module.exports = {
  resolvePlaybook,
  getStagesForPlaybook,
  getPlaysForStage,
  firePlaybookPlays,
  fireForEntity,
  evaluateConditions,
};
