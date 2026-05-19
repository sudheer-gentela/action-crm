// DiscardProspectModal.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState } from 'react';
import { apiFetch } from './prospectingShared';

const DISCARD_REASONS = [
  { code: 'account_not_fit', label: 'Account not a fit',  hint: 'Wrong industry, size, geography, etc.' },
  { code: 'contact_not_fit', label: 'Contact not a fit',  hint: 'Wrong role, seniority, or left the company.' },
  { code: 'timing',          label: 'Timing not right',   hint: 'Good fit, but not buying right now.' },
  { code: 'competitor',      label: 'Using a competitor', hint: 'Committed to a competing vendor.' },
  { code: 'no_budget',       label: 'No budget',          hint: 'Budget frozen or not available.' },
  { code: 'duplicate',       label: 'Duplicate',          hint: 'Same person already in the system.' },
  { code: 'other',           label: 'Other',              hint: 'None of the above — use the note.' },
];

function DiscardProspectModal({ prospects, onDiscarded, onClose }) {
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote]             = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState(null);
  const [progress, setProgress]     = useState({ done: 0, total: prospects.length });

  const selectedReason = DISCARD_REASONS.find(r => r.code === reasonCode);
  const isBulk  = prospects.length > 1;

  const handleDiscard = async () => {
    if (!reasonCode) {
      setError('Please pick a reason.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setProgress({ done: 0, total: prospects.length });

    const failures = [];
    // Sequential rather than parallel — keeps the server load predictable and
    // gives us a clean progress readout. Bulk sizes are capped elsewhere.
    for (const p of prospects) {
      try {
        await apiFetch(`/prospects/${p.id}/stage`, {
          method: 'POST',
          body: JSON.stringify({
            stage:      'disqualified',
            reasonCode,
            reason:     note.trim() || null,
          }),
        });
      } catch (err) {
        failures.push({ prospect: p, message: err.message });
      }
      setProgress(prev => ({ done: prev.done + 1, total: prev.total }));
    }

    setSubmitting(false);

    if (failures.length === 0) {
      onDiscarded();
    } else if (failures.length === prospects.length) {
      setError(`All ${prospects.length} failed. First error: ${failures[0].message}`);
    } else {
      // Partial success — close the modal and surface via a light message.
      // The parent will refresh the list, so failures will appear as still-active.
      setError(
        `${prospects.length - failures.length} of ${prospects.length} discarded. ` +
        `${failures.length} failed (likely stage transition not allowed). ` +
        `See activity for details.`
      );
    }
  };

  const title = isBulk
    ? `Discard ${prospects.length} prospects`
    : `Discard ${prospects[0]?.first_name || ''} ${prospects[0]?.last_name || ''}`.trim() || 'Discard prospect';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12,
          width: 480, maxWidth: '90vw',
          maxHeight: '85vh', overflowY: 'auto',
          padding: '18px 20px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.15)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>🗑 {title}</h3>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{ background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: submitting ? 'not-allowed' : 'pointer' }}
          >✕</button>
        </div>

        {isBulk && (
          <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#92400e', marginBottom: 12 }}>
            The same reason will be applied to all {prospects.length} selected prospects.
          </div>
        )}

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>
          Reason <span style={{ color: '#dc2626' }}>*</span>
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {DISCARD_REASONS.map(r => (
            <label
              key={r.code}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 10px',
                border: `1.5px solid ${reasonCode === r.code ? '#0F9D8E' : '#e5e7eb'}`,
                borderRadius: 7,
                background: reasonCode === r.code ? '#ecfdf5' : '#fff',
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="radio"
                name="discard-reason"
                checked={reasonCode === r.code}
                onChange={() => setReasonCode(r.code)}
                disabled={submitting}
                style={{ marginTop: 2 }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{r.label}</div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>{r.hint}</div>
              </div>
            </label>
          ))}
        </div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>
          Note <span style={{ color: '#9ca3af', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
        </label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          disabled={submitting}
          rows={3}
          placeholder={
            selectedReason
              ? `Why "${selectedReason.label.toLowerCase()}"? Helps future reporting.`
              : 'Any extra context — appears in the activity log.'
          }
          style={{
            width: '100%', padding: '8px 10px',
            borderRadius: 7, border: '1px solid #e5e7eb',
            fontSize: 13, fontFamily: 'inherit',
            boxSizing: 'border-box', resize: 'vertical',
          }}
        />

        {error && (
          <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#dc2626', marginTop: 12 }}>
            ⚠️ {error}
          </div>
        )}

        {submitting && isBulk && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 12 }}>
            Discarding… {progress.done} / {progress.total}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: '8px 16px', borderRadius: 7,
              border: '1px solid #d1d5db', background: '#fff', color: '#374151',
              fontSize: 13, cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleDiscard}
            disabled={submitting || !reasonCode}
            style={{
              padding: '8px 18px', borderRadius: 7, border: 'none',
              background: (submitting || !reasonCode) ? '#9ca3af' : '#dc2626',
              color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: (submitting || !reasonCode) ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? '⏳ Discarding…' : (isBulk ? `🗑 Discard ${prospects.length}` : '🗑 Discard')}
          </button>
        </div>
      </div>
    </div>
  );
}



// ═════════════════════════════════════════════════════════════════════════════
// SEQUENCES VIEW
// Manage sequences + enrollments. Embedded in the Sequences tab of ProspectingView.
// ═════════════════════════════════════════════════════════════════════════════


export default DiscardProspectModal;
