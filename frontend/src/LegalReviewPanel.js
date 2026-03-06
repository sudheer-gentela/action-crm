// LegalReviewPanel.js
import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const LEGAL_EVENTS = new Set([
  'submitted_for_legal_review', 'legal_picked_up', 'legal_reassigned',
  'returned_to_sales', 'resubmitted_to_legal', 'document_version_uploaded',
]);

const EV_ICONS = {
  submitted_for_legal_review: '📤',
  legal_picked_up:            '👋',
  legal_reassigned:           '↔️',
  returned_to_sales:          '📥',
  resubmitted_to_legal:       '🔄',
  document_version_uploaded:  '📎',
};

export default function LegalReviewPanel({ contract: c, isLegalMember, onUpdated }) {
  const [reassignTo, setReassignTo]   = useState('');
  const [showReassign, setShowReassign] = useState(false);
  const [busy, setBusy]               = useState('');
  const [err, setErr]                 = useState('');

  async function act(key, fn) {
    setBusy(key); setErr('');
    try { await fn(); onUpdated(); }
    catch (e) { setErr(e.response?.data?.error?.message || e.message || 'Action failed'); }
    finally { setBusy(''); }
  }

  const legalEvents = (c.events || []).filter(ev => LEGAL_EVENTS.has(ev.event_type));

  // ── Status card ─────────────────────────────────────────────
  function StatusCard() {
    if (c.status !== 'in_legal_review') {
      return (
        <div className="lrp-card lrp-card--neutral">
          <div className="lrp-card-icon">⚖️</div>
          <div>
            <div className="lrp-card-title">Not currently in legal review</div>
            <div className="lrp-card-sub">Status: <strong>{c.status.replace(/_/g, ' ')}</strong></div>
          </div>
        </div>
      );
    }

    if (c.legalQueue) {
      return (
        <div className="lrp-card lrp-card--queue">
          <div className="lrp-card-icon">📋</div>
          <div>
            <div className="lrp-card-title">In legal queue — unassigned</div>
            <div className="lrp-card-sub">Awaiting a legal team member to pick up</div>
          </div>
        </div>
      );
    }

    return (
      <div className="lrp-card lrp-card--assigned">
        <div className="lrp-card-icon">👤</div>
        <div>
          <div className="lrp-card-title">Assigned to legal reviewer</div>
          <div className="lrp-card-sub">
            {c.legalAssigneeName
              ? <><strong>{c.legalAssigneeName}</strong> is reviewing</>
              : 'Assigned (reviewer details unavailable)'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lrp-wrap">
      <StatusCard />

      {err && <div className="lrp-err">{err}</div>}

      {/* Legal actions — only for legal team members */}
      {isLegalMember && c.status === 'in_legal_review' && (
        <div className="lrp-actions">
          {c.legalQueue && (
            <button className="lrp-btn lrp-btn--primary"
              disabled={busy === 'pickup'}
              onClick={() => act('pickup', () => apiService.contracts.pickUp(c.id))}>
              {busy === 'pickup' ? '…' : '👋 Pick Up'}
            </button>
          )}

          <button className="lrp-btn lrp-btn--secondary"
            disabled={busy === 'return'}
            onClick={() => act('return', () => apiService.contracts.returnToSales(c.id))}>
            {busy === 'return' ? '…' : '📥 Return to Sales'}
          </button>

          <button className="lrp-btn lrp-btn--ghost"
            onClick={() => setShowReassign(v => !v)}>
            ↔️ Reassign
          </button>

          {showReassign && (
            <div className="lrp-reassign">
              <input
                className="lrp-inp"
                placeholder="Assignee user ID"
                value={reassignTo}
                onChange={e => setReassignTo(e.target.value)}
              />
              <div className="lrp-reassign-btns">
                <button className="lrp-inline-ok"
                  disabled={!reassignTo || busy === 'reassign'}
                  onClick={() => act('reassign', () =>
                    apiService.contracts.reassign(c.id, parseInt(reassignTo, 10))
                  )}>
                  {busy === 'reassign' ? '…' : 'Reassign'}
                </button>
                <button className="lrp-inline-cancel" onClick={() => { setShowReassign(false); setReassignTo(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legal event history */}
      {legalEvents.length > 0 && (
        <div className="lrp-history">
          <div className="lrp-history-title">Legal Activity</div>
          {legalEvents.map(ev => (
            <div key={ev.id} className="lrp-ev">
              <div className="lrp-ev-icon">{EV_ICONS[ev.event_type] || '📋'}</div>
              <div className="lrp-ev-body">
                <div className="lrp-ev-type">{ev.event_type.replace(/_/g, ' ')}</div>
                {ev.first_name && (
                  <div className="lrp-ev-actor">{ev.first_name} {ev.last_name}</div>
                )}
              </div>
              <div className="lrp-ev-time">{fmt(ev.created_at)}</div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .lrp-wrap { display:flex; flex-direction:column; gap:12px; }
        .lrp-card { display:flex; align-items:center; gap:12px; padding:13px 14px; border-radius:10px; border:1.5px solid; }
        .lrp-card--neutral  { border-color:#e2e8f0; background:#f8fafc; }
        .lrp-card--queue    { border-color:#fde68a; background:#fffbeb; }
        .lrp-card--assigned { border-color:#a7f3d0; background:#f0fdf4; }
        .lrp-card-icon { font-size:22px; flex-shrink:0; }
        .lrp-card-title { font-size:13px; font-weight:700; color:#0f172a; margin-bottom:2px; }
        .lrp-card-sub   { font-size:12px; color:#64748b; }
        .lrp-err { font-size:12px; color:#991b1b; background:#fef2f2; padding:7px 11px; border-radius:7px; }
        .lrp-actions { display:flex; flex-wrap:wrap; gap:7px; }
        .lrp-btn { padding:8px 14px; border-radius:8px; border:none; cursor:pointer; font-size:12px; font-weight:600; font-family:inherit; }
        .lrp-btn:disabled { opacity:.45; cursor:not-allowed; }
        .lrp-btn--primary  { background:#6366f1; color:#fff; }
        .lrp-btn--primary:hover:not(:disabled) { background:#4f46e5; }
        .lrp-btn--secondary { background:#f1f5f9; color:#374151; }
        .lrp-btn--secondary:hover:not(:disabled) { background:#e2e8f0; }
        .lrp-btn--ghost { background:none; border:1.5px solid #e2e8f0; color:#475569; }
        .lrp-btn--ghost:hover { background:#f8fafc; }
        .lrp-reassign { width:100%; display:flex; flex-direction:column; gap:7px; padding:10px 12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; }
        .lrp-inp { padding:7px 10px; border:1.5px solid #e2e8f0; border-radius:7px; font-size:13px; font-family:inherit; outline:none; }
        .lrp-inp:focus { border-color:#6366f1; }
        .lrp-reassign-btns { display:flex; gap:7px; }
        .lrp-inline-ok { padding:6px 14px; border-radius:7px; border:none; background:#6366f1; color:#fff; font-size:12px; font-weight:600; cursor:pointer; }
        .lrp-inline-ok:disabled { opacity:.45; }
        .lrp-inline-cancel { padding:6px 12px; border-radius:7px; border:1px solid #e2e8f0; background:#fff; color:#64748b; font-size:12px; cursor:pointer; }
        .lrp-history { display:flex; flex-direction:column; gap:7px; }
        .lrp-history-title { font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:.05em; margin-bottom:2px; }
        .lrp-ev { display:flex; align-items:flex-start; gap:9px; padding:8px 0; border-top:1px solid #f1f5f9; }
        .lrp-ev-icon { width:26px; height:26px; border-radius:50%; background:#f1f5f9; display:flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0; }
        .lrp-ev-body { flex:1; }
        .lrp-ev-type { font-size:12px; font-weight:600; color:#0f172a; text-transform:capitalize; }
        .lrp-ev-actor { font-size:11px; color:#94a3b8; }
        .lrp-ev-time { font-size:10px; color:#94a3b8; white-space:nowrap; }
      `}</style>
    </div>
  );
}
