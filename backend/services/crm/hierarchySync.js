/**
 * crm/hierarchySync.js
 *
 * DROP-IN LOCATION: backend/services/crm/hierarchySync.js
 *
 * Syncs CRM user hierarchy into GoWarm's:
 *   - org_hierarchy  (manager/rep reporting lines)
 *   - teams          (team groupings by dimension='sales')
 *   - team_memberships (user → team assignments)
 *
 * Key design decisions:
 *
 * 1. JOIN KEY IS EMAIL.
 *    The CRM user's email must match a GoWarm users.email row.
 *    If a CRM user has no GoWarm account (hasn't been invited yet),
 *    they are skipped — not an error. As reps are onboarded to GoWarm
 *    they get picked up on the next sync.
 *
 * 2. HIERARCHY IS ADDITIVE, NOT DESTRUCTIVE.
 *    We upsert org_hierarchy rows. We do not delete existing rows that
 *    aren't in the CRM sync — those may have been set manually (e.g.
 *    via CSV import). To fully replace the hierarchy from CRM, the
 *    OrgAdmin must use the "Reset hierarchy from CRM" option.
 *
 * 3. TEAMS ARE UPSERTED BY NAME + DIMENSION.
 *    teams.dimension = 'sales' for CRM-sourced teams.
 *    teams.org_role_key = slugified team name for downstream role matching.
 *
 * 4. RELATIONSHIP_TYPE = 'solid'.
 *    CRM manager relationships are always solid lines.
 *    Dotted lines (matrix orgs) must be added manually in GoWarm.
 */

const { pool } = require('../../config/database');

/**
 * Run hierarchy sync for an org using a pre-initialised adapter.
 *
 * @param {number} orgId
 * @param {object} adapter  - Initialised CRM adapter (must implement getUsers())
 * @returns {{ usersProcessed: number, hierarchyUpdated: number, teamsUpdated: number, skipped: number }}
 */
async function syncHierarchy(orgId, adapter) {
  console.log(`  👥 [Hierarchy] Starting for org ${orgId}`);

  const users = await adapter.getUsers();
  if (users.length === 0) {
    console.log(`  ✓ [Hierarchy] No CRM users returned — skipping`);
    return { usersProcessed: 0, hierarchyUpdated: 0, teamsUpdated: 0, skipped: 0 };
  }

  // Build email → GoWarm user_id lookup for all users in this org
  const emailToUserId = await _buildEmailUserMap(orgId);

  let hierarchyUpdated = 0;
  let teamsUpdated     = 0;
  let skipped          = 0;

  // Pass 1 — upsert org_hierarchy for each user we can resolve
  for (const crmUser of users) {
    if (!crmUser.email) { skipped++; continue; }

    const userId = emailToUserId.get(crmUser.email);
    if (!userId) {
      // User exists in CRM but hasn't been invited to GoWarm yet — skip silently
      skipped++;
      continue;
    }

    const managerId = crmUser.managerEmail
      ? emailToUserId.get(crmUser.managerEmail) || null
      : null;

    try {
      await pool.query(`
        INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role, relationship_type, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'solid', NOW(), NOW())
        ON CONFLICT (org_id, user_id)
          WHERE relationship_type = 'solid'
        DO UPDATE SET
          reports_to     = EXCLUDED.reports_to,
          hierarchy_role = EXCLUDED.hierarchy_role,
          updated_at     = NOW()
      `, [orgId, userId, managerId, crmUser.hierarchyRole || 'rep']);

      hierarchyUpdated++;
    } catch (err) {
      console.error(`  ⚠️  [Hierarchy] user ${crmUser.email}: ${err.message}`);
    }
  }

  // Pass 2 — upsert teams and team_memberships
  // Group users by teamName
  const teamGroups = new Map(); // teamName → [userId, ...]
  for (const crmUser of users) {
    if (!crmUser.teamName || !crmUser.email) continue;
    const userId = emailToUserId.get(crmUser.email);
    if (!userId) continue;

    if (!teamGroups.has(crmUser.teamName)) {
      teamGroups.set(crmUser.teamName, []);
    }
    teamGroups.get(crmUser.teamName).push(userId);
  }

  for (const [teamName, memberIds] of teamGroups) {
    try {
      const teamId = await _upsertTeam(orgId, teamName);

      for (const userId of memberIds) {
        await pool.query(`
          INSERT INTO team_memberships (org_id, user_id, team_id, role, is_primary, created_at)
          VALUES ($1, $2, $3, 'member', true, NOW())
          ON CONFLICT (user_id, team_id) DO NOTHING
        `, [orgId, userId, teamId]);
      }

      teamsUpdated++;
    } catch (err) {
      console.error(`  ⚠️  [Hierarchy] team "${teamName}": ${err.message}`);
    }
  }

  console.log(
    `  ✓ [Hierarchy] org ${orgId} — hierarchy:${hierarchyUpdated} teams:${teamsUpdated} skipped:${skipped}`
  );

  return {
    usersProcessed:  users.length,
    hierarchyUpdated,
    teamsUpdated,
    skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Map of email → GoWarm user_id for all users in an org.
 * Case-insensitive — keys are lowercased.
 *
 * @param {number} orgId
 * @returns {Map<string, number>}
 */
async function _buildEmailUserMap(orgId) {
  const res = await pool.query(
    `SELECT u.id, LOWER(u.email) AS email
     FROM users u
     JOIN org_users ou ON ou.user_id = u.id
     WHERE ou.org_id = $1 AND ou.is_active = true`,
    [orgId]
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.email, row.id);
  }
  return map;
}

/**
 * Upsert a team by name and dimension='sales'.
 * Returns the team id.
 *
 * @param {number} orgId
 * @param {string} teamName
 * @returns {number} team id
 */
async function _upsertTeam(orgId, teamName) {
  // org_role_key is a slug used for downstream role matching
  const orgRoleKey = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  const res = await pool.query(`
    INSERT INTO teams (org_id, name, dimension, org_role_key, is_active, created_at, updated_at)
    VALUES ($1, $2, 'sales', $3, true, NOW(), NOW())
    ON CONFLICT (org_id, dimension, name)
    DO UPDATE SET
      org_role_key = EXCLUDED.org_role_key,
      is_active    = true,
      updated_at   = NOW()
    RETURNING id
  `, [orgId, teamName, orgRoleKey]);

  return res.rows[0].id;
}

module.exports = { syncHierarchy };
