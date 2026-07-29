// ─────────────────────────────────────────────────────────────────────────────
// ModuleAccessRequest.js
//
// DROP-IN LOCATION: frontend/src/ModuleAccessRequest.js
//
// In the account menu. A member requests a module they have on behalf of a
// COLLEAGUE who doesn't have it → admin approval. Pick a colleague, then pick
// from the modules you have that they lack.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

const LABELS = { prospecting: 'Prospecting', contracts: 'Contracts', handovers: 'Handovers', service: 'Service', agency: 'Agency' };

export default function ModuleAccessRequest() {
  const [open, setOpen]         = useState(false);
  const [colleagues, setColleagues] = useState([]);
  const [target, setTarget]     = useState('');
  const [modules, setModules]   = useState([]);
  const [moduleKey, setModuleKey] = useState('');
  const [msg, setMsg]           = useState('');
  const [busy, setBusy]         = useState(false);

  useEffect(() => {
    if (!open) return;
    apiService.handovers.moduleColleagues().then(r => setColleagues(r.data.colleagues || [])).catch(() => setColleagues([]));
  }, [open]);

  useEffect(() => {
    setModuleKey(''); setModules([]);
    if (!target) return;
    apiService.handovers.grantableModules(target).then(r => setModules(r.data.modules || [])).catch(() => setModules([]));
  }, [target]);

  const submit = async () => {
    setMsg('');
    if (!target || !moduleKey) { setMsg('Pick a colleague and a module.'); return; }
    setBusy(true);
    try {
      await apiService.handovers.requestModuleFor(target, moduleKey);
      setMsg('Request sent to an admin.');
      setTarget(''); setModuleKey(''); setModules([]);
    } catch (e) { setMsg(e?.response?.data?.error?.message || 'Could not send request.'); }
    finally { setBusy(false); }
  };

  const sel = { width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 6, boxSizing: 'border-box' };

  return (
    <div style={{ padding: '6px 10px', borderTop: '1px solid rgba(0,0,0,0.06)', marginTop: 4 }}>
      {!open ? (
        <button className="sb-popover-item" onClick={() => { setOpen(true); setMsg(''); }} style={{ width: '100%', textAlign: 'left' }}>
          <span>🔑</span> Request module access for a colleague
        </button>
      ) : (
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>Request module access for a colleague</div>
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
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={submit} disabled={busy || !moduleKey} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 5, border: 'none', background: (busy || !moduleKey) ? '#9ca3af' : '#059669', color: '#fff', cursor: (busy || !moduleKey) ? 'default' : 'pointer' }}>Request</button>
            <button onClick={() => { setOpen(false); setMsg(''); setTarget(''); }} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, border: 'none', background: '#f1f5f9', color: '#374151', cursor: 'pointer' }}>Cancel</button>
          </div>
          {msg && <div style={{ fontSize: 11, color: msg.startsWith('Request sent') ? '#059669' : '#991b1b', marginTop: 6 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
