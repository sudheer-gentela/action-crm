// services/orgHierarchyService.js
// Handles contact reporting structure + account parent/subsidiary hierarchy

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT ORG CHART
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the full contact tree for an account, structured as a nested array.
 * Root nodes are contacts with no reports_to_contact_id within this account.
 */
async function getContactOrgChart(orgId, accountId) {
  // Fetch all contacts for this account with their reporting relationships
  const { rows } = await pool.query(
    `SELECT
       c.id, c.first_name, c.last_name, c.email, c.title,
       c.org_chart_title, c.org_chart_seniority,
       c.reports_to_contact_id, c.role_type, c.engagement_level,
       c.account_id, c.linkedin_url
     FROM contacts c
     WHERE c.org_id = $1 AND c.account_id = $2
     ORDER BY c.org_chart_seniority DESC NULLS LAST, c.last_name`,
    [orgId, accountId]
  );

  return buildTree(rows);
}

/**
 * Build nested tree from flat rows.
 * Returns array of root nodes, each with a `children` array (recursive).
 */
function buildTree(rows) {
  const map = {};
  rows.forEach(r => { map[r.id] = { ...r, children: [] }; });

  const roots = [];
  rows.forEach(r => {
    const parentId = r.reports_to_contact_id;
    if (parentId && map[parentId]) {
      map[parentId].children.push(map[r.id]);
    } else {
      roots.push(map[r.id]);
    }
  });

  return roots;
}

/**
 * Returns the "position" of a single contact within the org chart:
 * their manager, their direct reports, and their siblings.
 * Used for the mini-tree on the Contact detail panel.
 */
async function getContactPosition(orgId, contactId) {
  const { rows: [contact] } = await pool.query(
    `SELECT c.id, c.first_name, c.last_name, c.title, c.org_chart_title,
            c.reports_to_contact_id, c.account_id, c.role_type, c.engagement_level
     FROM contacts c
     WHERE c.org_id = $1 AND c.id = $2`,
    [orgId, contactId]
  );

  if (!contact) return null;

  // Manager
  let manager = null;
  if (contact.reports_to_contact_id) {
    const { rows: [mgr] } = await pool.query(
      `SELECT id, first_name, last_name, title, org_chart_title, role_type,
              reports_to_contact_id
       FROM contacts WHERE org_id = $1 AND id = $2`,
      [orgId, contact.reports_to_contact_id]
    );
    manager = mgr || null;
  }

  // Direct reports
  const { rows: directReports } = await pool.query(
    `SELECT id, first_name, last_name, title, org_chart_title, role_type, engagement_level
     FROM contacts
     WHERE org_id = $1 AND reports_to_contact_id = $2
     ORDER BY org_chart_seniority DESC NULLS LAST, last_name`,
    [orgId, contactId]
  );

  // Peers (same manager, excluding self) — only show if ≤ 5 to keep mini-tree clean
  let peers = [];
  if (contact.reports_to_contact_id) {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, title, org_chart_title, role_type
       FROM contacts
       WHERE org_id = $1
         AND reports_to_contact_id = $2
         AND id != $3
       ORDER BY last_name
       LIMIT 5`,
      [orgId, contact.reports_to_contact_id, contactId]
    );
    peers = rows;
  }

  return { contact, manager, directReports, peers };
}

/**
 * Update a contact's reporting relationship.
 * Pass reportsToContactId = null to make them a root node.
 */
async function setReportsTo(orgId, contactId, reportsToContactId) {
  // Guard: prevent cycles (can't report to yourself or to a report of yours)
  if (reportsToContactId) {
    if (reportsToContactId === contactId) {
      throw new Error('A contact cannot report to themselves');
    }
    const isDescendant = await checkIsDescendant(orgId, reportsToContactId, contactId);
    if (isDescendant) {
      throw new Error('Cannot create a circular reporting relationship');
    }
  }

  const { rows: [updated] } = await pool.query(
    `UPDATE contacts
     SET reports_to_contact_id = $1
     WHERE org_id = $2 AND id = $3
     RETURNING id, first_name, last_name, reports_to_contact_id`,
    [reportsToContactId || null, orgId, contactId]
  );
  return updated;
}

/**
 * Update org_chart_title and/or org_chart_seniority for a contact.
 */
async function updateOrgChartMeta(orgId, contactId, { orgChartTitle, orgChartSeniority }) {
  const { rows: [updated] } = await pool.query(
    `UPDATE contacts
     SET org_chart_title      = COALESCE($1, org_chart_title),
         org_chart_seniority  = COALESCE($2, org_chart_seniority)
     WHERE org_id = $3 AND id = $4
     RETURNING id, org_chart_title, org_chart_seniority`,
    [orgChartTitle ?? null, orgChartSeniority ?? null, orgId, contactId]
  );
  return updated;
}

/**
 * DFS check: is targetId a descendant of rootId?
 * Used to prevent circular hierarchies.
 */
async function checkIsDescendant(orgId, rootId, targetId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM contacts WHERE org_id = $1 AND id = $2
       UNION ALL
       SELECT c.id FROM contacts c
       INNER JOIN descendants d ON c.reports_to_contact_id = d.id
       WHERE c.org_id = $1
     )
     SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
    [orgId, rootId, targetId]
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT HIERARCHY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get full account hierarchy tree for an account (up = parents, down = children).
 */
async function getAccountHierarchy(orgId, accountId) {
  // Walk up to find ultimate parent
  const ancestors = await getAccountAncestors(orgId, accountId);
  const rootAccountId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : accountId;

  // Walk down from root to get full tree
  const tree = await buildAccountTree(orgId, rootAccountId);
  return { rootAccountId, ancestors, tree };
}

async function getAccountAncestors(orgId, accountId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE ancestors AS (
       SELECT a.id, a.name, a.industry, ah.relationship_type, 1 AS depth
       FROM accounts a
       JOIN account_hierarchy ah ON ah.parent_account_id = a.id
       WHERE ah.org_id = $1 AND ah.child_account_id = $2
       UNION ALL
       SELECT a.id, a.name, a.industry, ah.relationship_type, anc.depth + 1
       FROM accounts a
       JOIN account_hierarchy ah ON ah.parent_account_id = a.id
       JOIN ancestors anc ON ah.child_account_id = anc.id
       WHERE ah.org_id = $1
     )
     SELECT * FROM ancestors ORDER BY depth DESC`,
    [orgId, accountId]
  );
  return rows;
}

async function buildAccountTree(orgId, rootId) {
  // Fetch all descendants
  const { rows } = await pool.query(
    `WITH RECURSIVE tree AS (
       SELECT a.id, a.name, a.industry, a.domain,
              NULL::integer AS parent_id, ah.relationship_type, 0 AS depth
       FROM accounts a
       LEFT JOIN account_hierarchy ah ON ah.child_account_id = a.id AND ah.org_id = $1
       WHERE a.org_id = $1 AND a.id = $2
       UNION ALL
       SELECT a.id, a.name, a.industry, a.domain,
              ah.parent_account_id AS parent_id, ah.relationship_type, t.depth + 1
       FROM accounts a
       JOIN account_hierarchy ah ON ah.child_account_id = a.id
       JOIN tree t ON ah.parent_account_id = t.id
       WHERE ah.org_id = $1
     )
     SELECT DISTINCT ON (id) * FROM tree ORDER BY id, depth`,
    [orgId, rootId]
  );

  // Enrich with deal counts + ARR
  if (rows.length === 0) return null;
  const accountIds = rows.map(r => r.id);
  const { rows: dealStats } = await pool.query(
    `SELECT account_id,
            COUNT(*) FILTER (WHERE stage NOT IN ('closed_won','closed_lost')) AS active_deals,
            SUM(amount) FILTER (WHERE stage NOT IN ('closed_lost')) AS total_arr
     FROM deals
     WHERE org_id = $1 AND account_id = ANY($2)
     GROUP BY account_id`,
    [orgId, accountIds]
  );
  const statsMap = {};
  dealStats.forEach(s => { statsMap[s.account_id] = s; });

  const map = {};
  rows.forEach(r => {
    map[r.id] = {
      ...r,
      activeDeals: parseInt(statsMap[r.id]?.active_deals || 0),
      totalArr: parseFloat(statsMap[r.id]?.total_arr || 0),
      children: []
    };
  });

  let root = null;
  rows.forEach(r => {
    if (r.parent_id && map[r.parent_id]) {
      map[r.parent_id].children.push(map[r.id]);
    } else {
      root = map[r.id];
    }
  });
  return root;
}

/**
 * Add a parent→child relationship between two accounts.
 */
async function addAccountRelationship(orgId, parentAccountId, childAccountId, relationshipType, createdBy) {
  // Prevent self-relationship
  if (parentAccountId === childAccountId) {
    throw new Error('An account cannot be its own parent');
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO account_hierarchy (org_id, parent_account_id, child_account_id, relationship_type, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, parent_account_id, child_account_id) DO UPDATE
       SET relationship_type = EXCLUDED.relationship_type
     RETURNING *`,
    [orgId, parentAccountId, childAccountId, relationshipType || 'subsidiary', createdBy]
  );
  return row;
}

/**
 * Remove a parent→child relationship.
 */
async function removeAccountRelationship(orgId, parentAccountId, childAccountId) {
  await pool.query(
    `DELETE FROM account_hierarchy
     WHERE org_id = $1 AND parent_account_id = $2 AND child_account_id = $3`,
    [orgId, parentAccountId, childAccountId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIBILITY CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a user can view the org chart for a given account.
 * Respects org-level visibility setting (whole_org vs deal_team).
 */
async function canViewOrgChart(orgId, userId, accountId) {
  const { rows: [org] } = await pool.query(
    `SELECT settings FROM organizations WHERE id = $1`,
    [orgId]
  );
  const visibility = org?.settings?.org_chart_visibility || 'whole_org';

  if (visibility === 'whole_org') return true;

  // 'deal_team' — user must be on a deal team for a deal associated with this account
  const { rows } = await pool.query(
    `SELECT 1
     FROM deal_team_members dtm
     JOIN deals d ON d.id = dtm.deal_id
     WHERE d.org_id = $1 AND d.account_id = $2 AND dtm.user_id = $3
     LIMIT 1`,
    [orgId, accountId, userId]
  );
  return rows.length > 0;
}

module.exports = {
  getContactOrgChart,
  getContactPosition,
  setReportsTo,
  updateOrgChartMeta,
  getAccountHierarchy,
  addAccountRelationship,
  removeAccountRelationship,
  canViewOrgChart,
};
