/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OADiagnosticRulesSummary. Includes co-located single-consumer constants/helpers. */
import React, { useState, useEffect } from 'react';

const PRIORITY_COLORS = {
  critical: { bg: '#fef2f2', color: '#991b1b', border: '#fecaca' },
  high:     { bg: '#fff7ed', color: '#9a3412', border: '#fed7aa' },
  medium:   { bg: '#fefce8', color: '#854d0e', border: '#fef08a' },
  low:      { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  'n/a':    { bg: '#f8fafc', color: '#64748b', border: '#e2e8f0' },
};

export default function OADiagnosticRulesSummary() {
  const API     = process.env.REACT_APP_API_URL || '';
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { Authorization: `Bearer ${token}` };

  const [summary,   setSummary]   = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [expanded,  setExpanded]  = useState('deals');
  const [showAll,   setShowAll]   = useState({});  // { moduleKey: bool } — show non-configurable rules

  useEffect(() => {
    fetch(`${API}/org/admin/diagnostic-rules/summary`, { headers })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setSummary(data))
      .catch(() => setError('Failed to load rules summary'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  if (loading) return <div className="sv-loading">Generating rules summary…</div>;
  if (error)   return <div className="sv-alert sv-alert--error">⚠️ {error}</div>;
  if (!summary) return null;

  const generatedAt = new Date(summary.generated_at).toLocaleString();

  return (
    <div style={{ paddingTop: 16 }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
          Live diagnostic rules for your organisation — thresholds reflect your current configuration.
          Rules marked <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '1px 6px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>CONFIGURABLE</span> can be adjusted in the Edit Rules tab.
        </p>
        <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap', marginLeft: 16 }}>
          Generated {generatedAt}
        </span>
      </div>

      {summary.modules.map(mod => {
        const isExpanded    = expanded === mod.key;
        const configurableRules = mod.rules.filter(r => r.configurable);
        const fixedRules        = mod.rules.filter(r => !r.configurable);
        const showingAll        = !!showAll[mod.key];
        const visibleRules      = showingAll ? mod.rules : configurableRules;
        const hasCustomised     = Object.values(mod.config).some(v => v.customised);

        return (
          <div key={mod.key} style={{
            border: '1px solid #e5e7eb', borderRadius: 10,
            overflow: 'hidden', background: '#fff', marginBottom: 12,
          }}>
            {/* Module header */}
            <button
              onClick={() => setExpanded(isExpanded ? null : mod.key)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', padding: '14px 20px',
                background: isExpanded ? '#f8fafc' : '#fff',
                border: 'none', cursor: 'pointer',
                borderBottom: isExpanded ? '1px solid #e5e7eb' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>{mod.icon}</span>
                <span style={{ fontWeight: 700, fontSize: 15, color: '#1e293b' }}>{mod.label}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  {mod.rules.length} rule{mod.rules.length !== 1 ? 's' : ''}
                  {' · '}{configurableRules.length} configurable
                </span>
                {hasCustomised && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                    background: '#dbeafe', color: '#1d4ed8', textTransform: 'uppercase',
                  }}>Customised</span>
                )}
              </div>
              <span style={{ color: '#94a3b8', fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</span>
            </button>

            {isExpanded && (
              <div style={{ padding: '20px 24px' }}>

                {/* Config summary row */}
                {Object.keys(mod.config).length > 0 && (
                  <div style={{
                    background: '#f8fafc', borderRadius: 8, padding: '12px 16px',
                    marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: '12px 24px',
                  }}>
                    {Object.entries(mod.config).map(([key, cfg]) => (
                      <div key={key}>
                        <span style={{
                          fontSize: 11, color: cfg.customised ? '#1d4ed8' : '#64748b',
                          fontWeight: cfg.customised ? 700 : 500,
                        }}>
                          {key.replace(/_/g, ' ')}:&nbsp;
                          <strong style={{ color: cfg.customised ? '#1d4ed8' : '#1e293b' }}>
                            {key === 'wrong_channel_max_response_rate'
                              ? `${Math.round(cfg.value * 100)}%`
                              : key === 'high_value_threshold'
                              ? `$${cfg.value.toLocaleString()}`
                              : cfg.value}
                          </strong>
                          {cfg.customised && (
                            <span style={{ color: '#93c5fd', fontWeight: 400 }}>
                              {' '}(default: {key === 'wrong_channel_max_response_rate'
                                ? `${Math.round(cfg.default * 100)}%`
                                : key === 'high_value_threshold'
                                ? `$${cfg.default.toLocaleString()}`
                                : cfg.default})
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Rules table */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {visibleRules.map(rule => {
                    const pc = PRIORITY_COLORS[rule.priority] || PRIORITY_COLORS['n/a'];
                    return (
                      <div key={rule.key} style={{
                        border: `1px solid ${pc.border}`, borderRadius: 8,
                        background: pc.bg, padding: '12px 16px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{rule.title}</span>
                              <span style={{
                                fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                background: pc.color + '22', color: pc.color, fontWeight: 700,
                                textTransform: 'uppercase',
                              }}>{rule.priority}</span>
                              {rule.configurable && (
                                <span style={{
                                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                  background: '#dbeafe', color: '#1d4ed8', fontWeight: 700,
                                  textTransform: 'uppercase',
                                }}>Configurable</span>
                              )}
                            </div>
                            <p style={{ fontSize: 12, color: '#374151', margin: '0 0 6px 0', lineHeight: 1.5 }}>
                              {rule.description}
                            </p>
                            <div style={{ fontSize: 11, color: '#6b7280' }}>
                              <span style={{ fontWeight: 600 }}>Trigger: </span>{rule.trigger}
                              <span style={{ marginLeft: 12, color: '#94a3b8' }}>· {rule.mode}</span>
                            </div>
                          </div>
                          <div style={{
                            fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap',
                            textAlign: 'right', minWidth: 80,
                          }}>
                            <span style={{ fontWeight: 600 }}>Next step</span><br />
                            {rule.next_step}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Show/hide fixed rules toggle */}
                {fixedRules.length > 0 && (
                  <button
                    onClick={() => setShowAll(prev => ({ ...prev, [mod.key]: !prev[mod.key] }))}
                    style={{
                      marginTop: 12, background: 'none', border: 'none',
                      color: '#6b7280', fontSize: 12, cursor: 'pointer', padding: 0,
                    }}
                  >
                    {showingAll
                      ? `▲ Hide ${fixedRules.length} fixed rule${fixedRules.length !== 1 ? 's' : ''}`
                      : `▼ Show ${fixedRules.length} fixed rule${fixedRules.length !== 1 ? 's' : ''} (non-configurable)`}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer */}
      <div style={{ marginTop: 16, padding: '12px 16px', background: '#f8fafc', borderRadius: 8 }}>
        <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, lineHeight: 1.6 }}>
          <strong style={{ color: '#64748b' }}>How to read this document:</strong> Rules fire automatically — you cannot disable individual rules.
          Configurable rules let you adjust when they fire by changing the threshold in Edit Rules.
          Fixed rules fire on binary conditions (e.g. no agent assigned) that have no threshold to configure.
          All rules follow the <strong>upsert + resolve</strong> pattern — alerts are created when conditions are met and auto-resolved when they clear.
          STRAP rules use <strong>supersede/regenerate</strong> — one active STRAP per entity.
        </p>
      </div>
    </div>
  );
}
