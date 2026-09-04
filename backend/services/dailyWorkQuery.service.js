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
              -- LABELS, resolved here rather than in the client.
              --
              -- The row already carried activity_type_key and anchor_kind/id,
              -- which are the SNAPSHOT — correct, and unreadable. Turning them
              -- into words client-side needs the activity list and the anchor
              -- list both loaded, and DailyWorkView only fetches anchors in edit
              -- mode, so the day log had the keys and no way to render them.
              --
              -- Read live, not snapshotted, and deliberately: a renamed
              -- initiative should read under its current name everywhere, which
              -- is the same rule the anchor picker already follows. The key
              -- stays the thing of record; this is only how it is shown.
              at.label AS activity_label,
              CASE e.anchor_kind
                WHEN 'handover' THEN h.name
                WHEN 'account'  THEN aa.name
                WHEN 'campaign' THEN pc.name
              END AS anchor_label,
              (SELECT count(*)::int FROM play_evidence pv
                WHERE pv.daily_work_entry_id = e.id) AS evidence_count
         FROM daily_work_entries e
         JOIN daily_work_items i ON i.id = e.item_id AND i.org_id = e.org_id
         LEFT JOIN accounts a    ON a.id = e.account_id AND a.org_id = e.org_id
         -- Each join is guarded by anchor_kind as well as the id, so an id that
         -- happens to exist in another table cannot supply a name for the wrong
         -- kind of anchor.
         LEFT JOIN daily_activity_types at
                ON at.org_id = e.org_id AND at.key = e.activity_type_key
         LEFT JOIN sales_handovers h
                ON e.anchor_kind = 'handover' AND h.id = e.anchor_id AND h.org_id = e.org_id
         LEFT JOIN accounts aa
                ON e.anchor_kind = 'account'  AND aa.id = e.anchor_id AND aa.org_id = e.org_id
         LEFT JOIN prospecting_campaigns pc
                ON e.anchor_kind = 'campaign' AND pc.id = e.anchor_id AND pc.org_id = e.org_id
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
/**
 * @param {boolean} [opts.slim=false]  2026_140. Return only the counted fields.
 *
 * WHY slim EXISTS. GET /people calls this TWICE — once for the window on
 * screen, and once for a trailing 28 days to answer "are they keeping up
 * generally". The second call built the full payload for every person: the
 * per-day strip, the logged and working date arrays, the account ids, the
 * activity keys — 28 days of it — and the route then read exactly TWO integers
 * off each row and threw the rest away.
 *
 * On a 40-person team that is 40 x 28 day objects plus four arrays per person,
 * serialised, sent over the wire and discarded by the client. slim skips the
 * per-day construction and the array aggregation entirely.
 *
 * The counts are unaffected: days_logged, working_days and rate come from
 * dwDate.loggingRate over the same inputs either way, so the trailing figures
 * are identical to what they were.
 */
async function getRollup(orgId, { userIds, from, to, filters = {}, slim = false }) {
  if (!userIds || userIds.length === 0) return [];

  return withOrgTransaction(orgId, async (client) => {
    const params = [orgId, userIds, from, to];
    const filterSql = buildFilters(filters, params);

    const { rows } = await client.query(
      `SELECT e.user_id,
              u.first_name, u.last_name,
              array_agg(DISTINCT e.entry_date::text)                      AS logged_dates,
              count(*)::int                                               AS entry_count,
              -- 2026_140. Both arrays are aggregated only when they will be
              -- read. logged_dates is NOT optional — loggingRate needs it even
              -- in slim mode, which is why it stays unconditional.
              ${slim ? `'{}'::int[]  AS account_ids` : `array_remove(array_agg(DISTINCT e.account_id), NULL)        AS account_ids`},
              ${slim ? `'{}'::text[] AS activity_keys` : `array_remove(array_agg(DISTINCT e.activity_type_key), NULL) AS activity_keys`}
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
      if (slim) {
        // Exactly what the trailing caller reads, and nothing else. Returning a
        // narrower shape rather than the full one with empty arrays is
        // deliberate: an empty `days` would render as a strip with no squares
        // if this row ever reached the UI, which is a plausible-looking lie.
        // An absent key is not.
        return {
          user_id: userId,
          days_logged: rate.logged,
          working_days: rate.working,
          rate: rate.rate,
          has_schedule: cal.hasSchedule,
        };
      }
      return {
        user_id: userId,
        first_name: who.first_name || null,
        last_name: who.last_name || null,
        entry_count: row.entry_count || 0,
        // 2026_140. The COUNT, not the ids. DailyWorkTeamView reads only
        // `.length` off this — "3 accounts" under the entry count — and an
        // active rep's id array is far larger than the one number drawn from
        // it. The ids are still aggregated above for any caller that wants
        // them; this is about what crosses the wire by default.
        account_count: (row.account_ids || []).length,
        account_ids: row.account_ids || [],
        activity_keys: row.activity_keys || [],
        // The strip the manager reads at a glance, in date order.
        //
        // logged_dates and working_dates are NOT returned any more. `days`
        // encodes both — every working date is a key, and `logged` is
        // membership of the other array — so sending all three was the same
        // information three times, and nothing in the frontend read either of
        // the two that are gone.
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

/**
 * Each person's department, for the People screen.
 *
 * A separate lookup rather than a join inside getRollup: the rollup filters on
 * the ENTRY's snapshotted department_team_id, which is deliberately the team
 * someone was in when they logged. This is the opposite — who they are NOW,
 * which is what belongs beside their name. Joining them would quietly conflate
 * the two, and the snapshot rule exists precisely so October keeps answering
 * the same thing after someone transfers in November.
 *
 * Primary membership only, and only teams on an 'internal' dimension, matching
 * what listDepartments offers as a filter.
 */
async function getDepartmentsByUser(orgId, userIds) {
  const out = new Map();
  if (!userIds || userIds.length === 0) return out;

  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT DISTINCT ON (tm.user_id) tm.user_id, t.name
         FROM team_memberships tm
         JOIN teams t ON t.id = tm.team_id AND t.org_id = tm.org_id
         JOIN team_dimensions td ON td.key = t.dimension AND td.org_id = t.org_id
                                AND td.applies_to = 'internal'
        WHERE tm.org_id = $1 AND tm.user_id = ANY($2) AND t.is_active = TRUE
        ORDER BY tm.user_id, tm.is_primary DESC NULLS LAST, t.name`,
      [orgId, userIds]);
    for (const r of rows) out.set(r.user_id, r.name);
    return out;
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

/**
 * The daily work somebody logged AGAINST their project tasks.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * daily_work_items.play_instance_id has existed since 2026_136 — an item can be
 * filed against a specific checklist task — and NOTHING has ever read it back.
 * Every query in this file selects around it. So the link was being written and
 * was unreadable, which meant a manager looking at somebody's overdue task
 * could see that it was late and had no way to see what the person had actually
 * been doing about it. That is the single most useful thing on the screen and
 * it was one column away.
 *
 * ── SHAPE: ALL TASKS AT ONCE, KEYED BY TASK ─────────────────────────────────
 *
 * One call per person, not one per task. The person page renders a table of
 * their open work and needs a count on every row — fetching per row is N
 * requests to render one screen, and the counts would pop in one at a time.
 *
 * ── NOT WINDOW-BOUNDED, DELIBERATELY ────────────────────────────────────────
 *
 * Every other read here is bounded by the from/to the screen is showing. This
 * one is not, because the task table it feeds is not either: a task that has
 * been open for six weeks shows on the list regardless of the period, and its
 * updates are the history of that task rather than of this week. Bounding them
 * to the visible window would show "Updates (0)" on a task somebody worked on
 * heavily a fortnight ago — a confident and wrong answer.
 *
 * Capped per task instead. PER_TASK_CAP is applied in JS after ordering, not as
 * a SQL LIMIT, because one LIMIT across the whole result would silently starve
 * the last tasks in the list while the first ones showed everything.
 */
const TASK_UPDATE_CAP = 20;

async function getTaskUpdates(orgId, userId, playInstanceIds = []) {
  const ids = [...new Set((playInstanceIds || [])
    .map(n => parseInt(n, 10)).filter(Number.isInteger))];
  if (!ids.length) return {};

  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT i.play_instance_id,
              e.entry_date::text AS entry_date,
              e.description,
              e.id AS entry_id
         FROM daily_work_entries e
         JOIN daily_work_items i ON i.id = e.item_id AND i.org_id = e.org_id
        WHERE e.org_id = $1
          AND i.owner_user_id = $2
          AND i.play_instance_id = ANY($3::int[])
        ORDER BY i.play_instance_id, e.entry_date DESC, e.id DESC`,
      [orgId, userId, ids]);

    const byTask = {};
    for (const r of rows) {
      const key = String(r.play_instance_id);
      if (!byTask[key]) byTask[key] = { updates: [], total: 0 };
      byTask[key].total += 1;
      // The cap trims what is SENT, never what is COUNTED. A row reading
      // "Updates (34)" that opens onto twenty is honest; a row reading
      // "Updates (20)" when there are thirty-four is not.
      if (byTask[key].updates.length < TASK_UPDATE_CAP) {
        byTask[key].updates.push({
          entryId: r.entry_id, date: r.entry_date, description: r.description,
        });
      }
    }
    return byTask;
  });
}

/**
 * Ad-hoc work ASSIGNED to someone, as items rather than as logged entries.
 *
 * ── THE GAP THIS FILLS ──────────────────────────────────────────────────────
 *
 * daily_work_items.kind is 'recurring' or 'assigned'. An assigned item is real
 * open work — it has a target_date, an assigned_by, and a status running
 * yet_to_start → in_progress → in_review → completed/dropped.
 *
 * Nothing showed it. The person page listed ENTRIES, which are work that was
 * LOGGED — so an item nobody has touched yet has no entry and was invisible.
 * The only surface anywhere was the stalled queue on the People list, and only
 * once an item had been quiet for three days.
 *
 * The failure mode was the bad kind: somebody with six things assigned and none
 * started rendered as "1 of 1 days logged · 100%" and nothing else. The page
 * looked like a clean bill of health precisely when it should not have.
 *
 * ── WINDOWED ON target_date, NOT ON opened_on ───────────────────────────────
 *
 * The question is "what is due in this period", not "what was created in it".
 * Items with NO target date are always returned: they are open work with no
 * deadline, and a date filter that silently drops undated work is the same
 * mistake in a smaller box.
 *
 * @param {boolean} [includeClosed=false] also return completed and dropped.
 *   'dropped' rides with 'completed' deliberately — a manager asking to see
 *   everything submitted wants to know what was abandoned too, and hiding it
 *   makes a dropped item indistinguishable from one that never existed.
 */
async function getAssignedItems(orgId, userId, { from, to, includeClosed = false } = {}) {
  return withOrgTransaction(orgId, async (client) => {
    const { rows } = await client.query(
      `SELECT i.id AS item_id, i.title, i.status,
              i.target_date::text AS target_date,
              i.opened_on::text   AS opened_on,
              i.play_instance_id,
              i.activity_type_key,
              i.account_id,
              a.name AS account_name,
              ab.first_name || ' ' || ab.last_name AS assigned_by_name,
              last_entry.entry_date::text AS last_entry_date,
              coalesce(entry_count.n, 0)::int AS entry_count
         FROM daily_work_items i
         LEFT JOIN accounts a  ON a.id = i.account_id AND a.org_id = i.org_id
         LEFT JOIN users    ab ON ab.id = i.assigned_by
         LEFT JOIN LATERAL (
                SELECT max(e.entry_date) AS entry_date
                  FROM daily_work_entries e
                 WHERE e.item_id = i.id AND e.org_id = i.org_id
              ) last_entry ON TRUE
         LEFT JOIN LATERAL (
                SELECT count(*)::int AS n
                  FROM daily_work_entries e
                 WHERE e.item_id = i.id AND e.org_id = i.org_id
              ) entry_count ON TRUE
        WHERE i.org_id = $1
          AND i.owner_user_id = $2
          AND i.kind = 'assigned'
          AND ($5::boolean IS TRUE
               OR i.status IN ('yet_to_start', 'in_progress', 'in_review'))
          -- Forward horizon, not a band — same correction as the project side.
          -- Undated and OVERDUE assigned work always comes back; the window
          -- only decides how far ahead to look. Filtering overdue items out of
          -- a "next 7 days" view hides the ones somebody is already late on.
          AND (i.target_date IS NULL
               OR $3::date IS NULL
               OR i.target_date BETWEEN $3::date AND $4::date
               OR i.target_date < CURRENT_DATE)
        ORDER BY (i.target_date IS NULL), i.target_date, i.id`,
      [orgId, userId, from || null, to || null, includeClosed]);

    return rows.map(r => ({
      id: `item-${r.item_id}`,
      itemId: r.item_id,
      title: r.title,
      status: r.status,
      targetDate: r.target_date,
      openedOn: r.opened_on,
      // Set only on an item filed against a project task — chk_dwi_linked_is_assigned
      // restricts play_instance_id to kind='assigned', so this is the ONLY
      // place the link can appear. The two are not separate kinds of work.
      playInstanceId: r.play_instance_id,
      account: r.account_name,
      assignedByName: r.assigned_by_name,
      lastEntryDate: r.last_entry_date,
      entryCount: r.entry_count,
      isOpen: ['yet_to_start', 'in_progress', 'in_review'].includes(r.status),
    }));
  });
}

/**
 * How many OPEN assigned items fall outside the window being shown.
 *
 * So the table can say "8 more outside this period" rather than silently
 * omitting them. A filter that hides open work with no trace is how somebody
 * concludes a person has nothing on.
 */
async function countAssignedOutside(orgId, userId, { from, to } = {}) {
  if (!from || !to) return 0;
  return withOrgTransaction(orgId, async (client) => {
    const { rows: [r] } = await client.query(
      `SELECT count(*)::int AS n
         FROM daily_work_items i
        WHERE i.org_id = $1 AND i.owner_user_id = $2
          AND i.kind = 'assigned'
          AND i.status IN ('yet_to_start', 'in_progress', 'in_review')
          AND i.target_date IS NOT NULL
          -- After the window only. Overdue items are shown now, so counting
          -- them as hidden would contradict the table above the line.
          AND i.target_date > $4::date`,
      [orgId, userId, from, to]);
    return r?.n || 0;
  });
}

module.exports = {
  getVisibleUserIds,
  getTaskUpdates,
  getAssignedItems,
  countAssignedOutside,
  getLog,
  getDepartmentsByUser,
  getDayDetail,
  getRollup,
  getAccountSummary,
  getStalledAssigned,
  getCandidateActivityTypes,
  loadCalendars,
  buildFilters,
};
