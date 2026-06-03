/**
 * repTimezone.js — shared helpers for per-rep timezone handling.
 *
 * Two concerns live here so every caller formats identically:
 *   - isValidTimeZone(tz): true if `tz` is an IANA zone Node can resolve.
 *   - formatStampInZone(date, tz): a human stamp in the rep's zone, e.g.
 *       "2026-06-02 16:52 GMT+5:30"  (Asia/Kolkata)
 *       "2026-06-02 07:22 EDT"       (America/New_York)
 *       "2026-06-02 11:22 UTC"       (tz null / unknown → UTC, explicitly labelled)
 *
 * We store IANA names (not fixed GMT offsets) so the offset — and DST —
 * is computed for the actual date. NULL/invalid zones print as UTC.
 */

// Validate by asking Intl to resolve it. We deliberately do NOT check
// membership in Intl.supportedValuesOf('timeZone') — that list is canonical
// only (e.g. it has 'Asia/Calcutta' but not its alias 'Asia/Kolkata', which is
// what browsers actually emit). The constructor accepts canonical names AND
// aliases and throws on garbage, which is exactly the test we want.
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

// Format `date` as "YYYY-MM-DD HH:MM <ZONELABEL>" in the given zone.
// Unknown / null zones format in UTC and are labelled "UTC".
function formatStampInZone(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const zone = isValidTimeZone(tz) ? tz : 'UTC';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:     zone,
    year:         'numeric',
    month:        '2-digit',
    day:          '2-digit',
    hour:         '2-digit',
    minute:       '2-digit',
    hour12:       false,
    timeZoneName: 'short',
  }).formatToParts(d);

  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  const label = zone === 'UTC' ? 'UTC' : (get('timeZoneName') || 'UTC');

  // Intl can emit "24" for midnight under hour12:false on some ICU builds.
  const hour = get('hour') === '24' ? '00' : get('hour');

  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')} ${label}`;
}

module.exports = { isValidTimeZone, formatStampInZone };
