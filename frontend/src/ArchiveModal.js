// ============================================================
// ActionCRM Playbook Builder — C10: ArchiveModal
// File: frontend/src/ArchiveModal.js
//
// ROUTING NOTE (C11) — add to frontend/src/App.js:
//
//   import PlaybooksView     from './PlaybooksView';
//   import PlaybookDetail    from './PlaybookDetail';
//   import PlaybookRegister  from './PlaybookRegister';
//   import PlaybookApprovals from './PlaybookApprovals';
//
//   Inside <Routes>:
//
//   <Route path="/playbooks" element={
//     <ProtectedRoute><PlaybooksView currentUser={currentUser} /></ProtectedRoute>
//   } />
//   <Route path="/playbooks/register" element={
//     <ProtectedRoute><PlaybookRegister /></ProtectedRoute>
//   } />
//   <Route path="/playbooks/:id" element={
//     <ProtectedRoute><PlaybookDetail currentUser={currentUser} /></ProtectedRoute>
//   } />
//   <Route path="/admin/playbooks" element={
//     <ProtectedRoute requireAdmin><PlaybookApprovals /></ProtectedRoute>
//   } />
//   <Route path="/admin/playbooks/registrations/:id" element={
//     <ProtectedRoute requireAdmin><PlaybookApprovals /></ProtectedRoute>
//   } />
//
//   Redirect old editor path:
//   <Route path="/playbook-plays-editor/:id"
//          element={<Navigate to="/playbooks" replace />} />
// ============================================================

import React, { useState } from 'react';
import './ArchiveModal.css';

const SUNSET_OPTIONS = [
  { days: 0,  label: 'Immediately' },
  { days: 3,  label: '3 days' },
  { days: 7,  label: '7 days (recommended)' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
];

export default function ArchiveModal({ playbook, onConfirm, onCancel }) {
  const [sunsetDays, setSunsetDays]   = useState(7);
  const [reason, setReason]           = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [confirmed, setConfirmed]     = useState(false);

  const handleConfirm = () => {
    if (!reason.trim()) return alert('Please provide an archive reason');
    onConfirm({
      reason,
      // Parse to integer so the backend FK comparison works correctly
      replacement_pb_id: replacementId ? parseInt(replacementId, 10) : null,
      sunset_days: sunsetDays,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box archive-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Archive Playbook</h3>
        <p className="archive-warning">
          Archiving <strong>{playbook.name}</strong> will stop all new action
          generation. Existing in-progress actions will complete within the
          sunset period.
        </p>

        <div className="form-section">
          <label className="form-label">Sunset Period</label>
          <div className="sunset-chips">
            {SUNSET_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                className={`sunset-chip ${sunsetDays === opt.days ? 'sunset-chip--active' : ''}`}
                onClick={() => setSunsetDays(opt.days)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-section">
          <label className="form-label">
            Replacement Playbook ID (optional)
            <input
              type="number"
              placeholder="Enter playbook ID of the successor"
              value={replacementId}
              onChange={(e) => setReplacementId(e.target.value)}
              min="1"
            />
            <span className="form-hint">
              If set, users will see a link to the replacement playbook.
            </span>
          </label>
        </div>

        <div className="form-section">
          <label className="form-label">
            Archive Reason *
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Superseded by updated Enterprise Deal Playbook v2"
              rows={3}
            />
          </label>
        </div>

        <div className="archive-confirm-check">
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {' '}I understand this will deactivate all plays and stop action
            generation after the sunset period.
          </label>
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="btn-danger"
            onClick={handleConfirm}
            disabled={!confirmed || !reason.trim()}
            type="button"
          >
            Archive Playbook
          </button>
        </div>
      </div>
    </div>
  );
}
