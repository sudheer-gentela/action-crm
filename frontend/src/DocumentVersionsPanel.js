// DocumentVersionsPanel.js — v2
// Chunk 2 additions:
//   • Major (X.0) / Minor (X.Y) version selector with clear explanation
//   • upload_comment field (required for major, optional for minor)
//   • Superseded version collapse / expand toggle
//   • Executed document badge + visual distinction
//   • Version number displayed as major.minor (from version_major / version_minor columns)
//   • Resubmit-to-legal notice when NDA major version uploaded while status = with_sales

import React, { useState } from 'react';
import { apiService } from './apiService';

const PROVIDERS = [
  { value: 'google_drive', label: '🔵 Google Drive' },
  { value: 'onedrive',     label: '🟦 OneDrive' },
  { value: 'other',        label: '🔗 Other' },
];

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function providerLabel(provider) {
  return PROVIDERS.find(p => p.value === provider)?.label || '🔗';
}

// Derive the display label from major.minor columns (fallback to legacy version_label)
function versionDisplay(v) {
  if (v.version_major != null && v.version_minor != null) {
    return `${v.version_major}.${v.version_minor}`;
  }
  return v.version_label || '?';
}

export default function DocumentVersionsPanel({ contract: c, onUpdated }) {
  const [showForm, setShowForm]   = useState(false);
  const [showOld, setShowOld]     = useState(false);
  const [form, setForm]           = useState({
    documentUrl:      '',
    documentProvider: 'google_drive',
    versionType:      'major',
    comment:          '',
  });
  const [uploading, setUploading] = useState(false);
  const [err, setErr]             = useState('');

  const versions = c.versions || [];

  // Current = not superseded + is_current flag (or first non-superseded if flag missing)
  const currentVersion = versions.find(v => v.is_current && !v.is_superseded)
    || versions.find(v => !v.is_superseded)
    || versions[0]
    || null;

  const executedVersion = versions.find(v => v.is_executed);

  // Historical = everything that is superseded OR not the current one
  const historicalVersions = versions.filter(v =>
    v.id !== currentVersion?.id
  );
  const supersededCount = historicalVersions.filter(v => v.is_superseded).length;

  async function upload() {
    if (!form.documentUrl.trim()) { setErr('Document URL is required'); return; }
    if (form.versionType === 'major' && !form.comment.trim()) {
      setErr('A comment is required for major versions'); return;
    }
    setUploading(true); setErr('');
    try {
      await apiService.contracts.uploadVersion(c.id, {
        documentUrl:      form.documentUrl,
        documentProvider: form.documentProvider,
        versionType:      form.versionType,
        comment:          form.comment,
      });
      setShowForm(false);
      setForm({ documentUrl: '', documentProvider: 'google_drive', versionType: 'major', comment: '' });
      onUpdated();
    } catch (e) {
      setErr(e.response?.data?.error?.message || e.message || 'Upload failed');
    } finally { setUploading(false); }
  }

  return (
    <div className="dvp-wrap">

      {/* ── Current version card ── */}
      {currentVersion ? (
        <div className={`dvp-current ${currentVersion.is_executed ? 'dvp-current--executed' : ''}`}>
          <div className="dvp-cur-hd">
            <span className="dvp-cur-label">Current Version</span>
            <span className="dvp-ver-badge dvp-ver-badge--cur">v{versionDisplay(currentVersion)}</span>
            <span className={`dvp-type-pill dvp-type-pill--${currentVersion.version_type || 'major'}`}>
              {currentVersion.version_type === 'minor' ? 'minor' : 'major'}
            </span>
            {currentVersion.is_executed && (
              <span className="dvp-executed-badge">✅ Executed</span>
            )}
            {currentVersion.round_number > 1 && (
              <span className="dvp-round">Round {currentVersion.round_number}</span>
            )}
          </div>

          <a href={currentVersion.document_url} target="_blank" rel="noreferrer" className="dvp-link">
            {providerLabel(currentVersion.document_provider)} Open document
          </a>

          {(currentVersion.upload_comment || currentVersion.comment) && (
            <div className="dvp-comment">
              "{currentVersion.upload_comment || currentVersion.comment}"
            </div>
          )}

          <div className="dvp-meta">
            {currentVersion.first_name} {currentVersion.last_name} · {fmt(currentVersion.created_at)}
          </div>
        </div>
      ) : (
        <div className="dvp-no-doc">No document attached yet.</div>
      )}

      {/* ── Executed document separate callout (when different from current) ── */}
      {executedVersion && executedVersion.id !== currentVersion?.id && (
        <div className="dvp-executed-card">
          <div className="dvp-executed-hd">
            <span className="dvp-executed-badge">✅ Executed Document</span>
            <span className="dvp-ver-badge">v{versionDisplay(executedVersion)}</span>
          </div>
          <a href={executedVersion.document_url} target="_blank" rel="noreferrer" className="dvp-link">
            {providerLabel(executedVersion.document_provider)} Open executed document
          </a>
          <div className="dvp-meta">
            {executedVersion.first_name} {executedVersion.last_name} · {fmt(executedVersion.created_at)}
          </div>
        </div>
      )}

      {/* ── Upload form or button ── */}
      {!showForm ? (
        <button className="dvp-upload-btn" onClick={() => setShowForm(true)}>
          + Upload New Version
        </button>
      ) : (
        <div className="dvp-form">
          <div className="dvp-form-title">Upload New Version</div>
          {err && <div className="dvp-err">{err}</div>}

          <label className="dvp-lbl">Document URL *
            <input className="dvp-inp"
              placeholder="Paste Google Drive / OneDrive link"
              value={form.documentUrl}
              onChange={e => setForm({ ...form, documentUrl: e.target.value })} />
          </label>

          <label className="dvp-lbl">Provider
            <select className="dvp-inp" value={form.documentProvider}
              onChange={e => setForm({ ...form, documentProvider: e.target.value })}>
              {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>

          {/* Version type selector */}
          <div className="dvp-vtype-row">
            <div className="dvp-vtype-label">Version type</div>
            <div className="dvp-vtype-opts">
              <button
                className={`dvp-vtype-btn ${form.versionType === 'major' ? 'dvp-vtype-btn--on' : ''}`}
                onClick={() => setForm({ ...form, versionType: 'major' })}>
                <span className="dvp-vtype-icon">◉</span>
                <span>
                  <strong>Major</strong>
                  <span className="dvp-vtype-sub"> (X.0)</span>
                </span>
              </button>
              <button
                className={`dvp-vtype-btn ${form.versionType === 'minor' ? 'dvp-vtype-btn--on' : ''}`}
                onClick={() => setForm({ ...form, versionType: 'minor' })}>
                <span className="dvp-vtype-icon">○</span>
                <span>
                  <strong>Minor</strong>
                  <span className="dvp-vtype-sub"> (X.Y)</span>
                </span>
              </button>
            </div>
            <div className="dvp-vtype-hint">
              {form.versionType === 'major'
                ? '⚠️ Major — new customer redlines or significant revision. Comment required.'
                : 'ℹ️ Minor — internal review iteration. Does not trigger resubmission.'}
            </div>
          </div>

          <label className="dvp-lbl">
            Comment {form.versionType === 'major' ? <span className="dvp-req">*</span> : <span className="dvp-opt">(optional)</span>}
            <input className="dvp-inp"
              placeholder={form.versionType === 'major'
                ? 'e.g. Customer redlines v2 — NDA clause 7 updated'
                : 'e.g. Legal round 1 edits — minor formatting fixes'}
              value={form.comment}
              onChange={e => setForm({ ...form, comment: e.target.value })} />
          </label>

          {/* Resubmit notice for NDA majors while with_sales */}
          {c.status === 'in_review' && c.reviewSubStatus === 'with_sales' && form.versionType === 'major' && (
            <div className={`dvp-notice ${c.contractType === 'nda' ? 'dvp-notice--warn' : 'dvp-notice--info'}`}>
              {c.contractType === 'nda'
                ? '⚠️ NDA — uploading a major version while with Sales will automatically resubmit to Legal.'
                : 'ℹ️ After uploading a major version, use "Resubmit to Legal" if these redlines need review.'}
            </div>
          )}

          <div className="dvp-form-btns">
            <button className="dvp-ok" onClick={upload} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload Version'}
            </button>
            <button className="dvp-cancel" onClick={() => { setShowForm(false); setErr(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Version history ── */}
      {historicalVersions.length > 0 && (
        <div className="dvp-history">
          <button className="dvp-history-toggle" onClick={() => setShowOld(s => !s)}>
            <span className="dvp-history-title">Version History</span>
            <span className="dvp-history-count">{historicalVersions.length} version{historicalVersions.length !== 1 ? 's' : ''}</span>
            {supersededCount > 0 && (
              <span className="dvp-superseded-count">{supersededCount} superseded</span>
            )}
            <span className="dvp-history-chevron">{showOld ? '▲' : '▼'}</span>
          </button>

          {showOld && (
            <div className="dvp-history-list">
              {historicalVersions.map(v => (
                <div key={v.id} className={`dvp-ver-row ${v.is_superseded ? 'dvp-ver-row--superseded' : ''} ${v.is_executed ? 'dvp-ver-row--executed' : ''}`}>
                  <div className="dvp-ver-left">
                    <span className="dvp-ver-badge">v{versionDisplay(v)}</span>
                    <span className={`dvp-type-pill dvp-type-pill--${v.version_type || 'major'}`}>
                      {v.version_type === 'minor' ? 'minor' : 'major'}
                    </span>
                    {v.is_executed && <span className="dvp-exec-mini">✅</span>}
                    {v.is_superseded && <span className="dvp-sup-pill">superseded</span>}
                    {v.round_number > 1 && <span className="dvp-round">R{v.round_number}</span>}
                  </div>
                  <div className="dvp-ver-mid">
                    <a href={v.document_url} target="_blank" rel="noreferrer" className="dvp-old-link">Open</a>
                    {(v.upload_comment || v.comment) && (
                      <span className="dvp-old-comment"> · {v.upload_comment || v.comment}</span>
                    )}
                  </div>
                  <div className="dvp-ver-meta">
                    {v.first_name} {v.last_name} · {fmt(v.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <style>{`
        .dvp-wrap{display:flex;flex-direction:column;gap:12px}

        /* Current version */
        .dvp-current{padding:13px;border:1.5px solid #c7d2fe;border-radius:10px;background:#f5f3ff}
        .dvp-current--executed{border-color:#6ee7b7;background:#f0fdf4}
        .dvp-cur-hd{display:flex;align-items:center;gap:7px;margin-bottom:7px;flex-wrap:wrap}
        .dvp-cur-label{font-size:11px;font-weight:700;color:#5b21b6;text-transform:uppercase;letter-spacing:.3px}
        .dvp-current--executed .dvp-cur-label{color:#065f46}

        /* Executed card */
        .dvp-executed-card{padding:11px 13px;border:1.5px solid #6ee7b7;border-radius:10px;background:#f0fdf4}
        .dvp-executed-hd{display:flex;align-items:center;gap:7px;margin-bottom:6px}
        .dvp-executed-badge{font-size:11px;font-weight:700;color:#065f46;background:#bbf7d0;padding:2px 7px;border-radius:4px}

        /* Badges & pills */
        .dvp-ver-badge{font-size:11px;font-weight:700;background:#ede9fe;color:#5b21b6;padding:2px 7px;border-radius:5px}
        .dvp-ver-badge--cur{background:#6366f1;color:#fff}
        .dvp-type-pill{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}
        .dvp-type-pill--major{background:#fef3c7;color:#92400e}
        .dvp-type-pill--minor{background:#f0fdf4;color:#065f46}
        .dvp-sup-pill{font-size:9px;font-weight:700;background:#fee2e2;color:#991b1b;padding:1px 5px;border-radius:3px;text-transform:uppercase}
        .dvp-exec-mini{font-size:12px}
        .dvp-round{font-size:10px;color:#94a3b8}

        /* Common */
        .dvp-link{display:inline-block;font-size:13px;color:#6366f1;font-weight:600;text-decoration:none;margin-bottom:5px}
        .dvp-link:hover{text-decoration:underline}
        .dvp-comment{font-size:12px;color:#475569;font-style:italic;margin-bottom:3px}
        .dvp-meta{font-size:11px;color:#94a3b8}
        .dvp-no-doc{text-align:center;color:#94a3b8;font-size:13px;padding:14px 0}

        /* Upload button */
        .dvp-upload-btn{padding:9px;border:1.5px dashed #6366f1;border-radius:9px;background:none;color:#6366f1;font-size:12px;font-weight:600;cursor:pointer;text-align:center;width:100%}
        .dvp-upload-btn:hover{background:#f5f3ff}

        /* Upload form */
        .dvp-form{border:1.5px solid #e2e8f0;border-radius:10px;padding:13px;display:flex;flex-direction:column;gap:10px;background:#f8fafc}
        .dvp-form-title{font-size:13px;font-weight:700;color:#0f172a}
        .dvp-err{font-size:12px;color:#991b1b;background:#fef2f2;padding:6px 10px;border-radius:6px}
        .dvp-lbl{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:#475569}
        .dvp-req{color:#ef4444}
        .dvp-opt{font-weight:400;color:#94a3b8}
        .dvp-inp{padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:7px;font-size:13px;font-family:inherit;outline:none;background:#fff;color:#0f172a}
        .dvp-inp:focus{border-color:#6366f1}

        /* Version type selector */
        .dvp-vtype-row{display:flex;flex-direction:column;gap:6px}
        .dvp-vtype-label{font-size:12px;font-weight:600;color:#475569}
        .dvp-vtype-opts{display:flex;gap:8px}
        .dvp-vtype-btn{flex:1;padding:9px 10px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:7px;text-align:left}
        .dvp-vtype-btn--on{border-color:#6366f1;background:#eef2ff;color:#4f46e5}
        .dvp-vtype-icon{font-size:14px}
        .dvp-vtype-sub{font-weight:400;color:#94a3b8}
        .dvp-vtype-hint{font-size:11px;color:#64748b;background:#f1f5f9;padding:6px 9px;border-radius:6px}

        /* Notices */
        .dvp-notice{font-size:12px;padding:8px 11px;border-radius:7px}
        .dvp-notice--info{background:#dbeafe;color:#1e40af}
        .dvp-notice--warn{background:#fee2e2;color:#991b1b}

        /* Form buttons */
        .dvp-form-btns{display:flex;gap:8px}
        .dvp-ok{padding:8px 18px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
        .dvp-ok:hover:not(:disabled){background:#4f46e5}
        .dvp-ok:disabled{opacity:.5;cursor:not-allowed}
        .dvp-cancel{padding:8px 14px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#64748b;font-size:13px;cursor:pointer}

        /* History */
        .dvp-history{border:1px solid #f1f5f9;border-radius:9px;overflow:hidden}
        .dvp-history-toggle{width:100%;display:flex;align-items:center;gap:7px;padding:9px 12px;background:#f8fafc;border:none;cursor:pointer;font-family:inherit}
        .dvp-history-toggle:hover{background:#f1f5f9}
        .dvp-history-title{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.3px}
        .dvp-history-count{font-size:11px;color:#94a3b8;margin-left:auto}
        .dvp-superseded-count{font-size:10px;background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:3px}
        .dvp-history-chevron{font-size:10px;color:#94a3b8}
        .dvp-history-list{display:flex;flex-direction:column;gap:0}
        .dvp-ver-row{display:flex;align-items:center;gap:7px;padding:8px 12px;border-top:1px solid #f1f5f9;background:#fff;flex-wrap:wrap}
        .dvp-ver-row--superseded{background:#fafafa;opacity:.75}
        .dvp-ver-row--executed{background:#f0fdf4}
        .dvp-ver-left{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
        .dvp-ver-mid{flex:1;font-size:12px;color:#475569;min-width:0}
        .dvp-old-link{color:#6366f1;text-decoration:none;font-weight:600}
        .dvp-old-link:hover{text-decoration:underline}
        .dvp-old-comment{color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dvp-ver-meta{font-size:10px;color:#94a3b8;white-space:nowrap}
      `}</style>
    </div>
  );
}
