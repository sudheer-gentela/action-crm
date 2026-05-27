// ─────────────────────────────────────────────────────────────────────────────
// CampaignAccess — owner-based access control for prospecting_campaigns.
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors the access pattern already used by `campaignConfigGuard` in
// prospecting-campaigns.routes.js (which has been retained as the per-handler
// guard for /:id/config endpoints). This module generalises that approach:
//
//   1. ADMIN BYPASS — anyone in org_users with role 'admin' or 'owner' has
//      full access to every campaign in their org. Same semantics that
//      requireRole('admin') gives elsewhere, but resolved at call-time.
//
//   2. OWNER MATCH — non-admin users with campaign.owner_id === req.userId
//      can read AND mutate.
//
//   3. MANAGER ROLLUP — non-admin users can READ (but NOT mutate) campaigns
//      owned by anyone in req.subordinateIds (populated by orgContext
//      middleware via the org_hierarchy recursive CTE).
//
//   4. EVERYONE ELSE — 403.
//
// CACHE: req._cachedRole stores the lookup so a single request doing
// multiple access checks (e.g. PUT /:id which also re-loads the campaign)
// hits the DB once.
//
// NOTE on the 403 message strings: apiFetch in prospectingShared.js
// auto-refreshes the token on 403 with message === 'Invalid or expired
// token'. The strings here MUST NOT match that exact string; they all start
// with "You don't have permission..." which is safe.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

const ADMIN_ROLES = new Set(['admin', 'owner']);

/**
 * Look up the caller's org_users.role for the current org. Caches on req so
 * repeated checks within one handler don't hit the DB twice. Returns the
 * role string ('admin' | 'owner' | 'member') or null if the user isn't an
 * active member of the org.
 */
async function loadUserRole(req) {
  if (req._cachedRole !== undefined) return req._cachedRole;

  const { rows } = await pool.query(
    `SELECT role FROM org_users
      WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
    [req.userId, req.orgId]
  );
  const role = rows[0]?.role || null;
  req._cachedRole = role;
  return role;
}

/** True if the caller has an admin-equivalent role for this org. */
async function isAdmin(req) {
  const role = await loadUserRole(req);
  return role !== null && ADMIN_ROLES.has(role);
}

/**
 * Read-access check. Pass the campaign row (must have owner_id at minimum).
 * Returns { allowed, reason } — reason is human-readable, suitable for the
 * 403 body.
 *
 * Read access is granted to:
 *   • Admins / owners (org-level role)
 *   • The campaign owner
 *   • Any manager whose subordinateIds (transitive, solid-line) include the
 *     campaign owner
 */
async function canAccessCampaign(req, campaign) {
  if (!campaign) return { allowed: false, reason: 'Campaign not found' };

  if (await isAdmin(req)) {
    return { allowed: true, reason: null };
  }
  if (campaign.owner_id === req.userId) {
    return { allowed: true, reason: null };
  }
  const subs = req.subordinateIds || [];
  if (subs.includes(campaign.owner_id)) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: "You don't have permission to view this campaign. It's owned by another user in your org.",
  };
}

/**
 * Mutate-access check. Same shape as canAccessCampaign, but stricter:
 * managers can READ subordinates' campaigns but NOT mutate them. This is the
 * standard CRM pattern (Salesforce, HubSpot defaults) — managers oversee
 * but don't silently change their team's work.
 *
 * Mutate access is granted to:
 *   • Admins / owners (org-level role)
 *   • The campaign owner (only)
 */
async function canMutateCampaign(req, campaign) {
  if (!campaign) return { allowed: false, reason: 'Campaign not found' };

  if (await isAdmin(req)) {
    return { allowed: true, reason: null };
  }
  if (campaign.owner_id === req.userId) {
    return { allowed: true, reason: null };
  }
  // Distinguish the manager-trying-to-mutate case for a clearer message —
  // managers should know they CAN see this campaign but CAN'T change it.
  const subs = req.subordinateIds || [];
  if (subs.includes(campaign.owner_id)) {
    return {
      allowed: false,
      reason: "You don't have permission to modify this campaign. As a manager you can view your team's campaigns but only the owner or an admin can change them.",
    };
  }
  return {
    allowed: false,
    reason: "You don't have permission to modify this campaign. Only the owner or an admin can change it.",
  };
}

/**
 * Convenience: check + respond with 403 in one call. Returns true if the
 * caller is allowed to proceed; returns false (after writing the response)
 * if not. Handlers do:
 *
 *   if (!(await requireCanAccess(req, res, campaign))) return;
 *
 * which keeps the call site to a single line.
 */
async function requireCanAccess(req, res, campaign) {
  const { allowed, reason } = await canAccessCampaign(req, campaign);
  if (allowed) return true;
  res.status(403).json({ error: { message: reason } });
  return false;
}

async function requireCanMutate(req, res, campaign) {
  const { allowed, reason } = await canMutateCampaign(req, campaign);
  if (allowed) return true;
  res.status(403).json({ error: { message: reason } });
  return false;
}

module.exports = {
  loadUserRole,
  isAdmin,
  canAccessCampaign,
  canMutateCampaign,
  requireCanAccess,
  requireCanMutate,
  ADMIN_ROLES,
};
