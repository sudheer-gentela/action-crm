// ─────────────────────────────────────────────────────────────────────────────
// OAProspectStages.js
//
// Add this component to OrgAdminView.js:
//   1. Import at top: import OAProspectStages from './OAProspectStages';
//   2. Add tab to ORG_ADMIN_TABS array (after 'deal-stages'):
//      { id: 'prospect-stages', label: 'Prospect Stages', icon: '🔬' },
//   3. Add render line in settings-body (after deal-stages line):
//      {tab === 'prospect-stages' && <OAProspectStages />}
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || '';

// ── Shared fetch helper ─────────────────────────────────────────────────────
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

// ── Stage type options for prospect lifecycle ───────────────────────────────
const STAGE_TYPE_OPTIONS = [
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

const STAGE_TYPE_LABELS = Object.fromEntries(STAGE_TYPE_OPTIONS.map(o => [o.value, o.label]));

// ── Default color palette for the color picker ──────────────────────────────
const COLOR_PRESETS = [
  '#6B7280', '#3B82F6', '#8B5CF6', '#F59E0B',
  '#10B981', '#059669', '#EF4444', '#6366F1',
  '#EC4899', '#14B8A6', '#F97316', '#84CC16',
];

export default function OAProspectStages() {
  const [stages,   setStages]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  // Add form state
  const [adding,      setAdding]      = useState(false);
  const [newName,     setNewName]     = useState('');
  const [newType,     setNewType]     = useState('custom');
  const [newTerminal, setNewTerminal] = useState(false);
  const [newColor,    setNewColor]    = useState('#6B7280');
  const [submitting,  setSubmitting]  = useState(false);

  // Inline edit state
  const [editId,   setEditId]   = useState(null);
  const [editName, setEditName] = useState('');

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiFetch('/prospect-stages');
      setStages(r.stages || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Reorder ─────────────────────────────────────────────────────────────────
  async function moveStage(stage, direction) {
    const sorted  = [...stages].sort((a, b) => a.sort_order - b.sort_order);
    const idx     = sorted.findIndex(s => s.id === stage.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const newOrder = sorted.map(s => s.id);
    [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];

    try {
      const r = await apiFetch('/prospect-stages/reorder', {
        method: 'PATCH',
        body:   JSON.stringify({ order: newOrder }),
      });
      setStages(r.stages || []);
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Toggle active ──────────────────────────────────────────────────────────
  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/prospect-stages/${stage.id}`, {
        method: 'PUT',
        body:   JSON.stringify({ is_active: !stage.is_active }),
      });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Rename ─────────────────────────────────────────────────────────────────
  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) {
      setEditId(null);
      return;
    }
    try {
      const r = await apiFetch(`/prospect-stages/${stage.id}`, {
        method: 'PUT',
        body:   JSON.stringify({ name: editName.trim() }),
      });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null);
      flash('success', 'Stage renamed');
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function handleDelete(stage) {
    if (!window.confirm(`Delete stage "${stage.name}"?\n\nThis cannot be undone. Prospects in this stage must be moved first.`)) return;
    try {
      await apiFetch(`/prospect-stages/${stage.id}`, { method: 'DELETE' });
      setStages(prev => prev.filter(s => s.id !== stage.id));
      flash('success', `"${stage.name}" deleted`);
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Add new stage ──────────────────────────────────────────────────────────
  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch('/prospect-stages', {
        method: 'POST',
        body:   JSON.stringify({
          name:        newName.trim(),
          stage_type:  newType,
          is_terminal: newTerminal,
          color:       newColor,
        }),
      });
      setStages(prev => [...prev, r.stage]);
      setNewName('');
      setNewType('custom');
      setNewTerminal(false);
      setNewColor('#6B7280');
      setAdding(false);
      flash('success', `"${r.stage.name}" created`);
    } catch (e) {
      flash('error', e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="sv-loading">Loading prospect stages…</div>;

  const sorted       = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const systemStages = sorted.filter(s => s.is_system);
  const customStages = sorted.filter(s => !s.is_system);

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🔬 Prospect Stages</h2>
          <p className="sv-panel-desc">
            Configure the lifecycle stages for your prospecting pipeline. System stages
            can be renamed, reordered, or deactivated. Custom stages can be fully managed.
            Stage type tells the AI what kind of prospecting activity is expected.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <div className="sv-panel-body">

        {/* ── System stages ─────────────────────────────────────────────────── */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Default Stages</h3>
            <p className="sv-hint">
              Built-in prospect lifecycle stages. Can be renamed and reordered.
              Deactivate to hide from the pipeline. Cannot be deleted.
            </p>

            <div className="oa-roles-list">
              {systemStages.map((stage, idx) => (
                <ProspectStageRow
                  key={stage.id}
                  stage={stage}
                  isFirst={idx === 0}
                  isLast={idx === systemStages.length - 1}
                  editId={editId}
                  editName={editName}
                  onEditStart={() => { setEditId(stage.id); setEditName(stage.name); }}
                  onEditChange={setEditName}
                  onEditCommit={() => handleRename(stage)}
                  onEditCancel={() => setEditId(null)}
                  onToggle={() => handleToggle(stage)}
                  onMoveUp={() => moveStage(stage, 'up')}
                  onMoveDown={() => moveStage(stage, 'down')}
                  onDelete={null}
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── Custom stages ────────────────────────────────────────────────── */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Custom Stages</h3>
            <p className="sv-hint">
              Stages specific to your organisation's prospecting process. Click a name
              to rename. Custom stages cannot be deleted if prospects are currently in
              that stage.
            </p>

            {customStages.length === 0 && !adding && (
              <p className="sv-empty">No custom stages yet.</p>
            )}

            <div className="oa-roles-list">
              {customStages.map((stage, idx) => (
                <ProspectStageRow
                  key={stage.id}
                  stage={stage}
                  isFirst={idx === 0}
                  isLast={idx === customStages.length - 1}
                  editId={editId}
                  editName={editName}
                  onEditStart={() => { setEditId(stage.id); setEditName(stage.name); }}
                  onEditChange={setEditName}
                  onEditCommit={() => handleRename(stage)}
                  onEditCancel={() => setEditId(null)}
                  onToggle={() => handleToggle(stage)}
                  onMoveUp={() => moveStage(stage, 'up')}
                  onMoveDown={() => moveStage(stage, 'down')}
                  onDelete={() => handleDelete(stage)}
                />
              ))}
            </div>

            {/* Add new stage form */}
            {adding ? (
              <div className="oa-stage-add-form">
                <div className="oa-stage-add-row">
                  <input
                    className="oa-input"
                    placeholder="Stage name (e.g. Cold Outreach)…"
                    value={newName}
                    autoFocus
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
                  />
                </div>

                <div className="oa-stage-add-row">
                  <label className="oa-stage-label">Stage type</label>
                  <select
                    className="oa-select"
                    value={newType}
                    onChange={e => setNewType(e.target.value)}
                  >
                    {STAGE_TYPE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>
                        {o.label} — {o.desc}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="oa-stage-add-row">
                  <label className="oa-stage-label">Color</label>
                  <div className="oa-color-presets">
                    {COLOR_PRESETS.map(c => (
                      <button
                        key={c}
                        className={`oa-color-swatch ${newColor === c ? 'oa-color-swatch--active' : ''}`}
                        style={{ backgroundColor: c }}
                        onClick={() => setNewColor(c)}
                        title={c}
                      />
                    ))}
                  </div>
                </div>

                <div className="oa-stage-add-row oa-stage-add-row--checkbox">
                  <label>
                    <input
                      type="checkbox"
                      checked={newTerminal}
                      onChange={e => setNewTerminal(e.target.checked)}
                    />
                    {' '}Terminal stage (prospects here are excluded from AI action generation)
                  </label>
                </div>

                <div className="oa-stage-add-row oa-stage-add-row--actions">
                  <button
                    className="sv-btn-primary"
                    onClick={handleAdd}
                    disabled={submitting || !newName.trim()}
                  >
                    {submitting ? '…' : '+ Add Stage'}
                  </button>
                  <button
                    className="sv-btn-sm"
                    onClick={() => { setAdding(false); setNewName(''); }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="sv-btn-primary"
                style={{ marginTop: 12 }}
                onClick={() => setAdding(true)}
              >
                + Add Custom Stage
              </button>
            )}
          </div>
        </div>

        {/* ── Stage type legend ─────────────────────────────────────────────── */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Stage Type Reference</h3>
            <p className="sv-hint">
              Stage type is an immutable semantic label set when a stage is created.
              It tells the AI and action engine what kind of prospecting activity is
              expected, regardless of what you've named the stage.
            </p>
            <div className="oa-stage-type-grid">
              {STAGE_TYPE_OPTIONS.map(o => (
                <div key={o.value} className="oa-stage-type-card">
                  <span className="oa-stage-type-name">{o.label}</span>
                  <span className="oa-stage-type-desc">{o.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── ProspectStageRow sub-component ───────────────────────────────────────────

function ProspectStageRow({
  stage, isFirst, isLast,
  editId, editName, onEditStart, onEditChange, onEditCommit, onEditCancel,
  onToggle, onMoveUp, onMoveDown, onDelete,
}) {
  const isEditing = editId === stage.id;

  return (
    <div className={`oa-role-row ${!stage.is_active ? 'oa-role-row--inactive' : ''}`}>
      <div className="oa-stage-row__order">
        <button
          className="oa-stage-order-btn"
          onClick={onMoveUp}
          disabled={isFirst}
          title="Move up"
        >▲</button>
        <button
          className="oa-stage-order-btn"
          onClick={onMoveDown}
          disabled={isLast}
          title="Move down"
        >▼</button>
      </div>

      {/* Color dot */}
      {stage.color && (
        <span
          className="oa-stage-color-dot"
          style={{ backgroundColor: stage.color }}
          title={stage.color}
        />
      )}

      <div className="oa-role-row__info" style={{ flex: 1 }}>
        {isEditing ? (
          <input
            className="oa-input oa-input--inline"
            value={editName}
            autoFocus
            onChange={e => onEditChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  onEditCommit();
              if (e.key === 'Escape') onEditCancel();
            }}
            onBlur={onEditCommit}
          />
        ) : (
          <span
            className="oa-role-row__name oa-role-row__name--editable"
            onClick={onEditStart}
            title="Click to rename"
          >
            {stage.name} ✏️
          </span>
        )}

        <span className="oa-stage-type-badge">
          {STAGE_TYPE_LABELS[stage.stage_type] || stage.stage_type}
        </span>

        {stage.is_terminal && (
          <span className="oa-role-row__tag oa-role-row__tag--terminal">Terminal</span>
        )}
        {!stage.is_active && (
          <span className="oa-role-row__tag">Inactive</span>
        )}
        {stage.is_system && (
          <span className="oa-role-row__tag oa-role-row__tag--system">System</span>
        )}
      </div>

      <div className="oa-stage-row__actions">
        <button
          className={`sv-btn-sm ${stage.is_active ? 'sv-btn-sm--danger' : 'sv-btn-sm--primary'}`}
          onClick={onToggle}
        >
          {stage.is_active ? 'Deactivate' : 'Activate'}
        </button>

        {onDelete && (
          <button
            className="sv-btn-sm sv-btn-sm--danger"
            onClick={onDelete}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
