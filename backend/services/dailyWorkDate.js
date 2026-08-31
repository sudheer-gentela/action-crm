// dailyWorkDate.js
//
// The one place a local date is decided.
//
// entry_date is the OWNER's local date, not the server's and not the
// browser's. Three things must agree on it or the module quietly lies:
//
//   the reminder    — "it is 18:00 where this person is, nudge them"
//   the today view  — "these are today's rows"
//   every metric    — "distinct entry_date / working days"
//
// If the reminder and the metric disagree by one day, someone is nudged for a
// day the metric has already counted, or a day they logged is scored as a
// miss. Nothing errors. The number is just wrong, and it is wrong in a way
// that only shows up for people who work late, or travel, or live somewhere
// the server does not.
//
// So: one module, no second implementation, no inline `new Date()` anywhere in
// the daily work code. If something here is wrong it is wrong everywhere at
// once, which is far easier to find than three functions that disagree.
//
// ── Why no date library ──────────────────────────────────────────────
//
// Node ships full ICU, so Intl.DateTimeFormat resolves real IANA zones
// including DST. luxon or date-fns-tz would add a dependency to do what the
// platform already does correctly.
//
// ── Why no arithmetic on Date objects ────────────────────────────────
//
// Every function here either formats an instant into a local calendar date, or
// walks calendar dates as 'YYYY-MM-DD' strings. It never adds 24 hours to a
// timestamp. Adding a day to an instant is wrong twice a year in any zone with
// DST — the day that is 23 or 25 hours long lands on the wrong date.

const UTC = 'UTC';

/** Cache of validated zones. Intl construction is not free and the reminder
 *  formats once per user per hour. */
const validZones = new Map();

function isValidZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  if (validZones.has(tz)) return validZones.get(tz);
  let ok = true;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); }
  catch { ok = false; }
  validZones.set(tz, ok);
  return ok;
}

/**
 * Resolve which timezone an entry belongs to.
 *
 *   users.timezone
 *     -> organizations.settings->'calendar'->>'timezone'
 *       -> UTC
 *
 * users.timezone must be MANAGER-SET. auth.routes.js currently writes it
 * opportunistically from the browser at login when it is NULL, which for a
 * compliance metric is wrong: someone opening the app abroad would silently
 * move their own day boundary, and with it their rate. Removing that write is
 * a separate change; until then, treat any value here as suspect if it
 * disagrees with the org.
 *
 * An invalid or unknown zone falls through rather than throwing. A person with
 * a typo in their timezone should be scored against the org calendar, not
 * crash the reminder for everyone in that org.
 *
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} query
 *        Pass the org-scoped query function, so this works unchanged if RLS is
 *        enabled later.
 */
async function resolveTimezone(query, orgId, userId) {
  const { rows } = await query(
    `SELECT u.timezone AS user_tz,
            o.settings->'calendar'->>'timezone' AS org_tz
       FROM users u
       JOIN organizations o ON o.id = $1
      WHERE u.id = $2`,
    [orgId, userId]
  );

  const row = rows[0] || {};
  if (isValidZone(row.user_tz)) return row.user_tz;
  if (isValidZone(row.org_tz)) return row.org_tz;
  return UTC;
}

/**
 * The local calendar date of an instant, as 'YYYY-MM-DD'.
 *
 * en-CA is not chosen for aesthetics — it formats as YYYY-MM-DD. Parts are
 * assembled by hand anyway rather than trusting the joined string, because a
 * locale change would silently reorder it.
 */
function localDate(tz, at = new Date()) {
  const zone = isValidZone(tz) ? tz : UTC;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);

  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The local hour of an instant, 0-23.
 *
 * This is what the reminder self-filters on. Following the prospecting digest
 * pattern, the cron runs hourly and each row asks "is it my hour where I am"
 * rather than anything scheduling per-timezone.
 *
 * hourCycle h23 matters: the default for some locales renders midnight as 24,
 * which compares wrong against a stored 0.
 */
function localHour(tz, at = new Date()) {
  const zone = isValidZone(tz) ? tz : UTC;
  const hour = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).find(p => p.type === 'hour').value;
  return Number(hour);
}

/**
 * ISO weekday index for a 'YYYY-MM-DD' string, Monday = 0 ... Sunday = 6.
 *
 * Matches weekday_mask bit order from 2026_131: bit 0 is Monday, so Mon-Fri is
 * 31. Built through Date.UTC so no timezone can shift it — the input is
 * already a calendar date, not an instant.
 */
function weekdayIndex(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sunday
  return (dow + 6) % 7;                                       // 0 = Monday
}

/** Does this date fall on a day the person is scheduled to work? */
function isScheduledDay(dateStr, weekdayMask) {
  return (weekdayMask & (1 << weekdayIndex(dateStr))) !== 0;
}

/**
 * Walk calendar dates inclusively as strings.
 *
 * Stepping through Date.UTC at midnight is safe because these are calendar
 * dates with no zone attached — the DST trap only exists when adding hours to
 * a real instant.
 */
function eachDate(fromStr, toStr) {
  const out = [];
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const end = Date.UTC(ty, tm - 1, td);
  let cur = Date.UTC(fy, fm - 1, fd);
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
  }
  return out;
}

/**
 * Shift a 'YYYY-MM-DD' by n days, returning a string.
 *
 * UTC arithmetic on the parts, exactly as eachDate does above, never
 * `new Date(str)` plus setDate. A date built from a bare 'YYYY-MM-DD' is UTC
 * midnight, and reading it back through local getters west of UTC hands you
 * the previous day — the same trap this module's header is about.
 */
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * The metric's denominator.
 *
 * A day counts when the schedule says the person works it, the holiday
 * calendar does not blank it, and there is no personal exception (leave).
 *
 * Deliberately pure: holidays and exceptions arrive as Sets of date strings,
 * loaded by the caller. That keeps every branch of the calendar logic testable
 * without a database, which is why the tests for this run in milliseconds and
 * cover DST, month ends and leap years rather than one happy path.
 *
 * An org with no calendar configured yields every scheduled weekday. That is
 * deliberate: a new customer gets a working, slightly pessimistic rate on day
 * one instead of a blocked screen.
 */
function workingDays(fromStr, toStr, { weekdayMask, holidays = new Set(), exceptions = new Set() }) {
  return eachDate(fromStr, toStr).filter(d =>
    isScheduledDay(d, weekdayMask) && !holidays.has(d) && !exceptions.has(d)
  );
}

/**
 * distinct entry_date / working days, as a fraction and a pair of counts.
 *
 * Days logged are intersected with the working days rather than counted
 * directly. Someone who logs on a Saturday should not score 6/5 — the extra
 * day is real work, and it is visible in the log, but it is not evidence about
 * a weekday they missed.
 *
 * A zero denominator returns null, not 0 and not NaN. Someone whose whole
 * range was holiday has no rate; showing 0% would read as a failure they did
 * not commit.
 */
function loggingRate(loggedDates, workingDateList) {
  const working = new Set(workingDateList);
  const hits = [...new Set(loggedDates)].filter(d => working.has(d));
  if (working.size === 0) return { logged: hits.length, working: 0, rate: null };
  return { logged: hits.length, working: working.size, rate: hits.length / working.size };
}

module.exports = {
  resolveTimezone,
  localDate,
  localHour,
  weekdayIndex,
  isScheduledDay,
  eachDate,
  addDays,
  workingDays,
  loggingRate,
  isValidZone,
  UTC,
};
