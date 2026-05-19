// LogCallModal.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState } from 'react';
import { apiFetch } from './prospectingShared';

function LogCallModal({ prospect, settings, onSaved, onClose, sequenceStepLogId, taskNote, sequenceContext, editingCallId = null, prefilledDurationSec = null }) {
  // Form state. occurred_at defaults to "now" in datetime-local format.
  const localNow = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); // shift for local input
    return d.toISOString().slice(0, 16);  // YYYY-MM-DDTHH:MM
  };
  // Default callback date — 1 business day from now at 10am local
  const defaultCallbackAt = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const [occurredAt, setOccurredAt] = useState(localNow());
  const [outcomeKey, setOutcomeKey] = useState('');
  const [durationMin, setDurationMin] = useState(
    prefilledDurationSec ? String(Math.round((prefilledDurationSec / 60) * 10) / 10) : ''
  );   // input as minutes; converted to seconds on save
  const [phoneUsed, setPhoneUsed] = useState(prospect?.phone || '');
  // Phase 2: pre-fill notes with the sequence step's task_note when this
  // modal opens from a sequence call task. The rep can edit before saving.
  const [notes, setNotes] = useState(taskNote || '');
  // Phase 2: callback_requested_at — shown only when outcome is
  // 'callback_requested'. Defaults to next business day at 10am.
  const [callbackAt, setCallbackAt] = useState(defaultCallbackAt());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Outcome metadata derived from the selected key. Drives:
  //   - whether the duration field is shown (no_answer / wrong_number /
  //     gatekeeper hide it because there's no connection to measure)
  //   - whether the callback date field is shown
  //   - placeholder text in the notes field
  const OUTCOMES_NO_DURATION = new Set(['no_answer', 'wrong_number', 'gatekeeper']);
  const showDuration = outcomeKey && !OUTCOMES_NO_DURATION.has(outcomeKey);
  const showCallbackAt = outcomeKey === 'callback_requested';

  const notesPlaceholder = (() => {
    if (!outcomeKey) return 'What happened on the call?';
    if (outcomeKey === 'connected_meaningful' || outcomeKey === 'connected_brief') {
      return 'What did you discuss? Any specific next steps the prospect mentioned?';
    }
    if (outcomeKey === 'voicemail_left') return 'Brief context for the voicemail you left';
    if (outcomeKey === 'callback_requested') return 'Why did they ask for a callback? What should you cover when you call back?';
    if (outcomeKey === 'do_not_call') return 'Any context worth recording for compliance?';
    return 'Optional notes';
  })();

  const handleSave = async () => {
    if (!outcomeKey) { setError('Pick an outcome'); return; }
    if (!prospect?.id) { setError('No prospect loaded'); return; }
    setSaving(true);
    setError(null);
    try {
      const body = {
        prospect_id: prospect.id,
        outcome: outcomeKey,
        occurred_at: occurredAt ? new Date(occurredAt).toISOString() : undefined,
        notes: notes.trim() || undefined,
        phone_used: phoneUsed.trim() || undefined,
      };
      if (showDuration && durationMin && Number(durationMin) > 0) {
        body.duration_seconds = Math.round(Number(durationMin) * 60);
      }
      // Phase 2: when outcome is callback_requested, capture the timestamp
      // the prospect asked us to call back at.
      if (showCallbackAt && callbackAt) {
        body.callback_requested_at = new Date(callbackAt).toISOString();
      }
      // Phase 2: link to the sequence step log so the backend advances
      // the sequence in the same transaction.
      if (sequenceStepLogId) {
        body.sequence_step_log_id = sequenceStepLogId;
      }
      if (editingCallId) {
        // Editing an existing terminal call row whose outcome was never
        // captured — PATCH that row instead of creating a new call.
        await apiFetch(`/prospect-calls/${editingCallId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch('/prospect-calls', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      await onSaved();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Group outcomes by their `group` for visual separation in the dropdown.
  // Defaults shown when settings is still loading.
  const outcomes = settings?.outcomes || [];
  const outcomesByGroup = {};
  outcomes.forEach(o => {
    const g = o.group || 'other';
    if (!outcomesByGroup[g]) outcomesByGroup[g] = [];
    outcomesByGroup[g].push(o);
  });
  const GROUP_LABELS = {
    connected:  'Connected',
    no_contact: 'No contact',
    blocker:    'Blocker',
    other:      'Other',
  };
  const groupOrder = ['connected', 'no_contact', 'blocker', 'other'].filter(g => outcomesByGroup[g]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1100,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 480, maxWidth: '92vw', maxHeight: '92vh', overflowY: 'auto',
          background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1a202c' }}>
              📞 Log call
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {prospect.first_name} {prospect.last_name}
              {prospect.title && ` · ${prospect.title}`}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, color: '#9ca3af', cursor: 'pointer', padding: 0, lineHeight: 1 }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '14px 18px' }}>

          {/* Sequence context banner — shown when modal opens from a sequence task.
              Tells the rep this call is part of a sequence step so they know the
              sequence will advance on save. */}
          {sequenceStepLogId && sequenceContext && (
            <div style={{
              marginBottom: 14, padding: '8px 10px',
              background: '#eff6ff', border: '1px solid #bfdbfe',
              borderRadius: 6, fontSize: 12, color: '#1e40af',
            }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                📨 Sequence step
              </div>
              <div>
                {sequenceContext.sequence_name} — step {sequenceContext.step_order}.
                Saving this call will mark the step done and advance the sequence.
              </div>
            </div>
          )}

          {/* When */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
              When
            </label>
            <input
              type="datetime-local"
              value={occurredAt}
              onChange={e => setOccurredAt(e.target.value)}
              style={{
                width: '100%', padding: '7px 10px', fontSize: 13,
                border: '1px solid #d1d5db', borderRadius: 6, color: '#1a202c',
              }}
            />
          </div>

          {/* Outcome */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
              Outcome <span style={{ color: '#dc2626' }}>*</span>
            </label>
            {!settings ? (
              <div style={{ fontSize: 12, color: '#9ca3af', padding: '7px 0' }}>Loading outcomes…</div>
            ) : (
              <select
                value={outcomeKey}
                onChange={e => setOutcomeKey(e.target.value)}
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 13,
                  border: '1px solid #d1d5db', borderRadius: 6, color: '#1a202c',
                  background: '#fff',
                }}
              >
                <option value="">— Select outcome —</option>
                {groupOrder.map(g => (
                  <optgroup key={g} label={GROUP_LABELS[g] || g}>
                    {outcomesByGroup[g].map(o => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>

          {/* Duration — only shown for outcomes where a connection was made */}
          {showDuration && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Duration (minutes)
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={durationMin}
                onChange={e => setDurationMin(e.target.value)}
                placeholder={
                  outcomeKey === 'voicemail_left' ? '1' :
                  outcomeKey === 'connected_meaningful' ? '10' : ''
                }
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 13,
                  border: '1px solid #d1d5db', borderRadius: 6, color: '#1a202c',
                }}
              />
            </div>
          )}

          {/* Callback date — only shown for outcome=callback_requested */}
          {showCallbackAt && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Call back at <span style={{ color: '#9a3412' }}>*</span>
              </label>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                When did the prospect ask you to call back? This shows up in your Calls inbox so you don't miss it.
              </div>
              <input
                type="datetime-local"
                value={callbackAt}
                onChange={e => setCallbackAt(e.target.value)}
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 13,
                  border: '1px solid #d1d5db', borderRadius: 6, color: '#1a202c',
                }}
              />
            </div>
          )}

          {/* Phone */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
              Phone called {!prospect?.phone && <span style={{ color: '#9a3412', fontWeight: 500 }}>(no phone on file)</span>}
            </label>
            <input
              type="tel"
              value={phoneUsed}
              onChange={e => setPhoneUsed(e.target.value)}
              placeholder="+1 (415) 555-1234"
              style={{
                width: '100%', padding: '7px 10px', fontSize: 13,
                border: '1px solid #d1d5db', borderRadius: 6, color: '#1a202c',
              }}
            />
          </div>

          {/* Notes */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
              Notes
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={notesPlaceholder}
              rows={4}
              style={{
                width: '100%', padding: '7px 10px', fontSize: 13,
                border: '1px solid #d1d5db', borderRadius: 6, color: '#1a202c',
                resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </div>

          {error && (
            <div style={{
              padding: '7px 10px', background: '#fef2f2', border: '1px solid #fecaca',
              color: '#991b1b', borderRadius: 6, fontSize: 12, marginBottom: 12,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px', borderTop: '1px solid #e5e7eb',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          background: '#f9fafb', borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '7px 14px', background: '#fff', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6,
              fontSize: 13, fontWeight: 500,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !outcomeKey}
            style={{
              padding: '7px 14px', background: outcomeKey && !saving ? '#9a3412' : '#d1d5db',
              color: '#fff', border: 'none', borderRadius: 6,
              fontSize: 13, fontWeight: 600,
              cursor: (saving || !outcomeKey) ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save call log'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// DISCARD PROSPECT MODAL
// Structured-reason disqualification for one or many prospects.
// Used from:
//   - Detail panel "Move Stage" → disqualified
//   - Bulk action bar "🗑 Discard"
//   - Per-card ⋯ menu → "Discard"
// ═════════════════════════════════════════════════════════════════════════════

// ── Shared ⋯ menu for prospect cards/rows ─────────────────────────────────
// Currently only "Discard" — room to grow (Move stage, Add tag, etc.).
// Uses inline popover; closes on outside click or selection.

export default LogCallModal;
