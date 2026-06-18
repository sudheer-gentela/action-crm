/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAPlaybooks. */
import React, { useState, useEffect } from 'react';
import PlaybookPlaysEditor from '../../PlaybookPlaysEditor';
import { apiService } from '../../apiService';

export default function OAPlaybooks() {
  const [playbooks,    setPlaybooks]    = useState([]);
  const [selectedId,   setSelectedId]   = useState(null);
  const [playbook,     setPlaybook]     = useState(null);   // full playbook row incl. stage_guidance
  const [liveStages,   setLiveStages]   = useState([]);    // from deal_stages table
  const [guidance,     setGuidance]     = useState({});    // { stage_type: { goal, key_actions, ... } }
  const [loading,      setLoading]      = useState(true);
  const [stagesLoading,setStagesLoading]= useState(true);
  const [saving,       setSaving]       = useState(null);   // null | 'meta' | stage_type string
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState('');
  const [showNewForm,  setShowNewForm]  = useState(false);
  const [newPbData,    setNewPbData]    = useState({ name: '', type: 'sales', description: '' });
  const [editingStage, setEditingStage] = useState(null);   // stage_type being expanded
  const [creating,     setCreating]     = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [showCompany,  setShowCompany]  = useState(false);
  const [showPlaysTab, setShowPlaysTab] = useState(false);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API    = process.env.REACT_APP_API_URL || '';

  // ── Fetch live sales stages once on mount ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`${API}/pipeline-stages/sales`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        // Only active non-terminal stages are meaningful for playbook guidance
        const active = (data.stages || [])
          .filter(s => s.is_active)
          .sort((a, b) => a.sort_order - b.sort_order);
        setLiveStages(active);
      } catch {
        // Non-fatal — editor degrades gracefully
      } finally {
        setStagesLoading(false);
      }
    })();
  }, [API, token]);

  // ── Load playbook list ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r    = await apiService.playbooks.getAll();
        const list = r.data.playbooks || [];
        setPlaybooks(list);
        const def = list.find(p => p.is_default) || list[0];
        if (def) setSelectedId(def.id);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  // ── Load selected playbook + extract stage_guidance ──────────────────────
  useEffect(() => {
    if (!selectedId) {
      setPlaybook(null);
      setGuidance({});
      return;
    }
    setPlaybook(null);
    setGuidance({});
    setEditingStage(null);
    setShowCompany(false);
    setShowPlaysTab(false);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        setPlaybook(raw);
        // stage_guidance is keyed by stage key: { qualified: {...}, demo: {...} }
        setGuidance(raw.stage_guidance || {});
      } catch { setError('Failed to load playbook content'); }
    })();
  }, [selectedId]);

  // ── Save playbook name / description / company context ───────────────────
  const handleSaveMeta = async () => {
    if (!playbook) return;
    setSaving('meta');
    try {
      await apiService.playbooks.update(selectedId, {
        name:        playbook.name,
        description: playbook.description,
        content:     playbook.content,   // company context lives here
      });
      setPlaybooks(prev => prev.map(p =>
        p.id === selectedId ? { ...p, name: playbook.name, description: playbook.description } : p
      ));
      flash('success', 'Playbook saved ✓');
    } catch { flash('error', 'Failed to save playbook'); }
    finally  { setSaving(null); }
  };

  // ── Save guidance for a single stage_type ────────────────────────────────
  // Uses the dedicated PUT /api/playbooks/:id/stages/:stageType endpoint
  // so we never clobber other stages' guidance.
  const handleSaveStage = async (stageKey, stageType) => {
    if (!playbook) return;
    setSaving(stageKey);
    const stageGuidance = guidance[stageKey] || {};
    try {
      const res = await fetch(`${API}/api/playbooks/${selectedId}/stages/${stageKey}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          goal:                  stageGuidance.goal                || null,
          next_step:             stageGuidance.next_step           || null,
          timeline:              stageGuidance.timeline            || null,
          key_actions:           Array.isArray(stageGuidance.key_actions) ? stageGuidance.key_actions : [],
          email_response_time:   stageGuidance.email_response_time || null,
          success_criteria:      Array.isArray(stageGuidance.success_criteria) ? stageGuidance.success_criteria : [],
          requires_proposal_doc: !!stageGuidance.requires_proposal_doc,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err?.error?.message || res.statusText);
      }
      flash('success', `Stage guidance saved ✓`);
    } catch (e) {
      flash('error', e.message || 'Failed to save stage guidance');
    } finally {
      setSaving(null);
    }
  };

  // ── Helpers to mutate local guidance state ────────────────────────────────
  const updateGuidanceField = (stageKey, field, value) => {
    setGuidance(prev => ({
      ...prev,
      [stageKey]: { ...(prev[stageKey] || {}), [field]: value },
    }));
  };

  const updateKeyAction = (stageKey, idx, value) => {
    const actions = [...(guidance[stageKey]?.key_actions || [])];
    actions[idx]  = value;
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const addKeyAction = (stageKey) => {
    const actions = [...(guidance[stageKey]?.key_actions || []), ''];
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const removeKeyAction = (stageKey, idx) => {
    const actions = (guidance[stageKey]?.key_actions || []).filter((_, i) => i !== idx);
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const TYPE_LABELS = { market: '🌍 Market', product: '📦 Product', custom: '⚙️ Custom', prospecting: '🎯 Prospecting', clm: '📋 CLM' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096', prospecting: '#0F9D8E', clm: '#7c3aed' };
  const TEAL = '#0F9D8E';

  // ── Dynamic playbook types from org settings ────────────────────────────────
  const [playbookTypes,        setPlaybookTypes]        = useState([]);
  const [playbookTypesLoading, setPlaybookTypesLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/org/admin/playbook-types`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.playbook_types?.length) setPlaybookTypes(data.playbook_types);
      } catch (err) {
        console.error('Failed to load playbook types:', err);
      } finally {
        setPlaybookTypesLoading(false);
      }
    })();
  }, [API, token]);


  // ── Type filter tab: dynamic from org playbook types ────────────────────────
  const [typeFilter, setTypeFilter] = useState('sales');
  const isProspecting = typeFilter === 'prospecting';
  const isSalesType   = typeFilter === 'sales';
  const isCLM         = typeFilter === 'clm';
  const isService     = typeFilter === 'service';
  const isCustomType  = !isSalesType && !isProspecting && !isCLM && !isService;


  // Service stages are fixed case-status strings, not stored in pipeline_stages.
  // "sales" tab catches legacy types (custom, market, product) + explicit sales type
  // All other tabs filter by exact type key
  const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];
  const filteredPlaybooks = typeFilter === 'sales'
    ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type))
    : playbooks.filter(p => p.type === typeFilter);

  // ── Stage loader — unified for all types ─────────────────────────────────
  // sales       → pipeline-stages/sales
  // prospecting → pipeline-stages/prospecting
  // all others (service, clm, handover_s2i, custom) → org/admin/playbook-stages/:type
  const [prospectLiveStages, setProspectLiveStages] = useState([]);
  const [prospectStagesLoading, setProspectStagesLoading] = useState(false);
  const [customLiveStages, setCustomLiveStages] = useState([]);
  const [customStagesLoading, setCustomStagesLoading] = useState(false);

  useEffect(() => {
    if (isSalesType) return; // sales uses liveStages already loaded from pipeline-stages/sales

    if (isProspecting) {
      setProspectStagesLoading(true);
      (async () => {
        try {
          const res = await fetch(`${API}/pipeline-stages/prospecting`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await res.json();
          const active = (data.stages || [])
            .filter(s => s.is_active)
            .sort((a, b) => a.sort_order - b.sort_order);
          setProspectLiveStages(active);
        } catch { /* non-fatal */ }
        finally { setProspectStagesLoading(false); }
      })();
      return;
    }

    // All other types — load from pipeline-stages/:type (org-wide, consistent with PlaybooksView)
    setCustomStagesLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API}/pipeline-stages/${typeFilter}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const active = (data.stages || [])
          .filter(s => s.is_active !== false)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        setCustomLiveStages(active);
      } catch { /* non-fatal */ }
      finally { setCustomStagesLoading(false); }
    })();
  }, [typeFilter, API, token, isSalesType, isProspecting]);

  // Re-select on type filter change
  useEffect(() => {
    const filtered = typeFilter === 'sales'
      ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type))
      : playbooks.filter(p => p.type === typeFilter);
    const def = filtered.find(p => p.is_default) || filtered[0];
    setSelectedId(def?.id || null);
    setEditingStage(null);
    setShowNewForm(false);
    // Also clear playbook/guidance so stale data doesn't render
    if (!def) { setPlaybook(null); setGuidance({}); }
  }, [typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which stages to show in the editor
  const activeLiveStages = isProspecting ? prospectLiveStages
    : isSalesType ? liveStages
    : customLiveStages; // service, clm, handover_s2i, custom all loaded from org settings
  const activeStagesLoading = isProspecting ? prospectStagesLoading
    : isSalesType ? stagesLoading
    : customStagesLoading;

  const handleSetDefault = async (id) => {
    try {
      await apiService.playbooks.setDefault(id);
      // Only toggle default within the same type group
      const targetPb = playbooks.find(p => p.id === id);
      const targetType = targetPb?.type || 'sales';
      setPlaybooks(prev => prev.map(p => {
        if (p.type === targetType || (p.type !== 'prospecting' && targetType !== 'prospecting' && !isCustomType)) {
          return { ...p, is_default: p.id === id };
        }
        return p;
      }));
      if (playbook && playbook.id === id) setPlaybook({ ...playbook, is_default: true });
      flash('success', 'Default playbook updated ✓');
    } catch { flash('error', 'Failed to set default'); }
  };

  const handleCreate = async () => {
    if (!newPbData.name.trim()) { flash('error', 'Name is required'); return; }
    // CLM playbook is system-managed — admins can edit it but not create additional ones
    if (typeFilter === 'clm') {
      flash('error', 'The CLM playbook is system-managed. Edit the existing one directly.');
      return;
    }
    setCreating(true);
    try {
      // For sales tab, use the sub-type from the form (or default 'custom')
      // For all other tabs, use the typeFilter key directly
      const effectiveType = typeFilter === 'sales'
        ? (newPbData.type || 'custom')
        : typeFilter;
      const createPayload = {
        name: newPbData.name,
        type: effectiveType,
        description: newPbData.description || '',
        content: typeFilter === 'sales' ? { company: {} } : {},
        stage_guidance: {},
      };
      const r  = await apiService.playbooks.create(createPayload);
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: typeFilter === 'sales' ? 'custom' : typeFilter, description: '' });
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

  // Current type metadata
  const activeType = playbookTypes.find(t => t.key === typeFilter) || playbookTypes[0];

  if (loading || playbookTypesLoading) return <div className="sv-loading">Loading playbooks...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>{activeType?.icon || '📋'} {activeType?.label || 'Sales'} Playbooks</h2>
          <p className="sv-panel-desc">
            {isProspecting
              ? 'Manage outreach playbooks — define stage guidance, key actions, and cadences for each prospecting stage.'
              : typeFilter === 'sales'
                ? 'Stage names and order come from the Deal Stages tab. Edit guidance here to tell the AI what actions to generate for each stage.'
                : `Manage ${activeType?.label || typeFilter} playbooks and stage guidance.`}
          </p>
        </div>
        {!isCLM && (
          <button className="sv-btn-primary" onClick={() => setShowNewForm(true)}>
            + New {activeType?.label || 'Sales'} Playbook
          </button>
        )}
      </div>

      {/* Dynamic type toggle tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', margin: '0 0 16px', flexWrap: 'wrap' }}>
        {playbookTypes.map(t => {
          const count = t.key === 'sales'
            ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type)).length
            : playbooks.filter(p => p.type === t.key).length;
          return (
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
              {t.icon} {t.label} ({count})
            </button>
          );
        })}
      </div>

      {error   && <div className="sv-alert sv-alert-error">{error}</div>}
      {success && <div className="sv-alert sv-alert-success">{success}</div>}

      {showNewForm && (
        <div className="sv-card oa-pb-new-form">
          <h4 style={{ marginTop: 0, marginBottom: 16 }}>New {activeType?.label || 'Sales'} Playbook</h4>
          <div className="oa-pb-form-grid">
            <div className="sv-field">
              <label>Name</label>
              <input className="sv-input" placeholder={`e.g. ${isProspecting ? 'Outbound SDR' : typeFilter === 'sales' ? 'EMEA Enterprise' : activeType?.label + ' Template'}`}
                value={newPbData.name} onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
            </div>
            {typeFilter === 'sales' && (
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
            <input className="sv-input" placeholder={`e.g. ${isProspecting ? 'Multi-channel outbound sequence' : typeFilter === 'sales' ? 'For deals in EMEA region' : activeType?.label + ' playbook description'}`}
              value={newPbData.description} onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="sv-btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Playbook'}
            </button>
            <button className="sv-btn sv-btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="oa-pb-layout">
        {/* Sidebar */}
        <div className="oa-pb-sidebar">
          {filteredPlaybooks.length === 0
            ? <div className="sv-empty">No {activeType?.label?.toLowerCase() || typeFilter} playbooks yet. Create one above.</div>
            : filteredPlaybooks.map(pb => (
              <div key={pb.id}
                className={`oa-pb-list-item ${selectedId === pb.id ? 'active' : ''}`}
                onClick={() => setSelectedId(pb.id)}>
                <div className="oa-pb-list-main">
                  <span className="oa-pb-list-name">{pb.name}</span>
                  {pb.is_default && <span className="oa-pb-star" title="Default">★</span>}
                </div>
                <span style={{ fontSize: 11, color: TYPE_COLORS[pb.type], fontWeight: 600 }}>{TYPE_LABELS[pb.type]}</span>
                {selectedId === pb.id && (
                  <div className="oa-pb-item-actions">
                    {!pb.is_default && (
                      <button className="oa-pb-link" onClick={e => { e.stopPropagation(); handleSetDefault(pb.id); }}>
                        Set default
                      </button>
                    )}
                    {!pb.is_default && (
                      <button className="oa-pb-link oa-pb-link--danger" onClick={e => { e.stopPropagation(); handleDelete(pb.id); }} disabled={deleting}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          }
        </div>

        {/* Editor */}
        <div className="oa-pb-editor">
          {!playbook ? (
            <div className="sv-loading">Select a playbook to edit</div>
          ) : (
            <>
              {/* Header — name / description / save meta */}
              <div className="oa-pb-editor-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <input
                      className="oa-pb-name-input"
                      value={playbook.name}
                      onChange={e => setPlaybook({ ...playbook, name: e.target.value })}
                      placeholder="Playbook name"
                    />
                    {playbook.is_default && <span className="oa-pb-default-badge">Default</span>}
                    <span style={{ fontSize: 12, fontWeight: 600, color: TYPE_COLORS[playbook.type] }}>{TYPE_LABELS[playbook.type]}</span>
                  </div>
                  <input
                    className="oa-pb-desc-input"
                    value={playbook.description || ''}
                    onChange={e => setPlaybook({ ...playbook, description: e.target.value })}
                    placeholder="Description (optional)"
                  />
                </div>
                <button className="sv-btn-primary" onClick={handleSaveMeta} disabled={!!saving} style={{ flexShrink: 0 }}>
                  {saving === 'meta' ? '⏳ Saving...' : '💾 Save'}
                </button>
              </div>

              {/* ── Sub-tabs: Stage Guidance | Plays by Role ──────── */}
              <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
                {[
                  { key: false, label: `${activeType?.icon || '📋'} Stage Guidance` },
                  { key: true,  label: '🎭 Plays by Role' },
                ].map(t => (
                  <button
                    key={String(t.key)}
                    onClick={() => setShowPlaysTab(t.key)}
                    style={{
                      padding: '8px 16px', background: 'none', border: 'none',
                      borderBottom: `3px solid ${showPlaysTab === t.key ? (activeType?.color || '#3b82f6') : 'transparent'}`,
                      color: showPlaysTab === t.key ? (activeType?.color || '#3b82f6') : '#6b7280',
                      fontWeight: showPlaysTab === t.key ? 600 : 400,
                      fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* ── Plays by Role sub-tab ──────────────────────── */}
              {showPlaysTab && (
                <PlaybookPlaysEditor playbookId={playbook.id} />
              )}

              {/* ── Stage Guidance sub-tab ─────────────────────── */}
              {!showPlaysTab && (
              <>
              {/* Company context — sales playbooks only */}
              {typeFilter === 'sales' && playbook.content && (
                <div className="sv-card" style={{ marginBottom: 16 }}>
                  <div className="oa-pb-section-header" onClick={() => setShowCompany(v => !v)}>
                    <span>🏢 Company Context</span>
                    {!showCompany && (playbook.content?.company?.name || playbook.content?.company?.industry || playbook.content?.company?.product) && (
                      <span className="oa-pb-summary">
                        {[playbook.content.company.name, playbook.content.company.industry, playbook.content.company.product].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', color: '#a0aec0' }}>{showCompany ? '▲' : '▼'}</span>
                  </div>
                  {showCompany && (
                    <div style={{ marginTop: 14 }}>
                      {['name', 'industry', 'product'].map(field => (
                        <div key={field} className="sv-field" style={{ marginBottom: 12 }}>
                          <label style={{ textTransform: 'capitalize' }}>{field}</label>
                          <input className="sv-input"
                            value={playbook.content?.company?.[field] || ''}
                            onChange={e => setPlaybook({ ...playbook, content: { ...playbook.content, company: { ...playbook.content.company, [field]: e.target.value } } })} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Stage guidance — driven by live stages */}
              <div className="sv-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h4 style={{ margin: 0, fontSize: 15, color: activeType?.color || undefined }}>
                    {activeType?.icon || '📋'} {activeType?.label || 'Stage'} Guidance
                  </h4>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>
                    {isProspecting ? 'Stages from Prospect Stages tab'
                      : isSalesType ? 'Stages from Deal Stages tab'
                      : isService   ? 'Service case status stages'
                      : isCLM ? 'CLM contract lifecycle stages'
                      : `Stages from ${activeType?.label || typeFilter} Stages tab`}
                    {' · save each stage individually'}
                  </span>
                </div>

                {activeStagesLoading ? (
                  <div className="sv-loading" style={{ padding: 16 }}>Loading stages…</div>
                ) : activeLiveStages.length === 0 ? (
                  <div className="sv-empty">
                    No active pipeline stages found. {isProspecting ? 'Add stages in the Prospect Stages tab.' : isSalesType ? 'Add stages in the Deal Stages tab.' : 'Add stages in Org Settings → Playbook Stages.'}
                  </div>
                ) : (
                  <div className="sv-stages-list">
                    {activeLiveStages.map((stage, i) => {
                      const stageType = stage.stage_type;  // semantic label for display only
                      const stageKey  = stage.key;              // guidance lookup key
                      const g         = guidance[stageKey] || {};
                      const isOpen    = editingStage === stage.id;
                      const isSaving  = saving === stageKey;
                      const hasGuidance = !!(g.goal || (g.key_actions?.length));

                      return (
                        <div key={stage.id} className="sv-stage-row">
                          <div className="sv-stage-header"
                            onClick={() => setEditingStage(isOpen ? null : stage.id)}>
                            <span className="sv-stage-num" style={typeFilter !== 'sales' ? { background: (activeType?.color || TEAL) + '20', color: activeType?.color || TEAL } : undefined}>{i + 1}</span>
                            <span className="sv-stage-name">{stage.name}</span>
                            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>
                              {stageType}
                            </span>
                            {hasGuidance && (
                              <span style={{ fontSize: 11, color: '#10b981', marginLeft: 8 }}>● guided</span>
                            )}
                            <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8, flex: 1 }}>
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
                                  onChange={e => updateGuidanceField(stageKey, 'goal', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Timeline</label>
                                <input className="sv-input"
                                  placeholder="e.g. 1-2 weeks"
                                  value={g.timeline || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'timeline', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Email Response Time</label>
                                <input className="sv-input"
                                  placeholder="e.g. within 4 hours"
                                  value={g.email_response_time || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'email_response_time', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Next Step</label>
                                <input className="sv-input"
                                  placeholder="e.g. Schedule technical deep-dive"
                                  value={g.next_step || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'next_step', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>
                                  <input type="checkbox"
                                    checked={!!g.requires_proposal_doc}
                                    onChange={e => updateGuidanceField(stageKey, 'requires_proposal_doc', e.target.checked)}
                                    style={{ marginRight: 6 }} />
                                  Requires proposal document
                                </label>
                              </div>

                              {/* Key actions */}
                              <div className="sv-field" style={{ marginTop: 8 }}>
                                <label>Key Actions</label>
                                {(g.key_actions || []).map((action, ai) => (
                                  <div key={ai} className="oa-pb-action-row">
                                    <span className="oa-pb-action-num">{ai + 1}</span>
                                    <textarea
                                      className="sv-input oa-pb-action-textarea"
                                      value={action}
                                      rows={Math.max(1, Math.ceil(action.length / 60))}
                                      onChange={e => updateKeyAction(stageKey, ai, e.target.value)}
                                    />
                                    <button className="oa-pb-action-remove"
                                      onClick={() => removeKeyAction(stageKey, ai)}
                                      title="Remove">×</button>
                                  </div>
                                ))}
                                <button className="oa-pb-add-action" onClick={() => addKeyAction(stageKey)}>
                                  + Add action
                                </button>
                              </div>

                              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                                <button
                                  className="sv-btn-primary"
                                  onClick={() => handleSaveStage(stageKey, stageType)}
                                  disabled={!!saving}
                                >
                                  {isSaving ? '⏳ Saving…' : `💾 Save ${stage.name} guidance`}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
