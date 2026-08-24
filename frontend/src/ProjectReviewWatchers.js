/**
 * ProjectReviewWatchers.js
 *
 * DROP-IN LOCATION: frontend/src/ProjectReviewWatchers.js  (NEW FILE)
 *
 * Who gets alerted, on top of the project manager, when a task on this project
 * moves through review (2026_130).
 *
 * SELF-FETCHING. It loads both its own list and the org's assignable users
 * rather than taking them as props, following ContactPolicy in the same panel.
 * The alternative was threading `users` down through HandoverSummary →
 * ProjectPeoplePanel for one collapsed section that most people never open.
 *
 * WHAT IS DELIBERATELY NOT LISTED HERE. The project manager and the project
 * creator are always alerted and never appear as rows. A list that can be
 * emptied must not be able to silence the two people accountable for the
 * project — so they are resolved on the server from the project itself, and
 * there is nothing here to remove.
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
};

const errText = (e, fallback) => e?.response?.data?.error?.message || fallback;

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '?';
}

export default function ProjectReviewWatchers({ handoverId, canManage, managerLabel = 'Project Manager' }) {
  const [watchers, setWatchers] = useState(null);   // null = loading
  const [users,    setUsers]    = useState([]);
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

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canManage) return;   // the picker is the only thing that needs the list
    if (typeof apiService.handovers?.assignableUsers !== 'function') return;
    apiService.handovers.assignableUsers()
      .then(r => setUsers(r.data?.users || []))
      .catch(() => setUsers([]));
  }, [canManage]);

  // The whole list is replaced on every change: the endpoint is a PUT, and a
  // set-of-users is small enough that sending it whole avoids an add/remove
  // protocol that could drift from what is on screen.
  const save = async (nextIds) => {
    setBusy(true); setErr('');
    const previous = watchers;
    try {
      const r = await apiService.handovers.setReviewWatchers(handoverId, nextIds);
      setWatchers(r.data || []);
    } catch (e) {
      setWatchers(previous);
      setErr(errText(e, 'Could not save the alert list.'));
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

  const ids       = watchers.map(w => w.userId);
  const available = users.filter(u => !ids.includes(u.id));

  return (
    <div>
      <div style={S.h5}>🔔 Also alert on task reviews</div>
      <div style={{ ...S.meta, marginBottom: 6 }}>
        The {managerLabel.toLowerCase()} and whoever created this project are always
        alerted. Anyone added here is alerted too — when a task is sent for review,
        approved, or sent back.
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
            {w.email && <span style={{ ...S.meta, marginLeft: 6 }}>{w.email}</span>}
          </span>
          {canManage && (
            <button style={S.btn} disabled={busy}
              onClick={() => save(ids.filter(id => id !== w.userId))}>
              Remove
            </button>
          )}
        </div>
      ))}

      {err && <div style={S.err}>{err}</div>}

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
              await save([...ids, parseInt(pick, 10)]);
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
