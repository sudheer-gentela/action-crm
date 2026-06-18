import React, { useState, useEffect, useCallback } from 'react';
import { hashSegment, writeHash } from './hashNav';
import { apiService } from './apiService';
import './OrgAdminView.css';
import DealHealthSettings from './DealHealthSettings';
import CustomFieldDefsEditor from './customfields/CustomFieldDefsEditor';
import OrgSendingScheduleSettings from './OrgSendingScheduleSettings';
import OAStages from './OAStages';
import OAProducts from './OAProducts';
import OATeamDimensions from './OATeamDimensions';
import WorkflowCanvas from './WorkflowCanvas';
import ExecutionLog from './ExecutionLog';
import OAEmailSettings from './OAEmailSettings';
import OAMeetingSettings from './OAMeetingSettings';
import SalesforceConnect from './SalesforceConnect';
import HubSpotConnect    from './HubSpotConnect';
import OATwilioSettings from './OATwilioSettings';
import OAAIProviderSettings from './OAAIProviderSettings';
import OAProspectingSkillConfig from './OAProspectingSkillConfig';
import { TrackingDomainSettings } from './prospecting/TrackingSettings';   // Insights/WBR Phase 7

import {
  MODULE_NAV_DEFS, TAB_META, MODULE_COLORS, CALL_TYPE_LABELS,
} from './orgadmin/constants';
import { buildNavGroups, formatTokens, formatCost } from './orgadmin/helpers';
import {
  UsageBar, ToggleSwitch, ModuleSubTabs, OAModuleSeedPanel, OAModuleGeneral,
} from './orgadmin/shared';

import OAPlaybooks from './orgadmin/panels/OAPlaybooks';
import OAPlaybookTypes from './orgadmin/panels/OAPlaybookTypes';
import OADealRoles from './orgadmin/panels/OADealRoles';
import OADiagnosticRules from './orgadmin/panels/OADiagnosticRules';
import OAIcpScoring from './orgadmin/panels/OAIcpScoring';


import OAMembers from './orgadmin/panels/OAMembers';
import OAHierarchy from './orgadmin/panels/OAHierarchy';
import OATeams from './orgadmin/panels/OATeams';
import OAInvitations from './orgadmin/panels/OAInvitations';


// ═══════════════════════════════════════════════════════════════════
// ORG ADMIN VIEW — per-organisation administration
// Accessible to org owners and admins only.
// The SettingsView handles AI/playbook/deal-health configuration —
// this view handles PEOPLE, ROLES, INVITATIONS, and ORG SETTINGS.
// ═══════════════════════════════════════════════════════════════════

// Static nav groups — Modules group is injected dynamically in OrgAdminView
// based on which modules are enabled for the org.


// Module definitions — drives dynamic nav + per-module content routing


// Builds the full nav group list, inserting enabled module items before 'General'


// Content descriptions for the top bar


// ─────────────────────────────────────────────────────────────────────────────
// OATokenUsageModule — AI usage dashboard for Org Admin
// ─────────────────────────────────────────────────────────────────────────────


function OATokenUsageModule() {
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

export default function OrgAdminView() {
  // Restored from #/org-admin/<tab> on refresh; 'members' (the default)
  // is represented by no segment. See hashNav.js for the ownership model.
  const [tab, setTab]               = useState(() => {
    if (hashSegment(0) === 'org-admin') {
      const s = hashSegment(1);
      if (s) return s;
    }
    return 'members';
  });

  useEffect(() => {
    if (hashSegment(0) !== 'org-admin') return;
    writeHash(['org-admin', tab === 'members' ? null : tab]);
  }, [tab]);
  const [stats, setStats]           = useState(null);
  const [orgName, setOrgName]       = useState('');
  const [orgId,   setOrgId]         = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // orgModules — controls which module nav items are visible.
  // Kept in sync via moduleToggle events fired by child components.
  const [orgModules, setOrgModules] = useState({
    contracts:   false,
    prospecting: false,
    handovers:   false,
    service:     false,
    agency:      false,
  });

  useEffect(() => {
    apiService.orgAdmin.getStats()
      .then(r => setStats(r.data))
      .catch(console.error);

   apiService.orgAdmin.getProfile()
     .then(r => {
       const org  = r.data?.org ?? r.data ?? {};
       const name = org.name || '';
       if (name) setOrgName(name);
       if (org.id) setOrgId(org.id);


       // New profile shape: r.data.modules = { key: { allowed, enabled } }
       // Legacy shape:      r.data.org.settings.modules = { key: true/false }
       // buildNavGroups and orgModules state only need `enabled` — extract that.
       const normalisedMods = r.data.modules;
       if (normalisedMods) {
         setOrgModules({
           contracts:   normalisedMods.contracts?.enabled   || false,
           prospecting: normalisedMods.prospecting?.enabled || false,
           handovers:   normalisedMods.handovers?.enabled   || false,
           service:     normalisedMods.service?.enabled     || false,
           agency:      normalisedMods.agency?.enabled      || false,
         });
       } else {
         // Legacy fallback
         const mods =
           org?.settings?.modules ||
           org?.modules           ||
           {};
         setOrgModules({
           contracts:   mods.contracts   === true || mods.contracts?.enabled   || false,
           prospecting: mods.prospecting === true || mods.prospecting?.enabled || false,
           handovers:   mods.handovers   === true || mods.handovers?.enabled   || false,
           service:     mods.service     === true || mods.service?.enabled     || false,
           agency:      mods.agency      === true || mods.agency?.enabled      || false,
         });
       }
     })
     .catch(e => console.error('[OrgAdminView] getProfile failed:', e));


    // Listen for module toggle events fired by child General sub-tabs
    const handleModuleToggle = (e) => {
      const { module, enabled } = e.detail;
      setOrgModules(prev => ({ ...prev, [module]: enabled }));
    };
    window.addEventListener('moduleToggle', handleModuleToggle);
    return () => window.removeEventListener('moduleToggle', handleModuleToggle);
  }, []);

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
  const meta = TAB_META[tab] || TAB_META.members;
  const navGroups = buildNavGroups(orgModules);

  // When a module is disabled via its General sub-tab, redirect to the Modules overview
  // so the user can see the full list and re-enable if needed.
  useEffect(() => {
    if (tab.startsWith('mod-')) {
      const def = MODULE_NAV_DEFS.find(m => m.navId === tab);
      if (def && !orgModules[def.moduleKey]) {
        setTab('modules');
      }
    }
  }, [orgModules, tab]);

  return (
    <div className="oa-layout">
      {/* ── Sidebar ── */}
      <nav className={`oa-sidebar ${sidebarCollapsed ? 'oa-sidebar--collapsed' : ''}`}>
        <div className="oa-sidebar-header">
          {!sidebarCollapsed && <span className="oa-sidebar-title">{orgName || 'Admin'}</span>}
          <button
            className="oa-sidebar-toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>

        <div className="oa-sidebar-nav">
          {navGroups.map(group => (
            <div key={group.label} className="oa-nav-group">
              {!sidebarCollapsed && <div className="oa-nav-group-label">{group.label}</div>}
              {group.items.map(item => (
                <button
                  key={item.id}
                  className={`oa-nav-item ${tab === item.id ? 'oa-nav-item--active' : ''}`}
                  onClick={() => setTab(item.id)}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <span className="oa-nav-icon">{item.icon}</span>
                  {!sidebarCollapsed && <span className="oa-nav-label">{item.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        {!sidebarCollapsed && (
          <div className="oa-sidebar-footer">Organisation Admin</div>
        )}
      </nav>

      {/* ── Main Content ── */}
      <main className="oa-main">
        <div className="oa-topbar">
          <h1 className="oa-topbar-title">{meta.title}</h1>
          <p className="oa-topbar-desc">{meta.desc}</p>
        </div>

        <div className="oa-content">
          {tab === 'custom-fields' && <CustomFieldDefsEditor />}
          {/* Stats cards — show on members tab */}
          {tab === 'members' && stats && (
            <div className="oa-stats-grid">
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Active Members</div>
                <div className="oa-stat-card-value" style={{ color: '#059669' }}>{stats.members.active}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Pending Invites</div>
                <div className="oa-stat-card-value" style={{ color: '#d97706' }}>{stats.invitations.total}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Total Deals</div>
                <div className="oa-stat-card-value" style={{ color: '#4338ca' }}>{stats.deals.total}</div>
              </div>
              <div className="oa-stat-card">
                <div className="oa-stat-card-label">Actions (7d)</div>
                <div className="oa-stat-card-value" style={{ color: '#0284c7' }}>{stats.actions.week}</div>
              </div>
            </div>
          )}

          <div className="oa-tab-content">
            {/* ── Modules overview — always accessible for enable/disable ── */}
            {tab === 'modules'          && <OAModules />}
            {/* ── Per-module settings pages (only reachable when module is enabled) ── */}
            {tab === 'ai-usage'          && <OATokenUsageModule />}
            {tab === 'mod-prospecting'  && <OAProspectingModule />}
            {tab === 'mod-contracts'    && <OACLMModule />}
            {tab === 'mod-handovers'    && <OAHandoverModule />}
            {tab === 'mod-service'      && <OAServiceModule />}
            {tab === 'mod-agency'       && <OAAgencyModule />}
            {/* ── All other existing sections (untouched) ── */}
            {tab === 'members'          && <OAMembers currentUserId={currentUser.id} />}
            {tab === 'hierarchy'        && <OAHierarchy />}
            {tab === 'teams'            && <OATeams />}
            {tab === 'invitations'      && <OAInvitations />}
            {tab === 'playbooks'        && <OAPlaybooks />}
            {tab === 'health'           && <DealHealthSettings />}
            {tab === 'icp-scoring'      && <OAIcpScoring />}
            {tab === 'diagnostic-rules' && <OADiagnosticRules />}
            {tab === 'stages'           && <OAStages />}
            {tab === 'org-roles'        && <OADealRoles />}
            {tab === 'products'         && <OAProducts />}
            {tab === 'ai-agent'         && <OAAgentSettings />}
            {tab === 'ai-providers'     && <OAAIProviderSettings />}
            {tab === 'action-ai'        && <OAActionsAI />}
            {tab === 'duplicates'       && <OADuplicateSettings />}
            {tab === 'workflows'        && <OAWorkflows />}
            {tab === 'email-settings'   && <OAEmailSettings />}
            {tab === 'tracking-domain'  && <TrackingDomainSettings />}   {/* Insights/WBR Phase 7 */}
            {tab === 'team-dimensions'  && <OATeamDimensions />}
            {(tab === 'integrations' || tab === 'integrations-overview') && <OAIntegrations orgId={orgId} />}
            {tab === 'salesforce'        && <OASalesforceSettings />}
            {tab === 'hubspot'           && <OAHubSpotSettings />}
            {tab === 'settings'         && <OASettings />}
          </div>
        </div>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ROLE DEFINITIONS — rendered as cards so users understand what each means
// ─────────────────────────────────────────────────────────────────


// v2: Department options for CLM legal team routing


const CONTRACT_TYPE_LABELS = {
  nda:        'NDA',
  msa:        'MSA',
  sow:        'SOW',
  order_form: 'Order Form',
  amendment:  'Amendment',
};


// ─────────────────────────────────────────────────────────────────
// MEMBERS TAB
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// HIERARCHY TAB — visual org tree with drag-drop & matrix reporting
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// TEAMS TAB
// Multi-dimensional team management: dimensions config, team CRUD,
// and user assignment grid.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// OATeamRoster — read-only view of user assignments across dimensions
// Filterable by dimension and team, with search and summary stats.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// ICP SCORING CONFIG TAB
// Configures the Ideal Customer Profile scoring model.
// Reads/writes organizations.settings.icp_config via the
// existing icpScoring.service.js GET/PUT /icp-config/current.
// ─────────────────────────────────────────────────────────────────

// ── Color palette for categories ──────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// OADiagnosticRules
// Configure thresholds for nightly + real-time diagnostic engines.
// One collapsible section per module. Save button per section.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// OADiagnosticRulesSummary
// Live per-org rules document. Shows every module, every rule, with the org's
// actual effective thresholds substituted in. Updates whenever rules are saved.
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// INVITATIONS TAB
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// ORG SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// OAPlaybooks — full playbook management for org admins
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// OAPlaybooks — wired to deal_stages + stage_guidance
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// OASalesforceSettings — Salesforce integration settings tab
// ─────────────────────────────────────────────────────────────────

function OASalesforceSettings() {
  return (
    <div className="oa-panel">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>
          ☁️ Salesforce Integration
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Connect your Salesforce org to sync contacts, accounts, deals, and leads.
          Records sync nightly at 04:00 UTC. Stage and field mapping is configurable per org.
        </p>
      </div>
      <SalesforceConnect />
    </div>
  );
}

// OAHubSpotSettings — HubSpot integration settings tab
// ─────────────────────────────────────────────────────────────────

function OAHubSpotSettings() {
  return (
    <div className="oa-panel">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>
          🟠 HubSpot Integration
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Connect your HubSpot portal to sync companies, contacts, and deals.
          Records sync nightly at 04:00 UTC. Stage and field mapping is configurable per org.
        </p>
      </div>
      <HubSpotConnect />
    </div>
  );
}


function OASettings() {
  const [org, setOrg]       = useState(null);
  const [name, setName]     = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => { setOrg(r.data.org); setName(r.data.org.name); })
      .catch(() => setError('Failed to load org'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name cannot be empty'); return; }
    try {
      setSaving(true); setError('');
      await apiService.orgAdmin.updateProfile({ name: name.trim() });
      setSuccess('Organisation name updated ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>⚙️ Organisation Settings</h2>
          <p className="sv-panel-desc">Settings that apply to all members of your organisation.</p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        <div className="sv-section">
          {/* Org name */}
          <div className="sv-card">
            <h3>Organisation Name</h3>
            <p className="sv-hint">This name appears throughout the application and in invitation emails.</p>
            <div className="oa-name-row">
              <input
                className="oa-input"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
              />
              <button className="sv-btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? '⏳ Saving…' : '💾 Save'}
              </button>
            </div>
          </div>

          {/* Read-only plan info */}
          {org && (
            <div className="sv-card">
              <h3>Plan & Limits</h3>
              <p className="sv-hint">To upgrade your plan or change seat limits, contact ActionCRM support.</p>
              <div className="oa-plan-grid">
                <div className="oa-plan-item">
                  <span className="oa-plan-label">Current plan</span>
                  <span className="sa-plan-pill">{org.plan}</span>
                </div>
                <div className="oa-plan-item">
                  <span className="oa-plan-label">Status</span>
                  <span className={`sa-badge-status sa-badge-status--${org.status === 'active' ? 'green' : 'red'}`}>{org.status}</span>
                </div>
                <div className="oa-plan-item">
                  <span className="oa-plan-label">User seats</span>
                  <span className="oa-plan-value">{org.max_users} seats</span>
                </div>
                <div className="oa-plan-item">
                  <span className="oa-plan-label">Member since</span>
                  <span className="oa-plan-value">{new Date(org.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Playbook Types */}
          <OAPlaybookTypes />

          {/* Danger zone */}
          <div className="sv-card oa-danger-card">
            <h3>⚠️ Need to transfer ownership?</h3>
            <p className="sv-hint">
              To transfer the organisation to a new owner, go to the <strong>Members</strong> tab, select the new owner, and change their role to <strong>Owner</strong>. You will remain as an Admin.
              Only one user can hold the Owner role at a time.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── OAPlaybookTypes ──────────────────────────────────────────────────────────
// Manage configurable playbook types (stored in organizations.settings.playbook_types)
// System types (Sales, Prospecting) cannot be removed. Custom types can be added/removed.


// ── OADealRoles (Organization Roles) ──────────────────────────────────────────
// Lets org admins manage roles available across all playbooks and workflows.
// System roles can be toggled active/inactive but not renamed or deleted.
// Custom roles can be created, renamed, and deleted.


// Helper: try /org-roles, fall back to /deal-roles for backward compat


// ─────────────────────────────────────────────────────────────────
// AI AGENT TAB — org-level toggle, proposal stats, token usage
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// AI AGENT TAB — org-level toggle, proposal stats, token usage
// ─────────────────────────────────────────────────────────────────

function OAAgentSettings() {
  const [enabled, setEnabled]               = useState(false);
  const [autoExpireDays, setAutoExpireDays] = useState(7);
  const [maxPerDeal, setMaxPerDeal]         = useState(10);
  const [minConfidence, setMinConfidence]   = useState(0.40);
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState('');
  const [success, setSuccess]               = useState('');
  const [stats, setStats]                   = useState(null);
  const [tokenUsage, setTokenUsage]         = useState(null);
  const [period, setPeriod]                 = useState(30);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  useEffect(() => {
    (async () => {
      try {
        const statusRes = await apiService.agent.getStatus();
        setEnabled(statusRes.data?.enabled || false);
        if (statusRes.data?.settings) {
          setMaxPerDeal(statusRes.data.settings.max_proposals_per_deal || 10);
          setMinConfidence(statusRes.data.settings.min_confidence ?? 0.40);
          setAutoExpireDays(statusRes.data.settings.auto_expire_days || 7);
        }

        const statsRes = await apiService.agent.admin.getStats(period);
        setStats(statsRes.data?.stats || null);

        const usageRes = await apiService.agent.admin.getTokenUsage(period);
        setTokenUsage(usageRes.data || null);
      } catch (e) {
        console.log('Agent settings load:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [period]);

  const handleToggle = async () => {
    setSaving(true);
    try {
      await apiService.agent.admin.updateSettings({
        agentic_framework_enabled: !enabled,
        agentic_auto_expire_days: autoExpireDays,
      });
      setEnabled(!enabled);
      flash('success', `AI Agent ${!enabled ? 'enabled' : 'disabled'} ✓`);
    } catch (e) {
      flash('error', e.message || 'Failed to update settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveExpiry = async () => {
    setSaving(true);
    try {
      await apiService.agent.admin.updateSettings({ agentic_auto_expire_days: autoExpireDays });
      flash('success', 'Auto-expire setting saved ✓');
    } catch (e) {
      flash('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading AI Agent settings…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🤖 AI Agent Framework</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Enable the AI agent to propose CRM actions that require team member approval before execution.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error" style={{ margin: '12px 0' }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ margin: '12px 0' }}>{success}</div>}

      <div className="sv-panel-body">
        {/* Toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              {enabled ? '🟢 AI Agent is Enabled' : '⚪ AI Agent is Disabled'}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              {enabled
                ? 'The agent is actively generating proposals for your team. All proposals require human approval.'
                : 'Enable to let the AI agent propose CRM actions. No changes are made without approval.'}
            </div>
          </div>
          <button onClick={handleToggle} disabled={saving} style={{
            padding: '8px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 13, cursor: 'pointer',
            background: enabled ? '#fee2e2' : '#d1fae5', color: enabled ? '#dc2626' : '#059669',
          }}>
            {saving ? '⏳…' : enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        {/* Auto-expire */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Auto-expire pending proposals after:</label>
          <select value={autoExpireDays} onChange={e => setAutoExpireDays(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={0}>Never</option>
          </select>
          <button onClick={handleSaveExpiry} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
        </div>

        {/* Max proposals per deal per day */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Max proposals per deal/day:</label>
          <select value={maxPerDeal} onChange={e => setMaxPerDeal(parseInt(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={3}>3 (conservative)</option>
            <option value={5}>5</option>
            <option value={10}>10 (default)</option>
            <option value={15}>15</option>
            <option value={25}>25</option>
            <option value={50}>50 (max)</option>
          </select>
          <button onClick={async () => {
            setSaving(true);
            try { await apiService.agent.admin.updateSettings({ agentic_max_proposals_per_deal: maxPerDeal }); flash('success', 'Daily cap saved ✓'); }
            catch (e) { flash('error', e.message); }
            finally { setSaving(false); }
          }} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Lower = less noise, higher = more proposals to review</span>
        </div>

        {/* Confidence floor */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>Min. confidence threshold:</label>
          <select value={minConfidence} onChange={e => setMinConfidence(parseFloat(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
            <option value={0}>0% (show all)</option>
            <option value={0.25}>25%</option>
            <option value={0.40}>40% (default)</option>
            <option value={0.50}>50%</option>
            <option value={0.60}>60%</option>
            <option value={0.75}>75% (high only)</option>
          </select>
          <button onClick={async () => {
            setSaving(true);
            try { await apiService.agent.admin.updateSettings({ agentic_min_confidence: minConfidence }); flash('success', 'Confidence threshold saved ✓'); }
            catch (e) { flash('error', e.message); }
            finally { setSaving(false); }
          }} disabled={saving}
            style={{ padding: '6px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
            Save
          </button>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Proposals below this confidence are discarded automatically</span>
        </div>

        {/* Proposal Stats */}
        {stats && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>📊 Proposal Stats (last {period} days)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
              {[
                { label: 'Pending',  value: stats.pending,  color: '#f59e0b' },
                { label: 'Executed', value: stats.executed,  color: '#059669' },
                { label: 'Rejected', value: stats.rejected,  color: '#ef4444' },
                { label: 'Failed',   value: stats.failed,    color: '#dc2626' },
                { label: 'Expired',  value: stats.expired,   color: '#6b7280' },
                { label: 'Total',    value: stats.total,     color: '#374151' },
              ].map(s => (
                <div key={s.label} style={{ padding: '12px 14px', textAlign: 'center', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value || 0}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token Usage */}
        {tokenUsage && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>
              🔢 AI Token Usage (last {period} days)
              <select value={period} onChange={e => setPeriod(parseInt(e.target.value))}
                style={{ marginLeft: 12, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </h3>
            <div style={{ padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Total Tokens</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  {parseInt(tokenUsage.totals?.total_tokens || 0).toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Est. Cost</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  ${parseFloat(tokenUsage.totals?.estimated_cost || 0).toFixed(4)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>API Calls</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>
                  {parseInt(tokenUsage.totals?.call_count || 0).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Duplicate Detection Settings (Org Admin)
// ═══════════════════════════════════════════════════════════════
function OADuplicateSettings() {
  const [config, setConfig]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await apiService.orgAdmin.getDuplicateSettings();
        setConfig(res.data.duplicate_detection);
      } catch (e) {
        setError('Failed to load settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleToggle = async (key, value) => {
    setSaving(true);
    try {
      const res = await apiService.orgAdmin.updateDuplicateSettings({ [key]: value });
      setConfig(prev => ({ ...prev, ...res.data.duplicate_detection }));
      flash('success', 'Setting saved ✓');
    } catch (e) {
      flash('error', e.response?.data?.error?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading duplicate settings…</div>;

  const sectionStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    padding: '20px 24px', marginBottom: 16,
  };
  const headingStyle = { fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 12 };
  const rowStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 0', borderBottom: '1px solid #f3f4f6',
  };
  const labelStyle = { fontSize: 13, fontWeight: 500, color: '#374151' };
  const descStyle = { fontSize: 12, color: '#9ca3af', marginTop: 2 };
  const toggleStyle = (on) => ({
    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: saving ? 'wait' : 'pointer',
    background: on ? '#4f46e5' : '#d1d5db', position: 'relative', transition: 'background 0.2s',
  });
  const dotStyle = (on) => ({
    width: 18, height: 18, borderRadius: '50%', background: '#fff',
    position: 'absolute', top: 3, left: on ? 23 : 3, transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  });
  const selectStyle = {
    padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13,
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 0' }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: '#111827' }}>🔍 Duplicate Detection</h2>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>Configure which rules detect duplicates and who can see them.</p>

      {error   && <div className="sv-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ marginBottom: 12 }}>{success}</div>}

      {/* ── Contact Duplicate Rules ─────────────────── */}
      <div style={sectionStyle}>
        <div style={headingStyle}>👤 Contact Duplicate Rules</div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Email match</div>
            <div style={descStyle}>Flag contacts with the same email address as duplicates</div>
          </div>
          <button style={toggleStyle(config?.contact_email_match)} disabled={saving}
            onClick={() => handleToggle('contact_email_match', !config?.contact_email_match)}>
            <div style={dotStyle(config?.contact_email_match)} />
          </button>
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Name + Account match</div>
            <div style={descStyle}>Flag contacts with the same first name, last name, and account</div>
          </div>
          <button style={toggleStyle(config?.contact_name_account_match)} disabled={saving}
            onClick={() => handleToggle('contact_name_account_match', !config?.contact_name_account_match)}>
            <div style={dotStyle(config?.contact_name_account_match)} />
          </button>
        </div>

        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <div>
            <div style={labelStyle}>Who can see contact duplicates?</div>
            <div style={descStyle}>
              {config?.contact_visibility === 'org'
                ? 'All members see duplicates across the entire org (default)'
                : 'Members only see duplicates within their own contacts'}
            </div>
          </div>
          <select style={selectStyle} value={config?.contact_visibility || 'org'} disabled={saving}
            onChange={e => handleToggle('contact_visibility', e.target.value)}>
            <option value="org">Entire org (default)</option>
            <option value="own">Own contacts only</option>
          </select>
        </div>
      </div>

      {/* ── Account Duplicate Rules ─────────────────── */}
      <div style={sectionStyle}>
        <div style={headingStyle}>🏢 Account Duplicate Rules</div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Domain match</div>
            <div style={descStyle}>Flag accounts with the same website domain as duplicates</div>
          </div>
          <button style={toggleStyle(config?.account_domain_match)} disabled={saving}
            onClick={() => handleToggle('account_domain_match', !config?.account_domain_match)}>
            <div style={dotStyle(config?.account_domain_match)} />
          </button>
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Name match</div>
            <div style={descStyle}>Flag accounts with the same name (case-insensitive)</div>
          </div>
          <button style={toggleStyle(config?.account_name_match)} disabled={saving}
            onClick={() => handleToggle('account_name_match', !config?.account_name_match)}>
            <div style={dotStyle(config?.account_name_match)} />
          </button>
        </div>

        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <div>
            <div style={labelStyle}>Who can see account duplicates?</div>
            <div style={descStyle}>
              {config?.account_visibility === 'org'
                ? 'All members see duplicates across the entire org (default)'
                : 'Members only see duplicates within their own accounts'}
            </div>
          </div>
          <select style={selectStyle} value={config?.account_visibility || 'org'} disabled={saving}
            onChange={e => handleToggle('account_visibility', e.target.value)}>
            <option value="org">Entire org (default)</option>
            <option value="own">Own accounts only</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ── Integrations (org-level) ──────────────────────────────────────────────────

function OAIntegrations({ orgId }) {
  const [subTab, setSubTab] = useState('email-calendar');
  const [integrations, setIntegrations] = useState([]);
  const [outreachLimits, setOutreachLimits] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(null);
  const [flash, setFlash]         = useState(null);
  const [limitsEditing, setLimitsEditing] = useState(false);
  const [limitsForm, setLimitsForm] = useState({});
  const [limitsSaving, setLimitsSaving] = useState(false);

  const PROVIDERS = [
    {
      type: 'microsoft',
      label: 'Microsoft (Outlook + OneDrive)',
      icon: '📧',
      desc: 'Enable Outlook email sync, calendar, and OneDrive file access for all org members.',
      envHint: 'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID',
      scopes: ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'Files.Read', 'User.Read'],
    },
    {
      type: 'google',
      label: 'Google (Gmail + Drive + Calendar)',
      icon: '🟢',
      desc: 'Enable Gmail sync, Google Calendar events, and Google Drive file access for all org members.',
      envHint: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET',
      scopes: ['Gmail', 'Calendar', 'Drive', 'Profile'],
    },
  ];

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getIntegrations(),
      apiService.outreachLimits.get(),
    ])
      .then(([intRes, limRes]) => {
        setIntegrations(intRes.data.integrations || []);
        setOutreachLimits(limRes.data.limits || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const getStatus    = (type) => integrations.find(i => i.integration_type === type)?.status || 'inactive';
  const getLastSynced = (type) => integrations.find(i => i.integration_type === type)?.last_synced_at;

  const handleToggle = async (type, newStatus) => {
    setSaving(type);
    setFlash(null);
    try {
      const r = await apiService.orgAdmin.updateIntegration(type, { status: newStatus });
      setIntegrations(prev => [...prev.filter(i => i.integration_type !== type), r.data.integration]);
      setFlash({ type: 'success', message: `${type === 'microsoft' ? 'Microsoft' : 'Google'} integration ${newStatus === 'active' ? 'enabled' : 'disabled'}.` });
    } catch (err) {
      setFlash({ type: 'error', message: err?.response?.data?.error?.message || 'Failed to update integration.' });
    } finally {
      setSaving(null);
    }
  };

  const startEditLimits = () => {
    setLimitsForm({
      dailyLimitCeiling:    outreachLimits?.dailyLimitCeiling    ?? 100,
      minDelayMinutesCeiling: outreachLimits?.minDelayMinutesCeiling ?? 2,
      defaultDailyLimit:    outreachLimits?.defaultDailyLimit    ?? 50,
      defaultMinDelayMinutes: outreachLimits?.defaultMinDelayMinutes ?? 5,
    });
    setLimitsEditing(true);
  };

  const saveLimits = async () => {
    setLimitsSaving(true);
    try {
      const r = await apiService.outreachLimits.update(limitsForm);
      setOutreachLimits(r.data.limits);
      setLimitsEditing(false);
      setFlash({ type: 'success', message: 'Outreach limits saved.' });
    } catch (err) {
      setFlash({ type: 'error', message: err?.response?.data?.error?.message || 'Failed to save limits.' });
    } finally {
      setLimitsSaving(false);
    }
  };

  const cardStyle = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 24, marginBottom: 16 };
  const toggleBtn = (active, disabled) => ({
    padding: '8px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
    border: active ? '1px solid #dcfce7' : '1px solid #e5e7eb',
    background: active ? '#dcfce7' : '#f3f4f6',
    color: active ? '#166534' : '#6b7280',
    cursor: disabled ? 'wait' : 'pointer', transition: 'all 0.15s',
  });
  const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 };
  const labelStyle = { fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 };
  const inputStyle = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 100 };

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading integrations...</div>;

  const SUB_TABS = [
    { id: 'email-calendar', label: '📧 Email & Calendar' },
    { id: 'meeting',        label: '🎙️ Meeting & Transcripts' },
  ];

  const subTabStyle = (id) => ({
    padding: '7px 16px',
    borderRadius: '7px 7px 0 0',
    border: '1px solid transparent',
    borderBottom: 'none',
    background: subTab === id ? '#fff' : 'transparent',
    borderColor: subTab === id ? '#e5e7eb' : 'transparent',
    borderBottomColor: subTab === id ? '#fff' : 'transparent',
    fontSize: 13,
    fontWeight: subTab === id ? 600 : 500,
    color: subTab === id ? '#111827' : '#6b7280',
    cursor: 'pointer',
    marginBottom: -1,
  });

  return (
    <div>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {SUB_TABS.map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)} style={subTabStyle(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Email & Calendar tab ───────────────────────────────────── */}
      {subTab === 'email-calendar' && (
        <div>
          {flash && (
            <div style={{
              padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14, fontWeight: 500,
              background: flash.type === 'success' ? '#dcfce7' : '#fef2f2',
              color:      flash.type === 'success' ? '#166534' : '#991b1b',
            }}>
              {flash.message}
            </div>
          )}

          <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20, lineHeight: 1.6 }}>
            Enable or disable third-party integrations for your organisation. When enabled, individual
            team members can connect their personal accounts from <strong>Settings → Integrations</strong>.
          </p>

          {/* ── Email / calendar providers ─────────────────────────── */}
          {PROVIDERS.map(provider => {
            const active   = getStatus(provider.type) === 'active';
            const lastSync = getLastSynced(provider.type);
            const isSaving = saving === provider.type;
            return (
              <div key={provider.type} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
                    <span style={{ fontSize: 28 }}>{provider.icon}</span>
                    <div>
                      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#1a202c' }}>{provider.label}</h3>
                      <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>{provider.desc}</p>
                    </div>
                  </div>
                  <button style={toggleBtn(active, isSaving)} disabled={isSaving}
                    onClick={() => handleToggle(provider.type, active ? 'inactive' : 'active')}>
                    {isSaving ? '...' : active ? '✓ Enabled' : 'Enable'}
                  </button>
                </div>
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Status</div>
                      <div style={{ fontSize: 14, fontWeight: 500, color: active ? '#059669' : '#6b7280', marginTop: 2 }}>
                        {active ? 'Active' : 'Inactive'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Scopes</div>
                      <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2 }}>{provider.scopes.join(', ')}</div>
                    </div>
                    {lastSync && (
                      <div>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Last synced</div>
                        <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2 }}>{new Date(lastSync).toLocaleString()}</div>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 12, padding: '8px 12px', background: '#f8fafc', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
                  💡 Requires env vars: <code style={{ background: '#e5e7eb', padding: '1px 4px', borderRadius: 3 }}>{provider.envHint}</code>
                </div>
              </div>
            );
          })}

          {/* ── Prospecting Email Limits ────────────────────────────── */}
          <div style={{ ...cardStyle, marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
                <span style={{ fontSize: 28 }}>📤</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#1a202c' }}>Prospecting Email Limits</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
                    Set org-wide ceilings for outreach volume and send cadence. Individual reps can set
                    lower limits on their own sender accounts, but cannot exceed these ceilings.
                  </p>
                </div>
              </div>
              {!limitsEditing && (
                <button
                  style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f3f4f6', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                  onClick={startEditLimits}
                >
                  Edit
                </button>
              )}
            </div>

            {limitsEditing ? (
              <div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Daily limit ceiling</label>
                    <input type="number" min={1} style={inputStyle} value={limitsForm.dailyLimitCeiling}
                      onChange={e => setLimitsForm(p => ({ ...p, dailyLimitCeiling: parseInt(e.target.value) || 1 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Max emails/day per account</span>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Min delay ceiling (min)</label>
                    <input type="number" min={0} style={inputStyle} value={limitsForm.minDelayMinutesCeiling}
                      onChange={e => setLimitsForm(p => ({ ...p, minDelayMinutesCeiling: parseInt(e.target.value) || 0 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Minimum gap enforced between sends</span>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Default daily limit</label>
                    <input type="number" min={1} style={inputStyle} value={limitsForm.defaultDailyLimit}
                      onChange={e => setLimitsForm(p => ({ ...p, defaultDailyLimit: parseInt(e.target.value) || 1 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Applied when rep has no custom limit</span>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Default min delay (min)</label>
                    <input type="number" min={0} style={inputStyle} value={limitsForm.defaultMinDelayMinutes}
                      onChange={e => setLimitsForm(p => ({ ...p, defaultMinDelayMinutes: parseInt(e.target.value) || 0 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Applied when rep has no custom delay</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={saveLimits} disabled={limitsSaving}
                    style={{ padding: '8px 18px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: limitsSaving ? 'wait' : 'pointer' }}
                  >
                    {limitsSaving ? 'Saving…' : 'Save Limits'}
                  </button>
                  <button
                    onClick={() => setLimitsEditing(false)}
                    style={{ padding: '8px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : outreachLimits ? (
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                {[
                  { label: 'Daily Limit Ceiling',      value: `${outreachLimits.dailyLimitCeiling} emails/day` },
                  { label: 'Min Delay Ceiling',         value: `${outreachLimits.minDelayMinutesCeiling} min` },
                  { label: 'Default Daily Limit',       value: `${outreachLimits.defaultDailyLimit} emails/day` },
                  { label: 'Default Min Delay',         value: `${outreachLimits.defaultMinDelayMinutes} min` },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 2 }}>{value}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#9ca3af' }}>No limits configured — click Edit to set org-wide defaults.</div>
            )}
          </div>

          <div style={{ marginTop: 8, padding: 16, background: '#fffbeb', borderRadius: 8, border: '1px solid #fde68a', fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
            <strong>How org integrations work:</strong><br />
            Enabling an integration here allows members to connect their personal accounts.
            Each member still authorises individually via Settings → Integrations — you are not
            granting access to a shared mailbox. This switch controls whether the option is <em>available</em> to your team.
          </div>
        </div>
      )}

      {/* ── Meeting & Transcripts tab ──────────────────────────────── */}
      {subTab === 'meeting' && <OAMeetingSettings orgId={orgId} />}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// MODULE SETTINGS PAGES
// One component per module, each with its own sub-tab shell.
// These are rendered when the user clicks a module nav item.
// General sub-tab always has the enable/disable toggle.
// Other sub-tabs are hidden until the module is enabled.
// ═══════════════════════════════════════════════════════════════════

// ── Shared sub-tab bar ──────────────────────────────────────────────
// ── Module toggle helpers ─────────────────────────────────────────────────────
// All four use apiService.X.toggleModule — see apiService.js for endpoints.

// ─────────────────────────────────────────────────────────────────
// OAModuleSeedPanel — reusable GoWarm sample playbook seed panel
// Used in the Playbook sub-tab of each module settings page.
// Props:
//   seedDone    bool    — whether seed has already been run
//   seeding     bool    — in-flight
//   seedMsg     string  — success/error message
//   onSeed      fn      — fires the seed request
//   color       string  — accent colour matching the module
//   playbookName string — display name
//   playbookDesc string — short description of what's seeded
// ─────────────────────────────────────────────────────────────────


// ── Generic module General tab ───────────────────────────────────────
// Reusable enable/disable toggle for any module.
// moduleKey: 'contracts' | 'prospecting' | 'handovers' | 'service'
// toggleFn: async (enabled: bool) => Promise  (calls the relevant apiService method)


// ─────────────────────────────────────────────────────────────────
// PROSPECTING MODULE — General only
// ─────────────────────────────────────────────────────────────────
const ORG_AI_MODELS = {
  anthropic: [
    { value: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku (fast, economical)' },
    { value: 'claude-sonnet-4-5-20251022', label: 'Claude Sonnet (balanced)' },
    { value: 'claude-opus-4-5-20251022',   label: 'Claude Opus (most capable)' },
  ],
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (fast, economical)' },
    { value: 'gpt-4o',      label: 'GPT-4o (most capable)' },
  ],
  gemini: [
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (fast)' },
    { value: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro (most capable)' },
  ],
};

// ── Org-wide campaign-delete switch ──────────────────────────────────────────
// "Campaign owners may delete their own campaigns." Reads/writes
// GET|PUT /prospecting-campaigns/org/delete-policy, persisted in
// org_action_config.campaign_settings.owner_delete_enabled. Admins/owners are
// never restricted by this switch — it gates campaign OWNERS only. Default ON.
function OACampaignDeletePolicy() {
  const API     = process.env.REACT_APP_API_URL || '';
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/prospecting-campaigns/org/delete-policy`, { headers })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then(d => setEnabled(d?.enabled !== false))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleToggle = async () => {
    const next = !enabled;
    setEnabled(next);          // optimistic
    setSaving(true);
    try {
      const r = await fetch(`${API}/prospecting-campaigns/org/delete-policy`, {
        method: 'PUT', headers, body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Save failed');
      setEnabled(d?.enabled !== false);
      showFlash('success', 'Campaign-delete policy saved ✓');
    } catch (err) {
      setEnabled(!next);       // revert on failure
      showFlash('error', err.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sv-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, justifyContent: 'space-between' }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ marginBottom: 4 }}>Campaign deletion by owners</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#718096', lineHeight: 1.5, maxWidth: 560 }}>
            When on, a campaign’s owner can delete their own campaign (along with its
            prospects), unless that specific campaign has been locked against deletion.
            When off, only admins can delete campaigns. Admins are never restricted by
            this switch.
          </p>
        </div>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          {loading
            ? <span style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</span>
            : <ToggleSwitch on={enabled} onChange={saving ? () => {} : handleToggle} color="#E8630A" />}
        </div>
      </div>
      {flash && (
        <div style={{
          marginTop: 10, fontSize: 12,
          color: flash.type === 'error' ? '#b91c1c' : '#15803d',
        }}>
          {flash.msg}
        </div>
      )}
    </div>
  );
}

// ── Org-wide "managers can edit subordinates' items" switch ──────────────────
// Reads/writes GET|PUT /prospecting-campaigns/org/manager-edit-policy, persisted
// in org_action_config.campaign_settings.manager_can_edit. Read by
// services/AccessPolicy.js. When OFF (default), managers are view-only on a
// subordinate's prospecting items unless the owner opts a specific item in.
function OAManagerEditPolicy() {
  const API     = process.env.REACT_APP_API_URL || '';
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/prospecting-campaigns/org/manager-edit-policy`, { headers })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then(d => setEnabled(d?.enabled === true))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleToggle = async () => {
    const next = !enabled;
    setEnabled(next);          // optimistic
    setSaving(true);
    try {
      const r = await fetch(`${API}/prospecting-campaigns/org/manager-edit-policy`, {
        method: 'PUT', headers, body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Save failed');
      setEnabled(d?.enabled === true);
      showFlash('success', 'Manager-edit policy saved ✓');
    } catch (err) {
      setEnabled(!next);       // revert on failure
      showFlash('error', err.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sv-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, justifyContent: 'space-between' }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ marginBottom: 4 }}>Managers can edit team members’ items</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#718096', lineHeight: 1.5, maxWidth: 560 }}>
            When on, a manager can edit prospecting items (sequences, etc.) owned by
            anyone on their team, org-wide. When off, managers are view-only on a
            subordinate’s items unless the owner opts a specific item in. Owners and
            admins can always edit. Default off.
          </p>
        </div>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          {loading
            ? <span style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</span>
            : <ToggleSwitch on={enabled} onChange={saving ? () => {} : handleToggle} color="#E8630A" />}
        </div>
      </div>
      {flash && (
        <div style={{
          marginTop: 10, fontSize: 12,
          color: flash.type === 'error' ? '#b91c1c' : '#15803d',
        }}>
          {flash.msg}
        </div>
      )}
    </div>
  );
}

function OAProspectingModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [subTab, setSubTab]       = useState('general');
  const [seedDone, setSeedDone]   = useState(false);
  const [seeding, setSeeding]     = useState(false);
  const [seedMsg, setSeedMsg]     = useState('');

  const [cfg, setCfg]         = useState({
    ai_provider:     'anthropic',
    ai_model:        'claude-haiku-4-5-20251001',
    product_context: '',
  });
  const [orgResearchPrompt, setOrgResearchPrompt] = useState('');
  const [orgDraftPrompt,    setOrgDraftPrompt]    = useState('');
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    Promise.all([
      fetch(`${API}/org/admin/prospecting/ai-config`, { headers }).then(r => r.json()),
      fetch(`${API}/prompts/org/prospecting`, { headers }).then(r => r.json()),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
    ]).then(([cfgRes, promptRes, seedRes]) => {
      const c = cfgRes || {};
      setCfg({
        ai_provider:     c.ai_provider     || 'anthropic',
        ai_model:        c.ai_model        || 'claude-haiku-4-5-20251001',
        product_context: c.product_context || '',
      });
      setOrgResearchPrompt(promptRes?.prompts?.prospecting_research || '');
      setOrgDraftPrompt(promptRes?.prompts?.prospecting_draft       || '');
      setSeedDone(!!seedRes?.status?.prospecting);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleSeedProspecting = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'prospecting' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r1 = await fetch(`${API}/org/admin/prospecting/ai-config`, {
        method: 'PATCH', headers,
        body: JSON.stringify(cfg),
      });
      if (!r1.ok) { const e = await r1.json(); throw new Error(e?.error?.message || 'AI config save failed'); }

      const r2 = await fetch(`${API}/prompts/org/prospecting`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          prompts: { prospecting_research: orgResearchPrompt, prospecting_draft: orgDraftPrompt },
        }),
      });
      if (!r2.ok) { const e = await r2.json(); throw new Error(e?.error?.message || 'Prompts save failed'); }

      showFlash('success', 'Prospecting AI settings saved ✓');
    } catch(err) {
      showFlash('error', err.message || 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🎯 Prospecting</h2>
          <p className="sv-panel-desc">Full prospecting pipeline — prospect lists, outreach stages, ICP scoring, and playbooks.</p>
        </div>
      </div>

      <ModuleSubTabs
        tabs={[['general', 'General'], ['ai', 'AI Settings'], ['skill-inputs', 'Skill inputs'], ['calls', 'Call Settings'], ['twilio', 'Twilio'], ['sending-schedule', 'Sending Schedule'], ['escalation', 'Escalation'], ['enrichment', 'Enrichment'], ['playbook', 'Playbook']]}
        active={subTab}
        onChange={setSubTab}

      
      />

      {/* ── General sub-tab ── */}
      {subTab === 'general' && (
        <>
          <OAModuleGeneral
            moduleKey="prospecting"
            icon="🎯"
            label="Prospecting"
            desc="Enables the prospect pipeline, ICP scoring, outreach sequencing, and prospecting playbooks for your whole organisation."
            toggleFn={(enabled) => apiService.prospects.toggleModule(enabled)}
          />
          <OACampaignDeletePolicy />
          <OAManagerEditPolicy />
        </>
      )}

      {/* ── Skill inputs sub-tab ── */}
      {subTab === 'skill-inputs' && <OAProspectingSkillConfig />}

      {/* ── Sending Schedule sub-tab — org-wide send window, pacing, budget
            split. Rendered editable here (admin console); readOnly=false. ── */}
      {subTab === 'sending-schedule' && <OrgSendingScheduleSettings readOnly={false} />}

      {/* ── Playbook seed sub-tab ── */}
      {subTab === 'playbook' && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedProspecting}
          color="#0F9D8E"
          playbookName="GoWarm Prospecting Playbook"
          playbookDesc="42 plays across 9 stages: Target → Research → Outreach → Engaged → RAL → Sales Discovery Call → SAL → Disqualified / Nurture."
        />
      )}

      {/* ── Call Settings sub-tab ── */}
      {subTab === 'calls' && (
        <OACallSettings />
      )}

      {/* ── Twilio sub-tab ── */}
      {subTab === 'twilio' && (
        <OATwilioSettings />
      )}

      {/* ── Escalation sub-tab ── */}
      {subTab === 'escalation' && (
        <OAProspectingEscalation />
      )}

      {/* ── Enrichment sub-tab ── */}
      {subTab === 'enrichment' && (
        <OAProspectingEnrichment />
      )}

      {/* ── AI Settings sub-tab ── */}
      {subTab === 'ai' && (
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>🤖 Org AI Defaults</h3>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
              Org-wide defaults for prospecting AI. Individual users can override these in My Preferences.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{ padding: '7px 18px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
          >
            {saving ? '⏳ Saving…' : '💾 Save'}
          </button>
        </div>

        {flash && (
          <div style={{
            marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
            background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
            color:      flash.type === 'success' ? '#065f46'  : '#991b1b',
            border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
          }}>
            {flash.msg}
          </div>
        )}

        {loading ? (
          <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* Provider + Model row */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Default AI Provider</label>
                <select
                  value={cfg.ai_provider}
                  onChange={e => setCfg(p => ({ ...p, ai_provider: e.target.value, ai_model: '' }))}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                >
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="gemini">Google (Gemini)</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Default Model</label>
                <select
                  value={cfg.ai_model}
                  onChange={e => setCfg(p => ({ ...p, ai_model: e.target.value }))}
                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                >
                  {(ORG_AI_MODELS[cfg.ai_provider] || ORG_AI_MODELS.anthropic).map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Product context */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                What your org sells — AI context
              </label>
              <textarea
                value={cfg.product_context}
                onChange={e => setCfg(p => ({ ...p, product_context: e.target.value }))}
                rows={4}
                placeholder="Describe what your organisation sells and who you sell to. This context is injected into every AI research and drafting prompt.&#10;&#10;e.g. We sell revenue operations software to B2B consulting firms with 50-500 employees. Key pain points we solve: siloed pipeline data, manual reporting, and inconsistent sales processes."
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>

            {/* Org prompt templates */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                Research prompt template
                <span style={{ color: '#9ca3af' }}> — use <code>{'{{prospectInfo}}'}</code> where prospect data should appear.</span>
              </label>
              <textarea
                value={orgResearchPrompt}
                onChange={e => setOrgResearchPrompt(e.target.value)}
                rows={5}
                placeholder="Leave blank to use the system default…"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                Draft email prompt template
                <span style={{ color: '#9ca3af' }}> — use <code>{'{{prospectInfo}}'}</code> and <code>{'{{researchNotes}}'}</code>.</span>
              </label>
              <textarea
                value={orgDraftPrompt}
                onChange={e => setOrgDraftPrompt(e.target.value)}
                rows={5}
                placeholder="Leave blank to use the system default…"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }}
              />
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────

function OACLMESignConfig() {
  const API  = process.env.REACT_APP_API_URL;
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const PROVIDER_LABELS = { none: 'None (manual)', docusign: 'DocuSign', hellosign: 'HelloSign / Dropbox Sign', adobe_sign: 'Adobe Acrobat Sign' };

  const [config, setConfig]   = useState({ provider: 'none', apiKey: '', accountId: '', webhookSecret: '', sandboxMode: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetch(`${API}/org/admin/esign-config`, { headers })
      .then(r => r.json())
      .then(d => {
        if (d.config) setConfig({ provider: 'none', apiKey: '', accountId: '', webhookSecret: '', sandboxMode: false, ...d.config });
      })
      .catch(() => setError('Failed to load eSign configuration'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await fetch(`${API}/org/admin/esign-config`, {
        method: 'POST',
        headers,
        body: JSON.stringify(config),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Save failed');
      setSuccess('eSign configuration saved ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading eSign configuration…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Provider picker */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 6 }}>eSignature Provider</div>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 14px' }}>
          Choose your e-signature integration. Contracts sent for signature will use this provider.
          Select <strong>None</strong> to use manual signature tracking only.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {Object.entries(PROVIDER_LABELS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setConfig(c => ({ ...c, provider: key }))}
              style={{
                padding: '12px 16px', borderRadius: 9, textAlign: 'left', cursor: 'pointer',
                border: config.provider === key ? '2px solid #6366f1' : '1px solid #e5e7eb',
                background: config.provider === key ? '#eef2ff' : '#fff',
                fontWeight: config.provider === key ? 700 : 400,
                fontSize: 13, color: config.provider === key ? '#4338ca' : '#374151',
                transition: 'all .15s',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Provider credentials — shown only when a real provider is chosen */}
      {config.provider !== 'none' && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 22px' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 14 }}>
            {PROVIDER_LABELS[config.provider]} — Credentials
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label className="sv-label">API Key / Integration Key</label>
              <input
                className="sv-input"
                type="password"
                placeholder="Paste API key from your provider dashboard"
                value={config.apiKey}
                onChange={e => setConfig(c => ({ ...c, apiKey: e.target.value }))}
              />
            </div>
            <div>
              <label className="sv-label">Account ID {config.provider === 'docusign' ? '(DocuSign Account GUID)' : '(optional)'}</label>
              <input
                className="sv-input"
                placeholder={config.provider === 'docusign' ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : 'Account ID if required'}
                value={config.accountId}
                onChange={e => setConfig(c => ({ ...c, accountId: e.target.value }))}
              />
            </div>
            <div>
              <label className="sv-label">Webhook Secret (optional)</label>
              <input
                className="sv-input"
                type="password"
                placeholder="Used to verify incoming webhook events from the provider"
                value={config.webhookSecret}
                onChange={e => setConfig(c => ({ ...c, webhookSecret: e.target.value }))}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={config.sandboxMode}
                onChange={e => setConfig(c => ({ ...c, sandboxMode: e.target.checked }))}
              />
              <span>
                <strong>Sandbox / Test mode</strong>
                <span style={{ color: '#6b7280', marginLeft: 6 }}>— Uses the provider's sandbox environment. Disable for production.</span>
              </span>
            </label>
          </div>
        </div>
      )}

      <div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ padding: '9px 24px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}

function OACLMModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [subTab, setSubTab]     = useState('general');
  const [seedDone, setSeedDone] = useState(false);
  const [seeding, setSeeding]   = useState(false);
  const [seedMsg, setSeedMsg]   = useState('');

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getProfile(),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
    ])
      .then(([profileRes, seedRes]) => {
        setEnabled(profileRes.data.org?.settings?.modules?.contracts || false);
        setSeedDone(!!seedRes?.status?.clm);
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    const handler = (e) => {
      if (e.detail.module === 'contracts') {
        setEnabled(e.detail.enabled);
        if (!e.detail.enabled) setSubTab('general');
      }
    };
    window.addEventListener('moduleToggle', handler);
    return () => window.removeEventListener('moduleToggle', handler);
  }, []); // eslint-disable-line

  const handleSeedCLM = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'clm' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm CLM sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  const tabs = [
    ['general', 'General'],
    ...(enabled ? [['esign', 'eSign Configuration'], ['templates', 'CLM Templates'], ['playbook', 'Playbook']] : []),
  ];

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📄 Contract Lifecycle Management</h2>
          <p className="sv-panel-desc">Full CLM workflow — contracts, legal review, approval chains, e-signatures, and document versioning.</p>
        </div>
      </div>
      <ModuleSubTabs tabs={tabs} active={subTab} onChange={setSubTab} />
      {subTab === 'general' && (
        <OAModuleGeneral
          moduleKey="contracts"
          icon="📄"
          label="Contract Lifecycle Management"
          desc="Enables the full CLM workflow for your organisation — contract creation, legal review queues, approval chains, e-signature tracking, and document versioning."
          toggleFn={(enabled) => apiService.contracts.toggleModule(enabled)}
        />
      )}
      {subTab === 'esign'     && enabled && <OACLMESignConfig />}
      {subTab === 'templates' && enabled && <OACLMTemplates />}
      {subTab === 'playbook'  && enabled && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedCLM}
          color="#6366f1"
          playbookName="GoWarm CLM Playbook"
          playbookDesc="40 plays across 9 stages: Draft → In Review (Legal/Sales/Customer) → In Signatures → Active → Voided / Terminated / Expired."
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// HANDOVER MODULE — General | Playbook
// ─────────────────────────────────────────────────────────────────
function OAHandoverModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [subTab, setSubTab]     = useState('general');
  const [seedDone, setSeedDone] = useState(false);
  const [seeding, setSeeding]   = useState(false);
  const [seedMsg, setSeedMsg]   = useState('');

  useEffect(() => {
    fetch(`${API}/org/admin/seed-status`, { headers })
      .then(r => r.json())
      .then(data => setSeedDone(!!data?.status?.handovers))
      .catch(() => {});
  }, []); // eslint-disable-line

  const handleSeedHandovers = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'handovers' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm Handover sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🤝 Sales → Implementation Handover</h2>
          <p className="sv-panel-desc">Structured handover workflow when a deal closes — ensures sales captures everything the implementation team needs.</p>
        </div>
      </div>
      <ModuleSubTabs
        tabs={[['general', 'General'], ['playbook', 'Playbook']]}
        active={subTab}
        onChange={setSubTab}
      />
      {subTab === 'general' && (
        <OAModuleGeneral
          moduleKey="handovers"
          icon="🤝"
          label="Sales → Implementation Handover"
          desc="Automatically creates a handover checklist when a deal closes. Ensures the implementation team receives everything they need before the handoff."
          toggleFn={(enabled) => apiService.handovers.toggleModule(enabled)}
        />
      )}
      {subTab === 'playbook' && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedHandovers}
          color="#0369a1"
          playbookName="GoWarm Handover Playbook"
          playbookDesc="15 plays across 5 stages: Assign Service Owner → Document Stakeholders → Record Commitments & Risks → Confirm Go-Live & Commercial → Attach Docs & Sign-off."
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SERVICE MODULE — General | SLA Settings | Playbook
// Wraps the existing OAServiceGeneral + OAServiceSLATiers.
// ─────────────────────────────────────────────────────────────────
function OAServiceModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [subTab, setSubTab]     = useState('general');
  const [seedDone, setSeedDone] = useState(false);
  const [seeding, setSeeding]   = useState(false);
  const [seedMsg, setSeedMsg]   = useState('');

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getProfile(),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
    ])
      .then(([profileRes, seedRes]) => {
        setEnabled(profileRes.data.org?.settings?.modules?.service || false);
        setSeedDone(!!seedRes?.status?.service);
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    const handler = (e) => {
      if (e.detail.module === 'service') {
        setEnabled(e.detail.enabled);
        if (!e.detail.enabled) setSubTab('general');
      }
    };
    window.addEventListener('moduleToggle', handler);
    return () => window.removeEventListener('moduleToggle', handler);
  }, []); // eslint-disable-line

  const handleSeedService = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'service' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm Service sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  const tabs = [
    ['general', 'General'],
    ...(enabled ? [['sla', 'SLA Settings'], ['playbook', 'Playbook']] : []),
  ];

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🎧 Customer Support &amp; Service</h2>
          <p className="sv-panel-desc">Full case management with SLA tracking, playbook-driven workflows, and team assignment.</p>
        </div>
      </div>
      <ModuleSubTabs tabs={tabs} active={subTab} onChange={setSubTab} />
      {subTab === 'general'  && <OAServiceGeneral />}
      {subTab === 'sla'      && enabled && <OAServiceSLATiers />}
      {subTab === 'playbook' && enabled && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedService}
          color="#0891b2"
          playbookName="GoWarm Service Playbook"
          playbookDesc="16 plays across 5 stages: Open → In Progress → Pending Customer → Resolved → Closed."
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// AGENCY MODULE SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

function OAAgencyModule() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => setEnabled(r.data.org?.settings?.modules?.agency || false))
      .catch(console.error)
      .finally(() => setLoading(false));

    const handler = (e) => {
      if (e.detail.module === 'agency') setEnabled(e.detail.enabled);
    };
    window.addEventListener('moduleToggle', handler);
    return () => window.removeEventListener('moduleToggle', handler);
  }, []);

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🏢 Agency Client Management</h2>
          <p className="sv-panel-desc">
            Manage client accounts on behalf of your customers — dedicated portals, team assignment,
            outreach tracking, and client-scoped dashboards.
          </p>
        </div>
      </div>

      {!enabled && (
        <div style={{ padding: '20px 0', color: '#6b7280', fontSize: 13 }}>
          This module is currently disabled. Enable it from the{' '}
          <strong>Modules</strong> tab to access agency settings.
        </div>
      )}

      {enabled && (
        <div style={{ marginTop: 8 }}>
          <div style={{
            background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
            padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#166534',
          }}>
            ✅ Agency module is enabled. Create and manage clients from the Agency tab in the main navigation.
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '18px 20px' }}>
            <h4 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: '#111827' }}>Portal Configuration</h4>
            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
              Client portal invites are sent via magic link. Each link is one-time use and expires after 7 days.
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
              To wire up email delivery for portal invites, configure{' '}
              <code style={{ fontSize: 12, background: '#f3f4f6', padding: '1px 5px', borderRadius: 4 }}>
                backend/services/portalEmailService.js
              </code>{' '}
              with your email provider.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// MODULES TAB — enable/disable product modules per org
// ─────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// OAModules — enable/disable product modules + GoWarm sample playbook seeding
// ─────────────────────────────────────────────────────────────────────────────

function OAModules() {
  // modules state holds { allowed: bool, enabled: bool } per key
  const [modules, setModules] = useState({
    contracts:   { allowed: false, enabled: false },
    prospecting: { allowed: false, enabled: false },
    handovers:   { allowed: false, enabled: false },
    service:     { allowed: false, enabled: false },
    agency:      { allowed: false, enabled: false },
  });
  // seedStatus holds { prospecting, sales, clm, service, handovers } booleans
  const [seedStatus, setSeedStatus] = useState({});
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(null);   // module key being toggled
  const [seeding, setSeeding]       = useState(null);   // module key being seeded
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');

  const API    = process.env.REACT_APP_API_URL || '';
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getProfile(),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
    ])
      .then(([profileRes, seedRes]) => {
        const normalised = profileRes.data.modules;
        if (normalised) {
          setModules({
            contracts:   normalised.contracts   || { allowed: false, enabled: false },
            prospecting: normalised.prospecting || { allowed: false, enabled: false },
            handovers:   normalised.handovers   || { allowed: false, enabled: false },
            service:     normalised.service     || { allowed: false, enabled: false },
            agency:      normalised.agency      || { allowed: false, enabled: false },
          });
        } else {
          const mods = profileRes.data.org?.settings?.modules || {};
          const toLegacy = (v) => { const b = v === true || v === 'true'; return { allowed: b, enabled: b }; };
          setModules({
            contracts:   toLegacy(mods.contracts),
            prospecting: toLegacy(mods.prospecting),
            handovers:   toLegacy(mods.handovers),
            service:     toLegacy(mods.service),
            agency:      toLegacy(mods.agency),
          });
        }
        setSeedStatus(seedRes.status || {});
      })
      .catch(() => setError('Failed to load module settings'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const MODULE_TOGGLE_API = {
    contracts:   (enabled) => apiService.contracts.toggleModule(enabled),
    prospecting: (enabled) => apiService.prospects.toggleModule(enabled),
    handovers:   (enabled) => apiService.handovers.toggleModule(enabled),
    service:     (enabled) => apiService.support.toggleModule(enabled),
    agency:      (enabled) => apiService.agency.toggleModule(enabled),
  };

  // Maps module key → the playbook seed key used by the backend
  const MODULE_SEED_KEY = {
    prospecting: 'prospecting',
    contracts:   'clm',
    handovers:   'handovers',
    service:     'service',
    agency:      null, // no sample playbook for agency
  };

  const handleToggle = async (moduleName, newEnabled) => {
    setSaving(moduleName);
    setError('');
    try {
      await MODULE_TOGGLE_API[moduleName](newEnabled);
      setModules(prev => ({
        ...prev,
        [moduleName]: { ...prev[moduleName], enabled: newEnabled },
      }));
      const label = MODULE_DEFS.find(m => m.key === moduleName)?.label || moduleName;
      setSuccess(`${label} module ${newEnabled ? 'enabled' : 'disabled'} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      window.dispatchEvent(new CustomEvent('moduleToggle', { detail: { module: moduleName, enabled: newEnabled } }));
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message || 'Failed to update module';
      setError(msg);
    } finally {
      setSaving(null);
    }
  };

  const handleSeed = async (moduleName) => {
    const seedKey = MODULE_SEED_KEY[moduleName];
    if (!seedKey) return;
    setSeeding(moduleName);
    setError('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ module: seedKey }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      if (data.seeded) {
        setSeedStatus(prev => ({ ...prev, [seedKey]: true }));
        setSuccess(`GoWarm sample playbook seeded for ${MODULE_DEFS.find(m => m.key === moduleName)?.label || moduleName} ✓`);
        setTimeout(() => setSuccess(''), 4000);
      } else {
        setSuccess(data.message || 'Already seeded.');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (e) {
      setError(e.message || 'Failed to seed playbook');
    } finally {
      setSeeding(null);
    }
  };

  // MODULE_DEFS is unchanged from original — copy it from the existing OAModules
  const MODULE_DEFS = [
    {
      key: 'prospecting',
      icon: '🎯',
      label: 'Prospecting',
      desc: 'Full prospecting pipeline — manage prospect lists, track outreach stages, ICP scoring, coverage scorecards, and prospecting playbooks.',
      features: [
        'Prospect pipeline with customisable stages',
        'ICP scoring and fit analysis',
        'Outreach sequencing and action tracking',
        'Account coverage scorecards against playbooks',
        'Prospect-to-deal conversion workflow',
        'Prospecting playbooks with stage guidance',
      ],
      color: '#0F9D8E',
    },
    {
      key: 'contracts',
      icon: '📄',
      label: 'Contract Lifecycle Management',
      desc: 'Full CLM workflow — create contracts, legal review queue, approval chains, e-signature tracking, document versioning, and automated expiry notifications.',
      features: [
        'NDA, MSA, SOW, Order Form, Amendment support',
        'Legal team review queue and assignment',
        'Internal approval chains (by role, value, type)',
        'Document version history with major/minor tracking',
        'Signatory management and signature tracking',
        'Deal-linked contracts visible in deal detail view',
        'Automated expiry and unsigned follow-up notifications',
      ],
      color: '#6366f1',
    },
    {
      key: 'handovers',
      icon: '🤝',
      label: 'Sales → Implementation Handover',
      desc: 'Structured handover workflow when a deal closes — ensures sales captures everything the implementation team needs before handing off.',
      features: [
        'Handover automatically created when a deal is marked Closed Won',
        'Play-driven checklist with gate enforcement before submission',
        'Customer stakeholder mapping with implementation roles',
        'Commitments, promises, risks, and red flags log',
        'Commercial terms summary and go-live date tracking',
        'Service owner assignment and acknowledgement workflow',
        'Implementation notes visible to the service team',
      ],
      color: '#0369a1',
    },
    {
      key: 'service',
      icon: '🎧',
      label: 'Customer Support & Service',
      desc: 'Full case management — log, track, and resolve customer support cases with SLA tracking, playbook-driven workflows, and team assignment.',
      features: [
        'Case creation with priority and source tracking',
        'SLA tiers — response and resolution target hours',
        'SLA breach detection and dashboard alerts',
        'Status workflow: Open → In Progress → Pending Customer → Resolved → Closed',
        'Playbook-driven plays fired on case creation and status change',
        'Team and individual assignment with activity log',
        'Internal notes and customer-facing comments',
      ],
      color: '#0891b2',
    },
    {
      key: 'agency',
      icon: '🏢',
      label: 'Agency Client Management',
      desc: 'Manage client accounts on behalf of your customers — dedicated portals, team assignment, outreach tracking, and client-scoped dashboards.',
      features: [
        'Client records linked to existing accounts',
        'Team assignment — assign internal users as client leads or members',
        'Prospect, account, and sequence scoping per client',
        'Client portal with magic-link access for external stakeholders',
        'Client-branded sender accounts for outreach sequences',
        'Per-client outreach dashboard and reply tracking',
      ],
      color: '#7c3aed',
    },
  ];

  // Render — same outer structure as original, but with locked state for disallowed modules
  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🧩 Modules</h2>
          <p className="sv-panel-desc">
            Enable or disable product modules for your organisation.
            Modules must be provisioned by the platform before they can be activated.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {loading ? (
        <div className="sv-loading">Loading modules…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {MODULE_DEFS.map(mod => {
            const state     = modules[mod.key] || { allowed: false, enabled: false };
            const isAllowed = state.allowed;
            const isEnabled = state.enabled;
            const isSaving  = saving === mod.key;
            const isLocked  = !isAllowed;

            return (
              <div
                key={mod.key}
                style={{
                  border: `1px solid ${isLocked ? '#e5e7eb' : isEnabled ? mod.color + '40' : '#e5e7eb'}`,
                  borderRadius: 12,
                  padding: '18px 20px',
                  background: isLocked ? '#fafafa' : isEnabled ? mod.color + '08' : '#fff',
                  opacity: isLocked ? 0.65 : 1,
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  {/* Icon */}
                  <div style={{ fontSize: 28, marginTop: 2, flexShrink: 0 }}>{mod.icon}</div>

                  {/* Content */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{mod.label}</div>
                      {/* Status chip */}
                      {isLocked ? (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: '#f3f4f6', color: '#9ca3af',
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          🔒 Not included in plan
                        </span>
                      ) : isEnabled ? (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: mod.color + '20', color: mod.color,
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          Active
                        </span>
                      ) : (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: '#f3f4f6', color: '#9ca3af',
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          Available — not active
                        </span>
                      )}
                    </div>

                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px', lineHeight: 1.5 }}>
                      {isLocked
                        ? 'This module is not included in your current plan. Contact support to upgrade.'
                        : mod.desc
                      }
                    </p>

                    {/* Feature list — only show when not locked */}
                    {!isLocked && mod.features && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {mod.features.map(f => (
                          <span key={f} style={{
                            fontSize: 11, padding: '2px 8px', borderRadius: 20,
                            background: '#f3f4f6', color: '#374151',
                          }}>
                            ✓ {f}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* GoWarm sample playbook seed button — only when enabled and seed key exists */}
                    {!isLocked && isEnabled && MODULE_SEED_KEY[mod.key] && (() => {
                      const sk      = MODULE_SEED_KEY[mod.key];
                      const seeded  = !!seedStatus[sk];
                      const isBusy  = seeding === mod.key;
                      return (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <button
                            disabled={seeded || isBusy}
                            onClick={() => !seeded && !isBusy && handleSeed(mod.key)}
                            title={seeded ? 'Sample playbook already seeded' : 'Seed the GoWarm sample playbook for this module'}
                            style={{
                              padding: '6px 14px',
                              borderRadius: 7,
                              border: `1px solid ${seeded ? '#d1d5db' : mod.color}`,
                              background: seeded ? '#f9fafb' : mod.color + '15',
                              color: seeded ? '#9ca3af' : mod.color,
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: seeded || isBusy ? 'not-allowed' : 'pointer',
                              opacity: isBusy ? 0.7 : 1,
                              transition: 'all 0.15s',
                            }}
                          >
                            {isBusy ? '⏳ Seeding…' : seeded ? '✓ Sample Playbook Seeded' : '🌱 Seed GoWarm Sample Playbook'}
                          </button>
                          {!seeded && (
                            <span style={{ fontSize: 11, color: '#9ca3af' }}>
                              One-time — loads all v2 plays and stages for this module
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Toggle — disabled for locked modules */}
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <button
                      disabled={isLocked || isSaving}
                      onClick={() => !isLocked && handleToggle(mod.key, !isEnabled)}
                      title={
                        isLocked
                          ? 'Not included in your plan — contact support'
                          : isEnabled ? 'Disable module' : 'Enable module'
                      }
                      style={{
                        position: 'relative', width: 46, height: 26, borderRadius: 13,
                        border: 'none',
                        background: isLocked ? '#e5e7eb' : isEnabled ? mod.color : '#d1d5db',
                        cursor: isLocked || isSaving ? 'not-allowed' : 'pointer',
                        opacity: isSaving ? 0.7 : 1,
                        transition: 'background 0.2s',
                      }}
                    >
                      <span style={{
                        position: 'absolute', top: 4,
                        left: (!isLocked && isEnabled) ? 23 : 4,
                        width: 18, height: 18, borderRadius: '50%',
                        background: isLocked ? '#9ca3af' : '#fff',
                        transition: 'left 0.2s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }} />
                    </button>
                    <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>
                      {isSaving ? '…' : isEnabled ? 'On' : 'Off'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────
// CLM TEMPLATES TAB
// Admins upload master DOCX templates per contract type.
// Users download, fill in Word, upload back as v1.0.
// ─────────────────────────────────────────────────────────────────

function OACLMTemplates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');
  const [uploading, setUploading] = useState(null); // contract_type being uploaded
  const [form, setForm]           = useState({ contractType: 'nda', name: '', description: '', fileUrl: '', fileName: '' });
  const [showForm, setShowForm]   = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.contracts.getTemplates();
      setTemplates(r.data.templates || []);
    } catch { setError('Failed to load templates'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.fileUrl.trim()) {
      setError('Name and file URL are required'); return;
    }
    try {
      setUploading(form.contractType);
      await apiService.contracts.createTemplate(form);
      setSuccess('Template added');
      setTimeout(() => setSuccess(''), 2500);
      setShowForm(false);
      setForm({ contractType: 'nda', name: '', description: '', fileUrl: '', fileName: '' });
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to add template');
    } finally { setUploading(null); }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Remove template "${name}"?`)) return;
    try {
      await apiService.contracts.deleteTemplate(id);
      setSuccess('Template removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch { setError('Failed to remove template'); }
  };

  const groupedByType = Object.keys(CONTRACT_TYPE_LABELS).reduce((acc, type) => {
    acc[type] = templates.filter(t => t.contract_type === type && t.is_active);
    return acc;
  }, {});

  return (
    <div className="sv-panel">
      <div className="sv-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>📄 CLM Contract Templates</h2>
          <p className="sv-panel-desc">
            Upload master templates for each contract type. Team members can download these,
            fill them in Word, and upload back into a contract as v1.0.
          </p>
        </div>
        <button
          className="sv-btn sv-btn-primary"
          onClick={() => setShowForm(true)}
          style={{ whiteSpace: 'nowrap', marginLeft: 16 }}
        >
          + Add Template
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Add template form */}
      {showForm && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
          padding: 20, marginBottom: 20,
        }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>Add New Template</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label className="sv-label">Contract Type</label>
              <select
                className="sv-input"
                value={form.contractType}
                onChange={e => setForm(f => ({ ...f, contractType: e.target.value }))}
              >
                {Object.entries(CONTRACT_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="sv-label">Template Name</label>
              <input
                className="sv-input"
                placeholder="e.g. Standard NDA v3"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="sv-label">File URL (paste link from Google Drive / OneDrive / SharePoint)</label>
            <input
              className="sv-input"
              placeholder="https://docs.google.com/…"
              value={form.fileUrl}
              onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label className="sv-label">File Name (optional)</label>
            <input
              className="sv-input"
              placeholder="NDA_Template_v3.docx"
              value={form.fileName}
              onChange={e => setForm(f => ({ ...f, fileName: e.target.value }))}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="sv-label">Description (optional)</label>
            <input
              className="sv-input"
              placeholder="Use for standard mutual NDAs with US entities"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="sv-btn sv-btn-primary"
              onClick={handleCreate}
              disabled={!!uploading}
            >
              {uploading ? 'Adding…' : 'Add Template'}
            </button>
            <button className="sv-btn" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="sv-loading">Loading templates…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {Object.entries(CONTRACT_TYPE_LABELS).map(([type, label]) => (
            <div key={type}>
              <div style={{
                fontWeight: 600, fontSize: 13, color: '#374151',
                borderBottom: '1px solid #e5e7eb', paddingBottom: 8, marginBottom: 12,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {label}
                <span style={{
                  fontSize: 11, background: '#f3f4f6', color: '#6b7280',
                  borderRadius: 10, padding: '1px 8px',
                }}>
                  {groupedByType[type]?.length || 0}
                </span>
              </div>
              {(!groupedByType[type] || groupedByType[type].length === 0) ? (
                <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic', paddingLeft: 4 }}>
                  No templates — click "Add Template" to upload one.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {groupedByType[type].map(t => (
                    <div key={t.id} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', background: '#fff', border: '1px solid #e5e7eb',
                      borderRadius: 8, gap: 12,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#1f2937' }}>
                          📄 {t.name}
                        </div>
                        {t.description && (
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.description}</div>
                        )}
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                          Added {new Date(t.created_at).toLocaleDateString()}
                          {t.file_name && ` · ${t.file_name}`}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <a
                          href={t.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="sv-btn"
                          style={{ fontSize: 12, padding: '4px 12px', textDecoration: 'none' }}
                        >
                          ↓ Download
                        </a>
                        <button
                          className="oa-btn-remove"
                          style={{ fontSize: 12 }}
                          onClick={() => handleDelete(t.id, t.name)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// OAActionsAI — per-module AI enhancement toggles + export context settings
// Phase 3: AI is optional per action type, with a master toggle.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// REPLACE the entire OAActionsAI function in OrgAdminView.js with this block.
// Find: `function OAActionsAI() {`  …  `// ═══ function OAServiceGeneral`
// Replace with everything below up to the separator comment.
// ─────────────────────────────────────────────────────────────────────────────

function OAActionsAI() {
  const [config, setConfig]   = useState(null);
  const [saving, setSaving]   = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(true);

  const API = process.env.REACT_APP_API_URL || '';

  function apiFetch(path, opts = {}) {
    const token = localStorage.getItem('token') || localStorage.getItem('authToken');
    return fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      ...opts,
    }).then(r => {
      if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
      return r.json();
    });
  }

  useEffect(() => {
    apiFetch('/actions/config')
      .then(data => {
        const raw = data.config?.ai_settings || {};
        setConfig({
          master_enabled:         raw.master_enabled          ?? true,
          strap_generation_mode:  raw.strap_generation_mode   || 'both',
          strap_ai_provider:      raw.strap_ai_provider       || 'anthropic',
          modules: {
            deals:       raw.modules?.deals       ?? true,
            straps:      raw.modules?.straps      ?? true,
            clm:         raw.modules?.clm         ?? false,
            prospecting: raw.modules?.prospecting ?? false,
          },
        });
      })
      .catch(() => setError('Failed to load config'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await apiFetch('/actions/config', {
        method: 'PUT',
        body: JSON.stringify({ ai_settings: config }),
      });
      setSuccess('Saved ✓');
      setTimeout(() => setSuccess(''), 2500);
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function toggleModule(key) {
    setConfig(prev => ({
      ...prev,
      modules: { ...prev.modules, [key]: !prev.modules[key] },
    }));
  }

  const MODULE_DEFS = [
    { key: 'deals',       icon: '💼', label: 'Deal Actions',        desc: 'AI enhances rules-generated actions for at-risk and high-value deals using deal health, emails, meetings, and playbook context.' },
    { key: 'straps',      icon: '🎯', label: 'STRAP Actions',       desc: 'AI can suggest additional context and refinements to STRAP-generated action steps.' },
    { key: 'clm',         icon: '📄', label: 'Contract Actions',    desc: 'AI enhancement for CLM-generated actions. Off by default as CLM plays are already well-structured.' },
    { key: 'prospecting', icon: '🔭', label: 'Prospecting Actions', desc: 'AI enhancement for prospecting stage actions. Off by default as prospecting actions are simpler.' },
  ];

  const PROVIDER_DEFS = [
    { value: 'anthropic', label: 'Anthropic (Claude)', envKey: 'ANTHROPIC_API_KEY', note: 'Default — key configured at deploy time.' },
    { value: 'openai',    label: 'OpenAI (GPT-4o mini)', envKey: 'OPENAI_API_KEY',  note: 'Requires OPENAI_API_KEY in environment.' },
    { value: 'grok',      label: 'Grok (xAI)',           envKey: 'XAI_API_KEY',     note: 'Requires XAI_API_KEY in environment.' },
  ];

  const aiModeDisabled = !config?.master_enabled;

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 680, padding: '24px 0' }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>✨ Actions AI Settings</h2>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>
        Control when AI enhances your generated actions. Changes here apply org-wide as defaults —
        individual users can override STRAP generation settings in their own Settings.
      </p>

      {error   && <div style={{ padding: '10px 14px', background: '#fef2f2', borderRadius: 8, color: '#991b1b', fontSize: 14, marginBottom: 16 }}>{error}</div>}

      {/* ── Master toggle ── */}
      <div style={{ background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 10, padding: '16px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>🤖 Master AI Toggle</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>Turn off to disable all AI regardless of module settings.</div>
        </div>
        <ToggleSwitch
          on={config?.master_enabled}
          color="#10b981"
          onChange={() => setConfig(p => ({ ...p, master_enabled: !p.master_enabled }))}
        />
      </div>

      {/* ── Per-module toggles ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: aiModeDisabled ? 0.5 : 1, pointerEvents: aiModeDisabled ? 'none' : 'auto' }}>
        {MODULE_DEFS.map(mod => (
          <div key={mod.key} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 18px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500, fontSize: 14 }}>{mod.icon} {mod.label}</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>{mod.desc}</div>
            </div>
            <ToggleSwitch
              on={config?.modules[mod.key]}
              color="#6366f1"
              onChange={() => toggleModule(mod.key)}
            />
          </div>
        ))}
      </div>

      {/* ── STRAP Generation Mode ── */}
      <div style={{ marginTop: 28, paddingTop: 24, borderTop: '1px solid #e5e7eb' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>🎯 STRAP Generation Mode</div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16, lineHeight: 1.5 }}>
          When a user clicks "Generate STRAP", choose whether to show the playbook version,
          the AI version, or both side-by-side for the user to compare and choose.
          The AI option is only shown when Master AI is on.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {[
            { value: 'both',     icon: '⚖️', label: 'Both (user chooses)',  desc: 'Generate both versions. User sees a side-by-side comparison, selects one, edits if needed, then confirms.' },
            { value: 'playbook', icon: '📘', label: 'Playbook only',        desc: 'Always use the playbook template. Fast and consistent. No AI call.' },
            { value: 'ai',       icon: '🤖', label: 'AI only',              desc: 'Always use AI to generate the STRAP. If AI is unavailable, falls back to playbook automatically.' },
          ].map(opt => {
            const isSelected = config?.strap_generation_mode === opt.value;
            const isAiOpt    = opt.value === 'ai' || opt.value === 'both';
            const dimmed     = isAiOpt && aiModeDisabled;
            return (
              <label
                key={opt.value}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px',
                  border: `1.5px solid ${isSelected ? '#6366f1' : '#e5e7eb'}`,
                  borderRadius: 10, cursor: dimmed ? 'not-allowed' : 'pointer',
                  background: isSelected ? '#eef2ff' : '#fff',
                  opacity: dimmed ? 0.45 : 1,
                }}
              >
                <input
                  type="radio"
                  name="strap_generation_mode"
                  value={opt.value}
                  checked={isSelected}
                  disabled={dimmed}
                  onChange={() => !dimmed && setConfig(p => ({ ...p, strap_generation_mode: opt.value }))}
                  style={{ marginTop: 3, accentColor: '#6366f1' }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{opt.icon} {opt.label}</div>
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2, lineHeight: 1.4 }}>{opt.desc}</div>
                </div>
              </label>
            );
          })}
        </div>

        {/* AI Provider selector — only shown when mode includes AI */}
        {(config?.strap_generation_mode === 'ai' || config?.strap_generation_mode === 'both') && !aiModeDisabled && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '16px 18px' }}>
            <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 10 }}>AI Provider for STRAP generation</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {PROVIDER_DEFS.map(p => {
                const isSelected = config?.strap_ai_provider === p.value;
                return (
                  <label key={p.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="strap_ai_provider"
                      value={p.value}
                      checked={isSelected}
                      onChange={() => setConfig(prev => ({ ...prev, strap_ai_provider: p.value }))}
                      style={{ marginTop: 2, accentColor: '#6366f1' }}
                    />
                    <div>
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{p.label}</span>
                      <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>{p.note}</span>
                    </div>
                  </label>
                );
              })}
            </div>
            <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 10, lineHeight: 1.4 }}>
              ℹ️ If the selected provider's API key is not configured, STRAP generation will
              automatically fall back to the playbook template and show a warning to the user.
            </p>
          </div>
        )}
      </div>

      {/* ── Export context info ── */}
      <div style={{ marginTop: 24, padding: '14px 18px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10 }}>
        <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>💡 Using your own AI?</div>
        <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
          Every action card has an <strong>Export Context</strong> button that generates a structured
          summary of the deal — health score, contacts, emails, meetings, playbook goal, and the
          action itself. Copy it and paste into ChatGPT, Claude.ai, or any AI tool to get tailored
          suggestions without sharing your CRM credentials.
        </div>
      </div>

      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleSave}
          disabled={saving || !config}
          style={{ padding: '9px 22px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 500, fontSize: 14, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {success && <span style={{ color: '#059669', fontSize: 14 }}>{success}</span>}
      </div>
    </div>
  );
}

// ── Shared toggle switch used in OAActionsAI ──────────────────────────────────
// Add this helper just above OAActionsAI in OrgAdminView.js (or inline above).


// ─────────────────────────────────────────────────────────────────────────────
// END OF OAActionsAI REPLACEMENT BLOCK
// ─────────────────────────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════
function OAServiceGeneral() {
  const [enabled, setEnabled] = useState(false);
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => {
        const s = r.data.org?.settings || {};
        setEnabled(s.modules?.service || false);
      })
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false));

    // Load case stats if module is on
    apiService.support?.getDashboard?.('all')
      .then(d => setStats(d?.stats || null))
      .catch(() => {});
  }, []);

  const handleToggle = async (newVal) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await apiService.support.toggleModule(newVal);
      setEnabled(newVal);
      setSuccess(`Service module ${newVal ? 'enabled' : 'disabled'} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      window.dispatchEvent(new CustomEvent('moduleToggle', { detail: { module: 'service', enabled: newVal } }));
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Enable / disable toggle */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Enable Service Module</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3 }}>
            When enabled, agents can create and manage support cases from the 🎧 Service tab. Default SLA tiers are created automatically on first enable.
          </div>
        </div>
        <div
          onClick={() => !saving && handleToggle(!enabled)}
          style={{
            flexShrink: 0, width: 44, height: 24, borderRadius: 12,
            background: enabled ? '#6366f1' : '#d1d5db',
            position: 'relative', cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'background .2s', opacity: saving ? 0.7 : 1,
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: '50%', background: '#fff',
            position: 'absolute', top: 3,
            left: enabled ? 23 : 3,
            transition: 'left .2s',
            boxShadow: '0 1px 3px rgba(0,0,0,.2)',
          }} />
        </div>
      </div>

      {/* Stats summary (only if enabled and data loaded) */}
      {enabled && stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {[
            { label: 'Total Open',          value: stats.totalOpen,          color: '#6366f1' },
            { label: 'Response Breaches',   value: stats.responseBreaches,   color: '#ef4444' },
            { label: 'Resolution Breaches', value: stats.resolutionBreaches, color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '14px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: s.value > 0 ? s.color : '#d1d5db', marginTop: 4 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {enabled && !stats && (
        <div style={{ padding: '14px 18px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9, fontSize: 13, color: '#166534' }}>
          ✅ Service module is active. No open cases yet.
        </div>
      )}
    </div>
  );
}

function OAServiceSLATiers() {
  const [tiers, setTiers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [editing, setEditing] = useState(null);   // null | 'new' | tier object
  const [saving, setSaving]   = useState(false);
  const [form, setForm]       = useState({});

  const load = () => {
    setLoading(true);
    apiService.support.getSlaTiers()
      .then(r => { setTiers(r.data?.tiers || []); setError(''); })
      .catch(e => setError(e.response?.data?.error?.message || e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setForm({ name: '', description: '', responseTargetHours: 4, resolutionTargetHours: 24 });
    setEditing('new');
  };

  const openEdit = (tier) => {
    setForm({
      name:                  tier.name,
      description:           tier.description || '',
      responseTargetHours:   tier.responseTargetHours,
      resolutionTargetHours: tier.resolutionTargetHours,
      isActive:              tier.isActive,
    });
    setEditing(tier);
  };

  const handleSave = async () => {
    if (!form.name?.trim()) { setError('Tier name is required'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      if (editing === 'new') {
        await apiService.support.createSlaTier({
          name:                  form.name.trim(),
          description:           form.description || undefined,
          responseTargetHours:   parseFloat(form.responseTargetHours) || 4,
          resolutionTargetHours: parseFloat(form.resolutionTargetHours) || 24,
        });
        setSuccess('SLA tier created ✓');
      } else {
        await apiService.support.updateSlaTier(editing.id, {
          name:                  form.name.trim(),
          description:           form.description || undefined,
          responseTargetHours:   parseFloat(form.responseTargetHours),
          resolutionTargetHours: parseFloat(form.resolutionTargetHours),
          isActive:              form.isActive,
        });
        setSuccess('SLA tier updated ✓');
      }
      setTimeout(() => setSuccess(''), 3000);
      setEditing(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tier) => {
    try {
      await apiService.support.updateSlaTier(tier.id, { isActive: !tier.isActive });
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to update');
    }
  };

  if (loading) return <div className="sv-loading">Loading SLA tiers…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          Define response and resolution targets for different customer tiers. Accounts are assigned a tier, and cases inherit it.
        </div>
        {!editing && (
          <button onClick={openNew} style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0, marginLeft: 16 }}>
            + New Tier
          </button>
        )}
      </div>

      {/* New / edit form */}
      {editing && (
        <div style={{ background: '#f8fafc', border: '1px solid #c7d2fe', borderRadius: 10, padding: '18px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 14 }}>
            {editing === 'new' ? 'New SLA Tier' : `Edit — ${editing.name}`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Gold, Platinum"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Response Target (hours)</label>
              <input type="number" min="0.5" step="0.5" value={form.responseTargetHours} onChange={e => setForm(f => ({ ...f, responseTargetHours: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Resolution Target (hours)</label>
              <input type="number" min="1" step="1" value={form.resolutionTargetHours} onChange={e => setForm(f => ({ ...f, resolutionTargetHours: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          </div>
          {editing !== 'new' && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
                Active (visible for assignment)
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving} style={{ padding: '7px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {saving ? 'Saving…' : editing === 'new' ? 'Create Tier' : 'Save Changes'}
            </button>
            <button onClick={() => { setEditing(null); setError(''); }} style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tier list */}
      {tiers.length === 0 ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          No SLA tiers yet. The default tiers (Platinum, Gold, Standard) are created automatically when the module is first enabled.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tiers.map(tier => (
            <div key={tier.id} style={{ background: '#fff', border: `1px solid ${tier.isActive ? '#e5e7eb' : '#f3f4f6'}`, borderRadius: 9, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, opacity: tier.isActive ? 1 : 0.6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{tier.name}</span>
                  {!tier.isActive && <span style={{ fontSize: 10, background: '#f3f4f6', color: '#9ca3af', padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>Inactive</span>}
                </div>
                {tier.description && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{tier.description}</div>}
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280', flexShrink: 0 }}>
                <span>⏱ Response: <strong style={{ color: '#374151' }}>{tier.responseTargetHours}h</strong></span>
                <span>✅ Resolution: <strong style={{ color: '#374151' }}>{tier.resolutionTargetHours}h</strong></span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => openEdit(tier)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151' }}>Edit</button>
                <button onClick={() => handleToggleActive(tier)} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer', color: tier.isActive ? '#9ca3af' : '#059669' }}>
                  {tier.isActive ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OAWorkflows — Workflow Engine tab for Org Admin
// Placed in the Data Quality nav group alongside Duplicates.
// Renders two sub-tabs:
//   Workflows   — WorkflowCanvas (org scope)
//   Exec Log    — ExecutionLog (org scope, includes Violations sub-tab)
// ─────────────────────────────────────────────────────────────────────────────

function OAWorkflows() {
  const [subTab, setSubTab] = useState('canvas');

  const SUB_TABS = [
    { id: 'canvas', label: '⚙️ Workflows & Rules' },
    { id: 'log',    label: '📋 Execution Log'     },
  ];

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>⚙️ Workflows</h2>
          <p className="sv-panel-desc">
            Define data-integrity rules for deals, contacts, and accounts.
            Platform workflows (🔒) are managed by ActionCRM and cannot be modified.
          </p>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '7px 16px',
              borderRadius: '7px 7px 0 0',
              border: '1px solid transparent',
              borderBottom: 'none',
              background: subTab === t.id ? '#fff' : 'transparent',
              borderColor: subTab === t.id ? '#e5e7eb' : 'transparent',
              borderBottomColor: subTab === t.id ? '#fff' : 'transparent',
              fontSize: 13,
              fontWeight: subTab === t.id ? 600 : 500,
              color: subTab === t.id ? '#111827' : '#6b7280',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'canvas' && <WorkflowCanvas scope="org" />}
      {subTab === 'log'    && <ExecutionLog   scope="org" />}
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// OACallSettings
//
// Sub-tab inside OAProspectingModule. Lets org admins customize:
//   - The list of call outcomes shown in the "Log call" form dropdown
//   - The edit window — how long after a call can be edited by the logger
//
// The component reads org settings from /api/org/call-settings on mount and
// PATCHes them on save. Validation surfaces server messages inline.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// OAProspectingEscalation — per-org policy for the prospecting notification
// pipeline. Edits org_action_config.prospecting_escalation via the new
// /org/admin/prospecting-escalation endpoints (Sprint 1, Group A).
//
// What lives here:
//   - Master enable + per-channel enable (immediate, daily digest)
//   - immediate_hours threshold (when to fire the "overdue" alert)
//   - tier hours (when to loop in manager / skip-level / org admins)
//   - digest_hour_utc (when the daily summary fires for this org)
//   - delivery channels (email, in_app)
//
// What does NOT live here (intentionally):
//   - Per-user opt-outs — those live in NotificationSettings.js so reps can
//     quiet just themselves without disabling for the whole org.
//   - Manager hierarchy — that's a separate org-admin concern (org_hierarchy
//     table) and already has its own UI.
// ═════════════════════════════════════════════════════════════════════════════
function OAProspectingEscalation() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // policy starts undefined so we can distinguish "still loading" from
  // "loaded but empty". Defaults from the server come back inside the
  // policy object — we never have to hardcode them client-side.
  const [policy,   setPolicy]   = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [dirty,    setDirty]    = useState(false);
  const [flash,    setFlash]    = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/org/admin/prospecting-escalation`, { headers })
      .then(r => r.json())
      .then(res => {
        setPolicy(res.policy || {});
        setDefaults(res.defaults || {});
      })
      .catch(() => showFlash('error', 'Failed to load escalation policy'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single field setter — works for booleans, numbers, arrays.
  const set = (key, value) => {
    setPolicy(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  // Channel multi-select. The policy stores an array; UI is two checkboxes.
  const toggleChannel = (ch) => {
    const current = Array.isArray(policy.channels) ? policy.channels : [];
    const next = current.includes(ch)
      ? current.filter(c => c !== ch)
      : [...current, ch];
    // Don't allow empty — validation on the backend would reject it, but
    // better to short-circuit the UI so the user sees what's happening.
    if (next.length === 0) {
      showFlash('error', 'At least one delivery channel must be selected');
      return;
    }
    set('channels', next);
  };

  const handleSave = async () => {
    // Client-side monotonicity guard mirrors the server check — gives a
    // clearer error before the round trip.
    if (!(policy.tier1_hours < policy.tier2_hours && policy.tier2_hours < policy.tier3_hours)) {
      showFlash('error', 'Tier hours must be strictly increasing: Tier 1 < Tier 2 < Tier 3');
      return;
    }

    setSaving(true);
    try {
      const r = await fetch(`${API}/org/admin/prospecting-escalation`, {
        method: 'PUT', headers,
        body: JSON.stringify(policy),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Save failed');
      setPolicy(res.policy);
      setDirty(false);
      showFlash('success', 'Escalation policy saved');
    } catch (e) {
      showFlash('error', e.message || 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!defaults) return;
    if (!window.confirm('Reset all escalation settings to system defaults? Unsaved changes will be lost.')) return;
    setPolicy({ ...defaults });
    setDirty(true);
  };

  if (loading || !policy) {
    return <div style={{ padding: 24, color: '#6b7280' }}>Loading escalation settings…</div>;
  }

  // Reused styles — kept inline to match the rest of OrgAdminView.js, which
  // doesn't import a CSS module for these subtabs.
  const cardStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
    padding: 16, marginBottom: 12,
  };
  const labelStyle = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4,
  };
  const inputStyle = {
    width: 120, padding: '6px 10px', fontSize: 13,
    border: '1px solid #d1d5db', borderRadius: 6,
  };
  const helpStyle = {
    fontSize: 11, color: '#6b7280', marginTop: 4,
  };

  // Build the digest-hour dropdown. We label each UTC hour with its
  // corresponding IST and PT time so the admin can pick by their morning,
  // not by guessing offsets. 24 options.
  const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
    const istHour = (h + 5) % 24;
    const istMin  = 30;
    const ptHour  = (h + 24 - 8) % 24;  // PST baseline, ignores DST
    const fmt = (hr, min = 0) => {
      const pm = hr >= 12;
      const h12 = hr % 12 === 0 ? 12 : hr % 12;
      return `${h12}:${String(min).padStart(2,'0')} ${pm ? 'PM' : 'AM'}`;
    };
    return {
      value: h,
      label: `${String(h).padStart(2,'0')}:00 UTC  (${fmt(istHour, istMin)} IST · ${fmt(ptHour)} PT)`,
    };
  });

  return (
    <div style={{ marginTop: 8, maxWidth: 760 }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>📣 Escalation Policy</h3>
          <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
            How overdue prospecting actions are surfaced to reps and escalated to managers.
          </p>
        </div>
        <button
          onClick={handleReset}
          style={{
            padding: '6px 12px', fontSize: 12, color: '#6b7280',
            background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Reset to defaults
        </button>
      </div>

      {flash && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
          background: flash.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      flash.type === 'error' ? '#991b1b' : '#166534',
          border: `1px solid ${flash.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* ── Master enable ──────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Escalation enabled</div>
            <div style={helpStyle}>Master switch. When off, no alerts or escalations fire for this org.</div>
          </div>
          <label className="ns-toggle" style={{ position: 'relative', display: 'inline-block', width: 38, height: 22 }}>
            <input
              type="checkbox"
              checked={!!policy.enabled}
              onChange={e => set('enabled', e.target.checked)}
              style={{ display: 'none' }}
            />
            <span style={{
              position: 'absolute', cursor: 'pointer', inset: 0,
              background: policy.enabled ? '#10b981' : '#d1d5db',
              borderRadius: 11, transition: 'background 0.15s',
            }} />
            <span style={{
              position: 'absolute', top: 2, left: policy.enabled ? 18 : 2,
              width: 18, height: 18, background: '#fff', borderRadius: '50%',
              transition: 'left 0.15s',
            }} />
          </label>
        </div>
      </div>

      {/* When master is off, dim the rest. Still editable so the admin can
          tweak settings before turning the policy on. */}
      <div style={{ opacity: policy.enabled ? 1 : 0.5 }}>

        {/* ── Immediate alert ────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Immediate alert</div>
              <div style={helpStyle}>Notify the rep when an action has been overdue for the threshold below.</div>
            </div>
            <input
              type="checkbox"
              checked={!!policy.immediate_alert_enabled}
              onChange={e => set('immediate_alert_enabled', e.target.checked)}
              style={{ marginTop: 4 }}
            />
          </div>
          {policy.immediate_alert_enabled && (
            <div>
              <label style={labelStyle}>Alert after</label>
              <input
                type="number" min={1} max={720}
                value={policy.immediate_hours}
                onChange={e => set('immediate_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>hours past due</span>
            </div>
          )}
        </div>

        {/* ── Daily digest ───────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Daily digest</div>
              <div style={helpStyle}>
                One summary per rep per day, sent at the time you pick below.
                Defaults to 03:00 UTC = 8:30 AM IST.
              </div>
            </div>
            <input
              type="checkbox"
              checked={!!policy.daily_digest_enabled}
              onChange={e => set('daily_digest_enabled', e.target.checked)}
              style={{ marginTop: 4 }}
            />
          </div>
          {policy.daily_digest_enabled && (
            <div>
              <label style={labelStyle}>Send digest at</label>
              <select
                value={policy.digest_hour_utc}
                onChange={e => set('digest_hour_utc', parseInt(e.target.value))}
                style={{ ...inputStyle, width: 360 }}
              >
                {HOUR_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* ── Escalation tiers ───────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>Escalation tiers</div>
          <div style={{ ...helpStyle, marginBottom: 14 }}>
            When an action stays overdue, escalate up the hierarchy at these
            thresholds. Tier 2 notifies the rep's reporting manager; Tier 3
            also notifies the manager's manager (or all org admins as a
            fallback if no skip-level manager exists).
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Tier 1 — rep nudge</label>
              <input
                type="number" min={1} max={720}
                value={policy.tier1_hours}
                onChange={e => set('tier1_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <div style={helpStyle}>hours past due</div>
            </div>
            <div>
              <label style={labelStyle}>Tier 2 — loop in manager</label>
              <input
                type="number" min={1} max={720}
                value={policy.tier2_hours}
                onChange={e => set('tier2_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <div style={helpStyle}>hours past due</div>
            </div>
            <div>
              <label style={labelStyle}>Tier 3 — skip-level</label>
              <input
                type="number" min={1} max={720}
                value={policy.tier3_hours}
                onChange={e => set('tier3_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <div style={helpStyle}>hours past due</div>
            </div>
          </div>
        </div>

        {/* ── Delivery channels ──────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>Delivery channels</div>
          <div style={{ ...helpStyle, marginBottom: 14 }}>
            How notifications are delivered. In-app notifications appear in
            the bell icon. Email notifications go to each recipient's
            registered address.
          </div>

          <div style={{ display: 'flex', gap: 24 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={(policy.channels || []).includes('in_app')}
                onChange={() => toggleChannel('in_app')}
              />
              In-app
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={(policy.channels || []).includes('email')}
                onChange={() => toggleChannel('email')}
              />
              Email
            </label>
          </div>
        </div>
      </div>

      {/* ── Save bar ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            color: '#fff', background: dirty && !saving ? '#0F9D8E' : '#9ca3af',
            border: 'none', borderRadius: 6,
            cursor: dirty && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// OAProspectingEnrichment — per-org enrichment configuration (Sprint 3).
//
// Edits org_action_config.enrichment via /org/admin/enrichment-config:
//   - chain_company / chain_person — drag-to-reorder provider chains
//   - monthly_cap — hard stop on enrichment credits per calendar month
//
// Also surfaces:
//   - Per-provider API key entry (calls /org/admin/enrichment-credentials)
//   - Current month's usage tile (calls /org/admin/enrichment-usage)
//
// Provider keys are stored encrypted in org_credentials with purpose='enrichment'.
// ═════════════════════════════════════════════════════════════════════════════
function OAProspectingEnrichment() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [config,          setConfig]        = useState(null);
  const [validProviders,  setValidProviders] = useState([]);
  const [configured,      setConfigured]    = useState([]);
  const [credentials,     setCredentials]   = useState([]);
  const [usage,           setUsage]         = useState(null);
  const [loading,         setLoading]       = useState(true);
  const [saving,          setSaving]        = useState(false);
  const [dirty,           setDirty]         = useState(false);
  const [flash,           setFlash]         = useState(null);
  const [newKeyProvider,  setNewKeyProvider] = useState('');
  const [newKeyValue,     setNewKeyValue]    = useState('');
  const [newKeyLabel,     setNewKeyLabel]    = useState('');

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  // Helper — load all three: config, credentials, usage.
  const reload = async () => {
    try {
      const [cfg, creds, use] = await Promise.all([
        fetch(`${API}/org/admin/enrichment-config`,      { headers }).then(r => r.json()),
        fetch(`${API}/org/admin/enrichment-credentials`, { headers }).then(r => r.json()),
        fetch(`${API}/org/admin/enrichment-usage`,       { headers }).then(r => r.json()),
      ]);
      setConfig(cfg.config || {});
      setValidProviders(cfg.valid_providers || []);
      setConfigured(cfg.configured_providers || []);
      setCredentials(creds.credentials || []);
      setUsage(use);
    } catch (e) {
      showFlash('error', 'Failed to load enrichment settings');
    }
  };

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = (key, val) => {
    setConfig(prev => ({ ...prev, [key]: val }));
    setDirty(true);
  };

  // Chain editor — move a provider up or down in the order, or toggle whether
  // it's in the chain at all.
  const toggleProviderInChain = (chainKey, provider) => {
    const current = Array.isArray(config[chainKey]) ? config[chainKey] : [];
    const next = current.includes(provider)
      ? current.filter(p => p !== provider)
      : [...current, provider];
    if (next.length === 0) {
      showFlash('error', 'At least one provider must be in the chain');
      return;
    }
    setField(chainKey, next);
  };

  const moveProviderInChain = (chainKey, provider, dir) => {
    const current = [...(config[chainKey] || [])];
    const idx = current.indexOf(provider);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= current.length) return;
    [current[idx], current[target]] = [current[target], current[idx]];
    setField(chainKey, current);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/org/admin/enrichment-config`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          chain_company: config.chain_company,
          chain_person:  config.chain_person,
          monthly_cap:   config.monthly_cap,
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Save failed');
      setConfig(res.config);
      setDirty(false);
      showFlash('success', 'Enrichment configuration saved');
    } catch (e) {
      showFlash('error', e.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleAddKey = async () => {
    if (!newKeyProvider || !newKeyValue) {
      showFlash('error', 'Pick a provider and paste the API key');
      return;
    }
    try {
      const r = await fetch(`${API}/org/admin/enrichment-credentials`, {
        method: 'POST', headers,
        body: JSON.stringify({
          provider: newKeyProvider,
          api_key:  newKeyValue,
          label:    newKeyLabel || null,
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Failed to store key');
      setNewKeyProvider('');
      setNewKeyValue('');
      setNewKeyLabel('');
      showFlash('success', `Stored ${newKeyProvider} credential ending …${res.credential?.key_last4 || ''}`);
      await reload();
    } catch (e) {
      showFlash('error', e.message || 'Failed to store key');
    }
  };

  if (loading || !config) {
    return <div style={{ padding: 24, color: '#6b7280' }}>Loading enrichment settings…</div>;
  }

  const cardStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
    padding: 16, marginBottom: 12,
  };
  const helpStyle = { fontSize: 11, color: '#6b7280', marginTop: 4 };

  const PROVIDER_LABELS = {
    coresignal: 'CoreSignal',
    apollo:     'Apollo.io',
  };

  // Render one chain editor (company OR person). Shows providers in order
  // with up/down buttons and a toggle to include/exclude each.
  const ChainEditor = ({ chainKey, label, allowed }) => {
    const current = Array.isArray(config[chainKey]) ? config[chainKey] : [];
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 }}>{label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {current.map((prov, i) => (
            <div key={prov} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', background: '#f9fafb',
              border: '1px solid #e5e7eb', borderRadius: 6,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, color: '#6b7280', minWidth: 16,
              }}>{i + 1}.</span>
              <span style={{ flex: 1, fontSize: 13 }}>{PROVIDER_LABELS[prov] || prov}</span>
              {configured.includes(prov)
                ? <span style={{ fontSize: 10, color: '#16a34a' }}>● key configured</span>
                : <span style={{ fontSize: 10, color: '#f59e0b' }}>● no key</span>}
              <button
                disabled={i === 0}
                onClick={() => moveProviderInChain(chainKey, prov, -1)}
                style={{ padding: '2px 6px', fontSize: 11, cursor: i === 0 ? 'default' : 'pointer' }}
                title="Move up"
              >▲</button>
              <button
                disabled={i === current.length - 1}
                onClick={() => moveProviderInChain(chainKey, prov, +1)}
                style={{ padding: '2px 6px', fontSize: 11, cursor: i === current.length - 1 ? 'default' : 'pointer' }}
                title="Move down"
              >▼</button>
              <button
                onClick={() => toggleProviderInChain(chainKey, prov)}
                style={{ padding: '2px 6px', fontSize: 11, color: '#991b1b', cursor: 'pointer' }}
                title="Remove from chain"
              >✕</button>
            </div>
          ))}
        </div>
        {/* Providers not yet in the chain */}
        {allowed.filter(p => !current.includes(p)).length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
            Add:&nbsp;
            {allowed.filter(p => !current.includes(p)).map(p => (
              <button
                key={p}
                onClick={() => toggleProviderInChain(chainKey, p)}
                style={{
                  padding: '2px 8px', fontSize: 11, marginRight: 6,
                  background: '#fff', border: '1px solid #d1d5db', borderRadius: 4,
                  cursor: 'pointer', color: '#374151',
                }}
              >+ {PROVIDER_LABELS[p] || p}</button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 8, maxWidth: 820 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>
        💎 Enrichment
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>
        Configure which providers enrich your prospects, in what order, and the
        monthly credit cap.
      </p>

      {flash && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
          background: flash.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      flash.type === 'error' ? '#991b1b' : '#166534',
          border: `1px solid ${flash.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* ── Usage tile ───────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 8 }}>
          This month's usage
        </div>
        {usage ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>{usage.total || 0}</span>
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                credits used
                {usage.cap ? ` of ${usage.cap} cap` : ' (no cap set)'}
              </span>
            </div>
            {usage.cap && (
              <div style={{ marginTop: 8, height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width:  `${Math.min(100, usage.percent_used || 0)}%`,
                  height: '100%',
                  background: usage.percent_used >= 90 ? '#dc2626'
                            : usage.percent_used >= 70 ? '#f59e0b'
                            : '#10b981',
                }} />
              </div>
            )}
            {Array.isArray(usage.by_provider) && usage.by_provider.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {usage.by_provider.map(p => (
                  <span key={p.provider} style={{
                    padding: '3px 8px', background: '#f3f4f6',
                    border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 11,
                  }}>
                    <strong>{PROVIDER_LABELS[p.provider] || p.provider}</strong>
                    <span style={{ color: '#6b7280', marginLeft: 6 }}>
                      {p.credits} credits · {p.calls} calls
                      {p.errors > 0 ? ` · ${p.errors} errors` : ''}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ color: '#9ca3af', fontSize: 12 }}>No usage data yet this month.</div>
        )}
      </div>

      {/* ── Monthly cap ─────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Monthly credit cap</div>
        <div style={helpStyle}>
          Hard stop. Enrichment calls return an error after this many credits
          in the current calendar month. Set to 0 (or leave blank) for no cap.
          At 90% of cap, all org admins get a one-time warning notification.
        </div>
        <div style={{ marginTop: 8 }}>
          <input
            type="number" min={0}
            value={config.monthly_cap ?? ''}
            placeholder="No cap"
            onChange={e => {
              const v = e.target.value.trim();
              setField('monthly_cap', v === '' ? null : parseInt(v) || 0);
            }}
            style={{
              width: 160, padding: '6px 10px', fontSize: 13,
              border: '1px solid #d1d5db', borderRadius: 6,
            }}
          />
          <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>credits / month</span>
        </div>
      </div>

      {/* ── Chains ──────────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>
          Provider chain
        </div>
        <div style={{ ...helpStyle, marginBottom: 10 }}>
          Providers are tried in order. If the first returns no_found or no key
          is configured, the next one is tried.
        </div>
        <ChainEditor chainKey="chain_company" label="Account / company enrichment" allowed={validProviders} />
        <ChainEditor chainKey="chain_person"  label="Person enrichment"           allowed={validProviders.filter(p => p === 'apollo')} />
      </div>

      {/* ── API keys ────────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>API keys</div>
        <div style={helpStyle}>
          Stored encrypted with AES-256-GCM. Only the last 4 characters are
          shown back. Rotating a key auto-revokes the previous one.
        </div>

        {/* Existing keys */}
        {credentials.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {credentials.map(c => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', background: '#f9fafb',
                border: '1px solid #e5e7eb', borderRadius: 6,
              }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{PROVIDER_LABELS[c.provider] || c.provider}</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>•••• {c.key_last4}</span>
                {c.label && <span style={{ fontSize: 11, color: '#9ca3af' }}>({c.label})</span>}
                <span style={{ flex: 1 }} />
                <span style={{
                  fontSize: 10,
                  color: c.status === 'active' ? '#16a34a' : c.status === 'invalid' ? '#dc2626' : '#6b7280',
                }}>● {c.status}</span>
              </div>
            ))}
          </div>
        )}

        {/* Add new key */}
        <div style={{
          marginTop: 12, padding: 12,
          background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Add a key</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              value={newKeyProvider}
              onChange={e => setNewKeyProvider(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}
            >
              <option value="">Select provider…</option>
              {validProviders.map(p => (
                <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>
              ))}
            </select>
            <input
              type="password"
              placeholder="API key"
              value={newKeyValue}
              onChange={e => setNewKeyValue(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={newKeyLabel}
              onChange={e => setNewKeyLabel(e.target.value)}
              style={{ width: 180, padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <button
              onClick={handleAddKey}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                color: '#fff', background: '#0F9D8E', border: 'none', borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Store key
            </button>
          </div>
        </div>
      </div>

      {/* ── Save bar ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            color: '#fff', background: dirty && !saving ? '#0F9D8E' : '#9ca3af',
            border: 'none', borderRadius: 6,
            cursor: dirty && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Saving…' : 'Save configuration'}
        </button>
      </div>
    </div>
  );
}


function OACallSettings() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [outcomes,     setOutcomes]   = useState([]);
  const [editWindow,   setEditWindow] = useState(24);
  const [loading,      setLoading]    = useState(true);
  const [saving,       setSaving]     = useState(false);
  const [flash,        setFlash]      = useState(null);
  const [dirty,        setDirty]      = useState(false);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/org/call-settings`, { headers })
      .then(r => r.json())
      .then(res => {
        const s = res.settings || {};
        setOutcomes(s.outcomes || []);
        setEditWindow(typeof s.edit_window_hours === 'number' ? s.edit_window_hours : 24);
      })
      .catch(() => showFlash('error', 'Failed to load call settings'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const GROUP_LABELS = {
    connected:  'Connected',
    no_contact: 'No contact',
    blocker:    'Blocker',
  };

  // Mutators — each marks the form dirty so the Save button activates.
  const updateOutcome = (index, field, value) => {
    setOutcomes(prev => prev.map((o, i) => i === index ? { ...o, [field]: value } : o));
    setDirty(true);
  };

  const moveOutcome = (index, dir) => {
    setOutcomes(prev => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      // Renumber so display order matches the new array order.
      return next.map((o, i) => ({ ...o, order: i + 1 }));
    });
    setDirty(true);
  };

  const removeOutcome = (index) => {
    setOutcomes(prev => prev.filter((_, i) => i !== index).map((o, i) => ({ ...o, order: i + 1 })));
    setDirty(true);
  };

  const addOutcome = () => {
    const baseKey = `custom_${Date.now()}`;
    setOutcomes(prev => [
      ...prev,
      {
        key:   baseKey,
        label: 'New outcome',
        group: 'connected',
        order: prev.length + 1,
      },
    ]);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/org/call-settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          outcomes,
          edit_window_hours: Number(editWindow),
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Save failed');
      setOutcomes(res.settings.outcomes || outcomes);
      setEditWindow(res.settings.edit_window_hours);
      setDirty(false);
      showFlash('success', 'Call settings saved ✓');
    } catch (err) {
      showFlash('error', err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 20, color: '#6b7280' }}>Loading…</div>;

  return (
    <div style={{ marginTop: 8 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>📞 Call Settings</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Customize the outcomes that appear in the "Log call" form, and how long reps can edit their own call logs.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          style={{
            padding: '7px 18px',
            background: dirty && !saving ? '#0F9D8E' : '#e5e7eb',
            color: dirty && !saving ? '#fff' : '#9ca3af',
            border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600,
            cursor: dirty && !saving ? 'pointer' : 'not-allowed', flexShrink: 0,
          }}
        >
          {saving ? '⏳ Saving…' : '💾 Save'}
        </button>
      </div>

      {flash && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
          color:      flash.type === 'success' ? '#065f46' : '#991b1b',
          border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* Edit window */}
      <div style={{ marginBottom: 24, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
          Edit window (hours)
        </label>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          How long after logging a call can the rep edit their own entry. Set to 0 to disable edits entirely. Maximum 720 (one month).
        </div>
        <input
          type="number"
          min="0" max="720" step="1"
          value={editWindow}
          onChange={e => { setEditWindow(e.target.value); setDirty(true); }}
          style={{
            width: 140, padding: '6px 10px', fontSize: 13,
            border: '1px solid #d1d5db', borderRadius: 6,
          }}
        />
      </div>

      {/* Outcomes list */}
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: '#111827' }}>Outcomes</h4>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            The full list of outcomes available in the "Log call" form. Order here drives display order in the dropdown.
          </div>
        </div>
        <button
          onClick={addOutcome}
          style={{
            padding: '5px 12px', background: '#fff', color: '#0F9D8E',
            border: '1px solid #0F9D8E', borderRadius: 6, fontSize: 12, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          + Add outcome
        </button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{
          display: 'grid', gridTemplateColumns: '40px 1fr 2fr 1fr 90px',
          gap: 12, padding: '10px 14px', fontSize: 11, fontWeight: 600,
          color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4,
          background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
        }}>
          <div>Order</div>
          <div>Key</div>
          <div>Label</div>
          <div>Group</div>
          <div></div>
        </div>

        {outcomes.length === 0 && (
          <div style={{ padding: '20px 14px', color: '#9ca3af', fontStyle: 'italic', textAlign: 'center', fontSize: 13 }}>
            No outcomes configured. Add one to get started.
          </div>
        )}

        {outcomes.map((o, i) => (
          <div key={`${o.key}-${i}`} style={{
            display: 'grid', gridTemplateColumns: '40px 1fr 2fr 1fr 90px',
            gap: 12, padding: '10px 14px', alignItems: 'center', fontSize: 13,
            borderBottom: i < outcomes.length - 1 ? '1px solid #f3f4f6' : 'none',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button
                onClick={() => moveOutcome(i, -1)}
                disabled={i === 0}
                style={{ background: 'none', border: 'none', cursor: i === 0 ? 'not-allowed' : 'pointer', color: i === 0 ? '#d1d5db' : '#6b7280', fontSize: 10, padding: 0 }}
                title="Move up"
              >▲</button>
              <button
                onClick={() => moveOutcome(i, 1)}
                disabled={i === outcomes.length - 1}
                style={{ background: 'none', border: 'none', cursor: i === outcomes.length - 1 ? 'not-allowed' : 'pointer', color: i === outcomes.length - 1 ? '#d1d5db' : '#6b7280', fontSize: 10, padding: 0 }}
                title="Move down"
              >▼</button>
            </div>
            <input
              value={o.key}
              onChange={e => updateOutcome(i, 'key', e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              title="Stable identifier stored on call rows. Lowercase letters, digits, underscores only."
            />
            <input
              value={o.label}
              onChange={e => updateOutcome(i, 'label', e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12 }}
            />
            <select
              value={o.group}
              onChange={e => updateOutcome(i, 'group', e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 12, background: '#fff' }}
            >
              {Object.entries(GROUP_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <button
              onClick={() => removeOutcome(i)}
              style={{
                padding: '4px 8px', background: '#fff', color: '#991b1b',
                border: '1px solid #fecaca', borderRadius: 4, fontSize: 11, fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Remove outcome (only allowed if no calls reference it)"
            >Remove</button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
        Note: outcome keys are stable identifiers. You can rename labels freely, but you cannot remove an outcome key that's still referenced by past call logs.
      </div>
    </div>
  );
}

