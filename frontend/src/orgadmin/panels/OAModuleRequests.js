// ─────────────────────────────────────────────────────────────────────────────
// OAModuleRequests.js
//
// DROP-IN LOCATION: frontend/src/orgadmin/panels/OAModuleRequests.js
//
// Admin review queue for self-service module access requests. Approve grants the
// module; reject requires a reason.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const LABELS = { prospecting: 'Prospecting', contracts: 'Contracts', handovers: 'Handovers', service: 'Service', agency: 'Agency' };

export default function OAModuleRequests() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { const r = await apiService.handovers.pendingModuleRequests(); setRows(r.data.requests || []); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not load requests.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const approve = async (id) => { try { await apiService.handovers.reviewModuleRequest(id, { action: 'approve' }); load(); } catch (e) { setErr(e?.response?.data?.error?.message || 'Could not approve'); } };
  const reject = async (id) => {
    const reason = window.prompt('Reason for rejecting?');
    if (reason === null) return;
    try { await apiService.handovers.reviewModuleRequest(id, { action: 'reject', reason }); load(); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not reject'); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>Module Access Requests</h2>
      <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 16px' }}>
        Team members requesting access to modules your org has enabled. Approving grants them the module.
      </p>
      {err && <div style={{ color: '#991b1b', fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {loading ? <div style={{ color: '#9ca3af' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No pending requests.</div>
        : rows.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 8, background: '#fff' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{r.for_name || r.for_email}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                needs <b>{LABELS[r.module_key] || r.module_key}</b>
                {r.by_name ? <> · requested by {r.by_name}</> : null}
                {' '}· {new Date(r.created_at).toLocaleDateString()}
                {r.reason ? ` · "${r.reason}"` : ''}
              </div>
            </div>
            <button onClick={() => approve(r.id)} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', background: '#059669', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Approve</button>
            <button onClick={() => reject(r.id)} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#991b1b', fontWeight: 600, cursor: 'pointer' }}>Reject</button>
          </div>
        ))}
    </div>
  );
}
