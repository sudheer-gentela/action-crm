// ─────────────────────────────────────────────────────────────────────────────
// ReportingHub.js
//
// DROP-IN LOCATION: frontend/src/ReportingHub.js
//
// Module-wise reporting. Top level is the MODULE (Deals + whatever the user has
// access to + Cross-module); each module holds its own reports. Prospecting keeps
// its full existing view (TeamReportingView); Projects → Delivery health; the rest
// are placeholders that fill in as we build them.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useMemo } from 'react';
import TeamReportingView from './TeamReportingView';
import PortfolioHealthReport from './PortfolioHealthReport';
import DealsReporting from './DealsReporting';

// gate === undefined → always visible (core module). Otherwise gated on orgModules[gate].
const MODULES = [
  { key: 'deals',       label: 'Deals',        icon: 'ti-briefcase',
    reports: [{ k: 'pipeline_health', label: 'Pipeline health', live: true }, { k: 'funnel', label: 'Funnel', live: true }, { k: 'forecast', label: 'Forecast', live: true }, { k: 'winloss', label: 'Win / loss', live: true }] },
  { key: 'prospecting', label: 'Prospecting',  icon: 'ti-target', gate: 'prospecting', prospecting: true },
  { key: 'projects',    label: 'Projects',     icon: 'ti-checklist', gate: 'handovers',
    reports: [{ k: 'delivery_health', label: 'Delivery health', live: true }, { k: 'ontime', label: 'On-time delivery' }, { k: 'throughput', label: 'Throughput' }] },
  { key: 'service',     label: 'Service',      icon: 'ti-headset', gate: 'service',
    reports: [{ k: 'case_health', label: 'Case health' }, { k: 'sla', label: 'SLA compliance' }, { k: 'backlog', label: 'Backlog' }] },
  { key: 'contracts',   label: 'Contracts',    icon: 'ti-file-text', gate: 'contracts',
    reports: [{ k: 'contract_status', label: 'Contract status' }] },
  { key: 'agency',      label: 'Agency',       icon: 'ti-building', gate: 'agency',
    reports: [{ k: 'client_rollup', label: 'Client rollup' }] },
  { key: 'cross',       label: 'Cross-module', icon: 'ti-arrows-shuffle',
    reports: [{ k: 'account360', label: 'Account 360' }, { k: 'team_perf', label: 'Team performance' }, { k: 'portfolio', label: 'Portfolio overview' }] },
];

const PLACEHOLDER_NOTE = {
  account360: 'One account end to end — prospecting, deals, projects, and service in a single health read.',
  team_perf: 'A rep or team across every module they touch.',
  portfolio: 'Everything in flight rolled to one R/Y/G, drillable by module.',
  pipeline_health: 'Deal health (R/Y/G) across the pipeline, from the existing deal-health engine.',
};

export default function ReportingHub({ orgModules = {}, drilldownCampaignId = null, onDrilldownConsumed = null }) {
  const visible = useMemo(
    () => MODULES.filter(m => m.gate === undefined || !!orgModules[m.gate]),
    [orgModules]);

  const initial = drilldownCampaignId ? 'prospecting'
    : (visible.find(m => m.key === 'prospecting') ? 'prospecting'
      : visible.find(m => m.key === 'projects') ? 'projects'
      : visible[0]?.key) || 'deals';

  const [moduleKey, setModuleKey] = useState(initial);
  const activeModule = visible.find(m => m.key === moduleKey) || visible[0];
  const [reportKey, setReportKey] = useState(activeModule?.reports?.[0]?.k || null);

  const pickModule = (k) => {
    setModuleKey(k);
    const m = MODULES.find(x => x.key === k);
    setReportKey(m?.reports?.[0]?.k || null);
  };

  const tabBtn = (on) => ({
    padding: '6px 12px', borderRadius: 'var(--radius, 8px)', cursor: 'pointer', fontSize: 13,
    background: on ? 'var(--surface-1, #f8fafc)' : 'transparent',
    border: `1px solid ${on ? '#cbd5e1' : '#e5e7eb'}`, color: '#1f2937', fontWeight: on ? 600 : 400,
  });

  return (
    <div style={{ padding: '4px 0' }}>
      {/* Module row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, borderBottom: '1px solid #eef2f6', paddingBottom: 12 }}>
        {visible.map(m => {
          const on = m.key === moduleKey;
          return (
            <button key={m.key} onClick={() => pickModule(m.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
                background: on ? '#eff6ff' : '#fff', border: on ? '2px solid #93c5fd' : '1px solid #e5e7eb',
                color: on ? '#1d4ed8' : '#374151', fontWeight: on ? 700 : 500, fontSize: 13 }}>
              <i className={`ti ${m.icon}`} aria-hidden="true" style={{ fontSize: 16 }} /> {m.label}
            </button>
          );
        })}
      </div>

      {/* Prospecting keeps its full existing view */}
      {activeModule?.prospecting ? (
        <TeamReportingView drilldownCampaignId={drilldownCampaignId} onDrilldownConsumed={onDrilldownConsumed} />
      ) : (
        <div>
          {/* Report sub-tabs for the module */}
          {activeModule?.reports?.length > 1 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {activeModule.reports.map(r => (
                <button key={r.k} onClick={() => setReportKey(r.k)} style={tabBtn(r.k === reportKey)}>
                  {r.label}{!r.live && <span style={{ marginLeft: 6, fontSize: 10, color: '#9ca3af' }}>soon</span>}
                </button>
              ))}
            </div>
          )}

          {/* Report content */}
          {(() => {
            const report = activeModule?.reports?.find(r => r.k === reportKey);
            if (report?.live && report.k === 'delivery_health') {
              return <PortfolioHealthReport title="Delivery health — projects" />;
            }
            if (activeModule?.key === 'deals' && report?.live) {
              return <DealsReporting reportKey={report.k} />;
            }
            return (
              <div style={{ background: '#f8fafc', borderRadius: 12, padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
                <i className="ti ti-chart-dots" aria-hidden="true" style={{ fontSize: 26, color: '#94a3b8' }} />
                <div style={{ fontSize: 14, fontWeight: 600 }}>{report?.label || 'Report'}</div>
                <div style={{ fontSize: 13, color: '#6b7280', maxWidth: 440 }}>
                  {PLACEHOLDER_NOTE[report?.k] || 'This report is coming soon — the module-wise shell is in place, ready to drop it in.'}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
