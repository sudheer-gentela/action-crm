import React, { useState, useEffect, useCallback } from 'react';
import SnoozeModal from './SnoozeModal';
import './DealActionsPanel.css';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

const STATUS_LABELS = {
  yet_to_start: { label: 'Yet to Start', color: '#6b7280' },
  in_progress:  { label: 'In Progress',  color: '#3b82f6' },
  completed:    { label: 'Completed',    color: '#10b981' },
  snoozed:      { label: 'Snoozed',      color: '#f59e0b' },
};

const PRIORITY_COLORS = {
  critical: '#dc2626',
  high:     '#ef4444',
  medium:   '#f59e0b',
  low:      '#10b981',
};

const SNOOZE_DURATION_LABELS = {
  '1_week':      '1 week',
  '2_weeks':     '2 weeks',
  '1_month':     '1 month',
  'stage_change':'until stage changes',
  'indefinite':  'indefinitely',
};

// ── Compact action row ────────────────────────────────────────

function DealActionRow({ action, onStatusChange, onSnoozeClick, onUnsnooze, onDelete }) {
  const isSnoozed   = action.status === 'snoozed';
  const isCompleted = action.status === 'completed';
  const pColor      = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  const [expanding, setExpanding] = useState(false);

  return (
    <div className={`dap-action-row ${isSnoozed ? 'dap-action-row--snoozed' : ''} ${isCompleted ? 'dap-action-row--completed' : ''}`}>

      {/* Priority bar */}
      <div className="dap-action-row__priority-bar" style={{ background: pColor }} />

      <div className="dap-action-row__body">
        {/* Title row */}
        <div className="dap-action-row__title-row">
          <span className="dap-action-row__title">{action.title}</span>
          <div className="dap-action-row__badges">
            {isSnoozed && <span className="dap-badge dap-badge--snoozed">😴</span>}
            {action.source === 'ai_generated' && <span className="dap-badge dap-badge--ai">🤖</span>}
            {action.source === 'manual'        && <span className="dap-badge dap-badge--manual">✋</span>}
          </div>
        </div>

        {/* Snooze info */}
        {isSnoozed && (
          <div className="dap-action-row__snooze-info">
            💬 {action.snoozeReason}
            {action.snoozedUntil && (
              <> · until {new Date(action.snoozedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="dap-action-row__actions">
          {!isCompleted && !isSnoozed && (
            <>
              {action.status === 'yet_to_start' && (
                <button
                  className="dap-btn dap-btn--start"
                  onClick={() => onStatusChange(action.id, 'in_progress')}
                >
                  ▶ Start
                </button>
              )}
              {action.status === 'in_progress' && (
                <button
                  className="dap-btn dap-btn--complete"
                  onClick={() => onStatusChange(action.id, 'completed')}
                >
                  ✓ Done
                </button>
              )}
              <button
                className="dap-btn dap-btn--snooze"
                onClick={() => onSnoozeClick(action)}
              >
                😴
              </button>
            </>
          )}
          {isSnoozed && (
            <button
              className="dap-btn dap-btn--unsnooze"
              onClick={() => onUnsnooze(action.id)}
            >
              ↑ Unsnooze
            </button>
          )}
          <button
            className="dap-btn dap-btn--delete"
            onClick={() => onDelete(action.id)}
            title="Delete action"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add action inline form ────────────────────────────────────

function AddActionForm({ dealId, onAdded, onCancel }) {
  const [title,    setTitle]    = useState('');
  const [priority, setPriority] = useState('medium');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  async function handleAdd() {
    if (!title.trim()) { setError('Action title is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const data = await apiFetch('/actions', {
        method: 'POST',
        body: JSON.stringify({ dealId, title: title.trim(), priority, type: 'follow_up', source: 'manual' }),
      });
      onAdded(data.action);
    } catch (err) {
      setError(err.message || 'Failed to add action.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dap-add-form">
      <input
        className="dap-add-form__input"
        placeholder="Action title…"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') onCancel(); }}
        autoFocus
      />
      <select
        className="dap-add-form__priority"
        value={priority}
        onChange={e => setPriority(e.target.value)}
      >
        <option value="critical">🔴 Critical</option>
        <option value="high">🟠 High</option>
        <option value="medium">🟡 Medium</option>
        <option value="low">🟢 Low</option>
      </select>
      {error && <div className="dap-add-form__error">{error}</div>}
      <div className="dap-add-form__btns">
        <button className="dap-btn dap-btn--add-cancel" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="dap-btn dap-btn--add-save"   onClick={handleAdd} disabled={saving || !title.trim()}>
          {saving ? '…' : '+ Add'}
        </button>
      </div>
    </div>
  );
}

// ── Main DealActionsPanel ─────────────────────────────────────

export default function DealActionsPanel({ deal }) {
  const [actions,      setActions]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [generating,   setGenerating]   = useState(false);
  const [error,        setError]        = useState(null);
  const [showSnoozed,  setShowSnoozed]  = useState(false);
  const [showAddForm,  setShowAddForm]  = useState(false);
  const [snoozeAction, setSnoozeAction] = useState(null);

  const fetchActions = useCallback(async () => {
    if (!deal?.id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/actions?dealId=${deal.id}`);
      setActions(data.actions || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  useEffect(() => { fetchActions(); }, [fetchActions]);

  async function handleStatusChange(actionId, newStatus) {
    try {
      await apiFetch(`/actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      setActions(prev => prev.map(a =>
        a.id === actionId ? { ...a, status: newStatus, completed: newStatus === 'completed' } : a
      ));
    } catch (err) {
      alert('Failed to update status: ' + err.message);
    }
  }

  async function handleSnooze(actionId, reason, duration) {
    await apiFetch(`/actions/${actionId}/snooze`, {
      method: 'PATCH',
      body: JSON.stringify({ reason, duration }),
    });
    setActions(prev => prev.map(a =>
      a.id === actionId
        ? { ...a, status: 'snoozed', snoozeReason: reason, snoozeDuration: duration }
        : a
    ));
    setSnoozeAction(null);
  }

  async function handleUnsnooze(actionId) {
    try {
      await apiFetch(`/actions/${actionId}/unsnooze`, { method: 'PATCH' });
      setActions(prev => prev.map(a =>
        a.id === actionId
          ? { ...a, status: 'yet_to_start', snoozedUntil: null, snoozeReason: null, snoozeDuration: null }
          : a
      ));
    } catch (err) {
      alert('Failed to unsnooze: ' + err.message);
    }
  }

  async function handleDelete(actionId) {
    if (!window.confirm('Delete this action?')) return;
    try {
      await apiFetch(`/actions/${actionId}`, { method: 'DELETE' });
      setActions(prev => prev.filter(a => a.id !== actionId));
    } catch (err) {
      alert('Failed to delete action: ' + err.message);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await apiFetch('/actions/generate', {
        method: 'POST',
        body: JSON.stringify({ dealId: deal.id }),
      });
      await fetchActions();
      // Small non-blocking notice
      console.log(`✅ Generated ${result.inserted} new actions for this deal.`);
    } catch (err) {
      alert('Failed to generate actions: ' + err.message);
    } finally {
      setGenerating(false);
    }
  }

  function handleActionAdded(newAction) {
    setActions(prev => [newAction, ...prev]);
    setShowAddForm(false);
  }

  // Partition actions
  const activeActions  = actions.filter(a => a.status !== 'snoozed' && a.status !== 'completed');
  const snoozedActions = actions.filter(a => a.status === 'snoozed');
  const completedCount = actions.filter(a => a.status === 'completed').length;

  if (loading) {
    return (
      <div className="dap-loading">
        <div className="dap-loading-spinner" />
        <span>Loading actions…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dap-error">
        <p>{error}</p>
        <button onClick={fetchActions}>Retry</button>
      </div>
    );
  }

  return (
    <div className="dap-root">

      {/* Section header */}
      <div className="dap-header">
        <div className="dap-header__counts">
          {activeActions.length > 0 && (
            <span className="dap-count dap-count--active">{activeActions.length} active</span>
          )}
          {snoozedActions.length > 0 && (
            <span className="dap-count dap-count--snoozed">{snoozedActions.length} snoozed</span>
          )}
          {completedCount > 0 && (
            <span className="dap-count dap-count--done">{completedCount} done</span>
          )}
        </div>
        <div className="dap-header__btns">
          <button
            className="dap-btn dap-btn--generate"
            onClick={handleGenerate}
            disabled={generating}
            title="Re-run AI generation for this deal. Snoozed actions are preserved."
          >
            {generating ? '⏳' : '⚡'} {generating ? 'Generating…' : 'Regenerate'}
          </button>
          <button
            className="dap-btn dap-btn--add"
            onClick={() => setShowAddForm(v => !v)}
          >
            + Add
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAddForm && (
        <AddActionForm
          dealId={deal.id}
          onAdded={handleActionAdded}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Active actions */}
      {activeActions.length === 0 && !showAddForm && (
        <div className="dap-empty">
          No active actions for this deal.
        </div>
      )}

      {activeActions.map(action => (
        <DealActionRow
          key={action.id}
          action={action}
          onStatusChange={handleStatusChange}
          onSnoozeClick={setSnoozeAction}
          onUnsnooze={handleUnsnooze}
          onDelete={handleDelete}
        />
      ))}

      {/* Snoozed section */}
      {snoozedActions.length > 0 && (
        <div className="dap-snoozed-section">
          <button
            className="dap-snoozed-toggle"
            onClick={() => setShowSnoozed(v => !v)}
          >
            😴 Snoozed ({snoozedActions.length})
            <span className="dap-snoozed-toggle__chevron">{showSnoozed ? '▲' : '▼'}</span>
          </button>
          {showSnoozed && snoozedActions.map(action => (
            <DealActionRow
              key={action.id}
              action={action}
              onStatusChange={handleStatusChange}
              onSnoozeClick={setSnoozeAction}
              onUnsnooze={handleUnsnooze}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Snooze Modal */}
      {snoozeAction && (
        <SnoozeModal
          action={snoozeAction}
          onSnooze={handleSnooze}
          onClose={() => setSnoozeAction(null)}
        />
      )}
    </div>
  );
}
