import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import './SettingsView.css';

// ════════════════════════════════════════════════════════════
// PLAYBOOKS VIEW — standalone Resource view
// Reuses sv-* and pb-* CSS from SettingsView.css
// Read-only for members, editable for org-admin / super-admin
// ════════════════════════════════════════════════════════════

export default function PlaybooksView() {
  const [playbooks, setPlaybooks]       = useState([]);
  const [selectedId, setSelectedId]     = useState(null);
  const [playbook, setPlaybook]         = useState(null);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [showNewForm, setShowNewForm]   = useState(false);
  const [newPbData, setNewPbData]       = useState({ name: '', type: 'custom', description: '' });
  const [editingStage, setEditingStage] = useState(null);
  const [creating, setCreating]         = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [showCompany, setShowCompany]   = useState(false);

  const activeRole = sessionStorage.getItem('activeRole') || 'member';
  const canEdit    = activeRole === 'org-admin' || activeRole === 'super-admin';

  // ── Load playbook list ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const r = await apiService.playbooks.getAll();
        const list = r.data.playbooks || [];
        setPlaybooks(list);
        const def = list.find(p => p.is_default) || list[0];
        if (def) setSelectedId(def.id);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  // ── Load selected playbook content ───────────────────────
  useEffect(() => {
    if (!selectedId) return;
    setPlaybook(null);
    setEditingStage(null);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        if (raw?.content?.stages && !raw.content.deal_stages) {
          raw.content.deal_stages = raw.content.stages;
          delete raw.content.stages;
        }
        setPlaybook(raw);
      } catch { setError('Failed to load playbook content'); }
    })();
  }, [selectedId]);

  // ── Flash helper ─────────────────────────────────────────
  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3000);
  };

  // ── CRUD handlers ────────────────────────────────────────
  const handleSave = async () => {
    if (!playbook || !canEdit) return;
    setSaving(true);
    try {
      await apiService.playbooks.update(selectedId, { content: playbook.content });
      flash('success', 'Playbook saved ✓');
    } catch { flash('error', 'Failed to save playbook'); }
    finally  { setSaving(false); }
  };

  const handleSetDefault = async (id) => {
    if (!canEdit) return;
    try {
      await apiService.playbooks.setDefault(id);
      setPlaybooks(prev => prev.map(p => ({ ...p, is_default: p.id === id })));
      flash('success', 'Default playbook updated ✓');
    } catch { flash('error', 'Failed to set default'); }
  };

  const handleCreate = async () => {
    if (!newPbData.name.trim()) { flash('error', 'Name is required'); return; }
    setCreating(true);
    try {
      const r  = await apiService.playbooks.create({ ...newPbData, content: { deal_stages: {}, company: {} } });
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: 'custom', description: '' });
      flash('success', 'Playbook created ✓');
    } catch { flash('error', 'Failed to create playbook'); }
    finally  { setCreating(false); }
  };

  const handleDelete = async (id) => {
    const pb = playbooks.find(p => p.id === id);
    if (pb?.is_default) { flash('error', 'Set another playbook as default before deleting this one'); return; }
    if (!window.confirm(`Delete "${pb?.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await apiService.playbooks.delete(id);
      const remaining = playbooks.filter(p => p.id !== id);
      setPlaybooks(remaining);
      if (selectedId === id) setSelectedId(remaining[0]?.id || null);
      flash('success', 'Playbook deleted');
    } catch (e) { flash('error', e?.response?.data?.error?.message || 'Failed to delete playbook'); }
    finally     { setDeleting(false); }
  };

  // ── Stage helpers ────────────────────────────────────────
  const stagesSource = playbook?.content?.deal_stages || playbook?.content?.stages;
  const stagesArray  = stagesSource
    ? Array.isArray(stagesSource)
      ? stagesSource
      : Object.entries(stagesSource).map(([id, val]) => ({ id, ...val }))
    : [];

  const updateStageField = (stageId, fieldKey, value) => {
    const ds = playbook.content.deal_stages;
    if (Array.isArray(ds)) {
      setPlaybook({ ...playbook, content: { ...playbook.content, deal_stages: ds.map(s => (s.id === stageId || s.name === stageId) ? { ...s, [fieldKey]: value } : s) } });
    } else {
      setPlaybook({ ...playbook, content: { ...playbook.content, deal_stages: { ...ds, [stageId]: { ...ds[stageId], [fieldKey]: value } } } });
    }
  };

  const TYPE_LABELS = { market: '\u{1F30D} Market', product: '\u{1F4E6} Product', custom: '\u2699\uFE0F Custom' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096' };

  // ── Render ───────────────────────────────────────────────
  if (loading) return <div className="sv-loading">Loading playbooks...</div>;

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="sv-panel">
        <div className="sv-panel-header">
          <div>
            <h2>📘 Sales Playbooks</h2>
            <p className="sv-panel-desc">
              {canEdit
                ? 'Manage playbooks per market or product. Each deal can use a specific playbook; the default is used when none is selected.'
                : 'View your org\'s sales playbooks — stage guidance, key actions, and success criteria for every deal stage.'}
            </p>
          </div>
          {canEdit && (
            <button className="sv-btn sv-btn-primary" onClick={() => setShowNewForm(true)}>+ New Playbook</button>
          )}
        </div>

        {error   && <div className="sv-alert sv-alert-error">{error}</div>}
        {success && <div className="sv-alert sv-alert-success">{success}</div>}

        {showNewForm && canEdit && (
          <div className="sv-card pb-new-form">
            <h4 style={{ marginTop: 0, marginBottom: 16 }}>New Playbook</h4>
            <div className="sv-form-grid">
              <div className="sv-field">
                <label>Name</label>
                <input className="sv-input" placeholder="e.g. EMEA Enterprise" value={newPbData.name}
                  onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div className="sv-field">
                <label>Type</label>
                <select className="sv-input" value={newPbData.type} onChange={e => setNewPbData(p => ({ ...p, type: e.target.value }))}>
                  <option value="market">🌍 Market</option>
                  <option value="product">📦 Product</option>
                  <option value="custom">⚙️ Custom</option>
                </select>
              </div>
            </div>
            <div className="sv-field" style={{ marginTop: 12 }}>
              <label>Description (optional)</label>
              <input className="sv-input" placeholder="e.g. For deals in EMEA region" value={newPbData.description}
                onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="sv-btn sv-btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? 'Creating...' : 'Create Playbook'}
              </button>
              <button className="sv-btn sv-btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="pb-layout">
          <div className="pb-sidebar">
            {playbooks.length === 0 ? (
              <div className="sv-empty">No playbooks yet</div>
            ) : playbooks.map(pb => (
              <div key={pb.id} className={`pb-list-item ${selectedId === pb.id ? 'active' : ''}`}
                onClick={() => setSelectedId(pb.id)}>
                <div className="pb-list-item-main">
                  <span className="pb-list-name">{pb.name}</span>
                  {pb.is_default && <span className="pb-default-star" title="Default">★</span>}
                </div>
                <div className="pb-list-meta">
                  <span className="pb-type-badge" style={{ color: TYPE_COLORS[pb.type] }}>{TYPE_LABELS[pb.type]}</span>
                </div>
                {selectedId === pb.id && canEdit && (
                  <div className="pb-list-actions">
                    {!pb.is_default && (
                      <button className="sv-btn-link" onClick={e => { e.stopPropagation(); handleSetDefault(pb.id); }}>Set default</button>
                    )}
                    {!pb.is_default && (
                      <button className="sv-btn-link sv-btn-danger" onClick={e => { e.stopPropagation(); handleDelete(pb.id); }} disabled={deleting}>Delete</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="pb-editor">
            {!playbook ? (
              <div className="sv-loading">Select a playbook...</div>
            ) : (
              <>
                <div className="pb-editor-header">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <h3 style={{ margin: 0 }}>{playbook.name}</h3>
                      {playbook.is_default && <span className="pb-default-badge">Default</span>}
                      <span className="pb-type-badge" style={{ color: TYPE_COLORS[playbook.type] }}>{TYPE_LABELS[playbook.type]}</span>
                    </div>
                    {playbook.description && <p style={{ margin: '4px 0 0', color: '#718096', fontSize: 13 }}>{playbook.description}</p>}
                  </div>
                  {canEdit && (
                    <button className="sv-btn sv-btn-primary" onClick={handleSave} disabled={saving}>
                      {saving ? '⏳ Saving...' : '💾 Save'}
                    </button>
                  )}
                </div>

                {!canEdit && (
                  <div className="sv-alert" style={{ background: '#ebf8ff', borderColor: '#bee3f8', color: '#2b6cb0', marginBottom: 16 }}>
                    👁 View only — switch to Org Admin role to edit playbooks
                  </div>
                )}

                {playbook.content && (
                  <div className="sv-card" style={{ marginBottom: 20 }}>
                    <div className="pb-company-header" onClick={() => setShowCompany(v => !v)}>
                      <span>🏢 Company Context</span>
                      {!showCompany && (playbook.content?.company?.name || playbook.content?.company?.industry || playbook.content?.company?.product) && (
                        <span className="pb-company-summary">
                          {[playbook.content.company.name, playbook.content.company.industry, playbook.content.company.product].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      <span className="sv-expand-btn" style={{ marginLeft: 'auto' }}>{showCompany ? '▲' : '▼'}</span>
                    </div>
                    {showCompany && (
                      <div style={{ marginTop: 14 }}>
                        {['name', 'industry', 'product'].map(field => (
                          <div key={field} className="sv-field" style={{ marginBottom: 12 }}>
                            <label style={{ textTransform: 'capitalize' }}>{field}</label>
                            <input className="sv-input"
                              value={playbook.content?.company?.[field] || ''}
                              disabled={!canEdit}
                              onChange={e => setPlaybook({ ...playbook, content: { ...playbook.content, company: { ...playbook.content.company, [field]: e.target.value } } })} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {stagesArray.length > 0 && (
                  <div className="sv-card">
                    <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>📋 Deal Stages</h4>
                    <div className="sv-stages-list">
                      {stagesArray.map((stage, i) => {
                        const stageId = stage.id || stage.name || String(i);
                        return (
                          <div key={stageId} className="sv-stage-row">
                            <div className="sv-stage-header" onClick={() => setEditingStage(editingStage === stageId ? null : stageId)}>
                              <span className="sv-stage-num">{i + 1}</span>
                              <span className="sv-stage-name">{stage.name || stageId}</span>
                              <span className="sv-hint sv-stage-goal">{stage.goal?.substring(0, 60)}{stage.goal?.length > 60 ? '…' : ''}</span>
                              <span className="sv-expand-btn">{editingStage === stageId ? '▲' : '▼'}</span>
                            </div>
                            {editingStage === stageId && (
                              <div className="sv-stage-detail">
                                {Object.entries(stage).filter(([k]) => k !== 'id' && k !== 'key_actions' && k !== 'success_criteria').map(([key, val]) => (
                                  <div key={key} className="sv-field" style={{ marginBottom: 10 }}>
                                    <label style={{ textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</label>
                                    <input className="sv-input" value={val || ''} disabled={!canEdit} onChange={e => updateStageField(stageId, key, e.target.value)} />
                                  </div>
                                ))}
                                {Array.isArray(stage.key_actions) && (
                                  <div className="sv-field" style={{ marginTop: 8 }}>
                                    <label>Key Actions</label>
                                    {stage.key_actions.map((action, ai) => (
                                      <div key={ai} className="pb-action-row">
                                        <span className="pb-action-num">{ai + 1}</span>
                                        {canEdit ? (
                                          <textarea
                                            className="sv-input pb-action-textarea"
                                            value={action}
                                            rows={Math.max(1, Math.ceil(action.length / 60))}
                                            onChange={e => { const a = [...stage.key_actions]; a[ai] = e.target.value; updateStageField(stageId, 'key_actions', a); }}
                                          />
                                        ) : (
                                          <span className="pb-action-text">{action}</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {stagesArray.length === 0 && (
                  <div className="sv-empty">No stages defined in this playbook yet.</div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
