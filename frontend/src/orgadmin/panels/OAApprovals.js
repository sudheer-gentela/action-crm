// ─────────────────────────────────────────────────────────────────────────────
// OAApprovals.js
//
// DROP-IN LOCATION: frontend/src/orgadmin/panels/OAApprovals.js
//
// One queue for the admin to close out: module-access grants, new-user invites,
// and project-team requests, each with Approve / Reject. Dispatches to the right
// backend via the unified /api/approvals/review endpoint.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const TYPE_BADGE = {
  module_grant:   { label: 'Module', bg: '#eff6ff', fg: '#1d4ed8' },
  invite:         { label: 'Invite', bg: '#ecfdf5', fg: '#047857' },
  project_member: { label: 'Project', bg: '#fef3c7', fg: '#92400e' },
  // Vendor / partner relationships, approved ONCE org-wide by a named approver
  // (finance) rather than per project — accountRelationships.review enforces
  // that, which is why this is not gated on plain org-admin like the others.
  account_relationship: { label: 'Vendor', bg: '#f5f3ff', fg: '#6d28d9' },
};

export default function OAApprovals() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [busy, setBusy]       = useState('');
  // Whether the LOAD failed, as opposed to an action failing.
  //
  // rows stays [] when the fetch dies, and [] renders "Nothing to approve right
  // now" with a party emoji. So a failure showed an error and a celebration at
  // once, and the celebration is the part people believe — an admin reads it,
  // concludes the queue is clear, and walks away from work that is waiting.
  // An empty list only means "nothing waiting" if we actually got a list.
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(''); setLoadFailed(false);
    try {
      const r = await apiService.handovers.getApprovals();
      setRows(r.data.approvals || []);
    } catch (e) {
      setErr(e?.response?.data?.error?.message || 'Could not load approvals.');
      setLoadFailed(true);
      // Cleared rather than left stale: a queue from before the failure would
      // be presented as current, and these rows carry Approve and Reject.
      setRows([]);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (item, action) => {
    let reason;
    if (action === 'reject') {
      reason = window.prompt('Reason for rejecting?');
      if (reason === null) return;
    }
    setBusy(`${item.type}:${item.id}`); setErr('');
    try {
      await apiService.handovers.reviewApproval({ type: item.type, id: item.id, contextId: item.contextId, action, reason });
      await load();
    } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not update.'); }
    finally { setBusy(''); }
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Approvals</h2>
      <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 16px' }}>
        Everything waiting on you — module access, new-user invites, and project-team requests — in one place.
      </p>
      {err && <div style={{ color: '#991b1b', fontSize: 13, marginBottom: 10 }}>{err}</div>}

      {loading ? <div style={{ color: '#9ca3af' }}>Loading…</div>
        : loadFailed ? (
          <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
            <div>The approvals queue couldn't be loaded, so this list is not showing anything.</div>
            <div style={{ marginTop: 4 }}>
              There may still be items waiting. This is usually an expired session — sign out and back in.
            </div>
            <button onClick={load} style={{ marginTop: 10, fontSize: 12, padding: '5px 14px', borderRadius: 6,
                                            border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
              Try again
            </button>
          </div>
        )
        : rows.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Nothing to approve right now. 🎉</div>
        : rows.map(item => {
          const b = TYPE_BADGE[item.type] || { label: item.type, bg: '#f1f5f9', fg: '#334155' };
          const key = `${item.type}:${item.id}`;
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 8, background: '#fff' }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: b.bg, color: b.fg, textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{b.label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{item.title}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>{item.sub} · {new Date(item.createdAt).toLocaleDateString()}</div>
              </div>
              <button disabled={busy === key} onClick={() => act(item, 'approve')} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', background: '#059669', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Approve</button>
              <button disabled={busy === key} onClick={() => act(item, 'reject')} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#991b1b', fontWeight: 600, cursor: 'pointer' }}>Reject</button>
            </div>
          );
        })}
    </div>
  );
}
