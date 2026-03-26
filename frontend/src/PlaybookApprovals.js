import { apiService } from './apiService';
// ============================================================
// ActionCRM Playbook Builder — C8: PlaybookApprovals (admin)
// File: frontend/src/PlaybookApprovals.js
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import './PlaybookApprovals.css';

const STATUS_LABELS = {
  draft:              { label: 'Draft',              cls: 'badge-draft' },
  submitted:          { label: 'Submitted',          cls: 'badge-review' },
  under_review:       { label: 'Under Review',       cls: 'badge-review' },
  changes_requested:  { label: 'Changes Requested',  cls: 'badge-warning' },
  approved:           { label: 'Approved',           cls: 'badge-live' },
  rejected:           { label: 'Rejected',           cls: 'badge-archived' },
};

export default function PlaybookApprovals() {
  const [registrations, setRegistrations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filterStatus, setFilterStatus] = useState('submitted');
  const [loading, setLoading] = useState(true);
  const [actionModal, setActionModal] = useState(null); // { type: 'reject'|'changes', id }
  const [actionText, setActionText] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiService.playbookBuilder.getRegistrations({
        status: filterStatus || undefined,
      });
      setRegistrations(res.registrations || []);
    } catch (err) {
      console.error('Failed to load registrations', err);
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (regId) => {
    if (!window.confirm('Approve this registration? This will create the playbook.')) return;
    setWorking(true);
    try {
      await apiService.playbookBuilder.approveRegistration(regId);
      setSelected(null);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const openActionModal = (type, regId) => {
    setActionModal({ type, id: regId });
    setActionText('');
  };

  const handleModalAction = async () => {
    if (!actionText.trim()) {
      alert('Please provide a reason or notes.');
      return;
    }
    setWorking(true);
    try {
      if (actionModal.type === 'reject') {
        await apiService.playbookBuilder.rejectRegistration(actionModal.id, actionText);
      } else {
        await apiService.playbookBuilder.requestChanges(actionModal.id, actionText);
      }
      setActionModal(null);
      setActionText('');
      setSelected(null);
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      setWorking(false);
    }
  };

  const pendingCount = registrations.filter((r) =>
    ['submitted', 'under_review'].includes(r.status)
  ).length;

  return (
    <div className="pb-approvals">
      {/* Header */}
      <div className="pb-approvals-header">
        <h2>
          Playbook Approvals
          {pendingCount > 0 && (
            <span className="badge-alert">{pendingCount}</span>
          )}
        </h2>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="pb-filter-select"
        >
          <option value="">All</option>
          <option value="submitted">Submitted</option>
          <option value="under_review">Under Review</option>
          <option value="changes_requested">Changes Requested</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="pb-approvals-layout">
        {/* List pane */}
        <div className="pb-approvals-list">
          {loading && <div className="pb-loading">Loading…</div>}
          {!loading && registrations.length === 0 && (
            <div className="pb-empty">No registrations with this status.</div>
          )}
          {registrations.map((reg) => {
            const badge =
              STATUS_LABELS[reg.status] || STATUS_LABELS.submitted;
            return (
              <div
                key={reg.id}
                className={`approval-card ${
                  selected?.id === reg.id ? 'approval-card--selected' : ''
                }`}
                onClick={() => setSelected(reg)}
              >
                <div className="approval-card-header">
                  <span className="approval-name">{reg.name}</span>
                  <span className={`pb-badge ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>
                <div className="approval-card-meta">
                  <span>{reg.type}</span>
                  {reg.department && <span> · {reg.department}</span>}
                  <span> · {reg.submitter_name}</span>
                </div>
                {reg.submitted_at && (
                  <div className="approval-card-date">
                    {new Date(reg.submitted_at).toLocaleDateString()}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Detail pane */}
        {selected && (
          <div className="pb-approval-detail">
            <div className="approval-detail-header">
              <h3>{selected.name}</h3>
              <span
                className={`pb-badge ${
                  STATUS_LABELS[selected.status]?.cls ?? 'badge-draft'
                }`}
              >
                {STATUS_LABELS[selected.status]?.label ?? selected.status}
              </span>
            </div>

            <div className="approval-detail-grid">
              <div className="approval-detail-row">
                <strong>Type:</strong> {selected.type}
              </div>
              {selected.department && (
                <div className="approval-detail-row">
                  <strong>Dept:</strong> {selected.department}
                </div>
              )}
              <div className="approval-detail-row">
                <strong>Entity:</strong> {selected.entity_type}
              </div>
              <div className="approval-detail-row">
                <strong>Trigger:</strong> {selected.trigger_mode}
              </div>
              <div className="approval-detail-row">
                <strong>Conflict rule:</strong> {selected.conflict_rule}
              </div>
              <div className="approval-detail-row">
                <strong>Submitted by:</strong> {selected.submitter_name}
              </div>
              {selected.submitted_at && (
                <div className="approval-detail-row">
                  <strong>Submitted:</strong>{' '}
                  {new Date(selected.submitted_at).toLocaleDateString()}
                </div>
              )}
            </div>

            <div className="approval-purpose">
              <strong>Purpose</strong>
              <p>{selected.purpose}</p>
            </div>

            {selected.eligibility_filter && (
              <div className="approval-detail-row">
                <strong>Eligibility filter:</strong>{' '}
                <code>{selected.eligibility_filter}</code>
              </div>
            )}

            {selected.rejection_reason && (
              <div className="approval-reason-box">
                <strong>Notes / Reason:</strong>
                <p>{selected.rejection_reason}</p>
              </div>
            )}

            {['submitted', 'under_review'].includes(selected.status) && (
              <div className="approval-actions">
                <button
                  className="btn-primary"
                  onClick={() => handleApprove(selected.id)}
                  disabled={working}
                >
                  ✓ Approve &amp; Create Playbook
                </button>
                <button
                  className="btn-warning"
                  onClick={() => openActionModal('changes', selected.id)}
                  disabled={working}
                >
                  ↩ Request Changes
                </button>
                <button
                  className="btn-danger"
                  onClick={() => openActionModal('reject', selected.id)}
                  disabled={working}
                >
                  ✕ Reject
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reject / Request-changes modal */}
      {actionModal && (
        <div className="modal-overlay" onClick={() => setActionModal(null)}>
          <div
            className="modal-box"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              {actionModal.type === 'reject'
                ? 'Reject Registration'
                : 'Request Changes'}
            </h3>
            <p>
              {actionModal.type === 'reject'
                ? 'Provide a reason for rejection. The submitter will see this.'
                : 'Describe the changes needed. The submitter can update and resubmit.'}
            </p>
            <textarea
              value={actionText}
              onChange={(e) => setActionText(e.target.value)}
              rows={4}
              placeholder="Enter reason or notes…"
            />
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => setActionModal(null)}
                disabled={working}
              >
                Cancel
              </button>
              <button
                className={
                  actionModal.type === 'reject' ? 'btn-danger' : 'btn-warning'
                }
                onClick={handleModalAction}
                disabled={working}
              >
                {working
                  ? 'Saving…'
                  : actionModal.type === 'reject'
                  ? 'Reject'
                  : 'Send Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
