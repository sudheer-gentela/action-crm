// salesResolverPolicy.js
//
// Pure policy math for the background Sales-Navigator URL resolver. No I/O — the
// caller loads the raw org JSONB (org_action_config.sales_resolver) and the raw
// user JSONB (user_preferences.preferences->'sales_resolver') and passes them in.
//
// INVARIANT (the whole point of this module): the ORG value is a HARD CEILING.
// A user may only ever make resolution MORE conservative — never exceed the org.
// Effective policy is an element-wise "more conservative wins":
//   enabled          → org.enabled AND user.enabled        (either off ⇒ off)
//   max_per_day      → min(user, org)                       (never above org)
//   min_gap_seconds  → max(user, org)                       (never below org floor)
//   quiet_hours      → union (paused if inside EITHER window)
//   require_presence → org OR user                          (either can require)
//
// A dedicated unit test (npm run test, or node scripts/…) exercises the clamp
// against adversarial user input (user tries 999/day, 1s gap, enabled while org
// disabled) to prove none of it can breach the ceiling.

// Built-in defaults — used when a key is absent from the org JSONB. These are
// deliberately safe: the resolver is OFF until an admin opts in.
const DEFAULTS = Object.freeze({
  enabled: false,
  max_per_user_per_day: 100,
  min_gap_seconds: 45,
  quiet_hours: Object.freeze({ start: '22:00', end: '07:00' }),
  require_presence: true,
});

// Absolute guardrails the ORG itself cannot exceed — a second backstop so a
// mis-set org policy (e.g. max 100000, gap 1s) still can't produce unsafe
// pacing. The org can be more conservative than these, never less.
const HARD_MAX_PER_DAY = 250;   // hard ceiling on any per-user daily cap
const HARD_MIN_GAP_SEC = 30;    // hard floor on the gap between resolves

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}
function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
// "HH:MM" → minutes since midnight, or null if malformed.
function hm(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Normalize a raw policy object (org or user) against DEFAULTS, applying the
// org hard-guardrails. Missing/malformed keys fall back to defaults.
function normalizeOrg(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: o.enabled === true,                                  // explicit opt-in
    max_per_user_per_day: clampInt(toInt(o.max_per_user_per_day, DEFAULTS.max_per_user_per_day), 0, HARD_MAX_PER_DAY),
    min_gap_seconds: Math.max(HARD_MIN_GAP_SEC, toInt(o.min_gap_seconds, DEFAULTS.min_gap_seconds)),
    quiet_hours: normalizeQuiet(o.quiet_hours) || DEFAULTS.quiet_hours,
    require_presence: o.require_presence !== false,               // default true
  };
}
function normalizeQuiet(q) {
  if (!q || typeof q !== 'object') return null;
  if (hm(q.start) == null || hm(q.end) == null) return null;
  return { start: q.start, end: q.end };
}

// Compute the effective per-user policy from raw org + raw user JSONB.
// user may be null/undefined/empty → effective == normalized org.
function effectivePolicy(rawOrg, rawUser) {
  const org = normalizeOrg(rawOrg);
  const user = (rawUser && typeof rawUser === 'object') ? rawUser : {};

  // enabled: both must be on. User defaults to ON (absent ⇒ true), so an
  // enabled org resolves unless the user explicitly opted out; a disabled org
  // is always off regardless of user.
  const userEnabled = user.enabled !== false;
  const enabled = org.enabled && userEnabled;

  // max_per_day: min(user, org). Absent user ⇒ org ceiling. Never above org.
  const userMax = (user.max_per_day == null) ? org.max_per_user_per_day
    : clampInt(toInt(user.max_per_day, org.max_per_user_per_day), 0, org.max_per_user_per_day);
  const max_per_day = Math.min(userMax, org.max_per_user_per_day);

  // min_gap_seconds: max(user, org). A user may only widen the gap.
  const userGap = (user.min_gap_seconds == null) ? org.min_gap_seconds
    : Math.max(toInt(user.min_gap_seconds, org.min_gap_seconds), org.min_gap_seconds);
  const min_gap_seconds = Math.max(userGap, org.min_gap_seconds);

  // require_presence: either side may require it.
  const require_presence = org.require_presence || (user.require_presence === true);

  // quiet_hours: keep BOTH windows; the runtime pauses if inside either.
  const userQuiet = normalizeQuiet(user.quiet_hours);
  const quiet_windows = [org.quiet_hours];
  if (userQuiet) quiet_windows.push(userQuiet);

  return { enabled, max_per_day, min_gap_seconds, require_presence, quiet_windows, org };
}

// Is `nowMinutes` (minutes since local midnight) inside any quiet window?
// Handles windows that wrap past midnight (start > end), e.g. 22:00–07:00.
function inQuietHours(quiet_windows, nowMinutes) {
  for (const w of (quiet_windows || [])) {
    const s = hm(w.start), e = hm(w.end);
    if (s == null || e == null) continue;
    if (s === e) continue;                          // zero-length window = never
    const inside = (s < e) ? (nowMinutes >= s && nowMinutes < e)
                           : (nowMinutes >= s || nowMinutes < e);   // wraps midnight
    if (inside) return true;
  }
  return false;
}

module.exports = {
  DEFAULTS,
  HARD_MAX_PER_DAY,
  HARD_MIN_GAP_SEC,
  normalizeOrg,
  effectivePolicy,
  inQuietHours,
};
