// dailyWorkQuery.service.js
//
// The read path. Kept apart from dailyWork.service.js because that file is
// about invariants and this one is about SQL shapes; mixing them produced the
// six-thousand-line view files elsewhere in this codebase.
//
// ── The rule this whole file exists to obey ──────────────────────────
//
// The person-day view is DERIVED AT READ. Never stored, never cached, never
// materialised. Grouping happens here, in SQL, every time.
//
// The temptation is obvious: the manager screen shows one row per person per
// day, so store one row per person per day. This codebase has already been
// bitten twice by exactly that shortcut — project_play_assignees against
// owner_user_id, playbook_stages against project_stages — where a stored
// summary drifted from the rows it summarised and there were suddenly two
// answers to one question with no way to tell which was right.
//
// It also would not survive the filters. Filter to one account and the day's
// text is a different sentence; a stored rollup can only hold one version.
//
// ── Every date is a string ───────────────────────────────────────────
//
// node-postgres parses DATE at local midnight, so a date read as an object and
// serialised to JSON reports the previous day for any server east of UTC.
// Every date column here is cast ::text in SQL. This is not decoration.
//
// ── Filters read the SNAPSHOT ────────────────────────────────────────
//
// department_team_id, activity_type_key, anchor_* and account_id are filtered
// on daily_work_entries, never joined through to the item or the user. That is
// what makes "what did Marketing do in October" keep answering the same thing
// after someone transfers in November.

const { withOrgTransaction } = require('../config/database');
const hierarchyService = require('./hierarchyService');
const dwDate = require('./dailyWorkDate');

/* ───────────────────────── scope ───────────────────────────────────── */

/**
 * Whose work a manager may read: themselves plus the whole chain beneath them.
 *
 * hierarchyService.getSubordinates already walks direct and indirect reports,
 * follows solid lines only on recursive descent, and UNIONs so a cycle in the
 * hierarchy cannot hang it. There was no reason to write that twice.
 */
async function getVisibleUserIds(orgId, viewerUserId) {
  const subordinates = await hierarchyService.getSubordinates(orgId, viewerUserId);
  return [...new Set([viewerUserId, ...subordinates])];
}

/* ───────────────────────── filters ─────────────────────────────────── */

/**
 * Build the filter clause against the ENTRY's snapshot columns.
 *
 * accountKey is a three-way thing rather than an id, because the account view
 * has three meaningful buckets and only one of them is an account:
 *
 *   <id>         a real account
 *   'internal'   anchored work with no account — internal projects and
 *                campaigns. Anchored, so it is deliberate.
 *   'none'       no anchor at all. Not internal: unattributed. This is a
 *                data-quality signal and must stay distinguishable.
 */
function buildFilters(filters = {}, params) {
  const clauses = [];

  if (filters.accountKey === 'internal') {
    clauses.push(`e.account_id IS NULL AND e.anchor_kind IS NOT NULL`);
  } else if (filters.accountKey === 'none') {
    clauses.push(`e.anchor_kind IS NULL`);
  } else if (filters.accountKey) {
    params.push(Number(filters.accountKey));
    clauses.push(`e.account_id = $${params.length}`);
  }

  if (filters.anchorKind && filters.anchorId) {
    params.push(filters.anchorKind, Number(filters.anchorId));
    clauses.push(`e.anchor_kind = $${params.length - 1} AND e.anchor_id = $${params.length}`);
  }

  if (filters.activityKey) {
    params.push(filters.activityKey);
    clauses.push(`e.activity_type_key = $${params.length}`);
  }

  if (filters.departmentTeamId) {
    params.push(Number(filters.departmentTeamId));
    clauses.push(`e.department_team_id = $${params.length}`);
  }

  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}

/* ───────────────────────── the log ─────────────────────────────────── */

/**
 * One row per person per day, with the day's descriptions concatenated.
 *
 * ORDER BY i.created_at inside string_agg is load-bearing. Ordering by entry id
 * would reshuffle a person's day whenever they edited one row, so yesterday's
 * summary would read differently today without anything having changed. Item
 * creation order is stable for the life of the item.
 *
 * item_count and the arrays come back alongside the text so the caller can
 * render "3 items · 2 accounts" without a second query, and can expand to the
 * parts without re-deriving anything.
 */
async function getLog(orgId, { userIds, from, to, filters = {}, limit = 500 }) {
  if (!userIds || userIds.length === 0) return [];

  return withOrgTransaction(orgId, async (client) => {
    const params = [orgId, userIds, from, to];
    const filterSql = buildFilters(filters, params);
    params.push(limit);

    const { rows } = await client.query(
      `SELECT e.user_id,
              e.entry_date::text AS entry_date,
              u.first_name, u.last_name,
              count(*)::int      AS item_count,
              string_agg(e.description, ' ' ORDER BY i.created_at, i.id) AS work_done,
              array_agg(DISTINCT e.day_stage)                            AS stages,
              array_remove(array_agg(DISTINCT e.account_id), NULL)       AS account_ids,
              array_remove(array_agg(DISTINCT e.activity_type_key), NULL) AS activity_keys,
              sum(CASE WHEN pe.n IS NULL THEN 0 ELSE pe.n END)::int      AS evidence_count
         FROM daily_work_entries e
         JOIN daily_work_items i ON i.id = e.item_id AND i.org_id = e.org_id
         JOIN users u            ON u.id = e.user_id
         LEFT JOIN LATERAL (
                SELECT count(*)::int AS n FROM play_evidence pv
                 WHERE pv.daily_work_entry_id = e.id
              ) pe ON TRUE
        WHERE e.org_id = $1
          AND e.user_id = ANY($2)
          AND e.entry_date BETWEEN $3 AND $4
          ${filterSql}
        GROUP BY e.user_id, e.entry_date, u.first_name, u.last_name
        ORDER BY e.entry_date DESC, u.first_name, u.last_name
        LIMIT $${params.length}`,
      params);

    return rows;
  });
}

/**
 * The items behind one person-day, for when the reader expands a row.
 *
 * Separate query rather than always fetching the parts: the log is the common
 * read and most rows are never expanded. Fetching every item for every day to
 * satisfy the few that are opened is how a screen that feels fine at ten
 * people stops being usable at a hundred.
 */
async function getDayDetail(orgId, userId, entryDate, filters = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const params = [orgId, userId, entryDate];
    const filterSql = buildFilters(filters, params);

    const { rows } = await client.query(
      `SELECT e.id AS entry_id, e.description, e.next_steps, e.day_stage,
              e.is_continuation, e.activity_type_key,
              e.anchor_kind, e.anchor_id, e.account_id,
              i.id AS item_id, i.title, i.kind, i.status,
              i.target_date::text AS target_date, i.assigned_by,
              a.name AS account_name,
              (SELECT count(*)::int FROM play_evidence pv
                WHERE pv.daily_work_entry_id = e.id) AS evidence_count
         FROM daily_work_entries e
         JOIN daily_work_items i ON i.id = e.item_id AND i.org_id = e.org_id
         LEFT JOIN accounts a    ON a.id = e.account_id AND a.org_id = e.org_id
        WHERE e.org_id = $1 AND e.user_id = $2 AND e.entry_date = $3
          ${filterSql}
        ORDER BY i.created_at, i.id`,
      params);

    return rows;
  });
}

/* ───────────────────────── the denominator ─────────────────────────── */

/**
 * Load what each person's working days are made of.
 *
 * Schedules are effective-dated, so the row that applies is the latest one
 * whose effective_from is on or before the day in question. DISTINCT ON does
 * that in one pass. Someone who moved to a four-day week in June must have
 * their May days counted against the old mask.
 *
 * A person with no schedule row gets Mon-Fri and no holidays, rather than an
 * error or a zero denominator. Missing configuration should degrade to a
 * sensible default, not to a wrong number or a blocked screen.
 */
async function loadCalendars(client, orgId, userIds, from, to) {
  const { rows: schedules } = await client.query(
    `SELECT DISTINCT ON (user_id)
            user_id, weekday_mask, holiday_calendar_id
       FROM daily_work_schedules
      WHERE org_id = $1 AND user_id = ANY($2) AND effective_from <= $3
      ORDER BY user_id, effective_from DESC`,
    [orgId, userIds, to]);

  const byUser = new Map(schedules.map(s => [s.user_id, s]));

  const calendarIds = [...new Set(schedules.map(s => s.holiday_calendar_id).filter(Boolean))];
  const holidaysByCalendar = new Map();
  if (calendarIds.length) {
    const { rows } = await client.query(
      `SELECT calendar_id, holiday_date::text AS holiday_date
         FROM holiday_calendar_dates
        WHERE org_id = $1 AND calendar_id = ANY($2)
          AND holiday_date BETWEEN $3 AND $4`,
      [orgId, calendarIds, from, to]);
    rows.forEach(r => {
      if (!holidaysByCalendar.has(r.calendar_id)) holidaysByCalendar.set(r.calendar_id, new Set());
      holidaysByCalendar.get(r.calendar_id).add(r.holiday_date);
    });
  }

  // Approved leave only. A pending request should not quietly shrink someone's
  // denominator and flatter their rate before anyone has agreed to it.
  const { rows: exceptions } = await client.query(
    `SELECT user_id, exception_date::text AS exception_date
       FROM daily_work_exceptions
      WHERE org_id = $1 AND user_id = ANY($2)
        AND exception_date BETWEEN $3 AND $4
        AND approved_at IS NOT NULL`,
    [orgId, userIds, from, to]);

  const exceptionsByUser = new Map();
  exceptions.forEach(e => {
    if (!exceptionsByUser.has(e.user_id)) exceptionsByUser.set(e.user_id, new Set());
    exceptionsByUser.get(e.user_id).add(e.exception_date);
  });

  const out = new Map();
  for (const userId of userIds) {
    const sched = byUser.get(userId);
    out.set(userId, {
      weekdayMask: sched ? sched.weekday_mask : 31,
      holidays: (sched && holidaysByCalendar.get(sched.holiday_calendar_id)) || new Set(),
      exceptions: exceptionsByUser.get(userId) || new Set(),
      hasSchedule: !!sched,
    });
  }
  return out;
}

/**
 * One row per person for a whole period — what keeps a fifteen-person team to
 * fifteen rows whether the period is a day or a month.
 *
 * The rate is computed in dailyWorkDate, not here and not in SQL, so the
 * reminder, the member's own chip and this screen cannot disagree about what a
 * working day is.
 *
 * days is returned as a per-date map so the caller can draw the strip of
 * logged/not-logged squares without another round trip.
 */
async function getRollup(orgId, { userIds, from, to, filters = {} }) {
  if (!userIds || userIds.length === 0) return [];

  return withOrgTransaction(orgId, async (client) => {
    const params = [orgId, userIds, from, to];
    const filterSql = buildFilters(filters, params);

    const { rows } = await client.query(
      `SELECT e.user_id,
              u.first_name, u.last_name,
              array_agg(DISTINCT e.entry_date::text)                      AS logged_dates,
              count(*)::int                                               AS entry_count,
              array_remove(array_agg(DISTINCT e.account_id), NULL)        AS account_ids,
              array_remove(array_agg(DISTINCT e.activity_type_key), NULL) AS activity_keys
         FROM daily_work_entries e
         JOIN users u ON u.id = e.user_id
        WHERE e.org_id = $1
          AND e.user_id = ANY($2)
          AND e.entry_date BETWEEN $3 AND $4
          ${filterSql}
        GROUP BY e.user_id, u.first_name, u.last_name`,
      params);

    const byUser = new Map(rows.map(r => [r.user_id, r]));

    // Names come from a SEPARATE query over the requested ids, not from the
    // entries join. The entries join only knows about people who logged
    // something, so on a day nobody has logged — which is every day before the
    // pilot starts — the whole team rendered as "Unknown". The absence of a
    // row is exactly the case this screen exists to show, so the names have to
    // come from somewhere that does not depend on there being entries.
    const { rows: names } = await client.query(
      `SELECT id, first_name, last_name FROM users WHERE id = ANY($1)`, [userIds]);
    const nameById = new Map(names.map(n => [n.id, n]));

    const calendars = await loadCalendars(client, orgId, userIds, from, to);

    return userIds.map(userId => {
      const row = byUser.get(userId) || {};
      const cal = calendars.get(userId);
      const workingDates = dwDate.workingDays(from, to, cal);
      const logged = row.logged_dates || [];
      const rate = dwDate.loggingRate(logged, workingDates);

      const who = nameById.get(userId) || {};
      return {
        user_id: userId,
        first_name: who.first_name || null,
        last_name: who.last_name || null,
        entry_count: row.entry_count || 0,
        account_ids: row.account_ids || [],
        activity_keys: row.activity_keys || [],
        logged_dates: logged,
        working_dates: workingDates,
        // The strip the manager reads at a glance, in date order.
        days: workingDates.map(d => ({ date: d, logged: logged.includes(d) })),
        days_logged: rate.logged,
        working_days: rate.working,
        // null, never 0, when the whole period was holiday — see
        // dailyWorkDate.loggingRate. Zero would read as a failure nobody made.
        rate: rate.rate,
        has_schedule: cal.hasSchedule,
      };
    });
  });
}

/* ───────────────────────── the account view ────────────────────────── */

/**
 * What has been delivered to one account, and by whom.
 *
 * Reads e.account_id — the snapshot — so a project that moved to another
 * customer last month does not drag its history across with it.
 */
async function getAccountSummary(orgId, { accountKey, userIds, from, to }) {
  if (!userIds || userIds.length === 0) return { totals: {}, byPerson: [], byActivity: [] };

  return withOrgTransaction(orgId, async (client) => {
    const params = [orgId, userIds, from, to];
    const filterSql = buildFilters({ accountKey }, params);

    const { rows: byPerson } = await client.query(
      `SELECT e.user_id, u.first_name, u.last_name,
              count(*)::int AS entries,
              count(DISTINCT e.entry_date)::int AS days
         FROM daily_work_entries e
         JOIN users u ON u.id = e.user_id
        WHERE e.org_id = $1 AND e.user_id = ANY($2)
          AND e.entry_date BETWEEN $3 AND $4
          ${filterSql}
        GROUP BY e.user_id, u.first_name, u.last_name
        ORDER BY entries DESC`,
      params);

    const params2 = [orgId, userIds, from, to];
    const filterSql2 = buildFilters({ accountKey }, params2);

    const { rows: byActivity } = await client.query(
      `SELECT coalesce(e.activity_type_key, 'unspecified') AS activity_key,
              count(*)::int AS entries
         FROM daily_work_entries e
        WHERE e.org_id = $1 AND e.user_id = ANY($2)
          AND e.entry_date BETWEEN $3 AND $4
          ${filterSql2}
        GROUP BY 1
        ORDER BY entries DESC`,
      params2);

    return {
      totals: {
        entries: byPerson.reduce((n, r) => n + r.entries, 0),
        people: byPerson.length,
      },
      byPerson,
      byActivity,
    };
  });
}

/* ───────────────────────── the manager's queue ─────────────────────── */

/**
 * Assigned work with no movement.
 *
 * Scoped to assigned items only, deliberately. Recurring work never completes,
 * so "stale" over it means nothing — every recurring item is permanently
 * unfinished and would sit in this list forever.
 *
 * Staleness is measured from the last ENTRY, not from the item's updated_at.
 * updated_at moves when a title is edited; the question here is whether anyone
 * has done any work.
 */
async function getStalledAssigned(orgId, { userIds, asOfDate, staleDays = 3 }) {
  if (!userIds || userIds.length === 0) return [];

  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT i.id AS item_id, i.title, i.owner_user_id, i.status,
              i.target_date::text AS target_date,
              i.assigned_by, i.opened_on::text AS opened_on,
              u.first_name, u.last_name,
              last_entry.entry_date::text AS last_entry_date,
              ($3::date - coalesce(last_entry.entry_date, i.opened_on))::int AS days_quiet
         FROM daily_work_items i
         JOIN users u ON u.id = i.owner_user_id
         LEFT JOIN LATERAL (
                SELECT max(e.entry_date) AS entry_date
                  FROM daily_work_entries e
                 WHERE e.item_id = i.id AND e.org_id = i.org_id
              ) last_entry ON TRUE
        WHERE i.org_id = $1
          AND i.owner_user_id = ANY($2)
          AND i.kind = 'assigned'
          AND i.status IN ('yet_to_start','in_progress','in_review')
          AND ($3::date - coalesce(last_entry.entry_date, i.opened_on)) >= $4
        ORDER BY days_quiet DESC, i.target_date NULLS LAST`,
      [orgId, userIds, asOfDate, staleDays]);

    return rows;
  });
}

/**
 * Activity types someone proposed by picking "Other" and naming it.
 *
 * Derived from daily_activity_types.status, NOT stored as work items. A review
 * queue is not a day's work: making it one would mean logging work about
 * logging work, and it would inflate days-logged for whoever happened to have
 * admin chores that day.
 */
async function getCandidateActivityTypes(orgId) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT t.id, t.key, t.label, t.created_by, t.created_at,
              u.first_name, u.last_name,
              (SELECT count(*)::int FROM daily_work_entries e
                WHERE e.org_id = t.org_id AND e.activity_type_key = t.key) AS uses
         FROM daily_activity_types t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.org_id = $1 AND t.status = 'candidate'
        ORDER BY t.created_at`,
      [orgId]);

    return rows;
  });
}

module.exports = {
  getVisibleUserIds,
  getLog,
  getDayDetail,
  getRollup,
  getAccountSummary,
  getStalledAssigned,
  getCandidateActivityTypes,
  loadCalendars,
  buildFilters,
};
