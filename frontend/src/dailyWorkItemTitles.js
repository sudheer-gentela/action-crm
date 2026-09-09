// dailyWorkItemTitles.js
//
// The ITEM cell of a DAY ROLLUP ROW, shared by every screen that draws one.
//
// ── What this replaces ───────────────────────────────────────────────
//
// The cell printed "1 item". Next to it sat the day's descriptions run
// together — "Linkedin outreach for CT and Top tier prospects, research and
// drafted Linkedin content" — under a column headed Item. So the one column
// that exists to say WHAT was worked on said only HOW MANY, and the only way
// to find out was to press Details on every row in turn. On a screen whose
// whole job is scanning a team, that is the wrong default: the reader is
// looking down the column for the piece of work they care about, and a stack
// of "1 item" gives them nothing to look at.
//
// The titles were always one join away — getLog already joins daily_work_items
// for the ordering — so this costs a text[] on a query that was running
// anyway, not a second round trip.
//
// ── Why it is a module and not four copies ───────────────────────────
//
// Four rollup rows render this cell: the People list in day period, the same
// list expanded to days in week/month, the person page's timeline, and My
// day's own history. They are in two files today. Copies would agree on the
// day they were written and drift on the first fix — and the drift would be
// invisible, because each screen looks right on its own. Same reasoning as
// dailyWorkProjectLink.js, for the same reason.
//
// ── The two rules ────────────────────────────────────────────────────
//
// 1. NEVER LOSE THE COUNT. Truncating to three titles silently would turn a
//    seven-item day into a three-item day for anyone skimming, which is a
//    worse lie than "1 item" ever was. Past the cap the remainder is stated,
//    and Details still opens the full list with descriptions and labels.
//
// 2. FALL BACK, DO NOT BLANK. A backend that has not shipped item_titles yet
//    sends the rows without it. That renders exactly what this cell rendered
//    before rather than an empty column, so a staged deploy degrades to the
//    old behaviour instead of to a hole.

import React from 'react';

/**
 * The titles worth showing, cleaned.
 *
 * Anything blank is dropped rather than rendered as an empty line: the title
 * column is NOT NULL and non-blank at the database, but a row that predates
 * that constraint, or one arriving from a backend mid-deploy, should not open
 * a gap in the table.
 *
 * Exported because the caller needs to know whether it got titles before it
 * picks the cell's class — titles are content and read at full weight, the
 * count is a summary and reads muted.
 */
export function itemTitleList(titles) {
  if (!Array.isArray(titles)) return [];
  return titles
    .map(t => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);
}

/**
 * How many titles to name before summarising the rest.
 *
 * Three, because the ITEM column is a fraction of the row and a day with nine
 * items would otherwise set the row height for every other person on screen.
 * Most days are one to three items, so in the common case nothing is hidden
 * at all.
 */
const DEFAULT_LIMIT = 3;

/**
 * The cell's contents — NOT the <td>, which the caller owns because the
 * column widths and the muted class differ between the tables that use this.
 *
 * `count` is the authority on how many items the day had; the titles are what
 * can be named. They agree today (one entry per item per day, enforced by a
 * unique constraint) and the remainder line is computed from `count` anyway,
 * so if they ever stop agreeing the number stays right.
 */
export function DayItemTitles({ titles, count, limit = DEFAULT_LIMIT }) {
  const names = itemTitleList(titles);
  const n = Number.isFinite(count) ? count : names.length;

  // The old cell, unchanged, for a response that carries no titles.
  if (names.length === 0) {
    return <>{n} {n === 1 ? 'item' : 'items'}</>;
  }

  const shown = names.slice(0, limit);
  const rest = Math.max(n - shown.length, 0);

  return (
    <>
      {shown.map((title, i) => (
        // Index key: these are display strings, not records — two items on one
        // day can legitimately share a title, and the list is re-rendered whole
        // whenever the day changes.
        <div className="dw-item-name" key={i} title={title}>{title}</div>
      ))}
      {rest > 0 && (
        // Its own class rather than .dw-meta: .dw-meta carries no rule outside
        // .dw-dayrow in DailyWork.css, so borrowing it here would look styled
        // in the markup and render as plain text.
        <div className="dw-item-more">
          +{rest} more {rest === 1 ? 'item' : 'items'}
        </div>
      )}
    </>
  );
}

export default DayItemTitles;
