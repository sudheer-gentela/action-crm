// dailyWorkDay.js
//
// How a daily work screen NAMES the day it is writing to.
//
// Shared by My day (DailyWorkView) and the task composer (TaskWorkComposer),
// the two places work is logged. Both let someone step back to an earlier day
// inside the backfill window, and both used to keep saying "today" while they
// did — "Save today's work", "Edit today's update" — while the save went to the
// earlier day. People believed the label: they typed several days into one day
// and each save overwrote the last. One module so the two screens cannot drift
// back into disagreeing about which day they say they are on.
//
// Nothing here decides WHICH day it is. `today` always comes from the server,
// resolved in the owner's timezone; these functions only put words to a date
// the server already chose. Dates are 'YYYY-MM-DD' strings throughout, parsed
// component-wise into a local Date — never new Date('YYYY-MM-DD'), which the
// spec reads as UTC midnight and renders as the previous day west of UTC.

/**
 * Weekday plus date, short enough for a button: "Mon 21 Sep".
 *
 * The weekday is the part that matters when writing up last week: "21 Sep"
 * makes someone count back; "Mon" is how they remember it. Browser locale, so
 * it reads the way every other date on these screens does.
 */
export function formatDateMedium(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

/**
 * Is this date the server's today?
 *
 * A missing `today` (an older server that does not send it) counts as today,
 * because such a server only ever saves to today — so "today" is the true
 * label for whatever it is about to write.
 */
export function isServerToday(dateStr, today) {
  return !today || dateStr === today;
}

/**
 * The day as a word for sentences: "today", or "Mon 21 Sep".
 *
 * Callers add their own preposition ("for", "on"): English needs a different
 * one depending on the sentence, and "today" takes none.
 */
export function dayWord(dateStr, today) {
  return isServerToday(dateStr, today) ? 'today' : formatDateMedium(dateStr);
}
