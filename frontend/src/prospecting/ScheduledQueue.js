// ScheduledQueue.js — the "Scheduled" tab for auto-send sequences (Level 2).
//
// Lists pending auto-send emails (status 'scheduled', plus in-flight 'sending')
// for the current rep and lets them:
//   • edit subject/body  (PATCH /sequences/scheduled/:id) — the send time is
//     FIXED and never changes; editing only touches the content.
//   • skip this step      (POST  /sequences/scheduled/:id/skip)   — drops this
//     one email and advances the sequence to the next step.
//   • cancel              (POST  /sequences/scheduled/:id/cancel) — full
//     unenroll (stops the whole sequence for that prospect).
//
// Signature + From are applied AT SEND time on the backend; we surface the
// resolved preview read-only so the rep sees the full email that will go out.
// Once the firer claims a row it flips to 'sending' (canEdit/canSkip = false).

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const TEAL = '#0F9D8E';

function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

export default function ScheduledQueue({ onChanged, onCount }) {
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  // Per-row UI state: { [logId]: { open, subject, body, busy, error, savedAt } }
  const [edits,   setEdits]   = useState({});

  // Report the current count up so the tab label can show it.
  useEffect(() => { if (onCount) onCount(items.length); }, [items.length, onCount]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch('/sequences/scheduled');
      setItems(r.scheduled || []);
    } catch (err) {
      setError('Failed to load scheduled sends: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchEdit = (id, patch) =>
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const handleSave = async (item) => {
    const e = edits[item.id] || {};
    const subject = e.subject !== undefined ? e.subject : item.subject;
    const body    = e.body    !== undefined ? e.body    : item.body;
    patchEdit(item.id, { busy: true, error: null });
    try {
      const r = await apiFetch(`/sequences/scheduled/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ subject, body }),
      });
      const updated = r.scheduled || {};
      setItems(prev => prev.map(it => it.id === item.id
        ? { ...it, subject: updated.subject ?? subject, body: updated.body ?? body }
        : it));
      patchEdit(item.id, { busy: false, savedAt: Date.now(), subject: undefined, body: undefined });
    } catch (err) {
      // 409 → the firer claimed it mid-edit. Reload so the row reflects reality.
      patchEdit(item.id, { busy: false, error: err.message });
      if (/already sending|sent/i.test(err.message)) load();
    }
  };

  const handleSkip = async (item) => {
    if (!window.confirm(
      `Skip this email to ${item.prospect?.firstName || 'this prospect'}? ` +
      `The sequence will continue to the next step.`
    )) return;
    patchEdit(item.id, { busy: true, error: null });
    try {
      await apiFetch(`/sequences/scheduled/${item.id}/skip`, { method: 'POST', body: JSON.stringify({}) });
      setItems(prev => prev.filter(it => it.id !== item.id));
      if (onChanged) onChanged();
    } catch (err) {
      patchEdit(item.id, { busy: false, error: err.message });
      if (/already sending|sent/i.test(err.message)) load();
    }
  };

  const handleCancel = async (item) => {
    if (!window.confirm(
      `Cancel the whole sequence for ${item.prospect?.firstName || 'this prospect'}?\n\n` +
      `This unenrolls them — all pending steps are discarded. ` +
      `To drop just this one email, use "Skip" instead.`
    )) return;
    patchEdit(item.id, { busy: true, error: null });
    try {
      await apiFetch(`/sequences/scheduled/${item.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      // Cancel unenrolls — drop every row for that enrollment.
      setItems(prev => prev.filter(it => it.enrollmentId !== item.enrollmentId));
      if (onChanged) onChanged();
    } catch (err) {
      patchEdit(item.id, { busy: false, error: err.message });
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading scheduled sends…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && (
        <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626' }}>
          ⚠️ {error}
        </div>
      )}

      {items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🕒</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Nothing scheduled</div>
          <div style={{ fontSize: 13, color: '#9ca3af' }}>
            Auto-send emails appear here once a campaign is activated — you can edit, skip, or cancel them before they go out.
          </div>
        </div>
      ) : items.map(item => {
        const e         = edits[item.id] || {};
        const subject   = e.subject !== undefined ? e.subject : (item.subject || '');
        const body      = e.body    !== undefined ? e.body    : (item.body || '');
        const dirty     = (e.subject !== undefined && e.subject !== item.subject) ||
                          (e.body    !== undefined && e.body    !== item.body);
        const sending   = item.status === 'sending';
        const canEdit   = !!item.canEdit && !sending;
        const fullName  = [item.prospect?.firstName, item.prospect?.lastName].filter(Boolean).join(' ') || item.prospect?.email || 'Prospect';

        return (
          <div key={item.id} style={{
            border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflow: 'hidden',
            opacity: item.busy ? 0.7 : 1,
          }}>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 10, padding: '10px 14px', borderBottom: e.open ? '1px solid #f1f5f9' : 'none',
              cursor: 'pointer',
            }}
              onClick={() => patchEdit(item.id, { open: !e.open })}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {fullName}
                  {item.prospect?.companyName && (
                    <span style={{ fontWeight: 500, color: '#6b7280' }}> · {item.prospect.companyName}</span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 2 }}>
                  {item.sequenceName} · step {item.stepOrder} · {item.subject || '(no subject)'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {sending ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', background: '#fef3c7', padding: '3px 8px', borderRadius: 99 }}>
                    Sending…
                  </span>
                ) : (
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 99,
                    color: item.isOverdue ? '#b91c1c' : '#155e63',
                    background: item.isOverdue ? '#fee2e2' : '#e6f6f4',
                  }}>
                    {item.isOverdue ? 'Due now · ' : ''}{fmtWhen(item.scheduledSendAt)}
                  </span>
                )}
                <span style={{ fontSize: 14, color: '#9ca3af' }}>{e.open ? '▾' : '▸'}</span>
              </div>
            </div>

            {/* Body (expanded) */}
            {e.open && (
              <div style={{ padding: 14 }}>
                {/* From / signature preview (read-only) */}
                <div style={{ fontSize: 11.5, color: '#6b7280', marginBottom: 10, lineHeight: 1.5 }}>
                  <div>
                    <strong style={{ color: '#374151' }}>To:</strong> {item.prospect?.email || '—'}
                  </div>
                  {item.fromPreview && (
                    <div>
                      <strong style={{ color: '#374151' }}>From:</strong>{' '}
                      {item.fromPreview.displayName ? `${item.fromPreview.displayName} ` : ''}
                      &lt;{item.fromPreview.email}&gt;
                      <span style={{ color: '#9ca3af' }}> · applied on send</span>
                    </div>
                  )}
                </div>

                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Subject</label>
                <input
                  type="text"
                  value={subject}
                  disabled={!canEdit || item.busy}
                  onChange={ev => patchEdit(item.id, { subject: ev.target.value })}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px', marginBottom: 10,
                    border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13,
                    background: canEdit ? '#fff' : '#f9fafb', color: '#111827',
                  }}
                />

                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>Body</label>
                <textarea
                  value={body}
                  disabled={!canEdit || item.busy}
                  onChange={ev => patchEdit(item.id, { body: ev.target.value })}
                  rows={8}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                    border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, lineHeight: 1.5,
                    fontFamily: 'inherit', resize: 'vertical',
                    background: canEdit ? '#fff' : '#f9fafb', color: '#111827',
                  }}
                />
                {item.signaturePreview && (
                  <div style={{
                    marginTop: 8, padding: '8px 10px', background: '#f8fafc',
                    border: '1px dashed #e5e7eb', borderRadius: 7,
                    fontSize: 11.5, color: '#6b7280', whiteSpace: 'pre-wrap',
                  }}>
                    <div style={{ fontWeight: 600, color: '#9ca3af', marginBottom: 4 }}>Signature (added on send)</div>
                    {item.signaturePreview}
                  </div>
                )}

                {e.error && (
                  <div style={{ marginTop: 10, fontSize: 12, color: '#dc2626' }}>⚠️ {e.error}</div>
                )}
                {e.savedAt && !e.error && !dirty && (
                  <div style={{ marginTop: 10, fontSize: 12, color: '#059669' }}>✓ Saved</div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
                  <button
                    onClick={() => handleSave(item)}
                    disabled={!canEdit || !dirty || item.busy}
                    style={{
                      padding: '7px 16px', borderRadius: 7, border: 'none',
                      background: (!canEdit || !dirty) ? '#e5e7eb' : TEAL,
                      color: (!canEdit || !dirty) ? '#9ca3af' : '#fff',
                      fontSize: 12, fontWeight: 600,
                      cursor: (!canEdit || !dirty || item.busy) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {item.busy ? 'Saving…' : 'Save'}
                  </button>

                  <button
                    onClick={() => handleSkip(item)}
                    disabled={!item.canSkip || sending || item.busy}
                    title="Skip just this email; keep the sequence going"
                    style={{
                      padding: '7px 14px', borderRadius: 7,
                      border: '1px solid #e5e7eb', background: '#fff', color: '#374151',
                      fontSize: 12, fontWeight: 600,
                      cursor: (!item.canSkip || sending || item.busy) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    ⏭ Skip step
                  </button>

                  <button
                    onClick={() => handleCancel(item)}
                    disabled={item.busy}
                    title="Cancel the whole sequence for this prospect (unenroll)"
                    style={{
                      marginLeft: 'auto', padding: '7px 14px', borderRadius: 7,
                      border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c',
                      fontSize: 12, fontWeight: 600,
                      cursor: item.busy ? 'not-allowed' : 'pointer',
                    }}
                  >
                    ⏹ Cancel enrollment
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
