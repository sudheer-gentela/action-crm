// LinkedInRiskPanel — rep-visible LinkedIn auto-send risk report.
//
// Rendered as the "LinkedIn risk" tab inside TeamReportingView. Self-contained:
// owns its depth / window / column controls and fetches GET /linkedin-autosend/risk
// directly. The endpoint scopes through ReportingScopeService exactly like the
// rest of reporting, so the viewer always sees their own line and everyone below
// them in the hierarchy (the upward-rollup pattern). "Just me" narrows a manager
// to their own numbers via selfOnly=1.
//
// Two risk tiers are surfaced together: ToS risk (challenges, rate-limits,
// failures) and readiness risk (prospects with an imminent send but no stored
// URN, which fall back to the fragile live resolve at send time). Both come from
// the same endpoint; URN coverage is derived from member_urn IS NULL, so it
// self-clears as URNs backfill.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import './LinkedInRiskPanel.css';

const WINDOWS = [
  { key: '24h', label: '24h' },
  { key: '7d',  label: '7d'  },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All time' },
];

// 'just_me' → selfOnly=1; the rest map straight to the endpoint's depth param.
// NOTE: depth is now inherited from TeamReportingView's shared depth control
// (passed as a prop), so the values direct/plus1/plus2/all match that selector.
// The endpoint still supports selfOnly for a future "Just me" if we make depth
// configurable per-panel later.

// Metric columns the user can show/hide. The seat (person) column is always on.
const COLUMNS = [
  { key: 'sent',           label: 'Sent'        },
  { key: 'failed',         label: 'Failed'      },
  { key: 'limited',        label: 'Limited'     },
  { key: 'challenge',      label: 'Challenge'   },
  { key: 'riskEvents',     label: 'Risk events' },
  { key: 'pending',        label: 'Pending'     },
  { key: 'urnCoveragePct', label: 'URN cov.'    },
  { key: 'lastRiskAt',     label: 'Last risk'   },
];
const MAX_COLS     = 6;   // cap so the table stays readable
const DEFAULT_COLS = ['sent', 'failed', 'limited', 'challenge', 'urnCoveragePct', 'lastRiskAt'];

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return '—';
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function cellText(key, v) {
  if (key === 'urnCoveragePct') return v == null ? '—' : `${v}%`;
  if (key === 'lastRiskAt')     return relTime(v);
  return v == null ? 0 : v;
}

// Severity colouring per cell. Returns a className from LinkedInRiskPanel.css.
function cellClass(key, v) {
  if (key === 'challenge')      return v > 0 ? 'lir-danger' : '';
  if (key === 'limited')        return v > 0 ? 'lir-warning' : '';
  if (key === 'failed')         return v > 0 ? 'lir-muted-strong' : '';
  if (key === 'urnCoveragePct') {
    if (v == null) return 'lir-muted';
    if (v >= 90)   return 'lir-success';
    if (v >= 70)   return 'lir-warning';
    return 'lir-danger';
  }
  if (key === 'lastRiskAt')     return 'lir-muted';
  return '';
}

function SeatName({ seat }) {
  const name = seat.name || seat.displayName || 'Unknown';
  const inner = (
    <>
      <span className="lir-seat-name">{name}</span>
      {seat.publicIdentifier && <span className="lir-seat-handle">{seat.publicIdentifier}</span>}
    </>
  );
  return seat.profileUrl
    ? <a className="lir-seat" href={seat.profileUrl} target="_blank" rel="noreferrer" title="Open LinkedIn profile">{inner}</a>
    : <span className="lir-seat">{inner}</span>;
}

function SummaryCard({ label, value, sub, tone }) {
  return (
    <div className="lir-card">
      <div className="lir-card-label">{label}</div>
      <div className={`lir-card-value ${tone ? `lir-${tone}` : ''}`}>
        {value == null ? '—' : value}
      </div>
      {sub && <div className="lir-card-sub">{sub}</div>}
    </div>
  );
}

const KIND_CLASS = { challenge: 'lir-tag-danger', limited: 'lir-tag-warning', failed: 'lir-tag-muted' };

const COLS_STORAGE_KEY = 'gowarm.lir.columns';

function loadCols() {
  try {
    const arr = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || 'null');
    if (Array.isArray(arr) && arr.length) {
      const valid = arr.filter(k => COLUMNS.some(c => c.key === k)).slice(0, MAX_COLS);
      if (valid.length) return new Set(valid);
    }
  } catch (_) { /* ignore corrupt/absent */ }
  return new Set(DEFAULT_COLS);
}

export default function LinkedInRiskPanel({ depth }) {
  const [windowKey, setWindowKey] = useState('7d');
  const [cols, setCols]           = useState(loadCols);
  const [showCols, setShowCols]   = useState(false);
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  // Persist column choice so it's stable across reloads (per browser).
  useEffect(() => {
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify([...cols])); } catch (_) {}
  }, [cols]);

  useEffect(() => {
    if (!depth) return;   // parent still hydrating its shared depth
    let alive = true;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    p.set('window', windowKey);
    p.set('depth', depth);   // inherited from TeamReportingView
    apiFetch(`/linkedin-autosend/risk?${p.toString()}`)
      .then(res => { if (alive) { setData(res); setLoading(false); } })
      .catch(err => { if (alive) { setError(err?.message || 'Failed to load LinkedIn risk'); setLoading(false); } });
    return () => { alive = false; };
  }, [windowKey, depth]);

  const toggleCol = useCallback((key) => {
    setCols(prev => {
      const next = new Set(prev);
      if (next.has(key))            next.delete(key);
      else if (next.size < MAX_COLS) next.add(key);
      return next;
    });
  }, []);

  const visibleColumns = useMemo(() => COLUMNS.filter(c => cols.has(c.key)), [cols]);

  const summary    = data?.summary || null;
  const seats      = data?.seats || [];
  const urnMissing = data?.urnMissingSample || [];
  const events     = data?.recentEvents || [];

  return (
    <div className="lir-root">

      <div className="trv-toolbar lir-toolbar">
        <div className="trv-toolbar-group">
          <span className="trv-toolbar-label">Window:</span>
          {WINDOWS.map(w => (
            <button
              key={w.key}
              className={`trv-window-btn ${windowKey === w.key ? 'active' : ''}`}
              onClick={() => setWindowKey(w.key)}
            >{w.label}</button>
          ))}
        </div>

        <div className="trv-toolbar-group lir-toolbar-right">
          <div className="lir-colmenu">
            <button className="trv-window-btn" onClick={() => setShowCols(s => !s)}>
              Columns ({cols.size}/{MAX_COLS})
            </button>
            {showCols && (
              <div className="lir-colmenu-pop">
                <div className="lir-colmenu-hint">Show up to {MAX_COLS} columns</div>
                {COLUMNS.map(c => {
                  const checked  = cols.has(c.key);
                  const disabled = !checked && cols.size >= MAX_COLS;
                  return (
                    <label key={c.key} className={`lir-colmenu-row ${disabled ? 'disabled' : ''}`}>
                      <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleCol(c.key)} />
                      <span>{c.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <div className="lir-error">{error}</div>}
      {(loading || !depth) && !data && <div className="lir-empty">Loading…</div>}

      {data && (
        <>
          <div className="lir-cards">
            <SummaryCard label="Challenges"    value={summary?.challenge} tone="danger"  />
            <SummaryCard label="Rate-limited"  value={summary?.limited}   tone="warning" />
            <SummaryCard label="Failures"      value={summary?.failed} />
            <SummaryCard label="Pending sends" value={summary?.pending} />
            <SummaryCard
              label="URN coverage"
              value={summary?.urnCoveragePct == null ? '—' : `${summary.urnCoveragePct}%`}
              sub={summary ? `${summary.urnMissing} of ${summary.urnPending} missing` : null}
              tone="info"
            />
          </div>

          <div className="lir-section-label">By person — you and everyone below you in the hierarchy</div>
          {seats.length === 0 ? (
            <div className="lir-empty">No LinkedIn auto-send activity in this scope and window.</div>
          ) : (
            <div className="lir-table-wrap">
              <table className="lir-table">
                <thead>
                  <tr>
                    <th className="lir-l">Seat</th>
                    {visibleColumns.map(c => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {seats.map(s => (
                    <tr key={s.userId}>
                      <td className="lir-l"><SeatName seat={s} /></td>
                      {visibleColumns.map(c => (
                        <td key={c.key} className={`lir-num ${cellClass(c.key, s[c.key])}`}>
                          {cellText(c.key, s[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {urnMissing.length > 0 && (
            <div className="lir-block">
              <div className="lir-block-head">
                <span className="lir-block-title">Missing a stored URN</span>
                <span className="lir-pill lir-pill-info">{summary?.urnMissing ?? urnMissing.length} · revisit to capture</span>
              </div>
              <div className="lir-list">
                {urnMissing.map(p => (
                  <div className="lir-list-row" key={p.prospectId}>
                    <div className="lir-list-main">
                      <span className="lir-list-name">{p.name || 'Unknown'}</span>
                    </div>
                    {p.linkedinUrl && (
                      <a className="lir-link" href={p.linkedinUrl} target="_blank" rel="noreferrer">Open profile ↗</a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {events.length > 0 && (
            <div className="lir-block">
              <div className="lir-block-head">
                <span className="lir-block-title">Recent risk events</span>
              </div>
              <div className="lir-list">
                {events.map(e => (
                  <div className="lir-list-row" key={e.logId}>
                    <span className={`lir-tag ${KIND_CLASS[e.riskKind] || 'lir-tag-muted'}`}>{e.riskKind}</span>
                    <div className="lir-list-main">
                      <span className="lir-list-name">{e.name || 'Unknown'}</span>
                      {e.linkedinUrl && (
                        <a className="lir-link-quiet" href={e.linkedinUrl} target="_blank" rel="noreferrer">profile</a>
                      )}
                    </div>
                    {e.reason && <span className="lir-reason" title={e.reason}>{e.reason}</span>}
                    <span className="lir-when">{relTime(e.firedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
