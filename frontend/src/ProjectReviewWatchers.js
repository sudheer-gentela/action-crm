/**
 * ProjectReviewWatchers.js
 *
 * Who gets alerted, on top of the project manager, when a task on this project
 * moves through review (2026_130, 2026_138).
 *
 * SELF-FETCHING. It loads its own list, the org's assignable users and the
 * viewer's own subscription state rather than taking them as props, following
 * ContactPolicy in the same panel. The alternative was threading three more
 * values down through HandoverSummary → ProjectPeoplePanel for one collapsed
 * section that most people never open.
 *
 * WHAT IS DELIBERATELY NOT LISTED HERE. The project manager and the project
 * creator are always alerted and never appear as rows. A list that can be
 * emptied must not be able to silence the two people accountable for the
 * project — so they are resolved on the server from the project itself, and
 * there is nothing here to remove.
 *
 * ── 2026_138: TWO KINDS OF ROW ──────────────────────────────────────────────
 *
 * A row is either manager-managed or self-subscribed, and the difference is
 * visible and enforced. A manager may not remove somebody who put themselves
 * on the list — setWatchers' DELETE skips self_subscribed rows — so rendering a
 * Remove button on those rows would offer a control that returns 200 and
 * changes nothing, which is worse than not offering it.
 *
 * The Follow button below is the other half: any approved member can put
 * themselves on this list, which is what promotes them from completion-only
 * traffic to the full review loop.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const S = {
  h5:   { margin: '14px 0 6px', fontSize: 12, fontWeight: 700, color: '#374151' },
  meta: { fontSize: 11, color: '#6b7280', lineHeight: 1.55 },
  row:  { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 13 },
  btn:  { fontSize: 11, padding: '3px 9px', borderRadius: 4, border: '1px solid #d1d5db',
          background: '#fff', color: '#374151', cursor: 'pointer' },
  add:  { fontSize: 12, padding: '4px 10px', borderRadius: 4, background: '#f0f9ff',
          color: '#0369a1', border: '1px dashed #93c5fd', cursor: 'pointer' },
  sel:  { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db',
          minWidth: 180, fontFamily: 'inherit' },
  err:  { fontSize: 12, color: '#991b1b', background: '#fee2e2', padding: '5px 8px',
          borderRadius: 5, marginTop: 6 },
  empty:{ fontSize: 12, color: '#9ca3af', margin: '4px 0' },
  pill: { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
          textTransform: 'uppercase', letterSpacing: 0.3,
          background: '#eff6ff', color: '#1d4ed8' },
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '?';
}

export default function ProjectReviewWatchers({
  handoverId, canManage, managerLabel = 'Project Manager', currentUserId = null,
}) {
  const [watchers, setWatchers] = useState(null);   // null = loading
  const [users,    setUsers]    = useState([]);
  const [mine,     setMine]     = useState(null);   // null = unknown / endpoint absent
  const [adding,   setAdding]   = useState(false);
  const [pick,     setPick]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState('');

  // The endpoint may not exist yet if apiService.js has not shipped alongside
  // this component. A missing method throws synchronously — before a promise
  // exists — so a trailing .catch() would not catch it and the error would take
  // the whole People card down with it. On a stale bundle this section simply
  // does not render.
  const load = useCallback(() => {
    if (!handoverId) return;
    if (typeof apiService.handovers?.reviewWatchers !== 'function') {
      setWatchers([]);
      return;
    }
    apiService.handovers.reviewWatchers(handoverId)
      .then(r => setWatchers(r.data || []))
      .catch(e => { setWatchers([]); setErr(errText(e, 'Could not load the alert list.')); });
  }, [handoverId]);

  // The viewer's own subscription, fetched separately from the list.
  //
  // NOT derived from `watchers`. That list is readable by anyone who can see
  // the People card, but the honest source for "am I following this" is the
  // endpoint that also knows whether the row is mine to remove — a manager who
  // added me appears in the same list and must not get an Unfollow button that
  // does nothing. Guarded the same way as load() for a stale bundle.
  const loadMine = useCallback(() => {
    if (!handoverId) return;
    if (typeof apiService.handovers?.myReviewWatch !== 'function') { setMine(null); return; }
    apiService.handovers.myReviewWatch(handoverId)
      .then(r => setMine(r.data || { subscribed: false, selfSubscribed: false }))
      .catch(() => setMine(null));
  }, [handoverId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMine(); }, [loadMine]);

  useEffect(() => {
    if (!canManage) return;   // the picker is the only thing that needs the list
    if (typeof apiService.handovers?.assignableUsers !== 'function') return;
    apiService.handovers.assignableUsers()
      .then(r => setUsers(r.data?.users || []))
      .catch(() => setUsers([]));
  }, [canManage]);

  // The whole MANAGER-MANAGED list is replaced on every change: the endpoint is
  // a PUT, and a set-of-users is small enough that sending it whole avoids an
  // add/remove protocol that could drift from what is on screen.
  //
  // Self-subscribed ids are excluded from what is sent. The server would ignore
  // them either way — its DELETE skips those rows and its INSERT is ON CONFLICT
  // DO NOTHING — but sending them would make this PUT claim to be setting a
  // list it is not in charge of, and the next person to read this would
  // reasonably conclude a manager can remove a self-subscriber.
  const save = async (nextManagedIds) => {
    setBusy(true); setErr('');
    const previous = watchers;
    try {
      const r = await apiService.handovers.setReviewWatchers(handoverId, nextManagedIds);
      setWatchers(r.data || []);
    } catch (e) {
      setWatchers(previous);
      setErr(errText(e, 'Could not save the alert list.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleMine = async (next) => {
    setBusy(true); setErr('');
    try {
      await apiService.handovers.setMyReviewWatch(handoverId, next);
      // Both, and in this order. The row list is what the section renders and
      // the state drives the button; refreshing only one leaves the person
      // looking at a list that does not contain the name they just added.
      await Promise.all([load(), loadMine()]);
    } catch (e) {
      setErr(errText(e, next
        ? 'Could not follow this project.'
        : 'Could not stop following this project.'));
    } finally {
      setBusy(false);
    }
  };

  if (watchers === null) return null;   // silent while loading — this is a minor section
  // No endpoint and nothing stored: render nothing rather than an empty section
  // with an Add button that would fail on click.
  if (watchers.length === 0 && typeof apiService.handovers?.setReviewWatchers !== 'function') {
    return null;
  }

  const ids        = watchers.map(w => w.userId);
  const managedIds = watchers.filter(w => !w.selfSubscribed).map(w => w.userId);
  // Everyone already on the list is filtered out of the picker, self-subscribed
  // included — a manager adding somebody who is already there would be a no-op
  // that looks like it worked.
  const available  = users.filter(u => !ids.includes(u.id));

  const canFollow = mine && typeof apiService.handovers?.setMyReviewWatch === 'function';

  return (
    <div>
      <div style={S.h5}>🔔 Also alert on task reviews</div>
      <div style={{ ...S.meta, marginBottom: 6 }}>
        The {managerLabel.toLowerCase()} and whoever created this project are always
        alerted. Everyone on the project team hears when a task finishes. Anyone
        listed here also hears the rest of the loop — sent for review, and sent back.
      </div>

      {watchers.length === 0 && <p style={S.empty}>Nobody extra is alerted.</p>}

      {watchers.map(w => (
        <div key={w.userId} style={S.row}>
          <span style={{
            width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
            background: '#e0f2fe', color: '#0369a1', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700,
          }}>{initials(w.name)}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden',
                         textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {w.name}
            {currentUserId != null && w.userId === currentUserId && (
              <span style={{ ...S.meta, marginLeft: 6 }}>(you)</span>
            )}
            {w.email && <span style={{ ...S.meta, marginLeft: 6 }}>{w.email}</span>}
          </span>
          {/* Marked so a manager can see why there is no Remove button beside
              this name, rather than concluding the button is broken. */}
          {w.selfSubscribed && <span style={S.pill}>following</span>}
          {/* Remove is offered ONLY on manager-managed rows. On a
              self-subscribed row the server's DELETE would skip it, the PUT
              would return 200, and the name would still be there after the
              refresh — a control that reports success and changes nothing. */}
          {canManage && !w.selfSubscribed && (
            <button style={S.btn} disabled={busy}
              onClick={() => save(managedIds.filter(id => id !== w.userId))}>
              Remove
            </button>
          )}
        </div>
      ))}

      {err && <div style={S.err}>{err}</div>}

      {/* ── Follow, for the viewer themselves ─────────────────────────────────
          Shown to everyone, not only to people who can manage the project —
          that is the whole point. The server refuses anyone who is not on the
          project, so a viewer who should not be here gets a message rather than
          a silent no-op.

          Three states, because "subscribed" and "subscribed BY ME" are
          different and only the second is mine to undo. */}
      {canFollow && (
        <div style={{ marginTop: 10 }}>
          {mine.selfSubscribed ? (
            <button style={S.btn} disabled={busy} onClick={() => toggleMine(false)}>
              Stop following this project
            </button>
          ) : mine.subscribed ? (
            <span style={S.meta}>
              You are on this list — the {managerLabel.toLowerCase()} added you, so only
              they can take you off it.
            </span>
          ) : (
            <>
              <button style={S.add} disabled={busy} onClick={() => toggleMine(true)}>
                🔔 Follow this project
              </button>
              <div style={{ ...S.meta, marginTop: 4 }}>
                You already hear when a task finishes. Follow to also hear when one is
                sent for review or sent back.
              </div>
            </>
          )}
        </div>
      )}

      {canManage && !adding && (
        <button style={{ ...S.add, marginTop: 8 }} onClick={() => { setAdding(true); setErr(''); }}>
          + Add someone
        </button>
      )}

      {canManage && adding && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={pick} onChange={e => setPick(e.target.value)} style={S.sel} disabled={busy}>
            <option value="">Choose someone…</option>
            {available.map(u => (
              <option key={u.id} value={u.id}>
                {u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}
              </option>
            ))}
          </select>
          <button
            style={{ ...S.btn, background: '#0369a1', color: '#fff', border: 'none' }}
            disabled={busy || !pick}
            onClick={async () => {
              await save([...managedIds, parseInt(pick, 10)]);
              setPick(''); setAdding(false);
            }}>
            Add
          </button>
          <button style={S.btn} disabled={busy}
            onClick={() => { setAdding(false); setPick(''); setErr(''); }}>
            Cancel
          </button>
          {available.length === 0 && (
            <span style={S.meta}>Everyone available is already on the list.</span>
          )}
        </div>
      )}
    </div>
  );
}
