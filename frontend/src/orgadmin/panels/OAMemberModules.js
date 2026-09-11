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
  service: 'Service', agency: 'Agency', dailywork: 'Daily Work',
};

// 2026_142. Why a grant exists when it was not an admin's choice. Keyed by the
// server's source value so a new source shows its raw key rather than nothing.
function sourceLabel(s) {
  if (!s) return null;
  if (s.source === 'move_request_approver') {
    const what = s.itemTitle ? `“${s.itemTitle}” to ${s.projectName}` : 'daily work onto a project';
    return `Granted automatically so they can approve moving ${what}`;
  }
  return `Granted automatically (${s.source})`;
}

export default function OAMemberModules({ userId, canEdit }) {
  const [orgEnabled, setOrgEnabled] = useState([]);
  const [granted, setGranted]       = useState(new Set());
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [msg, setMsg]               = useState('');
  const [sources, setSources]       = useState({});

  useEffect(() => {
    let live = true;
    apiService.orgAdmin.getMemberModules(userId)
      .then(r => {
        if (!live) return;
        setOrgEnabled(r.data.orgEnabled || []);
        setGranted(new Set(r.data.granted || []));
        setSources(r.data.sources || {});
      })
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
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                   title={granted.has(k) ? sourceLabel(sources[k]) || undefined : undefined}>
              <input type="checkbox" checked={granted.has(k)} disabled={!canEdit} onChange={() => toggle(k)} />
              {LABELS[k] || k}
              {/* Only while still granted: unticking and saving removes the
                  grant, and its source goes with it (setUserModules). */}
              {granted.has(k) && sources[k] && (
                <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                               background: '#eef2ff', color: '#4338ca' }}>
                  for a move request
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      {/* The sentence behind each badge, spelled out, so the reason is visible
          without hovering — the thing an admin needs to know is why someone
          has access they did not give them. */}
      {Object.entries(sources).filter(([k]) => granted.has(k) && orgEnabled.includes(k)).map(([k, s]) => (
        <div key={k} style={{ fontSize: 12, color: '#4b5563', marginBottom: 8 }}>
          {LABELS[k] || k}: {sourceLabel(s)}{s.grantedAt ? ` on ${new Date(s.grantedAt).toLocaleDateString()}` : ''}.
        </div>
      ))}
      {canEdit && orgEnabled.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={save} disabled={saving} style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, border: 'none', background: '#059669', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>{saving ? 'Saving…' : 'Save modules'}</button>
          {msg && <span style={{ fontSize: 12, color: msg === 'Saved' ? '#059669' : '#991b1b' }}>{msg}</span>}
        </div>
      )}
    </div>
  );
}
