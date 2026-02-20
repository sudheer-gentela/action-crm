import React, { useState, useEffect, useCallback } from 'react';
import './ActionsView.css';

const API = process.env.REACT_APP_API_URL || '';

// ── Constants ────────────────────────────────────────────────────────────────

const ACTION_TYPE_OPTIONS = [
  { value: '',             label: 'All Types' },
  { value: 'meeting',      label: '📅 Meeting' },
  { value: 'follow_up',   label: '🔄 Follow Up' },
  { value: 'email_send',  label: '✉️ Email to Send' },
  { value: 'document_prep', label: '📄 Document Prep' },
  { value: 'meeting_prep', label: '📋 Meeting Prep' },
  { value: 'internal',    label: '🏠 Internal' },
];

const PRIORITY_COLORS = {
  critical: '#dc2626',
  high:     '#ef4444',
  medium:   '#f59e0b',
  low:      '#10b981',
};

const STATUS_CONFIG = {
  yet_to_start: { label: 'Yet to Start', icon: '○',  color: '#6b7280', next: 'in_progress' },
  in_progress:  { label: 'In Progress',  icon: '◑',  color: '#3b82f6', next: 'completed'   },
  completed:    { label: 'Completed',    icon: '●',  color: '#10b981', next: null           },
};

const SOURCE_RULE_LABELS = {
  stagnant_deal:             'Stagnant Deal',
  high_value_no_meeting:     'High Value — No Meeting',
  stage_proposal_followup:   'Proposal Follow-up',
  decision_maker_no_contact: 'Decision Maker — No Contact',
  unanswered_email:          'Unanswered Email',
  no_proposal_doc:           'No Proposal Document',
  champion_nurture:          'Champion Nurture',
  no_files:                  'No Files Uploaded',
  ai_enhancer:               'AI Enhancement',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0)  return { text: `${Math.abs(diffDays)}d overdue`, overdue: true };
  if (diffDays === 0) return { text: 'Due today', today: true };
  if (diffDays === 1) return { text: 'Due tomorrow' };
  return { text: `Due ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` };
}

function typeLabel(type) {
  const map = {
    meeting:       '📅 Meeting',
    meeting_schedule: '📅 Meeting',
    follow_up:     '🔄 Follow Up',
    email:         '✉️ Email',
    email_send:    '✉️ Email',
    document_prep: '📄 Document',
    document:      '📄 Document',
    review:        '📋 Review',
    meeting_prep:  '📋 Meeting Prep',
  };
  return map[type] || (type ? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Task');
}

// ── Evidence Panel ────────────────────────────────────────────────────────────

function EvidencePanel({ action }) {
  const [open, setOpen] = useState(false);

  const hasEvidence = action.description || action.context || action.suggestedAction || action.evidenceEmail;
  if (!hasEvidence) return null;

  const ruleLabel = action.sourceRule
    ? (SOURCE_RULE_LABELS[action.sourceRule] || action.sourceRule.replace(/_/g, ' '))
    : null;

  return (
    <div className="av-evidence">
      <button className="av-evidence-toggle" onClick={() => setOpen(o => !o)}>
        <span>💡 Why this action?</span>
        <span className="av-evidence-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="av-evidence-body">
          {/* Rule that fired */}
          {ruleLabel && (
            <div className="av-evidence-row">
              <span className="av-evidence-label">Rule</span>
              <span className="av-evidence-value av-evidence-rule">{ruleLabel}</span>
            </div>
          )}

          {/* Description = rule's direct evidence text */}
          {action.description && (
            <div className="av-evidence-row">
              <span className="av-evidence-label">Signal</span>
              <span className="av-evidence-value">{action.description}</span>
            </div>
          )}

          {/* AI context */}
          {action.context && action.source === 'ai_generated' && (
            <div className="av-evidence-row">
              <span className="av-evidence-label">AI Insight</span>
              <span className="av-evidence-value av-evidence-ai">{action.context}</span>
            </div>
          )}

          {/* Triggering email snippet */}
          {action.evidenceEmail && (
            <div className="av-evidence-email">
              <div className="av-evidence-email-header">
                <span className="av-evidence-label">Triggering Email</span>
                <span className={`av-evidence-email-dir ${action.evidenceEmail.direction}`}>
                  {action.evidenceEmail.direction === 'sent' ? '↑ Sent' : '↓ Received'}
                </span>
              </div>
              <div className="av-evidence-email-subject">"{action.evidenceEmail.subject}"</div>
              {action.evidenceEmail.snippet && (
                <div className="av-evidence-email-snippet">{action.evidenceEmail.snippet}</div>
              )}
            </div>
          )}

          {/* Suggested action */}
          {action.suggestedAction && (
            <div className="av-evidence-row av-evidence-suggested">
              <span className="av-evidence-label">Suggested</span>
              <span className="av-evidence-value">{action.suggestedAction}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Status Stepper ────────────────────────────────────────────────────────────

function StatusStepper({ action, onStatusChange }) {
  const [updating, setUpdating] = useState(false);
  const cfg = STATUS_CONFIG[action.status] || STATUS_CONFIG.yet_to_start;

  async function advance() {
    if (!cfg.next || updating) return;
    setUpdating(true);
    try {
      await onStatusChange(action.id, cfg.next);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="av-status">
      <div className="av-status-steps">
        {Object.entries(STATUS_CONFIG).map(([key, s]) => (
          <div
            key={key}
            className={`av-status-step ${action.status === key ? 'active' : ''} ${
              Object.keys(STATUS_CONFIG).indexOf(key) <
              Object.keys(STATUS_CONFIG).indexOf(action.status) ? 'done' : ''
            }`}
            style={{ '--step-color': s.color }}
          >
            <span className="av-status-dot">{s.icon}</span>
            <span className="av-status-step-label">{s.label}</span>
          </div>
        ))}
      </div>
      {cfg.next && (
        <button
          className={`av-status-btn av-status-btn--${cfg.next}`}
          onClick={advance}
          disabled={updating}
        >
          {updating ? '…' : cfg.next === 'in_progress' ? 'Start' : 'Complete ✓'}
        </button>
      )}
      {action.status === 'completed' && (
        <span className="av-status-completed-by">
          {action.autoCompleted ? '🤖 Auto-completed' : `✓ Marked done${action.completedAt ? ` · ${new Date(action.completedAt).toLocaleDateString()}` : ''}`}
        </span>
      )}
    </div>
  );
}

// ── Action Card ───────────────────────────────────────────────────────────────

function ActionCard({ action, onStatusChange }) {
  const dueInfo = formatDate(action.dueDate);
  const pColor  = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  const isCompleted = action.status === 'completed';

  return (
    <div className={`av-card av-card--${action.priority} ${isCompleted ? 'av-card--completed' : ''} ${action.isInternal ? 'av-card--internal' : ''}`}>

      {/* Card header */}
      <div className="av-card-header">
        <span className="av-type-badge" style={{ background: pColor + '18', color: pColor }}>
          {typeLabel(action.type)}
        </span>

        <div className="av-card-badges">
          {action.isInternal && <span className="av-badge av-badge--internal">🏠 Internal</span>}
          {action.source === 'ai_generated' && (
            <span className="av-badge av-badge--ai" title={
              action.metadata?.confidence
                ? `AI · ${Math.round(action.metadata.confidence * 100)}% confidence`
                : 'AI Generated'
            }>🤖 AI</span>
          )}
          <span className="av-priority-dot" style={{ background: pColor }} title={action.priority} />
        </div>
      </div>

      {/* Title */}
      <h3 className="av-card-title">{action.title}</h3>

      {/* Deal / Account context */}
      {action.deal && (
        <div className="av-card-context">
          <span className="av-context-deal">💼 {action.deal.name}</span>
          {action.deal.account && <span className="av-context-account">· {action.deal.account}</span>}
          {action.deal.stage && (
            <span className="av-context-stage">{action.deal.stage.replace(/_/g, ' ')}</span>
          )}
        </div>
      )}

      {/* Contact context */}
      {action.contact && (
        <div className="av-card-context">
          <span>👤 {action.contact.firstName} {action.contact.lastName}</span>
          {action.contact.email && <span className="av-context-email">· {action.contact.email}</span>}
        </div>
      )}

      {/* Due date */}
      {dueInfo && (
        <div className={`av-due ${dueInfo.overdue ? 'av-due--overdue' : dueInfo.today ? 'av-due--today' : ''}`}>
          🗓 {dueInfo.text}
        </div>
      )}

      {/* Evidence panel */}
      <EvidencePanel action={action} />

      {/* Status stepper */}
      <StatusStepper action={action} onStatusChange={onStatusChange} />
    </div>
  );
}

// ── Filter Bar ────────────────────────────────────────────────────────────────

function FilterBar({ filters, onChange, options }) {
  return (
    <div className="av-filters">
      {/* Source filter */}
      <div className="av-filter-group av-filter-group--source">
        {[
          { value: 'all',   label: 'All' },
          { value: 'ai',    label: '🤖 AI' },
          { value: 'rules', label: '⚙️ Rules' },
        ].map(opt => (
          <button
            key={opt.value}
            className={`av-filter-pill ${filters.source === opt.value ? 'active' : ''}`}
            onClick={() => onChange('source', opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Internal / External */}
      <div className="av-filter-group av-filter-group--internal">
        {[
          { value: '',       label: 'All' },
          { value: 'false',  label: '🌐 External' },
          { value: 'true',   label: '🏠 Internal' },
        ].map(opt => (
          <button
            key={opt.value}
            className={`av-filter-pill ${filters.isInternal === opt.value ? 'active' : ''}`}
            onClick={() => onChange('isInternal', opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Action Type */}
      <select
        className="av-filter-select"
        value={filters.actionType}
        onChange={e => onChange('actionType', e.target.value)}
      >
        {ACTION_TYPE_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Deal */}
      <select
        className="av-filter-select"
        value={filters.dealId}
        onChange={e => onChange('dealId', e.target.value)}
      >
        <option value="">All Deals</option>
        {options.deals.map(d => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      {/* Account */}
      <select
        className="av-filter-select"
        value={filters.accountId}
        onChange={e => onChange('accountId', e.target.value)}
      >
        <option value="">All Accounts</option>
        {options.accounts.map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>

      {/* Owner */}
      <select
        className="av-filter-select"
        value={filters.ownerId}
        onChange={e => onChange('ownerId', e.target.value)}
      >
        <option value="">All Owners</option>
        {options.owners.map(o => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>

      {/* Date range */}
      <div className="av-filter-dates">
        <input
          type="date"
          className="av-filter-date"
          value={filters.dueAfter}
          onChange={e => onChange('dueAfter', e.target.value)}
          placeholder="From"
          title="Due after"
        />
        <span className="av-filter-date-sep">→</span>
        <input
          type="date"
          className="av-filter-date"
          value={filters.dueBefore}
          onChange={e => onChange('dueBefore', e.target.value)}
          placeholder="To"
          title="Due before"
        />
      </div>

      {/* Status tabs */}
      <div className="av-filter-group av-filter-group--status">
        {[
          { value: '',              label: 'Open' },
          { value: 'in_progress',   label: '◑ In Progress' },
          { value: 'completed',     label: '● Completed' },
        ].map(opt => (
          <button
            key={opt.value}
            className={`av-filter-pill ${filters.status === opt.value ? 'active' : ''}`}
            onClick={() => onChange('status', opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Clear all */}
      <button className="av-filter-clear" onClick={() => onChange('__reset__', null)}>
        ✕ Clear
      </button>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = {
  source:     'all',
  isInternal: '',
  actionType: '',
  dealId:     '',
  accountId:  '',
  ownerId:    '',
  dueAfter:   '',
  dueBefore:  '',
  status:     '',
};

export default function ActionsView() {
  const [actions, setActions]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError]         = useState(null);
  const [filters, setFilters]     = useState(DEFAULT_FILTERS);
  const [filterOptions, setFilterOptions] = useState({ deals: [], accounts: [], owners: [] });

  // Load filter options once
  useEffect(() => {
    apiFetch('/actions/filter-options')
      .then(data => setFilterOptions(data))
      .catch(() => {});
  }, []);

  const fetchActions = useCallback(async (activeFilters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();

      // Status
      if (activeFilters.status) {
        params.set('status', activeFilters.status);
      } else {
        // default: show only non-completed
        params.set('status', 'yet_to_start');
        // We'll also fetch in_progress — two calls merged, or we omit status filter
        // Actually: no status filter = show all non-completed (API filters on FE)
        params.delete('status');
      }

      if (activeFilters.dealId)     params.set('dealId',     activeFilters.dealId);
      if (activeFilters.accountId)  params.set('accountId',  activeFilters.accountId);
      if (activeFilters.ownerId)    params.set('ownerId',     activeFilters.ownerId);
      if (activeFilters.actionType) params.set('actionType', activeFilters.actionType);
      if (activeFilters.isInternal) params.set('isInternal', activeFilters.isInternal);
      if (activeFilters.dueAfter)   params.set('dueAfter',   activeFilters.dueAfter);
      if (activeFilters.dueBefore)  params.set('dueBefore',  activeFilters.dueBefore);
      if (activeFilters.status)     params.set('status',     activeFilters.status);

      const data = await apiFetch(`/actions?${params.toString()}`);
      let rows = data.actions || [];

      // Client-side source filter (fast, no extra API call)
      if (activeFilters.source === 'ai')    rows = rows.filter(a => a.source === 'ai_generated');
      if (activeFilters.source === 'rules') rows = rows.filter(a => a.source === 'auto_generated');

      // If no status filter selected, hide completed
      if (!activeFilters.status) {
        rows = rows.filter(a => a.status !== 'completed');
      }

      setActions(rows);
    } catch (err) {
      console.error('Error fetching actions:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []); // no deps — always called with explicit activeFilters argument

  useEffect(() => {
    fetchActions(filters);
  }, [filters, fetchActions]);

  function handleFilterChange(key, value) {
    if (key === '__reset__') {
      setFilters(DEFAULT_FILTERS);
      return;
    }
    setFilters(prev => ({ ...prev, [key]: value }));
  }

  async function handleStatusChange(actionId, newStatus) {
    try {
      await apiFetch(`/actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      // Optimistic update
      setActions(prev =>
        prev.map(a =>
          a.id === actionId
            ? { ...a, status: newStatus, completed: newStatus === 'completed' }
            : a
        ).filter(a => {
          // If we're on the default (open) view, hide newly-completed
          if (!filters.status && a.id === actionId && newStatus === 'completed') return false;
          return true;
        })
      );
    } catch (err) {
      console.error('Status update failed:', err);
      alert('Failed to update status: ' + err.message);
    }
  }

  async function handleGenerateActions() {
    setGenerating(true);
    try {
      const result = await apiFetch('/actions/generate', { method: 'POST' });
      await fetchActions(filters);
      alert(`✅ Generated ${result.generated} actions, inserted ${result.inserted} new.`);
    } catch (err) {
      alert('Failed to generate actions: ' + err.message);
    } finally {
      setGenerating(false);
    }
  }

  // Counts for header
  const yetToStart  = actions.filter(a => a.status === 'yet_to_start').length;
  const inProgress  = actions.filter(a => a.status === 'in_progress').length;
  const completed   = actions.filter(a => a.status === 'completed').length;

  return (
    <div className="av-root">
      {/* Header */}
      <div className="av-header">
        <div className="av-header-left">
          <h2 className="av-title">⚡ Actions</h2>
          <div className="av-header-counts">
            <span className="av-count av-count--open">{yetToStart} to start</span>
            {inProgress > 0 && <span className="av-count av-count--progress">{inProgress} in progress</span>}
            {completed  > 0 && <span className="av-count av-count--done">{completed} completed</span>}
          </div>
        </div>
        <button
          className="av-generate-btn"
          onClick={handleGenerateActions}
          disabled={generating || loading}
        >
          {generating ? '⏳ Generating…' : '⚡ Generate Actions'}
        </button>
      </div>

      {/* Filters */}
      <FilterBar filters={filters} onChange={handleFilterChange} options={filterOptions} />

      {/* Content */}
      {loading && (
        <div className="av-loading">
          <div className="av-spinner" />
          <span>Loading actions…</span>
        </div>
      )}

      {error && (
        <div className="av-error">
          <p>{error}</p>
          <button onClick={() => fetchActions(filters)}>Retry</button>
        </div>
      )}

      {!loading && !error && actions.length === 0 && (
        <div className="av-empty">
          <div className="av-empty-icon">🎯</div>
          <p>No actions match the current filters.</p>
          <button className="av-generate-btn" onClick={handleGenerateActions} disabled={generating}>
            Generate Actions
          </button>
        </div>
      )}

      {!loading && !error && actions.length > 0 && (
        <div className="av-grid">
          {actions.map(action => (
            <ActionCard
              key={action.id}
              action={action}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
