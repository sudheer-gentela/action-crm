// TaskWorkComposer.js
//
// Logging daily work against a project task, from either place it is offered:
// the checklist row inside a project, and the My project work card on My day.
//
// ONE COMPONENT, NOT TWO, for the same reason dailyWorkProjectLink exists.
// Both screens have to agree on which stages are offered, how far back the
// date picker goes, what an edit looks like and which refusal text is shown.
// Two copies would agree on the day they were written and drift on the first
// fix applied to one of them, and the drift would be invisible because each
// screen looks right on its own.
//
// ── Everything load-bearing comes from the server ────────────────────
//
// The stage list, today's date and the earliest day that may be written are
// all read from GET /daily-work/tasks/:id. None of them is computed here.
//
// That is not tidiness. entry_date is the OWNER's local date, resolved
// server-side from their timezone — a browser computing "today" itself would
// disagree the moment its clock or zone differed from the one the save uses,
// and would offer a day the save then refuses. The stage list is the same
// argument: LINKED_DAY_STAGES on the server decides what postTaskUpdate will
// accept, so offering five options and refusing two would be the composer
// lying about its own contract.
//
// ── Styling ──────────────────────────────────────────────────────────
//
// Inline styles rather than the dw-* classes. This renders inside
// HandoverView, which has no daily work stylesheet loaded, so a class-based
// version would look right on My day and unstyled inside a project.

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

// Mirrors the server's MAX_DESCRIPTION and the 1000-character soft limit the
// rest of the module warns at. The server refuses over the hard limit with the
// overage named and writes nothing; this is here so the person sees it coming
// rather than losing a paste to a round trip.
const HARD_LIMIT = 2000;
const SOFT_LIMIT = 1000;

const STAGE_LABEL = {
  yet_to_start: 'Yet to start',
  in_progress:  'In progress',
  in_review:    'Sent for review',
  completed:    'Complete',
  dropped:      'Dropped',
};

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * The days that may be written, newest first.
 *
 * Built by walking from the server's `today` back to the server's `earliest`,
 * so the list cannot extend past the window even by one day. Dates are handled
 * as UTC strings throughout: a Date built from a bare YYYY-MM-DD in local time
 * is the classic way a day-picker ends up one day off east of Greenwich.
 */
function daysInWindow(today, earliest) {
  if (!today) return [];
  const out = [];
  const cursor = new Date(`${today}T00:00:00Z`);
  const floor = earliest ? new Date(`${earliest}T00:00:00Z`) : cursor;
  while (cursor >= floor && out.length < 32) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

// ── Why every control carries an explicit width and height ───────────
//
// DailyWork.css sets `.dw select, .dw textarea { width: 100% }` and
// `.dw textarea { min-height: 96px }`. Inside My day this composer renders
// under `.dw`, so a bare inline style that omits those properties loses to the
// stylesheet: the stage and date pickers stretched to full width and stacked,
// and both textareas opened three lines taller than they need to be. Inline
// wins on the properties it actually names, so they are named.
//
// The same values then apply inside HandoverView, which has no daily work
// stylesheet at all — which is the point of styling this component inline in
// the first place.
const S = {
  wrap:   { marginTop: 8, padding: '8px 10px', background: '#f8fafc',
            border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 },
  ta:     { width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4,
            border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical',
            minHeight: 46, lineHeight: 1.45, fontFamily: 'inherit' },
  taNext: { width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 4,
            border: '1px solid #d1d5db', boxSizing: 'border-box', resize: 'vertical',
            minHeight: 34, lineHeight: 1.45, fontFamily: 'inherit' },
  select: { width: 'auto', minWidth: 120, fontSize: 12, padding: '4px 6px',
            borderRadius: 4, border: '1px solid #d1d5db', fontFamily: 'inherit' },
  row:    { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 },
  primary:{ fontSize: 11, padding: '5px 12px', borderRadius: 4, background: '#0369a1',
            color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 },
  quiet:  { fontSize: 11, padding: '4px 10px', borderRadius: 4, background: '#fff',
            color: '#374151', border: '1px solid #d1d5db', cursor: 'pointer' },
  link:   { fontSize: 11, padding: 0, background: 'none', border: 'none',
            color: '#0369a1', cursor: 'pointer', textDecoration: 'underline' },
  err:    { marginTop: 6, fontSize: 11, color: '#991b1b', background: '#fef2f2',
            border: '1px solid #fecaca', borderRadius: 4, padding: '5px 8px' },
  note:   { fontSize: 11, color: '#6b7280' },
  entry:  { padding: '5px 0', borderTop: '1px solid #e5e7eb' },
  badge:  { fontSize: 10, fontWeight: 600, color: '#374151', background: '#f3f4f6',
            border: '1px solid #e5e7eb', borderRadius: 10, padding: '1px 7px' },
};

/**
 * @param playInstanceId  the task
 * @param onPosted        called after a successful post, so the surrounding
 *                        screen can refresh whatever it shows about this work
 * @param startOpen       render the composer expanded (the project checklist
 *                        opens it deliberately; My day shows the feed first)
 */
export default function TaskWorkComposer({ playInstanceId, onPosted, startOpen = false }) {
  const [state, setState]     = useState(null);
  const [loading, setLoading] = useState(false);
  // Distinct from `error`: this means the module is not available to this
  // person at all, and the whole component stands down rather than showing a
  // failure for something they were never offered.
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError]     = useState('');
  const [open, setOpen]       = useState(startOpen);

  const [date, setDate]       = useState(null);
  const [description, setDescription] = useState('');
  const [nextSteps, setNextSteps]     = useState('');
  const [nextOpen, setNextOpen]       = useState(false);
  const [stage, setStage]     = useState('in_progress');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await apiService.dailyWork.taskWork(playInstanceId);
      setState(data);
      setDate(prev => prev || data.today);
    } catch (err) {
      // requireModule('dailywork') denies with 404 rather than 403 — the
      // feature is invisible, not forbidden — so a 404 here means this person
      // does not have Daily Work, not that the task is missing.
      if (err?.response?.status === 404) setUnavailable(true);
      else setError(err?.response?.data?.error || 'Could not load the work log for this task.');
    } finally { setLoading(false); }
  }, [playInstanceId]);

  useEffect(() => { load(); }, [load]);

  // Prefill from whatever is already written for the selected day, so posting
  // twice on one day is visibly an EDIT of one row rather than an append that
  // silently replaces what was there. The server upserts on
  // (org, item, entry_date) either way; this makes that visible.
  const mine = (state?.feed || []).find(
    f => f.user_id === state?.viewerUserId && f.entry_date === date);

  useEffect(() => {
    setDescription(mine?.description || '');
    setNextSteps(mine?.next_steps || '');
    setNextOpen(false);
    setStage(mine?.day_stage || 'in_progress');
    setSaved(false);
    // Keyed on the row identity rather than the object: `mine` is a fresh
    // object on every render, and depending on it directly would reset the
    // textarea under someone mid-sentence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.entry_id, date]);

  const post = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await apiService.dailyWork.postTaskUpdate(playInstanceId, {
        description,
        nextSteps: nextSteps.trim() || null,
        dayStage: stage,
        // Omitted when it is today, so the ordinary case sends nothing to
        // argue with and the server resolves the day it would have anyway.
        date: date && state?.today && date !== state.today ? date : null,
      });
      setSaved(true);
      await load();
      onPosted?.();
    } catch (err) {
      // The server's sentence, verbatim. It knows which of the several ways a
      // post can be refused actually happened — a closed task, a stage that
      // would close the item, a day outside the window — and a generic
      // "could not save" here would throw that away.
      setError(err?.response?.data?.error || 'That could not be saved.');
    } finally { setSaving(false); }
  };

  if (unavailable) return null;
  if (loading && !state) return <div style={S.note}>Loading work log…</div>;
  if (!state) {
    return error ? <div style={S.err}>{error}</div> : null;
  }

  const feed = state.feed || [];
  const days = daysInWindow(state.today, state.earliest);
  const length = description.length;
  const overHard = length > HARD_LIMIT;
  const overSoft = length >= SOFT_LIMIT;
  const blank = !description.trim();

  return (
    <div style={S.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12, color: '#374151' }}>Daily work</b>
        <span style={S.note}>
          {feed.length === 0
            ? 'Nothing logged against this task yet'
            : `${feed.length} ${feed.length === 1 ? 'update' : 'updates'}`}
        </span>
        {state.canPost && (
          <button type="button" style={{ ...S.quiet, marginLeft: 'auto' }}
                  onClick={() => setOpen(v => !v)}>
            {open ? 'Close' : mine ? "Edit today's update" : 'Log an update'}
          </button>
        )}
      </div>

      {!state.canPost && (
        // The read still answers for closed work — reviewing what happened is
        // the case this most needs to serve — so say why there is no composer
        // rather than rendering an empty panel.
        <div style={{ ...S.note, marginTop: 6 }}>
          {state.task?.isRetired || state.task?.projectStatus === 'completed'
            || state.task?.projectStatus === 'cancelled'
            ? 'This project is closed, so there is nowhere for new work to be counted.'
            : 'This task is closed. Reopen it if there is more to do.'}
        </div>
      )}

      {open && state.canPost && (
        <div style={{ marginTop: 6 }}>
          <textarea
            aria-label="What did you do on this task"
            rows={2}
            style={{ ...S.ta, borderColor: overHard ? '#fca5a5' : '#d1d5db' }}
            value={description}
            placeholder="What did you actually do on this task?"
            onChange={e => setDescription(e.target.value)}
          />
          {overSoft && (
            <div style={{ ...S.note, color: overHard ? '#991b1b' : '#92400e' }}>
              {length} / {HARD_LIMIT}
              {overHard && ' — trim it, nothing is cut for you'}
            </div>
          )}

          {/* Next steps is optional and usually empty, so it costs a line only
              when it has content or is asked for. Same treatment as the My day
              grid, and for the same reason: an always-present second box spends
              a third of the panel on a field most updates never use. */}
          {(nextSteps || nextOpen) ? (
            <textarea aria-label="Next steps" rows={1} style={{ ...S.taNext, marginTop: 5 }}
                      autoFocus={nextOpen && !nextSteps}
                      value={nextSteps}
                      placeholder="What happens next?"
                      onChange={e => setNextSteps(e.target.value)} />
          ) : (
            <button type="button" style={{ ...S.link, marginTop: 5 }}
                    onClick={() => setNextOpen(true)}>
              + Next steps
            </button>
          )}

          <div style={S.row}>
            {/* Only the stages the server will accept. Finishing the task is
                deliberately not here: it happens on the task itself, so it
                keeps passing through whatever gating, review and evidence
                rules this project applies. */}
            <select aria-label="Stage" style={S.select} value={stage}
                    onChange={e => setStage(e.target.value)}>
              {(state.stages || []).map(s => (
                <option key={s} value={s}>{STAGE_LABEL[s] || s}</option>
              ))}
            </select>

            {days.length > 1 && (
              <select aria-label="Which day" style={S.select} value={date || state.today}
                      onChange={e => setDate(e.target.value)}>
                {days.map(d => (
                  <option key={d} value={d}>
                    {d === state.today ? 'Today' : fmtDay(d)}
                  </option>
                ))}
              </select>
            )}

            <button type="button" style={{ ...S.primary, opacity: blank || overHard ? 0.5 : 1 }}
                    disabled={saving || blank || overHard}
                    title={blank ? 'Say what you did' : undefined}
                    onClick={post}>
              {saving ? 'Saving…' : mine ? 'Save changes' : 'Post update'}
            </button>
            {saved && !saving && <span style={S.note}>Saved</span>}
            <span style={{ ...S.note, marginLeft: 'auto' }}>
              Finishing the task is a separate action on the task itself.
            </span>
          </div>
        </div>
      )}

      {error && <div style={S.err}>{error}</div>}

      {feed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {feed.map(f => (
            <div key={f.entry_id} style={S.entry}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 11, color: '#374151' }}>
                  {f.user_id === state.viewerUserId
                    ? 'You'
                    : `${f.first_name || ''} ${f.last_name || ''}`.trim() || 'Someone'}
                </b>
                <span style={S.note}>{fmtDay(f.entry_date)}</span>
                <span style={S.badge}>{STAGE_LABEL[f.day_stage] || f.day_stage}</span>
                {/* written_on later than entry_date means the day was written
                    up afterwards, inside the backfill window. Distinct from
                    edited, which is a correction to a day already written. */}
                {f.written_on && f.written_on > f.entry_date && (
                  <span style={S.note}>written {fmtDay(f.written_on)}</span>
                )}
                {f.edited && <span style={S.note}>edited</span>}
              </div>
              <div style={{ fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap' }}>
                {f.description}
              </div>
              {f.next_steps && (
                <div style={{ ...S.note, marginTop: 2 }}>Next: {f.next_steps}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
