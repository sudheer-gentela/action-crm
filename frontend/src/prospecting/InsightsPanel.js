// ────────────────────────────────────────────────────────────────────────────
// InsightsPanel.js — Phase 5 of the Outbound Insights & WBR system
// (docs/INSIGHTS_WBR_DESIGN.md)
//
// The nightly engine's findings, with the full drill path:
//   insight card → detail (hypothesis + segment breakdown + action)
//   → evidence table (step logs / prospects / delivery events, paginated)
//   → ProspectDetailPanel (the existing leaf view — drill ends at raw records)
//
// Data: GET /api/prospecting-insights, /:id, /:id/evidence; POST /:id/acknowledge.
//
// Props:
//   focusMetric     — optional metric key to auto-expand (from WBR grid dot)
//   onInsightsLoaded — optional (insights[]) => void, lets the parent build
//                      the WBR grid's insight-dot set from one fetch
// ────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import ProspectDetailPanel from './ProspectDetailPanel';
import './InsightsPanel.css';

const CAUSE_LABELS = {
  list_targeting: 'List / targeting',
  deliverability_sender: 'Sender health',
  deliverability_domain: 'Domain health',
  message_step: 'Message / copy',
  timing_cadence: 'Timing / cadence',
  rep_execution: 'Rep execution',
  capacity_volume: 'Capacity',
  list_exhaustion: 'List exhaustion',
  mixed_confounded: 'Multiple factors',
};

const METRIC_LABELS = {
  reply_rate: 'Reply rate',
  bounce_rate: 'Bounce rate',
  send_volume: 'Send volume',
  list_runway: 'List runway',
};

const EVIDENCE_TABS = [
  { key: 'step_logs', label: 'Sends' },
  { key: 'prospects', label: 'Prospects' },
  { key: 'delivery_events', label: 'Bounces' },
];

const PAGE_SIZE = 10;

function fmtWindow(ins) {
  const f = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(ins.current_window_start)} – ${f(ins.current_window_end)}`;
}

function fmtAge(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

// ── Evidence table (drill level 3) ──────────────────────────────────────────

function EvidenceTable({ insightId, counts, onOpenProspect }) {
  const available = EVIDENCE_TABS.filter((t) => (counts[t.key] || 0) > 0);
  const [type, setType] = useState(available[0]?.key || 'step_logs');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/prospecting-insights/${insightId}/evidence?type=${type}&limit=${PAGE_SIZE}&offset=${offset}`)
      .then(setData)
      .catch(() => setData({ rows: [], total: 0 }))
      .finally(() => setLoading(false));
  }, [insightId, type, offset]);

  if (available.length === 0) {
    return <div className=" insx-evidence-empty">No sampled evidence rows for this finding (state-based insights summarize live counts instead).</div>;
  }

  const rows = data?.rows || [];
  const total = data?.total || 0;

  return (
    <div className="insx-evidence">
      <div className="insx-evidence-tabs">
        {available.map((t) => (
          <button
            key={t.key}
            className={`insx-evidence-tab ${type === t.key ? 'active' : ''}`}
            onClick={() => { setType(t.key); setOffset(0); }}
          >
            {t.label} ({counts[t.key]})
          </button>
        ))}
      </div>

      {loading ? (
        <div className="insx-evidence-empty">Loading evidence…</div>
      ) : (
        <table className="insx-evidence-table">
          <tbody>
            {type === 'step_logs' && rows.map((r) => (
              <tr key={r.id} className="insx-ev-row" onClick={() => r.prospect_id && onOpenProspect(r.prospect_id)}>
                <td className="insx-ev-main">
                  <span className="insx-ev-name">{r.prospect_name || '—'}</span>
                  <span className="insx-ev-sub">{r.company_name || ''}</span>
                </td>
                <td>{r.channel}</td>
                <td><span className={`insx-status insx-status-${r.status}`}>{r.status}</span></td>
                <td className="insx-ev-detail" title={r.subject || ''}>{r.subject || '—'}</td>
                <td className="insx-ev-when">{fmtAge(r.fired_at)}</td>
              </tr>
            ))}
            {type === 'prospects' && rows.map((r) => (
              <tr key={r.id} className="insx-ev-row" onClick={() => onOpenProspect(r.id)}>
                <td className="insx-ev-main">
                  <span className="insx-ev-name">{r.name || r.email}</span>
                  <span className="insx-ev-sub">{r.company_name || ''}{r.title ? ` · ${r.title}` : ''}</span>
                </td>
                <td>{r.stage}</td>
                <td>fit {r.icp_score ?? '—'}</td>
                <td className="insx-ev-detail">{r.email}</td>
                <td />
              </tr>
            ))}
            {type === 'delivery_events' && rows.map((r) => (
              <tr key={r.id} className="insx-ev-row" onClick={() => r.prospect_id && onOpenProspect(r.prospect_id)}>
                <td className="insx-ev-main">
                  <span className="insx-ev-name">{r.failed_recipient}</span>
                  <span className="insx-ev-sub">{r.smtp_code || ''}</span>
                </td>
                <td><span className={`insx-status insx-status-${r.event_type}`}>{r.event_type.replace('_', ' ')}</span></td>
                <td>{r.enrollment_stopped ? 'sequence stopped' : ''}</td>
                <td className="insx-ev-detail" title={r.diagnostic_excerpt || ''}>{r.diagnostic_excerpt || '—'}</td>
                <td className="insx-ev-when">{fmtAge(r.detected_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total > PAGE_SIZE && (
        <div className="insx-pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ Prev</button>
          <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total} sampled</span>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next ›</button>
        </div>
      )}
    </div>
  );
}

// ── Insight card (levels 1–2) ────────────────────────────────────────────────

function InsightCard({ insight, expanded, onToggle, onAcknowledge, onOpenProspect }) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    if (expanded && !detail) {
      apiFetch(`/prospecting-insights/${insight.id}`).then(setDetail).catch(() => {});
    }
  }, [expanded, insight.id, detail]);

  const seg = insight.segment || {};
  const breakdown = detail?.evidence?.breakdown || [];
  const counts = detail?.evidence?.counts || {};
  const isRate = ['reply_rate', 'bounce_rate'].includes(insight.metric);
  const fmtV = (v) => (v === null || v === undefined) ? '—'
    : isRate ? `${(Number(v) * 100).toFixed(1)}%` : Number(v).toLocaleString();

  return (
    <div className={`insx-card ${insight.status === 'resolved' ? 'insx-card-resolved' : ''}`}>
      <button className="insx-card-head" onClick={onToggle} aria-expanded={expanded}>
        <div className="insx-card-chips">
          <span className={`insx-chip insx-chip-status-${insight.status}`}>{insight.status}</span>
          <span className="insx-chip insx-chip-metric">{METRIC_LABELS[insight.metric] || insight.metric}</span>
          <span className="insx-chip insx-chip-cause">{CAUSE_LABELS[insight.cause_code] || insight.cause_code}</span>
          {seg.label && <span className="insx-chip insx-chip-seg">{seg.label}</span>}
        </div>
        <div className="insx-card-headline">{insight.headline}</div>
        <div className="insx-card-meta">
          {fmtWindow(insight)} · {insight.impact_estimate} · detected {fmtAge(insight.first_detected_at)}
          <span className="insx-card-caret">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div className="insx-card-body">
          <div className="insx-numbers">
            <div className="insx-number">
              <div className="insx-number-label">This week</div>
              <div className="insx-number-value">{fmtV(insight.observed)}</div>
              <div className="insx-number-sub">n = {insight.observed_n}</div>
            </div>
            <div className="insx-number">
              <div className="insx-number-label">Baseline</div>
              <div className="insx-number-value">{fmtV(insight.baseline)}</div>
              <div className="insx-number-sub">n = {insight.baseline_n}</div>
            </div>
          </div>

          {detail ? (
            <>
              <div className="insx-section">
                <div className="insx-section-title">Why</div>
                <div className="insx-text">{detail.hypothesis}</div>
              </div>
              {breakdown.length > 0 && (
                <div className="insx-section">
                  <div className="insx-section-title">Segment breakdown ({breakdown[0].dim.replace('_', ' ')})</div>
                  <table className="insx-breakdown">
                    <thead>
                      <tr><th>Segment</th><th>This week</th><th>Baseline</th><th>n</th></tr>
                    </thead>
                    <tbody>
                      {breakdown.map((b, i) => (
                        <tr key={i}>
                          <td>{b.label || b.value}</td>
                          <td>{b.cur_rate}%</td>
                          <td>{b.base_rate}%</td>
                          <td>{b.cur_n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="insx-section">
                <div className="insx-section-title">Recommended action</div>
                <div className="insx-text">{detail.recommended_action}</div>
              </div>
              <div className="insx-section">
                <div className="insx-section-title">Evidence</div>
                <EvidenceTable insightId={insight.id} counts={counts} onOpenProspect={onOpenProspect} />
              </div>
            </>
          ) : (
            <div className="insx-evidence-empty">Loading detail…</div>
          )}

          {insight.status === 'new' && (
            <div className="insx-actions">
              <button className="insx-ack-btn" onClick={() => onAcknowledge(insight.id)}>
                Acknowledge
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function InsightsPanel({ focusMetric, onInsightsLoaded }) {
  const [insights, setInsights] = useState(null);
  const [error, setError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [openProspectId, setOpenProspectId] = useState(null);

  const load = useCallback(() => {
    setError(null);
    apiFetch(`/prospecting-insights${showResolved ? '?status=all' : ''}`)
      .then((res) => {
        const list = res.insights || [];
        setInsights(list);
        if (onInsightsLoaded) onInsightsLoaded(list);
      })
      .catch((e) => setError(e.message || 'Failed to load insights'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showResolved]);

  useEffect(() => { load(); }, [load]);

  // Auto-expand when arriving from a WBR grid dot.
  useEffect(() => {
    if (focusMetric && insights) {
      const hit = insights.find((i) => i.metric === focusMetric && i.status !== 'resolved');
      if (hit) setExpandedId(hit.id);
    }
  }, [focusMetric, insights]);

  const acknowledge = (id) => {
    apiFetch(`/prospecting-insights/${id}/acknowledge`, { method: 'POST' })
      .then(load)
      .catch(() => {});
  };

  if (error) return <div className="insx-state insx-state-error">{error}</div>;
  if (!insights) return <div className="insx-state">Loading insights…</div>;

  return (
    <div className="insx-root">
      <div className="insx-toolbar">
        <div className="insx-toolbar-note">
          Nightly diagnostics on the outbound motion. Findings below sample-size
          floors are suppressed by design — silence means no trustworthy signal,
          not no problems.
        </div>
        <label className="insx-toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {insights.length === 0 ? (
        <div className="insx-state">
          No open insights. The engine reports here when a metric moves beyond
          its baseline with enough volume behind it.
        </div>
      ) : (
        insights.map((ins) => (
          <InsightCard
            key={ins.id}
            insight={ins}
            expanded={expandedId === ins.id}
            onToggle={() => setExpandedId(expandedId === ins.id ? null : ins.id)}
            onAcknowledge={acknowledge}
            onOpenProspect={setOpenProspectId}
          />
        ))
      )}

      {openProspectId && (
        <ProspectDetailPanel
          prospectId={openProspectId}
          initialTab="overview"
          onClose={() => setOpenProspectId(null)}
          onUpdate={() => {}}
        />
      )}
    </div>
  );
}
