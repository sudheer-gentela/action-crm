// dailyWorkProjectLink.js
//
// The one path from Daily Work into a project, shared by the two screens that
// offer it: a manager reading someone's timeline on People, and a person
// reading their own on My day.
//
// EXTRACTED RATHER THAN COPIED, and the reason is the whole point of the
// module. Both screens must agree on what a task row looks like, when the link
// is offered, what the crumb carries, and which refusal text is shown. Two
// copies would agree on the day they were written and drift on the first fix
// applied to one of them — and the drift would be invisible, because each
// screen looks right on its own.

import React, { useState } from 'react';
import { apiService } from './apiService';
import TaskWorkComposer from './TaskWorkComposer';

/**
 * The return crumb.
 *
 * Written when someone leaves Daily Work for a project, read by HandoverView
 * to offer a way back. Same shape as AgencyView's 'gwc_agency_deeplink':
 * JSON in sessionStorage, plus a CustomEvent for the case where the target
 * view is already mounted.
 *
 * sessionStorage rather than the URL, for three reasons that all point the
 * same way. writeHash uses history.replaceState on purpose — see hashNav.js,
 * "so the Back button keeps meaning leave the app" — so browser Back was
 * never going to bring anyone back here, and the return has to be explicit UI
 * either way. It survives a refresh, which is what someone mid-task needs. And
 * a pasted link must NOT tell the recipient to go back to Priya's day: they
 * were never there, and that crumb would be a lie about their own history.
 *
 * The period and anchor date travel with it because the People screen keeps
 * them in component state, not in the URL, and the module unmounts on tab
 * switch. Without them a manager on Week comes back to Day and has to find
 * their place again, which is the exact friction this is meant to remove.
 */
export const RETURN_KEY = 'gwc_dailywork_return';

export function writeReturnCrumb(person, period, anchorDate, filters) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({
      userId:  person.user_id,
      name:    `${person.first_name} ${person.last_name}`.trim(),
      period:  period || null,
      anchor:  anchorDate || null,
      filters: filters || null,
    }));
  } catch { /* private mode, quota — the link still works, just no crumb back */ }
}

/**
 * One project task or commitment on someone's timeline.
 *
 * Checks the link before navigating rather than after. The basis for offering
 * it is derived — this person, in your team, has this task open — and that can
 * lapse between the page loading and the click. Navigating first and
 * discovering it there would dump the manager on a project with no explanation
 * of why they are looking at it.
 *
 * Commitments are NOT linked. They live on the same details tab, but nothing
 * scrolls to a specific one and the derived check keys on project tasks, so a
 * link would land somewhere vague. Left as a plain row until that is built.
 */
/**
 * "Open this task", as a hook.
 *
 * EXTRACTED so the row layout and the table layout share one copy. The check
 * before navigating, the crumb, the event shape and the refusal text are four
 * things two layouts would otherwise each own, and the drift would be
 * invisible because each looks right on its own — the same argument that put
 * ProjectItemRow in this file rather than in two screens.
 *
 * Checks the link BEFORE navigating rather than after. The basis for offering
 * it is derived — this person has this task open — and that can lapse between
 * the page loading and the click. Navigating first and discovering it there
 * would dump the reader on a project with no explanation of why they are
 * looking at it.
 */
export function useOpenProjectTask({ item, person, period, anchorDate, filters, onRefuse }) {
  const [busy, setBusy] = useState(false);

  // Both required. handoverId says which project; playInstanceId says which
  // row inside it. Without the second the link still works but lands on a
  // checklist of thirty tasks with nothing open, which is the hunt this was
  // built to remove — so it is a condition of offering the link, not a bonus.
  const linkable = item.kind === 'task' && !!item.handoverId && !!item.playInstanceId;

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await apiService.dailyWork.checkProjectLink(person.user_id, item.handoverId);
      writeReturnCrumb(person, period, anchorDate, filters);
      window.dispatchEvent(new CustomEvent('open-project-task', {
        detail: {
          handoverId: item.handoverId,
          playInstanceId: item.playInstanceId,
          scope: data.scope,
          sub: 'details',
        },
      }));
    } catch (err) {
      // The server's sentence, not ours. It knows which of the several ways
      // the basis can lapse actually happened; a generic "could not open"
      // here would throw that away.
      onRefuse?.(err?.response?.data?.reason
        || 'That project could not be opened just now.');
      setBusy(false);
    }
  };

  return { open, busy, linkable };
}

/**
 * How the due date reads on a row.
 *
 * The LATE flag is the server's — item.isOverdue, computed in
 * getPersonProjectItems against the server's clock, because "overdue" has to
 * mean the same thing here as it does in the manager's count and a browser
 * comparing a date string against its own clock is how the two drift apart.
 *
 * The countdown is presentation only, and needs a `today` the browser did not
 * invent: My day passes the server-resolved local date it already has. Without
 * it there is no countdown, just the date — which is still an improvement on
 * what was here before, which was a badge reading "task due" on a task due in
 * three weeks.
 */
export function dueText(item, today) {
  if (!item.dueDate) return item.isStanding ? 'no end date' : 'no due date';

  const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', timeZone: 'UTC' });

  if (item.isOverdue) {
    const over = typeof item.daysOver === 'number' ? item.daysOver : daysBetween(today, item.dueDate);
    return over != null && over > 0
      ? `overdue by ${over} ${over === 1 ? 'day' : 'days'} · was due ${fmt(item.dueDate)}`
      : `overdue · was due ${fmt(item.dueDate)}`;
  }

  const days = daysBetween(today, item.dueDate);
  if (days == null) return `due ${fmt(item.dueDate)}`;
  if (days < 0)  return `due ${fmt(item.dueDate)}`;
  if (days === 0) return `due today`;
  if (days === 1) return `due tomorrow · ${fmt(item.dueDate)}`;
  return `due in ${days} days · ${fmt(item.dueDate)}`;
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Null if either is missing. */
export function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * @param who  optional trailing meta — the person's name, on screens that mix
 *             several people's work into one list. Omitted on a single
 *             person's timeline, where repeating their name on every row is
 *             noise.
 * @param canLog  offer the composer on this row. TRUE only on My day, where
 *             the person reading is the person who did the work. A manager on
 *             the People screen is looking at somebody else's timeline, and
 *             saveDay refuses an entry written for another owner
 *             (NOT_YOUR_ITEM) — so a composer there would be a control that
 *             cannot succeed. Defaults to false, which is the safe direction:
 *             a screen that forgets to pass it loses a convenience rather
 *             than offering an impossible write.
 * @param today   the server-resolved local date, for the due countdown only.
 * @param onPosted  bubbled up so the surrounding screen can refresh; a new
 *             update creates a daily work item that My day's log has to pick up.
 */
export function ProjectItemRow({ item, person, period, anchorDate, filters, onRefuse,
                                who = null, canLog = false, today = null, onPosted = null,
                                // 'card' (default) keeps My Day and the overdue
                                // queue exactly as they are; 'link' is the bare
                                // control for a table cell.
                                variant = 'card' }) {
  const [logging, setLogging] = useState(false);
  const { open, busy, linkable } = useOpenProjectTask({
    item, person, period, anchorDate, filters, onRefuse });
  // Commitments carry no playInstanceId and have no link column behind them,
  // so there is nothing for an update to attach to. Left as a plain row, the
  // same way they are left unlinked above.
  const loggable = canLog && item.kind === 'task' && !!item.playInstanceId;

  // TITLE AND DUE ON ONE LINE, project and controls on the next. It was three
  // lines: a badge reading "task due", the title, then the project — and the
  // badge said the same words whether the task was six days late or three
  // weeks away, which is the one thing someone scanning this list needs to
  // tell apart.
  const body = (
    <>
      <div className="t">
        <b>{item.title}</b>
        <span className={`dw-badge ${item.isOverdue ? 'carried' : ''}`}>
          {dueText(item, today)}
        </span>
        {item.kind === 'commitment' && <span className="dw-badge">commitment</span>}
      </div>
      <div className="dw-meta">
        {who ? `${who} · ` : ''}{item.project}{item.isStanding ? ' · standing' : ''}
      </div>
    </>
  );

  // ── The plain row: neither link nor composer ──────────────────────────
  // ── variant="link": the CONTROL only, no card body (2026_140) ─────────
  //
  // The person page renders its tasks as table rows now, so the title, project
  // and due date are already columns — and repeating them inside a card in the
  // actions cell would print each one twice. What that screen needs from this
  // component is the one thing worth sharing: the open-this-task behaviour,
  // with its crumb, its liveness check and its refusal text.
  //
  // A VARIANT rather than a second component, for the reason in this file's
  // header. Two copies of the link would agree on the day they were written
  // and drift on the first fix applied to one of them, invisibly, because each
  // screen looks right on its own.
  //
  // Returns a fragment, not a div: this renders inside a <td> beside a sibling
  // button, and a block wrapper would push that button onto its own line.
  if (variant === 'link') {
    if (!linkable) return null;
    return (
      <button type="button" className="dw-btn-link" onClick={open} disabled={busy}>
        {busy ? 'opening…' : 'Open'}
      </button>
    );
  }

  if (!linkable && !loggable) return <div className="dw-detail-item">{body}</div>;

  // ── Otherwise a container with its own controls ───────────────────────
  //
  // This used to BE a button, with the whole row as the click target. It
  // cannot stay one: a composer nested inside a button is invalid markup and
  // browsers do unpredictable things with the inner controls. So the row is a
  // div again and each affordance is its own button — which also separates
  // "open this task" from "log against it", two actions that were never the
  // same click.
  return (
    <div className="dw-detail-item">
      {body}
      <div className="dw-meta" style={{ display: 'flex', gap: 10, marginTop: 2 }}>
        {linkable && (
          <button type="button" className="dw-btn-link" onClick={open} disabled={busy}>
            {busy ? 'opening…' : 'open this task'}
          </button>
        )}
        {loggable && (
          <button type="button" className="dw-btn-link"
                  aria-expanded={logging}
                  onClick={() => setLogging(v => !v)}>
            {logging ? 'hide daily work' : 'log work on this'}
          </button>
        )}
      </div>
      {loggable && logging && (
        <TaskWorkComposer playInstanceId={item.playInstanceId}
                          startOpen
                          onPosted={onPosted} />
      )}
    </div>
  );
}

