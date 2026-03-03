import React, { useState, useEffect, useCallback } from 'react';
import './DealStrapPanel.css';

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

const HURDLE_ICONS = {
  close_date:        '📅',
  buyer_engagement:  '👤',
  process:           '⚙️',
  deal_size:         '💰',
  competitive:       '⚔️',
  momentum:          '🔄',
  contact_coverage:  '👥',
  stage_progression: '📋',
};

const HURDLE_TYPE_OPTIONS = [
  { value: 'close_date',        label: '📅 Close Date' },
  { value: 'buyer_engagement',  label: '👤 Buyer Engagement' },
  { value: 'competitive',       label: '⚔️ Competitive' },
  { value: 'momentum',          label: '🔄 Momentum' },
  { value: 'contact_coverage',  label: '👥 Contact Coverage' },
  { value: 'process',           label: '⚙️ Process' },
  { value: 'deal_size',         label: '💰 Deal Size' },
  { value: 'stage_progression', label: '📋 Stage Progression' },
];

const STATUS_ICONS = {
  yet_to_start: '○',
  in_progress:  '◑',
  completed:    '●',
  snoozed:      '😴',
};

function formatDueDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const diffDays = Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0)  return { text: `${Math.abs(diffDays)}d overdue`, overdue: true };
  if (diffDays === 0) return { text: 'Due today',    today: true };
  if (diffDays === 1) return { text: 'Due tomorrow' };
  return { text: `Due ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` };
}

// ── Sequenced action row ──────────────────────────────────────

function StrapActionRow({ action, onStatusChange }) {
  const isCompleted = action.action_status === 'completed' || action.completed;
  const dueInfo = formatDueDate(action.due_date);
  const statusIcon = STATUS_ICONS[action.action_status] || '○';

  return (
    <div className={`dsp-action-row ${isCompleted ? 'dsp-action-row--completed' : ''}`}>
      <div className="dsp-action-row__seq">
        {action.is_gate && <span className="dsp-gate-icon" title="Gate — complete before proceeding">🔒</span>}
        <span className="dsp-action-row__num">{action.sequence}</span>
      </div>
      <div className="dsp-action-row__body">
        <div className="dsp-action-row__title-row">
          <span className="dsp-action-row__status-icon">{statusIcon}</span>
          <span className={`dsp-action-row__title ${isCompleted ? 'dsp-action-row__title--done' : ''}`}>
            {action.action_title || action.title}
          </span>
          {action.next_step && (
            <span className="dsp-action-row__channel">{action.next_step}</span>
          )}
        </div>
        {action.suggested_action && !isCompleted && (
          <div className="dsp-action-row__suggestion">💡 {action.suggested_action}</div>
        )}
        {action.success_signal && !isCompleted && (
          <div className="dsp-action-row__signal">✅ Success signal: {action.success_signal}</div>
        )}
        <div className="dsp-action-row__meta">
          {dueInfo && !isCompleted && (
            <span className={`dsp-action-row__due ${dueInfo.overdue ? 'dsp-action-row__due--overdue' : dueInfo.today ? 'dsp-action-row__due--today' : ''}`}>
              🗓 {dueInfo.text}
            </span>
          )}
          {!isCompleted && action.action_status === 'yet_to_start' && (
            <button className="dsp-btn dsp-btn--start" onClick={() => onStatusChange(action.action_id, 'in_progress')}>▶ Start</button>
          )}
          {!isCompleted && action.action_status === 'in_progress' && (
            <button className="dsp-btn dsp-btn--complete" onClick={() => onStatusChange(action.action_id, 'completed')}>✓ Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Override form ─────────────────────────────────────────────

function OverrideForm({ dealId, onCreated, onCancel }) {
  const [hurdleType,  setHurdleType]  = useState('');
  const [hurdleTitle, setHurdleTitle] = useState('');
  const [reason,      setReason]      = useState('');
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState('');

  async function handleSubmit() {
    if (!hurdleType || !hurdleTitle.trim()) {
      setError('Hurdle type and title are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data = await apiFetch(`/straps/deal/${dealId}/override`, {
        method: 'POST',
        body: JSON.stringify({ hurdleType, hurdleTitle: hurdleTitle.trim(), reason: reason.trim() || null }),
      });
      onCreated(data);
    } catch (err) {
      setError(err.message || 'Failed to create override STRAP.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dsp-override-form">
      <div style={{ fontSize: 13, fontWeight: 600, color: '#2d3748', marginBottom: 8 }}>
        ✏️ Override: Choose Your Own Hurdle
      </div>
      <select
        className="dsp-override-form__select"
        value={hurdleType}
        onChange={e => setHurdleType(e.target.value)}
      >
        <option value="">Select hurdle type…</option>
        {HURDLE_TYPE_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <input
        className="dsp-override-form__input"
        placeholder="Describe the hurdle (e.g. 'Need to reach the CFO before Q2 budget lock')"
        value={hurdleTitle}
        onChange={e => setHurdleTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onCancel(); }}
      />
      <textarea
        className="dsp-override-form__textarea"
        placeholder="Why are you overriding the auto recommendation? (optional but helps track effectiveness)"
        value={reason}
        onChange={e => setReason(e.target.value)}
        rows={2}
      />
      {error && <div className="dsp-error">{error}</div>}
      <div className="dsp-override-form__btns">
        <button className="dsp-btn dsp-btn--cancel" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="dsp-btn dsp-btn--generate" onClick={handleSubmit} disabled={saving || !hurdleType || !hurdleTitle.trim()}>
          {saving ? '⏳ Creating…' : '🎯 Create Override STRAP'}
        </button>
      </div>
    </div>
  );
}

// ── History item ──────────────────────────────────────────────

function StrapHistoryItem({ strap }) {
  const [expanded, setExpanded] = useState(false);
  const icon = HURDLE_ICONS[strap.hurdle_type] || '🎯';
  const statusColor = strap.status === 'successful' ? '#059669'
    : strap.status === 'unsuccessful' ? '#dc2626' : '#6b7280';

  return (
    <div className="dsp-history-item">
      <div className="dsp-history-item__header" onClick={() => setExpanded(v => !v)}>
        <span className="dsp-history-item__icon">{icon}</span>
        <div className="dsp-history-item__info">
          <span className="dsp-history-item__title">
            {strap.hurdle_title}
            {strap.source === 'manual' && <span className="dsp-badge dsp-badge--manual">✋ override</span>}
          </span>
          <div className="dsp-history-item__meta">
            <span style={{ color: statusColor, fontWeight: 600 }}>{strap.status}</span>
            {strap.creator_first_name && <span> · by {strap.creator_first_name} {strap.creator_last_name}</span>}
            {strap.resolved_at && <span> · {new Date(strap.resolved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
          </div>
        </div>
        <span className="dsp-history-item__chevron">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="dsp-history-item__body">
          {strap.strategy && <div className="dsp-history-item__field"><strong>Strategy:</strong> {strap.strategy}</div>}
          {strap.outcome && <div className="dsp-history-item__field"><strong>Outcome:</strong> {strap.outcome}</div>}
          {strap.source === 'manual' && strap.override_reason && (
            <div className="dsp-history-item__field"><strong>Override reason:</strong> {strap.override_reason}</div>
          )}
          {strap.source === 'manual' && strap.auto_hurdle_title && (
            <div className="dsp-history-item__field" style={{ color: '#a0aec0', fontStyle: 'italic' }}>
              🤖 System would have recommended: {strap.auto_hurdle_title}
            </div>
          )}
          {strap.actions?.length > 0 && (
            <div className="dsp-history-item__actions">
              {strap.actions.map((a, i) => (
                <div key={i} className="dsp-history-item__action">
                  <span>{a.completed ? '●' : '○'}</span>
                  <span>{a.action_title}</span>
                  <span style={{ color: a.completed ? '#059669' : '#9ca3af' }}>{a.action_status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main DealStrapPanel ───────────────────────────────────────

export default function DealStrapPanel({ deal }) {
  const [strap,          setStrap]          = useState(null);
  const [history,        setHistory]        = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [generating,     setGenerating]     = useState(false);
  const [resolving,      setResolving]      = useState(false);
  const [error,          setError]          = useState(null);
  const [showHistory,    setShowHistory]    = useState(false);
  const [showOverride,   setShowOverride]   = useState(false);

  const fetchStrap = useCallback(async () => {
    if (!deal?.id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch(`/straps/deal/${deal.id}`);
      setStrap(data.strap || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [deal?.id]);

  const fetchHistory = useCallback(async () => {
    if (!deal?.id) return;
    try {
      const data = await apiFetch(`/straps/deal/${deal.id}/history`);
      setHistory(data.straps || []);
    } catch { /* silent */ }
  }, [deal?.id]);

  useEffect(() => { fetchStrap(); }, [fetchStrap]);
  useEffect(() => { if (showHistory) fetchHistory(); }, [showHistory, fetchHistory]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      await apiFetch(`/straps/deal/${deal.id}/generate`, {
        method: 'POST',
        body: JSON.stringify({ useAI: true }),
      });
      await fetchStrap();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleOverrideCreated() {
    setShowOverride(false);
    await fetchStrap();
  }

  async function handleResolve(status) {
    setResolving(true);
    try {
      const outcome = status === 'successful'
        ? 'Hurdle resolved — moving to next challenge'
        : 'Strategy did not resolve the hurdle';
      const data = await apiFetch(`/straps/${strap.id}/resolve`, {
        method: 'PUT',
        body: JSON.stringify({ status, outcome, autoNext: true }),
      });
      if (data.nextStrap) {
        await fetchStrap();
      } else {
        setStrap(null);
      }
    } catch (err) {
      alert('Failed to resolve STRAP: ' + err.message);
    } finally {
      setResolving(false);
    }
  }

  async function handleReassess() {
    setResolving(true);
    try {
      await apiFetch(`/straps/${strap.id}/reassess`, { method: 'PUT' });
      await fetchStrap();
    } catch (err) {
      alert('Failed to reassess: ' + err.message);
    } finally {
      setResolving(false);
    }
  }

  async function handleActionStatusChange(actionId, newStatus) {
    try {
      await apiFetch(`/actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      await fetchStrap();
    } catch (err) {
      alert('Failed to update action: ' + err.message);
    }
  }

  if (loading) {
    return (
      <div className="dsp-loading">
        <div className="dsp-loading-spinner" />
        <span>Loading STRAP…</span>
      </div>
    );
  }

  // ── No active STRAP ─────────────────────────────────────────

  if (!strap) {
    return (
      <div className="dsp-root">
        <div className="dsp-empty">
          <div className="dsp-empty__icon">🎯</div>
          <div className="dsp-empty__text">No active STRAP for this deal.</div>
          <div className="dsp-empty__sub">Generate a STRAP to identify the biggest hurdle and build a focused action plan.</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="dsp-btn dsp-btn--generate" onClick={handleGenerate} disabled={generating}>
              {generating ? '⏳ Analyzing deal…' : '🎯 Auto Generate STRAP'}
            </button>
            <button className="dsp-btn dsp-btn--override-trigger" onClick={() => setShowOverride(v => !v)}>
              ✏️ I Know the Hurdle
            </button>
          </div>
          {error && <div className="dsp-error">{error}</div>}
        </div>

        {showOverride && (
          <OverrideForm
            dealId={deal.id}
            onCreated={handleOverrideCreated}
            onCancel={() => setShowOverride(false)}
          />
        )}

        <HistorySection dealId={deal?.id} history={history} showHistory={showHistory} setShowHistory={setShowHistory} />
      </div>
    );
  }

  // ── Active STRAP ────────────────────────────────────────────

  const hurdleIcon     = HURDLE_ICONS[strap.hurdle_type] || '🎯';
  const actions        = strap.actions || [];
  const completedCount = actions.filter(a => a.completed || a.action_status === 'completed').length;
  const totalActions   = actions.length;
  const progress       = totalActions > 0 ? Math.round((completedCount / totalActions) * 100) : 0;

  return (
    <div className="dsp-root">
      {/* Hurdle card */}
      <div className="dsp-hurdle-card">
        <div className="dsp-hurdle-card__header">
          <div className="dsp-hurdle-card__icon">{hurdleIcon}</div>
          <div className="dsp-hurdle-card__info">
            <div className="dsp-hurdle-card__label">
              Current Hurdle
              {strap.source === 'manual' && (
                <span className="dsp-badge dsp-badge--manual" style={{ marginLeft: 6 }}>
                  ✋ Override by {strap.override_first_name || 'user'}
                </span>
              )}
              {strap.source === 'auto' && (
                <span className="dsp-badge dsp-badge--auto" style={{ marginLeft: 6 }}>🤖 Auto</span>
              )}
            </div>
            <div className="dsp-hurdle-card__title">{strap.hurdle_title}</div>
          </div>
          <div className="dsp-hurdle-card__type" style={{
            background: '#ebf4ff', color: '#2b6cb0'
          }}>
            {strap.hurdle_type.replace(/_/g, ' ')}
          </div>
        </div>

        {/* Manual override context */}
        {strap.source === 'manual' && strap.auto_hurdle_title && (
          <div style={{ fontSize: 11, color: '#a0aec0', padding: '4px 8px', background: '#f7fafc', borderRadius: 4, marginBottom: 8 }}>
            🤖 System recommended: "{strap.auto_hurdle_title}" — overridden{strap.override_reason ? `: ${strap.override_reason}` : ''}
          </div>
        )}

        {strap.strategy && (
          <div className="dsp-hurdle-card__strategy"><strong>Strategy:</strong> {strap.strategy}</div>
        )}
        {strap.strategy_hypothesis && (
          <div className="dsp-hurdle-card__hypothesis"><strong>Hypothesis:</strong> {strap.strategy_hypothesis}</div>
        )}

        <div className="dsp-hurdle-card__progress">
          <div className="dsp-progress-bar">
            <div className="dsp-progress-bar__fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="dsp-progress-bar__label">{completedCount}/{totalActions} actions</span>
        </div>

        {/* Creator info */}
        {strap.creator_first_name && (
          <div style={{ fontSize: 11, color: '#a0aec0', marginTop: 6 }}>
            Created by {strap.creator_first_name} {strap.creator_last_name} · {new Date(strap.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </div>
        )}
      </div>

      {/* Sequenced actions */}
      <div className="dsp-actions-list">
        {actions.map((action, idx) => (
          <StrapActionRow key={action.action_id || idx} action={action} onStatusChange={handleActionStatusChange} />
        ))}
      </div>

      {/* Resolve controls */}
      <div className="dsp-resolve-controls">
        <button className="dsp-btn dsp-btn--success" onClick={() => handleResolve('successful')} disabled={resolving}>
          ✅ Hurdle Resolved
        </button>
        <button className="dsp-btn dsp-btn--fail" onClick={() => handleResolve('unsuccessful')} disabled={resolving}>
          ❌ Didn't Work
        </button>
        <button className="dsp-btn dsp-btn--reassess" onClick={handleReassess} disabled={resolving}>
          ♻️ Reassess
        </button>
        <button className="dsp-btn dsp-btn--regenerate" onClick={handleGenerate} disabled={generating}>
          {generating ? '⏳' : '🔄'} Regenerate
        </button>
      </div>

      {error && <div className="dsp-error">{error}</div>}

      <HistorySection dealId={deal?.id} history={history} showHistory={showHistory} setShowHistory={setShowHistory} />
    </div>
  );
}

function HistorySection({ dealId, history, showHistory, setShowHistory }) {
  if (!dealId) return null;
  const pastStraps = history.filter(s => s.status !== 'active');

  return (
    <div className="dsp-history-section">
      <button className="dsp-history-toggle" onClick={() => setShowHistory(v => !v)}>
        📜 STRAP History {pastStraps.length > 0 && `(${pastStraps.length})`}
        <span className="dsp-history-toggle__chevron">{showHistory ? '▲' : '▼'}</span>
      </button>
      {showHistory && pastStraps.length === 0 && (
        <div className="dsp-history-empty">No past STRAPs for this deal.</div>
      )}
      {showHistory && pastStraps.map(s => <StrapHistoryItem key={s.id} strap={s} />)}
    </div>
  );
}
