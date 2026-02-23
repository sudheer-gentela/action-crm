// ─────────────────────────────────────────────────────────────────────────────
// OADealStages.js
//
// Add this component to OrgAdminView.js:
//   1. Import at top: import OADealStages from './OADealStages';
//   2. Add tab to ORG_ADMIN_TABS array (see instructions below)
//   3. Add render line in settings-body (see instructions below)
//
// INTEGRATION INSTRUCTIONS FOR OrgAdminView.js:
//
// Step 1 — Add to ORG_ADMIN_TABS (after 'deal-roles'):
//   { id: 'deal-stages', label: 'Deal Stages', icon: '🏷️' },
//
// Step 2 — Add to settings-body render block (after deal-roles line):
//   {tab === 'deal-stages' && <OADealStages />}
//
// Step 3 — Add import at top of OrgAdminView.js:
//   import OADealStages from './OADealStages';
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.REACT_APP_API_URL || '';

// ── Shared fetch helper (same pattern as OADealRoles in OrgAdminView.js) ──────
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

// ── Stage type options shown in the "Add stage" form ─────────────────────────
const STAGE_TYPE_OPTIONS = [
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

const STAGE_TYPE_LABELS = Object.fromEntries(STAGE_TYPE_OPTIONS.map(o => [o.value, o.label]));

export default function OADealStages() {
  const [stages,   setStages]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  // Add form state
  const [adding,      setAdding]      = useState(false);
  const [newName,     setNewName]     = useState('');
  const [newType,     setNewType]     = useState('custom');
  const [newTerminal, setNewTerminal] = useState(false);
  const [submitting,  setSubmitting]  = useState(false);

  // Inline rename state
  const [editId,   setEditId]   = useState(null);
  const [editName, setEditName] = useState('');

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiFetch('/api/deal-stages');
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
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order);
    const idx    = sorted.findIndex(s => s.id === stage.id);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const order = sorted.map((s, i) => {
      if (i === idx)     return { id: s.id, sort_order: sorted[swapIdx].sort_order };
      if (i === swapIdx) return { id: s.id, sort_order: sorted[idx].sort_order };
      return { id: s.id, sort_order: s.sort_order };
    });

    try {
      const r = await apiFetch('/api/deal-stages/reorder', {
        method: 'POST',
        body:   JSON.stringify({ order }),
      });
      setStages(r.stages || []);
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Toggle active ────────────────────────────────────────────────────────────
  async function handleToggle(stage) {
    try {
      const r = await apiFetch(`/api/deal-stages/${stage.id}`, {
        method: 'PATCH',
        body:   JSON.stringify({ is_active: !stage.is_active }),
      });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      flash('success', `"${stage.name}" ${r.stage.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Rename ───────────────────────────────────────────────────────────────────
  async function handleRename(stage) {
    if (!editName.trim() || editName.trim() === stage.name) {
      setEditId(null);
      return;
    }
    try {
      const r = await apiFetch(`/api/deal-stages/${stage.id}`, {
        method: 'PATCH',
        body:   JSON.stringify({ name: editName.trim() }),
      });
      setStages(prev => prev.map(s => s.id === stage.id ? r.stage : s));
      setEditId(null);
      flash('success', 'Stage renamed');
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async function handleDelete(stage) {
    if (!window.confirm(`Delete stage "${stage.name}"?\n\nThis cannot be undone. Deals in this stage must be moved first.`)) return;
    try {
      await apiFetch(`/api/deal-stages/${stage.id}`, { method: 'DELETE' });
      setStages(prev => prev.filter(s => s.id !== stage.id));
      flash('success', `"${stage.name}" deleted`);
    } catch (e) {
      flash('error', e.message);
    }
  }

  // ── Add new stage ────────────────────────────────────────────────────────────
  async function handleAdd() {
    if (!newName.trim()) return;
    setSubmitting(true);
    try {
      const r = await apiFetch('/api/deal-stages', {
        method: 'POST',
        body:   JSON.stringify({
          name:        newName.trim(),
          stage_type:  newType,
          is_terminal: newTerminal,
        }),
      });
      setStages(prev => [...prev, r.stage]);
      setNewName('');
      setNewType('custom');
      setNewTerminal(false);
      setAdding(false);
      flash('success', `"${r.stage.name}" created`);
    } catch (e) {
      flash('error', e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="sv-loading">Loading stages…</div>;

  const sorted       = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const systemStages = sorted.filter(s => s.is_system);
  const customStages = sorted.filter(s => !s.is_system);

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🏷️ Deal Stages</h2>
          <p className="sv-panel-desc">
            Configure the stages in your sales pipeline. System stages can be renamed or
            deactivated. Custom stages can be fully managed. Stage type controls how the
            AI and rules engine understand each stage.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <div className="sv-panel-body">

        {/* ── System stages ──────────────────────────────────────────────────── */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Default Stages</h3>
            <p className="sv-hint">
              Built-in stages seeded from your default playbook. Can be renamed and
              reordered. Deactivate to hide from the pipeline. Cannot be deleted.
            </p>

            <div className="oa-roles-list">
              {systemStages.map((stage, idx) => (
                <StageRow
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
                  onDelete={null}  // system stages: no delete
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── Custom stages ───────────────────────────────────────────────────── */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Custom Stages</h3>
            <p className="sv-hint">
              Stages specific to your organisation's process. Click a name to rename.
              Custom stages cannot be deleted if deals are currently in that stage.
            </p>

            {customStages.length === 0 && !adding && (
              <p className="sv-empty">No custom stages yet.</p>
            )}

            <div className="oa-roles-list">
              {customStages.map((stage, idx) => (
                <StageRow
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
                    placeholder="Stage name (e.g. Legal Review)…"
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

                <div className="oa-stage-add-row oa-stage-add-row--checkbox">
                  <label>
                    <input
                      type="checkbox"
                      checked={newTerminal}
                      onChange={e => setNewTerminal(e.target.checked)}
                    />
                    {' '}Terminal stage (deals here are excluded from AI action generation)
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

        {/* ── Stage type legend ────────────────────────────────────────────────── */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Stage Type Reference</h3>
            <p className="sv-hint">
              Stage type is an immutable semantic label set when a stage is created.
              It tells the AI and rules engine what kind of sales activity is expected,
              regardless of what you've named the stage.
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

// ── StageRow sub-component ────────────────────────────────────────────────────

function StageRow({
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
