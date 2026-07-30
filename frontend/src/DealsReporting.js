// ─────────────────────────────────────────────────────────────────────────────
// DealsReporting.js
//
// DROP-IN LOCATION: frontend/src/DealsReporting.js
//
// Renders one of the Deals module reports by key:
//   pipeline_health · funnel · forecast · winloss
// Pipeline health reuses PortfolioHealthReport (deals fetcher + deal lenses).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import PortfolioHealthReport from './PortfolioHealthReport';

const DEAL_LENSES = [
  { k: 'owner',   label: 'Owner' },
  { k: 'stage',   label: 'Stage' },
  { k: 'account', label: 'Account' },
  { k: 'none',    label: 'Overall' },
];

const BUCKETS = [
  { k: 'week', label: 'Week' }, { k: 'month', label: 'Month' },
  { k: 'quarter', label: 'Quarter' }, { k: 'half', label: 'Half-year' },
];

function fmtMoney(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

const card = { background: '#fff', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 16 };

function Funnel() {
  const [d, setD] = useState(null);
  useEffect(() => { apiService.handovers.dealsFunnel().then(r => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d) return <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>;
  const max = Math.max(1, ...d.stages.map(s => s.value));
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 500 }}>Pipeline funnel</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{d.totalCount} open · {fmtMoney(d.totalValue)}</span>
      </div>
      {d.stages.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No open deals.</div>
        : d.stages.map(s => (
          <div key={s.stage} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
              <span style={{ fontWeight: 500 }}>{s.label}</span>
              <span style={{ color: '#6b7280' }}>{s.count} · {fmtMoney(s.value)}</span>
            </div>
            <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4 }}>
              <div style={{ width: `${(s.value / max) * 100}%`, height: '100%', background: '#1d4ed8', borderRadius: 4 }} />
            </div>
          </div>
        ))}
    </div>
  );
}

function Forecast() {
  const [bucket, setBucket] = useState(() => {
    try { return localStorage.getItem('gw_forecast_bucket') || 'month'; } catch { return 'month'; }
  });
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    apiService.handovers.dealsForecast(bucket).then(r => setD(r.data)).catch(() => setD(null));
    try { localStorage.setItem('gw_forecast_bucket', bucket); } catch { /* ignore */ }
  }, [bucket]);
  const max = d ? Math.max(1, ...d.buckets.map(b => b.weighted)) : 1;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 500 }}>Forecast</span>
        {d && <span style={{ fontSize: 12, color: '#6b7280' }}>weighted {fmtMoney(d.totalWeighted)} of {fmtMoney(d.totalRaw)} open</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {BUCKETS.map(b => (
            <button key={b.k} onClick={() => setBucket(b.k)} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              background: bucket === b.k ? '#1d4ed8' : '#fff', color: bucket === b.k ? '#fff' : '#374151',
              border: `1px solid ${bucket === b.k ? '#1d4ed8' : '#e5e7eb'}`, fontWeight: bucket === b.k ? 600 : 400 }}>{b.label}</button>
          ))}
        </div>
      </div>
      {!d ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        : d.buckets.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No open deals with a close date.</div>
        : d.buckets.map(b => (
          <div key={b.key} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
              <span style={{ fontWeight: 500 }}>{b.label}</span>
              <span style={{ color: '#6b7280' }}>{fmtMoney(b.weighted)} <span style={{ color: '#9ca3af' }}>({b.count} · {fmtMoney(b.raw)})</span></span>
            </div>
            <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4 }}>
              <div style={{ width: `${(b.weighted / max) * 100}%`, height: '100%', background: '#059669', borderRadius: 4 }} />
            </div>
          </div>
        ))}
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>Weighted = value × probability. Bars are weighted; raw value and deal count in parentheses.</div>
    </div>
  );
}

function WinLoss() {
  const [groupBy, setGroupBy] = useState('owner');
  const [windowDays, setWindowDays] = useState(90);
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); apiService.handovers.dealsWinLoss(windowDays, groupBy).then(r => setD(r.data)).catch(() => setD(null)); }, [groupBy, windowDays]);
  const o = d?.overall;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 500 }}>Win / loss</span>
        {o && <span style={{ fontSize: 20, fontWeight: 700, color: '#059669' }}>{o.winRate}%</span>}
        {o && <span style={{ fontSize: 12, color: '#6b7280' }}>{o.won}W · {o.lost}L · won {fmtMoney(o.wonValue)}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={windowDays} onChange={e => setWindowDays(Number(e.target.value))} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db' }}>
            <option value={30}>30d</option><option value={90}>90d</option><option value={180}>180d</option><option value={365}>365d</option>
          </select>
          <select value={groupBy} onChange={e => setGroupBy(e.target.value)} style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db' }}>
            <option value="owner">By owner</option><option value="stage">By stage</option>
          </select>
        </div>
      </div>
      {!d ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        : d.groups.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No closed deals in this window.</div>
        : d.groups.map(g => (
          <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', borderTop: '0.5px solid #f3f4f6', fontSize: 13 }}>
            <span style={{ flex: 1, fontWeight: 500 }}>{g.label}</span>
            <div style={{ width: 120, height: 8, background: '#fee2e2', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${g.winRate}%`, height: '100%', background: '#16a34a' }} />
            </div>
            <span style={{ width: 40, textAlign: 'right', color: '#374151' }}>{g.winRate}%</span>
            <span style={{ width: 90, textAlign: 'right', color: '#9ca3af', fontSize: 12 }}>{g.won}W · {g.lost}L</span>
          </div>
        ))}
    </div>
  );
}

export default function DealsReporting({ reportKey }) {
  if (reportKey === 'pipeline_health')
    return <PortfolioHealthReport title="Pipeline health — deals" fetcher={apiService.handovers.dealsHealth} lenses={DEAL_LENSES} />;
  if (reportKey === 'funnel')   return <Funnel />;
  if (reportKey === 'forecast') return <Forecast />;
  if (reportKey === 'winloss')  return <WinLoss />;
  return null;
}
