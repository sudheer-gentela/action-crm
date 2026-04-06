// ─────────────────────────────────────────────────────────────────────────────
// superAdmin.routes.js
//
// Mount in server.js:
//   app.use('/api/super', require('./routes/superAdmin.routes'));
//
// All routes require: authenticateToken + requireSuperAdmin
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const { pool } = require('../config/database');
const authenticateToken = require('../middleware/auth.middleware');
const { requireSuperAdmin, auditLog } = require('../middleware/superAdmin.middleware');
const { seedOrg } = require('../services/orgSeed.service');

// Apply auth + super admin guard to ALL routes in this file
router.use(authenticateToken, requireSuperAdmin);

// ═════════════════════════════════════════════════════════════════════════════
// PLATFORM STATS (dashboard overview)
// ═════════════════════════════════════════════════════════════════════════════

router.get('/stats', async (req, res) => {
  try {
    const [orgStats, userStats, activityStats] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                            AS total_orgs,
          COUNT(*) FILTER (WHERE status = 'active')          AS active_orgs,
          COUNT(*) FILTER (WHERE status = 'suspended')       AS suspended_orgs,
          COUNT(*) FILTER (WHERE status = 'trial')           AS trial_orgs,
          COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS new_orgs_30d
        FROM organizations
      `),
      pool.query(`
        SELECT
          COUNT(*)                                                       AS total_users,
          COUNT(*) FILTER (WHERE ou.is_active = TRUE)                   AS active_users,
          COUNT(DISTINCT ou.user_id) FILTER (WHERE ou.joined_at > now() - interval '30 days') AS new_users_30d
        FROM org_users ou
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS actions_24h,
          COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')   AS actions_7d
        FROM actions
      `),
    ]);

    res.json({
      orgs:     orgStats.rows[0],
      users:    userStats.rows[0],
      activity: activityStats.rows[0],
    });
  } catch (err) {
    console.error('GET /super/stats error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ORGANISATIONS — CRUD
// ═════════════════════════════════════════════════════════════════════════════

// List all orgs with member count
router.get('/orgs', async (req, res) => {
  try {
    const { search = '', status = '', plan = '', page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ['1=1'];
    const params     = [];
    let   p          = 1;

    if (search) {
      conditions.push(`o.name ILIKE $${p++}`);
      params.push(`%${search}%`);
    }
    if (status) {
      conditions.push(`o.status = $${p++}`);
      params.push(status);
    }
    if (plan) {
      conditions.push(`o.plan = $${p++}`);
      params.push(plan);
    }

    const where = conditions.join(' AND ');

    const [rows, countRow] = await Promise.all([
      pool.query(`
        SELECT
          o.id, o.name, o.status, o.plan, o.max_users,
          o.notes, o.created_at, o.suspended_at,
          COUNT(ou.user_id) FILTER (WHERE ou.is_active = TRUE) AS member_count,
          MAX(CASE WHEN ou.role = 'owner' THEN u.email END)    AS owner_email
        FROM organizations o
        LEFT JOIN org_users ou ON ou.org_id = o.id
        LEFT JOIN users u      ON u.id = ou.user_id AND ou.role = 'owner'
        WHERE ${where}
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT $${p++} OFFSET $${p++}
      `, [...params, parseInt(limit), offset]),

      pool.query(`
        SELECT COUNT(*) AS total FROM organizations o WHERE ${where}
      `, params),
    ]);

    res.json({
      orgs:  rows.rows,
      total: parseInt(countRow.rows[0].total),
      page:  parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('GET /super/orgs error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Get single org with full detail
router.get('/orgs/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;

    // org_integrations may not exist yet — query gracefully
    let integrations = { rows: [] };
    try {
      integrations = await pool.query(`
        SELECT * FROM org_integrations WHERE org_id = $1
      `, [orgId]);
    } catch (_) { /* table may not exist yet */ }

    const [org, members] = await Promise.all([
      pool.query(`
        SELECT o.*, u.email AS suspended_by_email
        FROM   organizations o
        LEFT JOIN users u ON u.id = o.suspended_by
        WHERE  o.id = $1
      `, [orgId]),

      pool.query(`
        SELECT ou.user_id, ou.role, ou.is_active, ou.joined_at,
               u.email, u.first_name || ' ' || u.last_name AS name
        FROM   org_users ou
        JOIN   users u ON u.id = ou.user_id
        WHERE  ou.org_id = $1
        ORDER  BY ou.role, u.first_name
      `, [orgId]),
    ]);

    if (org.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    res.json({ org: org.rows[0], members: members.rows, integrations: integrations.rows });
  } catch (err) {
    console.error(`GET /super/orgs/${req.params.orgId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Create a new org
router.post('/orgs', async (req, res) => {
  try {
    const { name, plan = 'free', max_users = 10, notes = '' } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: { message: 'Organisation name is required' } });
    }

    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const result = await pool.query(`
      INSERT INTO organizations (name, slug, plan, max_users, notes, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'active', now())
      RETURNING *
    `, [name.trim(), slug, plan, max_users, notes]);

    await auditLog(req, 'create_org', 'org', result.rows[0].id, { name, plan });

    // Seed default stages, playbooks, etc.
    await seedOrg(result.rows[0].id);

    res.status(201).json({ org: result.rows[0] });
  } catch (err) {
    console.error('POST /super/orgs error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Update org details
router.patch('/orgs/:orgId', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { name, plan, max_users, notes, status } = req.body;

    const result = await pool.query(`
      UPDATE organizations
      SET
        name      = COALESCE($1, name),
        plan      = COALESCE($2, plan),
        max_users = COALESCE($3, max_users),
        notes     = COALESCE($4, notes),
        status    = COALESCE($5, status)
      WHERE id = $6
      RETURNING *
    `, [name, plan, max_users, notes, status, orgId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    await auditLog(req, 'update_org', 'org', parseInt(orgId), req.body);
    res.json({ org: result.rows[0] });
  } catch (err) {
    console.error(`PATCH /super/orgs/${req.params.orgId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Delete org (hard delete — cascades to all org data)
router.delete('/orgs/:orgId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { orgId } = req.params;

    const existing = await client.query(
      `SELECT id, name FROM organizations WHERE id = $1`,
      [orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    const orgName = existing.rows[0].name;

    await client.query('BEGIN');

    // users.org_id → organizations(id) has no ON DELETE CASCADE.
    // Users are global accounts shared across the platform — we null out their
    // org_id rather than deleting them, so their user record stays intact but
    // they are detached from the deleted org.
    // org_users rows (the join table) will cascade-delete automatically.
    await client.query(
      `UPDATE users SET org_id = NULL WHERE org_id = $1`,
      [orgId]
    );

    // organizations_suspended_by_fkey: organizations.suspended_by → users(id)
    // null this out so the org row itself can be deleted cleanly
    await client.query(
      `UPDATE organizations SET suspended_by = NULL WHERE id = $1`,
      [orgId]
    );

    // Hard delete — all remaining child records cascade via ON DELETE CASCADE
    await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);

    await client.query('COMMIT');

    await auditLog(req, 'delete_org', 'org', parseInt(orgId), { name: orgName });
    console.log(`🗑️  Org ${orgId} (${orgName}) permanently deleted by super admin`);

    res.json({ message: `Organisation "${orgName}" permanently deleted.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`DELETE /super/orgs/${req.params.orgId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  } finally {
    client.release();
  }
});

// Suspend / unsuspend org
router.post('/orgs/:orgId/suspend', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { suspend, reason } = req.body; // suspend: true|false

    const result = await pool.query(`
      UPDATE organizations
      SET
        status       = $1,
        suspended_at = $2,
        suspended_by = $3,
        notes        = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE notes END
      WHERE id = $5
      RETURNING *
    `, [
      suspend ? 'suspended' : 'active',
      suspend ? new Date() : null,
      suspend ? req.userId : null,
      reason || null,
      orgId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    await auditLog(req, suspend ? 'suspend_org' : 'unsuspend_org', 'org', parseInt(orgId), { reason });
    res.json({ org: result.rows[0] });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/suspend error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Add this block to superAdmin.routes.js
//
// Paste it immediately after the existing suspend/unsuspend route block
// (after the closing brace of router.post('/orgs/:orgId/suspend', ...)),
// before the USERS WITHIN AN ORG section.
//
// This adds one new endpoint:
//   PATCH /super/orgs/:orgId/modules
//
// Body: { modules: { prospecting: true, contracts: false, ... } }
//
// Sets the `allowed` flag for each module in organizations.settings.modules.
// The org admin can still independently control the `enabled` flag, but they
// cannot enable a module that is not allowed by the platform.
//
// Modules not mentioned in the request body are left unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_KEYS = ['prospecting', 'contracts', 'handovers', 'service', 'agency'];

// ═════════════════════════════════════════════════════════════════════════════
// MODULE PROVISIONING — super admin controls which modules an org may use
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /super/orgs/:orgId/modules
 * Read the current allowed/enabled state for all modules of an org.
 * Used to populate the module toggles in SAOrgDetail.
 */
router.get('/orgs/:orgId/modules', async (req, res) => {
  try {
    const { orgId } = req.params;

    const result = await pool.query(
      `SELECT settings->'modules' AS modules FROM organizations WHERE id = $1`,
      [orgId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    const rawModules = result.rows[0]?.modules || {};
    const modules = {};

    for (const key of MODULE_KEYS) {
      const raw = rawModules[key];
      if (raw === null || raw === undefined) {
        modules[key] = { allowed: false, enabled: false };
      } else if (typeof raw === 'object') {
        modules[key] = { allowed: !!raw.allowed, enabled: !!raw.enabled };
      } else {
        // Legacy scalar — treat existing true as allowed+enabled
        const b = raw === true || raw === 'true';
        modules[key] = { allowed: b, enabled: b };
      }
    }

    res.json({ modules });
  } catch (err) {
    console.error(`GET /super/orgs/${req.params.orgId}/modules error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /super/orgs/:orgId/modules
 * Set the `allowed` flag for one or more modules.
 *
 * Body: { modules: { prospecting: true, contracts: false, agency: true } }
 *
 * When a module is disallowed (allowed: false), its enabled flag is also
 * forced to false so org admins cannot have it active while it's not provisioned.
 *
 * Modules not mentioned in the request body are left completely unchanged.
 */
router.patch('/orgs/:orgId/modules', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { modules: incoming } = req.body;

    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: { message: 'modules object is required' } });
    }

    // Validate keys
    const unknownKeys = Object.keys(incoming).filter(k => !MODULE_KEYS.includes(k));
    if (unknownKeys.length) {
      return res.status(400).json({ error: { message: `Unknown module(s): ${unknownKeys.join(', ')}` } });
    }

    // Load current settings so we can merge cleanly
    const current = await pool.query(
      `SELECT settings FROM organizations WHERE id = $1`,
      [orgId]
    );
    if (!current.rows.length) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    const settings    = current.rows[0].settings || {};
    const rawModules  = settings.modules || {};

    // Build merged module map
    const merged = { ...rawModules };

    for (const [moduleName, allowedValue] of Object.entries(incoming)) {
      const allowed = allowedValue === true || allowedValue === 'true';

      // Read existing object shape or legacy scalar
      const existing = merged[moduleName];
      let currentEnabled = false;
      if (existing !== null && existing !== undefined) {
        if (typeof existing === 'object') {
          currentEnabled = !!existing.enabled;
        } else {
          currentEnabled = existing === true || existing === 'true';
        }
      }

      // If revoking access, force enabled to false too
      const newEnabled = allowed ? currentEnabled : false;

      merged[moduleName] = { allowed, enabled: newEnabled };
    }

    // Write back using jsonb_set on the modules sub-key
    await pool.query(
      `UPDATE organizations
          SET settings   = jsonb_set(COALESCE(settings, '{}'::jsonb), '{modules}', $2::jsonb, true),
              updated_at = NOW()
        WHERE id = $1`,
      [orgId, JSON.stringify(merged)]
    );

    // Invalidate the requireModule cache for every changed module
    const requireModule = require('../middleware/requireModule.middleware');
    for (const moduleName of Object.keys(incoming)) {
      requireModule.invalidate(orgId, moduleName);
    }

    await auditLog(req, 'update_org_modules', 'org', parseInt(orgId), {
      changes: Object.entries(incoming).map(([k, v]) => `${k}=${v}`).join(', '),
    });

    // Return the full resolved module state
    const finalModules = {};
    for (const key of MODULE_KEYS) {
      const v = merged[key];
      if (!v || typeof v !== 'object') {
        const b = v === true || v === 'true';
        finalModules[key] = { allowed: b, enabled: b };
      } else {
        finalModules[key] = { allowed: !!v.allowed, enabled: !!v.enabled };
      }
    }

    res.json({ modules: finalModules });
  } catch (err) {
    console.error(`PATCH /super/orgs/${req.params.orgId}/modules error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});



// ═════════════════════════════════════════════════════════════════════════════
// USERS WITHIN AN ORG (super admin view — can add users to any org)
// ═════════════════════════════════════════════════════════════════════════════

// Add existing user to org
router.post('/orgs/:orgId/users', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, role = 'member' } = req.body;

    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name FROM users WHERE email = $1', [email]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found. They must register first.' } });
    }

    const user = userResult.rows[0];

    // Check seat limit
    const [countRow, orgRow] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE', [orgId]),
      pool.query('SELECT max_users FROM organizations WHERE id = $1', [orgId]),
    ]);
    if (parseInt(countRow.rows[0].count) >= parseInt(orgRow.rows[0].max_users)) {
      return res.status(400).json({ error: { message: 'Org has reached its user seat limit' } });
    }

    await pool.query(`
      INSERT INTO org_users (org_id, user_id, role, is_active, joined_at)
      VALUES ($1, $2, $3, TRUE, now())
      ON CONFLICT (org_id, user_id) DO UPDATE
        SET role = $3, is_active = TRUE
    `, [orgId, user.id, role]);

    await auditLog(req, 'add_user_to_org', 'user', user.id, { orgId, role });
    res.status(201).json({ message: 'User added', user: { ...user, role } });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/users error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Update a user's role in an org
router.patch('/orgs/:orgId/users/:userId', async (req, res) => {
  try {
    const { orgId, userId } = req.params;
    const { role, is_active } = req.body;

    // Prevent removing the last owner
    if (role && role !== 'owner') {
      const ownerCheck = await pool.query(
        `SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND role = 'owner' AND is_active = TRUE AND user_id != $2`,
        [orgId, userId]
      );
      const currentRole = await pool.query(
        `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`, [orgId, userId]
      );
      if (currentRole.rows[0]?.role === 'owner' && parseInt(ownerCheck.rows[0].count) === 0) {
        return res.status(400).json({ error: { message: 'Cannot change role of the last owner. Promote another user to owner first.' } });
      }
    }

    const result = await pool.query(`
      UPDATE org_users
      SET
        role      = COALESCE($1, role),
        is_active = COALESCE($2, is_active)
      WHERE org_id = $3 AND user_id = $4
      RETURNING *
    `, [role, is_active, orgId, userId]);

    await auditLog(req, 'update_user_in_org', 'user', parseInt(userId), { orgId, role, is_active });
    res.json({ membership: result.rows[0] });
  } catch (err) {
    console.error(`PATCH /super/orgs/${req.params.orgId}/users/${req.params.userId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// Remove user from org
router.delete('/orgs/:orgId/users/:userId', async (req, res) => {
  try {
    const { orgId, userId } = req.params;

    await pool.query(
      `UPDATE org_users SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId]
    );

    await auditLog(req, 'remove_user_from_org', 'user', parseInt(userId), { orgId });
    res.json({ message: 'User removed from org' });
  } catch (err) {
    console.error(`DELETE /super/orgs/${req.params.orgId}/users/${req.params.userId} error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CREATE USER + ADD TO ORG (super admin creates account directly)
// ═════════════════════════════════════════════════════════════════════════════

router.post('/orgs/:orgId/users/create', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, first_name, last_name, password, role = 'member' } = req.body;

    if (!email?.trim()) return res.status(400).json({ error: { message: 'Email is required' } });
    if (!first_name?.trim()) return res.status(400).json({ error: { message: 'First name is required' } });
    if (!last_name?.trim()) return res.status(400).json({ error: { message: 'Last name is required' } });
    if (!password || password.length < 8) return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });

    // Check if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { message: 'A user with this email already exists. Use "Add Existing User" instead.' } });
    }

    // Check seat limit
    const [countRow, orgRow] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE', [orgId]),
      pool.query('SELECT max_users FROM organizations WHERE id = $1', [orgId]),
    ]);
    if (parseInt(countRow.rows[0].count) >= parseInt(orgRow.rows[0].max_users)) {
      return res.status(400).json({ error: { message: 'Org has reached its user seat limit' } });
    }

    // Hash password and create user
    const password_hash = await bcrypt.hash(password, 12);
    const userResult = await pool.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, org_id, created_at)
      VALUES ($1, $2, $3, $4, $5, now())
      RETURNING id, email, first_name, last_name
    `, [email.trim().toLowerCase(), password_hash, first_name.trim(), last_name.trim(), orgId]);

    const user = userResult.rows[0];

    // Add to org
    await pool.query(`
      INSERT INTO org_users (org_id, user_id, role, is_active, joined_at)
      VALUES ($1, $2, $3, TRUE, now())
    `, [orgId, user.id, role]);

    await auditLog(req, 'create_user_for_org', 'user', user.id, { orgId, role, email });
    res.status(201).json({ message: 'User created and added to org', user: { ...user, role } });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/users/create error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INVITE FLOW — generate invite link, list pending invites
// ═════════════════════════════════════════════════════════════════════════════


// Create invite
router.post('/orgs/:orgId/invites', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { email, role = 'member' } = req.body;

    if (!email?.trim()) return res.status(400).json({ error: { message: 'Email is required' } });

    // Check if user already in org
    const existingUser = await pool.query(
      `SELECT u.id FROM users u JOIN org_users ou ON ou.user_id = u.id
       WHERE u.email = $1 AND ou.org_id = $2 AND ou.is_active = TRUE`,
      [email.trim().toLowerCase(), orgId]
    );
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: { message: 'This user is already a member of this org' } });
    }

    // Check for existing pending invite
    const existingInvite = await pool.query(
      `SELECT id FROM org_invites WHERE email = $1 AND org_id = $2 AND accepted_at IS NULL AND expires_at > now()`,
      [email.trim().toLowerCase(), orgId]
    );
    if (existingInvite.rows.length > 0) {
      return res.status(409).json({ error: { message: 'An active invite already exists for this email' } });
    }

    // Check seat limit
    const [countRow, orgRow] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM org_users WHERE org_id = $1 AND is_active = TRUE', [orgId]),
      pool.query('SELECT max_users, name FROM organizations WHERE id = $1', [orgId]),
    ]);
    if (parseInt(countRow.rows[0].count) >= parseInt(orgRow.rows[0].max_users)) {
      return res.status(400).json({ error: { message: 'Org has reached its user seat limit' } });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const result = await pool.query(`
      INSERT INTO org_invites (org_id, email, role, token, invited_by, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [orgId, email.trim().toLowerCase(), role, token, req.userId, expires_at]);

    // Build invite URL (frontend registration page with token)
    const appUrl = process.env.APP_URL || process.env.REACT_APP_URL || 'http://localhost:3000';
    const inviteUrl = `${appUrl}/register?invite=${token}`;

    // TODO: Send email with inviteUrl when email service is configured
    // e.g. await sendEmail({ to: email, subject: `You're invited to ${orgRow.rows[0].name}`, body: `...${inviteUrl}...` });
    console.log(`📧 Invite created for ${email} → ${inviteUrl}`);

    await auditLog(req, 'invite_user_to_org', 'org', parseInt(orgId), { email, role });
    res.status(201).json({
      invite: result.rows[0],
      inviteUrl,
      message: 'Invite created. Share the invite URL with the user.',
    });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/invites error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// List pending invites for an org
router.get('/orgs/:orgId/invites', async (req, res) => {
  try {
    const { orgId } = req.params;
    const result = await pool.query(`
      SELECT oi.*, u.email AS invited_by_email
      FROM   org_invites oi
      LEFT JOIN users u ON u.id = oi.invited_by
      WHERE  oi.org_id = $1
      ORDER  BY oi.created_at DESC
    `, [orgId]);
    res.json({ invites: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Revoke/cancel an invite
router.delete('/orgs/:orgId/invites/:inviteId', async (req, res) => {
  try {
    await pool.query('DELETE FROM org_invites WHERE id = $1 AND org_id = $2', [req.params.inviteId, req.params.orgId]);
    res.json({ message: 'Invite cancelled' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// IMPERSONATION — super admin borrows org context for support
// ═════════════════════════════════════════════════════════════════════════════

router.post('/orgs/:orgId/impersonate', async (req, res) => {
  try {
    const { orgId } = req.params;

    const orgResult = await pool.query(
      'SELECT id, name, status FROM organizations WHERE id = $1', [orgId]
    );
    if (orgResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Organisation not found' } });
    }

    await auditLog(req, 'impersonate_org', 'org', parseInt(orgId), {});

    // Return a support context token (the frontend stores this separately
    // and sends it as X-Support-Org-Id header — handled in orgContext middleware)
    res.json({
      message:         `Now supporting org: ${orgResult.rows[0].name}`,
      supportOrgId:    orgResult.rows[0].id,
      supportOrgName:  orgResult.rows[0].name,
    });
  } catch (err) {
    console.error(`POST /super/orgs/${req.params.orgId}/impersonate error:`, err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SUPER ADMINS — manage who has platform-level access
// ═════════════════════════════════════════════════════════════════════════════

router.get('/admins', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sa.id, sa.user_id, sa.granted_at, sa.revoked_at, sa.notes,
             u.email, u.first_name || ' ' || u.last_name AS name,
             g.email AS granted_by_email
      FROM   super_admins sa
      JOIN   users u  ON u.id  = sa.user_id
      LEFT JOIN users g ON g.id = sa.granted_by
      ORDER  BY sa.granted_at DESC
    `);
    res.json({ admins: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.post('/admins', async (req, res) => {
  try {
    const { email, notes = '' } = req.body;
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const result = await pool.query(`
      INSERT INTO super_admins (user_id, granted_by, notes)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE SET revoked_at = NULL, granted_by = $2, notes = $3
      RETURNING *
    `, [userResult.rows[0].id, req.userId, notes]);

    await auditLog(req, 'grant_super_admin', 'user', userResult.rows[0].id, { email });
    res.status(201).json({ admin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

router.delete('/admins/:userId', async (req, res) => {
  try {
    if (parseInt(req.params.userId) === req.userId) {
      return res.status(400).json({ error: { message: 'Cannot revoke your own super admin access' } });
    }

    await pool.query(
      `UPDATE super_admins SET revoked_at = now() WHERE user_id = $1`,
      [req.params.userId]
    );

    await auditLog(req, 'revoke_super_admin', 'user', parseInt(req.params.userId), {});
    res.json({ message: 'Super admin access revoked' });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═════════════════════════════════════════════════════════════════════════════

router.get('/audit', async (req, res) => {
  try {
    const { page = 1, limit = 50, admin_id, action } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (admin_id) { conditions.push(`sal.super_admin_id = $${p++}`); params.push(admin_id); }
    if (action)   { conditions.push(`sal.action = $${p++}`);         params.push(action); }

    const where = conditions.join(' AND ');

    const result = await pool.query(`
      SELECT sal.*, u.email AS admin_email, u.first_name || ' ' || u.last_name AS admin_name
      FROM   super_admin_audit_log sal
      JOIN   users u ON u.id = sal.super_admin_id
      WHERE  ${where}
      ORDER  BY sal.created_at DESC
      LIMIT  $${p++} OFFSET $${p++}
    `, [...params, parseInt(limit), offset]);

    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});



// ── Platform Settings ─────────────────────────────────────────────────────────
// Reads and writes platform_settings table rows.
// Each row is a named config key (e.g. 'email_filter') with a JSONB value.

/**
 * GET /super/platform-settings/:key
 * Read a platform setting by key.
 */
router.get('/platform-settings/:key', requireSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const result = await pool.query(
      `SELECT key, value, updated_by, updated_at FROM platform_settings WHERE key = $1`,
      [key]
    );
    if (result.rows.length === 0) {
      // Return empty value rather than 404 — caller treats missing as blank
      return res.json({ key, value: {}, updated_by: null, updated_at: null });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`GET /super/platform-settings/${req.params.key} error:`, err);
    res.status(500).json({ error: { message: 'Failed to load platform setting' } });
  }
});

/**
 * PATCH /super/platform-settings/:key
 * Write (upsert) a platform setting by key.
 * Body: { value: <any JSONB-serialisable object> }
 */
router.patch('/platform-settings/:key', requireSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined || value === null) {
      return res.status(400).json({ error: { message: 'value is required' } });
    }

    const result = await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value      = $2::jsonb,
             updated_by = $3,
             updated_at = NOW()
       RETURNING key, value, updated_by, updated_at`,
      [key, JSON.stringify(value), req.user?.userId || null]
    );

    console.log(`🛠️ Platform setting '${key}' updated by user ${req.user?.userId}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`PATCH /super/platform-settings/${req.params.key} error:`, err);
    res.status(500).json({ error: { message: 'Failed to save platform setting' } });
  }
});



module.exports = router;
