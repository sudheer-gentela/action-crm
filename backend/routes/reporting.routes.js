// ─────────────────────────────────────────────────────────────────────────────
// routes/reporting.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Cross-campaign sequence reporting for managers.
//
// Mount: app.use('/api/reporting', require('./routes/reporting.routes'));
//
// Endpoints:
//   GET /api/reporting/sequences/team-overview
//   GET /api/reporting/sequences/team-by-rep
//   GET /api/reporting/sequences/team-by-sequence    (Phase 3)
//
// All three endpoints return aggregate metrics across multiple campaigns and
// sequences, scoped to "what this viewer is allowed to see" via
// ReportingScopeService. That service is the single auth gatekeeper —
// these routes never query sequence data using client-supplied user IDs
// without first intersecting them with the resolved scope.
//
// Time window semantics:
//   - If both startDate and endDate are present, use them (inclusive).
//   - Else if windowDays is present, use [now - windowDays, now].
//   - Else default to the last 7 days (matches the existing
//     /api/prospecting-campaigns/:id/sequence-health "7d" bucket).
//
// Campaign filter:
//   - If campaignIds is present, restrict to those campaigns only
//     (intersected with what the viewer's scope can see — same auth
//     pattern as userIds).
//   - Else include every campaign that has at least one prospect owned
//     by anyone in the resolved scope.
//
// See: SEQUENCE_REPORTING_DESIGN.md §4.4 for the design rationale and
// the precise response shapes; §5 for how the frontend uses these.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const authenticateToken      = require('../middleware/auth.middleware');
const { orgContext }         = require('../middleware/orgContext.middleware');
const ReportingScopeService  = require('../services/ReportingScopeService');

router.use(authenticateToken);
router.use(orgContext);

// ─────────────────────────────────────────────────────────────────────────────
// Shared parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a comma-separated query param as an integer array.
 * Returns null when the param is missing/empty (signals "no filter"),
 * or a possibly-empty array of valid integers.
 *
 * "1,2,abc,3" → [1, 2, 3]   (silently drops invalid entries)
 * undefined   → null
 * ""          → null
 */
function parseIntListParam(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const list = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => parseInt(s, 10))
    .filter(Number.isInteger);
  return list;   // possibly empty array
}

/**
 * Resolve the time window from query params.
 *
 * Returns { startISO, endISO, isoIntervalDescription } where:
 *   - startISO/endISO are ISO 8601 strings ready to bind as $N::timestamptz
 *   - isoIntervalDescription is a short string the response echoes back,
 *     useful for the UI's "showing 7 days" indicator
 *
 * Precedence:
 *   1. Both startDate AND endDate present → use them
 *   2. windowDays present → [now - windowDays days, now]
 *   3. Default → last 7 days
 *
 * windowDays is clamped to [1, 365] to prevent unbounded queries.
 */
function parseTimeWindow(query) {
  const { startDate, endDate, windowDays } = query;

  if (startDate && endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      throw new Error('startDate and endDate must be valid ISO date strings');
    }
    return {
      startISO: s.toISOString(),
      endISO:   e.toISOString(),
      isoIntervalDescription: `${s.toISOString().slice(0, 10)} to ${e.toISOString().slice(0, 10)}`,
    };
  }

  const days = windowDays !== undefined
    ? Math.max(1, Math.min(365, parseInt(windowDays, 10) || 7))
    : 7;
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    startISO: start.toISOString(),
    endISO:   end.toISOString(),
    isoIntervalDescription: `last ${days} day${days === 1 ? '' : 's'}`,
  };
}

/**
 * Apply campaign-id filter against the viewer's scope.
 * Same pattern as ReportingScopeService for userIds — silently drop
 * out-of-scope IDs, never error, to avoid leaking which IDs exist.
 *
 * Returns null when no filter was requested (caller's WHERE clause
 * skips the campaign predicate). Returns an array (possibly empty)
 * when filtering should apply.
 *
 * "In scope" = the campaign has at least one prospect owned by a user
 * in scope.userIds. We compute this in one query rather than two
 * round-trips.
 */
async function resolveCampaignFilter(orgId, scopeUserIds, requestedCampaignIds) {
  if (requestedCampaignIds === null) return null;

  if (requestedCampaignIds.length === 0) {
    // Caller passed ?campaignIds= with empty value — interpret as
    // "filter to nothing" (returns no data). Distinct from "no filter".
    return [];
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT c.id
       FROM prospecting_campaigns c
       JOIN prospects p ON p.campaign_id = c.id
      WHERE c.org_id = $1
        AND c.id    = ANY($2::int[])
        AND p.owner_id = ANY($3::int[])
        AND p.deleted_at IS NULL`,
    [orgId, requestedCampaignIds, scopeUserIds]
  );
  return rows.map(r => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/sequences/team-overview
// ─────────────────────────────────────────────────────────────────────────────
//
// High-level rollup for the "All Campaigns — by Campaign" view.
//
// Returns:
//   {
//     scope: { ... from ReportingScopeService },
//     period: { startDate, endDate, description },
//     totals: { activeCampaigns, activeSequences, enrolledProspects,
//               drafts, sent, replied, failed, stalled, repliedRate },
//     campaigns: [ { campaignId, name, owner: {...}, enrolled, drafts,
//                    sent, replied, failed, stalled, lastActivityAt } ]
//   }
//
// "Stalled" = active enrollments with no log activity since 7 days before
// the window's end. Matches the existing /sequence-health definition.
//
// SQL strategy:
//   Two queries — one for the totals row, one for the per-campaign rows.
//   Both filter step logs by fired_at IN [start, end] and by the resolved
//   scope of enrolled_by. The campaign-level query left-joins logs so a
//   campaign with zero activity in the window still appears with zero
//   counters (lets the manager see "Sudheer's campaign is dormant this
//   week" — explicit zero is signal).
//
router.get('/sequences/team-overview', async (req, res) => {
  try {
    const explicitUserIds = parseIntListParam(req.query.userIds);
    const requestedCampaignIds = parseIntListParam(req.query.campaignIds);

    const window = parseTimeWindow(req.query);

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, explicitUserIds }
    );

    const scopeUserIds = scope.userIds;
    const campaignIdFilter = await resolveCampaignFilter(
      req.orgId, scopeUserIds, requestedCampaignIds
    );

    // ── Per-campaign aggregates ─────────────────────────────────────
    //
    // We base the row set on prospecting_campaigns LEFT JOINed to the
    // activity tables so campaigns owned by in-scope users with zero
    // logs in the window still show up. The "in scope" predicate is on
    // prospects.owner_id (which we equate to "the rep responsible for
    // this prospect in this campaign"). We use enrollments.enrolled_by
    // for the activity-level rollup so a rep who enrolled a prospect
    // owned by someone else also surfaces (handover scenarios).
    //
    // A campaign is included if either:
    //   - It has prospects owned by an in-scope user, OR
    //   - It has enrollments created by an in-scope user
    // The OR happens via the UNION of two existence subqueries.

    let campaignWhere = `c.org_id = $1 AND (
       EXISTS (SELECT 1 FROM prospects p
                WHERE p.campaign_id = c.id
                  AND p.owner_id    = ANY($2::int[])
                  AND p.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM sequence_enrollments se
                       JOIN prospects p ON p.id = se.prospect_id
                  WHERE p.campaign_id = c.id
                    AND se.enrolled_by = ANY($2::int[]))
    )`;
    const campaignParams = [req.orgId, scopeUserIds];

    if (campaignIdFilter !== null) {
      if (campaignIdFilter.length === 0) {
        // Empty filter → return empty response, skip queries entirely
        return res.json({
          scope,
          period: {
            startDate: window.startISO,
            endDate:   window.endISO,
            description: window.isoIntervalDescription,
          },
          totals:    _emptyTotals(),
          campaigns: [],
        });
      }
      campaignParams.push(campaignIdFilter);
      campaignWhere += ` AND c.id = ANY($${campaignParams.length}::int[])`;
    }

    // Time window params come last so the indexes align across both queries.
    campaignParams.push(window.startISO, window.endISO);
    const startIdx = campaignParams.length - 1;   // 1-based: position of startISO
    const endIdx   = campaignParams.length;

    const perCampaignRes = await pool.query(
      `WITH log_agg AS (
         SELECT
           p.campaign_id,
           COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                              AS drafts,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int                AS sent,
           COUNT(*) FILTER (WHERE ssl.status = 'replied')::int                            AS replied,
           COUNT(*) FILTER (WHERE ssl.status = 'failed')::int                             AS failed,
           MAX(ssl.fired_at) AS last_fired_at
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN prospects p             ON p.id = se.prospect_id
         WHERE ssl.org_id    = $1
           AND ssl.fired_at >= $${startIdx}::timestamptz
           AND ssl.fired_at <= $${endIdx}::timestamptz
           AND se.enrolled_by = ANY($2::int[])
         GROUP BY p.campaign_id
       ),
       enroll_agg AS (
         SELECT
           p.campaign_id,
           COUNT(*)::int AS enrolled
         FROM sequence_enrollments se
         JOIN prospects p ON p.id = se.prospect_id
         WHERE se.org_id     = $1
           AND se.enrolled_at >= $${startIdx}::timestamptz
           AND se.enrolled_at <= $${endIdx}::timestamptz
           AND se.enrolled_by = ANY($2::int[])
         GROUP BY p.campaign_id
       ),
       stalled_agg AS (
         SELECT
           p.campaign_id,
           COUNT(*)::int AS stalled
         FROM sequence_enrollments se
         JOIN prospects p ON p.id = se.prospect_id
         LEFT JOIN LATERAL (
           SELECT MAX(fired_at) AS last_fired FROM sequence_step_logs
            WHERE enrollment_id = se.id
         ) ssl_max ON true
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.status     = 'active'
           AND COALESCE(ssl_max.last_fired, se.enrolled_at) < $${endIdx}::timestamptz - INTERVAL '7 days'
         GROUP BY p.campaign_id
       )
       SELECT
         c.id AS campaign_id,
         c.name,
         c.owner_id,
         u.first_name, u.last_name, u.email,
         COALESCE(e.enrolled, 0)  AS enrolled,
         COALESCE(l.drafts, 0)    AS drafts,
         COALESCE(l.sent, 0)      AS sent,
         COALESCE(l.replied, 0)   AS replied,
         COALESCE(l.failed, 0)    AS failed,
         COALESCE(s.stalled, 0)   AS stalled,
         l.last_fired_at
       FROM prospecting_campaigns c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN log_agg    l ON l.campaign_id = c.id
       LEFT JOIN enroll_agg e ON e.campaign_id = c.id
       LEFT JOIN stalled_agg s ON s.campaign_id = c.id
       WHERE ${campaignWhere}
       ORDER BY l.last_fired_at DESC NULLS LAST, c.id ASC`,
      campaignParams
    );

    // ── Totals row ────────────────────────────────────────────────
    // Computed by summing the per-campaign rows. Doing it client-side
    // here keeps the totals consistent with the campaigns array even
    // when the campaign filter narrows the set.
    const campaignRows = perCampaignRes.rows;

    // Tag direct vs indirect on each owner using the scope's reports list.
    const reportByUserId = new Map(scope.reports.map(r => [r.userId, r]));
    const campaigns = campaignRows.map(r => {
      const ownerName = r.owner_id
        ? ([r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email)
        : null;
      const ownerMeta = reportByUserId.get(r.owner_id);
      return {
        campaignId: r.campaign_id,
        name:       r.name,
        owner: r.owner_id ? {
          userId:           r.owner_id,
          name:             ownerName,
          isDirect:         ownerMeta?.isDirect          ?? null,
          depthFromManager: ownerMeta?.depthFromManager  ?? null,
        } : null,
        enrolled:        r.enrolled,
        drafts:          r.drafts,
        sent:            r.sent,
        replied:         r.replied,
        failed:          r.failed,
        stalled:         r.stalled,
        lastActivityAt:  r.last_fired_at,
      };
    });

    const totals = campaigns.reduce((acc, c) => {
      acc.enrolled += c.enrolled;
      acc.drafts   += c.drafts;
      acc.sent     += c.sent;
      acc.replied  += c.replied;
      acc.failed   += c.failed;
      acc.stalled  += c.stalled;
      return acc;
    }, _emptyTotals());

    totals.activeCampaigns = campaigns.filter(c => c.enrolled > 0 || c.drafts > 0 || c.sent > 0 || c.replied > 0).length;
    totals.repliedRate = totals.sent > 0
      ? +((totals.replied / totals.sent) * 100).toFixed(1)
      : 0;

    // activeSequences and enrolledProspects need their own queries — keep
    // the response honest rather than guessing from campaign rows.
    const distinctSeqRes = await pool.query(
      `SELECT COUNT(DISTINCT se.sequence_id)::int AS n
         FROM sequence_enrollments se
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.org_id     = $1
          AND se.enrolled_by = ANY($2::int[])
          AND se.status     = 'active'
          ${campaignIdFilter && campaignIdFilter.length
              ? `AND p.campaign_id = ANY($3::int[])`
              : ''}`,
      campaignIdFilter && campaignIdFilter.length
        ? [req.orgId, scopeUserIds, campaignIdFilter]
        : [req.orgId, scopeUserIds]
    );
    totals.activeSequences = distinctSeqRes.rows[0]?.n || 0;
    totals.enrolledProspects = totals.enrolled;   // alias for the UI tile

    res.json({
      scope,
      period: {
        startDate:   window.startISO,
        endDate:     window.endISO,
        description: window.isoIntervalDescription,
      },
      totals,
      campaigns,
    });
  } catch (err) {
    console.error('team-overview error:', err);
    res.status(500).json({ error: { message: 'Failed to load team overview: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/sequences/team-by-rep
// ─────────────────────────────────────────────────────────────────────────────
//
// Per-rep breakdown for the "All Campaigns — by Rep" view.
//
// Returns:
//   {
//     scope, period,
//     reps: [ { userId, name, email, isDirect, depthFromManager,
//               campaignsActive, sequencesActive, enrolled,
//               drafts, sent, replied, failed, stalled,
//               lastActivityAt,
//               topCampaigns: [ { campaignId, name, enrolled, sent } ] (max 3) } ]
//   }
//
// Per the user's request, reps with zero activity in the window are
// HIDDEN — we don't render zero-state rows. The reps array is built
// from "users in scope who have at least one row in the window".
// If a manager genuinely wants to see "everyone on my team", that's
// the scope.reports list (always returned) — UI can render that
// alongside if it wants the structural view.
//
router.get('/sequences/team-by-rep', async (req, res) => {
  try {
    const explicitUserIds = parseIntListParam(req.query.userIds);
    const requestedCampaignIds = parseIntListParam(req.query.campaignIds);

    const window = parseTimeWindow(req.query);

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, explicitUserIds }
    );

    const scopeUserIds = scope.userIds;
    const campaignIdFilter = await resolveCampaignFilter(
      req.orgId, scopeUserIds, requestedCampaignIds
    );

    if (campaignIdFilter && campaignIdFilter.length === 0) {
      return res.json({
        scope,
        period: {
          startDate: window.startISO,
          endDate:   window.endISO,
          description: window.isoIntervalDescription,
        },
        reps: [],
      });
    }

    // Build the param list once and reference positions in the SQL.
    const params = [req.orgId, scopeUserIds, window.startISO, window.endISO];
    let campaignClauseLog = '';
    let campaignClauseEnroll = '';
    if (campaignIdFilter && campaignIdFilter.length) {
      params.push(campaignIdFilter);
      campaignClauseLog    = `AND p_log.campaign_id    = ANY($5::int[])`;
      campaignClauseEnroll = `AND p_enroll.campaign_id = ANY($5::int[])`;
    }

    // ── Per-rep aggregates ──────────────────────────────────────────
    //
    // Two CTEs:
    //   log_agg    — counts step-log statuses per enrolled_by within window
    //   enroll_agg — counts new enrollments per enrolled_by within window
    //
    // We aggregate by sequence_enrollments.enrolled_by (the rep who
    // started the outreach) rather than ssl.* directly — there's no
    // user_id on the step log row, so the enrollment is the only join
    // path to a user.
    //
    // active counters (campaigns/sequences) are over the WHOLE history
    // for this rep, not just the window — "Rohit has 12 active sequences"
    // is a state metric, not a window metric.

    const perRepRes = await pool.query(
      `WITH log_agg AS (
         SELECT
           se.enrolled_by AS user_id,
           COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                AS drafts,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int  AS sent,
           COUNT(*) FILTER (WHERE ssl.status = 'replied')::int              AS replied,
           COUNT(*) FILTER (WHERE ssl.status = 'failed')::int               AS failed,
           MAX(ssl.fired_at) AS last_fired_at
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN prospects p_log         ON p_log.id = se.prospect_id
         WHERE ssl.org_id    = $1
           AND se.enrolled_by = ANY($2::int[])
           AND ssl.fired_at >= $3::timestamptz
           AND ssl.fired_at <= $4::timestamptz
           ${campaignClauseLog}
         GROUP BY se.enrolled_by
       ),
       enroll_agg AS (
         SELECT
           se.enrolled_by AS user_id,
           COUNT(*)::int AS enrolled
         FROM sequence_enrollments se
         JOIN prospects p_enroll ON p_enroll.id = se.prospect_id
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.enrolled_at >= $3::timestamptz
           AND se.enrolled_at <= $4::timestamptz
           ${campaignClauseEnroll}
         GROUP BY se.enrolled_by
       ),
       stalled_agg AS (
         SELECT
           se.enrolled_by AS user_id,
           COUNT(*)::int AS stalled
         FROM sequence_enrollments se
         JOIN prospects p_stall ON p_stall.id = se.prospect_id
         LEFT JOIN LATERAL (
           SELECT MAX(fired_at) AS last_fired FROM sequence_step_logs
            WHERE enrollment_id = se.id
         ) sx ON true
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.status     = 'active'
           AND COALESCE(sx.last_fired, se.enrolled_at) < $4::timestamptz - INTERVAL '7 days'
           ${campaignIdFilter && campaignIdFilter.length ? `AND p_stall.campaign_id = ANY($5::int[])` : ''}
         GROUP BY se.enrolled_by
       ),
       active_state AS (
         -- Whole-history counters: how many sequences and campaigns is
         -- this rep currently active in. Independent of the time window.
         SELECT
           se.enrolled_by AS user_id,
           COUNT(DISTINCT se.sequence_id)::int  AS sequences_active,
           COUNT(DISTINCT p_act.campaign_id)::int AS campaigns_active
         FROM sequence_enrollments se
         JOIN prospects p_act ON p_act.id = se.prospect_id
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.status     = 'active'
           ${campaignIdFilter && campaignIdFilter.length ? `AND p_act.campaign_id = ANY($5::int[])` : ''}
         GROUP BY se.enrolled_by
       )
       SELECT
         u.id AS user_id,
         u.first_name, u.last_name, u.email,
         COALESCE(l.drafts, 0)            AS drafts,
         COALESCE(l.sent, 0)              AS sent,
         COALESCE(l.replied, 0)           AS replied,
         COALESCE(l.failed, 0)            AS failed,
         COALESCE(e.enrolled, 0)          AS enrolled,
         COALESCE(s.stalled, 0)           AS stalled,
         COALESCE(a.sequences_active, 0)  AS sequences_active,
         COALESCE(a.campaigns_active, 0)  AS campaigns_active,
         l.last_fired_at
       FROM users u
       LEFT JOIN log_agg     l ON l.user_id = u.id
       LEFT JOIN enroll_agg  e ON e.user_id = u.id
       LEFT JOIN stalled_agg s ON s.user_id = u.id
       LEFT JOIN active_state a ON a.user_id = u.id
       WHERE u.id = ANY($2::int[])
       -- LEFT JOIN on log_agg so reps with zero activity in the window
       -- still appear with zero counters. Matches the "campaigns with
       -- zero activity still appear" behavior in team-overview — a
       -- manager wants to see "Rohit did nothing this week" as signal,
       -- not have him disappear from the list. The userIds filter still
       -- removes reps from scope.userIds, which IS reflected here via
       -- the $2 ANY clause.
       ORDER BY l.last_fired_at DESC NULLS LAST, u.first_name ASC`,
      params
    );

    // ── Top 3 campaigns per rep (separate query, joined client-side) ─
    //
    // For each rep, find the campaigns where they have the most sent
    // activity in the window. Capped at 3 per rep.
    //
    // We compute this in a single query with a window function
    // (ROW_NUMBER OVER PARTITION BY rep ORDER BY sent DESC) and a
    // WHERE rn <= 3 filter, rather than N+1 queries.

    const repUserIds = perRepRes.rows.map(r => r.user_id);
    let topCampaigns = new Map();   // userId → [{ campaignId, name, enrolled, sent }]

    if (repUserIds.length > 0) {
      const tcParams = [req.orgId, repUserIds, window.startISO, window.endISO];
      let tcCampaignClause = '';
      if (campaignIdFilter && campaignIdFilter.length) {
        tcParams.push(campaignIdFilter);
        tcCampaignClause = `AND p.campaign_id = ANY($5::int[])`;
      }

      const tcRes = await pool.query(
        `WITH per_rep_camp AS (
           SELECT
             se.enrolled_by AS user_id,
             c.id   AS campaign_id,
             c.name AS campaign_name,
             COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int AS sent,
             COUNT(DISTINCT p.id)::int AS enrolled
           FROM sequence_enrollments se
           JOIN prospects p ON p.id = se.prospect_id
           JOIN prospecting_campaigns c ON c.id = p.campaign_id
           LEFT JOIN sequence_step_logs ssl
             ON ssl.enrollment_id = se.id
            AND ssl.fired_at >= $3::timestamptz
            AND ssl.fired_at <= $4::timestamptz
           WHERE se.org_id     = $1
             AND se.enrolled_by = ANY($2::int[])
             ${tcCampaignClause}
           GROUP BY se.enrolled_by, c.id, c.name
         ),
         ranked AS (
           SELECT *,
                  ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY sent DESC, enrolled DESC, campaign_id ASC) AS rn
           FROM per_rep_camp
         )
         SELECT user_id, campaign_id, campaign_name, sent, enrolled
         FROM ranked WHERE rn <= 3
         ORDER BY user_id, rn`,
        tcParams
      );

      for (const row of tcRes.rows) {
        if (!topCampaigns.has(row.user_id)) topCampaigns.set(row.user_id, []);
        topCampaigns.get(row.user_id).push({
          campaignId: row.campaign_id,
          name:       row.campaign_name,
          enrolled:   row.enrolled,
          sent:       row.sent,
        });
      }
    }

    // ── Hydrate with scope metadata (isDirect, depth) ───────────────
    const reportByUserId = new Map(scope.reports.map(r => [r.userId, r]));
    const reps = perRepRes.rows.map(r => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email;
      const meta = reportByUserId.get(r.user_id);
      // The viewer themselves is in scope.userIds but not in scope.reports
      // (reports = team members, excluding the manager). We tag them
      // explicitly as isDirect: false, depthFromManager: 0 so the UI can
      // render their row distinctly ("you").
      const isViewer = r.user_id === req.user.userId;
      return {
        userId:           r.user_id,
        name,
        email:            r.email,
        isDirect:         isViewer ? false : (meta?.isDirect ?? null),
        depthFromManager: isViewer ? 0     : (meta?.depthFromManager ?? null),
        isViewer,
        campaignsActive:  r.campaigns_active,
        sequencesActive:  r.sequences_active,
        enrolled:         r.enrolled,
        drafts:           r.drafts,
        sent:             r.sent,
        replied:          r.replied,
        failed:           r.failed,
        stalled:          r.stalled,
        lastActivityAt:   r.last_fired_at,
        topCampaigns:     topCampaigns.get(r.user_id) || [],
      };
    });

    res.json({
      scope,
      period: {
        startDate:   window.startISO,
        endDate:     window.endISO,
        description: window.isoIntervalDescription,
      },
      reps,
    });
  } catch (err) {
    console.error('team-by-rep error:', err);
    res.status(500).json({ error: { message: 'Failed to load team-by-rep: ' + err.message } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/sequences/team-by-sequence
// ─────────────────────────────────────────────────────────────────────────────
//
// Per-sequence rollup for the "All Campaigns — by Sequence" view. Peer to
// team-overview and team-by-rep.
//
// Why this exists separately from team-overview:
//   Sequences can run on prospects that have NO campaign at all (one-off
//   prospects enrolled directly into a sequence). Those activities never
//   appear in team-overview.campaigns[] because there's no campaign to
//   roll up to. This endpoint captures every activity that goes through
//   sequence_enrollments, regardless of whether the prospect has a campaign.
//
//   Counting in both lenses is INTENTIONAL, not double-counting. When a
//   sequence runs on a prospect in a campaign, that same activity appears
//   in both team-overview (one row per campaign) and team-by-sequence (one
//   row per sequence) — two views of the same data, not partitions.
//
// Returns:
//   {
//     scope, period,
//     totals: { activeSequences, activeCampaigns, enrolledProspects,
//               drafts, sent, replied, failed, stalled, repliedRate },
//     sequences: [
//       { sequenceId, name,
//         owner: { userId, name, isDirect, depthFromManager },   // sequences.created_by
//         enrolled, drafts, sent, replied, failed, stalled,
//         lastActivityAt,
//         topUsers: [ { userId, name, enrolled, sent } ]          // top 3 by sent
//       }
//     ]
//   }
//
// Filter semantics:
//   ?sequenceIds=  — optional; restricts the result to these sequences only
//                    (intersected with scope-visible sequences, silently filtered).
//   ?campaignIds=  — optional. When PRESENT, restricts to sequences running on
//                    prospects in those campaigns — the orphan bucket
//                    (prospects.campaign_id IS NULL) is EXCLUDED.
//                    When ABSENT (no filter), the orphan bucket IS INCLUDED:
//                    sequences that run on prospects with no campaign at all
//                    contribute their activity to the rollup.
//
// Notes on totals.activeCampaigns:
//   This counts distinct non-null campaign_ids touched by in-scope activity
//   in the window. The orphan bucket (campaign_id = NULL) is NOT counted as
//   a campaign — it's a "no campaign" pseudo-bucket. So when orphan-only
//   activity is present, activeCampaigns can be 0 while activeSequences > 0
//   (correct: there are sequences running but no campaigns containing them).
//
// Stalled definition:
//   Same as Phase 2: active enrollments whose latest log is older than
//   7 days before the window's end. Definition is independent of windowDays.
//
router.get('/sequences/team-by-sequence', async (req, res) => {
  try {
    const explicitUserIds      = parseIntListParam(req.query.userIds);
    const requestedSequenceIds = parseIntListParam(req.query.sequenceIds);
    const requestedCampaignIds = parseIntListParam(req.query.campaignIds);

    const window = parseTimeWindow(req.query);

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, explicitUserIds }
    );

    const scopeUserIds = scope.userIds;

    // Resolve campaign filter through the same auth helper team-overview uses.
    // null = "no filter" (include orphan bucket); empty array = "filtered to
    // nothing" (return empty response).
    const campaignIdFilter = await resolveCampaignFilter(
      req.orgId, scopeUserIds, requestedCampaignIds
    );

    if (campaignIdFilter && campaignIdFilter.length === 0) {
      // Caller asked for campaigns but none survived the scope intersection.
      // Return empty response — consistent with how the other two endpoints
      // handle this case.
      return res.json({
        scope,
        period: {
          startDate:   window.startISO,
          endDate:     window.endISO,
          description: window.isoIntervalDescription,
        },
        totals:    _emptyTotals(),
        sequences: [],
      });
    }

    // ── Build the campaign predicate for this endpoint ──────────────
    //
    // Two modes depending on whether the caller passed ?campaignIds=:
    //
    //   campaignIdFilter === null  → include orphan-bucket activity
    //                                (no predicate on campaign_id at all)
    //   campaignIdFilter !== null  → restrict to those campaigns only
    //                                (predicate: p.campaign_id = ANY(...))
    //
    // The "orphan inclusion" mode is what distinguishes team-by-sequence
    // from team-overview — see header comment for the rationale.

    // Build the param list once and reference positions in SQL.
    // Params: [orgId, scopeUserIds, windowStart, windowEnd, (campaignIdFilter?), (sequenceIdFilter?)]
    const params = [req.orgId, scopeUserIds, window.startISO, window.endISO];
    let nextParam = 5;

    let campaignClause = '';
    if (campaignIdFilter !== null) {
      params.push(campaignIdFilter);
      // Use the same alias name everywhere in the CTEs below — the prospects
      // table is aliased as p_log / p_enroll / p_stall / p_act in different
      // CTEs but each one applies the same campaign predicate. We template
      // the predicate per-CTE because the alias differs.
      campaignClause = `$${nextParam}::int[]`;
      nextParam++;
    }

    // Sequence ID filter is intersected with scope-visible sequences. Same
    // pattern as userIds — silently drop out-of-scope IDs. "In scope" =
    // "the sequence has at least one enrollment by someone in scopeUserIds".
    // We resolve this in one query before building the main rollup.
    let sequenceIdFilter = null;   // null = "no filter"
    if (requestedSequenceIds !== null) {
      if (requestedSequenceIds.length === 0) {
        return res.json({
          scope,
          period: {
            startDate:   window.startISO,
            endDate:     window.endISO,
            description: window.isoIntervalDescription,
          },
          totals:    _emptyTotals(),
          sequences: [],
        });
      }

      const seqScopeParams = [req.orgId, scopeUserIds, requestedSequenceIds];
      let seqScopeCampaignClause = '';
      if (campaignIdFilter !== null) {
        seqScopeParams.push(campaignIdFilter);
        seqScopeCampaignClause = `AND p.campaign_id = ANY($4::int[])`;
      }

      const seqScopeRes = await pool.query(
        `SELECT DISTINCT se.sequence_id
           FROM sequence_enrollments se
           JOIN prospects p ON p.id = se.prospect_id
          WHERE se.org_id      = $1
            AND se.enrolled_by = ANY($2::int[])
            AND se.sequence_id = ANY($3::int[])
            ${seqScopeCampaignClause}`,
        seqScopeParams
      );
      sequenceIdFilter = seqScopeRes.rows.map(r => r.sequence_id);

      if (sequenceIdFilter.length === 0) {
        // All requested sequence IDs were out-of-scope. Return empty.
        return res.json({
          scope,
          period: {
            startDate:   window.startISO,
            endDate:     window.endISO,
            description: window.isoIntervalDescription,
          },
          totals:    _emptyTotals(),
          sequences: [],
        });
      }

      params.push(sequenceIdFilter);
    }

    // Compute the sequence-id position param # (used in WHERE on the
    // outer SELECT and in each CTE that needs to filter).
    const seqIdParamIdx = sequenceIdFilter !== null ? nextParam : null;
    if (sequenceIdFilter !== null) nextParam++;

    // Per-CTE campaign predicates with the right alias. campaignClause was
    // built above; we just template the alias here. When campaignClause is
    // empty, no predicate is applied (orphan bucket included).
    const ccLog    = campaignClause ? `AND p_log.campaign_id    = ANY(${campaignClause})` : '';
    const ccEnroll = campaignClause ? `AND p_enroll.campaign_id = ANY(${campaignClause})` : '';
    const ccStall  = campaignClause ? `AND p_stall.campaign_id  = ANY(${campaignClause})` : '';
    const ccAct    = campaignClause ? `AND p_act.campaign_id    = ANY(${campaignClause})` : '';
    const ccConn   = campaignClause ? `AND p_conn.campaign_id   = ANY(${campaignClause})` : '';

    // Per-sequence filter predicates for each CTE (applies the
    // user-supplied sequenceIds intersected with scope).
    const sfLog    = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfEnroll = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfStall  = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfAct    = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfConn   = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfOuter  = sequenceIdFilter !== null ? `AND s.id = ANY($${seqIdParamIdx}::int[])` : '';

    // ── Per-sequence aggregates ─────────────────────────────────────
    //
    // Three CTEs aggregated by sequence_id:
    //   log_agg     — counts step-log statuses + last_fired_at within window
    //   enroll_agg  — counts new enrollments within window
    //   stalled_agg — active enrollments with no log activity in the trailing
    //                 7 days from window's end
    // Plus an active_state CTE that's NOT window-bound — it captures the
    // current "is this sequence live" state (status='active' AND has any
    // active enrollments). Used for the activeSequences total.
    //
    // The outer SELECT bases the row set on the sequences table so
    // sequences with status='active' and zero activity in the window
    // still appear with zero counters — same dormancy-as-signal convention
    // as Phase 2's campaign rows.

    const perSeqRes = await pool.query(
      `WITH log_agg AS (
         SELECT
           se.sequence_id,
           COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                              AS drafts,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int                AS sent,
           COUNT(*) FILTER (WHERE ssl.status = 'replied')::int                            AS replied,
           COUNT(*) FILTER (WHERE ssl.status = 'failed')::int                             AS failed,
           MAX(ssl.fired_at)                                                              AS last_fired_at
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN prospects p_log         ON p_log.id = se.prospect_id
         WHERE ssl.org_id     = $1
           AND ssl.fired_at  >= $3::timestamptz
           AND ssl.fired_at  <= $4::timestamptz
           AND se.enrolled_by = ANY($2::int[])
           ${ccLog}
           ${sfLog}
         GROUP BY se.sequence_id
       ),
       enroll_agg AS (
         SELECT
           se.sequence_id,
           COUNT(*)::int AS enrolled,
           -- Count of distinct campaigns this sequence touched in the window
           -- (excluding orphan/null campaign_id). Feeds the totals.activeCampaigns
           -- count via UNION downstream.
           COUNT(DISTINCT p_enroll.campaign_id) FILTER (WHERE p_enroll.campaign_id IS NOT NULL)::int AS distinct_campaigns
         FROM sequence_enrollments se
         JOIN prospects p_enroll ON p_enroll.id = se.prospect_id
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.enrolled_at >= $3::timestamptz
           AND se.enrolled_at <= $4::timestamptz
           ${ccEnroll}
           ${sfEnroll}
         GROUP BY se.sequence_id
       ),
       stalled_agg AS (
         SELECT
           se.sequence_id,
           COUNT(*)::int AS stalled
         FROM sequence_enrollments se
         JOIN prospects p_stall ON p_stall.id = se.prospect_id
         LEFT JOIN LATERAL (
           SELECT MAX(fired_at) AS last_fired FROM sequence_step_logs
            WHERE enrollment_id = se.id
         ) sx ON true
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.status     = 'active'
           AND COALESCE(sx.last_fired, se.enrolled_at) < $4::timestamptz - INTERVAL '7 days'
           ${ccStall}
           ${sfStall}
         GROUP BY se.sequence_id
       ),
       connected_agg AS (
         -- LinkedIn acceptances attributed per sequence. A prospect is
         -- "connected" iff an acceptance was EXPLICITLY logged, which sets
         -- channel_data.linkedin.connected_at. We deliberately key off
         -- connected_at (not connection_status) because the sequence step
         -- firer can advance the status pointer straight to 'message_sent'
         -- without an acceptance ever occurring — counting status >=
         -- connection_accepted would over-count those leapfroggers. Window-
         -- bounded by connected_at to stay consistent with sent/replied.
         SELECT
           se.sequence_id,
           COUNT(DISTINCT se.prospect_id)::int AS connected
         FROM sequence_enrollments se
         JOIN prospects p_conn ON p_conn.id = se.prospect_id
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND (p_conn.channel_data->'linkedin'->>'connected_at') IS NOT NULL
           AND (p_conn.channel_data->'linkedin'->>'connected_at')::timestamptz >= $3::timestamptz
           AND (p_conn.channel_data->'linkedin'->>'connected_at')::timestamptz <= $4::timestamptz
           ${ccConn}
           ${sfConn}
         GROUP BY se.sequence_id
       ),
       active_state AS (
         -- Whole-history state: which sequences currently have at least one
         -- active enrollment by someone in scope. Independent of the window.
         SELECT DISTINCT se.sequence_id
         FROM sequence_enrollments se
         JOIN prospects p_act ON p_act.id = se.prospect_id
         WHERE se.org_id     = $1
           AND se.enrolled_by = ANY($2::int[])
           AND se.status     = 'active'
           ${ccAct}
           ${sfAct}
       )
       SELECT
         s.id    AS sequence_id,
         s.name,
         s.created_by AS owner_id,
         s.status AS sequence_status,
         u.first_name, u.last_name, u.email,
         COALESCE(l.drafts, 0)              AS drafts,
         COALESCE(l.sent, 0)                AS sent,
         COALESCE(l.replied, 0)             AS replied,
         COALESCE(l.failed, 0)              AS failed,
         COALESCE(e.enrolled, 0)            AS enrolled,
         COALESCE(e.distinct_campaigns, 0)  AS distinct_campaigns,
         COALESCE(st.stalled, 0)            AS stalled,
         COALESCE(cn.connected, 0)          AS connected,
         l.last_fired_at,
         (a.sequence_id IS NOT NULL)        AS is_active
       FROM sequences s
       LEFT JOIN users        u  ON u.id = s.created_by
       LEFT JOIN log_agg      l  ON l.sequence_id = s.id
       LEFT JOIN enroll_agg   e  ON e.sequence_id = s.id
       LEFT JOIN stalled_agg  st ON st.sequence_id = s.id
       LEFT JOIN connected_agg cn ON cn.sequence_id = s.id
       LEFT JOIN active_state a  ON a.sequence_id = s.id
       WHERE s.org_id = $1
         AND (
           -- Include any sequence that has any activity in scope (any CTE
           -- contributed a row), OR is currently active state-wise. This
           -- mirrors Phase 2's "include zero-activity but in-scope campaigns"
           -- behavior. A sequence that's been archived and has no recent
           -- activity in scope is excluded.
           l.sequence_id  IS NOT NULL
           OR e.sequence_id  IS NOT NULL
           OR st.sequence_id IS NOT NULL
           OR cn.sequence_id IS NOT NULL
           OR a.sequence_id  IS NOT NULL
         )
         ${sfOuter}
       ORDER BY l.last_fired_at DESC NULLS LAST, s.id ASC`,
      params
    );

    // ── Top 3 users per sequence ────────────────────────────────────
    //
    // For each sequence, find the reps who have the most sent activity in
    // the window. Capped at 3. Computed with a window function in one
    // query, same pattern as team-by-rep's topCampaigns.

    const seqIds = perSeqRes.rows.map(r => r.sequence_id);
    const topUsers = new Map();   // sequenceId → [{ userId, name, enrolled, sent }]

    if (seqIds.length > 0) {
      const tuParams = [req.orgId, scopeUserIds, window.startISO, window.endISO, seqIds];
      let tuParamIdx = 6;

      let tuCampaignClause = '';
      if (campaignIdFilter !== null) {
        tuParams.push(campaignIdFilter);
        tuCampaignClause = `AND p.campaign_id = ANY($${tuParamIdx}::int[])`;
        tuParamIdx++;
      }

      const tuRes = await pool.query(
        `WITH per_seq_user AS (
           SELECT
             se.sequence_id,
             se.enrolled_by AS user_id,
             COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int AS sent,
             COUNT(DISTINCT p.id)::int AS enrolled
           FROM sequence_enrollments se
           JOIN prospects p ON p.id = se.prospect_id
           LEFT JOIN sequence_step_logs ssl
             ON ssl.enrollment_id = se.id
            AND ssl.fired_at >= $3::timestamptz
            AND ssl.fired_at <= $4::timestamptz
           WHERE se.org_id     = $1
             AND se.enrolled_by = ANY($2::int[])
             AND se.sequence_id = ANY($5::int[])
             ${tuCampaignClause}
           GROUP BY se.sequence_id, se.enrolled_by
         ),
         ranked AS (
           SELECT *,
                  ROW_NUMBER() OVER (PARTITION BY sequence_id ORDER BY sent DESC, enrolled DESC, user_id ASC) AS rn
           FROM per_seq_user
         )
         SELECT psu.sequence_id, psu.user_id, psu.sent, psu.enrolled,
                u.first_name, u.last_name, u.email
         FROM ranked psu
         LEFT JOIN users u ON u.id = psu.user_id
         WHERE psu.rn <= 3
         ORDER BY psu.sequence_id, psu.rn`,
        tuParams
      );

      for (const row of tuRes.rows) {
        if (!topUsers.has(row.sequence_id)) topUsers.set(row.sequence_id, []);
        const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email;
        topUsers.get(row.sequence_id).push({
          userId:   row.user_id,
          name,
          enrolled: row.enrolled,
          sent:     row.sent,
        });
      }
    }

    // ── Hydrate the rows with owner metadata (isDirect, depth) ──────
    const reportByUserId = new Map(scope.reports.map(r => [r.userId, r]));
    const sequences = perSeqRes.rows.map(r => {
      const ownerName = r.owner_id
        ? ([r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email)
        : null;
      const ownerMeta = reportByUserId.get(r.owner_id);
      const isViewer  = r.owner_id === req.user.userId;
      return {
        sequenceId: r.sequence_id,
        name:       r.name,
        owner: r.owner_id ? {
          userId:           r.owner_id,
          name:             ownerName,
          isDirect:         isViewer ? false : (ownerMeta?.isDirect ?? null),
          depthFromManager: isViewer ? 0     : (ownerMeta?.depthFromManager ?? null),
        } : null,
        enrolled:       r.enrolled,
        drafts:         r.drafts,
        sent:           r.sent,
        connected:      r.connected,
        replied:        r.replied,
        failed:         r.failed,
        stalled:        r.stalled,
        lastActivityAt: r.last_fired_at,
        topUsers:       topUsers.get(r.sequence_id) || [],
      };
    });

    // ── Totals ──────────────────────────────────────────────────────
    //
    // Sum across the per-sequence rows for the activity counters. For
    // activeCampaigns we compute the union of distinct campaign_ids touched
    // across all in-scope sequences in the window (separate query — summing
    // distinct_campaigns from each row would over-count if two sequences
    // touch the same campaign).
    const totals = sequences.reduce((acc, s) => {
      acc.enrolled += s.enrolled;
      acc.drafts   += s.drafts;
      acc.sent     += s.sent;
      acc.connected += s.connected;
      acc.replied  += s.replied;
      acc.failed   += s.failed;
      acc.stalled  += s.stalled;
      return acc;
    }, _emptyTotals());

    // activeSequences = number of sequences that have any activity or are
    // currently active state-wise. The perSeqRes already filtered to "has
    // any signal" via the OR in the outer WHERE, so this is just the row
    // count.
    totals.activeSequences = perSeqRes.rows.filter(r => r.is_active || r.drafts > 0 || r.sent > 0 || r.replied > 0 || r.enrolled > 0).length;

    // activeCampaigns: distinct non-null campaign_ids touched by in-scope
    // enrollments in the window. Excludes the orphan bucket by definition
    // (campaign_id IS NOT NULL). When the orphan-only mode is in effect
    // and there are no non-null campaigns, this returns 0.
    const acParams = [req.orgId, scopeUserIds, window.startISO, window.endISO];
    let acCampaignClause = '';
    let acSeqClause = '';
    let acParamIdx = 5;
    if (campaignIdFilter !== null) {
      acParams.push(campaignIdFilter);
      acCampaignClause = `AND p.campaign_id = ANY($${acParamIdx}::int[])`;
      acParamIdx++;
    }
    if (sequenceIdFilter !== null) {
      acParams.push(sequenceIdFilter);
      acSeqClause = `AND se.sequence_id = ANY($${acParamIdx}::int[])`;
    }
    const acRes = await pool.query(
      `SELECT COUNT(DISTINCT p.campaign_id)::int AS n
         FROM sequence_enrollments se
         JOIN prospects p ON p.id = se.prospect_id
        WHERE se.org_id     = $1
          AND se.enrolled_by = ANY($2::int[])
          AND p.campaign_id IS NOT NULL
          AND (
            -- Activity in the window OR enrollment in the window
            EXISTS (SELECT 1 FROM sequence_step_logs ssl
                     WHERE ssl.enrollment_id = se.id
                       AND ssl.fired_at >= $3::timestamptz
                       AND ssl.fired_at <= $4::timestamptz)
            OR (se.enrolled_at >= $3::timestamptz AND se.enrolled_at <= $4::timestamptz)
          )
          ${acCampaignClause}
          ${acSeqClause}`,
      acParams
    );
    totals.activeCampaigns = acRes.rows[0]?.n || 0;
    totals.enrolledProspects = totals.enrolled;   // alias for the UI tile

    totals.repliedRate = totals.sent > 0
      ? +((totals.replied / totals.sent) * 100).toFixed(1)
      : 0;

    res.json({
      scope,
      period: {
        startDate:   window.startISO,
        endDate:     window.endISO,
        description: window.isoIntervalDescription,
      },
      totals,
      sequences,
    });
  } catch (err) {
    console.error('team-by-sequence error:', err);
    res.status(500).json({ error: { message: 'Failed to load team-by-sequence: ' + err.message } });
  }
});

function _emptyTotals() {
  return {
    activeCampaigns:   0,
    activeSequences:   0,
    enrolledProspects: 0,
    enrolled:          0,
    drafts:            0,
    sent:              0,
    connected:         0,
    replied:           0,
    failed:            0,
    stalled:           0,
    repliedRate:       0,
  };
}

module.exports = router;
