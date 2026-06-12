// ────────────────────────────────────────────────────────────────────────────
// WbrGrid.js — Phase 5 of the Outbound Insights & WBR system
// (docs/INSIGHTS_WBR_DESIGN.md)
//
// The WBR frame as a grid: rows = metrics, columns = the four trailing
// complete weeks + WoW, then MTD/QTD/YTD each with a same-days-elapsed
// prior-year comparable. Data from GET /api/prospecting-wbr/frame.
//
// Direction-aware deltas: most metrics are good-when-up; bounce_rate and
// failed are good-when-down. "—" cells mean no data / zero denominator
// (expected for YoY until a year of history exists — design doc D34).
//
// Insight annotation (the drill entry point): metrics with an open insight
// get a dot; clicking the row jumps to the Insights tab via onJumpToInsight.
//
// Props:
//   depth           — passed through to the API (scope narrowing)
//   campaignFilter  — array of campaign ids ([] = all)
//   insightMetrics  — Set of metric keys with open insights (from parent)
//   onJumpToInsight — (metricKey) => void
// ────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import './WbrGrid.css';

const GOOD_WHEN_DOWN = new Set(['bounce_rate', 'failed', 'bounces']);

const PERIOD_COLS = [
  { key: 'w4', label: 'W-4' }, { key: 'w3', label: 'W-3' },
  { key: 'w2', label: 'W-2' }, { key: 'w1', label: 'W-1' },
  { key: 'wow', label: 'WoW', isDelta: true },
  { key: 'mtd', label: 'MTD' }, { key: 'mtd_yoy', label: 'vs LY', isDelta: true },
  { key: 'qtd', label: 'QTD' }, { key: 'qtd_yoy', label: 'vs LY', isDelta: true },
  { key: 'ytd', label: 'YTD' }, { key: 'ytd_yoy', label: 'vs LY', isDelta: true },
];

function fmtValue(cell, type) {
  if (!cell || cell.value === null || cell.value === undefined) return '—';
  if (type === 'rate') return `${(cell.value * 100).toFixed(1)}%`;
  return Number(cell.value).toLocaleString();
}

function fmtDelta(d, type) {
  if (!d || d.delta === null || d.delta === undefined) return '—';
  if (type === 'rate') {
    const pts = d.delta * 100;
    return `${pts > 0 ? '+' : ''}${pts.toFixed(1)}pt`;
  }
  if (d.delta_rel !== null && d.delta_rel !== undefined) {
    const p = d.delta_rel * 100;
    return `${p > 0 ? '+' : ''}${p.toFixed(0)}%`;
  }
  return `${d.delta > 0 ? '+' : ''}${Number(d.delta).toLocaleString()}`;
}

function deltaClass(d, metricKey) {
  if (!d || d.delta === null || d.delta === undefined || Number(d.delta) === 0) return 'wbr-delta-flat';
  const up = Number(d.delta) > 0;
  const good = GOOD_WHEN_DOWN.has(metricKey) ? !up : up;
  return good ? 'wbr-delta-good' : 'wbr-delta-bad';
}

function fmtRange(p) {
  if (!p) return '';
  const f = (s) => new Date(`${s}T00:00:00Z`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(p.start)} – ${f(p.end)}`;
}

export default function WbrGrid({ depth, campaignFilter = [], insightMetrics, onJumpToInsight }) {
  const [frame, setFrame] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const campaignKey = campaignFilter.join(',');
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (depth) params.set('depth', depth);
    if (campaignKey) params.set('campaignIds', campaignKey);
    apiFetch(`/prospecting-wbr/frame?${params.toString()}`)
      .then(setFrame)
      .catch((e) => setError(e.message || 'Failed to load WBR frame'))
      .finally(() => setLoading(false));
  }, [depth, campaignKey]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="wbr-state">Loading WBR frame…</div>;
  if (error) {
    return (
      <div className="wbr-state wbr-state-error">
        {error} <button className="wbr-retry" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!frame || !frame.metrics) return <div className="wbr-state">No data yet.</div>;

  const { periods, metrics, asOf, calendar } = frame;
  const allZero = metrics.every((m) =>
    ['w4', 'w3', 'w2', 'w1', 'mtd'].every((p) => !m.cells[p] || !m.cells[p].n)
  );

  return (
    <div className="wbr-root">
      {allZero && (
        <div className="wbr-empty-note">
          No snapshot data in the current periods yet. The nightly job (or a
          manual backfill) fills this grid from your outbound activity.
        </div>
      )}
      <div className="wbr-scroll">
        <table className="wbr-table">
          <thead>
            <tr>
              <th className="wbr-th wbr-th-metric">Metric</th>
              {PERIOD_COLS.map((c, i) => (
                <th
                  key={c.key + i}
                  className={`wbr-th ${c.isDelta ? 'wbr-th-delta' : ''}`}
                  title={periods[c.key] ? fmtRange(periods[c.key]) : ''}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const hasInsight = insightMetrics && insightMetrics.has(m.key);
              return (
                <tr
                  key={m.key}
                  className={`wbr-row ${hasInsight ? 'wbr-row-flagged' : ''}`}
                  onClick={hasInsight && onJumpToInsight ? () => onJumpToInsight(m.key) : undefined}
                  title={hasInsight ? 'Open insight — click to see the diagnosis' : undefined}
                >
                  <td className="wbr-td wbr-td-metric">
                    {hasInsight && <span className="wbr-insight-dot" aria-label="Open insight" />}
                    {m.label}
                  </td>
                  {PERIOD_COLS.map((c, i) => {
                    if (c.isDelta) {
                      const d = m.cells[c.key];
                      return (
                        <td key={c.key + i} className={`wbr-td wbr-td-delta ${deltaClass(d, m.key)}`}>
                          {fmtDelta(d, m.type)}
                        </td>
                      );
                    }
                    const cell = m.cells[c.key];
                    return (
                      <td key={c.key} className="wbr-td wbr-td-num" title={cell && cell.n ? `n = ${cell.n}` : ''}>
                        {fmtValue(cell, m.type)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="wbr-footnote">
        Complete days through {asOf} · dates bucketed in {calendar?.timezone || 'UTC'} ·
        W-1 is the most recent complete week · "vs LY" compares the same days elapsed
        last year · rates recomputed per period from raw counts
      </div>
    </div>
  );
}
