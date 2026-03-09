// ─────────────────────────────────────────────────────────────────────────
// services/teamService.js
//
// CRUD and query service for the multi-dimensional teams system.
//
// Teams are org-scoped, grouped by "dimension" (market_segment, seller_role,
// product_line, geo, motion — or any custom dimension the org defines).
//
// A user can belong to one or more teams across dimensions.
// Team memberships are independent of org_hierarchy (reporting structure).
//
// Key methods:
//   getDimensions(orgId)              — returns the org's configured dimensions
//   saveDimensions(orgId, dimensions) — update dimension configuration
//   getTeams(orgId, dimension?)       — list teams, optionally filtered
//   createTeam / updateTeam / deleteTeam — CRUD
//   getUserProfile(userId, orgId)     — all memberships across dimensions
//   setMembership / removeMembership  — assign/remove user from team
//   bulkAssign(orgId, assignments)    — batch assign multiple users to teams
//   getTeamMembers(teamId, orgId)     — all members of a team
// ─────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const DEFAULT_DIMENSIONS = [
  { key: 'market_segment', label: 'Market Segment', required: false, description: 'Which market segment the user sells into' },
  { key: 'seller_role',    label: 'Seller Role',    required: false, description: 'The selling role of the user' },
  { key: 'product_line',   label: 'Product Line',   required: false, description: 'Which product(s) the user sells' },
  { key: 'geo',            label: 'Geography',      required: false, description: 'Geographic territory' },
  { key: 'motion',         label: 'Motion',         required: false, description: 'Type of sales motion' },
  { key: 'function',       label: 'Function',       required: false, description: 'Functional team — Legal, Sales, Implementation, CS, Executive, etc.' },
];

const teamService = {

  // ── Dimension Configuration ─────────────────────────────────────────

  /**
   * Get the org's team dimensions config.
   * Falls back to DEFAULT_DIMENSIONS if not configured.
   */
  async getDimensions(orgId) {
    try {
      const r = await pool.query(
        `SELECT settings->'team_dimensions' AS dims FROM organizations WHERE id = $1`,
        [orgId]
      );
      const dims = r.rows[0]?.dims;
      console.log(`[teamService] getDimensions org=${orgId}, fromDB type=${typeof dims}, isArray=${Array.isArray(dims)}, length=${dims?.length}, value=`, JSON.stringify(dims)?.substring(0, 200));
      if (Array.isArray(dims) && dims.length > 0) return dims;
    } catch (err) {
      console.error('teamService.getDimensions error:', err.message);
    }
    console.log(`[teamService] getDimensions org=${orgId} — falling back to DEFAULT_DIMENSIONS`);
    return [...DEFAULT_DIMENSIONS];
  },

  /**
   * Save the org's team dimensions config.
   * Validates that existing teams don't reference removed dimensions.
   */
  async saveDimensions(orgId, dimensions) {
    if (!Array.isArray(dimensions)) throw new Error('dimensions must be an array');

    // Validate each dimension has a key and label
    for (const dim of dimensions) {
      if (!dim.key || !dim.label) throw new Error('Each dimension must have a key and label');
      if (!/^[a-z][a-z_]*$/.test(dim.key)) throw new Error(`Invalid dimension key: "${dim.key}" — use lowercase letters + underscores only, must start with a letter`);
    }

    // Check for orphaned teams — teams whose dimension is being removed
    const newKeys = new Set(dimensions.map(d => d.key));
    const existingTeams = await pool.query(
      `SELECT DISTINCT dimension FROM teams WHERE org_id = $1 AND is_active = true`,
      [orgId]
    );
    const orphanedDimensions = existingTeams.rows
      .map(r => r.dimension)
      .filter(d => !newKeys.has(d));

    if (orphanedDimensions.length > 0) {
      throw new Error(
        `Cannot remove dimension(s) "${orphanedDimensions.join(', ')}" — active teams exist. ` +
        `Delete or deactivate those teams first.`
      );
    }

    console.log(`[teamService] saveDimensions org=${orgId}, saving ${dimensions.length} dimensions:`, dimensions.map(d => d.key).join(', '));

    const result = await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{team_dimensions}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2
       RETURNING settings->'team_dimensions' AS saved_dims`,
      [JSON.stringify(dimensions), orgId]
    );

    console.log(`[teamService] saveDimensions result: rowCount=${result.rowCount}, savedDims=`, JSON.stringify(result.rows[0]?.saved_dims)?.substring(0, 200));

    return dimensions;
  },

  // ── Team CRUD ───────────────────────────────────────────────────────

  /**
   * Get all teams for an org, optionally filtered by dimension.
   * Includes member count.
   */
  async getTeams(orgId, dimension = null) {
    let query = `
      SELECT t.*,
             COALESCE(mc.member_count, 0)::int AS member_count
      FROM teams t
      LEFT JOIN (
        SELECT team_id, COUNT(*) AS member_count
        FROM team_memberships
        WHERE org_id = $1
        GROUP BY team_id
      ) mc ON mc.team_id = t.id
      WHERE t.org_id = $1 AND t.is_active = true
    `;
    const params = [orgId];

    if (dimension) {
      query += ` AND t.dimension = $2`;
      params.push(dimension);
    }

    query += ` ORDER BY t.dimension, t.name`;

    const r = await pool.query(query, params);
    return r.rows;
  },

  /**
   * Create a new team.
   */
  async createTeam(orgId, { name, dimension, description, parentTeamId, settings, createdBy }) {
    if (!name || !dimension) throw new Error('name and dimension are required');

    // Validate dimension exists in org config
    const dims = await this.getDimensions(orgId);
    if (!dims.find(d => d.key === dimension)) {
      throw new Error(`Unknown dimension: "${dimension}". Configure it in team dimensions first.`);
    }

    const r = await pool.query(`
      INSERT INTO teams (org_id, name, dimension, description, parent_team_id, settings, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [orgId, name.trim(), dimension, description || null, parentTeamId || null, JSON.stringify(settings || {}), createdBy || null]);

    return r.rows[0];
  },

  /**
   * Update an existing team.
   */
  async updateTeam(orgId, teamId, updates) {
    const allowed = ['name', 'description', 'parent_team_id', 'settings', 'is_active'];
    const sets = [];
    const params = [orgId, teamId];
    let pIdx = 3;

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        const colName = key;
        const value = key === 'settings' ? JSON.stringify(updates[key]) : updates[key];
        sets.push(`${colName} = $${pIdx}`);
        params.push(value);
        pIdx++;
      }
    }

    if (sets.length === 0) throw new Error('No valid fields to update');
    sets.push('updated_at = NOW()');

    const r = await pool.query(
      `UPDATE teams SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`,
      params
    );

    if (r.rows.length === 0) throw new Error('Team not found');
    return r.rows[0];
  },

  /**
   * Soft-delete a team. Removes all memberships first.
   */
  async deleteTeam(orgId, teamId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove memberships
      await client.query(
        `DELETE FROM team_memberships WHERE org_id = $1 AND team_id = $2`,
        [orgId, teamId]
      );

      // Re-parent child teams
      await client.query(
        `UPDATE teams SET parent_team_id = NULL, updated_at = NOW()
         WHERE org_id = $1 AND parent_team_id = $2`,
        [orgId, teamId]
      );

      // Soft delete
      const r = await client.query(
        `UPDATE teams SET is_active = false, updated_at = NOW()
         WHERE org_id = $1 AND id = $2 RETURNING id`,
        [orgId, teamId]
      );

      await client.query('COMMIT');
      return r.rowCount > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // ── Membership Management ───────────────────────────────────────────

  /**
   * Get a user's team profile — all memberships across dimensions.
   */
  async getUserProfile(userId, orgId) {
    const r = await pool.query(`
      SELECT tm.id AS membership_id, tm.role, tm.is_primary, tm.created_at,
             t.id AS team_id, t.name AS team_name, t.dimension, t.description AS team_description
      FROM team_memberships tm
      JOIN teams t ON tm.team_id = t.id
      WHERE tm.user_id = $1 AND tm.org_id = $2 AND t.is_active = true
      ORDER BY t.dimension, t.name
    `, [userId, orgId]);

    // Group by dimension
    const profile = {};
    for (const row of r.rows) {
      if (!profile[row.dimension]) profile[row.dimension] = [];
      profile[row.dimension].push({
        teamId: row.team_id,
        teamName: row.team_name,
        role: row.role,
        isPrimary: row.is_primary,
        membershipId: row.membership_id,
      });
    }
    return profile;
  },

  /**
   * Get all memberships for all users in an org (for the admin grid).
   */
  async getAllMemberships(orgId) {
    const r = await pool.query(`
      SELECT tm.user_id, tm.team_id, tm.role, tm.is_primary,
             t.name AS team_name, t.dimension,
             u.first_name, u.last_name, u.email
      FROM team_memberships tm
      JOIN teams t ON tm.team_id = t.id
      JOIN users u ON tm.user_id = u.id
      WHERE tm.org_id = $1 AND t.is_active = true
      ORDER BY u.first_name, u.last_name, t.dimension
    `, [orgId]);
    return r.rows;
  },

  /**
   * Assign a user to a team.
   * If the user already has a primary team in this dimension,
   * the new one becomes non-primary (unless explicitly set).
   */
  async setMembership(orgId, userId, teamId, { role, isPrimary } = {}) {
    // Verify team belongs to this org
    const teamCheck = await pool.query(
      `SELECT dimension FROM teams WHERE id = $1 AND org_id = $2 AND is_active = true`,
      [teamId, orgId]
    );
    if (teamCheck.rows.length === 0) throw new Error('Team not found');
    const dimension = teamCheck.rows[0].dimension;

    // Check if user already has a primary in this dimension
    const existing = await pool.query(`
      SELECT tm.id, tm.team_id FROM team_memberships tm
      JOIN teams t ON tm.team_id = t.id
      WHERE tm.user_id = $1 AND tm.org_id = $2 AND t.dimension = $3 AND t.is_active = true
    `, [userId, orgId, dimension]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If user already has a team in this dimension, remove it (single team per dimension by default)
      if (existing.rows.length > 0) {
        await client.query(
          `DELETE FROM team_memberships WHERE user_id = $1 AND org_id = $2 AND team_id = ANY($3)`,
          [userId, orgId, existing.rows.map(r => r.team_id)]
        );
      }

      const r = await client.query(`
        INSERT INTO team_memberships (org_id, user_id, team_id, role, is_primary)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, team_id)
        DO UPDATE SET role = COALESCE(EXCLUDED.role, team_memberships.role),
                      is_primary = COALESCE(EXCLUDED.is_primary, team_memberships.is_primary)
        RETURNING *
      `, [orgId, userId, teamId, role || 'member', isPrimary !== false]);

      await client.query('COMMIT');
      return r.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Remove a user from a specific team.
   */
  async removeMembership(orgId, userId, teamId) {
    const r = await pool.query(
      `DELETE FROM team_memberships WHERE org_id = $1 AND user_id = $2 AND team_id = $3 RETURNING id`,
      [orgId, userId, teamId]
    );
    return r.rowCount > 0;
  },

  /**
   * Bulk assign users to teams.
   * Input: [{ userId, teamId }]
   * Each assignment replaces the user's existing team in that dimension.
   */
  async bulkAssign(orgId, assignments) {
    const results = [];
    for (const { userId, teamId } of assignments) {
      try {
        const r = await this.setMembership(orgId, userId, teamId);
        results.push({ userId, teamId, success: true });
      } catch (err) {
        results.push({ userId, teamId, success: false, error: err.message });
      }
    }
    return results;
  },

  /**
   * Get all members of a specific team.
   */
  async getTeamMembers(teamId, orgId) {
    const r = await pool.query(`
      SELECT tm.user_id, tm.role, tm.is_primary, tm.created_at,
             u.first_name, u.last_name, u.email
      FROM team_memberships tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = $1 AND tm.org_id = $2
      ORDER BY u.first_name, u.last_name
    `, [teamId, orgId]);
    return r.rows;
  },
};

module.exports = teamService;
