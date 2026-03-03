import React, { useState, useEffect, useCallback } from 'react';
import './StrapPanel.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `HTTP ${res.status}`); }
  return res.json();
}

const PRI = {
  critical: { color: '#dc2626', bg: '#fef2f2', label: 'Critical' },
  high:     { color: '#ef4444', bg: '#fef2f2', label: 'High' },
  medium:   { color: '#f59e0b', bg: '#fffbeb', label: 'Medium' },
  low:      { color: '#10b981', bg: '#ecfdf5', label: 'Low' },
};
const ELBL = { deal:'Deal', account:'Account', prospect:'Prospect', implementation:'Implementation' };

function StrapPanel({ entityType, entityId }) {
  const [strap, setStrap] = useState(null);
  const [hist, setHist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(false);
  const [error, setError] = useState('');
  const [showHist, setShowHist] = useState(false);
  const [showOvr, setShowOvr] = useState(false);
  const [exp, setExp] = useState(true);
  const [ovrForm, setOvrForm] = useState({ hurdleType:'', hurdleTitle:'', priority:'medium', reason:'', situation:'', target:'', response:'', actionPlan:'' });

  const load = useCallback(async () => {
    if (!entityType || !entityId) return;
    try { setLoading(true); setError(''); const d = await apiFetch(`/straps/${entityType}/${entityId}`); setStrap(d.strap || null); }
    catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [entityType, entityId]);

  const loadHist = useCallback(async () => {
    if (!entityType || !entityId) return;
    try { const d = await apiFetch(`/straps/${entityType}/${entityId}/history`); setHist(d.history || []); }
    catch (e) { console.error('STRAP history error:', e); }
  }, [entityType, entityId]);

  useEffect(() => { load(); }, [load]);

  const doGen = async () => {
    try { setGen(true); setError(''); const d = await apiFetch(`/straps/${entityType}/${entityId}/generate`, { method:'POST', body:JSON.stringify({ useAI:true }) }); setStrap(d.strap||null); if (!d.strap && d.message) setError(d.message); }
    catch (e) { setError(e.message); } finally { setGen(false); }
  };
  const doResolve = async () => {
    if (!strap) return;
    try { await apiFetch(`/straps/${strap.id}/resolve`, { method:'PUT', body:JSON.stringify({ resolutionType:'manual', note:'Resolved by user' }) }); setStrap(null); load(); }
    catch (e) { setError(e.message); }
  };
  const doReassess = async () => {
    if (!strap) return;
    try { setGen(true); const d = await apiFetch(`/straps/${strap.id}/reassess`, { method:'PUT' }); setStrap(d.strap||null); }
    catch (e) { setError(e.message); } finally { setGen(false); }
  };
  const doOverride = async () => {
    try { setGen(true); const d = await apiFetch(`/straps/${entityType}/${entityId}/override`, { method:'POST', body:JSON.stringify(ovrForm) }); setStrap(d.strap||null); setShowOvr(false); setOvrForm({ hurdleType:'', hurdleTitle:'', priority:'medium', reason:'', situation:'', target:'', response:'', actionPlan:'' }); }
    catch (e) { setError(e.message); } finally { setGen(false); }
  };
  const togHist = () => { if (!showHist) loadHist(); setShowHist(!showHist); };

  if (loading) return <div className="sp-panel"><div className="sp-loading">Loading STRAP...</div></div>;

  if (!strap) return (
    <div className="sp-panel"><div className="sp-empty">
      <p className="sp-empty-text">No active STRAP for this {ELBL[entityType]||entityType}.</p>
      {error && <p className="sp-error">{error}</p>}
      <div className="sp-empty-actions">
        <button className="sp-btn sp-btn--primary" onClick={doGen} disabled={gen}>{gen ? 'Analyzing...' : 'Generate STRAP'}</button>
        <button className="sp-btn sp-btn--secondary" onClick={() => setShowOvr(true)}>Manual Override</button>
        <button className="sp-btn sp-btn--ghost" onClick={togHist}>History</button>
      </div>
      {showOvr && <OvrForm f={ovrForm} set={setOvrForm} save={doOverride} cancel={() => setShowOvr(false)} busy={gen} />}
      {showHist && <Hist items={hist} et={entityType} />}
    </div></div>
  );

  const pc = PRI[strap.priority] || PRI.medium;
  return (
    <div className="sp-panel">
      {error && <p className="sp-error">{error}</p>}
      <div className="sp-header" onClick={() => setExp(!exp)}>
        <div className="sp-header-left">
          <span className="sp-priority-badge" style={{ background:pc.bg, color:pc.color }}>{pc.label}</span>
          <span className="sp-hurdle-title">{strap.hurdle_title}</span>
          {strap.source==='manual' && <span className="sp-manual-badge">Manual</span>}
        </div>
        <span className="sp-expand-icon">{exp ? '\u25B2' : '\u25BC'}</span>
      </div>
      {exp && <div className="sp-body">
        {strap.situation && <Sec icon="S" label="Situation" text={strap.situation} />}
        {strap.target && <Sec icon="T" label="Target" text={strap.target} />}
        {strap.response && <Sec icon="R" label="Response" text={strap.response} />}
        {strap.action_plan && <Sec icon="A" label="Action Plan" text={strap.action_plan} pre />}
        <div className="sp-meta">
          <span>{strap.hurdle_type.replace(/_/g,' ')}</span>
          <span>{new Date(strap.created_at).toLocaleDateString()}</span>
          {strap.ai_model && <span>AI: {strap.ai_model}</span>}
        </div>
        <div className="sp-actions">
          <button className="sp-btn sp-btn--success" onClick={doResolve}>Resolve</button>
          <button className="sp-btn sp-btn--secondary" onClick={doReassess} disabled={gen}>{gen?'Working...':'Reassess'}</button>
          <button className="sp-btn sp-btn--ghost" onClick={() => setShowOvr(true)}>Override</button>
          <button className="sp-btn sp-btn--ghost" onClick={togHist}>History</button>
        </div>
      </div>}
      {showOvr && <OvrForm f={ovrForm} set={setOvrForm} save={doOverride} cancel={() => setShowOvr(false)} busy={gen} />}
      {showHist && <Hist items={hist} et={entityType} />}
    </div>
  );
}

function Sec({ icon, label, text, pre }) {
  return (<div className="sp-section">
    <div className="sp-section-label"><span className="sp-section-icon">{icon}</span> {label}</div>
    <div className={`sp-section-content${pre?' sp-pre':''}`}>{text}</div>
  </div>);
}

function OvrForm({ f, set, save, cancel, busy }) {
  const u = (k,v) => set(p => ({...p,[k]:v}));
  return (<div className="sp-override-form">
    <h4 className="sp-override-title">Manual Override</h4>
    <div className="sp-form-grid">
      <div className="sp-form-group"><label>Hurdle Type</label><input value={f.hurdleType} onChange={e=>u('hurdleType',e.target.value)} placeholder="e.g. buyer_engagement" /></div>
      <div className="sp-form-group"><label>Hurdle Title</label><input value={f.hurdleTitle} onChange={e=>u('hurdleTitle',e.target.value)} placeholder="e.g. Key stakeholder unresponsive" /></div>
      <div className="sp-form-group"><label>Priority</label><select value={f.priority} onChange={e=>u('priority',e.target.value)}><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
      <div className="sp-form-group sp-form-full"><label>Reason</label><input value={f.reason} onChange={e=>u('reason',e.target.value)} placeholder="Why override?" /></div>
      <div className="sp-form-group sp-form-full"><label>Situation</label><textarea value={f.situation} onChange={e=>u('situation',e.target.value)} rows={2} /></div>
      <div className="sp-form-group sp-form-full"><label>Target</label><input value={f.target} onChange={e=>u('target',e.target.value)} /></div>
      <div className="sp-form-group sp-form-full"><label>Action Plan</label><textarea value={f.actionPlan} onChange={e=>u('actionPlan',e.target.value)} rows={3} placeholder="1. First step..." /></div>
    </div>
    <div className="sp-override-actions">
      <button className="sp-btn sp-btn--primary" onClick={save} disabled={!f.hurdleType||!f.hurdleTitle||busy}>{busy?'Saving...':'Save Override'}</button>
      <button className="sp-btn sp-btn--ghost" onClick={cancel}>Cancel</button>
    </div>
  </div>);
}

function Hist({ items, et }) {
  if (!items.length) return <div className="sp-history"><p className="sp-history-empty">No STRAP history.</p></div>;
  return (<div className="sp-history"><h4 className="sp-history-title">STRAP History</h4>
    {items.map(h => { const hpc = PRI[h.priority]||PRI.medium; return (
      <div key={h.id} className={`sp-history-item sp-history--${h.status}`}>
        <div className="sp-history-header">
          <span className="sp-priority-badge-sm" style={{background:hpc.bg,color:hpc.color}}>{hpc.label}</span>
          <span className="sp-history-hurdle">{h.hurdle_title}</span>
          <span className={`sp-status-badge sp-status--${h.status}`}>{h.status}</span>
        </div>
        <div className="sp-history-meta">
          <span>{new Date(h.created_at).toLocaleDateString()}</span>
          {h.resolved_at && <span> &rarr; {new Date(h.resolved_at).toLocaleDateString()} ({h.resolution_type})</span>}
          {h.source==='manual' && <span className="sp-manual-badge-sm">manual</span>}
        </div>
        {h.resolution_note && <div className="sp-history-note">{h.resolution_note}</div>}
      </div>
    );})}
  </div>);
}

export default StrapPanel;
