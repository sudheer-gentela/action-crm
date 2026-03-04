import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import { csvExport, EXPORT_COLUMNS } from './csvUtils';
import './ActionsView.css';
import EmailComposer from './EmailComposer';
import SnoozeModal from './SnoozeModal';

const API = process.env.REACT_APP_API_URL || '';

// ── Constants ────────────────────────────────────────────────────────────────



const PRIORITY_COLORS = {
  critical: '#dc2626',
  high:     '#ef4444',
  medium:   '#f59e0b',
  low:      '#10b981',
};

const STRAP_ENTITY_CONFIG = {
  deal:           { icon: '💼', color: '#4f46e5', bg: '#eef2ff', label: 'Deal' },
  prospect:       { icon: '🎯', color: '#0F9D8E', bg: '#f0fdfa', label: 'Prospect' },
  account:        { icon: '🏢', color: '#7c3aed', bg: '#f5f3ff', label: 'Account' },
  implementation: { icon: '🚀', color: '#0369a1', bg: '#f0f9ff', label: 'Implementation' },
};

const STRAP_SECTIONS = [
  { key: 'S', field: 'situation',   label: 'Situation',   color: '#3b82f6' },
  { key: 'T', field: 'target',      label: 'Target',      color: '#10b981' },
  { key: 'R', field: 'response',    label: 'Response',    color: '#f59e0b' },
  { key: 'A', field: 'action_plan', label: 'Action Plan', color: '#8b5cf6' },
];

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
  call:          { icon: '📞', label: 'Log Call',          placeholder: 'What was discussed? Any next steps agreed?',    resourceLabel: 'Call',       opensExternal: true },
  whatsapp:      { icon: '💬', label: 'Log WhatsApp',      placeholder: 'What was the outcome of the conversation?',     resourceLabel: 'WhatsApp',   opensExternal: true },
  linkedin:      { icon: '🔗', label: 'Log LinkedIn',      placeholder: 'What message did you send / receive?',          resourceLabel: 'LinkedIn',   opensExternal: true },
  slack:         { icon: '💬', label: 'Log Slack Message', placeholder: 'What was the key point of the exchange?',       resourceLabel: 'Slack',      opensExternal: false },
  document:      { icon: '📄', label: 'Log Document Sent', placeholder: 'Which document? Any response from the prospect?', resourceLabel: 'Files',    navigateTab: 'files' },
  internal_task: { icon: '🔧', label: 'Log Internal Task', placeholder: 'What did you complete or decide?',             resourceLabel: 'Task',       opensExternal: false },
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

// ── Resume Button ─────────────────────────────────────────────────────────────
// Appears only on in_progress actions. Resolves the best deep-link target for
// the action based on action_type, source_rule, and deal_id, then fires the
// appropriate navigation event.

async function resolveResumeTarget(action) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API   = process.env.REACT_APP_API_URL || '';

  const type      = (action.actionType  || action.action_type  || '').toLowerCase();
  const rule      = (action.sourceRule  || action.source_rule  || '').toLowerCase();
  const nextStep  = (action.nextStep    || action.next_step    || '').toLowerCase();
  const dealId    = action.deal?.id || action.dealId    || action.deal_id    || null;

  // Helper: fetch with auth
  const get = async (path) => {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return r.json();
  };

  // ── Email-type actions → most recent email thread for the deal ──────────
  if (
    type === 'unanswered_email' ||
    rule === 'unanswered_email' ||
    type === 'email_send' ||
    type === 'email' ||
    (type === 'follow_up' && nextStep === 'email') ||
    nextStep === 'email'
  ) {
    return { tab: 'email', dealId, label: 'Open Email Thread', icon: '✉️' };
  }

  // ── Meeting prep / followup → calendar or deal ──────────────────────────
  if (type === 'meeting_prep' || rule === 'meeting_prep') {
    // Try to find the upcoming/most recent meeting
    if (dealId) {
      const data = await get(`/meetings?deal_id=${dealId}`).catch(() => null);
      const meetings = data?.meetings || [];
      const upcoming = meetings
        .filter(m => m.status === 'scheduled' && new Date(m.start_time) > new Date())
        .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
      if (upcoming) return { tab: 'calendar', meetingId: upcoming.id, label: 'View Meeting', icon: '📅' };
    }
    return { tab: 'deals', dealId, label: 'Open Deal', icon: '💼' };
  }

  if (type === 'meeting_followup' || rule === 'meeting_followup') {
    return { tab: 'deals', dealId, label: 'Open Deal', icon: '💼' };
  }

  // ── Meeting schedule → calendar (scheduling new) ─────────────────────────
  if (type === 'meeting_schedule' || type === 'meeting') {
    return { tab: 'calendar', label: 'Schedule Meeting', icon: '📅' };
  }

  // ── Document / file actions → Files tab ─────────────────────────────────
  if (
    type === 'document_prep' || type === 'document' ||
    rule === 'no_proposal_doc' || rule === 'no_files' ||
    rule === 'health_5a_competitive' || rule === 'failed_file'
  ) {
    return { tab: 'files', dealId, label: 'Open Files', icon: '📁' };
  }

  // ── Internal / task → Deal detail pane ──────────────────────────────────
  if (dealId) return { tab: 'deals', dealId, label: 'Open Deal', icon: '💼' };

  // Fallback — go to Actions
  return { tab: 'actions', label: 'Back to Actions', icon: '⚡' };
}

function ResumeButton({ action }) {
  const [loading, setLoading] = useState(false);

  if (action.status !== 'in_progress') return null;

  async function handleResume(e) {
    e.stopPropagation();
    setLoading(true);
    try {
      const target = await resolveResumeTarget(action);

      // Single enriched navigate event — carries tab AND dealId together so
      // App.js can set pendingEmailDealId/pendingDealId BEFORE switching the
      // tab. This prevents the race condition where EmailView mounted with
      // dealId=null because the two separate events (resumeToEmail + navigate)
      // triggered separate async React state updates.
      window.dispatchEvent(new CustomEvent('navigate', {
        detail: {
          tab:    target.tab,
          dealId: target.dealId || null,
          resume: true,
        },
      }));
    } catch (err) {
      console.error('Resume navigation failed:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      className="av-resume-btn"
      onClick={handleResume}
      disabled={loading}
      title="Pick up where you left off"
    >
      {loading ? '…' : '↩ Resume'}
    </button>
  );
}

// ── Manual Log Modal ──────────────────────────────────────────────────────────

function ManualLogModal({ action, onComplete, onInProgress, onClose }) {
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);
  const cfg = MANUAL_LOG_CONFIG[action.nextStep] || MANUAL_LOG_CONFIG.internal_task;
  const person = action.contact || action.prospect || {};
  const personName = [person.firstName, person.lastName].filter(Boolean).join(' ');
  const phone = person.phone;
  const linkedinUrl = person.linkedinUrl;
  const dealId = action.deal?.id || null;

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

          {/* Resource links */}
          {personName && (
            <div className="av-log-resource-bar">
              <span className="av-log-resource-person">{personName}</span>
              {phone && (
                <a href={`tel:${phone.replace(/\s/g, '')}`} className="av-log-resource-link av-log-resource-link--call">
                  📞 {phone}
                </a>
              )}
              {linkedinUrl && (
                <a href={linkedinUrl.startsWith('http') ? linkedinUrl : `https://${linkedinUrl}`}
                   target="_blank" rel="noreferrer" className="av-log-resource-link av-log-resource-link--linkedin">
                  🔗 LinkedIn ↗
                </a>
              )}
              {phone && (
                <a href={`https://wa.me/${phone.replace(/[\s\-()]/g, '').replace(/^\+/, '')}`}
                   target="_blank" rel="noreferrer" className="av-log-resource-link av-log-resource-link--whatsapp">
                  💬 WhatsApp ↗
                </a>
              )}
              {person.email && (
                <a href={`mailto:${person.email}`} className="av-log-resource-link av-log-resource-link--email">
                  ✉️ {person.email}
                </a>
              )}
            </div>
          )}

          {action.nextStep === 'document' && dealId && (
            <button className="av-log-resource-nav" onClick={() => {
              window.dispatchEvent(new CustomEvent('navigate', {
                detail: { tab: 'deals', dealId, resume: true },
              }));
            }}>
              📁 Open Files for {action.deal?.name || 'this deal'} →
            </button>
          )}

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

// ── Column Definitions ──────────────────────────────────────────────────────

const ALL_COLUMNS = [
  { key: 'channel',  label: 'Channel',  width: 90,  defaultVisible: true,  sortable: true,  filterable: true  },
  { key: 'title',    label: 'Action',   width: 0,   defaultVisible: true,  sortable: true,  filterable: false },
  { key: 'deal',     label: 'Deal',     width: 160, defaultVisible: true,  sortable: true,  filterable: true  },
  { key: 'contact',  label: 'Contact',  width: 130, defaultVisible: true,  sortable: true,  filterable: false },
  { key: 'due',      label: 'Due',      width: 100, defaultVisible: true,  sortable: true,  filterable: false },
  { key: 'priority', label: 'Priority', width: 90,  defaultVisible: true,  sortable: true,  filterable: true  },
  { key: 'status',   label: 'Status',   width: 110, defaultVisible: true,  sortable: true,  filterable: true  },
  { key: 'source',   label: 'Source',   width: 80,  defaultVisible: true,  sortable: true,  filterable: true  },
  { key: 'account',  label: 'Account',  width: 130, defaultVisible: false, sortable: true,  filterable: true  },
  { key: 'stage',    label: 'Stage',    width: 100, defaultVisible: false, sortable: true,  filterable: true  },
  { key: 'internal', label: 'Type',     width: 80,  defaultVisible: false, sortable: true,  filterable: true  },
  { key: 'actions',  label: '',         width: 60,  defaultVisible: true,  sortable: false, filterable: false },
];

const CHANNEL_META = {
  email:         { icon: '✉️', label: 'Email',     color: '#f59e0b' },
  call:          { icon: '📞', label: 'Call',       color: '#10b981' },
  follow_up:     { icon: '✉️', label: 'Follow Up', color: '#f59e0b' },
  linkedin:      { icon: '🔗', label: 'LinkedIn',   color: '#2563eb' },
  whatsapp:      { icon: '💬', label: 'WhatsApp',   color: '#16a34a' },
  document:      { icon: '📄', label: 'Document',   color: '#8b5cf6' },
  slack:         { icon: '💬', label: 'Slack',       color: '#e11d48' },
  internal_task: { icon: '🔧', label: 'Task',       color: '#6b7280' },
};

const SOURCE_META = {
  strap:           { label: '🎯 STRAP',   bg: '#faf5ff', color: '#7c3aed', border: '#e9d5ff' },
  ai_generated:    { label: '🤖 AI',      bg: '#f0fdf4', color: '#15803d', border: '#bbf7d0' },
  playbook:        { label: '📘 Play',    bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
  auto_generated:  { label: '⚙️ Rules',   bg: '#fefce8', color: '#a16207', border: '#fde68a' },
};

const STATUS_META = {
  yet_to_start: { icon: '○', label: 'To Start',    color: '#9ca3af' },
  in_progress:  { icon: '◑', label: 'In Progress', color: '#f59e0b' },
  completed:    { icon: '●', label: 'Done',        color: '#10b981' },
  snoozed:      { icon: '😴', label: 'Snoozed', color: '#8b5cf6' },
};

function tableDueLabel(d) {
  if (!d) return { text: '—', overdue: false, today: false };
  const now = new Date(); now.setHours(0,0,0,0);
  const due = new Date(d); due.setHours(0,0,0,0);
  const diff = Math.ceil((due - now) / 86400000);
  if (diff < 0) return { text: `${Math.abs(diff)}d overdue`, overdue: true };
  if (diff === 0) return { text: 'Today', today: true };
  if (diff === 1) return { text: 'Tomorrow' };
  return { text: due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) };
}

function getColumnValue(action, colKey) {
  switch (colKey) {
    case 'channel':  return action.nextStep || 'email';
    case 'title':    return action.title || '';
    case 'deal':     return action.deal?.name || '';
    case 'contact':  return action.contact ? `${action.contact.firstName || ''} ${action.contact.lastName || ''}`.trim() : (action.prospect ? `${action.prospect.firstName || ''} ${action.prospect.lastName || ''}`.trim() : '');
    case 'due':      return action.dueDate || '';
    case 'priority': return action.priority || 'medium';
    case 'status':   return action.status || 'yet_to_start';
    case 'source':   return action.source || '';
    case 'account':  return action.deal?.account || action.prospect?.companyName || '';
    case 'stage':    return action.deal?.stage || action.prospect?.stage || '';
    case 'internal': return action.isInternal ? 'Internal' : 'External';
    default:         return '';
  }
}

// ── Actions Table Component ─────────────────────────────────────────────────

function ActionsTable({ actions, onStatusChange, onStart, onSnoozeClick, onUnsnooze }) {
  const [visibleCols, setVisibleCols] = useState(() =>
    ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)
  );
  const [sortKey, setSortKey] = useState('due');
  const [sortDir, setSortDir] = useState('asc');
  const [colFilters, setColFilters] = useState({});
  const [showColConfig, setShowColConfig] = useState(false);

  // Unique values for filterable columns
  const filterOptions = {};
  ALL_COLUMNS.filter(c => c.filterable).forEach(col => {
    const vals = new Set();
    actions.forEach(a => {
      const v = getColumnValue(a, col.key);
      if (v) vals.add(v);
    });
    filterOptions[col.key] = Array.from(vals).sort();
  });

  // Apply column-level filters
  let filtered = actions;
  Object.entries(colFilters).forEach(([key, val]) => {
    if (val) {
      filtered = filtered.filter(a => getColumnValue(a, key) === val);
    }
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let aVal = getColumnValue(a, sortKey);
    let bVal = getColumnValue(b, sortKey);

    // Priority sort order
    if (sortKey === 'priority') {
      const order = { critical: 1, high: 2, medium: 3, low: 4 };
      aVal = order[aVal] || 3;
      bVal = order[bVal] || 3;
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    }
    // Status sort order
    if (sortKey === 'status') {
      const order = { yet_to_start: 1, in_progress: 2, snoozed: 3, completed: 4 };
      aVal = order[aVal] || 1;
      bVal = order[bVal] || 1;
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    }
    // Date sort
    if (sortKey === 'due') {
      const da = aVal ? new Date(aVal).getTime() : 9999999999999;
      const db = bVal ? new Date(bVal).getTime() : 9999999999999;
      return sortDir === 'asc' ? da - db : db - da;
    }
    // String sort
    aVal = String(aVal).toLowerCase();
    bVal = String(bVal).toLowerCase();
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function toggleCol(key) {
    setVisibleCols(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  }

  const activeCols = ALL_COLUMNS.filter(c => visibleCols.includes(c.key));

  // Navigation helpers for clickable cells
  function navToDeal(action) {
    const dealId = action.deal?.id;
    if (dealId) {
      window.dispatchEvent(new CustomEvent('navigate', {
        detail: { tab: 'deals', dealId, resume: true },
      }));
    }
  }

  function navToContact(action) {
    const contactId = action.contact?.id;
    if (contactId) {
      window.dispatchEvent(new CustomEvent('navigate', {
        detail: { tab: 'deals', dealId: action.deal?.id, contactId, resume: true },
      }));
    } else if (action.prospect?.id) {
      window.dispatchEvent(new CustomEvent('navigate', {
        detail: { tab: 'prospecting' },
      }));
    }
  }

  function navToAction(action) {
    // Same as clicking the Start button — routes to the right resource
    onStart(action);
  }

  async function navToInProgress(action) {
    if (action.status !== 'in_progress') return;
    // Use resolveResumeTarget to find where to go
    try {
      const target = await resolveResumeTarget(action);
      window.dispatchEvent(new CustomEvent('navigate', {
        detail: {
          tab: target.tab,
          dealId: target.dealId || null,
          resume: true,
        },
      }));
    } catch (err) {
      console.error('Navigate to in-progress failed:', err);
    }
  }
  const gridCols = activeCols.map(c => c.width ? `${c.width}px` : '1fr').join(' ');

  return (
    <div className="av-table-root">
      {/* Column config toggle — fixed at top */}
      <div className="av-table-toolbar">
        <span className="av-table-result-count">{sorted.length} action{sorted.length !== 1 ? 's' : ''}</span>
        {Object.keys(colFilters).some(k => colFilters[k]) && (
          <button className="av-table-clear-filters" onClick={() => setColFilters({})}>
            ✕ Clear column filters
          </button>
        )}
        <button
          className="av-table-col-config-btn"
          onClick={() => setShowColConfig(p => !p)}
        >
          ⚙️ Columns
        </button>
        {showColConfig && (
          <div className="av-table-col-config">
            {ALL_COLUMNS.filter(c => c.key !== 'actions').map(col => (
              <label key={col.key} className="av-table-col-config-item">
                <input
                  type="checkbox"
                  checked={visibleCols.includes(col.key)}
                  onChange={() => toggleCol(col.key)}
                />
                {col.label}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Header row — fixed at top */}
      <div className="av-table-header" style={{ gridTemplateColumns: gridCols }}>
        {activeCols.map(col => {
          const isSorted = sortKey === col.key;
          const arrow = isSorted ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
          return (
            <div key={col.key} className="av-table-th">
              {col.sortable ? (
                <span
                  className={`av-table-th-label ${isSorted ? 'av-table-th-label--active' : ''}`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}{arrow}
                </span>
              ) : (
                <span className="av-table-th-label">{col.label}</span>
              )}
              {col.filterable && filterOptions[col.key]?.length > 1 && (
                <select
                  className="av-table-th-filter"
                  value={colFilters[col.key] || ''}
                  onChange={e => setColFilters(p => ({ ...p, [col.key]: e.target.value }))}
                >
                  <option value="">All</option>
                  {filterOptions[col.key].map(v => (
                    <option key={v} value={v}>{col.key === 'channel' ? (CHANNEL_META[v]?.label || v) : col.key === 'source' ? (SOURCE_META[v]?.label || v).replace(/[^\w\s]/g, '').trim() : col.key === 'status' ? (STATUS_META[v]?.label || v) : col.key === 'priority' ? v.charAt(0).toUpperCase() + v.slice(1) : v}</option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      {/* Scrollable rows */}
      <div className="av-table-body">
        {sorted.map((action, i) => {
        const ch = CHANNEL_META[action.nextStep] || CHANNEL_META.email;
        const pri = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium;
        const st = STATUS_META[action.status] || STATUS_META.yet_to_start;
        const due = tableDueLabel(action.dueDate);
        const src = SOURCE_META[action.source] || SOURCE_META.ai_generated;
        const isComplete = action.status === 'completed';

        return (
          <div
            key={action.id}
            className={`av-table-row ${isComplete ? 'av-table-row--completed' : ''} ${i % 2 === 0 ? 'av-table-row--even' : ''}`}
            style={{ gridTemplateColumns: gridCols }}
          >
            {activeCols.map(col => {
              switch (col.key) {
                case 'channel':
                  return (
                    <div key={col.key} className="av-table-cell">
                      <span className="av-table-channel-badge" style={{ background: ch.color + '14', color: ch.color }}>
                        {ch.icon} {ch.label}
                      </span>
                    </div>
                  );
                case 'title':
                  return (
                    <div key={col.key} className="av-table-cell av-table-cell--title av-table-cell--clickable" onClick={() => navToAction(action)} title="Start this action">
                      {action.isInternal && <span className="av-table-internal-icon">🏠</span>}
                      <span className={isComplete ? 'av-table-strikethrough' : ''}>{action.title}</span>
                    </div>
                  );
                case 'deal':
                  return (
                    <div key={col.key} className={`av-table-cell av-table-cell--truncate ${action.deal ? 'av-table-cell--clickable' : ''}`} onClick={() => action.deal && navToDeal(action)} title={action.deal ? 'Open deal' : ''}>
                      {action.deal ? (
                        <span className="av-table-deal-name">💼 {action.deal.name}</span>
                      ) : action.prospect ? (
                        <span className="av-table-prospect-name">🎯 {action.prospect.firstName} {action.prospect.lastName}</span>
                      ) : (
                        <span className="av-table-empty">—</span>
                      )}
                    </div>
                  );
                case 'contact':
                  return (
                    <div key={col.key} className={`av-table-cell av-table-cell--truncate ${(action.contact || action.prospect) ? 'av-table-cell--clickable' : ''}`} onClick={() => (action.contact || action.prospect) && navToContact(action)} title={action.contact ? 'Open contact' : action.prospect ? 'Open prospect' : ''}>
                      {action.contact ? (
                        <span>👤 {action.contact.firstName} {action.contact.lastName}</span>
                      ) : action.prospect ? (
                        <span>🎯 {action.prospect.firstName} {action.prospect.lastName}</span>
                      ) : (
                        <span className="av-table-empty">—</span>
                      )}
                    </div>
                  );
                case 'due':
                  return (
                    <div key={col.key} className={`av-table-cell ${due.overdue ? 'av-table-cell--overdue' : due.today ? 'av-table-cell--today' : ''}`}>
                      {due.text}
                    </div>
                  );
                case 'priority':
                  return (
                    <div key={col.key} className="av-table-cell">
                      <span className="av-table-priority-dot" style={{ background: pri }} />
                      <span style={{ textTransform: 'capitalize' }}>{action.priority}</span>
                    </div>
                  );
                case 'status':
                  return (
                    <div key={col.key} className={`av-table-cell ${action.status === 'in_progress' ? 'av-table-cell--clickable' : ''}`} onClick={() => action.status === 'in_progress' && navToInProgress(action)} title={action.status === 'in_progress' ? 'Resume — go to where this action is in progress' : ''}>
                      <span className="av-table-status-badge" style={{ background: st.color + '14', color: st.color }}>
                        {st.icon} {st.label}
                      </span>
                    </div>
                  );
                case 'source':
                  return (
                    <div key={col.key} className="av-table-cell">
                      <span className="av-table-source-badge" style={{ background: src.bg, color: src.color, borderColor: src.border }}>
                        {src.label}
                      </span>
                    </div>
                  );
                case 'account':
                  return (
                    <div key={col.key} className="av-table-cell av-table-cell--truncate">
                      {action.deal?.account || action.prospect?.companyName || <span className="av-table-empty">—</span>}
                    </div>
                  );
                case 'stage':
                  return (
                    <div key={col.key} className="av-table-cell">
                      <span className="av-table-stage">{action.deal?.stage?.replace(/_/g, ' ') || action.prospect?.stage?.replace(/_/g, ' ') || '—'}</span>
                    </div>
                  );
                case 'internal':
                  return (
                    <div key={col.key} className="av-table-cell">
                      {action.isInternal ? '🏠 Internal' : '🌐 External'}
                    </div>
                  );
                case 'actions':
                  return (
                    <div key={col.key} className="av-table-cell av-table-cell--actions">
                      {!isComplete && action.status !== 'snoozed' && (
                        <button
                          className="av-table-start-btn"
                          style={{ background: ch.color + '14', color: ch.color, borderColor: ch.color + '40' }}
                          onClick={() => onStart(action)}
                        >
                          {ch.icon} →
                        </button>
                      )}
                      {action.status === 'snoozed' && (
                        <button
                          className="av-table-start-btn"
                          style={{ background: '#8b5cf614', color: '#8b5cf6', borderColor: '#8b5cf640' }}
                          onClick={() => onUnsnooze(action.id)}
                        >
                          ↑ Wake
                        </button>
                      )}
                    </div>
                  );
                default:
                  return <div key={col.key} className="av-table-cell">—</div>;
              }
            })}
          </div>
        );
      })}

      {sorted.length === 0 && (
        <div className="av-table-empty-state">No actions match the current filters.</div>
      )}
      </div>{/* end av-table-body */}
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
          {action.source === 'playbook' && (
            <span className="av-badge av-badge--playbook" title="Generated from playbook stage guidance"
              style={{ background: '#ebf8ff', color: '#2b6cb0', border: '1px solid #bee3f8' }}>📘 Playbook</span>
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

      {/* Prospect context */}
      {action.prospect && (
        <div className="av-card-context">
          <span style={{ color: '#0F9D8E', fontWeight: 600 }}>🎯 {action.prospect.firstName} {action.prospect.lastName}</span>
          {action.prospect.companyName && <span className="av-context-account">· {action.prospect.companyName}</span>}
          {action.prospect.stage && (
            <span className="av-context-stage" style={{ background: '#0F9D8E18', color: '#0F9D8E' }}>
              {action.prospect.stage.replace(/_/g, ' ')}
            </span>
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

      {/* Footer row: status stepper + resume + snooze button */}
      {!isSnoozed && (
        <div className="av-card-footer">
          <StatusStepper action={action} onStatusChange={onStatusChange} onStart={onStart} />
          <div className="av-card-footer-actions">
            <ResumeButton action={action} />
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
        </div>
      )}
    </div>
  );
}

// ── STRAP Pinned Card ────────────────────────────────────────────────────────

function StrapPinnedCard({ strap, expanded, onToggle, onResolve, onReassess, onUpdate }) {
  const [editingSection, setEditingSection] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [resolveMode, setResolveMode] = useState(false);
  const [progress, setProgress] = useState(null);

  const pri = PRIORITY_COLORS[strap.priority] || PRIORITY_COLORS.medium;
  const ent = STRAP_ENTITY_CONFIG[strap.entity_type] || STRAP_ENTITY_CONFIG.deal;
  const ctx = strap.entityContext || {};

  // Fetch progress when expanded (only once per expand)
  const progressFetched = React.useRef(false);
  useEffect(() => {
    if (expanded && !progressFetched.current) {
      progressFetched.current = true;
      apiService.straps.getProgress(strap.id)
        .then(res => setProgress(res.data?.progress || null))
        .catch(() => setProgress(null));
    }
    if (!expanded) {
      progressFetched.current = false;
    }
  }, [expanded, strap.id]);

  function startEdit(field, currentValue) {
    setEditingSection(field);
    setEditValue(currentValue || '');
  }

  async function saveEdit(field) {
    setSaving(true);
    try {
      await onUpdate(strap.id, { [field]: editValue });
      setEditingSection(null);
    } catch (err) {
      alert('Failed to save: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  function navigateToEntity() {
    const tabMap = { deal: 'deals', account: 'accounts', prospect: 'prospecting', implementation: 'deals' };
    const tab = tabMap[strap.entity_type] || 'deals';
    const detail = { tab };
    if (strap.entity_type === 'deal' || strap.entity_type === 'implementation') detail.dealId = strap.entity_id;
    if (strap.entity_type === 'account') detail.accountId = strap.entity_id;
    window.dispatchEvent(new CustomEvent('navigate', { detail }));
  }

  return (
    <div className={`av-strap-card ${expanded ? 'av-strap-card--expanded' : ''}`}
         style={{ borderLeftColor: pri }}>
      {/* Collapsed header */}
      <div className="av-strap-header" onClick={onToggle}>
        <span className="av-strap-icon">S</span>
        <span className="av-strap-priority" style={{ background: pri + '14', color: pri, borderColor: pri + '40' }}>
          {strap.priority}
        </span>
        <span className="av-strap-entity-badge" style={{ background: ent.bg, color: ent.color }}>
          {ent.icon} {strap.entity_type}
        </span>
        <span className="av-strap-hurdle-title">{strap.hurdle_title}</span>
        {progress && progress.total > 0 && (
          <span className="av-strap-progress">
            <span className="av-strap-progress-bar">
              <span className="av-strap-progress-fill"
                style={{ width: `${progress.percent}%`, background: progress.percent === 100 ? '#10b981' : '#4f46e5' }}
              />
            </span>
            <span className="av-strap-progress-label" style={{ color: progress.percent === 100 ? '#059669' : '#6b7280' }}>
              {progress.completed}/{progress.total}
            </span>
          </span>
        )}
        <span className="av-strap-entity-name">{ctx.entityName}</span>
        <span className="av-strap-chevron">{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="av-strap-body">
          {/* S-T-R-A sections */}
          {STRAP_SECTIONS.map(sec => {
            const value = strap[sec.field] || '';
            const isEditing = editingSection === sec.field;
            return (
              <div key={sec.key} className="av-strap-section">
                <div className="av-strap-section-header">
                  <span className="av-strap-section-icon" style={{ background: sec.color }}>{sec.key}</span>
                  <span className="av-strap-section-label" style={{ color: sec.color }}>{sec.label}</span>
                  {!isEditing && (
                    <button className="av-strap-edit-btn" onClick={(e) => { e.stopPropagation(); startEdit(sec.field, value); }}>
                      ✎ Edit
                    </button>
                  )}
                </div>
                {isEditing ? (
                  <div className="av-strap-edit-area">
                    <textarea
                      className="av-strap-textarea"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      rows={sec.key === 'A' ? 5 : 3}
                      autoFocus
                    />
                    <div className="av-strap-edit-actions">
                      <button className="av-strap-save-btn" onClick={() => saveEdit(sec.field)} disabled={saving}>
                        {saving ? '…' : 'Save'}
                      </button>
                      <button className="av-strap-cancel-btn" onClick={() => setEditingSection(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className={`av-strap-section-content ${sec.key === 'A' ? 'av-strap-pre' : ''}`}>
                    {value || <span className="av-strap-empty">Not set</span>}
                  </div>
                )}
              </div>
            );
          })}

          {/* Meta */}
          <div className="av-strap-meta">
            <span>{strap.hurdle_type?.replace(/_/g, ' ')}</span>
            <span>{new Date(strap.created_at).toLocaleDateString()}</span>
            {strap.ai_model && <span>AI: {strap.ai_model}</span>}
            {strap.source === 'manual' && <span className="av-strap-manual-badge">Manual</span>}
            {strap.created_by_name && <span>By: {strap.created_by_name}</span>}
          </div>

          {/* Progress tracking */}
          {progress && progress.total > 0 && (
            <div className="av-strap-progress-section">
              <span className="av-strap-progress-section-label">📋 Action Progress</span>
              <span className="av-strap-progress-bar av-strap-progress-bar--large">
                <span className="av-strap-progress-fill"
                  style={{ width: `${progress.percent}%`, background: progress.percent === 100 ? '#10b981' : '#4f46e5' }}
                />
              </span>
              <span className="av-strap-progress-detail">
                {progress.completed} done · {progress.inProgress} in progress · {progress.pending} to do
              </span>
              {progress.percent === 100 && (
                <span className="av-strap-progress-complete">✓ All actions complete — ready to resolve</span>
              )}
            </div>
          )}

          {/* Footer actions */}
          <div className="av-strap-footer">
            {!resolveMode ? (
              <>
                <button className="av-strap-resolve-btn" onClick={() => setResolveMode(true)}>✓ Resolve</button>
                <button className="av-strap-action-btn" onClick={() => onReassess(strap.id)}>↻ Reassess</button>
                <button className="av-strap-action-btn" onClick={navigateToEntity}>
                  Open {strap.entity_type} →
                </button>
              </>
            ) : (
              <>
                <span className="av-strap-resolve-label">How resolved?</span>
                <button className="av-strap-resolve-opt av-strap-resolve-opt--cleared"
                  onClick={() => { onResolve(strap.id, 'manual', 'Hurdle cleared'); setResolveMode(false); }}>
                  ✓ Hurdle Cleared
                </button>
                <button className="av-strap-resolve-opt av-strap-resolve-opt--superseded"
                  onClick={() => { onResolve(strap.id, 'superseded', 'New hurdle identified'); setResolveMode(false); }}>
                  ↻ Superseded
                </button>
                <button className="av-strap-resolve-opt av-strap-resolve-opt--irrelevant"
                  onClick={() => { onResolve(strap.id, 'manual', 'No longer relevant'); setResolveMode(false); }}>
                  🚫 Not Relevant
                </button>
                <button className="av-strap-cancel-btn" onClick={() => setResolveMode(false)}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filter Bar ────────────────────────────────────────────────────────────────

function FilterBar({ filters, onChange, options }) {
  const hasFilters = filters.dealId || filters.accountId;
  return (
    <div className="av-filters">
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

      {/* Clear */}
      {hasFilters && (
        <button className="av-filter-clear" onClick={() => onChange('__reset__', null)}>
          ✕ Clear
        </button>
      )}
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

  // ── Scope toggle state ────────────────────────────────────────
  const [scope, setScope] = useState('mine');   // 'mine' | 'team' | 'org'
  const actionSource = 'all'; // simplified — column filters handle source filtering
  const [viewLayout, setViewLayout] = useState('table'); // 'table' | 'cards'
  const [hasTeam, setHasTeam] = useState(false);

  // ── STRAP state ────────────────────────────────────────────────
  const [straps, setStraps]               = useState([]);
  const [strapsLoading, setStrapsLoading] = useState(false);
  const [expandedStrap, setExpandedStrap] = useState(null);

  useEffect(() => {
    apiService.orgAdmin.getMyTeam()
      .then(r => setHasTeam(r.data.hasTeam))
      .catch(() => setHasTeam(false));
  }, []);

  // ── Fetch filter options, contacts, deals when scope changes ──
  const lastScopeFetch = React.useRef('');
  useEffect(() => {
    if (lastScopeFetch.current === scope) return;
    lastScopeFetch.current = scope;

    apiFetch(`/actions/filter-options?scope=${scope}`).then(data => setFilterOptions(data)).catch(() => {});
    apiFetch(`/contacts?scope=${scope}`).then(d => setContacts(d.contacts || [])).catch(() => {});
    apiFetch(`/deals?scope=${scope}`).then(d => setDeals(d.deals || [])).catch(() => {});
  }, [scope]);

  // ── Fetch STRAPs ────────────────────────────────────────────────
  // Uses a ref to avoid re-creating the callback and to skip duplicate fetches
  const strapsFetchKey = `${scope}|${actionSource}`;
  const lastStrapsFetch = React.useRef('');

  useEffect(() => {
    // Skip if we already fetched for this exact key
    if (lastStrapsFetch.current === strapsFetchKey) return;
    lastStrapsFetch.current = strapsFetchKey;

    let cancelled = false;
    setStrapsLoading(true);

    const params = { scope };
    if (actionSource === 'deals')       params.entityType = 'deal';
    if (actionSource === 'prospecting') params.entityType = 'prospect';

    apiService.straps.getAllActive(scope, params)
      .then(res => {
        if (!cancelled) setStraps(res.data?.straps || res.data || []);
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Failed to fetch STRAPs:', err);
          setStraps([]);
        }
      })
      .finally(() => {
        if (!cancelled) setStrapsLoading(false);
      });

    return () => { cancelled = true; };
  }, [strapsFetchKey, scope, actionSource]);

  // ── Filter STRAPs client-side to match active action filters ────
  const filteredStraps = straps.filter(s => {
    if (filters.dealId) {
      const did = parseInt(filters.dealId);
      if (s.entity_type === 'deal' && s.entity_id !== did) return false;
      if (s.entity_type === 'account' && s.entityContext?.accountId !== did) return false;
      if (s.entity_type !== 'deal' && s.entity_type !== 'account') return false;
    }
    if (filters.accountId) {
      const aid = parseInt(filters.accountId);
      if (s.entity_type === 'account' && s.entity_id !== aid) return false;
      if (s.entity_type === 'deal' && s.entityContext?.accountId !== aid) return false;
      if (s.entity_type !== 'deal' && s.entity_type !== 'account') return false;
    }
    return true;
  });

  // ── STRAP actions: resolve, reassess, update ────────────────────
  async function handleStrapResolve(strapId, resolutionType, note) {
    try {
      await apiService.straps.resolve(strapId, { resolutionType, note });
      setStraps(prev => prev.filter(s => s.id !== strapId));
      setExpandedStrap(null);
    } catch (err) {
      alert('Failed to resolve STRAP: ' + err.message);
    }
  }

  async function handleStrapReassess(strapId) {
    try {
      const res = await apiService.straps.reassess(strapId);
      const newStrap = res.data?.strap;
      if (newStrap) {
        setStraps(prev => prev.map(s => s.id === strapId ? { ...newStrap, entityContext: s.entityContext } : s));
      } else {
        setStraps(prev => prev.filter(s => s.id !== strapId));
      }
    } catch (err) {
      alert('Failed to reassess STRAP: ' + err.message);
    }
  }

  async function handleStrapUpdate(strapId, updates) {
    const res = await apiService.straps.update(strapId, updates);
    const updated = res.data?.strap;
    if (updated) {
      setStraps(prev => prev.map(s => s.id === strapId ? { ...s, ...updated } : s));
    }
  }

  // ── Fetch actions (unified) ───────────────────────────────────
  // Uses a key-based dedup to prevent duplicate fetches on re-renders.
  // actionsFetchKey changes only when scope, actionSource, or filters actually change.
  const actionsFetchKey = `${scope}|${actionSource}|${JSON.stringify(filters)}`;
  const lastActionsFetch = React.useRef('');

  const fetchActionsImpl = useCallback(async (activeFilters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();

      // Pass scope to backend
      params.set('scope', scope);

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

      const data = await apiFetch(`/actions/unified?${params.toString()}`);
      let rows = data.actions || [];

      // Client-side source filter
      if (activeFilters.source === 'ai')       rows = rows.filter(a => a.source === 'ai_generated');
      if (activeFilters.source === 'rules')    rows = rows.filter(a => a.source === 'auto_generated');
      if (activeFilters.source === 'playbook') rows = rows.filter(a => a.source === 'playbook');

      // Deals vs Prospecting source filter (uses actionSource from unified endpoint)
      if (actionSource === 'deals')       rows = rows.filter(a => a.actionSource === 'deal');
      if (actionSource === 'prospecting') rows = rows.filter(a => a.actionSource === 'prospecting');

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
  }, [scope, actionSource]);

  // Expose fetchActions for manual re-fetches (e.g. after generate)
  const fetchActions = useCallback((f) => {
    lastActionsFetch.current = ''; // force re-fetch
    return fetchActionsImpl(f);
  }, [fetchActionsImpl]);

  useEffect(() => {
    // Skip if we already fetched for this exact combination
    if (lastActionsFetch.current === actionsFetchKey) return;
    lastActionsFetch.current = actionsFetchKey;

    fetchActionsImpl(filters);
  }, [actionsFetchKey, filters, fetchActionsImpl]);

  function handleFilterChange(key, value) {
    if (key === '__reset__') { setFilters(DEFAULT_FILTERS); return; }
    setFilters(prev => ({ ...prev, [key]: value }));
  }

  async function handleStatusChange(actionId, newStatus) {
    try {
      // Find the action to determine which table to update
      const action = actions.find(a => a.id === actionId);
      const isProspecting = action?.actionSource === 'prospecting';

      if (isProspecting) {
        // Map ActionsView statuses to prospecting_actions statuses
        const statusMap = { yet_to_start: 'pending', in_progress: 'in_progress', completed: 'completed' };
        const mappedStatus = statusMap[newStatus] || newStatus;
        await apiFetch(`/prospecting-actions/${actionId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: mappedStatus }),
        });
      } else {
        await apiFetch(`/actions/${actionId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        });
      }

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
    const nextStep = action.nextStep || 'email';
    const emailNextSteps = ['email', 'follow_up'];

    if (emailNextSteps.includes(nextStep)) {
      // Email → opens composer (existing flow)
      setComposerAction(action);
      return;
    }

    // For all other channels: set status to in_progress, then open resource
    const person = action.contact || action.prospect || {};
    const dealId = action.deal?.id || null;

    // Attempt external navigation based on channel
    if (nextStep === 'call') {
      const phone = person.phone;
      if (phone) {
        window.open(`tel:${phone.replace(/\s/g, '')}`, '_self');
      }
    } else if (nextStep === 'linkedin') {
      const url = person.linkedinUrl;
      if (url) {
        window.open(url.startsWith('http') ? url : `https://${url}`, '_blank');
      }
    } else if (nextStep === 'whatsapp') {
      const phone = person.phone;
      if (phone) {
        const cleanPhone = phone.replace(/[\s\-()]/g, '').replace(/^\+/, '');
        window.open(`https://wa.me/${cleanPhone}`, '_blank');
      }
    } else if (nextStep === 'document') {
      // Best: go to deal detail page which has DealFilesPanel with deal-specific files
      if (dealId) {
        window.dispatchEvent(new CustomEvent('navigate', {
          detail: { tab: 'deals', dealId, resume: true },
        }));
      } else if (action.deal?.account) {
        // Account-level STRAP: go to accounts tab which shows all related deals
        const accountId = action.deal?.accountId || null;
        if (accountId) {
          window.dispatchEvent(new CustomEvent('navigate', {
            detail: { tab: 'accounts', accountId, resume: true },
          }));
        } else {
          window.dispatchEvent(new CustomEvent('navigate', {
            detail: { tab: 'files', resume: true },
          }));
        }
      } else {
        window.dispatchEvent(new CustomEvent('navigate', {
          detail: { tab: 'files', resume: true },
        }));
      }
    }

    // Set status to in_progress (async, non-blocking)
    handleStatusChange(action.id, 'in_progress').catch(() => {});

    // Open log modal so they can record the outcome
    setLogAction(action);
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
    const action = actions.find(a => a.id === actionId);
    const endpoint = action?.actionSource === 'prospecting'
      ? `/prospecting-actions/${actionId}/snooze`
      : `/actions/${actionId}/snooze`;
    await apiFetch(endpoint, {
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
      const action = actions.find(a => a.id === actionId);
      const endpoint = action?.actionSource === 'prospecting'
        ? `/prospecting-actions/${actionId}/unsnooze`
        : `/actions/${actionId}/unsnooze`;
      await apiFetch(endpoint, { method: 'PATCH' });
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
      const dealMsg = result.deal ? `${result.deal.inserted} deal action(s)` : '';
      const prospectMsg = result.prospecting ? `${result.prospecting.created} prospecting action(s)` : '';
      const parts = [dealMsg, prospectMsg].filter(Boolean).join(', ');
      alert(`✅ Generated ${parts || 'no new actions'}.${result.prospecting?.skipped ? ` Skipped ${result.prospecting.skipped} duplicate(s).` : ''}`);
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
              {scope !== 'mine' && (
                <span className="av-count" style={{ background: '#eef2ff', color: '#4338ca' }}>
                  {scope === 'team' ? '👥 Team' : '🏢 All Org'}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Scope toggle — only visible if user has subordinates */}
            {hasTeam && (
              <div style={{
                display: 'inline-flex', borderRadius: '8px', overflow: 'hidden',
                border: '1px solid #e2e4ea', fontSize: '13px',
              }}>
                {['mine', 'team', 'org'].map(s => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    style={{
                      padding: '6px 14px', border: 'none', cursor: 'pointer',
                      background: scope === s ? '#4f46e5' : '#fff',
                      color: scope === s ? '#fff' : '#4b5563',
                      fontWeight: scope === s ? 600 : 400,
                      transition: 'all 0.15s',
                    }}
                  >
                    {s === 'mine' ? 'My Actions' : s === 'team' ? 'My Team' : 'All Org'}
                  </button>
                ))}
              </div>
            )}
            <button
              className="av-generate-btn"
              onClick={handleGenerateActions}
              disabled={generating || loading}
            >
              {generating ? '⏳ Generating…' : '⚡ Generate Actions'}
            </button>
            <button onClick={() => csvExport(actions, EXPORT_COLUMNS.actions, `actions-${scope}-${new Date().toISOString().slice(0,10)}.csv`)} title="Export CSV"
              style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db',
                       background: '#fff', fontSize: 13, cursor: 'pointer' }}>
              📤 Export
            </button>
            <div style={{
              display: 'inline-flex', borderRadius: 8, overflow: 'hidden',
              border: '1px solid #e2e4ea', fontSize: 13,
            }}>
              <button
                onClick={() => setViewLayout('table')}
                title="Table view"
                style={{
                  padding: '6px 12px', border: 'none', cursor: 'pointer',
                  background: viewLayout === 'table' ? '#4f46e5' : '#fff',
                  color: viewLayout === 'table' ? '#fff' : '#4b5563',
                  fontWeight: viewLayout === 'table' ? 600 : 400,
                }}>
                ☰
              </button>
              <button
                onClick={() => setViewLayout('cards')}
                title="Card view"
                style={{
                  padding: '6px 12px', border: 'none', cursor: 'pointer',
                  background: viewLayout === 'cards' ? '#4f46e5' : '#fff',
                  color: viewLayout === 'cards' ? '#fff' : '#4b5563',
                  fontWeight: viewLayout === 'cards' ? 600 : 400,
                }}>
                ▦
              </button>
            </div>
          </div>
        </div>

        {/* Filters */}
        <FilterBar filters={filters} onChange={handleFilterChange} options={filterOptions} />

        {/* ── STRAP Pinned Section ──────────────────────────────────── */}
        {(filters.source === 'all' || filters.source === 'strap') && filteredStraps.length > 0 && (
          <div className="av-strap-section">
            <div className="av-strap-section-header">
              <div className="av-strap-section-title">
                <span>🎯 Active STRAPs</span>
                <span className="av-strap-count">{filteredStraps.length}</span>
              </div>
            </div>
            <div className="av-strap-list">
              {filteredStraps.map(s => (
                <StrapPinnedCard
                  key={s.id}
                  strap={s}
                  expanded={expandedStrap === s.id}
                  onToggle={() => setExpandedStrap(expandedStrap === s.id ? null : s.id)}
                  onResolve={handleStrapResolve}
                  onReassess={handleStrapReassess}
                  onUpdate={handleStrapUpdate}
                />
              ))}
            </div>
          </div>
        )}

        {/* No STRAPs when filtered */}
        {filters.source === 'strap' && filteredStraps.length === 0 && !strapsLoading && (
          <div className="av-empty">
            <div className="av-empty-icon">🎯</div>
            <p>No active STRAPs{filters.dealId || filters.accountId ? ' matching filters' : ''}.</p>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>Generate STRAPs from deal, account, or prospect detail pages.</p>
          </div>
        )}

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
        {!loading && !error && actions.length === 0 && filters.source !== 'strap' && (
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

        {/* Action list — hidden when source filter is strap only */}
        {!loading && !error && actions.length > 0 && filters.source !== 'strap' && (
          viewLayout === 'table' ? (
            <ActionsTable
              actions={actions}
              onStatusChange={handleStatusChange}
              onStart={handleStart}
              onSnoozeClick={setSnoozeAction}
              onUnsnooze={handleUnsnooze}
            />
          ) : (
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
          )
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
