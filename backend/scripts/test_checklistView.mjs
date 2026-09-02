// test_checklistView.mjs
//
// Standalone harness for checklistView.js — the sorting, the owner filter, the
// per-stage rollup and the current-stage rule.
//
//   node frontend/src/test_checklistView.mjs
//
// No database, no build step, no node_modules. checklistView.js is pure ES
// module with no imports, so node loads it directly.
//
// WHY A HARNESS AT ALL for a view-level change: every failure mode here is
// silent. A comparator with the operands the wrong way round produces a
// plausible order. A count that includes cancelled tasks when it should not
// produces a confident number. Neither throws, and neither is visible without
// counting rows by hand on a 49-task project.

import {
  isPlayDone, toInputDate,
  groupPlaysByStage, sortPlaysWithin,
  ownerFilterOptions, validOwnerFilter,
  buildChecklistGroups, currentStageKey,
  playMatchesOwner, readStoredSort, readStoredOwnerFilter,
  CHECKLIST_SORTS,
} from '../src/checklistView.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);

/* ── fixtures ──────────────────────────────────────────────────────────────
 *
 * Three stages in plan order, plus the ad-hoc bucket. Stage one is fully
 * closed BY WAY OF A CANCELLATION, which is the case that separates the
 * checklist's definition of done from getStageVariance's and is the whole
 * reason the strip is not fed from that endpoint.
 */
const P = (o) => ({
  id: o.id, playInstanceId: o.id, title: o.title || `T${o.id}`,
  stageKey: o.stage, stageName: o.stageName || o.stage, stageSortOrder: o.stageSort,
  sortOrder: o.sort, status: o.status || 'not_started',
  dueDate: o.due ?? null, isOverdue: !!o.overdue,
  ownerUserId: o.owner ?? null, ownerName: o.ownerName ?? null,
  stageBlockedBy: o.blockedBy || [],
});

const PRIYA = 7, MANI = 9, VIEWER = 7;

const plays = [
  // stage one — closed, and one of the closures is a CANCELLATION
  P({ id: 1, stage: 'discovery', stageSort: 10, sort: 10, status: 'completed', due: '2026-06-01', owner: PRIYA, ownerName: 'Priya Rao' }),
  P({ id: 2, stage: 'discovery', stageSort: 10, sort: 20, status: 'cancelled', due: '2026-06-02', owner: MANI,  ownerName: 'Manikanta S' }),

  // stage two — partly done, one in progress, one overdue, one unassigned
  P({ id: 3, stage: 'build', stageSort: 20, sort: 10, status: 'completed',  due: '2026-06-10', owner: PRIYA, ownerName: 'Priya Rao' }),
  P({ id: 4, stage: 'build', stageSort: 20, sort: 20, status: 'in_progress', due: '2026-06-20', owner: MANI,  ownerName: 'Manikanta S' }),
  P({ id: 5, stage: 'build', stageSort: 20, sort: 30, status: 'not_started', due: '2026-06-05', owner: PRIYA, ownerName: 'Priya Rao', overdue: true }),
  P({ id: 6, stage: 'build', stageSort: 20, sort: 40, status: 'in_review',   due: null }),

  // stage three — untouched, and entirely Manikanta's
  P({ id: 7, stage: 'uat', stageSort: 30, sort: 10, status: 'not_started', due: '2026-07-01', owner: MANI, ownerName: 'Manikanta S' }),

  // ad-hoc bucket, always last, never the current stage
  P({ id: 8, stage: 'custom', stageSort: 99, sort: 10, status: 'not_started', due: '2026-06-03', owner: PRIYA, ownerName: 'Priya Rao' }),
];

const G = (groups, key) => groups.find(g => g.key === key);
const ids = arr => arr.map(p => p.id);

/* ── done, and the timestamp trap ─────────────────────────────────────────── */

console.log('\nDEFINITIONS');
check('cancelled counts as done, same as the checklist', isPlayDone('cancelled'));
check('skipped counts as done', isPlayDone('skipped'));
check('in_review does NOT count as done', !isPlayDone('in_review'));
check('blocked does NOT count as done', !isPlayDone('blocked'));

// The reason the sort decorates rather than comparing raw strings: pg may hand
// back a DATE as either form and '2026-06-02T00:00:00.000Z' does not compare
// against '2026-06-10' the way a reader expects.
eq('a bare date normalises to itself', toInputDate('2026-06-10'), '2026-06-10');
check('a timestamp normalises to the same calendar day',
  ['2026-06-09', '2026-06-10'].includes(toInputDate('2026-06-10T00:00:00.000Z')),
  toInputDate('2026-06-10T00:00:00.000Z'));
eq('a null date is empty, not a crash', toInputDate(null), '');

/* ── grouping and stage order ─────────────────────────────────────────────── */

console.log('\nGROUPING — stage order is unchanged');
const base = groupPlaysByStage(plays);
eq('stages come back in plan order with custom pinned last',
  base.map(g => g.key), ['discovery', 'build', 'uat', 'custom']);
eq('done counts terminal statuses, cancellation included', G(base, 'discovery').done, 2);

/* ── sorting ──────────────────────────────────────────────────────────────── */

console.log('\nSORT — within a stage, never across one');
const build = G(base, 'build').items;

eq('plan order reproduces sort_order',
  ids(sortPlaysWithin(build, 'plan')), [3, 4, 5, 6]);
eq('due date is ascending with the undated row last',
  ids(sortPlaysWithin(build, 'due')), [5, 3, 4, 6]);
eq('owner sorts by name, then due date, unassigned last',
  ids(sortPlaysWithin(build, 'owner')), [4, 5, 3, 6]);

check('sorting does not mutate the input', ids(build).join() === '3,4,5,6');
eq('every advertised sort is implemented',
  CHECKLIST_SORTS.map(([k]) => k).filter(k => {
    const out = sortPlaysWithin(build, k);
    return out.length !== build.length;
  }), []);
eq('an unknown sort key falls back to plan order rather than dropping rows',
  ids(sortPlaysWithin(build, 'nonsense')), [3, 4, 5, 6]);
eq('sorting an empty stage is empty, not an error',
  sortPlaysWithin([], 'due'), []);

/* ── owner matching and the dropdown ──────────────────────────────────────── */

console.log('\nOWNER FILTER');
const opts = ownerFilterOptions(plays, VIEWER);
eq('every task is counted once', opts.total, 8);
eq('only owners with tasks are listed', opts.owners.map(o => o.name),
  ['Manikanta S', 'Priya Rao']);
eq('their counts are right', opts.owners.map(o => o.count), [3, 4]);
eq('unassigned is counted', opts.unassigned, 1);
eq('just mine counts the viewer', opts.mine, 4);

check('mine matches only the viewer',
  playMatchesOwner(plays[0], 'mine', VIEWER) && !playMatchesOwner(plays[1], 'mine', VIEWER));
check('mine matches nothing when there is no viewer id',
  !playMatchesOwner(plays[0], 'mine', null));
check('unassigned matches only the ownerless row',
  playMatchesOwner(plays[5], 'unassigned', VIEWER) && !playMatchesOwner(plays[0], 'unassigned', VIEWER));
check('a specific owner matches by id',
  playMatchesOwner(plays[1], `u:${MANI}`, VIEWER) && !playMatchesOwner(plays[0], `u:${MANI}`, VIEWER));
check('all matches everything', plays.every(p => playMatchesOwner(p, 'all', VIEWER)));

console.log('\nOWNER FILTER — a remembered value is validated against THIS project');
eq('a known owner survives', validOwnerFilter(`u:${MANI}`, opts), `u:${MANI}`);
eq('an owner with nothing here falls back to All', validOwnerFilter('u:999', opts), 'all');
eq('mine falls back when the viewer has no tasks',
  validOwnerFilter('mine', ownerFilterOptions(plays, 4242)), 'all');
eq('unassigned falls back when there are none',
  validOwnerFilter('unassigned', ownerFilterOptions(plays.filter(p => p.ownerUserId != null), VIEWER)), 'all');
eq('junk falls back', validOwnerFilter('u:abc', opts), 'all');
eq('empty falls back', validOwnerFilter('', opts), 'all');

/* ── the rollup the strip renders ─────────────────────────────────────────── */

console.log('\nROLLUP — unfiltered');
const all = buildChecklistGroups(plays, { ownerKey: 'all', sortKey: 'due', viewerUserId: VIEWER });
const b = G(all, 'build');
eq('total counts every task in the stage', b.total, 4);
eq('done counts terminal only', b.done, 1);
eq('in progress is in_progress alone — in_review is not counted', b.inProgress, 1);
eq('overdue comes from the server-computed flag', b.overdue, 1);
check('unfiltered, shown figures equal project figures',
  b.shownTotal === b.total && b.shownDone === b.done
  && b.shownInProgress === b.inProgress && b.shownOverdue === b.overdue);
check('the filtered flag is off', all.every(g => g.filtered === false));
eq('the sort is applied inside the group', ids(b.items), [5, 3, 4, 6]);
eq('allItems keeps the unfiltered list for the lock badge', ids(b.allItems), [3, 4, 5, 6]);

// The case that makes the endpoint-fed version wrong. getProjectVariance drops
// cancelled rows and calls done "completed_at IS NOT NULL", so it would report
// discovery as 1 of 1; the checklist says 2 of 2.
eq('a stage closed by a cancellation reads 2 of 2, as the rows below it do',
  [G(all, 'discovery').done, G(all, 'discovery').total], [2, 2]);

console.log('\nROLLUP — filtered to one owner');
const mine = buildChecklistGroups(plays, { ownerKey: 'mine', sortKey: 'due', viewerUserId: VIEWER });
const mb = G(mine, 'build');
check('the filtered flag is on', mine.every(g => g.filtered === true));
eq('project figures are untouched by the filter',
  [mb.total, mb.done, mb.inProgress, mb.overdue], [4, 1, 1, 1]);
eq('shown figures describe the filtered slice',
  [mb.shownTotal, mb.shownDone, mb.shownInProgress, mb.shownOverdue], [2, 1, 0, 1]);
eq('only the viewer\'s rows are listed', ids(mb.items), [5, 3]);

// The reason the filter is applied per group rather than before grouping.
const mu = G(mine, 'uat');
check('a stage with nothing for this owner stays in the list', !!mu);
eq('and is empty rather than absent', mu.items.length, 0);
eq('while still reporting the project\'s own figures', [mu.done, mu.total], [0, 1]);
eq('no stage is dropped by filtering', mine.map(g => g.key), base.map(g => g.key));

const mani = buildChecklistGroups(plays, { ownerKey: `u:${MANI}`, sortKey: 'plan', viewerUserId: VIEWER });
eq('filtering to a named owner works the same way',
  ids(G(mani, 'build').items), [4]);
eq('unassigned is filterable',
  ids(G(buildChecklistGroups(plays, { ownerKey: 'unassigned', sortKey: 'plan' }), 'build').items), [6]);

/* ── current stage ────────────────────────────────────────────────────────── */

console.log('\nCURRENT STAGE');
eq('the earliest stage that is not fully closed', currentStageKey(all), 'build');
check('parallel work in a later stage does not move it',
  currentStageKey(buildChecklistGroups(
    plays.map(p => (p.id === 7 ? { ...p, status: 'in_progress' } : p)), {})) === 'build');
eq('it does not respond to the owner filter', currentStageKey(mine), 'build');

const allClosed = plays.map(p => ({ ...p, status: 'completed' }));
eq('nothing is current once every stage is closed',
  currentStageKey(buildChecklistGroups(allClosed, {})), null);

// custom is the ad-hoc bucket, not a phase. If it could be current, a project
// with one stray added task would report itself as being "on" a stage that has
// no place in the plan.
const onlyCustomOpen = plays.map(p => (p.stageKey === 'custom' ? p : { ...p, status: 'completed' }));
eq('the ad-hoc bucket is never the current stage',
  currentStageKey(buildChecklistGroups(onlyCustomOpen, {})), null);

eq('an empty project has no current stage', currentStageKey(buildChecklistGroups([], {})), null);
eq('and produces no groups', buildChecklistGroups([], {}).length, 0);

/* ── stored preferences ───────────────────────────────────────────────────── */

console.log('\nSTORED PREFERENCES — defaults survive a hostile localStorage');
// No localStorage in node at all, which is the same path a browser with
// storage disabled takes. The defaults are what keep drag alive on a draft.
eq('draft falls back to plan order', readStoredSort('anything', 'plan'), 'plan');
eq('live falls back to due date', readStoredSort('anything', 'due'), 'due');
eq('the owner filter falls back to All', readStoredOwnerFilter(), 'all');

globalThis.localStorage = {
  getItem: (k) => (k === 'ok' ? 'owner' : 'garbage'),
};
eq('a stored sort is honoured', readStoredSort('ok', 'due'), 'owner');
eq('an unrecognised stored sort falls back', readStoredSort('bad', 'due'), 'due');
delete globalThis.localStorage;

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail === 0 ? 0 : 1);
