// ─────────────────────────────────────────────────────────────────────────────
// services/BounceEventsQuery.js
// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE DEFINITION OF "A BOUNCE" FOR EVERY REPORTING SURFACE.
//
// Sibling of services/ReplyEventsQuery.js, and it exists for the same reason:
// the moment two surfaces compute the same word from two different predicates,
// they drift, and someone eventually files a bug that takes a day to explain.
//
// ─────────────────────────────────────────────────────────────────────────────
// A BOUNCE IS A PROPERTY OF THE SEND, NOT AN EVENT IN THE WINDOW
//
// This is the whole design, and it is not the obvious choice.
//
// `email_delivery_events.detected_at` is when the NDR arrived. Bounding the
// window on it would be the natural mirror of reply_events, which bounds on the
// reply's own timestamp. It is also wrong here, because `Delivered` is defined
// as `Sent − Bounced`, and those two would then count different cohorts:
//
//   24h window. 40 sends went out yesterday. 3 NDRs arrive this morning.
//   sent = 0 (fired_at is outside the window)
//   bounced = 3 (detected_at is inside it)
//   delivered = -3
//
// So the window is applied to `sequence_step_logs.fired_at` — the send — and a
// bounce is attributed to the send it killed. `Delivered %` becomes a cohort
// rate: of the mail we sent in this window, this fraction landed. That is what
// a rep means by the phrase, and it cannot go negative.
//
// The cost, stated plainly: a 24h window under-reports bounces on sends made in
// the last few hours, because their NDRs have not arrived yet. The number
// matures over the following day. That is honest, and it is the correct
// trade — a delivery rate that ratchets down as evidence arrives beats one that
// can print a negative.
//
// This ALSO makes `bounce_events` a strict subset of the row set `log_agg`
// counts as `sent`: same fired_at bounds, same `status IN ('sent','completed')`,
// same `channel = 'email'`, same `enrolled_by` scope. `Sent − Bounced >= 0` is
// therefore guaranteed by construction rather than clamped after the fact.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE ROW PER SEND, CLASSIFIED BY ITS WORST OUTCOME
//
// `email_delivery_events` is unique only on (org_id, ndr_external_id,
// failed_recipient) WHERE ndr_external_id IS NOT NULL. A single step log can
// therefore collect several events: a soft bounce on Tuesday and a hard bounce
// on Thursday, or two NDRs for one send from a mail server that retried.
// Counting rows would double-count the send and could push `delivered` negative
// again.
//
// `DISTINCT ON (ssl.id)` collapses to one row per send, ordered by severity:
//
//     hard_bounce > block > soft_bounce
//
// A send that soft-bounced and later hard-bounced is a hard bounce. The reverse
// never happens. Ties break on detected_at ASC — the first verdict wins.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONLY HARD BOUNCES ARE SUBTRACTED
//
// A soft bounce is a full mailbox or a greylist — a retry, not a dead address.
// Subtracting it from `Delivered` is a lie about mail that usually arrives on
// the retry.
//
//   bounced       = hard_bounce              ← the headline, subtracted
//   bounced_block = block                    ← shown, NOT subtracted
//   bounced_soft  = soft_bounce              ← shown, NOT subtracted
//   delivered     = sent_email − bounced
//
// A NOTE ON `block`, BECAUSE IT IS THE DEBATABLE ONE
//
// classify() returns 'block' for 5.7.x — access denied, recipient rejected,
// spam-blocked. That mail did NOT arrive. Counting it inside `delivered`
// therefore overstates delivery, and it is the metric a reputation problem
// would show up in first: a blocklisted sending domain produces blocks, not
// hard bounces, and `Deliv %` would stay green while the mailbox burns.
//
// It is excluded from the subtraction on the product owner's explicit call,
// because a block is a sender problem rather than a dead address, and the two
// warrant different responses. `bounced_block` is surfaced beside the headline
// so it is never invisible. Flipping the decision is a one-line change to the
// FILTER below and to `delivered()`.
//
// KNOWN LIMIT (deliberate)
//
// Events with `step_log_id IS NULL` — an NDR the parser could not tie back to a
// send — are excluded entirely. They have no fired_at, so they belong to no
// window and to no cohort. They are still visible on the prospect's enrollment
// timeline (routes/sequences.routes.js anchors them by time) and in the raw
// `email_delivery_events` table. They are simply not a fraction of anything.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `bounce_events` CTE — one row per SEND that bounced, tagged with
 * the worst delivery verdict that send received.
 *
 * Emits: step_log_id, user_id, sequence_id, campaign_id, event_type
 *        (+ prospect_id, enrollment_id, failed_recipient, smtp_code,
 *         diagnostic_excerpt, enrollment_stopped, detected_at when detail=true)
 *
 * Positional placeholders, same contract as replyEventsCte: pass null for an
 * optional filter to omit its predicate, and then do NOT bind a value for it.
 *
 * @param {object} o
 *   orgParam       default '$1' — scalar org id
 *   userParam      default '$2' — int[] of enrolled_by user ids; null = all reps
 *   startParam     e.g. '$3' — window start, bound as timestamptz (vs fired_at)
 *   endParam       e.g. '$4' — window end, bound as timestamptz (vs fired_at)
 *   campaignParam  optional e.g. '$5' — int[] of campaign ids
 *   sequenceParam  optional e.g. '$6' — int[] of sequence ids
 *   detail         default false — add the per-row columns the drill list needs
 * @returns {string} the CTE body, WITHOUT a trailing comma and WITHOUT `WITH`
 */
function bounceEventsCte({
  orgParam = '$1',
  userParam = '$2',
  startParam,
  endParam,
  campaignParam = null,
  sequenceParam = null,
  detail = false,
}) {
  if (!startParam || !endParam) {
    throw new Error('bounceEventsCte: startParam and endParam are required');
  }

  const repClause  = userParam     ? `AND se_b.enrolled_by = ANY(${userParam}::int[])`     : '';
  const campClause = campaignParam ? `AND p_b.campaign_id   = ANY(${campaignParam}::int[])` : '';
  const seqClause  = sequenceParam ? `AND se_b.sequence_id  = ANY(${sequenceParam}::int[])` : '';

  const detailCols = detail ? `,
           se_b.prospect_id          AS prospect_id,
           se_b.id                   AS enrollment_id,
           ede.failed_recipient      AS failed_recipient,
           ede.smtp_code             AS smtp_code,
           ede.diagnostic_excerpt    AS diagnostic_excerpt,
           ede.enrollment_stopped    AS enrollment_stopped,
           ede.detected_at           AS detected_at,
           ssl_b.fired_at            AS sent_at` : '';

  return `
     bounce_events AS (
       SELECT DISTINCT ON (ssl_b.id)
         ssl_b.id            AS step_log_id,
         se_b.enrolled_by    AS user_id,
         se_b.sequence_id    AS sequence_id,
         p_b.campaign_id     AS campaign_id,
         ede.event_type      AS event_type${detailCols}
       FROM email_delivery_events ede
       JOIN sequence_step_logs ssl_b
         ON ssl_b.id     = ede.step_log_id
        AND ssl_b.org_id = ede.org_id
       JOIN sequence_enrollments se_b
         ON se_b.id      = ssl_b.enrollment_id
       JOIN prospects p_b
         ON p_b.id       = se_b.prospect_id
      WHERE ede.org_id      = ${orgParam}
        -- Strict subset of what log_agg counts as sent, so delivered >= 0.
        AND ssl_b.channel   = 'email'
        AND ssl_b.status    IN ('sent','completed')
        AND ssl_b.fired_at >= ${startParam}::timestamptz
        AND ssl_b.fired_at <= ${endParam}::timestamptz
        ${repClause}
        ${campClause}
        ${seqClause}
      -- One row per send; worst verdict wins, earliest verdict breaks the tie.
      ORDER BY ssl_b.id,
               CASE ede.event_type
                 WHEN 'hard_bounce' THEN 1
                 WHEN 'block'       THEN 2
                 WHEN 'soft_bounce' THEN 3
                 ELSE 4
               END,
               ede.detected_at ASC
     )`;
}

/**
 * The three counters every aggregate needs, as SQL expressions over
 * `bounce_events`. Kept here so campaign / rep / sequence grains can never
 * disagree about which verdicts are undeliverable.
 */
const BOUNCE_COUNTERS = `
         COUNT(*) FILTER (WHERE event_type = 'hard_bounce')::int      AS bounced_hard,
         COUNT(*) FILTER (WHERE event_type = 'block')::int            AS bounced_block,
         COUNT(*) FILTER (WHERE event_type = 'soft_bounce')::int      AS bounced_soft,
         -- The subtracted quantity. Hard bounces only: a dead address had no
         -- opportunity to receive. Blocks and soft bounces are reported beside
         -- it but left inside delivered (see header).
         COUNT(*) FILTER (WHERE event_type = 'hard_bounce')::int      AS bounced`;

/** The one event type that removes a send from `delivered`. */
const UNDELIVERABLE_EVENT_TYPES = ['hard_bounce'];

/**
 * delivered = sent − hard bounces. Never negative: every bounce_events row is a
 * step log that log_agg already counted as sent, so the subtrahend is bounded.
 */
function delivered(sentEmail, bounced) {
  return Math.max(0, (sentEmail || 0) - (bounced || 0));
}

/** delivered / sent as a 1-decimal percentage. 0 when nothing was sent. */
function deliveredRate(sentEmail, bounced) {
  const s = sentEmail || 0;
  if (s <= 0) return 0;
  return +((delivered(s, bounced) / s) * 100).toFixed(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// ABSENCE OF EVIDENCE IS NOT EVIDENCE OF DELIVERY
//
// We never receive positive delivery confirmation. There is no SMTP DSN for
// success and no ESP webhook. `delivered` is therefore not "the mail arrived" —
// it is "we sent it and no bounce came back." Those are the same number only
// when bounces are actually being captured.
//
// If `email_delivery_events` is empty, `bounced` is 0 for every row and
// `deliveredRate` prints a confident 100.0% for every campaign in the org. That
// reading is indistinguishable from a healthy list, and it is wrong: it means
// the delivery pipeline has told us nothing at all. On a live org the first
// symptom of a broken NDR ingest would be a page full of perfect scores.
//
// So the counters are only meaningful in the presence of telemetry, and the API
// says so explicitly rather than letting a zero speak for itself.
//
// COVERAGE START. Bounce capture began when Gate 0 landed in
// routes/prospecting-inbox.routes.js — before that, NDRs were stored as
// replies and no delivery event was ever written. `since` is the first
// detected_at on record. A reporting window that opens before `since` contains
// sends for which no bounce could have been recorded, so its delivery rate is
// optimistic by an unknown amount. The UI flags the window rather than
// pretending the boundary does not exist.
//
// (Historic NDRs recovered by NdrCleanupService are reprocessed with
// detected_at = now(), so `since` reflects when we started *looking*, not when
// the bounces happened. That is the honest reading either way.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this org have any delivery telemetry, and from when?
 *
 * @returns {Promise<{hasEvents: boolean, since: string|null}>}
 */
async function deliveryTelemetry(pool, orgId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(detected_at) AS since
       FROM email_delivery_events
      WHERE org_id = $1`,
    [orgId]
  );
  return {
    hasEvents: (rows[0]?.n || 0) > 0,
    since:     rows[0]?.since || null,
  };
}

module.exports = {
  bounceEventsCte, BOUNCE_COUNTERS, UNDELIVERABLE_EVENT_TYPES,
  delivered, deliveredRate, deliveryTelemetry,
};
