// hashNav.js — tiny shared helpers for URL-hash navigation state.
//
// The app has no router; navigation is component state mirrored into the
// URL hash so a browser refresh restores where the user was:
//
//   #/<tab>/<segment2>/<segment3>
//
// Ownership model (see App.js): App owns segment 0 (the tab); each view
// owns the segments below it and must only rewrite the hash when ITS
// segment changes — never clobbering parents' or children's segments.
// All writes use history.replaceState so the Back button keeps meaning
// "leave the app" instead of replaying every drawer ever opened.

// Lower-cased hash segments, e.g. "#/Deals/123" → ['deals', '123'].
export function hashParts() {
  return (window.location.hash || '')
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

// Segment n or null.
export function hashSegment(n) {
  return hashParts()[n] ?? null;
}

// Positive-integer segment n, or null when absent / not numeric.
export function hashIdSegment(n) {
  const v = hashParts()[n];
  const id = parseInt(v, 10);
  return Number.isInteger(id) && id > 0 && String(id) === v ? id : null;
}

// Replace the hash without adding a history entry. parts may contain
// null/undefined entries, which truncate the hash at that point:
//   writeHash(['deals', 123])  → #/deals/123
//   writeHash(['deals', null]) → #/deals
export function writeHash(parts) {
  const clean = [];
  for (const p of parts) {
    if (p === null || p === undefined || p === '') break;
    clean.push(String(p));
  }
  const desired = '#/' + clean.join('/');
  if (window.location.hash !== desired) {
    window.history.replaceState(null, '', desired);
  }
}
