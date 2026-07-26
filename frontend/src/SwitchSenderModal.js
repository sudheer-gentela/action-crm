// ─────────────────────────────────────────────────────────────────────────────
// SwitchSenderModal.js  (2026_71)
//
// Resolution UI for a threaded/pinned enrollment paused because its pinned
// mailbox can't send. Opened from the blocked notification. Offers the three
// resolution paths:
//   • Switch to a different sender  → POST /sequences/enrollments/:id/switch-sender
//                                     (repins, carries the thread on the
//                                      recipient side, resumes)
//   • Reconnect the pinned mailbox  → navigate to Settings → Outreach (rep) or
//                                     the Agency client senders (client)
//   • Stop the sequence             → POST /sequences/enrollments/:id/stop
//
// Eligible senders are scoped server-side to the same pool (the client's
// mailboxes for a client prospect, else the rep's own).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import api from './apiService';
import { writeHash } from './hashNav';

const TEAL = '#0F9D8E';

export default function SwitchSenderModal({ enrollmentId, seqName, onClose, onResolved }) {
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [isClient, setIsClient]               = useState(false);
  const [currentSenderId, setCurrentSenderId] = useState(null);
  const [senders, setSenders] = useState([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy]         = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/sequences/enrollments/${enrollmentId}/eligible-senders`);
        if (!alive) return;
        const d = res.data || {};
        setIsClient(!!d.isClient);
        setCurrentSenderId(d.currentSenderId || null);
        setSenders(d.senders || []);
        const firstOther = (d.senders || []).find(s => s.id !== d.currentSenderId);
        setSelected(firstOther ? String(firstOther.id) : '');
      } catch {
        if (alive) setError('Could not load available mailboxes.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [enrollmentId]);

  const others = senders.filter(s => s.id !== currentSenderId);

  const doSwitch = async () => {
    if (!selected) return;
    setBusy('switch'); setError('');
    try {
      await api.post(`/sequences/enrollments/${enrollmentId}/switch-sender`,
        { sender_account_id: Number(selected) });
      onResolved && onResolved();
      onClose();
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Failed to switch sender.');
      setBusy('');
    }
  };

  const doStop = async () => {
    setBusy('stop'); setError('');
    try {
      await api.post(`/sequences/enrollments/${enrollmentId}/stop`, { reason: 'thread_sender_blocked_manual_stop' });
      onResolved && onResolved();
      onClose();
    } catch (e) {
      setError(e?.response?.data?.error?.message || 'Failed to stop the sequence.');
      setBusy('');
    }
  };

  const goReconnect = () => {
    if (isClient) {
      window.location.hash = '#/agency';
    } else {
      writeHash(['settings', 'preferences']);
      window.dispatchEvent(new CustomEvent('navigate', { detail: 'settings' }));
    }
    onClose();
  };

  return createPortal(
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modal}>
        <div style={header}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Resolve paused sequence</div>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>
        <div style={bodyStyle}>
          <p style={{ fontSize: 13, color: '#374151', marginTop: 0 }}>
            {seqName ? <><strong>{seqName}</strong> is paused</> : 'This enrollment is paused'} because its pinned {isClient ? 'client ' : ''}mailbox can’t send. Choose how to resolve it.
          </p>
          {error && <div style={errBox}>{error}</div>}

          {loading ? (
            <div style={{ color: '#6b7280', fontSize: 13 }}>Loading mailboxes…</div>
          ) : (
            <>
              <div style={card}>
                <div style={cardTitle}>Switch to a different sender</div>
                <div style={cardHint}>
                  The new mailbox takes over. The same subject and reply history carry across, so the prospect still sees one continuous thread.
                </div>
                {others.length ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <select value={selected} onChange={e => setSelected(e.target.value)} style={select}>
                      {others.map(s => (
                        <option key={s.id} value={s.id}>{s.email} ({s.provider})</option>
                      ))}
                    </select>
                    <button onClick={doSwitch} disabled={!selected || !!busy} style={primaryBtn(!!busy)}>
                      {busy === 'switch' ? 'Switching…' : 'Switch & resume'}
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>
                    No other active {isClient ? 'client ' : ''}mailbox is connected. Connect one, then use “Reconnect” below.
                  </div>
                )}
              </div>

              <div style={card}>
                <div style={cardTitle}>Reconnect the pinned mailbox</div>
                <div style={cardHint}>
                  Fix the mailbox’s connection, then resume — it keeps sending from the same address, thread intact.
                </div>
                <button onClick={goReconnect} style={secondaryBtn}>
                  {isClient ? 'Open client senders' : 'Open Settings → Outreach'}
                </button>
              </div>

              <div style={card}>
                <div style={cardTitle}>Stop the sequence</div>
                <div style={cardHint}>End this enrollment. No further steps will send.</div>
                <button onClick={doStop} disabled={!!busy} style={dangerBtn}>
                  {busy === 'stop' ? 'Stopping…' : 'Stop enrollment'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 };
const modal = { background: '#fff', borderRadius: 14, width: 520, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.18)', overflow: 'hidden' };
const header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid #f1f5f9' };
const bodyStyle = { padding: '16px 18px', overflowY: 'auto' };
const closeBtn = { border: 'none', background: 'transparent', fontSize: 16, cursor: 'pointer', color: '#6b7280' };
const card = { border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', marginTop: 12 };
const cardTitle = { fontSize: 13, fontWeight: 600, color: '#111827' };
const cardHint = { fontSize: 11, color: '#6b7280', marginTop: 3, lineHeight: 1.5 };
const select = { flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 };
const errBox = { background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12, borderRadius: 8, padding: '8px 10px', marginBottom: 10 };
const primaryBtn = (busy) => ({ padding: '8px 14px', borderRadius: 6, border: 'none', background: busy ? '#9ca3af' : TEAL, color: '#fff', fontWeight: 600, fontSize: 13, cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' });
const secondaryBtn = { marginTop: 10, padding: '8px 14px', borderRadius: 6, border: `1px solid ${TEAL}`, background: '#fff', color: TEAL, fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const dangerBtn = { marginTop: 10, padding: '8px 14px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
