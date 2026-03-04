// services/orgHierarchyService.js
// Handles contact reporting structure + account parent/subsidiary hierarchy
//
// v2 additions:
//   - reports_to_confidence ('confirmed' | 'best_guess') on contact reporting lines
//   - contact_dotted_lines table for secondary/matrix/cross-team reporting
//   - unplaced contacts returned separately from tree roots

const { pool } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT ORG CHART
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the full contact tree for an account plus unplaced contacts.
 * Also enriches each contact with their dotted-line managers (cross-account).
 */
async function getContactOrgChart(orgId, accountId) {
  const { rows } = await pool.query(
    `SELECT
       c.id, c.first_name, c.last_name, c.email, c.title,
       c.org_chart_title, c.org_chart_seniority,
       c.reports_to_contact_id, c.reports_to_confidence,
       c.role_type, c.engagement_level,
       c.account_id, c.linkedin_url
     FROM contacts c
     WHERE c.org_id = $1 AND c.account_id = $2 AND c.deleted_at IS NULL
     ORDER BY c.org_chart_seniority DESC NULLS LAST, c.last_name`,
    [orgId, accountId]
  );

  // Enrich with dotted-line managers (cross-account supported)
  const contactIds = rows.map(r => r.id);
  const dottedMap = {};
  if (contactIds.length > 0) {
    const { rows: dottedRows } = await pool.query(
      `SELECT
         cdl.contact_id,
         cdl.notes,
         m.id           AS manager_id,
         m.first_name   AS manager_first_name,
         m.last_name    AS manager_last_name,
         m.org_chart_title AS manager_org_chart_title,
         m.title        AS manager_title,
         a.name         AS manager_account_name
       FROM contact_dotted_lines cdl
       JOIN contacts m ON m.id = cdl.dotted_manager_id AND m.deleted_at IS NULL
       LEFT JOIN accounts a ON a.id = m.account_id
       WHERE cdl.org_id = $1 AND cdl.contact_id = ANY($2)
       ORDER BY m.last_name`,
      [orgId, contactIds]
    );
    dottedRows.forEach(d => {
      if (!dottedMap[d.contact_id]) dottedMap[d.contact_id] = [];
      dottedMap[d.contact_id].push({
        id:           d.manager_id,
        first_name:   d.manager_first_name,
        last_name:    d.manager_last_name,
        title:        d.manager_org_chart_title || d.manager_title,
        account_name: d.manager_account_name,
        notes:        d.notes,
      });
    });
  }

  const enriched = rows.map(r => ({ ...r, dotted_line_managers: dottedMap[r.id] || [] }));
  const { tree, unplaced } = buildTree(enriched);
  return { tree, unplaced };
}

/**
 * Build nested tree from flat rows.
 * unplaced = contacts where reports_to_contact_id IS NULL (no manager assigned at all)
 * roots    = contacts whose manager is outside this account (shown as tree roots)
 */
function buildTree(rows) {
  const map = {};
  rows.forEach(r => { map[r.id] = { ...r, children: [] }; });

  const roots    = [];
  const unplaced = [];

  rows.forEach(r => {
    const parentId = r.reports_to_contact_id;
    if (!parentId) {
      unplaced.push(map[r.id]);
    } else if (map[parentId]) {
      map[parentId].children.push(map[r.id]);
    } else {
      // Manager exists but is in a different account — treat as tree root
      roots.push(map[r.id]);
    }
  });

  return { tree: roots, unplaced };
}

/**
 * Returns position of a single contact: manager, direct reports, dotted lines.
 * Used for the mini-tree on the Contact detail panel.
 */
async function getContactPosition(orgId, contactId) {
  const { rows: [contact] } = await pool.query(
    `SELECT c.id, c.first_name, c.last_name, c.title, c.org_chart_title,
            c.reports_to_contact_id, c.reports_to_confidence,
            c.account_id, c.role_type, c.engagement_level
     FROM contacts c
     WHERE c.org_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`,
    [orgId, contactId]
  );
  if (!contact) return null;

  // Manager
  let manager = null;
  if (contact.reports_to_contact_id) {
    const { rows: [mgr] } = await pool.query(
      `SELECT id, first_name, last_name, title, org_chart_title, role_type,
              reports_to_contact_id
       FROM contacts
       WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [orgId, contact.reports_to_contact_id]
    );
    manager = mgr || null;
  }

  // Direct reports
  const { rows: directReports } = await pool.query(
    `SELECT id, first_name, last_name, title, org_chart_title, role_type, engagement_level
     FROM contacts
     WHERE org_id = $1 AND reports_to_contact_id = $2 AND deleted_at IS NULL
     ORDER BY org_chart_seniority DESC NULLS LAST, last_name`,
    [orgId, contactId]
  );

  // Peers (same manager, max 5)
  let peers = [];
  if (contact.reports_to_contact_id) {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, title, org_chart_title, role_type
       FROM contacts
       WHERE org_id = $1
         AND reports_to_contact_id = $2
         AND id != $3
         AND deleted_at IS NULL
       ORDER BY last_name LIMIT 5`,
      [orgId, contact.reports_to_contact_id, contactId]
    );
    peers = rows;
  }

  // Dotted-line managers this contact reports to (cross-account)
  const { rows: dottedManagers } = await pool.query(
    `SELECT
       m.id, m.first_name, m.last_name, m.title, m.org_chart_title,
       m.role_type, cdl.notes,
       a.name AS account_name
     FROM contact_dotted_lines cdl
     JOIN contacts m ON m.id = cdl.dotted_manager_id AND m.deleted_at IS NULL
     LEFT JOIN accounts a ON a.id = m.account_id
     WHERE cdl.org_id = $1 AND cdl.contact_id = $2
     ORDER BY m.last_name`,
    [orgId, contactId]
  );

  // Dotted-line reports — who reports dotted-line TO this contact
  const { rows: dottedReports } = await pool.query(
    `SELECT
       c.id, c.first_name, c.last_name, c.title, c.org_chart_title,
       c.role_type, cdl.notes,
       a.name AS account_name
     FROM contact_dotted_lines cdl
     JOIN contacts c ON c.id = cdl.contact_id AND c.deleted_at IS NULL
     LEFT JOIN accounts a ON a.id = c.account_id
     WHERE cdl.org_id = $1 AND cdl.dotted_manager_id = $2
     ORDER BY c.last_name`,
    [orgId, contactId]
  );

  return { contact, manager, directReports, peers, dottedManagers, dottedReports };
}

/**
 * Update a contact's reporting relationship.
 * confidence: 'confirmed' (default) | 'best_guess'
 * Pass reportsToContactId = null to make them unplaced.
 */
async function setReportsTo(orgId, contactId, reportsToContactId, confidence = 'confirmed') {
  if (reportsToContactId) {
    if (reportsToContactId === contactId) {
      throw new Error('A contact cannot report to themselves');
    }
    const isDescendant = await checkIsDescendant(orgId, reportsToContactId, contactId);
    if (isDescendant) {
      throw new Error('Cannot create a circular reporting relationship');
    }
  }

  const safeConfidence = ['confirmed', 'best_guess'].includes(confidence) ? confidence : 'confirmed';

  const { rows: [updated] } = await pool.query(
    `UPDATE contacts
     SET reports_to_contact_id = $1,
         reports_to_confidence  = $2
     WHERE org_id = $3 AND id = $4
     RETURNING id, first_name, last_name, reports_to_contact_id, reports_to_confidence`,
    [reportsToContactId || null, safeConfidence, orgId, contactId]
  );
  return updated;
}

/**
 * Add or update a dotted-line relationship between two contacts.
 * Both contacts must be in the same org; they can be in different accounts.
 */
async function addDottedLine(orgId, contactId, dottedManagerId, notes) {
  if (contactId === dottedManagerId) {
    throw new Error('A contact cannot dotted-line report to themselves');
  }
  const { rows: found } = await pool.query(
    `SELECT id FROM contacts
     WHERE org_id = $1 AND id = ANY($2) AND deleted_at IS NULL`,
    [orgId, [contactId, dottedManagerId]]
  );
  if (found.length < 2) {
    throw new Error('One or both contacts not found in this organisation');
  }
  const { rows: [row] } = await pool.query(
    `INSERT INTO contact_dotted_lines (org_id, contact_id, dotted_manager_id, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, contact_id, dotted_manager_id)
     DO UPDATE SET notes = EXCLUDED.notes, updated_at = NOW()
     RETURNING *`,
    [orgId, contactId, dottedManagerId, notes || null]
  );
  return row;
}

/**
 * Remove a dotted-line relationship.
 */
async function removeDottedLine(orgId, contactId, dottedManagerId) {
  const result = await pool.query(
    `DELETE FROM contact_dotted_lines
     WHERE org_id = $1 AND contact_id = $2 AND dotted_manager_id = $3
     RETURNING id`,
    [orgId, contactId, dottedManagerId]
  );
  return result.rowCount > 0;
}

/**
 * Update org_chart_title and/or org_chart_seniority for a contact.
 */
async function updateOrgChartMeta(orgId, contactId, { orgChartTitle, orgChartSeniority }) {
  const { rows: [updated] } = await pool.query(
    `UPDATE contacts
     SET org_chart_title     = COALESCE($1, org_chart_title),
         org_chart_seniority = COALESCE($2, org_chart_seniority)
     WHERE org_id = $3 AND id = $4
     RETURNING id, org_chart_title, org_chart_seniority`,
    [orgChartTitle ?? null, orgChartSeniority ?? null, orgId, contactId]
  );
  return updated;
}

/**
 * DFS check: is targetId a descendant of rootId?
 * Prevents circular reporting hierarchies.
 */
async function checkIsDescendant(orgId, rootId, targetId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM contacts WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id FROM contacts c
       INNER JOIN descendants d ON c.reports_to_contact_id = d.id
       WHERE c.org_id = $1 AND c.deleted_at IS NULL
     )
     SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
    [orgId, rootId, targetId]
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT HIERARCHY — unchanged from v1
// ─────────────────────────────────────────────────────────────────────────────

async function getAccountHierarchy(orgId, accountId) {
  const ancestors = await getAccountAncestors(orgId, accountId);
  const rootAccountId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : accountId;
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

  if (rows.length === 0) return null;
  const accountIds = rows.map(r => r.id);
  const { rows: dealStats } = await pool.query(
    `SELECT account_id,
            COUNT(*) FILTER (WHERE stage NOT IN ('closed_won','closed_lost')) AS active_deals,
            SUM(value) FILTER (WHERE stage NOT IN ('closed_lost')) AS total_arr
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
      totalArr:    parseFloat(statsMap[r.id]?.total_arr || 0),
      children:    [],
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

async function addAccountRelationship(orgId, parentAccountId, childAccountId, relationshipType, createdBy) {
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

async function canViewOrgChart(orgId, userId, accountId) {
  const { rows: [org] } = await pool.query(
    `SELECT settings FROM organizations WHERE id = $1`, [orgId]
  );
  const visibility = org?.settings?.org_chart_visibility || 'whole_org';
  if (visibility === 'whole_org') return true;

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
  addDottedLine,
  removeDottedLine,
  updateOrgChartMeta,
  getAccountHierarchy,
  addAccountRelationship,
  removeAccountRelationship,
  canViewOrgChart,
};
