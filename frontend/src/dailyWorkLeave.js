// dailyWorkLeave.js
//
// Days somebody was not working, on the two screens that deal with them.
//
// ── ONE COMPONENT, TWO POSITIONS ─────────────────────────────────────
//
// A manager on People marks a report's day off and it is approved as they
// click, because they are the person whose approval it needs. A member on My
// day marks their own and it is a REQUEST — pending, visible to their manager,
// and still counted against them until it is granted.
//
// That difference is a single word in the copy and one button, and it is
// decided by the SERVER either way: POST /exceptions never reads an approved
// flag from the body, it resolves one from the caller's position. `mode` here
// changes what the panel SAYS, never what it is allowed to do. If the two ever
// disagree the server wins and the panel shows the row it actually got back,
// which is why every action re-reads the list rather than patching state.
//
// Extracted rather than copied for the reason dailyWorkProjectLink.js gives:
// both screens must agree on what a leave row looks like, when Approve is
// offered and what the result sentence claims. Two copies agree on the day
// they are written and drift on the first fix applied to one of them — and the
// drift is invisible, because each screen looks right on its own.
//
// ── WHY A MEMBER CANNOT APPROVE THEIR OWN ────────────────────────────
//
// An approved day leaves that person's denominator, which raises the logging
// rate they are measured on. Self-approval would make the metric an opinion.
// The pending state is not friction for its own sake: it is what makes the
// number mean anything.

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

/** 'Mon, 7 Sep'. Local formatting from parts — never new Date(str), which
 *  parses a bare date as UTC midnight and renders as the previous day west of
 *  UTC. Same rule as everywhere else in Daily Work. */
function formatDay(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
}

// What each surface calls things. Kept as data rather than as conditionals
// scattered through the JSX, so the two readings can be compared side by side
// — which is the only way to notice that one of them has started lying.
const COPY = {
  manage: {
    heading:  'Leave and absences',
    action:   'Mark as leave',
    busy:     'Saving…',
    empty:    'Nothing marked in this window.',
    approved: (d) => `${formatDay(d)} is marked as leave and no longer counts against them.`,
    noEffect: (d) => `${formatDay(d)} is recorded, but it was not a working day for them, so no figure changes.`,
    pending:  (d) => `${formatDay(d)} is recorded and waiting for approval — it still counts until then.`,
    removed:  (d) => `${formatDay(d)} is a working day again.`,
  },
  own: {
    heading:  'Days off',
    action:   'Request a day off',
    busy:     'Sending…',
    empty:    'Nothing marked in this window.',
    // A member never gets this sentence today — their own request is always
    // pending — but the copy exists because an owner or admin marking their
    // own day IS approved on the spot, and they see this panel too.
    approved: (d) => `${formatDay(d)} is marked as leave and no longer counts against you.`,
    noEffect: (d) => `${formatDay(d)} is recorded, but it was not a working day for you, so no figure changes.`,
    pending:  (d) => `${formatDay(d)} has gone to your manager. It still counts against you until they approve it.`,
    removed:  (d) => `${formatDay(d)} is a working day again.`,
  },
};

const DEFAULT_WIDTHS = ['13%', '26%', '28%', '13%', '13%', '7%'];

/**
 * @param {number}   userId    whose days these are
 * @param {string}   [from]    window start. Omitted on My day, where the
 *                             server's default window is the authority and is
 *                             read back off the response
 * @param {string}   [to]      window end
 * @param {string}   [mode]    'manage' (a manager, on People) | 'own' (My day)
 * @param {string[]} [widths]  column widths of the table this sits under, so
 *                             the rows line up with it. Six of them
 * @param {Function} [onChanged] called after any write — the host re-reads
 *                             whatever figures it shows, because rates are
 *                             computed server-side and cannot be guessed here
 */
export function LeavePanel({ userId, from, to, mode = 'manage',
                             widths = DEFAULT_WIDTHS, onChanged }) {
  const copy = COPY[mode] || COPY.manage;

  const [rows, setRows] = useState(null);      // null = not loaded yet
  // The window actually in force. Seeded from the props and then replaced by
  // whatever the server echoes back, because My day sends none and lets the
  // server pick — and a panel captioned with a window it did not query would
  // be quietly wrong about which days it is showing.
  const [win, setWin] = useState({ from, to });
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);      // { kind, text }

  const load = useCallback(async () => {
    try {
      const { data } = await apiService.dailyWork.listLeave({
        from, to, users: String(userId) });
      setRows(data.rows || []);
      if (data.from && data.to) setWin({ from: data.from, to: data.to });
    } catch {
      // An empty list, not a stuck spinner. This is a sidecar to the day log;
      // failing to load leave must not make the screen look broken.
      setRows([]);
    }
  }, [userId, from, to]);

  useEffect(() => { load(); }, [load]);

  // Every write goes through here so the reload, the result sentence and the
  // error handling exist once rather than three times.
  const run = async (fn, okText) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await fn();
      await load();
      if (onChanged) onChanged();
      setNote({ kind: 'info', text: okText(result) });
      return true;
    } catch (err) {
      setNote({ kind: 'stop', text: err?.response?.data?.error || 'That did not go through' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !!date && !!reason.trim() && !busy;

  const mark = async () => {
    if (!canSubmit) return;
    const ok = await run(
      () => apiService.dailyWork.markLeave({ userId, date, reason }).then(r => r.data),
      (r) => {
        // Three outcomes, and they are genuinely different. Reporting them all
        // as success is how someone ends up believing a Sunday was deducted.
        if (r.countsTowardRate) return copy.approved(r.exception_date);
        if (r.approved) return copy.noEffect(r.exception_date);
        return copy.pending(r.exception_date);
      });
    // Cleared only on success: a failed save that also wiped the fields makes
    // the reader retype what they just typed to find out whether it fails the
    // same way twice.
    if (ok) { setDate(''); setReason(''); }
  };

  const loading = rows === null;

  return (
    <div className="dw-leave">
      <div className="dw-leave-head">
        <b>{copy.heading}</b>
        {/* One date, not "Mon, 7 Sep — Mon, 7 Sep". The Day period sets from
            and to to the same day, and a range that repeats itself reads as a
            rendering fault rather than as a one-day window. */}
        <span className="dw-leave-window">
          {win.from === win.to
            ? formatDay(win.from)
            : `${formatDay(win.from)} — ${formatDay(win.to)}`}
        </span>
      </div>

      {note && <div className={`dw-leave-note ${note.kind}`}>{note.text}</div>}

      {/* THE SAME COLUMNS AS THE TABLE THIS SITS UNDER, passed in by the host.
          These rows carry the same shape of fact the day rows do — a date,
          what it was, a control at the end — so they line up under them and
          are read the same way rather than as a different kind of object that
          happens to be nearby.

          Its own table, not rows appended to that one: the day rows come from
          the log and these come from the leave record, and merging them would
          put "nothing was logged" and "they were off" in one list with no way
          to tell which a row is. */}
      <table className="dw-logtable dw-leavetable">
        <colgroup>
          {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <tbody>
          {loading && (
            <tr><td colSpan={6} className="dw-item-status">Loading…</td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={6} className="dw-item-status">{copy.empty}</td></tr>
          )}

          {!loading && rows.map(r => {
            // Approve is a manager's control and the server refuses it from
            // anyone else — but offering a button that always fails is its own
            // kind of lie, so it is not rendered on My day at all.
            const canApprove = mode === 'manage' && !r.approved;
            // A member may withdraw a request nobody has acted on. Once it is
            // granted, removing it puts a working day back into their own
            // denominator, and reversing that is their manager's decision.
            const canRemove = mode === 'manage' || !r.approved;
            return (
              <tr key={r.id}>
                <td className="dw-logdate">{formatDay(r.exception_date)}</td>
                <td className="dw-logitem">
                  Leave
                  {r.approved
                    ? <span className="dw-badge">approved</span>
                    : <span className="dw-badge carried">awaiting approval</span>}
                </td>
                <td>
                  {r.reason}
                  {/* Under the reason, not folded into the badge beside it: a
                      pending day STILL COUNTS, which is the consequence the
                      reader needs rather than a restatement of the status word
                      next to it. */}
                  {!r.approved && (
                    <div className="dw-leave-still">
                      {mode === 'own'
                        ? 'Still counts against you until approved'
                        : 'Still counted until approved'}
                    </div>
                  )}
                </td>
                {/* Named here, where the day rows have to leave Activity
                    blank — a day rolls up several items with different
                    activities, but a leave day has exactly one person who
                    decided it. */}
                <td className="dw-col-activity dw-meta">
                  {r.approved
                    ? (r.approved_by_first ? `approved by ${r.approved_by_first}` : '—')
                    : (r.requested_by_first ? `asked by ${r.requested_by_first}` : '—')}
                </td>
                <td className="dw-col-initiative dw-meta" />
                <td className="dw-logactions">
                  {canApprove && (
                    <button type="button" className="dw-btn-link" disabled={busy}
                            onClick={() => run(
                              () => apiService.dailyWork.approveLeave(r.id),
                              () => `${formatDay(r.exception_date)} approved.`)}>
                      Approve
                    </button>
                  )}
                  {canRemove ? (
                    <button type="button" className="dw-btn-link" disabled={busy}
                            onClick={() => run(
                              () => apiService.dailyWork.removeLeave(r.id),
                              () => copy.removed(r.exception_date))}>
                      Remove
                    </button>
                  ) : (
                    // Said, not hidden. A row with no control and no
                    // explanation reads as a bug in the screen rather than as
                    // a decision somebody else has to reverse.
                    <span className="dw-meta">manager only</span>
                  )}
                </td>
              </tr>
            );
          })}

          {/*
            ONE ROW TO ADD ONE, in the same columns as the rows above: the date
            under the dates, the reason under the reasons. An editor whose
            fields do not line up with the values they produce makes the reader
            check, after saving, that what they typed landed where they meant.

            No <form>. On People this table is nested inside another one, where
            a form submits on Enter and reloads the page — so Enter is wired to
            the same handler as the button, because a two-field row that cannot
            be finished from the keyboard is one nobody uses twice.
          */}
          <tr className="dw-leave-add">
            <td>
              <input type="date" value={date} min={win.from} max={win.to} disabled={busy}
                     aria-label={mode === 'own' ? 'Date you were off' : 'Date they were off'}
                     onChange={e => setDate(e.target.value)} />
            </td>
            <td className="dw-logitem muted">Leave</td>
            <td colSpan={2}>
              <input type="text" value={reason} maxLength={200} disabled={busy}
                     placeholder="Reason — e.g. Leave, sick, public holiday"
                     aria-label="Reason"
                     onChange={e => setReason(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter' && canSubmit) mark(); }} />
            </td>
            {/* Two columns for the button: the actions column alone is 7% and
                would wrap the label onto three lines. */}
            <td colSpan={2} className="dw-logactions">
              <button type="button" className="dw-btn" disabled={!canSubmit} onClick={mark}>
                {busy ? copy.busy : copy.action}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default LeavePanel;
