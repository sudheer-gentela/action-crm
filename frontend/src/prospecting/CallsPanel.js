// CallsPanel.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React from 'react';

function CallsPanel({ prospect, calls, pendingCallTasks = [], onLogCall, onLogCallFromTask, onCaptureOutcome }) {
  // Aggregates for the summary strip at the top.
  const total      = calls.length;
  const connected  = calls.filter(c =>
    c.outcome === 'connected_meaningful' ||
    c.outcome === 'connected_brief' ||
    c.outcome === 'callback_requested'
  ).length;
  const voicemail  = calls.filter(c => c.outcome === 'voicemail_left').length;
  const last       = calls[0]; // calls list is newest-first from the API

  // Color map for outcome groups. Mirrors the system-default groups
  // returned by /api/org/call-settings.
  const groupColor = (group) => {
    if (group === 'connected')  return { bg: '#dcfce7', border: '#86efac', fg: '#14532d' };
    if (group === 'no_contact') return { bg: '#fef3c7', border: '#fcd34d', fg: '#78350f' };
    if (group === 'blocker')    return { bg: '#fee2e2', border: '#fca5a5', fg: '#7f1d1d' };
    return                              { bg: '#f3f4f6', border: '#e5e7eb', fg: '#374151' };
  };

  // Compact relative time. Falls back to date if older than 30 days.
  const relTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60)        return 'just now';
    if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400*7)   return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 86400*30)  return `${Math.floor(diff / (86400 * 7))}w ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const fmtDuration = (sec) => {
    if (!sec || sec <= 0) return '';
    const min = Math.round(sec / 60);
    return min === 0 ? `${sec}s` : `${min} min`;
  };

  return (
    <div style={{ padding: '4px 0' }}>

      {/* CTA + phone row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {prospect.phone ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Phone on file:</span>
              <a href={`tel:${prospect.phone}`}
                 style={{ fontSize: 14, color: '#9a3412', fontWeight: 600, textDecoration: 'none' }}>
                {prospect.phone}
              </a>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
              No phone on file — add one when you log a call.
            </div>
          )}
        </div>
        <button
          onClick={onLogCall}
          style={{
            padding: '7px 14px', background: '#9a3412', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          📞 Log call
        </button>
      </div>

      {/* Summary strip */}
      {total > 0 && (
        <div style={{
          display: 'flex', gap: 12, padding: '10px 12px', marginBottom: 16,
          background: '#fff7ed', borderRadius: 6, border: '1px solid #fed7aa',
          fontSize: 12, color: '#7c2d12',
        }}>
          <div><strong>{total}</strong> total</div>
          <div style={{ color: '#14532d' }}><strong>{connected}</strong> connected</div>
          {voicemail > 0 && <div style={{ color: '#78350f' }}><strong>{voicemail}</strong> voicemail</div>}
          {last && <div style={{ marginLeft: 'auto', color: '#9a3412' }}>last: {relTime(last.occurred_at)}</div>}
        </div>
      )}

      {/* Pending call tasks — Phase 2. Shown above completed calls when
          this prospect has open sequence call drafts. */}
      {pendingCallTasks.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: '#3730a3', textTransform: 'uppercase',
            letterSpacing: 0.5, marginBottom: 8,
          }}>
            Pending call tasks ({pendingCallTasks.length})
          </div>
          {pendingCallTasks.map(draft => {
            const isOverdue = draft.scheduled_send_at && new Date(draft.scheduled_send_at) < new Date();
            return (
              <div
                key={draft.id}
                style={{
                  padding: '10px 12px', marginBottom: 8, borderRadius: 8,
                  background: '#eff6ff', border: `1px solid ${isOverdue ? '#fca5a5' : '#bfdbfe'}`,
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: isOverdue ? '#991b1b' : '#3730a3',
                      padding: '2px 6px', borderRadius: 4,
                      background: isOverdue ? '#fee2e2' : '#dbeafe',
                    }}>
                      {isOverdue ? '⚠ Overdue' : '📨 Sequence'}
                    </span>
                    {draft.sequence_name && (
                      <span style={{ fontSize: 11, color: '#1e40af' }}>
                        {draft.sequence_name} · step {draft.step_order}
                      </span>
                    )}
                  </div>
                  {(draft.task_note || draft.body) && (
                    <div style={{ fontSize: 12, color: '#1e3a8a', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                      {draft.task_note || draft.body}
                    </div>
                  )}
                  {draft.scheduled_send_at && (
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
                      Due {relTime(draft.scheduled_send_at)}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onLogCallFromTask && onLogCallFromTask(draft)}
                  style={{
                    padding: '6px 12px', background: '#9a3412', color: '#fff',
                    border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  📞 Log call
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {total === 0 && pendingCallTasks.length === 0 && (
        <div style={{
          padding: '24px 16px', textAlign: 'center',
          background: '#f9fafb', borderRadius: 8, border: '1px dashed #e5e7eb',
        }}>
          <div style={{ fontSize: 28, marginBottom: 6, opacity: 0.5 }}>📞</div>
          <div style={{ fontSize: 13, color: '#6b7280', fontWeight: 500, marginBottom: 4 }}>
            No calls logged yet
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            Log your first call to start tracking outcomes for this prospect.
          </div>
        </div>
      )}

      {/* Call list — newest first */}
      {calls.map(call => {
        const colors = groupColor(call.outcome_group);
        const dur    = fmtDuration(call.duration_seconds);

        // ── Phase 3 status-aware rendering ───────────────────────────────
        // A row can be in three states:
        //   1. outcome set                 → render normally (existing path)
        //   2. outcome=NULL, status terminal completed → "Outcome not captured"
        //      + Capture button → opens LogCallModal in editingCallId mode
        //   3. outcome=NULL, status terminal abnormal (failed/no_answer/busy/
        //      canceled) → show terminal status, offer optional capture
        //   4. outcome=NULL, status non-terminal → call is still in flight
        //      somewhere (e.g. rep closed tab); show transient state
        const isOutcomeMissing = !call.outcome;
        const TERMINAL_NORMAL   = ['completed'];
        const TERMINAL_ABNORMAL = ['no_answer', 'failed', 'busy', 'canceled'];
        const isCompletedNoOutcome = isOutcomeMissing && TERMINAL_NORMAL.includes(call.status);
        const isAbnormalTerminal   = isOutcomeMissing && TERMINAL_ABNORMAL.includes(call.status);
        const isInFlight           = isOutcomeMissing && !TERMINAL_NORMAL.includes(call.status) && !TERMINAL_ABNORMAL.includes(call.status);

        // Recovery button is offered for both completed-no-outcome and
        // abnormal-terminal states — in both cases the rep may want to add
        // context (e.g. "no answer, will retry tomorrow").
        const canCapture = (isCompletedNoOutcome || isAbnormalTerminal) && !!onCaptureOutcome;

        // Label & color override for missing-outcome rows.
        const statusLabel = isCompletedNoOutcome ? '⏳ Outcome not captured'
                          : call.status === 'no_answer' ? '📵 No answer'
                          : call.status === 'busy'      ? '☎️ Busy'
                          : call.status === 'failed'    ? '⚠️ Failed'
                          : call.status === 'canceled'  ? '🚫 Canceled'
                          : isInFlight                  ? `🔄 ${call.status || 'in progress'}`
                          : (call.outcome_label || call.outcome);
        const missingOutcomeColors = isCompletedNoOutcome ? { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' }
                                    : isAbnormalTerminal  ? { bg: '#f3f4f6', border: '#d1d5db', fg: '#374151' }
                                    : isInFlight          ? { bg: '#dbeafe', border: '#93c5fd', fg: '#1e40af' }
                                    : null;
        const finalColors = missingOutcomeColors || colors;

        return (
          <div key={call.id} style={{
            padding: '12px 14px', marginBottom: 10, borderRadius: 8,
            background: '#fff',
            border: `1px solid ${isCompletedNoOutcome ? '#fde68a' : '#e5e7eb'}`,
          }}>
            {/* Inbound badge — its own line at the top, more prominent than
                the small grey dot it was before. Outbound calls show nothing
                here (no badge needed for the default direction). */}
            {call.direction === 'inbound' && (
              <div style={{
                display: 'inline-block', marginBottom: 6,
                padding: '2px 8px', borderRadius: 4,
                background: '#eff6ff', border: '1px solid #bfdbfe',
                color: '#1e40af', fontSize: 10, fontWeight: 600,
                letterSpacing: '0.04em', textTransform: 'uppercase',
              }}>
                📥 Inbound
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                  background: finalColors.bg, border: `1px solid ${finalColors.border}`, color: finalColors.fg,
                  fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                }}>
                  {statusLabel}
                </span>
                {dur && (
                  <span style={{ fontSize: 11, color: '#6b7280' }}>· {dur}</span>
                )}
              </div>
              <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                {relTime(call.occurred_at)}
              </span>
            </div>

            {call.notes && (
              <div style={{ fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', marginBottom: 6, lineHeight: 1.4 }}>
                {call.notes}
              </div>
            )}

            {/* Recording playback — Twilio audio is hosted by Twilio and
                served at recording_url. The .mp3 is playable directly via
                <audio>. The URL is unauthenticated (URL-as-secret); links
                are valid until the recording is deleted from Twilio. */}
            {call.recording_url && (
              <div style={{ marginBottom: 6 }}>
                <audio
                  controls
                  preload="none"
                  src={call.recording_url}
                  style={{ width: '100%', height: 28 }}
                />
              </div>
            )}

            {/* Capture-outcome recovery CTA — appears whenever outcome is
                NULL on a terminal row. Click opens LogCallModal in
                editingCallId mode so the rep can disposition the call now. */}
            {canCapture && (
              <button
                onClick={() => onCaptureOutcome(call)}
                style={{
                  marginTop: 4, marginBottom: 4,
                  padding: '6px 12px',
                  background: '#0F9D8E', color: '#fff',
                  border: 'none', borderRadius: 6,
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {call.direction === 'inbound'
                  ? '📝 Log details'
                  : (isCompletedNoOutcome ? '📝 Capture outcome' : '📝 Add notes')}
              </button>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: '#9ca3af' }}>
              <span>by {call.logged_by_name || call.logged_by_email || `User #${call.user_id}`}</span>
              {call.phone_used && (
                <span>
                  {call.direction === 'inbound'
                    ? `· from ${call.phone_used}`
                    : `· called ${call.phone_used}`}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// LOG CALL MODAL
// Modal form for capturing a new call log. Mounted from the drawer when
// the rep clicks "Log call". Closes on save or cancel.
//
// Props:
//   prospect  — the current prospect (for prefill: phone, name)
//   settings  — call settings from /api/org/call-settings (with outcomes
//               array). When null the form shows a brief loading state.
//   onSaved   — async callback fired after a successful save
//   onClose   — close the modal without saving
// ═════════════════════════════════════════════════════════════════════════════


export default CallsPanel;
