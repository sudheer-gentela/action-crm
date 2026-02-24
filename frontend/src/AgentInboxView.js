import React, { useState, useEffect, useCallback } from 'react';
import './AgentInboxView.css';

const API = process.env.REACT_APP_API_URL || '';

// ── Constants ────────────────────────────────────────────────────────────────

const PROPOSAL_TYPE_CONFIG = {
  create_contact:    { icon: '👤', label: 'Create Contact',    color: '#3b82f6' },
  update_deal_stage: { icon: '📊', label: 'Update Deal Stage', color: '#8b5cf6' },
  draft_email:       { icon: '✉️', label: 'Draft Email',       color: '#f59e0b' },
  schedule_meeting:  { icon: '📅', label: 'Schedule Meeting',  color: '#10b981' },
  flag_risk:         { icon: '⚠️', label: 'Flag Risk',         color: '#ef4444' },
  update_contact:    { icon: '📝', label: 'Update Contact',    color: '#6366f1' },
  link_contact_deal: { icon: '🔗', label: 'Link Contact',      color: '#14b8a6' },
};

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   color: '#f59e0b', bg: '#fef3c7' },
  approved:  { label: 'Approved',  color: '#10b981', bg: '#d1fae5' },
  executing: { label: 'Running',   color: '#3b82f6', bg: '#dbeafe' },
  executed:  { label: 'Executed',  color: '#059669', bg: '#d1fae5' },
  rejected:  { label: 'Rejected',  color: '#ef4444', bg: '#fee2e2' },
  failed:    { label: 'Failed',    color: '#dc2626', bg: '#fee2e2' },
  expired:   { label: 'Expired',   color: '#6b7280', bg: '#f3f4f6' },
};

const CONFIDENCE_THRESHOLDS = {
  high:   { min: 0.75, color: '#059669', bg: '#d1fae5', label: 'High' },
  medium: { min: 0.50, color: '#d97706', bg: '#fef3c7', label: 'Medium' },
  low:    { min: 0.00, color: '#6b7280', bg: '#f3f4f6', label: 'Low' },
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

function getConfidenceLevel(confidence) {
  if (confidence == null) return CONFIDENCE_THRESHOLDS.low;
  if (confidence >= 0.75) return CONFIDENCE_THRESHOLDS.high;
  if (confidence >= 0.50) return CONFIDENCE_THRESHOLDS.medium;
  return CONFIDENCE_THRESHOLDS.low;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function proposalSummary(p) {
  const payload = p.payload || {};
  switch (p.proposalType) {
    case 'create_contact':
      return `${payload.first_name || ''} ${payload.last_name || ''} — ${payload.email || payload.title || 'New contact'}`.trim();
    case 'update_deal_stage':
      return `${payload.current_stage || '?'} → ${payload.proposed_stage || '?'}`;
    case 'draft_email':
      return payload.subject || 'Email draft';
    case 'schedule_meeting':
      return payload.title || 'New meeting';
    case 'flag_risk':
      return payload.reason || 'Deal risk flagged';
    case 'update_contact':
      return `Update ${payload.title || payload.role_type || 'contact info'}`;
    case 'link_contact_deal':
      return `Link as ${payload.role || 'stakeholder'}`;
    default:
      return p.proposalType;
  }
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function AgentInboxView() {
  const [proposals, setProposals]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [typeFilter, setTypeFilter]     = useState('');
  const [selected, setSelected]         = useState(new Set());
  const [detailId, setDetailId]         = useState(null);
  const [agentEnabled, setAgentEnabled] = useState(null);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch(`/agent/proposals?status=${statusFilter}${typeFilter ? '&proposalType=' + typeFilter : ''}`);
      setProposals(data.proposals || []);
    } catch (e) {
      setError(e.message || 'Failed to load proposals');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  // Check if agentic framework is enabled
  useEffect(() => {
    apiFetch('/agent/status')
      .then(data => setAgentEnabled(data.enabled))
      .catch(() => setAgentEnabled(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Actions ────────────────────────────────────────────────

  const handleApprove = async (id) => {
    try {
      await apiFetch(`/agent/proposals/${id}/approve`, { method: 'POST' });
      flash('success', 'Proposal approved and executed');
      load();
    } catch (e) { flash('error', e.message); }
  };

  const handleReject = async (id, reason = '') => {
    try {
      await apiFetch(`/agent/proposals/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      flash('success', 'Proposal rejected');
      load();
    } catch (e) { flash('error', e.message); }
  };

  const handleBulkApprove = async () => {
    if (selected.size === 0) return;
    try {
      await apiFetch('/agent/proposals/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ proposalIds: [...selected] }),
      });
      flash('success', `${selected.size} proposals approved`);
      setSelected(new Set());
      load();
    } catch (e) { flash('error', e.message); }
  };

  const handleBulkReject = async () => {
    if (selected.size === 0) return;
    try {
      await apiFetch('/agent/proposals/bulk-reject', {
        method: 'POST',
        body: JSON.stringify({ proposalIds: [...selected] }),
      });
      flash('success', `${selected.size} proposals rejected`);
      setSelected(new Set());
      load();
    } catch (e) { flash('error', e.message); }
  };

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === proposals.length) setSelected(new Set());
    else setSelected(new Set(proposals.map(p => p.id)));
  };

  // ── Not enabled state ──────────────────────────────────────

  if (agentEnabled === false) {
    return (
      <div className="ai-inbox-view">
        <div className="ai-inbox-header">
          <div>
            <h1>🤖 AI Agent</h1>
            <p className="ai-inbox-subtitle">AI-powered CRM automation with human-in-the-loop approval</p>
          </div>
        </div>
        <div className="ai-inbox-disabled">
          <div className="ai-inbox-disabled-icon">🤖</div>
          <h2>Agentic Framework Not Enabled</h2>
          <p>Ask your org admin to enable the AI Agent in Organisation Settings → AI Agent tab.</p>
          <p className="ai-inbox-disabled-hint">Once enabled, the agent will propose CRM actions like creating contacts, updating deal stages, and drafting emails — all requiring your approval before execution.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-inbox-view">
      {/* Header */}
      <div className="ai-inbox-header">
        <div>
          <h1>🤖 AI Agent Inbox</h1>
          <p className="ai-inbox-subtitle">
            Review and approve AI-proposed CRM actions
            {proposals.length > 0 && statusFilter === 'pending' && (
              <span className="ai-inbox-count-hint"> — {proposals.length} pending</span>
            )}
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Filters + Bulk actions */}
      <div className="ai-inbox-toolbar">
        <div className="ai-inbox-filters">
          <select
            className="ai-inbox-filter-select"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="pending">Pending</option>
            <option value="executed">Executed</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
            <option value="expired">Expired</option>
          </select>

          <select
            className="ai-inbox-filter-select"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          >
            <option value="">All Types</option>
            {Object.entries(PROPOSAL_TYPE_CONFIG).map(([key, cfg]) => (
              <option key={key} value={key}>{cfg.icon} {cfg.label}</option>
            ))}
          </select>
        </div>

        {statusFilter === 'pending' && proposals.length > 0 && (
          <div className="ai-inbox-bulk-actions">
            <button className="ai-inbox-select-all" onClick={toggleAll}>
              {selected.size === proposals.length ? '☑ Deselect all' : '☐ Select all'}
            </button>
            {selected.size > 0 && (
              <>
                <button className="ai-inbox-bulk-btn ai-inbox-bulk-approve" onClick={handleBulkApprove}>
                  ✓ Approve {selected.size}
                </button>
                <button className="ai-inbox-bulk-btn ai-inbox-bulk-reject" onClick={handleBulkReject}>
                  ✕ Reject {selected.size}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Proposals list */}
      {loading ? (
        <div className="sv-loading">Loading proposals…</div>
      ) : proposals.length === 0 ? (
        <div className="ai-inbox-empty">
          <div className="ai-inbox-empty-icon">🤖</div>
          <h3>No {statusFilter} proposals</h3>
          <p>
            {statusFilter === 'pending'
              ? 'The agent hasn\'t proposed any actions yet. Proposals will appear here as you use the CRM — generating actions, processing emails, and analyzing deals.'
              : `No proposals with status "${statusFilter}" found.`}
          </p>
        </div>
      ) : (
        <div className="ai-inbox-list">
          {proposals.map(p => {
            const typeCfg    = PROPOSAL_TYPE_CONFIG[p.proposalType] || { icon: '❓', label: p.proposalType, color: '#6b7280' };
            const confLevel  = getConfidenceLevel(p.confidence);
            const statusCfg  = STATUS_CONFIG[p.status] || STATUS_CONFIG.pending;
            const isSelected = selected.has(p.id);
            const isDetail   = detailId === p.id;

            return (
              <div
                key={p.id}
                className={`ai-inbox-card ${isSelected ? 'ai-inbox-card--selected' : ''} ${isDetail ? 'ai-inbox-card--active' : ''}`}
              >
                <div className="ai-inbox-card-main" onClick={() => setDetailId(isDetail ? null : p.id)}>
                  {/* Checkbox (pending only) */}
                  {p.status === 'pending' && (
                    <div className="ai-inbox-card-check" onClick={e => { e.stopPropagation(); toggleSelect(p.id); }}>
                      <input type="checkbox" checked={isSelected} readOnly />
                    </div>
                  )}

                  {/* Type icon */}
                  <div className="ai-inbox-card-type" style={{ background: typeCfg.color + '18', color: typeCfg.color }}>
                    <span className="ai-inbox-type-icon">{typeCfg.icon}</span>
                  </div>

                  {/* Content */}
                  <div className="ai-inbox-card-content">
                    <div className="ai-inbox-card-top">
                      <span className="ai-inbox-card-type-label" style={{ color: typeCfg.color }}>{typeCfg.label}</span>
                      {p.deal && <span className="ai-inbox-card-deal">· {p.deal.name}</span>}
                      <span className="ai-inbox-card-time">{timeAgo(p.createdAt)}</span>
                    </div>
                    <div className="ai-inbox-card-summary">{proposalSummary(p)}</div>
                    {p.reasoning && (
                      <div className="ai-inbox-card-reasoning">{p.reasoning.substring(0, 120)}{p.reasoning.length > 120 ? '…' : ''}</div>
                    )}
                  </div>

                  {/* Confidence badge */}
                  {p.confidence != null && (
                    <div className="ai-inbox-card-confidence" style={{ background: confLevel.bg, color: confLevel.color }}>
                      {Math.round(p.confidence * 100)}%
                    </div>
                  )}

                  {/* Status badge (non-pending) */}
                  {p.status !== 'pending' && (
                    <div className="ai-inbox-card-status" style={{ background: statusCfg.bg, color: statusCfg.color }}>
                      {statusCfg.label}
                    </div>
                  )}
                </div>

                {/* Quick actions (pending only) */}
                {p.status === 'pending' && (
                  <div className="ai-inbox-card-actions">
                    <button
                      className="ai-inbox-action-btn ai-inbox-approve-btn"
                      onClick={e => { e.stopPropagation(); handleApprove(p.id); }}
                      title="Approve and execute"
                    >
                      ✓ Approve
                    </button>
                    <button
                      className="ai-inbox-action-btn ai-inbox-reject-btn"
                      onClick={e => { e.stopPropagation(); handleReject(p.id); }}
                      title="Reject proposal"
                    >
                      ✕ Reject
                    </button>
                    <button
                      className="ai-inbox-action-btn ai-inbox-detail-btn"
                      onClick={e => { e.stopPropagation(); setDetailId(p.id); }}
                      title="View details and edit"
                    >
                      ✎ Review
                    </button>
                  </div>
                )}

                {/* Detail panel (expanded) */}
                {isDetail && <ProposalDetail proposal={p} onApprove={handleApprove} onReject={handleReject} onClose={() => setDetailId(null)} onRefresh={load} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Proposal Detail (Expanded Card) ──────────────────────────────────────────

function ProposalDetail({ proposal, onApprove, onReject, onClose, onRefresh }) {
  const [editPayload, setEditPayload] = useState(proposal.payload || {});
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [edited, setEdited] = useState(false);

  const p = proposal;
  const typeCfg = PROPOSAL_TYPE_CONFIG[p.proposalType] || { icon: '❓', label: p.proposalType, color: '#6b7280' };

  const handleFieldChange = (key, value) => {
    setEditPayload(prev => ({ ...prev, [key]: value }));
    setEdited(true);
  };

  const handleApproveWithEdits = async () => {
    setSaving(true);
    try {
      if (edited) {
        await apiFetch(`/agent/proposals/${p.id}/payload`, {
          method: 'PATCH',
          body: JSON.stringify({ payload: editPayload }),
        });
      }
      await onApprove(p.id);
    } catch (e) {
      console.error('Approve error:', e);
    } finally {
      setSaving(false);
    }
  };

  const handleRejectWithReason = async () => {
    setSaving(true);
    try {
      await onReject(p.id, rejectReason);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-detail-panel" onClick={e => e.stopPropagation()}>
      {/* Header */}
      <div className="ai-detail-header">
        <div>
          <span className="ai-detail-type" style={{ color: typeCfg.color }}>{typeCfg.icon} {typeCfg.label}</span>
          {p.deal && <span className="ai-detail-deal"> — {p.deal.name}</span>}
        </div>
        <button className="ai-detail-close" onClick={onClose}>✕</button>
      </div>

      {/* AI Reasoning */}
      {p.reasoning && (
        <div className="ai-detail-section">
          <div className="ai-detail-section-label">🤖 AI Reasoning</div>
          <div className="ai-detail-reasoning">{p.reasoning}</div>
        </div>
      )}

      {/* Deal Context */}
      {p.deal && (
        <div className="ai-detail-section">
          <div className="ai-detail-section-label">💼 Deal Context</div>
          <div className="ai-detail-deal-card">
            <div className="ai-detail-deal-name">{p.deal.name}</div>
            <div className="ai-detail-deal-meta">
              {p.deal.stage && <span>Stage: {p.deal.stage}</span>}
              {p.deal.value > 0 && <span>Value: ${parseFloat(p.deal.value).toLocaleString()}</span>}
              {p.deal.health && <span>Health: {p.deal.health}</span>}
            </div>
          </div>
        </div>
      )}

      {/* Editable Payload */}
      <div className="ai-detail-section">
        <div className="ai-detail-section-label">📋 Proposed Changes {p.status === 'pending' && '(editable)'}</div>
        <div className="ai-detail-payload">
          {renderPayloadFields(p.proposalType, editPayload, p.status === 'pending' ? handleFieldChange : null)}
        </div>
      </div>

      {/* Source info */}
      <div className="ai-detail-section ai-detail-meta-section">
        <div className="ai-detail-meta-row">
          <span className="ai-detail-meta-label">Source</span>
          <span className="ai-detail-meta-value">{p.source || '—'}</span>
        </div>
        <div className="ai-detail-meta-row">
          <span className="ai-detail-meta-label">Confidence</span>
          <span className="ai-detail-meta-value">{p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—'}</span>
        </div>
        <div className="ai-detail-meta-row">
          <span className="ai-detail-meta-label">Created</span>
          <span className="ai-detail-meta-value">{p.createdAt ? new Date(p.createdAt).toLocaleString() : '—'}</span>
        </div>
        {p.expiresAt && (
          <div className="ai-detail-meta-row">
            <span className="ai-detail-meta-label">Expires</span>
            <span className="ai-detail-meta-value">{new Date(p.expiresAt).toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Action bar (pending only) */}
      {p.status === 'pending' && (
        <div className="ai-detail-actions">
          {!showRejectForm ? (
            <>
              <button
                className="ai-detail-btn ai-detail-approve-btn"
                onClick={handleApproveWithEdits}
                disabled={saving}
              >
                {saving ? '⏳ Executing…' : edited ? '✓ Save & Approve' : '✓ Approve & Execute'}
              </button>
              <button
                className="ai-detail-btn ai-detail-reject-btn"
                onClick={() => setShowRejectForm(true)}
                disabled={saving}
              >
                ✕ Reject
              </button>
            </>
          ) : (
            <div className="ai-detail-reject-form">
              <textarea
                className="ai-detail-reject-input"
                placeholder="Why are you rejecting this? (optional — helps improve future suggestions)"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                rows={2}
              />
              <div className="ai-detail-reject-actions">
                <button
                  className="ai-detail-btn ai-detail-reject-btn"
                  onClick={handleRejectWithReason}
                  disabled={saving}
                >
                  {saving ? '⏳…' : '✕ Confirm Reject'}
                </button>
                <button className="ai-detail-btn ai-detail-cancel-btn" onClick={() => setShowRejectForm(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Execution result (executed/failed) */}
      {p.executionResult && (
        <div className="ai-detail-section">
          <div className="ai-detail-section-label">📦 Execution Result</div>
          <pre className="ai-detail-result">{JSON.stringify(p.executionResult, null, 2)}</pre>
        </div>
      )}
      {p.errorMessage && (
        <div className="ai-detail-section">
          <div className="ai-detail-section-label">❌ Error</div>
          <div className="ai-detail-error">{p.errorMessage}</div>
        </div>
      )}
    </div>
  );
}

// ── Payload field renderer per type ──────────────────────────────────────────

function renderPayloadFields(type, payload, onChange) {
  const readOnly = !onChange;
  const field = (key, label, multiline = false) => (
    <div key={key} className="ai-payload-field">
      <label className="ai-payload-label">{label}</label>
      {multiline ? (
        <textarea
          className="ai-payload-input ai-payload-textarea"
          value={payload[key] || ''}
          onChange={onChange ? (e => onChange(key, e.target.value)) : undefined}
          readOnly={readOnly}
          rows={4}
        />
      ) : (
        <input
          className="ai-payload-input"
          value={payload[key] || ''}
          onChange={onChange ? (e => onChange(key, e.target.value)) : undefined}
          readOnly={readOnly}
        />
      )}
    </div>
  );

  switch (type) {
    case 'create_contact':
      return (
        <div className="ai-payload-grid">
          {field('first_name', 'First Name')}
          {field('last_name', 'Last Name')}
          {field('email', 'Email')}
          {field('title', 'Title')}
          {field('role_type', 'Role')}
          {field('source_evidence', 'Evidence', true)}
        </div>
      );
    case 'update_deal_stage':
      return (
        <div className="ai-payload-grid">
          {field('current_stage', 'Current Stage')}
          {field('proposed_stage', 'Proposed Stage')}
          {field('reason', 'Reason', true)}
        </div>
      );
    case 'draft_email':
      return (
        <div className="ai-payload-grid">
          {field('subject', 'Subject')}
          {field('to_address', 'To')}
          {field('body', 'Email Body', true)}
        </div>
      );
    case 'schedule_meeting':
      return (
        <div className="ai-payload-grid">
          {field('title', 'Meeting Title')}
          {field('description', 'Description', true)}
          {field('meeting_type', 'Type')}
        </div>
      );
    case 'flag_risk':
      return (
        <div className="ai-payload-grid">
          {field('signal_key', 'Signal')}
          {field('reason', 'Reason', true)}
        </div>
      );
    case 'update_contact':
      return (
        <div className="ai-payload-grid">
          {field('title', 'New Title')}
          {field('role_type', 'New Role')}
          {field('engagement_level', 'Engagement')}
        </div>
      );
    case 'link_contact_deal':
      return (
        <div className="ai-payload-grid">
          {field('role', 'Role in Deal')}
        </div>
      );
    default:
      return (
        <pre className="ai-payload-raw">{JSON.stringify(payload, null, 2)}</pre>
      );
  }
}
