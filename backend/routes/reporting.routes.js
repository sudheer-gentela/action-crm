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
// Single definition of "a reply" (email + LinkedIn, channel-tagged). Shared
// with prospecting-campaigns.routes.js /:id/sequence-health so the campaign
// row and its drill-down panel reconcile by construction, not by luck.
const { replyEventsCte } = require('../services/ReplyEventsQuery');
// Single definition of "a bounce". Shared with prospecting-campaigns.routes.js
// /:id/sequence-health so the campaign row and its drill-down cannot disagree.
const {
  bounceEventsCte, BOUNCE_COUNTERS, UNDELIVERABLE_EVENT_TYPES,
  delivered: _delivered, deliveredRate: _deliveredRate,
  deliveryTelemetry: _deliveryTelemetry,
} = require('../services/BounceEventsQuery');
const {
  engagementEventsCte, ENGAGEMENT_COUNTERS, engagementTelemetry,
} = require('../services/EngagementEventsQuery');

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
 * Agency Phase 4: resolve an optional clientId query param into the id list
 * of that client's campaigns (prospecting_campaigns.client_id, 2026_52).
 *
 * The client dimension deliberately rides the EXISTING campaignIds machinery
 * rather than adding p.client_id predicates inside every CTE: the returned
 * list is intersected with any explicit campaignIds filter and then flows
 * through resolveCampaignFilter / campaignParam untouched, so all three team
 * lenses stay consistent with each other by construction.
 *
 * Semantics (documented, not accidental): this is CAMPAIGN-grain client
 * attribution — activity counts for a client are activity in that client's
 * campaigns. A client prospect enrolled outside any campaign is not counted
 * here (it still appears in the client dashboard, which is prospect-grain).
 *
 * Returns:
 *   null  — no clientId param → no client filter
 *   int[] — possibly EMPTY (client exists but has no campaigns, or bad id;
 *           callers already short-circuit empty campaign filters to an
 *           empty response, which is exactly right)
 */
async function resolveClientCampaignIds(orgId, rawClientId) {
  if (rawClientId === undefined || rawClientId === null || rawClientId === '') return null;
  const cid = parseInt(rawClientId, 10);
  if (!Number.isInteger(cid)) return [];
  const r = await pool.query(
    `SELECT id FROM prospecting_campaigns WHERE org_id = $1 AND client_id = $2`,
    [orgId, cid]
  );
  return r.rows.map(x => x.id);
}

/**
 * Agency Phase 4: combine the explicit campaignIds filter with the
 * client-derived campaign list. null = "no filter" on either side.
 *   null ∩ null → null       (no filter at all)
 *   null ∩ list → list       (only one side filters)
 *   list ∩ list → set-intersection (possibly empty → empty response upstream)
 */
function mergeCampaignFilters(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const bs = new Set(b);
  return a.filter(id => bs.has(id));
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
// Reply attribution — the single definition of "replied" for all three tabs
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
//
// These endpoints used to count replies as:
//     COUNT(*) FILTER (WHERE ssl.status = 'replied')
//
// Nothing in the codebase ever writes that value. The only writer of the
// string 'replied' is SequenceStepFirer.js, and it writes to
// sequence_enrollments.status, not sequence_step_logs.status. So the REPLIED
// column read 0 on every tab, for every org, forever — while the campaign
// detail panel (prospecting-campaigns.routes.js, the `outreach` CTE) happily
// showed real reply counts because it reads the `emails` table.
//
// sequence_enrollments.status='replied' is NOT a usable substitute either:
// SequenceStepFirer only sets it when it next ticks an *active* enrollment,
// so enrollments that already reached 'completed' never get marked. On a live
// org this undercounts by an order of magnitude.
//
// So: replies come from `emails`, using the SAME predicate the campaign panel
// uses, and reconcile with it by construction.
//
// GRAIN AND ATTRIBUTION
//
// An inbound email has no enrollment_id, so it can't be attributed to a rep /
// sequence directly. We reach back to the most recent enrollment that PRECEDED
// the reply (`se.enrolled_at < e.sent_at`), and take that enrollment's
// enrolled_by / sequence_id, plus the prospect's campaign_id.
//
// `DISTINCT ON (e.id) ... ORDER BY e.id, se.enrolled_at DESC, se.id DESC`
// guarantees exactly ONE row per inbound email. Without it, a prospect enrolled
// twice (or by two reps) would have its single reply counted once per
// enrollment. This is the difference between a reply *count* and a reply
// *cross-join*, and it is the reason the CTE is not just a plain JOIN.
//
// The scope predicate (`se.enrolled_by = ANY(...)`) is applied BEFORE the
// DISTINCT ON, so a reply lands on the most recent *in-scope* enrollment even
// when a later out-of-scope enrollment exists. That is the correct behaviour
// for a manager viewing a narrowed team.
//
// TIMESTAMP DISCIPLINE
//
// emails.sent_at is `timestamp without time zone`, holding UTC wall time (DB
// convention). sequence_enrollments.enrolled_at is `timestamptz`. Mixing them
// bare makes Postgres cast the naive value using the *session* TimeZone, which
// is environment-dependent. Every comparison below is therefore explicit:
//   * naive vs. window bound → `$n::timestamptz AT TIME ZONE 'UTC'` (→ naive)
//   * naive vs. timestamptz  → `e.sent_at AT TIME ZONE 'UTC'`       (→ tz-aware)
//
// KNOWN LIMITS (deliberate — documented rather than hidden)
//
//   1. Email only. LinkedIn replies live in prospecting_activities as
//      activity_type='linkedin_event' / metadata->>'event'='reply_received'.
//      The campaign panel's email branch has the same blind spot, so the two
//      surfaces agree. Widening both is a separate change.
//   2. A reply to a prospect who was never enrolled in any sequence is not
//      counted here (no rep to attribute it to). The campaign panel does count
//      it, since it keys off campaign_id alone. Expect reporting <= campaign
//      panel for orgs doing manual outreach outside sequences.
//   3. `replied` is window-bounded by the reply's own timestamp, while `sent`
//      is window-bounded by fired_at. repliedRate is therefore a period rate
//      (replies received / sends made, same window), NOT a per-send cohort
//      rate. Same convention MetricSnapshotService uses (design decision D18).
//   4. We filter e.deleted_at IS NULL; the campaign panel currently does not.
//      A soft-deleted reply will make the two differ by one. The one-line fix
//      belongs in prospecting-campaigns.routes.js — flagged, not smuggled in.

// ─────────────────────────────────────────────────────────────────────────────
// The `reply_events` CTE now lives in services/ReplyEventsQuery.js so that
// /api/prospecting-campaigns/:id/sequence-health (the drill-down panel) can
// build its reply counts from the SAME definition. Before the extraction, the
// drill-down counted sequence_step_logs.status = 'replied' — a value nothing
// writes — so its REPLIED column and reply-rate tile read 0 while the campaign
// row one click away showed the real number. See that file's header.
//
// The builder defaults orgParam='$1' and userParam='$2', which is exactly the
// contract the three endpoints below already satisfy: every one of them binds
// orgId at $1 and scopeUserIds::int[] at $2.
// ─────────────────────────────────────────────────────────────────────────────

/** replied / sent as a 1-decimal percentage. 0 when there were no sends. */
function _repliedRate(replied, sent) {
  return sent > 0 ? +((replied / sent) * 100).toFixed(1) : 0;
}

/**
 * Attach the channel-split + delivery counters and their rates to a row.
 * Kept in one place so by-rep / by-campaign / by-sequence can never drift.
 *
 * `repliedRate` stays the blended figure for backward compatibility, but it is
 * a lie on any mixed-channel sequence (email replies over email+LinkedIn
 * sends). Read emailRepliedRate / linkedinRepliedRate instead.
 *
 * DELIVERY
 *
 *   sent       — attempted. A step log at 'sent'/'completed'. Unchanged.
 *   bounced    — hard_bounce + block. Undeliverable. A subset of sentEmail.
 *   bouncedSoft— soft_bounce. A retry, not a dead address. Never subtracted.
 *   delivered  — sentEmail − bounced. Cannot go negative (see BounceEventsQuery).
 *
 * `emailRepliedRate` now divides by DELIVERED, not by sent. A hard-bounced
 * address had no opportunity to reply; leaving it in the denominator quietly
 * punishes a campaign for a dead list rather than reporting one. The LinkedIn
 * rate still divides by sends — LinkedIn has no bounce concept.
 */
function _withChannelSplit(r) {
  const sentEmail        = r.sent_email        || 0;
  const sentLinkedin     = r.sent_linkedin     || 0;
  const repliedEmail     = r.replied_email     || 0;
  const repliedLinkedin  = r.replied_linkedin  || 0;
  const bouncedHard      = r.bounced_hard      || 0;
  const bouncedBlock     = r.bounced_block     || 0;
  const bouncedSoft      = r.bounced_soft      || 0;
  const bounced          = r.bounced           || 0;
  const deliveredEmail   = _delivered(sentEmail, bounced);
  // Message-grain human engagement (see EngagementEventsQuery). Rates divide
  // by DELIVERED for the same reason emailRepliedRate does — a hard-bounced
  // address had no opportunity to open. openedRate inherits the directional
  // caveat of its numerator.
  const opened           = r.opened            || 0;
  const clicked          = r.clicked           || 0;
  return {
    sentEmail,
    sentLinkedin,
    repliedEmail,
    repliedLinkedin,
    bouncedHard,
    bouncedBlock,
    bouncedSoft,
    bounced,
    deliveredEmail,
    opened,
    clicked,
    openedRate:          _repliedRate(opened, deliveredEmail),
    clickedRate:         _repliedRate(clicked, deliveredEmail),
    deliveredRate:       _deliveredRate(sentEmail, bounced),
    emailRepliedRate:    _repliedRate(repliedEmail, deliveredEmail),
    linkedinRepliedRate: _repliedRate(repliedLinkedin, sentLinkedin),
  };
}

/** Sum channel + delivery counters from `row` into `acc` (a totals object). */
function _accChannelSplit(acc, row) {
  acc.sentEmail       += row.sentEmail       || 0;
  acc.sentLinkedin    += row.sentLinkedin    || 0;
  acc.repliedEmail    += row.repliedEmail    || 0;
  acc.repliedLinkedin += row.repliedLinkedin || 0;
  acc.bouncedHard     += row.bouncedHard     || 0;
  acc.bouncedBlock    += row.bouncedBlock    || 0;
  acc.bouncedSoft     += row.bouncedSoft     || 0;
  acc.bounced         += row.bounced         || 0;
  acc.opened          += row.opened          || 0;
  acc.clicked         += row.clicked         || 0;
  return acc;
}

/**
 * Finalise delivery + per-channel rates on a totals object after reduction.
 * Rates are recomputed from the summed numerator and denominator — never
 * averaged across rows. Same discipline MetricFrameService applies (D1).
 */
function _finaliseChannelRates(t) {
  t.deliveredEmail      = _delivered(t.sentEmail, t.bounced);
  t.deliveredRate       = _deliveredRate(t.sentEmail, t.bounced);
  t.emailRepliedRate    = _repliedRate(t.repliedEmail, t.deliveredEmail);
  t.linkedinRepliedRate = _repliedRate(t.repliedLinkedin, t.sentLinkedin);
  t.openedRate          = _repliedRate(t.opened, t.deliveredEmail);
  t.clickedRate         = _repliedRate(t.clicked, t.deliveredEmail);
  return t;
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
    // Agency Phase 4: optional ?clientId= narrows to that client's campaigns.
    // Rides the existing campaignIds machinery (see resolveClientCampaignIds).
    const clientCampaignIds = await resolveClientCampaignIds(req.orgId, req.query.clientId);

    const window = parseTimeWindow(req.query);

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, explicitUserIds }
    );

    const scopeUserIds = scope.userIds;
    const campaignIdFilter = await resolveCampaignFilter(
      req.orgId, scopeUserIds, mergeCampaignFilters(requestedCampaignIds, clientCampaignIds)
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
          deliveryTelemetry: await _deliveryTelemetry(pool, req.orgId),
      // Same honesty gate for opens/clicks: with tracking never armed, a 0
      // reads exactly like nobody-cares. The UI renders em-dashes until
      // human engagement events exist for this org.
      engagementTelemetry: await engagementTelemetry(pool, req.orgId),
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
         -- NOTE: no 'replied' column here. sequence_step_logs.status never reaches
         -- 'replied' (see replyEventsCte header). Replies come from reply_agg.
         SELECT
           p.campaign_id,
           COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                              AS drafts,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int                AS sent,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'email')::int                       AS sent_email,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'linkedin')::int                    AS sent_linkedin,
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
       ${replyEventsCte({
         startParam: `$${startIdx}`,
         endParam:   `$${endIdx}`,
       })},
       reply_agg AS (
         -- Campaign-grain replies. Orphan replies (prospect with no campaign)
         -- have nowhere to roll up to in this lens and are dropped — the
         -- by-sequence tab is where they surface.
         SELECT campaign_id,
                COUNT(*)::int                                        AS replied,
                COUNT(*) FILTER (WHERE channel = 'email')::int       AS replied_email,
                COUNT(*) FILTER (WHERE channel = 'linkedin')::int    AS replied_linkedin
           FROM reply_events
          WHERE campaign_id IS NOT NULL
          GROUP BY campaign_id
       ),
       ${bounceEventsCte({
         startParam: `$${startIdx}`,
         endParam:   `$${endIdx}`,
       })},
       bounce_agg AS (
         -- Campaign-grain delivery failures, one row per bounced SEND.
         -- Bounded on the send's fired_at, so this is a strict subset of
         -- log_agg.sent_email and delivered can never go negative.
         SELECT campaign_id, ${BOUNCE_COUNTERS}
           FROM bounce_events
          WHERE campaign_id IS NOT NULL
          GROUP BY campaign_id
       ),
       ${engagementEventsCte({
         startParam: `$${startIdx}`,
         endParam:   `$${endIdx}`,
       })},
       engagement_agg AS (
         -- Campaign-grain human opens/clicks, one row per engaged SEND.
         -- Same fired_at cohort bounds as log_agg, so opened <= sent_email.
         SELECT campaign_id, ${ENGAGEMENT_COUNTERS}
           FROM engagement_events
          WHERE campaign_id IS NOT NULL
          GROUP BY campaign_id
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
         c.client_id,
         cl.name AS client_name,
         u.first_name, u.last_name, u.email,
         COALESCE(e.enrolled, 0)  AS enrolled,
         COALESCE(l.drafts, 0)    AS drafts,
         COALESCE(l.sent, 0)      AS sent,
         COALESCE(l.sent_email, 0)        AS sent_email,
         COALESCE(l.sent_linkedin, 0)     AS sent_linkedin,
         COALESCE(rp.replied, 0)  AS replied,
         COALESCE(rp.replied_email, 0)    AS replied_email,
         COALESCE(rp.replied_linkedin, 0) AS replied_linkedin,
         COALESCE(b.bounced_hard, 0)      AS bounced_hard,
         COALESCE(b.bounced_block, 0)     AS bounced_block,
         COALESCE(b.bounced_soft, 0)      AS bounced_soft,
         COALESCE(b.bounced, 0)           AS bounced,
         COALESCE(g.opened, 0)            AS opened,
         COALESCE(g.clicked, 0)           AS clicked,
         COALESCE(l.failed, 0)    AS failed,
         COALESCE(s.stalled, 0)   AS stalled,
         l.last_fired_at
       FROM prospecting_campaigns c
       LEFT JOIN users u ON u.id = c.owner_id
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN log_agg    l ON l.campaign_id = c.id
       LEFT JOIN enroll_agg e ON e.campaign_id = c.id
       LEFT JOIN stalled_agg s ON s.campaign_id = c.id
       LEFT JOIN reply_agg  rp ON rp.campaign_id = c.id
       LEFT JOIN bounce_agg b  ON b.campaign_id = c.id
       LEFT JOIN engagement_agg g ON g.campaign_id = c.id
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
        // Agency Phase 4: which client this campaign runs for (2026_52).
        clientId:   r.client_id ?? null,
        clientName: r.client_name ?? null,
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
        // The UI's per-row "Reply rate" column reads this. It was never sent,
        // so the column rendered '—' for every campaign.
        repliedRate:     _repliedRate(r.replied, r.sent),
        ..._withChannelSplit(r),
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
      return _accChannelSplit(acc, c);
    }, _emptyTotals());
    _finaliseChannelRates(totals);

    totals.activeCampaigns = campaigns.filter(c => c.enrolled > 0 || c.drafts > 0 || c.sent > 0 || c.replied > 0).length;
    totals.repliedRate = _repliedRate(totals.replied, totals.sent);

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
      // Whether `bounced` / `deliveredEmail` / `deliveredRate` mean anything at
      // all. With no delivery telemetry every campaign scores a perfect 100%,
      // which is indistinguishable from a healthy list. The UI renders "—".
      deliveryTelemetry: await _deliveryTelemetry(pool, req.orgId),
      // Same honesty gate for opens/clicks: with tracking never armed, a 0
      // reads exactly like nobody-cares. The UI renders em-dashes until
      // human engagement events exist for this org.
      engagementTelemetry: await engagementTelemetry(pool, req.orgId),
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
//     totals: { enrolled, enrolledProspects, drafts, sent, replied, failed,
//               stalled, repliedRate },
//     reps: [ { userId, name, email, isDirect, depthFromManager,
//               campaignsActive, sequencesActive, enrolled,
//               drafts, sent, replied, failed, stalled, repliedRate,
//               lastActivityAt,
//               topCampaigns: [ { campaignId, name, enrolled, sent } ] (max 3) } ]
//   }
//
// `replied` is sourced from inbound `emails` via reply_events — NOT from
// sequence_step_logs.status, which never reaches 'replied'. See the
// replyEventsCte header above for the full rationale and known limits.
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
    // Agency Phase 4: optional ?clientId= narrows to that client's campaigns.
    // Rides the existing campaignIds machinery (see resolveClientCampaignIds).
    const clientCampaignIds = await resolveClientCampaignIds(req.orgId, req.query.clientId);

    const window = parseTimeWindow(req.query);

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, explicitUserIds }
    );

    const scopeUserIds = scope.userIds;
    const campaignIdFilter = await resolveCampaignFilter(
      req.orgId, scopeUserIds, mergeCampaignFilters(requestedCampaignIds, clientCampaignIds)
    );

    if (campaignIdFilter && campaignIdFilter.length === 0) {
      return res.json({
        scope,
        period: {
          startDate: window.startISO,
          endDate:   window.endISO,
          description: window.isoIntervalDescription,
        },
        totals: _emptyTotals(),
        reps: [],
      });
    }

    // Build the param list once and reference positions in the SQL.
    const params = [req.orgId, scopeUserIds, window.startISO, window.endISO];
    let campaignClauseLog = '';
    let campaignClauseEnroll = '';
    let campaignReplyParam = null;
    if (campaignIdFilter && campaignIdFilter.length) {
      params.push(campaignIdFilter);
      campaignClauseLog    = `AND p_log.campaign_id    = ANY($5::int[])`;
      campaignClauseEnroll = `AND p_enroll.campaign_id = ANY($5::int[])`;
      campaignReplyParam   = '$5';
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
         -- NOTE: no 'replied' column here. sequence_step_logs.status never reaches
         -- 'replied' (see replyEventsCte header). Replies come from reply_agg.
         SELECT
           se.enrolled_by AS user_id,
           COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                AS drafts,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int  AS sent,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'email')::int           AS sent_email,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'linkedin')::int        AS sent_linkedin,
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
       ${replyEventsCte({
         startParam: '$3',
         endParam:   '$4',
         campaignParam: campaignReplyParam,
       })},
       reply_agg AS (
         -- Rep-grain replies, attributed via the enrollment that preceded the
         -- reply. Exactly one row per inbound event (DISTINCT ON upstream).
         SELECT user_id,
                COUNT(*)::int                                      AS replied,
                COUNT(*) FILTER (WHERE channel = 'email')::int     AS replied_email,
                COUNT(*) FILTER (WHERE channel = 'linkedin')::int  AS replied_linkedin
           FROM reply_events
          GROUP BY user_id
       ),
       ${bounceEventsCte({
         startParam: '$3',
         endParam:   '$4',
         campaignParam: campaignReplyParam,
       })},
       bounce_agg AS (
         SELECT user_id, ${BOUNCE_COUNTERS}
           FROM bounce_events
          GROUP BY user_id
       ),
       ${engagementEventsCte({
         startParam: '$3',
         endParam:   '$4',
         campaignParam: campaignReplyParam,
       })},
       engagement_agg AS (
         SELECT user_id, ${ENGAGEMENT_COUNTERS}
           FROM engagement_events
          GROUP BY user_id
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
         COALESCE(l.sent_email, 0)        AS sent_email,
         COALESCE(l.sent_linkedin, 0)     AS sent_linkedin,
         COALESCE(rp.replied, 0)          AS replied,
         COALESCE(rp.replied_email, 0)    AS replied_email,
         COALESCE(rp.replied_linkedin, 0) AS replied_linkedin,
         COALESCE(b.bounced_hard, 0)      AS bounced_hard,
         COALESCE(b.bounced_block, 0)     AS bounced_block,
         COALESCE(b.bounced_soft, 0)      AS bounced_soft,
         COALESCE(b.bounced, 0)           AS bounced,
         COALESCE(g.opened, 0)            AS opened,
         COALESCE(g.clicked, 0)           AS clicked,
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
       LEFT JOIN reply_agg   rp ON rp.user_id = u.id
       LEFT JOIN bounce_agg  b  ON b.user_id  = u.id
       LEFT JOIN engagement_agg g ON g.user_id = u.id
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
        // The UI's per-row "Reply rate" column reads this. It was never sent,
        // so the column rendered '—' even for reps with thousands of sends.
        repliedRate:      _repliedRate(r.replied, r.sent),
        ..._withChannelSplit(r),
        lastActivityAt:   r.last_fired_at,
        topCampaigns:     topCampaigns.get(r.user_id) || [],
      };
    });

    // ── Totals row ──────────────────────────────────────────────────
    //
    // This endpoint never returned `totals`. TeamReportingView.js does
    // `const totals = data.totals || {}`, so the Enrolled / Sent / Reply-rate
    // summary cards silently rendered 0 / 0 / '—' while the table underneath
    // showed the real numbers. Peer endpoints (team-overview, team-by-sequence)
    // both build one; by-rep was the odd one out.
    //
    // Summed from the rep rows, so the cards can never disagree with the table.
    const totals = reps.reduce((acc, r) => {
      acc.enrolled += r.enrolled;
      acc.drafts   += r.drafts;
      acc.sent     += r.sent;
      acc.replied  += r.replied;
      acc.failed   += r.failed;
      acc.stalled  += r.stalled;
      return _accChannelSplit(acc, r);
    }, _emptyTotals());

    totals.enrolledProspects = totals.enrolled;   // alias for the UI tile
    totals.repliedRate       = _repliedRate(totals.replied, totals.sent);
    _finaliseChannelRates(totals);

    // activeCampaigns / activeSequences are intentionally left at 0. Per-rep
    // `campaignsActive` / `sequencesActive` are whole-history state counters —
    // summing them across reps would double-count any campaign two reps share.
    // The by-rep UI doesn't render those tiles; it derives "Active reps"
    // client-side from the reps array. Don't fake a number nobody asked for.

    res.json({
      scope,
      period: {
        startDate:   window.startISO,
        endDate:     window.endISO,
        description: window.isoIntervalDescription,
      },
      totals,
      // Whether `bounced` / `deliveredEmail` / `deliveredRate` mean anything at
      // all. With no delivery telemetry every campaign scores a perfect 100%,
      // which is indistinguishable from a healthy list. The UI renders "—".
      deliveryTelemetry: await _deliveryTelemetry(pool, req.orgId),
      // Same honesty gate for opens/clicks: with tracking never armed, a 0
      // reads exactly like nobody-cares. The UI renders em-dashes until
      // human engagement events exist for this org.
      engagementTelemetry: await engagementTelemetry(pool, req.orgId),
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
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/sequences/team-by-client — Agency Phase 4
//
// Per-CLIENT rollup of the same campaign-grain aggregates team-overview uses:
// activity is attributed to a client through its campaigns (2026_52), so this
// tab and the campaign tab reconcile by construction. Campaigns with no client
// roll into a single { clientId: null } "No client" bucket so the totals
// across rows always equal the campaign tab's totals for the same filters.
//
// Scope model is identical to team-overview: campaign row set = campaigns
// with prospects owned by (or enrollments created by) in-scope users; reply
// and bounce definitions come from the shared CTE builders so no lens can
// drift from another.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/sequences/team-by-client', async (req, res) => {
  try {
    const explicitUserIds = parseIntListParam(req.query.userIds);
    const window = parseTimeWindow(req.query);

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, explicitUserIds }
    );
    const scopeUserIds = scope.userIds;

    const params = [req.orgId, scopeUserIds, window.startISO, window.endISO];

    const perClientRes = await pool.query(
      `WITH scoped_campaigns AS (
         -- Same inclusion predicate as team-overview's campaign row set.
         SELECT c.id, c.client_id
           FROM prospecting_campaigns c
          WHERE c.org_id = $1 AND (
            EXISTS (SELECT 1 FROM prospects p
                     WHERE p.campaign_id = c.id
                       AND p.owner_id    = ANY($2::int[])
                       AND p.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM sequence_enrollments se
                            JOIN prospects p ON p.id = se.prospect_id
                       WHERE p.campaign_id = c.id
                         AND se.enrolled_by = ANY($2::int[]))
          )
       ),
       log_agg AS (
         SELECT
           p.campaign_id,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int  AS sent,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'email')::int           AS sent_email,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'linkedin')::int        AS sent_linkedin,
           COUNT(*) FILTER (WHERE ssl.status = 'failed')::int               AS failed,
           MAX(ssl.fired_at) AS last_fired_at
         FROM sequence_step_logs ssl
         JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
         JOIN prospects p             ON p.id = se.prospect_id
         WHERE ssl.org_id    = $1
           AND ssl.fired_at >= $3::timestamptz
           AND ssl.fired_at <= $4::timestamptz
           AND se.enrolled_by = ANY($2::int[])
         GROUP BY p.campaign_id
       ),
       enroll_agg AS (
         SELECT p.campaign_id, COUNT(*)::int AS enrolled
           FROM sequence_enrollments se
           JOIN prospects p ON p.id = se.prospect_id
          WHERE se.org_id      = $1
            AND se.enrolled_at >= $3::timestamptz
            AND se.enrolled_at <= $4::timestamptz
            AND se.enrolled_by = ANY($2::int[])
          GROUP BY p.campaign_id
       ),
       ${replyEventsCte({ startParam: '$3', endParam: '$4' })},
       reply_agg AS (
         SELECT campaign_id,
                COUNT(*)::int                                      AS replied,
                COUNT(*) FILTER (WHERE channel = 'email')::int     AS replied_email,
                COUNT(*) FILTER (WHERE channel = 'linkedin')::int  AS replied_linkedin
           FROM reply_events
          WHERE campaign_id IS NOT NULL
          GROUP BY campaign_id
       ),
       ${bounceEventsCte({ startParam: '$3', endParam: '$4' })},
       bounce_agg AS (
         SELECT campaign_id, ${BOUNCE_COUNTERS}
           FROM bounce_events
          WHERE campaign_id IS NOT NULL
          GROUP BY campaign_id
       )
       SELECT
         sc.client_id,
         cl.name AS client_name,
         COUNT(DISTINCT sc.id)::int                    AS campaigns,
         COALESCE(SUM(e.enrolled), 0)::int             AS enrolled,
         COALESCE(SUM(l.sent), 0)::int                 AS sent,
         COALESCE(SUM(l.sent_email), 0)::int           AS sent_email,
         COALESCE(SUM(l.sent_linkedin), 0)::int        AS sent_linkedin,
         COALESCE(SUM(l.failed), 0)::int               AS failed,
         COALESCE(SUM(rp.replied), 0)::int             AS replied,
         COALESCE(SUM(rp.replied_email), 0)::int       AS replied_email,
         COALESCE(SUM(rp.replied_linkedin), 0)::int    AS replied_linkedin,
         COALESCE(SUM(b.bounced), 0)::int              AS bounced,
         COALESCE(SUM(b.bounced_hard), 0)::int         AS bounced_hard,
         COALESCE(SUM(b.bounced_block), 0)::int        AS bounced_block,
         COALESCE(SUM(b.bounced_soft), 0)::int         AS bounced_soft,
         MAX(l.last_fired_at)                          AS last_activity_at
       FROM scoped_campaigns sc
       LEFT JOIN clients cl    ON cl.id = sc.client_id
       LEFT JOIN log_agg    l  ON l.campaign_id  = sc.id
       LEFT JOIN enroll_agg e  ON e.campaign_id  = sc.id
       LEFT JOIN reply_agg  rp ON rp.campaign_id = sc.id
       LEFT JOIN bounce_agg b  ON b.campaign_id  = sc.id
       GROUP BY sc.client_id, cl.name
       ORDER BY (sc.client_id IS NULL) ASC, sent DESC, cl.name ASC`,
      params
    );

    const clients = perClientRes.rows.map(r => ({
      clientId:       r.client_id,
      clientName:     r.client_id ? r.client_name : null,   // null → UI renders "No client"
      campaigns:      r.campaigns,
      enrolled:       r.enrolled,
      sent:           r.sent,
      sentEmail:      r.sent_email,
      sentLinkedin:   r.sent_linkedin,
      failed:         r.failed,
      replied:        r.replied,
      repliedEmail:   r.replied_email,
      repliedLinkedin:r.replied_linkedin,
      bounced:        r.bounced,
      bouncedHard:    r.bounced_hard,
      bouncedBlock:   r.bounced_block,
      bouncedSoft:    r.bounced_soft,
      repliedRate:    _repliedRate(r.replied, r.sent),
      lastActivityAt: r.last_activity_at,
    }));

    res.json({
      scope,
      period: {
        startDate: window.startISO,
        endDate:   window.endISO,
        description: window.isoIntervalDescription,
      },
      clients,
    });
  } catch (err) {
    console.error('GET /reporting/sequences/team-by-client', err);
    res.status(500).json({ error: { message: 'Failed to load per-client reporting' } });
  }
});

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

    // Agency Phase 4: optional ?clientId= narrows to that client's campaigns
    // before the scope intersection — same construction as the other tabs.
    const clientCampaignIds = await resolveClientCampaignIds(req.orgId, req.query.clientId);

    // Resolve campaign filter through the same auth helper team-overview uses.
    // null = "no filter" (include orphan bucket); empty array = "filtered to
    // nothing" (return empty response).
    const campaignIdFilter = await resolveCampaignFilter(
      req.orgId, scopeUserIds, mergeCampaignFilters(requestedCampaignIds, clientCampaignIds)
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
    // reply_events builds its own alias-correct predicates; it needs the bare
    // param placeholder, not the pre-templated clause strings above.
    // campaignClause is `$N::int[]` — strip the cast, replyEventsCte re-adds it.
    const campaignReplyParam = campaignClause ? campaignClause.replace('::int[]', '') : null;

    // Per-sequence filter predicates for each CTE (applies the
    // user-supplied sequenceIds intersected with scope).
    const sfLog    = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfEnroll = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfStall  = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfAct    = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sfConn   = sequenceIdFilter !== null ? `AND se.sequence_id = ANY($${seqIdParamIdx}::int[])` : '';
    const sequenceReplyParam = sequenceIdFilter !== null ? `$${seqIdParamIdx}` : null;
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
         -- NOTE: no 'replied' column here. sequence_step_logs.status never reaches
         -- 'replied' (see replyEventsCte header). Replies come from reply_agg.
         SELECT
           se.sequence_id,
           COUNT(*) FILTER (WHERE ssl.status = 'draft')::int                              AS drafts,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed'))::int                AS sent,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'email')::int                       AS sent_email,
           COUNT(*) FILTER (WHERE ssl.status IN ('sent','completed')
                                  AND ssl.channel = 'linkedin')::int                    AS sent_linkedin,
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
       ${replyEventsCte({
         startParam: '$3',
         endParam:   '$4',
         campaignParam: campaignReplyParam,
         sequenceParam: sequenceReplyParam,
       })},
       reply_agg AS (
         -- Sequence-grain replies. Unlike the campaign lens, orphan prospects
         -- (campaign_id IS NULL) are retained — surfacing them is precisely
         -- why this endpoint exists (see header).
         SELECT sequence_id,
                COUNT(*)::int                                       AS replied,
                COUNT(*) FILTER (WHERE channel = 'email')::int      AS replied_email,
                COUNT(*) FILTER (WHERE channel = 'linkedin')::int   AS replied_linkedin
           FROM reply_events
          GROUP BY sequence_id
       ),
       ${bounceEventsCte({
         startParam: '$3',
         endParam:   '$4',
         campaignParam: campaignReplyParam,
         sequenceParam: sequenceReplyParam,
       })},
       bounce_agg AS (
         SELECT sequence_id, ${BOUNCE_COUNTERS}
           FROM bounce_events
          GROUP BY sequence_id
       ),
       ${engagementEventsCte({
         startParam: '$3',
         endParam:   '$4',
         campaignParam: campaignReplyParam,
         sequenceParam: sequenceReplyParam,
       })},
       engagement_agg AS (
         SELECT sequence_id, ${ENGAGEMENT_COUNTERS}
           FROM engagement_events
          GROUP BY sequence_id
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
         COALESCE(l.sent_email, 0)          AS sent_email,
         COALESCE(l.sent_linkedin, 0)       AS sent_linkedin,
         COALESCE(rp.replied, 0)            AS replied,
         COALESCE(rp.replied_email, 0)      AS replied_email,
         COALESCE(rp.replied_linkedin, 0)   AS replied_linkedin,
         COALESCE(b.bounced_hard, 0)        AS bounced_hard,
         COALESCE(b.bounced_block, 0)       AS bounced_block,
         COALESCE(b.bounced_soft, 0)        AS bounced_soft,
         COALESCE(b.bounced, 0)             AS bounced,
         COALESCE(g.opened, 0)              AS opened,
         COALESCE(g.clicked, 0)             AS clicked,
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
       LEFT JOIN reply_agg    rp ON rp.sequence_id = s.id
       LEFT JOIN bounce_agg   b  ON b.sequence_id  = s.id
       LEFT JOIN engagement_agg g ON g.sequence_id = s.id
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
           -- A sequence whose only in-window signal is an inbound reply
           -- (sends fired before the window) must still appear.
           OR rp.sequence_id IS NOT NULL
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
        repliedRate:    _repliedRate(r.replied, r.sent),
        ..._withChannelSplit(r),
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
      return _accChannelSplit(acc, s);
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

    totals.repliedRate = _repliedRate(totals.replied, totals.sent);
    _finaliseChannelRates(totals);

    res.json({
      scope,
      period: {
        startDate:   window.startISO,
        endDate:     window.endISO,
        description: window.isoIntervalDescription,
      },
      totals,
      // Whether `bounced` / `deliveredEmail` / `deliveredRate` mean anything at
      // all. With no delivery telemetry every campaign scores a perfect 100%,
      // which is indistinguishable from a healthy list. The UI renders "—".
      deliveryTelemetry: await _deliveryTelemetry(pool, req.orgId),
      // Same honesty gate for opens/clicks: with tracking never armed, a 0
      // reads exactly like nobody-cares. The UI renders em-dashes until
      // human engagement events exist for this org.
      engagementTelemetry: await engagementTelemetry(pool, req.orgId),
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
    sentEmail:            0,
    sentLinkedin:         0,
    repliedEmail:         0,
    repliedLinkedin:      0,
    bouncedHard:          0,
    bouncedBlock:         0,
    bouncedSoft:          0,
    bounced:              0,
    deliveredEmail:       0,
    opened:               0,
    clicked:              0,
    openedRate:           0,
    clickedRate:          0,
    deliveredRate:        0,
    emailRepliedRate:     0,
    linkedinRepliedRate:  0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity reporting (Team Reporting → Activity tab)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/activity
//   Query: depth, windowDays | startDate+endDate, userId (optional drill-down)
//
//   Returns ATOMS ONLY — no rates are computed server-side. The client rolls
//   atoms up using the viewer's active definition (see /activity-definition).
//
//   Action-state model (seven mutually exclusive states, both modules):
//     auto_cleared   auto_completed = true (engine closed it)
//     rep_completed  completed_at set / status 'completed', not auto
//     snoozed | in_progress | skipped | failed   (per status)
//     pending        everything else (prospecting 'pending', deals 'not_started',
//                    and — see note — canonical 'blocked' / 'cancelled')
//   Cohort semantics: created_at within the window; state as of query time.
//
//   Sources: prospecting_actions.source passed through verbatim; deals split
//   playbook (source_rule IS NOT NULL) vs manual. Deals `actions` has no
//   org_id column — scoping is user_id ∈ resolved scope, which is org-safe
//   because ReportingScopeService only ever returns this org's users.
//
//   Calls: counted by occurred_at, outcomes passed through verbatim.
//   Deliveries: notification_deliveries by channel × status; per-rep failed
//   counts are notifications TO the rep that didn't land (plumbing health).
// ─────────────────────────────────────────────────────────────────────────────

const ActivityConfig = require('../services/activityReportConfig');

// Shared CASE expression — keep in lockstep with ActivityConfig.VALID_STATES.
const ACTION_STATE_CASE = `
  CASE
    WHEN a.auto_completed = TRUE                                THEN 'auto_cleared'
    WHEN a.completed_at IS NOT NULL OR a.status = 'completed'   THEN 'rep_completed'
    WHEN a.status = 'snoozed'                                   THEN 'snoozed'
    WHEN a.status = 'in_progress'                               THEN 'in_progress'
    WHEN a.status = 'skipped'                                   THEN 'skipped'
    WHEN a.status = 'failed'                                    THEN 'failed'
    ELSE 'pending'
  END`;

router.get('/activity', async (req, res) => {
  try {
    const { startISO, endISO, isoIntervalDescription } = parseTimeWindow(req.query);

    // Optional drill-down target. Passed through resolveReportingScope as
    // explicitUserIds so out-of-scope IDs are silently dropped — the scope
    // service is the auth gate, exactly like the sequence endpoints.
    const drillUserId = req.query.userId !== undefined
      ? parseInt(req.query.userId, 10) : null;
    const explicitUserIds = Number.isInteger(drillUserId) ? [drillUserId] : null;

    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId,
      req.orgId,
      { depth: req.query.depth, ...(explicitUserIds ? { explicitUserIds } : {}) }
    );
    const userIds = scope.userIds;

    // Drill-down requested but target not in scope → the only survivor is
    // the viewer themself (scope service always re-adds the viewer).
    const drillDenied = Number.isInteger(drillUserId)
      && !userIds.includes(drillUserId);
    if (drillDenied) {
      return res.status(403).json({ error: { message: 'User not in your reporting scope' } });
    }

    const windowParams = [req.orgId, userIds, startISO, endISO];

    // ── Calls ────────────────────────────────────────────────────────────
    const callsRes = await pool.query(
      `SELECT c.user_id,
              COALESCE(c.outcome, 'unknown')      AS outcome,
              COUNT(*)::int                        AS n,
              COALESCE(SUM(c.duration_seconds),0)::int AS duration_seconds
         FROM calls c
        WHERE c.org_id = $1
          AND c.user_id = ANY($2::int[])
          AND c.occurred_at >= $3::timestamptz
          AND c.occurred_at <= $4::timestamptz
        GROUP BY c.user_id, COALESCE(c.outcome, 'unknown')`,
      windowParams
    );

    // ── Action atoms — prospecting ───────────────────────────────────────
    const prospectingAtomsRes = await pool.query(
      `SELECT a.user_id,
              'prospecting'                        AS module,
              COALESCE(a.source, 'manual')         AS source,
              ${ACTION_STATE_CASE}                 AS state,
              COUNT(*)::int                        AS n
         FROM prospecting_actions a
        WHERE a.org_id = $1
          AND a.user_id = ANY($2::int[])
          AND a.created_at >= $3::timestamptz
          AND a.created_at <= $4::timestamptz
        GROUP BY 1, 2, 3, 4`,
      windowParams
    );

    // ── Action atoms — deals (no org_id column; user scope is org-safe) ──
    const dealsAtomsRes = await pool.query(
      `SELECT a.user_id,
              'deals'                              AS module,
              CASE WHEN a.source_rule IS NOT NULL THEN 'playbook' ELSE 'manual' END AS source,
              ${ACTION_STATE_CASE}                 AS state,
              COUNT(*)::int                        AS n
         FROM actions a
        WHERE a.user_id = ANY($1::int[])
          AND a.created_at >= $2::timestamptz
          AND a.created_at <= $3::timestamptz
        GROUP BY 1, 2, 3, 4`,
      [userIds, startISO, endISO]
    );

    // ── Notification deliveries ──────────────────────────────────────────
    const deliveriesRes = await pool.query(
      `SELECT d.user_id, d.channel, d.status, COUNT(*)::int AS n
         FROM notification_deliveries d
        WHERE d.org_id = $1
          AND d.user_id = ANY($2::int[])
          AND d.created_at >= $3::timestamptz
          AND d.created_at <= $4::timestamptz
        GROUP BY d.user_id, d.channel, d.status`,
      windowParams
    );

    // ── Rep directory for the UI (names for every id that can appear) ───
    const usersRes = await pool.query(
      `SELECT id AS user_id, first_name || ' ' || last_name AS name
         FROM users WHERE id = ANY($1::int[])`,
      [userIds]
    );

    const payload = {
      window: { start: startISO, end: endISO, description: isoIntervalDescription },
      scope: {
        scope: scope.scope,
        depth: scope.depth,
        sizeNote: scope.sizeNote,
        userIds,
      },
      reps: usersRes.rows,
      calls: callsRes.rows,
      actionAtoms: [...prospectingAtomsRes.rows, ...dealsAtomsRes.rows],
      deliveries: deliveriesRes.rows,
      states: ActivityConfig.VALID_STATES,
    };

    // ── Drill-down extras ────────────────────────────────────────────────
    if (Number.isInteger(drillUserId)) {
      const drillParams = [req.orgId, drillUserId, startISO, endISO];

      const recentCalls = await pool.query(
        `SELECT c.id, c.outcome, c.duration_seconds, c.direction,
                c.occurred_at,
                p.first_name || ' ' || p.last_name AS prospect_name,
                p.company_name
           FROM calls c
           LEFT JOIN prospects p ON p.id = c.prospect_id
          WHERE c.org_id = $1 AND c.user_id = $2
            AND c.occurred_at >= $3::timestamptz
            AND c.occurred_at <= $4::timestamptz
          ORDER BY c.occurred_at DESC
          LIMIT 20`,
        drillParams
      );

      // Open actions (both modules), oldest first — the "what's sitting" list.
      const openActions = await pool.query(
        `SELECT * FROM (
            SELECT a.id, 'prospecting' AS module, a.title, a.status,
                   a.created_at, a.due_date,
                   p.first_name || ' ' || p.last_name AS about
              FROM prospecting_actions a
              LEFT JOIN prospects p ON p.id = a.prospect_id
             WHERE a.org_id = $1 AND a.user_id = $2
               AND a.auto_completed = FALSE
               AND a.completed_at IS NULL
               AND a.status IN ('pending','in_progress','snoozed')
            UNION ALL
            SELECT a.id, 'deals' AS module, a.title, a.status,
                   a.created_at, a.due_date,
                   d.name AS about
              FROM actions a
              LEFT JOIN deals d ON d.id = a.deal_id
             WHERE a.user_id = $2
               AND COALESCE(a.auto_completed, FALSE) = FALSE
               AND a.completed_at IS NULL
               AND a.status IN ('not_started','in_progress','blocked','snoozed')
          ) open_actions
          ORDER BY created_at ASC
          LIMIT 20`,
        [req.orgId, drillUserId]
      );

      const failures = await pool.query(
        `SELECT d.channel, d.reason, d.created_at
           FROM notification_deliveries d
          WHERE d.org_id = $1 AND d.user_id = $2 AND d.status = 'failed'
            AND d.created_at >= $3::timestamptz
            AND d.created_at <= $4::timestamptz
          ORDER BY d.created_at DESC
          LIMIT 10`,
        drillParams
      );

      payload.drilldown = {
        userId: drillUserId,
        recentCalls: recentCalls.rows,
        openActions: openActions.rows,
        deliveryFailures: failures.rows,
      };
    }

    res.json(payload);
  } catch (err) {
    console.error('GET /reporting/activity failed:', err);
    res.status(500).json({ error: { message: 'Failed to load activity report' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/activity-definition
//   → { system_default, org_default: {definition, source}, user: {active, definitions} }
// PUT /api/reporting/activity-definition
//   body.scope = 'org'  → { definition }              (org admin/owner only)
//   body.scope = 'user' → { action: 'save',       name, definition, makeActive? }
//                         { action: 'delete',     name }
//                         { action: 'set_active', name|null }
// ─────────────────────────────────────────────────────────────────────────────

router.get('/activity-definition', async (req, res) => {
  try {
    const [orgDefault, userState] = await Promise.all([
      ActivityConfig.getOrgDefault(req.orgId),
      ActivityConfig.getUserState(req.user.userId, req.orgId),
    ]);
    res.json({
      system_default: ActivityConfig.SYSTEM_DEFAULT,
      valid_states:   ActivityConfig.VALID_STATES,
      org_default:    orgDefault,
      user:           userState,
      max_user_definitions: ActivityConfig.MAX_USER_DEFINITIONS,
    });
  } catch (err) {
    console.error('GET /reporting/activity-definition failed:', err);
    res.status(500).json({ error: { message: 'Failed to load definitions' } });
  }
});

router.put('/activity-definition', async (req, res) => {
  try {
    const { scope: defScope } = req.body || {};

    if (defScope === 'org') {
      // Mirrors ReportingScopeService admin semantics: admin OR owner.
      // (requireRole('admin') alone would wrongly exclude owners.)
      const adminRes = await pool.query(
        `SELECT 1 FROM org_users
          WHERE user_id = $1 AND org_id = $2
            AND is_active = TRUE AND role IN ('admin', 'owner')`,
        [req.user.userId, req.orgId]
      );
      if (adminRes.rows.length === 0) {
        return res.status(403).json({ error: { message: 'Only an org admin can set the org default' } });
      }
      const result = await ActivityConfig.setOrgDefault(
        req.orgId, req.body.definition, req.user.userId
      );
      return res.json({ org_default: result });
    }

    if (defScope === 'user') {
      const { action } = req.body;
      let state;
      if (action === 'save') {
        state = await ActivityConfig.saveUserDefinition(
          req.user.userId, req.orgId, req.body.name, req.body.definition,
          { makeActive: req.body.makeActive !== false }
        );
      } else if (action === 'delete') {
        state = await ActivityConfig.deleteUserDefinition(
          req.user.userId, req.orgId, req.body.name
        );
      } else if (action === 'set_active') {
        state = await ActivityConfig.setActiveDefinition(
          req.user.userId, req.orgId,
          req.body.name === null ? null : String(req.body.name)
        );
      } else {
        return res.status(400).json({ error: { message: "action must be 'save', 'delete', or 'set_active'" } });
      }
      return res.json({ user: state });
    }

    return res.status(400).json({ error: { message: "scope must be 'org' or 'user'" } });
  } catch (err) {
    const clientErr = /must be|unknown state|repeats|required|characters or fewer|up to|No saved definition/.test(err.message);
    if (clientErr) {
      return res.status(400).json({ error: { message: err.message } });
    }
    console.error('PUT /reporting/activity-definition failed:', err);
    res.status(500).json({ error: { message: 'Failed to save definition' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reporting/metric-drill
// ─────────────────────────────────────────────────────────────────────────────
//
// "What are the five replies behind that 5?"
//
// Returns the individual rows that constitute one aggregate cell on any of the
// reporting tables. Every numeric cell in the UI can launch this with the
// filter tuple it was rendered from.
//
//   ?metric=replied|sent|drafts|failed|enrolled|stalled
//          |delivered|opened|clicked                        (required)
//   ?channel=email|linkedin      narrows sent/drafts/failed/replied
//   ?campaignId=N  ?sequenceId=N  ?userId=N               grain selectors
//   ?depth= ?windowDays= | ?startDate= &endDate=          same as the tabs
//   ?limit=100 (max 500)  ?offset=0
//
// Returns { metric, channel, period, total, rows: [...], unattributedReplies }
//
// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT
//
// A drill list that re-derives its own WHERE clause is exactly how the campaign
// row came to show 5 replies while its own drill-down showed 0. So each branch
// below reuses the predicates of the aggregate that produced the number,
// verbatim:
//
//   replied            → replyEventsCte, the same builder the tabs use
//   sent/drafts/failed → sequence_step_logs, same status + fired_at bounds
//                        as log_agg
//   enrolled           → sequence_enrollments, same enrolled_at bounds as
//                        enroll_agg
//   stalled            → sequence_enrollments + the LATERAL MAX(fired_at) and
//                        the endDate − 7 days anchor of stalled_agg
//
// `total` is computed by COUNT(*) OVER () on the very same row set the page
// slices, so it can never drift from the list. The frontend compares it to the
// cell value that launched the drill and warns on mismatch in dev. If a cell
// ever stops reconciling with its own evidence, you find out that afternoon.
//
// GRAIN NOTES (these mirror the aggregates, deliberately)
//
//   * `replied` with no campaignId does NOT filter campaign_id, matching the
//     rep- and sequence-grain reply_agg. The campaign-grain reply_agg drops
//     campaign_id IS NULL, and passing ?campaignId=N reproduces that.
//   * `sent` with no campaignId does not join a campaign predicate either.
//   * `stalled` ignores the window START — stalled_agg is anchored only on the
//     window's end. Passing 24h vs 30d changes nothing but the anchor date.
//
// `unattributedReplies` is a footnote, not a row source: replies from prospects
// with no preceding enrollment cannot be attributed to a rep or a sequence, so
// reply_events drops them and so does every count on this page. The campaign
// detail panel's own funnel keys off campaign_id alone and DOES count them.
// Surfacing the number stops that difference from looking like a bug.
// ─────────────────────────────────────────────────────────────────────────────

const DRILL_METRICS = ['replied', 'sent', 'bounced', 'drafts', 'failed', 'enrolled', 'stalled', 'delivered', 'opened', 'clicked'];
const DRILL_STATUS = {
  sent:   `ssl.status IN ('sent','completed')`,
  drafts: `ssl.status = 'draft'`,
  failed: `ssl.status = 'failed'`,
};

/**
 * Markup → plain text → ~200 chars. Email bodies are raw HTML more often than
 * not; LinkedIn notes are plain. Cheap and lossy on purpose — the full thread
 * lives one click further in, on the enrollment timeline.
 */
function _snippet(raw, max = 200) {
  if (!raw) return null;
  const text = String(raw)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Shape a prospect-identity row the same way for every metric. */
function _drillRow(r, extra = {}) {
  return {
    prospectId:   r.prospect_id,
    enrollmentId: r.enrollment_id ?? null,
    name:         [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.prospect_email || '(no name)',
    email:        r.prospect_email || null,
    title:        r.title || null,
    company:      r.company_name || null,
    linkedinUrl:  r.linkedin_url || null,
    campaignId:   r.campaign_id ?? null,
    campaignName: r.campaign_name || null,
    sequenceId:   r.sequence_id ?? null,
    sequenceName: r.sequence_name || null,
    repId:        r.rep_id ?? null,
    repName:      [r.rep_first_name, r.rep_last_name].filter(Boolean).join(' ').trim() || r.rep_email || null,
    occurredAt:   r.occurred_at ?? null,
    ...extra,
  };
}

router.get('/metric-drill', async (req, res) => {
  try {
    const metric = String(req.query.metric || '');
    if (!DRILL_METRICS.includes(metric)) {
      return res.status(400).json({
        error: { message: `metric must be one of: ${DRILL_METRICS.join(', ')}` },
      });
    }

    const channel = ['email', 'linkedin'].includes(req.query.channel) ? req.query.channel : null;
    if (channel && (metric === 'enrolled' || metric === 'stalled')) {
      return res.status(400).json({
        error: { message: `channel is not meaningful for metric='${metric}'` },
      });
    }
    // LinkedIn has no delivery-failure concept. Accept ?channel=email as a
    // no-op (the cell that launches the drill sends it) and reject linkedin
    // rather than silently returning an empty list.
    if (['bounced', 'delivered', 'opened', 'clicked'].includes(metric) && channel === 'linkedin') {
      return res.status(400).json({
        error: { message: `${metric} applies to email only` },
      });
    }

    const window = parseTimeWindow(req.query);

    const limit  = Math.max(1, Math.min(500, parseInt(req.query.limit, 10)  || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // ── Auth. Same gatekeeper as every other endpoint in this file. ──
    const scope = await ReportingScopeService.resolveReportingScope(
      req.user.userId, req.orgId, { depth: req.query.depth }
    );

    // ?userId= narrows to one rep — intersected with the scope, never trusted.
    // An out-of-scope id yields an empty result rather than an error, so we
    // never confirm whether that user exists.
    let scopeUserIds = scope.userIds;
    if (req.query.userId !== undefined) {
      const wanted = parseInt(req.query.userId, 10);
      scopeUserIds = scope.userIds.filter(id => id === wanted);
      if (scopeUserIds.length === 0) {
        return res.json({
          metric, channel, period: {
            startDate: window.startISO, endDate: window.endISO,
            description: window.isoIntervalDescription,
          },
          total: 0, rows: [], unattributedReplies: 0,
        });
      }
    }

    // ?campaignId= / ?sequenceId= — single ids, carried as int[] because that
    // is what replyEventsCte and the ANY() predicates below want.
    const rawCampaignId = req.query.campaignId !== undefined ? parseInt(req.query.campaignId, 10) : null;
    const rawSequenceId = req.query.sequenceId !== undefined ? parseInt(req.query.sequenceId, 10) : null;
    const campaignIds = Number.isInteger(rawCampaignId) ? [rawCampaignId] : null;
    const sequenceIds = Number.isInteger(rawSequenceId) ? [rawSequenceId] : null;

    if (campaignIds) {
      const allowed = await resolveCampaignFilter(req.orgId, scope.userIds, campaignIds);
      if (!allowed || allowed.length === 0) {
        return res.json({
          metric, channel, period: {
            startDate: window.startISO, endDate: window.endISO,
            description: window.isoIntervalDescription,
          },
          total: 0, rows: [], unattributedReplies: 0,
        });
      }
    }

    // Params are pushed in the order each branch needs them; positions are read
    // back off the array length so a branch can skip one without breaking the
    // next. Postgres rejects a bind that supplies an unreferenced parameter.
    const params = [req.orgId, scopeUserIds];
    const P = (v) => { params.push(v); return `$${params.length}`; };

    let sql;
    let unattributedReplies = 0;

    if (metric === 'replied') {
      const startParam    = P(window.startISO);
      const endParam      = P(window.endISO);
      const campaignParam = campaignIds ? P(campaignIds) : null;
      const sequenceParam = sequenceIds ? P(sequenceIds) : null;
      const channelClause = channel ? `WHERE re.channel = ${P(channel)}` : '';

      sql = `
        WITH ${replyEventsCte({
          startParam, endParam, campaignParam, sequenceParam, detail: true,
        })},
        filtered AS (SELECT * FROM reply_events re ${channelClause})
        SELECT
          COUNT(*) OVER ()::int AS total_count,
          f.prospect_id, f.enrollment_id, f.channel, f.subject, f.body_raw,
          -- replied_at is timestamp WITHOUT time zone, holding UTC wall time
          -- (both branches of reply_events emit it naive). node-postgres reads
          -- a naive timestamp in the SERVER's local zone, so returning it raw
          -- shifts every drill row's timestamp by the container's UTC offset.
          -- Every other metric here sources fired_at / enrolled_at, which are
          -- already timestamptz. Lift this one explicitly.
          (f.replied_at AT TIME ZONE 'UTC') AS occurred_at,
          f.sequence_id, f.campaign_id,
          f.user_id AS rep_id,
          p.first_name, p.last_name, p.email AS prospect_email,
          p.title, p.company_name, p.linkedin_url,
          s.name AS sequence_name,
          c.name AS campaign_name,
          u.first_name AS rep_first_name, u.last_name AS rep_last_name, u.email AS rep_email
        FROM filtered f
        JOIN prospects p ON p.id = f.prospect_id
        LEFT JOIN sequences s              ON s.id = f.sequence_id
        LEFT JOIN prospecting_campaigns c  ON c.id = f.campaign_id
        LEFT JOIN users u                  ON u.id = f.user_id
        ORDER BY f.replied_at DESC, f.prospect_id DESC
        LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    } else if (metric === 'bounced') {
      // Same CTE the aggregates use, in detail mode. One row per bounced SEND,
      // classified by its worst verdict.
      //
      // The list must contain exactly what the clicked cell counted, or the
      // `expected` check in the panel fires and the two disagree — the whole
      // failure this endpoint exists to prevent. The cell counts hard bounces,
      // so the drill filters to UNDELIVERABLE_EVENT_TYPES, the single source of
      // truth for which verdicts are subtracted from `delivered`.
      const startParam    = P(window.startISO);
      const endParam      = P(window.endISO);
      const campaignParam = campaignIds ? P(campaignIds) : null;
      const sequenceParam = sequenceIds ? P(sequenceIds) : null;
      const eventTypeParam = P(UNDELIVERABLE_EVENT_TYPES);

      sql = `
        WITH ${bounceEventsCte({
          startParam, endParam, campaignParam, sequenceParam, detail: true,
        })},
        filtered AS (
          SELECT * FROM bounce_events be
           WHERE be.event_type = ANY(${eventTypeParam}::text[])
        )
        SELECT
          COUNT(*) OVER ()::int AS total_count,
          f.prospect_id, f.enrollment_id, f.step_log_id,
          f.event_type, f.failed_recipient, f.smtp_code, f.diagnostic_excerpt,
          f.enrollment_stopped,
          f.detected_at AS occurred_at,
          f.sent_at,
          f.sequence_id, f.campaign_id,
          f.user_id AS rep_id,
          p.first_name, p.last_name, p.email AS prospect_email,
          p.title, p.company_name, p.linkedin_url,
          s.name AS sequence_name,
          c.name AS campaign_name,
          u.first_name AS rep_first_name, u.last_name AS rep_last_name, u.email AS rep_email
        FROM filtered f
        JOIN prospects p ON p.id = f.prospect_id
        LEFT JOIN sequences s              ON s.id = f.sequence_id
        LEFT JOIN prospecting_campaigns c  ON c.id = f.campaign_id
        LEFT JOIN users u                  ON u.id = f.user_id
        ORDER BY f.detected_at DESC, f.step_log_id DESC
        LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    } else if (metric === 'sent' || metric === 'drafts' || metric === 'failed') {
      const startParam = P(window.startISO);
      const endParam   = P(window.endISO);
      const chanClause = channel     ? `AND ssl.channel = ${P(channel)}`                    : '';
      const campClause = campaignIds ? `AND p.campaign_id = ANY(${P(campaignIds)}::int[])`  : '';
      const seqClause  = sequenceIds ? `AND se.sequence_id = ANY(${P(sequenceIds)}::int[])` : '';

      sql = `
        SELECT
          COUNT(*) OVER ()::int AS total_count,
          se.prospect_id, ssl.enrollment_id, ssl.channel, ssl.status,
          ssl.step_intent, ssl.error_message,
          ssl.subject, LEFT(ssl.body, 4000) AS body_raw,
          ssl.fired_at AS occurred_at,
          se.sequence_id, p.campaign_id,
          se.enrolled_by AS rep_id,
          p.first_name, p.last_name, p.email AS prospect_email,
          p.title, p.company_name, p.linkedin_url,
          s.name AS sequence_name,
          c.name AS campaign_name,
          u.first_name AS rep_first_name, u.last_name AS rep_last_name, u.email AS rep_email
        FROM sequence_step_logs ssl
        JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
        JOIN prospects p             ON p.id = se.prospect_id
        LEFT JOIN sequences s              ON s.id = se.sequence_id
        LEFT JOIN prospecting_campaigns c  ON c.id = p.campaign_id
        LEFT JOIN users u                  ON u.id = se.enrolled_by
        WHERE ssl.org_id    = $1
          AND se.enrolled_by = ANY($2::int[])
          AND ssl.fired_at  >= ${startParam}::timestamptz
          AND ssl.fired_at  <= ${endParam}::timestamptz
          AND ${DRILL_STATUS[metric]}
          ${chanClause}
          ${campClause}
          ${seqClause}
        ORDER BY ssl.fired_at DESC, ssl.id DESC
        LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    } else if (metric === 'delivered' || metric === 'opened' || metric === 'clicked') {
      // One row per email SEND, reusing the exact predicates of the 'sent'
      // branch (which are the exact predicates of log_agg) narrowed by:
      //   delivered — no hard_bounce delivery event on the send
      //   opened    — >=1 human open  (ordered by last open)
      //   clicked   — >=1 human click (ordered by last click, URLs returned)
      // The engagement sub-join mirrors engagementEventsCte's semantics
      // (human-only, cohort-bounded via the send's fired_at) so these lists
      // always reconcile with the engagement_agg cells that launch them.
      const startParam = P(window.startISO);
      const endParam   = P(window.endISO);
      const campClause = campaignIds ? `AND p.campaign_id = ANY(${P(campaignIds)}::int[])`  : '';
      const seqClause  = sequenceIds ? `AND se.sequence_id = ANY(${P(sequenceIds)}::int[])` : '';

      const metricClause =
        metric === 'delivered'
          ? `AND NOT EXISTS (
               SELECT 1 FROM email_delivery_events ede
                WHERE ede.step_log_id = ssl.id
                  AND ede.org_id      = ssl.org_id
                  AND ede.event_type  = 'hard_bounce'
             )`
          : metric === 'opened'
            ? `AND COALESCE(g.opens, 0)  > 0`
            : `AND COALESCE(g.clicks, 0) > 0`;

      const orderClause =
        metric === 'opened'  ? 'g.last_open_at DESC NULLS LAST, ssl.id DESC'
        : metric === 'clicked' ? 'g.last_click_at DESC NULLS LAST, ssl.id DESC'
        : 'ssl.fired_at DESC, ssl.id DESC';

      sql = `
        SELECT
          COUNT(*) OVER ()::int AS total_count,
          se.prospect_id, ssl.enrollment_id, ssl.channel, ssl.status,
          ssl.subject, LEFT(ssl.body, 4000) AS body_raw,
          ssl.fired_at AS occurred_at,
          g.opens, g.last_open_at, g.clicks, g.last_click_at, g.clicked_urls,
          se.sequence_id, p.campaign_id,
          se.enrolled_by AS rep_id,
          p.first_name, p.last_name, p.email AS prospect_email,
          p.title, p.company_name, p.linkedin_url,
          s.name AS sequence_name,
          c.name AS campaign_name,
          u.first_name AS rep_first_name, u.last_name AS rep_last_name, u.email AS rep_email
        FROM sequence_step_logs ssl
        JOIN sequence_enrollments se ON se.id = ssl.enrollment_id
        JOIN prospects p             ON p.id = se.prospect_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE eee.event_type = 'open')::int   AS opens,
                 MAX(eee.occurred_at) FILTER (WHERE eee.event_type = 'open')  AS last_open_at,
                 COUNT(*) FILTER (WHERE eee.event_type = 'click')::int  AS clicks,
                 MAX(eee.occurred_at) FILTER (WHERE eee.event_type = 'click') AS last_click_at,
                 ARRAY_REMOVE(ARRAY_AGG(DISTINCT eee.url)
                              FILTER (WHERE eee.event_type = 'click'), NULL)  AS clicked_urls
            FROM email_engagement_events eee
           WHERE eee.step_log_id = ssl.id
             AND eee.org_id      = ssl.org_id
             AND eee.is_bot      = false
        ) g ON true
        LEFT JOIN sequences s              ON s.id = se.sequence_id
        LEFT JOIN prospecting_campaigns c  ON c.id = p.campaign_id
        LEFT JOIN users u                  ON u.id = se.enrolled_by
        WHERE ssl.org_id    = $1
          AND se.enrolled_by = ANY($2::int[])
          AND ssl.fired_at  >= ${startParam}::timestamptz
          AND ssl.fired_at  <= ${endParam}::timestamptz
          AND ssl.channel   = 'email'
          AND ${DRILL_STATUS.sent}
          ${metricClause}
          ${campClause}
          ${seqClause}
        ORDER BY ${orderClause}
        LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    } else if (metric === 'enrolled') {
      const startParam = P(window.startISO);
      const endParam   = P(window.endISO);
      const campClause = campaignIds ? `AND p.campaign_id = ANY(${P(campaignIds)}::int[])`  : '';
      const seqClause  = sequenceIds ? `AND se.sequence_id = ANY(${P(sequenceIds)}::int[])` : '';

      sql = `
        SELECT
          COUNT(*) OVER ()::int AS total_count,
          se.prospect_id, se.id AS enrollment_id, se.status,
          se.enrolled_at AS occurred_at,
          se.sequence_id, p.campaign_id,
          se.enrolled_by AS rep_id,
          p.first_name, p.last_name, p.email AS prospect_email,
          p.title, p.company_name, p.linkedin_url,
          s.name AS sequence_name,
          c.name AS campaign_name,
          u.first_name AS rep_first_name, u.last_name AS rep_last_name, u.email AS rep_email
        FROM sequence_enrollments se
        JOIN prospects p ON p.id = se.prospect_id
        LEFT JOIN sequences s              ON s.id = se.sequence_id
        LEFT JOIN prospecting_campaigns c  ON c.id = p.campaign_id
        LEFT JOIN users u                  ON u.id = se.enrolled_by
        WHERE se.org_id     = $1
          AND se.enrolled_by = ANY($2::int[])
          AND se.enrolled_at >= ${startParam}::timestamptz
          AND se.enrolled_at <= ${endParam}::timestamptz
          ${campClause}
          ${seqClause}
        ORDER BY se.enrolled_at DESC, se.id DESC
        LIMIT ${P(limit)} OFFSET ${P(offset)}`;

    } else {   // stalled
      // No window START: stalled_agg anchors only on the window's end.
      const endParam   = P(window.endISO);
      const campClause = campaignIds ? `AND p.campaign_id = ANY(${P(campaignIds)}::int[])`  : '';
      const seqClause  = sequenceIds ? `AND se.sequence_id = ANY(${P(sequenceIds)}::int[])` : '';

      sql = `
        SELECT
          COUNT(*) OVER ()::int AS total_count,
          se.prospect_id, se.id AS enrollment_id, se.status,
          COALESCE(sx.last_fired, se.enrolled_at) AS occurred_at,
          se.enrolled_at,
          se.sequence_id, p.campaign_id,
          se.enrolled_by AS rep_id,
          p.first_name, p.last_name, p.email AS prospect_email,
          p.title, p.company_name, p.linkedin_url,
          s.name AS sequence_name,
          c.name AS campaign_name,
          u.first_name AS rep_first_name, u.last_name AS rep_last_name, u.email AS rep_email
        FROM sequence_enrollments se
        JOIN prospects p ON p.id = se.prospect_id
        LEFT JOIN LATERAL (
          SELECT MAX(fired_at) AS last_fired FROM sequence_step_logs
           WHERE enrollment_id = se.id
        ) sx ON true
        LEFT JOIN sequences s              ON s.id = se.sequence_id
        LEFT JOIN prospecting_campaigns c  ON c.id = p.campaign_id
        LEFT JOIN users u                  ON u.id = se.enrolled_by
        WHERE se.org_id     = $1
          AND se.enrolled_by = ANY($2::int[])
          AND se.status     = 'active'
          AND COALESCE(sx.last_fired, se.enrolled_at) < ${endParam}::timestamptz - INTERVAL '7 days'
          ${campClause}
          ${seqClause}
        ORDER BY COALESCE(sx.last_fired, se.enrolled_at) ASC, se.id ASC
        LIMIT ${P(limit)} OFFSET ${P(offset)}`;
    }

    const { rows } = await pool.query(sql, params);
    const total = rows.length ? rows[0].total_count : 0;

    // ── The footnote (replies only) ──────────────────────────────────
    // Inbound email from a prospect in this campaign who was never enrolled.
    // Not in `total`, by design — there is no rep or sequence to attribute it
    // to. Counted separately so the gap is visible instead of mysterious.
    if (metric === 'replied' && campaignIds) {
      const { rows: ur } = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM emails e
           JOIN prospects p ON p.id = e.prospect_id AND p.org_id = e.org_id
          WHERE e.org_id     = $1
            AND p.campaign_id = ANY($2::int[])
            AND e.direction   IN ('received','inbound')
            AND e.deleted_at  IS NULL
            AND e.sent_at    >= ($3::timestamptz AT TIME ZONE 'UTC')
            AND e.sent_at    <= ($4::timestamptz AT TIME ZONE 'UTC')
            AND EXISTS (
              SELECT 1 FROM emails o
               WHERE o.org_id = e.org_id AND o.prospect_id = e.prospect_id
                 AND o.direction = 'sent' AND o.deleted_at IS NULL
                 AND o.sent_at < e.sent_at
            )
            AND NOT EXISTS (
              SELECT 1 FROM sequence_enrollments se
               WHERE se.prospect_id = p.id
                 AND se.org_id      = e.org_id
                 AND se.enrolled_at < (e.sent_at AT TIME ZONE 'UTC')
            )`,
        [req.orgId, campaignIds, window.startISO, window.endISO]
      );
      unattributedReplies = ur[0]?.n || 0;
    }

    const out = rows.map(r => {
      if (metric === 'replied') {
        return _drillRow(r, {
          channel: r.channel,
          subject: r.subject || null,
          snippet: _snippet(r.body_raw),
        });
      }
      if (metric === 'bounced') {
        // eventType is always a hard bounce here (the drill filters to the
        // subtracted set); the field is returned so the row can label itself
        // if UNDELIVERABLE_EVENT_TYPES ever widens.
        const rejected = (r.failed_recipient || '').toLowerCase();
        const onRecord = (r.prospect_email  || '').toLowerCase();
        return _drillRow(r, {
          channel:            'email',
          eventType:          r.event_type,
          failedRecipient:    r.failed_recipient || null,
          smtpCode:           r.smtp_code || null,
          diagnostic:         r.diagnostic_excerpt || null,
          enrollmentStopped:  r.enrollment_stopped === true,
          sentAt:             r.sent_at || null,
          // The NDR body names the address the mail server actually rejected.
          // The pre-Gate-0 ingest attached bounces to whichever prospect shared
          // the sending domain, so a mismatch here means a stale address on the
          // record or a misattributed bounce. Either is worth a rep's minute.
          addressMismatch:    !!(rejected && onRecord && rejected !== onRecord),
        });
      }
      if (metric === 'sent' || metric === 'drafts' || metric === 'failed') {
        return _drillRow(r, {
          channel:      r.channel,
          status:       r.status,
          stepIntent:   r.step_intent || null,
          errorMessage: r.error_message || null,
          subject:      r.subject || null,
          snippet:      _snippet(r.body_raw),
        });
      }
      if (metric === 'delivered' || metric === 'opened' || metric === 'clicked') {
        // Engagement extras ride along so the panel can render "opened 3× ·
        // last <date>" and the clicked destinations without another fetch.
        return _drillRow(r, {
          channel:     'email',
          subject:     r.subject || null,
          snippet:     metric === 'delivered' ? _snippet(r.body_raw) : null,
          opens:       r.opens  || 0,
          lastOpenAt:  r.last_open_at || null,
          clicks:      r.clicks || 0,
          lastClickAt: r.last_click_at || null,
          clickedUrls: r.clicked_urls || [],
        });
      }
      if (metric === 'stalled') {
        return _drillRow(r, { status: r.status, enrolledAt: r.enrolled_at });
      }
      return _drillRow(r, { status: r.status });   // enrolled
    });

    res.json({
      metric,
      channel,
      period: {
        startDate:   window.startISO,
        endDate:     window.endISO,
        description: window.isoIntervalDescription,
      },
      total,
      rows: out,
      unattributedReplies,
    });
  } catch (err) {
    console.error('GET /reporting/metric-drill failed:', err);
    res.status(500).json({ error: { message: 'Failed to load drill rows: ' + err.message } });
  }
});

// ── GET /reporting/health — portfolio R/Y/G rollup grouped by a lens ──────────
const { orgContext: _orgCtxHealth } = require('../middleware/orgContext.middleware');
const _portfolioReporting = require('../services/reporting.service');
router.get('/health', _orgCtxHealth, (req, res) =>
  _portfolioReporting.healthRollup(req.orgId, req.query.groupBy || 'account')
    .then(out => res.json(out))
    .catch(e => res.status(e.status || 500).json({ error: { message: e.message } })));

module.exports = router;
