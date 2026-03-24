/**
 * PlayRouteResolver.js
 *
 * Single source of truth for resolving play role → assigned user(s).
 * Used by every action-generation path in Phase 2+:
 *   - actionsGenerator.js        (deals nightly)
 *   - PlaybookPlayService        (deals stage-change, handovers)
 *   - ContractActionsGenerator   (CLM)
 *   - prospectingActions.service (prospects)
 *   - supportService             (cases)
 *   - StrapActionGenerator       (STRAPs)
 *
 * Priority order per play role — each step is tried in sequence,
 * stopping at the first that yields a result:
 *
 *   1. Entity-specific role lookup
 *        Deals/handovers: deal_team_members WHERE role_id = play_role.role_id
 *        Contracts:       owner_id / legal_assignee_id by role key
 *        Prospects:       assigned_to (no role routing today — Phase 2 wires in team lookup)
 *        Cases:           assigned_to
 *
 *   2. Function team queue
 *        teams WHERE org_role_key = role.key → team_memberships
 *        (lead first, then alphabetical, max 5)
 *
 *   3. Entity owner
 *        deal.owner_id / contract.owner_id / prospect.assigned_to /
 *        case.assigned_to / caller userId
 *
 *   4. Caller fallback
 *        userId passed at generation time. Always succeeds.
 *
 * Modelled on notificationService.resolveRecipients() — same additive
 * accumulation pattern, same org_hierarchy avoidance (not used for
 * action assignment per settled decisions).
 *
 * Public API:
 *   resolveForPlay({ orgId, roleKey, roleId, entity, entityType, callerUserId })
 *     → Promise<number[]>  (de-duped array of userIds, always ≥ 1)
 *
 *   resolveForPlays({ orgId, plays, entity, entityType, callerUserId })
 *     → Promise<Map<playId, number[]>>
 */

'use strict';

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1a — deal_team_members lookup (deals + handovers).
 * Returns userIds for members with role_id matching the play's role.
 */
async function _dealTeamLookup(orgId, dealId, roleId) {
  if (!dealId || !roleId) return [];
  const { rows } = await pool.query(
    `SELECT dtm.user_id
     FROM deal_team_members dtm
     JOIN org_users ou ON ou.user_id = dtm.user_id AND ou.org_id = dtm.org_id
     WHERE dtm.deal_id = $1
       AND dtm.org_id  = $2
       AND dtm.role_id = $3
       AND ou.is_active = TRUE`,
    [dealId, orgId, roleId]
  );
  return rows.map(r => r.user_id);
}

/**
 * Step 1b — CLM contract field lookup.
 * Maps role key → contract column directly (legacy ROLE_STRATEGY, now centralised here).
 * Returns a single userId or null.
 */
function _contractRoleLookup(contract, roleKey) {
  switch (roleKey) {
    case 'account_executive':  return contract.owner_id || null;
    case 'legal':              return contract.legal_assignee_id || null;
    // sales_manager + others fall through to team/owner steps
    default:                   return null;
  }
}

/**
 * Step 2 — function team queue via org_role_key.
 * Returns up to 5 userIds, team leads first.
 */
async function _teamQueueLookup(orgId, roleKey) {
  if (!roleKey) return [];
  const { rows } = await pool.query(
    `SELECT tm.user_id
     FROM team_memberships tm
     JOIN teams t ON t.id = tm.team_id
     JOIN org_users ou ON ou.user_id = tm.user_id AND ou.org_id = tm.org_id
     WHERE t.org_id       = $1
       AND t.org_role_key = $2
       AND t.is_active    = TRUE
       AND ou.is_active   = TRUE
     ORDER BY (tm.role = 'lead') DESC, tm.user_id ASC
     LIMIT 5`,
    [orgId, roleKey]
  );
  return rows.map(r => r.user_id);
}

/**
 * Derive entity owner userId from an entity object + entityType.
 * Returns null if not determinable.
 */
function _entityOwner(entity, entityType) {
  if (!entity) return null;
  switch (entityType) {
    case 'deal':
    case 'handover':   return entity.owner_id || null;
    case 'contract':   return entity.owner_id || null;
    case 'prospect':   return entity.assigned_to || null;
    case 'case':       return entity.assigned_to || null;
    default:           return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve assigned userId(s) for a single play role.
 *
 * @param {object} params
 * @param {number}        params.orgId
 * @param {string|null}   params.roleKey      — org_roles.key (e.g. 'legal', 'account_executive')
 * @param {number|null}   params.roleId       — org_roles.id  (used for deal_team_members lookup)
 * @param {object|null}   params.entity       — full entity row (deal, contract, prospect, case…)
 * @param {string}        params.entityType   — 'deal' | 'contract' | 'prospect' | 'case' | 'handover'
 * @param {number}        params.callerUserId — fallback of last resort, always succeeds
 *
 * @returns {Promise<number[]>}  De-duped array, guaranteed length ≥ 1
 */
async function resolveForPlay({ orgId, roleKey, roleId, entity, entityType, callerUserId }) {
  const candidates = new Set();

  // ── Step 1: Entity-specific role lookup ──────────────────────────────────

  if (entityType === 'deal' || entityType === 'handover') {
    const dealId = entity?.id || entity?.deal_id || null;
    const teamUsers = await _dealTeamLookup(orgId, dealId, roleId);
    teamUsers.forEach(uid => candidates.add(uid));
  }

  if (entityType === 'contract') {
    const contractUser = _contractRoleLookup(entity, roleKey);
    if (contractUser) candidates.add(contractUser);
  }

  // Prospects and cases: no per-entity role table exists yet — skip to step 2

  if (candidates.size > 0) {
    return Array.from(candidates);
  }

  // ── Step 2: Function team queue via org_role_key ──────────────────────────

  const teamUsers = await _teamQueueLookup(orgId, roleKey);
  teamUsers.forEach(uid => candidates.add(uid));

  if (candidates.size > 0) {
    return Array.from(candidates);
  }

  // ── Step 3: Entity owner ──────────────────────────────────────────────────

  const owner = _entityOwner(entity, entityType);
  if (owner) candidates.add(owner);

  if (candidates.size > 0) {
    return Array.from(candidates);
  }

  // ── Step 4: Caller fallback — always succeeds ─────────────────────────────

  if (callerUserId) candidates.add(callerUserId);

  return Array.from(candidates);
}

/**
 * Resolve assignments for every play in a list in a single pass.
 * Caches team-queue results per roleKey to avoid redundant DB queries.
 *
 * @param {object} params
 * @param {number}   params.orgId
 * @param {Array}    params.plays         — play rows, each with { id, roles: [{role_id, role_key}] }
 * @param {object}   params.entity        — full entity row
 * @param {string}   params.entityType
 * @param {number}   params.callerUserId
 *
 * @returns {Promise<Map<number, number[]>>}  playId → [userId, …]
 */
async function resolveForPlays({ orgId, plays, entity, entityType, callerUserId }) {
  // Pre-fetch deal team once (only relevant for deal/handover)
  let dealTeamByRoleId = {};
  if ((entityType === 'deal' || entityType === 'handover') && entity) {
    const dealId = entity.id || entity.deal_id || null;
    if (dealId) {
      const { rows } = await pool.query(
        `SELECT dtm.role_id, dtm.user_id
         FROM deal_team_members dtm
         JOIN org_users ou ON ou.user_id = dtm.user_id AND ou.org_id = dtm.org_id
         WHERE dtm.deal_id = $1 AND dtm.org_id = $2 AND ou.is_active = TRUE`,
        [dealId, orgId]
      );
      for (const row of rows) {
        if (!dealTeamByRoleId[row.role_id]) dealTeamByRoleId[row.role_id] = [];
        dealTeamByRoleId[row.role_id].push(row.user_id);
      }
    }
  }

  // Team queue cache: roleKey → userId[]
  const teamCache = new Map();

  async function cachedTeamQueue(roleKey) {
    if (!roleKey) return [];
    if (teamCache.has(roleKey)) return teamCache.get(roleKey);
    const users = await _teamQueueLookup(orgId, roleKey);
    teamCache.set(roleKey, users);
    return users;
  }

  const owner = _entityOwner(entity, entityType) || callerUserId;
  const result = new Map();

  for (const play of plays) {
    const roles = Array.isArray(play.roles) ? play.roles : [];

    // Play has no role assignments — assign to owner/caller
    if (roles.length === 0) {
      result.set(play.id, owner ? [owner] : [callerUserId]);
      continue;
    }

    const seenUsers = new Set();

    for (const role of roles) {
      const { role_id: roleId, role_key: roleKey } = role;

      // Step 1: entity-specific
      if (entityType === 'deal' || entityType === 'handover') {
        const users = dealTeamByRoleId[roleId] || [];
        users.forEach(uid => seenUsers.add(uid));
        if (users.length > 0) continue;
      }

      if (entityType === 'contract') {
        const u = _contractRoleLookup(entity, roleKey);
        if (u) { seenUsers.add(u); continue; }
      }

      // Step 2: team queue
      const teamUsers = await cachedTeamQueue(roleKey);
      if (teamUsers.length > 0) {
        teamUsers.forEach(uid => seenUsers.add(uid));
        continue;
      }

      // Step 3: entity owner
      if (owner) { seenUsers.add(owner); continue; }

      // Step 4: caller
      if (callerUserId) seenUsers.add(callerUserId);
    }

    result.set(play.id, seenUsers.size > 0 ? Array.from(seenUsers) : [callerUserId]);
  }

  return result;
}

module.exports = { resolveForPlay, resolveForPlays };
