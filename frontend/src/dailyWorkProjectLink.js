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
 * @param who  optional trailing meta — the person's name, on screens that mix
 *             several people's work into one list. Omitted on a single
 *             person's timeline, where repeating their name on every row is
 *             noise.
 */
export function ProjectItemRow({ item, person, period, anchorDate, filters, onRefuse, who = null }) {
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

  const body = (
    <>
      <div className="t">
        <span className={`dw-badge ${item.isOverdue ? 'carried' : ''}`}>
          {item.kind === 'commitment' ? 'commitment due' : 'task due'}
        </span>
        <b>{item.title}</b>
        {item.isOverdue && <span className="dw-badge carried">overdue</span>}
      </div>
      <div className="dw-meta">
        {who ? `${who} · ` : ''}{item.project}{item.isStanding ? ' · standing' : ''}
        {typeof item.daysOver === 'number' &&
          ` · ${item.daysOver} ${item.daysOver === 1 ? 'day' : 'days'} over`}
        {linkable && <> · {busy ? 'opening…' : 'open this task'}</>}
      </div>
    </>
  );

  if (!linkable) return <div className="dw-detail-item">{body}</div>;

  // A button, not an anchor: there is no URL to put in href — the destination
  // is decided by the server's scope answer, which arrives after the click.
  // A bare <a> with no href is unreachable by keyboard and announces nothing.
  return (
    <button type="button" className="dw-detail-item" onClick={open} disabled={busy}
            style={{ display: 'block', width: '100%', textAlign: 'left',
                     background: 'none', font: 'inherit', cursor: busy ? 'wait' : 'pointer' }}>
      {body}
    </button>
  );
}

