// prospecting/WorkQueueView.js
//
// Signal-Based Campaigns — Phase 7: the prioritized action queue as the rep
// experiences it (design §7 / handoff: "open contact → priority + why-now +
// research + draft + page to validate → act").
//
// A focused list of SIGNAL actions (action_type='signal', the P5 surfacer's
// rows) from the existing GET /api/prospecting-actions — no new list endpoint.
// The server already orders pending → priority → due date; within a priority
// bucket we sub-sort by metadata.priority_score (the engine's finer ordering:
// stronger trigger rank first, corroboration as tiebreak).
//
// Each row: prospect · company · priority chip · why-now hook · active trigger
// or outstanding confirmations · due. Click → the parent opens the prospect
// drawer at the Work tab.
//
// Props:
//   scope            {'mine'|'team'|'org'}
//   onSelectProspect {fn} (prospectId) => void
//   search           {string} optional client-side filter (name/company/hook)

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, formatDate, TEAL } from './prospectingShared';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_CHIP = {
  high:   { bg: '#fff7ed', color: '#c2410c', border: '#fdba74' },
  medium: { bg: '#fefce8', color: '#a16207', border: '#fde047' },
  low:    { bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb' },
};

const STATUS_FILTERS = [
  { key: 'pending',  label: 'To work' },
  { key: 'snoozed',  label: 'Deferred' },
  { key: 'completed', label: 'Done' },
];

export default function WorkQueueView({ scope = 'mine', onSelectProspect, search = '' }) {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [status, setStatus]   = useState('pending');
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState(null);

  useEffect(() => {
    apiFetch('/prospecting-campaigns?status=all')
      .then(r => setCampaigns(r.campaigns || []))
      .catch(() => { /* selector stays hidden */ });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ scope, actionType: 'signal', status });
      const r = await apiFetch(`/prospecting-actions?${qs.toString()}`);
      setActions(r.actions || []);
    } catch (err) {
      setError(err.message || 'Failed to load the work queue');
    } finally {
      setLoading(false);
    }
  }, [scope, status]);

  useEffect(() => { load(); }, [load]);

  // Client-side narrowing + fine ordering.
  const q = (search || '').trim().toLowerCase();
  const visible = actions
    .filter(a => !campaignId || a.metadata?.campaign_id === campaignId)
    .filter(a => {
      if (!q) return true;
      const hay = [
        a.prospect?.firstName, a.prospect?.lastName, a.prospect?.companyName,
        a.title, a.metadata?.why_now,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 3;
      const pb = PRIORITY_ORDER[b.priority] ?? 3;
      if (pa !== pb) return pa - pb;
      const sa = a.metadata?.priority_score ?? 0;
      const sb = b.metadata?.priority_score ?? 0;
      if (sa !== sb) return sb - sa;                       // finer engine score
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return da - db;
    });

  const counts = { high: 0, medium: 0, low: 0 };
  for (const a of visible) if (counts[a.priority] !== undefined) counts[a.priority]++;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ── Header strip ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 4px', borderBottom: '1px solid #e5e7eb',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937' }}>⚡ Work queue</div>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {visible.length} contact{visible.length === 1 ? '' : 's'}
          {status === 'pending' && visible.length > 0 && ` · ${counts.high} high / ${counts.medium} medium / ${counts.low} low`}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {campaigns.length > 0 && (
            <select
              value={campaignId || ''}
              onChange={e => setCampaignId(e.target.value ? parseInt(e.target.value, 10) : null)}
              style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', maxWidth: 200 }}
            >
              <option value="">🚀 All campaigns</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {STATUS_FILTERS.map(f => (
            <button key={f.key} onClick={() => setStatus(f.key)}
              style={{
                fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 12, cursor: 'pointer',
                border: `1px solid ${status === f.key ? TEAL : '#d1d5db'}`,
                background: status === f.key ? '#E1F5EE' : '#fff',
                color: status === f.key ? '#0F6E56' : '#6b7280',
              }}>{f.label}</button>
          ))}
          <button onClick={load} title="Re-evaluate view" style={{
            fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db',
            background: '#fff', cursor: 'pointer', color: '#6b7280',
          }}>↻</button>
        </div>
      </div>

      {/* ── List ─────────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ padding: 30, fontSize: 13, color: '#6b7280' }}>Loading queue…</div>
      ) : error ? (
        <div style={{ padding: 20, fontSize: 13, color: '#b91c1c' }}>⚠️ {error}</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          {status === 'pending'
            ? <>Nothing to work right now. Signal actions appear here when campaign targeting matches — import a list, or hit “Re-evaluate queue” on a campaign.</>
            : 'Nothing here.'}
        </div>
      ) : (
        <div>
          {visible.map(a => {
            const chip = PRIORITY_CHIP[a.priority] || PRIORITY_CHIP.low;
            const confirmations = a.metadata?.confirmations || [];
            const isReplacement = a.metadata?.kind === 'find_replacement';
            const trigger = a.metadata?.active_trigger;
            return (
              <div
                key={a.id}
                onClick={() => onSelectProspect && a.prospectId && onSelectProspect(a.prospectId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 10px',
                  borderBottom: '1px solid #f3f4f6', cursor: 'pointer', background: '#fff',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
              >
                <span style={{
                  fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 10,
                  background: chip.bg, color: chip.color, border: `1px solid ${chip.border}`,
                  flexShrink: 0, width: 62, textAlign: 'center',
                }}>
                  {(a.priority || 'low').toUpperCase()}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    {a.prospect
                      ? <>{a.prospect.firstName} {a.prospect.lastName}
                          {a.prospect.companyName && <span style={{ fontWeight: 400, color: '#6b7280', fontSize: 12 }}>· {a.prospect.companyName}</span>}
                        </>
                      : a.title}
                    {isReplacement && (
                      <span style={{ fontSize: 10, background: '#eff6ff', color: '#1d4ed8', padding: '1px 7px', borderRadius: 10 }}>find replacement</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isReplacement
                      ? a.description
                      : (a.metadata?.why_now
                          ? <>💡 {a.metadata.why_now}</>
                          : (confirmations.length > 0
                              ? <>❓ Confirm on the page: {confirmations.map(c => c.label).slice(0, 3).join(', ')}{confirmations.length > 3 ? '…' : ''}</>
                              : a.description || a.title))}
                  </div>
                </div>

                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {trigger && !isReplacement && (
                    <div style={{ fontSize: 10, color: '#0F6E56', fontWeight: 600 }}>⚡ {trigger.label}</div>
                  )}
                  {status === 'pending' && confirmations.length > 0 && !isReplacement && (
                    <div style={{ fontSize: 10, color: '#a16207' }}>{confirmations.length} to validate</div>
                  )}
                  {status === 'snoozed' && a.snoozedUntil && (
                    <div style={{ fontSize: 10, color: '#6b7280' }}>💤 until {new Date(a.snoozedUntil).toLocaleDateString()}</div>
                  )}
                  {status === 'completed' && (
                    <div style={{ fontSize: 10, color: '#6b7280' }}>{a.outcome || 'done'}</div>
                  )}
                  {a.dueDate && status === 'pending' && (
                    <div style={{ fontSize: 10, color: new Date(a.dueDate) < new Date() ? '#b91c1c' : '#9ca3af' }}>
                      {new Date(a.dueDate) < new Date() ? 'overdue · ' : 'due '}{formatDate(a.dueDate)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
