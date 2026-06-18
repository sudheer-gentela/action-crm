import React, { useState, useEffect } from 'react';
import { hashSegment, writeHash } from './hashNav';
import { apiService } from './apiService';
import './OrgAdminView.css';
import DealHealthSettings from './DealHealthSettings';
import CustomFieldDefsEditor from './customfields/CustomFieldDefsEditor';
import OAStages from './OAStages';
import OAProducts from './OAProducts';
import OATeamDimensions from './OATeamDimensions';
import WorkflowCanvas from './WorkflowCanvas';
import ExecutionLog from './ExecutionLog';
import OAEmailSettings from './OAEmailSettings';
import OAMeetingSettings from './OAMeetingSettings';
import SalesforceConnect from './SalesforceConnect';
import HubSpotConnect    from './HubSpotConnect';
import OAAIProviderSettings from './OAAIProviderSettings';
import { TrackingDomainSettings } from './prospecting/TrackingSettings';   // Insights/WBR Phase 7

import {
  MODULE_NAV_DEFS, TAB_META, MODULE_COLORS, CALL_TYPE_LABELS,
} from './orgadmin/constants';
import { buildNavGroups, formatTokens, formatCost } from './orgadmin/helpers';
import { UsageBar, ToggleSwitch } from './orgadmin/shared';

import OAModules from './orgadmin/panels/OAModules';
import OAProspectingModule from './orgadmin/panels/OAProspectingModule';
import OACLMModule from './orgadmin/panels/OACLMModule';
import OAHandoverModule from './orgadmin/panels/OAHandoverModule';
import OAServiceModule from './orgadmin/panels/OAServiceModule';
import OAAgencyModule from './orgadmin/panels/OAAgencyModule';
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


// ── Org-wide campaign-delete switch ──────────────────────────────────────────
// "Campaign owners may delete their own campaigns." Reads/writes
// GET|PUT /prospecting-campaigns/org/delete-policy, persisted in
// org_action_config.campaign_settings.owner_delete_enabled. Admins/owners are
// never restricted by this switch — it gates campaign OWNERS only. Default ON.


// ── Org-wide "managers can edit subordinates' items" switch ──────────────────
// Reads/writes GET|PUT /prospecting-campaigns/org/manager-edit-policy, persisted
// in org_action_config.campaign_settings.manager_can_edit. Read by
// services/AccessPolicy.js. When OFF (default), managers are view-only on a
// subordinate's prospecting items unless the owner opts a specific item in.


// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// HANDOVER MODULE — General | Playbook
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// SERVICE MODULE — General | SLA Settings | Playbook
// Wraps the existing OAServiceGeneral + OAServiceSLATiers.
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// AGENCY MODULE SETTINGS TAB
// ─────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// MODULES TAB — enable/disable product modules per org
// ─────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// OAModules — enable/disable product modules + GoWarm sample playbook seeding
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────
// CLM TEMPLATES TAB
// Admins upload master DOCX templates per contract type.
// Users download, fill in Word, upload back as v1.0.
// ─────────────────────────────────────────────────────────────────


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


