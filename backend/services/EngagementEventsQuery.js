// ─────────────────────────────────────────────────────────────────────────────
// EngagementEventsQuery.js — the one definition of "opened" and "clicked"
// ─────────────────────────────────────────────────────────────────────────────
//
// Mirrors BounceEventsQuery: a single CTE builder that every reporting grain
// (campaign / rep / sequence) and the metric drill reuse verbatim, so an
// aggregate cell and its own drill-down can never disagree about what an
// "open" is.
//
// SEMANTICS
//
//   * MESSAGE-grain: one row per SEND (sequence_step_logs id) that received
//     at least one HUMAN engagement event. 25 open events on 10 messages is
//     opened=10, not 25 — the aggregate answers "how many messages were
//     opened", and the per-event multiplicity lives in the drill rows
//     (opens / last_open_at) and the prospect drawer.
//   * COHORT attribution: the window bounds the send's fired_at, NOT the
//     event's occurred_at. An open that arrives Tuesday for a send fired
//     inside last week's window counts toward last week. This makes
//     opened/clicked strict subsets of log_agg.sent_email — the same
//     discipline bounce_events applies — at the cost of late events
//     retroactively updating a closed window. (MetricSnapshotService counts
//     by occurred date instead; the WBR grid and these tables are therefore
//     allowed to differ slightly, and that is documented, not a bug.)
//   * HUMAN only: is_bot = false. The bot filter catches scanner UAs,
//     too-soon fires, and datacenter IPs — it does NOT catch Apple MPP or
//     Gmail image-proxy prefetches. Opens are DIRECTIONAL and every UI
//     surface labels them as such. Clicks are trustworthy.
//
// Positional placeholders, same contract as replyEventsCte / bounceEventsCte:
// pass null for an optional filter to omit its predicate, and then do NOT
// bind a value for it.
//
// @param {object} o
//   orgParam       default '$1' — scalar org id
//   userParam      default '$2' — int[] of enrolled_by user ids; null = all reps
//   startParam     e.g. '$3' — window start, bound as timestamptz (vs fired_at)
//   endParam       e.g. '$4' — window end, bound as timestamptz (vs fired_at)
//   campaignParam  optional e.g. '$5' — int[] of campaign ids
//   sequenceParam  optional e.g. '$6' — int[] of sequence ids
// @returns {string} the CTE body, WITHOUT a trailing comma and WITHOUT `WITH`
function engagementEventsCte({
  orgParam = '$1',
  userParam = '$2',
  startParam,
  endParam,
  campaignParam = null,
  sequenceParam = null,
}) {
  if (!startParam || !endParam) {
    throw new Error('engagementEventsCte: startParam and endParam are required');
  }

  const repClause  = userParam     ? `AND se_g.enrolled_by = ANY(${userParam}::int[])`     : '';
  const campClause = campaignParam ? `AND p_g.campaign_id   = ANY(${campaignParam}::int[])` : '';
  const seqClause  = sequenceParam ? `AND se_g.sequence_id  = ANY(${sequenceParam}::int[])` : '';

  return `
     engagement_events AS (
       SELECT ssl_g.id           AS step_log_id,
              se_g.enrolled_by   AS user_id,
              se_g.sequence_id   AS sequence_id,
              p_g.campaign_id    AS campaign_id,
              BOOL_OR(eee.event_type = 'open')  AS opened,
              BOOL_OR(eee.event_type = 'click') AS clicked
       FROM email_engagement_events eee
       JOIN sequence_step_logs ssl_g
         ON ssl_g.id     = eee.step_log_id
        AND ssl_g.org_id = eee.org_id
       JOIN sequence_enrollments se_g
         ON se_g.id      = ssl_g.enrollment_id
       JOIN prospects p_g
         ON p_g.id       = se_g.prospect_id
      WHERE eee.org_id      = ${orgParam}
        AND eee.is_bot      = false
        -- Strict subset of what log_agg counts as sent_email, so
        -- opened <= sent_email always holds.
        AND ssl_g.channel   = 'email'
        AND ssl_g.status    IN ('sent','completed')
        AND ssl_g.fired_at >= ${startParam}::timestamptz
        AND ssl_g.fired_at <= ${endParam}::timestamptz
        ${repClause}
        ${campClause}
        ${seqClause}
      GROUP BY ssl_g.id, se_g.enrolled_by, se_g.sequence_id, p_g.campaign_id
     )`;
}

/**
 * The two counters every aggregate needs, as SQL expressions over
 * `engagement_events`. One row in the CTE is one engaged MESSAGE, so a plain
 * count of the flags is already message-grain — no DISTINCT needed.
 */
const ENGAGEMENT_COUNTERS = `
         COUNT(*) FILTER (WHERE opened)::int   AS opened,
         COUNT(*) FILTER (WHERE clicked)::int  AS clicked`;

/**
 * "Do engagement events exist for this org at all?" — same honesty gate as
 * BounceEventsQuery.deliveryTelemetry. With tracking never armed, every
 * campaign scores 0 opens, which reads exactly like nobody-cares and means
 * nothing at all. The UI renders an em-dash instead of a zero until this
 * says events exist.
 */
async function engagementTelemetry(pool, orgId) {
  const { rows } = await pool.query(
    `SELECT MIN(occurred_at) AS since, COUNT(*)::int > 0 AS has_events
       FROM email_engagement_events
      WHERE org_id = $1 AND is_bot = false`,
    [orgId]
  );
  return {
    hasEvents: rows[0]?.has_events === true,
    since:     rows[0]?.since || null,
  };
}

module.exports = { engagementEventsCte, ENGAGEMENT_COUNTERS, engagementTelemetry };
