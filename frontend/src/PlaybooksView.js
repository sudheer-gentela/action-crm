import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import PlaybookPlaysEditor from './PlaybookPlaysEditor';
import './SettingsView.css';

// ════════════════════════════════════════════════════════════
// PLAYBOOKS VIEW — standalone member-facing view
// Reuses sv-* and pb-* CSS from SettingsView.css
// Read-only for members, editable for org-admin / super-admin.
// All stage lists (sales, prospecting, CLM) are fetched live —
// no stale playbook.content.deal_stages used as the stage list.
// ════════════════════════════════════════════════════════════

const TEAL = '#0F9D8E';

// "sales" tab absorbs legacy type values stored in older playbooks.
// Declared at module level so it is stable and never triggers ESLint
// react-hooks/exhaustive-deps warnings when referenced inside effects.
const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];

const STAGE_TYPE_ICONS = {
  targeting: '🎯', research: '🔍', outreach: '📤', engagement: '💬',
  qualification: '✅', converted: '🎉', disqualified: '❌', nurture: '🌱', custom: '⚙️',
};

const TYPE_LABELS = {
  sales: '📘 Sales', market: '🌍 Market', product: '📦 Product',
  custom: '⚙️ Custom', prospecting: '🎯 Prospecting', clm: '📋 CLM',
};
const TYPE_COLORS = {
  sales: '#3b82f6', market: '#3182ce', product: '#38a169',
  custom: '#718096', prospecting: TEAL, clm: '#7c3aed',
};

export default function PlaybooksView({ initialTypeFilter }) {
  const token    = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API_BASE = process.env.REACT_APP_API_URL || '';

  // ── Core state ───────────────────────────────────────────
  const [playbooks, setPlaybooks]       = useState([]);
  const [selectedId, setSelectedId]     = useState(null);
  const [playbook, setPlaybook]         = useState(null);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [showNewForm, setShowNewForm]   = useState(false);
  const [newPbData, setNewPbData]       = useState({ name: '', type: 'sales', description: '' });
  const [editingStage, setEditingStage] = useState(null);
  const [creating, setCreating]         = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [showCompany, setShowCompany]   = useState(false);
  const [showPlaysTab, setShowPlaysTab] = useState(false);

  // ── Playbook types (dynamic from org settings) ───────────
  const [playbookTypes, setPlaybookTypes] = useState([
    { key: 'sales',         label: 'Sales',         icon: '📘', color: '#3b82f6', is_system: true },
    { key: 'prospecting',   label: 'Prospecting',   icon: '🎯', color: '#0F9D8E', is_system: true },
    { key: 'handover_s2i',  label: 'Handover',      icon: '🤝', color: '#0369a1', is_system: true },
  ]);

  // ── Type filter ──────────────────────────────────────────
  const [typeFilter, setTypeFilter] = useState(initialTypeFilter || 'sales');
  const isProspecting = typeFilter === 'prospecting';
  const isCLM         = typeFilter === 'clm';
  const isHandover    = typeFilter === 'handover_s2i';
  const isSales       = !isProspecting && !isCLM && !isHandover && (
    typeFilter === 'sales' || ['custom', 'market', 'product'].includes(typeFilter)
  );

  // ── Live stage lists — fetched dynamically per playbook type ─────────────
  // stagesMap: { [typeKey]: Stage[] } — built from playbookTypes after they load.
  // All types use /pipeline-stages/:key uniformly — no special cases.
  const [stagesMap,     setStagesMap]     = useState({});
  const [stagesLoading, setStagesLoading] = useState(false);

  // ── Role — reactive to role-switch events ────────────────
  const [activeRole, setActiveRole] = useState(
    () => sessionStorage.getItem('activeRole') || 'member'
  );
  const canEdit = activeRole === 'org-admin' || activeRole === 'super-admin';

  // ── Listen for role switches while mounted ───────────────
  useEffect(() => {
    const onSwitch = () => setActiveRole(sessionStorage.getItem('activeRole') || 'member');
    window.addEventListener('roleSwitch', onSwitch);
    window.addEventListener('storage',   onSwitch);
    return () => {
      window.removeEventListener('roleSwitch', onSwitch);
      window.removeEventListener('storage',   onSwitch);
    };
  }, []);

  // ── Fetch org playbook types ─────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/org/admin/playbook-types`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        if (data.playbook_types?.length) {
          // Always ensure system types are present — merge API response with defaults
          // The org/admin/playbook-types endpoint may not include system types like
          // handover_s2i that were added after the org was created
          const SYSTEM_TYPES = [
            { key: 'sales',        label: 'Sales',        icon: '📘', color: '#3b82f6', is_system: true },
            { key: 'prospecting',  label: 'Prospecting',  icon: '🎯', color: '#0F9D8E', is_system: true },
            { key: 'handover_s2i', label: 'Handover',     icon: '🤝', color: '#0369a1', is_system: true },
          ];
          // Strip legacy 'handovers' key — correct key is 'handover_s2i'
          const cleaned  = data.playbook_types.filter(t => t.key !== 'handovers');
          const apiKeys  = new Set(cleaned.map(t => t.key));
          const missing  = SYSTEM_TYPES.filter(t => !apiKeys.has(t.key));
          console.log('[PB types] from API:', cleaned.map(t=>t.key), 'merged missing:', missing.map(t=>t.key));
          setPlaybookTypes([...cleaned, ...missing]);
        }
      })
      .catch(() => { /* keep defaults — sales + prospecting */ });
  }, [API_BASE, token]);

  // ── Fetch all stage lists — driven by playbookTypes so new modules auto-appear
  useEffect(() => {
    if (!playbookTypes.length) return;
    setStagesLoading(true);
    const h = { Authorization: `Bearer ${token}` };

    const active = d => (d.stages || [])
      .filter(s => s.is_active !== false)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    // All types use /pipeline-stages/:key — including handover_s2i, no exclusions
    Promise.all(
      playbookTypes.map(t => fetch(`${API_BASE}/pipeline-stages/${t.key}`, { headers: h }).then(r => r.ok ? r.json() : { stages: [] }))
    )
      .then(results => {
        const map = {};
        playbookTypes.forEach((t, i) => { map[t.key] = active(results[i]); });
        setStagesMap(map);
      })
      .catch(() => { /* non-fatal — degrade gracefully */ })
      .finally(() => setStagesLoading(false));
  }, [playbookTypes, API_BASE, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active stage list for current tab ────────────────────
  const activeLiveStages = stagesMap[typeFilter] || [];

  // ── Filtered playbook list for current tab ───────────────
  const filteredPlaybooks = typeFilter === 'sales'
    ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type))
    : playbooks.filter(p => p.type === typeFilter);

  // ── Load playbook list ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const r = await apiService.playbooks.getAll();
        console.log('[PB list] all playbooks:', (r.data.playbooks || []).map(p => ({ id: p.id, name: p.name, type: p.type })));
        setPlaybooks(r.data.playbooks || []);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  // ── Re-select default when tab or list changes ───────────
  // SALES_LEGACY_TYPES is a module-level constant (never changes),
  // so it is safe to omit from the dependency array.
  useEffect(() => {
    const filtered = typeFilter === 'sales'
      ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type))
      : playbooks.filter(p => p.type === typeFilter);
    const def = filtered.find(p => p.is_default) || filtered[0];
    setSelectedId(def?.id || null);
    setEditingStage(null);
    setShowNewForm(false);
    setShowPlaysTab(false);
  }, [typeFilter, playbooks]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load selected playbook ───────────────────────────────
  useEffect(() => {
    if (!selectedId) { setPlaybook(null); return; }
    setPlaybook(null);
    setEditingStage(null);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        // Normalise legacy content shape
        if (raw?.content?.stages && !raw.content.deal_stages) {
          raw.content.deal_stages = raw.content.stages;
          delete raw.content.stages;
        }
        setPlaybook(raw);
      } catch (e) { console.error('[PB] playbook load failed:', e); setError('Failed to load playbook content'); }
    })();
  }, [selectedId, API_BASE, token]);

  // ── Flash helper ─────────────────────────────────────────
  const flash = useCallback((type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3000);
  }, []);

  // ── CRUD ─────────────────────────────────────────────────
  const handleSave = async () => {
    if (!playbook || !canEdit) return;
    setSaving(true);
    try {
      if (isProspecting || isCLM || isHandover) {
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
      const targetType = playbooks.find(p => p.id === id)?.type || 'sales';
      setPlaybooks(prev => prev.map(p => {
        const sameGroup = targetType === 'prospecting'
          ? p.type === 'prospecting'
          : SALES_LEGACY_TYPES.includes(targetType)
            ? SALES_LEGACY_TYPES.includes(p.type)
            : p.type === targetType;
        return sameGroup ? { ...p, is_default: p.id === id } : p;
      }));
      flash('success', 'Default playbook updated ✓');
    } catch { flash('error', 'Failed to set default'); }
  };

  const handleCreate = async () => {
    if (!newPbData.name.trim()) { flash('error', 'Name is required'); return; }
    setCreating(true);
    try {
      const type = isProspecting ? 'prospecting'
        : isCLM ? 'clm'
        : isHandover ? 'handover_s2i'
        : typeFilter === 'sales' ? (newPbData.type || 'sales')
        : typeFilter;
      const createPayload = type === 'prospecting'
        ? { name: newPbData.name, type, description: newPbData.description }
        : { name: newPbData.name, type, description: newPbData.description, content: { deal_stages: {}, company: {} } };
      const r  = await apiService.playbooks.create(createPayload);
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: 'sales', description: '' });
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
      setPlaybooks(prev => prev.filter(p => p.id !== id));
      if (selectedId === id) setSelectedId(null);
      flash('success', 'Playbook deleted');
    } catch (e) { flash('error', e?.response?.data?.error?.message || 'Failed to delete playbook'); }
    finally     { setDeleting(false); }
  };

  // ── Guidance field updaters ──────────────────────────────
  // Used by sales tab — updates playbook.content.deal_stages by stage key
  const updateStageContentField = (stageKey, field, value) => {
    setPlaybook(prev => {
      const ds = prev.content?.deal_stages;
      if (!ds) return prev;
      const updated = Array.isArray(ds)
        ? ds.map(s => (s.key === stageKey || s.name === stageKey) ? { ...s, [field]: value } : s)
        : { ...ds, [stageKey]: { ...(ds[stageKey] || {}), [field]: value } };
      return { ...prev, content: { ...prev.content, deal_stages: updated } };
    });
  };

  // Used by prospecting + CLM tabs — updates playbook.stage_guidance by stage key
  const updateGuidanceField = (stageKey, field, value) => {
    setPlaybook(prev => ({
      ...prev,
      stage_guidance: {
        ...prev.stage_guidance,
        [stageKey]: { ...(prev.stage_guidance?.[stageKey] || {}), [field]: value },
      },
    }));
  };

  // ── Render ───────────────────────────────────────────────
  if (loading) return <div className="sv-loading">Loading playbooks...</div>;

  const activeType = playbookTypes.find(t => t.key === typeFilter) || playbookTypes[0];

  // ── Stage guidance panel — shared by prospecting + CLM ──
  const renderGuidanceStages = (stages, accentColor) => {
    if (stagesLoading) return <div className="sv-loading">Loading stages…</div>;
    if (stages.length === 0) return (
      <div className="sv-empty">
        {isCLM
          ? 'No active CLM stages found. Run the CLM pipeline stages migration to seed CLM stages.'
          : isHandover
            ? 'No active handover stages found. Run the handover migration to seed stages.'
            : 'No active prospect stages found. Add stages in the Prospect Stages tab.'}
      </div>
    );
    return (
      <div className="sv-stages-list">
        {stages.map((stage, i) => {
          const g      = (playbook.stage_guidance || {})[stage.key] || {};
          const isOpen = editingStage === stage.key;
          return (
            <div key={stage.key} className="sv-stage-row">
              <div className="sv-stage-header" onClick={() => setEditingStage(isOpen ? null : stage.key)}>
                <span className="sv-stage-num" style={{ background: accentColor + '20', color: accentColor }}>{i + 1}</span>
                <span className="sv-stage-name">
                  {STAGE_TYPE_ICONS[stage.stage_type] || ''} {stage.name}
                </span>
                {(g.goal || g.key_actions?.length > 0) && (
                  <span style={{ fontSize: 11, color: accentColor, marginLeft: 8 }}>● guided</span>
                )}
                <span className="sv-hint sv-stage-goal" style={{ flex: 1 }}>
                  {g.goal?.substring(0, 55)}{g.goal?.length > 55 ? '…' : ''}
                </span>
                <span className="sv-expand-btn">{isOpen ? '▲' : '▼'}</span>
              </div>
              {isOpen && (
                <div className="sv-stage-detail">
                  {[
                    { key: 'goal',             label: 'Goal',             placeholder: 'What should happen in this stage?' },
                    { key: 'timeline',         label: 'Timeline',         placeholder: 'e.g. 2–5 business days' },
                  ].map(f => (
                    <div key={f.key} className="sv-field" style={{ marginBottom: 10 }}>
                      <label>{f.label}</label>
                      <input className="sv-input" placeholder={f.placeholder}
                        value={g[f.key] || ''} disabled={!canEdit}
                        onChange={e => updateGuidanceField(stage.key, f.key, e.target.value)} />
                    </div>
                  ))}
                  <div className="sv-field" style={{ marginTop: 8 }}>
                    <label>Key Actions (comma-separated)</label>
                    <input className="sv-input"
                      value={(g.key_actions || []).join(', ')} disabled={!canEdit}
                      onChange={e => updateGuidanceField(stage.key, 'key_actions',
                        e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                      )} />
                  </div>
                  <div className="sv-field" style={{ marginTop: 10 }}>
                    <label>Success Criteria (comma-separated)</label>
                    <input className="sv-input"
                      value={(g.success_criteria || []).join(', ')} disabled={!canEdit}
                      onChange={e => updateGuidanceField(stage.key, 'success_criteria',
                        e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                      )} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 960 }}>
      <div className="sv-panel">

        {/* ── Header ────────────────────────────────────── */}
        <div className="sv-panel-header">
          <div>
            <h2>{activeType?.icon} {activeType?.label} Playbooks</h2>
            <p className="sv-panel-desc">
              {canEdit
                ? isCLM
                  ? 'Manage CLM playbooks — define contract workflow guidance, actions, and review criteria.'
                  : isHandover
                    ? 'Manage handover playbooks — define the plays and checks required when a deal is closed won and handed to the service team.'
                    : isProspecting
                      ? 'Manage outreach playbooks — define stage guidance, key actions, and cadences for each prospecting stage.'
                      : 'Manage playbooks per market or product. Each deal can use a specific playbook; the default is used when none is selected.'
                : isCLM
                  ? 'View your org\'s CLM playbooks — contract workflow guidance and review criteria.'
                  : isHandover
                    ? 'View your org\'s handover playbook — the plays and gate checks required before a won deal is handed to the service team.'
                    : isProspecting
                      ? 'View your org\'s prospecting playbooks — outreach strategy, actions, and success criteria per stage.'
                      : 'View your org\'s sales playbooks — stage guidance, key actions, and success criteria for every deal stage.'}
            </p>
          </div>
          {canEdit && !isCLM && !isHandover && (
            <button className="sv-btn sv-btn-primary" onClick={() => setShowNewForm(true)}>
              + New {activeType?.label || 'Sales'} Playbook
            </button>
          )}
        </div>

        {/* ── Type tabs ─────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 20 }}>
          {playbookTypes.map(t => {
            const count = t.key === 'sales'
              ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type)).length
              : playbooks.filter(p => p.type === t.key).length;
            const active = typeFilter === t.key;
            return (
              <button key={t.key} onClick={() => setTypeFilter(t.key)} style={{
                padding: '10px 20px', background: 'none', border: 'none',
                borderBottom: `3px solid ${active ? (t.color || '#3b82f6') : 'transparent'}`,
                color: active ? (t.color || '#3b82f6') : '#6b7280',
                fontWeight: active ? 600 : 400, fontSize: 14,
                cursor: 'pointer', transition: 'all 0.15s',
              }}>
                {t.icon} {t.label} ({count})
              </button>
            );
          })}
        </div>

        {error   && <div className="sv-alert sv-alert-error">{error}</div>}
        {success && <div className="sv-alert sv-alert-success">{success}</div>}

        {/* ── New playbook form ──────────────────────────── */}
        {showNewForm && canEdit && (
          <div className="sv-card pb-new-form">
            <h4 style={{ marginTop: 0, marginBottom: 12 }}>New {activeType?.label || 'Sales'} Playbook</h4>
            <div style={{ display: 'flex', gap: 12 }}>
              <div className="sv-field" style={{ flex: 1 }}>
                <label>Name</label>
                <input className="sv-input"
                  placeholder={isProspecting ? 'e.g. Outbound SDR' : isCLM ? 'e.g. Enterprise CLM' : 'e.g. EMEA Enterprise'}
                  value={newPbData.name}
                  onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
              </div>
              {!isProspecting && !isCLM && !isHandover && (
                <div className="sv-field">
                  <label>Type</label>
                  <select className="sv-input" value={newPbData.type}
                    onChange={e => setNewPbData(p => ({ ...p, type: e.target.value }))}>
                    <option value="sales">📘 Sales</option>
                    <option value="market">🌍 Market</option>
                    <option value="product">📦 Product</option>
                    <option value="custom">⚙️ Custom</option>
                  </select>
                </div>
              )}
            </div>
            <div className="sv-field" style={{ marginTop: 8 }}>
              <label>Description (optional)</label>
              <input className="sv-input" placeholder="Brief description"
                value={newPbData.description}
                onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="sv-btn sv-btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? '⏳ Creating...' : '+ Create'}
              </button>
              <button className="sv-btn sv-btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* ── List + Detail ──────────────────────────────── */}
        <div className="pb-layout">

          {/* Sidebar list */}
          <div className="pb-sidebar">
            {filteredPlaybooks.length === 0 ? (
              <div className="sv-empty">
                No {activeType?.label?.toLowerCase() || 'sales'} playbooks yet.
                {canEdit ? ' Create one above.' : ' Ask your org admin to create one.'}
              </div>
            ) : filteredPlaybooks.map(pb => (
              <div key={pb.id}
                className={`pb-list-item ${selectedId === pb.id ? 'active' : ''}`}
                onClick={() => setSelectedId(pb.id)}>
                <div className="pb-list-item-main">
                  <span className="pb-list-name">{pb.name}</span>
                  {pb.is_default && <span className="pb-default-star" title="Default">★</span>}
                </div>
                <div className="pb-list-meta">
                  <span className="pb-type-badge" style={{ color: TYPE_COLORS[pb.type] || '#718096' }}>
                    {TYPE_LABELS[pb.type] || pb.type}
                  </span>
                </div>
                {selectedId === pb.id && canEdit && (
                  <div className="pb-list-actions">
                    {!pb.is_default && (
                      <button className="sv-btn sv-btn-xs"
                        onClick={e => { e.stopPropagation(); handleSetDefault(pb.id); }}>
                        ★ Set Default
                      </button>
                    )}
                    {!pb.is_default && (
                      <button className="sv-btn sv-btn-xs sv-btn-danger"
                        onClick={e => { e.stopPropagation(); handleDelete(pb.id); }}
                        disabled={deleting}>
                        🗑 Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Detail panel */}
          <div className="pb-detail">
            {!playbook ? (
              <div className="sv-empty">Select a playbook to view its content.</div>
            ) : (
              <>
                {/* Detail header */}
                <div className="pb-detail-header">
                  <div>
                    <h3 style={{ margin: 0 }}>{playbook.name}</h3>
                    {playbook.is_default && <span className="pb-default-badge">Default</span>}
                    <span className="pb-type-badge" style={{ color: TYPE_COLORS[playbook.type] || '#718096' }}>
                      {TYPE_LABELS[playbook.type] || playbook.type}
                    </span>
                  </div>
                  {canEdit && (
                    <button className="sv-btn sv-btn-primary" onClick={handleSave} disabled={saving}>
                      {saving ? '⏳ Saving...' : '💾 Save'}
                    </button>
                  )}
                </div>

                {!canEdit && (
                  <div className="sv-alert" style={{
                    background: '#ebf8ff', borderColor: '#bee3f8',
                    color: '#2b6cb0', marginBottom: 16,
                  }}>
                    👁 View only — switch to Org Admin role to edit playbooks
                  </div>
                )}

                {/* Sub-tabs */}
                <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
                  {[
                    { key: false, label: isCLM ? '📋 Contract Stages' : isHandover ? '🤝 Handover Stages' : isProspecting ? '🎯 Stage Guidance' : '📋 Stage Guidance' },
                    { key: true,  label: '🎭 Plays by Role' },
                  ].map(t => {
                    const color = isCLM ? '#7c3aed' : isHandover ? '#0369a1' : isProspecting ? TEAL : '#3b82f6';
                    return (
                      <button key={String(t.key)} onClick={() => setShowPlaysTab(t.key)} style={{
                        padding: '8px 16px', background: 'none', border: 'none',
                        borderBottom: `3px solid ${showPlaysTab === t.key ? color : 'transparent'}`,
                        color: showPlaysTab === t.key ? color : '#6b7280',
                        fontWeight: showPlaysTab === t.key ? 600 : 400,
                        fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
                      }}>
                        {t.label}
                      </button>
                    );
                  })}
                </div>

                {/* Plays sub-tab */}
                {showPlaysTab && (
                  <PlaybookPlaysEditor playbookId={playbook.id} readOnly={!canEdit} />
                )}

                {/* Stage Guidance sub-tab */}
                {!showPlaysTab && (
                  <>
                    {/* ── PROSPECTING ── */}
                    {isProspecting && (
                      <>
                        <div className="sv-card" style={{ marginBottom: 16 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: canEdit ? 'pointer' : 'default', fontSize: 13 }}>
                            <input type="checkbox"
                              checked={playbook.content?.account_based || false}
                              disabled={!canEdit}
                              onChange={e => setPlaybook(prev => ({
                                ...prev, content: { ...prev.content, account_based: e.target.checked },
                              }))} />
                            <strong>Account-Based Prospecting</strong>
                            <span style={{ color: '#6b7280', fontSize: 11 }}>— define role requirements per account</span>
                          </label>
                        </div>

                        <div className="sv-card">
                          <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15, color: TEAL }}>
                            🎯 Prospecting Stage Guidance
                          </h4>
                          {renderGuidanceStages(activeLiveStages, TEAL)}
                        </div>

                        {playbook.content?.account_based && (
                          <div className="sv-card" style={{ marginTop: 16 }}>
                            <h4 style={{ marginTop: 0, marginBottom: 8, fontSize: 14 }}>👥 Role Requirements</h4>
                            <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px' }}>
                              Define which roles you need covered per account. Used by the Coverage Scorecard.
                            </p>
                            {(playbook.content?.role_requirements || []).map((req, idx) => (
                              <div key={idx} style={{
                                display: 'flex', gap: 8, alignItems: 'center',
                                padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13,
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
                              <div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
                                No role requirements defined yet.
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {/* ── CLM ── */}
                    {isCLM && (
                      <div className="sv-card">
                        <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15, color: '#7c3aed' }}>
                          📋 CLM Stage Guidance
                        </h4>
                        {renderGuidanceStages(activeLiveStages, '#7c3aed')}
                      </div>
                    )}

                    {/* ── HANDOVER S2I ── */}
                    {isHandover && (
                      <div className="sv-card">
                        <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15, color: '#0369a1' }}>
                          🤝 Handover Stage Guidance
                        </h4>
                        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 16px' }}>
                          Define goals and key actions for each stage of the sales-to-implementation handover.
                          Gate plays are enforced before a handover can be submitted.
                        </p>
                        {renderGuidanceStages(activeLiveStages, '#0369a1')}
                      </div>
                    )}

                    {/* ── GENERIC MODULE (service, custom, future modules) ── */}
                    {!isProspecting && !isCLM && !isHandover && !isSales && (
                      <div className="sv-card">
                        <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>
                          📋 {playbookTypes.find(t => t.key === typeFilter)?.label || typeFilter} Stages
                        </h4>
                        {stagesLoading ? (
                          <div className="sv-loading">Loading stages…</div>
                        ) : activeLiveStages.length === 0 ? (
                          <div className="sv-empty">No active stages found. Add stages in Org Admin → Stages.</div>
                        ) : (
                          <div className="sv-stages-list">
                            {activeLiveStages.map((stage, i) => {
                              const guidance = playbook.stage_guidance?.[stage.key] || {};
                              const isOpen = editingStage === stage.key;
                              return (
                                <div key={stage.key} className="sv-stage-row">
                                  <div className="sv-stage-header" onClick={() => setEditingStage(isOpen ? null : stage.key)}>
                                    <span className="sv-stage-num">{i + 1}</span>
                                    <span className="sv-stage-name">{stage.name}</span>
                                    <span className="sv-hint sv-stage-goal">
                                      {guidance.goal?.substring(0, 60)}{guidance.goal?.length > 60 ? '…' : ''}
                                    </span>
                                    <span className="sv-expand-btn">{isOpen ? '▲' : '▼'}</span>
                                  </div>
                                  {isOpen && (
                                    <div className="sv-stage-detail">
                                      {['goal', 'timeline', 'next_step'].map(field => (
                                        <div key={field} className="sv-field" style={{ marginBottom: 10 }}>
                                          <label style={{ textTransform: 'capitalize' }}>{field.replace(/_/g, ' ')}</label>
                                          <input className="sv-input"
                                            value={guidance[field] || ''} disabled={!canEdit}
                                            onChange={e => updateGuidanceField(stage.key, field, e.target.value)} />
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── SALES (and legacy sales types) ── */}
                    {isSales && (
                      <>
                        {/* Company context */}
                        {playbook.content && (
                          <div className="sv-card" style={{ marginBottom: 20 }}>
                            <div className="pb-company-header" onClick={() => setShowCompany(v => !v)}>
                              <span>🏢 Company Context</span>
                              {!showCompany && (
                                playbook.content?.company?.name ||
                                playbook.content?.company?.industry ||
                                playbook.content?.company?.product
                              ) && (
                                <span className="pb-company-summary">
                                  {[
                                    playbook.content.company.name,
                                    playbook.content.company.industry,
                                    playbook.content.company.product,
                                  ].filter(Boolean).join(' · ')}
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
                                      onChange={e => setPlaybook(prev => ({ ...prev, content: {
                                        ...prev.content, company: { ...prev.content.company, [field]: e.target.value },
                                      }}))} />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Deal stages — live from /deal-stages */}
                        <div className="sv-card">
                          <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>📋 Deal Stages</h4>
                          {stagesLoading ? (
                            <div className="sv-loading">Loading stages…</div>
                          ) : activeLiveStages.length === 0 ? (
                            <div className="sv-empty">No active deal stages found. Add stages in the Deal Stages tab.</div>
                          ) : (
                            <div className="sv-stages-list">
                              {activeLiveStages.map((stage, i) => {
                                // Guidance stored in playbook.content.deal_stages — look up by key or name
                                const ds = playbook.content?.deal_stages;
                                const stageData = ds
                                  ? Array.isArray(ds)
                                    ? (ds.find(s => s.key === stage.key || s.name === stage.name) || {})
                                    : (ds[stage.key] || ds[stage.name] || {})
                                  : {};
                                const isOpen = editingStage === stage.key;
                                return (
                                  <div key={stage.key} className="sv-stage-row">
                                    <div className="sv-stage-header" onClick={() => setEditingStage(isOpen ? null : stage.key)}>
                                      <span className="sv-stage-num">{i + 1}</span>
                                      <span className="sv-stage-name">{stage.name}</span>
                                      <span className="sv-hint sv-stage-goal">
                                        {stageData.goal?.substring(0, 60)}{stageData.goal?.length > 60 ? '…' : ''}
                                      </span>
                                      <span className="sv-expand-btn">{isOpen ? '▲' : '▼'}</span>
                                    </div>
                                    {isOpen && (
                                      <div className="sv-stage-detail">
                                        {['goal', 'timeline', 'next_step'].map(field => (
                                          <div key={field} className="sv-field" style={{ marginBottom: 10 }}>
                                            <label style={{ textTransform: 'capitalize' }}>{field.replace(/_/g, ' ')}</label>
                                            <input className="sv-input"
                                              value={stageData[field] || ''} disabled={!canEdit}
                                              onChange={e => updateStageContentField(stage.key, field, e.target.value)} />
                                          </div>
                                        ))}
                                        {Array.isArray(stageData.key_actions) && stageData.key_actions.length > 0 && (
                                          <div className="sv-field" style={{ marginTop: 8 }}>
                                            <label>Key Actions</label>
                                            {stageData.key_actions.map((action, ai) => (
                                              <div key={ai} className="pb-action-row">
                                                <span className="pb-action-num">{ai + 1}</span>
                                                {canEdit ? (
                                                  <textarea className="sv-input pb-action-textarea"
                                                    value={action}
                                                    rows={Math.max(1, Math.ceil(action.length / 60))}
                                                    onChange={e => {
                                                      const updated = [...stageData.key_actions];
                                                      updated[ai] = e.target.value;
                                                      updateStageContentField(stage.key, 'key_actions', updated);
                                                    }} />
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
                          )}
                        </div>
                      </>
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
