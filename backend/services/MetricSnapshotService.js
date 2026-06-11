/**
 * MetricSnapshotService.js
 *
 * Phase 1 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Computes the daily-grain raw-count snapshot of the outbound motion into
 * `prospecting_metric_daily`. Everything downstream — WBR frames (Phase 4),
 * OutboundInsightEngine (Phase 3) — reads from that table and NEVER from the
 * transactional tables directly.
 *
 * Entry points:
 *   runNightly(orgId)                — recompute trailing RECOMPUTE_DAYS
 *                                      org-local days (absorbs late replies /
 *                                      LinkedIn syncs). Cron: 03:20 UTC in
 *                                      syncScheduler.js, after the diagnostic
 *                                      sweeps (02:30 / 02:45 / 03:00).
 *   backfill(orgId, fromDate?)       — recompute from `fromDate` (or the org's
 *                                      earliest event) to today, in chunks.
 *   computeRange(orgId, start, end)  — recompute an explicit org-local date
 *                                      range [start, end] inclusive. The other
 *                                      two are thin wrappers over this.
 *   verify(orgId, days)              — reconcile snapshot totals against live
 *                                      aggregates (acceptance test, mirrors
 *                                      reporting.routes.js team-overview CTEs).
 *   getOrgCalendar(orgId)            — { timezone, weekStartDay,
 *                                      fiscalYearStartMonth } from
 *                                      organizations.settings.calendar with
 *                                      defaults UTC / Monday(1) / January(1).
 *                                      Also used by MetricFrameService (Phase 4).
 *
 * Writer contract (decision D19):
 *   DELETE + INSERT per (org_id, metric_date range) in ONE transaction.
 *   Safe to recompute any range at any time. Sentinel dims (0 / 'none' /
 *   'unknown'), never NULL — the unique grain index depends on it.
 *
 * Date semantics (decisions D8, D18):
 *   metric_date is the ORG-LOCAL date. timestamptz columns convert with
 *   (col AT TIME ZONE tz); naive timestamp columns are stored as UTC wall
 *   time (DB convention) and convert with (col AT TIME ZONE 'UTC' AT TIME
 *   ZONE tz). Replies are attributed to the date RECEIVED; sends to the date
 *   FIRED (period-based rates, not per-send cohorts).
 *
 * Known approximations (documented in the design doc, revisit if they bite):
 *   - qualified/converted derive from prospects.stage + stage_changed_at
 *     (current stage only — a prospect that transitioned twice in history
 *     counts once, on its latest transition date). prospect_stages table was
 *     absent from the schema dump, so no stage_type taxonomy join (D21).
 *   - fit_band uses the prospect's CURRENT icp_score (no score history kept).
 *   - LinkedIn events bucket by created_at (sync time), not LinkedIn's
 *     occurred-at; the 7-day recompute window absorbs ordinary lag (D20).
 *   - ooo_replies fires only when the reply activity carries
 *     metadata->>'email_id' linking to an email row whose subject matches the
 *     OOO patterns. Where that linkage is absent it stays 0; Phase 2 (inbox
 *     instrumentation) tightens this.
 *
 * Every INSERT carries org_id. Keep it that way.
 */

const db = require('../config/database');

// ── tunables ─────────────────────────────────────────────────────────────────

const RECOMPUTE_DAYS = 7;     // nightly trailing window (late-event absorption)
const BACKFILL_CHUNK_DAYS = 90;

// fit_band cut points over prospects.icp_score (0–100). FitGate's verdict is
// pass/fail and not persisted per prospect; icp_score is. Revisit cut points
// once real distributions exist (open item in design doc §8).
const FIT_BAND_SQL = `CASE
       WHEN p.icp_score IS NULL THEN 'unknown'
       WHEN p.icp_score >= 70   THEN 'high'
       WHEN p.icp_score >= 40   THEN 'medium'
       ELSE 'low' END`;

// Stage keys meaning "qualified" / "converted" — FALLBACK ONLY (D21 revised).
// The canonical source is pipeline_stages (pipeline = 'prospecting'), where
// prospects.stage stores the stage KEY and stage_type carries the taxonomy
// ('qualification' / 'converted' — same enum the legacy prospect-stages route
// validated and deals use via fn_sync_deal_stage_type for 'sales'). These
// literals only apply when an org has no pipeline_stages row for a key.
const QUALIFIED_STAGES = ['qualified'];
const CONVERTED_STAGES = ['converted'];

// Rule-based OOO detection (decision D4) — applied to the replied email's subject.
const OOO_SUBJECT_REGEX =
  '(out of office|out-of-office|auto.?reply|automatic reply|away from (the )?office|on (annual |parental )?leave|on vacation|currently traveling)';

// All measure columns, in table order. Each fact family emits this full list
// (zeros where not applicable) so the UNION ALL is column-aligned by name.
const MEASURES = [
  'enrolled', 'sent', 'failed', 'replied_steps', 'replies', 'ooo_replies',
  'connections_sent', 'connections_accepted', 'calls_logged',
  'meetings_booked', 'qualified', 'converted', 'prospects_added',
  'bounces_hard', 'bounces_soft', 'blocks',          // Phase 2 (email_delivery_events)
];

/** Emit the measure select list with `exprs` overriding specific measures. */
function measureCols(exprs = {}) {
  return MEASURES.map((m) => `${exprs[m] || '0'} AS ${m}`).join(',\n         ');
}

/** Org-local date expression for a timestamptz column. */
function tzDate(col) {
  return `((${col}) AT TIME ZONE $2::text)::date`;
}

/** Org-local date expression for a naive (timestamp without tz) column stored as UTC. */
function naiveDate(col) {
  return `(((${col}) AT TIME ZONE 'UTC') AT TIME ZONE $2::text)::date`;
}

// ── calendar config ──────────────────────────────────────────────────────────

const CALENDAR_DEFAULTS = {
  timezone: 'UTC',
  weekStartDay: 1,            // 1 = Monday (ISO) — decision D2
  fiscalYearStartMonth: 1,    // January — decision D2
};

/**
 * Read org calendar config from organizations.settings.calendar with defaults.
 * Invalid timezones fall back to UTC (a bad tz string would make every date
 * expression throw — fail safe, log loud).
 */
async function getOrgCalendar(orgId) {
  const r = await db.query(
    `SELECT settings -> 'calendar' AS cal FROM organizations WHERE id = $1`,
    [orgId]
  );
  const cal = r.rows[0]?.cal || {};
  const out = {
    timezone: typeof cal.timezone === 'string' && cal.timezone ? cal.timezone : CALENDAR_DEFAULTS.timezone,
    weekStartDay: Number.isInteger(cal.week_start_day) ? cal.week_start_day : CALENDAR_DEFAULTS.weekStartDay,
    fiscalYearStartMonth: Number.isInteger(cal.fiscal_year_start_month)
      ? cal.fiscal_year_start_month : CALENDAR_DEFAULTS.fiscalYearStartMonth,
  };
  // Cheap validity probe — pg throws on unknown tz names at query time.
  try {
    await db.query(`SELECT now() AT TIME ZONE $1::text`, [out.timezone]);
  } catch (e) {
    console.error(`[MetricSnapshot] org=${orgId} invalid timezone '${out.timezone}' — falling back to UTC`);
    out.timezone = CALENDAR_DEFAULTS.timezone;
  }
  return out;
}

/** Today's date string (YYYY-MM-DD) in the given timezone. */
async function localToday(tz) {
  const r = await db.query(`SELECT (now() AT TIME ZONE $1::text)::date::text AS d`, [tz]);
  return r.rows[0].d;
}

// ── fact-family subqueries ───────────────────────────────────────────────────
// Each family SELECTs: org-local date d, the 7 grain dims (sentinel-coalesced),
// and the full measure list. Params: $1 org, $2 tz, $3 start date, $4 end date.
// Raw-timestamp pre-filters (±2 days padding) keep the scans index-friendly;
// the exact predicate is on the converted local date.

function familyStepLogs() {
  return `
      SELECT ${tzDate('ssl.fired_at')}                                   AS d,
             COALESCE(p.campaign_id, 0)                                  AS campaign_id,
             COALESCE(se.sequence_id, 0)                                 AS sequence_id,
             COALESCE(ssl.sequence_step_id, 0)                           AS sequence_step_id,
             COALESCE(NULLIF(ssl.channel, ''), 'unknown')                AS channel,
             CASE WHEN ssl.channel = 'email'
                  THEN COALESCE(e.sender_account_id, 0) ELSE 0 END       AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({
           sent: `CASE WHEN ssl.status IN ('sent','completed','replied') THEN 1 ELSE 0 END`,
           failed: `CASE WHEN ssl.status = 'failed' THEN 1 ELSE 0 END`,
           replied_steps: `CASE WHEN ssl.status = 'replied' THEN 1 ELSE 0 END`,
         })}
        FROM sequence_step_logs ssl
        JOIN sequence_enrollments se ON se.id = ssl.enrollment_id AND se.org_id = ssl.org_id
        JOIN prospects p             ON p.id = ssl.prospect_id    AND p.org_id  = ssl.org_id
        LEFT JOIN emails e           ON e.id = ssl.email_id       AND e.org_id  = ssl.org_id
       WHERE ssl.org_id = $1
         AND ssl.status IN ('sent','completed','replied','failed')
         AND ssl.fired_at >= ($3::date - INTERVAL '2 days')
         AND ssl.fired_at <  ($4::date + INTERVAL '3 days')
         AND ${tzDate('ssl.fired_at')} BETWEEN $3::date AND $4::date`;
}

function familyEnrollments() {
  return `
      SELECT ${tzDate('se.enrolled_at')}                                 AS d,
             COALESCE(p.campaign_id, 0)                                  AS campaign_id,
             COALESCE(se.sequence_id, 0)                                 AS sequence_id,
             0                                                           AS sequence_step_id,
             'none'                                                      AS channel,
             0                                                           AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({ enrolled: '1' })}
        FROM sequence_enrollments se
        JOIN prospects p ON p.id = se.prospect_id AND p.org_id = se.org_id
       WHERE se.org_id = $1
         AND se.enrolled_at >= ($3::date - INTERVAL '2 days')
         AND se.enrolled_at <  ($4::date + INTERVAL '3 days')
         AND ${tzDate('se.enrolled_at')} BETWEEN $3::date AND $4::date`;
}

// Replies / connections / calls — all from prospecting_activities (naive created_at).
function familyActivities() {
  const d = naiveDate('a.created_at');
  return `
      SELECT ${d}                                                        AS d,
             COALESCE(p.campaign_id, 0)                                  AS campaign_id,
             0                                                           AS sequence_id,
             0                                                           AS sequence_step_id,
             CASE
               WHEN a.activity_type = 'call_logged' THEN 'call'
               WHEN a.activity_type IN ('linkedin_connection_sent','linkedin_event') THEN 'linkedin'
               WHEN a.activity_type = 'email_received' THEN 'email'
               ELSE COALESCE(NULLIF(a.metadata ->> 'channel', ''), 'unknown')
             END                                                         AS channel,
             0                                                           AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({
           replies: `CASE WHEN a.activity_type IN ('response_received','email_received') THEN 1 ELSE 0 END`,
           ooo_replies: `CASE WHEN a.activity_type IN ('response_received','email_received')
                              AND re.subject ~* '${OOO_SUBJECT_REGEX}' THEN 1 ELSE 0 END`,
           connections_sent: `CASE WHEN a.activity_type = 'linkedin_connection_sent'
                                     OR (a.activity_type = 'linkedin_event'
                                         AND a.metadata ->> 'event' = 'connection_request_sent')
                                   THEN 1 ELSE 0 END`,
           connections_accepted: `CASE WHEN a.activity_type = 'linkedin_event'
                                        AND a.metadata ->> 'event' = 'connection_accepted'
                                       THEN 1 ELSE 0 END`,
           calls_logged: `CASE WHEN a.activity_type = 'call_logged' THEN 1 ELSE 0 END`,
         })}
        FROM prospecting_activities a
        JOIN prospects p ON p.id = a.prospect_id AND p.org_id = a.org_id
        LEFT JOIN emails re
          ON a.metadata ? 'email_id'
         AND (a.metadata ->> 'email_id') ~ '^[0-9]+$'
         AND re.id = (a.metadata ->> 'email_id')::int
         AND re.org_id = a.org_id
       WHERE a.org_id = $1
         AND a.activity_type IN ('response_received','email_received','call_logged',
                                 'linkedin_connection_sent','linkedin_event')
         AND a.created_at >= ($3::date - INTERVAL '2 days')
         AND a.created_at <  ($4::date + INTERVAL '3 days')
         AND ${d} BETWEEN $3::date AND $4::date`;
}

function familyMeetings() {
  const d = naiveDate('m.created_at');
  return `
      SELECT ${d}                                                        AS d,
             COALESCE(p.campaign_id, 0)                                  AS campaign_id,
             0 AS sequence_id, 0 AS sequence_step_id,
             'none' AS channel, 0 AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({ meetings_booked: '1' })}
        FROM meetings m
        JOIN prospects p ON p.id = m.prospect_id AND p.org_id = m.org_id
       WHERE m.org_id = $1
         AND m.prospect_id IS NOT NULL
         AND m.deleted_at IS NULL
         AND COALESCE(m.status, 'scheduled') <> 'cancelled'
         AND m.created_at >= ($3::date - INTERVAL '2 days')
         AND m.created_at <  ($4::date + INTERVAL '3 days')
         AND ${d} BETWEEN $3::date AND $4::date`;
}

// Stage transitions — taxonomy-driven via pipeline_stages (pipeline =
// 'prospecting'), with literal-key fallback for orgs/keys without a taxonomy
// row. Still an approximation on the time axis (current stage + latest
// transition date — D21): a prospect that transitioned twice counts once.
function familyStageTransitions() {
  const d = naiveDate('p.stage_changed_at');
  const q = QUALIFIED_STAGES.map((s) => `'${s}'`).join(',');
  const c = CONVERTED_STAGES.map((s) => `'${s}'`).join(',');
  const effType = `COALESCE(ps.stage_type,
                            CASE WHEN p.stage IN (${q}) THEN 'qualification'
                                 WHEN p.stage IN (${c}) THEN 'converted'
                            END)`;
  return `
      SELECT ${d}                                                        AS d,
             COALESCE(p.campaign_id, 0)                                  AS campaign_id,
             0 AS sequence_id, 0 AS sequence_step_id,
             'none' AS channel, 0 AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({
           qualified: `CASE WHEN ${effType} = 'qualification' THEN 1 ELSE 0 END`,
           converted: `CASE WHEN ${effType} = 'converted' THEN 1 ELSE 0 END`,
         })}
        FROM prospects p
        LEFT JOIN pipeline_stages ps
          ON ps.org_id = p.org_id
         AND ps.pipeline = 'prospecting'
         AND ps.key = p.stage
       WHERE p.org_id = $1
         AND p.stage_changed_at IS NOT NULL
         AND ${effType} IN ('qualification','converted')
         AND p.stage_changed_at >= ($3::date - INTERVAL '2 days')
         AND p.stage_changed_at <  ($4::date + INTERVAL '3 days')
         AND ${d} BETWEEN $3::date AND $4::date`;
}

function familyProspectsAdded() {
  const d = naiveDate('p.created_at');
  return `
      SELECT ${d}                                                        AS d,
             COALESCE(p.campaign_id, 0)                                  AS campaign_id,
             0 AS sequence_id, 0 AS sequence_step_id,
             'none' AS channel, 0 AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({ prospects_added: '1' })}
        FROM prospects p
       WHERE p.org_id = $1
         AND p.created_at >= ($3::date - INTERVAL '2 days')
         AND p.created_at <  ($4::date + INTERVAL '3 days')
         AND ${d} BETWEEN $3::date AND $4::date`;
}

// Phase 2 — bounce/block events from NDR parsing, by DETECTED date.
// Dims come from the event row (matched at detection time); unmatched events
// carry sentinel dims and still count at the org level. fit_band from the
// linked prospect's current icp_score where available.
function familyDeliveryEvents() {
  return `
      SELECT ${tzDate('ede.detected_at')}                                AS d,
             COALESCE(ede.campaign_id, 0)                                AS campaign_id,
             0 AS sequence_id, 0 AS sequence_step_id,
             'email' AS channel,
             COALESCE(ede.sender_account_id, 0)                          AS sender_account_id,
             COALESCE(p.owner_id, 0)                                     AS owner_id,
             ${FIT_BAND_SQL}                                             AS fit_band,
         ${measureCols({
           bounces_hard: `CASE WHEN ede.event_type = 'hard_bounce' THEN 1 ELSE 0 END`,
           bounces_soft: `CASE WHEN ede.event_type = 'soft_bounce' THEN 1 ELSE 0 END`,
           blocks: `CASE WHEN ede.event_type = 'block' THEN 1 ELSE 0 END`,
         })}
        FROM email_delivery_events ede
        LEFT JOIN prospects p ON p.id = ede.prospect_id AND p.org_id = ede.org_id
       WHERE ede.org_id = $1
         AND ede.detected_at >= ($3::date - INTERVAL '2 days')
         AND ede.detected_at <  ($4::date + INTERVAL '3 days')
         AND ${tzDate('ede.detected_at')} BETWEEN $3::date AND $4::date`;
}

// ── core writer ──────────────────────────────────────────────────────────────

/**
 * Recompute the snapshot for an explicit org-local date range [start, end]
 * (YYYY-MM-DD strings, inclusive). DELETE + INSERT in one transaction.
 *
 * @returns {{ rows: number, start: string, end: string }}
 */
async function computeRange(orgId, startDate, endDate, calendarOpt) {
  const cal = calendarOpt || (await getOrgCalendar(orgId));
  const tz = cal.timezone;

  const union = [
    familyStepLogs(),
    familyEnrollments(),
    familyActivities(),
    familyMeetings(),
    familyStageTransitions(),
    familyProspectsAdded(),
    familyDeliveryEvents(),   // Phase 2
  ].join('\n      UNION ALL\n');

  const insertSql = `
    INSERT INTO prospecting_metric_daily
      (org_id, metric_date, campaign_id, sequence_id, sequence_step_id,
       channel, sender_account_id, owner_id, fit_band,
       ${MEASURES.join(', ')})
    SELECT $1, f.d, f.campaign_id, f.sequence_id, f.sequence_step_id,
           f.channel, f.sender_account_id, f.owner_id, f.fit_band,
           ${MEASURES.map((m) => `SUM(f.${m})::int`).join(', ')}
      FROM (
${union}
      ) f
     GROUP BY f.d, f.campaign_id, f.sequence_id, f.sequence_step_id,
              f.channel, f.sender_account_id, f.owner_id, f.fit_band`;

  // withOrgTransaction handles BEGIN/COMMIT/ROLLBACK and sets the org RLS
  // context (config/database.js convention for new code paths).
  const inserted = await db.withOrgTransaction(orgId, async (client) => {
    let rows = 0;
    await client.query(
      `DELETE FROM prospecting_metric_daily
        WHERE org_id = $1 AND metric_date BETWEEN $2::date AND $3::date`,
      [orgId, startDate, endDate]
    );
    const r = await client.query(insertSql, [orgId, tz, startDate, endDate]);
    rows = r.rowCount || 0;

    // tasks_overdue gauge — only when the range includes the current org-local
    // day (D22). Upsert into the existing grain rows where possible; gauge rows
    // have their own slim grain (owner + campaign).
    const today = (await client.query(`SELECT (now() AT TIME ZONE $1::text)::date::text AS d`, [tz])).rows[0].d;
    if (today >= startDate && today <= endDate) {
      const g = await client.query(
        `INSERT INTO prospecting_metric_daily
           (org_id, metric_date, campaign_id, sequence_id, sequence_step_id,
            channel, sender_account_id, owner_id, fit_band, tasks_overdue)
         SELECT $1, $2::date, COALESCE(p.campaign_id, 0), 0, 0, 'none', 0,
                COALESCE(pa.user_id, p.owner_id, 0), 'unknown', COUNT(*)::int
           FROM prospecting_actions pa
           JOIN prospects p ON p.id = pa.prospect_id AND p.org_id = pa.org_id
          WHERE pa.org_id = $1
            AND pa.status IN ('pending','in_progress')
            AND pa.due_date IS NOT NULL
            AND pa.due_date < now()
          GROUP BY COALESCE(p.campaign_id, 0), COALESCE(pa.user_id, p.owner_id, 0)
         ON CONFLICT (org_id, metric_date, campaign_id, sequence_id, sequence_step_id,
                      channel, sender_account_id, owner_id, fit_band)
         DO UPDATE SET tasks_overdue = EXCLUDED.tasks_overdue, computed_at = now()`,
        [orgId, today]
      );
      rows += g.rowCount || 0;
    }

    return rows;
  });

  return { rows: inserted, start: startDate, end: endDate };
}

/**
 * Nightly entry point — recompute trailing RECOMPUTE_DAYS org-local days
 * (inclusive of today). Registered at 03:20 UTC in syncScheduler.js.
 */
async function runNightly(orgId) {
  const startTime = Date.now();
  const cal = await getOrgCalendar(orgId);
  const end = await localToday(cal.timezone);
  const startRow = await db.query(
    `SELECT ($1::date - ($2::int - 1))::text AS d`, [end, RECOMPUTE_DAYS]
  );
  const start = startRow.rows[0].d;

  const result = await computeRange(orgId, start, end, cal);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[MetricSnapshot] org=${orgId} nightly done in ${duration}s — ` +
    `range=${start}..${end} rows=${result.rows} tz=${cal.timezone}`
  );
  return result;
}

/**
 * Backfill from `fromDate` (YYYY-MM-DD, org-local) — or, when omitted, from
 * the org's earliest observable event — through today, in chunks.
 */
async function backfill(orgId, fromDate) {
  const cal = await getOrgCalendar(orgId);
  const end = await localToday(cal.timezone);

  let start = fromDate;
  if (!start) {
    const r = await db.query(
      `SELECT LEAST(
                COALESCE((SELECT MIN(${tzDate('fired_at')})    FROM sequence_step_logs      WHERE org_id = $1), $3::date),
                COALESCE((SELECT MIN(${tzDate('enrolled_at')}) FROM sequence_enrollments    WHERE org_id = $1), $3::date),
                COALESCE((SELECT MIN(${naiveDate('created_at')}) FROM prospecting_activities WHERE org_id = $1), $3::date),
                COALESCE((SELECT MIN(${naiveDate('created_at')}) FROM prospects              WHERE org_id = $1), $3::date)
              )::text AS d`,
      [orgId, cal.timezone, end]
    );
    start = r.rows[0].d;
  }

  console.log(`[MetricSnapshot] org=${orgId} backfill ${start}..${end} (chunks of ${BACKFILL_CHUNK_DAYS}d)`);

  let totalRows = 0;
  let chunkStart = start;
  while (chunkStart <= end) {
    const r = await db.query(
      `SELECT LEAST($1::date + ($2::int - 1), $3::date)::text AS d`,
      [chunkStart, BACKFILL_CHUNK_DAYS, end]
    );
    const chunkEnd = r.rows[0].d;
    const res = await computeRange(orgId, chunkStart, chunkEnd, cal);
    totalRows += res.rows;
    console.log(`[MetricSnapshot] org=${orgId}   chunk ${chunkStart}..${chunkEnd} rows=${res.rows}`);
    const n = await db.query(`SELECT ($1::date + 1)::text AS d`, [chunkEnd]);
    chunkStart = n.rows[0].d;
  }

  console.log(`[MetricSnapshot] org=${orgId} backfill complete — rows=${totalRows}`);
  return { rows: totalRows, start, end };
}

// ── reconciliation (acceptance test) ─────────────────────────────────────────

/**
 * Compare snapshot totals against live aggregates for the trailing `days`
 * org-local days. The live side mirrors the team-overview CTE semantics:
 *   live.sent    = step logs status IN ('sent','completed')   → snapshot (sent - replied_steps)
 *   live.replied = step logs status = 'replied'               → snapshot replied_steps
 *   live.failed  = status = 'failed'                          → snapshot failed
 *   live.enrolled by enrolled_at                              → snapshot enrolled
 *
 * @returns {{ window: string, snapshot: object, live: object, match: boolean }}
 */
async function verify(orgId, days = 30) {
  const cal = await getOrgCalendar(orgId);
  const tz = cal.timezone;
  const end = await localToday(tz);
  const startRow = await db.query(`SELECT ($1::date - ($2::int - 1))::text AS d`, [end, days]);
  const start = startRow.rows[0].d;

  const snapRes = await db.query(
    `SELECT COALESCE(SUM(sent - replied_steps), 0)::int AS sent,
            COALESCE(SUM(replied_steps), 0)::int        AS replied,
            COALESCE(SUM(failed), 0)::int               AS failed,
            COALESCE(SUM(enrolled), 0)::int             AS enrolled
       FROM prospecting_metric_daily
      WHERE org_id = $1 AND metric_date BETWEEN $2::date AND $3::date`,
    [orgId, start, end]
  );

  const liveRes = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM sequence_step_logs ssl
         WHERE ssl.org_id = $1 AND ssl.status IN ('sent','completed')
           AND ${tzDate('ssl.fired_at')} BETWEEN $3::date AND $4::date)::int AS sent,
       (SELECT COUNT(*) FROM sequence_step_logs ssl
         WHERE ssl.org_id = $1 AND ssl.status = 'replied'
           AND ${tzDate('ssl.fired_at')} BETWEEN $3::date AND $4::date)::int AS replied,
       (SELECT COUNT(*) FROM sequence_step_logs ssl
         WHERE ssl.org_id = $1 AND ssl.status = 'failed'
           AND ${tzDate('ssl.fired_at')} BETWEEN $3::date AND $4::date)::int AS failed,
       (SELECT COUNT(*) FROM sequence_enrollments se
         WHERE se.org_id = $1
           AND ${tzDate('se.enrolled_at')} BETWEEN $3::date AND $4::date)::int AS enrolled`,
    [orgId, tz, start, end]
  );

  const snapshot = snapRes.rows[0];
  const live = liveRes.rows[0];
  const match = ['sent', 'replied', 'failed', 'enrolled']
    .every((k) => Number(snapshot[k]) === Number(live[k]));

  return { window: `${start}..${end}`, snapshot, live, match };
}

module.exports = {
  runNightly,
  backfill,
  computeRange,
  verify,
  getOrgCalendar,
  RECOMPUTE_DAYS,
};
