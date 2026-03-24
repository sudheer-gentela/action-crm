// ─────────────────────────────────────────────────────────────────────────────
// PlaybookPlayService.js
//
// Core service for role-based playbook plays:
//   - Activate plays when a deal enters a new stage
//   - Resolve role → person assignments from deal team
//   - Handle sequential dependencies
//   - Gate checking for stage advancement
//   - Complete / skip / reassign plays
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');
const { resolveForPlay } = require('./PlayRouteResolver');
const { evaluateConditions } = require('./playbook.service');

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
      `SELECT d.playbook_id, d.stage_entered_at, d.close_date, d.updated_at,
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

    for (const play of playsResult.rows) {
      // Skip if already instantiated
      if (existingPlayIds.has(play.id)) continue;

      // Evaluate fire_conditions before instantiating
      const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
      if (conditions.length > 0) {
        const dealContext = {
          daysInStage: Math.floor(
            (Date.now() - new Date(dealMeta.stage_entered_at || dealMeta.updated_at)) / 86400000
          ),
          daysUntilClose: dealMeta.close_date
            ? Math.ceil((new Date(dealMeta.close_date) - Date.now()) / 86400000)
            : 999,
        };
        if (!evaluateConditions(conditions, dealContext)) continue;
      }

      const roles = typeof play.roles === 'string' ? JSON.parse(play.roles) : play.roles;
      const coOwnerRoles = roles.filter(r => r.ownership_type === 'co_owner');

      // Determine initial status
      let initialStatus = 'active';
      if (play.execution_type === 'sequential' && play.depends_on && play.depends_on.length > 0) {
        // Check if all dependencies are completed
        const allDepsComplete = await this._areDependenciesComplete(dealId, play.depends_on);
        if (!allDepsComplete) {
          initialStatus = 'pending';
        }
      }

      // Calculate due date
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (play.due_offset_days || 3));

      // Create instance
      const instResult = await db.query(
        `INSERT INTO deal_play_instances (
           deal_id, org_id, play_id, stage_key,
           title, description, channel, priority,
           execution_type, is_gate, due_date, sort_order,
           status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          dealId, orgId, play.id, stageKey,
          play.title, play.description, play.channel, play.priority,
          play.execution_type, play.is_gate, dueDate.toISOString().split('T')[0],
          play.sort_order, initialStatus
        ]
      );

      const instance = instResult.rows[0];
      playIdToInstanceId[play.id] = instance.id;

      // Assign co-owners from deal team, with PlayRouteResolver as fallback
      const assignees = [];
      for (const role of coOwnerRoles) {
        const members = teamByRole[role.role_id] || [];
        if (members.length === 0) {
          // No deal-team member for this role — try team queue + owner fallback
          const resolvedIds = await resolveForPlay({
            orgId,
            roleKey:      role.role_key || null,
            roleId:       role.role_id  || null,
            entity:       { id: dealId },
            entityType:   'deal',
            callerUserId: userId,
          });
          // Skip the deal-team-members lookup (already empty) — go straight to resolved
          for (const resolvedId of resolvedIds) {
            if (resolvedId === userId && resolvedIds.length > 1) continue; // prefer non-caller
            try {
              await db.query(
                `INSERT INTO deal_play_assignees (instance_id, user_id, role_id, assigned_by)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (instance_id, user_id) DO NOTHING`,
                [instance.id, resolvedId, role.role_id, userId]
              );
              assignees.push({ userId: resolvedId, name: '', roleKey: role.role_key });
            } catch (err) {
              console.error('Failed to assign play (resolver fallback):', err.message);
            }
            break; // only first resolved user for this role
          }
          if (assignees.length === 0) {
            warnings.push(`No team member with role "${role.role_name}" for play "${play.title}" — used resolver fallback`);
          }
          continue;
        }
        for (const member of members) {
          try {
            await db.query(
              `INSERT INTO deal_play_assignees (instance_id, user_id, role_id, assigned_by)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (instance_id, user_id) DO NOTHING`,
              [instance.id, member.user_id, member.role_id, userId]
            );
            assignees.push({ userId: member.user_id, name: member.name, roleKey: member.role_key });
          } catch (err) {
            console.error('Failed to assign play:', err.message);
          }
        }
      }

      // Create action row if instance is active
      let actionId = null;
      if (initialStatus === 'active' && assignees.length > 0) {
        actionId = await this._createActionForPlay(instance, assignees[0], orgId);
        if (actionId) {
          await db.query(
            `UPDATE deal_play_instances SET action_id = $1 WHERE id = $2`,
            [actionId, instance.id]
          );
        }
      }

      instances.push({
        ...instance,
        action_id: actionId,
        assignees,
        roles: coOwnerRoles,
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
   * of whatever sales playbook the deal has assigned. Assigns plays to the
   * deal owner rather than role-based deal team members.
   *
   * @param {number} dealId
   * @param {string} stageKey
   * @param {number} orgId
   * @param {number} userId
   * @param {number} playbookId  — explicit playbook to activate plays from
   * @returns {{ instances: Array, warnings: string[] }}
   */
  static async activateStageForPlaybook(dealId, stageKey, orgId, userId, playbookId) {
    const warnings = [];

    // Get plays for this stage from the specific playbook
    const playsResult = await db.query(
      `SELECT pp.*
       FROM playbook_plays pp
       WHERE pp.playbook_id = $1 AND pp.stage_key = $2 AND pp.is_active = TRUE
         AND (pp.trigger_mode IS NULL OR pp.trigger_mode = 'stage_change')
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
              d.stage_entered_at, d.close_date, d.updated_at
       FROM deals d WHERE d.id = $1`,
      [dealId]
    );
    const deal = dealResult.rows[0] || null;

    const instances = [];

    for (const play of playsResult.rows) {
      if (existingPlayIds.has(play.id)) continue;

      // Evaluate fire_conditions before instantiating
      const conditions = Array.isArray(play.fire_conditions) ? play.fire_conditions : [];
      if (conditions.length > 0) {
        const dealContext = {
          daysInStage: Math.floor(
            (Date.now() - new Date(deal?.stage_entered_at || deal?.updated_at)) / 86400000
          ),
          daysUntilClose: deal?.close_date
            ? Math.ceil((new Date(deal.close_date) - Date.now()) / 86400000)
            : 999,
        };
        if (!evaluateConditions(conditions, dealContext)) continue;
      }

      // Handover plays use same dependency logic as regular plays
      let initialStatus = 'active';
      if (play.execution_type === 'sequential' && play.depends_on && play.depends_on.length > 0) {
        const allDepsComplete = await this._areDependenciesComplete(dealId, play.depends_on);
        if (!allDepsComplete) initialStatus = 'pending';
      }

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (play.due_offset_days || 3));

      const instResult = await db.query(
        `INSERT INTO deal_play_instances (
           deal_id, org_id, play_id, stage_key,
           title, description, channel, priority,
           execution_type, is_gate, due_date, sort_order,
           status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          dealId, orgId, play.id, stageKey,
          play.title, play.description, play.channel, play.priority,
          play.execution_type, play.is_gate, dueDate.toISOString().split('T')[0],
          play.sort_order, initialStatus,
        ]
      );

      const instance = instResult.rows[0];

      // Resolve assignee via PlayRouteResolver — respects role routing + team queue
      // Falls back to deal owner, then caller userId
      const plays_roles = Array.isArray(play.roles)
        ? play.roles
        : (play.roles ? (typeof play.roles === 'string' ? JSON.parse(play.roles) : play.roles) : []);

      const primaryRole = plays_roles.find(r => r.ownership_type === 'primary') || plays_roles[0] || null;

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
        ? { userId: assignedUserId, name: '' }
        : null;

      // Create action assigned to resolved user
      let actionId = null;
      if (initialStatus === 'active' && assignee) {
        actionId = await this._createActionForPlay(instance, assignee, orgId);
        if (actionId) {
          await db.query(
            'UPDATE deal_play_instances SET action_id = $1 WHERE id = $2',
            [actionId, instance.id]
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
       WHERE id = $2 AND org_id = $3 AND status IN ('active', 'pending')
       RETURNING *`,
      [userId, instanceId, orgId]
    );

    if (result.rows.length === 0) {
      throw new Error('Play instance not found or already completed');
    }

    const instance = result.rows[0];

    // Also complete the linked action if any
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
       WHERE id = $2 AND org_id = $3 AND status IN ('active', 'pending')
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

    // Find incomplete gate instances for this stage
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
         AND dpi.is_gate = TRUE AND dpi.status NOT IN ('completed', 'skipped')
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
       ) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 'parallel', $8, $9, $10, 'active', TRUE, $11)
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

    // Create action for first assignee
    if (assigneeIds && assigneeIds.length > 0) {
      const firstUser = await db.query(
        `SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id = $1`,
        [assigneeIds[0]]
      );
      if (firstUser.rows.length > 0) {
        const actionId = await this._createActionForPlay(
          instance,
          { userId: firstUser.rows[0].id, name: firstUser.rows[0].name },
          orgId
        );
        if (actionId) {
          await db.query(
            `UPDATE deal_play_instances SET action_id = $1 WHERE id = $2`,
            [actionId, instance.id]
          );
          instance.action_id = actionId;
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
   */
  static async _areDependenciesComplete(dealId, dependsOnPlayIds) {
    if (!dependsOnPlayIds || dependsOnPlayIds.length === 0) return true;

    const result = await db.query(
      `SELECT COUNT(*) AS incomplete
       FROM deal_play_instances
       WHERE deal_id = $1
         AND play_id = ANY($2)
         AND status NOT IN ('completed', 'skipped')`,
      [dealId, dependsOnPlayIds]
    );

    return parseInt(result.rows[0].incomplete) === 0;
  }

  /**
   * When a play completes, check if any pending plays depended on it and activate them.
   */
  static async _resolveDependencies(dealId, completedPlayId, orgId, userId) {
    if (!completedPlayId) return [];

    // Find pending instances whose depends_on includes this play
    const pendingResult = await db.query(
      `SELECT dpi.id, dpi.play_id, pp.depends_on
       FROM deal_play_instances dpi
       LEFT JOIN playbook_plays pp ON pp.id = dpi.play_id
       WHERE dpi.deal_id = $1 AND dpi.status = 'pending'
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
          `UPDATE deal_play_instances SET status = 'active', updated_at = NOW()
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
          const actionId = await this._createActionForPlay(
            instance, assigneeResult.rows[0], orgId
          );
          if (actionId) {
            await db.query(
              `UPDATE deal_play_instances SET action_id = $1 WHERE id = $2`,
              [actionId, pending.id]
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
   */
  static async _createActionForPlay(instance, assignee, orgId) {
    try {
      const channelMap = {
        email:             'email',
        call:              'call',
        meeting:           'call',
        document:          'document',
        internal_task:     'document',
        handover_section:  'document',   // handover form section → task action
        handover_document: 'document',   // file attachment play  → task action
      };

      const result = await db.query(
        `INSERT INTO actions (
           org_id, user_id, deal_id,
           title, description,
           type, action_type, priority,
           next_step, is_internal,
           source, source_rule,
           due_date, status, completed,
           metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 'playbook', 'playbook_play', $10, 'yet_to_start', false, $11)
         RETURNING id`,
        [
          orgId,
          assignee.userId,
          instance.deal_id,
          instance.title,
          instance.description || 'Playbook play: ' + instance.title,
          instance.channel === 'meeting' ? 'meeting_schedule' : (instance.channel === 'email' ? 'email_send' : 'task_complete'),
          instance.priority || 'medium',
          channelMap[instance.channel] || 'document',
          instance.channel === 'internal_task' || instance.channel === 'document',
          instance.due_date,
          JSON.stringify({
            play_instance_id: instance.id,
            play_id: instance.play_id,
            stage_key: instance.stage_key,
          })
        ]
      );

      return result.rows[0]?.id || null;
    } catch (err) {
      console.error('Failed to create action for play:', err.message);
      return null;
    }
  }
}

module.exports = PlaybookPlayService;
