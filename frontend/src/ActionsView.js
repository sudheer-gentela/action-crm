import React, { useState, useEffect, useCallback } from 'react';
import './ActionsView.css';
import EmailComposer from './EmailComposer';
import SnoozeModal from './SnoozeModal';

const API = process.env.REACT_APP_API_URL || '';

// ── Constants ────────────────────────────────────────────────────────────────

const ACTION_TYPE_OPTIONS = [
  { value: '',              label: 'All Types' },
  { value: 'meeting',       label: '📅 Meeting' },
  { value: 'follow_up',     label: '🔄 Follow Up' },
  { value: 'email_send',    label: '✉️ Email to Send' },
  { value: 'document_prep', label: '📄 Document Prep' },
  { value: 'meeting_prep',  label: '📋 Meeting Prep' },
  { value: 'internal',      label: '🏠 Internal' },
];

const NEXT_STEP_OPTIONS = [
  { value: '',              label: 'All Channels' },
  { value: 'email',         label: '✉️ Email' },
  { value: 'call',          label: '📞 Call' },
  { value: 'whatsapp',      label: '💬 WhatsApp' },
  { value: 'linkedin',      label: '🔗 LinkedIn' },
  { value: 'slack',         label: '💬 Slack' },
  { value: 'document',      label: '📄 Document' },
  { value: 'internal_task', label: '🔧 Internal Task' },
];

const PRIORITY_COLORS = {
  critical: '#dc2626',
  high:     '#ef4444',
  medium:   '#f59e0b',
  low:      '#10b981',
};

const STATUS_CONFIG = {
  yet_to_start: { label: 'Yet to Start', icon: '○', color: '#6b7280', next: 'in_progress' },
  in_progress:  { label: 'In Progress',  icon: '◑', color: '#3b82f6', next: 'completed'  },
  completed:    { label: 'Completed',    icon: '●', color: '#10b981', next: null          },
};

const SNOOZE_DURATION_LABELS = {
  '1_week':      '1 week',
  '2_weeks':     '2 weeks',
  '1_month':     '1 month',
  'stage_change':'until stage changes',
  'indefinite':  'indefinitely',
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

const MANUAL_LOG_CONFIG = {
  call:          { icon: '📞', label: 'Log Call',          placeholder: 'What was discussed? Any next steps agreed?' },
  whatsapp:      { icon: '💬', label: 'Log WhatsApp',      placeholder: 'What was the outcome of the conversation?' },
  linkedin:      { icon: '🔗', label: 'Log LinkedIn',      placeholder: 'What message did you send / receive?' },
  slack:         { icon: '💬', label: 'Log Slack Message', placeholder: 'What was the key point of the exchange?' },
  document:      { icon: '📄', label: 'Log Document Sent', placeholder: 'Which document? Any response from the prospect?' },
  internal_task: { icon: '🔧', label: 'Log Internal Task', placeholder: 'What did you complete or decide?' },
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

async function apiFetchRaw(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const res = await fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || res.statusText);
  return data;
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0)   return { text: `${Math.abs(diffDays)}d overdue`, overdue: true };
  if (diffDays === 0) return { text: 'Due today', today: true };
  if (diffDays === 1) return { text: 'Due tomorrow' };
  return { text: `Due ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` };
}

function nextStepLabel(nextStep) {
  const map = {
    email:         '✉️ Email',
    call:          '📞 Call',
    whatsapp:      '💬 WhatsApp',
    linkedin:      '🔗 LinkedIn',
    slack:         '💬 Slack',
    document:      '📄 Document',
    internal_task: '🔧 Internal Task',
  };
  return map[nextStep] || '✉️ Email';
}

// ── Evidence Panel ────────────────────────────────────────────────────────────

function EvidencePanel({ action }) {
  const [open, setOpen] = useState(false);
  const hasEvidence = action.description || action.context || action.suggestedAction || action.evidenceEmail;
  if (!hasEvidence) return null;

  const ruleLabel = action.sourceRule
    ? (SOURCE_RULE_LABELS[action.sourceRule] || action.sourceRule)
    : null;

  return (
    <div className="av-evidence">
      <button className="av-evidence-toggle" onClick={() => setOpen(o => !o)}>
        <span>Why this action?</span>
        <span className="av-evidence-chevron">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="av-evidence-body">
          {ruleLabel && (
            <div className="av-evidence-row">
              <span className="av-evidence-label">Rule</span>
              <span className="av-evidence-value av-evidence-rule">{ruleLabel}</span>
            </div>
          )}
          {action.description && (
            <div className="av-evidence-row">
              <span className="av-evidence-label">Signal</span>
              <span className="av-evidence-value">{action.description}</span>
            </div>
          )}
          {action.context && (
            <div className="av-evidence-row">
              <span className="av-evidence-label">AI Insight</span>
              <span className="av-evidence-value av-evidence-ai">{action.context}</span>
            </div>
          )}
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

// ── Manual Log Modal ──────────────────────────────────────────────────────────

function ManualLogModal({ action, onComplete, onInProgress, onClose }) {
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);
  const cfg = MANUAL_LOG_CONFIG[action.nextStep] || MANUAL_LOG_CONFIG.internal_task;

  async function handleDone() {
    setSaving(true);
    try { await onComplete(notes); } finally { setSaving(false); }
  }

  async function handleInProgress() {
    setSaving(true);
    try { await onInProgress(notes); } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content av-log-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{cfg.icon} {cfg.label}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="av-log-modal-body">
          <div className="av-log-action-title">{action.title}</div>
          {action.suggestedAction && (
            <div className="av-log-suggested">
              <span className="av-log-suggested-label">Suggested approach</span>
              <p>{action.suggestedAction}</p>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="log-notes">Notes (optional)</label>
            <textarea
              id="log-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={cfg.placeholder}
              rows="5"
            />
          </div>
        </div>
        <div className="av-log-modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="av-log-btn-progress" onClick={handleInProgress} disabled={saving}>
            {saving ? '…' : '◑ Still in Progress'}
          </button>
          <button className="av-log-btn-done" onClick={handleDone} disabled={saving}>
            {saving ? '…' : '✓ Mark Done'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Status Stepper ────────────────────────────────────────────────────────────

function StatusStepper({ action, onStatusChange, onStart }) {
  const [updating, setUpdating] = useState(false);
  const cfg = STATUS_CONFIG[action.status] || STATUS_CONFIG.yet_to_start;

  async function advance() {
    if (!cfg.next || updating) return;
    if (cfg.next === 'in_progress') {
      if (onStart) { onStart(action); return; }
    }
    setUpdating(true);
    try { await onStatusChange(action.id, cfg.next); }
    finally { setUpdating(false); }
  }

  // Snoozed actions don't show the stepper
  if (action.status === 'snoozed') return null;

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
          {updating ? '…' : cfg.next === 'in_progress'
            ? `${nextStepLabel(action.nextStep)} →`
            : 'Complete ✓'}
        </button>
      )}
      {action.status === 'completed' && (
        <span className="av-status-completed-by">
          {action.autoCompleted
            ? '🤖 Auto-completed'
            : `✓ Marked done${action.completedAt ? ` · ${new Date(action.completedAt).toLocaleDateString()}` : ''}`}
        </span>
      )}
    </div>
  );
}

// ── Action Card ───────────────────────────────────────────────────────────────

function ActionCard({ action, onStatusChange, onStart, onSnoozeClick, onUnsnooze }) {
  const dueInfo    = formatDate(action.dueDate);
  const pColor     = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
  const isCompleted = action.status === 'completed';
  const isSnoozed   = action.status === 'snoozed';

  return (
    <div className={`
      av-card
      av-card--${action.priority}
      ${isCompleted ? 'av-card--completed' : ''}
      ${isSnoozed   ? 'av-card--snoozed'   : ''}
      ${action.isInternal ? 'av-card--internal' : ''}
    `.trim().replace(/\s+/g, ' ')}>

      {/* Card header */}
      <div className="av-card-header">
        <span className="av-type-badge" style={{ background: pColor + '18', color: pColor }}>
          {nextStepLabel(action.nextStep)}
        </span>
        <div className="av-card-badges">
          {isSnoozed && <span className="av-badge av-badge--snoozed">😴 Snoozed</span>}
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
      {dueInfo && !isSnoozed && (
        <div className={`av-due ${dueInfo.overdue ? 'av-due--overdue' : dueInfo.today ? 'av-due--today' : ''}`}>
          🗓 {dueInfo.text}
        </div>
      )}

      {/* Snooze info banner */}
      {isSnoozed && (
        <div className="av-snooze-info">
          <div className="av-snooze-info__reason">
            💬 {action.snoozeReason}
          </div>
          <div className="av-snooze-info__meta">
            Snoozed {SNOOZE_DURATION_LABELS[action.snoozeDuration] || action.snoozeDuration}
            {action.snoozedUntil && (
              <> · wakes {new Date(action.snoozedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>
            )}
          </div>
          <button className="av-snooze-info__unsnooze" onClick={() => onUnsnooze(action.id)}>
            ↑ Unsnooze
          </button>
        </div>
      )}

      {/* Evidence panel — hide on snoozed */}
      {!isSnoozed && <EvidencePanel action={action} />}

      {/* Footer row: status stepper + snooze button */}
      {!isSnoozed && (
        <div className="av-card-footer">
          <StatusStepper action={action} onStatusChange={onStatusChange} onStart={onStart} />
          {!isCompleted && (
            <button
              className="av-snooze-btn"
              onClick={() => onSnoozeClick(action)}
              title="Snooze this action"
            >
              😴
            </button>
          )}
        </div>
      )}
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
          { value: '',      label: 'All' },
          { value: 'false', label: '🌐 External' },
          { value: 'true',  label: '🏠 Internal' },
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

      {/* Next Step / Channel */}
      <select
        className="av-filter-select"
        value={filters.nextStep}
        onChange={e => onChange('nextStep', e.target.value)}
      >
        {NEXT_STEP_OPTIONS.map(o => (
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
          title="Due after"
        />
        <span className="av-filter-date-sep">→</span>
        <input
          type="date"
          className="av-filter-date"
          value={filters.dueBefore}
          onChange={e => onChange('dueBefore', e.target.value)}
          title="Due before"
        />
      </div>

      {/* Status tabs — now includes Snoozed */}
      <div className="av-filter-group av-filter-group--status">
        {[
          { value: '',            label: 'Open' },
          { value: 'in_progress', label: '◑ In Progress' },
          { value: 'snoozed',     label: '😴 Snoozed' },
          { value: 'completed',   label: '● Completed' },
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

// ── Default filters ───────────────────────────────────────────────────────────

const DEFAULT_FILTERS = {
  source:     'all',
  isInternal: '',
  actionType: '',
  nextStep:   '',
  dealId:     '',
  accountId:  '',
  ownerId:    '',
  dueAfter:   '',
  dueBefore:  '',
  status:     '',
};

// ── Main Component ────────────────────────────────────────────────────────────

export default function ActionsView() {
  const [actions,       setActions]       = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [generating,    setGenerating]    = useState(false);
  const [error,         setError]         = useState(null);
  const [filters,       setFilters]       = useState(DEFAULT_FILTERS);
  const [filterOptions, setFilterOptions] = useState({ deals: [], accounts: [], owners: [] });
  const [contacts,      setContacts]      = useState([]);
  const [deals,         setDeals]         = useState([]);

  // Modal states
  const [composerAction, setComposerAction] = useState(null);
  const [logAction,      setLogAction]      = useState(null);
  const [snoozeAction,   setSnoozeAction]   = useState(null);

  useEffect(() => {
    apiFetch('/actions/filter-options').then(data => setFilterOptions(data)).catch(() => {});
    apiFetch('/contacts').then(d => setContacts(d.contacts || [])).catch(() => {});
    apiFetch('/deals').then(d => setDeals(d.deals || [])).catch(() => {});
  }, []);

  const fetchActions = useCallback(async (activeFilters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();

      if (activeFilters.status) {
        params.set('status', activeFilters.status);
      }
      if (activeFilters.dealId)     params.set('dealId',     activeFilters.dealId);
      if (activeFilters.accountId)  params.set('accountId',  activeFilters.accountId);
      if (activeFilters.ownerId)    params.set('ownerId',     activeFilters.ownerId);
      if (activeFilters.actionType) params.set('actionType', activeFilters.actionType);
      if (activeFilters.isInternal) params.set('isInternal', activeFilters.isInternal);
      if (activeFilters.nextStep)   params.set('nextStep',   activeFilters.nextStep);
      if (activeFilters.dueAfter)   params.set('dueAfter',   activeFilters.dueAfter);
      if (activeFilters.dueBefore)  params.set('dueBefore',  activeFilters.dueBefore);

      const data = await apiFetch(`/actions?${params.toString()}`);
      let rows = data.actions || [];

      // Client-side source filter
      if (activeFilters.source === 'ai')    rows = rows.filter(a => a.source === 'ai_generated');
      if (activeFilters.source === 'rules') rows = rows.filter(a => a.source === 'auto_generated');

      // Default view: hide completed and snoozed
      if (!activeFilters.status) {
        rows = rows.filter(a => a.status !== 'completed' && a.status !== 'snoozed');
      }

      setActions(rows);
    } catch (err) {
      console.error('Error fetching actions:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActions(filters);
  }, [filters, fetchActions]);

  function handleFilterChange(key, value) {
    if (key === '__reset__') { setFilters(DEFAULT_FILTERS); return; }
    setFilters(prev => ({ ...prev, [key]: value }));
  }

  async function handleStatusChange(actionId, newStatus) {
    try {
      await apiFetch(`/actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      setActions(prev =>
        prev.map(a => a.id === actionId
          ? { ...a, status: newStatus, completed: newStatus === 'completed' }
          : a
        ).filter(a => {
          if (!filters.status && a.id === actionId && newStatus === 'completed') return false;
          return true;
        })
      );
    } catch (err) {
      console.error('Status update failed:', err);
      alert('Failed to update status: ' + err.message);
    }
  }

  function handleStart(action) {
    const emailNextSteps = ['email', 'follow_up'];
    if (emailNextSteps.includes(action.nextStep)) {
      setComposerAction(action);
    } else {
      setLogAction(action);
    }
  }

  async function handleEmailSent(emailData) {
    try {
      const result = await apiFetchRaw('/emails', {
        method: 'POST',
        body: JSON.stringify({
          dealId:    emailData.deal_id    || composerAction?.deal?.id || null,
          contactId: emailData.contact_id || null,
          subject:   emailData.subject,
          body:      emailData.body,
          toAddress: emailData.toAddress,
          actionId:  emailData.actionId  || null,
        }),
      });
      if (emailData.actionId) {
        setActions(prev => prev.map(a =>
          a.id === emailData.actionId
            ? { ...a, status: a.status === 'yet_to_start' ? 'in_progress' : a.status }
            : a
        ));
      }
      setComposerAction(null);
      return result;
    } catch (err) {
      console.error('Email send failed:', err);
      throw err;
    }
  }

  async function handleManualComplete(action, notes) {
    try {
      await apiFetch(`/actions/${action.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed', notes }),
      });
      setActions(prev => prev
        .map(a => a.id === action.id ? { ...a, status: 'completed', completed: true } : a)
        .filter(a => !(!filters.status && a.id === action.id))
      );
      setLogAction(null);
    } catch (err) {
      console.error('Manual complete failed:', err);
      alert('Failed to mark action complete: ' + err.message);
    }
  }

  async function handleManualInProgress(action, notes) {
    try {
      await apiFetch(`/actions/${action.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'in_progress', notes }),
      });
      setActions(prev => prev.map(a =>
        a.id === action.id ? { ...a, status: 'in_progress' } : a
      ));
      setLogAction(null);
    } catch (err) {
      console.error('Status update failed:', err);
    }
  }

  async function handleSnooze(actionId, reason, duration) {
    await apiFetch(`/actions/${actionId}/snooze`, {
      method: 'PATCH',
      body: JSON.stringify({ reason, duration }),
    });
    // Remove from open view, show in snoozed view
    setActions(prev =>
      prev.map(a => a.id === actionId
        ? { ...a, status: 'snoozed', snoozeReason: reason, snoozeDuration: duration }
        : a
      ).filter(a => {
        if (filters.status !== 'snoozed' && a.id === actionId) return false;
        return true;
      })
    );
    setSnoozeAction(null);
  }

  async function handleUnsnooze(actionId) {
    try {
      await apiFetch(`/actions/${actionId}/unsnooze`, { method: 'PATCH' });
      setActions(prev =>
        prev.map(a => a.id === actionId
          ? { ...a, status: 'yet_to_start', snoozedUntil: null, snoozeReason: null, snoozeDuration: null }
          : a
        ).filter(a => {
          // If we're on snoozed view, remove it after unsnooze
          if (filters.status === 'snoozed' && a.id === actionId) return false;
          return true;
        })
      );
    } catch (err) {
      alert('Failed to unsnooze: ' + err.message);
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

  // Header counts
  const yetToStart = actions.filter(a => a.status === 'yet_to_start').length;
  const inProgress = actions.filter(a => a.status === 'in_progress').length;
  const snoozed    = actions.filter(a => a.status === 'snoozed').length;
  const completed  = actions.filter(a => a.status === 'completed').length;

  return (
    <>
      <div className="av-root">

        {/* Header */}
        <div className="av-header">
          <div className="av-header-left">
            <h2 className="av-title">⚡ Actions</h2>
            <div className="av-header-counts">
              <span className="av-count av-count--open">{yetToStart} to start</span>
              {inProgress > 0 && <span className="av-count av-count--progress">{inProgress} in progress</span>}
              {snoozed    > 0 && <span className="av-count av-count--snoozed">{snoozed} snoozed</span>}
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

        {/* Loading */}
        {loading && (
          <div className="av-loading">
            <div className="av-spinner"></div>
            <span>Loading actions…</span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="av-error">
            <p>{error}</p>
            <button onClick={() => fetchActions(filters)}>Retry</button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && actions.length === 0 && (
          <div className="av-empty">
            <div className="av-empty-icon">
              {filters.status === 'snoozed' ? '😴' : '🎯'}
            </div>
            <p>
              {filters.status === 'snoozed'
                ? 'No snoozed actions.'
                : 'No actions match the current filters.'}
            </p>
            {!filters.status && (
              <button className="av-generate-btn" onClick={handleGenerateActions} disabled={generating}>
                Generate Actions
              </button>
            )}
          </div>
        )}

        {/* Action grid */}
        {!loading && !error && actions.length > 0 && (
          <div className="av-grid">
            {actions.map(action => (
              <ActionCard
                key={action.id}
                action={action}
                onStatusChange={handleStatusChange}
                onStart={handleStart}
                onSnoozeClick={setSnoozeAction}
                onUnsnooze={handleUnsnooze}
              />
            ))}
          </div>
        )}

      </div>

      {/* Email Composer Modal */}
      {composerAction && (
        <EmailComposer
          contacts={contacts}
          deals={deals}
          prefill={{
            contactId: composerAction.contact ? composerAction.contact.id    : null,
            dealId:    composerAction.deal    ? composerAction.deal.id       : null,
            subject:   composerAction.title,
            body:      composerAction.suggestedAction
                         ? 'Hi,\n\n' + composerAction.suggestedAction + '\n\nBest regards,'
                         : '',
            toAddress: composerAction.contact ? composerAction.contact.email : '',
          }}
          actionId={composerAction.id}
          actionContext={{
            title:           composerAction.title,
            suggestedAction: composerAction.suggestedAction,
            nextStep:        composerAction.nextStep,
          }}
          onSubmit={handleEmailSent}
          onClose={() => setComposerAction(null)}
        />
      )}

      {/* Manual Log Modal */}
      {logAction && (
        <ManualLogModal
          action={logAction}
          onComplete={notes   => handleManualComplete(logAction, notes)}
          onInProgress={notes => handleManualInProgress(logAction, notes)}
          onClose={() => setLogAction(null)}
        />
      )}

      {/* Snooze Modal */}
      {snoozeAction && (
        <SnoozeModal
          action={snoozeAction}
          onSnooze={handleSnooze}
          onClose={() => setSnoozeAction(null)}
        />
      )}
    </>
  );
}
