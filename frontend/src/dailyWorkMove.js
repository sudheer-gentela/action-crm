// dailyWorkMove.js
//
// The screens for moving daily work onto a project plan (2026_142).
//
// ── WHO SEES WHAT ────────────────────────────────────────────────────
//
//   MoveRequestForm      the person, on My day, or their manager, on People —
//                        pick the project and the entries, and ask
//   MovePromptCard       My day: items tagged to a project that are not on its
//                        plan, shown every day until asked about or closed
//   MoveReviewSection    My day, inside "Awaiting your review": requests
//                        waiting on a project the viewer manages
//   MoveApprovalPanel    the approver: leave entries out, choose the task (or
//                        plan a new one and see what it does to the plan), then
//                        approve or reject
//   MyMoveRequestsCard   My day: the person's waiting requests, the
//                        retire-or-keep question, and entries a move flagged
//   MoveRequestStatus    one request in full, with withdraw and add-entries
//
// ── ONE MODULE, SEVERAL SCREENS ──────────────────────────────────────
//
// Extracted for the reason dailyWorkLeave.js and dailyWorkProjectLink.js give:
// My day and People must agree on what a request looks like and which controls
// it offers, and two copies agree on the day they are written and drift on the
// first fix.
//
// ── THE SERVER DECIDES ───────────────────────────────────────────────
//
// Every rule is enforced in dailyWorkMove.service. Controls are hidden or
// disabled here only so nobody is offered something that will be refused, and
// every refusal shows the server's own sentence. After any action the component
// re-reads rather than patching local state, because the move itself —
// merges, left-out entries, a second batch moving — is decided server-side and
// a guess here would be wrong in exactly the interesting cases.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiService } from './apiService';

/* ───────────────────────── helpers ─────────────────────────────────── */

const MAX_TEXT = 2000;

function readError(err, fallback) {
  return err?.response?.data?.error || err?.response?.data?.reason || err?.message || fallback;
}

/** 'Mon, 7 Sep', from parts — never new Date('YYYY-MM-DD'), which is UTC midnight. */
function formatDay(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
}

const OUTCOME_LABEL = {
  pending: 'waiting',
  moved: 'moved',
  merged: 'merged into the task entry for that day',
  left_out_too_long: 'left out for now — too long to merge',
  excluded: 'not moved',
};

const STATUS_LABEL = {
  pending: 'waiting for a decision',
  approved: 'moved',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
};

const CLOSED_TASK = ['completed', 'skipped', 'cancelled'];

/** Is this daily work item one that could be asked about? Mirrors assertItemMovable. */
export function isMovableRow(row) {
  if (!row || row.play_instance_id) return false;
  if (row.kind === 'assigned') return ['yet_to_start', 'in_progress', 'in_review'].includes(row.status);
  return row.status === 'active';
}

/**
 * The separator mergePair puts between two texts. The same template string as
 * the service, so the editor's count is the count the server will check.
 */
function mergedLength(taskText, originalText, itemTitle) {
  const sep = `\n\n— moved from "${itemTitle || ''}" —\n`;
  return (taskText || '').length + sep.length + (originalText || '').length;
}

/* ───────────────────────── raising a request ───────────────────────── */

/**
 * Ask for an item's work to move onto a project.
 *
 * ENTRIES START CHECKED when their saved tag is the chosen project — the work
 * already says where it belongs. Everything else starts unchecked for the
 * requester to pick, which is the agreed rule for untagged work. Changing the
 * project re-applies that default until the requester has ticked anything
 * themselves; after that their choices are left alone.
 *
 * @param forName  shown on People, where a manager is asking for someone else
 */
export function MoveRequestForm({ itemId, forName = null, onDone, onCancel }) {
  const [opts, setOpts] = useState(null);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apiService.dailyWork.moveOptions(itemId)
      .then(({ data }) => {
        if (!alive) return;
        setOpts(data);
        const it = data.item;
        const own = it.lockedTargetId
          || (it.anchor_kind === 'handover' && data.targets.some(t => t.id === it.anchor_id) ? it.anchor_id : null);
        if (own) setTarget(String(own));
      })
      .catch(err => { if (alive) setError(readError(err, 'Could not load this item.')); });
    return () => { alive = false; };
  }, [itemId]);

  const targetId = target ? Number(target) : null;

  // The default selection follows the project until the requester takes over.
  useEffect(() => {
    if (!opts || touched) return;
    setSelected(new Set(opts.entries
      .filter(e => !e.in_other_request && targetId
                && e.anchor_kind === 'handover' && e.anchor_id === targetId)
      .map(e => e.id)));
  }, [opts, targetId, touched]);

  const disabledReason = (e) => {
    if (e.in_other_request) return 'already part of another request';
    if (e.anchor_is_standing && e.anchor_id !== targetId) return `belongs to the ${e.anchor_label} initiative`;
    return null;
  };

  const toggle = (id) => {
    setTouched(true);
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!targetId) return;
    setBusy(true);
    setError(null);
    try {
      // Drop anything the current project makes ineligible, so switching the
      // project after ticking cannot send an entry the server will refuse.
      const entryIds = opts.entries.filter(e => selected.has(e.id) && !disabledReason(e)).map(e => e.id);
      const { data } = await apiService.dailyWork.createMoveRequest({
        itemId, targetHandoverId: targetId, entryIds, note: note.trim() || null });
      onDone?.(data);
    } catch (err) {
      setError(readError(err, 'Could not send the request.'));
      setBusy(false);
    }
  };

  if (error && !opts) return <div className="dw-banner stop">{error}</div>;
  if (!opts) return <div className="dw-item-status">Loading…</div>;

  const { item, entries, totalEntries, targets } = opts;
  const projects = targets.filter(t => t.tracking_mode !== 'standing');
  const initiatives = targets.filter(t => t.tracking_mode === 'standing');
  const chosen = entries.filter(e => selected.has(e.id) && !disabledReason(e)).length;

  if (!item.movable) {
    return (
      <div className="dw-move">
        <div className="dw-banner warn" style={{ marginBottom: 0 }}>{item.reason}</div>
        {item.open_request_id && (
          <div style={{ marginTop: 10 }}><MoveRequestStatus requestId={item.open_request_id} /></div>
        )}
        {onCancel && (
          <div className="dw-move-actions"><button className="dw-btn dw-btn-sm" onClick={onCancel}>Close</button></div>
        )}
      </div>
    );
  }

  return (
    <div className="dw-move">
      <div className="dw-item-title" style={{ margin: 0 }}>
        Move “{item.title}” onto a project{forName ? ` for ${forName}` : ''}
      </div>
      <div className="dw-meta" style={{ marginTop: 4 }}>
        The project’s manager decides, and chooses the task it goes on. Work tagged to another
        project also needs that project’s manager to agree.
      </div>

      <div className="dw-field">
        <label htmlFor={`dw-move-target-${itemId}`}>Project</label>
        <select id={`dw-move-target-${itemId}`} value={target}
                disabled={!!item.lockedTargetId}
                onChange={e => setTarget(e.target.value)}>
          <option value="">Choose a project</option>
          {projects.length > 0 && (
            <optgroup label="Projects">
              {projects.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </optgroup>
          )}
          {initiatives.length > 0 && (
            <optgroup label="Initiatives">
              {initiatives.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </optgroup>
          )}
        </select>
        {item.lockedTargetId && (
          <div className="dw-item-status">This item belongs to an initiative, so it can only move within it.</div>
        )}
      </div>

      <div className="dw-field">
        <label>Entries to move · {chosen} chosen</label>
        {entries.length === 0 ? (
          <div className="dw-item-status">
            Nothing has been logged on this item yet. Once the move is approved, new work goes to the task.
          </div>
        ) : (
          <div className="dw-move-list" role="group" aria-label="Entries to move">
            {entries.map(e => {
              const why = disabledReason(e);
              return (
                <label key={e.id} className={`dw-move-row ${why ? 'off' : ''}`}>
                  <input type="checkbox" disabled={!!why}
                         checked={selected.has(e.id) && !why}
                         onChange={() => toggle(e.id)} />
                  <span className="when">{formatDay(e.entry_date)}</span>
                  <span className="what">
                    <span className="dw-clamp-2">{e.description}</span>
                    {e.anchor_label && <span className="dw-badge" style={{ marginTop: 3 }}>{e.anchor_label}</span>}
                    {why && <span className="dw-meta" style={{ display: 'block' }}>Cannot move: {why}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {totalEntries > entries.length && (
          <div className="dw-item-status">
            Showing the latest {entries.length} of {totalEntries}. Older entries stay where they are.
          </div>
        )}
      </div>

      <div className="dw-field">
        <label htmlFor={`dw-move-note-${itemId}`}>Note for the project manager (optional)</label>
        <textarea id={`dw-move-note-${itemId}`} value={note} maxLength={MAX_TEXT}
                  placeholder="Why this belongs on the plan"
                  onChange={e => setNote(e.target.value)} />
      </div>

      {error && <div className="dw-banner stop" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

      <div className="dw-move-actions">
        <button className="dw-btn dw-btn-sm dw-btn-primary" disabled={!targetId || busy} onClick={submit}>
          {busy ? 'Sending…' : 'Ask to move'}
        </button>
        {onCancel && <button className="dw-btn dw-btn-sm" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

/* ───────────────────────── one request ─────────────────────────────── */

/**
 * A request in full: where it stands, who decided what, and what happened to
 * each entry. The requester can withdraw what is waiting, and add entries
 * logged since until the first part has moved.
 */
export function MoveRequestStatus({ requestId, viewerId = null, onChanged }) {
  const [req, setReq] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);   // null | { entries, picked:Set }
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiService.dailyWork.moveRequest(requestId)
      .then(({ data }) => { setReq(data); setError(null); })
      .catch(err => setError(readError(err, 'Could not load the request.')));
  }, [requestId]);

  useEffect(() => { load(); }, [load]);

  const after = () => { load(); onChanged?.(); };

  if (error) return <div className="dw-banner stop">{error}</div>;
  if (!req) return <div className="dw-item-status">Loading…</div>;

  const isRequester = viewerId != null
    && (req.requested_by != null ? req.requested_by === viewerId : req.owner_user_id === viewerId);

  const withdraw = async () => {
    if (!window.confirm('Withdraw what is still waiting on this request?')) return;
    setBusy(true);
    try { await apiService.dailyWork.withdrawMoveRequest(requestId); after(); }
    catch (err) { setError(readError(err, 'Could not withdraw.')); }
    finally { setBusy(false); }
  };

  const startAdding = async () => {
    try {
      const { data } = await apiService.dailyWork.moveOptions(req.item_id);
      const already = new Set(req.entries.map(e => e.entry_id));
      setAdding({
        entries: data.entries.filter(e => !already.has(e.id) && !e.in_other_request
          && !(e.anchor_is_standing && e.anchor_id !== req.target_handover_id)),
        picked: new Set(),
      });
    } catch (err) { setError(readError(err, 'Could not load the entries.')); }
  };

  const addPicked = async () => {
    setBusy(true);
    try {
      await apiService.dailyWork.addMoveEntries(requestId, [...adding.picked]);
      setAdding(null);
      after();
    } catch (err) { setError(readError(err, 'Could not add those entries.')); }
    finally { setBusy(false); }
  };

  const batchOf = (id) => req.batches.find(b => b.id === id);

  return (
    <div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
        <b>“{req.item_title}”</b> → <b>{req.target_name}</b>{' '}
        <span className={`dw-badge ${req.status === 'rejected' ? 'carried' : req.status === 'approved' ? 'new' : 'review'}`}>
          {STATUS_LABEL[req.status] || req.status}
        </span>
        {req.status === 'approved' && req.is_open && <span className="dw-badge review">more waiting</span>}
      </div>
      <div className="dw-meta">
        Asked by {req.requested_by_name || 'someone no longer here'}{req.owner_name && req.requested_by !== req.owner_user_id ? ` for ${req.owner_name}` : ''}
        {req.task_title && <> · on the task “{req.task_title}”</>}
      </div>
      {req.note && <div className="dw-prior" style={{ marginTop: 8 }}>{req.note}</div>}

      {req.batches.map(b => (
        <div key={b.id} style={{ marginTop: 10 }}>
          {req.batches.length > 1 && (
            <div className="dw-meta"><b>Part {b.batch_no}</b> · {STATUS_LABEL[b.status] || b.status}</div>
          )}
          {req.approvals.filter(a => a.batch_id === b.id).map(a => (
            <div key={a.id} className="dw-meta">
              {a.project_name} ({a.role === 'target' ? 'moving to' : 'tagged work'}):{' '}
              {a.decision === 'pending' ? 'waiting'
                : `${a.decision} by ${a.decided_by_name || 'someone no longer here'}`}
              {a.reason && <> — “{a.reason}”</>}
            </div>
          ))}
        </div>
      ))}

      {req.entries.length > 0 && (
        <div className="dw-move-list" style={{ marginTop: 10 }}>
          {req.entries.map(e => (
            <div key={e.id} className={`dw-move-row ${['excluded'].includes(e.outcome) ? 'off' : ''}`}>
              <span className="when">{formatDay(e.entry_date)}</span>
              <span className="what">
                <span className="dw-clamp-2">{e.snap_description}</span>
                <span className="dw-meta" style={{ display: 'block' }}>
                  {!e.selected && e.outcome === 'pending' ? 'left out by an approver'
                    : OUTCOME_LABEL[e.outcome] || e.outcome}
                  {req.batches.length > 1 && batchOf(e.batch_id) && ` · part ${batchOf(e.batch_id).batch_no}`}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {isRequester && (req.is_open || req.status === 'pending') && !adding && (
        <div className="dw-move-actions">
          {req.status === 'pending' && (
            <button className="dw-btn dw-btn-sm" disabled={busy} onClick={startAdding}>Add entries logged since</button>
          )}
          {req.is_open && (
            <button className="dw-btn dw-btn-sm" disabled={busy} onClick={withdraw}>Withdraw</button>
          )}
        </div>
      )}

      {adding && (
        <div className="dw-field">
          <label>Entries to add</label>
          {adding.entries.length === 0 ? (
            <div className="dw-item-status">There is nothing else on this item to add.</div>
          ) : (
            <div className="dw-move-list">
              {adding.entries.map(e => (
                <label key={e.id} className="dw-move-row">
                  <input type="checkbox" checked={adding.picked.has(e.id)}
                         onChange={() => setAdding(a => {
                           const picked = new Set(a.picked);
                           if (picked.has(e.id)) picked.delete(e.id); else picked.add(e.id);
                           return { ...a, picked };
                         })} />
                  <span className="when">{formatDay(e.entry_date)}</span>
                  <span className="what"><span className="dw-clamp-2">{e.description}</span></span>
                </label>
              ))}
            </div>
          )}
          <div className="dw-move-actions">
            <button className="dw-btn dw-btn-sm dw-btn-primary" disabled={busy || adding.picked.size === 0}
                    onClick={addPicked}>Add to the request</button>
            <button className="dw-btn dw-btn-sm" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── deciding ────────────────────────────────── */

/**
 * The approver's panel for one project on one request.
 *
 * THE TARGET, on the first part, also chooses where the work goes: an open
 * task, or a new one. A new task must be CHECKED against the plan before it can
 * be approved, and checked again if anything about it changes — seeing what it
 * does to the plan is the point of the step, and an approval made on a stale
 * check would store implications that were never about this task.
 *
 * A SOURCE can only leave out entries tagged to its own project; the others are
 * shown but locked.
 */
export function MoveApprovalPanel({ requestId, handoverId, onDecided, onCancel }) {
  const [req, setReq] = useState(null);
  const [place, setPlace] = useState(null);
  const [error, setError] = useState(null);
  const [left, setLeft] = useState(() => new Set());
  const [mode, setMode] = useState('existing');
  const [taskId, setTaskId] = useState('');
  const [spec, setSpec] = useState({ title: '', stageKey: '', dueDate: '', isGate: false, dependsOn: [], dependents: [] });
  const [check, setCheck] = useState(null);   // { key, result }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Pressing Approve while the plan is unchecked sends the cursor here.
  const checkBtnRef = useRef(null);

  useEffect(() => {
    let alive = true;
    apiService.dailyWork.moveRequest(requestId)
      .then(({ data }) => { if (alive) setReq(data); })
      .catch(err => { if (alive) setError(readError(err, 'Could not load the request.')); });
    return () => { alive = false; };
  }, [requestId]);

  const approval = req && req.approvals
    .filter(a => a.handover_id === handoverId && a.decision === 'pending')
    .map(a => ({ ...a, batch: req.batches.find(b => b.id === a.batch_id) }))
    .filter(a => a.batch && a.batch.status === 'pending')
    .sort((a, b) => a.batch.batch_no - b.batch.batch_no)[0];
  const choosesTask = !!approval && approval.role === 'target' && approval.batch.batch_no === 1;

  useEffect(() => {
    if (!choosesTask) return;
    let alive = true;
    apiService.dailyWork.movePlacementOptions(requestId)
      .then(({ data }) => {
        if (!alive) return;
        setPlace(data);
        setSpec(s => ({ ...s, title: s.title || data.itemTitle || '' }));
        // A project with no open task has nothing to offer under "an existing
        // task": the approver lands on an empty dropdown and the only way on is
        // a radio they have to notice. Start them where the work can actually go.
        if (!data.tasks.some(t => !CLOSED_TASK.includes(t.status))) setMode('new');
      })
      .catch(err => { if (alive) setError(readError(err, 'Could not load the project’s tasks.')); });
    return () => { alive = false; };
  }, [choosesTask, requestId]);

  if (error && !req) return <div className="dw-banner stop">{error}</div>;
  if (!req) return <div className="dw-item-status">Loading…</div>;
  if (!approval) {
    return <div className="dw-item-status">There is nothing on this request waiting for you any more.</div>;
  }

  const entries = req.entries.filter(e => e.batch_id === approval.batch_id && e.outcome === 'pending');
  const canUntick = (e) => approval.role === 'target'
    || (e.snap_anchor_kind === 'handover' && e.snap_anchor_id === handoverId);

  const openTasks = place ? place.tasks.filter(t => !CLOSED_TASK.includes(t.status)) : [];
  const specKey = JSON.stringify(spec);
  const checked = mode === 'new' && check && check.key === specKey;

  const setSpecField = (patch) => setSpec(s => ({ ...s, ...patch }));
  const toggleIn = (field, id) => setSpec(s => {
    const list = s[field].includes(id) ? s[field].filter(x => x !== id) : [...s[field], id];
    return { ...s, [field]: list };
  });

  const newTaskBody = () => ({
    title: spec.title, stageKey: spec.stageKey || null, dueDate: spec.dueDate || null,
    isGate: spec.isGate, dependsOn: spec.dependsOn, dependents: spec.dependents,
  });

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiService.dailyWork.moveConflicts(requestId, newTaskBody());
      setCheck({ key: specKey, result: data });
    } catch (err) { setError(readError(err, 'Could not check the plan.')); }
    finally { setBusy(false); }
  };

  // What still stands between this approver and an approval, in their words.
  // Said on the panel and again on the press, because the gate used to be a
  // disabled button carrying a title tooltip — and a disabled control takes no
  // pointer events, so Chrome never draws it. The press did nothing, silently,
  // and the request looked like it had been swallowed.
  //
  // A stale check gets its own sentence. Checking, then changing the due date,
  // blocks again for a reason the approver has no way to guess from "check the
  // plan", which they know they already did.
  const approveNeeds = !choosesTask ? null
    : mode === 'existing'
      ? (taskId ? null : 'Choose the task this work should go to, or switch to “A new task”.')
      : !spec.title.trim() ? 'The new task needs a title.'
        : !check ? 'Press “Check the plan” before approving. You are deciding where this sits in the plan, '
                   + 'so the panel wants you to see what it does to it first.'
          : !checked ? 'The task changed since you last checked it. Press “Check the plan again” before approving.'
            : null;

  const decide = async (decision) => {
    if (decision === 'reject' && !reason.trim()) {
      setError('Say why, so the person knows what to do next.');
      return;
    }
    if (decision === 'approve' && approveNeeds) {
      setError(approveNeeds);
      // The check stays theirs to run. Running it off the Approve button would
      // make the plan something they clicked past twice rather than looked at,
      // which is the whole reason the step exists. Put the cursor on it instead.
      if (choosesTask && mode === 'new' && spec.title.trim()) checkBtnRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        handoverId, decision, reason: reason.trim() || null, batchId: approval.batch_id,
        untickEntryIds: decision === 'approve' ? [...left] : [],
      };
      if (decision === 'approve' && choosesTask) {
        body.placement = mode === 'existing'
          ? { existingPlayInstanceId: Number(taskId) }
          : { newTask: newTaskBody() };
      }
      const { data } = await apiService.dailyWork.decideMoveRequest(requestId, body);
      onDecided?.(data);
    } catch (err) {
      setError(readError(err, 'Could not record the decision.'));
      setBusy(false);
    }
  };

  return (
    <div className="dw-move">
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
        <b>{req.owner_name}</b> would like “<b>{req.item_title}</b>” moved onto <b>{req.target_name}</b>
        {req.requested_by !== req.owner_user_id && req.requested_by_name && <> (asked by {req.requested_by_name})</>}.
      </div>
      <div className="dw-meta">
        {approval.role === 'target'
          ? 'You manage the project this work would join.'
          : `Some of this work is tagged to ${approval.project_name}, which you manage. You can leave out entries tagged to it.`}
        {approval.batch.batch_no > 1 && ` This is part ${approval.batch.batch_no}: entries added after the first decision.`}
      </div>
      {req.note && <div className="dw-prior" style={{ marginTop: 8 }}>{req.note}</div>}

      <div className="dw-field">
        <label>Entries · {entries.filter(e => e.selected && !left.has(e.id)).length} moving</label>
        {entries.length === 0 ? (
          <div className="dw-item-status">No logged entries — approving moves the item itself, so new work goes to the task.</div>
        ) : (
          <div className="dw-move-list">
            {entries.map(e => {
              const leftOut = !e.selected || left.has(e.id);
              const locked = !e.selected || !canUntick(e);
              return (
                <label key={e.id} className={`dw-move-row ${leftOut ? 'off' : ''}`}>
                  <input type="checkbox" checked={!leftOut} disabled={locked}
                         onChange={() => setLeft(s => {
                           const next = new Set(s);
                           if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
                           return next;
                         })} />
                  <span className="when">{formatDay(e.entry_date)}</span>
                  <span className="what">
                    <span className="dw-clamp-2">{e.current_description || e.snap_description}</span>
                    {e.snap_anchor_label && <span className="dw-badge" style={{ marginTop: 3 }}>{e.snap_anchor_label}</span>}
                    {!e.selected && <span className="dw-meta" style={{ display: 'block' }}>Left out by another approver</span>}
                    {e.selected && !canUntick(e) && (
                      <span className="dw-meta" style={{ display: 'block' }}>Not tagged to your project</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {choosesTask && (
        <div className="dw-field">
          <label>Where it goes</label>
          {!place ? <div className="dw-item-status">Loading the project’s tasks…</div> : (
            <>
              <div role="radiogroup" style={{ display: 'flex', gap: 16, fontSize: 13.5, marginBottom: 8 }}>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input type="radio" name={`dw-place-${requestId}`} checked={mode === 'existing'}
                         disabled={openTasks.length === 0}
                         onChange={() => setMode('existing')} />
                  An existing task{openTasks.length === 0 && ' (none open)'}
                </label>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input type="radio" name={`dw-place-${requestId}`} checked={mode === 'new'}
                         onChange={() => setMode('new')} />
                  A new task
                </label>
              </div>

              {mode === 'existing' ? (
                <select aria-label="Task" value={taskId} onChange={e => setTaskId(e.target.value)}>
                  <option value="">Choose a task</option>
                  {openTasks.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.title} · {t.stage_name}{t.due_date ? ` · due ${formatDay(t.due_date)}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <NewTaskFields spec={spec} place={place} requestId={requestId}
                               onField={setSpecField} onToggle={toggleIn} />
              )}

              {mode === 'new' && (
                <div style={{ marginTop: 12 }}>
                  <button ref={checkBtnRef} className="dw-btn dw-btn-sm"
                          disabled={busy || !spec.title.trim()} onClick={runCheck}>
                    {check && !checked ? 'Check the plan again' : 'Check the plan'}
                  </button>
                  {check && !checked && (
                    <span className="dw-meta" style={{ marginLeft: 10 }}>The task changed since the last check.</span>
                  )}
                  {checked && <ConflictList result={check.result} />}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="dw-field">
        <label htmlFor={`dw-move-reason-${requestId}-${handoverId}`}>Reason (needed to reject)</label>
        <textarea id={`dw-move-reason-${requestId}-${handoverId}`} value={reason} maxLength={MAX_TEXT}
                  placeholder="Tell them why, or anything they should know"
                  onChange={e => setReason(e.target.value)} />
      </div>

      {error && <div className="dw-banner stop" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
      {approveNeeds && !error && (
        <div className="dw-meta" style={{ marginTop: 12 }}>{approveNeeds}</div>
      )}

      <div className="dw-move-actions">
        <button className="dw-btn dw-btn-sm dw-btn-primary" disabled={busy}
                onClick={() => decide('approve')}>
          {busy ? 'Saving…' : 'Approve'}
        </button>
        <button className="dw-btn dw-btn-sm" disabled={busy} onClick={() => decide('reject')}>Reject</button>
        {onCancel && <button className="dw-btn dw-btn-sm" onClick={onCancel}>Close</button>}
      </div>
    </div>
  );
}

/** The new-task form, split out so the approval panel stays readable. */
function NewTaskFields({ spec, place, requestId, onField, onToggle }) {
  const open = place.tasks.filter(t => !CLOSED_TASK.includes(t.status));
  return (
    <div>
      <div className="dw-move-grid">
        <div className="dw-field">
          <label htmlFor={`dw-nt-title-${requestId}`}>Title</label>
          <input id={`dw-nt-title-${requestId}`} type="text" value={spec.title}
                 onChange={e => onField({ title: e.target.value })} />
        </div>
        <div className="dw-field">
          <label htmlFor={`dw-nt-stage-${requestId}`}>Stage</label>
          <select id={`dw-nt-stage-${requestId}`} value={spec.stageKey}
                  onChange={e => onField({ stageKey: e.target.value })}>
            <option value="">Added on this project</option>
            {place.stages.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </div>
        <div className="dw-field">
          <label htmlFor={`dw-nt-due-${requestId}`}>Due date</label>
          <input id={`dw-nt-due-${requestId}`} type="date" value={spec.dueDate}
                 onChange={e => onField({ dueDate: e.target.value })} />
        </div>
      </div>
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13.5, marginTop: 10 }}>
        <input type="checkbox" checked={spec.isGate} onChange={e => onField({ isGate: e.target.checked })} />
        This task is a gate for later stages
      </label>

      <div className="dw-move-grid" style={{ marginTop: 12 }}>
        <div className="dw-field">
          <label>It waits for</label>
          <TaskChecklist tasks={place.tasks} picked={spec.dependsOn} disabledIds={spec.dependents}
                         onToggle={id => onToggle('dependsOn', id)} />
        </div>
        <div className="dw-field">
          <label>These wait for it</label>
          <TaskChecklist tasks={open} picked={spec.dependents} disabledIds={spec.dependsOn}
                         onToggle={id => onToggle('dependents', id)} />
        </div>
      </div>
    </div>
  );
}

function TaskChecklist({ tasks, picked, disabledIds, onToggle }) {
  if (!tasks.length) return <div className="dw-item-status">No tasks on this project yet.</div>;
  return (
    <div className="dw-move-list" style={{ maxHeight: 180 }}>
      {tasks.map(t => (
        <label key={t.id} className={`dw-move-row ${disabledIds.includes(t.id) ? 'off' : ''}`}>
          <input type="checkbox" checked={picked.includes(t.id)} disabled={disabledIds.includes(t.id)}
                 onChange={() => onToggle(t.id)} />
          <span className="what">
            {t.title}
            <span className="dw-meta" style={{ display: 'block' }}>
              {t.stage_name}{t.due_date ? ` · due ${formatDay(t.due_date)}` : ''}
              {CLOSED_TASK.includes(t.status) ? ` · ${t.status}` : ''}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** What the plan check found. Conflicts first; nothing here blocks the decision. */
function ConflictList({ result }) {
  const items = [...(result.conflicts || [])]
    .sort((a, b) => (a.severity === 'conflict' ? 0 : 1) - (b.severity === 'conflict' ? 0 : 1));
  const count = items.filter(i => i.severity === 'conflict').length;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="dw-meta">
        {count === 0 ? 'No clashes with the plan.' : `${count} ${count === 1 ? 'clash' : 'clashes'} with the plan.`}
        {' '}Nothing moves any other task’s dates — you decide whether to go ahead.
      </div>
      {items.length > 0 && (
        <ul className="dw-conflicts">
          {items.map((c, i) => <li key={i} className={c.severity}>{c.message}</li>)}
        </ul>
      )}
    </div>
  );
}

/* ───────────────────────── My day: the approver ────────────────────── */

/**
 * The move requests waiting on the viewer, for the "Awaiting your review" card.
 * Presentational: the card owns the fetch so it can decide whether to render at
 * all when both of its queues are empty.
 */
export function MoveReviewSection({ items, onChanged }) {
  const [open, setOpen] = useState(null);   // approval_id
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 3 }}>
        Daily work asking to join your projects
      </div>
      {items.map(i => (
        <div key={i.approval_id} style={{ borderBottom: '1px solid var(--dw-line-2)', padding: '4px 0' }}>
          <button type="button" className="dw-btn-link" style={{ textAlign: 'left', color: '#1f2937' }}
                  aria-expanded={open === i.approval_id}
                  onClick={() => setOpen(open === i.approval_id ? null : i.approval_id)}>
            {i.owner_name}: “{i.item_title}” → {i.target_name}
          </button>
          <span className="dw-meta" style={{ marginLeft: 6 }}>
            {i.role === 'source' ? `tagged to ${i.project_name} · ` : ''}
            {i.entry_count} {i.entry_count === 1 ? 'entry' : 'entries'}
            {i.batch_no > 1 ? ` · part ${i.batch_no}` : ''}
          </span>
          {open === i.approval_id && (
            <MoveApprovalPanel requestId={i.request_id} handoverId={i.handover_id}
                               onDecided={() => { setOpen(null); onChanged?.(); }}
                               onCancel={() => setOpen(null)} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── My day: the prompt ──────────────────────── */

/**
 * Items tagged to a project that are not on its plan.
 *
 * Shown every day while the condition holds — it stops when a request is
 * raised, or the item closes or retires. The condition is computed by getDay
 * (on_project_not_plan), so this card and the server agree on which items it
 * is about. Renders nothing when there are none.
 */
export function MovePromptCard({ rows, onChanged }) {
  const [asking, setAsking] = useState(null);
  const items = (rows || []).filter(r => r.on_project_not_plan && !r.open_move_request_id && isMovableRow(r));
  if (items.length === 0) return null;
  return (
    <div className="dw-card" style={{ borderLeft: '3px solid #6d28d9' }}>
      <div className="dw-card-head">
        <h2>On a project, but not on its plan</h2>
        <span className="m">
          Work here does not show on the project until it is on one of its tasks
        </span>
      </div>
      <div className="dw-item-body" style={{ paddingTop: 8 }}>
        {items.map(r => (
          <div key={r.item_id} style={{ padding: '6px 0', borderBottom: '1px solid var(--dw-line-2)' }}>
            <span style={{ fontSize: 13.5 }}>{r.title}</span>
            <span className="dw-badge" style={{ marginLeft: 6 }}>{r.anchor_label}</span>
            {asking !== r.item_id && (
              <button type="button" className="dw-btn-link" style={{ marginLeft: 10 }}
                      onClick={() => setAsking(r.item_id)}>
                Ask to move it onto the plan
              </button>
            )}
            {asking === r.item_id && (
              <MoveRequestForm itemId={r.item_id}
                               onCancel={() => setAsking(null)}
                               onDone={(req) => {
                                 // The screen says what happened: this card
                                 // re-renders without the item once the day is
                                 // re-read, so a message kept here would vanish.
                                 setAsking(null);
                                 onChanged?.(req);
                               }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── My day: afterwards ──────────────────────── */

/**
 * The person's side once they have asked: requests still waiting, the
 * retire-or-keep question for a recurring item whose work moved, and entries a
 * move flagged — a merge to tidy and mark done, or an entry left out for length
 * that moves on its own once it fits. Renders nothing when there is nothing.
 */
export function MyMoveRequestsCard({ viewerId, reloadKey = 0, onChanged }) {
  const [data, setData] = useState(null);
  const [openReq, setOpenReq] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (typeof apiService.dailyWork?.myMoveRequests !== 'function') return;
    apiService.dailyWork.myMoveRequests()
      .then(({ data: d }) => setData(d))
      .catch(() => setData({ requests: [], flagged: [] }));
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  const after = () => { load(); onChanged?.(); };

  if (!data) return null;
  const waiting = data.requests.filter(r => r.is_open);
  const questions = data.requests.filter(r => r.recurring_decision === 'pending');
  if (waiting.length + questions.length + data.flagged.length === 0) return null;

  const answer = async (id, decision) => {
    try { await apiService.dailyWork.moveRecurringDecision(id, decision); after(); }
    catch (err) { setError(readError(err, 'Could not save that.')); }
  };

  return (
    <div className="dw-card">
      <div className="dw-card-head">
        <h2>Work moving to projects</h2>
        <span className="m">
          {waiting.length > 0 && `${waiting.length} waiting`}
          {waiting.length > 0 && data.flagged.length > 0 && ' · '}
          {data.flagged.length > 0 && `${data.flagged.length} to tidy up`}
        </span>
      </div>
      <div className="dw-item-body" style={{ paddingTop: 8 }}>
        {error && <div className="dw-banner stop" style={{ marginTop: 8 }}>{error}</div>}

        {questions.map(r => (
          <div key={`q-${r.id}`} className="dw-banner info" style={{ marginTop: 8 }}>
            The work on “{r.item_title}” moved to {r.target_name}. Keep this item on your list for other work,
            or retire it?
            <div className="dw-move-actions" style={{ marginTop: 8 }}>
              <button className="dw-btn dw-btn-sm" onClick={() => answer(r.id, 'keep')}>Keep it</button>
              <button className="dw-btn dw-btn-sm" onClick={() => answer(r.id, 'retire')}>Retire it</button>
            </div>
          </div>
        ))}

        {waiting.map(r => (
          <div key={`w-${r.id}`} style={{ padding: '6px 0', borderBottom: '1px solid var(--dw-line-2)' }}>
            <button type="button" className="dw-btn-link" style={{ color: '#1f2937', textAlign: 'left' }}
                    aria-expanded={openReq === r.id}
                    onClick={() => setOpenReq(openReq === r.id ? null : r.id)}>
              “{r.item_title}” → {r.target_name}
            </button>
            <span className="dw-badge review" style={{ marginLeft: 6 }}>
              {r.status === 'approved' ? 'more waiting' : 'waiting'}
            </span>
            {openReq === r.id && (
              <div style={{ marginTop: 8 }}>
                <MoveRequestStatus requestId={r.id} viewerId={viewerId} onChanged={after} />
              </div>
            )}
          </div>
        ))}

        {/* Keyed on the outcome too: when a left-out entry merges, the editor has
            to start again from the merged text, not keep the text typed before. */}
        {data.flagged.map(f => (
          <FlaggedEntry key={`f-${f.id}-${f.outcome}-${f.needs_edit}`} row={f} onChanged={after} />
        ))}
      </div>
    </div>
  );
}

/**
 * One entry a move flagged.
 *
 * MERGED: the task's entry for that day now holds both texts. Edit it into one
 * account, then Done. Done is explicit, as agreed — saving an edit does not
 * clear it, because the first save is often not the last.
 *
 * LEFT OUT: the two texts together were over the limit. Shorten either; the
 * count shows the merged length exactly as the server will measure it, and the
 * merge happens on the save that makes it fit.
 *
 * Both edit past the backfill window: these rows are the one exception to it.
 */
function FlaggedEntry({ row, onChanged }) {
  const [task, setTask] = useState(row.task_description || '');
  const [original, setOriginal] = useState(row.original_description || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async (which, text) => {
    setBusy(true);
    setError(null);
    try {
      await apiService.dailyWork.editMoveEntry(row.id, { which, description: text });
      onChanged?.();
    } catch (err) { setError(readError(err, 'Could not save.')); }
    finally { setBusy(false); }
  };

  const done = async () => {
    setBusy(true);
    try { await apiService.dailyWork.markMoveEntryDone(row.id); onChanged?.(); }
    catch (err) { setError(readError(err, 'Could not mark it done.')); setBusy(false); }
  };

  if (row.needs_edit) {
    return (
      <div className="dw-field">
        <label>{formatDay(row.entry_date)} · merged into your entry on {row.target_name}</label>
        <textarea value={task} onChange={e => setTask(e.target.value)}
                  className={task.length > MAX_TEXT ? 'over' : ''} />
        <div className="dw-foot">
          <span className={`dw-count ${task.length > MAX_TEXT ? 'over' : ''}`}>{task.length} / {MAX_TEXT}</span>
          {error && <span className="dw-err">{error}</span>}
        </div>
        <div className="dw-move-actions" style={{ marginTop: 6 }}>
          <button className="dw-btn dw-btn-sm" disabled={busy || task === row.task_description || !task.trim()}
                  onClick={() => save('task', task)}>Save</button>
          <button className="dw-btn dw-btn-sm dw-btn-primary" disabled={busy} onClick={done}>Done</button>
        </div>
      </div>
    );
  }

  const total = mergedLength(task, original, row.item_title);
  return (
    <div className="dw-field">
      <label>{formatDay(row.entry_date)} · waiting to move to {row.target_name}</label>
      <div className="dw-meta" style={{ marginBottom: 6 }}>{row.left_out_reason}</div>
      <div className="dw-move-grid">
        <div>
          <div className="dw-meta">Already on the task</div>
          <textarea value={task} onChange={e => setTask(e.target.value)} />
          <button className="dw-btn dw-btn-sm" style={{ marginTop: 6 }}
                  disabled={busy || task === row.task_description || !task.trim()}
                  onClick={() => save('task', task)}>Save</button>
        </div>
        <div>
          <div className="dw-meta">From “{row.item_title}”</div>
          <textarea value={original} onChange={e => setOriginal(e.target.value)} />
          <button className="dw-btn dw-btn-sm" style={{ marginTop: 6 }}
                  disabled={busy || original === row.original_description || !original.trim()}
                  onClick={() => save('original', original)}>Save</button>
        </div>
      </div>
      <div className="dw-foot">
        <span className={`dw-count ${total > MAX_TEXT ? 'over' : ''}`}>together {total} / {MAX_TEXT}</span>
        {error && <span className="dw-err">{error}</span>}
      </div>
    </div>
  );
}
