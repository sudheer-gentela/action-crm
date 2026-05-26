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
//
// Both endpoints return aggregate metrics across multiple campaigns and
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

function _emptyTotals() {
  return {
    activeCampaigns:   0,
    activeSequences:   0,
    enrolledProspects: 0,
    enrolled:          0,
    drafts:            0,
    sent:              0,
    replied:           0,
    failed:            0,
    stalled:           0,
    repliedRate:       0,
  };
}

module.exports = router;
