// ─────────────────────────────────────────────────────────────────────────────
// OAMemberModules.js
//
// DROP-IN LOCATION: frontend/src/orgadmin/panels/OAMemberModules.js
//
// Inline per-user module-access editor. Shows the modules the ORG has enabled and
// lets an admin grant/revoke each for one member. Effective access for a user is
// org-enabled ∩ granted, so only org-enabled modules are shown as toggleable.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

const LABELS = {
  prospecting: 'Prospecting', contracts: 'Contracts', handovers: 'Projects',
  service: 'Service', agency: 'Agency',
};

export default function OAMemberModules({ userId, canEdit }) {
  const [orgEnabled, setOrgEnabled] = useState([]);
  const [granted, setGranted]       = useState(new Set());
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [msg, setMsg]               = useState('');

  useEffect(() => {
    let live = true;
    apiService.orgAdmin.getMemberModules(userId)
      .then(r => { if (!live) return; setOrgEnabled(r.data.orgEnabled || []); setGranted(new Set(r.data.granted || [])); })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [userId]);

  const toggle = (k) => setGranted(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const save = async () => {
    setSaving(true); setMsg('');
    try { await apiService.orgAdmin.setMemberModules(userId, [...granted].filter(k => orgEnabled.includes(k))); setMsg('Saved'); }
    catch (e) { setMsg(e?.response?.data?.error?.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  if (loading) return <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 12px' }}>Loading modules…</div>;

  return (
    <div style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: 8, margin: '4px 0 10px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 8 }}>Module access</div>
      {orgEnabled.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>No modules enabled for this org.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
          {orgEnabled.map(k => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={granted.has(k)} disabled={!canEdit} onChange={() => toggle(k)} />
              {LABELS[k] || k}
            </label>
          ))}
        </div>
      )}
      {canEdit && orgEnabled.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={save} disabled={saving} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', background: '#059669', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>{saving ? 'Saving…' : 'Save modules'}</button>
          {msg && <span style={{ fontSize: 12, color: msg === 'Saved' ? '#059669' : '#991b1b' }}>{msg}</span>}
        </div>
      )}
    </div>
  );
}
