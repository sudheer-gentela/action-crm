/*
 * WhatsAppSessionConnect.js
 *
 * Org Admin panel for WhatsApp SESSION CAPTURE — reading existing customer
 * groups via a companion-device client.
 *
 * This is NOT the Cloud API connection (see WhatsAppConnect.js). They are
 * separate transports on separate numbers and must not be confused:
 *   - Cloud API  : official, sendable, 1:1 + API-created groups, needs OBA
 *   - Session    : unofficial, READ-ONLY, sees groups created on a phone
 *
 * The QR is rendered server-side into a data URL, so there is no QR library
 * on the frontend. Codes rotate roughly every 20s; we poll every 3s while the
 * modal is open and the API refuses to serve anything older than 60s rather
 * than handing back a code that would silently fail to scan.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiService } from './apiService';

const QR_POLL_MS     = 3000;
const HEALTH_POLL_MS = 15000;

const CARD   = { border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16, background: '#fff' };
const LABEL  = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
const INPUT  = { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
const BTN    = { padding: '7px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: '1px solid transparent' };
const PRIMARY= { ...BTN, background: '#E8630A', color: '#fff' };
const GHOST  = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const DANGER = { ...BTN, background: '#fff', color: '#991b1b', border: '1px solid #fecaca' };

const STATUS_STYLE = {
  connected:    { bg: '#ecfdf5', fg: '#065f46', text: 'Connected' },
  pending_qr:   { bg: '#fffbeb', fg: '#92400e', text: 'Waiting for scan' },
  connecting:   { bg: '#eff6ff', fg: '#1e40af', text: 'Connecting' },
  disconnected: { bg: '#fef2f2', fg: '#991b1b', text: 'Disconnected' },
  logged_out:   { bg: '#fef2f2', fg: '#991b1b', text: 'Logged out — rescan needed' },
};

const CONFIG_FIELDS = [
  { key: 'heartbeatSeconds',    label: 'Heartbeat (seconds)',      min: 15,  max: 3600,  hint: 'How often the worker proves it is alive. Health alerts fire at 3× this.' },
  { key: 'flushIntervalMs',     label: 'Flush interval (ms)',      min: 250, max: 60000, hint: 'How long captured messages buffer before being written.' },
  { key: 'batchMax',            label: 'Max batch size',           min: 1,   max: 500,   hint: 'Flush early once this many messages are queued.' },
  { key: 'staleSocketMinutes',  label: 'Watchdog (minutes)',       min: 5,   max: 1440,  hint: 'Force a reconnect after this long with no socket activity.' },
  { key: 'reconnectMaxSeconds', label: 'Reconnect backoff cap (s)',min: 10,  max: 3600,  hint: 'Ceiling on the exponential retry delay.' },
];

export default function WhatsAppSessionConnect() {
  const [health,  setHealth]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [notice,  setNotice]  = useState('');

  const [label,   setLabel]   = useState('');
  const [qr,      setQr]      = useState(null);
  const [showQr,  setShowQr]  = useState(false);
  const [cfg,     setCfg]     = useState(null);
  const [showCfg, setShowCfg] = useState(false);

  const qrTimer = useRef(null);

  const loadHealth = useCallback(async () => {
    try {
      const res = await apiService.whatsappSession.status();
      setHealth(res.data);
      if (res.data?.config) setCfg(c => c || res.data.config);
    } catch {
      setHealth({ configured: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHealth(); }, [loadHealth]);

  useEffect(() => {
    const t = setInterval(loadHealth, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, [loadHealth]);

  // Poll for a fresh QR only while the modal is open. Codes rotate every ~20s,
  // so a single fetch is almost always stale by the time someone has the phone
  // unlocked and in the right menu.
  useEffect(() => {
    if (!showQr) {
      if (qrTimer.current) { clearInterval(qrTimer.current); qrTimer.current = null; }
      return undefined;
    }
    const tick = async () => {
      try {
        const res = await apiService.whatsappSession.qr();
        setQr(res.data);
        if (res.data?.status === 'connected') {
          setShowQr(false);
          setNotice('Connected. Groups are being catalogued now.');
          loadHealth();
        }
      } catch (e) {
        setError(e?.response?.data?.error?.message || 'Could not fetch the QR code.');
      }
    };
    tick();
    qrTimer.current = setInterval(tick, QR_POLL_MS);
    return () => { if (qrTimer.current) clearInterval(qrTimer.current); };
  }, [showQr, loadHealth]);

  const run = async (fn, okMsg) => {
    setError(''); setNotice(''); setBusy(true);
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
      await loadHealth();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () => run(
    async () => { await apiService.whatsappSession.create({ label: label || 'Session capture' }); setShowQr(true); },
    'Session created. Scan the QR from the handset.'
  );

  const handleDisable = () => {
    if (!window.confirm(
      'Disable capture and delete the stored session keys?\n\n' +
      'Also remove the linked device from the handset:\n' +
      'WhatsApp → Settings → Linked Devices → log out.'
    )) return;
    run(async () => { await apiService.whatsappSession.disable(); setShowQr(false); }, 'Session disabled and keys wiped.');
  };

  const handleSaveCfg = () => run(
    async () => { await apiService.whatsappSession.updateSettings(cfg); },
    'Settings saved. The worker picks these up on its next heartbeat — no restart needed.'
  );

  if (loading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading capture settings…</div>;

  const configured = health?.configured;
  const st = STATUS_STYLE[health?.status] || { bg: '#f3f4f6', fg: '#374151', text: health?.status || 'Unknown' };

  return (
    <div style={{ maxWidth: 680 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1a202c' }}>
        WhatsApp group capture
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
        Reads messages from WhatsApp groups an ordinary number has been added to — including groups
        created on a phone, which the Cloud API cannot see. Read-only: nothing is ever sent from here.
      </p>

      <div style={{ ...CARD, background: '#fffbeb', borderColor: '#fde68a' }}>
        <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.6 }}>
          <strong>Use a dedicated number.</strong> This registers a linked device on the WhatsApp
          account you scan with, which is against WhatsApp&rsquo;s terms and can result in that number
          being banned without appeal. A personal number also brings hundreds of unrelated groups
          into the triage queue.
        </div>
      </div>

      {error  && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, color: '#991b1b' }}>{error}</div>}
      {notice && <div style={{ marginBottom: 12, padding: '8px 12px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, fontSize: 13, color: '#065f46' }}>{notice}</div>}

      {!configured ? (
        <div style={CARD}>
          <label style={LABEL}>Label</label>
          <input
            style={INPUT}
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Implementation observer"
          />
          <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 14px' }}>
            Just for your reference in this panel.
          </p>
          <button style={{ ...PRIMARY, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={handleCreate}>
            {busy ? 'Creating…' : 'Add a number'}
          </button>
        </div>
      ) : (
        <>
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <span style={{ display: 'inline-block', padding: '3px 9px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: st.bg, color: st.fg }}>
                  {st.text}
                </span>
                {health.waPhone && (
                  <span style={{ marginLeft: 10, fontSize: 13, color: '#374151' }}>+{health.waPhone}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {(health.status === 'pending_qr' || health.status === 'logged_out' || health.status === 'disconnected') && (
                  <button style={GHOST} onClick={() => { setShowQr(true); setError(''); }}>Show QR</button>
                )}
                <button style={DANGER} disabled={busy} onClick={handleDisable}>Disable</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, fontSize: 12 }}>
              <Stat label="Groups bound"    value={health.groups?.bound ?? 0} />
              <Stat label="Awaiting triage" value={health.groups?.unbound ?? 0} />
              <Stat label="Last heartbeat"  value={health.heartbeatStaleMins == null ? '—' : `${health.heartbeatStaleMins}m ago`} />
              <Stat label="Reconnects"      value={health.reconnectCount ?? 0} />
            </div>
          </div>

          {(health.warnings || []).length > 0 && (
            <div style={CARD}>
              {health.warnings.map((w, i) => (
                <div key={i} style={{
                  padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 6,
                  background: w.level === 'critical' ? '#fef2f2' : '#fffbeb',
                  color:      w.level === 'critical' ? '#991b1b' : '#92400e',
                  border: `1px solid ${w.level === 'critical' ? '#fecaca' : '#fde68a'}`,
                }}>{w.message}</div>
              ))}
            </div>
          )}

          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Handset check-in</div>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px', lineHeight: 1.5 }}>
              WhatsApp unlinks every companion device if the primary handset is not opened for 14 days.
              Nothing in the protocol reports this, so confirm it here after someone has physically
              opened WhatsApp on that phone.
              {health.phoneStaleDays != null && (
                <> Last confirmed <strong>{health.phoneStaleDays} day{health.phoneStaleDays === 1 ? '' : 's'}</strong> ago.</>
              )}
            </p>
            <button
              style={GHOST}
              disabled={busy}
              onClick={() => run(() => apiService.whatsappSession.phoneSeen(), 'Handset check-in recorded.')}
            >
              Handset was opened today
            </button>
          </div>

          <div style={CARD}>
            <button
              style={{ ...GHOST, marginBottom: showCfg ? 14 : 0 }}
              onClick={() => setShowCfg(v => !v)}
            >
              {showCfg ? 'Hide' : 'Show'} advanced settings
            </button>

            {showCfg && cfg && (
              <>
                {CONFIG_FIELDS.map(f => (
                  <div key={f.key} style={{ marginBottom: 12 }}>
                    <label style={LABEL}>{f.label}</label>
                    <input
                      type="number"
                      style={{ ...INPUT, maxWidth: 200 }}
                      min={f.min}
                      max={f.max}
                      value={cfg[f.key] ?? ''}
                      onChange={e => setCfg(c => ({ ...c, [f.key]: e.target.value }))}
                    />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                      {f.hint} Range {f.min}–{f.max}.
                    </div>
                  </div>
                ))}
                <button style={{ ...PRIMARY, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={handleSaveCfg}>
                  Save settings
                </button>
                <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 0' }}>
                  Applied on the worker&rsquo;s next heartbeat. The WhatsApp connection is not interrupted.
                </p>
              </>
            )}
          </div>
        </>
      )}

      {showQr && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: 400, maxWidth: '90vw' }}>
            <h4 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Link the device</h4>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 16px', lineHeight: 1.5 }}>
              On the handset: <strong>WhatsApp → Settings → Linked Devices → Link a Device</strong>,
              then scan. The code refreshes automatically.
            </p>

            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
              {qr?.qrDataUrl
                ? <img src={qr.qrDataUrl} alt="WhatsApp pairing code" width={280} height={280} />
                : <span style={{ fontSize: 13, color: '#6b7280' }}>
                    {qr?.waiting === false && qr?.status !== 'pending_qr'
                      ? 'Waiting for the worker to start…'
                      : 'Generating a code…'}
                  </span>}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button style={GHOST} onClick={() => setShowQr(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ color: '#9ca3af', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#1a202c' }}>{value}</div>
    </div>
  );
}
