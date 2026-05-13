/**
 * TwilioCallModal.js
 *
 * The in-progress modal shown while a Twilio call is live. Drives off the
 * /api/prospect-calls/:id/status poll endpoint.
 *
 * Lifecycle:
 *   1. Mount → start polling every 1.5s
 *   2. status='initiated'   → "📞 Dialing your phone…"
 *   3. status='ringing'     → "📞 Ringing prospect…"
 *   4. status='in_progress' → "🔴 Live · M:SS" (count up duration)
 *   5. status='completed'   → close modal, fire onCompleted(callId, durationSeconds)
 *                              so the parent opens LogCallModal pre-filled
 *   6. status in failed/no_answer/busy/canceled → show terminal message, then
 *                              close after 3s and fire onClosed()
 *
 * Props:
 *   callId            (int, required)
 *   prospect          ({ first_name, last_name, phone })
 *   onCompleted(callId, durationSeconds) — fires when call ends normally
 *   onClosed(reason)  — fires when call ends abnormally or user closes
 *
 * Drop-in location: frontend/src/TwilioCallModal.js
 * Imported and rendered by ProspectingView.js (see patch instructions).
 */

import React, { useState, useEffect, useRef } from 'react';

export default function TwilioCallModal({ callId, prospect, onCompleted, onClosed }) {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { Authorization: `Bearer ${token}` };

  const [status, setStatus]               = useState('initiated');
  const [durationSeconds, setDuration]    = useState(0);
  const [terminalMsg, setTerminalMsg]     = useState(null);
  const [error, setError]                 = useState(null);

  // Refs so the polling loop sees latest values without re-creating itself.
  const pollTimer        = useRef(null);
  const liveStartedAtRef = useRef(null);   // ms timestamp when status hit in_progress
  const handledTerminal  = useRef(false);  // dedupe terminal callbacks

  // ── Poll loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch(`${API}/prospect-calls/${callId}/status`, { headers });
        if (!r.ok) throw new Error('status fetch failed');
        const j = await r.json();
        if (cancelled) return;

        setStatus(j.status);
        if (typeof j.duration_seconds === 'number') {
          setDuration(j.duration_seconds);
        }

        // Start a local count-up the first time we see in_progress so the
        // UI feels responsive between 1.5s polls.
        if (j.status === 'in_progress' && !liveStartedAtRef.current) {
          liveStartedAtRef.current = Date.now();
        }

        if (j.is_terminal && !handledTerminal.current) {
          handledTerminal.current = true;
          if (j.status === 'completed') {
            // Hand off to LogCallModal via the parent.
            onCompleted?.(callId, j.duration_seconds);
            return;  // stop polling
          } else {
            // Abnormal end. Show a brief message then close.
            const msg = {
              no_answer: 'No answer.',
              busy:      'The line was busy.',
              failed:    'Call failed.',
              canceled:  'Call canceled.',
            }[j.status] || `Call ended (${j.status}).`;
            setTerminalMsg(msg);
            setTimeout(() => onClosed?.(j.status), 3000);
            return;  // stop polling
          }
        }
      } catch (err) {
        // Transient — just keep polling. Set the error message for visibility.
        setError('Polling failed; retrying…');
      }
      if (!cancelled) {
        pollTimer.current = setTimeout(tick, 1500);
      }
    }
    tick();

    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  // ── Local count-up while live ─────────────────────────────────────────
  const [localTick, setLocalTick] = useState(0);
  useEffect(() => {
    if (status !== 'in_progress') return;
    const interval = setInterval(() => setLocalTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [status]);

  // ── Render ─────────────────────────────────────────────────────────────
  const displayDuration = (() => {
    // When server reports a duration, prefer it. Otherwise compute locally
    // from the start timestamp for a smooth count-up.
    if (durationSeconds > 0) return durationSeconds;
    if (liveStartedAtRef.current) {
      // localTick triggers re-render every second; the actual math reads
      // from the ref.
      void localTick;
      return Math.floor((Date.now() - liveStartedAtRef.current) / 1000);
    }
    return 0;
  })();

  const prospectName = prospect && (prospect.first_name || prospect.last_name)
    ? `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim()
    : (prospect?.phone || 'prospect');

  const headline = (() => {
    if (terminalMsg) return terminalMsg;
    if (status === 'initiated') return '📞 Dialing your phone…';
    if (status === 'ringing')   return `📞 Ringing ${prospectName}…`;
    if (status === 'in_progress') return `🔴 Live · ${formatDuration(displayDuration)}`;
    return `Status: ${status}`;
  })();

  return (
    <div style={overlay} onClick={() => { /* prevent click-through; require terminal */ }}>
      <div style={modal}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
          {headline}
        </div>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
          {prospect?.phone && <span style={{ fontFamily: 'monospace' }}>{prospect.phone}</span>}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
          Twilio is bridging your phone with the prospect's. Hang up your phone to end the call.
        </div>

        <button
          onClick={() => onClosed?.('user_closed')}
          style={{
            padding: '8px 16px', background: '#f3f4f6', border: '1px solid #e5e7eb',
            borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          Hide modal
        </button>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
          Hiding doesn't end the call; only hanging up does.
        </div>
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modal = {
  background: '#fff', borderRadius: 12, padding: 28, minWidth: 380, maxWidth: 480,
  boxShadow: '0 20px 50px rgba(0,0,0,0.3)',
};
