import React, { useState } from 'react';
import './SnoozeModal.css';

const DURATION_OPTIONS = [
  { value: '1_week',      label: '1 Week',             hint: 'Wake up in 7 days' },
  { value: '2_weeks',     label: '2 Weeks',            hint: 'Wake up in 14 days' },
  { value: '1_month',     label: '1 Month',            hint: 'Wake up in 30 days' },
  { value: 'stage_change',label: 'Until Stage Changes',hint: 'Reactivate when deal stage moves' },
  { value: 'indefinite',  label: 'Indefinitely',       hint: 'Only reactivate manually' },
];

export default function SnoozeModal({ action, onSnooze, onClose }) {
  const [reason,   setReason]   = useState('');
  const [duration, setDuration] = useState('');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  async function handleSnooze() {
    if (!reason.trim()) { setError('Please enter a reason for snoozing.'); return; }
    if (!duration)       { setError('Please select a snooze duration.');    return; }

    setSaving(true);
    setError('');
    try {
      await onSnooze(action.id, reason.trim(), duration);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to snooze action.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content snooze-modal" onClick={e => e.stopPropagation()}>

        <div className="modal-header">
          <h2>😴 Snooze Action</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="snooze-modal__body">
          <div className="snooze-modal__action-title">{action.title}</div>

          {/* Reason */}
          <div className="snooze-modal__field">
            <label className="snooze-modal__label" htmlFor="snooze-reason">
              Why are you snoozing this?
            </label>
            <textarea
              id="snooze-reason"
              className="snooze-modal__textarea"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Waiting for legal review to complete, following up next week…"
              rows={3}
              autoFocus
            />
          </div>

          {/* Duration */}
          <div className="snooze-modal__field">
            <label className="snooze-modal__label">Snooze until…</label>
            <div className="snooze-modal__durations">
              {DURATION_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`snooze-modal__duration-btn ${duration === opt.value ? 'active' : ''}`}
                  onClick={() => setDuration(opt.value)}
                  type="button"
                >
                  <span className="snooze-modal__duration-label">{opt.label}</span>
                  <span className="snooze-modal__duration-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {error && <div className="snooze-modal__error">{error}</div>}
        </div>

        <div className="snooze-modal__footer">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="snooze-modal__confirm-btn"
            onClick={handleSnooze}
            disabled={saving || !reason.trim() || !duration}
          >
            {saving ? '…' : '😴 Snooze Action'}
          </button>
        </div>

      </div>
    </div>
  );
}
