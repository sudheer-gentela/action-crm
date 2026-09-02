// checklistView.js
//
// The project checklist's view model: how a plays array becomes stage groups,
// how those groups are sorted and filtered, and the per-stage rollup the stage
// strip renders.
//
// ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────
//
// All of it is pure — arrays in, arrays out, no React, no DOM, no fetch — and
// it is the part of the pilot where a mistake is SILENT. A broken comparator
// does not throw; it puts the rows in a plausible wrong order that nobody
// notices for a month. A miscounted stage prints a confident number.
//
// HandoverView.js is 7,800 lines of JSX and cannot be loaded by a standalone
// node harness, so logic that lives there can only be verified by reading it.
// Extracted here it can be executed. This is the same move stageKey.js made on
// the backend, for the same reason and with the same rule attached: ONE copy.
// A second implementation of "which stage is current" or "what counts as done"
// is exactly how the strip and the rows underneath it would come to disagree.
//
// The date and terminal-status helpers came along because the logic below
// depends on them. Leaving them in HandoverView would have made this module
// import from the file that imports it — a cycle, which is the frontend form
// of the express-in-a-service problem stageKey.js was extracted to solve.
// Nothing else in the codebase referenced HandoverView's copies; DailyWorkView,
// ProspectingView, NotificationSettings and ProjectPlayModals each hold their
// own unrelated definitions and are untouched.

/**
 * Turn a date value from the API into a Date positioned on the right CALENDAR
 * DAY in the viewer's timezone.
 *
 * The trap, both halves of it:
 *
 *   • A DATE column read as an object and serialised reports the previous day
 *     east of UTC — node-postgres parses DATE at local midnight, so 2026-12-01
 *     from IST goes over the wire as 2026-11-30T18:30:00Z.
 *   • `new Date('2026-12-01')` is UTC MIDNIGHT, so it renders as 30 Nov west
 *     of UTC. Fixing the server to send a bare date and leaving this alone
 *     just moves the bug to the other hemisphere.
 *
 * So a bare 'YYYY-MM-DD' is built in LOCAL time, component by component, and
 * anything carrying a time is parsed normally. Both forms are accepted on
 * purpose: goLiveDate is fixed at the source now, but other DATE columns in
 * this module still arrive as timestamps, and this keeps working for them
 * either way.
 */
export function parseLocalDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  const s = String(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

/** 'YYYY-MM-DD' for a date input, from whichever form the API sent. */
export function toInputDate(d) {
  const dt = parseLocalDate(d);
  if (!dt || Number.isNaN(dt.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Terminal statuses. Kept as one list so a status added later does not have to
// be found in six separate inline arrays.
export const PLAY_DONE_STATUSES = ['completed', 'skipped', 'cancelled'];
export const isPlayDone = st => PLAY_DONE_STATUSES.includes(st);

// ── Stage grouping for the handover checklist ─────────────────────────────────
export const STAGE_LABELS = {
  mobilize: 'Mobilization', groundwork: 'Groundwork', installation: 'Installation',
  finishing: 'Finishing', signoff: 'Sign-off', custom: 'Added here, outside the plan',
};
export function stageLabel(key) {
  if (!key) return 'Other';
  return STAGE_LABELS[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
// Group plays by stage, in the order the server resolved; ad-hoc ('custom')
// always last.
//
// 2026_115: ordering now comes from play.stageSortOrder, which the backend
// derives from COALESCE(playbook_stages, project_stages). It used to be
// minSort — the smallest sortOrder among a group's plays — which looked
// reasonable but never worked: addPlay numbers sort_order per stage starting
// at 10, so the first play in EVERY stage was 10, all groups tied, and the
// stable sort just handed back SQL order (alphabetical by stage_key). Stages
// silently ran in the wrong sequence.
//
// minSort is kept as the tiebreak for pre-migration rows that have no
// stageSortOrder yet.
export function groupPlaysByStage(plays) {
  const map = new Map();
  for (const p of plays) {
    const key = p.stageKey || 'other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const groups = [...map.entries()].map(([key, items]) => ({
    key,
    // Server-supplied name first: it is the only one that knows this project's
    // own vocabulary. stageLabel() remains the fallback for older payloads.
    label: items.find(i => i.stageName)?.stageName || stageLabel(key),
    items,
    stageSort: items.find(i => i.stageSortOrder != null)?.stageSortOrder ?? null,
    minSort: Math.min(...items.map(i => i.sortOrder ?? 9999)),
    done: items.filter(i => isPlayDone(i.status)).length,
  }));
  groups.sort((a, b) => {
    if (a.key === 'custom') return 1;
    if (b.key === 'custom') return -1;
    const as = a.stageSort, bs = b.stageSort;
    if (as != null && bs != null && as !== bs) return as - bs;
    if (as != null && bs == null) return -1;   // defined stages before undefined
    if (as == null && bs != null) return 1;
    return a.minSort - b.minSort;
  });
  return groups;
}

// ═══════════════════════════════════════════════════════════════════════════
// Checklist view controls — sort, owner filter, per-stage rollup
// ═══════════════════════════════════════════════════════════════════════════
//
// A project has 45-50 tasks. Nobody holds that in their head, and until now
// nothing in the product answered "which stage are we on" or "who is carrying
// what". Three view-level additions, NO schema change, NO new endpoint:
//
//   the strip    per-stage rollup above the checklist (ProjectStageStrip)
//   sort         due date · owner · plan order, WITHIN each stage
//   owner filter one dropdown, counts included, unassigned a real entry
//
// All three are computed from the plays array already on screen. That is the
// whole reason the numbers can be trusted: there is one definition of "done"
// and one of "overdue" in play, so the strip cannot drift from the rows.
//
// Cost is one pass and three sorts over ~50 objects, memoised on the plays
// array and the two control values. Nothing is fetched, so a room full of
// people opening projects adds no server work at all — this is strictly less
// load than the /variance/stages call the original design would have made.

export const CHECKLIST_SORTS = [
  ['due',   'Due date'],
  ['owner', 'Owner'],
  ['plan',  'Plan order'],
];

// Where the sort preference is remembered. TWO keys, not one, and this is the
// point rather than an accident: a draft plan defaults to plan order so the
// drag handle keeps working — reordering is most of what a draft IS — and a
// live plan defaults to due date. One shared key would mean sorting a live
// project by date silently disabled reordering on the next draft you opened.
export const SORT_KEY_DRAFT = 'gw_project_checklist_sort_draft';
export const SORT_KEY_LIVE  = 'gw_project_checklist_sort_live';
export const OWNER_FILTER_KEY = 'gw_project_checklist_owner';

export function readStoredSort(storageKey, fallback) {
  try {
    const v = localStorage.getItem(storageKey);
    return CHECKLIST_SORTS.some(([k]) => k === v) ? v : fallback;
  } catch { return fallback; }
}

export function readStoredOwnerFilter() {
  try { return localStorage.getItem(OWNER_FILTER_KEY) || 'all'; }
  catch { return 'all'; }
}

/** Does this play belong to the filtered owner? */
export function playMatchesOwner(play, ownerKey, viewerUserId) {
  if (!ownerKey || ownerKey === 'all') return true;
  if (ownerKey === 'unassigned') return play.ownerUserId == null;
  if (ownerKey === 'mine') {
    return play.ownerUserId != null && viewerUserId != null
      && Number(play.ownerUserId) === Number(viewerUserId);
  }
  const m = /^u:(\d+)$/.exec(ownerKey);
  return !!m && play.ownerUserId != null
    && Number(play.ownerUserId) === Number(m[1]);
}

/**
 * Sort a stage's tasks.
 *
 * Sorting happens WITHIN a stage, never across one — the stage grouping is the
 * thing that makes 45 rows legible and no sort may break it. Someone who wants
 * one person's list end to end wants the filter, not the sort.
 *
 * Keys are precomputed once per task rather than derived inside the
 * comparator: due_date arrives as a DATE from pg and may be serialised as
 * either 'YYYY-MM-DD' or a full timestamp depending on the driver's date
 * handling, so raw string comparison is not safe. toInputDate() normalises
 * both forms and is the same function the date inputs already use.
 *
 * 'plan' reproduces _getPlays()'s ORDER BY within a stage exactly — sort_order,
 * then due date nulls last, then id — so switching back to it gives the view
 * this screen has always had, byte for byte. That matters because it is the
 * only ordering handleDropPlay() is allowed to write against.
 */
export function sortPlaysWithin(items, sortKey) {
  const decorated = items.map((p, i) => ({
    p, i,
    due:   toInputDate(p.dueDate) || '',
    owner: (p.ownerName || '').trim().toLowerCase(),
    order: p.sortOrder == null ? Number.MAX_SAFE_INTEGER : Number(p.sortOrder),
    id:    Number(p.id) || 0,
  }));

  const byDue = (a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due !== b.due) return a.due ? -1 : 1;   // dated before undated
    return 0;
  };
  const byOrder = (a, b) => (a.order - b.order) || (a.id - b.id);

  let cmp;
  if (sortKey === 'due') {
    cmp = (a, b) => byDue(a, b) || byOrder(a, b);
  } else if (sortKey === 'owner') {
    // Unassigned last. A blank owner sorting first would put the rows nobody
    // has picked up at the top of every stage, which reads as a priority
    // ordering it is not.
    cmp = (a, b) => {
      if (a.owner !== b.owner) {
        if (!a.owner) return 1;
        if (!b.owner) return -1;
        return a.owner < b.owner ? -1 : 1;
      }
      return byDue(a, b) || byOrder(a, b);
    };
  } else {
    cmp = (a, b) => byOrder(a, b) || byDue(a, b);
  }

  // Index as the final tiebreak keeps the sort stable across browsers.
  return decorated.sort((a, b) => cmp(a, b) || (a.i - b.i)).map(d => d.p);
}

export const countDone       = items => items.filter(p => isPlayDone(p.status)).length;
export const countInProgress = items => items.filter(p => p.status === 'in_progress').length;
// isOverdue is computed server-side in fmtPlay against the same terminal-status
// set as isPlayDone, so a cancelled task is never counted late here either.
export const countOverdue    = items => items.filter(p => p.isOverdue).length;

/**
 * The owner dropdown's contents, built from the UNFILTERED plays.
 *
 * The counts are the point: opening it once answers "who is carrying what",
 * which is the second question nobody could ask this product. Only owners who
 * actually have tasks on this project are listed, and Unassigned is a real
 * entry rather than an absence — imported plans produce unassigned rows
 * whenever a name matched two people, and they are otherwise invisible.
 */
export function ownerFilterOptions(plays, viewerUserId) {
  const byId = new Map();
  let unassigned = 0;
  let mine = 0;

  for (const p of plays) {
    if (p.ownerUserId == null) { unassigned++; continue; }
    const id = Number(p.ownerUserId);
    if (viewerUserId != null && id === Number(viewerUserId)) mine++;
    const entry = byId.get(id) || { id, name: '', count: 0 };
    entry.count++;
    if (!entry.name && p.ownerName) entry.name = String(p.ownerName).trim();
    byId.set(id, entry);
  }

  const owners = [...byId.values()]
    .map(o => ({ ...o, name: o.name || `User ${o.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { total: plays.length, mine, unassigned, owners };
}

/**
 * Validate a remembered owner filter against THIS project.
 *
 * The preference is stored globally, the way checklistLayout is. Without this
 * check, filtering to a colleague on one project and opening another a week
 * later would present an entirely grey checklist with no obvious cause. A
 * stored owner who has no tasks here falls back to All; 'mine' and
 * 'unassigned' are project-independent but still only survive when they would
 * actually match something.
 */
export function validOwnerFilter(ownerKey, options) {
  if (!ownerKey || ownerKey === 'all') return 'all';
  if (ownerKey === 'mine')       return options.mine > 0 ? 'mine' : 'all';
  if (ownerKey === 'unassigned') return options.unassigned > 0 ? 'unassigned' : 'all';
  const m = /^u:(\d+)$/.exec(ownerKey);
  if (m && options.owners.some(o => o.id === Number(m[1]))) return ownerKey;
  return 'all';
}

/**
 * Stage groups, decorated with everything the strip and the headers need.
 *
 * The filter is applied to each group's ITEMS, never to the plays before
 * grouping. That is what keeps a stage with nothing for the filtered owner on
 * screen, greyed, rather than vanishing — so the shape of the plan stays
 * legible while you look at one person's slice of it.
 *
 * Project-level counts (total, done, inProgress, overdue) are always computed
 * over the unfiltered items, and the filtered ones live alongside as shown*.
 * The strip leads with the filtered figure and carries the project's beside
 * it; the stage headers lead with the project's. Neither ever has to guess.
 */
export function buildChecklistGroups(plays, { ownerKey = 'all', sortKey = 'plan', viewerUserId = null } = {}) {
  const filtered = ownerKey !== 'all';
  return groupPlaysByStage(plays).map(g => {
    const all   = g.items;
    const shown = filtered
      ? all.filter(p => playMatchesOwner(p, ownerKey, viewerUserId))
      : all;
    const items = sortPlaysWithin(shown, sortKey);
    return {
      ...g,
      allItems:        all,
      items,
      total:           all.length,
      done:            g.done,
      inProgress:      countInProgress(all),
      overdue:         countOverdue(all),
      filtered,
      shownTotal:      items.length,
      shownDone:       filtered ? countDone(items) : g.done,
      shownInProgress: filtered ? countInProgress(items) : countInProgress(all),
      shownOverdue:    filtered ? countOverdue(items) : countOverdue(all),
    };
  });
}

/**
 * Which stage the project is ON.
 *
 * DEFINED rather than guessed: the earliest stage in plan order that is not
 * fully closed. Deterministic, needs no new column, and matches how people
 * talk — parallel work in a later stage does not move it, because you are
 * still on stage 2 while stage 2 is unfinished.
 *
 * 'custom' is excluded. It is the ad-hoc bucket for work added outside the
 * plan, not a phase, and calling it the current stage would say the project
 * had reached a point it has no notion of. Returns null once every sequenced
 * stage is closed, and nothing is accented.
 */
export function currentStageKey(groups) {
  const g = groups.find(x => x.key !== 'custom' && x.done < x.total);
  return g ? g.key : null;
}

