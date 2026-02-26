import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import './SettingsView.css';

// ════════════════════════════════════════════════════════════
// PLAYBOOKS VIEW — standalone Resource view (member-facing)
// Reuses sv-* and pb-* CSS from SettingsView.css
// Read-only for members, editable for org-admin / super-admin.
// Supports both Sales and Prospecting playbook types via tab.
// ════════════════════════════════════════════════════════════

const TEAL = '#0F9D8E';

const PROSPECT_STAGE_KEYS = ['target', 'researched', 'contacted', 'engaged', 'qualified'];
const PROSPECT_STAGE_LABELS = {
  target: '🎯 Target', researched: '🔍 Researched', contacted: '📤 Contacted',
  engaged: '💬 Engaged', qualified: '✅ Qualified',
};

export default function PlaybooksView({ initialTypeFilter }) {
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

  // Type filter: 'sales' | 'prospecting'
  const [typeFilter, setTypeFilter]     = useState(initialTypeFilter || 'sales');

  const activeRole = sessionStorage.getItem('activeRole') || 'member';
  const canEdit    = activeRole === 'org-admin' || activeRole === 'super-admin';

  // ── Derived: filtered playbook list ─────────────────────
  const filteredPlaybooks = typeFilter === 'prospecting'
    ? playbooks.filter(p => p.type === 'prospecting')
    : playbooks.filter(p => p.type !== 'prospecting');

  // ── Load playbook list ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const r = await apiService.playbooks.getAll();
        const list = r.data.playbooks || [];
        setPlaybooks(list);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  // Re-select on type filter change
  useEffect(() => {
    const filtered = typeFilter === 'prospecting'
      ? playbooks.filter(p => p.type === 'prospecting')
      : playbooks.filter(p => p.type !== 'prospecting');
    const def = filtered.find(p => p.is_default) || filtered[0];
    setSelectedId(def?.id || null);
    setEditingStage(null);
    setShowNewForm(false);
  }, [typeFilter, playbooks]);

  // ── Load selected playbook content ───────────────────────
  useEffect(() => {
    if (!selectedId) { setPlaybook(null); return; }
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
      if (playbook.type === 'prospecting') {
        await apiService.playbooks.update(selectedId, {
          stage_guidance: playbook.stage_guidance,
          content: playbook.content,
        });
      } else {
        await apiService.playbooks.update(selectedId, { content: playbook.content });
      }
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
      const createPayload = typeFilter === 'prospecting'
        ? { name: newPbData.name, type: 'prospecting', description: newPbData.description }
        : { ...newPbData, content: { deal_stages: {}, company: {} } };
      const r  = await apiService.playbooks.create(createPayload);
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: typeFilter === 'prospecting' ? 'prospecting' : 'custom', description: '' });
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
      if (selectedId === id) setSelectedId(null);
      flash('success', 'Playbook deleted');
    } catch (e) { flash('error', e?.response?.data?.error?.message || 'Failed to delete playbook'); }
    finally     { setDeleting(false); }
  };

  // ── Sales stage helpers ──────────────────────────────────
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

  // ── Prospecting stage guidance helpers ───────────────────
  const prospectGuidance = playbook?.stage_guidance || {};

  const updateProspectGuidanceField = (stageKey, field, value) => {
    setPlaybook(prev => ({
      ...prev,
      stage_guidance: {
        ...prev.stage_guidance,
        [stageKey]: { ...(prev.stage_guidance?.[stageKey] || {}), [field]: value },
      },
    }));
  };

  const TYPE_LABELS = { market: '\u{1F30D} Market', product: '\u{1F4E6} Product', custom: '\u2699\uFE0F Custom', prospecting: '🎯 Prospecting' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096', prospecting: TEAL };

  // ── Render ───────────────────────────────────────────────
  if (loading) return <div className="sv-loading">Loading playbooks...</div>;

  const isProspecting = typeFilter === 'prospecting';

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="sv-panel">
        <div className="sv-panel-header">
          <div>
            <h2>{isProspecting ? '🎯 Prospecting Playbooks' : '📘 Sales Playbooks'}</h2>
            <p className="sv-panel-desc">
              {canEdit
                ? (isProspecting
                    ? 'Manage outreach playbooks — define stage guidance, key actions, and cadences for each prospecting stage.'
                    : 'Manage playbooks per market or product. Each deal can use a specific playbook; the default is used when none is selected.')
                : (isProspecting
                    ? 'View your org\'s prospecting playbooks — outreach strategy, actions, and success criteria per stage.'
                    : 'View your org\'s sales playbooks — stage guidance, key actions, and success criteria for every deal stage.')}
            </p>
          </div>
          {canEdit && (
            <button className="sv-btn sv-btn-primary" onClick={() => setShowNewForm(true)}>
              + New {isProspecting ? 'Prospecting' : 'Sales'} Playbook
            </button>
          )}
        </div>

        {/* Type toggle tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 20 }}>
          {[
            { key: 'sales', label: '📘 Sales', color: '#3b82f6' },
            { key: 'prospecting', label: '🎯 Prospecting', color: TEAL },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTypeFilter(t.key)}
              style={{
                padding: '10px 20px',
                background: 'none',
                border: 'none',
                borderBottom: `3px solid ${typeFilter === t.key ? t.color : 'transparent'}`,
                color: typeFilter === t.key ? t.color : '#6b7280',
                fontWeight: typeFilter === t.key ? 600 : 400,
                fontSize: 14,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {t.label} ({(t.key === 'prospecting' ? playbooks.filter(p => p.type === 'prospecting') : playbooks.filter(p => p.type !== 'prospecting')).length})
            </button>
          ))}
        </div>

        {error   && <div className="sv-alert sv-alert-error">{error}</div>}
        {success && <div className="sv-alert sv-alert-success">{success}</div>}

        {showNewForm && canEdit && (
          <div className="sv-card pb-new-form">
            <h4 style={{ marginTop: 0, marginBottom: 12 }}>New {isProspecting ? 'Prospecting' : 'Sales'} Playbook</h4>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="sv-field" style={{ flex: 1 }}>
                <label>Name</label>
                <input className="sv-input" placeholder={isProspecting ? 'e.g. Outbound SDR' : 'e.g. EMEA Enterprise'}
                  value={newPbData.name} onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
              </div>
              {!isProspecting && (
                <div className="sv-field">
                  <label>Type</label>
                  <select className="sv-input" value={newPbData.type} onChange={e => setNewPbData(p => ({ ...p, type: e.target.value }))}>
                    <option value="market">🌍 Market</option>
                    <option value="product">📦 Product</option>
                    <option value="custom">⚙️ Custom</option>
                  </select>
                </div>
              )}
            </div>
            <div className="sv-field" style={{ marginTop: 12 }}>
              <label>Description (optional)</label>
              <input className="sv-input" placeholder={isProspecting ? 'e.g. Multi-channel outbound sequence' : 'e.g. For deals in EMEA region'}
                value={newPbData.description} onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
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
            {filteredPlaybooks.length === 0 ? (
              <div className="sv-empty">
                No {isProspecting ? 'prospecting' : 'sales'} playbooks yet.
                {canEdit ? ' Create one above.' : ' Ask your org admin to create one.'}
              </div>
            ) : filteredPlaybooks.map(pb => (
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

                {/* ── SALES playbook content ────────────────── */}
                {playbook.type !== 'prospecting' && (
                  <>
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

                {/* ── PROSPECTING playbook content ─────────── */}
                {playbook.type === 'prospecting' && (
                  <>
                    {/* Account-based config */}
                    <div className="sv-card" style={{ marginBottom: 16 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: canEdit ? 'pointer' : 'default', fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={playbook.content?.account_based || false}
                          disabled={!canEdit}
                          onChange={e => setPlaybook({
                            ...playbook,
                            content: { ...playbook.content, account_based: e.target.checked },
                          })}
                        />
                        <strong>Account-Based Prospecting</strong>
                        <span style={{ color: '#6b7280', fontSize: 11 }}>— define role requirements per account</span>
                      </label>
                    </div>

                    {/* Prospect stage guidance */}
                    <div className="sv-card">
                      <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15, color: TEAL }}>
                        🎯 Prospecting Stage Guidance
                      </h4>
                      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#9ca3af' }}>
                        Prospect stages are: Target → Researched → Contacted → Engaged → Qualified → Converted.
                        Define guidance for each active stage below.
                      </p>
                      <div className="sv-stages-list">
                        {PROSPECT_STAGE_KEYS.map((stageKey, i) => {
                          const g = prospectGuidance[stageKey] || {};
                          const isOpen = editingStage === stageKey;
                          const hasGuidance = !!(g.goal || g.key_actions?.length);

                          return (
                            <div key={stageKey} className="sv-stage-row">
                              <div className="sv-stage-header" onClick={() => setEditingStage(isOpen ? null : stageKey)}>
                                <span className="sv-stage-num" style={{ background: TEAL + '20', color: TEAL }}>{i + 1}</span>
                                <span className="sv-stage-name">{PROSPECT_STAGE_LABELS[stageKey]}</span>
                                {hasGuidance && (
                                  <span style={{ fontSize: 11, color: TEAL, marginLeft: 8 }}>● guided</span>
                                )}
                                <span className="sv-hint sv-stage-goal" style={{ flex: 1 }}>
                                  {g.goal?.substring(0, 55)}{g.goal?.length > 55 ? '…' : ''}
                                </span>
                                <span className="sv-expand-btn">{isOpen ? '▲' : '▼'}</span>
                              </div>

                              {isOpen && (
                                <div className="sv-stage-detail">
                                  <div className="sv-field" style={{ marginBottom: 10 }}>
                                    <label>Goal</label>
                                    <input className="sv-input"
                                      placeholder="What should the rep achieve in this stage?"
                                      value={g.goal || ''}
                                      disabled={!canEdit}
                                      onChange={e => updateProspectGuidanceField(stageKey, 'goal', e.target.value)} />
                                  </div>
                                  <div className="sv-field" style={{ marginBottom: 10 }}>
                                    <label>Timeline</label>
                                    <input className="sv-input"
                                      placeholder="e.g. 1-2 weeks"
                                      value={g.timeline || ''}
                                      disabled={!canEdit}
                                      onChange={e => updateProspectGuidanceField(stageKey, 'timeline', e.target.value)} />
                                  </div>

                                  {/* Key actions */}
                                  <div className="sv-field" style={{ marginTop: 8 }}>
                                    <label>Key Actions (comma-separated action keys)</label>
                                    <input className="sv-input"
                                      placeholder="e.g. send_email, send_linkedin, follow_up"
                                      value={(g.key_actions || []).join(', ')}
                                      disabled={!canEdit}
                                      onChange={e => updateProspectGuidanceField(stageKey, 'key_actions',
                                        e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                                      )} />
                                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                                      Available: research_company, research_contact, send_email, send_linkedin, follow_up, make_call, send_sms, send_whatsapp, qualify, schedule_meeting, send_content
                                    </span>
                                  </div>

                                  {/* Success criteria */}
                                  <div className="sv-field" style={{ marginTop: 10 }}>
                                    <label>Success Criteria (comma-separated)</label>
                                    <input className="sv-input"
                                      placeholder="e.g. Response received, Meeting booked"
                                      value={(g.success_criteria || []).join(', ')}
                                      disabled={!canEdit}
                                      onChange={e => updateProspectGuidanceField(stageKey, 'success_criteria',
                                        e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                                      )} />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Role requirements for account-based */}
                    {playbook.content?.account_based && (
                      <div className="sv-card" style={{ marginTop: 16 }}>
                        <h4 style={{ marginTop: 0, marginBottom: 8, fontSize: 14 }}>👥 Role Requirements</h4>
                        <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px' }}>
                          Define which roles you need covered per account. Used by the Coverage Scorecard.
                        </p>
                        {(playbook.content?.role_requirements || []).map((req, idx) => (
                          <div key={idx} style={{
                            display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0',
                            borderBottom: '1px solid #f3f4f6', fontSize: 13,
                          }}>
                            <span style={{ fontWeight: 600 }}>{req.role?.replace(/_/g, ' ')}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                              background: req.required ? '#fef2f2' : '#fffbeb',
                              color: req.required ? '#991b1b' : '#92400e',
                            }}>
                              {req.required ? 'Required' : 'Optional'}
                            </span>
                            {req.titles?.length > 0 && (
                              <span style={{ color: '#6b7280', fontSize: 11 }}>— {req.titles.join(', ')}</span>
                            )}
                          </div>
                        ))}
                        {(!playbook.content?.role_requirements || playbook.content.role_requirements.length === 0) && (
                          <div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>No role requirements defined yet.</div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
