// ─────────────────────────────────────────────────────────────────────────────
// OAEmailDomains.js
//
// DROP-IN LOCATION: frontend/src/orgadmin/panels/OAEmailDomains.js
//
// Manage the org's email domain(s). A membership request for a user whose email
// domain matches one of these — and where a seat is available — is auto-approved;
// others go to an admin. One or more domains supported.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

export default function OAEmailDomains() {
  const [domains, setDomains] = useState([]);
  const [value, setValue]     = useState('');
  const [err, setErr]         = useState('');
  const [busy, setBusy]       = useState(false);

  const load = useCallback(async () => {
    try { const r = await apiService.handovers.orgDomains(); setDomains(r.data.domains || []); }
    catch { setDomains([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setErr(''); const d = value.trim();
    if (!d) return;
    setBusy(true);
    try { const r = await apiService.handovers.addOrgDomain(d); setDomains(r.data.domains || []); setValue(''); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not add domain.'); }
    finally { setBusy(false); }
  };
  const remove = async (id) => {
    try { const r = await apiService.handovers.removeOrgDomain(id); setDomains(r.data.domains || []); }
    catch (e) { setErr(e?.response?.data?.error?.message || 'Could not remove.'); }
  };

  return (
    <div className="sv-card">
      <h3>Email Domains</h3>
      <p className="sv-hint">
        Users whose email is on one of these domains are auto-approved when added to a project (if a seat is free).
        Others require admin approval. Add one or more.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="e.g. acme.com"
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
          style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, minWidth: 220 }} />
        <button onClick={add} disabled={busy || !value.trim()} style={{
          padding: '8px 16px', borderRadius: 6, border: 'none',
          background: (busy || !value.trim()) ? '#9ca3af' : '#059669', color: '#fff', fontSize: 13, fontWeight: 600,
          cursor: (busy || !value.trim()) ? 'default' : 'pointer' }}>Add domain</button>
      </div>

      {domains.length === 0
        ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No domains added yet.</div>
        : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {domains.map(d => (
              <span key={d.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13,
                padding: '5px 10px', borderRadius: 999, background: '#f1f5f9', color: '#334155' }}>
                {d.domain}
                <button onClick={() => remove(d.id)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 13, lineHeight: 1 }}>✕</button>
              </span>
            ))}
          </div>
        )}
      {err && <div style={{ fontSize: 12, color: '#991b1b', marginTop: 8 }}>{err}</div>}
    </div>
  );
}
