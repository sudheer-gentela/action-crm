import React, { useState, useEffect, useCallback } from 'react';
import './StrapPanel.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PRI = {
  critical: { color: '#dc2626', bg: '#fef2f2', label: 'Critical' },
  high:     { color: '#ef4444', bg: '#fef2f2', label: 'High' },
  medium:   { color: '#f59e0b', bg: '#fffbeb', label: 'Medium' },
  low:      { color: '#10b981', bg: '#ecfdf5', label: 'Low' },
};

const ELBL = {
  deal: 'Deal', account: 'Account', prospect: 'Prospect', implementation: 'Implementation',
};

// ── Main StrapPanel component ─────────────────────────────────────────────────

function StrapPanel({ entityType, entityId }) {
  const [strap, setStrap]           = useState(null);
  const [hist, setHist]             = useState([]);
  const [loading, setLoading]       = useState(true);
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');
  const [showHist, setShowHist]     = useState(false);
  const [showOvr, setShowOvr]       = useState(false);
  const [expanded, setExpanded]     = useState(true);
  const [editMode, setEditMode]     = useState(false);
  const [editDraft, setEditDraft]   = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Choice modal state
  const [preview, setPreview]       = useState(null); // { hurdle, playbookDraft, aiDraft, aiUnavailable, aiUnavailableReason, effectiveMode }
  const [showModal, setShowModal]   = useState(false);

  const [ovrForm, setOvrForm] = useState({
    hurdleType: '', hurdleTitle: '', priority: 'medium',
    reason: '', situation: '', target: '', response: '', actionPlan: '',
  });

  // ── Load active STRAP ──────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!entityType || !entityId) return;
    try {
      setLoading(true);
      setError('');
      const d = await apiFetch(`/straps/${entityType}/${entityId}`);
      setStrap(d.strap || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  const loadHist = useCallback(async () => {
    if (!entityType || !entityId) return;
    try {
      const d = await apiFetch(`/straps/${entityType}/${entityId}/history`);
      setHist(d.history || []);
    } catch (e) {
      console.error('STRAP history error:', e);
    }
  }, [entityType, entityId]);

  useEffect(() => { load(); }, [load]);

  // ── Preview — fetch both drafts ────────────────────────────────────────────

  const doPreview = async () => {
    try {
      setBusy(true);
      setError('');
      const d = await apiFetch(`/straps/${entityType}/${entityId}/preview`, { method: 'POST' });

      if (!d.hurdle) {
        setError(d.message || 'No hurdle identified — entity appears healthy.');
        return;
      }

      // Single-draft modes: auto-confirm without showing modal
      if (d.effectiveMode === 'playbook' || d.effectiveMode === 'ai') {
        const draft = d.playbookDraft || d.aiDraft;
        await doConfirm({
          chosenSource: d.effectiveMode,
          hurdle: d.hurdle,
          draft,
        });
        return;
      }

      // 'both' or 'playbook_only' (AI unavailable warning) — show modal
      setPreview(d);
      setShowModal(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Confirm — save chosen + edited draft ──────────────────────────────────

  const doConfirm = async ({ chosenSource, hurdle, draft }) => {
    try {
      setBusy(true);
      setError('');
      const d = await apiFetch(`/straps/${entityType}/${entityId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ chosenSource, hurdle, draft }),
      });
      setStrap(d.strap || null);
      setShowModal(false);
      setPreview(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Resolve ────────────────────────────────────────────────────────────────

  const doResolve = async () => {
    if (!strap) return;
    try {
      setBusy(true);
      setError('');
      await apiFetch(`/straps/${strap.id}/resolve`, {
        method: 'PUT',
        body: JSON.stringify({ resolutionType: 'manual', note: 'Resolved by user' }),
      });
      setStrap(null);
      setEditMode(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Reassess ───────────────────────────────────────────────────────────────

  const doReassess = async () => {
    if (!strap) return;
    try {
      setBusy(true);
      setError('');
      // Reassess auto-generates using the configured mode — no choice modal needed
      // because it's a system-triggered regen, not a fresh generation.
      // We use the preview→confirm flow so the user still sees & approves the result.
      const d = await apiFetch(`/straps/${entityType}/${entityId}/preview`, { method: 'POST' });
      if (!d.hurdle) {
        // Resolve the current STRAP if no hurdle found
        await apiFetch(`/straps/${strap.id}/resolve`, {
          method: 'PUT',
          body: JSON.stringify({ resolutionType: 'manual', note: 'Reassessed — no hurdle found' }),
        });
        setStrap(null);
        return;
      }
      setPreview(d);
      setShowModal(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Override ───────────────────────────────────────────────────────────────

  const doOverride = async () => {
    try {
      setBusy(true);
      setError('');
      const d = await apiFetch(`/straps/${entityType}/${entityId}/override`, {
        method: 'POST',
        body: JSON.stringify(ovrForm),
      });
      setStrap(d.strap || null);
      setShowOvr(false);
      setOvrForm({ hurdleType: '', hurdleTitle: '', priority: 'medium', reason: '', situation: '', target: '', response: '', actionPlan: '' });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Inline edit (active STRAP) ─────────────────────────────────────────────

  const startEdit = () => {
    setEditDraft({
      situation:   strap.situation   || '',
      target:      strap.target      || '',
      response:    strap.response    || '',
      action_plan: strap.action_plan || '',
      hurdle_title: strap.hurdle_title || '',
      priority:    strap.priority    || 'medium',
    });
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditDraft(null);
  };

  const saveEdit = async () => {
    try {
      setSavingEdit(true);
      setError('');
      // PATCH /actions/straps/:id — existing route in actions_routes.js
      const d = await apiFetch(`/actions/straps/${strap.id}`, {
        method: 'PATCH',
        body: JSON.stringify(editDraft),
      });
      setStrap(d.strap || strap);
      setEditMode(false);
      setEditDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingEdit(false);
    }
  };

  // ── Toggle history ─────────────────────────────────────────────────────────

  const togHist = () => {
    if (!showHist) loadHist();
    setShowHist(!showHist);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="sp-panel">
        <div className="sp-loading">Loading STRAP…</div>
      </div>
    );
  }

  return (
    <div className="sp-panel">
      {error && <p className="sp-error">{error}</p>}

      {/* Choice modal (shown during preview/reassess) */}
      {showModal && preview && (
        <StrapChoiceModal
          preview={preview}
          busy={busy}
          onConfirm={doConfirm}
          onCancel={() => { setShowModal(false); setPreview(null); }}
        />
      )}

      {/* Empty state */}
      {!strap && !showModal && (
        <div className="sp-empty">
          <p className="sp-empty-text">
            No active STRAP for this {ELBL[entityType] || entityType}.
          </p>
          <div className="sp-empty-actions">
            <button className="sp-btn sp-btn--primary" onClick={doPreview} disabled={busy}>
              {busy ? 'Analysing…' : 'Generate STRAP'}
            </button>
            <button className="sp-btn sp-btn--secondary" onClick={() => setShowOvr(true)}>
              Manual Override
            </button>
            <button className="sp-btn sp-btn--ghost" onClick={togHist}>History</button>
          </div>
          {showOvr && (
            <OvrForm f={ovrForm} set={setOvrForm} save={doOverride} cancel={() => setShowOvr(false)} busy={busy} />
          )}
          {showHist && <Hist items={hist} />}
        </div>
      )}

      {/* Active STRAP */}
      {strap && !showModal && (
        <>
          <div className="sp-header" onClick={() => !editMode && setExpanded(!expanded)}>
            <div className="sp-header-left">
              <span
                className="sp-priority-badge"
                style={{ background: (PRI[strap.priority] || PRI.medium).bg, color: (PRI[strap.priority] || PRI.medium).color }}
              >
                {(PRI[strap.priority] || PRI.medium).label}
              </span>
              {editMode
                ? <input
                    className="sp-edit-title-input"
                    value={editDraft.hurdle_title}
                    onChange={e => setEditDraft(p => ({ ...p, hurdle_title: e.target.value }))}
                    onClick={e => e.stopPropagation()}
                  />
                : <span className="sp-hurdle-title">{strap.hurdle_title}</span>
              }
              {strap.source === 'manual' && <span className="sp-manual-badge">Manual</span>}
            </div>
            {!editMode && (
              <span className="sp-expand-icon">{expanded ? '▲' : '▼'}</span>
            )}
          </div>

          {expanded && (
            <div className="sp-body">
              {editMode ? (
                // Inline edit form
                <div className="sp-edit-form">
                  <EditField label="S — Situation" value={editDraft.situation}
                    onChange={v => setEditDraft(p => ({ ...p, situation: v }))} rows={3} />
                  <EditField label="T — Target" value={editDraft.target}
                    onChange={v => setEditDraft(p => ({ ...p, target: v }))} rows={2} />
                  <EditField label="R — Response" value={editDraft.response}
                    onChange={v => setEditDraft(p => ({ ...p, response: v }))} rows={3} />
                  <EditField label="A — Action Plan" value={editDraft.action_plan}
                    onChange={v => setEditDraft(p => ({ ...p, action_plan: v }))} rows={6}
                    hint="Editing the action plan will regenerate all linked actions." />
                  <div className="sp-edit-priority">
                    <label>Priority</label>
                    <select value={editDraft.priority} onChange={e => setEditDraft(p => ({ ...p, priority: e.target.value }))}>
                      {['critical','high','medium','low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}
                    </select>
                  </div>
                  <div className="sp-edit-actions">
                    <button className="sp-btn sp-btn--primary" onClick={saveEdit} disabled={savingEdit}>
                      {savingEdit ? 'Saving…' : '💾 Save Changes'}
                    </button>
                    <button className="sp-btn sp-btn--ghost" onClick={cancelEdit} disabled={savingEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                // Read-only view
                <>
                  {strap.situation   && <Sec icon="S" label="Situation"    text={strap.situation} />}
                  {strap.target      && <Sec icon="T" label="Target"       text={strap.target} />}
                  {strap.response    && <Sec icon="R" label="Response"     text={strap.response} />}
                  {strap.action_plan && <Sec icon="A" label="Action Plan"  text={strap.action_plan} pre />}

                  <div className="sp-meta">
                    <span>{strap.hurdle_type.replace(/_/g, ' ')}</span>
                    <span>{new Date(strap.created_at).toLocaleDateString()}</span>
                    {strap.ai_model && <span>AI: {strap.ai_model}</span>}
                  </div>

                  <div className="sp-actions">
                    <button className="sp-btn sp-btn--success" onClick={doResolve} disabled={busy}>
                      Resolve
                    </button>
                    <button className="sp-btn sp-btn--secondary" onClick={doReassess} disabled={busy}>
                      {busy ? 'Working…' : 'Reassess'}
                    </button>
                    <button className="sp-btn sp-btn--edit" onClick={startEdit}>
                      ✏ Edit
                    </button>
                    <button className="sp-btn sp-btn--ghost" onClick={() => setShowOvr(true)}>
                      Override
                    </button>
                    <button className="sp-btn sp-btn--ghost" onClick={togHist}>
                      History
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {showOvr && (
            <OvrForm f={ovrForm} set={setOvrForm} save={doOverride} cancel={() => setShowOvr(false)} busy={busy} />
          )}
          {showHist && <Hist items={hist} />}
        </>
      )}
    </div>
  );
}

// ── StrapChoiceModal ──────────────────────────────────────────────────────────

function StrapChoiceModal({ preview, busy, onConfirm, onCancel }) {
  const { hurdle, playbookDraft, aiDraft, aiUnavailable, aiUnavailableReason, effectiveMode } = preview;

  const [selected, setSelected]     = useState(null); // 'playbook' | 'ai'
  const [editedDraft, setEditedDraft] = useState(null);
  const [confirming, setConfirming]  = useState(false);

  const selectCard = (source) => {
    const draft = source === 'playbook' ? playbookDraft : aiDraft;
    setSelected(source);
    setEditedDraft({
      situation:   draft.situation   || '',
      target:      draft.target      || '',
      response:    draft.response    || '',
      actionPlan:  draft.actionPlan  || '',
    });
  };

  const handleConfirm = async () => {
    if (!selected || !editedDraft) return;
    setConfirming(true);
    try {
      await onConfirm({
        chosenSource: selected,
        hurdle: {
          hurdleType: hurdle.hurdleType,
          title:      hurdle.title,
          priority:   hurdle.priority,
        },
        draft: editedDraft,
      });
    } finally {
      setConfirming(false);
    }
  };

  const pc = PRI[hurdle.priority] || PRI.medium;
  const showBothCards = effectiveMode === 'both' && aiDraft;
  const showOneCard   = !showBothCards;

  return (
    <div className="sp-modal-overlay">
      <div className="sp-modal">

        {/* Header */}
        <div className="sp-modal-header">
          <div className="sp-modal-title">
            <span className="sp-priority-badge" style={{ background: pc.bg, color: pc.color }}>
              {pc.label}
            </span>
            <span className="sp-modal-hurdle">{hurdle.title}</span>
          </div>
          <p className="sp-modal-subtitle">
            {showBothCards
              ? 'Two STRAP strategies have been generated. Select one to edit and confirm.'
              : 'Review the generated STRAP, edit if needed, then confirm.'}
          </p>
        </div>

        {/* AI unavailable warning */}
        {aiUnavailable && aiUnavailableReason && (
          <div className="sp-modal-warning">
            ⚠️ {aiUnavailableReason}
          </div>
        )}

        {/* Cards */}
        <div className={`sp-modal-cards ${showBothCards ? 'sp-modal-cards--two' : 'sp-modal-cards--one'}`}>

          {playbookDraft && (
            <StrapDraftCard
              source="playbook"
              label="📘 Playbook"
              draft={playbookDraft}
              selected={selected === 'playbook'}
              editedDraft={selected === 'playbook' ? editedDraft : null}
              onSelect={() => selectCard('playbook')}
              onEdit={setEditedDraft}
            />
          )}

          {aiDraft && (
            <StrapDraftCard
              source="ai"
              label="🤖 AI Generated"
              draft={aiDraft}
              selected={selected === 'ai'}
              editedDraft={selected === 'ai' ? editedDraft : null}
              onSelect={() => selectCard('ai')}
              onEdit={setEditedDraft}
            />
          )}
        </div>

        {/* Footer */}
        <div className="sp-modal-footer">
          <button
            className="sp-btn sp-btn--primary sp-btn--lg"
            onClick={handleConfirm}
            disabled={!selected || confirming || busy}
          >
            {confirming || busy ? 'Saving…' : '✓ Confirm & Save STRAP'}
          </button>
          <button className="sp-btn sp-btn--ghost" onClick={onCancel} disabled={confirming || busy}>
            Cancel
          </button>
          {!selected && (
            <span className="sp-modal-hint">← Select a STRAP to continue</span>
          )}
        </div>

      </div>
    </div>
  );
}

// ── StrapDraftCard ────────────────────────────────────────────────────────────

function StrapDraftCard({ source, label, draft, selected, editedDraft, onSelect, onEdit }) {
  const isEditing = selected && editedDraft;

  return (
    <div
      className={`sp-draft-card ${selected ? 'sp-draft-card--selected' : ''}`}
      onClick={!selected ? onSelect : undefined}
    >
      <div className="sp-draft-card-header">
        <span className="sp-draft-card-label">{label}</span>
        {!selected && (
          <button className="sp-btn sp-btn--select" onClick={(e) => { e.stopPropagation(); onSelect(); }}>
            Select this STRAP
          </button>
        )}
        {selected && (
          <span className="sp-draft-card-selected-badge">✓ Selected — edit below</span>
        )}
      </div>

      {isEditing ? (
        // Editable fields
        <div className="sp-draft-edit">
          <EditField label="S — Situation" value={editedDraft.situation}
            onChange={v => onEdit(p => ({ ...p, situation: v }))} rows={3} />
          <EditField label="T — Target" value={editedDraft.target}
            onChange={v => onEdit(p => ({ ...p, target: v }))} rows={2} />
          <EditField label="R — Response" value={editedDraft.response}
            onChange={v => onEdit(p => ({ ...p, response: v }))} rows={3} />
          <EditField label="A — Action Plan" value={editedDraft.actionPlan}
            onChange={v => onEdit(p => ({ ...p, actionPlan: v }))} rows={6}
            hint="Actions will be generated from these numbered steps." />
        </div>
      ) : (
        // Read-only preview
        <div className="sp-draft-preview">
          <DraftSec icon="S" label="Situation" text={draft.situation} />
          <DraftSec icon="T" label="Target"    text={draft.target} />
          <DraftSec icon="R" label="Response"  text={draft.response} />
          <DraftSec icon="A" label="Action Plan" text={draft.actionPlan} pre />
        </div>
      )}
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Sec({ icon, label, text, pre }) {
  return (
    <div className="sp-section">
      <div className="sp-section-label">
        <span className="sp-section-icon">{icon}</span> {label}
      </div>
      <div className={`sp-section-content${pre ? ' sp-pre' : ''}`}>{text}</div>
    </div>
  );
}

function DraftSec({ icon, label, text, pre }) {
  if (!text) return null;
  return (
    <div className="sp-draft-sec">
      <div className="sp-draft-sec-label"><span>{icon}</span> {label}</div>
      <div className={`sp-draft-sec-content${pre ? ' sp-pre' : ''}`}>{text}</div>
    </div>
  );
}

function EditField({ label, value, onChange, rows = 3, hint }) {
  return (
    <div className="sp-edit-field">
      <label className="sp-edit-field-label">{label}</label>
      <textarea
        className="sp-edit-field-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
      />
      {hint && <p className="sp-edit-field-hint">{hint}</p>}
    </div>
  );
}

function OvrForm({ f, set, save, cancel, busy }) {
  const u = (k, v) => set(p => ({ ...p, [k]: v }));
  return (
    <div className="sp-override-form">
      <h4 className="sp-override-title">Manual Override</h4>
      <div className="sp-form-grid">
        <div className="sp-form-group">
          <label>Hurdle Type</label>
          <input value={f.hurdleType} onChange={e => u('hurdleType', e.target.value)} placeholder="e.g. buyer_engagement" />
        </div>
        <div className="sp-form-group">
          <label>Hurdle Title</label>
          <input value={f.hurdleTitle} onChange={e => u('hurdleTitle', e.target.value)} placeholder="e.g. Key stakeholder unresponsive" />
        </div>
        <div className="sp-form-group">
          <label>Priority</label>
          <select value={f.priority} onChange={e => u('priority', e.target.value)}>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="sp-form-group sp-form-full">
          <label>Reason</label>
          <input value={f.reason} onChange={e => u('reason', e.target.value)} placeholder="Why override?" />
        </div>
        <div className="sp-form-group sp-form-full">
          <label>Situation</label>
          <textarea value={f.situation} onChange={e => u('situation', e.target.value)} rows={2} />
        </div>
        <div className="sp-form-group sp-form-full">
          <label>Target</label>
          <input value={f.target} onChange={e => u('target', e.target.value)} />
        </div>
        <div className="sp-form-group sp-form-full">
          <label>Response</label>
          <textarea value={f.response} onChange={e => u('response', e.target.value)} rows={2} />
        </div>
        <div className="sp-form-group sp-form-full">
          <label>Action Plan</label>
          <textarea value={f.actionPlan} onChange={e => u('actionPlan', e.target.value)} rows={4} placeholder="1. First step&#10;2. Second step…" />
        </div>
      </div>
      <div className="sp-override-actions">
        <button className="sp-btn sp-btn--primary" onClick={save} disabled={!f.hurdleType || !f.hurdleTitle || busy}>
          {busy ? 'Saving…' : 'Save Override'}
        </button>
        <button className="sp-btn sp-btn--ghost" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}

function Hist({ items }) {
  if (!items.length) {
    return <div className="sp-history"><p className="sp-history-empty">No STRAP history.</p></div>;
  }
  return (
    <div className="sp-history">
      <h4 className="sp-history-title">STRAP History</h4>
      {items.map(h => {
        const hpc = PRI[h.priority] || PRI.medium;
        return (
          <div key={h.id} className={`sp-history-item sp-history--${h.status}`}>
            <div className="sp-history-header">
              <span className="sp-priority-badge-sm" style={{ background: hpc.bg, color: hpc.color }}>
                {hpc.label}
              </span>
              <span className="sp-history-hurdle">{h.hurdle_title}</span>
              <span className={`sp-status-badge sp-status--${h.status}`}>{h.status}</span>
            </div>
            <div className="sp-history-meta">
              <span>{new Date(h.created_at).toLocaleDateString()}</span>
              {h.resolved_at && (
                <span> → {new Date(h.resolved_at).toLocaleDateString()} ({h.resolution_type})</span>
              )}
              {h.source === 'manual' && <span className="sp-manual-badge-sm">manual</span>}
            </div>
            {h.resolution_note && <div className="sp-history-note">{h.resolution_note}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default StrapPanel;
