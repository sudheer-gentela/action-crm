// ─────────────────────────────────────────────────────────────────────────────
// SendingScheduleResolver — owns the "when should this enrollment fire?" math.
// ─────────────────────────────────────────────────────────────────────────────
//
// Settings cascade (low → high priority):
//   1. built-in defaults (this file)
//   2. org_integrations.config.{startMode,pacingMode,cadenceMinutes,sendWindow*}
//   3. prospecting_campaigns.{start_mode,pacing_mode,cadence_minutes,send_window_*}
//
// Higher priority NON-NULL values win. A campaign can override only the
// fields it cares about; others fall back to org/default. The merged
// result is the "effective" schedule for that campaign.
//
// ── Per-channel daily cap (the throughput governor) ──────────────────────────
// The cap that limits a day's volume depends on the FIRST step's channel:
//   - email    → Σ over the activating user's ACTIVE email sender accounts of
//                their effective daily_limit (NULL daily_limit → org
//                defaultDailyLimit, clamped to dailyLimitCeiling). This is the
//                only cap with a real hard gate (the firer, at send time).
//                Computed live via resolveEmailCapacity().
//   - linkedin → a per-day RELEASE cap (campaign daily_activation_cap, else org
//                default, else built-in). Soft only — the action happens
//                manually off-platform, so we can only pace how many tasks we
//                hand the rep. There is NO linkedin sender account to gate on.
//   - call     → uncapped (calling WINDOW limits volume, not a daily number).
//   - task     → uncapped.
//
// ── Pacing (within a day) ────────────────────────────────────────────────────
//   - cadence : slot[i] = effectiveStart + i × cadenceMinutes (± jitter).
//               No fixed window end; a silent safety ceiling (sendWindowEndHour,
//               else 18:00 local) rolls overflow to the next day so volume
//               can't bleed into the night.
//   - spread  : even across [effectiveStart, sendWindowEndHour) with jitter.
//
// ── Daily start (first slot of TODAY) ────────────────────────────────────────
//   - on_activate  : effectiveStart = now.
//   - fixed        : effectiveStart = today@startHour:startMinute; if already
//                    passed, today gets nothing → first slots land tomorrow.
//   - fixed_or_now : effectiveStart = max(today@start, now). (default)
//
// Manual channels (linkedin/call/task) keep "released at window start, or now
// if the start already passed" regardless of start_mode — they're tasks, not
// auto-sends, so the rep works the queue at their convenience.
//
// All scheduling math uses the resolved timezone. The database stores UTC Date
// objects; the resolver converts in both directions via Intl.
//
// Day-of-week convention: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
// (matches PostgreSQL EXTRACT(DOW), JavaScript Date.getDay()).
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

// Hard-coded defaults — applied when neither org nor campaign sets a value.
const DEFAULTS = Object.freeze({
  startMode:            'fixed_or_now',
  pacingMode:           'cadence',
  cadenceMinutes:       5,
  sendWindowStartHour:  8,            // 08:00 — configurable per org/campaign
  sendWindowStartMinute: 0,
  sendWindowEndHour:    18,           // 18:00 — used as spread end + cadence safety ceiling
  sendWindowDays:       [1, 2, 3, 4, 5],   // Mon–Fri
  sendWindowTimezone:   'America/New_York',
  // Manual-channel (linkedin/task/call) release time. These steps don't "send"
  // at fire time — they materialize a draft/task. We release them at the START
  // of the local day rather than inheriting the prior step's clock time, so reps
  // find them queued first thing. Independent of the email send window.
  manualReleaseHour:    4,            // 04:00 local — configurable per org
  manualReleaseMinute:  0,
  // Soft per-day LinkedIn/manual release cap (no sender account exists for it).
  linkedinReleaseCap:   25,
  // Budget split policy: 'shared' (pooled FCFS) or 'weighted' (per-campaign).
  budgetMode:           'shared',
  // Email fallbacks (used when a sender's daily_limit is NULL).
  defaultDailyLimit:    50,
  dailyLimitCeiling:    100,
  // Per-account send spacing (auto-send cooldown). Floor behaves as a minimum.
  defaultMinDelayMinutes: 5,
  minDelayMinutesFloor:   2,
  // Cadence safety ceiling when no sendWindowEndHour is resolvable.
  cadenceSafetyEndHour: 18,
});

const MANUAL_CHANNELS = new Set(['linkedin', 'task', 'call']);
const UNCAPPED_CHANNELS = new Set(['call', 'task']); // no daily volume cap at all

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the effective sending schedule for a campaign (org default ⨁
 * campaign overrides). Returns a fully-populated settings object.
 *
 * If campaignId is omitted, returns the org-level effective settings.
 */
async function resolveSettings({ orgId, campaignId = null }) {
  if (!orgId) throw new Error('resolveSettings: orgId is required');

  const [orgRes, campRes] = await Promise.all([
    pool.query(
      `SELECT config FROM org_integrations
        WHERE org_id = $1 AND integration_type = 'prospecting_email'`,
      [orgId]
    ),
    campaignId
      ? pool.query(
          `SELECT daily_activation_cap, send_window_start_hour,
                  send_window_start_minute, send_window_end_hour,
                  send_window_days, send_window_timezone,
                  start_mode, pacing_mode, cadence_minutes
             FROM prospecting_campaigns
            WHERE id = $1 AND org_id = $2`,
          [campaignId, orgId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const orgConfig = orgRes.rows[0]?.config || {};
  const camp      = campRes.rows[0] || {};

  const resolved = {
    // Pacing / start
    startMode:
      coerceEnum(camp.start_mode, ['on_activate', 'fixed', 'fixed_or_now']) ??
      coerceEnum(orgConfig.startMode, ['on_activate', 'fixed', 'fixed_or_now']) ??
      DEFAULTS.startMode,

    pacingMode:
      coerceEnum(camp.pacing_mode, ['cadence', 'spread']) ??
      coerceEnum(orgConfig.pacingMode, ['cadence', 'spread']) ??
      DEFAULTS.pacingMode,

    cadenceMinutes:
      coerceRange(camp.cadence_minutes, 1, 240) ??
      coerceRange(orgConfig.cadenceMinutes, 1, 240) ??
      DEFAULTS.cadenceMinutes,

    // Window
    sendWindowStartHour:
      coerceRange(camp.send_window_start_hour, 0, 23) ??
      coerceRange(orgConfig.sendWindowStartHour, 0, 23) ??
      DEFAULTS.sendWindowStartHour,

    sendWindowStartMinute:
      coerceRange(camp.send_window_start_minute, 0, 59) ??
      coerceRange(orgConfig.sendWindowStartMinute, 0, 59) ??
      DEFAULTS.sendWindowStartMinute,

    sendWindowEndHour:
      coerceRange(camp.send_window_end_hour, 1, 24) ??
      coerceRange(orgConfig.sendWindowEndHour, 1, 24) ??
      DEFAULTS.sendWindowEndHour,

    sendWindowDays:
      coerceDayArray(camp.send_window_days) ??
      coerceDayArray(orgConfig.sendWindowDays) ??
      DEFAULTS.sendWindowDays,

    sendWindowTimezone:
      coerceTimezone(camp.send_window_timezone) ??
      coerceTimezone(orgConfig.sendWindowTimezone) ??
      DEFAULTS.sendWindowTimezone,

    // Manual-channel release time (linkedin/task/call). Org-level only — there's
    // no per-campaign column for it yet. Falls back to the 04:00 default.
    manualReleaseHour:
      coerceRange(orgConfig.manualReleaseHour, 0, 23) ??
      DEFAULTS.manualReleaseHour,

    manualReleaseMinute:
      coerceRange(orgConfig.manualReleaseMinute, 0, 59) ??
      DEFAULTS.manualReleaseMinute,

    // Budget split policy across the owner's campaigns in a channel pool.
    //   'shared'   → one pool, first-come-first-served (existingByDay owner-wide)
    //   'weighted' → each campaign gets share_weight-normalized slice of the pool
    // Org-level only (no per-campaign override — it's a global policy choice).
    budgetMode:
      coerceEnum(orgConfig.budgetMode, ['shared', 'weighted']) ?? DEFAULTS.budgetMode,

    // LinkedIn/manual soft release cap (repurposed daily_activation_cap).
    linkedinReleaseCap:
      coerceInt(camp.daily_activation_cap) ??
      coerceInt(orgConfig.linkedinReleaseCap) ??
      coerceInt(orgConfig.dailyActivationCap) ??       // legacy key fallback
      DEFAULTS.linkedinReleaseCap,

    // Email fallbacks — exposed so the capacity resolver and firer agree.
    defaultDailyLimit:
      coerceInt(orgConfig.defaultDailyLimit) ?? DEFAULTS.defaultDailyLimit,
    dailyLimitCeiling:
      coerceInt(orgConfig.dailyLimitCeiling) ?? DEFAULTS.dailyLimitCeiling,

    // Per-account send spacing (auto-send cooldown). The ceiling is a FLOOR:
    // an account's effective min-delay is never below it. Both allow 0.
    defaultMinDelayMinutes:
      coerceNonNegInt(orgConfig.defaultMinDelayMinutes) ?? DEFAULTS.defaultMinDelayMinutes,
    minDelayMinutesFloor:
      coerceNonNegInt(orgConfig.minDelayMinutesCeiling) ?? DEFAULTS.minDelayMinutesFloor,
  };

  // Safety: a window where end ≤ start yields ZERO slots in both cadence and
  // spread (empty interval) — the campaign would silently never send. Because
  // start and end resolve from independent layers (a campaign start-hour
  // override can land past the org/default end), repair to a guaranteed
  // non-empty window so sends never silently halt, and warn so the misconfig
  // is visible. (Save-time validation in the route rejects the explicit
  // both-fields-provided case; this catches the cross-layer case.)
  if (resolved.sendWindowEndHour <= resolved.sendWindowStartHour) {
    const startH = resolved.sendWindowStartHour;
    const repaired = Math.min(24, Math.max(startH + 1, DEFAULTS.sendWindowEndHour));
    console.warn(
      `[SendingSchedule] send-window end (${resolved.sendWindowEndHour}:00) <= start ` +
      `(${startH}:00) for org=${orgId} campaign=${campaignId ?? 'org'}; ` +
      `repaired end -> ${repaired}:00 to keep a non-empty send window.`
    );
    resolved.sendWindowEndHour = repaired;
  }

  return Object.freeze(resolved);
}

/**
 * Compute the EMAIL daily capacity for a given user (the user whose sender
 * accounts actually send — i.e. sequence_enrollments.enrolled_by). Returns:
 *   { todayRemaining, perDayFull, activeSenders, perAccount: [{id,email,limit,sentToday}] }
 *
 * - perDayFull   : Σ effective daily_limit across the user's ACTIVE email
 *                  senders (NULL daily_limit → defaultDailyLimit, clamped to
 *                  dailyLimitCeiling). The capacity on a fresh day.
 * - todayRemaining: Σ max(0, effectiveLimit − sentToday), where sentToday is 0
 *                  if the account's counter hasn't been reset today. Floored at
 *                  0 per account (manual over-cap sends can push a counter past
 *                  its limit — see sequences.routes.js draft send).
 *
 * `settings` supplies defaultDailyLimit / dailyLimitCeiling (resolveSettings()).
 */
async function resolveEmailCapacity({ orgId, userId, now = new Date(), settings = null, senderIds = null }) {
  if (!orgId || !userId) return { todayRemaining: 0, perDayFull: 0, activeSenders: 0, perAccount: [] };
  const s = settings || await resolveSettings({ orgId });
  const defaultLimit = s.defaultDailyLimit ?? DEFAULTS.defaultDailyLimit;
  const ceiling      = s.dailyLimitCeiling ?? DEFAULTS.dailyLimitCeiling;

  // Optional per-campaign sender selection: NULL/empty = all of the user's
  // senders (prior behaviour); otherwise restrict the pool to the chosen ids.
  const filterIds = (Array.isArray(senderIds) && senderIds.length) ? senderIds : null;

  const { rows } = await pool.query(
    `SELECT id, email, daily_limit, emails_sent_today, last_reset_at
       FROM prospecting_sender_accounts
      WHERE org_id    = $1
        AND user_id   = $2
        AND client_id IS NULL
        AND is_active  = true
        AND ($3::int[] IS NULL OR id = ANY($3))`,
    [orgId, userId, filterIds]
  );

  const todayStr = now.toDateString();
  let todayRemaining = 0;
  let perDayFull     = 0;
  const perAccount   = [];
  for (const r of rows) {
    const effLimit = Math.min(
      (r.daily_limit != null && r.daily_limit > 0) ? r.daily_limit : defaultLimit,
      ceiling
    );
    // Counter is stale (and thus effectively 0) if it hasn't been reset today.
    const resetToday = r.last_reset_at && new Date(r.last_reset_at).toDateString() === todayStr;
    const sentToday  = resetToday ? (r.emails_sent_today || 0) : 0;
    perDayFull     += effLimit;
    todayRemaining += Math.max(0, effLimit - sentToday);
    perAccount.push({ id: r.id, email: r.email, limit: effLimit, sentToday });
  }
  return { todayRemaining, perDayFull, activeSenders: rows.length, perAccount };
}

/**
 * Per-channel daily cap, derived for the first step's channel.
 *
 *   resolveChannelDailyCap('email', { emailCapacity })
 *     → { todayRemaining, perDayFull, kind: 'email' }
 *   resolveChannelDailyCap('linkedin', { settings })
 *     → { todayRemaining: N, perDayFull: N, kind: 'linkedin' }
 *   resolveChannelDailyCap('call'|'task', ...)
 *     → { todayRemaining: Infinity, perDayFull: Infinity, kind: 'uncapped' }
 */
function resolveChannelDailyCap(channel, { emailCapacity = null, settings = null } = {}) {
  if (channel === 'email') {
    const cap = emailCapacity || { todayRemaining: 0, perDayFull: 0 };
    return { todayRemaining: cap.todayRemaining, perDayFull: cap.perDayFull, kind: 'email' };
  }
  if (channel === 'linkedin') {
    const n = (settings && settings.linkedinReleaseCap) || DEFAULTS.linkedinReleaseCap;
    return { todayRemaining: n, perDayFull: n, kind: 'linkedin' };
  }
  // call / task and anything else → uncapped.
  return { todayRemaining: Infinity, perDayFull: Infinity, kind: 'uncapped' };
}

/**
 * Compute firing-time slots for a batch of N new enrollments.
 *
 *   scheduleBatchSlots({
 *     count: 30,
 *     settings,                       // from resolveSettings()
 *     channel: 'email',               // first step's channel
 *     dayCap: { todayRemaining, perDayFull },   // from resolveChannelDailyCap()
 *     existingByDay: { '2026-05-27': 4 },       // owner-wide, same-channel, pre-booked
 *     now: new Date(),
 *   }) → [Date, ...]   (UTC, ascending, length = count or capped-with-overflow)
 *
 * Pure (no DB) so the simulation in __tests__ can exercise it directly.
 */
function scheduleBatchSlots({
  count,
  settings,
  channel = 'email',
  dayCap = null,
  existingByDay = {},
  now = new Date(),
}) {
  if (count <= 0) return [];
  const isManual   = MANUAL_CHANNELS.has(channel);
  const isUncapped = UNCAPPED_CHANNELS.has(channel) ||
                     (dayCap && !Number.isFinite(dayCap.todayRemaining) && !Number.isFinite(dayCap.perDayFull));
  const tz         = settings.sendWindowTimezone;
  const slots      = [];
  const consumed   = { ...existingByDay };

  // Per-day cap source. For uncapped channels we use a large finite number so
  // the day-walk still terminates (release everything on the first valid day).
  const capToday = isUncapped ? count + (sumExisting(existingByDay)) : (dayCap ? dayCap.todayRemaining : 0);
  const capFull  = isUncapped ? count + (sumExisting(existingByDay)) : (dayCap ? dayCap.perDayFull   : 0);

  // on_activate means "start now": today's first batch is released immediately,
  // bypassing BOTH the send-day and start-hour gating for TODAY ONLY. All
  // future/overflow slots respect the normal window again. This makes "Start
  // now, when I activate" do what it says even on a weekend or before the
  // window opens — applies to every channel (manual tasks and email alike).
  const startNow = settings.startMode === 'on_activate';

  let cursor = new Date(now.getTime());
  let safety = 730; // refuse to schedule > ~2 years out
  while (slots.length < count && safety-- > 0) {
    const tzDate     = getLocalCalendarDate(cursor, tz);
    const localDayKey = tzDate.dayKey;
    const localDow    = tzDate.dayOfWeek;

    const isToday = isSameLocalDay(cursor, now, tz);
    // Skip non-send days — EXCEPT today when startNow (explicit "start now").
    if (!settings.sendWindowDays.includes(localDow) && !(isToday && startNow)) {
      cursor = advanceToNextDayLocal(cursor, tz);
      continue;
    }

    const dayCapN   = isToday ? capToday : capFull;
    const usedToday = consumed[localDayKey] || 0;
    if (usedToday >= dayCapN) {
      cursor = advanceToNextDayLocal(cursor, tz);
      continue;
    }

    const startHour = settings.sendWindowStartHour;
    const startMin  = settings.sendWindowStartMinute || 0;
    const endHour   = settings.sendWindowEndHour;
    const startOfWindowMin = startHour * 60 + startMin;
    const nowMinIntoDay    = tzDate.hour * 60 + tzDate.minute;

    // ── First-slot anchor for TODAY (start_mode). Future days always anchor
    //    to the configured start.
    let effStartMin;
    if (!isToday) {
      effStartMin = startOfWindowMin;
    } else if (startNow) {
      // on_activate: release the first batch right now, regardless of channel,
      // day, or window start hour.
      effStartMin = nowMinIntoDay + 1;
    } else if (isManual) {
      // Manual channels: released at window start, or now if start passed.
      effStartMin = Math.max(startOfWindowMin, nowMinIntoDay + 1);
    } else if (settings.startMode === 'fixed') {
      // Fixed start: if today's start already passed, today gets no slots.
      if (nowMinIntoDay >= startOfWindowMin) {
        cursor = advanceToNextDayLocal(cursor, tz);
        continue;
      }
      effStartMin = startOfWindowMin;
    } else { // fixed_or_now
      effStartMin = Math.max(startOfWindowMin, nowMinIntoDay + 1);
    }

    const remainCap = dayCapN - usedToday;
    const startIdx  = usedToday;        // global index into the day's sequence
    const candidates = [];

    if (settings.pacingMode === 'cadence' && !isManual) {
      // Cadence: fixed interval from effStart, ± jitter. Silent safety ceiling
      // = sendWindowEndHour (else 18:00) so volume can't run into the night.
      const ceilingMin = (Number.isFinite(endHour) ? endHour : DEFAULTS.cadenceSafetyEndHour) * 60;
      const interval   = settings.cadenceMinutes || DEFAULTS.cadenceMinutes;
      for (let i = startIdx; i < startIdx + remainCap; i++) {
        const baseMin   = effStartMin + (i - startIdx) * interval;
        const jitter    = (Math.random() - 0.5) * interval * 0.4; // ±20%
        const minute    = Math.max(effStartMin, baseMin + jitter); // never before start
        if (minute >= ceilingMin) break; // overflow rolls to next day
        candidates.push(buildSlot(localDayKey, minute, tz, isToday, now));
      }
    } else if (isManual) {
      // Manual channels: all at effStart with ±5min jitter (rep works the queue).
      for (let i = startIdx; i < startIdx + remainCap; i++) {
        const jitter  = (Math.random() * 10) - 5; // ±5 min
        const minute  = effStartMin + jitter;
        candidates.push(buildSlot(localDayKey, minute, tz, isToday, now, /*manualFallbackNow*/ true));
      }
    } else {
      // Spread: even across [effStart, endHour) with jitter.
      const endMin       = endHour * 60;
      const availableMin = Math.max(0, endMin - effStartMin);
      const slotMinutes  = availableMin / Math.max(1, dayCapN);
      for (let i = startIdx; i < startIdx + remainCap; i++) {
        const offset  = slotMinutes * ((i - startIdx) + 0.5);
        const jitter  = (Math.random() - 0.5) * slotMinutes * 0.5;
        const minute  = Math.max(effStartMin, effStartMin + offset + jitter);
        if (minute >= endMin) break;
        const slot = buildSlot(localDayKey, minute, tz, isToday, now);
        if (slot) candidates.push(slot);
      }
    }

    const cleaned = candidates.filter(Boolean);
    const take = Math.min(cleaned.length, count - slots.length);
    for (let i = 0; i < take; i++) slots.push(cleaned[i]);
    consumed[localDayKey] = (consumed[localDayKey] || 0) + take;

    // If this day produced zero usable candidates (e.g. cadence overflow with
    // no remaining room), force advance so we don't spin on the same day.
    if (take === 0) {
      consumed[localDayKey] = dayCapN; // mark full to skip next iteration
    }
    cursor = advanceToNextDayLocal(cursor, tz);
  }

  // Ascending order (jitter can locally reorder within a day).
  slots.sort((a, b) => a.getTime() - b.getTime());
  return slots;
}

/**
 * True if firing this step right now would be inside its allowed window.
 * Channel-aware: manual channels (linkedin/task/call) always pass — they
 * create tasks, nothing leaves the system at firing time.
 *
 * For email, cadence mode has no hard window-end, so we treat the cadence
 * safety ceiling (sendWindowEndHour, else 18:00) as the late bound.
 */
function isWithinWindow(when, settings, channel = 'email') {
  if (MANUAL_CHANNELS.has(channel)) return true;
  const tz = settings.sendWindowTimezone;
  const local = getLocalCalendarDate(when, tz);
  if (!settings.sendWindowDays.includes(local.dayOfWeek)) return false;
  const startMin = settings.sendWindowStartHour * 60 + (settings.sendWindowStartMinute || 0);
  const endHour  = Number.isFinite(settings.sendWindowEndHour)
    ? settings.sendWindowEndHour
    : DEFAULTS.cadenceSafetyEndHour;
  const nowMin   = local.hour * 60 + local.minute;
  if (nowMin < startMin)        return false;
  if (nowMin >= endHour * 60)   return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual-channel due-time resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UTC instant at which a manual-channel step that is `delayDays` out should be
 * released. Release time = manualReleaseHour:manualReleaseMinute in
 * sendWindowTimezone, on the local day `delayDays` after `from`, rolled forward
 * to the next configured send day (sendWindowDays).
 *
 * Manual steps (linkedin/task/call) don't send anything at fire time — the firer
 * just materializes a draft/task — so releasing at the top of the day means reps
 * see the queued touch first thing instead of at whatever time the prior step
 * happened to fire.
 */
function manualReleaseFor(from, delayDays, settings) {
  const tz = settings.sendWindowTimezone;
  const fromDay = getLocalCalendarDate(from, tz).dayKey;
  // Anchor at local noon so whole-day shifts stay clear of DST/midnight edges.
  let cursor = new Date(buildLocalTimestamp(fromDay, 12, 0, tz).getTime()
                        + (parseInt(delayDays, 10) || 0) * 86400000);
  let cal = getLocalCalendarDate(cursor, tz);
  const days = (settings.sendWindowDays && settings.sendWindowDays.length)
    ? settings.sendWindowDays : [0, 1, 2, 3, 4, 5, 6];
  let guard = 0;
  while (!days.includes(cal.dayOfWeek) && guard < 7) {
    cursor = new Date(buildLocalTimestamp(cal.dayKey, 12, 0, tz).getTime() + 86400000);
    cal = getLocalCalendarDate(cursor, tz);
    guard++;
  }
  return buildLocalTimestamp(
    cal.dayKey,
    settings.manualReleaseHour,
    settings.manualReleaseMinute || 0,
    tz
  );
}

/**
 * Channel-aware next_step_due for a sequence advance.
 *   - manual channels (linkedin/task/call) → manualReleaseFor() (top of day)
 *   - email → now + delay_days (unchanged; the send-window gate still applies
 *     at send time, and the pre-scheduler still snaps email into its window)
 *
 * `settings` must come from resolveSettings(). Synchronous on purpose so the
 * firer can call it with the settings it already resolved per tick.
 */
function nextStepDue(nextStep, settings) {
  const delay = parseInt(nextStep.delay_days, 10) || 0;
  if (MANUAL_CHANNELS.has(nextStep.channel)) {
    return manualReleaseFor(new Date(), delay, settings);
  }
  const d = new Date();
  d.setDate(d.getDate() + delay);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function sumExisting(obj) {
  return Object.values(obj || {}).reduce((a, b) => a + (b || 0), 0);
}

// Build a UTC Date for `minutesIntoDay` on `dayKey` in tz. Returns null if the
// slot would be before `now` on today (unless manualFallbackNow, in which case
// it returns now+60s so the rep still sees the task immediately).
function buildSlot(dayKey, minutesIntoDay, tz, isToday, now, manualFallbackNow = false) {
  const m = Math.max(0, Math.round(minutesIntoDay));
  const slot = buildLocalTimestamp(dayKey, Math.floor(m / 60), m % 60, tz);
  if (isToday && slot.getTime() < now.getTime()) {
    return manualFallbackNow ? new Date(now.getTime() + 60000) : null;
  }
  return slot;
}

function coerceInt(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function coerceNonNegInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function coerceRange(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function coerceEnum(v, allowed) {
  if (typeof v !== 'string') return null;
  return allowed.includes(v) ? v : null;
}
function coerceDayArray(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  const days = v.map(d => parseInt(d, 10)).filter(d => Number.isFinite(d) && d >= 0 && d <= 6);
  return days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : null;
}
function coerceTimezone(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch (_) {
    return null;
  }
}

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
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dayKey, dayOfWeek: dow, hour, minute };
}

function isSameLocalDay(a, b, tz) {
  return getLocalCalendarDate(a, tz).dayKey === getLocalCalendarDate(b, tz).dayKey;
}

function advanceToNextDayLocal(d, tz) {
  const next = new Date(d.getTime() + 25 * 60 * 60 * 1000);
  const { dayKey } = getLocalCalendarDate(next, tz);
  return buildLocalTimestamp(dayKey, 0, 1, tz);
}

function buildLocalTimestamp(dayKey, hour, minute, tz) {
  const [y, m, d] = dayKey.split('-').map(n => parseInt(n, 10));
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  const localReading = getLocalCalendarDate(new Date(naive), tz);
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
  resolveEmailCapacity,
  resolveChannelDailyCap,
  scheduleBatchSlots,
  isWithinWindow,
  manualReleaseFor,
  nextStepDue,
  _internal: {
    getLocalCalendarDate,
    buildLocalTimestamp,
    isSameLocalDay,
    advanceToNextDayLocal,
  },
};
