/*
 * SAWhatsAppSessions.js
 *
 * Super-admin view: WhatsApp session capture health across every tenant.
 *
 * WHY THIS SCREEN EXISTS
 *   Session capture fails silently. A worker stops, WhatsApp ends a session,
 *   or a handset goes untouched for 14 days — and nobody notices until someone
 *   asks why a project has no WhatsApp history. Tenant admins do not sit on
 *   their own settings page waiting for a warning. This is where "which of my
 *   customers is quietly broken right now" is answerable.
 *
 * Health only — counts and timestamps, never message content.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';

const POLL_MS = 30000;

const CARD  = { border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' };
const BTN   = { padding: '5px 11px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer' };
const GHOST = { ...BTN, background: '#fff', color: '#374151', border: '1px solid #d1d5db' };
const DANGER= { ...BTN, background: '#fff', color: '#991b1b', border: '1px solid #fecaca' };

const STATUS = {
  connected:    { bg: '#ecfdf5', fg: '#065f46', text: 'Connected' },
  pending_qr:   { bg: '#fffbeb', fg: '#92400e', text: 'Awaiting scan' },
  connecting:   { bg: '#eff6ff', fg: '#1e40af', text: 'Connecting' },
  disconnected: { bg: '#fef2f2', fg: '#991b1b', text: 'Disconnected' },
  logged_out:   { bg: '#fef2f2', fg: '#991b1b', text: 'Logged out' },
};

export default function SAWhatsAppSessions() {
  const [data,    setData]    = useState({ sessions: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [onlyBad, setOnlyBad] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiService.superAdmin.whatsappSessions();
      setData(res.data || { sessions: [], summary: {} });
      setError('');
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Could not load sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const disable = async (s) => {
    if (!window.confirm(
      `Disable WhatsApp capture for ${s.org_name}?\n\n` +
      'This stops capture immediately and deletes the stored session keys. ' +
      'Their admin will need to scan a new QR to resume.'
    )) return;
    setBusy(true);
    try {
      await apiService.superAdmin.disableWhatsappSession(s.id);
      await load();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading sessions…</div>;

  const sum = data.summary || {};
  const rows = onlyBad
    ? (data.sessions || []).filter(s => s.warnings?.length)
    : (data.sessions || []);

  return (
    <div>
      <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1a202c' }}>
        WhatsApp capture — all tenants
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
        Operational health only. Refreshes every 30 seconds.
      </p>

      {error && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, color: '#991b1b' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', marginBottom: 14 }}>
        <Stat label="Sessions"  value={sum.total ?? 0} />
        <Stat label="Connected" value={sum.connected ?? 0} />
        <Stat label="Broken"    value={sum.critical ?? 0} tone={sum.critical ? 'bad' : null} />
        <Stat label="At risk"   value={sum.atRisk ?? 0} tone={sum.atRisk ? 'warn' : null} />
        <button
          style={{ ...GHOST, marginLeft: 'auto', background: onlyBad ? '#1A3A5C' : '#fff', color: onlyBad ? '#fff' : '#374151', borderColor: onlyBad ? '#1A3A5C' : '#d1d5db' }}
          onClick={() => setOnlyBad(v => !v)}
        >{onlyBad ? 'Showing problems only' : 'Show problems only'}</button>
      </div>

      <div style={{ ...CARD, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left', color: '#6b7280', fontSize: 12 }}>
              <th style={{ padding: '9px 12px' }}>Tenant</th>
              <th style={{ padding: '9px 12px', width: 130 }}>Status</th>
              <th style={{ padding: '9px 12px', width: 110 }}>Heartbeat</th>
              <th style={{ padding: '9px 12px', width: 110 }}>Handset</th>
              <th style={{ padding: '9px 12px', width: 130 }}>Groups</th>
              <th style={{ padding: '9px 12px', width: 90 }}>Msgs 24h</th>
              <th style={{ padding: '9px 12px', width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                {onlyBad ? 'Nothing needs attention.' : 'No tenants have session capture configured.'}
              </td></tr>
            )}
            {rows.map(s => {
              const st = STATUS[s.status] || { bg: '#f3f4f6', fg: '#374151', text: s.status };
              return (
                <tr key={s.id} style={{ borderTop: '1px solid #f3f4f6', background: s.healthy ? '#fff' : '#fffbfb' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 500, color: '#1a202c' }}>{s.org_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                      {s.wa_phone ? `+${s.wa_phone}` : 'no number yet'}
                      {s.label ? ` · ${s.label}` : ''}
                      {s.capture_mode === 'all' ? ' · capturing all groups' : ''}
                    </div>
                    {(s.warnings || []).map((w, i) => (
                      <div key={i} style={{ fontSize: 11, marginTop: 4, color: w.level === 'critical' ? '#991b1b' : '#92400e' }}>
                        {w.level === 'critical' ? '✕' : '!'} {w.message}
                      </div>
                    ))}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: st.bg, color: st.fg }}>
                      {st.text}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12 }}>
                    {s.heartbeat_stale_minutes == null ? '—' : `${s.heartbeat_stale_minutes}m ago`}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: s.phone_stale_days >= 10 ? '#991b1b' : '#6b7280' }}>
                    {s.phone_stale_days == null ? 'never' : `${s.phone_stale_days}d ago`}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>
                    {s.groups_watched}/{s.groups_total} watched
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.groups_bound} bound</div>
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: s.messages_24h ? '#1a202c' : '#9ca3af' }}>
                    {s.messages_24h}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button style={DANGER} disabled={busy} onClick={() => disable(s)}>Disable</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 10, lineHeight: 1.6 }}>
        <strong>Msgs 24h</strong> at zero on a connected session is not necessarily wrong — it may
        just be a quiet weekend. <strong>Heartbeat</strong> is the real liveness signal: it is written
        on a timer whether or not anyone is messaging.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const colour = tone === 'bad' ? '#991b1b' : tone === 'warn' ? '#92400e' : '#1a202c';
  return (
    <div>
      <div style={{ fontSize: 12, color: '#9ca3af' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: colour }}>{value}</div>
    </div>
  );
}
