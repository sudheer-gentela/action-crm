import React, { useState } from 'react';
import './DealHealthScore.css';

const CAT_LABELS = {
  '1': 'Close Date Credibility',
  '2': 'Buyer Engagement & Power',
  '3': 'Process Completion',
  '4': 'Deal Size Realism',
  '5': 'Competitive & Pricing Risk',
  '6': 'Momentum & Activity',
};

const CAT_ICONS = { '1':'📅', '2':'👥', '3':'⚙️', '4':'💰', '5':'🥊', '6':'⚡' };

export default function DealHealthScore({ deal, onScoreDeal, scoring }) {
  const [expanded, setExpanded] = useState(false);

  const score     = deal.health_score ?? null;
  const health    = deal.health || 'healthy';
  const breakdown = deal.health_score_breakdown
    ? (typeof deal.health_score_breakdown === 'string'
        ? JSON.parse(deal.health_score_breakdown)
        : deal.health_score_breakdown)
    : null;

  const updatedAt = deal.health_score_updated_at
    ? new Date(deal.health_score_updated_at).toLocaleString()
    : null;

  const healthConfig = {
    healthy: { color: '#10b981', bg: '#d1fae5', label: '✅ Healthy', border: '#6ee7b7' },
    watch:   { color: '#f59e0b', bg: '#fef3c7', label: '⚠️ Watch',   border: '#fcd34d' },
    risk:    { color: '#ef4444', bg: '#fee2e2', label: '🔴 At Risk',  border: '#fca5a5' },
  };
  const hc = healthConfig[health] || healthConfig.healthy;

  return (
    <div className="dhs-container">

      {/* Score Badge */}
      <div className="dhs-badge" style={{ background: hc.bg, borderColor: hc.border }}>
        <div className="dhs-badge-left">
          <div className="dhs-score-ring" style={{ '--score-color': hc.color, '--score': score ?? 0 }}>
            <svg viewBox="0 0 36 36" className="dhs-ring-svg">
              <path className="dhs-ring-bg"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              <path className="dhs-ring-fill"
                style={{ stroke: hc.color, strokeDasharray: `${score ?? 0}, 100` }}
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            </svg>
            <span className="dhs-score-num" style={{ color: hc.color }}>
              {score !== null ? score : '–'}
            </span>
          </div>
        </div>
        <div className="dhs-badge-right">
          <span className="dhs-health-label" style={{ color: hc.color }}>{hc.label}</span>
          {updatedAt && <span className="dhs-updated">Scored {updatedAt}</span>}
          <div className="dhs-badge-actions">
            <button className="dhs-btn-score" onClick={onScoreDeal} disabled={scoring}>
              {scoring ? '⏳ Scoring...' : '🔄 Re-score'}
            </button>
            {breakdown && (
              <button className="dhs-btn-expand" onClick={() => setExpanded(!expanded)}>
                {expanded ? '▲ Hide breakdown' : '▼ Show breakdown'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Breakdown Panel */}
      {expanded && breakdown && (
        <div className="dhs-breakdown">

          {/* Category bars */}
          <div className="dhs-categories">
            {Object.entries(CAT_LABELS).map(([num, label]) => {
              const cat = breakdown.categories?.[num];
              if (!cat) return null;
              const catScore = cat.score ?? 100;
              const catHealth = catScore >= 80 ? 'healthy' : catScore >= 50 ? 'watch' : 'risk';
              const catHC = healthConfig[catHealth];
              return (
                <div key={num} className="dhs-cat-row">
                  <span className="dhs-cat-icon">{CAT_ICONS[num]}</span>
                  <span className="dhs-cat-label">{label}</span>
                  <div className="dhs-cat-bar-wrap">
                    <div className="dhs-cat-bar" style={{ width: `${catScore}%`, background: catHC.color }} />
                  </div>
                  <span className="dhs-cat-score" style={{ color: catHC.color }}>{catScore}</span>
                </div>
              );
            })}
          </div>

          {/* Atomic parameters */}
          <div className="dhs-params">
            <h4>Parameter Detail</h4>
            {Object.entries(breakdown.params || {}).map(([key, param]) => {
              const isPositive = (param.impact || 0) > 0;
              const isNegative = (param.impact || 0) < 0;
              const isNeutral  = (param.impact || 0) === 0;
              const state      = param.state || (param.value ? 'confirmed' : 'absent');

              const indicator = state === 'confirmed'
                ? (isNegative ? '🔴' : '✅')
                : state === 'unknown' ? '❓'
                : (isPositive ? '⬜' : '➖');

              return (
                <div key={key} className={`dhs-param-row ${state}`}>
                  <div className="dhs-param-indicator">{indicator}</div>
                  <div className="dhs-param-info">
                    <span className="dhs-param-label">{param.label}</span>

                    {state === 'unknown' && (
                      <span className="dhs-param-unknown">Not yet confirmed — no points earned</span>
                    )}

                    {param.ai !== undefined && (
                      <div className="dhs-param-signals">
                        <span className={`dhs-signal ${param.ai ? 'active' : ''}`}>
                          🤖 AI: {param.ai ? 'Yes' : param.aiSuppressed ? 'Off' : 'No'}
                          {param.source && <span className="dhs-signal-source"> ({param.source})</span>}
                        </span>
                        <span className={`dhs-signal ${param.user ? 'active' : ''}`}>
                          👤 You: {param.user ? 'Yes' : 'No'}
                        </span>
                        {param.aiSuppressed && (
                          <span className="dhs-signal-suppressed">⛔ AI off — enable in config</span>
                        )}
                        {!param.aiSuppressed && param.ai !== param.user && param.ai !== undefined && param.user !== undefined && (
                          <span className="dhs-signal-conflict">⚡ Signals differ</span>
                        )}
                      </div>
                    )}

                    {param.auto && <span className="dhs-param-auto">⚡ Auto-detected</span>}
                    {param.pushCount > 0 && <span className="dhs-param-detail">Pushed {param.pushCount}×</span>}
                    {param.daysSinceLastMeeting != null && <span className="dhs-param-detail">Last meeting: {param.daysSinceLastMeeting} days ago</span>}
                    {param.avgHours && <span className="dhs-param-detail">Avg response: {param.avgHours}h (norm: {param.normHours}h)</span>}
                    {param.count !== undefined && <span className="dhs-param-detail">{param.count} stakeholder{param.count !== 1 ? 's' : ''}</span>}
                    {param.ratio && <span className="dhs-param-detail">{param.ratio}× segment avg</span>}
                    {param.competitors?.length > 0 && <span className="dhs-param-detail">{param.competitors.map(c => c.name).join(', ')}</span>}
                    {param.execContacts?.length > 0 && <span className="dhs-param-detail">{param.execContacts.join(', ')}</span>}
                  </div>
                  <div className={`dhs-param-impact ${isPositive ? 'pos' : isNegative ? 'neg' : 'neutral'}`}>
                    {isNeutral ? '—' : `${isPositive ? '+' : ''}${param.impact}`}
                  </div>
                </div>
              );
            })}
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
