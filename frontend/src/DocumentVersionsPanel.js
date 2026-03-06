// DocumentVersionsPanel.js
import React, { useState } from 'react';
import { apiService } from './apiService';

const PROVIDERS = [
  { value:'google_drive', label:'🔵 Google Drive' },
  { value:'onedrive',     label:'🟦 OneDrive' },
  { value:'other',        label:'🔗 Other' },
];

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

export default function DocumentVersionsPanel({ contract: c, onUpdated }) {
  const [show, setShow]         = useState(false);
  const [form, setForm]         = useState({ documentUrl:'', documentProvider:'google_drive', versionType:'major', comment:'' });
  const [uploading, setUploading] = useState(false);
  const [err, setErr]           = useState('');

  const versions = c.versions || [];
  const current  = versions.find(v => v.is_current);

  async function upload() {
    if (!form.documentUrl.trim()) { setErr('Document URL is required'); return; }
    if (form.versionType === 'major' && !form.comment.trim()) { setErr('Comment is required for major versions'); return; }
    setUploading(true); setErr('');
    try {
      await apiService.contracts.uploadVersion(c.id, form);
      setShow(false);
      setForm({ documentUrl:'', documentProvider:'google_drive', versionType:'major', comment:'' });
      onUpdated();
    } catch (e) { setErr(e.response?.data?.error?.message || e.message || 'Upload failed'); }
    finally { setUploading(false); }
  }

  return (
    <div className="dvp-wrap">
      {/* Current version */}
      {current ? (
        <div className="dvp-current">
          <div className="dvp-cur-hd">
            <span className="dvp-cur-label">Current Version</span>
            <span className="dvp-ver-badge dvp-ver-badge--cur">v{current.version_label}</span>
            <span className={`dvp-type-pill dvp-type-pill--${current.version_type}`}>{current.version_type}</span>
            {current.round_number > 1 && <span className="dvp-round">Round {current.round_number}</span>}
          </div>
          <a href={current.document_url} target="_blank" rel="noreferrer" className="dvp-link">
            {PROVIDERS.find(p=>p.value===current.document_provider)?.label||'🔗'} Open document
          </a>
          {current.comment && <div className="dvp-comment">"{current.comment}"</div>}
          <div className="dvp-meta">
            {current.first_name} {current.last_name} · {fmt(current.created_at)}
          </div>
        </div>
      ) : (
        <div className="dvp-no-doc">No document attached yet.</div>
      )}

      {/* Upload */}
      {!show ? (
        <button className="dvp-upload-btn" onClick={() => setShow(true)}>+ Upload New Version</button>
      ) : (
        <div className="dvp-form">
          <div className="dvp-form-title">Upload New Version</div>
          {err && <div className="dvp-err">{err}</div>}

          <label className="dvp-lbl">Document URL
            <input className="dvp-inp" placeholder="Paste Google Drive / OneDrive link"
              value={form.documentUrl} onChange={e => setForm({...form,documentUrl:e.target.value})} />
          </label>

          <label className="dvp-lbl">Provider
            <select className="dvp-inp" value={form.documentProvider}
              onChange={e => setForm({...form,documentProvider:e.target.value})}>
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>

          <div className="dvp-vtype-row">
            <div className="dvp-vtype-label">Version type</div>
            <div className="dvp-vtype-opts">
              {['major','minor'].map(vt => (
                <button key={vt}
                  className={`dvp-vtype-btn ${form.versionType===vt?'dvp-vtype-btn--on':''}`}
                  onClick={() => setForm({...form,versionType:vt})}>
                  {vt==='major' ? '◉ Major (X.0)' : '○ Minor (X.Y)'}
                </button>
              ))}
            </div>
            <div className="dvp-vtype-hint">
              {form.versionType==='major'
                ? 'New customer redlines or significant revision'
                : 'Internal review iteration — no resubmit trigger'}
            </div>
          </div>

          <label className="dvp-lbl">Comment {form.versionType==='major' ? '(required)' : '(optional)'}
            <input className="dvp-inp" placeholder={form.versionType==='major'?'e.g. Customer redlines v2':'e.g. Legal edits round 1'}
              value={form.comment} onChange={e => setForm({...form,comment:e.target.value})} />
          </label>

          {/* Resubmit notice */}
          {c.status==='with_sales' && form.versionType==='major' && (
            <div className={`dvp-notice ${c.contractType==='nda'?'dvp-notice--warn':''}`}>
              {c.contractType==='nda'
                ? '⚠️ NDA — uploading this version will trigger resubmission to legal review.'
                : 'ℹ️ After uploading a major version, use "Resubmit to Legal" if redlines need review.'}
            </div>
          )}

          <div className="dvp-form-btns">
            <button className="dvp-ok" onClick={upload} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            <button className="dvp-cancel" onClick={() => setShow(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* History */}
      {versions.length > 1 && (
        <div className="dvp-history">
          <div className="dvp-history-title">Version History</div>
          {versions.filter(v=>!v.is_current).map(v => (
            <div key={v.id} className="dvp-ver-row">
              <div className="dvp-ver-left">
                <span className="dvp-ver-badge">v{v.version_label}</span>
                <span className={`dvp-type-pill dvp-type-pill--${v.version_type}`}>{v.version_type}</span>
                {v.round_number > 1 && <span className="dvp-round">R{v.round_number}</span>}
              </div>
              <div className="dvp-ver-mid">
                <a href={v.document_url} target="_blank" rel="noreferrer" className="dvp-old-link">Open</a>
                {v.comment && <span className="dvp-old-comment"> · {v.comment}</span>}
              </div>
              <div className="dvp-ver-meta">{v.first_name} {v.last_name} · {fmt(v.created_at)}</div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .dvp-wrap{display:flex;flex-direction:column;gap:12px}
        .dvp-current{padding:13px;border:1.5px solid #c7d2fe;border-radius:10px;background:#f5f3ff}
        .dvp-cur-hd{display:flex;align-items:center;gap:7px;margin-bottom:7px}
        .dvp-cur-label{font-size:11px;font-weight:700;color:#5b21b6;text-transform:uppercase}
        .dvp-ver-badge{font-size:11px;font-weight:700;background:#ede9fe;color:#5b21b6;padding:2px 7px;border-radius:5px}
        .dvp-ver-badge--cur{background:#6366f1;color:#fff}
        .dvp-type-pill{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}
        .dvp-type-pill--major{background:#fef3c7;color:#92400e}
        .dvp-type-pill--minor{background:#f0fdf4;color:#065f46}
        .dvp-round{font-size:10px;color:#94a3b8}
        .dvp-link{display:inline-block;font-size:13px;color:#6366f1;font-weight:600;text-decoration:none;margin-bottom:5px}
        .dvp-link:hover{text-decoration:underline}
        .dvp-comment{font-size:12px;color:#475569;font-style:italic;margin-bottom:3px}
        .dvp-meta{font-size:11px;color:#94a3b8}
        .dvp-no-doc{text-align:center;color:#94a3b8;font-size:13px;padding:14px 0}
        .dvp-upload-btn{padding:9px;border:1.5px dashed #6366f1;border-radius:9px;background:none;color:#6366f1;font-size:12px;font-weight:600;cursor:pointer;text-align:center}
        .dvp-upload-btn:hover{background:#f5f3ff}
        .dvp-form{border:1.5px solid #e2e8f0;border-radius:10px;padding:13px;display:flex;flex-direction:column;gap:9px;background:#f8fafc}
        .dvp-form-title{font-size:13px;font-weight:700;color:#0f172a}
        .dvp-err{font-size:12px;color:#991b1b;background:#fef2f2;padding:6px 10px;border-radius:6px}
        .dvp-lbl{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#475569}
        .dvp-inp{padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:13px;font-family:inherit;outline:none;background:#fff}
        .dvp-inp:focus{border-color:#6366f1}
        .dvp-vtype-row{display:flex;flex-direction:column;gap:5px}
        .dvp-vtype-label{font-size:12px;font-weight:600;color:#475569}
        .dvp-vtype-opts{display:flex;gap:7px}
        .dvp-vtype-btn{flex:1;padding:7px;border:1.5px solid #e2e8f0;border-radius:7px;background:#fff;font-size:12px;cursor:pointer;font-family:inherit}
        .dvp-vtype-btn--on{border-color:#6366f1;background:#eef2ff;color:#4f46e5;font-weight:700}
        .dvp-vtype-hint{font-size:11px;color:#94a3b8}
        .dvp-notice{font-size:12px;padding:8px 11px;border-radius:7px;background:#dbeafe;color:#1e40af}
        .dvp-notice--warn{background:#fee2e2;color:#991b1b}
        .dvp-form-btns{display:flex;gap:8px}
        .dvp-ok{padding:8px 18px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
        .dvp-ok:disabled{opacity:.5}
        .dvp-cancel{padding:8px 14px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#64748b;font-size:13px;cursor:pointer}
        .dvp-history{display:flex;flex-direction:column;gap:5px}
        .dvp-history-title{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:3px}
        .dvp-ver-row{display:flex;align-items:center;gap:7px;padding:7px;border:1px solid #f1f5f9;border-radius:7px;background:#fff;flex-wrap:wrap}
        .dvp-ver-left{display:flex;gap:4px;align-items:center}
        .dvp-ver-mid{flex:1;font-size:12px;color:#475569}
        .dvp-old-link{color:#6366f1;text-decoration:none;font-weight:600}
        .dvp-old-link:hover{text-decoration:underline}
        .dvp-old-comment{color:#94a3b8}
        .dvp-ver-meta{font-size:10px;color:#94a3b8}
      `}</style>
    </div>
  );
}
