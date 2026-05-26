// ─────────────────────────────────────────────────────────────────────────────
// services/ReportingScopeService.js
//
// Resolves the set of user IDs whose activity a given viewer is allowed to
// see in the manager-reporting feature. This is the single source of truth
// for "who's on my team" — every reporting endpoint calls this and uses the
// returned userIds to filter queries.
//
// Why a service: scope resolution is a small but security-critical piece of
// logic. Centralizing it means we can reason about the auth boundary in one
// place. Every callsite passing ?userIds= from the client MUST intersect with
// this resolved scope server-side before any query touches sequence data.
//
// Depth model:
//   The manager picks a depth level for their view (persisted in
//   user_preferences). The four choices map to which hierarchyService
//   method backs the query:
//
//     'direct'  → hierarchyService.getDirectReports     (depth = 1 only)
//     'plus1'   → hierarchyService.getSubordinatesWithDepth(orgId, uid, 2)
//     'plus2'   → hierarchyService.getSubordinatesWithDepth(orgId, uid, 3)
//     'all'     → hierarchyService.getSubordinates       (no depth cap)
//
//   The 'all' path uses the unbounded version because it's slightly cheaper
//   than getSubordinatesWithDepth(orgId, uid, Number.MAX_SAFE_INTEGER) —
//   no depth column to compute, no per-user ROW_NUMBER ranking. For 'all'
//   we synthesize depthFromManager = null in the response because the
//   answer "how many levels deep" isn't surfaced by the unbounded query.
//   Callers that need the level info should ask for 'plus2' or lower.
//
// Fallback chain (in priority order):
//   1. Caller is org admin/owner   → scope='admin', userIds = all org users
//   2. Caller has subordinates     → scope='team',  userIds per depth
//   3. Otherwise                    → scope='self',  userIds = [callerId]
//
// The viewer is ALWAYS included in the userIds list. A manager viewing
// "their team" includes themselves — their own work is part of the team.
//
// The auth contract:
//   resolveReportingScope(viewerId, orgId, opts) is the gatekeeper.
//   If a caller passes ?userIds=X,Y,Z, the route handler MUST intersect
//   those with the returned userIds and silently drop the rest. The route
//   never queries sequence data using user-supplied IDs directly.
// ─────────────────────────────────────────────────────────────────────────────

const { pool }          = require('../config/database');
const hierarchyService  = require('./hierarchyService');

const VALID_DEPTHS = ['direct', 'plus1', 'plus2', 'all'];
const DEFAULT_DEPTH = 'direct';

/**
 * Validate and normalize a depth string. Returns DEFAULT_DEPTH for any
 * input that isn't one of the four allowed values (including null,
 * undefined, or an empty string).
 */
function normalizeDepth(depth) {
  if (typeof depth !== 'string') return DEFAULT_DEPTH;
  return VALID_DEPTHS.includes(depth) ? depth : DEFAULT_DEPTH;
}

/**
 * Check if a user is an org admin or owner. Uses the org_users.role column
 * (NOT users.role, which is global). A user with no org_users row is
 * treated as a regular member — we never elevate based on absence of data.
 */
async function _isOrgAdmin(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT role FROM org_users
      WHERE org_id = $1 AND user_id = $2 AND is_active = true`,
    [orgId, userId]
  );
  if (!rows.length) return false;
  return rows[0].role === 'admin' || rows[0].role === 'owner';
}

/**
 * Returns all active user IDs in the org. Used for the admin scope path.
 * Active = has a non-null org_users row with is_active = true.
 */
async function _allOrgUserIds(orgId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM org_users
      WHERE org_id = $1 AND is_active = true
      ORDER BY user_id ASC`,
    [orgId]
  );
  return rows.map(r => r.user_id);
}

/**
 * Hydrate a list of user IDs into [{ userId, name, email }] rows.
 * Caller-friendly: name is "First Last" already concatenated; missing
 * names render as the email instead.
 */
async function _hydrateUsers(orgId, userIds) {
  if (!userIds.length) return [];
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, email
       FROM users
      WHERE id = ANY($1::int[]) AND org_id = $2`,
    [userIds, orgId]
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  return userIds.map(id => {
    const u = byId.get(id);
    if (!u) return { userId: id, name: null, email: null };
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email;
    return { userId: id, name, email: u.email };
  });
}

/**
 * Human-readable scope summary for the UI's scope indicator line.
 * Shape examples:
 *   "Showing only your activity"
 *   "Showing 4 direct reports + you"
 *   "Showing 6 reports across 2 levels + you"
 *   "Showing 12 reports (all levels) + you"
 *   "Showing all 8 users in the org (admin)"
 */
function _sizeNote({ scope, depth, reports }) {
  if (scope === 'self') return 'Showing only your activity';
  if (scope === 'admin') return `Showing all ${reports.length} users in the org (admin)`;
  const n = reports.length;
  if (depth === 'direct') return `Showing ${n} direct report${n === 1 ? '' : 's'} + you`;
  if (depth === 'plus1')  return `Showing ${n} reports across 2 levels + you`;
  if (depth === 'plus2')  return `Showing ${n} reports across 3 levels + you`;
  if (depth === 'all')    return `Showing ${n} reports (all levels) + you`;
  return `Showing ${n} reports + you`;
}

const ReportingScopeService = {

  VALID_DEPTHS,
  DEFAULT_DEPTH,
  normalizeDepth,

  /**
   * Resolve the reporting scope for a viewer.
   *
   * @param {number} viewerId   The user requesting the report.
   * @param {number} orgId      Their org (from auth context, never client input).
   * @param {object} [opts]
   * @param {string} [opts.depth]            One of VALID_DEPTHS. Coerced to DEFAULT_DEPTH if invalid.
   * @param {number[]} [opts.explicitUserIds] If the caller passed ?userIds=, intersect
   *                                          with the resolved scope and return only
   *                                          the survivors. Out-of-scope IDs are silently
   *                                          dropped — never errored — to avoid leaking
   *                                          information about which IDs exist.
   *
   * @returns {Promise<{
   *   scope:    'self' | 'team' | 'admin',
   *   depth:    'direct' | 'plus1' | 'plus2' | 'all',
   *   userIds:  number[],
   *   reports:  Array<{ userId, name, email, depthFromManager: number|null, isDirect: boolean }>,
   *   source:   'org_hierarchy' | 'org_role' | 'fallback_self',
   *   hasTeam:  boolean,
   *   sizeNote: string,
   * }>}
   *
   *   userIds — always non-empty; always includes viewerId. This is what
   *             route handlers pass to WHERE clauses.
   *   reports — sibling info for the UI. Includes viewer only when scope
   *             is 'admin' (where viewer is one of the users); excludes
   *             viewer when scope is 'team' (viewer is the manager, not a
   *             report); empty when scope is 'self'.
   *   depthFromManager — 1 for direct reports, 2..N for indirect when
   *                      depth is bounded ('direct', 'plus1', 'plus2').
   *                      null when depth is 'all' (we don't compute the
   *                      number — see service header for why).
   *                      Also null when scope is 'admin' (no manager
   *                      relationship in that view).
   */
  async resolveReportingScope(viewerId, orgId, opts = {}) {
    if (!Number.isInteger(viewerId) || !Number.isInteger(orgId)) {
      throw new Error('resolveReportingScope: viewerId and orgId must be integers');
    }

    const depth = normalizeDepth(opts.depth);
    const explicitUserIds = Array.isArray(opts.explicitUserIds)
      ? opts.explicitUserIds.filter(Number.isInteger)
      : null;

    // ── Path 1: admin / owner ────────────────────────────────────────
    if (await _isOrgAdmin(orgId, viewerId)) {
      const allIds = await _allOrgUserIds(orgId);
      const hydrated = await _hydrateUsers(orgId, allIds);
      const allReports = hydrated.map(u => ({
        ...u,
        depthFromManager: null,
        isDirect: false,
      }));

      const userIds = explicitUserIds
        ? explicitUserIds.filter(id => allIds.includes(id))
        : allIds;

      // Always ensure viewer is in the userIds set
      const finalIds = userIds.includes(viewerId) ? userIds : [...userIds, viewerId];

      // Reports list moves with userIds (same rationale as the team
      // path below) — admins who narrow their view should see only the
      // narrowed list, not zero-state rows for everyone else.
      const reports = explicitUserIds
        ? allReports.filter(r => explicitUserIds.includes(r.userId))
        : allReports;

      return {
        scope:    'admin',
        depth,
        userIds:  finalIds,
        reports,
        source:   'org_role',
        hasTeam:  true,
        sizeNote: _sizeNote({ scope: 'admin', depth, reports }),
      };
    }

    // ── Path 2: team (has subordinates) ──────────────────────────────
    // Branch on depth to pick the cheapest correct query.
    let subordinates;   // [{ user_id, depth }] when depth-bounded; [user_id] when 'all'
    let isUnboundedAll = false;

    if (depth === 'direct') {
      // getDirectReports returns rich rows; we just need the IDs at depth 1.
      const direct = await hierarchyService.getDirectReports(orgId, viewerId);
      subordinates = direct.map(r => ({ user_id: r.user_id, depth: 1 }));
    } else if (depth === 'plus1') {
      subordinates = await hierarchyService.getSubordinatesWithDepth(orgId, viewerId, 2);
    } else if (depth === 'plus2') {
      subordinates = await hierarchyService.getSubordinatesWithDepth(orgId, viewerId, 3);
    } else {
      // 'all' — use unbounded for cheaper query, lose the depth info per service header.
      const ids = await hierarchyService.getSubordinates(orgId, viewerId);
      subordinates = ids.map(id => ({ user_id: id, depth: null }));
      isUnboundedAll = true;
    }

    if (subordinates.length === 0) {
      // ── Path 3: fallback self ──────────────────────────────────────
      return {
        scope:    'self',
        depth,
        userIds:  [viewerId],
        reports:  [],
        source:   'fallback_self',
        hasTeam:  false,
        sizeNote: _sizeNote({ scope: 'self', depth, reports: [] }),
      };
    }

    // Hydrate the report list with names/emails.
    const reportIds = subordinates.map(s => s.user_id);
    const hydrated = await _hydrateUsers(orgId, reportIds);
    const byId = new Map(hydrated.map(h => [h.userId, h]));

    const allReports = subordinates.map(s => {
      const h = byId.get(s.user_id) || { userId: s.user_id, name: null, email: null };
      const depthFromManager = isUnboundedAll ? null : s.depth;
      return {
        ...h,
        depthFromManager,
        isDirect: !isUnboundedAll && s.depth === 1,
      };
    });

    // Build the final userIds set: subordinates + the viewer themselves.
    // The viewer's own work counts as "team activity" because a working
    // manager who's also sending sequences should see themselves in the roll-up.
    const teamPlusViewerIds = [...reportIds, viewerId];

    const userIds = explicitUserIds
      ? explicitUserIds.filter(id => teamPlusViewerIds.includes(id))
      : teamPlusViewerIds;

    // Reports list moves with userIds — if Minaakshi filters her view to
    // just Rohit, Priya disappears from the reports list entirely (not
    // shown at zero-state). This was a deliberate UX decision: showing
    // a filtered-out rep at zero-state is more confusing than just
    // hiding them. To get the full structural view, the viewer clears
    // the userIds filter.
    //
    // The viewer themselves is filtered out of `reports` regardless —
    // `reports` is the team-list-not-including-the-manager. So when
    // explicitUserIds = [viewerId] alone, reports correctly shrinks to [].
    const reports = explicitUserIds
      ? allReports.filter(r => explicitUserIds.includes(r.userId))
      : allReports;

    // Guarantee non-empty — if the explicitUserIds filter dropped everything,
    // fall back to viewer-only so the query still returns rows (just empty
    // for the team). Better UX than 400'ing.
    const finalIds = userIds.length > 0 ? userIds : [viewerId];

    return {
      scope:    'team',
      depth,
      userIds:  finalIds,
      reports,
      source:   'org_hierarchy',
      hasTeam:  true,
      sizeNote: _sizeNote({ scope: 'team', depth, reports }),
    };
  },
};

module.exports = ReportingScopeService;
