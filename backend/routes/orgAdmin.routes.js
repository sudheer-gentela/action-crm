// ─────────────────────────────────────────────────────────────────────────────
// orgAdmin.routes.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');

const ActionConfigService = require('../services/actionConfig.service');
const { seedModulePlaybook, getSeedStatus } = require('../services/orgSeed.service');

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


// ── GET /api/org/admin/action-ai/config ──────────────────────────────────────
// Returns org-level AI defaults for the action system.
// Non-admins can read (so user settings panel can display "Org default: X").
// Admin role is required only for PATCH.

router.get('/action-ai/config', async (req, res) => {
  try {
    const orgDefaults = await ActionConfigService.getOrgDefaults(req.orgId);

    // If no org row exists yet return system defaults so UI always has something to show
    const ActionConfigServiceMod = require('../services/actionConfig.service');
    const settings = orgDefaults?.ai_settings || {
      master_enabled:    true,
      modules:           { deals: true, straps: true, clm: false, prospecting: false },
      generation_mode:   ['playbook', 'rules', 'ai'],
      ai_provider:       'anthropic',
      default_model:     'claude-haiku-4-5-20251001',
      strap_generation_mode: 'both',
      strap_ai_provider:     'anthropic',
    };

    res.json({ ai_settings: settings });
  } catch (err) {
    console.error('GET /org/admin/action-ai/config error:', err);
    res.status(500).json({ error: { message: 'Failed to load org action AI config' } });
  }
});

// ── PATCH /api/org/admin/action-ai/config ─────────────────────────────────────
// Updates org-level AI defaults. Admin only.
// Body: { ai_settings: { master_enabled, modules, generation_mode, ai_provider, ... } }

router.patch('/action-ai/config', adminOnly, async (req, res) => {
  try {
    const { ai_settings } = req.body;

    if (!ai_settings || typeof ai_settings !== 'object') {
      return res.status(400).json({ error: { message: 'ai_settings object required' } });
    }

    const row = await ActionConfigService.setOrgDefaults(
      req.orgId,
      ai_settings,
      req.user.userId
    );

    console.log(`🔧 Org action AI config updated for org ${req.orgId} by user ${req.user.userId}`);
    res.json({ ai_settings: row.ai_settings });
  } catch (err) {
    console.error('PATCH /org/admin/action-ai/config error:', err);
    if (err.message === 'No valid fields to update') {
      return res.status(400).json({ error: { message: err.message } });
    }
    res.status(500).json({ error: { message: 'Failed to update org action AI config' } });
  }
});

// ── GET /api/org/admin/action-ai/prompt-overrides ────────────────────────────
// Returns count of user prompt overrides per prompt key — shown in admin prompts tab.

router.get('/action-ai/prompt-overrides', adminOnly, async (req, res) => {
  try {
    const result = await require('../config/database').query(
      `SELECT template_type, COUNT(*) AS override_count
       FROM user_prompts
       WHERE org_id = $1 AND user_id IS NOT NULL
       GROUP BY template_type`,
      [req.orgId]
    );

    const counts = {};
    result.rows.forEach(r => { counts[r.template_type] = parseInt(r.override_count); });
    res.json({ counts });
  } catch (err) {
    console.error('GET /org/admin/action-ai/prompt-overrides error:', err);
    res.status(500).json({ error: { message: 'Failed to load override counts' } });
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
    // Load platform defaults from DB instead of hardcoding them.
    // Falls back to empty if platform_settings table not yet migrated.
    let PLATFORM_DEFAULTS = { blocked_domains: [], blocked_local_patterns: [] };
    try {
      const psResult = await pool.query(
        `SELECT value FROM platform_settings WHERE key = 'email_filter'`
      );
      if (psResult.rows.length > 0) {
        PLATFORM_DEFAULTS = psResult.rows[0].value || PLATFORM_DEFAULTS;
      }
    } catch (e) {
      console.warn('platform_settings unavailable in email-settings route:', e.message);
    }

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

/**
 * GET /org/admin/email-filter-log
 * Paginated log of emails dropped by the sync filter.
 * Query params: ?reason=&provider=&page=&limit=
 */
router.get('/email-filter-log', adminOnly, async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(100, parseInt(req.query.limit) || 25);
    const offset   = (page - 1) * limit;
    const reason   = req.query.reason   || null;
    const provider = req.query.provider || null;

    const conditions = ['org_id = $1'];
    const params     = [req.orgId];
    let   p          = 2;

    if (reason)   { conditions.push(`reason = $${p++}`);   params.push(reason);   }
    if (provider) { conditions.push(`provider = $${p++}`); params.push(provider); }

    const where = conditions.join(' AND ');

    const [rows, countRow] = await Promise.all([
      pool.query(
        `SELECT id, from_address, to_address, subject, reason, provider, sync_date, external_id
         FROM email_filter_log
         WHERE ${where}
         ORDER BY sync_date DESC
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM email_filter_log WHERE ${where}`,
        params
      ),
    ]);

    res.json({
      logs:  rows.rows,
      total: parseInt(countRow.rows[0].total),
      page,
      limit,
      pages: Math.ceil(parseInt(countRow.rows[0].total) / limit),
    });
  } catch (err) {
    console.error('GET /org/admin/email-filter-log error:', err);
    res.status(500).json({ error: { message: 'Failed to load filter log' } });
  }
});

/**
 * DELETE /org/admin/email-filter-log
 * Purge all filter log entries for this org (admin only).
 */
router.delete('/email-filter-log', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM email_filter_log WHERE org_id = $1`,
      [req.orgId]
    );
    console.log(`🧹 Email filter log manually purged for org ${req.orgId}: ${result.rowCount} rows`);
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('DELETE /org/admin/email-filter-log error:', err);
    res.status(500).json({ error: { message: 'Failed to purge filter log' } });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// ADD TO: backend/routes/orgAdmin.routes.js
// (append before the final module.exports = router line)
//
// Two new routes for OAMeetingSettings.js frontend component:
//   GET  /org/admin/meeting-settings  — list active transcript integrations
//   PATCH /org/admin/meeting-settings — enable/update/disable a provider
//
// Storage: org_integrations table
//   integration_type = provider id (e.g. 'zoom_org', 'teams', 'fireflies_org')
//   credentials jsonb = { webhook_secret }   ← sensitive, never returned to client
//   config jsonb      = { auto_analyze }
//   status            = 'active' | 'inactive'
// ─────────────────────────────────────────────────────────────────────────────

const TRANSCRIPT_PROVIDERS = ['zoom_org', 'teams', 'fireflies_org', 'gong', 'gmeet'];

/**
 * GET /org/admin/meeting-settings
 * Returns all transcript integrations for this org.
 * Does NOT return webhook_secret — only confirms whether one is set.
 */
router.get('/meeting-settings', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         integration_type,
         status,
         last_synced_at,
         error_message,
         created_at,
         updated_at,
         config,
         -- Never expose the secret itself; just tell the client if one exists
         CASE WHEN credentials->>'webhook_secret' IS NOT NULL
                   AND credentials->>'webhook_secret' != ''
              THEN true ELSE false END AS has_secret
       FROM org_integrations
       WHERE org_id = $1
         AND integration_type = ANY($2)
       ORDER BY integration_type`,
      [req.orgId, TRANSCRIPT_PROVIDERS],
    );

    res.json({ integrations: result.rows });
  } catch (err) {
    console.error('GET /org/admin/meeting-settings error:', err);
    res.status(500).json({ error: { message: 'Failed to load meeting integrations' } });
  }
});

/**
 * PATCH /org/admin/meeting-settings
 * Upsert a transcript provider integration for this org.
 *
 * Body:
 *   provider        string   required  — one of TRANSCRIPT_PROVIDERS
 *   enabled         boolean  required  — true = active, false = inactive
 *   webhook_secret  string   optional  — if omitted on update, existing secret kept
 *   auto_analyze    boolean  optional  — default true
 */
router.patch('/meeting-settings', adminOnly, async (req, res) => {
  try {
    const { provider, enabled, webhook_secret, auto_analyze = true } = req.body;

    if (!provider || !TRANSCRIPT_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: { message: `provider must be one of: ${TRANSCRIPT_PROVIDERS.join(', ')}` },
      });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: { message: 'enabled (boolean) is required' } });
    }

    const newStatus = enabled ? 'active' : 'inactive';
    const newConfig = JSON.stringify({ auto_analyze: !!auto_analyze });

    // Check if a row already exists for this org + provider
    const existing = await pool.query(
      `SELECT id, credentials FROM org_integrations
       WHERE org_id = $1 AND integration_type = $2`,
      [req.orgId, provider],
    );

    if (existing.rows.length > 0) {
      // UPDATE — preserve existing secret if no new one supplied
      const currentSecret = existing.rows[0].credentials?.webhook_secret || '';
      const secretToStore = (webhook_secret && webhook_secret.trim())
        ? webhook_secret.trim()
        : currentSecret;

      await pool.query(
        `UPDATE org_integrations
         SET status      = $1,
             config      = $2::jsonb,
             credentials = jsonb_set(
                             COALESCE(credentials, '{}'::jsonb),
                             '{webhook_secret}',
                             to_jsonb($3::text)
                           ),
             updated_at  = NOW()
         WHERE org_id = $4 AND integration_type = $5`,
        [newStatus, newConfig, secretToStore, req.orgId, provider],
      );
    } else {
      // INSERT — webhook_secret required for new rows when enabling
      if (enabled && (!webhook_secret || !webhook_secret.trim())) {
        return res.status(400).json({
          error: { message: 'webhook_secret is required when enabling a new integration' },
        });
      }

      await pool.query(
        `INSERT INTO org_integrations
           (org_id, integration_type, credentials, config, status, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NOW(), NOW())`,
        [
          req.orgId,
          provider,
          JSON.stringify({ webhook_secret: webhook_secret?.trim() || '' }),
          newConfig,
          newStatus,
        ],
      );
    }

    console.log(`🔌 Meeting integration [${provider}] ${newStatus} for org ${req.orgId}`);
    res.json({ success: true, provider, status: newStatus });
  } catch (err) {
    console.error('PATCH /org/admin/meeting-settings error:', err);
    res.status(500).json({ error: { message: 'Failed to update meeting integration' } });
  }
});


// ── Playbook Seeding ──────────────────────────────────────────────────────────

/**
 * GET /org/admin/seed-status
 * Returns which modules have already had their GoWarm sample playbook seeded.
 * Response: { prospecting, sales, clm, service, handovers } — all booleans.
 */
router.get('/seed-status', adminOnly, async (req, res) => {
  try {
    const status = await getSeedStatus(req.orgId);
    res.json({ status });
  } catch (err) {
    console.error('GET /org/admin/seed-status error:', err);
    res.status(500).json({ error: { message: 'Failed to load seed status' } });
  }
});

/**
 * POST /org/admin/seed-module
 * Seeds the GoWarm sample playbook for a given module (one-time per module).
 * Body: { module: 'prospecting' | 'sales' | 'clm' | 'service' | 'handovers' }
 * Returns: { seeded: true, message } on success, or { seeded: false, message } if already done.
 */
router.post('/seed-module', adminOnly, async (req, res) => {
  try {
    const { module } = req.body;
    const VALID_MODULES = ['prospecting', 'sales', 'clm', 'service', 'handovers'];
    if (!module || !VALID_MODULES.includes(module)) {
      return res.status(400).json({ error: { message: `module must be one of: ${VALID_MODULES.join(', ')}` } });
    }
    const result = await seedModulePlaybook(req.orgId, module);
    res.json(result);
  } catch (err) {
    console.error('POST /org/admin/seed-module error:', err);
    res.status(500).json({ error: { message: 'Failed to seed module playbook' } });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC RULES CONFIG
// Configurable thresholds for all nightly + real-time diagnostic engines.
// Stored in organizations.settings.diagnostic_rules.
// getDiagnosticRulesConfig is exported for use by engine callers.
// ─────────────────────────────────────────────────────────────────────────────

const DIAGNOSTIC_DEFAULTS = {
  deals: {
    stagnant_days_realtime: 14,
    stagnant_days_nightly:  30,
    close_imminent_days:    7,
    high_value_threshold:   100000,
  },
  cases: {
    stale_days:            5,
    pending_too_long_days: 7,
  },
  handovers: {
    no_kickoff_days: 5,
    stalled_days:    7,
  },
  prospecting: {
    stale_days:                    14,
    ghosting_days:                 5,
    hot_lead_response_days:        3,
    low_icp_threshold:             30,
    wrong_channel_min_attempts:    3,
    wrong_channel_max_response_rate: 0.10,
  },
  accounts: {
    stale_days:             30,
    expansion_stalled_days: 30,
    renewal_window_days:    90,
    whitespace_min_roles:   3,
    whitespace_min_contacts: 5,
  },
  strap: {
    min_age_hours: 12,
  },
};

/**
 * Load the effective diagnostic rules config for an org.
 * Merges org-level overrides (settings.diagnostic_rules) with DIAGNOSTIC_DEFAULTS.
 * Returns full config even if org has no overrides — always safe to destructure.
 *
 * @param {number} orgId
 * @returns {Promise<object>} merged config
 */
async function getDiagnosticRulesConfig(orgId) {
  try {
    const result = await pool.query(
      `SELECT settings->'diagnostic_rules' AS rules FROM organizations WHERE id = $1`,
      [orgId]
    );
    const overrides = result.rows[0]?.rules || {};

    // Deep merge: org overrides win, defaults fill gaps
    const merged = {};
    for (const [module, defaults] of Object.entries(DIAGNOSTIC_DEFAULTS)) {
      merged[module] = { ...defaults, ...(overrides[module] || {}) };
    }
    return merged;
  } catch (err) {
    console.error('[getDiagnosticRulesConfig] Failed, using defaults:', err.message);
    return { ...DIAGNOSTIC_DEFAULTS };
  }
}

/**
 * GET /org/admin/diagnostic-rules/summary
 * Returns the complete org-specific rules document as structured JSON.
 * Every module, every rule, with effective thresholds substituted in.
 * Used by OADiagnosticRulesSummary to render the live per-org document.
 *
 * Response shape:
 * {
 *   generated_at: ISO string,
 *   org_id: number,
 *   modules: [
 *     {
 *       key, label, icon,
 *       config: { key: { value, default, customised } },
 *       rules: [
 *         { key, title, description, trigger, priority, mode,
 *           next_step, configurable, param_keys }
 *       ]
 *     }
 *   ]
 * }
 */
router.get('/diagnostic-rules/summary', adminOnly, async (req, res) => {
  try {
    const config     = await getDiagnosticRulesConfig(req.orgId);
    const overrides  = await pool.query(
      `SELECT settings->'diagnostic_rules' AS rules FROM organizations WHERE id = $1`,
      [req.orgId]
    ).then(r => r.rows[0]?.rules || {});

    const c = config; // shorthand

    const modules = [
      {
        key: 'deals', label: 'Deals', icon: '💼',
        config: _buildConfigDisplay('deals', c.deals, DIAGNOSTIC_DEFAULTS.deals, overrides.deals || {}),
        rules: [
          {
            key: 'stagnant_deal', title: 'Stagnant Deal',
            description: 'Deal has had no stage progression for too long.',
            trigger: `No stage change in more than ${c.deals.stagnant_days_realtime} days (real-time) or ${c.deals.stagnant_days_nightly} days (nightly sweep). Excludes closed deals.`,
            priority: 'high', mode: 'Real-time + Nightly sweep', next_step: 'Email',
            configurable: true, param_keys: ['stagnant_days_realtime', 'stagnant_days_nightly'],
          },
          {
            key: 'close_imminent', title: 'Close Date Imminent',
            description: 'Deal close date is approaching — final checklist needed.',
            trigger: `Close date is within ${c.deals.close_imminent_days} days from today.`,
            priority: 'high', mode: 'Real-time + Nightly sweep', next_step: 'Internal task',
            configurable: true, param_keys: ['close_imminent_days'],
          },
          {
            key: 'past_close_date', title: 'Past Close Date',
            description: 'Deal has passed its close date without being won or lost.',
            trigger: 'Close date is in the past and deal is not in a terminal stage.',
            priority: 'high', mode: 'Real-time + Nightly sweep', next_step: 'Internal task',
            configurable: false, param_keys: [],
          },
          {
            key: 'high_value_no_meeting', title: 'High-Value Deal — No Executive Meeting',
            description: `Deal value exceeds $${c.deals.high_value_threshold.toLocaleString()} but no completed meetings on record.`,
            trigger: `Deal value > $${c.deals.high_value_threshold.toLocaleString()} AND no completed meetings.`,
            priority: 'high', mode: 'Real-time + Nightly sweep', next_step: 'Email',
            configurable: true, param_keys: ['high_value_threshold'],
          },
          { key: 'no_contacts', title: 'No Contacts on Deal', description: 'Deal has no contacts linked.', trigger: 'contacts.length === 0', priority: 'high', mode: 'Real-time', next_step: 'Internal task', configurable: false, param_keys: [] },
          { key: 'health_2a_no_buyer', title: 'No Economic Buyer Identified', description: 'No economic buyer or decision maker tagged on the deal.', trigger: 'Health param 2a state is unknown or absent.', priority: 'high', mode: 'Real-time', next_step: 'Email', configurable: false, param_keys: [] },
          { key: 'health_2b_no_exec', title: 'No Executive Meeting', description: 'No exec-level meeting has been held on this deal.', trigger: 'Health param 2b absent AND no decision maker contacts.', priority: 'high', mode: 'Real-time', next_step: 'Email', configurable: false, param_keys: [] },
          { key: 'health_2c_single_thread', title: 'Single-Threaded Deal', description: 'Only one meaningful stakeholder engaged.', trigger: 'Health param 2c absent.', priority: 'medium', mode: 'Real-time', next_step: 'Internal task', configurable: false, param_keys: [] },
          { key: 'health_1a_unknown', title: 'Close Date Credibility Unconfirmed', description: 'No buyer signal received on close date.', trigger: 'Health param 1a unknown.', priority: 'high', mode: 'Real-time', next_step: 'Email', configurable: false, param_keys: [] },
          { key: 'health_1b_slipped', title: 'Close Date Slippage', description: 'Close date has slipped one or more times.', trigger: 'Health param 1b confirmed (slippage).', priority: 'high', mode: 'Real-time', next_step: 'Call', configurable: false, param_keys: [] },
          { key: 'health_5a_competitive', title: 'Competitive Deal', description: 'Competitive presence confirmed — counter-strategy needed.', trigger: 'Health param 5a confirmed.', priority: 'high', mode: 'Real-time', next_step: 'Document', configurable: false, param_keys: [] },
          { key: 'health_5b_price', title: 'Price Sensitivity', description: 'Price sensitivity flagged on deal.', trigger: 'Health param 5b confirmed.', priority: 'high', mode: 'Real-time', next_step: 'Document', configurable: false, param_keys: [] },
          { key: 'health_5c_discount', title: 'Discount Approval Pending', description: 'Discount approval is blocking deal progression.', trigger: 'Health param 5c confirmed.', priority: 'high', mode: 'Real-time', next_step: 'Slack', configurable: false, param_keys: [] },
          { key: 'unanswered_email', title: 'Unanswered Email', description: 'Outbound email has had no reply after 3+ days.', trigger: 'Sent email 3+ days ago with no inbound reply.', priority: 'medium', mode: 'Real-time', next_step: 'Email / Call if >7d', configurable: false, param_keys: [] },
          { key: 'meeting_followup', title: 'Meeting Follow-Up Needed', description: 'Meeting completed recently with no follow-up email sent.', trigger: 'Meeting completed within last 2 days AND no outbound email since.', priority: 'high', mode: 'Real-time', next_step: 'Email', configurable: false, param_keys: [] },
          { key: 'no_proposal_doc', title: 'No Proposal Document', description: 'Stage requires a proposal but none has been uploaded.', trigger: 'Playbook stage guidance requires_proposal_doc = true AND no proposal file found.', priority: 'high', mode: 'Real-time', next_step: 'Document', configurable: false, param_keys: [] },
        ],
      },
      {
        key: 'cases', label: 'Cases', icon: '🎧',
        config: _buildConfigDisplay('cases', c.cases, DIAGNOSTIC_DEFAULTS.cases, overrides.cases || {}),
        rules: [
          { key: 'case_unassigned', title: 'Case Unassigned', description: 'Case has no assigned agent.', trigger: 'assigned_to IS NULL', priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          { key: 'case_no_response', title: 'First Response SLA Breached', description: 'No first response sent within the SLA window.', trigger: 'first_responded_at IS NULL AND now > response_due_at. Response window set by SLA tier settings.', priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Email', configurable: false, param_keys: [] },
          { key: 'case_resolution_overdue', title: 'Resolution SLA Breached', description: 'Case still unresolved past SLA deadline.', trigger: 'resolved_at IS NULL AND now > resolution_due_at. Resolution window set by SLA tier settings.', priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          {
            key: 'case_stale', title: 'Case Gone Stale',
            description: `No activity on an open case for more than ${c.cases.stale_days} days.`,
            trigger: `Status not in (pending_customer, resolved, closed) AND no note or status change in ${c.cases.stale_days} days.`,
            priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['stale_days'],
          },
          {
            key: 'case_pending_too_long', title: 'Pending Customer Too Long',
            description: `Case waiting on customer reply for more than ${c.cases.pending_too_long_days} days.`,
            trigger: `Status = pending_customer AND no customer reply in ${c.cases.pending_too_long_days} days.`,
            priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Email',
            configurable: true, param_keys: ['pending_too_long_days'],
          },
          { key: 'case_escalation_needed', title: 'Critical Case Needs Escalation', description: 'Critical case has breached resolution SLA.', trigger: 'priority = critical AND resolution_breached = true.', priority: 'critical', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
        ],
      },
      {
        key: 'handovers', label: 'Handovers', icon: '🤝',
        config: _buildConfigDisplay('handovers', c.handovers, DIAGNOSTIC_DEFAULTS.handovers, overrides.handovers || {}),
        rules: [
          {
            key: 'handover_no_kickoff', title: 'No Kickoff Meeting Scheduled',
            description: `Handover active for more than ${c.handovers.no_kickoff_days} days with no kickoff meeting linked.`,
            trigger: `daysSinceCreated > ${c.handovers.no_kickoff_days} AND no meeting with handover_id found.`,
            priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['no_kickoff_days'],
          },
          { key: 'handover_commitment_overdue', title: 'Overdue Commitment', description: 'One or more sales commitments have passed their due date.', trigger: 'Any commitment in sales_handover_commitments where due_date < today.', priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          { key: 'handover_stakeholder_gap', title: 'Required Stakeholder Roles Missing', description: 'Required stakeholder roles are absent from the handover.', trigger: 'implementation_lead, day_to_day_admin, or go_live_approver missing from sales_handover_stakeholders.', priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          {
            key: 'handover_stalled', title: 'Handover Stalled',
            description: `No progress on handover for more than ${c.handovers.stalled_days} days.`,
            trigger: `daysSinceLastActivity > ${c.handovers.stalled_days}.`,
            priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['stalled_days'],
          },
          { key: 'handover_incomplete_brief', title: 'Handover Brief Incomplete', description: 'Go-live date is set but brief fields are missing.', trigger: 'go_live_date IS NOT NULL AND briefIsComplete = false.', priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
        ],
      },
      {
        key: 'prospecting', label: 'Prospecting', icon: '🎯',
        config: _buildConfigDisplay('prospecting', c.prospecting, DIAGNOSTIC_DEFAULTS.prospecting, overrides.prospecting || {}),
        rules: [
          {
            key: 'prospect_ghosting', title: 'Prospect Ghosting',
            description: `3+ outreach attempts, zero replies, last outreach more than ${c.prospecting.ghosting_days} days ago.`,
            trigger: `outreach_count >= 3 AND response_count = 0 AND daysSinceLastOutreach > ${c.prospecting.ghosting_days}.`,
            priority: 'critical', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['ghosting_days'],
          },
          {
            key: 'prospect_conversion_ready', title: 'Ready for Conversion',
            description: `High engagement (>30% response rate, last response within ${c.prospecting.hot_lead_response_days} days) but still in prospecting.`,
            trigger: `responseRate > 0.3 AND daysSinceLastResponse <= ${c.prospecting.hot_lead_response_days} AND not yet converted.`,
            priority: 'critical', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['hot_lead_response_days'],
          },
          {
            key: 'prospect_stale_outreach', title: 'Outreach Gone Stale',
            description: `No outreach in more than ${c.prospecting.stale_days} days.`,
            trigger: `daysSinceLastOutreach > ${c.prospecting.stale_days} AND not ghosting.`,
            priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['stale_days'],
          },
          { key: 'prospect_no_meeting', title: 'Engaged But No Meeting', description: 'Prospect has replied but no meeting has been scheduled.', trigger: 'hasReplied = true AND stage in (engaged, qualified) AND no upcoming meeting.', priority: 'high', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          { key: 'prospect_no_research', title: 'No Research Completed', description: 'Prospect in targeting or research stage with no research notes.', trigger: 'stage in (targeting, research) AND research_notes is empty.', priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          {
            key: 'prospect_wrong_channel', title: 'Wrong Outreach Channel',
            description: `${c.prospecting.wrong_channel_min_attempts}+ attempts with less than ${Math.round(c.prospecting.wrong_channel_max_response_rate * 100)}% response rate — channel not working.`,
            trigger: `outreach_count >= ${c.prospecting.wrong_channel_min_attempts} AND responseRate < ${c.prospecting.wrong_channel_max_response_rate}.`,
            priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['wrong_channel_min_attempts', 'wrong_channel_max_response_rate'],
          },
          { key: 'prospect_multi_thread', title: 'Single Entry Point', description: 'Only one prospect at the company after 2+ outreach attempts.', trigger: 'otherProspectsAtCompany.length === 0 AND outreach_count >= 2.', priority: 'medium', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task', configurable: false, param_keys: [] },
          {
            key: 'prospect_low_icp', title: 'Low ICP Fit',
            description: `ICP score is below ${c.prospecting.low_icp_threshold}/100.`,
            trigger: `icp_score < ${c.prospecting.low_icp_threshold}.`,
            priority: 'low', mode: 'Nightly sweep + Real-time event', next_step: 'Internal task',
            configurable: true, param_keys: ['low_icp_threshold'],
          },
        ],
      },
      {
        key: 'accounts', label: 'Accounts', icon: '🏢',
        config: _buildConfigDisplay('accounts', c.accounts, DIAGNOSTIC_DEFAULTS.accounts, overrides.accounts || {}),
        rules: [
          {
            key: 'stale_account', title: 'Account Gone Dark',
            description: `No engagement with a paying customer in more than ${c.accounts.stale_days} days.`,
            trigger: `daysSinceLastEngagement > ${c.accounts.stale_days} AND wonDealCount > 0.`,
            priority: 'critical', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task',
            configurable: true, param_keys: ['stale_days'],
          },
          {
            key: 'renewal_risk', title: 'Renewal Risk',
            description: `Contract anniversary approaching within ${c.accounts.renewal_window_days} days with no active expansion deal.`,
            trigger: `Deal close anniversary within ${c.accounts.renewal_window_days} days AND no open deals.`,
            priority: 'critical', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task',
            configurable: true, param_keys: ['renewal_window_days'],
          },
          { key: 'champion_gap', title: 'No Champion Identified', description: 'No champion contact on a customer account.', trigger: 'champions.length === 0 AND wonDealCount > 0.', priority: 'high', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task', configurable: false, param_keys: [] },
          { key: 'no_exec_relationship', title: 'No Executive Relationship', description: 'No executive-level contact on a customer account.', trigger: 'executives.length === 0 AND wonDealCount > 0.', priority: 'high', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task', configurable: false, param_keys: [] },
          {
            key: 'expansion_blocked', title: 'Expansion Deal Stalled',
            description: `Open expansion deal idle for more than ${c.accounts.expansion_stalled_days} days.`,
            trigger: `Any open deal with no updates in ${c.accounts.expansion_stalled_days} days.`,
            priority: 'high', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task',
            configurable: true, param_keys: ['expansion_stalled_days'],
          },
          { key: 'revenue_concentration', title: 'Revenue Concentrated', description: 'All account revenue from a single deal.', trigger: 'wonDeals.length === 1 AND totalRevenue > 0.', priority: 'medium', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task', configurable: false, param_keys: [] },
          {
            key: 'whitespace', title: 'Untapped Departments',
            description: `Fewer than ${c.accounts.whitespace_min_roles} contact roles and fewer than ${c.accounts.whitespace_min_contacts} contacts on a customer account.`,
            trigger: `uniqueRoles.size < ${c.accounts.whitespace_min_roles} AND contacts.length < ${c.accounts.whitespace_min_contacts} AND wonDealCount > 0.`,
            priority: 'medium', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task',
            configurable: true, param_keys: ['whitespace_min_roles', 'whitespace_min_contacts'],
          },
          { key: 'single_product', title: 'Single Product Line', description: 'Customer using only one product or service line.', trigger: 'Only one distinct deal name across won deals.', priority: 'low', mode: 'STRAP (Nightly sweep)', next_step: 'Internal task', configurable: false, param_keys: [] },
        ],
      },
      {
        key: 'strap', label: 'STRAP', icon: '⚡',
        config: _buildConfigDisplay('strap', c.strap, DIAGNOSTIC_DEFAULTS.strap, overrides.strap || {}),
        rules: [
          {
            key: 'strap_sweep_behaviour', title: 'STRAP Nightly Re-Validation',
            description: `Active STRAPs older than ${c.strap.min_age_hours} hours are re-validated each night. If the hurdle has cleared or shifted, the STRAP is auto-resolved and regenerated.`,
            trigger: `STRAP age > ${c.strap.min_age_hours} hours AND nightly sweep runs (03:00 UTC).`,
            priority: 'n/a', mode: 'Nightly sweep only', next_step: 'n/a',
            configurable: true, param_keys: ['min_age_hours'],
          },
        ],
      },
    ];

    res.json({
      generated_at: new Date().toISOString(),
      org_id:       req.orgId,
      modules,
    });
  } catch (err) {
    console.error('GET /org/admin/diagnostic-rules/summary error:', err);
    res.status(500).json({ error: { message: 'Failed to generate rules summary' } });
  }
});

// Helper: build config display object for a module
// Returns { key: { value, default: defaultValue, customised } }
function _buildConfigDisplay(moduleKey, effectiveConfig, moduleDefaults, orgOverrides) {
  const display = {};
  for (const [key, defaultValue] of Object.entries(moduleDefaults)) {
    display[key] = {
      value:      effectiveConfig[key] ?? defaultValue,
      default:    defaultValue,
      customised: orgOverrides[key] !== undefined,
    };
  }
  return display;
}

/**
 * GET /org/admin/diagnostic-rules
 * Returns the effective diagnostic rules config for this org (defaults merged with overrides).
 * Also returns which values are customised vs default, for UI highlighting.
 */
router.get('/diagnostic-rules', adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT settings->'diagnostic_rules' AS rules FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const overrides = result.rows[0]?.rules || {};
    const config    = await getDiagnosticRulesConfig(req.orgId);

    // Build a customised map — tells the UI which values have been overridden
    const customised = {};
    for (const [module, defaults] of Object.entries(DIAGNOSTIC_DEFAULTS)) {
      customised[module] = {};
      for (const key of Object.keys(defaults)) {
        customised[module][key] = !!(overrides[module] && overrides[module][key] !== undefined);
      }
    }

    res.json({ config, defaults: DIAGNOSTIC_DEFAULTS, customised });
  } catch (err) {
    console.error('GET /org/admin/diagnostic-rules error:', err);
    res.status(500).json({ error: { message: 'Failed to load diagnostic rules config' } });
  }
});

/**
 * PATCH /org/admin/diagnostic-rules
 * Update one or more diagnostic rule thresholds for this org.
 * Body: { module: 'deals'|'cases'|'handovers'|'prospecting'|'accounts'|'strap', updates: { key: value } }
 * Validates that keys exist in DIAGNOSTIC_DEFAULTS and values are numbers.
 */
router.patch('/diagnostic-rules', adminOnly, async (req, res) => {
  try {
    const { module, updates } = req.body;

    const VALID_MODULES = Object.keys(DIAGNOSTIC_DEFAULTS);
    if (!module || !VALID_MODULES.includes(module)) {
      return res.status(400).json({
        error: { message: `module must be one of: ${VALID_MODULES.join(', ')}` },
      });
    }

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: { message: 'updates must be an object' } });
    }

    const moduleDefaults = DIAGNOSTIC_DEFAULTS[module];
    const validKeys = Object.keys(moduleDefaults);

    // Validate all incoming keys and values
    for (const [key, value] of Object.entries(updates)) {
      if (!validKeys.includes(key)) {
        return res.status(400).json({
          error: { message: `Unknown key "${key}" for module "${module}". Valid keys: ${validKeys.join(', ')}` },
        });
      }
      if (typeof value !== 'number' || isNaN(value) || value < 0) {
        return res.status(400).json({
          error: { message: `Value for "${key}" must be a non-negative number` },
        });
      }
    }

    // Load existing overrides, merge in new updates, write back
    const current = await pool.query(
      `SELECT settings->'diagnostic_rules' AS rules FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    const existing = current.rows[0]?.rules || {};
    const merged   = {
      ...existing,
      [module]: { ...(existing[module] || {}), ...updates },
    };

    await pool.query(
      `UPDATE organizations
       SET settings   = jsonb_set(COALESCE(settings, '{}'::jsonb), '{diagnostic_rules}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(merged), req.orgId]
    );

    // Return the full updated config
    const updatedConfig = await getDiagnosticRulesConfig(req.orgId);
    res.json({ config: updatedConfig, module, updated: updates });
  } catch (err) {
    console.error('PATCH /org/admin/diagnostic-rules error:', err);
    res.status(500).json({ error: { message: 'Failed to update diagnostic rules config' } });
  }
});

module.exports = router;
module.exports.getDiagnosticRulesConfig = getDiagnosticRulesConfig;
module.exports.DIAGNOSTIC_DEFAULTS      = DIAGNOSTIC_DEFAULTS;

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
