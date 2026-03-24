// playbookService.js
// Shared playbook service — works across all modules (deals, cases, contracts, prospects).
//
// Responsibilities:
//   resolvePlaybook()      — find the right playbook for an entity (explicit or type default)
//   getPlaybook()          — load full playbook record for a user/org (used by DealContextBuilder)
//   getPlaybookById()      — load full playbook record by id with config flags
//   getStagesForPlaybook() — fetch stages from pipeline_stages table
//   getPlaysForStage()     — fetch active plays for a specific playbook stage (read-only)
//   getStageActions()      — alias used by actionsGenerator: plays for org-default sales playbook
//   getStageGuidance()     — stage_guidance block for org-default sales playbook
//   firePlaybookPlays()    — evaluate plays and insert into the module's play instances table
//   upsertStageGuidance()  — update stage_guidance JSONB for one stage key
//
// Each module calls this service instead of implementing its own play-firing logic.

'use strict';

const db = require('../config/database');

// ── Play instances config per entity type ────────────────────────────────────
// Maps entityType → { table, entityColumn }
// Add new modules here as they are built.
const ENTITY_CONFIG = {
  deal:     { table: 'deal_play_instances',      entityColumn: 'deal_id'     },
  case:     { table: 'case_plays',               entityColumn: 'case_id'     },
  contract: { table: 'contract_play_instances',  entityColumn: 'contract_id' },
  prospect: { table: 'prospecting_actions',      entityColumn: 'prospect_id' },
  handover: { table: 'deal_play_instances',      entityColumn: 'deal_id'     },
};

// Sales-legacy types that map to the 'sales' pipeline in pipeline_stages
const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];

// ═════════════════════════════════════════════════════════════════════════════
// CANONICAL CHANNEL MAP — single source of truth for all modules.
// Imported by ActionsRulesEngine, PlaybookActionGenerator,
// ContractActionsGenerator, and prospectingActions.service.
// ═════════════════════════════════════════════════════════════════════════════

const CHANNEL_MAP = {
  email:         { action_type: 'email_send',      next_step: 'email',         prospect_channel: 'email',    is_internal: false },
  call:          { action_type: 'meeting_schedule', next_step: 'call',          prospect_channel: 'phone',    is_internal: false },
  meeting:       { action_type: 'meeting_schedule', next_step: 'call',          prospect_channel: 'phone',    is_internal: false },
  linkedin:      { action_type: 'follow_up',        next_step: 'linkedin',      prospect_channel: 'linkedin', is_internal: false },
  whatsapp:      { action_type: 'follow_up',        next_step: 'whatsapp',      prospect_channel: 'whatsapp', is_internal: false },
  document:      { action_type: 'document_prep',    next_step: 'document',      prospect_channel: null,       is_internal: true  },
  internal_task: { action_type: 'task_complete',    next_step: 'internal_task', prospect_channel: null,       is_internal: true  },
  slack:         { action_type: 'task_complete',    next_step: 'slack',         prospect_channel: null,       is_internal: true  },
  // sms: no sms in actions.next_step CHECK constraint — maps to 'email' there
  sms:           { action_type: 'follow_up',        next_step: 'email',         prospect_channel: 'sms',      is_internal: false },
  phone:         { action_type: 'meeting_schedule', next_step: 'call',          prospect_channel: 'phone',    is_internal: false },
};

const DEFAULT_CHANNEL = { action_type: 'task_complete', next_step: 'email', prospect_channel: null, is_internal: false };

/**
 * Resolve a play channel to its action_type / next_step / is_internal triple.
 * Used by ActionsRulesEngine and PlaybookActionGenerator for the actions table.
 * @param {string|null} channel
 * @returns {{ action_type: string, next_step: string, is_internal: boolean }}
 */
function resolveChannel(channel) {
  return CHANNEL_MAP[channel] || DEFAULT_CHANNEL;
}

/**
 * Resolve a play channel to the prospect_channel value stored in prospecting_actions.
 * The prospecting_actions.channel CHECK is: email | linkedin | phone | sms | whatsapp.
 * @param {string|null} channel
 * @returns {string|null}
 */
function resolveProspectChannel(channel) {
  const entry = CHANNEL_MAP[channel];
  return entry !== undefined ? entry.prospect_channel : null;
}

// ── parsePlaybookRow ─────────────────────────────────────────────────────────
// Safely parse JSONB fields on a playbook row.
function parsePlaybookRow(row) {
  if (!row) return null;
  const parse = (v) => {
    if (!v) return {};
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
    return v;
  };
  return {
    ...row,
    content:        parse(row.content),
    stage_guidance: parse(row.stage_guidance),
  };
}

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

// ── getPlaybook ──────────────────────────────────────────────────────────────
// Load the default sales playbook for a user's org.
// Called by DealContextBuilder._getPlaybook(userId, orgId).
// Tries user's org first, falls back to org-wide default.
//
// returns: full playbook row with parsed JSONB, or null
async function getPlaybook(userId, orgId) {
  // First: check if the user has a personal playbook preference via their deals
  // (most orgs just have one default — this covers that case)
  const result = await db.query(
    `SELECT * FROM playbooks
     WHERE org_id = $1
       AND type IN ('sales', 'custom', 'market', 'product')
       AND is_default = true
     LIMIT 1`,
    [orgId]
  );
  if (result.rows[0]) return parsePlaybookRow(result.rows[0]);

  // Fallback: any sales-type playbook for this org
  const fallback = await db.query(
    `SELECT * FROM playbooks
     WHERE org_id = $1
       AND type IN ('sales', 'custom', 'market', 'product')
     ORDER BY created_at ASC
     LIMIT 1`,
    [orgId]
  );
  return fallback.rows[0] ? parsePlaybookRow(fallback.rows[0]) : null;
}

// ── getPlaybookById ──────────────────────────────────────────────────────────
// Load a specific playbook by id with all config flags.
// Used by PlaybookActionGenerator and PlaybookInstanceManager.
//
// returns: full playbook row with parsed JSONB + config flags, or null
async function getPlaybookById(playbookId, orgId) {
  if (!playbookId) return null;
  const result = await db.query(
    `SELECT * FROM playbooks WHERE id = $1 AND org_id = $2`,
    [playbookId, orgId]
  );
  return result.rows[0] ? parsePlaybookRow(result.rows[0]) : null;
}

// ── getDefaultPlaybookForEntity ──────────────────────────────────────────────
// Resolve the default playbook for a given entity type in an org.
// Used by PlaybookActionGenerator when no explicit playbookId is provided.
//
// entityType: 'deal' | 'prospect' | 'contract' | 'case' | 'handover'
// returns: full playbook row or null
async function getDefaultPlaybookForEntity(orgId, entityType) {
  const result = await db.query(
    `SELECT * FROM playbooks
     WHERE org_id = $1
       AND entity_type = $2
       AND is_default = true
     LIMIT 1`,
    [orgId, entityType]
  );
  if (result.rows[0]) return parsePlaybookRow(result.rows[0]);

  // Legacy fallback for orgs not yet migrated: match by type field
  const typeMap = {
    deal:     ['sales', 'custom', 'market', 'product'],
    prospect: ['prospecting'],
    contract: ['clm'],
    case:     ['service'],
    handover: ['handover_s2i'],
  };
  const types = typeMap[entityType];
  if (!types) return null;

  const fallback = await db.query(
    `SELECT * FROM playbooks
     WHERE org_id = $1 AND type = ANY($2::text[]) AND is_default = true
     LIMIT 1`,
    [orgId, types]
  );
  return fallback.rows[0] ? parsePlaybookRow(fallback.rows[0]) : null;
}

// ── getStagesForPlaybook ─────────────────────────────────────────────────────
// Returns ordered active non-terminal stages for a playbook from pipeline_stages.
//
// returns: Array<{ key, name, sort_order, is_active, is_terminal }>
async function getStagesForPlaybook(orgId, playbookId, playbookType) {
  const pipeline = !playbookType || SALES_LEGACY_TYPES.includes(playbookType) ? 'sales'
    : playbookType === 'prospecting' ? 'prospecting'
    : playbookType;

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
// Used by DealContextBuilder and PlaybookActionGenerator.
// Does NOT insert or fire anything.
//
// params:
//   orgId      {number}
//   playbookId {number|null}  — if null, returns []
//   stageKey   {string}       — the stage key to fetch plays for
//   triggerMode {string|null} — optional: 'stage_change' | 'on_demand' | 'scheduled'
//                               if null/omitted, returns plays of all modes
//
// returns: Array<{ id, title, description, channel, suggested_action,
//                  execution_type, due_offset_days, is_gate, priority, sort_order,
//                  trigger_mode, schedule_config }>
async function getPlaysForStage(orgId, playbookId, stageKey, triggerMode = null) {
  if (!playbookId || !stageKey) return [];

  const params = [playbookId, stageKey];
  const modeClause = triggerMode
    ? `AND (pp.trigger_mode IS NULL OR pp.trigger_mode = $${params.push(triggerMode)})`
    : '';

  const result = await db.query(
    `SELECT id, title, description, channel, suggested_action,
            execution_type, due_offset_days, is_gate, priority, sort_order,
            fire_conditions, trigger_mode, schedule_config
     FROM playbook_plays pp
     WHERE playbook_id = $1
       AND stage_key   = $2
       AND is_active   = true
       ${modeClause}
     ORDER BY sort_order ASC`,
    params
  );
  return result.rows;
}

// ── getStageActions ──────────────────────────────────────────────────────────
// Called by actionsGenerator.buildContext() to load plays for the deal's
// current stage using the org's default sales playbook.
// Only returns plays with trigger_mode = 'scheduled' — this is the nightly
// cron path. Stage-change and on-demand plays are excluded here.
//
// params:
//   orgId    {number}
//   stageKey {string}  — e.g. 'proposal', 'demo'
//
// returns: Array of play rows (same shape as getPlaysForStage)
async function getStageActions(orgId, stageKey) {
  if (!orgId || !stageKey) return [];
  try {
    // Resolve the default sales playbook for this org
    const pbResult = await db.query(
      `SELECT id FROM playbooks
       WHERE org_id = $1
         AND type IN ('sales', 'custom', 'market', 'product')
         AND is_default = true
       LIMIT 1`,
      [orgId]
    );
    const playbookId = pbResult.rows[0]?.id;
    if (!playbookId) return [];
    return await getPlaysForStage(orgId, playbookId, stageKey, 'scheduled');
  } catch (err) {
    console.error('[playbookService] getStageActions error:', err.message);
    return [];
  }
}

// ── getStageGuidance ─────────────────────────────────────────────────────────
// Called by actionsGenerator.buildContext() to load the stage_guidance block
// for the deal's current stage from the org's default sales playbook.
//
// This is the FIXED version — the old code called this with (orgId, stageKey)
// but the function didn't exist.
//
// params:
//   orgId    {number}
//   stageKey {string}
//
// returns: stage guidance object { goal, key_actions, success_criteria, ... } or null
async function getStageGuidance(orgId, stageKey) {
  if (!orgId || !stageKey) return null;
  try {
    const result = await db.query(
      `SELECT stage_guidance FROM playbooks
       WHERE org_id = $1
         AND type IN ('sales', 'custom', 'market', 'product')
         AND is_default = true
       LIMIT 1`,
      [orgId]
    );
    if (!result.rows[0]) return null;
    const raw = result.rows[0].stage_guidance;
    const guidance = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return guidance[stageKey] || null;
  } catch (err) {
    console.error('[playbookService] getStageGuidance error:', err.message);
    return null;
  }
}

// ── upsertStageGuidance ──────────────────────────────────────────────────────
// Update one stage's guidance block inside the playbook's stage_guidance JSONB.
// Called by playbooks.routes.js PUT /:id/stages/:stageKey.
//
// returns: updated playbook row
async function upsertStageGuidance(playbookId, orgId, stageKey, guidance) {
  const result = await db.query(
    `UPDATE playbooks
     SET stage_guidance = jsonb_set(
           COALESCE(stage_guidance, '{}')::jsonb,
           $3::text[],
           $4::jsonb,
           true
         ),
         updated_at = NOW()
     WHERE id = $1 AND org_id = $2
     RETURNING id, stage_guidance`,
    [playbookId, orgId, `{${stageKey}}`, JSON.stringify(guidance)]
  );
  return result.rows[0];
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
        case 'contract_status_is':
          return context.contractStatus === cond.value;
        case 'review_sub_status_is':
          return context.reviewSubStatus === cond.value;
        case 'days_to_expiry': {
          const dte = context.daysToExpiry ?? null;
          if (dte === null) return false;
          return applyOperator(cond.operator, dte, cond.value);
        }
        case 'has_no_renewal':
          return context.hasRenewal !== true;

        // ── Prospect conditions ───────────────────────────────────────────
        case 'icp_score_above':
          return (context.icpScore || 0) > (cond.value || 0);
        case 'outreach_count_above':
          return (context.outreachCount || 0) > (cond.value || 0);

        default:
          return true; // Unknown condition — don't block
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

// ── extractKeywords ───────────────────────────────────────────────────────────
// Derives a simple keyword array from a play title for action tagging.
// Strips common stop words and short tokens, returns lowercase unique words.
function extractKeywords(title) {
  if (!title || typeof title !== 'string') return [];
  const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'by','from','up','about','into','through','this','that','these','those',
    'is','are','was','were','be','been','being','have','has','had','do','does',
    'did','will','would','could','should','may','might','shall','can','need',
    'your','their','our','its','we','you','they','it','he','she','i','me',
  ]);
  return [...new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  )];
}

// ── requiresExternalEvidence ──────────────────────────────────────────────────
// Returns true for action types / titles that involve external communication
// (email, meeting, call) and therefore require evidence of completion.
function requiresExternalEvidence(actionType, title) {
  const EXTERNAL_TYPES = new Set([
    'email_send', 'email', 'follow_up', 'meeting_schedule', 'meeting',
  ]);
  if (EXTERNAL_TYPES.has(actionType)) return true;
  const t = (title || '').toLowerCase();
  return (
    t.includes('email')     ||
    t.includes('send')      ||
    t.includes('call')      ||
    t.includes('meeting')   ||
    t.includes('schedule')  ||
    t.includes('reach out') ||
    t.includes('follow up') ||
    t.includes('linkedin')
  );
}

// ── buildDueAt ───────────────────────────────────────────────────────────────
function buildDueAt(dueOffsetDays) {
  const days = parseInt(dueOffsetDays) || 3;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// ── firePlaybookPlays ────────────────────────────────────────────────────────
// Core method — fires plays for an entity when it enters a stage.
// Creates play instance rows only (not actions — ActionWriter handles that).
//
// params: {
//   orgId        {number}
//   playbookId   {number}
//   stageKey     {string}
//   entityType   {string}  — 'deal' | 'case' | 'contract' | 'prospect' | 'handover'
//   entityId     {number}
//   context      {object}
//   assignedTo   {number|null}
// }
//
// returns: { fired: number, skipped: number }
async function firePlaybookPlays({ orgId, playbookId, stageKey, entityType, entityId, context = {}, assignedTo = null }) {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) throw new Error(`Unknown entityType: ${entityType}`);

  const playsResult = await db.query(
    `SELECT pp.id, pp.title, pp.description, pp.channel,
            pp.fire_conditions, pp.due_offset_days,
            pp.execution_type, pp.is_gate, pp.is_active,
            pp.priority, pp.sort_order, pp.suggested_action
     FROM playbook_plays pp
     WHERE pp.playbook_id = $1
       AND pp.stage_key   = $2
       AND pp.is_active   = true
     ORDER BY pp.sort_order ASC`,
    [playbookId, stageKey]
  );

  const plays = playsResult.rows;
  if (plays.length === 0) return { fired: 0, skipped: 0 };

  // Get playbook name for stamping
  const pbRow = await db.query('SELECT name FROM playbooks WHERE id = $1', [playbookId]);
  const playbookName = pbRow.rows[0]?.name || null;

  let fired = 0;
  let skipped = 0;

  for (const play of plays) {
    const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
    if (!evaluateConditions(conditions, context)) { skipped++; continue; }

    const dueAt = buildDueAt(play.due_offset_days);

    try {
      if (entityType === 'prospect') {
        // prospecting_actions serves as both instance + action for prospects
        await db.query(
          `INSERT INTO prospecting_actions
             (org_id, user_id, prospect_id, playbook_id, play_id, title, description,
              action_type, channel, priority, due_date, source, source_rule,
              playbook_name, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'playbook_play', $8, $9, $10,
                   'playbook', 'playbook_play', $11, 'pending')
           ON CONFLICT DO NOTHING`,
          [orgId, assignedTo, entityId, playbookId, play.id,
           play.title, play.description || null, play.channel || null,
           play.priority || 'medium', dueAt, playbookName]
        );
      } else if (entityType === 'case') {
        // case_plays — now has full instance shape after migration
        await db.query(
          `INSERT INTO case_plays
             (org_id, case_id, play_id, title, description, channel,
              priority, execution_type, is_gate, due_date, sort_order,
              stage_key, assigned_to, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
           ON CONFLICT (case_id, play_id) DO NOTHING`,
          [orgId, entityId, play.id, play.title, play.description || null,
           play.channel || null, play.priority || 'medium',
           play.execution_type || 'parallel', play.is_gate || false,
           dueAt, play.sort_order || 0, stageKey, assignedTo]
        );
      } else if (entityType === 'contract') {
        // contract_play_instances
        await db.query(
          `INSERT INTO contract_play_instances
             (org_id, contract_id, play_id, stage_key, title, description, channel,
              priority, execution_type, is_gate, due_date, sort_order, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
           ON CONFLICT (contract_id, play_id) DO NOTHING`,
          [orgId, entityId, play.id, stageKey, play.title, play.description || null,
           play.channel || null, play.priority || 'medium',
           play.execution_type || 'parallel', play.is_gate || false,
           dueAt, play.sort_order || 0]
        );
      } else {
        // deal / handover → deal_play_instances
        await db.query(
          `INSERT INTO deal_play_instances
             (org_id, deal_id, play_id, stage_key, title, description, channel,
              priority, execution_type, is_gate, due_date, sort_order, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
           ON CONFLICT (deal_id, play_id) DO NOTHING`,
          [orgId, entityId, play.id, stageKey, play.title, play.description || null,
           play.channel || null, play.priority || 'medium',
           play.execution_type || 'parallel', play.is_gate || false,
           dueAt, play.sort_order || 0]
        );
      }
      fired++;
    } catch (err) {
      console.error(`[playbookService] Failed to fire play ${play.id} for ${entityType} ${entityId}:`, err.message);
    }
  }

  return { fired, skipped };
}

// ── fireForEntity ────────────────────────────────────────────────────────────
// Convenience wrapper — resolves the playbook automatically from the entity row.
async function fireForEntity({ orgId, playbookType, playbookId, stageKey, entityType, entityId, context = {}, assignedTo = null }) {
  try {
    const resolvedId = await resolvePlaybook(orgId, playbookId, playbookType);
    if (!resolvedId) {
      console.warn(`[playbookService] No playbook found for type=${playbookType} org=${orgId} — skipping play fire`);
      return { fired: 0, skipped: 0 };
    }
    return await firePlaybookPlays({ orgId, playbookId: resolvedId, stageKey, entityType, entityId, context, assignedTo });
  } catch (err) {
    console.error(`[playbookService] fireForEntity error (${entityType} ${entityId}):`, err.message);
    return { fired: 0, skipped: 0 };
  }
}

module.exports = {
  // Channel map — single source of truth
  CHANNEL_MAP,
  resolveChannel,
  resolveProspectChannel,
  // Playbook resolution
  getPlaybook,
  getPlaybookById,
  getDefaultPlaybookForEntity,
  getStagesForPlaybook,
  getPlaysForStage,
  getStageActions,
  getStageGuidance,
  upsertStageGuidance,
  firePlaybookPlays,
  fireForEntity,
  evaluateConditions,
  extractKeywords,
  requiresExternalEvidence,
};
