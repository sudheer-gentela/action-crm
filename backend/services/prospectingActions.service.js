/**
 * prospectingActions.service.js
 *
 * Generates prospecting actions from a playbook's plays for a prospect.
 * Called manually ("Generate Actions" button) or after stage changes.
 *
 * PHASE 4 ADDITION:
 *   - Added `runNightlySweep(orgId)` — iterates all active prospects for an
 *     org, runs ProspectDiagnosticsEngine for each, writes Type A diagnostic
 *     alerts to prospecting_actions with upsert + resolve semantics.
 *   - Resolves diagnostics for prospects that move to terminal stages.
 *
 * PHASE 6 ADDITION:
 *   - Added `completeProspectingAction(actionId, prospectId, orgId, userId, opts)`
 *     — canonical completion writer that hooks PlayCompletionService for
 *     next-play chaining on playbook_play rows.
 *
 * PHASE 7 ADDITION:
 *   - Added `generateForProspectEvent(prospectId, orgId, userId, eventType)`
 *     — ad-hoc diagnostic re-run for a single prospect triggered by a discrete
 *     real-time event (email reply received, meeting booked, etc.).
 *
 * FIXED IN THIS VERSION:
 *   - Now uses playbook_plays rows (the structured plays defined in the
 *     playbook editor) instead of stage_guidance.key_actions text labels.
 *   - Falls back to stage_guidance.key_actions only if no playbook_plays
 *     exist for the stage (backward compatibility).
 *   - Stamps playbook_id, play_id, and playbook_name on each inserted row.
 *   - source_rule column now populated (added by migration).
 *
 * Flow (generateForProspect):
 *   1. Load prospect → get current stage + playbook_id
 *   2. Try playbook_plays for this stage first
 *   3. Fallback: load stage_guidance[currentStage].key_actions
 *   4. Load existing actions → deduplicate
 *   5. Insert pending actions for anything not already present
 *
 * Flow (runNightlySweep):
 *   1. Load all active prospects for org
 *   2. For each: run ProspectDiagnosticsEngine.runForProspect()
 *   3. Log summary
 *
 * Flow (generateForProspectEvent):
 *   1. Load prospect — skip terminal stages
 *   2. Run ProspectDiagnosticsEngine.runForProspect() for this one prospect
 *   3. Log result
 */

const db                      = require('../config/database');
const PlaybookService         = require('./playbook.service');
const { resolveProspectChannel } = PlaybookService;
const { resolveForPlay }      = require('./PlayRouteResolver');
const ProspectDiagnosticsEngine = require('./ProspectDiagnosticsEngine');
const PlayCompletionService   = require('./PlayCompletionService');  // Phase 6

// Terminal stages — skip diagnostic sweep for these
const TERMINAL_STAGES = new Set(['converted', 'disqualified', 'archived']);

// ═════════════════════════════════════════════════════════════════════════════
// generateForProspect — main entry point (unchanged from pre-Phase 4)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {number} prospectId
 * @param {number} orgId
 * @param {number} userId
 * @returns {{ created: number, skipped: number, actions: object[], source: string }}
 */
async function generateForProspect(prospectId, orgId, userId) {
  // 1. Load prospect
  const prospectRes = await db.query(
    'SELECT * FROM prospects WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL',
    [prospectId, orgId]
  );
  if (prospectRes.rows.length === 0) throw new Error('Prospect not found');
  const prospect = prospectRes.rows[0];

  if (!prospect.playbook_id) {
    throw new Error('No playbook assigned to this prospect. Assign a playbook first.');
  }

  // 2. Load playbook
  const pbRes = await db.query(
    'SELECT * FROM playbooks WHERE id = $1 AND org_id = $2',
    [prospect.playbook_id, orgId]
  );
  if (pbRes.rows.length === 0) throw new Error('Assigned playbook not found');
  const playbook = pbRes.rows[0];
  const playbookName = playbook.name;

  // 3. Load existing actions for deduplication
  const existingRes = await db.query(
    `SELECT action_type, channel, title, play_id, status
     FROM prospecting_actions
     WHERE prospect_id = $1 AND org_id = $2 AND status != 'skipped'`,
    [prospectId, orgId]
  );
  const existingPlayIds = new Set(existingRes.rows.filter(a => a.play_id).map(a => a.play_id));
  const existingKeys    = new Set(existingRes.rows.map(a => a.title.toLowerCase()));

  // 4. Try playbook_plays rows first — on_demand plays only
  const playsResult = await PlaybookService.getPlaysForStage(orgId, prospect.playbook_id, prospect.stage, 'on_demand');

  if (playsResult.length === 0) {
    return {
      created: 0, skipped: 0, actions: [],
      source:  'none',
      message: `No plays defined for stage "${prospect.stage}" in this playbook. Add plays in the Playbook editor.`,
    };
  }

  return await _generateFromPlays(
    prospect, orgId, userId, playsResult,
    playbook, playbookName, existingPlayIds, existingKeys
  );
}

// ── Path A: generate from playbook_plays rows ─────────────────────────────────

async function _generateFromPlays(prospect, orgId, userId, plays, playbook, playbookName, existingPlayIds, existingKeys) {
  const created = [];
  let skipped   = 0;

  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];

    // Skip if already have an action from this exact play
    if (existingPlayIds.has(play.id)) { skipped++; continue; }
    // Also title-dedup as safety net
    if (existingKeys.has(play.title.toLowerCase())) { skipped++; continue; }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (parseInt(play.due_offset_days) || 3));

    const channel = resolveProspectChannel(play.channel);

    // Resolve assignee — uses play roles if present, otherwise falls back to caller
    const playRoles = Array.isArray(play.roles) ? play.roles : [];
    const primaryRole = playRoles.find(r => r.ownership_type === 'owner') || playRoles[0] || null;
    const assigneeIds = await resolveForPlay({
      orgId,
      roleKey:      primaryRole?.role_key  || null,
      roleId:       primaryRole?.role_id   || null,
      entity:       prospect,
      entityType:   'prospect',
      callerUserId: userId,
    });
    const assigneeUserId = assigneeIds[0] || userId;

    const result = await db.query(
      `INSERT INTO prospecting_actions (
         org_id, user_id, prospect_id,
         title, description,
         action_type, channel,
         priority, due_date,
         source, source_rule,
         suggested_action,
         playbook_id, play_id, playbook_name,
         sequence_step, status
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         'playbook_play', $6,
         $7, $8,
         'playbook', 'playbook_play',
         $9,
         $10, $11, $12,
         $13, 'pending'
       )
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        orgId, assigneeUserId, prospect.id,
        play.title, play.description || null,
        channel,
        play.priority || 'medium', dueDate,
        play.suggested_action || null,
        playbook.id, play.id, playbookName,
        i + 1,
      ]
    );

    if (result.rows[0]) {
      created.push(result.rows[0]);
      existingPlayIds.add(play.id);
      existingKeys.add(play.title.toLowerCase());
    }
  }

  // Log activity
  if (created.length > 0) {
    await db.query(
      `INSERT INTO prospecting_activities (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'actions_generated', $3, $4)`,
      [
        prospect.id, userId,
        `Generated ${created.length} action(s) from playbook plays "${playbookName}" for stage "${prospect.stage}"`,
        JSON.stringify({ playbookId: playbook.id, stage: prospect.stage, actionCount: created.length, skipped, source: 'playbook_plays' }),
      ]
    ).catch(() => {});
  }

  return { created: created.length, skipped, actions: created, source: 'playbook_plays' };
}

// ═════════════════════════════════════════════════════════════════════════════
// runNightlySweep — Phase 4 addition
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Nightly diagnostic sweep for all active prospects in an org.
 *
 * For each prospect:
 *   - Runs ProspectDiagnosticsEngine (builds context + identifies hurdles)
 *   - Upserts matching diagnostic alerts (Type A) to prospecting_actions
 *   - Resolves alerts whose condition has cleared
 *
 * Terminal-stage prospects (converted/disqualified/archived) are skipped
 * by ProspectDiagnosticsEngine — this query also pre-filters them for
 * efficiency so we don't build context unnecessarily.
 *
 * The system user id is resolved by looking up the org owner / first admin.
 * Diagnostic rows are written under this user. If no admin is found,
 * falls back to userId = null (prospecting_actions.user_id is nullable).
 *
 * Cron: 02:15 UTC daily (registered in syncScheduler.js)
 *
 * @param {number} orgId
 * @returns {{ processed: number, upserted: number, resolved: number, errors: number }}
 */
async function runNightlySweep(orgId) {
  const startTime = Date.now();
  console.log(`[ProspectingNightlySweep] Starting for org ${orgId}`);

  // Resolve a system user id for this org (used as user_id on written rows)
  const systemUserId = await _resolveSystemUser(orgId);

  // Load all active prospects for this org — skip terminal stages at query level
  const prospectsRes = await db.query(
    `SELECT id, stage
     FROM prospects
     WHERE org_id = $1
       AND deleted_at IS NULL
       AND stage NOT IN ('converted', 'disqualified', 'archived')
     ORDER BY id ASC`,
    [orgId]
  );

  const prospects = prospectsRes.rows;
  console.log(`[ProspectingNightlySweep] org=${orgId} prospects_to_scan=${prospects.length}`);

  let totalUpserted = 0;
  let totalResolved = 0;
  let totalErrors   = 0;

  for (const { id: prospectId } of prospects) {
    try {
      const result = await ProspectDiagnosticsEngine.runForProspect(
        prospectId, orgId, systemUserId
      );

      if (!result.skipped) {
        totalUpserted += result.upserted;
        totalResolved += result.resolved;
      }
    } catch (err) {
      totalErrors++;
      console.error(
        `[ProspectingNightlySweep] org=${orgId} prospect=${prospectId} error:`,
        err.message
      );
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[ProspectingNightlySweep] org=${orgId} done in ${duration}s — ` +
    `processed=${prospects.length} upserted=${totalUpserted} resolved=${totalResolved} errors=${totalErrors}`
  );

  return {
    processed: prospects.length,
    upserted:  totalUpserted,
    resolved:  totalResolved,
    errors:    totalErrors,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a system/admin user id for this org.
 * Used as the `user_id` on auto-generated diagnostic action rows.
 * Falls back to null if no user found (column is nullable).
 */
async function _resolveSystemUser(orgId) {
  try {
    const r = await db.query(
      `SELECT user_id FROM org_users
       WHERE org_id = $1 AND role IN ('owner', 'admin')
       ORDER BY
         CASE role WHEN 'owner' THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 1`,
      [orgId]
    );
    return r.rows[0]?.user_id || null;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// completeProspectingAction — Phase 6 addition
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mark a prospecting action as completed and fire the next sequential play.
 *
 * This is the canonical completion writer for prospecting_actions rows.
 * Routes should call this instead of writing status = 'completed' directly,
 * so that next-play chaining always fires.
 *
 * For rows that are NOT playbook plays (source = 'auto_generated' or
 * source = 'strap'), next-play logic is skipped automatically because
 * play_id will be null.
 *
 * @param {number} actionId
 * @param {number} prospectId
 * @param {number} orgId
 * @param {number} userId      — user completing the action
 * @param {object} [opts]
 * @param {string} [opts.outcome]   — optional outcome note
 * @returns {Promise<object>}  updated prospecting_action row
 */
async function completeProspectingAction(actionId, prospectId, orgId, userId, { outcome } = {}) {
  const result = await db.query(
    `UPDATE prospecting_actions
     SET status       = 'completed',
         completed_at = NOW(),
         completed_by = $1,
         outcome      = COALESCE($2, outcome),
         updated_at   = NOW()
     WHERE id = $3 AND prospect_id = $4 AND org_id = $5
     RETURNING *`,
    [userId, outcome || null, actionId, prospectId, orgId]
  );

  if (!result.rows.length) {
    throw Object.assign(new Error('Prospecting action not found'), { status: 404 });
  }

  const action = result.rows[0];

  // Phase 6 — fire next sequential play if this action was a playbook play.
  // Non-blocking: next-play failure must not disrupt the completion response.
  if (action.play_id) {
    PlayCompletionService.fireNextPlay('prospect', prospectId, action.play_id, orgId, userId)
      .catch(err => console.error(
        `[prospectingActions] next-play hook failed for prospect ${prospectId} play ${action.play_id}:`,
        err.message
      ));
  }

  return action;
}

// ═════════════════════════════════════════════════════════════════════════════
// generateForProspectEvent — Phase 7 addition
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Ad-hoc diagnostic re-run for a single prospect triggered by a discrete
 * real-time event. Delegates to ProspectDiagnosticsEngine.runForProspect()
 * — the same engine used by the nightly sweep — so results are always
 * consistent.
 *
 * Unlike the nightly sweep this function accepts a userId parameter.
 * It is used as the fallback writer user when the engine needs to attribute
 * newly created diagnostic rows. Typically this is the user who caused the
 * event (replied to an email, booked a meeting). Falls back to the org system
 * user if null is passed.
 *
 * Supported eventType values (informational — logged only, not branched on):
 *   'email_reply_received'  — inbound email reply from prospect synced
 *   'meeting_booked'        — meeting created and linked to this prospect
 *   'meeting_completed'     — meeting marked as happened
 *   'stage_changed'         — fallthrough for stage changes not handled by
 *                              generateForProspect (e.g. manual stage edits)
 *   'outreach_executed'     — outreach action completed (POST /:id/execute)
 *
 * Callers fire this non-blocking:
 *   generateForProspectEvent(prospectId, orgId, userId, 'email_reply_received')
 *     .catch(err => console.error('Prospect event trigger error:', err.message));
 *
 * Skips terminal prospects (converted / disqualified / archived) silently.
 * ProspectDiagnosticsEngine.runForProspect() also guards this, but we check
 * at query level to avoid an unnecessary engine call.
 *
 * @param {number} prospectId
 * @param {number} orgId
 * @param {number|null} userId   — user who triggered the event (may be null)
 * @param {string} eventType
 * @returns {Promise<{ upserted: number, resolved: number, skipped: boolean }>}
 */
async function generateForProspectEvent(prospectId, orgId, userId, eventType) {
  try {
    // Pre-check: skip terminal prospects without spinning up the engine
    const stageRes = await db.query(
      `SELECT stage FROM prospects
       WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [prospectId, orgId]
    );

    if (stageRes.rows.length === 0) {
      // Not found or deleted — silent skip
      return { upserted: 0, resolved: 0, skipped: true };
    }

    const { stage } = stageRes.rows[0];
    if (TERMINAL_STAGES.has(stage)) {
      return { upserted: 0, resolved: 0, skipped: true };
    }

    // Resolve effective userId — fall back to system user if caller passes null
    const effectiveUserId = userId ?? await _resolveSystemUser(orgId);

    console.log(
      `[ProspectEventTrigger] prospect=${prospectId} event=${eventType} ` +
      `org=${orgId} user=${effectiveUserId ?? 'system'}`
    );

    const result = await ProspectDiagnosticsEngine.runForProspect(
      prospectId, orgId, effectiveUserId
    );

    console.log(
      `[ProspectEventTrigger] prospect=${prospectId} event=${eventType} ` +
      `upserted=${result.upserted} resolved=${result.resolved} skipped=${result.skipped}`
    );

    return result;

  } catch (err) {
    console.error(
      `prospectingActions.generateForProspectEvent error ` +
      `(prospect=${prospectId} event=${eventType}):`,
      err.message
    );
    return { upserted: 0, resolved: 0, skipped: false };
  }
}

module.exports = {
  generateForProspect,
  runNightlySweep,
  completeProspectingAction,
  generateForProspectEvent,   // Phase 7
};
