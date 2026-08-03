/**
 * projectSettings.service.js
 *
 * DROP-IN LOCATION: backend/services/projectSettings.service.js  (NEW FILE)
 *
 * Per-org configuration for who can see which projects in the Projects
 * (handover) module, stored in organizations.settings->'project_access'.
 *
 * Follows the same shape as callSettings.service.js: stored values merge over
 * SYSTEM_DEFAULTS, so a partial config still resolves to a complete object and
 * new keys added here apply to every org without a migration.
 *
 * No new table. organizations.settings is already the home for module config
 * (modules, icp_config, prospecting_config, team_dimensions, ...).
 */

const { pool } = require('../config/database');

const SYSTEM_DEFAULTS = {
  // Which hierarchy drives team rollup.
  //   'people' — org_hierarchy reporting lines (solid + dotted). Live today,
  //              and consistent with Deals, Actions, Accounts, Contacts and
  //              Prospecting, which all scope this way.
  //   'team'   — teams.parent_team_id nesting. Phase 2; the resolver below
  //              deliberately refuses it rather than silently falling back,
  //              so a half-configured org fails loudly instead of showing the
  //              wrong projects.
  rollup_basis: 'people',

  // Which column makes a user "the owner" of a project for team rollup.
  //   'service_owner' — assigned_service_owner_id (the person delivering it)
  //   'created_by'    — whoever created the handover record
  owner_field: 'service_owner',

  // Managers can see their reports' projects at all.
  team_scope_enabled: true,

  // org_users.role values allowed to use scope=org.
  org_scope_roles: ['owner', 'admin'],

  // Projects with no service owner are a real operational state, not an error.
  // Hiding them means a project can be invisible to everyone but its creator,
  // which is exactly the case a head of projects needs to catch. Shown in team
  // scope and flagged in the UI rather than filtered out.
  show_unassigned_in_team_scope: true,

  // Restricted tabs (commercial) currently resolve to: org admin, service
  // owner, deal owner, or an explicit per-project grant. With this on, anyone
  // ABOVE the service owner in the hierarchy resolves too — so a head of
  // projects sees commercial terms for their reports' projects without needing
  // a grant on each one.
  //
  // Turn it off if commercial terms should stay need-to-know regardless of
  // reporting line. That is a legitimate policy, which is why this is a switch
  // rather than a hard-coded rule.
  commercial_follows_hierarchy: true,

  // The "From my deals" tab lists projects by created_by — the deals this
  // person closed. Off by default because for most people it is not a useful
  // lens, and the closer now stays attached through project_members anyway, so
  // hiding it no longer costs them visibility.
  show_from_my_deals_tab: false,

  // What the person accountable for a project is called. The database column is
  // assigned_service_owner_id and stays that way — renaming it would touch every
  // query in the handover, reporting and health services for no functional gain.
  // Orgs differ here (Project Manager, Delivery Lead, Engagement Manager), and a
  // single project can override it.
  manager_label: 'Project Manager',

  // Whether an internal customer must accept the project before it can be
  // completed.
  //   'soft' — sign-off is recorded if it happens, and never blocks.
  //   'hard' — completion is blocked until the project is signed off.
  //
  // The gate only bites once an internal customer has actually been named on
  // the project (project_members.side = 'internal_customer', status approved).
  // Blocking a project that has no named acceptor would strand it with nobody
  // able to unblock it.
  //
  // Default 'soft' so turning this on is a deliberate act and nothing currently
  // in flight is caught by it.
  closure_signoff_mode: 'soft',
};

const VALID_ROLES  = ['owner', 'admin', 'member', 'viewer'];
const VALID_BASIS  = ['people', 'team'];
const VALID_OWNER  = ['service_owner', 'created_by'];
const VALID_SIGNOFF = ['soft', 'hard'];

function merge(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    ...SYSTEM_DEFAULTS,
    ...s,
    // Arrays must not be spread-merged elementwise; take stored wholesale or
    // fall back to the default.
    org_scope_roles: Array.isArray(s.org_scope_roles) && s.org_scope_roles.length
      ? s.org_scope_roles.filter(r => VALID_ROLES.includes(r))
      : SYSTEM_DEFAULTS.org_scope_roles,
  };
}

async function get(orgId) {
  const { rows } = await pool.query(
    `SELECT settings->'project_access' AS cfg FROM organizations WHERE id = $1`,
    [orgId]
  );
  return merge(rows[0]?.cfg);
}

/**
 * Partial update. Only known keys are written, and each is validated — an
 * org-admin screen should not be able to persist a value the resolver cannot
 * interpret.
 */
async function update(orgId, patch = {}) {
  const current = await get(orgId);
  const next    = { ...current };

  if (patch.rollup_basis !== undefined) {
    if (!VALID_BASIS.includes(patch.rollup_basis)) {
      const e = new Error(`rollup_basis must be one of: ${VALID_BASIS.join(', ')}`);
      e.status = 400; throw e;
    }
    next.rollup_basis = patch.rollup_basis;
  }

  if (patch.owner_field !== undefined) {
    if (!VALID_OWNER.includes(patch.owner_field)) {
      const e = new Error(`owner_field must be one of: ${VALID_OWNER.join(', ')}`);
      e.status = 400; throw e;
    }
    next.owner_field = patch.owner_field;
  }

  if (patch.org_scope_roles !== undefined) {
    if (!Array.isArray(patch.org_scope_roles)) {
      const e = new Error('org_scope_roles must be an array'); e.status = 400; throw e;
    }
    const bad = patch.org_scope_roles.filter(r => !VALID_ROLES.includes(r));
    if (bad.length) {
      const e = new Error(`Unknown role(s): ${bad.join(', ')}`); e.status = 400; throw e;
    }
    // Owners must never be able to lock themselves out of org-wide visibility.
    next.org_scope_roles = [...new Set(['owner', ...patch.org_scope_roles])];
  }

  if (patch.manager_label !== undefined) {
    const v = String(patch.manager_label || '').trim();
    if (!v)          { const e = new Error('manager_label cannot be blank'); e.status = 400; throw e; }
    if (v.length > 40) { const e = new Error('manager_label must be 40 characters or fewer'); e.status = 400; throw e; }
    next.manager_label = v;
  }

  if (patch.closure_signoff_mode !== undefined) {
    if (!VALID_SIGNOFF.includes(patch.closure_signoff_mode)) {
      const e = new Error(`closure_signoff_mode must be one of: ${VALID_SIGNOFF.join(', ')}`);
      e.status = 400; throw e;
    }
    next.closure_signoff_mode = patch.closure_signoff_mode;
  }

  for (const k of ['team_scope_enabled', 'show_unassigned_in_team_scope',
                   'commercial_follows_hierarchy', 'show_from_my_deals_tab']) {
    if (patch[k] !== undefined) {
      if (typeof patch[k] !== 'boolean') {
        const e = new Error(`${k} must be a boolean`); e.status = 400; throw e;
      }
      next[k] = patch[k];
    }
  }

  await pool.query(
    `UPDATE organizations
        SET settings = jsonb_set(COALESCE(settings, '{}'), '{project_access}', $1::jsonb, true)
      WHERE id = $2`,
    [JSON.stringify(next), orgId]
  );

  return next;
}

/**
 * Resolve a user's org role.
 *
 * Necessary because req.userRole is populated by the requireRole middleware,
 * which the handover routes do not use — they run authenticateToken +
 * orgContext only, and orgContext sets orgId/subordinateIds but not the role.
 * Reading req.userRole there yields undefined and would deny org scope to
 * everyone, owners included.
 */
async function resolveRole(orgId, userId) {
  if (!orgId || !userId) return null;
  const { rows } = await pool.query(
    `SELECT role FROM org_users WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  return rows[0]?.role ?? null;
}

/** Can this org role use scope=org? */
function canUseOrgScope(cfg, role) {
  return Array.isArray(cfg.org_scope_roles) && cfg.org_scope_roles.includes(role);
}

/** SQL column backing the configured owner_field. */
function ownerColumn(cfg) {
  return cfg.owner_field === 'created_by' ? 'created_by' : 'assigned_service_owner_id';
}

module.exports = {
  SYSTEM_DEFAULTS,
  get,
  update,
  resolveRole,
  canUseOrgScope,
  ownerColumn,
};
