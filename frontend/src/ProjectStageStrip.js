// ProjectStageStrip.js
//
// One block per stage, above the checklist, answering the question the product
// could not answer anywhere: "are we on stage 2 or stage 5".
//
// ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────
//
// The caller's stage groups, which are built from the SAME plays array the
// checklist rows are built from. Not from GET /sales/:id/variance/stages,
// which was the original plan and would have printed numbers that disagree
// with the rows directly underneath them:
//
//   • getProjectVariance excludes cancelled and skipped rows outright, so its
//     total is smaller than the number of rows on screen
//   • its "completed" is completed_at IS NOT NULL, whereas the checklist's
//     done is PLAY_DONE_STATUSES — completed, skipped AND cancelled. A stage
//     of six with two cancelled and two done reads 2 of 6 below and 0 of 4
//     above
//   • it returns no sort_order, and a stage whose tasks are all cancelled
//     vanishes from it entirely, so "the earliest stage not fully closed"
//     cannot be derived from it
//
// Reading the array that is already in hand costs one pass over ~50 objects,
// needs no request, and cannot drift from the checklist because there is only
// one definition of "done" in play.
//
// ── WHAT COUNTS AS WHAT ──────────────────────────────────────────────
//
// done        completed | skipped | cancelled — exactly PLAY_DONE_STATUSES,
//             so this block and the stage header below it print one number.
//             Cancelled counting as done is a consequence of that, and is the
//             right trade: two numbers for the same stage forty pixels apart
//             is worse than one number that needs a footnote.
// in progress status === 'in_progress' only. in_review and blocked are in
//             NEITHER bar segment; they sit in the grey remainder. Flagged for
//             the pilot — seven blocks carrying four numbers each stops being
//             scannable, which is the problem this exists to solve.
// overdue     play.isOverdue, the server-computed field DueChip already
//             renders, so the strip and the row agree on lateness too.

import React from 'react';

const DONE_COLOR = '#10b981';
const PROG_COLOR = '#0369a1';
const REST_COLOR = '#e5e7eb';

/**
 * Two-segment bar: done, then in progress, then the untouched remainder.
 *
 * The two segments are disjoint by construction — a task is either in a
 * terminal status or it is in_progress, never both — so the widths can be laid
 * side by side without clamping.
 */
function StageBar({ total, done, inProgress }) {
  const pctDone = total ? (done / total) * 100 : 0;
  const pctProg = total ? (inProgress / total) * 100 : 0;
  return (
    <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden',
                  background: REST_COLOR, marginTop: 8 }}>
      <div style={{ width: `${pctDone}%`, background: DONE_COLOR, transition: 'width 0.2s' }} />
      <div style={{ width: `${pctProg}%`, background: PROG_COLOR, transition: 'width 0.2s' }} />
    </div>
  );
}

/**
 * The status line under the bar.
 *
 * Says the fewest words that are true. "not started" is a real state worth
 * naming; so is "complete". Everything between them is the two counts that
 * actually prompt an action.
 */
function statusLine({ total, done, inProgress, overdue }) {
  if (total === 0) return 'nothing for this owner';
  if (done === total) return 'complete';
  const parts = [];
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (parts.length === 0) return done === 0 ? 'not started' : 'nothing in progress';
  return parts.join(' · ');
}

/**
 * @param {object[]} groups   stage groups from buildChecklistGroups()
 * @param {string}   currentKey  key of the current stage, or null
 * @param {boolean}  filtered    an owner filter is on, so each block shows the
 *                               filtered figure with the project figure beside it
 */
export default function ProjectStageStrip({ groups = [], currentKey = null, filtered = false }) {
  if (!groups.length) return null;

  // Sequenced stages are numbered 1..n. The ad-hoc 'custom' bucket is not a
  // phase of the plan and gets no number — numbering it would imply it comes
  // after sign-off rather than outside the sequence altogether.
  let ordinal = 0;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8',
                       letterSpacing: 0.4, textTransform: 'uppercase' }}>
          Where the plan stands
        </span>
        {filtered && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>
            large figure is this owner · small figure is the whole project
          </span>
        )}
      </div>

      <div style={{ display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                    gap: 10, alignItems: 'stretch' }}>
        {groups.map(g => {
          const isCustom  = g.key === 'custom';
          const n         = isCustom ? null : ++ordinal;
          const isCurrent = g.key === currentKey;

          // When a filter is on the block leads with the filtered figures and
          // carries the project's beside them. Off, there is only one set and
          // shown* equals the project figures anyway.
          const total      = filtered ? g.shownTotal      : g.total;
          const done       = filtered ? g.shownDone       : g.done;
          const inProgress = filtered ? g.shownInProgress : g.inProgress;
          const overdue    = filtered ? g.shownOverdue    : g.overdue;

          return (
            <div key={g.key} style={{
              border: `1px solid ${isCurrent ? '#7dd3fc' : '#e5e7eb'}`,
              boxShadow: isCurrent ? 'inset 0 0 0 1px #7dd3fc' : 'none',
              background: isCurrent ? '#f0f9ff' : '#fff',
              borderRadius: 10, padding: '10px 12px', minWidth: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                {n != null && (
                  <span style={{ fontSize: 11, fontWeight: 700,
                                 color: isCurrent ? '#0369a1' : '#94a3b8' }}>{n}</span>
                )}
                <span title={g.label} style={{
                  fontSize: 16, fontWeight: 500, color: '#111827', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{g.label}</span>
              </div>

              {isCurrent && (
                <div style={{ fontSize: 9, fontWeight: 700, color: '#0369a1',
                              letterSpacing: 0.4, marginTop: 2 }}>CURRENT STAGE</div>
              )}

              <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>
                <b style={{ fontWeight: 600 }}>{done} of {total} done</b>
                {filtered && (
                  <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 5 }}>
                    · {g.done} of {g.total} on the project
                  </span>
                )}
              </div>

              <StageBar total={total} done={done} inProgress={inProgress} />

              <div style={{ fontSize: 11, color: overdue > 0 ? '#991b1b' : '#6b7280',
                            marginTop: 6 }}>
                {statusLine({ total, done, inProgress, overdue })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
