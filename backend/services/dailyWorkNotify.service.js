// dailyWorkNotify.service.js
//
// Phase 6. Two notifications, both fired hourly and both self-filtering.
//
//   REMINDER   to a member, at their own local hour, on a day they were
//              expected to log and have not.
//   ROLLUP     to a manager, at their local hour, summarising who logged.
//
// ── Why hourly with self-filtering, not a cron per timezone ──────────
//
// Copied from the prospecting digest (`cron.schedule('5 * * * *')`), where each
// org compares its own `digest_hour_utc` to the current UTC hour. The daily work
// version pushes that down a level: each PERSON compares their own local hour,
// resolved through dailyWorkDate from users.timezone. One schedule, any number
// of timezones, no new scheduler.
//
// ── What this must never do ──────────────────────────────────────────
//
// NAG. Every guard below exists to stop the reminder becoming noise:
//
//   - never on a day the person is not scheduled to work
//   - never on a holiday or approved leave
//   - never if they have already logged
//   - never twice in one local day, even across restarts or a re-run
//   - never to an inactive seat, and never to someone without the module
//
// The last one is not paranoia: the codebase already had a user receiving
// digests for 34 consecutive days that nobody read, and the guard that stops it
// (`org_users.is_active`) had to be added retrospectively.
//
// ── The absence is the point ─────────────────────────────────────────
//
// §5 of the design: there is no generator, so a day with no entry is simply an
// absence. Nothing expires, nothing accumulates, and there is no backlog to
// clear. The reminder therefore asks about TODAY and never mentions the days
// before it — a message that lists everything you have missed is how a system
// starts being ignored.

const { pool } = require('../config/database');
const dwDate = require('./dailyWorkDate');
const notificationService = require('./notificationService');

// A reminder late enough that the day's work has happened, early enough that
// someone can still act on it. Org-overridable via
// settings->'dailywork'->>'reminder_hour'.
const DEFAULT_REMINDER_HOUR = 17;
const DEFAULT_ROLLUP_HOUR = 18;

/* ───────────────────────── shared scan ─────────────────────────────── */

/**
 * Everyone with the module, with what is needed to decide whether to nudge
 * them: their timezone, their schedule, their calendar, and whether they have
 * logged today.
 *
 * One query per org rather than per person. At ten people the difference is
 * nothing; at a thousand it is the difference between a sweep that finishes
 * inside the hour and one that does not.
 */
async function loadCandidates(orgId) {
  const { rows } = await pool.query(
    `SELECT u.id            AS user_id,
            u.timezone      AS user_tz,
            o.settings->'calendar'->>'timezone'          AS org_tz,
            o.settings->'dailywork'->>'reminder_hour'    AS reminder_hour,
            o.settings->'dailywork'->>'rollup_hour'      AS rollup_hour,
            s.weekday_mask,
            s.holiday_calendar_id
       FROM user_module_access g
       JOIN users u      ON u.id = g.user_id
       JOIN org_users ou ON ou.user_id = u.id AND ou.org_id = g.org_id
       JOIN organizations o ON o.id = g.org_id
       LEFT JOIN LATERAL (
              SELECT weekday_mask, holiday_calendar_id
                FROM daily_work_schedules d
               WHERE d.org_id = g.org_id AND d.user_id = g.user_id
                 AND d.effective_from <= CURRENT_DATE
               ORDER BY effective_from DESC LIMIT 1
            ) s ON TRUE
      WHERE g.org_id = $1
        AND g.module_key = 'dailywork'
        -- is_active lives on org_users, not users. This is the guard whose
        -- absence produced 34 unread digests for a departed member.
        AND ou.is_active = TRUE`,
    [orgId]);
  return rows;
}

/** Holidays and approved leave for one person, on one date. */
async function isDayOff(orgId, userId, calendarId, date) {
  if (calendarId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM holiday_calendar_dates
        WHERE org_id = $1 AND calendar_id = $2 AND holiday_date = $3`,
      [orgId, calendarId, date]);
    if (rows.length) return 'holiday';
  }
  // Approved only. A pending request must not silently excuse someone before
  // anyone has agreed to it — the same rule the metric uses.
  const { rows } = await pool.query(
    `SELECT 1 FROM daily_work_exceptions
      WHERE org_id = $1 AND user_id = $2 AND exception_date = $3
        AND approved_at IS NOT NULL`,
    [orgId, userId, date]);
  return rows.length ? 'leave' : null;
}

async function hasLogged(orgId, userId, date) {
  const { rows } = await pool.query(
    `SELECT 1 FROM daily_work_entries
      WHERE org_id = $1 AND user_id = $2 AND entry_date = $3 LIMIT 1`,
    [orgId, userId, date]);
  return rows.length > 0;
}

/**
 * Has this exact notification already gone out for this local date?
 *
 * Checked against the notifications table rather than kept in memory, so a
 * restart, a redeploy or a manual re-run cannot produce a second one. The local
 * date is in the metadata precisely so this question can be asked.
 */
async function alreadySent(orgId, userId, type, date) {
  // Bounded to the last few days on purpose. metadata->>'entry_date' is not
  // indexed, and idx_notif_user_all is (user_id, created_at DESC) — without the
  // date bound this walks a user's entire notification history every hour, and
  // it gets slower every week the product runs. Three days is comfortably more
  // than the one day the question actually spans, even across a timezone edge.
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
      WHERE user_id = $2 AND org_id = $1 AND type = $3
        AND created_at > now() - interval '3 days'
        AND metadata->>'entry_date' = $4
      LIMIT 1`,
    [orgId, userId, type, date]);
  return rows.length > 0;
}

/* ───────────────────────── the reminder ────────────────────────────── */

/**
 * Nudge people who have not logged, at their own local hour.
 *
 * Returns a summary rather than logging inside the loop, so a caller can assert
 * on it in a test and so the hourly log line stays one line.
 */
async function runReminders({ now = new Date() } = {}) {
  const orgIds = await notificationService.getActiveOrgIds();
  const summary = { considered: 0, sent: 0, skipped: {} };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };

  for (const orgId of orgIds) {
    let people;
    try { people = await loadCandidates(orgId); }
    catch (err) { console.error(`[dailywork] org ${orgId} scan failed:`, err.message); continue; }

    for (const p of people) {
      summary.considered++;
      try {
        const tz = dwDate.isValidZone(p.user_tz) ? p.user_tz
                 : dwDate.isValidZone(p.org_tz) ? p.org_tz : 'UTC';
        const hour = Number(p.reminder_hour) >= 0 && Number(p.reminder_hour) <= 23
          ? Number(p.reminder_hour) : DEFAULT_REMINDER_HOUR;

        // The self-filter. Everyone is scanned every hour; only those for whom
        // it is now the right hour where they are get any further.
        if (dwDate.localHour(tz, now) !== hour) { skip('wrong_hour'); continue; }

        const date = dwDate.localDate(tz, now);

        // A person with no schedule is NOT nudged. The metric falls back to
        // Mon-Fri for them, which is a defensible default for a number nobody
        // is looking at yet; it is not a good enough basis for telling someone
        // they have missed a day.
        if (!p.weekday_mask) { skip('no_schedule'); continue; }
        if (!dwDate.isScheduledDay(date, p.weekday_mask)) { skip('not_a_working_day'); continue; }

        const off = await isDayOff(orgId, p.user_id, p.holiday_calendar_id, date);
        if (off) { skip(off); continue; }

        if (await hasLogged(orgId, p.user_id, date)) { skip('already_logged'); continue; }
        if (await alreadySent(orgId, p.user_id, 'dailywork_reminder', date)) {
          skip('already_reminded'); continue;
        }

        const { rows: open } = await pool.query(
          `SELECT count(*)::int AS n FROM daily_work_items
            WHERE org_id = $1 AND owner_user_id = $2
              AND status NOT IN ('completed','dropped','retired')`,
          [orgId, p.user_id]);

        await notificationService.createNotification(
          orgId, p.user_id,
          'dailywork_reminder',
          'What did you get done today?',
          // No mention of previous days, deliberately. There is no backlog to
          // clear, and listing past misses is how a nudge becomes a nag.
          open[0].n > 0
            ? `You have ${open[0].n} open work item${open[0].n === 1 ? '' : 's'}. It takes a minute.`
            : 'Add what you worked on — it takes a minute.',
          'daily_work', null,
          { entry_date: date, timezone: tz, open_items: open[0].n }
        );
        summary.sent++;
      } catch (err) {
        console.error(`[dailywork] reminder for user ${p.user_id} failed:`, err.message);
        skip('error');
      }
    }
  }
  return summary;
}

/* ───────────────────────── the manager rollup ──────────────────────── */

/**
 * Tell a manager who logged, at their own local hour.
 *
 * Sent whether or not everyone logged — a rollup that only arrives when
 * something is wrong trains people to read it as an accusation, and a manager
 * who wants to see the good day has to go looking for it.
 *
 * Names the people who have not logged, and says plainly what that means. The
 * temptation is to lead with a percentage; §8.3 is explicit that rates are not
 * comparable across different weekday masks and calendars, and a manager
 * reading one number will compare it to another one.
 */
async function runRollups({ now = new Date() } = {}) {
  const hierarchyService = require('./hierarchyService');
  const orgIds = await notificationService.getActiveOrgIds();
  const summary = { considered: 0, sent: 0, skipped: {} };
  const skip = (reason) => { summary.skipped[reason] = (summary.skipped[reason] || 0) + 1; };

  for (const orgId of orgIds) {
    let people;
    try { people = await loadCandidates(orgId); }
    catch (err) { console.error(`[dailywork] org ${orgId} rollup scan failed:`, err.message); continue; }

    const granted = new Set(people.map(p => p.user_id));

    for (const p of people) {
      summary.considered++;
      try {
        const tz = dwDate.isValidZone(p.user_tz) ? p.user_tz
                 : dwDate.isValidZone(p.org_tz) ? p.org_tz : 'UTC';
        const hour = Number(p.rollup_hour) >= 0 && Number(p.rollup_hour) <= 23
          ? Number(p.rollup_hour) : DEFAULT_ROLLUP_HOUR;

        if (dwDate.localHour(tz, now) !== hour) { skip('wrong_hour'); continue; }

        // Only people who actually have reports with the module.
        const subordinates = (await hierarchyService.getSubordinates(orgId, p.user_id))
          .filter(id => granted.has(id));
        if (!subordinates.length) { skip('no_reports'); continue; }

        const date = dwDate.localDate(tz, now);
        if (await alreadySent(orgId, p.user_id, 'dailywork_rollup', date)) {
          skip('already_sent'); continue;
        }

        // The manager's own local date is used for everyone. A report in
        // another timezone may be on a different date, which is a real edge and
        // is left alone rather than papered over: the rollup says what happened
        // on the manager's day, and the team log is where per-person dates live.
        const { rows } = await pool.query(
          `SELECT u.id, u.first_name, u.last_name,
                  EXISTS (SELECT 1 FROM daily_work_entries e
                           WHERE e.org_id = $1 AND e.user_id = u.id
                             AND e.entry_date = $3) AS logged
             FROM users u
            WHERE u.id = ANY($2)
            ORDER BY u.first_name, u.last_name`,
          [orgId, subordinates, date]);

        const logged = rows.filter(r => r.logged);
        const missing = rows.filter(r => !r.logged);
        const name = r => `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Someone';

        const body = missing.length === 0
          ? `Everyone logged today: ${logged.map(name).join(', ')}.`
          : `Logged: ${logged.length ? logged.map(name).join(', ') : 'nobody yet'}.\n` +
            `Not yet: ${missing.map(name).join(', ')}.\n\n` +
            // Said explicitly because the alternative reading — that someone is
            // behind — is the one a manager reaches for first.
            `A missing day is an absence, not a backlog. There is nothing to clear.`;

        await notificationService.createNotification(
          orgId, p.user_id,
          'dailywork_rollup',
          `${logged.length} of ${rows.length} logged today`,
          body,
          'daily_work', null,
          {
            entry_date: date,
            timezone: tz,
            logged_ids: logged.map(r => r.id),
            missing_ids: missing.map(r => r.id),
          }
        );
        summary.sent++;
      } catch (err) {
        console.error(`[dailywork] rollup for user ${p.user_id} failed:`, err.message);
        skip('error');
      }
    }
  }
  return summary;
}

module.exports = {
  runReminders,
  runRollups,
  loadCandidates,
  isDayOff,
  hasLogged,
  alreadySent,
  DEFAULT_REMINDER_HOUR,
  DEFAULT_ROLLUP_HOUR,
};
