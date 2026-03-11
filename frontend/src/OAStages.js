// ─────────────────────────────────────────────────────────────────────────────
// OAStages.js
//
// Unified Stages management — dynamically shows tabs for every playbook type.
// Deal stages and Prospect stages use their dedicated tables/routes.
// Custom types (customer_success, implementation, etc.) use pipeline_stages.
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

// ── Stage type options per pipeline ───────────────────────────────────────────

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

const GENERIC_STAGE_TYPE_OPTIONS = [
  { value: 'intake',        label: 'Intake',         desc: 'New item entering the pipeline' },
  { value: 'in_progress',   label: 'In Progress',    desc: 'Actively being worked on' },
  { value: 'review',        label: 'Review',         desc: 'Awaiting review or approval' },
  { value: 'blocked',       label: 'Blocked',        desc: 'Stalled — awaiting external input' },
  { value: 'completed',     label: 'Completed',      desc: 'Successfully finished — terminal stage' },
  { value: 'cancelled',     label: 'Cancelled',      desc: 'Cancelled or abandoned — terminal stage' },
  { value: 'custom',        label: 'Custom',         desc: 'Org-specific stage' },
];

const COLOR_PRESETS = [
  '#6B7280', '#3B82F6', '#8B5CF6', '#F59E0B',
  '#10B981', '#059669', '#EF4444', '#6366F1',
  '#EC4899', '#14B8A6', '#F97316', '#84CC16',
];

// ═══════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════

export default function OAStages() {
  const [activeTab, setActiveTab] = useState('deal');
  const [playbookTypes, setPlaybookTypes] = useState([]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalSaving, setTerminalSaving] = useState(false);

  // Fetch org's playbook types
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/org/admin/playbook-types');
        setPlaybookTypes(res.playbook_types || []);
      } catch { /* use defaults */ }
    })();
  }, []);

  // Fetch pipeline stage display settings
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/org/admin/pipeline-stages-settings');
        setShowTerminal(res.pipeline_stages_show_terminal === true);
      } catch { /* non-fatal */ }
    })();
  }, []);

  const handleToggleTerminal = async () => {
    const next = !showTerminal;
    setShowTerminal(next);
    setTerminalSaving(true);
    try {
      await apiFetch('/org/admin/pipeline-stages-settings', {
        method: 'PATCH',
        body: JSON.stringify({ pipeline_stages_show_terminal: next }),
      });
    } catch {
      setShowTerminal(!next); // revert on failure
    } finally {
      setTerminalSaving(false);
    }
  };

  // Build tab list: always start with deal + prospect, then add custom types
  const tabs = [
    { key: 'deal',     label: 'Deal Stages',     icon: '💼', color: '#4f46e5' },
    { key: 'prospect', label: 'Prospect Stages',  icon: '🎯', color: '#0F9D8E' },
  ];

  // Add tabs for custom playbook types (exclude sales + prospecting which are handled above)
  playbookTypes
    .filter(t => t.key !== 'sales' && t.key !== 'prospecting')
    .forEach(t => {
      tabs.push({
        key: t.key,
        label: `${t.label} Stages`,
        icon: t.icon || '📂',
        color: t.color || '#6b7280',
      });
    });

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🏷️ Stages</h2>
          <p className="sv-panel-desc">
            Configure the stages in your pipelines. Each playbook type can have its own set of stages.
            Add new playbook types in Org Settings → Playbook Types.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            Show terminal stages
          </span>
          <button
            onClick={handleToggleTerminal}
            disabled={terminalSaving}
            title={showTerminal ? 'Hide terminal stages (e.g. Closed Won / Lost) in Playbooks' : 'Show terminal stages in Playbooks'}
            style={{
              width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
              background: showTerminal ? '#10b981' : '#d1d5db',
              position: 'relative', transition: 'background 0.2s', flexShrink: 0,
              opacity: terminalSaving ? 0.6 : 1,
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: showTerminal ? 23 : 3,
              width: 18, height: 18, borderRadius: '50%', background: '#fff',
              transition: 'left 0.2s', display: 'block',
            }} />
          </button>
        </div>
      </div>

      {/* Dynamic tab toggle */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
        {tabs.map(t => (
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
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'deal'     && <DealStagesPanel />}
      {activeTab === 'prospect' && <ProspectStagesPanel />}
      {activeTab !== 'deal' && activeTab !== 'prospect' && (
        <PipelineStagesPanel
          pipeline={activeTab}
          tabInfo={tabs.find(t => t.key === activeTab)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Deal Stages Panel (uses /pipeline-stages/sales)
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
    try { setLoading(true); const r = await apiFetch('/pipeline-stages/sales'); setStages(r.stages || []); }
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
      const r = await apiFetch('/pipeline-stages/sales/reorder', { method: 'PATCH', body: JSON.stringify({ order: newOrder }) });
      setStages(r.stages || []);
    } catch (e) { flash('error', e.message); }
  }

  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/pipeline-stages/sales/${stage.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !stage.is_active }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) { setEditId(null); return; }
    try {
      const r = await apiFetch(`/pipeline-stages/sales/${stage.id}`, { method: 'PUT', body: JSON.stringify({ name: editName.trim() }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null);
      flash('success', 'Stage renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(stage) {
    if (!window.confirm(`Delete "${stage.name}"? This cannot be undone if no deals reference it.`)) return;
    try {
      const r = await apiFetch(`/pipeline-stages/sales/${stage.id}`, { method: 'DELETE' });
      if (r.action === 'deactivated') {
        setStages(prev => prev.map(s => s.id === stage.id ? { ...s, is_active: false } : s));
      } else {
        setStages(prev => prev.filter(s => s.id !== stage.id));
      }
      flash('success', r.message);
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch('/pipeline-stages/sales', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), stage_type: newType, is_terminal: newTerminal }),
      });
      setStages(prev => [...prev, r.stage]);
      setNewName(''); setNewType('custom'); setNewTerminal(false); setAdding(false);
      flash('success', 'Stage created');
    } catch (e) { flash('error', e.message); }
    finally { setSubmitting(false); }
  }

  if (loading) return <div className="sv-loading" style={{ padding: 24 }}>Loading deal stages…</div>;

  const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const systemStages = sorted.filter(s => s.is_system);
  const customStages = sorted.filter(s => !s.is_system);

  return (
    <div className="sv-panel-body">
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <StagesSection
        title="System Stages" hint="Built-in deal stages. Can be renamed and reordered. Cannot be deleted."
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

      {adding ? (
        <AddStageForm
          name={newName} onNameChange={setNewName}
          type={newType} onTypeChange={setNewType}
          terminal={newTerminal} onTerminalChange={setNewTerminal}
          typeOptions={DEAL_STAGE_TYPE_OPTIONS}
          submitting={submitting}
          onSubmit={handleAdd} onCancel={() => { setAdding(false); setNewName(''); }}
          placeholder="Stage name (e.g. Technical Review)…"
          terminalLabel="Terminal stage (deals here are excluded from AI action generation)"
        />
      ) : (
        <button className="sv-btn-primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add Custom Stage</button>
      )}

      <StageTypeGrid title="Stage Type Reference" options={DEAL_STAGE_TYPE_OPTIONS}
        hint="Stage type tells the AI what kind of deal activity is expected." />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Prospect Stages Panel (uses /pipeline-stages/prospecting)
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
    try { setLoading(true); const r = await apiFetch('/pipeline-stages/prospecting'); setStages(r.stages || []); }
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
      const r = await apiFetch('/pipeline-stages/prospecting/reorder', { method: 'PATCH', body: JSON.stringify({ order: newOrder }) });
      setStages(r.stages || []);
    } catch (e) { flash('error', e.message); }
  }

  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/pipeline-stages/prospecting/${stage.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !stage.is_active }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) { setEditId(null); return; }
    try {
      const r = await apiFetch(`/pipeline-stages/prospecting/${stage.id}`, { method: 'PUT', body: JSON.stringify({ name: editName.trim() }) });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null);
      flash('success', 'Stage renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(stage) {
    if (!window.confirm(`Delete "${stage.name}"?`)) return;
    try {
      const r = await apiFetch(`/pipeline-stages/prospecting/${stage.id}`, { method: 'DELETE' });
      if (r.action === 'deactivated') {
        setStages(prev => prev.map(s => s.id === stage.id ? { ...s, is_active: false } : s));
      } else {
        setStages(prev => prev.filter(s => s.id !== stage.id));
      }
      flash('success', r.message);
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch('/pipeline-stages/prospecting', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), stage_type: newType, is_terminal: newTerminal, color: newColor }),
      });
      setStages(prev => [...prev, r.stage]);
      setNewName(''); setNewType('custom'); setNewTerminal(false); setAdding(false);
      flash('success', 'Stage created');
    } catch (e) { flash('error', e.message); }
    finally { setSubmitting(false); }
  }

  if (loading) return <div className="sv-loading" style={{ padding: 24 }}>Loading prospect stages…</div>;

  const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const systemStages = sorted.filter(s => s.is_system);
  const customStages = sorted.filter(s => !s.is_system);

  return (
    <div className="sv-panel-body">
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <StagesSection
        title="Default Stages" hint="Built-in prospect lifecycle stages. Can be renamed and reordered."
        stages={systemStages} editId={editId} editName={editName}
        onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
        onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
        onToggle={handleToggle} onMove={moveStage} onDelete={null}
        stageTypeLabels={STAGE_TYPE_LABELS} showColor
      />

      <StagesSection
        title="Custom Stages" hint="Click a name to rename."
        stages={customStages} editId={editId} editName={editName}
        onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
        onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
        onToggle={handleToggle} onMove={moveStage} onDelete={handleDelete}
        stageTypeLabels={STAGE_TYPE_LABELS} showColor
      />

      {adding ? (
        <AddStageForm
          name={newName} onNameChange={setNewName}
          type={newType} onTypeChange={setNewType}
          terminal={newTerminal} onTerminalChange={setNewTerminal}
          typeOptions={PROSPECT_STAGE_TYPE_OPTIONS}
          submitting={submitting}
          onSubmit={handleAdd} onCancel={() => { setAdding(false); setNewName(''); }}
          placeholder="Stage name (e.g. Cold Outreach)…"
          terminalLabel="Terminal stage (prospects here are excluded from AI action generation)"
          color={newColor} onColorChange={setNewColor}
        />
      ) : (
        <button className="sv-btn-primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add Custom Stage</button>
      )}

      <StageTypeGrid title="Stage Type Reference" options={PROSPECT_STAGE_TYPE_OPTIONS}
        hint="Stage type tells the AI what kind of prospecting activity is expected." />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Generic Pipeline Stages Panel (uses /pipeline-stages/:pipeline)
// For custom types: Customer Success, Implementation, etc.
// ═══════════════════════════════════════════════════════════════════════════

function PipelineStagesPanel({ pipeline, tabInfo }) {
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

  const STAGE_TYPE_OPTIONS = GENERIC_STAGE_TYPE_OPTIONS;
  const STAGE_TYPE_LABELS = Object.fromEntries(STAGE_TYPE_OPTIONS.map(o => [o.value, o.label]));
  const pipelineLabel = tabInfo?.label?.replace(' Stages', '') || pipeline;

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiFetch(`/pipeline-stages/${pipeline}`);
      setStages(r.stages || []);
    }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [pipeline]);
  useEffect(() => { load(); }, [load]);

  async function moveStage(stage, direction) {
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex(s => s.id === stage.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const newOrder = sorted.map(s => s.id);
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
    try {
      const r = await apiFetch(`/pipeline-stages/${pipeline}/reorder`, { method: 'PATCH', body: JSON.stringify({ order: newOrder }) });
      setStages(r.stages || []);
    } catch (e) { flash('error', e.message); }
  }

  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/pipeline-stages/${pipeline}/${stage.id}`, {
        method: 'PUT', body: JSON.stringify({ is_active: !stage.is_active }),
      });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) { setEditId(null); return; }
    try {
      const r = await apiFetch(`/pipeline-stages/${pipeline}/${stage.id}`, {
        method: 'PUT', body: JSON.stringify({ name: editName.trim() }),
      });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null);
      flash('success', 'Stage renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(stage) {
    if (!window.confirm(`Delete "${stage.name}"?`)) return;
    try {
      await apiFetch(`/pipeline-stages/${pipeline}/${stage.id}`, { method: 'DELETE' });
      setStages(prev => prev.filter(s => s.id !== stage.id));
      flash('success', `"${stage.name}" deleted`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch(`/pipeline-stages/${pipeline}`, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), stage_type: newType, is_terminal: newTerminal, color: newColor }),
      });
      setStages(prev => [...prev, r.stage]);
      setNewName(''); setNewType('custom'); setNewTerminal(false); setAdding(false);
      flash('success', 'Stage created');
    } catch (e) { flash('error', e.message); }
    finally { setSubmitting(false); }
  }

  if (loading) return <div className="sv-loading" style={{ padding: 24 }}>Loading {pipelineLabel.toLowerCase()} stages…</div>;

  const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="sv-panel-body">
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      {sorted.length === 0 && !adding && (
        <div className="sv-empty" style={{ padding: 32, textAlign: 'center' }}>
          <p style={{ fontSize: 15, marginBottom: 8 }}>No stages defined for {pipelineLabel} yet.</p>
          <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 16 }}>
            Create stages to define your {pipelineLabel.toLowerCase()} pipeline. These stages will appear
            in {pipelineLabel} playbooks under Stage Guidance and Plays by Role.
          </p>
        </div>
      )}

      {sorted.length > 0 && (
        <StagesSection
          title={`${pipelineLabel} Stages`}
          hint={`Define the stages in your ${pipelineLabel.toLowerCase()} pipeline. Click a name to rename.`}
          stages={sorted} editId={editId} editName={editName}
          onEditStart={(s) => { setEditId(s.id); setEditName(s.name); }} onEditChange={setEditName}
          onEditCommit={(s) => handleRename(s)} onEditCancel={() => setEditId(null)}
          onToggle={handleToggle} onMove={moveStage} onDelete={handleDelete}
          stageTypeLabels={STAGE_TYPE_LABELS} showColor
        />
      )}

      {adding ? (
        <AddStageForm
          name={newName} onNameChange={setNewName}
          type={newType} onTypeChange={setNewType}
          terminal={newTerminal} onTerminalChange={setNewTerminal}
          typeOptions={GENERIC_STAGE_TYPE_OPTIONS}
          submitting={submitting}
          onSubmit={handleAdd} onCancel={() => { setAdding(false); setNewName(''); }}
          placeholder={`Stage name (e.g. Onboarding, Handoff Review)…`}
          terminalLabel="Terminal stage (items here are considered complete)"
          color={newColor} onColorChange={setNewColor}
        />
      ) : (
        <button className="sv-btn-primary" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ Add Stage</button>
      )}

      <StageTypeGrid title="Stage Type Reference" options={GENERIC_STAGE_TYPE_OPTIONS}
        hint="Stage type helps the AI understand what activity is expected at each stage." />
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
