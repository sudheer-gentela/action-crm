// EnrollmentActionModal.js — reason capture for stopping or removing an
// enrollment from the campaign. Mirrors DiscardProspectModal's style.
//
// Two modes:
//   mode='stop'   → POST /sequences/enrollments/:id/stop  { reason }
//                   Pauses sends; prospect STAYS in its current stage.
//   mode='remove' → POST /sequences/enrollments/:id/remove { toStage, reasonCode, reason }
//                   Stops the enrollment, discards unsent drafts, and moves the
//                   prospect to a chosen stage (default 'disqualified').
//                   campaign_id is preserved (attribution kept).
//
// Reason codes match the backend's disqualified reason codes so a
// toStage='disqualified' removal records a structured reason on the prospect.

import React, { useState } from 'react';
import { apiFetch } from './prospectingShared';

// Codes must match VALID_DQ_REASON_CODES (backend prospects.routes.js) and
// REMOVE_DQ_REASON_CODES (backend sequences.routes.js).
const REASONS = [
  { code: 'account_not_fit', label: 'Account not a fit', hint: 'Wrong industry, size, geography, segment (e.g. federal-only).' },
  { code: 'contact_not_fit', label: 'Contact not a fit', hint: 'Wrong role/seniority, or left the company.' },
  { code: 'timing',          label: 'Timing not right',  hint: 'Good fit, just not now.' },
  { code: 'competitor',      label: 'Using a competitor',hint: 'Committed to a competing vendor.' },
  { code: 'no_budget',       label: 'No budget',         hint: 'Budget frozen or unavailable.' },
  { code: 'duplicate',       label: 'Duplicate',         hint: 'Same person already in the system.' },
  { code: 'other',           label: 'Other',             hint: 'None of the above — use the note.' },
];

// Destinations must match REMOVE_DESTINATIONS (backend sequences.routes.js).
const STAGES = [
  { value: 'disqualified', label: 'Disqualified', hint: 'Default. Terminal — leaves the active funnel, not re-surfaced as a candidate.' },
  { value: 'nurture',      label: 'Nurture',      hint: 'Park for later; revisit down the line.' },
  { value: 'research',     label: 'Back to Research', hint: 'Re-work — keeps any research notes, re-addable.' },
  { value: 'target',       label: 'Back to Target',   hint: 'Re-work from scratch, re-addable.' },
];

function EnrollmentActionModal({ mode = 'remove', enrollment, onClose, onDone }) {
  const isRemove = mode === 'remove';
  const [toStage, setToStage]       = useState('disqualified');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote]             = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);

  const name = `${enrollment?.first_name || ''} ${enrollment?.last_name || ''}`.trim() || 'this prospect';
  const selectedReason = REASONS.find(r => r.code === reasonCode);
  const reasonRequired = isRemove && toStage === 'disqualified';

  const handleSubmit = async () => {
    if (reasonRequired && !reasonCode) {
      setError('Please pick a reason for disqualifying.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (isRemove) {
        await apiFetch(`/sequences/enrollments/${enrollment.id}/remove`, {
          method: 'POST',
          body: JSON.stringify({
            toStage,
            reasonCode: reasonCode || null,
            reason:     note.trim() || null,
          }),
        });
      } else {
        // Stop mode — store a human-readable reason string in stop_reason.
        const label = selectedReason ? selectedReason.label : null;
        const reasonStr = [label, note.trim() || null].filter(Boolean).join(' — ') || 'manual';
        await apiFetch(`/sequences/enrollments/${enrollment.id}/stop`, {
          method: 'POST',
          body: JSON.stringify({ reason: reasonStr }),
        });
      }
      onDone();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const title = isRemove ? `Remove ${name} from campaign` : `Stop sequence for ${name}`;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(15,23,42,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, width: 460, maxWidth: '92vw',
          padding: '22px 24px', boxShadow: '0 12px 40px rgba(0,0,0,0.22)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: '#6b7280', marginBottom: 16 }}>
          {isRemove
            ? 'Stops the sequence, discards any unsent drafts, and moves the prospect to the stage you pick. The prospect stays in the campaign for attribution.'
            : 'No further steps will fire. The prospect keeps its current pipeline stage.'}
        </div>

        {isRemove && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Move to stage</div>
            <select
              value={toStage}
              onChange={e => setToStage(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}
            >
              {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              {STAGES.find(s => s.value === toStage)?.hint}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
            Reason {reasonRequired ? <span style={{ color: '#dc2626' }}>*</span> : <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span>}
          </div>
          <select
            value={reasonCode}
            onChange={e => setReasonCode(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}
          >
            <option value="">— Select a reason —</option>
            {REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
          {selectedReason && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{selectedReason.hint}</div>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Note (optional)</div>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
            placeholder="Anything worth recording against this prospect…"
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, cursor: submitting ? 'not-allowed' : 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: isRemove ? '#dc2626' : '#b45309', color: '#fff', fontSize: 13, fontWeight: 600, cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? 'Working…' : (isRemove ? 'Remove from campaign' : 'Stop sequence')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EnrollmentActionModal;
