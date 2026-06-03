// ─────────────────────────────────────────────────────────────────────────────
// services/AccessPolicy.js
//
// The single, entity-agnostic core for the Prospecting ownership + visibility
// model. Every prospecting surface (sequences first, then campaigns, prospects,
// deals, CLM, service, handover) goes through this for its read scoping and
// edit gating, so the security-critical rules live and can be audited in ONE
// place. Per-module code stays a thin adapter: it passes its own column names
// and the row's owner / visibility / allow-manager-edit, and this module
// returns the decision.
//
// Builds on two existing services and adds nothing role-specific of its own:
//   • ReportingScopeService — resolves WHO a viewer may see (self/team/all).
//   • CampaignAccess.isAdmin — the org admin/owner check.
//
// Rules:
//   READ  — an item is visible when it is 'shared' (everyone) OR its owner is
//           in the viewer's resolved scope (self → own; manager → team; admin →
//           all). So shared items are org-wide; private items only reach the
//           owner and, through scope, their manager / an admin.
//   EDIT  — the owner always; an admin always; a manager-of-owner only if the
//           org-level `manager_can_edit` policy is ON, OR the specific item is
//           flagged allow_manager_edit by its owner (the per-item opt-in).
// ─────────────────────────────────────────────────────────────────────────────

const ReportingScopeService = require('./ReportingScopeService');
const CampaignAccess        = require('./CampaignAccess');
const CampaignSettings      = require('./campaignSettings.service');

/**
 * Resolve the set of owner user IDs whose items the viewer may see, honoring
 * the optional Mine/Team scope from the UI.
 *
 * @param {object} req  - must carry req.userId and req.orgId.
 * @param {object} opts - { depth?, explicitUserIds? }. Pass explicitUserIds=
 *                        [req.userId] for an explicit "Mine" view; pass depth
 *                        ('direct'|'plus1'|'plus2'|'all') for a "Team" view.
 * @returns {Promise<{ scope, userIds:number[], reports:Array }>}
 */
async function resolveScope(req, opts = {}) {
  return ReportingScopeService.resolveReportingScope(req.userId, req.orgId, opts);
}

/**
 * SQL fragment for "rows this viewer may see": shared to everyone, OR owned by
 * someone in the viewer's resolved scope. Pushes scopeUserIds onto `params`
 * (mutated) and returns the clause string.
 */
function visibilityClause(cfg, params) {
  const {
    alias,
    scopeUserIds,
    ownerCol = 'created_by',
    visibilityCol = 'visibility',
  } = cfg;
  params.push(scopeUserIds);
  const p = params.length;
  return `(${alias}.${visibilityCol} = 'shared' OR ${alias}.${ownerCol} = ANY($${p}::int[]))`;
}

/**
 * Can the viewer edit an item owned by ownerId?
 *
 *   owner                → yes
 *   admin / owner role    → yes
 *   manager-of-owner      → yes if org manager_can_edit is ON, OR the item is
 *                           flagged allow_manager_edit (opts.allowManagerEdit)
 *   everyone else         → no
 *
 * @param {object} opts - { allowManagerEdit?: boolean } the item's per-row flag.
 * @returns {Promise<{ allowed:boolean, reason:string|null }>}
 */
async function canEditItem(req, ownerId, opts = {}) {
  if (ownerId != null && ownerId === req.userId) {
    return { allowed: true, reason: null };
  }
  if (await CampaignAccess.isAdmin(req)) {
    return { allowed: true, reason: null };
  }

  const subs = req.subordinateIds || [];
  if (ownerId != null && subs.includes(ownerId)) {
    if (opts.allowManagerEdit === true) {
      return { allowed: true, reason: null };
    }
    const { manager_can_edit } = await CampaignSettings.getForOrg(req.orgId);
    if (manager_can_edit) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason:
        "View only — you manage this owner, but editing isn't enabled for this item. " +
        'The owner can allow it per item, or an admin can turn on "Managers can edit" org-wide.',
    };
  }

  return {
    allowed: false,
    reason: "Only the owner can edit this — it belongs to another user in your org.",
  };
}

/**
 * Express helper: enforce canEditItem, sending a 403 and returning false when
 * not allowed. Returns true when the caller may proceed.
 *
 * @param {object} opts - { allowManagerEdit?: boolean } forwarded to canEditItem.
 */
async function requireCanEdit(req, res, ownerId, opts = {}) {
  const { allowed, reason } = await canEditItem(req, ownerId, opts);
  if (!allowed) {
    res.status(403).json({ error: { message: reason } });
    return false;
  }
  return true;
}

/**
 * Batch edit-context — resolves the inputs canEditItem needs ONCE so a list
 * endpoint can decide editability per row without N+1 queries. Pair with
 * canEditWith(ctx, ownerId, allowManagerEdit) per row.
 *
 * @returns {Promise<{ viewerId, isAdmin, subs:Set<number>, managerCanEdit:boolean }>}
 */
async function editContext(req) {
  const viewerId = req.userId;
  const isAdmin  = await CampaignAccess.isAdmin(req);
  const subs     = new Set(req.subordinateIds || []);

  let managerCanEdit = false;
  if (!isAdmin && subs.size > 0) {
    const { manager_can_edit } = await CampaignSettings.getForOrg(req.orgId);
    managerCanEdit = !!manager_can_edit;
  }

  return { viewerId, isAdmin, subs, managerCanEdit };
}

/**
 * Pure per-row editability decision against a pre-resolved editContext.
 * Mirrors canEditItem's rules without any I/O.
 *
 * @param {boolean} allowManagerEdit - the row's per-item opt-in flag.
 */
function canEditWith(ctx, ownerId, allowManagerEdit = false) {
  if (ownerId != null && ownerId === ctx.viewerId) return true;
  if (ctx.isAdmin) return true;
  if (ownerId != null && ctx.subs.has(ownerId)) {
    return ctx.managerCanEdit || allowManagerEdit === true;
  }
  return false;
}

module.exports = {
  resolveScope,
  visibilityClause,
  canEditItem,
  requireCanEdit,
  editContext,
  canEditWith,
};
