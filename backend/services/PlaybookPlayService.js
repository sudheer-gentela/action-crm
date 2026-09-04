// ─────────────────────────────────────────────────────────────────────────────
// PlaybookPlayService.js
//
// Core service for role-based playbook plays:
//   - Activate plays when a deal enters a new stage
//   - Resolve role → person assignments from deal team
//   - Handle sequential dependencies
//   - Gate checking for stage advancement
//   - Complete / skip / reassign plays
//
// CHANGES (Phase A, 2026_70):
//   A5  — _createActionForPlay no longer collides on uq_actions_deal_source_rule.
//         It now sets playbook_play_id + source_module and upserts on
//         (deal_id, playbook_play_id), the index reserved for playbook tasks.
//         source_rule is left NULL (that index is reserved for Type-A diagnostic
//         alerts — see PlaybookActionGenerator.js). Errors are re-raised, not
//         swallowed, so a real failure is visible instead of silently NULLing
//         action_id.
//   B13 — activateStageForPlaybook now joins playbook_play_roles so role-based
//         assignment actually works for the handover path (previously SELECT pp.*
//         left play.roles undefined and every play fell through to deal.owner_id).
//   A5-containment (Q6, option a-plus) — _createActionForPlay RE-RAISES, which is
//         correct: a persistence helper must not decide policy, and swallowing is
//         what caused B10. Containment is therefore the CALLER's job and is applied
//         per play. One play failing to link can no longer abort the whole stage
//         activation, and the failure is surfaced in the returned `warnings` array
//         rather than vanishing. An instance left with action_id NULL is exactly
//         the state A9's backfill repairs, so it is recoverable, not corruption.
//         This is deliberately NOT silent swallowing — the difference from the
//         original bug is that every failure is both logged AND returned.
//   D20 — canonical status vocabulary throughout:
//         not_started | in_progress | blocked | snoozed | completed | skipped | cancelled
//         Play "active" (ready) → not_started; play "pending" (waiting) → blocked.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');
const { resolveForPlay } = require('./PlayRouteResolver');
const { evaluateConditions, PROJECT_EVALUABLE_CONDITIONS } = require('./playbook.service');

// Canonical statuses a play can hold while still "open" (not terminal).
const OPEN_PLAY_STATUSES = ['not_started', 'in_progress', 'blocked', 'snoozed'];

// ── Due-date anchoring (2026_64) ──────────────────────────────────────────────
// A play's due date is measured either forward from instantiation ('created',
// the default for every sales play) or backward from the handover's go-live
// date ('go_live', where due_offset_days is normally negative, e.g. -14 for
// "UAT sign-off two weeks before go-live"). go_live_date lives on
// sales_handovers and is usually still NULL when plays are first instantiated,
// so a go_live play is left unscheduled (due_date NULL) until the date is set,
// at which point the go-live trigger fills it in.
async function goLiveDateForDeal(dealId, orgId) {
  const r = await db.query(
    `SELECT to_char(go_live_date, 'YYYY-MM-DD') AS go_live_date
       FROM sales_handovers
      WHERE deal_id = $1 AND org_id = $2 AND go_live_date IS NOT NULL
      ORDER BY id
      LIMIT 1`,
    [dealId, orgId]
  );
  return r.rows[0]?.go_live_date ?? null; // 'YYYY-MM-DD' | null
}

function computeInstanceDueDate(anchor, offsetDays, goLiveStr, startedAtStr = null) {
  if (anchor === 'go_live') {
    if (!goLiveStr) return null; // unknown until go-live is set
    const [y, m, d] = goLiveStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(offsetDays) || 0)); // signed offset
    return dt.toISOString().split('T')[0];
  }
  // 2026_118: 'project_start' — offset from when the project actually
  // started, resolved on leaving draft.
  //
  // NULL until then, deliberately. The alternative (falling back to today)
  // is exactly the bug this anchor exists to fix: a project drafted in July
  // and started in September would open with every task already overdue
  // against dates that never meant anything. An empty DUE column is honest;
  // a wrong date is not.
  if (anchor === 'project_start') {
    if (!startedAtStr) return null;
    const [y, m, d] = startedAtStr.slice(0, 10).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(offsetDays) || 0));
    return dt.toISOString().split('T')[0];
  }
  // 'created' (default): forward from today — behaviour unchanged.
  const dt = new Date();
  dt.setDate(dt.getDate() + (offsetDays || 3));
  return dt.toISOString().split('T')[0];
}

class PlaybookPlayService {

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE ACTIVATION — create play instances when deal enters a stage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Activate all plays for a deal's new stage.
   *
   * @param {number} dealId
   * @param {string} stageKey    — the deal_stages.key being entered
   * @param {number} orgId
   * @param {number} userId      — who triggered the stage change
   * @returns {{ instances: Array, warnings: string[] }}
   */
  static async activateStage(dealId, stageKey, orgId, userId) {
    const warnings = [];

    // 1. Find the deal's playbook
    const dealRow = await db.query(
      `SELECT d.playbook_id, d.stage_changed_at, d.close_date, d.updated_at,
              d.owner_id,
              p.id AS pb_id
       FROM deals d
       LEFT JOIN playbooks p ON p.id = d.playbook_id
       WHERE d.id = $1 AND d.org_id = $2`,
      [dealId, orgId]
    );

    let playbookId = dealRow.rows[0]?.pb_id;
    const dealMeta  = dealRow.rows[0] || {};

    // Fallback to org default playbook
    if (!playbookId) {
      const def = await db.query(
        `SELECT id FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
        [orgId]
      );
      playbookId = def.rows[0]?.id;
    }

    if (!playbookId) {
      return { instances: [], warnings: ['No playbook found for this deal or org'] };
    }

    // 2. Get plays for this stage
    const playsResult = await db.query(
      `SELECT pp.*, 
              COALESCE(
                json_agg(json_build_object(
                  'role_id', ppr.role_id,
                  'role_name', dr.name,
                  'role_key', dr.key,
                  'ownership_type', ppr.ownership_type
                )) FILTER (WHERE ppr.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM playbook_plays pp
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN org_roles dr ON dr.id = ppr.role_id
       WHERE pp.playbook_id = $1 AND pp.stage_key = $2 AND pp.is_active = TRUE
         AND (pp.trigger_mode IS NULL OR pp.trigger_mode = 'stage_change')
       GROUP BY pp.id
       ORDER BY pp.sort_order ASC`,
      [playbookId, stageKey]
    );

    if (playsResult.rows.length === 0) {
      return { instances: [], warnings: ['No plays defined for stage: ' + stageKey] };
    }

    // 3. Get deal team members
    const teamResult = await db.query(
      `SELECT dtm.user_id, dtm.role_id, 
              u.first_name || ' ' || u.last_name AS name,
              dr.key AS role_key
       FROM deal_team_members dtm
       JOIN users u ON u.id = dtm.user_id
       LEFT JOIN org_roles dr ON dr.id = dtm.role_id
       WHERE dtm.deal_id = $1 AND dtm.org_id = $2`,
      [dealId, orgId]
    );

    const teamByRole = {};
    for (const tm of teamResult.rows) {
      if (tm.role_id) {
        if (!teamByRole[tm.role_id]) teamByRole[tm.role_id] = [];
        teamByRole[tm.role_id].push(tm);
      }
    }

    // 4. Check for existing instances (avoid duplicates)
    const existingResult = await db.query(
      `SELECT play_id FROM deal_play_instances
       WHERE deal_id = $1 AND stage_key = $2 AND play_id IS NOT NULL`,
      [dealId, stageKey]
    );
    const existingPlayIds = new Set(existingResult.rows.map(r => r.play_id));

    // 5. Build a map of play_id → instance_id for dependency resolution
    const playIdToInstanceId = {};
    const instances = [];

    // Also collect existing instance IDs for dependencies
    if (existingPlayIds.size > 0) {
      const existingInstances = await db.query(
        `SELECT id, play_id FROM deal_play_instances
         WHERE deal_id = $1 AND stage_key = $2 AND play_id IS NOT NULL`,
        [dealId, stageKey]
      );
      for (const ei of existingInstances.rows) {
        playIdToInstanceId[ei.play_id] = ei.id;
      }
    }

    // Resolve the handover's go-live date once (used by go_live-anchored plays).
    const goLiveDate = await goLiveDateForDeal(dealId, orgId);

    for (const play of playsResult.rows) {
      // Skip if already instantiated
      if (existingPlayIds.has(play.id)) continue;

      // Evaluate fire_conditions before instantiating
      const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
      if (conditions.length > 0) {
        const dealContext = {
          daysInStage: Math.floor(
            (Date.now() - new Date(dealMeta.stage_changed_at || dealMeta.updated_at)) / 86400000
          ),
          daysUntilClose: dealMeta.close_date
            ? Math.ceil((new Date(dealMeta.close_date) - Date.now()) / 86400000)
            : 999,
        };
        if (!evaluateConditions(conditions, dealContext)) continue;
      }

      const roles = typeof play.roles === 'string' ? JSON.parse(play.roles) : play.roles;

      // A7 / 2026_73b. The OWNER role drives assignment — exactly one action goes
      // to its holder. Co-owner roles are REASSIGNMENT TARGETS: recorded on the
      // instance so the UI can offer them, but not given work at creation.
      //
      // The `|| coOwnerRoles[0]` fallback matters: 2026_73b promotes one role per
      // play to 'owner', but a play created through the builder before the UI
      // supports designating an owner still arrives all-co_owner. Without the
      // fallback such a play would silently produce zero assignees — which is
      // exactly what happened between 73b landing and this code deploying.
      const ownerRole    = roles.find(r => r.ownership_type === 'owner') || null;
      const coOwnerRoles = roles.filter(r => r.ownership_type === 'co_owner');
      const assigningRole = ownerRole || coOwnerRoles[0] || null;

      // Determine initial status.
      // 'not_started' = ready to work; 'blocked' = waiting on sequential deps.
      let initialStatus = 'not_started';
      if (play.execution_type === 'sequential' && play.depends_on && play.depends_on.length > 0) {
        const allDepsComplete = await this._areDependenciesComplete(dealId, play.depends_on);
        if (!allDepsComplete) {
          initialStatus = 'blocked';
        }
      }

      // Due date, honouring the play's anchor (2026_64). 'created' → forward
      // from today (unchanged); 'go_live' → backward from go-live once known,
      // else NULL until the go-live trigger schedules it.
      const anchor  = play.due_anchor || 'created';
      const dueDate = computeInstanceDueDate(anchor, play.due_offset_days, goLiveDate, null);   // deal path: project_start is a project-only anchor

      // Create instance
      const instResult = await db.query(
        `INSERT INTO deal_play_instances (
           deal_id, org_id, play_id, stage_key,
           title, description, channel, priority,
           execution_type, is_gate, due_date, sort_order,
           status, due_anchor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          dealId, orgId, play.id, stageKey,
          play.title, play.description, play.channel, play.priority,
          play.execution_type, play.is_gate, dueDate,
          play.sort_order, initialStatus, anchor
        ]
      );

      const instance = instResult.rows[0];
      playIdToInstanceId[play.id] = instance.id;

      // Resolve the single accountable assignee from the owner role, recording
      // WHICH tier produced them so an unfilled role is visible rather than
      // looking like a deliberate choice (actions.assignment_source, 2026_73a).
      const assignees = [];
      let assignmentSource = null;
      const intendedRoleId = assigningRole ? assigningRole.role_id : null;

      if (assigningRole) {
        const members = teamByRole[assigningRole.role_id] || [];

        if (members.length > 0) {
          // Tier 1 — a project-team member holds the role.
          const member = members[0];
          try {
            await db.query(
              `INSERT INTO deal_play_assignees (instance_id, user_id, role_id, assigned_by)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (instance_id, user_id) DO NOTHING`,
              [instance.id, member.user_id, member.role_id, userId]
            );
            assignees.push({ userId: member.user_id, name: member.name, roleKey: member.role_key });
            assignmentSource = 'role_holder';
          } catch (err) {
            console.error('Failed to assign play:', err.message);
          }
        } else {
          // Tiers 2 and 3 — org team queue, then the deal owner. owner_id is now
          // passed through; previously only { id: dealId } was sent, so
          // _entityOwner() returned undefined and tier 3 could never fire here.
          const resolvedIds = await resolveForPlay({
            orgId,
            roleKey:      assigningRole.role_key || null,
            roleId:       assigningRole.role_id  || null,
            entity:       { id: dealId, owner_id: dealMeta.owner_id },
            entityType:   'deal',
            callerUserId: userId,
          });

          for (const resolvedId of resolvedIds) {
            if (resolvedId === userId && resolvedIds.length > 1) continue; // prefer non-caller
            try {
              await db.query(
                `INSERT INTO deal_play_assignees (instance_id, user_id, role_id, assigned_by)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (instance_id, user_id) DO NOTHING`,
                [instance.id, resolvedId, assigningRole.role_id, userId]
              );
              assignees.push({ userId: resolvedId, name: '', roleKey: assigningRole.role_key });
              // Distinguishing tier 2 from tier 3 without changing the shared
              // resolver's contract: landing on the deal owner means no role
              // holder was found anywhere.
              assignmentSource = (resolvedId === dealMeta.owner_id) ? 'project_owner' : 'team_queue';
            } catch (err) {
              console.error('Failed to assign play (resolver fallback):', err.message);
            }
            break;
          }

          if (assignees.length === 0) {
            warnings.push(`Nobody holds role "${assigningRole.role_name}" for play "${play.title}" and no fallback resolved — play left unassigned`);
          } else if (assignmentSource === 'project_owner') {
            warnings.push(`Nobody holds role "${assigningRole.role_name}" — play "${play.title}" assigned to the deal owner`);
          }
        }
      } else {
        warnings.push(`Play "${play.title}" has no role assigned — cannot route it`);
      }

      // Create action row if instance is ready to work.
      // Contained per play: _createActionForPlay re-raises, and we catch here so a
      // single failure cannot strand the rest of the stage. Surfaced, never silent.
      let actionId = null;
      if (initialStatus === 'not_started' && assignees.length > 0) {
        try {
          actionId = await this._createActionForPlay(
            instance, assignees[0], orgId, 'deals',
            { intendedRoleId, assignmentSource }
          );
          if (actionId) {
            await db.query(
              `UPDATE deal_play_instances SET action_id = $1 WHERE id = $2`,
              [actionId, instance.id]
            );
          }
        } catch (err) {
          warnings.push(
            `Play "${play.title}" was created but could not be linked to an action: ${err.message}`
          );
          console.error(
            `[PlaybookPlayService] action link failed for instance ${instance.id} (play ${play.id}):`,
            err.message
          );
        }
      }

      instances.push({
        ...instance,
        action_id: actionId,
        assignees,
        owner_role: ownerRole,
        // Reassignment targets for this play, per A7 — the UI offers these when
        // the assignee or their manager needs to move the work.
        co_owner_roles: coOwnerRoles,
        assignment_source: assignmentSource,
        intended_role_id: intendedRoleId,
      });
    }

    return { instances, warnings };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE ACTIVATION FOR SPECIFIC PLAYBOOK (handover variant)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Activate plays from a specific playbook (by explicit playbookId) rather
   * than looking up the deal's assigned playbook.
   *
   * Used by HandoverService to fire the handover_s2i playbook independently
   * of whatever sales playbook the deal has assigned.
   *
   * B13 fix: this now joins playbook_play_roles (as activateStage does) so
   * role-based assignment works. It still falls back to the deal owner when a
   * play has no role or no role holder resolves — which is the correct default
   * for handover work that hasn't had implementation roles configured yet.
   *
   * @param {number} dealId
   * @param {string} stageKey
   * @param {number} orgId
   * @param {number} userId
   * @param {number} playbookId  — explicit playbook to activate plays from
   * @returns {{ instances: Array, warnings: string[] }}
   */
  /**
   * Activate a playbook stage on a PROJECT that has no deal (2026_89).
   *
   * Sibling of activateStageForPlaybook(). Deliberately a separate method
   * rather than a refactor of that one: the deal path is what fires on every
   * won deal in production, and reshaping it to take a polymorphic context in
   * the same change that introduces project plays would put both at risk at
   * once. The duplication is real and should be collapsed once the project path
   * has run in anger — noting it here so it is a decision, not an oversight.
   *
   * Differences from the deal path:
   *   • existing-instance lookup keys on handover_id, not deal_id
   *   • entity context is the handover; there is no deal owner, so ownership
   *     falls back to the service owner and then the caller
   *   • go-live comes off the handover directly instead of via the deal
   *   • fire_conditions that reference deal fields cannot be evaluated, so
   *     plays carrying them are skipped and reported rather than fired blind
   */
  static async activateStageForProject(handoverId, stageKey, orgId, userId, playbookId) {
    const warnings = [];

    const playsResult = await db.query(
      `SELECT pp.*,
              COALESCE(
                json_agg(json_build_object(
                  'role_id', ppr.role_id,
                  'role_name', dr.name,
                  'role_key', dr.key,
                  'ownership_type', ppr.ownership_type
                )) FILTER (WHERE ppr.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM playbook_plays pp
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN org_roles dr ON dr.id = ppr.role_id
       WHERE pp.playbook_id = $1 AND pp.stage_key = $2 AND pp.is_active = TRUE
         AND (pp.trigger_mode IS NULL OR pp.trigger_mode = 'stage_change')
       GROUP BY pp.id
       ORDER BY pp.sort_order ASC`,
      [playbookId, stageKey]
    );

    if (playsResult.rows.length === 0) {
      return { instances: [], warnings: [`No plays defined in playbook ${playbookId} for stage: ${stageKey}`] };
    }

    const existingResult = await db.query(
      `SELECT ppi.play_id FROM project_play_instances ppi
       JOIN playbook_plays pp ON pp.id = ppi.play_id
       WHERE ppi.handover_id = $1 AND ppi.stage_key = $2 AND pp.playbook_id = $3`,
      [handoverId, stageKey, playbookId]
    );
    const existingPlayIds = new Set(existingResult.rows.map(r => r.play_id));

    const { rows: [handover] } = await db.query(
      `SELECT id, org_id, assigned_service_owner_id, go_live_date, created_by,
              project_kind, budget,
              -- started_at and baseline_frozen_at are BOTH required below.
              -- started_at anchors project_start-anchored due dates;
              -- baseline_frozen_at decides whether a new play is born with a
              -- committed baseline. Omitting either makes the column silently
              -- undefined, and a play then looks provisional on a live project.
              started_at, baseline_frozen_at
         FROM sales_handovers WHERE id = $1 AND org_id = $2`,
      [handoverId, orgId]
    );
    if (!handover) {
      throw Object.assign(new Error('Project not found'), { status: 404 });
    }

    // Only fetch file names if some play in this stage actually uses
    // no_file_matching — most stages don't, and this saves a query per
    // activation.
    const needsFileNames = playsResult.rows.some(p =>
      Array.isArray(p.fire_conditions) &&
      p.fire_conditions.some(c => c && c.type === 'no_file_matching')
    );
    let projectFileNames = [];
    if (needsFileNames) {
      const { rows: fileRows } = await db.query(
        `SELECT file_name FROM storage_files
          WHERE handover_id = $1 AND org_id = $2 AND file_name IS NOT NULL`,
        [handoverId, orgId]
      );
      projectFileNames = fileRows.map(r => r.file_name);
    }

    const goLiveDate = handover.go_live_date
      ? new Date(handover.go_live_date).toISOString().slice(0, 10)
      : null;
    // 2026_118: NULL while the project is still in draft, which leaves
    // project_start-anchored plays undated until Start.
    const startedAt = handover.started_at
      ? new Date(handover.started_at).toISOString().slice(0, 10)
      : null;

    // Context for fire_conditions. Deliberately narrow — it carries only what
    // a project can truthfully answer. daysInStage is absent because
    // sales_handovers has no stage-change timestamp; supplying updated_at
    // would look right and be wrong, since it moves on any edit.
    const projectContext = {
      daysUntilGoLive: goLiveDate
        ? Math.ceil((new Date(goLiveDate + 'T00:00:00Z') - Date.now()) / 86400000)
        : null,
      projectKind: handover.project_kind || 'customer',
      budget:      handover.budget ?? null,
      fileNames:   projectFileNames,
    };

    const instances = [];

    for (const play of playsResult.rows) {
      if (existingPlayIds.has(play.id)) continue;

      // Evaluate fire_conditions against the PROJECT, not a deal.
      //
      // Previously every play carrying any condition was skipped outright,
      // because conditions were assumed to be deal-only. Most are, but a
      // delivery playbook legitimately wants project ones — "escalate if
      // commissioning is not done 14 days before go-live". Those are now
      // evaluated; conditions that genuinely need a deal are reported BY NAME
      // and the play is skipped, rather than the whole play being dropped for
      // an unnamed reason.
      const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
      if (conditions.length > 0) {
        const inapplicable = conditions
          .map(c => c && c.type)
          .filter(t => t && !PROJECT_EVALUABLE_CONDITIONS.has(t));

        if (inapplicable.length > 0) {
          warnings.push(
            `Play "${play.title}" skipped: condition(s) ${[...new Set(inapplicable)].join(', ')} ` +
            'cannot be evaluated for a project (they need a deal, case or contract)'
          );
          continue;
        }

        if (!evaluateConditions(conditions, projectContext)) continue;
      }

      let initialStatus = 'not_started';
      if (play.execution_type === 'sequential' && play.depends_on && play.depends_on.length > 0) {
        initialStatus = 'blocked';
      }

      const anchor  = play.due_anchor || 'created';
      const dueDate = computeInstanceDueDate(anchor, play.due_offset_days, goLiveDate, startedAt);

      // BASELINE AT INSERT.
      //
      // Previously omitted from this column list entirely, so every play was
      // born with baseline_due_date = NULL and baseline_source = NULL. That is
      // correct while the project is in draft — the plan is provisional and
      // freezePlanOnStart will promote it at Start. It is WRONG when the
      // project is already frozen, because nothing runs after that point:
      // planVariance then reports isAdHoc = true and no variance at all, so a
      // project could show a full plan and a completely empty plan-vs-actual.
      // Adding a playbook to a running project hit this every time.
      //
      // 'original' rather than 'inferred': the project is live, this date is
      // the plan as of now, and it is being recorded at the moment of creation
      // rather than reconstructed after the fact.
      //
      // No due_date means no baseline, matching 2026_111 — an unscheduled play
      // given a baseline invents a plan that never existed.
      const frozen = !!handover.baseline_frozen_at;
      const baselineDue    = (frozen && dueDate) ? dueDate : null;
      const baselineSource = baselineDue ? 'original' : null;

      const instResult = await db.query(
        `INSERT INTO project_play_instances (
           handover_id, org_id, play_id, stage_key,
           title, description, channel, priority,
           execution_type, is_gate, due_date, sort_order,
           status, due_anchor, playbook_id,
           baseline_due_date, baseline_source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          handoverId, orgId, play.id, stageKey,
          play.title, play.description, play.channel, play.priority,
          play.execution_type, play.is_gate, dueDate,
          play.sort_order, initialStatus, anchor, playbookId,
          baselineDue, baselineSource,
        ]
      );
      const instance = instResult.rows[0];

      // sales_handover_plays is no longer written. project_play_instances
      // .handover_id is the single link, and the link table is retained
      // only as the rollback path for 2026_109. Writing both would let the
      // two disagree, which is the ambiguity the split removed.

      const plays_roles = Array.isArray(play.roles)
        ? play.roles
        : (play.roles ? (typeof play.roles === 'string' ? JSON.parse(play.roles) : play.roles) : []);

      const primaryRole = plays_roles.find(r => r.ownership_type === 'owner')
        || plays_roles.find(r => r.ownership_type === 'co_owner')
        || plays_roles[0]
        || null;

      const assignedUserIds = await resolveForPlay({
        orgId,
        roleKey:      primaryRole?.role_key || null,
        roleId:       primaryRole?.role_id  || null,
        // No deal owner exists, so the service owner stands in as the entity's
        // owner for role resolution.
        entity:       { id: handover.id, owner_id: handover.assigned_service_owner_id, org_id: orgId },
        entityType:   'handover',
        callerUserId: userId,
      });
      const assignedUserId = assignedUserIds[0]
        || handover.assigned_service_owner_id
        || userId;
      const assignee = assignedUserId ? { userId: assignedUserId } : null;

      // Contained per play, matching the deal path: one play failing to produce
      // an action must not abort the whole stage, and the failure is returned
      // rather than swallowed.
      let actionId = null;
      if (initialStatus === 'not_started' && assignee) {
        try {
          actionId = await this._createActionForPlay(
            instance, assignee, orgId, 'handovers',
            {
              intendedRoleId:   primaryRole ? primaryRole.role_id : null,
              assignmentSource: assignedUserIds.length === 0 ? 'project_owner' : 'role_holder',
            }
          );
          if (actionId) {
            await db.query('UPDATE project_play_instances SET action_id = $1 WHERE id = $2',
              [actionId, instance.id]);
          }
        } catch (err) {
          warnings.push(`Play "${play.title}" created but its action failed: ${err.message}`);
        }
      }

      instances.push({ ...instance, action_id: actionId });
    }

    return { instances, warnings };
  }

  static async activateStageForPlaybook(dealId, stageKey, orgId, userId, playbookId) {
    const warnings = [];

    // Get plays for this stage from the specific playbook, WITH roles (B13).
    const playsResult = await db.query(
      `SELECT pp.*,
              COALESCE(
                json_agg(json_build_object(
                  'role_id', ppr.role_id,
                  'role_name', dr.name,
                  'role_key', dr.key,
                  'ownership_type', ppr.ownership_type
                )) FILTER (WHERE ppr.id IS NOT NULL),
                '[]'
              ) AS roles
       FROM playbook_plays pp
       LEFT JOIN playbook_play_roles ppr ON ppr.play_id = pp.id
       LEFT JOIN org_roles dr ON dr.id = ppr.role_id
       WHERE pp.playbook_id = $1 AND pp.stage_key = $2 AND pp.is_active = TRUE
         AND (pp.trigger_mode IS NULL OR pp.trigger_mode = 'stage_change')
       GROUP BY pp.id
       ORDER BY pp.sort_order ASC`,
      [playbookId, stageKey]
    );

    if (playsResult.rows.length === 0) {
      return { instances: [], warnings: [`No plays defined in playbook ${playbookId} for stage: ${stageKey}`] };
    }

    // Check for existing instances from this playbook (avoid duplicates)
    const existingResult = await db.query(
      `SELECT dpi.play_id FROM deal_play_instances dpi
       JOIN playbook_plays pp ON pp.id = dpi.play_id
       WHERE dpi.deal_id = $1 AND dpi.stage_key = $2 AND pp.playbook_id = $3`,
      [dealId, stageKey, playbookId]
    );
    const existingPlayIds = new Set(existingResult.rows.map(r => r.play_id));

    // Get the deal for entity context (owner + fire_conditions + other fields)
    const dealResult = await db.query(
      `SELECT d.id, d.owner_id, d.account_id, d.org_id,
              d.stage_changed_at, d.close_date, d.updated_at
       FROM deals d WHERE d.id = $1`,
      [dealId]
    );
    const deal = dealResult.rows[0] || null;

    const instances = [];

    // Resolve the handover's go-live date once (used by go_live-anchored plays).
    const goLiveDate = await goLiveDateForDeal(dealId, orgId);

    for (const play of playsResult.rows) {
      if (existingPlayIds.has(play.id)) continue;

      // Evaluate fire_conditions before instantiating
      const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
      if (conditions.length > 0) {
        const dealContext = {
          daysInStage: Math.floor(
            (Date.now() - new Date(deal?.stage_changed_at || deal?.updated_at)) / 86400000
          ),
          daysUntilClose: deal?.close_date
            ? Math.ceil((new Date(deal.close_date) - Date.now()) / 86400000)
            : 999,
        };
        if (!evaluateConditions(conditions, dealContext)) continue;
      }

      // Handover plays use same dependency logic as regular plays.
      // 'not_started' = ready; 'blocked' = waiting on sequential deps.
      let initialStatus = 'not_started';
      if (play.execution_type === 'sequential' && play.depends_on && play.depends_on.length > 0) {
        const allDepsComplete = await this._areDependenciesComplete(dealId, play.depends_on);
        if (!allDepsComplete) initialStatus = 'blocked';
      }

      const anchor  = play.due_anchor || 'created';
      const dueDate = computeInstanceDueDate(anchor, play.due_offset_days, goLiveDate, null);   // deal path: project_start is a project-only anchor

      const instResult = await db.query(
        `INSERT INTO deal_play_instances (
           deal_id, org_id, play_id, stage_key,
           title, description, channel, priority,
           execution_type, is_gate, due_date, sort_order,
           status, due_anchor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          dealId, orgId, play.id, stageKey,
          play.title, play.description, play.channel, play.priority,
          play.execution_type, play.is_gate, dueDate,
          play.sort_order, initialStatus, anchor,
        ]
      );

      const instance = instResult.rows[0];

      // Resolve assignee via PlayRouteResolver — respects role routing + team queue.
      // Now that roles are joined (B13), primaryRole is populated when the play
      // defines one; otherwise we fall back to deal owner, then caller.
      const plays_roles = Array.isArray(play.roles)
        ? play.roles
        : (play.roles ? (typeof play.roles === 'string' ? JSON.parse(play.roles) : play.roles) : []);

      const primaryRole = plays_roles.find(r => r.ownership_type === 'owner')
        || plays_roles.find(r => r.ownership_type === 'co_owner')
        || plays_roles[0]
        || null;

      const assignedUserIds = await resolveForPlay({
        orgId,
        roleKey:      primaryRole?.role_key  || null,
        roleId:       primaryRole?.role_id   || null,
        entity:       deal,
        entityType:   'handover',
        callerUserId: userId,
      });
      const assignedUserId = assignedUserIds[0] || (deal?.owner_id) || userId;
      const assignee = assignedUserId
        ? { userId: assignedUserId, name: '', roleId: primaryRole?.role_id || null }
        : null;

      // Record the assignee so reassignment and gate views work for handover
      // plays the same way they do for deal plays.
      if (assignee) {
        try {
          await db.query(
            `INSERT INTO deal_play_assignees (instance_id, user_id, role_id, assigned_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (instance_id, user_id) DO NOTHING`,
            [instance.id, assignee.userId, assignee.roleId, userId]
          );
        } catch (err) {
          console.error('Failed to record handover play assignee:', err.message);
        }
      }

      // Create action assigned to resolved user.
      // Contained per play. This matters most here: handover.service.js links the
      // returned instances into sales_handover_plays AFTER this loop, so letting an
      // exception escape would lose the handover↔play linkage for every play,
      // including the ones that succeeded.
      let actionId = null;
      if (initialStatus === 'not_started' && assignee) {
        try {
          actionId = await this._createActionForPlay(
          instance, assignee, orgId, 'handovers',
          {
            intendedRoleId:   primaryRole ? primaryRole.role_id : null,
            assignmentSource: assignedUserIds.length === 0
              ? 'project_owner'
              : (assignedUserId === deal?.owner_id ? 'project_owner' : 'role_holder'),
          }
        );
          if (actionId) {
            await db.query(
              'UPDATE deal_play_instances SET action_id = $1 WHERE id = $2',
              [actionId, instance.id]
            );
          }
        } catch (err) {
          warnings.push(
            `Handover play "${play.title}" was created but could not be linked to an action: ${err.message}`
          );
          console.error(
            `[PlaybookPlayService] handover action link failed for instance ${instance.id} (play ${play.id}):`,
            err.message
          );
        }
      }

      instances.push({ ...instance, action_id: actionId });
    }

    return { instances, warnings };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPLETE A PLAY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark a play instance as completed. Triggers dependency resolution.
   */
  static async completePlay(instanceId, userId, orgId) {
    const result = await db.query(
      `UPDATE deal_play_instances
       SET status = 'completed', completed_at = NOW(), completed_by = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3 AND status IN ('not_started', 'in_progress', 'blocked', 'snoozed')
       RETURNING *`,
      [userId, instanceId, orgId]
    );

    if (result.rows.length === 0) {
      throw new Error('Play instance not found or already completed');
    }

    const instance = result.rows[0];

    // Also complete the linked action if any.
    // (actions.completed is kept in sync by trg_sync_action_completed, but we
    //  set it explicitly too so this works regardless of trigger state.)
    if (instance.action_id) {
      await db.query(
        `UPDATE actions SET status = 'completed', completed = true,
         completed_at = NOW(), completed_by = $1
         WHERE id = $2 AND status != 'completed'`,
        [userId, instance.action_id]
      );
    }

    // Resolve sequential dependencies — activate plays waiting on this one
    const activated = await this._resolveDependencies(instance.deal_id, instance.play_id, orgId, userId);

    return { instance: result.rows[0], activated };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SKIP A PLAY
  // ═══════════════════════════════════════════════════════════════════════════

  static async skipPlay(instanceId, userId, orgId) {
    const result = await db.query(
      `UPDATE deal_play_instances
       SET status = 'skipped', overridden_by = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3 AND status IN ('not_started', 'in_progress', 'blocked', 'snoozed')
       RETURNING *`,
      [userId, instanceId, orgId]
    );

    if (result.rows.length === 0) {
      throw new Error('Play instance not found or already completed/skipped');
    }

    const instance = result.rows[0];

    // Skipping also resolves dependencies (downstream plays can proceed)
    const activated = await this._resolveDependencies(instance.deal_id, instance.play_id, orgId, userId);

    return { instance: result.rows[0], activated };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REASSIGN A PLAY
  // ═══════════════════════════════════════════════════════════════════════════

  static async reassignPlay(instanceId, newUserId, roleId, assignedBy, orgId) {
    // Verify user belongs to org
    const userCheck = await db.query(
      `SELECT id FROM users WHERE id = $1 AND org_id = $2`, [newUserId, orgId]
    );
    if (userCheck.rows.length === 0) throw new Error('User not in org');

    // Add as assignee (or update)
    await db.query(
      `INSERT INTO deal_play_assignees (instance_id, user_id, role_id, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (instance_id, user_id) DO UPDATE
         SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by`,
      [instanceId, newUserId, roleId || null, assignedBy]
    );

    // Update the linked action's user_id
    const instance = await db.query(
      `SELECT action_id FROM deal_play_instances WHERE id = $1`, [instanceId]
    );
    if (instance.rows[0]?.action_id) {
      await db.query(
        `UPDATE actions SET user_id = $1 WHERE id = $2`,
        [newUserId, instance.rows[0].action_id]
      );
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROJECT PLAY LIFECYCLE  (2026_109 split)
  //
  // Deliberately separate from the deal methods above rather than making those
  // dispatch on which table holds the instance. The promise of the split is
  // that deal behaviour is byte-identical, and the cheapest way to keep that
  // promise is to not touch the deal code path at all.
  //
  // The bodies mirror their deal counterparts. Two differences are structural,
  // not stylistic:
  //   • they read and write project_play_instances / project_play_assignees
  //   • dependency resolution is keyed on handover_id, because a project play
  //     has no deal_id to key on
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark a project play instance as completed. Triggers dependency resolution.
   */
  static async completePlayForProject(instanceId, userId, orgId) {
    const result = await db.query(
      // 2026_130: 'in_review' admitted. Approving a submission calls straight
      // through to here, and without it the UPDATE matched zero rows and raised
      // "Play instance not found or already completed" on every approval.
      `UPDATE project_play_instances
       SET status = 'completed', completed_at = NOW(), completed_by = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
         AND status IN ('not_started', 'in_progress', 'blocked', 'snoozed', 'in_review')
       RETURNING *`,
      [userId, instanceId, orgId]
    );

    if (result.rows.length === 0) {
      throw new Error('Play instance not found or already completed');
    }

    const instance = result.rows[0];

    if (instance.action_id) {
      await db.query(
        `UPDATE actions SET status = 'completed', completed = true,
         completed_at = NOW(), completed_by = $1
         WHERE id = $2 AND status != 'completed'`,
        [userId, instance.action_id]
      );
    }

    const activated = await this._resolveDependenciesForProject(
      instance.handover_id, instance.play_id, orgId, userId
    );

    // 2026_138. Tell whoever was waiting on this task that they can start.
    //
    // Placed HERE rather than at the call sites deliberately. This method has
    // two callers — handover.service.completePlay and playReview._close — and
    // hooking both would mean the notice fires from one path and not the other
    // the first time somebody adds a third. The completion is what releases a
    // dependent, so the notice belongs where the completion is written.
    //
    // Note this is a DIFFERENT graph from _resolveDependenciesForProject above:
    // that reads playbook_plays.depends_on (play-template ids) and only ever
    // touches instances parked in 'blocked'. This reads
    // project_play_instances.depends_on, the hand-wired graph, which nothing
    // sets a status from. See dependencyNotifier for the full note.
    await PlaybookPlayService._notifyUnblocked(instanceId, orgId, userId);

    return { instance, activated };
  }

  /**
   * Best-effort unblock fan-out, shared by the completion and skip paths.
   *
   * Lazily required so this service keeps its current load-time dependency set
   * — it is required by playReview, which is required by the routes, and the
   * notifier reaches notificationService and the job queue.
   *
   * Swallows everything. The status change is already committed and is the
   * source of truth; a notification failure that propagated would surface as a
   * failed completion, the user would retry, and the retry would fail with
   * "this task changed while you were working on it".
   */
  static async _notifyUnblocked(instanceId, orgId, userId) {
    try {
      const dependencyNotifier = require('./dependencyNotifier.service');
      await dependencyNotifier.notifyUnblocked(instanceId, orgId, userId);
    } catch (err) {
      console.warn(
        `[PlaybookPlayService] unblock notice failed after closing instance ${instanceId}:`,
        err.message);
    }
  }

  static async skipPlayForProject(instanceId, userId, orgId) {
    const result = await db.query(
      // 2026_130: 'in_review' admitted — a skip can be submitted for approval
      // just as a completion can, and approval lands here.
      `UPDATE project_play_instances
       SET status = 'skipped', overridden_by = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
         AND status IN ('not_started', 'in_progress', 'blocked', 'snoozed', 'in_review')
       RETURNING *`,
      [userId, instanceId, orgId]
    );

    if (result.rows.length === 0) {
      throw new Error('Play instance not found or already completed/skipped');
    }

    const instance = result.rows[0];

    // Skipping also resolves dependencies (downstream plays can proceed)
    const activated = await this._resolveDependenciesForProject(
      instance.handover_id, instance.play_id, orgId, userId
    );

    // A skip satisfies a prerequisite exactly as a completion does — that is
    // what _outstandingPrereqs has always said — so the people waiting on it
    // are told the same way.
    await PlaybookPlayService._notifyUnblocked(instanceId, orgId, userId);

    return { instance, activated };
  }

  static async reassignPlayForProject(instanceId, newUserId, roleId, assignedBy, orgId) {
    const userCheck = await db.query(
      `SELECT id FROM users WHERE id = $1 AND org_id = $2`, [newUserId, orgId]
    );
    if (userCheck.rows.length === 0) throw new Error('User not in org');

    // Requires project_play_assignees_instance_id_user_id_key (2026_110).
    // 2026_109 created the table without it and this upsert would have raised.
    await db.query(
      `INSERT INTO project_play_assignees (instance_id, user_id, role_id, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (instance_id, user_id) DO UPDATE
         SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by`,
      [instanceId, newUserId, roleId || null, assignedBy]
    );

    const instance = await db.query(
      `SELECT action_id FROM project_play_instances WHERE id = $1 AND org_id = $2`,
      [instanceId, orgId]
    );
    if (instance.rows[0]?.action_id) {
      await db.query(
        `UPDATE actions SET user_id = $1 WHERE id = $2`,
        [newUserId, instance.rows[0].action_id]
      );
    }

    return { success: true };
  }

  static async _areDependenciesCompleteForProject(handoverId, dependsOnPlayIds) {
    if (!dependsOnPlayIds || dependsOnPlayIds.length === 0) return true;

    const result = await db.query(
      `SELECT COUNT(*) AS incomplete
       FROM project_play_instances
       WHERE handover_id = $1
         AND play_id = ANY($2)
         AND status NOT IN ('completed', 'skipped', 'cancelled')`,
      [handoverId, dependsOnPlayIds]
    );

    return parseInt(result.rows[0].incomplete) === 0;
  }

  /**
   * When a project play completes, activate any blocked plays that depended
   * on it. Scoped by handover_id — the deal version keys on deal_id, which a
   * project play does not have.
   */
  static async _resolveDependenciesForProject(handoverId, completedPlayId, orgId, userId) {
    if (!completedPlayId || !handoverId) return [];

    const pendingResult = await db.query(
      `SELECT ppi.id, ppi.play_id, pp.depends_on
       FROM project_play_instances ppi
       LEFT JOIN playbook_plays pp ON pp.id = ppi.play_id
       WHERE ppi.handover_id = $1 AND ppi.status = 'blocked'
         AND pp.depends_on IS NOT NULL
         AND $2 = ANY(pp.depends_on)`,
      [handoverId, completedPlayId]
    );

    const activated = [];

    for (const pending of pendingResult.rows) {
      const allDepsComplete = await this._areDependenciesCompleteForProject(
        handoverId, pending.depends_on
      );
      if (!allDepsComplete) continue;

      await db.query(
        `UPDATE project_play_instances SET status = 'not_started', updated_at = NOW()
         WHERE id = $1`,
        [pending.id]
      );

      const inst = await db.query(
        `SELECT * FROM project_play_instances WHERE id = $1`, [pending.id]
      );
      const instance = inst.rows[0];

      // 2026_130 BUGFIX. This read project_play_assignees, which is empty in
      // every live org: its only writer, reassignPlayForProject(), is not
      // reachable from any route (only scripts/phase109_acceptance.js calls
      // it). So the lookup always returned zero rows, no action was created,
      // and an unblocked play flipped to 'not_started' in nobody's queue —
      // silently, because the surrounding try/catch only guards action
      // CREATION, and creation was never attempted.
      //
      // owner_user_id is the assignment the product actually maintains: it is
      // what the checklist renders as the owner chip and what the inline owner
      // control writes. Reading it here makes the unblocked play land on the
      // person the UI has been showing as its owner all along.
      const assigneeResult = await db.query(
        `SELECT ppi.owner_user_id AS user_id,
                u.first_name || ' ' || u.last_name AS name
         FROM project_play_instances ppi
         JOIN users u ON u.id = ppi.owner_user_id
         WHERE ppi.id = $1 AND ppi.owner_user_id IS NOT NULL
         LIMIT 1`,
        [pending.id]
      );

      if (assigneeResult.rows.length > 0 && instance) {
        // No sales_handover_plays lookup needed to derive the module: every
        // row in this table belongs to a project by definition.
        //
        // Contained: unblocking play N+1 must not fail because its action
        // could not be created — the status transition above is already
        // committed and is the semantically important part.
        try {
          const actionId = await this._createActionForPlay(
            instance, assigneeResult.rows[0], orgId, 'handovers'
          );
          if (actionId) {
            await db.query(
              `UPDATE project_play_instances SET action_id = $1 WHERE id = $2`,
              [actionId, pending.id]
            );
          }
        } catch (err) {
          console.error(
            `[PlaybookPlayService] action link failed while unblocking project instance ${pending.id}:`,
            err.message
          );
        }
      }

      activated.push({ instanceId: pending.id, playId: pending.play_id });
    }

    return activated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GATE CHECK — can the deal advance to the next stage?
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @returns {{ canAdvance: boolean, enforcement: string, incompleteGates: Array }}
   */
  static async checkGates(dealId, stageKey, orgId) {
    // Get playbook gate enforcement setting
    const pbResult = await db.query(
      `SELECT p.gate_enforcement
       FROM deals d
       LEFT JOIN playbooks p ON p.id = d.playbook_id
       WHERE d.id = $1 AND d.org_id = $2`,
      [dealId, orgId]
    );

    let enforcement = pbResult.rows[0]?.gate_enforcement || 'advisory';

    // Fallback to org default playbook
    if (!pbResult.rows[0]?.gate_enforcement) {
      const def = await db.query(
        `SELECT gate_enforcement FROM playbooks WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
        [orgId]
      );
      enforcement = def.rows[0]?.gate_enforcement || 'advisory';
    }

    // Find incomplete gate instances for this stage.
    // A gate clears on completed OR skipped OR cancelled (an abandoned gate must
    // not block advancement forever — matches handover_deliverable_rollup).
    const gatesResult = await db.query(
      `SELECT dpi.id, dpi.title, dpi.status,
              COALESCE(
                json_agg(json_build_object('name', u.first_name || ' ' || u.last_name))
                FILTER (WHERE dpa.id IS NOT NULL),
                '[]'
              ) AS assignees
       FROM deal_play_instances dpi
       LEFT JOIN deal_play_assignees dpa ON dpa.instance_id = dpi.id
       LEFT JOIN users u ON u.id = dpa.user_id
       WHERE dpi.deal_id = $1 AND dpi.stage_key = $2
         AND dpi.is_gate = TRUE AND dpi.status NOT IN ('completed', 'skipped', 'cancelled')
       GROUP BY dpi.id
       ORDER BY dpi.sort_order`,
      [dealId, stageKey]
    );

    const incompleteGates = gatesResult.rows.map(g => ({
      id: g.id,
      title: g.title,
      status: g.status,
      assignees: typeof g.assignees === 'string' ? JSON.parse(g.assignees) : g.assignees,
    }));

    const canAdvance = enforcement === 'advisory' || incompleteGates.length === 0;

    return { canAdvance, enforcement, incompleteGates };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST PLAY INSTANCES for a deal
  // ═══════════════════════════════════════════════════════════════════════════

  static async getPlayInstances(dealId, orgId, { stageKey, userId } = {}) {
    let query = `
      SELECT dpi.*,
        COALESCE(
          json_agg(
            json_build_object(
              'user_id', dpa.user_id,
              'name', u.first_name || ' ' || u.last_name,
              'role_id', dpa.role_id,
              'role_name', dr.name,
              'role_key', dr.key
            )
          ) FILTER (WHERE dpa.id IS NOT NULL),
          '[]'
        ) AS assignees
      FROM deal_play_instances dpi
      LEFT JOIN deal_play_assignees dpa ON dpa.instance_id = dpi.id
      LEFT JOIN users u ON u.id = dpa.user_id
      LEFT JOIN org_roles dr ON dr.id = dpa.role_id
      WHERE dpi.deal_id = $1 AND dpi.org_id = $2
    `;
    const params = [dealId, orgId];

    if (stageKey) {
      params.push(stageKey);
      query += ` AND dpi.stage_key = $${params.length}`;
    }

    if (userId) {
      params.push(userId);
      query += ` AND dpi.id IN (
        SELECT instance_id FROM deal_play_assignees WHERE user_id = $${params.length}
      )`;
    }

    query += ` GROUP BY dpi.id ORDER BY dpi.sort_order ASC`;

    const result = await db.query(query, params);

    return result.rows.map(r => ({
      ...r,
      assignees: typeof r.assignees === 'string' ? JSON.parse(r.assignees) : r.assignees,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADD MANUAL PLAY (not from playbook template)
  // ═══════════════════════════════════════════════════════════════════════════

  static async addManualPlay(dealId, orgId, userId, data) {
    const { title, description, channel, priority, isGate, dueDate, assigneeIds } = data;

    // Get the deal's current stage
    const dealResult = await db.query(
      `SELECT d.stage AS stage_key
       FROM deals d
       WHERE d.id = $1 AND d.org_id = $2`,
      [dealId, orgId]
    );
    const stageKey = dealResult.rows[0]?.stage_key;
    if (!stageKey) throw new Error('Could not determine deal stage');

    // Get max sort_order for this stage
    const maxSort = await db.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
       FROM deal_play_instances WHERE deal_id = $1 AND stage_key = $2`,
      [dealId, stageKey]
    );

    const instResult = await db.query(
      `INSERT INTO deal_play_instances (
         deal_id, org_id, play_id, stage_key,
         title, description, channel, priority,
         execution_type, is_gate, due_date, sort_order,
         status, is_manual, overridden_by
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 'parallel', $8, $9, $10, 'not_started', TRUE, $11)
       RETURNING *`,
      [
        dealId, orgId, stageKey,
        title, description || null, channel || null, priority || 'medium',
        isGate || false, dueDate || null, maxSort.rows[0].next_order,
        userId
      ]
    );

    const instance = instResult.rows[0];

    // Assign users
    if (assigneeIds && assigneeIds.length > 0) {
      for (const uid of assigneeIds) {
        await db.query(
          `INSERT INTO deal_play_assignees (instance_id, user_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [instance.id, uid, userId]
        );
      }
    }

    // Create action for first assignee.
    // Manual plays have no playbook_play_id, so _createActionForPlay dedupes on
    // the play_instance_id in metadata rather than the (deal_id, play) index.
    if (assigneeIds && assigneeIds.length > 0) {
      const firstUser = await db.query(
        `SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id = $1`,
        [assigneeIds[0]]
      );
      if (firstUser.rows.length > 0) {
        // Contained: a manual play that cannot be linked is still a valid play.
        // Re-raising here would fail the whole addManualPlay call after the
        // instance row is already committed.
        try {
          const actionId = await this._createActionForPlay(
            instance,
            { userId: firstUser.rows[0].id, name: firstUser.rows[0].name },
            orgId,
            'deals'
          );
          if (actionId) {
            await db.query(
              `UPDATE deal_play_instances SET action_id = $1 WHERE id = $2`,
              [actionId, instance.id]
            );
            instance.action_id = actionId;
          }
        } catch (err) {
          console.error(
            `[PlaybookPlayService] action link failed for manual play instance ${instance.id}:`,
            err.message
          );
          instance.link_warning = `Play created but not linked to an action: ${err.message}`;
        }
      }
    }

    return instance;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if all dependency plays are completed or skipped.
   * (cancelled also counts as resolved — a cancelled predecessor should not
   *  block its successors forever.)
   */
  static async _areDependenciesComplete(dealId, dependsOnPlayIds) {
    if (!dependsOnPlayIds || dependsOnPlayIds.length === 0) return true;

    const result = await db.query(
      `SELECT COUNT(*) AS incomplete
       FROM deal_play_instances
       WHERE deal_id = $1
         AND play_id = ANY($2)
         AND status NOT IN ('completed', 'skipped', 'cancelled')`,
      [dealId, dependsOnPlayIds]
    );

    return parseInt(result.rows[0].incomplete) === 0;
  }

  /**
   * When a play completes, check if any blocked plays depended on it and
   * activate them.
   */
  static async _resolveDependencies(dealId, completedPlayId, orgId, userId) {
    if (!completedPlayId) return [];

    // Find blocked instances whose depends_on includes this play
    const pendingResult = await db.query(
      `SELECT dpi.id, dpi.play_id, pp.depends_on
       FROM deal_play_instances dpi
       LEFT JOIN playbook_plays pp ON pp.id = dpi.play_id
       WHERE dpi.deal_id = $1 AND dpi.status = 'blocked'
         AND pp.depends_on IS NOT NULL
         AND $2 = ANY(pp.depends_on)`,
      [dealId, completedPlayId]
    );

    const activated = [];

    for (const pending of pendingResult.rows) {
      // Check if ALL dependencies are now satisfied
      const allDepsComplete = await this._areDependenciesComplete(
        dealId,
        pending.depends_on
      );

      if (allDepsComplete) {
        // Activate this play
        await db.query(
          `UPDATE deal_play_instances SET status = 'not_started', updated_at = NOW()
           WHERE id = $1`,
          [pending.id]
        );

        // Create action row for the now-active play
        const inst = await db.query(
          `SELECT * FROM deal_play_instances WHERE id = $1`, [pending.id]
        );
        const instance = inst.rows[0];

        const assigneeResult = await db.query(
          `SELECT dpa.user_id, u.first_name || ' ' || u.last_name AS name
           FROM deal_play_assignees dpa
           JOIN users u ON u.id = dpa.user_id
           WHERE dpa.instance_id = $1
           LIMIT 1`,
          [pending.id]
        );

        if (assigneeResult.rows.length > 0 && instance) {
          // Derive source_module from whether this instance belongs to a handover.
          const hv = await db.query(
            `SELECT 1 FROM sales_handover_plays WHERE play_instance_id = $1 LIMIT 1`,
            [pending.id]
          );
          const sourceModule = hv.rows.length > 0 ? 'handovers' : 'deals';

          // Contained: unblocking play N+1 must not fail because its action
          // could not be created — the status transition to 'not_started' has
          // already been committed above and is the semantically important part.
          try {
            const actionId = await this._createActionForPlay(
              instance, assigneeResult.rows[0], orgId, sourceModule
            );
            if (actionId) {
              await db.query(
                `UPDATE deal_play_instances SET action_id = $1 WHERE id = $2`,
                [actionId, pending.id]
              );
            }
          } catch (err) {
            console.error(
              `[PlaybookPlayService] action link failed while unblocking instance ${pending.id}:`,
              err.message
            );
          }
        }

        activated.push({ instanceId: pending.id, playId: pending.play_id });
      }
    }

    return activated;
  }

  /**
   * Create an action row in the actions table for a play instance.
   *
   * A5 fix. Previously this hardcoded source_rule='playbook_play' with no
   * playbook_play_id, so the SECOND play on any deal collided on
   * uq_actions_deal_source_rule (deal_id, source_rule) — the index reserved
   * for Type-A diagnostic alerts — threw, was swallowed, and left action_id
   * NULL. Result: no play ever linked to an action.
   *
   * Now:
   *   - sets playbook_play_id (the correct dedupe key for playbook tasks)
   *   - leaves source_rule NULL (frees the diagnostic index)
   *   - sets source_module so the unified Actions view can group by module
   *   - upserts on the partial unique index uq_actions_deal_play
   *     (deal_id, playbook_play_id) so re-firing a stage is idempotent
   *   - re-raises on unexpected errors instead of silently returning null
   *
   * @param {object} instance      deal_play_instances row
   * @param {object} assignee      { userId, name }
   * @param {number} orgId
   * @param {string} sourceModule  'deals' | 'handovers'  (defaults 'deals')
   * @param {object} [provenance]   { intendedRoleId, assignmentSource } — A7 /
   *        2026_73a. intendedRoleId is the role that SHOULD own this work, kept
   *        even when unfilled. assignmentSource records which resolver tier
   *        produced the assignee; 'project_owner' means nobody held the role.
   * @returns {number|null} action id
   */
  static async _createActionForPlay(instance, assignee, orgId, sourceModule = 'deals', provenance = {}) {
    const intendedRoleId   = provenance.intendedRoleId   ?? null;
    const assignmentSource = provenance.assignmentSource ?? null;
    const channelMap = {
      email:             'email',
      call:              'call',
      meeting:           'call',
      document:          'document',
      internal_task:     'document',
      handover_section:  'document',   // handover form section → task action
      handover_document: 'document',   // file attachment play  → task action
    };

    const metadata = JSON.stringify({
      play_instance_id: instance.id,
      play_id: instance.play_id,
      stage_key: instance.stage_key,
    });

    // Which entity does this action hang off? A deal play carries deal_id; a
    // project play carries handover_id and has no deal at all. Before the
    // 2026_109 split both branches wrote deal_id, so a project play inserted
    // deal_id NULL — which made the partial index
    //   uq_actions_deal_play WHERE deal_id IS NOT NULL
    // inapplicable, silently degrading the upsert to a plain INSERT. Every
    // re-activation of a stage then created a duplicate action, and the action
    // was attached to nothing. uq_actions_handover_play (2026_110) is the
    // mirror index that makes the project branch idempotent.
    const handoverId = instance.handover_id ?? null;
    const dealId     = instance.deal_id ?? null;
    if (!handoverId && !dealId) {
      throw new Error(
        `Play instance ${instance.id} has neither deal_id nor handover_id; ` +
        'cannot attach an action to it.'
      );
    }
    // ON CONFLICT targets must be literal, so the two shapes are separate
    // statements rather than an interpolated column name.
    const conflictOnHandover = handoverId !== null;

    // Manual plays have no playbook_play_id; they can't use the
    // (entity, playbook_play_id) index, so fall back to a plain insert.
    // Playbook-derived plays upsert idempotently on that index.
    const hasPlayId = instance.play_id != null;

    try {
      if (hasPlayId && conflictOnHandover) {
        const result = await db.query(
          `INSERT INTO actions (
             org_id, user_id, handover_id,
             title, description,
             type, action_type, priority,
             next_step, is_internal,
             source, source_rule, source_module,
             playbook_play_id,
             due_date, status, completed,
             metadata,
             intended_role_id, assignment_source
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $6, $7, $8, $9,
             'playbook', NULL, $10,
             $11,
             $12, 'not_started', false, $13,
             $14, $15
           )
           ON CONFLICT (handover_id, playbook_play_id)
             WHERE handover_id IS NOT NULL AND playbook_play_id IS NOT NULL
           DO UPDATE SET
             user_id           = EXCLUDED.user_id,
             due_date          = EXCLUDED.due_date,
             intended_role_id  = EXCLUDED.intended_role_id,
             assignment_source = EXCLUDED.assignment_source,
             updated_at        = NOW()
           RETURNING id`,
          [
            orgId,
            assignee.userId,
            handoverId,
            instance.title,
            instance.description || 'Playbook play: ' + instance.title,
            instance.channel === 'meeting' ? 'meeting_schedule'
              : (instance.channel === 'email' ? 'email_send' : 'task_complete'),
            instance.priority || 'medium',
            channelMap[instance.channel] || 'document',
            instance.channel === 'internal_task' || instance.channel === 'document',
            sourceModule,
            instance.play_id,
            instance.due_date,
            metadata,
            intendedRoleId,
            assignmentSource,
          ]
        );
        return result.rows[0]?.id || null;
      }

      if (hasPlayId) {
        const result = await db.query(
          `INSERT INTO actions (
             org_id, user_id, deal_id,
             title, description,
             type, action_type, priority,
             next_step, is_internal,
             source, source_rule, source_module,
             playbook_play_id,
             due_date, status, completed,
             metadata,
             intended_role_id, assignment_source
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $6, $7, $8, $9,
             'playbook', NULL, $10,
             $11,
             $12, 'not_started', false, $13,
             $14, $15
           )
           ON CONFLICT (deal_id, playbook_play_id)
             WHERE deal_id IS NOT NULL AND playbook_play_id IS NOT NULL
           DO UPDATE SET
             user_id           = EXCLUDED.user_id,
             due_date          = EXCLUDED.due_date,
             intended_role_id  = EXCLUDED.intended_role_id,
             assignment_source = EXCLUDED.assignment_source,
             updated_at        = NOW()
           RETURNING id`,
          [
            orgId,
            assignee.userId,
            instance.deal_id,
            instance.title,
            instance.description || 'Playbook play: ' + instance.title,
            instance.channel === 'meeting' ? 'meeting_schedule'
              : (instance.channel === 'email' ? 'email_send' : 'task_complete'),
            instance.priority || 'medium',
            channelMap[instance.channel] || 'document',
            instance.channel === 'internal_task' || instance.channel === 'document',
            sourceModule,
            instance.play_id,
            instance.due_date,
            metadata,
            intendedRoleId,
            assignmentSource,
          ]
        );
        return result.rows[0]?.id || null;
      }

      // Manual play — no playbook_play_id, so no upsert index applies.
      // Writes whichever entity column this instance belongs to.
      const result = await db.query(
        `INSERT INTO actions (
           org_id, user_id, deal_id, handover_id,
           title, description,
           type, action_type, priority,
           next_step, is_internal,
           source, source_rule, source_module,
           due_date, status, completed,
           metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10,
           'playbook', NULL, $11,
           $12, 'not_started', false, $13
         )
         RETURNING id`,
        [
          orgId,
          assignee.userId,
          dealId,
          handoverId,
          instance.title,
          instance.description || 'Playbook play: ' + instance.title,
          instance.channel === 'meeting' ? 'meeting_schedule'
            : (instance.channel === 'email' ? 'email_send' : 'task_complete'),
          instance.priority || 'medium',
          channelMap[instance.channel] || 'document',
          instance.channel === 'internal_task' || instance.channel === 'document',
          sourceModule,
          instance.due_date,
          metadata,
        ]
      );
      return result.rows[0]?.id || null;

    } catch (err) {
      // Re-raise: a failure here previously vanished and left action_id NULL,
      // which is exactly the bug (B10) this method now fixes. Surface it.
      console.error('Failed to create action for play (instance %s):', instance.id, err.message);
      throw err;
    }
  }
}

module.exports = PlaybookPlayService;
