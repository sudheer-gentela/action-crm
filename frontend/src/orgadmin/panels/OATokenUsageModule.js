/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OATokenUsageModule. */
import React from 'react';
import { CALL_TYPE_LABELS, MODULE_COLORS } from '../constants';
import { formatCost, formatTokens } from '../helpers';
import { UsageBar } from '../shared';

export default function OATokenUsageModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { Authorization: `Bearer ${token}` };

  const [days,    setDays]    = React.useState(30);
  const [data,    setData]    = React.useState(null);
  const [costEst, setCostEst] = React.useState(null);  // per-feature cost catalog
  const [loading, setLoading] = React.useState(true);
  const [error,   setError]   = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    // Load token usage and cost estimates in parallel. Both come from the
    // same orgAdmin router (mounted at /api/org/admin) so they share the
    // adminOnly middleware. The old `${API}/ai-usage/org` URL was a stale
    // path — the correct route is `/api/org/admin/ai-usage`. Cost estimates
    // live alongside at `/api/org/admin/ai-cost-estimates`.
    Promise.all([
      fetch(`${API}/org/admin/ai-usage?days=${days}`, { headers })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('usage ' + r.status))),
      fetch(`${API}/org/admin/ai-cost-estimates?lookbackDays=${days}`, { headers })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('estimates ' + r.status))),
    ])
      .then(([u, c]) => { setData(u); setCostEst(c); setLoading(false); })
      .catch((e) => { setError('Failed to load: ' + e.message); setLoading(false); });
  }, [days]); // eslint-disable-line

  const totals   = data?.totals  || {};
  const byType   = data?.byType  || [];
  const byUser   = data?.byUser  || [];
  const daily    = data?.daily   || [];

  const maxTypeTokens = byType.reduce((m, r) => Math.max(m, parseInt(r.total_tokens) || 0), 0);
  const maxUserTokens = byUser.reduce((m, r) => Math.max(m, parseInt(r.total_tokens) || 0), 0);

  const pillStyle = (active) => ({
    padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500, cursor: 'pointer',
    background: active ? '#0F9D8E' : '#f3f4f6',
    color:      active ? '#fff'    : '#6b7280',
    border: 'none',
  });

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🤖 AI Usage</h2>
          <p className="sv-panel-desc">Token consumption and estimated cost across all AI features.</p>
        </div>
      </div>

      {/* Period selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
        {[7, 30, 60, 90].map(d => (
          <button key={d} style={pillStyle(days === d)} onClick={() => setDays(d)}>
            {d}d
          </button>
        ))}
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          {/* ── Summary cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 28 }}>
            {[
              { label: 'Total Tokens',   value: formatTokens(totals.total_tokens),  sub: `${parseInt(totals.call_count)||0} calls`, color: '#6366f1' },
              { label: 'Est. Cost',      value: formatCost(totals.estimated_cost),  sub: `last ${days} days`,                       color: '#f59e0b' },
              { label: 'Avg per Call',   value: totals.call_count > 0 ? formatTokens(Math.round(totals.total_tokens / totals.call_count)) : '—', sub: 'tokens/call', color: '#0F9D8E' },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* ── Cost per Feature (typical) ──────────────────────────────────
              Per-call-type cost projection for THIS org, using the model
              each call_type actually resolves to (via AIClientResolver). The
              "typical" input/output sizes come from this org's own history
              (median of last 30 days) once there are ≥ 5 samples per
              call_type; otherwise they fall back to a hardcoded catalog.

              Three numbers per row:
                Typical cost   — projection per single call
                Cached cost    — for cache-eligible skills (e.g. drafts),
                                 the cache-read price; shown as a second
                                 number when it's meaningfully cheaper
                Recent spend   — what this org has actually spent in the
                                 lookback window (real billed cost from
                                 ai_token_usage.estimated_cost_usd) ──── */}
          {costEst && Object.keys(costEst.estimates || {}).length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: '#374151' }}>
                Cost per Feature <span style={{ fontWeight: 400, color: '#9ca3af' }}>(typical, per call)</span>
              </h4>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
                Projected from {costEst.period?.sample_days || 30}-day median where available, fallback catalog otherwise. Models resolved from this org's AI settings.
              </div>

              {/* Bundles — multi-call user actions, top */}
              {costEst.bundles && Object.keys(costEst.bundles).length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 16 }}>
                  {Object.entries(costEst.bundles).map(([bid, b]) => (
                    <div key={bid} style={{
                      background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 10, padding: '12px 14px',
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>{b.label}</div>
                      <div style={{ fontSize: 11, color: '#0d9488', marginBottom: 8 }}>{b.desc}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#0F9D8E' }}>{formatCost(b.cold_cost_usd)}</div>
                          <div style={{ fontSize: 10, color: '#9ca3af' }}>cold</div>
                        </div>
                        {b.warm_cost_usd != null && b.warm_cost_usd < b.cold_cost_usd && (
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#0d9488' }}>{formatCost(b.warm_cost_usd)}</div>
                            <div style={{ fontSize: 10, color: '#9ca3af' }}>warm / cached</div>
                          </div>
                        )}
                      </div>
                      {b.notes && (
                        <div style={{ fontSize: 10, color: '#6b7280', marginTop: 8, fontStyle: 'italic' }}>{b.notes}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Per-call-type table */}
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1.8fr 1fr 0.9fr 0.9fr 1fr',
                  padding: '8px 12px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
                  fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  <div>Feature</div>
                  <div>Model</div>
                  <div style={{ textAlign: 'right' }}>Per Call</div>
                  <div style={{ textAlign: 'right' }}>Cached</div>
                  <div style={{ textAlign: 'right' }}>Recent ({days}d)</div>
                </div>
                {Object.entries(costEst.estimates)
                  .filter(([ct, e]) => e.recent_calls > 0 || e.source === 'fallback')  // hide noise
                  .sort((a, b) => (b[1].recent_cost_usd || 0) - (a[1].recent_cost_usd || 0))
                  .map(([ct, e]) => (
                  <div key={ct} style={{
                    display: 'grid',
                    gridTemplateColumns: '1.8fr 1fr 0.9fr 0.9fr 1fr',
                    padding: '10px 12px', borderBottom: '1px solid #f3f4f6',
                    fontSize: 12, alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#374151' }}>{e.label}</div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>
                        {e.desc}
                        {e.source === 'historical' && (
                          <span title={`Median over ${e.sample_count} calls`}> · historical</span>
                        )}
                        {e.source === 'fallback' && (
                          <span title="No historical data yet — estimate from prompt template"> · estimate</span>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
                      {e.model || '—'}
                    </div>
                    <div style={{ textAlign: 'right', fontWeight: 600, color: '#111827' }}>
                      {formatCost(e.cost_usd)}
                    </div>
                    <div style={{ textAlign: 'right', color: e.cached_cost_usd != null ? '#0d9488' : '#d1d5db' }}>
                      {e.cached_cost_usd != null ? formatCost(e.cached_cost_usd) : '—'}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ color: '#374151', fontWeight: 600 }}>{formatCost(e.recent_cost_usd)}</div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>{e.recent_calls} call{e.recent_calls === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── By module ── */}
          {(data?.byModule || []).length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#374151' }}>By Module</h4>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(data.byModule || []).map(m => (
                  <div key={m.module} style={{ flex: '1 1 140px', background: '#f9fafb', border: `2px solid ${MODULE_COLORS[m.module] || '#e5e7eb'}`, borderRadius: 10, padding: '12px 16px' }}>
                    <div style={{ fontSize: 11, color: MODULE_COLORS[m.module] || '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{m.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{formatTokens(m.total_tokens)}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{m.call_count} calls · {formatCost(m.estimated_cost)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── By feature type ── */}
          <div style={{ marginBottom: 28 }}>
            <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#374151' }}>By Feature</h4>
            {byType.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: 13 }}>No data yet.</p>
            ) : byType.map(row => (
              <div key={row.call_type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ width: 180, fontSize: 12, color: '#374151', flexShrink: 0 }}>
                  {CALL_TYPE_LABELS[row.call_type] || row.call_type}
                </div>
                <UsageBar value={parseInt(row.total_tokens)||0} max={maxTypeTokens} />
                <div style={{ width: 60, textAlign: 'right', fontSize: 12, color: '#6b7280', flexShrink: 0 }}>
                  {formatTokens(row.total_tokens)}
                </div>
                <div style={{ width: 52, textAlign: 'right', fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>
                  {formatCost(row.estimated_cost)}
                </div>
              </div>
            ))}
          </div>

          {/* ── By user ── */}
          {byUser.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#374151' }}>By User</h4>
              {byUser.map(row => (
                <div key={row.user_id} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid #f3f4f6' }}>
                  {/* User total row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <div style={{ width: 160, fontSize: 12, fontWeight: 600, color: '#374151', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.user_name}
                    </div>
                    <UsageBar value={parseInt(row.total_tokens)||0} max={maxUserTokens} color="#6366f1" />
                    <div style={{ width: 60, textAlign: 'right', fontSize: 12, color: '#374151', fontWeight: 600, flexShrink: 0 }}>
                      {formatTokens(row.total_tokens)}
                    </div>
                    <div style={{ width: 52, textAlign: 'right', fontSize: 11, color: '#9ca3af', flexShrink: 0 }}>
                      {formatCost(row.estimated_cost)}
                    </div>
                  </div>
                  {/* Per-user module pills */}
                  {(row.modules || []).length > 0 && (
                    <div style={{ display: 'flex', gap: 6, paddingLeft: 170 }}>
                      {(row.modules || []).map(m => (
                        <span key={m.module} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: (MODULE_COLORS[m.module] || '#9ca3af') + '20', color: MODULE_COLORS[m.module] || '#6b7280', fontWeight: 600 }}>
                          {m.label}: {formatTokens(m.total_tokens)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Daily history table ── */}
          {daily.length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#374151' }}>Daily History</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    {['Date', 'Calls', 'Tokens', 'Est. Cost'].map(h => (
                      <th key={h} style={{ padding: '4px 8px', textAlign: h === 'Date' ? 'left' : 'right', color: '#9ca3af', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {daily.slice(0, 14).map(row => (
                    <tr key={row.day} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '5px 8px', color: '#374151' }}>{row.day}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280' }}>{row.call_count}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#374151' }}>{formatTokens(row.total_tokens)}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280' }}>{formatCost(row.estimated_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
