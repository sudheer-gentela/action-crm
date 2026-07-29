// ─────────────────────────────────────────────────────────────────────────────
// ModuleAccessRequest.js
//
// DROP-IN LOCATION: frontend/src/ModuleAccessRequest.js
//
// In the account menu. A member requests a module they have for someone else:
//   • Existing colleague → module grant request (admin approves → colleague granted)
//   • New person by email → scoped invitation (admin approves → email → they join
//     with that module)
// Only modules the requester has are offered.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

const LABELS = { prospecting: 'Prospecting', contracts: 'Contracts', handovers: 'Handovers', service: 'Service', agency: 'Agency' };

export default function ModuleAccessRequest() {
  const [open, setOpen]         = useState(false);
  const [mode, setMode]         = useState('existing'); // 'existing' | 'new'
  const [colleagues, setColleagues] = useState([]);
  const [target, setTarget]     = useState('');
  const [email, setEmail]       = useState('');
  const [modules, setModules]   = useState([]);
  const [moduleKey, setModuleKey] = useState('');
  const [msg, setMsg]           = useState('');
  const [busy, setBusy]         = useState(false);

  useEffect(() => {
    if (!open) return;
    apiService.handovers.moduleColleagues().then(r => setColleagues(r.data.colleagues || [])).catch(() => setColleagues([]));
  }, [open]);

  // Existing: modules the requester has that the chosen colleague lacks.
  useEffect(() => {
    if (mode !== 'existing') return;
    setModuleKey(''); setModules([]);
    if (!target) return;
    apiService.handovers.grantableModules(target).then(r => setModules(r.data.modules || [])).catch(() => setModules([]));
  }, [target, mode]);

  // New: modules the requester has (offered for a brand-new invitee).
  useEffect(() => {
    if (mode !== 'new') return;
    setModuleKey('');
    apiService.handovers.myGrantableModules().then(r => setModules(r.data.modules || [])).catch(() => setModules([]));
  }, [mode]);

  const reset = () => { setTarget(''); setEmail(''); setModuleKey(''); setModules([]); setMsg(''); };

  const submit = async () => {
    setMsg('');
    if (!moduleKey) { setMsg('Pick a module.'); return; }
    setBusy(true);
    try {
      if (mode === 'existing') {
        if (!target) { setMsg('Pick a colleague.'); setBusy(false); return; }
        await apiService.handovers.requestModuleFor(target, moduleKey);
        setMsg('Request sent to an admin.');
      } else {
        if (!email.trim()) { setMsg('Enter an email.'); setBusy(false); return; }
        await apiService.handovers.requestNewUserModule(email.trim(), moduleKey);
        setMsg('Invite requested — an admin will approve, then they get an email to join.');
      }
      reset();
    } catch (e) { setMsg(e?.response?.data?.error?.message || 'Could not send request.'); }
    finally { setBusy(false); }
  };

  const sel = { width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 6, boxSizing: 'border-box' };
  const ok = msg.startsWith('Request sent') || msg.startsWith('Invite requested');

  return (
    <div style={{ padding: '6px 10px', borderTop: '1px solid rgba(0,0,0,0.06)', marginTop: 4 }}>
      {!open ? (
        <button className="sb-popover-item" onClick={() => { setOpen(true); setMsg(''); }} style={{ width: '100%', textAlign: 'left' }}>
          <span>🔑</span> Request module access for someone
        </button>
      ) : (
        <div>
          <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden', marginBottom: 6 }}>
            {[['existing', 'Existing member'], ['new', 'New person']].map(([k, label]) => (
              <button key={k} onClick={() => { setMode(k); reset(); }} style={{ padding: '3px 9px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer', background: mode === k ? '#1d4ed8' : '#fff', color: mode === k ? '#fff' : '#374151' }}>{label}</button>
            ))}
          </div>

          {mode === 'existing' ? (
            <>
              <select value={target} onChange={e => setTarget(e.target.value)} style={sel}>
                <option value="">Select colleague…</option>
                {colleagues.map(c => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
              </select>
              {target !== '' && (
                <select value={moduleKey} onChange={e => setModuleKey(e.target.value)} style={sel} disabled={!modules.length}>
                  <option value="">{modules.length ? 'Select module…' : 'No modules to grant them'}</option>
                  {modules.map(k => <option key={k} value={k}>{LABELS[k] || k}</option>)}
                </select>
              )}
            </>
          ) : (
            <>
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="person@company.com" style={sel} />
              <select value={moduleKey} onChange={e => setModuleKey(e.target.value)} style={sel} disabled={!modules.length}>
                <option value="">{modules.length ? 'Select module…' : 'No modules available'}</option>
                {modules.map(k => <option key={k} value={k}>{LABELS[k] || k}</option>)}
              </select>
            </>
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={submit} disabled={busy || !moduleKey} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 5, border: 'none', background: (busy || !moduleKey) ? '#9ca3af' : '#059669', color: '#fff', cursor: (busy || !moduleKey) ? 'default' : 'pointer' }}>Request</button>
            <button onClick={() => { setOpen(false); reset(); }} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, border: 'none', background: '#f1f5f9', color: '#374151', cursor: 'pointer' }}>Cancel</button>
          </div>
          {msg && <div style={{ fontSize: 11, color: ok ? '#059669' : '#991b1b', marginTop: 6 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
