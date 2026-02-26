// ─────────────────────────────────────────────────────────────────
// services/hierarchyService.js
//
// Recursive CTE queries for the org_hierarchy table.
// Used by orgContext middleware to populate req.subordinateIds
// and by orgAdmin routes for hierarchy CRUD.
// ─────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const hierarchyService = {

  // ── Ensure table exists (graceful first-run) ─────────────────
  async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS org_hierarchy (
        id             SERIAL PRIMARY KEY,
        org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reports_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        hierarchy_role VARCHAR(50) DEFAULT 'rep',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(org_id, user_id)
      )
    `);
  },

  // ── getSubordinates ──────────────────────────────────────────
  // Returns array of ALL user IDs that (directly or indirectly)
  // report to the given userId within the org. Does NOT include
  // the userId itself.
  async getSubordinates(orgId, userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE subordinates AS (
          -- Direct reports
          SELECT h.user_id
          FROM org_hierarchy h
          WHERE h.org_id = $1 AND h.reports_to = $2

          UNION ALL

          -- Indirect reports (recursive)
          SELECT h.user_id
          FROM org_hierarchy h
          INNER JOIN subordinates s ON h.reports_to = s.user_id
          WHERE h.org_id = $1
        )
        SELECT user_id FROM subordinates
      `, [orgId, userId]);

      return result.rows.map(r => r.user_id);
    } catch (err) {
      // Table might not exist yet
      if (err.message?.includes('relation "org_hierarchy" does not exist')) {
        return [];
      }
      throw err;
    }
  },

  // ── getDirectReports ─────────────────────────────────────────
  async getDirectReports(orgId, userId) {
    try {
      const result = await pool.query(`
        SELECT h.user_id, h.hierarchy_role,
               u.first_name, u.last_name, u.email
        FROM org_hierarchy h
        JOIN users u ON u.id = h.user_id
        WHERE h.org_id = $1 AND h.reports_to = $2
        ORDER BY u.first_name, u.last_name
      `, [orgId, userId]);
      return result.rows;
    } catch (err) {
      if (err.message?.includes('relation "org_hierarchy" does not exist')) return [];
      throw err;
    }
  },

  // ── getAncestors ─────────────────────────────────────────────
  // Returns the chain from userId up to the root (top of tree).
  // Result is ordered from immediate manager → root.
  async getAncestors(orgId, userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          -- Start: who does this user report to?
          SELECT h.reports_to AS user_id, h2.hierarchy_role, 1 AS depth
          FROM org_hierarchy h
          LEFT JOIN org_hierarchy h2 ON h2.org_id = h.org_id AND h2.user_id = h.reports_to
          WHERE h.org_id = $1 AND h.user_id = $2 AND h.reports_to IS NOT NULL

          UNION ALL

          -- Walk up
          SELECT h.reports_to AS user_id, h2.hierarchy_role, a.depth + 1
          FROM org_hierarchy h
          INNER JOIN ancestors a ON h.user_id = a.user_id
          LEFT JOIN org_hierarchy h2 ON h2.org_id = h.org_id AND h2.user_id = h.reports_to
          WHERE h.org_id = $1 AND h.reports_to IS NOT NULL
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
  // Returns every hierarchy row + user info for the entire org.
  // Frontend builds the tree structure from this flat list.
  async getFullTree(orgId) {
    try {
      const result = await pool.query(`
        SELECT
          h.id AS hierarchy_id,
          h.user_id,
          h.reports_to,
          h.hierarchy_role,
          h.created_at,
          h.updated_at,
          u.first_name,
          u.last_name,
          u.email,
          ou.role AS org_role,
          ou.is_active
        FROM org_hierarchy h
        JOIN users u ON u.id = h.user_id
        LEFT JOIN org_users ou ON ou.user_id = h.user_id AND ou.org_id = h.org_id
        WHERE h.org_id = $1
        ORDER BY h.reports_to NULLS FIRST, u.first_name, u.last_name
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
  // Returns true if managerId is a direct or indirect manager of targetUserId
  async isManagerOf(orgId, managerId, targetUserId) {
    if (managerId === targetUserId) return false;
    const subs = await this.getSubordinates(orgId, managerId);
    return subs.includes(targetUserId);
  },

  // ── setReportsTo ─────────────────────────────────────────────
  // Upserts a hierarchy record. Pass reportsTo=null to make user a root.
  async setReportsTo(orgId, userId, reportsTo, hierarchyRole) {
    // Prevent circular references
    if (reportsTo) {
      const wouldBeCircular = await this.isManagerOf(orgId, userId, reportsTo);
      if (wouldBeCircular) {
        throw new Error('Circular reference: target user is a subordinate of this user');
      }
    }

    await this.ensureTable();

    const result = await pool.query(`
      INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (org_id, user_id)
      DO UPDATE SET
        reports_to     = EXCLUDED.reports_to,
        hierarchy_role = COALESCE(EXCLUDED.hierarchy_role, org_hierarchy.hierarchy_role),
        updated_at     = NOW()
      RETURNING *
    `, [orgId, userId, reportsTo || null, hierarchyRole || 'rep']);

    return result.rows[0];
  },

  // ── removeFromHierarchy ──────────────────────────────────────
  // Removes a user from the hierarchy. Their direct reports become
  // reports of the removed user's manager (re-parenting).
  async removeFromHierarchy(orgId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find who this user reports to
      const current = await client.query(
        `SELECT reports_to FROM org_hierarchy WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId]
      );
      const parentId = current.rows[0]?.reports_to || null;

      // Re-parent direct reports to the removed user's manager
      await client.query(
        `UPDATE org_hierarchy SET reports_to = $1, updated_at = NOW()
         WHERE org_id = $2 AND reports_to = $3`,
        [parentId, orgId, userId]
      );

      // Delete the user's hierarchy record
      await client.query(
        `DELETE FROM org_hierarchy WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId]
      );

      await client.query('COMMIT');
      return { removedUserId: userId, reParentedTo: parentId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // ── bulkUpdate ───────────────────────────────────────────────
  // Accepts an array of { userId, reportsTo, hierarchyRole }
  // and upserts them all in a transaction.
  async bulkUpdate(orgId, entries) {
    await this.ensureTable();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const entry of entries) {
        const r = await client.query(`
          INSERT INTO org_hierarchy (org_id, user_id, reports_to, hierarchy_role)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (org_id, user_id)
          DO UPDATE SET
            reports_to     = EXCLUDED.reports_to,
            hierarchy_role = COALESCE(EXCLUDED.hierarchy_role, org_hierarchy.hierarchy_role),
            updated_at     = NOW()
          RETURNING *
        `, [orgId, entry.userId, entry.reportsTo || null, entry.hierarchyRole || 'rep']);
        results.push(r.rows[0]);
      }
      await client.query('COMMIT');
      return results;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = hierarchyService;
