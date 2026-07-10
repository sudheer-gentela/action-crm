// ─────────────────────────────────────────────────────────────────────────────
// services/ReplyEventsQuery.js
// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE DEFINITION OF "A REPLY" FOR EVERY REPORTING SURFACE.
//
// WHY THIS FILE EXISTS
//
// The `replied` counter used to be computed independently on two surfaces and
// they disagreed on live data:
//
//   * routes/reporting.routes.js  (Team reporting → By campaign)
//       counted inbound rows in `emails`, attributed to the enrollment that
//       preceded them. Showed real numbers.
//
//   * routes/prospecting-campaigns.routes.js  (/:id/sequence-health, the
//     drill-down panel)
//       counted `sequence_step_logs.status = 'replied'`.
//
// Nothing in the codebase ever writes 'replied' to sequence_step_logs.status.
// The only writer of that string is SequenceStepFirer.js, and it writes to
// sequence_enrollments.status. So the drill-down's REPLIED column and its
// reply-rate tile read 0 for every campaign, for every org, forever — while
// the campaign row one click away showed 5 replies and 45.5%.
//
// sequence_enrollments.status = 'replied' is not a usable substitute either:
// SequenceStepFirer only sets it when it next ticks an *active* enrollment, so
// enrollments that already reached 'completed' never get marked. On a live org
// that undercounts by an order of magnitude.
//
// Both surfaces now build their reply counts from this one CTE. They reconcile
// by construction rather than by coincidence. If you change the definition of
// a reply, you change it here, once.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT COUNTS AS A REPLY
//
// EMAIL branch    — a row in `emails` with direction 'received'/'inbound',
//   not soft-deleted, that follows at least one real outbound to the same
//   prospect. (Cold inbound — a prospect writing to us first — is not a reply.)
//
// LINKEDIN branch — a row in `prospecting_activities`. LinkedIn replies are
//   stored in a single bucket activity_type='linkedin_event' with the specific
//   event in metadata->>'event' (LinkedInConnectionSyncService.js,
//   prospects.routes.js). Manually-logged responses land as
//   activity_type='response_received' with metadata->>'channel'='linkedin'.
//   Both count.
//
// ─────────────────────────────────────────────────────────────────────────────
// GRAIN AND ATTRIBUTION
//
// An inbound email has no enrollment_id, so it cannot be attributed to a rep or
// a sequence directly. We reach back to the most recent enrollment that PRECEDED
// the reply (`se.enrolled_at < replied_at`) and take that enrollment's
// enrolled_by / sequence_id, plus the prospect's campaign_id. Same for the
// LinkedIn activity rows.
//
// `DISTINCT ON (e.id) ... ORDER BY e.id, se.enrolled_at DESC, se.id DESC`
// guarantees exactly ONE row per inbound event. Without it, a prospect enrolled
// twice (or by two reps) would have its single reply counted once per
// enrollment. This is the difference between a reply *count* and a reply
// *cross-join*, and it is the reason each branch is a subquery rather than a
// plain JOIN.
//
// The rep predicate (`se.enrolled_by = ANY(...)`) is applied BEFORE the
// DISTINCT ON, so a reply lands on the most recent *in-scope* enrollment even
// when a later out-of-scope enrollment exists. That is the correct behaviour
// for a manager viewing a narrowed team.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE `channel` COLUMN EXISTS
//
// `log_agg.sent` counts every step log regardless of channel. On a sequence
// whose step 1 is a LinkedIn touch and steps 2-3 are email, a blended
// repliedRate divides EMAIL replies by EMAIL + LINKEDIN sends. On a real
// campaign (166 LinkedIn sends, 174 email sends) that understates the email
// reply rate by roughly half. Splitting the numerator and denominator by
// channel is the only way the number means anything. Callers FILTER on
// `channel` to build the split.
//
// ─────────────────────────────────────────────────────────────────────────────
// TIMESTAMP DISCIPLINE
//
// `emails.sent_at` and `prospecting_activities.created_at` are both
// `timestamp without time zone`, holding UTC wall time (DB convention).
// `sequence_enrollments.enrolled_at` is `timestamptz`. Mixing them bare makes
// Postgres cast the naive value using the *session* TimeZone, which is
// environment-dependent. Every comparison below is therefore explicit:
//   * naive vs. window bound → `$n::timestamptz AT TIME ZONE 'UTC'` (→ naive)
//   * naive vs. timestamptz  → `x AT TIME ZONE 'UTC'`               (→ tz-aware)
//
// `replied_at` is emitted NAIVE (UTC wall time) so both branches union cleanly.
// A caller bucketing it against NOW() must lift it: `replied_at AT TIME ZONE 'UTC'`.
//
// ─────────────────────────────────────────────────────────────────────────────
// KNOWN LIMITS (deliberate — documented rather than hidden)
//
//   1. A reply from a prospect who was never enrolled in any sequence is not
//      counted (there is no enrollment to attribute it to). The campaign detail
//      panel's own funnel does count it, since it keys off campaign_id alone.
//      Expect reporting <= campaign panel for orgs doing manual outreach.
//   2. `replied` is window-bounded by the reply's own timestamp, while `sent`
//      is window-bounded by fired_at. repliedRate is therefore a period rate
//      (replies received / sends made, same window), NOT a per-send cohort
//      rate. Same convention MetricSnapshotService uses (design decision D18).
//   3. The email branch filters `e.deleted_at IS NULL`; the LinkedIn branch has
//      no soft-delete column to filter.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `reply_events` CTE — one row per attributable inbound reply,
 * across BOTH channels, each tagged with the channel it arrived on.
 *
 * Emits columns: channel, user_id, sequence_id, campaign_id, replied_at.
 *
 * Every predicate is passed as a positional placeholder string ('$3') rather
 * than a value, because the callers build their param arrays in different
 * orders. Pass null for any optional filter to omit its predicate entirely —
 * and then do NOT bind a value for it, or Postgres will reject the bind.
 *
 * @param {object} o
 *   orgParam       default '$1' — scalar org id
 *   userParam      default '$2' — int[] of enrolled_by user ids.
 *                  Pass null to count replies for ALL reps (the unscoped
 *                  back-compat path used by /:id/sequence-health when the
 *                  caller sent neither ?depth nor ?userIds).
 *   startParam     e.g. '$3' — window start, bound as timestamptz
 *   endParam       e.g. '$4' — window end, bound as timestamptz
 *   campaignParam  optional e.g. '$5' — int[] of campaign ids
 *   sequenceParam  optional e.g. '$6' — int[] of sequence ids
 * @returns {string} the CTE body, WITHOUT a trailing comma and WITHOUT `WITH`
 */
function replyEventsCte({
  orgParam = '$1',
  userParam = '$2',
  startParam,
  endParam,
  campaignParam = null,
  sequenceParam = null,
}) {
  if (!startParam || !endParam) {
    throw new Error('replyEventsCte: startParam and endParam are required');
  }

  const repEmail = userParam ? `AND se.enrolled_by    = ANY(${userParam}::int[])` : '';
  const repLi    = userParam ? `AND se_li.enrolled_by = ANY(${userParam}::int[])` : '';
  const ccEmail  = campaignParam ? `AND p_reply.campaign_id    = ANY(${campaignParam}::int[])` : '';
  const ccLi     = campaignParam ? `AND p_reply_li.campaign_id = ANY(${campaignParam}::int[])` : '';
  const sfEmail  = sequenceParam ? `AND se.sequence_id    = ANY(${sequenceParam}::int[])` : '';
  const sfLi     = sequenceParam ? `AND se_li.sequence_id = ANY(${sequenceParam}::int[])` : '';

  return `
     reply_events AS (
       -- ── EMAIL ────────────────────────────────────────────────────────
       SELECT * FROM (
         SELECT DISTINCT ON (e.id)
           'email'::text        AS channel,
           se.enrolled_by       AS user_id,
           se.sequence_id       AS sequence_id,
           p_reply.campaign_id  AS campaign_id,
           e.sent_at            AS replied_at
         FROM emails e
         JOIN prospects p_reply
           ON p_reply.id     = e.prospect_id
          AND p_reply.org_id = e.org_id
         JOIN sequence_enrollments se
           ON se.prospect_id = p_reply.id
          AND se.org_id      = e.org_id
          AND se.enrolled_at < (e.sent_at AT TIME ZONE 'UTC')
         WHERE e.org_id       = ${orgParam}
           AND e.direction    IN ('received', 'inbound')
           AND e.deleted_at   IS NULL
           AND e.sent_at     >= (${startParam}::timestamptz AT TIME ZONE 'UTC')
           AND e.sent_at     <= (${endParam}::timestamptz   AT TIME ZONE 'UTC')
           -- Cold inbound (a prospect writing first) is not a reply.
           AND EXISTS (
             SELECT 1 FROM emails o
              WHERE o.org_id      = e.org_id
                AND o.prospect_id = e.prospect_id
                AND o.direction   = 'sent'
                AND o.deleted_at  IS NULL
                AND o.sent_at     < e.sent_at
           )
           ${repEmail}
           ${ccEmail}
           ${sfEmail}
         ORDER BY e.id, se.enrolled_at DESC, se.id DESC
       ) q_email

       UNION ALL

       -- ── LINKEDIN ─────────────────────────────────────────────────────
       SELECT * FROM (
         SELECT DISTINCT ON (a.id)
           'linkedin'::text        AS channel,
           se_li.enrolled_by       AS user_id,
           se_li.sequence_id       AS sequence_id,
           p_reply_li.campaign_id  AS campaign_id,
           a.created_at            AS replied_at
         FROM prospecting_activities a
         JOIN prospects p_reply_li
           ON p_reply_li.id     = a.prospect_id
          AND p_reply_li.org_id = a.org_id
         JOIN sequence_enrollments se_li
           ON se_li.prospect_id = p_reply_li.id
          AND se_li.org_id      = a.org_id
          AND se_li.enrolled_at < (a.created_at AT TIME ZONE 'UTC')
         WHERE a.org_id          = ${orgParam}
           AND (
                (a.activity_type = 'linkedin_event'
                 AND a.metadata ->> 'event' = 'reply_received')
             OR (a.activity_type = 'response_received'
                 AND a.metadata ->> 'channel' = 'linkedin')
           )
           AND a.created_at >= (${startParam}::timestamptz AT TIME ZONE 'UTC')
           AND a.created_at <= (${endParam}::timestamptz   AT TIME ZONE 'UTC')
           ${repLi}
           ${ccLi}
           ${sfLi}
         ORDER BY a.id, se_li.enrolled_at DESC, se_li.id DESC
       ) q_linkedin
     )`;
}

/** replied / sent as a 1-decimal percentage. 0 when there were no sends. */
function repliedRate(replied, sent) {
  return sent > 0 ? +((replied / sent) * 100).toFixed(1) : 0;
}

module.exports = { replyEventsCte, repliedRate };
