// CallsInboxView.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import LogCallModal from './LogCallModal';

function CallsInboxView({ scope, onSelectProspect }) {
  const [items, setItems]         = useState([]);
  const [counts, setCounts]       = useState({ all: 0, pending: 0, overdue: 0, completed: 0 });
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [filter, setFilter]       = useState('all');   // all | pending | overdue | completed
  const [dateRange, setDateRange] = useState('30');    // days
  const [expandedId, setExpandedId] = useState(null);  // composite key: `${kind}-${id}`

  // Modal state — Phase 2 lets the rep click "Log call" on a pending row
  // and have the modal open pre-filled with the sequence step context.
  const [logModalState, setLogModalState] = useState(null);
  // logModalState shape: { prospect, sequenceStepLogId, taskNote, sequenceContext }
  const [callSettings, setCallSettings] = useState(null);

  // Load org-wide call settings once (same as drawer does).
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/org/call-settings');
        setCallSettings(r.settings || null);
      } catch (_) { /* non-fatal */ }
    })();
  }, []);

  const fromDate = () => {
    if (!dateRange) return undefined;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(dateRange, 10));
    return d.toISOString();
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {
        scope,
        filter,
        limit: 100,
        ...(dateRange && { from: fromDate() }),
      };
      const res = await apiFetch(`/prospect-calls/inbox?${new URLSearchParams(params)}`);
      setItems(res.items || []);
      setCounts(res.counts || { all: 0, pending: 0, overdue: 0, completed: 0 });
    } catch (err) {
      setError(err.message || 'Failed to load calls inbox');
    } finally {
      setLoading(false);
    }
  }, [scope, filter, dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // Fire the stale-call scan once on mount so the rep gets the notification.
  // Non-fatal — silently swallow errors so the inbox renders regardless.
  useEffect(() => {
    apiFetch('/prospect-calls/scan-stale').catch(() => {});
  }, []);

  // Color map mirroring CallsPanel
  const groupColor = (group) => {
    if (group === 'connected')  return { bg: '#dcfce7', border: '#86efac', fg: '#14532d' };
    if (group === 'no_contact') return { bg: '#fef3c7', border: '#fcd34d', fg: '#78350f' };
    if (group === 'blocker')    return { bg: '#fee2e2', border: '#fca5a5', fg: '#7f1d1d' };
    return                              { bg: '#f3f4f6', border: '#e5e7eb', fg: '#374151' };
  };

  const relTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    const future = diff < 0;
    const absDiff = Math.abs(diff);
    let str = '';
    if (absDiff < 60)        str = 'just now';
    else if (absDiff < 3600) str = `${Math.floor(absDiff / 60)}m`;
    else if (absDiff < 86400) str = `${Math.floor(absDiff / 3600)}h`;
    else if (absDiff < 86400*30) str = `${Math.floor(absDiff / 86400)}d`;
    else                     str = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (str === 'just now') return str;
    return future ? `in ${str}` : `${str} ago`;
  };

  const fmtDuration = (sec) => {
    if (!sec || sec <= 0) return '';
    const min = Math.round(sec / 60);
    return min === 0 ? `${sec}s` : `${min} min`;
  };

  // Open the LogCallModal for a pending row. We need to fetch the full
  // prospect record so the modal can pre-fill phone, name, etc.
  const openLogModal = async (item) => {
    try {
      const r = await apiFetch(`/prospects/${item.prospect_id}`);
      setLogModalState({
        prospect: r.prospect,
        sequenceStepLogId: item.kind === 'pending_sequence' ? item.sequence_step_log_id : null,
        taskNote: item.task_note || '',
        sequenceContext: item.kind === 'pending_sequence' ? {
          sequence_name: item.sequence_name,
          step_order:    item.sequence_step_order,
        } : null,
      });
    } catch (err) {
      alert('Could not load prospect: ' + (err.message || 'unknown error'));
    }
  };

  // After a successful save in the modal, refresh the inbox list.
  const onCallSaved = async () => {
    setLogModalState(null);
    await load();
  };

  // ── Render ──────────────────────────────────────────────────────────────
  const tabs = [
    { key: 'all',       label: 'All',       count: counts.all },
    { key: 'pending',   label: 'Pending',   count: counts.pending },
    { key: 'overdue',   label: 'Overdue',   count: counts.overdue },
    { key: 'completed', label: 'Completed', count: counts.completed },
  ];

  return (
    <div>
      {/* Filter row — tabs + date range */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 4, padding: 3, background: '#f3f4f6', borderRadius: 8 }}>
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              style={{
                padding: '5px 12px', fontSize: 12,
                background: filter === t.key ? '#fff' : 'transparent',
                color: filter === t.key ? '#111827' : '#6b7280',
                border: 'none', borderRadius: 6, cursor: 'pointer',
                fontWeight: filter === t.key ? 600 : 500,
                display: 'flex', alignItems: 'center', gap: 6,
                boxShadow: filter === t.key ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {t.label}
              {t.count > 0 && (
                <span style={{
                  fontSize: 10, padding: '0px 6px', borderRadius: 8,
                  background: t.key === 'overdue' && t.count > 0 ? '#fee2e2' : '#e5e7eb',
                  color:      t.key === 'overdue' && t.count > 0 ? '#991b1b' : '#374151',
                  fontWeight: 600,
                }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}
          style={{
            padding: '5px 8px', fontSize: 12, color: '#374151',
            border: '1px solid #d1d5db', borderRadius: 6, background: '#fff',
          }}
        >
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="">All time</option>
        </select>

        {loading && (
          <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
            Loading…
          </span>
        )}
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 12, background: '#fef2f2',
          border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          background: '#fff', borderRadius: 10, border: '1px dashed #e5e7eb',
        }}>
          <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.5 }}>📞</div>
          <div style={{ fontSize: 14, color: '#374151', fontWeight: 600, marginBottom: 4 }}>
            {filter === 'all'       ? 'No calls in this window' :
             filter === 'pending'   ? 'No pending call tasks' :
             filter === 'overdue'   ? 'Nothing overdue' :
             'No calls logged'}
          </div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>
            {filter === 'pending' || filter === 'overdue'
              ? 'Sequence call steps and callback requests will appear here.'
              : 'Calls logged from any prospect drawer show up here.'}
          </div>
        </div>
      )}

      {/* Items list */}
      {items.map(item => {
        const key = `${item.kind}-${item.id}`;
        const isPending = item.kind === 'pending_sequence' || item.kind === 'pending_callback';
        const isExpanded = expandedId === key;
        const colors = item.outcome_group ? groupColor(item.outcome_group) : null;
        const dur    = fmtDuration(item.duration_seconds);
        const prospectName = `${item.prospect_first_name || ''} ${item.prospect_last_name || ''}`.trim() || `Prospect #${item.prospect_id}`;
        const staleBadge = item.stale_days >= 5;

        return (
          <div
            key={key}
            style={{
              padding: '12px 14px', marginBottom: 8, borderRadius: 8,
              background: '#fff',
              border: item.is_overdue
                ? '1px solid #fca5a5'
                : '1px solid #e5e7eb',
              boxShadow: item.is_overdue ? '0 0 0 1px #fee2e2' : 'none',
              cursor: 'pointer',
            }}
            onClick={() => onSelectProspect && onSelectProspect(item.prospect_id)}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              {/* Left content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Row 1: prospect + outcome/status + relative time */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1a202c' }}>
                    {prospectName}
                  </div>
                  {item.prospect_company && (
                    <div style={{ fontSize: 11, color: '#6b7280' }}>
                      · {item.prospect_company}
                    </div>
                  )}

                  {/* Status pill */}
                  {item.kind === 'completed' && colors && (
                    <span style={{
                      padding: '2px 8px', borderRadius: 4,
                      background: colors.bg, border: `1px solid ${colors.border}`, color: colors.fg,
                      fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap',
                    }}>
                      {item.outcome_label || item.outcome}
                    </span>
                  )}
                  {item.kind === 'pending_sequence' && (
                    <span style={{
                      padding: '2px 8px', borderRadius: 4,
                      background: item.is_overdue ? '#fee2e2' : '#e0e7ff',
                      border: `1px solid ${item.is_overdue ? '#fca5a5' : '#a5b4fc'}`,
                      color:  item.is_overdue ? '#991b1b' : '#3730a3',
                      fontSize: 10, fontWeight: 600,
                    }}>
                      {item.is_overdue ? '⚠ Overdue · Sequence' : '📨 Sequence'}
                    </span>
                  )}
                  {item.kind === 'pending_callback' && (
                    <span style={{
                      padding: '2px 8px', borderRadius: 4,
                      background: item.is_overdue ? '#fee2e2' : '#fff7ed',
                      border: `1px solid ${item.is_overdue ? '#fca5a5' : '#fed7aa'}`,
                      color:  item.is_overdue ? '#991b1b' : '#9a3412',
                      fontSize: 10, fontWeight: 600,
                    }}>
                      {item.is_overdue ? '⚠ Overdue · Callback' : '🔄 Callback'}
                    </span>
                  )}
                  {staleBadge && (
                    <span style={{
                      padding: '2px 6px', borderRadius: 4,
                      background: '#fef2f2', color: '#991b1b',
                      fontSize: 10, fontWeight: 600,
                    }}>
                      {item.stale_days}d stale
                    </span>
                  )}

                  {dur && (
                    <span style={{ fontSize: 11, color: '#6b7280' }}>· {dur}</span>
                  )}

                  <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                    {relTime(item.event_at)}
                  </span>
                </div>

                {/* Row 2: sequence info for pending sequence rows */}
                {item.kind === 'pending_sequence' && item.sequence_name && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                    {item.sequence_name} · step {item.sequence_step_order}
                  </div>
                )}

                {/* Row 3: notes preview, click to expand */}
                {(item.notes || item.task_note) && (
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedId(isExpanded ? null : key);
                    }}
                    style={{
                      fontSize: 12, color: '#374151', cursor: 'pointer',
                      lineHeight: 1.4,
                      whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap',
                      overflow: isExpanded ? 'visible' : 'hidden',
                      textOverflow: isExpanded ? 'unset' : 'ellipsis',
                      marginBottom: 4,
                    }}
                  >
                    {item.notes || item.task_note}
                  </div>
                )}

                {/* Row 4: meta — logger, phone */}
                <div style={{ fontSize: 10, color: '#9ca3af', display: 'flex', gap: 8 }}>
                  {item.logged_by_name && <span>by {item.logged_by_name}</span>}
                  {item.phone_used && <span>· {item.phone_used}</span>}
                </div>
              </div>

              {/* Right action button — only for pending rows */}
              {isPending && (
                <button
                  onClick={(e) => { e.stopPropagation(); openLogModal(item); }}
                  style={{
                    padding: '6px 12px', background: '#9a3412', color: '#fff',
                    border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                  }}
                >
                  📞 Log call
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* Log call modal — opened by clicking Log call on a pending row */}
      {logModalState && (
        <LogCallModal
          prospect={logModalState.prospect}
          settings={callSettings}
          sequenceStepLogId={logModalState.sequenceStepLogId}
          taskNote={logModalState.taskNote}
          sequenceContext={logModalState.sequenceContext}
          onSaved={onCallSaved}
          onClose={() => setLogModalState(null)}
        />
      )}
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// PROSPECTING INBOX
// Unified view of all outreach emails sent from prospecting sender accounts.
// Scope: mine | team | org (controlled by the parent ProspectingView scope).
// ═════════════════════════════════════════════════════════════════════════════


export default CallsInboxView;
