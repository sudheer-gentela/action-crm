// ─────────────────────────────────────────────────────────────────
// services/hierarchyService.js
//
// Recursive CTE queries for the org_hierarchy table.
// Supports both SOLID (primary) and DOTTED (matrix) reporting lines.
//
// Used by orgContext middleware to populate req.subordinateIds
// and by orgAdmin routes for hierarchy CRUD.
//
// MATRIX REPORTING:
//   A user has exactly ONE solid line (primary manager) and zero or
//   more dotted lines (matrix/cross-functional managers).
//   Data visibility (subordinateIds) respects BOTH line types —
//   a dotted-line manager can see their matrix report's data.
// ─────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const hierarchyService = {

  // ── Ensure table exists (graceful first-run) ─────────────────
  async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS org_hierarchy (
        id                SERIAL PRIMARY KEY,
        org_id            INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reports_to        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        hierarchy_role    VARCHAR(50) DEFAULT 'rep',
        relationship_type VARCHAR(10) DEFAULT 'solid' CHECK (relationship_type IN ('solid', 'dotted')),
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(org_id, user_id, reports_to)
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_org_hierarchy_one_solid
        ON org_hierarchy (org_id, user_id)
        WHERE relationship_type = 'solid'
    `);
  },

  // ── getSubordinates ──────────────────────────────────────────
  // Returns ALL user IDs that report to userId (direct + indirect).
  // Direct reports include both solid AND dotted lines.
  // Recursive descent follows SOLID lines only (prevents fan-out).
  async getSubordinates(orgId, userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE subordinates AS (
          SELECT h.user_id
          FROM org_hierarchy h
          WHERE h.org_id = $1 AND h.reports_to = $2

          UNION

          SELECT h.user_id
          FROM org_hierarchy h
          INNER JOIN subordinates s ON h.reports_to = s.user_id
          WHERE h.org_id = $1 AND h.relationship_type = 'solid'
        )
        SELECT DISTINCT user_id FROM subordinates
      `, [orgId, userId]);
      return result.rows.map(r => r.user_id);
    } catch (err) {
      if (err.message?.includes('relation "org_hierarchy" does not exist')) return [];
      throw err;
    }
  },

  // ── getDirectReports ─────────────────────────────────────────
  async getDirectReports(orgId, userId) {
    try {
      const result = await pool.query(`
        SELECT h.user_id, h.hierarchy_role, h.relationship_type,
               u.first_name, u.last_name, u.email
        FROM org_hierarchy h
        JOIN users u ON u.id = h.user_id
        WHERE h.org_id = $1 AND h.reports_to = $2
        ORDER BY h.relationship_type ASC, u.first_name, u.last_name
      `, [orgId, userId]);
      return result.rows;
    } catch (err) {
      if (err.message?.includes('relation "org_hierarchy" does not exist')) return [];
      throw err;
    }
  },

  // ── getAncestors ─────────────────────────────────────────────
  async getAncestors(orgId, userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT h.reports_to AS user_id, h2.hierarchy_role, 1 AS depth
          FROM org_hierarchy h
          LEFT JOIN org_hierarchy h2
            ON h2.org_id = h.org_id AND h2.user_id = h.reports_to
            AND h2.relationship_type = 'solid'
          WHERE h.org_id = $1 AND h.user_id = $2
            AND h.reports_to IS NOT NULL AND h.relationship_type = 'solid'

          UNION ALL

          SELECT h.reports_to AS user_id, h2.hierarchy_role, a.depth + 1
          FROM org_hierarchy h
          INNER JOIN ancestors a ON h.user_id = a.user_id
          LEFT JOIN org_hierarchy h2
            ON h2.org_id = h.org_id AND h2.user_id = h.reports_to
            AND h2.relationship_type = 'solid'
          WHERE h.org_id = $1 AND h.reports_to IS NOT NULL
            AND h.relationship_type = 'solid'
        )
        SELECT a.user_id, a.hierarchy_role, a.depth,
               u.first_name, u.last_name, u.email
        FROM ancestors a
        JOIN users u ON u.id = a.user_id
        ORDER BY a.depth ASC
      `, [orgId, userId]);
      return result.rows;
    } catch (err) {
      if (err.message?.includes('relation "org_hierarchy" does not exist')) return [];
      throw err;
    }
  },

  // ── getFullTree ──────────────────────────────────────────────
  async getFullTree(orgId) {
    try {
      const result = await pool.query(`
        SELECT
          h.id AS hierarchy_id,
          h.user_id, h.reports_to, h.hierarchy_role,
          h.relationship_type,
          h.created_at, h.updated_at,
          u.first_name, u.last_name, u.email,
          ou.role AS org_role, ou.is_active
        FROM org_hierarchy h
        JOIN users u ON u.id = h.user_id
        LEFT JOIN org_users ou ON ou.user_id = h.user_id AND ou.org_id = h.org_id
        WHERE h.org_id = $1
        ORDER BY h.relationship_type ASC, h.reports_to NULLS FIRST, u.first_name
      `, [orgId]);
      return result.rows;
    } catch (err) {
      if (err.message?.includes('relation "org_hierarchy" does not exist')) {
        await this.ensureTable();
        return [];
      }
      throw err;
    }
  },

  // ── isManagerOf ──────────────────────────────────────────────
  async isManagerOf(orgId, managerId, targetUserId) {
    if (managerId === targetUserId) return false;
    const subs = await this.getSubordinates(orgId, managerId);
    return subs.includes(targetUserId);
  },

  // ── setReportsTo ─────────────────────────────────────────────
  async setReportsTo(orgId, userId, reportsTo, hierarchyRole, relationshipType = 'solid') {
    if (reportsTo && relationshipType === 'solid') {
      const wouldBeCircular = await this.isManagerOf(orgId, userId, reportsTo);
      if (wouldBeCircular) {
        throw new Error('Circular reference: target user is a subordinate of this user');
      }
    }
    await this.ensureTable();

    if (relationshipType === 'solid') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM org_hierarchy WHERE org_id=$1 AND user_id=$2 AND relationship_type='solid'`,
          [orgId, userId]
        );
        const result = await client.query(`
          INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role, relationship_type)
          VALUES ($1, $2, $3, $4, 'solid') RETURNING *
        `, [orgId, userId, reportsTo || null, hierarchyRole || 'rep']);
        await client.query('COMMIT');
        return result.rows[0];
      } catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
    } else {
      const result = await pool.query(`
        INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role, relationship_type)
        VALUES ($1, $2, $3, $4, 'dotted')
        ON CONFLICT (org_id, user_id, reports_to)
        DO UPDATE SET hierarchy_role = COALESCE(EXCLUDED.hierarchy_role, org_hierarchy.hierarchy_role),
                      relationship_type = 'dotted', updated_at = NOW()
        RETURNING *
      `, [orgId, userId, reportsTo, hierarchyRole || 'rep']);
      return result.rows[0];
    }
  },

  // ── removeDottedLine ─────────────────────────────────────────
  async removeDottedLine(orgId, userId, managerId) {
    const result = await pool.query(
      `DELETE FROM org_hierarchy
       WHERE org_id=$1 AND user_id=$2 AND reports_to=$3 AND relationship_type='dotted'
       RETURNING id`,
      [orgId, userId, managerId]
    );
    return result.rowCount > 0;
  },

  // ── removeFromHierarchy ──────────────────────────────────────
  async removeFromHierarchy(orgId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT reports_to FROM org_hierarchy
         WHERE org_id=$1 AND user_id=$2 AND relationship_type='solid'`,
        [orgId, userId]
      );
      const parentId = current.rows[0]?.reports_to || null;

      // Re-parent solid direct reports
      await client.query(
        `UPDATE org_hierarchy SET reports_to=$1, updated_at=NOW()
         WHERE org_id=$2 AND reports_to=$3 AND relationship_type='solid'`,
        [parentId, orgId, userId]
      );
      // Delete dotted lines pointing to this user
      await client.query(
        `DELETE FROM org_hierarchy WHERE org_id=$1 AND reports_to=$2 AND relationship_type='dotted'`,
        [orgId, userId]
      );
      // Delete all of this user's records
      await client.query(
        `DELETE FROM org_hierarchy WHERE org_id=$1 AND user_id=$2`,
        [orgId, userId]
      );
      await client.query('COMMIT');
      return { removedUserId: userId, reParentedTo: parentId };
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  },

  // ── bulkUpdate ───────────────────────────────────────────────
  async bulkUpdate(orgId, entries) {
    await this.ensureTable();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const entry of entries) {
        const relType = entry.relationshipType || 'solid';
        if (relType === 'solid') {
          await client.query(
            `DELETE FROM org_hierarchy WHERE org_id=$1 AND user_id=$2 AND relationship_type='solid'`,
            [orgId, entry.userId]
          );
          const r = await client.query(`
            INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role, relationship_type)
            VALUES ($1,$2,$3,$4,'solid') RETURNING *
          `, [orgId, entry.userId, entry.reportsTo || null, entry.hierarchyRole || 'rep']);
          results.push(r.rows[0]);
        } else {
          const r = await client.query(`
            INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role, relationship_type)
            VALUES ($1,$2,$3,$4,'dotted')
            ON CONFLICT (org_id, user_id, reports_to)
            DO UPDATE SET hierarchy_role=COALESCE(EXCLUDED.hierarchy_role, org_hierarchy.hierarchy_role),
                          relationship_type='dotted', updated_at=NOW()
            RETURNING *
          `, [orgId, entry.userId, entry.reportsTo, entry.hierarchyRole || 'rep']);
          results.push(r.rows[0]);
        }
      }
      await client.query('COMMIT');
      return results;
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  },
};

module.exports = hierarchyService;
