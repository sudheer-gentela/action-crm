/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAPlaybookTypes. Includes co-located single-consumer constants/helpers. */
import React, { useState, useEffect } from 'react';

const ICON_OPTIONS = ['📂', '🎧', '🔄', '🤝', '📞', '🚀', '💡', '🛡️', '📊', '🎓', '⚡', '🌐'];

const COLOR_PRESETS_PB = ['#3b82f6', '#0F9D8E', '#8b5cf6', '#ef4444', '#f59e0b', '#10b981', '#ec4899', '#6366f1', '#14b8a6', '#f97316', '#6b7280', '#1d4ed8'];

export default function OAPlaybookTypes() {
  const API   = process.env.REACT_APP_API_URL || '';
  const token = localStorage.getItem('token');

  const [types, setTypes]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [newType, setNewType]   = useState({ label: '', icon: '📂', color: '#6b7280' });
  const [adding, setAdding]     = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const flash = (type, msg) => {
    if (type === 'error') { setError(msg); setTimeout(() => setError(''), 4000); }
    else { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/org/admin/playbook-types`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        setTypes(data.playbook_types || []);
      } catch { flash('error', 'Failed to load playbook types'); }
      finally { setLoading(false); }
    })();
  }, [API, token]);

  const handleAdd = async () => {
    if (!newType.label.trim()) { flash('error', 'Label is required'); return; }
    setAdding(true);
    try {
      const key = newType.label.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      const res = await fetch(`${API}/org/admin/playbook-types`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label: newType.label.trim(), icon: newType.icon, color: newType.color }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      setTypes(data.playbook_types);
      setNewType({ label: '', icon: '📂', color: '#6b7280' });
      setShowAdd(false);
      flash('success', `"${newType.label.trim()}" type added ✓`);
    } catch (e) { flash('error', e.message); }
    finally { setAdding(false); }
  };

  const handleDelete = async (typeKey) => {
    const t = types.find(x => x.key === typeKey);
    if (!window.confirm(`Delete "${t?.label || typeKey}" playbook type? Playbooks of this type must be reassigned first.`)) return;
    setDeleting(typeKey);
    try {
      const res = await fetch(`${API}/org/admin/playbook-types/${typeKey}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      setTypes(data.playbook_types);
      flash('success', `"${t?.label}" removed ✓`);
    } catch (e) { flash('error', e.message); }
    finally { setDeleting(null); }
  };

  if (loading) return <div className="sv-card"><div className="sv-loading" style={{ padding: 16 }}>Loading playbook types…</div></div>;

  return (
    <div className="sv-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>📋 Playbook Types</h3>
          <p className="sv-hint" style={{ margin: '4px 0 0' }}>Define the categories of playbooks your org uses. System types cannot be removed.</p>
        </div>
        <button className="sv-btn-primary" style={{ fontSize: 13, padding: '6px 14px' }} onClick={() => setShowAdd(true)}>
          + Add Type
        </button>
      </div>

      {error   && <div className="sv-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ marginBottom: 12 }}>{success}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {types.map(t => (
          <div key={t.key} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
            background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb',
          }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{
              width: 14, height: 14, borderRadius: '50%', background: t.color,
              flexShrink: 0, border: '2px solid #fff', boxShadow: '0 0 0 1px #d1d5db',
            }} />
            <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{t.label}</span>
            <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{t.key}</span>
            {t.is_system ? (
              <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '2px 8px', borderRadius: 4 }}>System</span>
            ) : (
              <button
                onClick={() => handleDelete(t.key)}
                disabled={deleting === t.key}
                style={{
                  background: 'none', border: '1px solid #fca5a5', color: '#dc2626',
                  padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                }}
              >
                {deleting === t.key ? '…' : '✕ Remove'}
              </button>
            )}
          </div>
        ))}
      </div>

      {showAdd && (
        <div style={{ marginTop: 16, padding: 16, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
          <h4 style={{ margin: '0 0 12px', fontSize: 14 }}>Add New Playbook Type</h4>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="sv-field" style={{ flex: 1, minWidth: 160 }}>
              <label style={{ fontSize: 12 }}>Label</label>
              <input className="sv-input" placeholder="e.g. Customer Support"
                value={newType.label} onChange={e => setNewType(p => ({ ...p, label: e.target.value }))} />
            </div>
            <div className="sv-field" style={{ width: 80 }}>
              <label style={{ fontSize: 12 }}>Icon</label>
              <select className="sv-input" value={newType.icon} onChange={e => setNewType(p => ({ ...p, icon: e.target.value }))}>
                {ICON_OPTIONS.map(ic => <option key={ic} value={ic}>{ic}</option>)}
              </select>
            </div>
            <div className="sv-field">
              <label style={{ fontSize: 12 }}>Color</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {COLOR_PRESETS_PB.map(c => (
                  <button key={c} onClick={() => setNewType(p => ({ ...p, color: c }))} style={{
                    width: 22, height: 22, borderRadius: '50%', background: c, border: newType.color === c ? '2px solid #111' : '2px solid transparent',
                    cursor: 'pointer', padding: 0,
                  }} />
                ))}
              </div>
            </div>
          </div>

          {/* Preview */}
          {newType.label.trim() && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#fff', borderRadius: 6, border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>{newType.icon}</span>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: newType.color }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{newType.label}</span>
              <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
                {newType.label.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_')}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="sv-btn-primary" onClick={handleAdd} disabled={adding} style={{ fontSize: 13 }}>
              {adding ? 'Adding…' : '✓ Add Type'}
            </button>
            <button className="sv-btn sv-btn-secondary" onClick={() => setShowAdd(false)} style={{ fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
