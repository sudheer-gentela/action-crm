// ─────────────────────────────────────────────────────────────────────────────
// SendingScheduleResolver — owns the "when should this enrollment fire?" math.
// ─────────────────────────────────────────────────────────────────────────────
//
// Settings cascade (low → high priority):
//   1. built-in defaults (this file)
//   2. org_integrations.config.{dailyActivationCap,sendWindowStartHour,...}
//   3. prospecting_campaigns.{daily_activation_cap,send_window_start_hour,...}
//
// Higher priority NON-NULL values win. A campaign can override only the
// fields it cares about; others fall back to org/default. The merged
// result is the "effective" schedule for that campaign.
//
// Used by:
//   - prospecting-campaigns.routes.js bulk-activate — pre-schedules new
//     enrollments across days. Each slot is computed by scheduleNextSlot()
//     and stored as sequence_enrollments.next_step_due.
//   - SequenceStepFirer.fireDueSteps — second-line defense. When firing a
//     due step, checks isWithinWindow(now, settings). If outside, the step
//     stays queued; the next cron tick (or first tick inside the window)
//     picks it up.
//
// All scheduling math uses the resolved timezone. Database stores UTC
// Date objects; the resolver converts in both directions via Intl.
//
// Day-of-week convention: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
// (matches PostgreSQL EXTRACT(DOW), JavaScript Date.getDay()).
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

// Hard-coded defaults — applied when neither org nor campaign sets a value.
//
// The window is a tight 2-hour band aligned with peak inbox engagement
// (9-11am in the recipient's morning). Email steps are spread evenly across
// this band; LinkedIn/task steps are all released at the window's start
// hour (sendWindowStartHour) so the rep has all day to work the queue.
const DEFAULTS = Object.freeze({
  dailyActivationCap:   25,
  sendWindowStartHour:  9,
  sendWindowEndHour:    11,
  sendWindowDays:       [1, 2, 3, 4, 5],   // Mon–Fri
  sendWindowTimezone:   'America/New_York',
});

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the effective sending schedule for a campaign (org default ⨁
 * campaign overrides). Returns a settings object with all fields populated.
 *
 *   const settings = await resolveSettings({ orgId, campaignId });
 *   // → { dailyActivationCap, sendWindowStartHour, sendWindowEndHour,
 *   //     sendWindowDays, sendWindowTimezone }
 *
 * If campaignId is omitted, returns the org-level effective settings.
 */
async function resolveSettings({ orgId, campaignId = null }) {
  if (!orgId) throw new Error('resolveSettings: orgId is required');

  // Load org-level config (JSONB) and campaign overrides in parallel.
  const [orgRes, campRes] = await Promise.all([
    pool.query(
      `SELECT config FROM org_integrations
        WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [orgId]
    ),
    campaignId
      ? pool.query(
          `SELECT daily_activation_cap, send_window_start_hour,
                  send_window_end_hour, send_window_days, send_window_timezone
             FROM prospecting_campaigns
            WHERE id = $1 AND org_id = $2`,
          [campaignId, orgId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const orgConfig = orgRes.rows[0]?.config || {};
  const camp      = campRes.rows[0] || {};

  // Cascade: campaign override > org config > default. Each field resolved
  // independently — a campaign can override one field without overriding others.
  return Object.freeze({
    dailyActivationCap:
      coerceInt(camp.daily_activation_cap) ??
      coerceInt(orgConfig.dailyActivationCap) ??
      DEFAULTS.dailyActivationCap,

    sendWindowStartHour:
      coerceHour(camp.send_window_start_hour) ??
      coerceHour(orgConfig.sendWindowStartHour) ??
      DEFAULTS.sendWindowStartHour,

    sendWindowEndHour:
      coerceHour(camp.send_window_end_hour) ??
      coerceHour(orgConfig.sendWindowEndHour) ??
      DEFAULTS.sendWindowEndHour,

    sendWindowDays:
      coerceDayArray(camp.send_window_days) ??
      coerceDayArray(orgConfig.sendWindowDays) ??
      DEFAULTS.sendWindowDays,

    sendWindowTimezone:
      coerceTimezone(camp.send_window_timezone) ??
      coerceTimezone(orgConfig.sendWindowTimezone) ??
      DEFAULTS.sendWindowTimezone,
  });
}

/**
 * Compute the firing-time slots for a batch of N new enrollments.
 *
 *   const slots = scheduleBatchSlots({
 *     count: 30,
 *     settings: { dailyActivationCap: 10, ... },
 *     channel: 'email',                     // optional, default 'email'
 *     existingByDay: { '2026-05-27': 4 },   // optional — slots already used today
 *     now: new Date(),                      // optional — for testing
 *   });
 *   // → [Date, Date, ..., Date]  (length = count)
 *
 * `channel` controls the within-day spread:
 *   - 'email' (default): slots spread evenly across the window with jitter,
 *     so emails fire throughout the 2-hour peak band.
 *   - 'linkedin' | 'task' | 'call': all slots in a day land at the
 *     window START (sendWindowStartHour) with small jitter (±5min). LinkedIn
 *     tasks aren't actually sent automatically — the firer just creates a
 *     task row, and the rep actions it manually at their convenience. So we
 *     release the whole day's queue at start-of-window.
 *
 * existingByDay (yyyy-mm-dd in resolved timezone) is consulted so we don't
 * exceed dailyCap when prior enrollments already booked slots today/tomorrow.
 *
 * Returns an array of Date objects (UTC) ready to insert as next_step_due.
 */
function scheduleBatchSlots({ count, settings, channel = 'email', existingByDay = {}, now = new Date() }) {
  if (count <= 0) return [];
  const isManualChannel = channel === 'linkedin' || channel === 'task' || channel === 'call';
  const slots = [];
  const consumed = { ...existingByDay };

  // Walk forward day-by-day, filling each day to dailyCap before moving on.
  let cursor = new Date(now.getTime());
  let safetyGuard = 365; // refuse to schedule more than 1 year out
  while (slots.length < count && safetyGuard-- > 0) {
    // Resolve "what is the local-tz day of the cursor?"
    const tzDate = getLocalCalendarDate(cursor, settings.sendWindowTimezone);
    const localDayKey = tzDate.dayKey;     // 'YYYY-MM-DD'
    const localDow    = tzDate.dayOfWeek;  // 0..6

    // Is this day valid (per send_window_days)?
    if (!settings.sendWindowDays.includes(localDow)) {
      cursor = advanceToNextDayLocal(cursor, settings.sendWindowTimezone);
      continue;
    }

    // How many slots already used today (existing + previously consumed
    // in this batch)?
    const usedToday = consumed[localDayKey] || 0;
    if (usedToday >= settings.dailyActivationCap) {
      cursor = advanceToNextDayLocal(cursor, settings.sendWindowTimezone);
      continue;
    }

    // For email: if past window-end, skip to tomorrow.
    // For manual channels: tasks can be released later in the day too,
    // but if we're already past the END of the window, defer to tomorrow
    // anyway — tasks "due today" that appear at 8pm are misleading.
    const localHourNow = tzDate.hour;
    if (isSameLocalDay(cursor, now, settings.sendWindowTimezone) &&
        localHourNow >= settings.sendWindowEndHour) {
      cursor = advanceToNextDayLocal(cursor, settings.sendWindowTimezone);
      continue;
    }

    const isToday    = isSameLocalDay(cursor, now, settings.sendWindowTimezone);
    const remainCap  = settings.dailyActivationCap - usedToday;
    const windowStart = settings.sendWindowStartHour;
    const windowEnd   = settings.sendWindowEndHour;

    // Generate candidate slots for this day.
    const candidateSlots = [];
    if (isManualChannel) {
      // Manual channels: all slots at window-start with ±5min jitter.
      // The rep sees the whole day's queue when they log in.
      for (let i = settings.dailyActivationCap - remainCap; i < settings.dailyActivationCap; i++) {
        const jitterMin = Math.floor(Math.random() * 10) - 5; // ±5min
        const minutesIntoDay = (windowStart * 60) + jitterMin;
        const slot = buildLocalTimestamp(
          localDayKey,
          Math.floor(minutesIntoDay / 60),
          Math.max(0, Math.round(minutesIntoDay % 60)),
          settings.sendWindowTimezone,
        );
        if (!isToday || slot.getTime() >= now.getTime()) {
          candidateSlots.push(slot);
        } else {
          // If today's window-start already passed, release task NOW
          // rather than punting to tomorrow — the rep is logged in
          // and can action it.
          candidateSlots.push(new Date(now.getTime() + 60000));
        }
      }
    } else {
      // Email: spread evenly across [windowStart, windowEnd).
      const dayMinutes  = (windowEnd - windowStart) * 60;
      const slotMinutes = dayMinutes / settings.dailyActivationCap;
      for (let i = settings.dailyActivationCap - remainCap; i < settings.dailyActivationCap; i++) {
        const slotOffsetMin = slotMinutes * (i + 0.5);
        const jitterMin     = (Math.random() - 0.5) * slotMinutes * 0.5;
        const minutesIntoDay = (windowStart * 60) + slotOffsetMin + jitterMin;
        const slot = buildLocalTimestamp(
          localDayKey,
          Math.floor(minutesIntoDay / 60),
          Math.round(minutesIntoDay % 60),
          settings.sendWindowTimezone,
        );
        // Only include if at-or-after now. Past-time slots push to next day.
        if (!isToday || slot.getTime() >= now.getTime()) {
          candidateSlots.push(slot);
        }
      }
    }

    const slotsToTake = Math.min(candidateSlots.length, count - slots.length);
    for (let i = 0; i < slotsToTake; i++) {
      slots.push(candidateSlots[i]);
    }
    consumed[localDayKey] = (consumed[localDayKey] || 0) + slotsToTake;
    cursor = advanceToNextDayLocal(cursor, settings.sendWindowTimezone);
  }

  return slots;
}

/**
 * True if firing this step right now would be inside its allowed window.
 *
 * Channel-aware:
 *   - 'email'                       → must be inside [start, end) on a valid day
 *   - 'linkedin' | 'task' | 'call'  → ALWAYS true. These create tasks for the
 *     rep to action manually; nothing leaves the system at firing time, so
 *     there's no recipient-side timing concern.
 *
 * Used by the firer as defense-in-depth: even if a manually-created
 * enrollment lands at 2am, an email won't actually go out then.
 */
function isWithinWindow(when, settings, channel = 'email') {
  // Manual channels skip the window check entirely — the firer just
  // creates a task row, the rep actions it on their schedule.
  if (channel === 'linkedin' || channel === 'task' || channel === 'call') {
    return true;
  }
  const tz = settings.sendWindowTimezone;
  const local = getLocalCalendarDate(when, tz);
  if (!settings.sendWindowDays.includes(local.dayOfWeek)) return false;
  if (local.hour < settings.sendWindowStartHour) return false;
  if (local.hour >= settings.sendWindowEndHour)  return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function coerceInt(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function coerceHour(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null;
}
function coerceDayArray(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  const days = v.map(d => parseInt(d, 10)).filter(d => Number.isFinite(d) && d >= 0 && d <= 6);
  return days.length > 0 ? days : null;
}
function coerceTimezone(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  // Best-effort validation — does the timezone parse?
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch (_) {
    return null;
  }
}

/**
 * Given a UTC Date and a timezone, return:
 *   { dayKey: 'YYYY-MM-DD', dayOfWeek: 0..6, hour: 0..23, minute: 0..59 }
 * representing the local-tz reading of that moment.
 */
function getLocalCalendarDate(d, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  const dayKey = `${get('year')}-${get('month')}-${get('day')}`;
  let hour = parseInt(get('hour'), 10);
  // en-CA hour12:false can emit '24' for midnight on some platforms — normalize.
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dayKey, dayOfWeek: dow, hour, minute };
}

function isSameLocalDay(a, b, tz) {
  return getLocalCalendarDate(a, tz).dayKey === getLocalCalendarDate(b, tz).dayKey;
}

/**
 * Given a UTC Date, return a new UTC Date representing 00:00 of the NEXT
 * calendar day in the given timezone. (We then iterate from there to find
 * the next valid send-window day.)
 */
function advanceToNextDayLocal(d, tz) {
  // Strategy: pick a time well inside "tomorrow" local — noon next day,
  // which avoids DST ambiguity. We do this by stepping forward 25 hours
  // and then normalising to midnight via getLocalCalendarDate.
  const next = new Date(d.getTime() + 25 * 60 * 60 * 1000);
  // Bring it back to local midnight (00:00) of the resulting local day.
  const { dayKey } = getLocalCalendarDate(next, tz);
  return buildLocalTimestamp(dayKey, 0, 1, tz); // 00:01 so we're inside the day
}

/**
 * Given a local date 'YYYY-MM-DD' + hour + minute + tz, return the UTC Date
 * representing that moment. Handles DST by probing the timezone's offset
 * for the target instant.
 */
function buildLocalTimestamp(dayKey, hour, minute, tz) {
  // The trick: construct a UTC Date assuming the wall-clock string is UTC,
  // then ask "what would en-CA say this is in tz?" The difference between
  // the two readings tells us the offset to apply.
  const [y, m, d] = dayKey.split('-').map(n => parseInt(n, 10));
  // Start with a "fake UTC" instant.
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  // Read what that looks like in the target tz.
  const localReading = getLocalCalendarDate(new Date(naive), tz);
  // The diff between intended local (y/m/d/hour/minute) and what tz reads
  // tells us the offset.
  const intendedMs = Date.UTC(y, m - 1, d, hour, minute, 0);
  const readMs     = Date.UTC(
    parseInt(localReading.dayKey.split('-')[0], 10),
    parseInt(localReading.dayKey.split('-')[1], 10) - 1,
    parseInt(localReading.dayKey.split('-')[2], 10),
    localReading.hour,
    localReading.minute,
    0
  );
  const offsetMs = intendedMs - readMs;
  return new Date(naive + offsetMs);
}

module.exports = {
  DEFAULTS,
  resolveSettings,
  scheduleBatchSlots,
  isWithinWindow,
  // Exposed for testing
  _internal: {
    getLocalCalendarDate,
    buildLocalTimestamp,
    isSameLocalDay,
    advanceToNextDayLocal,
  },
};
