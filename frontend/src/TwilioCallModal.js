/**
 * TwilioCallModal.js  (browser dialing — Voice JS SDK v2)
 *
 * The rep now talks through the computer (WebRTC), so there is NO PSTN leg to
 * the rep's phone. On mount this modal:
 *   1. fetches a Voice AccessToken (GET /twilio/voice/token)
 *   2. creates a @twilio/voice-sdk Device
 *   3. Device.connect({ params: { callId } }) — Twilio fetches /voice-app TwiML,
 *      which dials the PROSPECT (from the DB row) with the rep's DID as caller
 *      ID and bridges it to this browser leg.
 *
 * The call lifecycle + duration still come from the server status poll
 * (/prospect-calls/:id/status), driven by the prospect-leg status webhook —
 * that remains the source of truth, identical to the dial-and-bridge version.
 * The Device/Call only provides the audio path, mute, and hangup.
 *
 * Props (unchanged):
 *   callId            (int, required)   — from POST /prospect-calls/prepare
 *   prospect          ({ first_name, last_name, phone })
 *   onCompleted(callId, durationSeconds)
 *   onClosed(reason)
 *
 * Requires dependency: @twilio/voice-sdk (npm i @twilio/voice-sdk)
 * Drop-in location: frontend/src/TwilioCallModal.js
 */

import React, { useState, useEffect, useRef } from 'react';
import { Device } from '@twilio/voice-sdk';

export default function TwilioCallModal({ callId, prospect, mode = 'softphone', onCompleted, onClosed }) {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { Authorization: `Bearer ${token}` };
  const isBridge = mode === 'bridge';

  const [status, setStatus]            = useState(isBridge ? 'initiated' : 'connecting'); // → ringing → in_progress → terminal
  const [durationSeconds, setDuration] = useState(0);
  const [terminalMsg, setTerminalMsg]  = useState(null);
  const [error, setError]              = useState(null);
  const [muted, setMuted]              = useState(false);
  const [ending, setEnding]            = useState(false);

  const pollTimer        = useRef(null);
  const liveStartedAtRef = useRef(null);
  const handledTerminal  = useRef(false);
  const deviceRef        = useRef(null);
  const callRef          = useRef(null);

  // ── Set up the softphone Device + place the call ───────────────────────
  useEffect(() => {
    if (isBridge) return;   // bridge mode: no browser Device — the call runs on the rep's phone
    let disposed = false;
    let watchdog = null;

    // If we never get past "connecting" within a reasonable window, stop hanging
    // and tell the rep what to check (mic permission / network / CSP).
    watchdog = setTimeout(() => {
      if (disposed || handledTerminal.current || liveStartedAtRef.current) return;
      handledTerminal.current = true;
      setStatus('failed');
      setTerminalMsg('Still trying to connect. This is usually a blocked microphone, or the page’s security policy blocking Twilio (it needs wss://*.twilio.com allowed). Open the browser console for the exact error.');
      setTimeout(() => onClosed?.('connect_timeout'), 5000);
    }, 15000);

    async function fetchToken() {
      const r = await fetch(`${API}/twilio/voice/token`, { headers });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(body?.error?.message || 'Could not get a calling token');
        e.code = body?.error?.code;
        throw e;
      }
      return body.token;
    }

    (async () => {
      let jwt;
      try {
        jwt = await fetchToken();
      } catch (err) {
        if (!disposed) {
          setError(err.message);
          setStatus('failed');
          setTerminalMsg(err.code === 'TWILIO_VOICE_NOT_PROVISIONED'
            ? 'Browser calling is not set up for your org yet.'
            : err.message);
          setTimeout(() => onClosed?.('token_error'), 3500);
        }
        return;
      }
      if (disposed) return;

      const device = new Device(jwt, {
        logLevel: 'error',
        codecPreferences: ['opus', 'pcmu'],
      });
      deviceRef.current = device;

      // Refresh the token before it expires so long sessions don't drop.
      device.on('tokenWillExpire', async () => {
        try { device.updateToken(await fetchToken()); }
        catch (e) { console.warn('token refresh failed:', e.message); }
      });

      device.on('error', (e) => {
        console.error('Twilio Device error:', e);
        if (disposed) return;
        setError(e?.message || 'Calling device error');
        // If the call never went live, a Device error is fatal — surface it with
        // guidance instead of leaving the rep stuck on "Connecting…".
        if (!liveStartedAtRef.current && !handledTerminal.current) {
          const code = e?.code;
          let msg = e?.message || 'Calling could not start.';
          if (code === 31204 || code === 20151 || code === 31201 || /token/i.test(msg)) {
            msg = 'Calling token was rejected. Ask your admin to re-run Twilio setup — the org’s API key or voice app may be stale.';
          } else if (code === 31401 || code === 31402 || /microphone|getusermedia|permission|notallowed/i.test(msg)) {
            msg = 'Microphone access is blocked. Allow mic access for this site in the address bar, then try again.';
          } else if (code === 31005 || code === 31000 || code === 31009 || code === 53000 || /transport|websocket|signaling|connection/i.test(msg)) {
            msg = 'Could not reach Twilio (network/WebSocket blocked). If this persists, the site’s security policy needs wss://*.twilio.com allowed.';
          }
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          handledTerminal.current = true;
          setStatus('failed');
          setTerminalMsg(msg);
          setTimeout(() => onClosed?.('device_error'), 4000);
        }
      });

      try {
        // Browser will prompt for mic permission here on first use.
        const call = await device.connect({ params: { callId: String(callId) } });
        callRef.current = call;
        // Call is established (ringing/answered) — stop the connect watchdog.
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }

        call.on('disconnect', () => {
          // Bridge ended (prospect hung up, rep ended, or we called disconnect).
          // The status poll resolves the terminal handoff with the authoritative
          // duration; if the poll already handled it, this is a no-op.
          if (!handledTerminal.current && !disposed) {
            // Nudge a final poll; if the webhook hasn't landed yet the poll
            // loop will catch the terminal state shortly.
          }
        });
        call.on('error', (e) => {
          console.error('Twilio Call error:', e);
          if (!disposed) setError(e?.message || 'Call error');
        });
      } catch (err) {
        if (!disposed) {
          setError(err?.message || 'Could not start the call');
          setStatus('failed');
          setTerminalMsg('Could not start the call. Check your microphone permission.');
          setTimeout(() => onClosed?.('connect_error'), 3500);
        }
      }
    })();

    return () => {
      disposed = true;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      try { callRef.current?.disconnect(); } catch (_) {}
      try { deviceRef.current?.destroy(); } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  // ── Status poll (source of truth for lifecycle + duration) ─────────────
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch(`${API}/prospect-calls/${callId}/status`, { headers });
        if (!r.ok) throw new Error('status fetch failed');
        const j = await r.json();
        if (cancelled) return;

        // Don't let the server status overwrite a local connecting/failed state
        // before the first real lifecycle event arrives.
        if (j.status && j.status !== 'initiated') setStatus(j.status);
        if (typeof j.duration_seconds === 'number') setDuration(j.duration_seconds);

        if (j.status === 'in_progress' && !liveStartedAtRef.current) {
          liveStartedAtRef.current = Date.now();
        }

        if (j.is_terminal && !handledTerminal.current) {
          handledTerminal.current = true;
          if (j.status === 'completed') {
            onCompleted?.(callId, j.duration_seconds);
            return;
          }
          const msg = {
            no_answer: 'No answer.',
            busy:      'The line was busy.',
            failed:    'Call failed.',
            canceled:  'Call ended.',
          }[j.status] || `Call ended (${j.status}).`;
          setTerminalMsg(msg);
          setTimeout(() => onClosed?.(j.status), 3000);
          return;
        }
      } catch (_) {
        setError('Reconnecting…');
      }
      if (!cancelled) pollTimer.current = setTimeout(tick, 1500);
    }
    tick();

    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  // ── Local count-up while live ──────────────────────────────────────────
  const [localTick, setLocalTick] = useState(0);
  useEffect(() => {
    if (status !== 'in_progress') return;
    const interval = setInterval(() => setLocalTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [status]);

  // ── Controls ───────────────────────────────────────────────────────────
  const toggleMute = () => {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    try { call.mute(next); setMuted(next); } catch (_) {}
  };

  const endCall = async () => {
    if (ending) return;
    setEnding(true);
    if (isBridge) {
      // No browser Device — ask the backend to cancel / hang up the Twilio call.
      try {
        await fetch(`${API}/prospect-calls/${callId}/cancel`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (_) { /* the status poll will still resolve the terminal state */ }
      handledTerminal.current = true;
      onClosed?.('user_canceled');
      return;
    }
    try { callRef.current?.disconnect(); } catch (_) {}
    // Let the status poll fire onCompleted/onClosed with the server duration.
    // If the call never connected, treat End as a user close.
    if (!liveStartedAtRef.current && !handledTerminal.current) {
      handledTerminal.current = true;
      onClosed?.('user_canceled');
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const displayDuration = (() => {
    if (durationSeconds > 0) return durationSeconds;
    if (liveStartedAtRef.current) { void localTick; return Math.floor((Date.now() - liveStartedAtRef.current) / 1000); }
    return 0;
  })();

  const prospectName = prospect && (prospect.first_name || prospect.last_name)
    ? `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim()
    : (prospect?.phone || 'prospect');

  const headline = (() => {
    if (terminalMsg) return terminalMsg;
    if (status === 'connecting') return '🎧 Connecting your microphone…';
    if (status === 'initiated')  return isBridge ? '📞 Dialing your phone…' : `📞 Calling ${prospectName}…`;
    if (status === 'ringing')    return `📞 Ringing ${prospectName}…`;
    if (status === 'in_progress') return `🔴 Live · ${formatDuration(displayDuration)}`;
    return `📞 Calling ${prospectName}…`;
  })();

  const isLive = status === 'in_progress';

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{headline}</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
          {prospect?.phone && <span style={{ fontFamily: 'monospace' }}>{prospect.phone}</span>}
        </div>

        {error && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 12 }}>{error}</div>}

        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>
          {isBridge
            ? 'Twilio is calling your phone, then bridging to the prospect. Answer your phone to connect.'
            : "You're on the call through your computer. Use the controls below — closing this window won't end the call."}
        </div>

        {!terminalMsg && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {!isBridge && (
              <button
                onClick={toggleMute}
                disabled={!isLive}
                style={{
                  padding: '10px 16px',
                  background: muted ? '#f59e0b' : '#f3f4f6',
                  color: muted ? '#fff' : '#111827',
                  border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14, fontWeight: 600,
                  cursor: isLive ? 'pointer' : 'not-allowed', opacity: isLive ? 1 : 0.5,
                }}
              >
                {muted ? '🔇 Unmute' : '🎙️ Mute'}
              </button>
            )}
            <button
              onClick={endCall}
              disabled={ending}
              style={{
                padding: '10px 20px',
                background: ending ? '#9ca3af' : '#dc2626',
                color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600,
                cursor: ending ? 'not-allowed' : 'pointer',
              }}
            >
              {ending ? '⏳ Ending…' : (isLive ? '🔴 End call' : '🚫 Cancel call')}
            </button>
          </div>
        )}

        <button
          onClick={() => onClosed?.('user_closed')}
          style={{ padding: '8px 16px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
        >
          Hide window
        </button>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
          Hiding doesn't end the call; only End call does.
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
