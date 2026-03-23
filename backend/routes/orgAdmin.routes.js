// ─────────────────────────────────────────────────────────────────────────────
// orgAdmin.routes.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

router.use(authenticateToken, orgContext);

const adminOnly = requireRole('owner', 'admin');

// ── Org Profile ───────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE 1 — Replace the existing GET /profile handler with this version.
// The only addition is the `modules` field at the bottom of the response.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/profile', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, status, plan, max_users, created_at, settings FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    const org      = result.rows[0];
    const settings = org.settings || {};
    const rawMods  = settings.modules || {};

    const MODULE_KEYS = ['prospecting', 'contracts', 'handovers', 'service', 'agency'];

    // Normalize all modules into { allowed, enabled } regardless of legacy shape
    const modules = {};
    for (const key of MODULE_KEYS) {
      const raw = rawMods[key];
      if (raw === null || raw === undefined) {
        modules[key] = { allowed: false, enabled: false };
      } else if (typeof raw === 'object') {
        modules[key] = { allowed: !!raw.allowed, enabled: !!raw.enabled };
      } else {
        // Legacy boolean/string scalar — treat as allowed + enabled
        const b = raw === true || raw === 'true';
        modules[key] = { allowed: b, enabled: b };
      }
    }

    // Return both the org row AND a normalised modules map at the top level
    // so OrgAdminView / OAModules can read r.data.modules without digging into settings
    res.json({ org, modules });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});


//router.patch('/profile', adminOnly, async (req, res) => {
//  try {
//    const { name } = req.body;
//    if (!name?.trim()) {
//      return res.status(400).json({ error: { message: 'Name is required' } });
//    }
//    const result = await pool.query(
//      `UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id, name`,
//      [name.trim(), req.orgId]
//    );
//    res.json({ org: result.rows[0] });
//  } catch (err) {
//    res.status(500).json({ error: { message: err.message } });
//  }
//});

// ── Members ───────────────────────────────────────────────────────────────────

router.get('/members', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ou.user_id, ou.role, ou.is_active, ou.joined_at,
        u.email,
        u.first_name || ' ' || u.last_name AS name,
        (SELECT COUNT(*) FROM actions a
         WHERE a.user_id = ou.user_id AND a.org_id = ou.org_id) AS action_count
      FROM org_users ou
      JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1
      ORDER BY ou.role, u.first_name
    `, [req.orgId]);

    res.json({ members: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.patch('/members/:userId', adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role }   = req.body;

    const VALID_ROLES = ['owner', 'admin', 'member', 'viewer'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: { message: `Role must be one of: ${VALID_ROLES.join(', ')}` } });
    }

    if (role === 'owner') {
      const callerRole = await pool.query(
        `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`,
        [req.orgId, req.userId]
      );
      if (callerRole.rows[0]?.role !== 'owner') {
        return res.status(403).json({ error: { message: 'Only owners can promote to owner' } });
      }
    }

    const currentRole = await pool.query(
      `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`,
      [req.orgId, userId]
    );
    if (currentRole.rows[0]?.role === 'owner' && role !== 'owner') {
      const ownerCount = await pool.query(
        `SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND role = 'owner' AND is_active = TRUE`,
        [req.orgId]
      );
      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: { message: 'Cannot change the role of the last owner' } });
      }
    }

    const result = await pool.query(`
      UPDATE org_users SET role = $1
      WHERE org_id = $2 AND user_id = $3
      RETURNING *
    `, [role, req.orgId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Member not found in this org' } });
    }
    res.json({ membership: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/members/:userId', adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;

    if (parseInt(userId) === req.userId) {
      return res.status(400).json({ error: { message: 'You cannot remove yourself' } });
    }

    const targetRole = await pool.query(
      `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
      [req.orgId, userId]
    );
    if (targetRole.rows[0]?.role === 'owner') {
      const ownerCount = await pool.query(
        `SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND role = 'owner' AND is_active = TRUE`,
        [req.orgId]
      );
      if (parseInt(ownerCount.rows[0].count) <= 1) {
        return res.status(400).json({ error: { message: 'Cannot remove the last owner' } });
      }
    }

    await pool.query(
      `UPDATE org_users SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
      [req.orgId, userId]
    );
    res.json({ message: 'Member deactivated' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Invitations ───────────────────────────────────────────────────────────────

router.get('/invitations', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        oi.*,
        u.email AS invited_by_email,
        CASE
          WHEN oi.accepted_at IS NOT NULL          THEN 'accepted'
          WHEN oi.expires_at  < NOW()              THEN 'expired'
          ELSE                                          'pending'
        END AS status
      FROM   org_invitations oi
      LEFT JOIN users u ON u.id = oi.invited_by
      WHERE  oi.org_id = $1
      ORDER  BY oi.created_at DESC
    `, [req.orgId]);
    res.json({ invitations: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/invitations', adminOnly, async (req, res) => {
  try {
    const { email, role = 'member', message = '' } = req.body;

    if (!email?.trim()) {
      return res.status(400).json({ error: { message: 'Email is required' } });
    }

    const existing = await pool.query(`
      SELECT ou.user_id FROM org_users ou
      JOIN users u ON u.id = ou.user_id
      WHERE ou.org_id = $1 AND u.email = $2 AND ou.is_active = TRUE
    `, [req.orgId, email.trim()]);

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: { message: 'This person is already a member of your org' } });
    }

    const [countRow, orgRow] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE`, [req.orgId]),
      pool.query(`SELECT max_users FROM organizations WHERE id = $1`, [req.orgId]),
    ]);
    if (parseInt(countRow.rows[0].count) >= parseInt(orgRow.rows[0].max_users)) {
      return res.status(400).json({ error: { message: 'You have reached your user seat limit. Contact support to upgrade.' } });
    }

    const token   = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await pool.query(`
      INSERT INTO org_invitations
        (org_id, invited_by, email, role, message, token, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [req.orgId, req.userId, email.trim(), role, message, token, expires]);

    res.status(201).json({ invitation: result.rows[0], token });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/invitations/:id', adminOnly, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM org_invitations WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json({ message: 'Invitation cancelled' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get('/stats', adminOnly, async (req, res) => {
  try {
    const [members, deals, actions, invites] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_active = TRUE)  AS active,
          COUNT(*) FILTER (WHERE is_active = FALSE) AS inactive
        FROM org_users WHERE org_id = $1
      `, [req.orgId]),
      pool.query(`SELECT COUNT(*) AS total FROM deals WHERE org_id = $1`, [req.orgId]),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
          COUNT(*) FILTER (WHERE status = 'pending')                      AS pending
        FROM actions WHERE org_id = $1
      `, [req.orgId]),
      pool.query(`SELECT COUNT(*) AS total FROM org_invitations WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()`, [req.orgId]),
    ]);

    res.json({
      members:     members.rows[0],
      deals:       deals.rows[0],
      actions:     actions.rows[0],
      invitations: invites.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Duplicate Detection Settings ──────────────────────────────────────────────

// Any org member can read (needed to apply rules in contacts/accounts views)
router.get('/duplicate-settings', async (req, res) => {
  try {
    const result = await pool.query(`SELECT settings FROM organizations WHERE id = $1`, [req.orgId]);
    const settings = result.rows[0]?.settings || {};
    const dedupConfig = settings.duplicate_detection || {};

    res.json({
      duplicate_detection: {
        contact_email_match:        dedupConfig.contact_email_match !== false,
        contact_name_account_match: dedupConfig.contact_name_account_match !== false,
        contact_visibility:         dedupConfig.contact_visibility || 'org',
        account_domain_match:       dedupConfig.account_domain_match !== false,
        account_name_match:         dedupConfig.account_name_match !== false,
        account_visibility:         dedupConfig.account_visibility || 'org',
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch duplicate settings' } });
  }
});

// Only admins/owners can change
router.patch('/duplicate-settings', adminOnly, async (req, res) => {
  try {
    const allowed = [
      'contact_email_match', 'contact_name_account_match', 'contact_visibility',
      'account_domain_match', 'account_name_match', 'account_visibility',
    ];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key.endsWith('_visibility')) {
          patch[key] = req.body[key] === 'own' ? 'own' : 'org';
        } else {
          patch[key] = !!req.body[key];
        }
      }
    }

    const result = await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{duplicate_detection}',
         COALESCE(settings->'duplicate_detection', '{}'::jsonb) || $1::jsonb
       ),
       updated_at = NOW()
       WHERE id = $2
       RETURNING settings->'duplicate_detection' AS duplicate_detection`,
      [JSON.stringify(patch), req.orgId]
    );

    res.json({ duplicate_detection: result.rows[0]?.duplicate_detection || {} });
  } catch (err) {
    console.error('PATCH /org-admin/duplicate-settings error:', err);
    res.status(500).json({ error: { message: 'Failed to update duplicate settings' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET  /org/admin/pipeline-stages-settings
// PATCH /org/admin/pipeline-stages-settings
// ─────────────────────────────────────────────────────────────────────────────

router.get('/pipeline-stages-settings', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT settings FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const settings = result.rows[0]?.settings || {};
    res.json({
      pipeline_stages_show_terminal: settings.pipeline_stages_show_terminal === true,
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to fetch pipeline stage settings' } });
  }
});

router.patch('/pipeline-stages-settings', adminOnly, async (req, res) => {
  try {
    const { pipeline_stages_show_terminal } = req.body;
    if (typeof pipeline_stages_show_terminal !== 'boolean') {
      return res.status(400).json({ error: { message: 'pipeline_stages_show_terminal must be a boolean' } });
    }
    const result = await pool.query(
      `UPDATE organizations
       SET settings   = jsonb_set(COALESCE(settings, '{}'::jsonb), '{pipeline_stages_show_terminal}', $1::jsonb, true),
           updated_at = NOW()
       WHERE id = $2
       RETURNING settings->'pipeline_stages_show_terminal' AS pipeline_stages_show_terminal`,
      [pipeline_stages_show_terminal.toString(), req.orgId]
    );
    res.json({
      pipeline_stages_show_terminal: result.rows[0]?.pipeline_stages_show_terminal === true,
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update pipeline stage settings' } });
  }
});

// ── Org Integrations ─────────────────────────────────────────────────────────

/**
 * GET /org/admin/integrations
 * List all org-level integrations (creates org_integrations table if missing)
 */
router.get('/integrations', adminOnly, async (req, res) => {
  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS org_integrations (
        id             SERIAL PRIMARY KEY,
        org_id         INTEGER NOT NULL REFERENCES organizations(id),
        integration_type VARCHAR(50) NOT NULL,
        credentials    JSONB DEFAULT '{}',
        config         JSONB DEFAULT '{}',
        status         VARCHAR(20) DEFAULT 'inactive',
        last_synced_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(org_id, integration_type)
      )
    `);

    const result = await pool.query(
      `SELECT * FROM org_integrations WHERE org_id = $1 ORDER BY integration_type`,
      [req.orgId]
    );
    res.json({ integrations: result.rows });
  } catch (err) {
    console.error('GET /org-admin/integrations error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch integrations' } });
  }
});

/**
 * PATCH /org/admin/integrations/:type
 * Enable/disable an org-level integration (upsert)
 */
router.patch('/integrations/:type', adminOnly, async (req, res) => {
  try {
    const { type } = req.params;
    const { status, config } = req.body;

    const validTypes = ['microsoft', 'google'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: { message: `Invalid integration type: ${type}` } });
    }

    const validStatuses = ['active', 'inactive'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: { message: `Invalid status: ${status}` } });
    }

    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS org_integrations (
        id             SERIAL PRIMARY KEY,
        org_id         INTEGER NOT NULL REFERENCES organizations(id),
        integration_type VARCHAR(50) NOT NULL,
        credentials    JSONB DEFAULT '{}',
        config         JSONB DEFAULT '{}',
        status         VARCHAR(20) DEFAULT 'inactive',
        last_synced_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(org_id, integration_type)
      )
    `);

    const result = await pool.query(`
      INSERT INTO org_integrations (org_id, integration_type, status, config)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (org_id, integration_type)
      DO UPDATE SET
        status     = COALESCE($3, org_integrations.status),
        config     = COALESCE($4, org_integrations.config),
        updated_at = NOW()
      RETURNING *
    `, [
      req.orgId,
      type,
      status || 'inactive',
      config ? JSON.stringify(config) : '{}',
    ]);

    console.log(`🔌 Integration ${type} set to ${result.rows[0].status} for org ${req.orgId}`);
    res.json({ integration: result.rows[0] });
  } catch (err) {
    console.error('PATCH /org-admin/integrations/:type error:', err);
    res.status(500).json({ error: { message: 'Failed to update integration' } });
  }
});

// ── Org Hierarchy ────────────────────────────────────────────────────────────

const hierarchyService = require('../services/hierarchyService');

/**
 * GET /org/admin/hierarchy
 * Get the full hierarchy tree for this org.
 * Available to all authenticated org members (not just admins) so that
 * scope toggles can detect whether the user has subordinates.
 */
router.get('/hierarchy', async (req, res) => {
  try {
    const tree = await hierarchyService.getFullTree(req.orgId);
    res.json({ hierarchy: tree });
  } catch (err) {
    console.error('GET /org-admin/hierarchy error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch hierarchy' } });
  }
});

/**
 * GET /org/admin/hierarchy/my-team
 * Returns the current user's subordinates (for scope toggle detection).
 * Available to all members.
 */
router.get('/hierarchy/my-team', async (req, res) => {
  try {
    const userId = req.user.userId || req.userId;
    const subordinates = await hierarchyService.getSubordinates(req.orgId, userId);
    const directReports = await hierarchyService.getDirectReports(req.orgId, userId);
    res.json({
      subordinateIds: subordinates,
      directReports,
      hasTeam: subordinates.length > 0,
    });
  } catch (err) {
    console.error('GET /org-admin/hierarchy/my-team error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch team info' } });
  }
});

/**
 * PUT /org/admin/hierarchy/:userId
 * Set a user's reports_to, hierarchy_role, and relationship_type.
 * Admin-only.
 */
router.put('/hierarchy/:userId', adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reportsTo, hierarchyRole, relationshipType = 'solid' } = req.body;

    if (!['solid', 'dotted'].includes(relationshipType)) {
      return res.status(400).json({ error: { message: 'relationshipType must be solid or dotted' } });
    }

    // Validate target user belongs to this org
    const memberCheck = await pool.query(
      `SELECT user_id FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
      [req.orgId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found in this org' } });
    }

    // If reportsTo is set, validate that user also belongs to this org
    if (reportsTo) {
      const managerCheck = await pool.query(
        `SELECT user_id FROM org_users WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE`,
        [req.orgId, reportsTo]
      );
      if (managerCheck.rows.length === 0) {
        return res.status(400).json({ error: { message: 'Manager not found in this org' } });
      }
    }

    const result = await hierarchyService.setReportsTo(
      req.orgId,
      parseInt(userId),
      reportsTo ? parseInt(reportsTo) : null,
      hierarchyRole || 'rep',
      relationshipType
    );

    res.json({ hierarchy: result });
  } catch (err) {
    if (err.message?.includes('Circular reference')) {
      return res.status(400).json({ error: { message: err.message } });
    }
    console.error('PUT /org-admin/hierarchy/:userId error:', err);
    res.status(500).json({ error: { message: 'Failed to update hierarchy' } });
  }
});

/**
 * POST /org/admin/hierarchy/bulk
 * Bulk update hierarchy (array of { userId, reportsTo, hierarchyRole }).
 * Admin-only.
 */
router.post('/hierarchy/bulk', adminOnly, async (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: { message: 'entries array is required' } });
    }

    const results = await hierarchyService.bulkUpdate(req.orgId, entries);
    res.json({ hierarchy: results });
  } catch (err) {
    console.error('POST /org-admin/hierarchy/bulk error:', err);
    res.status(500).json({ error: { message: 'Failed to bulk update hierarchy' } });
  }
});

/**
 * DELETE /org/admin/hierarchy/:userId/dotted/:managerId
 * Remove a specific dotted-line relationship.
 * Admin-only.
 */
router.delete('/hierarchy/:userId/dotted/:managerId', adminOnly, async (req, res) => {
  try {
    const removed = await hierarchyService.removeDottedLine(
      req.orgId, parseInt(req.params.userId), parseInt(req.params.managerId)
    );
    if (!removed) {
      return res.status(404).json({ error: { message: 'Dotted-line relationship not found' } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /org-admin/hierarchy/:userId/dotted/:managerId error:', err);
    res.status(500).json({ error: { message: 'Failed to remove dotted line' } });
  }
});

/**
 * DELETE /org/admin/hierarchy/:userId
 * Remove a user from the hierarchy (re-parents their reports).
 * Admin-only.
 */
router.delete('/hierarchy/:userId', adminOnly, async (req, res) => {
  try {
    const result = await hierarchyService.removeFromHierarchy(req.orgId, parseInt(req.params.userId));
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('DELETE /org-admin/hierarchy/:userId error:', err);
    res.status(500).json({ error: { message: 'Failed to remove from hierarchy' } });
  }
});

// ── Module Toggles ────────────────────────────────────────────────────────────
// These endpoints must NOT be gated by requireModule — they control module state.
// requireModule.invalidate ensures the cache is cleared immediately after toggle.

const requireModule = require('../middleware/requireModule.middleware');

const MODULE_KEYS    = ['prospecting', 'contracts', 'handovers', 'service', 'agency'];
const MODULE_LABELS  = {
  prospecting: 'Prospecting',
  contracts:   'Contract Lifecycle Management',
  handovers:   'Sales → Implementation Handover',
  service:     'Customer Support & Service',
  agency:      'Agency Client Management',
};

// Generic module toggle — replaces the individual per-module routes
// PATCH /org/admin/module/:moduleName
router.patch('/module/:moduleName', adminOnly, async (req, res) => {
  try {
    const { moduleName } = req.params;

    if (!MODULE_KEYS.includes(moduleName)) {
      return res.status(400).json({ error: { message: `Unknown module: ${moduleName}` } });
    }

    const enabled = req.body.enabled === true || req.body.enabled === 'true';
    const label   = MODULE_LABELS[moduleName] || moduleName;

    // Read current settings
    const current = await pool.query(
      `SELECT settings->'modules'->$2 AS module_val FROM organizations WHERE id = $1`,
      [req.orgId, moduleName]
    );

    const raw     = current.rows[0]?.module_val ?? null;
    let   allowed = false;

    if (raw === null || raw === undefined) {
      allowed = false;
    } else if (typeof raw === 'object') {
      allowed = !!raw.allowed;
    } else {
      // Legacy scalar — treat as allowed
      allowed = raw === true || raw === 'true';
    }

    // Enforce platform provisioning: org admins cannot enable a module that
    // the super admin has not provisioned for their org.
    if (enabled && !allowed) {
      return res.status(403).json({
        error: {
          message: `The ${label} module has not been provisioned for your organisation. Contact support to enable it.`,
          code: 'MODULE_NOT_ALLOWED',
        },
      });
    }

    // Write the new object shape, preserving the allowed flag
    const newValue = { allowed, enabled };

    await pool.query(
      `UPDATE organizations
          SET settings   = jsonb_set(
                             jsonb_set(COALESCE(settings, '{}'::jsonb), '{modules}', COALESCE(settings->'modules', '{}'::jsonb), true),
                             $3::text[],
                             $2::jsonb,
                             true
                           ),
              updated_at = NOW()
        WHERE id = $1`,
      [req.orgId, JSON.stringify(newValue), `{modules,${moduleName}}`]
    );

    requireModule.invalidate(req.orgId, moduleName);
    console.log(`🧩 ${label} module ${enabled ? 'enabled' : 'disabled'} for org ${req.orgId}`);

    res.json({ enabled, allowed });
  } catch (err) {
    console.error(`PATCH /org/admin/module/${req.params.moduleName} error:`, err);
    res.status(500).json({ error: { message: `Failed to update module` } });
  }
});


// ── Playbook Types (configurable per org) ────────────────────────────────────
// Stored in organizations.settings->'playbook_types' as a JSON array.
// System types (sales, prospecting) cannot be removed or renamed.

// Helper: get org's playbook types.
// Returns exactly what is stored in the DB — no injection, no defaults added.
// If nothing is stored, returns an empty array.
async function getPlaybookTypes(orgId) {
  const result = await pool.query(
    `SELECT settings->'playbook_types' AS types FROM organizations WHERE id = $1`,
    [orgId]
  );
  const stored = result.rows[0]?.types;
  if (!stored || !Array.isArray(stored)) return [];
  return stored;
}

// GET — any member can read (needed for playbook create form)
router.get('/playbook-types', async (req, res) => {
  try {
    const types = await getPlaybookTypes(req.orgId);
    res.json({ playbook_types: types });
  } catch (err) {
    console.error('GET /org-admin/playbook-types error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch playbook types' } });
  }
});

// POST — add a new custom type (admin only)
router.post('/playbook-types', adminOnly, async (req, res) => {
  try {
    const { key, label, icon, color } = req.body;

    if (!key?.trim() || !label?.trim()) {
      return res.status(400).json({ error: { message: 'key and label are required' } });
    }

    const safeKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (safeKey.length < 2) {
      return res.status(400).json({ error: { message: 'key must be at least 2 characters (letters, numbers, underscores)' } });
    }

    const existing = await getPlaybookTypes(req.orgId);
    if (existing.some(t => t.key === safeKey)) {
      return res.status(409).json({ error: { message: `A playbook type with key "${safeKey}" already exists` } });
    }

    const newType = {
      key: safeKey,
      label: label.trim(),
      icon: icon || '📂',
      color: color || '#6b7280',
      is_system: false,
    };

    const updated = [...existing, newType];

    await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{playbook_types}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(updated), req.orgId]
    );

    res.status(201).json({ playbook_types: updated, created: newType });
  } catch (err) {
    console.error('POST /org-admin/playbook-types error:', err);
    res.status(500).json({ error: { message: 'Failed to create playbook type' } });
  }
});

// PUT — update a custom type (admin only, cannot edit system types)
router.put('/playbook-types/:typeKey', adminOnly, async (req, res) => {
  try {
    const { typeKey } = req.params;
    const { label, icon, color } = req.body;

    const existing = await getPlaybookTypes(req.orgId);
    const idx = existing.findIndex(t => t.key === typeKey);
    if (idx === -1) {
      return res.status(404).json({ error: { message: `Playbook type "${typeKey}" not found` } });
    }
    if (existing[idx].is_system) {
      return res.status(403).json({ error: { message: 'System playbook types cannot be modified' } });
    }

    if (label?.trim())  existing[idx].label = label.trim();
    if (icon)           existing[idx].icon  = icon;
    if (color)          existing[idx].color = color;

    await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{playbook_types}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(existing), req.orgId]
    );

    res.json({ playbook_types: existing, updated: existing[idx] });
  } catch (err) {
    console.error('PUT /org-admin/playbook-types error:', err);
    res.status(500).json({ error: { message: 'Failed to update playbook type' } });
  }
});

// DELETE — remove a custom type (admin only, cannot delete system types)
// Blocks deletion if playbooks of this type exist.
router.delete('/playbook-types/:typeKey', adminOnly, async (req, res) => {
  try {
    const { typeKey } = req.params;

    const existing = await getPlaybookTypes(req.orgId);
    const target = existing.find(t => t.key === typeKey);
    if (!target) {
      return res.status(404).json({ error: { message: `Playbook type "${typeKey}" not found` } });
    }
    if (target.is_system) {
      return res.status(403).json({ error: { message: 'System playbook types cannot be deleted' } });
    }

    // Check if any playbooks use this type
    const usage = await pool.query(
      `SELECT COUNT(*) AS count FROM playbooks WHERE org_id = $1 AND type = $2`,
      [req.orgId, typeKey]
    );
    if (parseInt(usage.rows[0].count) > 0) {
      return res.status(409).json({
        error: { message: `Cannot delete — ${usage.rows[0].count} playbook(s) are using this type. Reassign them first.` },
      });
    }

    const updated = existing.filter(t => t.key !== typeKey);

    await pool.query(
      `UPDATE organizations
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{playbook_types}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(updated), req.orgId]
    );

    res.json({ playbook_types: updated, deleted: typeKey });
  } catch (err) {
    console.error('DELETE /org-admin/playbook-types error:', err);
    res.status(500).json({ error: { message: 'Failed to delete playbook type' } });
  }
});


// ── Playbook Stages ──────────────────────────────────────────────────────────
// All pipeline types now use pipeline_stages (org-wide, keyed by pipeline name).
// The pipeline name matches the playbook type:
//   sales / custom / market / product → pipeline = 'sales'
//   prospecting                       → pipeline = 'prospecting'
//   clm / service / handover_s2i      → pipeline = type key
//
// GET  /org/admin/playbook-stages/:playbookId — returns stages for a specific playbook
// PUT  /org/admin/playbook-stages/:playbookId — replaces all stages for a playbook (admin)

const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];

// GET — any member can read (needed for PlaybookPlaysEditor)
router.get('/playbook-stages/:playbookId', async (req, res) => {
  try {
    const playbookId = parseInt(req.params.playbookId, 10);
    if (!playbookId) return res.status(400).json({ error: { message: 'Invalid playbookId' } });

    // Verify playbook belongs to this org
    const pbResult = await pool.query(
      `SELECT id, type FROM playbooks WHERE id = $1 AND org_id = $2`,
      [playbookId, req.orgId]
    );
    if (!pbResult.rows.length) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    const { type: playbookType } = pbResult.rows[0];

    // Map playbook type → pipeline key
    const pipeline = SALES_LEGACY_TYPES.includes(playbookType) ? 'sales'
      : playbookType === 'prospecting' ? 'prospecting'
      : playbookType; // clm, service, handover_s2i, or any custom type

    // Read org settings for terminal stage visibility
    const orgRow = await pool.query(
      `SELECT settings FROM organizations WHERE id = $1`, [req.orgId]
    );
    const showTerminal = orgRow.rows[0]?.settings?.pipeline_stages_show_terminal === true;

    const result = await pool.query(
      `SELECT id, pipeline, key, name, stage_type, sort_order, is_active, is_terminal
       FROM pipeline_stages
       WHERE org_id = $1 AND pipeline = $2
         ${showTerminal ? '' : 'AND is_terminal = FALSE'}
       ORDER BY sort_order ASC, id ASC`,
      [req.orgId, pipeline]
    );

    res.json({ playbookId, type: playbookType, pipeline, stages: result.rows });
  } catch (err) {
    console.error('GET /org-admin/playbook-stages error:', err);
    res.status(500).json({ error: { message: 'Failed to fetch playbook stages' } });
  }
});

// PUT — admin only, replaces all stages for a playbook
router.put('/playbook-stages/:playbookId', adminOnly, async (req, res) => {
  try {
    const playbookId = parseInt(req.params.playbookId, 10);
    if (!playbookId) return res.status(400).json({ error: { message: 'Invalid playbookId' } });

    const { stages } = req.body;
    if (!Array.isArray(stages)) {
      return res.status(400).json({ error: { message: 'stages must be an array' } });
    }

    // Verify playbook belongs to this org
    const pbResult = await pool.query(
      `SELECT id, type FROM playbooks WHERE id = $1 AND org_id = $2`,
      [playbookId, req.orgId]
    );
    if (!pbResult.rows.length) {
      return res.status(404).json({ error: { message: 'Playbook not found' } });
    }
    const { type: playbookType } = pbResult.rows[0];

    // All pipeline types are managed via pipeline_stages (org-wide), not per-playbook.
    // This PUT endpoint is therefore disabled — stages are edited via OAStages / pipeline-stages routes.
    return res.status(400).json({
      error: { message: `Stages are managed org-wide via pipeline settings, not per-playbook. Use the Stages tab in Org Admin.` }
    });

    // Validate
    for (const s of stages) {
      if (!s.key?.trim()) return res.status(400).json({ error: { message: 'Each stage must have a key' } });
      if (!s.name?.trim()) return res.status(400).json({ error: { message: 'Each stage must have a name' } });
    }

    // Normalise
    const normalised = stages.map((s, i) => ({
      key:        s.key.trim().toLowerCase().replace(/\s+/g, '_'),
      name:       s.name.trim(),
      sort_order: s.sort_order ?? i + 1,
      is_active:  s.is_active  ?? true,
      is_terminal: s.is_terminal ?? false,
    }));

    // Replace all stages for this playbook in a transaction
    await pool.query('BEGIN');
    try {
      await pool.query(
        `DELETE FROM playbook_stages WHERE playbook_id = $1`,
        [playbookId]
      );
      for (const s of normalised) {
        await pool.query(
          `INSERT INTO playbook_stages (org_id, playbook_id, key, name, sort_order, is_active, is_terminal)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.orgId, playbookId, s.key, s.name, s.sort_order, s.is_active, s.is_terminal]
        );
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    res.json({ playbookId, type: playbookType, stages: normalised });
  } catch (err) {
    console.error('PUT /org-admin/playbook-stages error:', err);
    res.status(500).json({ error: { message: 'Failed to update playbook stages' } });
  }
});


// ── Prospecting AI Config ─────────────────────────────────────────────────────
// Stored in org_integrations (integration_type='prospecting') config JSONB.
// Separate from the module toggle — just the AI settings (model, provider, context, prompts).

/**
 * GET /org/admin/prospecting/ai-config
 * Returns the org's prospecting AI defaults.
 */
router.get('/prospecting/ai-config', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT config FROM org_integrations
       WHERE org_id = $1 AND integration_type = 'prospecting'`,
      [req.orgId]
    );
    const config = result.rows[0]?.config || {};
    res.json({
      ai_provider:     config.ai_provider     || 'anthropic',
      ai_model:        config.ai_model        || 'claude-haiku-4-5-20251001',
      product_context: config.product_context || '',
    });
  } catch (err) {
    console.error('GET /org/admin/prospecting/ai-config error:', err);
    res.status(500).json({ error: { message: 'Failed to load prospecting AI config' } });
  }
});

/**
 * PATCH /org/admin/prospecting/ai-config
 * Upserts org prospecting AI defaults.
 * Body: { ai_provider, ai_model, product_context }
 */
router.patch('/prospecting/ai-config', adminOnly, async (req, res) => {
  try {
    const ALLOWED = ['ai_provider', 'ai_model', 'product_context'];
    const patch = {};
    for (const key of ALLOWED) {
      if (key in req.body) patch[key] = req.body[key];
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'No valid config keys supplied' } });
    }

    await pool.query(`
      INSERT INTO org_integrations (org_id, integration_type, config, status)
      VALUES ($1, 'prospecting', $2::jsonb, 'active')
      ON CONFLICT (org_id, integration_type) DO UPDATE
      SET config     = org_integrations.config || $2::jsonb,
          updated_at = CURRENT_TIMESTAMP
    `, [req.orgId, JSON.stringify(patch)]);

    // Return updated config
    const result = await pool.query(
      `SELECT config FROM org_integrations WHERE org_id = $1 AND integration_type = 'prospecting'`,
      [req.orgId]
    );
    const config = result.rows[0]?.config || {};
    console.log(`🤖 Prospecting AI config updated for org ${req.orgId}:`, patch);
    res.json({
      ai_provider:     config.ai_provider     || 'anthropic',
      ai_model:        config.ai_model        || 'claude-haiku-4-5-20251001',
      product_context: config.product_context || '',
    });
  } catch (err) {
    console.error('PATCH /org/admin/prospecting/ai-config error:', err);
    res.status(500).json({ error: { message: 'Failed to save prospecting AI config' } });
  }
});


/**
 * GET /org/admin/email-settings
 * Returns the org's email filter config merged with platform defaults.
 */
router.get('/email-settings', adminOnly, async (req, res) => {
  try {
    const PLATFORM_DEFAULTS = {
      blocked_domains: [
        'accountprotection.microsoft.com',
        'communication.microsoft.com',
        'promomail.microsoft.com',
        'infoemails.microsoft.com',
        'engage.microsoft.com',
        'account.microsoft.com',
        'mail.onedrive.com',
        'microsoft.com',
        'googlemail.com',
      ],
      blocked_local_patterns: [
        'noreply', 'no-reply', 'donotreply', 'do-not-reply',
        'mailer-daemon', 'postmaster', 'bounce', 'notifications', 'unsubscribe',
      ],
    };

    const result = await pool.query(
      `SELECT settings->'email_filter' AS email_filter FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const orgFilter = result.rows[0]?.email_filter || {};

    // Derive internal domain(s) from user emails for display
    const domainResult = await pool.query(
      `SELECT DISTINCT LOWER(split_part(email, '@', 2)) AS domain
       FROM users
       WHERE org_id = $1
         AND email IS NOT NULL
         AND email NOT LIKE '%@gmail%'
         AND email NOT LIKE '%@yahoo%'
         AND email NOT LIKE '%@hotmail%'
         AND email NOT LIKE '%@outlook%'`,
      [req.orgId]
    );
    const internalDomains = domainResult.rows.map(r => r.domain).filter(d => d && d.includes('.'));

    // Account domain coverage
    const accountResult = await pool.query(
      `SELECT
         COUNT(*)                                                         AS total,
         COUNT(*) FILTER (WHERE domain IS NOT NULL
                            AND domain != ''
                            AND domain LIKE '%.%')                       AS have_domain,
         COUNT(*) FILTER (WHERE domain IS NULL OR domain = '')           AS missing_domain
       FROM accounts
       WHERE org_id = $1 AND deleted_at IS NULL`,
      [req.orgId]
    );
    const accountCoverage = accountResult.rows[0];

    res.json({
      platform_defaults:       PLATFORM_DEFAULTS,
      org_blocked_domains:     orgFilter.blocked_domains      || [],
      org_blocked_patterns:    orgFilter.blocked_local_patterns || [],
      internal_domains:        internalDomains,
      account_domain_coverage: {
        total:          parseInt(accountCoverage.total),
        have_domain:    parseInt(accountCoverage.have_domain),
        missing_domain: parseInt(accountCoverage.missing_domain),
      },
    });
  } catch (err) {
    console.error('GET /org/admin/email-settings error:', err);
    res.status(500).json({ error: { message: 'Failed to load email settings' } });
  }
});

/**
 * PATCH /org/admin/email-settings
 * Update org-specific blocked domains and/or patterns.
 * Body: { blocked_domains: string[], blocked_local_patterns: string[] }
 * Replaces the org-specific lists (does not affect platform defaults).
 */
router.patch('/email-settings', adminOnly, async (req, res) => {
  try {
    const { blocked_domains, blocked_local_patterns } = req.body;

    const patch = {};
    if (Array.isArray(blocked_domains)) {
      patch.blocked_domains = blocked_domains
        .map(d => d.trim().toLowerCase())
        .filter(d => d.length > 0 && d.includes('.'));
    }
    if (Array.isArray(blocked_local_patterns)) {
      patch.blocked_local_patterns = blocked_local_patterns
        .map(p => p.trim().toLowerCase())
        .filter(p => p.length > 0);
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: 'blocked_domains or blocked_local_patterns array required' } });
    }

    await pool.query(
      `UPDATE organizations
       SET settings   = jsonb_set(
                          COALESCE(settings, '{}'::jsonb),
                          '{email_filter}',
                          COALESCE(settings->'email_filter', '{}'::jsonb) || $1::jsonb,
                          true
                        ),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(patch), req.orgId]
    );

    console.log(`📧 Email filter settings updated for org ${req.orgId}:`, patch);
    res.json({ success: true, updated: patch });
  } catch (err) {
    console.error('PATCH /org/admin/email-settings error:', err);
    res.status(500).json({ error: { message: 'Failed to update email settings' } });
  }
});

/**
 * POST /org/admin/email-settings/derive-account-domains
 * Auto-derives domain from contacts for accounts that are missing a domain.
 * Returns a preview — does NOT auto-update. Frontend confirms before applying.
 */
router.post('/email-settings/derive-account-domains', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         a.id,
         a.name,
         a.domain                                                          AS current_domain,
         MODE() WITHIN GROUP (ORDER BY split_part(c.email, '@', 2))       AS suggested_domain,
         COUNT(c.id)                                                       AS contact_count
       FROM accounts a
       JOIN contacts c
         ON c.account_id = a.id
        AND c.email IS NOT NULL AND c.email != ''
        AND c.deleted_at IS NULL
        AND split_part(c.email, '@', 2) NOT LIKE '%gmail%'
        AND split_part(c.email, '@', 2) NOT LIKE '%yahoo%'
        AND split_part(c.email, '@', 2) NOT LIKE '%hotmail%'
        AND split_part(c.email, '@', 2) NOT LIKE '%outlook%'
       WHERE a.org_id = $1
         AND a.deleted_at IS NULL
         AND (a.domain IS NULL OR a.domain = '')
       GROUP BY a.id, a.name, a.domain
       HAVING COUNT(c.id) >= 1
       ORDER BY contact_count DESC`,
      [req.orgId]
    );

    res.json({ suggestions: result.rows });
  } catch (err) {
    console.error('POST /org/admin/email-settings/derive-account-domains error:', err);
    res.status(500).json({ error: { message: 'Failed to derive account domains' } });
  }
});

/**
 * PATCH /org/admin/email-settings/apply-account-domains
 * Applies suggested domain derivations from the derive endpoint.
 * Body: { updates: [{ id: number, domain: string }] }
 */
router.patch('/email-settings/apply-account-domains', adminOnly, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: { message: 'updates array required' } });
    }

    let applied = 0;
    for (const { id, domain } of updates) {
      if (!id || !domain || !domain.includes('.')) continue;
      await pool.query(
        `UPDATE accounts
         SET domain = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3 AND (domain IS NULL OR domain = '')`,
        [domain.trim().toLowerCase(), id, req.orgId]
      );
      applied++;
    }

    console.log(`📧 Auto-applied ${applied} account domains for org ${req.orgId}`);
    res.json({ success: true, applied });
  } catch (err) {
    console.error('PATCH /org/admin/email-settings/apply-account-domains error:', err);
    res.status(500).json({ error: { message: 'Failed to apply account domains' } });
  }
});


module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// AI Token Usage — Org Admin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /org/admin/ai-usage?days=30
 * Returns org-wide AI token usage aggregated by day, user, and call type.
 */
router.get('/ai-usage', adminOnly, async (req, res) => {
  try {
    const TokenTrackingService = require('../services/TokenTrackingService');
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const data = await TokenTrackingService.getOrgUsage(req.orgId, days);
    res.json(data);
  } catch (err) {
    console.error('GET /org/admin/ai-usage error:', err);
    res.status(500).json({ error: { message: 'Failed to load AI usage data' } });
  }
});
