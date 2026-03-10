// ─────────────────────────────────────────────────────────────────────────────
// accountTeams.service.js
//
// Customer-side org structure — teams and their members tied to an account.
// Surfaced in OrgChartPanel as the "Customer Teams" subtab and in
// ContactsView as a team membership section per contact.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

// ── Row formatters ────────────────────────────────────────────────────────────

function fmtTeam(row) {
  if (!row) return null;
  return {
    id:           row.id,
    orgId:        row.org_id,
    accountId:    row.account_id,
    name:         row.name,
    dimension:    row.dimension,
    parentTeamId: row.parent_team_id,
    description:  row.description,
    isActive:     row.is_active,
    createdBy:    row.created_by,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
    // aggregated
    members:      row.members      ?? [],
    memberCount:  row.member_count ?? 0,
  };
}

function fmtMember(row) {
  if (!row) return null;
  return {
    id:            row.id,
    accountTeamId: row.account_team_id,
    contactId:     row.contact_id,
    role:          row.role,
    isPrimary:     row.is_primary,
    notes:         row.notes,
    createdAt:     row.created_at,
    // joined contact fields
    contactName:   row.contact_name   ?? null,
    contactTitle:  row.contact_title  ?? null,
    contactEmail:  row.contact_email  ?? null,
  };
}

// ── listByAccount ─────────────────────────────────────────────────────────────

/**
 * All account teams for an account, grouped with their members.
 *
 * @param {number} accountId
 * @param {number} orgId
 * @param {{ activeOnly?: boolean }} opts
 */
async function listByAccount(accountId, orgId, { activeOnly = true } = {}) {
  const params = [accountId, orgId];
  const activeClause = activeOnly ? 'AND at.is_active = TRUE' : '';

  const { rows } = await pool.query(
    `SELECT
       at.*,
       COUNT(atm.id)::int AS member_count,
       COALESCE(
         json_agg(
           json_build_object(
             'id',           atm.id,
             'contactId',    atm.contact_id,
             'role',         atm.role,
             'isPrimary',    atm.is_primary,
             'notes',        atm.notes,
             'contactName',  c.first_name || ' ' || c.last_name,
             'contactTitle', c.title,
             'contactEmail', c.email
           ) ORDER BY atm.is_primary DESC, c.first_name ASC
         ) FILTER (WHERE atm.id IS NOT NULL),
         '[]'
       ) AS members
     FROM account_teams at
     LEFT JOIN account_team_members atm ON atm.account_team_id = at.id
     LEFT JOIN contacts c ON c.id = atm.contact_id
     WHERE at.account_id = $1 AND at.org_id = $2 ${activeClause}
     GROUP BY at.id
     ORDER BY at.dimension ASC, at.name ASC`,
    params
  );

  return rows.map(r => ({
    ...fmtTeam(r),
    members: typeof r.members === 'string' ? JSON.parse(r.members) : r.members,
  }));
}

// ── listByContact ─────────────────────────────────────────────────────────────

/**
 * All account team memberships for a contact — used in ContactsView sidebar.
 *
 * @param {number} contactId
 * @param {number} orgId
 */
async function listByContact(contactId, orgId) {
  const { rows } = await pool.query(
    `SELECT
       atm.*,
       at.name         AS team_name,
       at.dimension    AS team_dimension,
       at.account_id,
       a.name          AS account_name
     FROM account_team_members atm
     JOIN account_teams at ON at.id = atm.account_team_id
     JOIN accounts a       ON a.id  = at.account_id
     WHERE atm.contact_id = $1 AND atm.org_id = $2 AND at.is_active = TRUE
     ORDER BY a.name ASC, at.name ASC`,
    [contactId, orgId]
  );

  return rows.map(r => ({
    ...fmtMember(r),
    teamName:      r.team_name,
    teamDimension: r.team_dimension,
    accountId:     r.account_id,
    accountName:   r.account_name,
  }));
}

// ── createTeam ────────────────────────────────────────────────────────────────

/**
 * @param {number} orgId
 * @param {number} userId
 * @param {{ accountId, name, dimension, parentTeamId?, description? }} data
 */
async function createTeam(orgId, userId, data) {
  const { accountId, name, dimension = 'custom', parentTeamId, description } = data;

  if (!accountId || !name) {
    throw Object.assign(new Error('accountId and name are required'), { status: 400 });
  }

  const { rows } = await pool.query(
    `INSERT INTO account_teams
       (org_id, account_id, name, dimension, parent_team_id, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [orgId, accountId, name.trim(), dimension, parentTeamId || null, description || null, userId]
  );

  return fmtTeam(rows[0]);
}

// ── updateTeam ────────────────────────────────────────────────────────────────

/**
 * @param {number} orgId
 * @param {number} teamId
 * @param {{ name?, dimension?, description?, isActive? }} data
 */
async function updateTeam(orgId, teamId, data) {
  const existing = await _getTeam(orgId, teamId);

  const name        = data.name        !== undefined ? data.name.trim() : existing.name;
  const dimension   = data.dimension   !== undefined ? data.dimension   : existing.dimension;
  const description = data.description !== undefined ? data.description : existing.description;
  const isActive    = data.isActive    !== undefined ? data.isActive    : existing.isActive;

  const { rows } = await pool.query(
    `UPDATE account_teams
     SET name = $1, dimension = $2, description = $3, is_active = $4, updated_at = NOW()
     WHERE id = $5 AND org_id = $6
     RETURNING *`,
    [name, dimension, description, isActive, teamId, orgId]
  );

  if (rows.length === 0) throw Object.assign(new Error('Team not found'), { status: 404 });
  return fmtTeam(rows[0]);
}

// ── deleteTeam ────────────────────────────────────────────────────────────────

/**
 * Hard-delete a team and cascade-remove its members (via FK).
 */
async function deleteTeam(orgId, teamId) {
  const { rowCount } = await pool.query(
    'DELETE FROM account_teams WHERE id = $1 AND org_id = $2',
    [teamId, orgId]
  );
  if (rowCount === 0) throw Object.assign(new Error('Team not found'), { status: 404 });
  return { deleted: true, id: teamId };
}

// ── addMember ─────────────────────────────────────────────────────────────────

/**
 * Add a contact to an account team.
 * Upserts on (account_team_id, contact_id) — safe to call repeatedly.
 *
 * @param {number} orgId
 * @param {number} teamId
 * @param {{ contactId, role?, isPrimary?, notes? }} data
 */
async function addMember(orgId, teamId, data) {
  const { contactId, role = 'member', isPrimary = false, notes } = data;

  if (!contactId) throw Object.assign(new Error('contactId is required'), { status: 400 });

  // Verify team belongs to org
  await _getTeam(orgId, teamId);

  // If setting as primary, clear existing primary in this team first
  if (isPrimary) {
    await pool.query(
      'UPDATE account_team_members SET is_primary = FALSE WHERE account_team_id = $1',
      [teamId]
    );
  }

  const { rows } = await pool.query(
    `INSERT INTO account_team_members
       (org_id, account_team_id, contact_id, role, is_primary, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_team_id, contact_id) DO UPDATE
       SET role = EXCLUDED.role,
           is_primary = EXCLUDED.is_primary,
           notes = EXCLUDED.notes
     RETURNING *`,
    [orgId, teamId, contactId, role, isPrimary, notes || null]
  );

  // Return with joined contact fields
  const memberRow = await pool.query(
    `SELECT atm.*,
            c.first_name || ' ' || c.last_name AS contact_name,
            c.title                             AS contact_title,
            c.email                             AS contact_email
     FROM account_team_members atm
     LEFT JOIN contacts c ON c.id = atm.contact_id
     WHERE atm.id = $1`,
    [rows[0].id]
  );

  return fmtMember(memberRow.rows[0]);
}

// ── removeMember ─────────────────────────────────────────────────────────────

/**
 * Remove a contact from an account team.
 *
 * @param {number} orgId
 * @param {number} teamId
 * @param {number} memberId  — account_team_members.id
 */
async function removeMember(orgId, teamId, memberId) {
  const { rowCount } = await pool.query(
    'DELETE FROM account_team_members WHERE id = $1 AND account_team_id = $2 AND org_id = $3',
    [memberId, teamId, orgId]
  );
  if (rowCount === 0) throw Object.assign(new Error('Member not found'), { status: 404 });
  return { deleted: true, id: memberId };
}

// ── private helpers ───────────────────────────────────────────────────────────

async function _getTeam(orgId, teamId) {
  const { rows } = await pool.query(
    'SELECT * FROM account_teams WHERE id = $1 AND org_id = $2',
    [teamId, orgId]
  );
  if (rows.length === 0) throw Object.assign(new Error('Team not found'), { status: 404 });
  return fmtTeam(rows[0]);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  listByAccount,
  listByContact,
  createTeam,
  updateTeam,
  deleteTeam,
  addMember,
  removeMember,
};
