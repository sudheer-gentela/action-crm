// ─────────────────────────────────────────────────────────────────────────────
// OAStages.js
//
// Unified Stages management — combines Deal Stages and Prospect Stages
// into a single tabbed component under one OrgAdmin menu item.
//
// Replace the separate OADealStages and OAProspectStages imports/tabs
// with this single component:
//   import OAStages from './OAStages';
//   { id: 'stages', icon: '🏷️', label: 'Stages' }
//   {tab === 'stages' && <OAStages />}
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

// ── Deal stage types ────────────────────────────────────────────────────────
const DEAL_STAGE_TYPE_OPTIONS = [
  { value: 'awareness',   label: 'Awareness',             desc: 'Top of funnel / inbound interest' },
  { value: 'discovery',   label: 'Discovery',             desc: 'Qualification / needs analysis' },
  { value: 'evaluation',  label: 'Evaluation',            desc: 'Demo / proof of concept / trial' },
  { value: 'proposal',    label: 'Proposal',              desc: 'Formal proposal or quote sent' },
  { value: 'negotiation', label: 'Negotiation',           desc: 'Pricing / legal / contract review' },
  { value: 'closing',     label: 'Closing',               desc: 'Final approval / signature pending' },
  { value: 'closed_won',  label: 'Closed Won',            desc: 'Deal won — terminal stage' },
  { value: 'closed_lost', label: 'Closed Lost',           desc: 'Deal lost — terminal stage' },
  { value: 'custom',      label: 'Custom (no mapping)',   desc: 'Org-specific stage — AI uses general guidance' },
];

// ── Prospect stage types ────────────────────────────────────────────────────
const PROSPECT_STAGE_TYPE_OPTIONS = [
  { value: 'targeting',      label: 'Targeting',       desc: 'Identified as potential fit — not yet researched' },
  { value: 'research',       label: 'Research',        desc: 'Gathering intel, ICP scoring, account mapping' },
  { value: 'outreach',       label: 'Outreach',        desc: 'Active contact attempts (email, LinkedIn, phone)' },
  { value: 'engagement',     label: 'Engagement',      desc: 'Two-way communication established' },
  { value: 'qualification',  label: 'Qualification',   desc: 'Evaluating fit — budget, authority, need, timeline' },
  { value: 'converted',      label: 'Converted',       desc: 'Became a contact / deal — terminal stage' },
  { value: 'disqualified',   label: 'Disqualified',    desc: 'Not a fit — terminal stage' },
  { value: 'nurture',        label: 'Nurture',         desc: 'Long-term follow-up — not ready now' },
  { value: 'custom',         label: 'Custom',          desc: 'Org-specific stage — AI uses general guidance' },
];

const COLOR_PRESETS = [
  '#6B7280', '#3B82F6', '#8B5CF6', '#F59E0B',
  '#10B981', '#059669', '#EF4444', '#6366F1',
  '#EC4899', '#14B8A6', '#F97316', '#84CC16',
];

const TEAL = '#0F9D8E';

// ═══════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════

export default function OAStages() {
  const [activeTab, setActiveTab] = useState('deal'); // 'deal' | 'prospect'

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🏷️ Stages</h2>
          <p className="sv-panel-desc">
            Configure the stages in your sales and prospecting pipelines. System stages can
            be renamed or deactivated. Custom stages can be fully managed.
          </p>
        </div>
      </div>

      {/* Tab toggle */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'deal',     label: '💼 Deal Stages',     color: '#4f46e5' },
          { key: 'prospect', label: '🎯 Prospect Stages', color: TEAL },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '10px 20px',
              background: 'none',
              border: 'none',
              borderBottom: `3px solid ${activeTab === t.key ? t.color : 'transparent'}`,
              color: activeTab === t.key ? t.color : '#6b7280',
              fontWeight: activeTab === t.key ? 600 : 400,
              fontSize: 14,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'deal'     && <DealStagesPanel />}
      {activeTab === 'prospect' && <ProspectStagesPanel />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Deal Stages Panel
// ═══════════════════════════════════════════════════════════════════════════

function DealStagesPanel() {
  const [stages, setStages]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [adding, setAdding]         = useState(false);
  const [newName, setNewName]       = useState('');
  const [newType, setNewType]       = useState('custom');
  const [newTerminal, setNewTerminal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [editName, setEditName] = useState('');

  const STAGE_TYPE_OPTIONS = DEAL_STAGE_TYPE_OPTIONS;
  const STAGE_TYPE_LABELS = Object.fromEntries(STAGE_TYPE_OPTIONS.map(o => [o.value, o.label]));

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try { setLoading(true); const r = await apiFetch('/deal-stages'); setStages(r.stages || []); }
    catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function moveStage(stage, direction) {
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex(s => s.id === stage.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const newOrder = sorted.map(s => s.id);
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
    try {
      const r = await apiFetch('/deal-stages/reorder', { method: 'PATCH', body: JSON.stringify({ order: newOrder }) });
      setStages(r.stages || []);
    } catch (e) { flash('error', e.message); }
  }

  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/deal-stages/${stage.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !stage.is_active }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) { setEditId(null); return; }
    try {
      const r = await apiFetch(`/deal-stages/${stage.id}`, { method: 'PUT', body: JSON.stringify({ name: editName.trim() }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null); flash('success', 'Stage renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(stage) {
    if (!window.confirm(`Delete stage "${stage.name}"?\n\nDeals in this stage must be moved first.`)) return;
    try {
      await apiFetch(`/deal-stages/${stage.id}`, { method: 'DELETE' });
      setStages(prev => prev.filter(s => s.id !== stage.id));
      flash('success', `"${stage.name}" deleted`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch('/deal-stages', { method: 'POST', body: JSON.stringify({ name: newName.trim(), stage_type: newType, is_terminal: newTerminal }) });
      setStages(prev => [...prev, r.stage]);
      setNewName(''); setNewType('custom'); setNewTerminal(false); setAdding(false);
      flash('success', `"${r.stage.name}" created`);
    } catch (e) { flash('error', e.message); } finally { setSubmitting(false); }
  }

  if (loading) return <div className="sv-loading">Loading deal stages…</div>;

  const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const systemStages = sorted.filter(s => s.is_system);
  const customStages = sorted.filter(s => !s.is_system);

  return (
    <div className="sv-panel-body">
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <StagesSection
        title="Default Stages" hint="Built-in stages. Can be renamed and reordered. Cannot be deleted."
        stages={systemStages} editId={editId} editName={editName}
        onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
        onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
        onToggle={handleToggle} onMove={moveStage} onDelete={null}
        stageTypeLabels={STAGE_TYPE_LABELS}
      />

      <StagesSection
        title="Custom Stages" hint="Click a name to rename. Cannot be deleted if deals are in that stage."
        stages={customStages} editId={editId} editName={editName}
        onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
        onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
        onToggle={handleToggle} onMove={moveStage} onDelete={handleDelete}
        stageTypeLabels={STAGE_TYPE_LABELS}
      />

      {/* Add form */}
      {adding ? (
        <AddStageForm
          name={newName} onNameChange={setNewName}
          type={newType} onTypeChange={setNewType}
          terminal={newTerminal} onTerminalChange={setNewTerminal}
          typeOptions={STAGE_TYPE_OPTIONS}
          submitting={submitting}
          onSubmit={handleAdd} onCancel={() => { setAdding(false); setNewName(''); }}
          placeholder="Stage name (e.g. Legal Review)…"
          terminalLabel="Terminal stage (deals here are excluded from AI action generation)"
        />
      ) : (
        <button className="sv-btn-primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add Custom Stage</button>
      )}

      {/* Type reference */}
      <StageTypeGrid title="Stage Type Reference" options={STAGE_TYPE_OPTIONS}
        hint="Stage type tells the AI what kind of sales activity is expected." />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Prospect Stages Panel
// ═══════════════════════════════════════════════════════════════════════════

function ProspectStagesPanel() {
  const [stages, setStages]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [adding, setAdding]         = useState(false);
  const [newName, setNewName]       = useState('');
  const [newType, setNewType]       = useState('custom');
  const [newTerminal, setNewTerminal] = useState(false);
  const [newColor, setNewColor]     = useState('#6B7280');
  const [submitting, setSubmitting] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [editName, setEditName] = useState('');

  const STAGE_TYPE_OPTIONS = PROSPECT_STAGE_TYPE_OPTIONS;
  const STAGE_TYPE_LABELS = Object.fromEntries(STAGE_TYPE_OPTIONS.map(o => [o.value, o.label]));

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try { setLoading(true); const r = await apiFetch('/prospect-stages'); setStages(r.stages || []); }
    catch (e) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function moveStage(stage, direction) {
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex(s => s.id === stage.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const newOrder = sorted.map(s => s.id);
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
    try {
      const r = await apiFetch('/prospect-stages/reorder', { method: 'PATCH', body: JSON.stringify({ order: newOrder }) });
      setStages(r.stages || []);
    } catch (e) { flash('error', e.message); }
  }

  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/prospect-stages/${stage.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !stage.is_active }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) { setEditId(null); return; }
    try {
      const r = await apiFetch(`/prospect-stages/${stage.id}`, { method: 'PUT', body: JSON.stringify({ name: editName.trim() }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null); flash('success', 'Stage renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(stage) {
    if (!window.confirm(`Delete stage "${stage.name}"?\n\nProspects in this stage must be moved first.`)) return;
    try {
      await apiFetch(`/prospect-stages/${stage.id}`, { method: 'DELETE' });
      setStages(prev => prev.filter(s => s.id !== stage.id));
      flash('success', `"${stage.name}" deleted`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch('/prospect-stages', { method: 'POST', body: JSON.stringify({ name: newName.trim(), stage_type: newType, is_terminal: newTerminal, color: newColor }) });
      setStages(prev => [...prev, r.stage]);
      setNewName(''); setNewType('custom'); setNewTerminal(false); setNewColor('#6B7280'); setAdding(false);
      flash('success', `"${r.stage.name}" created`);
    } catch (e) { flash('error', e.message); } finally { setSubmitting(false); }
  }

  if (loading) return <div className="sv-loading">Loading prospect stages…</div>;

  const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const systemStages = sorted.filter(s => s.is_system);
  const customStages = sorted.filter(s => !s.is_system);

  return (
    <div className="sv-panel-body">
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <StagesSection
        title="Default Stages" hint="Built-in prospect lifecycle stages. Can be renamed and reordered. Cannot be deleted."
        stages={systemStages} editId={editId} editName={editName}
        onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
        onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
        onToggle={handleToggle} onMove={moveStage} onDelete={null}
        stageTypeLabels={STAGE_TYPE_LABELS} showColor
      />

      <StagesSection
        title="Custom Stages" hint="Click a name to rename. Cannot be deleted if prospects are in that stage."
        stages={customStages} editId={editId} editName={editName}
        onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
        onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
        onToggle={handleToggle} onMove={moveStage} onDelete={handleDelete}
        stageTypeLabels={STAGE_TYPE_LABELS} showColor
      />

      {/* Add form with color picker */}
      {adding ? (
        <AddStageForm
          name={newName} onNameChange={setNewName}
          type={newType} onTypeChange={setNewType}
          terminal={newTerminal} onTerminalChange={setNewTerminal}
          typeOptions={STAGE_TYPE_OPTIONS}
          submitting={submitting}
          onSubmit={handleAdd} onCancel={() => { setAdding(false); setNewName(''); }}
          placeholder="Stage name (e.g. Cold Outreach)…"
          terminalLabel="Terminal stage (prospects here are excluded from AI action generation)"
          color={newColor} onColorChange={setNewColor}
        />
      ) : (
        <button className="sv-btn-primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add Custom Stage</button>
      )}

      <StageTypeGrid title="Stage Type Reference" options={STAGE_TYPE_OPTIONS}
        hint="Stage type tells the AI what kind of prospecting activity is expected." />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared Sub-Components
// ═══════════════════════════════════════════════════════════════════════════

function StagesSection({ title, hint, stages, editId, editName, onEditStart, onEditChange, onEditCommit, onEditCancel, onToggle, onMove, onDelete, stageTypeLabels, showColor }) {
  return (
    <div className="sv-section">
      <div className="sv-card">
        <h3>{title}</h3>
        <p className="sv-hint">{hint}</p>
        {stages.length === 0 && <p className="sv-empty">No stages in this section.</p>}
        <div className="oa-roles-list">
          {stages.map((stage, idx) => (
            <StageRow
              key={stage.id} stage={stage}
              isFirst={idx === 0} isLast={idx === stages.length - 1}
              editId={editId} editName={editName}
              onEditStart={() => onEditStart(stage)} onEditChange={onEditChange}
              onEditCommit={() => onEditCommit(stage)} onEditCancel={onEditCancel}
              onToggle={() => onToggle(stage)}
              onMoveUp={() => onMove(stage, 'up')} onMoveDown={() => onMove(stage, 'down')}
              onDelete={onDelete ? () => onDelete(stage) : null}
              stageTypeLabels={stageTypeLabels} showColor={showColor}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StageRow({ stage, isFirst, isLast, editId, editName, onEditStart, onEditChange, onEditCommit, onEditCancel, onToggle, onMoveUp, onMoveDown, onDelete, stageTypeLabels, showColor }) {
  const isEditing = editId === stage.id;
  return (
    <div className={`oa-role-row ${!stage.is_active ? 'oa-role-row--inactive' : ''}`}>
      <div className="oa-stage-row__order">
        <button className="oa-stage-order-btn" onClick={onMoveUp} disabled={isFirst} title="Move up">▲</button>
        <button className="oa-stage-order-btn" onClick={onMoveDown} disabled={isLast} title="Move down">▼</button>
      </div>
      {showColor && stage.color && (
        <span className="oa-stage-color-dot" style={{ backgroundColor: stage.color }} title={stage.color} />
      )}
      <div className="oa-role-row__info" style={{ flex: 1 }}>
        {isEditing ? (
          <input className="oa-input oa-input--inline" value={editName} autoFocus
            onChange={e => onEditChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onEditCommit(); if (e.key === 'Escape') onEditCancel(); }}
            onBlur={onEditCommit} />
        ) : (
          <span className="oa-role-row__name oa-role-row__name--editable" onClick={onEditStart} title="Click to rename">
            {stage.name} ✏️
          </span>
        )}
        <span className="oa-stage-type-badge">{stageTypeLabels[stage.stage_type] || stage.stage_type}</span>
        {stage.is_terminal && <span className="oa-role-row__tag oa-role-row__tag--terminal">Terminal</span>}
        {!stage.is_active && <span className="oa-role-row__tag">Inactive</span>}
        {stage.is_system && <span className="oa-role-row__tag oa-role-row__tag--system">System</span>}
      </div>
      <div className="oa-stage-row__actions">
        <button className={`sv-btn-sm ${stage.is_active ? 'sv-btn-sm--danger' : 'sv-btn-sm--primary'}`} onClick={onToggle}>
          {stage.is_active ? 'Deactivate' : 'Activate'}
        </button>
        {onDelete && <button className="sv-btn-sm sv-btn-sm--danger" onClick={onDelete}>Delete</button>}
      </div>
    </div>
  );
}

function AddStageForm({ name, onNameChange, type, onTypeChange, terminal, onTerminalChange, typeOptions, submitting, onSubmit, onCancel, placeholder, terminalLabel, color, onColorChange }) {
  return (
    <div className="oa-stage-add-form">
      <div className="oa-stage-add-row">
        <input className="oa-input" placeholder={placeholder} value={name} autoFocus
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSubmit(); if (e.key === 'Escape') onCancel(); }} />
      </div>
      <div className="oa-stage-add-row">
        <label className="oa-stage-label">Stage type</label>
        <select className="oa-select" value={type} onChange={e => onTypeChange(e.target.value)}>
          {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>)}
        </select>
      </div>
      {onColorChange && (
        <div className="oa-stage-add-row">
          <label className="oa-stage-label">Color</label>
          <div className="oa-color-presets">
            {COLOR_PRESETS.map(c => (
              <button key={c} className={`oa-color-swatch ${color === c ? 'oa-color-swatch--active' : ''}`}
                style={{ backgroundColor: c }} onClick={() => onColorChange(c)} title={c} />
            ))}
          </div>
        </div>
      )}
      <div className="oa-stage-add-row oa-stage-add-row--checkbox">
        <label><input type="checkbox" checked={terminal} onChange={e => onTerminalChange(e.target.checked)} />{' '}{terminalLabel}</label>
      </div>
      <div className="oa-stage-add-row oa-stage-add-row--actions">
        <button className="sv-btn-primary" onClick={onSubmit} disabled={submitting || !name.trim()}>
          {submitting ? '…' : '+ Add Stage'}
        </button>
        <button className="sv-btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function StageTypeGrid({ title, options, hint }) {
  return (
    <div className="sv-section">
      <div className="sv-card">
        <h3>{title}</h3>
        <p className="sv-hint">{hint}</p>
        <div className="oa-stage-type-grid">
          {options.map(o => (
            <div key={o.value} className="oa-stage-type-card">
              <span className="oa-stage-type-name">{o.label}</span>
              <span className="oa-stage-type-desc">{o.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
