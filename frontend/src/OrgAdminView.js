import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './OrgAdminView.css';
import DealHealthSettings from './DealHealthSettings';
import OAStages from './OAStages';
import PlaybookPlaysEditor from './PlaybookPlaysEditor';
import OAProducts from './OAProducts';
import OATeamDimensions from './OATeamDimensions';
import WorkflowCanvas from './WorkflowCanvas';
import ExecutionLog from './ExecutionLog';
import OAEmailSettings from './OAEmailSettings';
import OAMeetingSettings from './OAMeetingSettings';
import SalesforceConnect from './SalesforceConnect';

// ═══════════════════════════════════════════════════════════════════
// ORG ADMIN VIEW — per-organisation administration
// Accessible to org owners and admins only.
// The SettingsView handles AI/playbook/deal-health configuration —
// this view handles PEOPLE, ROLES, INVITATIONS, and ORG SETTINGS.
// ═══════════════════════════════════════════════════════════════════

// Static nav groups — Modules group is injected dynamically in OrgAdminView
// based on which modules are enabled for the org.
const STATIC_NAV_GROUPS = [
  {
    label: 'Team',
    items: [
      { id: 'members',         icon: '👥', label: 'Members' },
      { id: 'hierarchy',       icon: '🏢', label: 'Hierarchy' },
      { id: 'teams',           icon: '🏷️', label: 'Teams' },
      { id: 'invitations',     icon: '✉️', label: 'Invitations' },
      { id: 'team-dimensions', icon: '🏷️', label: 'Team Dimensions' },
    ],
  },
  {
    label: 'Sales Process',
    items: [
      { id: 'playbooks', icon: '📘', label: 'Playbooks' },
      { id: 'stages',    icon: '🏷️', label: 'Stages' },
      { id: 'org-roles', icon: '🎭', label: 'Org Roles' },
      { id: 'products',  icon: '📦', label: 'Products' },
    ],
  },
  {
    label: 'Sales Execution Insights',
    items: [
      { id: 'health',      icon: '🏥', label: 'Deal Health' },
      { id: 'icp-scoring',        icon: '🎯', label: 'ICP Scoring'        },
      { id: 'diagnostic-rules', icon: '⚙️',  label: 'Diagnostic Rules'  },
    ],
  },
  {
    label: 'Auto Action Execution',
    items: [
      { id: 'ai-agent',  icon: '🤖', label: 'AI Agent' },
      { id: 'action-ai', icon: '✨', label: 'Actions AI' },
      { id: 'ai-usage',  icon: '📊', label: 'AI Usage' },
    ],
  },
  {
    label: 'Data Quality',
    items: [
      { id: 'duplicates',     icon: '🔍', label: 'Duplicates'     },
      { id: 'workflows',      icon: '⚙️', label: 'Workflows'      },
      { id: 'email-settings', icon: '📧', label: 'Email Settings'  },
    ],
  },
  // 'Modules' group is injected here dynamically — see buildNavGroups()
  {
    label: 'General',
    items: [
      { id: 'integrations', icon: '🔌', label: 'Integrations' },
      { id: 'salesforce',   icon: '☁️', label: 'Salesforce' },
      { id: 'settings', icon: '⚙️', label: 'Org Settings' },
    ],
  },
];

// Module definitions — drives dynamic nav + per-module content routing
const MODULE_NAV_DEFS = [
  { moduleKey: 'prospecting', navId: 'mod-prospecting', icon: '🎯', label: 'Prospecting' },
  { moduleKey: 'contracts',   navId: 'mod-contracts',   icon: '📄', label: 'CLM' },
  { moduleKey: 'handovers',   navId: 'mod-handovers',   icon: '🤝', label: 'Handover S→I' },
  { moduleKey: 'service',     navId: 'mod-service',     icon: '🎧', label: 'Service' },
  { moduleKey: 'agency',      navId: 'mod-agency',      icon: '🏢', label: 'Agency' },
];

// Builds the full nav group list, inserting enabled module items before 'General'
function buildNavGroups(orgModules) {
  const enabledModuleItems = MODULE_NAV_DEFS
    .filter(m => orgModules[m.moduleKey])
    .map(m => ({ id: m.navId, icon: m.icon, label: m.label }));

  // 🧩 Modules is always present — it's the only way to re-enable a disabled module.
  // Enabled modules appear as sub-items below it.
  const moduleGroup = {
    label: 'Modules',
    items: [
      { id: 'modules', icon: '🧩', label: 'Modules' },
      ...enabledModuleItems,
    ],
  };

  const groups = [...STATIC_NAV_GROUPS];
  const generalIdx = groups.findIndex(g => g.label === 'General');
  groups.splice(generalIdx, 0, moduleGroup);
  return groups;
}

// Content descriptions for the top bar
const TAB_META = {
  members:       { title: 'Members',       desc: 'Manage team members, roles, and permissions' },
  hierarchy:     { title: 'Hierarchy',     desc: 'Reporting structure and team visibility' },
  teams:         { title: 'Teams',         desc: 'Organise users by market segment, role, product, geo, and motion' },
  invitations:   { title: 'Invitations',   desc: 'Invite new members to your organisation' },
  'team-dimensions': { title: 'Team Dimensions', desc: 'Configure the dimension vocabulary used for internal and customer-side teams' },
  playbooks:     { title: 'Playbooks',     desc: 'Configure deal playbooks and templates' },
  'stages':      { title: 'Stages',       desc: 'Customise your deal and prospecting pipeline stages' },
  'org-roles':   { title: 'Organization Roles', desc: 'Manage roles used across deals, prospecting, and all playbooks' },
  'products':    { title: 'Product Catalog', desc: 'Manage products and services available for deal line items' },
  health:        { title: 'Deal Health',   desc: 'Configure health scoring parameters' },
  'diagnostic-rules': { title: 'Diagnostic Rules', desc: 'Configure thresholds for nightly and real-time diagnostic alerts across all modules' },
  'icp-scoring': { title: 'ICP Scoring',   desc: 'Define your Ideal Customer Profile and scoring criteria' },
  duplicates:    { title: 'Duplicates',    desc: 'Duplicate detection rules and visibility' },
  'workflows':   { title: 'Workflows',       desc: 'Manage data-integrity workflows and standalone rules for deals, contacts, and accounts' },
  'email-settings': { title: 'Email Settings', desc: 'Configure which emails are synced and matched to deals, prospects, and accounts' },
  'wf-log':      { title: 'Execution Log', desc: 'Workflow execution history and open violations' },
  'ai-agent':    { title: 'AI Agent',      desc: 'Agentic framework settings and token usage' },
  modules:             { title: 'Modules',                           desc: 'Enable or disable product modules for your organisation' },
  'mod-prospecting':   { title: 'Prospecting',                       desc: 'Prospecting module settings' },
  'mod-contracts':     { title: 'Contract Lifecycle Management',      desc: 'CLM module settings — eSign configuration and contract templates' },
  'mod-handovers':     { title: 'Sales → Implementation Handover',   desc: 'Handover module settings' },
  'mod-service':       { title: 'Customer Support & Service',         desc: 'Service module settings — SLA tiers and general configuration' },
  'mod-agency':        { title: 'Agency Client Management',           desc: 'Agency module settings — client portal and team configuration' },
  integrations:  { title: 'Integrations',  desc: 'Manage org-wide email, calendar, and cloud connections' },
  'integrations-overview':{ title: 'Email & Calendar', desc: 'Manage Microsoft and Google connections for your team' },
  'integrations-meeting': { title: 'Meeting & Transcript Integrations', desc: 'Configure transcript providers — Zoom, Teams, Fireflies, and more' },
  salesforce:    { title: 'Salesforce Integration', desc: 'Sync contacts, accounts, deals, and leads with Salesforce. Configure stage/field mapping and write-back settings.' },
  settings:      { title: 'Org Settings',  desc: 'Organisation name, plan, and preferences' },

};


// ─────────────────────────────────────────────────────────────────────────────
// OATokenUsageModule — AI usage dashboard for Org Admin
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_COLORS = {
  deals:        '#6366f1',
  prospecting:  '#0F9D8E',
  other:        '#9ca3af',
};

const CALL_TYPE_LABELS = {
  action_generation:          'Action Generation',
  ai_enhancement:             'AI Enhancement',
  email_analysis:             'Email Analysis',
  deal_health_check:          'Deal Health Check',
  context_suggest:            'Context Suggest',
  agent_proposal:             'Agent Proposal',
  prospecting_research:       'Prospect Research',
  prospecting_research_account: 'Account Research',
  prospecting_draft:          'Draft Email',
};

function formatTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatCost(c) {
  if (!c || c === 0) return '$0.00';
  if (c < 0.01) return '<$0.01';
  return '$' + parseFloat(c).toFixed(2);
}

function UsageBar({ value, max, color = '#0F9D8E' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 6, overflow: 'hidden', flex: 1, minWidth: 60 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.4s' }} />
    </div>
  );
}

function OATokenUsageModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { Authorization: `Bearer ${token}` };

  const [days,    setDays]    = React.useState(30);
  const [data,    setData]    = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error,   setError]   = React.useState('');

  React.useEffect(() => {
    setLoading(true);
    fetch(`${API}/ai-usage/org?days=${days}`, { headers })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError('Failed to load usage data'); setLoading(false); });
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
  const [tab, setTab]               = useState('members');
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
            {tab === 'action-ai'        && <OAActionsAI />}
            {tab === 'duplicates'       && <OADuplicateSettings />}
            {tab === 'workflows'        && <OAWorkflows />}
            {tab === 'email-settings'   && <OAEmailSettings />}
            {tab === 'team-dimensions'  && <OATeamDimensions />}
            {(tab === 'integrations' || tab === 'integrations-overview') && <OAIntegrations orgId={orgId} />}
            {tab === 'salesforce'        && <OASalesforceSettings />}
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

const ROLE_META = {
  owner:  { label: 'Owner',  color: 'purple', icon: '👑', desc: 'Full control — org settings, billing, all data. Cannot be removed.' },
  admin:  { label: 'Admin',  color: 'blue',   icon: '🔑', desc: 'Manage members, invitations, integrations, and all CRM data.' },
  member: { label: 'Member', color: 'green',  icon: '👤', desc: 'Full CRM access — deals, contacts, emails, AI. Cannot manage users.' },
  viewer: { label: 'Viewer', color: 'grey',   icon: '👁',  desc: 'Read-only access to all CRM data. Cannot create or edit records.' },
};

// v2: Department options for CLM legal team routing
const DEPARTMENT_OPTIONS = [
  { value: '',                 label: '— No department —' },
  { value: 'sales',            label: 'Sales' },
  { value: 'legal',            label: 'Legal' },
  { value: 'implementation',   label: 'Implementation' },
  { value: 'customer_support', label: 'Customer Support' },
  { value: 'finance',          label: 'Finance' },
  { value: 'executive',        label: 'Executive' },
];

const DEPARTMENT_META = {
  sales:            { label: 'Sales',            color: '#2563eb' },
  legal:            { label: 'Legal',            color: '#7c3aed' },
  implementation:   { label: 'Implementation',   color: '#059669' },
  customer_support: { label: 'Customer Support', color: '#d97706' },
  finance:          { label: 'Finance',          color: '#dc2626' },
  executive:        { label: 'Executive',        color: '#0891b2' },
};

const CONTRACT_TYPE_LABELS = {
  nda:        'NDA',
  msa:        'MSA',
  sow:        'SOW',
  order_form: 'Order Form',
  amendment:  'Amendment',
};

function RoleBadge({ role }) {
  const m = ROLE_META[role] || { label: role, color: 'grey', icon: '•' };
  return (
    <span className={`oa-role-badge oa-role-badge--${m.color}`}>
      {m.icon} {m.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────
// MEMBERS TAB
// ─────────────────────────────────────────────────────────────────

function OAMembers({ currentUserId }) {
  const [members, setMembers]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [callerRole, setCallerRole]   = useState('member');
  const [editingDept, setEditingDept] = useState(null); // userId currently editing dept

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.orgAdmin.getMembers();
      setMembers(r.data.members);
      const me = r.data.members.find(m => m.user_id === currentUserId);
      if (me) setCallerRole(me.role);
    } catch { setError('Failed to load members'); }
    finally { setLoading(false); }
  }, [currentUserId]);

  useEffect(() => { load(); }, [load]);

  const handleRoleChange = async (userId, role) => {
    try {
      await apiService.orgAdmin.updateMember(userId, { role });
      setSuccess('Role updated');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update role');
    }
  };

  const handleDepartmentChange = async (userId, department) => {
    try {
      await apiService.orgAdmin.updateMember(userId, { department: department || null });
      setSuccess('Department updated');
      setTimeout(() => setSuccess(''), 2000);
      setEditingDept(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update department');
    }
  };

  const handleRemove = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from the organisation?`)) return;
    try {
      await apiService.orgAdmin.removeMember(userId);
      setSuccess(`${name} removed`);
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to remove member');
    }
  };

  const filtered = members.filter(m =>
    !search ||
    m.name?.toLowerCase().includes(search.toLowerCase()) ||
    m.email.toLowerCase().includes(search.toLowerCase()) ||
    m.department?.toLowerCase().includes(search.toLowerCase())
  );

  const isOwner = callerRole === 'owner';
  const canEditMembers = isOwner || callerRole === 'admin';

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>👥 Team Members</h2>
          <p className="sv-panel-desc">
            Manage who is in your organisation and what they can access.
            Set each member's <strong>department</strong> to enable team-based routing —
            members with the <strong>Legal</strong> department will receive contracts for review.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Role legend */}
        <div className="oa-role-legend">
          {Object.entries(ROLE_META).map(([key, m]) => (
            <div key={key} className="oa-role-card">
              <div className="oa-role-card-header">
                <span className={`oa-role-badge oa-role-badge--${m.color}`}>{m.icon} {m.label}</span>
              </div>
              <p className="sv-hint">{m.desc}</p>
            </div>
          ))}
        </div>

        {/* Department info */}
        <div style={{
          background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
          padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#166534',
        }}>
          <strong>🏢 Departments</strong> — Members with the <strong>Legal</strong> department
          will be added to the CLM legal team queue for contract review. Click a member's
          department badge to change it.
        </div>

        {/* Search */}
        <input
          className="oa-search"
          placeholder="Search members by name, email, or department…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {loading ? (
          <div className="sv-loading">Loading members…</div>
        ) : (
          <div className="oa-member-table">
            {filtered.length === 0 && <div className="sv-empty">No members found</div>}
            {filtered.map(m => {
              const isMe              = m.user_id === currentUserId;
              const canEdit           = !isMe && (isOwner || (callerRole === 'admin' && m.role !== 'owner'));
              const canChangeToOwner  = isOwner && !isMe;
              const deptMeta          = DEPARTMENT_META[m.department] || null;
              const isEditingThisDept = editingDept === m.user_id;

              return (
                <div key={m.user_id} className={`oa-member-row ${!m.is_active ? 'oa-member-row--inactive' : ''}`}>
                  <div className="oa-member-avatar">
                    {(m.name || m.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="oa-member-info">
                    <div className="oa-member-name">
                      {m.name || m.email}
                      {isMe && <span className="oa-you-tag">you</span>}
                      {m.department === 'legal' && (
                        <span style={{
                          marginLeft: 6, fontSize: 11, background: '#ede9fe',
                          color: '#7c3aed', borderRadius: 4, padding: '2px 6px', fontWeight: 600,
                        }}>⚖️ Legal Team</span>
                      )}
                    </div>
                    <div className="oa-member-email">{m.email}</div>
                    <div className="oa-member-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
                      <span>Joined {new Date(m.joined_at).toLocaleDateString()} · {m.action_count} actions</span>

                      {/* Department chip — click to edit */}
                      {isEditingThisDept && canEditMembers ? (
                        <select
                          style={{ fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid #d1d5db' }}
                          defaultValue={m.department || ''}
                          autoFocus
                          onChange={e => handleDepartmentChange(m.user_id, e.target.value)}
                          onBlur={() => setEditingDept(null)}
                        >
                          {DEPARTMENT_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span
                          onClick={() => canEditMembers && setEditingDept(m.user_id)}
                          style={{
                            fontSize: 11, borderRadius: 4, padding: '2px 8px',
                            background: deptMeta ? `${deptMeta.color}15` : '#f1f5f9',
                            color: deptMeta ? deptMeta.color : '#64748b',
                            border: `1px solid ${deptMeta ? `${deptMeta.color}40` : '#e2e8f0'}`,
                            fontWeight: 500,
                            cursor: canEditMembers ? 'pointer' : 'default',
                          }}
                          title={canEditMembers ? 'Click to change department' : undefined}
                        >
                          {deptMeta ? `🏢 ${deptMeta.label}` : '+ Set department'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="oa-member-role">
                    {canEdit ? (
                      <select
                        className="oa-role-select"
                        value={m.role}
                        onChange={e => handleRoleChange(m.user_id, e.target.value)}
                      >
                        {canChangeToOwner && <option value="owner">👑 Owner</option>}
                        <option value="admin">🔑 Admin</option>
                        <option value="member">👤 Member</option>
                        <option value="viewer">👁 Viewer</option>
                      </select>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </div>
                  <div className="oa-member-actions">
                    {canEdit && (
                      <button
                        className="oa-btn-remove"
                        onClick={() => handleRemove(m.user_id, m.name || m.email)}
                        title="Remove from org"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// HIERARCHY TAB — visual org tree with drag-drop & matrix reporting
// ─────────────────────────────────────────────────────────────────

const HIERARCHY_ROLES = [
  { value: 'vp',       label: 'VP',       color: '#7c3aed' },
  { value: 'director', label: 'Director', color: '#2563eb' },
  { value: 'manager',  label: 'Manager',  color: '#059669' },
  { value: 'rep',      label: 'Rep',      color: '#64748b' },
];

function HierarchyRoleBadge({ role }) {
  const r = HIERARCHY_ROLES.find(h => h.value === role) || { label: role || 'Rep', color: '#64748b' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: '12px',
      fontSize: '11px', fontWeight: 600, color: '#fff',
      background: r.color, letterSpacing: '0.02em',
    }}>
      {r.label}
    </span>
  );
}

function OAHierarchy() {
  const [tree, setTree]         = useState([]);
  const [members, setMembers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [editing, setEditing]   = useState(null);
  const [editForm, setEditForm] = useState({ reportsTo: '', hierarchyRole: 'rep', relationshipType: 'solid' });
  const [saving, setSaving]     = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [dragUserId, setDragUserId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [showDotted, setShowDotted] = useState(true);
  const [addingDotted, setAddingDotted] = useState(null); // userId to add dotted line to
  const [importing, setImporting]       = useState(false);
  const [importResult, setImportResult] = useState(null); // summary from last import

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [hierRes, membersRes] = await Promise.all([
        apiService.orgAdmin.getHierarchy(),
        apiService.orgAdmin.getMembers(),
      ]);
      setTree(hierRes.data.hierarchy || []);
      setMembers(membersRes.data.members || []);
    } catch { setError('Failed to load hierarchy'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCsvImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setError('');
    try {
      const res = await apiService.orgAdmin.importHierarchy(file);
      setImportResult(res.summary);
      if (res.summary.imported > 0) {
        setSuccess(`Imported ${res.summary.imported} row${res.summary.imported !== 1 ? 's' : ''} successfully`);
        load(); // refresh tree
      } else {
        setError('No rows were imported — check the warnings below');
      }
    } catch (err) {
      setError(err.message || 'CSV import failed');
    } finally {
      setImporting(false);
      e.target.value = ''; // reset so same file can be re-uploaded after a fix
    }
  };

  // ── Build tree from flat list ────────────────────────────
  const buildTreeNodes = (flatList, allMembers) => {
    // Separate solid and dotted relationships
    const solidRows = flatList.filter(r => r.relationship_type !== 'dotted');
    const dottedRows = flatList.filter(r => r.relationship_type === 'dotted');

    const map = {};
    const roots = [];

    // Create nodes from solid rows
    const solidUserIds = new Set();
    for (const node of solidRows) {
      solidUserIds.add(node.user_id);
      if (!map[node.user_id]) {
        map[node.user_id] = { ...node, children: [], dottedManagers: [], dottedReports: [] };
      } else {
        Object.assign(map[node.user_id], node);
      }
    }

    // Build parent-child from solid lines
    for (const node of solidRows) {
      if (node.reports_to && map[node.reports_to]) {
        map[node.reports_to].children.push(map[node.user_id]);
      } else {
        roots.push(map[node.user_id]);
      }
    }

    // Attach dotted-line metadata
    for (const d of dottedRows) {
      if (map[d.user_id]) {
        map[d.user_id].dottedManagers.push({
          managerId: d.reports_to,
          managerName: flatList.find(n => n.user_id === d.reports_to)
            ? `${flatList.find(n => n.user_id === d.reports_to).first_name || ''} ${flatList.find(n => n.user_id === d.reports_to).last_name || ''}`.trim()
            : `User #${d.reports_to}`,
        });
      }
      if (map[d.reports_to]) {
        map[d.reports_to].dottedReports.push({
          userId: d.user_id,
          userName: map[d.user_id]
            ? `${map[d.user_id].first_name || ''} ${map[d.user_id].last_name || ''}`.trim()
            : `User #${d.user_id}`,
        });
      }
    }

    const inHierarchy = solidUserIds;
    const unassigned = allMembers.filter(m => !inHierarchy.has(m.user_id) && m.is_active);

    return { roots, unassigned, map, dottedRows };
  };

  const { roots, unassigned, map: nodeMap, dottedRows } = buildTreeNodes(tree, members);

  const toggleCollapse = (userId) => setCollapsed(p => ({ ...p, [userId]: !p[userId] }));

  // ── Editing ────────────────────────────────────────────────
  const startEdit = (node) => {
    setEditing(node.user_id);
    setEditForm({
      reportsTo: node.reports_to || '',
      hierarchyRole: node.hierarchy_role || 'rep',
      relationshipType: 'solid',
    });
  };
  const cancelEdit = () => { setEditing(null); setAddingDotted(null); };

  const saveEdit = async (userId) => {
    try {
      setSaving(true);
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: editForm.reportsTo ? parseInt(editForm.reportsTo) : null,
        hierarchyRole: editForm.hierarchyRole,
        relationshipType: editForm.relationshipType || 'solid',
      });
      setSuccess('Hierarchy updated');
      setTimeout(() => setSuccess(''), 2500);
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update');
      setTimeout(() => setError(''), 3000);
    } finally { setSaving(false); }
  };

  const addToHierarchy = async (userId) => {
    try {
      await apiService.orgAdmin.updateHierarchy(userId, { reportsTo: null, hierarchyRole: 'rep' });
      setSuccess('Added to hierarchy');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError(err.response?.data?.error?.message || 'Failed to add'); }
  };

  const removeFromHierarchy = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from the hierarchy? Their direct reports will be re-parented.`)) return;
    try {
      await apiService.orgAdmin.removeFromHierarchy(userId);
      setSuccess('Removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError(err.response?.data?.error?.message || 'Failed to remove'); }
  };

  // ── Dotted line management ────────────────────────────────
  const saveDottedLine = async (userId) => {
    if (!editForm.reportsTo) return;
    try {
      setSaving(true);
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: parseInt(editForm.reportsTo),
        hierarchyRole: editForm.hierarchyRole,
        relationshipType: 'dotted',
      });
      setSuccess('Dotted line added');
      setTimeout(() => setSuccess(''), 2000);
      setAddingDotted(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to add dotted line');
      setTimeout(() => setError(''), 3000);
    } finally { setSaving(false); }
  };

  const removeDottedLine = async (userId, managerId) => {
    try {
      await apiService.orgAdmin.removeDottedLine(userId, managerId);
      setSuccess('Dotted line removed');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError('Failed to remove dotted line'); }
  };

  // ── Drag & Drop ────────────────────────────────────────────
  const handleDragStart = (e, userId) => {
    setDragUserId(userId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(userId));
  };

  const handleDragOver = (e, targetUserId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (targetUserId !== dragUserId) {
      setDropTarget(targetUserId);
    }
  };

  const handleDragLeave = () => setDropTarget(null);

  const handleDrop = async (e, newManagerId) => {
    e.preventDefault();
    setDropTarget(null);
    const userId = parseInt(e.dataTransfer.getData('text/plain'));
    if (!userId || userId === newManagerId) return;

    try {
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: newManagerId || null,
        hierarchyRole: nodeMap[userId]?.hierarchy_role || 'rep',
        relationshipType: 'solid',
      });
      setSuccess('Moved successfully');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to move');
      setTimeout(() => setError(''), 3000);
    }
    setDragUserId(null);
  };

  const handleDropToRoot = async (e) => {
    e.preventDefault();
    setDropTarget(null);
    const userId = parseInt(e.dataTransfer.getData('text/plain'));
    if (!userId) return;
    try {
      await apiService.orgAdmin.updateHierarchy(userId, {
        reportsTo: null,
        hierarchyRole: nodeMap[userId]?.hierarchy_role || 'rep',
        relationshipType: 'solid',
      });
      setSuccess('Moved to top level');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (err) { setError(err.response?.data?.error?.message || 'Move failed'); }
    setDragUserId(null);
  };

  // Available managers for dropdowns
  const solidNodes = tree.filter(r => r.relationship_type !== 'dotted');
  const availableManagers = solidNodes.filter(n => n.user_id !== editing && n.user_id !== addingDotted);

  // ── Connector styles ────────────────────────────────────────
  const connectorStyle = (depth) => ({
    position: 'relative',
    marginLeft: depth > 0 ? 28 : 0,
    paddingLeft: depth > 0 ? 20 : 0,
    borderLeft: depth > 0 ? '2px solid #c7d2fe' : 'none',
  });

  // ── Render a tree node ─────────────────────────────────────
  const renderNode = (node, depth = 0) => {
    const isEditing = editing === node.user_id;
    const isAddingDotted = addingDotted === node.user_id;
    const isCollapsed = collapsed[node.user_id];
    const hasChildren = node.children?.length > 0;
    const isDragOver = dropTarget === node.user_id;
    const name = `${node.first_name || ''} ${node.last_name || ''}`.trim() || node.email;

    return (
      <div key={node.user_id} style={connectorStyle(depth)}>
        {/* Horizontal connector tick */}
        {depth > 0 && <div style={{
          position: 'absolute', left: '-2px', top: '22px',
          width: '20px', height: '0', borderTop: '2px solid #c7d2fe',
        }} />}

        {/* Node card */}
        <div
          draggable
          onDragStart={(e) => handleDragStart(e, node.user_id)}
          onDragOver={(e) => handleDragOver(e, node.user_id)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, node.user_id)}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 14px', margin: '3px 0', borderRadius: '10px',
            background: isDragOver ? '#e0e7ff' : isEditing ? '#f0f0ff' : '#fff',
            border: isDragOver ? '2px dashed #818cf8' : isEditing ? '1.5px solid #818cf8' : '1px solid #e8e9ee',
            cursor: 'grab', transition: 'all 0.15s',
            boxShadow: isDragOver ? '0 0 0 3px rgba(99,102,241,0.15)' : 'none',
          }}
        >
          {/* Expand/collapse */}
          <button
            onClick={(e) => { e.stopPropagation(); hasChildren && toggleCollapse(node.user_id); }}
            style={{
              width: '22px', height: '22px', border: 'none', background: hasChildren ? '#f0f0ff' : 'none',
              borderRadius: '4px', cursor: hasChildren ? 'pointer' : 'default',
              fontSize: '11px', color: hasChildren ? '#4338ca' : '#d1d5db', fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {hasChildren ? (isCollapsed ? '▸' : '▾') : '·'}
          </button>

          {/* Avatar */}
          <div style={{
            width: '34px', height: '34px', borderRadius: '50%',
            background: depth === 0 ? '#ddd6fe' : '#e0e7ff',
            color: depth === 0 ? '#5b21b6' : '#4338ca', fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', flexShrink: 0,
          }}>
            {(node.first_name?.[0] || '?').toUpperCase()}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '13px', color: '#1a1a2e', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {name}
              {/* Dotted-line indicators */}
              {showDotted && node.dottedManagers?.length > 0 && (
                <span title={`Dotted to: ${node.dottedManagers.map(d => d.managerName).join(', ')}`}
                  style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#fef3c7', color: '#92400e', border: '1px dashed #f59e0b' }}>
                  ⤴ {node.dottedManagers.length} dotted
                </span>
              )}
              {showDotted && node.dottedReports?.length > 0 && (
                <span title={`Dotted reports: ${node.dottedReports.map(d => d.userName).join(', ')}`}
                  style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', background: '#ecfdf5', color: '#065f46', border: '1px dashed #10b981' }}>
                  ⤵ {node.dottedReports.length} matrix
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>{node.email}</div>
          </div>

          <HierarchyRoleBadge role={node.hierarchy_role} />

          {node.org_role && (
            <span style={{ fontSize: '10px', color: '#94a3b8', padding: '2px 6px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
              {node.org_role}
            </span>
          )}

          {hasChildren && (
            <span style={{ fontSize: '11px', color: '#6366f1', fontWeight: 500 }}>
              {node.children.length} report{node.children.length !== 1 ? 's' : ''}
            </span>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={(e) => { e.stopPropagation(); isEditing ? cancelEdit() : startEdit(node); }}
              style={{ padding: '4px 10px', fontSize: '11px', borderRadius: '6px', border: '1px solid #e2e4ea', background: '#fff', cursor: 'pointer', color: '#4b5563' }}>
              {isEditing ? 'Cancel' : '✎'}
            </button>
            <button onClick={(e) => { e.stopPropagation(); setAddingDotted(addingDotted === node.user_id ? null : node.user_id); setEditing(null); }}
              title="Add dotted line"
              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '6px', border: '1px dashed #f59e0b', background: addingDotted === node.user_id ? '#fef3c7' : '#fff', cursor: 'pointer', color: '#92400e' }}>
              ⤴
            </button>
            <button onClick={(e) => { e.stopPropagation(); removeFromHierarchy(node.user_id, name); }}
              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '6px', border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', color: '#dc2626' }}>
              ✕
            </button>
          </div>
        </div>

        {/* Solid edit form */}
        {isEditing && (
          <div style={{
            marginLeft: '48px', padding: '12px 16px', margin: '4px 0 8px',
            background: '#f8f7ff', borderRadius: '8px', border: '1px solid #e0e7ff',
            display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '4px' }}>Reports To (Solid Line)</label>
              <select value={editForm.reportsTo} onChange={e => setEditForm(p => ({ ...p, reportsTo: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}>
                <option value="">— None (top of tree) —</option>
                {availableManagers.map(m => (
                  <option key={m.user_id} value={m.user_id}>{m.first_name} {m.last_name} ({m.email})</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '4px' }}>Role</label>
              <select value={editForm.hierarchyRole} onChange={e => setEditForm(p => ({ ...p, hierarchyRole: e.target.value }))}
                style={{ padding: '7px 10px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px' }}>
                {HIERARCHY_ROLES.map(r => (<option key={r.value} value={r.value}>{r.label}</option>))}
              </select>
            </div>
            <button onClick={() => saveEdit(node.user_id)} disabled={saving}
              style={{ padding: '7px 18px', fontSize: '13px', borderRadius: '6px', border: 'none', background: '#4f46e5', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontWeight: 600 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}

        {/* Dotted-line add form */}
        {isAddingDotted && (
          <div style={{
            marginLeft: '48px', padding: '12px 16px', margin: '4px 0 8px',
            background: '#fffbeb', borderRadius: '8px', border: '1px dashed #f59e0b',
            display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#92400e', display: 'block', marginBottom: '4px' }}>
                Add Dotted-Line Manager
              </label>
              <select value={editForm.reportsTo} onChange={e => setEditForm(p => ({ ...p, reportsTo: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px' }}>
                <option value="">— Select manager —</option>
                {availableManagers.filter(m => m.user_id !== node.reports_to).map(m => (
                  <option key={m.user_id} value={m.user_id}>{m.first_name} {m.last_name} ({m.email})</option>
                ))}
              </select>
            </div>
            <button onClick={() => saveDottedLine(node.user_id)} disabled={saving || !editForm.reportsTo}
              style={{ padding: '7px 18px', fontSize: '13px', borderRadius: '6px', border: 'none', background: '#f59e0b', color: '#fff', cursor: (saving || !editForm.reportsTo) ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: editForm.reportsTo ? 1 : 0.5 }}>
              {saving ? 'Adding…' : 'Add Dotted Line'}
            </button>
            <button onClick={() => setAddingDotted(null)}
              style={{ padding: '7px 14px', fontSize: '13px', borderRadius: '6px', border: '1px solid #e2e4ea', background: '#fff', cursor: 'pointer', color: '#6b7280' }}>
              Cancel
            </button>
          </div>
        )}

        {/* Dotted-line list for this node */}
        {showDotted && node.dottedManagers?.length > 0 && (
          <div style={{ marginLeft: '56px', marginBottom: '4px' }}>
            {node.dottedManagers.map(d => (
              <div key={d.managerId} style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '3px 10px', margin: '2px 4px 2px 0', borderRadius: '14px',
                border: '1px dashed #f59e0b', background: '#fffbeb', fontSize: '11px', color: '#92400e',
              }}>
                <span style={{ borderBottom: '1px dashed #f59e0b' }}>⤴ {d.managerName}</span>
                <button onClick={() => removeDottedLine(node.user_id, d.managerId)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: '11px', padding: '0 2px' }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Children */}
        {!isCollapsed && node.children?.map(child => renderNode(child, depth + 1))}
      </div>
    );
  };

  if (loading) return <div className="oa-loading">Loading hierarchy…</div>;

  return (
    <div>
      {error && <div className="oa-error-banner">{error}</div>}
      {success && <div className="oa-success-banner">{success}</div>}

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">In Hierarchy</div>
          <div className="oa-stat-card-value" style={{ color: '#4338ca' }}>{new Set(tree.filter(r => r.relationship_type !== 'dotted').map(r => r.user_id)).size}</div>
        </div>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">Top-Level</div>
          <div className="oa-stat-card-value" style={{ color: '#059669' }}>{roots.length}</div>
        </div>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">Dotted Lines</div>
          <div className="oa-stat-card-value" style={{ color: '#d97706' }}>{dottedRows.length}</div>
        </div>
        <div className="oa-stat-card" style={{ flex: '1 1 120px' }}>
          <div className="oa-stat-card-label">Unassigned</div>
          <div className="oa-stat-card-value" style={{ color: '#94a3b8' }}>{unassigned.length}</div>
        </div>
      </div>

      {/* Info + controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px',
        padding: '14px 18px', borderRadius: '10px', marginBottom: '20px',
        background: '#f0f0ff', border: '1px solid #e0e7ff', fontSize: '13px', color: '#4338ca',
      }}>
        <div>
          <strong>Drag & drop</strong> cards to reassign reporting lines. Use <strong>⤴</strong> to add dotted (matrix) lines.
          Hierarchy controls data visibility; admin access is still via org roles.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
            <input type="checkbox" checked={showDotted} onChange={e => setShowDotted(e.target.checked)}
              style={{ accentColor: '#f59e0b' }} />
            Show dotted lines
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
            <input
              type="file"
              accept=".csv"
              style={{ display: 'none' }}
              onChange={handleCsvImport}
              disabled={importing}
            />
            <button
              style={{
                fontSize: '12px', fontWeight: 600, padding: '5px 12px',
                borderRadius: '6px', border: '1px solid #c7d2fe', cursor: importing ? 'wait' : 'pointer',
                background: '#eef2ff', color: '#4338ca',
                opacity: importing ? 0.6 : 1,
              }}
              onClick={e => e.currentTarget.previousSibling.click()}
              disabled={importing}
              title="Upload a CSV with columns: email, manager_email, hierarchy_role, team_name"
            >
              {importing ? '⏳ Importing…' : '⬆ Import CSV'}
            </button>
          </label>
        </div>
      </div>

      {/* CSV import result summary */}
      {importResult && (
        <div style={{
          background: importResult.imported > 0 ? '#f0fdf4' : '#fffbeb',
          border: `1px solid ${importResult.imported > 0 ? '#bbf7d0' : '#fde68a'}`,
          borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', fontSize: '13px',
        }}>
          <div style={{ fontWeight: 600, marginBottom: importResult.errors.length > 0 ? 6 : 0 }}>
            Import complete — {importResult.imported} imported, {importResult.skipped} skipped
            {importResult.teams > 0 && `, ${importResult.teams} team${importResult.teams !== 1 ? 's' : ''} updated`}
          </div>
          {importResult.errors.length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', color: '#b45309', fontSize: '12px' }}>
                {importResult.errors.length} warning{importResult.errors.length !== 1 ? 's' : ''}
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: '20px', color: '#92400e', fontSize: '12px' }}>
                {importResult.errors.map((msg, i) => <li key={i}>{msg}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Drop zone: root level */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDropTarget('root'); }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={handleDropToRoot}
        style={{
          padding: dropTarget === 'root' ? '12px' : '0',
          marginBottom: '8px', borderRadius: '8px',
          border: dropTarget === 'root' ? '2px dashed #818cf8' : 'none',
          background: dropTarget === 'root' ? '#eef2ff' : 'transparent',
          textAlign: 'center', fontSize: '12px', color: '#6366f1',
          transition: 'all 0.15s', minHeight: dropTarget === 'root' ? '40px' : '0',
        }}
      >
        {dropTarget === 'root' && 'Drop here to make top-level'}
      </div>

      {/* Tree */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', color: '#1a1a2e' }}>
          Reporting Structure
        </h3>
        {roots.length === 0 && tree.length === 0 ? (
          <div style={{
            padding: '40px 20px', textAlign: 'center', color: '#9ca3af',
            border: '2px dashed #e8e9ee', borderRadius: '12px',
          }}>
            <p style={{ fontSize: '15px', fontWeight: 500 }}>No hierarchy set up yet</p>
            <p style={{ fontSize: '13px', marginTop: '6px' }}>
              Add members from the list below, drag to arrange, or use <strong>⬆ Import CSV</strong> to bulk-load from a spreadsheet.
            </p>
          </div>
        ) : (
          roots.map(root => renderNode(root, 0))
        )}
      </div>

      {/* Unassigned */}
      {unassigned.length > 0 && (
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', color: '#1a1a2e' }}>
            Members Not in Hierarchy ({unassigned.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {unassigned.map(m => (
              <div key={m.user_id}
                draggable
                onDragStart={(e) => handleDragStart(e, m.user_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '10px 14px', borderRadius: '10px',
                  background: '#fff', border: '1px solid #e8e9ee', cursor: 'grab',
                }}>
                <div style={{
                  width: '32px', height: '32px', borderRadius: '50%',
                  background: '#fef3c7', color: '#92400e', fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '13px', flexShrink: 0,
                }}>
                  {(m.name?.[0] || m.email?.[0] || '?').toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{m.name || m.email}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af' }}>{m.email}</div>
                </div>
                <span style={{ fontSize: '10px', color: '#94a3b8', padding: '2px 6px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
                  {m.role}
                </span>
                <button onClick={() => addToHierarchy(m.user_id)}
                  style={{
                    padding: '5px 14px', fontSize: '12px', borderRadius: '6px',
                    border: '1px solid #c7d2fe', background: '#eef2ff',
                    cursor: 'pointer', color: '#4338ca', fontWeight: 600,
                  }}>
                  + Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// TEAMS TAB
// Multi-dimensional team management: dimensions config, team CRUD,
// and user assignment grid.
// ─────────────────────────────────────────────────────────────────

const DIMENSION_COLORS = {
  market_segment: '#7c3aed',
  seller_role:    '#2563eb',
  product_line:   '#059669',
  geo:            '#d97706',
  motion:         '#dc2626',
};

function getDimColor(key) {
  return DIMENSION_COLORS[key] || '#6b7280';
}

// ─────────────────────────────────────────────────────────────────
// OATeamRoster — read-only view of user assignments across dimensions
// Filterable by dimension and team, with search and summary stats.
// ─────────────────────────────────────────────────────────────────

function OATeamRoster({ dimensions, teams, members, memberships, rosterDimFilter, setRosterDimFilter, rosterTeamFilter, setRosterTeamFilter, rosterSearch, setRosterSearch, getDimColor }) {

  // Build user → dimension → team mapping
  const userTeamMap = {};
  for (const m of memberships) {
    if (!userTeamMap[m.user_id]) userTeamMap[m.user_id] = {};
    userTeamMap[m.user_id][m.dimension] = { teamId: m.team_id, teamName: m.team_name };
  }

  // Compute assignment coverage stats
  const assignedUserIds = new Set(memberships.map(m => m.user_id));
  const fullyAssigned = members.filter(m => {
    const ut = userTeamMap[m.user_id];
    return ut && dimensions.every(d => ut[d.key]);
  });
  const partiallyAssigned = members.filter(m => {
    const ut = userTeamMap[m.user_id];
    return ut && Object.keys(ut).length > 0 && !dimensions.every(d => ut[d.key]);
  });
  const unassigned = members.filter(m => !assignedUserIds.has(m.user_id));

  // Filter members
  const filteredMembers = members.filter(m => {
    // Search filter
    if (rosterSearch) {
      const q = rosterSearch.toLowerCase();
      const name = `${m.first_name} ${m.last_name}`.toLowerCase();
      const email = (m.email || '').toLowerCase();
      if (!name.includes(q) && !email.includes(q)) return false;
    }

    const ut = userTeamMap[m.user_id] || {};

    // Dimension filter
    if (rosterDimFilter === 'unassigned') {
      return Object.keys(ut).length === 0;
    }
    if (rosterDimFilter === 'partial') {
      return Object.keys(ut).length > 0 && !dimensions.every(d => ut[d.key]);
    }
    if (rosterDimFilter === 'complete') {
      return dimensions.every(d => ut[d.key]);
    }
    if (rosterDimFilter !== 'all') {
      // A specific dimension key — show users who have an assignment in that dimension
      if (!ut[rosterDimFilter]) return false;
    }

    // Team filter (only when a specific dimension is selected)
    if (rosterTeamFilter !== 'all' && rosterDimFilter !== 'all' &&
        rosterDimFilter !== 'unassigned' && rosterDimFilter !== 'partial' && rosterDimFilter !== 'complete') {
      if (ut[rosterDimFilter]?.teamId !== parseInt(rosterTeamFilter)) return false;
    }

    return true;
  });

  // Reset team filter when dimension filter changes
  const handleDimFilterChange = (val) => {
    setRosterDimFilter(val);
    setRosterTeamFilter('all');
  };

  // Teams for the selected dimension filter
  const filteredDimTeams = (rosterDimFilter !== 'all' && rosterDimFilter !== 'unassigned' &&
    rosterDimFilter !== 'partial' && rosterDimFilter !== 'complete')
    ? teams.filter(t => t.dimension === rosterDimFilter)
    : [];

  // CSV export
  const handleExport = () => {
    const header = ['Name', 'Email', ...dimensions.map(d => d.label)];
    const rows = filteredMembers.map(m => {
      const ut = userTeamMap[m.user_id] || {};
      return [
        `${m.first_name} ${m.last_name}`,
        m.email,
        ...dimensions.map(d => ut[d.key]?.teamName || ''),
      ];
    });
    const csv = [header, ...rows].map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `team-roster-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* Coverage summary cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <button onClick={() => handleDimFilterChange('all')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'all' ? '2px solid #111827' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>All Users</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{members.length}</div>
        </button>
        <button onClick={() => handleDimFilterChange('complete')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'complete' ? '2px solid #059669' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#059669', textTransform: 'uppercase', letterSpacing: 0.5 }}>Fully Assigned</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#059669' }}>{fullyAssigned.length}</div>
        </button>
        <button onClick={() => handleDimFilterChange('partial')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'partial' ? '2px solid #d97706' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#d97706', textTransform: 'uppercase', letterSpacing: 0.5 }}>Partially Assigned</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#d97706' }}>{partiallyAssigned.length}</div>
        </button>
        <button onClick={() => handleDimFilterChange('unassigned')} style={{
          flex: '1 1 100px', padding: '12px 16px', borderRadius: 8, border: rosterDimFilter === 'unassigned' ? '2px solid #dc2626' : '1px solid #e5e7eb',
          background: '#fff', cursor: 'pointer', textAlign: 'left', minWidth: 100,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#dc2626', textTransform: 'uppercase', letterSpacing: 0.5 }}>Unassigned</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#dc2626' }}>{unassigned.length}</div>
        </button>
      </div>

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={rosterSearch}
          onChange={e => setRosterSearch(e.target.value)}
          placeholder="Search by name or email…"
          style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12, width: 220 }}
        />
        <select
          value={rosterDimFilter}
          onChange={e => handleDimFilterChange(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
        >
          <option value="all">All dimensions</option>
          <optgroup label="Status">
            <option value="complete">Fully assigned</option>
            <option value="partial">Partially assigned</option>
            <option value="unassigned">Unassigned</option>
          </optgroup>
          <optgroup label="By Dimension">
            {dimensions.map(d => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </optgroup>
        </select>
        {filteredDimTeams.length > 0 && (
          <select
            value={rosterTeamFilter}
            onChange={e => setRosterTeamFilter(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
          >
            <option value="all">All teams</option>
            {filteredDimTeams.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#6b7280' }}>{filteredMembers.length} user{filteredMembers.length !== 1 ? 's' : ''}</span>
        <button
          onClick={handleExport}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500,
            background: '#f3f4f6', border: '1px solid #d1d5db', cursor: 'pointer', color: '#374151',
          }}
        >
          Export CSV
        </button>
      </div>

      {/* Roster table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#374151', minWidth: 180 }}>User</th>
              {dimensions.map(dim => (
                <th key={dim.key} style={{
                  textAlign: 'left', padding: '8px 12px', fontWeight: 600, minWidth: 120,
                  color: getDimColor(dim.key),
                }}>
                  {dim.label}
                </th>
              ))}
              <th style={{ textAlign: 'center', padding: '8px 12px', fontWeight: 600, color: '#374151', width: 80 }}>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {filteredMembers.map(member => {
              const ut = userTeamMap[member.user_id] || {};
              const assignedCount = dimensions.filter(d => ut[d.key]).length;
              const coveragePct = dimensions.length > 0 ? Math.round((assignedCount / dimensions.length) * 100) : 0;
              return (
                <tr key={member.user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ fontWeight: 500, color: '#111827' }}>{member.first_name} {member.last_name}</div>
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>{member.email}</div>
                  </td>
                  {dimensions.map(dim => {
                    const assignment = ut[dim.key];
                    return (
                      <td key={dim.key} style={{ padding: '6px 12px' }}>
                        {assignment ? (
                          <span style={{
                            padding: '3px 10px', borderRadius: 4, fontSize: 11, fontWeight: 500,
                            background: getDimColor(dim.key) + '10', color: getDimColor(dim.key),
                            border: `1px solid ${getDimColor(dim.key)}25`,
                          }}>
                            {assignment.teamName}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: 'center', padding: '6px 12px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}>
                      <div style={{
                        width: 40, height: 6, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${coveragePct}%`, height: '100%', borderRadius: 3,
                          background: coveragePct === 100 ? '#059669' : coveragePct > 0 ? '#d97706' : '#dc2626',
                        }} />
                      </div>
                      <span style={{
                        fontSize: 10, fontWeight: 600, minWidth: 26,
                        color: coveragePct === 100 ? '#059669' : coveragePct > 0 ? '#d97706' : '#dc2626',
                      }}>
                        {assignedCount}/{dimensions.length}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredMembers.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
          No users match the current filters.
        </div>
      )}
    </div>
  );
}


function OATeams() {
  const [dimensions, setDimensions]   = useState([]);
  const [teams, setTeams]             = useState([]);
  const [members, setMembers]         = useState([]);
  const [memberships, setMemberships] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [activeDim, setActiveDim]     = useState(null);
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeamLines, setNewTeamLines] = useState('');
  const [saving, setSaving]           = useState(false);
  const [showDimConfig, setShowDimConfig] = useState(false);
  const [dimDraft, setDimDraft]       = useState([]);
  const [assigningUser, setAssigningUser] = useState(null);
  const [subTab, setSubTab] = useState('setup'); // 'setup' | 'roster'
  const [rosterDimFilter, setRosterDimFilter] = useState('all');
  const [rosterTeamFilter, setRosterTeamFilter] = useState('all');
  const [rosterSearch, setRosterSearch] = useState('');

  const load = async () => {
    try {
      setLoading(true);
      const [dimRes, teamsRes, membersRes, membershipRes] = await Promise.all([
        apiService.orgAdmin.getTeamDimensions(),
        apiService.orgAdmin.getTeams(),
        apiService.orgAdmin.getMembers(),
        apiService.orgAdmin.getTeamMemberships(),
      ]);
      const dims = dimRes.data.dimensions || [];
      setDimensions(dims);
      setTeams(teamsRes.data.teams || []);
      setMembers(membersRes.data.members || []);
      setMemberships(membershipRes.data.memberships || []);
      // Set active dimension if none selected or current one no longer exists
      setActiveDim(prev => {
        if (!prev || !dims.find(d => d.key === prev)) {
          return dims.length > 0 ? dims[0].key : null;
        }
        return prev;
      });
    } catch (err) {
      setError('Failed to load teams data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  // ── Team CRUD ─────────────────────────────────────────────────

  const handleCreateTeams = async () => {
    if (!activeDim) return;
    const names = newTeamLines
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (names.length === 0) return;

    // Deduplicate input and skip names that already exist
    const uniqueNames = [...new Set(names)];
    const existingNames = new Set(activeTeams.map(t => t.name.toLowerCase()));
    const toCreate = uniqueNames.filter(n => !existingNames.has(n.toLowerCase()));

    if (toCreate.length === 0) {
      setError('All entered team names already exist in this dimension');
      return;
    }

    setSaving(true);
    setError('');
    const created = [];
    const failed = [];
    for (const name of toCreate) {
      try {
        await apiService.orgAdmin.createTeam({
          name,
          dimension: activeDim,
        });
        created.push(name);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        failed.push(`${name}: ${msg}`);
      }
    }

    if (created.length > 0) {
      flash(`Created ${created.length} team${created.length > 1 ? 's' : ''}`);
    }
    if (failed.length > 0) {
      setError(`Failed to create: ${failed.join('; ')}`);
    }

    setNewTeamLines('');
    setShowNewTeam(false);
    await load();
    setSaving(false);
  };

  const handleDeleteTeam = async (team) => {
    if (!window.confirm(`Delete "${team.name}"? All memberships will be removed.`)) return;
    try {
      await apiService.orgAdmin.deleteTeam(team.id);
      flash(`Team "${team.name}" deleted`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  // ── Dimension config ──────────────────────────────────────────

  const openDimConfig = () => {
    setDimDraft(JSON.parse(JSON.stringify(dimensions)));
    setShowDimConfig(true);
  };

  const addDimension = () => {
    setDimDraft([...dimDraft, { key: '', label: '', required: false, description: '' }]);
  };

  const removeDimension = (idx) => {
    setDimDraft(dimDraft.filter((_, i) => i !== idx));
  };

  const updateDimDraft = (idx, field, value) => {
    const updated = [...dimDraft];
    updated[idx] = { ...updated[idx], [field]: value };
    // Always auto-generate key from label
    if (field === 'label') {
      updated[idx].key = value.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
    }
    setDimDraft(updated);
  };

  const saveDimConfig = async () => {
    // Filter out any dimensions with empty key or label
    const validDims = dimDraft.filter(d => d.key && d.key.trim() && d.label && d.label.trim());
    if (validDims.length === 0) {
      setError('At least one dimension with a name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiService.orgAdmin.updateTeamDimensions(validDims);
      flash('Dimensions updated');
      setShowDimConfig(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save dimensions');
    } finally {
      setSaving(false);
    }
  };

  // ── Membership assignment ─────────────────────────────────────

  const handleAssign = async (userId, teamId) => {
    try {
      await apiService.orgAdmin.setTeamMembership(userId, teamId);
      flash('Assignment updated');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  const handleRemoveMembership = async (userId, teamId) => {
    try {
      await apiService.orgAdmin.removeTeamMembership(userId, teamId);
      flash('Assignment removed');
      await load();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message);
    }
  };

  // ── Derived data ──────────────────────────────────────────────

  const activeTeams = teams.filter(t => t.dimension === activeDim);
  const activeDimLabel = dimensions.find(d => d.key === activeDim)?.label || activeDim;

  // Build user → team mapping per dimension
  const userTeamMap = {};
  for (const m of memberships) {
    if (!userTeamMap[m.user_id]) userTeamMap[m.user_id] = {};
    userTeamMap[m.user_id][m.dimension] = { teamId: m.team_id, teamName: m.team_name };
  }

  const activeMembers = (members || []).filter(m => m.is_active);

  if (loading) return <div className="oa-loading">Loading teams…</div>;

  return (
    <div>
      {error && <div className="oa-error">{error} <button onClick={() => setError('')}>×</button></div>}
      {success && <div className="oa-success">{success}</div>}

      {/* Sub-tab switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb', paddingBottom: 0 }}>
        {[
          { id: 'setup', label: 'Setup', icon: '⚙️' },
          { id: 'roster', label: 'Team Roster', icon: '👥' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: subTab === t.id ? 600 : 400,
              cursor: 'pointer', border: 'none', borderBottom: subTab === t.id ? '2px solid #111827' : '2px solid transparent',
              background: 'none', color: subTab === t.id ? '#111827' : '#6b7280',
              marginBottom: -1, transition: 'all 0.15s',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {subTab === 'setup' && (<>
      {/* Header with stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <div className="oa-stat-card">
          <div className="oa-stat-card-label">Dimensions</div>
          <div className="oa-stat-card-value" style={{ color: '#7c3aed' }}>{dimensions.length}</div>
        </div>
        <div className="oa-stat-card">
          <div className="oa-stat-card-label">Total Teams</div>
          <div className="oa-stat-card-value" style={{ color: '#2563eb' }}>{teams.length}</div>
        </div>
        <div className="oa-stat-card">
          <div className="oa-stat-card-label">Assigned Users</div>
          <div className="oa-stat-card-value" style={{ color: '#059669' }}>
            {new Set(memberships.map(m => m.user_id)).size}
          </div>
        </div>
      </div>

      {/* Info bar */}
      <div style={{
        padding: '10px 16px', marginBottom: 16, borderRadius: 8,
        background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, color: '#64748b',
      }}>
        Teams organise users by operational dimensions (market, role, geo, etc.).
        This is separate from the reporting hierarchy — teams don't affect data visibility.
        <button onClick={openDimConfig} style={{
          marginLeft: 12, fontSize: 11, color: '#2563eb', background: 'none',
          border: 'none', cursor: 'pointer', textDecoration: 'underline',
        }}>
          Configure dimensions →
        </button>
      </div>

      {/* Dimension tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {dimensions.map(dim => {
          const count = teams.filter(t => t.dimension === dim.key).length;
          return (
            <button
              key={dim.key}
              onClick={() => setActiveDim(dim.key)}
              style={{
                padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                cursor: 'pointer', border: 'none', transition: 'all 0.15s',
                background: activeDim === dim.key ? getDimColor(dim.key) + '15' : '#f3f4f6',
                color: activeDim === dim.key ? getDimColor(dim.key) : '#6b7280',
                outline: activeDim === dim.key ? `2px solid ${getDimColor(dim.key)}40` : 'none',
              }}
            >
              {dim.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Active dimension teams */}
      {activeDim && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: '#111827' }}>
              {activeDimLabel} Teams
            </h3>
            <button
              onClick={() => setShowNewTeam(!showNewTeam)}
              style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: getDimColor(activeDim), color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              + Add Teams
            </button>
          </div>

          {/* New team form — batch */}
          {showNewTeam && (
            <div style={{
              padding: 16, marginBottom: 12, borderRadius: 8,
              background: '#fff', border: `1px solid ${getDimColor(activeDim)}30`,
              borderLeft: `3px solid ${getDimColor(activeDim)}`,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: getDimColor(activeDim), marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Add {activeDimLabel} Teams
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                Enter one team name per line. You can paste a list.
              </div>
              <textarea
                value={newTeamLines}
                onChange={e => setNewTeamLines(e.target.value)}
                placeholder={`e.g.\n${activeDim === 'market_segment' ? 'Enterprise\nMid-Market\nSMB' : activeDim === 'geo' ? 'AMER\nEMEA\nAPAC' : activeDim === 'seller_role' ? 'AE\nSDR\nSE' : 'Team Alpha\nTeam Beta\nTeam Gamma'}`}
                rows={5}
                style={{
                  width: '100%', padding: '8px 12px', borderRadius: 6,
                  border: '1px solid #d1d5db', fontSize: 13, fontFamily: 'inherit',
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              {(() => {
                const names = newTeamLines.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const uniqueCount = new Set(names).size;
                const existingNames = new Set(activeTeams.map(t => t.name.toLowerCase()));
                const dupeCount = names.filter(n => existingNames.has(n.toLowerCase())).length;
                return names.length > 0 ? (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                    {uniqueCount} team{uniqueCount !== 1 ? 's' : ''} to create
                    {dupeCount > 0 && <span style={{ color: '#d97706' }}> · {dupeCount} already exist (will be skipped)</span>}
                  </div>
                ) : null;
              })()}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  onClick={handleCreateTeams}
                  disabled={!newTeamLines.trim() || saving}
                  style={{
                    padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: newTeamLines.trim() ? getDimColor(activeDim) : '#d1d5db',
                    color: '#fff', border: 'none', cursor: newTeamLines.trim() ? 'pointer' : 'default',
                  }}
                >
                  {saving ? 'Creating…' : 'Create Teams'}
                </button>
                <button
                  onClick={() => { setShowNewTeam(false); setNewTeamLines(''); }}
                  style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: '#f3f4f6', border: 'none', cursor: 'pointer', color: '#6b7280' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Team list */}
          {activeTeams.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No {activeDimLabel.toLowerCase()} teams yet. Create one to start assigning users.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeTeams.map(team => (
                <div key={team.id} style={{
                  padding: '12px 16px', borderRadius: 8,
                  background: '#fff', border: '1px solid #e5e7eb',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{team.name}</span>
                    {team.description && (
                      <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>{team.description}</span>
                    )}
                    <span style={{
                      marginLeft: 8, fontSize: 10, padding: '2px 8px', borderRadius: 10,
                      background: getDimColor(activeDim) + '12', color: getDimColor(activeDim),
                      fontWeight: 600,
                    }}>
                      {team.member_count} member{team.member_count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <button
                    onClick={() => handleDeleteTeam(team)}
                    style={{ fontSize: 11, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}
                    title="Delete team"
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── User Assignment Grid ──────────────────────────────── */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px', color: '#111827' }}>
          User Assignments
        </h3>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: '#374151', minWidth: 160 }}>User</th>
                {dimensions.map(dim => (
                  <th key={dim.key} style={{
                    textAlign: 'left', padding: '8px 12px', fontWeight: 600, minWidth: 120,
                    color: getDimColor(dim.key),
                  }}>
                    {dim.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeMembers.map(member => {
                const userTeams = userTeamMap[member.user_id] || {};
                return (
                  <tr key={member.user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 500, color: '#111827' }}>
                      {member.first_name} {member.last_name}
                      <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>{member.email}</div>
                    </td>
                    {dimensions.map(dim => {
                      const assignment = userTeams[dim.key];
                      const dimTeams = teams.filter(t => t.dimension === dim.key);
                      const isAssigning = assigningUser === `${member.user_id}-${dim.key}`;
                      return (
                        <td key={dim.key} style={{ padding: '6px 12px' }}>
                          {isAssigning ? (
                            <select
                              autoFocus
                              value={assignment?.teamId || ''}
                              onChange={async (e) => {
                                const val = e.target.value;
                                setAssigningUser(null);
                                if (val === '' && assignment) {
                                  await handleRemoveMembership(member.user_id, assignment.teamId);
                                } else if (val) {
                                  await handleAssign(member.user_id, parseInt(val));
                                }
                              }}
                              onBlur={() => setAssigningUser(null)}
                              style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 11, width: '100%' }}
                            >
                              <option value="">— None —</option>
                              {dimTeams.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                          ) : (
                            <button
                              onClick={() => setAssigningUser(`${member.user_id}-${dim.key}`)}
                              style={{
                                padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                                border: assignment ? `1px solid ${getDimColor(dim.key)}30` : '1px dashed #d1d5db',
                                background: assignment ? getDimColor(dim.key) + '10' : 'transparent',
                                color: assignment ? getDimColor(dim.key) : '#9ca3af',
                                fontWeight: assignment ? 500 : 400,
                              }}
                            >
                              {assignment ? assignment.teamName : '+ Assign'}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {activeMembers.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            No active members to assign.
          </div>
        )}
      </div>
      </>)}

      {/* ── Roster Sub-Tab ─────────────────────────────────────── */}
      {subTab === 'roster' && (
        <OATeamRoster
          dimensions={dimensions}
          teams={teams}
          members={activeMembers}
          memberships={memberships}
          rosterDimFilter={rosterDimFilter}
          setRosterDimFilter={setRosterDimFilter}
          rosterTeamFilter={rosterTeamFilter}
          setRosterTeamFilter={setRosterTeamFilter}
          rosterSearch={rosterSearch}
          setRosterSearch={setRosterSearch}
          getDimColor={getDimColor}
        />
      )}

      {/* ── Dimension Config Modal ──────────────────────────────── */}
      {showDimConfig && (
        <div className="pv-modal-overlay" onClick={() => setShowDimConfig(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 12, width: '90%', maxWidth: 600,
            maxHeight: '80vh', overflow: 'auto', padding: 24,
            boxShadow: '0 25px 50px rgba(0,0,0,0.15)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Configure Team Dimensions</h3>
              <button onClick={() => setShowDimConfig(false)} style={{ fontSize: 20, background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Dimensions define the categories of teams (e.g. Market Segment, Geo). Add, rename, or remove dimensions.
              You cannot remove a dimension that has active teams — delete those teams first.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {dimDraft.map((dim, idx) => (
                <div key={idx} style={{
                  display: 'flex', gap: 8, alignItems: 'center',
                  padding: '8px 12px', background: '#f9fafb', borderRadius: 6, border: '1px solid #e5e7eb',
                }}>
                  <input
                    type="text"
                    value={dim.label}
                    onChange={e => updateDimDraft(idx, 'label', e.target.value)}
                    placeholder="Label (e.g. Market Segment)"
                    style={{ flex: 1, padding: '6px 10px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 12 }}
                  />
                  <input
                    type="text"
                    value={dim.key}
                    readOnly
                    style={{ width: 130, padding: '6px 10px', borderRadius: 4, border: '1px solid #e5e7eb', fontSize: 11, fontFamily: 'monospace', color: '#9ca3af', background: '#f9fafb' }}
                    title="Auto-generated from label"
                  />
                  <button
                    onClick={() => removeDimension(idx)}
                    style={{ fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '4px 8px' }}
                    title="Remove dimension"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <button onClick={addDimension} style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12,
              background: '#f3f4f6', border: '1px dashed #d1d5db', cursor: 'pointer', color: '#6b7280', marginBottom: 16,
            }}>
              + Add Dimension
            </button>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDimConfig(false)} style={{
                padding: '8px 16px', borderRadius: 6, fontSize: 12, background: '#f3f4f6', border: 'none', cursor: 'pointer', color: '#374151',
              }}>
                Cancel
              </button>
              <button onClick={saveDimConfig} disabled={saving} style={{
                padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: '#111827', color: '#fff', border: 'none', cursor: 'pointer',
              }}>
                {saving ? 'Saving…' : 'Save Dimensions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


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

const DIAGNOSTIC_MODULE_DEFS = [
  {
    key: 'deals',
    label: 'Deals',
    icon: '💼',
    fields: [
      { key: 'stagnant_days_realtime', label: 'Stagnant days (real-time)',  unit: 'days',  hint: 'Days without stage change before real-time stagnant alert fires' },
      { key: 'stagnant_days_nightly',  label: 'Stagnant days (nightly)',    unit: 'days',  hint: 'Days without stage change before nightly sweep alert fires' },
      { key: 'close_imminent_days',    label: 'Close imminent window',      unit: 'days',  hint: 'Days until close date that triggers the final checklist alert' },
      { key: 'high_value_threshold',   label: 'High-value threshold',       unit: 'USD',   hint: 'Deal value above which the executive touchpoint rule fires' },
    ],
  },
  {
    key: 'cases',
    label: 'Cases',
    icon: '🎧',
    fields: [
      { key: 'stale_days',            label: 'Stale case days',            unit: 'days',  hint: 'Days without activity before stale alert fires (excludes pending_customer)' },
      { key: 'pending_too_long_days', label: 'Pending customer days',      unit: 'days',  hint: 'Days waiting on customer reply before follow-up alert fires' },
    ],
  },
  {
    key: 'handovers',
    label: 'Handovers',
    icon: '🤝',
    fields: [
      { key: 'no_kickoff_days', label: 'No kickoff days',    unit: 'days',  hint: 'Days after handover creation before no-kickoff alert fires' },
      { key: 'stalled_days',    label: 'Stalled days',       unit: 'days',  hint: 'Days without any update before stalled alert fires' },
    ],
  },
  {
    key: 'prospecting',
    label: 'Prospecting',
    icon: '🎯',
    fields: [
      { key: 'stale_days',                      label: 'Stale outreach days',         unit: 'days',  hint: 'Days since last outreach before stale alert fires' },
      { key: 'ghosting_days',                   label: 'Ghosting days',               unit: 'days',  hint: 'Days since last outreach (3+ attempts, 0 replies) before ghosting alert fires' },
      { key: 'hot_lead_response_days',          label: 'Hot lead response window',    unit: 'days',  hint: 'Max days since last response to be considered a hot lead' },
      { key: 'low_icp_threshold',               label: 'Low ICP threshold',           unit: 'score', hint: 'ICP score (0–100) below which the low fit alert fires' },
      { key: 'wrong_channel_min_attempts',      label: 'Wrong channel min attempts',  unit: 'count', hint: 'Minimum outreach attempts before wrong channel alert fires' },
      { key: 'wrong_channel_max_response_rate', label: 'Wrong channel max response',  unit: '%',     hint: 'Response rate below which wrong channel alert fires (e.g. 10 = 10%)' },
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    icon: '🏢',
    fields: [
      { key: 'stale_days',              label: 'Stale account days',        unit: 'days',  hint: 'Days without email or deal activity before account gone dark alert fires' },
      { key: 'expansion_stalled_days',  label: 'Expansion stalled days',    unit: 'days',  hint: 'Days an open deal has had no updates before flagged as stalled' },
      { key: 'renewal_window_days',     label: 'Renewal window days',       unit: 'days',  hint: 'Days before deal close anniversary within which renewal risk alert fires' },
      { key: 'whitespace_min_roles',    label: 'Whitespace min roles',      unit: 'count', hint: 'Minimum distinct contact role types below which whitespace alert fires' },
      { key: 'whitespace_min_contacts', label: 'Whitespace min contacts',   unit: 'count', hint: 'Minimum contact count below which whitespace alert fires' },
    ],
  },
  {
    key: 'strap',
    label: 'STRAP',
    icon: '⚡',
    fields: [
      { key: 'min_age_hours', label: 'STRAP min age before re-validation', unit: 'hours', hint: 'Hours a STRAP must be active before nightly sweep re-validates it' },
    ],
  },
];

function OADiagnosticRules() {
  const [subTab, setSubTab] = useState('edit'); // 'edit' | 'summary'

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>⚙️ Diagnostic Rules</h2>
          <p className="sv-panel-desc">
            Configure alert thresholds and view the complete rules document for your organisation.
          </p>
        </div>
      </div>
      <ModuleSubTabs
        tabs={[['edit', 'Edit Rules'], ['summary', 'Rules Summary']]}
        active={subTab}
        onChange={setSubTab}
      />
      {subTab === 'edit'    && <OADiagnosticRulesEdit />}
      {subTab === 'summary' && <OADiagnosticRulesSummary />}
    </div>
  );
}

function OADiagnosticRulesEdit() {
  const API    = process.env.REACT_APP_API_URL || '';
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [defaults,   setDefaults]   = useState(null);
  const [customised, setCustomised] = useState({});
  const [drafts,     setDrafts]     = useState({});   // { module: { key: value } }
  const [saving,     setSaving]     = useState(null); // module key being saved
  const [expanded,   setExpanded]   = useState('deals');
  const [error,      setError]      = useState('');
  const [success,    setSuccess]    = useState('');
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    fetch(`${API}/org/admin/diagnostic-rules`, { headers })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        setDefaults(data.defaults);
        setCustomised(data.customised || {});
        // Initialise drafts from current config
        const initial = {};
        for (const mod of DIAGNOSTIC_MODULE_DEFS) {
          initial[mod.key] = { ...(data.config[mod.key] || {}) };
          // Convert wrong_channel_max_response_rate to percentage for display
          if (mod.key === 'prospecting' && initial[mod.key].wrong_channel_max_response_rate !== undefined) {
            initial[mod.key].wrong_channel_max_response_rate =
              Math.round(initial[mod.key].wrong_channel_max_response_rate * 100);
          }
        }
        setDrafts(initial);
      })
      .catch(() => setError('Failed to load diagnostic rules'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleChange = (moduleKey, fieldKey, value) => {
    setDrafts(prev => ({
      ...prev,
      [moduleKey]: { ...prev[moduleKey], [fieldKey]: value === '' ? '' : Number(value) },
    }));
  };

  const handleSave = async (moduleKey) => {
    setSaving(moduleKey);
    setError('');
    setSuccess('');
    try {
      let updates = { ...drafts[moduleKey] };
      // Convert response rate from percentage back to ratio before saving
      if (moduleKey === 'prospecting' && updates.wrong_channel_max_response_rate !== undefined) {
        updates = {
          ...updates,
          wrong_channel_max_response_rate: updates.wrong_channel_max_response_rate / 100,
        };
      }
      const r = await fetch(`${API}/org/admin/diagnostic-rules`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ module: moduleKey, updates }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Save failed');
      // Reload customised map
      const cfgR = await fetch(`${API}/org/admin/diagnostic-rules`, { headers });
      const cfgData = await cfgR.json();
      setCustomised(cfgData.customised || {});
      setSuccess(`${DIAGNOSTIC_MODULE_DEFS.find(m => m.key === moduleKey)?.label} rules saved ✓`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  const handleReset = async (moduleKey) => {
    if (!defaults) return;
    // Reset drafts to defaults for this module
    const defaultVals = { ...defaults[moduleKey] };
    if (moduleKey === 'prospecting' && defaultVals.wrong_channel_max_response_rate !== undefined) {
      defaultVals.wrong_channel_max_response_rate =
        Math.round(defaultVals.wrong_channel_max_response_rate * 100);
    }
    setDrafts(prev => ({ ...prev, [moduleKey]: defaultVals }));
    // Save defaults to DB (effectively clears overrides)
    setSaving(moduleKey);
    setError('');
    try {
      const updates = { ...defaults[moduleKey] };
      const r = await fetch(`${API}/org/admin/diagnostic-rules`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ module: moduleKey, updates }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Reset failed');
      setSuccess(`${DIAGNOSTIC_MODULE_DEFS.find(m => m.key === moduleKey)?.label} rules reset to defaults ✓`);
      setTimeout(() => setSuccess(''), 3000);
      const cfgR = await fetch(`${API}/org/admin/diagnostic-rules`, { headers });
      const cfgData = await cfgR.json();
      setCustomised(cfgData.customised || {});
    } catch (e) {
      setError(e.message || 'Failed to reset');
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div className="sv-loading">Loading diagnostic rules…</div>;

  return (
    <div style={{ paddingTop: 16 }}>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        Configure the thresholds that control when diagnostic alerts fire for each module.
        Changes take effect at the next nightly sweep or real-time event.
        Values shown in <strong style={{ color: '#1d4ed8' }}>blue</strong> have been customised from the system default.
      </p>

      {error   && <div className="sv-alert sv-alert--error"   style={{ marginBottom: 16 }}>⚠️ {error}</div>}
      {success && <div className="sv-alert sv-alert--success" style={{ marginBottom: 16 }}>✅ {success}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {DIAGNOSTIC_MODULE_DEFS.map(mod => {
          const isExpanded  = expanded === mod.key;
          const isSaving    = saving === mod.key;
          const modDraft    = drafts[mod.key] || {};
          const modCustom   = customised[mod.key] || {};
          const hasCustom   = Object.values(modCustom).some(Boolean);

          return (
            <div key={mod.key} style={{
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              overflow: 'hidden',
              background: '#fff',
            }}>
              {/* Section header */}
              <button
                onClick={() => setExpanded(isExpanded ? null : mod.key)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '14px 20px',
                  background: isExpanded ? '#f8fafc' : '#fff',
                  border: 'none', cursor: 'pointer',
                  borderBottom: isExpanded ? '1px solid #e5e7eb' : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18 }}>{mod.icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 15, color: '#1e293b' }}>{mod.label}</span>
                  {hasCustom && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 7px',
                      borderRadius: 10, background: '#dbeafe', color: '#1d4ed8',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>Customised</span>
                  )}
                </div>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</span>
              </button>

              {/* Section body */}
              {isExpanded && (
                <div style={{ padding: '20px 24px' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 20,
                    marginBottom: 20,
                  }}>
                    {mod.fields.map(field => {
                      const isCustom  = !!modCustom[field.key];
                      const currVal   = modDraft[field.key];
                      const defVal    = defaults?.[mod.key]?.[field.key];

                      return (
                        <div key={field.key}>
                          <label style={{
                            display: 'block',
                            fontSize: 12,
                            fontWeight: isCustom ? 700 : 600,
                            color: isCustom ? '#1d4ed8' : '#374151',
                            marginBottom: 4,
                          }}>
                            {field.label}
                            {isCustom && <span style={{ marginLeft: 6, fontSize: 10, color: '#3b82f6' }}>● customised</span>}
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              type="number"
                              min={0}
                              step={field.unit === '%' ? 1 : (field.unit === 'USD' ? 1000 : 1)}
                              value={currVal ?? ''}
                              onChange={e => handleChange(mod.key, field.key, e.target.value)}
                              style={{
                                width: 90, padding: '6px 10px',
                                border: `1px solid ${isCustom ? '#93c5fd' : '#d1d5db'}`,
                                borderRadius: 6, fontSize: 14,
                                background: isCustom ? '#eff6ff' : '#fff',
                                fontWeight: isCustom ? 600 : 400,
                              }}
                            />
                            <span style={{ fontSize: 12, color: '#6b7280' }}>{field.unit}</span>
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                            {field.hint}
                            {defVal !== undefined && (
                              <span style={{ marginLeft: 4, color: '#cbd5e1' }}>
                                (default: {field.unit === '%' ? Math.round(defVal * 100) : defVal})
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Save / Reset row */}
                  <div style={{ display: 'flex', gap: 10, paddingTop: 16, borderTop: '1px solid #f1f5f9' }}>
                    <button
                      onClick={() => handleSave(mod.key)}
                      disabled={isSaving}
                      style={{
                        padding: '8px 20px', borderRadius: 7,
                        background: '#1A3A5C', color: '#fff',
                        border: 'none', cursor: isSaving ? 'not-allowed' : 'pointer',
                        opacity: isSaving ? 0.6 : 1, fontSize: 13, fontWeight: 600,
                      }}
                    >
                      {isSaving ? 'Saving…' : `Save ${mod.label} Rules`}
                    </button>
                    {hasCustom && (
                      <button
                        onClick={() => handleReset(mod.key)}
                        disabled={isSaving}
                        style={{
                          padding: '8px 16px', borderRadius: 7,
                          background: '#fff', color: '#6b7280',
                          border: '1px solid #d1d5db',
                          cursor: isSaving ? 'not-allowed' : 'pointer',
                          fontSize: 13,
                        }}
                      >
                        Reset to defaults
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CAT_COLORS = ['#7c3aed','#2563eb','#059669','#d97706','#dc2626','#0891b2','#4f46e5','#c026d3','#ea580c','#16a34a'];
function catColor(idx) { return CAT_COLORS[idx % CAT_COLORS.length]; }

// ─────────────────────────────────────────────────────────────────────────────
// OADiagnosticRulesSummary
// Live per-org rules document. Shows every module, every rule, with the org's
// actual effective thresholds substituted in. Updates whenever rules are saved.
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_COLORS = {
  critical: { bg: '#fef2f2', color: '#991b1b', border: '#fecaca' },
  high:     { bg: '#fff7ed', color: '#9a3412', border: '#fed7aa' },
  medium:   { bg: '#fefce8', color: '#854d0e', border: '#fef08a' },
  low:      { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  'n/a':    { bg: '#f8fafc', color: '#64748b', border: '#e2e8f0' },
};

function OADiagnosticRulesSummary() {
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

function OAIcpScoring() {
  const [config, setConfig]         = useState(null);
  const [draft, setDraft]           = useState(null);
  const [fieldDefs, setFieldDefs]   = useState({ fields: [], matchTypes: [] });
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [scoring, setScoring]       = useState(false);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');
  const [dirty, setDirty]           = useState(false);
  const [expandedCat, setExpandedCat] = useState(null);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  // ── Load config + field definitions ─────────────────────────────────

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [cfgRes, fieldsRes] = await Promise.all([
        apiService.prospects.getIcpConfig(),
        apiService.prospects.getIcpFields(),
      ]);
      const cfg = cfgRes.data.config || { categories: [] };
      setConfig(cfg);
      setDraft(JSON.parse(JSON.stringify(cfg)));
      setFieldDefs(fieldsRes.data || { fields: [], matchTypes: [] });
      setDirty(false);
    } catch (err) {
      setError('Failed to load ICP config');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Draft helpers ───────────────────────────────────────────────────

  const updateCategories = (fn) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      fn(next.categories);
      return next;
    });
    setDirty(true);
  };

  const updateCategory = (catIdx, field, value) => {
    updateCategories(cats => { cats[catIdx][field] = value; });
  };

  const updateRule = (catIdx, ruleIdx, field, value) => {
    updateCategories(cats => { cats[catIdx].rules[ruleIdx][field] = value; });
  };

  // ── Category CRUD ───────────────────────────────────────────────────

  const addCategory = () => {
    const newKey = 'custom_' + Date.now();
    updateCategories(cats => {
      cats.push({
        key: newKey,
        label: 'New Category',
        enabled: true,
        weight: 10,
        baseline_score: 50,
        rules: [],
      });
    });
    setExpandedCat((draft?.categories?.length || 0));
  };

  const removeCategory = (idx) => {
    const cat = draft.categories[idx];
    if (!window.confirm(`Delete category "${cat.label}"? This cannot be undone.`)) return;
    updateCategories(cats => cats.splice(idx, 1));
    if (expandedCat === idx) setExpandedCat(null);
    else if (expandedCat > idx) setExpandedCat(expandedCat - 1);
  };

  const moveCategory = (idx, dir) => {
    const to = idx + dir;
    if (to < 0 || to >= draft.categories.length) return;
    updateCategories(cats => {
      const tmp = cats[idx]; cats[idx] = cats[to]; cats[to] = tmp;
    });
    setExpandedCat(to);
  };

  // ── Rule CRUD ───────────────────────────────────────────────────────

  const addRule = (catIdx) => {
    updateCategories(cats => {
      cats[catIdx].rules.push({
        field: 'title',
        match_type: 'contains_text',
        target_values: [],
        points_if_match: 10,
        points_if_no_match: 0,
        points_if_empty: 0,
        label: 'New rule',
      });
    });
  };

  const removeRule = (catIdx, ruleIdx) => {
    updateCategories(cats => cats[catIdx].rules.splice(ruleIdx, 1));
  };

  // ── Save / Reset / Score All ────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const r = await apiService.prospects.updateIcpConfig(draft);
      setConfig(r.data.config || draft);
      setDraft(JSON.parse(JSON.stringify(r.data.config || draft)));
      setDirty(false);
      flash('ICP config saved');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleReset = () => {
    setDraft(JSON.parse(JSON.stringify(config)));
    setDirty(false);
    setExpandedCat(null);
  };

  const handleResetDefaults = async () => {
    if (!window.confirm('Reset to factory defaults? All custom categories and rules will be lost.')) return;
    try {
      const r = await apiService.prospects.getIcpDefaults();
      const defaultCfg = { categories: r.data.categories };
      setDraft(defaultCfg);
      setDirty(true);
      flash('Defaults loaded — save to apply');
    } catch (err) {
      setError('Failed to load defaults');
    }
  };

  const handleBulkScore = async () => {
    if (!window.confirm('Re-score all unscored prospects? This may take a moment.')) return;
    setScoring(true); setError('');
    try {
      const r = await apiService.prospects.scoreAllIcp();
      flash(r.data.message || 'Scoring complete');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Scoring failed');
    } finally { setScoring(false); }
  };

  // ── Loading state ──────────────────────────────────────────────────

  if (loading || !draft) return <div className="oa-loading">Loading ICP config…</div>;

  const categories = draft.categories || [];
  const enabledCats = categories.filter(c => c.enabled);
  const totalWeight = enabledCats.reduce((s, c) => s + (c.weight || 0), 0);

  // ── Helpers for field lookups ──────────────────────────────────────

  const getField = (key) => fieldDefs.fields.find(f => f.key === key);
  const getMatchTypesFor = (fieldKey) => {
    const f = getField(fieldKey);
    if (!f) return fieldDefs.matchTypes;
    return fieldDefs.matchTypes.filter(m => m.for_types.includes(f.type));
  };
  const groupedFields = fieldDefs.fields.reduce((acc, f) => {
    (acc[f.group] = acc[f.group] || []).push(f); return acc;
  }, {});

  // ── TagInput sub-component ────────────────────────────────────────

  const TagInput = ({ values, onChange, placeholder, color }) => {
    const [input, setInput] = useState('');
    const add = () => {
      const v = input.trim();
      if (v && !values.includes(v)) onChange([...values, v]);
      setInput('');
    };
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
        {values.map((v, i) => (
          <span key={i} style={{ padding: '1px 6px', borderRadius: 3, fontSize: 10, background: (color || '#6b7280') + '15', color: color || '#6b7280', border: `1px solid ${(color || '#6b7280')}30`, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            {v}
            <button onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 10, padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
        <input
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={values.length === 0 ? (placeholder || 'Type + Enter') : ''}
          style={{ flex: 1, minWidth: 80, padding: '2px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, outline: 'none' }}
        />
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div>
      {error && <div className="oa-error">{error} <button onClick={() => setError('')}>×</button></div>}
      {success && <div className="oa-success">{success}</div>}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
          Define scoring categories and rules. Each prospect is scored 0–100 based on the weighted categories below.
        </p>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={handleBulkScore} disabled={scoring}
            style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500, background: '#f3f4f6', border: '1px solid #d1d5db', cursor: 'pointer', color: '#374151' }}>
            {scoring ? 'Scoring…' : '⚡ Score Unscored'}
          </button>
          <button onClick={handleResetDefaults}
            style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#f3f4f6', border: '1px solid #d1d5db', cursor: 'pointer', color: '#6b7280' }}>
            Reset Defaults
          </button>
          {dirty && (
            <button onClick={handleReset}
              style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#fef2f2', border: '1px solid #fca5a5', cursor: 'pointer', color: '#dc2626' }}>
              Discard
            </button>
          )}
          <button onClick={handleSave} disabled={!dirty || saving}
            style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: dirty ? '#111827' : '#e5e7eb', color: '#fff', border: 'none', cursor: dirty ? 'pointer' : 'default' }}>
            {saving ? 'Saving…' : 'Save Config'}
          </button>
        </div>
      </div>

      {/* Weight summary bar */}
      <div style={{ padding: 12, borderRadius: 8, background: '#fff', border: '1px solid #e5e7eb', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Weight Distribution</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: totalWeight === 100 ? '#059669' : '#dc2626' }}>
            Total: {totalWeight}% {totalWeight !== 100 && '(should be 100%)'}
          </span>
        </div>
        {/* Stacked bar */}
        <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', background: '#f3f4f6' }}>
          {enabledCats.map((cat, i) => {
            const ci = categories.indexOf(cat);
            const pct = totalWeight > 0 ? (cat.weight / totalWeight) * 100 : 0;
            return pct > 0 ? (
              <div key={cat.key} style={{ width: pct + '%', background: catColor(ci), display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'width 0.3s' }}>
                <span style={{ fontSize: 9, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  {cat.weight >= 8 ? `${cat.label} ${cat.weight}%` : `${cat.weight}%`}
                </span>
              </div>
            ) : null;
          })}
        </div>
      </div>

      {/* Category list */}
      {categories.map((cat, ci) => {
        const color = catColor(ci);
        const isExpanded = expandedCat === ci;

        return (
          <div key={cat.key} style={{ marginBottom: 10, borderRadius: 8, border: `1px solid ${isExpanded ? color + '40' : '#e5e7eb'}`, background: '#fff', overflow: 'hidden', transition: 'border-color 0.2s' }}>

            {/* Category header */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', background: isExpanded ? color + '06' : 'transparent' }}
              onClick={() => setExpandedCat(isExpanded ? null : ci)}
            >
              <span style={{ fontSize: 12, color: '#9ca3af', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>

              {/* Enabled toggle */}
              <button
                onClick={e => { e.stopPropagation(); updateCategory(ci, 'enabled', !cat.enabled); }}
                style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${cat.enabled ? color : '#d1d5db'}`, background: cat.enabled ? color : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 10, color: '#fff', padding: 0, flexShrink: 0 }}
              >{cat.enabled ? '✓' : ''}</button>

              <span style={{ fontSize: 13, fontWeight: 600, color: cat.enabled ? '#111827' : '#9ca3af', flex: 1, textDecoration: cat.enabled ? 'none' : 'line-through' }}>
                {cat.label}
              </span>

              <span style={{ fontSize: 10, color: '#9ca3af' }}>
                {(cat.rules || []).length} rule{(cat.rules || []).length !== 1 ? 's' : ''}
              </span>

              {/* Weight badge */}
              <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: cat.enabled ? color + '15' : '#f3f4f6', color: cat.enabled ? color : '#9ca3af' }}>
                {cat.weight}%
              </span>

              {/* Move / Delete */}
              <div style={{ display: 'flex', gap: 2 }} onClick={e => e.stopPropagation()}>
                <button onClick={() => moveCategory(ci, -1)} disabled={ci === 0} style={{ background: 'none', border: 'none', cursor: ci === 0 ? 'default' : 'pointer', fontSize: 10, color: ci === 0 ? '#d1d5db' : '#6b7280', padding: '2px 4px' }}>▲</button>
                <button onClick={() => moveCategory(ci, 1)} disabled={ci === categories.length - 1} style={{ background: 'none', border: 'none', cursor: ci === categories.length - 1 ? 'default' : 'pointer', fontSize: 10, color: ci === categories.length - 1 ? '#d1d5db' : '#6b7280', padding: '2px 4px' }}>▼</button>
                <button onClick={() => removeCategory(ci)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#dc2626', padding: '2px 4px' }}>🗑</button>
              </div>
            </div>

            {/* Expanded: settings + rules */}
            {isExpanded && (
              <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${color}15` }}>

                {/* Category settings row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px', gap: 12, marginTop: 12, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Label</label>
                    <input
                      value={cat.label} onChange={e => updateCategory(ci, 'label', e.target.value)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Weight (%)</label>
                    <input
                      type="number" min={0} max={100} value={cat.weight}
                      onChange={e => updateCategory(ci, 'weight', parseInt(e.target.value) || 0)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'center' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Baseline Score</label>
                    <input
                      type="number" min={0} max={100} value={cat.baseline_score ?? 50}
                      onChange={e => updateCategory(ci, 'baseline_score', parseInt(e.target.value) || 0)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'center' }}
                    />
                  </div>
                </div>

                {/* Rules header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>Scoring Rules</span>
                  <button onClick={() => addRule(ci)}
                    style={{ padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: color + '10', color, border: `1px solid ${color}30`, cursor: 'pointer' }}>
                    + Add Rule
                  </button>
                </div>

                {/* Rules table */}
                {(cat.rules || []).length === 0 && (
                  <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 11, fontStyle: 'italic', background: '#fafafa', borderRadius: 6 }}>
                    No rules yet. Add a rule to start scoring this category.
                  </div>
                )}

                {(cat.rules || []).map((rule, ri) => {
                  const validMatchTypes = getMatchTypesFor(rule.field);
                  const needsTargetValues = !['exists'].includes(rule.match_type);
                  const isSingleValue = ['greater_than', 'less_than'].includes(rule.match_type);

                  return (
                    <div key={ri} style={{ padding: 10, marginBottom: 6, borderRadius: 6, background: '#fafafa', border: '1px solid #f0f0f0' }}>
                      {/* Row 1: Label + Field + Match Type + Delete */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 140px 28px', gap: 8, marginBottom: 6, alignItems: 'end' }}>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Label</label>
                          <input
                            value={rule.label || ''} onChange={e => updateRule(ci, ri, 'label', e.target.value)}
                            placeholder="Rule label"
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Field</label>
                          <select
                            value={rule.field} onChange={e => {
                              updateRule(ci, ri, 'field', e.target.value);
                              // Auto-fix match type if incompatible
                              const newFieldDef = getField(e.target.value);
                              const curMatch = rule.match_type;
                              const compatible = fieldDefs.matchTypes.filter(m => m.for_types.includes(newFieldDef?.type));
                              if (!compatible.find(m => m.key === curMatch)) {
                                updateRule(ci, ri, 'match_type', compatible[0]?.key || 'exists');
                              }
                            }}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, background: '#fff' }}
                          >
                            {Object.entries(groupedFields).map(([group, fields]) => (
                              <optgroup key={group} label={group}>
                                {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Match</label>
                          <select
                            value={rule.match_type} onChange={e => updateRule(ci, ri, 'match_type', e.target.value)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, background: '#fff' }}
                          >
                            {validMatchTypes.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                          </select>
                        </div>
                        <button onClick={() => removeRule(ci, ri)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 13, padding: 4, alignSelf: 'end' }}>×</button>
                      </div>

                      {/* Row 2: Target Values + Points */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px', gap: 8, alignItems: 'end' }}>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>
                            {needsTargetValues ? (isSingleValue ? 'Threshold' : 'Target Values') : 'Match type needs no values'}
                          </label>
                          {needsTargetValues ? (
                            isSingleValue ? (
                              <input
                                type="number" value={rule.target_values?.[0] ?? ''} step="any"
                                onChange={e => updateRule(ci, ri, 'target_values', e.target.value !== '' ? [parseFloat(e.target.value)] : [])}
                                style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11 }}
                              />
                            ) : (
                              <TagInput
                                values={rule.target_values || []}
                                onChange={v => updateRule(ci, ri, 'target_values', v)}
                                placeholder="Type + Enter"
                                color={color}
                              />
                            )
                          ) : (
                            <span style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic' }}>—</span>
                          )}
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#059669', display: 'block', marginBottom: 2 }}>If match</label>
                          <input
                            type="number" value={rule.points_if_match ?? 0}
                            onChange={e => updateRule(ci, ri, 'points_if_match', parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, textAlign: 'center', color: (rule.points_if_match || 0) >= 0 ? '#059669' : '#dc2626' }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#dc2626', display: 'block', marginBottom: 2 }}>If no match</label>
                          <input
                            type="number" value={rule.points_if_no_match ?? 0}
                            onChange={e => updateRule(ci, ri, 'points_if_no_match', parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, textAlign: 'center', color: (rule.points_if_no_match || 0) >= 0 ? '#059669' : '#dc2626' }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>If empty</label>
                          <input
                            type="number" value={rule.points_if_empty ?? 0}
                            onChange={e => updateRule(ci, ri, 'points_if_empty', parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, textAlign: 'center', color: (rule.points_if_empty || 0) >= 0 ? '#059669' : '#dc2626' }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Add category button */}
      <button onClick={addCategory}
        style={{ width: '100%', padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 600, background: '#fafafa', border: '2px dashed #d1d5db', cursor: 'pointer', color: '#6b7280', marginBottom: 16 }}>
        + Add Category
      </button>

      {/* How scoring works */}
      <details style={{ padding: 14, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
        <summary style={{ fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
          How ICP scoring works
        </summary>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 10, lineHeight: 1.7 }}>
          Each prospect is scored across all <strong>enabled categories</strong>. Within a category, the score starts at the <strong>baseline</strong> and
          each rule adds or subtracts points based on whether the prospect's field matches the target values.
          Category scores are clamped to 0–100.
          <br /><br />
          The composite score (0–100) is the <strong>weighted average</strong> of all enabled category scores.
          Disabled categories are excluded from the calculation.
          <br /><br />
          <strong>Rule fields</strong> can be direct prospect columns (title, industry, location…) or
          derived values (response rate, days since created, account deal status) that are computed at scoring time.
          <br /><br />
          <strong>Match types:</strong> "Is any of" checks exact match against a list. "Contains text" checks substring match.
          "Greater/Less than" compares a numeric value against a threshold.
          "Has value / Is true" checks that a field is non-empty or truthy.
          "Has any tag" checks the prospect's tags array.
        </div>
      </details>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────
// INVITATIONS TAB
// ─────────────────────────────────────────────────────────────────

function OAInvitations() {
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [form, setForm]               = useState({ email: '', role: 'member', message: '' });
  const [sending, setSending]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [showForm, setShowForm]       = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await apiService.orgAdmin.getInvitations();
      setInvitations(r.data.invitations);
    } catch { setError('Failed to load invitations'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSend = async () => {
    if (!form.email.trim()) { setError('Email is required'); return; }
    try {
      setSending(true); setError('');
      await apiService.orgAdmin.sendInvitation(form);
      setSuccess(`Invitation sent to ${form.email}`);
      setForm({ email: '', role: 'member', message: '' });
      setShowForm(false);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to send invitation');
    } finally { setSending(false); }
  };

  const handleCancel = async (id, email) => {
    if (!window.confirm(`Cancel invitation to ${email}?`)) return;
    try {
      await apiService.orgAdmin.cancelInvitation(id);
      setSuccess('Invitation cancelled');
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch { setError('Failed to cancel invitation'); }
  };

  const STATUS_COLORS = { pending: 'amber', accepted: 'green', cancelled: 'grey', expired: 'red' };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>✉️ Team Invitations</h2>
          <p className="sv-panel-desc">Invite people to join your organisation. Invitations expire after 7 days.</p>
        </div>
        <button className="sv-btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? '✕ Cancel' : '+ Invite Member'}
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Invite form */}
        {showForm && (
          <div className="sv-card oa-invite-form">
            <h3>New Invitation</h3>
            <div className="sa-form-grid">
              <div className="sa-form-field sa-form-field--full">
                <label>Email Address *</label>
                <input
                  autoFocus
                  type="email"
                  placeholder="colleague@company.com"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="sa-form-field">
                <label>Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                  <option value="admin">🔑 Admin</option>
                  <option value="member">👤 Member</option>
                  <option value="viewer">👁 Viewer</option>
                </select>
              </div>
              <div className="sa-form-field sa-form-field--full">
                <label>Personal Message (optional)</label>
                <textarea
                  placeholder="Hey, I'd like to invite you to our CRM…"
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  rows={2}
                />
              </div>
            </div>
            <div className="oa-invite-actions">
              <p className="sv-hint">They'll receive an email with a link to join. If they don't have an account, they'll be prompted to create one.</p>
              <button className="sv-btn-primary" onClick={handleSend} disabled={sending}>
                {sending ? '⏳ Sending…' : '📨 Send Invitation'}
              </button>
            </div>
          </div>
        )}

        {/* Invitations list */}
        {loading ? (
          <div className="sv-loading">Loading invitations…</div>
        ) : invitations.length === 0 ? (
          <div className="sv-empty">No invitations sent yet</div>
        ) : (
          <div className="oa-invite-list">
            {invitations.map(inv => (
              <div key={inv.id} className="oa-invite-row">
                <div className="oa-invite-info">
                  <div className="oa-member-name">{inv.email}</div>
                  <div className="oa-member-meta">
                    <RoleBadge role={inv.role} />
                    {' '}· Invited by {inv.invited_by_email || 'admin'}
                    {' '}· {new Date(inv.created_at).toLocaleDateString()}
                    {inv.expires_at && ` · Expires ${new Date(inv.expires_at).toLocaleDateString()}`}
                  </div>
                  {inv.message && <div className="oa-invite-message">"{inv.message}"</div>}
                </div>
                <div className="oa-invite-status">
                  <span className={`sa-badge-status sa-badge-status--${STATUS_COLORS[inv.status] || 'grey'}`}>
                    {inv.status}
                  </span>
                  {inv.status === 'pending' && (
                    <button className="oa-btn-remove" onClick={() => handleCancel(inv.id, inv.email)}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// ORG SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// OAPlaybooks — full playbook management for org admins
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// OAPlaybooks — wired to deal_stages + stage_guidance
// ─────────────────────────────────────────────────────────────────
function OAPlaybooks() {
  const [playbooks,    setPlaybooks]    = useState([]);
  const [selectedId,   setSelectedId]   = useState(null);
  const [playbook,     setPlaybook]     = useState(null);   // full playbook row incl. stage_guidance
  const [liveStages,   setLiveStages]   = useState([]);    // from deal_stages table
  const [guidance,     setGuidance]     = useState({});    // { stage_type: { goal, key_actions, ... } }
  const [loading,      setLoading]      = useState(true);
  const [stagesLoading,setStagesLoading]= useState(true);
  const [saving,       setSaving]       = useState(null);   // null | 'meta' | stage_type string
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState('');
  const [showNewForm,  setShowNewForm]  = useState(false);
  const [newPbData,    setNewPbData]    = useState({ name: '', type: 'sales', description: '' });
  const [editingStage, setEditingStage] = useState(null);   // stage_type being expanded
  const [creating,     setCreating]     = useState(false);
  const [deleting,     setDeleting]     = useState(false);
  const [showCompany,  setShowCompany]  = useState(false);
  const [showPlaysTab, setShowPlaysTab] = useState(false);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3500);
  };

  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const API    = process.env.REACT_APP_API_URL || '';

  // ── Fetch live sales stages once on mount ──────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch(`${API}/pipeline-stages/sales`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        // Only active non-terminal stages are meaningful for playbook guidance
        const active = (data.stages || [])
          .filter(s => s.is_active)
          .sort((a, b) => a.sort_order - b.sort_order);
        setLiveStages(active);
      } catch {
        // Non-fatal — editor degrades gracefully
      } finally {
        setStagesLoading(false);
      }
    })();
  }, [API, token]);

  // ── Load playbook list ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r    = await apiService.playbooks.getAll();
        const list = r.data.playbooks || [];
        setPlaybooks(list);
        const def = list.find(p => p.is_default) || list[0];
        if (def) setSelectedId(def.id);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  // ── Load selected playbook + extract stage_guidance ──────────────────────
  useEffect(() => {
    if (!selectedId) {
      setPlaybook(null);
      setGuidance({});
      return;
    }
    setPlaybook(null);
    setGuidance({});
    setEditingStage(null);
    setShowCompany(false);
    setShowPlaysTab(false);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        setPlaybook(raw);
        // stage_guidance is keyed by stage key: { qualified: {...}, demo: {...} }
        setGuidance(raw.stage_guidance || {});
      } catch { setError('Failed to load playbook content'); }
    })();
  }, [selectedId]);

  // ── Save playbook name / description / company context ───────────────────
  const handleSaveMeta = async () => {
    if (!playbook) return;
    setSaving('meta');
    try {
      await apiService.playbooks.update(selectedId, {
        name:        playbook.name,
        description: playbook.description,
        content:     playbook.content,   // company context lives here
      });
      setPlaybooks(prev => prev.map(p =>
        p.id === selectedId ? { ...p, name: playbook.name, description: playbook.description } : p
      ));
      flash('success', 'Playbook saved ✓');
    } catch { flash('error', 'Failed to save playbook'); }
    finally  { setSaving(null); }
  };

  // ── Save guidance for a single stage_type ────────────────────────────────
  // Uses the dedicated PUT /api/playbooks/:id/stages/:stageType endpoint
  // so we never clobber other stages' guidance.
  const handleSaveStage = async (stageKey, stageType) => {
    if (!playbook) return;
    setSaving(stageKey);
    const stageGuidance = guidance[stageKey] || {};
    try {
      const res = await fetch(`${API}/api/playbooks/${selectedId}/stages/${stageKey}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          goal:                  stageGuidance.goal                || null,
          next_step:             stageGuidance.next_step           || null,
          timeline:              stageGuidance.timeline            || null,
          key_actions:           Array.isArray(stageGuidance.key_actions) ? stageGuidance.key_actions : [],
          email_response_time:   stageGuidance.email_response_time || null,
          success_criteria:      Array.isArray(stageGuidance.success_criteria) ? stageGuidance.success_criteria : [],
          requires_proposal_doc: !!stageGuidance.requires_proposal_doc,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err?.error?.message || res.statusText);
      }
      flash('success', `Stage guidance saved ✓`);
    } catch (e) {
      flash('error', e.message || 'Failed to save stage guidance');
    } finally {
      setSaving(null);
    }
  };

  // ── Helpers to mutate local guidance state ────────────────────────────────
  const updateGuidanceField = (stageKey, field, value) => {
    setGuidance(prev => ({
      ...prev,
      [stageKey]: { ...(prev[stageKey] || {}), [field]: value },
    }));
  };

  const updateKeyAction = (stageKey, idx, value) => {
    const actions = [...(guidance[stageKey]?.key_actions || [])];
    actions[idx]  = value;
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const addKeyAction = (stageKey) => {
    const actions = [...(guidance[stageKey]?.key_actions || []), ''];
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const removeKeyAction = (stageKey, idx) => {
    const actions = (guidance[stageKey]?.key_actions || []).filter((_, i) => i !== idx);
    updateGuidanceField(stageKey, 'key_actions', actions);
  };

  const TYPE_LABELS = { market: '🌍 Market', product: '📦 Product', custom: '⚙️ Custom', prospecting: '🎯 Prospecting', clm: '📋 CLM' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096', prospecting: '#0F9D8E', clm: '#7c3aed' };
  const TEAL = '#0F9D8E';

  // ── Dynamic playbook types from org settings ────────────────────────────────
  const [playbookTypes,        setPlaybookTypes]        = useState([]);
  const [playbookTypesLoading, setPlaybookTypesLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/org/admin/playbook-types`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.playbook_types?.length) setPlaybookTypes(data.playbook_types);
      } catch (err) {
        console.error('Failed to load playbook types:', err);
      } finally {
        setPlaybookTypesLoading(false);
      }
    })();
  }, [API, token]);


  // ── Type filter tab: dynamic from org playbook types ────────────────────────
  const [typeFilter, setTypeFilter] = useState('sales');
  const isProspecting = typeFilter === 'prospecting';
  const isSalesType   = typeFilter === 'sales';
  const isCLM         = typeFilter === 'clm';
  const isService     = typeFilter === 'service';
  const isCustomType  = !isSalesType && !isProspecting && !isCLM && !isService;


  // Service stages are fixed case-status strings, not stored in pipeline_stages.
  // "sales" tab catches legacy types (custom, market, product) + explicit sales type
  // All other tabs filter by exact type key
  const SALES_LEGACY_TYPES = ['sales', 'custom', 'market', 'product'];
  const filteredPlaybooks = typeFilter === 'sales'
    ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type))
    : playbooks.filter(p => p.type === typeFilter);

  // ── Stage loader — unified for all types ─────────────────────────────────
  // sales       → pipeline-stages/sales
  // prospecting → pipeline-stages/prospecting
  // all others (service, clm, handover_s2i, custom) → org/admin/playbook-stages/:type
  const [prospectLiveStages, setProspectLiveStages] = useState([]);
  const [prospectStagesLoading, setProspectStagesLoading] = useState(false);
  const [customLiveStages, setCustomLiveStages] = useState([]);
  const [customStagesLoading, setCustomStagesLoading] = useState(false);

  useEffect(() => {
    if (isSalesType) return; // sales uses liveStages already loaded from pipeline-stages/sales

    if (isProspecting) {
      setProspectStagesLoading(true);
      (async () => {
        try {
          const res = await fetch(`${API}/pipeline-stages/prospecting`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await res.json();
          const active = (data.stages || [])
            .filter(s => s.is_active)
            .sort((a, b) => a.sort_order - b.sort_order);
          setProspectLiveStages(active);
        } catch { /* non-fatal */ }
        finally { setProspectStagesLoading(false); }
      })();
      return;
    }

    // All other types — load from pipeline-stages/:type (org-wide, consistent with PlaybooksView)
    setCustomStagesLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API}/pipeline-stages/${typeFilter}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const active = (data.stages || [])
          .filter(s => s.is_active !== false)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        setCustomLiveStages(active);
      } catch { /* non-fatal */ }
      finally { setCustomStagesLoading(false); }
    })();
  }, [typeFilter, API, token, isSalesType, isProspecting]);

  // Re-select on type filter change
  useEffect(() => {
    const filtered = typeFilter === 'sales'
      ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type))
      : playbooks.filter(p => p.type === typeFilter);
    const def = filtered.find(p => p.is_default) || filtered[0];
    setSelectedId(def?.id || null);
    setEditingStage(null);
    setShowNewForm(false);
    // Also clear playbook/guidance so stale data doesn't render
    if (!def) { setPlaybook(null); setGuidance({}); }
  }, [typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which stages to show in the editor
  const activeLiveStages = isProspecting ? prospectLiveStages
    : isSalesType ? liveStages
    : customLiveStages; // service, clm, handover_s2i, custom all loaded from org settings
  const activeStagesLoading = isProspecting ? prospectStagesLoading
    : isSalesType ? stagesLoading
    : customStagesLoading;

  const handleSetDefault = async (id) => {
    try {
      await apiService.playbooks.setDefault(id);
      // Only toggle default within the same type group
      const targetPb = playbooks.find(p => p.id === id);
      const targetType = targetPb?.type || 'sales';
      setPlaybooks(prev => prev.map(p => {
        if (p.type === targetType || (p.type !== 'prospecting' && targetType !== 'prospecting' && !isCustomType)) {
          return { ...p, is_default: p.id === id };
        }
        return p;
      }));
      if (playbook && playbook.id === id) setPlaybook({ ...playbook, is_default: true });
      flash('success', 'Default playbook updated ✓');
    } catch { flash('error', 'Failed to set default'); }
  };

  const handleCreate = async () => {
    if (!newPbData.name.trim()) { flash('error', 'Name is required'); return; }
    // CLM playbook is system-managed — admins can edit it but not create additional ones
    if (typeFilter === 'clm') {
      flash('error', 'The CLM playbook is system-managed. Edit the existing one directly.');
      return;
    }
    setCreating(true);
    try {
      // For sales tab, use the sub-type from the form (or default 'custom')
      // For all other tabs, use the typeFilter key directly
      const effectiveType = typeFilter === 'sales'
        ? (newPbData.type || 'custom')
        : typeFilter;
      const createPayload = {
        name: newPbData.name,
        type: effectiveType,
        description: newPbData.description || '',
        content: typeFilter === 'sales' ? { company: {} } : {},
        stage_guidance: {},
      };
      const r  = await apiService.playbooks.create(createPayload);
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: typeFilter === 'sales' ? 'custom' : typeFilter, description: '' });
      flash('success', 'Playbook created ✓');
    } catch { flash('error', 'Failed to create playbook'); }
    finally  { setCreating(false); }
  };

  const handleDelete = async (id) => {
    const pb = playbooks.find(p => p.id === id);
    if (pb?.is_default) { flash('error', 'Set another playbook as default before deleting this one'); return; }
    if (!window.confirm(`Delete "${pb?.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await apiService.playbooks.delete(id);
      const remaining = playbooks.filter(p => p.id !== id);
      setPlaybooks(remaining);
      if (selectedId === id) setSelectedId(remaining[0]?.id || null);
      flash('success', 'Playbook deleted');
    } catch (e) { flash('error', e?.response?.data?.error?.message || 'Failed to delete playbook'); }
    finally     { setDeleting(false); }
  };

  // Current type metadata
  const activeType = playbookTypes.find(t => t.key === typeFilter) || playbookTypes[0];

  if (loading || playbookTypesLoading) return <div className="sv-loading">Loading playbooks...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>{activeType?.icon || '📋'} {activeType?.label || 'Sales'} Playbooks</h2>
          <p className="sv-panel-desc">
            {isProspecting
              ? 'Manage outreach playbooks — define stage guidance, key actions, and cadences for each prospecting stage.'
              : typeFilter === 'sales'
                ? 'Stage names and order come from the Deal Stages tab. Edit guidance here to tell the AI what actions to generate for each stage.'
                : `Manage ${activeType?.label || typeFilter} playbooks and stage guidance.`}
          </p>
        </div>
        {!isCLM && (
          <button className="sv-btn-primary" onClick={() => setShowNewForm(true)}>
            + New {activeType?.label || 'Sales'} Playbook
          </button>
        )}
      </div>

      {/* Dynamic type toggle tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', margin: '0 0 16px', flexWrap: 'wrap' }}>
        {playbookTypes.map(t => {
          const count = t.key === 'sales'
            ? playbooks.filter(p => SALES_LEGACY_TYPES.includes(p.type)).length
            : playbooks.filter(p => p.type === t.key).length;
          return (
            <button
              key={t.key}
              onClick={() => setTypeFilter(t.key)}
              style={{
                padding: '10px 20px',
                background: 'none',
                border: 'none',
                borderBottom: `3px solid ${typeFilter === t.key ? t.color : 'transparent'}`,
                color: typeFilter === t.key ? t.color : '#6b7280',
                fontWeight: typeFilter === t.key ? 600 : 400,
                fontSize: 14,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {t.icon} {t.label} ({count})
            </button>
          );
        })}
      </div>

      {error   && <div className="sv-alert sv-alert-error">{error}</div>}
      {success && <div className="sv-alert sv-alert-success">{success}</div>}

      {showNewForm && (
        <div className="sv-card oa-pb-new-form">
          <h4 style={{ marginTop: 0, marginBottom: 16 }}>New {activeType?.label || 'Sales'} Playbook</h4>
          <div className="oa-pb-form-grid">
            <div className="sv-field">
              <label>Name</label>
              <input className="sv-input" placeholder={`e.g. ${isProspecting ? 'Outbound SDR' : typeFilter === 'sales' ? 'EMEA Enterprise' : activeType?.label + ' Template'}`}
                value={newPbData.name} onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
            </div>
            {typeFilter === 'sales' && (
              <div className="sv-field">
                <label>Type</label>
                <select className="sv-input" value={newPbData.type} onChange={e => setNewPbData(p => ({ ...p, type: e.target.value }))}>
                  <option value="market">🌍 Market</option>
                  <option value="product">📦 Product</option>
                  <option value="custom">⚙️ Custom</option>
                </select>
              </div>
            )}
          </div>
          <div className="sv-field" style={{ marginTop: 12 }}>
            <label>Description (optional)</label>
            <input className="sv-input" placeholder={`e.g. ${isProspecting ? 'Multi-channel outbound sequence' : typeFilter === 'sales' ? 'For deals in EMEA region' : activeType?.label + ' playbook description'}`}
              value={newPbData.description} onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="sv-btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Playbook'}
            </button>
            <button className="sv-btn sv-btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="oa-pb-layout">
        {/* Sidebar */}
        <div className="oa-pb-sidebar">
          {filteredPlaybooks.length === 0
            ? <div className="sv-empty">No {activeType?.label?.toLowerCase() || typeFilter} playbooks yet. Create one above.</div>
            : filteredPlaybooks.map(pb => (
              <div key={pb.id}
                className={`oa-pb-list-item ${selectedId === pb.id ? 'active' : ''}`}
                onClick={() => setSelectedId(pb.id)}>
                <div className="oa-pb-list-main">
                  <span className="oa-pb-list-name">{pb.name}</span>
                  {pb.is_default && <span className="oa-pb-star" title="Default">★</span>}
                </div>
                <span style={{ fontSize: 11, color: TYPE_COLORS[pb.type], fontWeight: 600 }}>{TYPE_LABELS[pb.type]}</span>
                {selectedId === pb.id && (
                  <div className="oa-pb-item-actions">
                    {!pb.is_default && (
                      <button className="oa-pb-link" onClick={e => { e.stopPropagation(); handleSetDefault(pb.id); }}>
                        Set default
                      </button>
                    )}
                    {!pb.is_default && (
                      <button className="oa-pb-link oa-pb-link--danger" onClick={e => { e.stopPropagation(); handleDelete(pb.id); }} disabled={deleting}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          }
        </div>

        {/* Editor */}
        <div className="oa-pb-editor">
          {!playbook ? (
            <div className="sv-loading">Select a playbook to edit</div>
          ) : (
            <>
              {/* Header — name / description / save meta */}
              <div className="oa-pb-editor-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <input
                      className="oa-pb-name-input"
                      value={playbook.name}
                      onChange={e => setPlaybook({ ...playbook, name: e.target.value })}
                      placeholder="Playbook name"
                    />
                    {playbook.is_default && <span className="oa-pb-default-badge">Default</span>}
                    <span style={{ fontSize: 12, fontWeight: 600, color: TYPE_COLORS[playbook.type] }}>{TYPE_LABELS[playbook.type]}</span>
                  </div>
                  <input
                    className="oa-pb-desc-input"
                    value={playbook.description || ''}
                    onChange={e => setPlaybook({ ...playbook, description: e.target.value })}
                    placeholder="Description (optional)"
                  />
                </div>
                <button className="sv-btn-primary" onClick={handleSaveMeta} disabled={!!saving} style={{ flexShrink: 0 }}>
                  {saving === 'meta' ? '⏳ Saving...' : '💾 Save'}
                </button>
              </div>

              {/* ── Sub-tabs: Stage Guidance | Plays by Role ──────── */}
              <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
                {[
                  { key: false, label: `${activeType?.icon || '📋'} Stage Guidance` },
                  { key: true,  label: '🎭 Plays by Role' },
                ].map(t => (
                  <button
                    key={String(t.key)}
                    onClick={() => setShowPlaysTab(t.key)}
                    style={{
                      padding: '8px 16px', background: 'none', border: 'none',
                      borderBottom: `3px solid ${showPlaysTab === t.key ? (activeType?.color || '#3b82f6') : 'transparent'}`,
                      color: showPlaysTab === t.key ? (activeType?.color || '#3b82f6') : '#6b7280',
                      fontWeight: showPlaysTab === t.key ? 600 : 400,
                      fontSize: 13, cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* ── Plays by Role sub-tab ──────────────────────── */}
              {showPlaysTab && (
                <PlaybookPlaysEditor playbookId={playbook.id} />
              )}

              {/* ── Stage Guidance sub-tab ─────────────────────── */}
              {!showPlaysTab && (
              <>
              {/* Company context — sales playbooks only */}
              {typeFilter === 'sales' && playbook.content && (
                <div className="sv-card" style={{ marginBottom: 16 }}>
                  <div className="oa-pb-section-header" onClick={() => setShowCompany(v => !v)}>
                    <span>🏢 Company Context</span>
                    {!showCompany && (playbook.content?.company?.name || playbook.content?.company?.industry || playbook.content?.company?.product) && (
                      <span className="oa-pb-summary">
                        {[playbook.content.company.name, playbook.content.company.industry, playbook.content.company.product].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', color: '#a0aec0' }}>{showCompany ? '▲' : '▼'}</span>
                  </div>
                  {showCompany && (
                    <div style={{ marginTop: 14 }}>
                      {['name', 'industry', 'product'].map(field => (
                        <div key={field} className="sv-field" style={{ marginBottom: 12 }}>
                          <label style={{ textTransform: 'capitalize' }}>{field}</label>
                          <input className="sv-input"
                            value={playbook.content?.company?.[field] || ''}
                            onChange={e => setPlaybook({ ...playbook, content: { ...playbook.content, company: { ...playbook.content.company, [field]: e.target.value } } })} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Stage guidance — driven by live stages */}
              <div className="sv-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h4 style={{ margin: 0, fontSize: 15, color: activeType?.color || undefined }}>
                    {activeType?.icon || '📋'} {activeType?.label || 'Stage'} Guidance
                  </h4>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>
                    {isProspecting ? 'Stages from Prospect Stages tab'
                      : isSalesType ? 'Stages from Deal Stages tab'
                      : isService   ? 'Service case status stages'
                      : isCLM ? 'CLM contract lifecycle stages'
                      : `Stages from ${activeType?.label || typeFilter} Stages tab`}
                    {' · save each stage individually'}
                  </span>
                </div>

                {activeStagesLoading ? (
                  <div className="sv-loading" style={{ padding: 16 }}>Loading stages…</div>
                ) : activeLiveStages.length === 0 ? (
                  <div className="sv-empty">
                    No active pipeline stages found. {isProspecting ? 'Add stages in the Prospect Stages tab.' : isSalesType ? 'Add stages in the Deal Stages tab.' : 'Add stages in Org Settings → Playbook Stages.'}
                  </div>
                ) : (
                  <div className="sv-stages-list">
                    {activeLiveStages.map((stage, i) => {
                      const stageType = stage.stage_type;  // semantic label for display only
                      const stageKey  = stage.key;              // guidance lookup key
                      const g         = guidance[stageKey] || {};
                      const isOpen    = editingStage === stage.id;
                      const isSaving  = saving === stageKey;
                      const hasGuidance = !!(g.goal || (g.key_actions?.length));

                      return (
                        <div key={stage.id} className="sv-stage-row">
                          <div className="sv-stage-header"
                            onClick={() => setEditingStage(isOpen ? null : stage.id)}>
                            <span className="sv-stage-num" style={typeFilter !== 'sales' ? { background: (activeType?.color || TEAL) + '20', color: activeType?.color || TEAL } : undefined}>{i + 1}</span>
                            <span className="sv-stage-name">{stage.name}</span>
                            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 6 }}>
                              {stageType}
                            </span>
                            {hasGuidance && (
                              <span style={{ fontSize: 11, color: '#10b981', marginLeft: 8 }}>● guided</span>
                            )}
                            <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8, flex: 1 }}>
                              {g.goal?.substring(0, 55)}{g.goal?.length > 55 ? '…' : ''}
                            </span>
                            <span className="sv-expand-btn">{isOpen ? '▲' : '▼'}</span>
                          </div>

                          {isOpen && (
                            <div className="sv-stage-detail">
                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Goal</label>
                                <input className="sv-input"
                                  placeholder="What should the rep achieve in this stage?"
                                  value={g.goal || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'goal', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Timeline</label>
                                <input className="sv-input"
                                  placeholder="e.g. 1-2 weeks"
                                  value={g.timeline || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'timeline', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Email Response Time</label>
                                <input className="sv-input"
                                  placeholder="e.g. within 4 hours"
                                  value={g.email_response_time || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'email_response_time', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>Next Step</label>
                                <input className="sv-input"
                                  placeholder="e.g. Schedule technical deep-dive"
                                  value={g.next_step || ''}
                                  onChange={e => updateGuidanceField(stageKey, 'next_step', e.target.value)} />
                              </div>

                              <div className="sv-field" style={{ marginBottom: 10 }}>
                                <label>
                                  <input type="checkbox"
                                    checked={!!g.requires_proposal_doc}
                                    onChange={e => updateGuidanceField(stageKey, 'requires_proposal_doc', e.target.checked)}
                                    style={{ marginRight: 6 }} />
                                  Requires proposal document
                                </label>
                              </div>

                              {/* Key actions */}
                              <div className="sv-field" style={{ marginTop: 8 }}>
                                <label>Key Actions</label>
                                {(g.key_actions || []).map((action, ai) => (
                                  <div key={ai} className="oa-pb-action-row">
                                    <span className="oa-pb-action-num">{ai + 1}</span>
                                    <textarea
                                      className="sv-input oa-pb-action-textarea"
                                      value={action}
                                      rows={Math.max(1, Math.ceil(action.length / 60))}
                                      onChange={e => updateKeyAction(stageKey, ai, e.target.value)}
                                    />
                                    <button className="oa-pb-action-remove"
                                      onClick={() => removeKeyAction(stageKey, ai)}
                                      title="Remove">×</button>
                                  </div>
                                ))}
                                <button className="oa-pb-add-action" onClick={() => addKeyAction(stageKey)}>
                                  + Add action
                                </button>
                              </div>

                              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                                <button
                                  className="sv-btn-primary"
                                  onClick={() => handleSaveStage(stageKey, stageType)}
                                  disabled={!!saving}
                                >
                                  {isSaving ? '⏳ Saving…' : `💾 Save ${stage.name} guidance`}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}


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

const ICON_OPTIONS = ['📂', '🎧', '🔄', '🤝', '📞', '🚀', '💡', '🛡️', '📊', '🎓', '⚡', '🌐'];
const COLOR_PRESETS_PB = ['#3b82f6', '#0F9D8E', '#8b5cf6', '#ef4444', '#f59e0b', '#10b981', '#ec4899', '#6366f1', '#14b8a6', '#f97316', '#6b7280', '#1d4ed8'];

function OAPlaybookTypes() {
  const API   = process.env.REACT_APP_API_URL || '';
  const token = localStorage.getItem('token');

  const [types, setTypes]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showAdd, setShowAdd]   = useState(false);
  const [newType, setNewType]   = useState({ label: '', icon: '📂', color: '#6b7280' });
  const [adding, setAdding]     = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const flash = (type, msg) => {
    if (type === 'error') { setError(msg); setTimeout(() => setError(''), 4000); }
    else { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/org/admin/playbook-types`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        setTypes(data.playbook_types || []);
      } catch { flash('error', 'Failed to load playbook types'); }
      finally { setLoading(false); }
    })();
  }, [API, token]);

  const handleAdd = async () => {
    if (!newType.label.trim()) { flash('error', 'Label is required'); return; }
    setAdding(true);
    try {
      const key = newType.label.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      const res = await fetch(`${API}/org/admin/playbook-types`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label: newType.label.trim(), icon: newType.icon, color: newType.color }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      setTypes(data.playbook_types);
      setNewType({ label: '', icon: '📂', color: '#6b7280' });
      setShowAdd(false);
      flash('success', `"${newType.label.trim()}" type added ✓`);
    } catch (e) { flash('error', e.message); }
    finally { setAdding(false); }
  };

  const handleDelete = async (typeKey) => {
    const t = types.find(x => x.key === typeKey);
    if (!window.confirm(`Delete "${t?.label || typeKey}" playbook type? Playbooks of this type must be reassigned first.`)) return;
    setDeleting(typeKey);
    try {
      const res = await fetch(`${API}/org/admin/playbook-types/${typeKey}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed');
      setTypes(data.playbook_types);
      flash('success', `"${t?.label}" removed ✓`);
    } catch (e) { flash('error', e.message); }
    finally { setDeleting(null); }
  };

  if (loading) return <div className="sv-card"><div className="sv-loading" style={{ padding: 16 }}>Loading playbook types…</div></div>;

  return (
    <div className="sv-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>📋 Playbook Types</h3>
          <p className="sv-hint" style={{ margin: '4px 0 0' }}>Define the categories of playbooks your org uses. System types cannot be removed.</p>
        </div>
        <button className="sv-btn-primary" style={{ fontSize: 13, padding: '6px 14px' }} onClick={() => setShowAdd(true)}>
          + Add Type
        </button>
      </div>

      {error   && <div className="sv-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ marginBottom: 12 }}>{success}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {types.map(t => (
          <div key={t.key} style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
            background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb',
          }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{
              width: 14, height: 14, borderRadius: '50%', background: t.color,
              flexShrink: 0, border: '2px solid #fff', boxShadow: '0 0 0 1px #d1d5db',
            }} />
            <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{t.label}</span>
            <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{t.key}</span>
            {t.is_system ? (
              <span style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', padding: '2px 8px', borderRadius: 4 }}>System</span>
            ) : (
              <button
                onClick={() => handleDelete(t.key)}
                disabled={deleting === t.key}
                style={{
                  background: 'none', border: '1px solid #fca5a5', color: '#dc2626',
                  padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                }}
              >
                {deleting === t.key ? '…' : '✕ Remove'}
              </button>
            )}
          </div>
        ))}
      </div>

      {showAdd && (
        <div style={{ marginTop: 16, padding: 16, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
          <h4 style={{ margin: '0 0 12px', fontSize: 14 }}>Add New Playbook Type</h4>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="sv-field" style={{ flex: 1, minWidth: 160 }}>
              <label style={{ fontSize: 12 }}>Label</label>
              <input className="sv-input" placeholder="e.g. Customer Support"
                value={newType.label} onChange={e => setNewType(p => ({ ...p, label: e.target.value }))} />
            </div>
            <div className="sv-field" style={{ width: 80 }}>
              <label style={{ fontSize: 12 }}>Icon</label>
              <select className="sv-input" value={newType.icon} onChange={e => setNewType(p => ({ ...p, icon: e.target.value }))}>
                {ICON_OPTIONS.map(ic => <option key={ic} value={ic}>{ic}</option>)}
              </select>
            </div>
            <div className="sv-field">
              <label style={{ fontSize: 12 }}>Color</label>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {COLOR_PRESETS_PB.map(c => (
                  <button key={c} onClick={() => setNewType(p => ({ ...p, color: c }))} style={{
                    width: 22, height: 22, borderRadius: '50%', background: c, border: newType.color === c ? '2px solid #111' : '2px solid transparent',
                    cursor: 'pointer', padding: 0,
                  }} />
                ))}
              </div>
            </div>
          </div>

          {/* Preview */}
          {newType.label.trim() && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: '#fff', borderRadius: 6, border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>{newType.icon}</span>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: newType.color }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{newType.label}</span>
              <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
                {newType.label.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_')}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="sv-btn-primary" onClick={handleAdd} disabled={adding} style={{ fontSize: 13 }}>
              {adding ? 'Adding…' : '✓ Add Type'}
            </button>
            <button className="sv-btn sv-btn-secondary" onClick={() => setShowAdd(false)} style={{ fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── OADealRoles (Organization Roles) ──────────────────────────────────────────
// Lets org admins manage roles available across all playbooks and workflows.
// System roles can be toggled active/inactive but not renamed or deleted.
// Custom roles can be created, renamed, and deleted.

const API_OA = process.env.REACT_APP_API_URL || '';

function apiFetchOA(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API_OA}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

// Helper: try /org-roles, fall back to /deal-roles for backward compat
async function oaRolesApi(path, options) {
  try { return await apiFetchOA(`/org-roles${path}`, options); }
  catch { return await apiFetchOA(`/deal-roles${path}`, options); }
}

function OADealRoles() {
  const [roles,    setRoles]    = React.useState([]);
  const [loading,  setLoading]  = React.useState(true);
  const [error,    setError]    = React.useState('');
  const [success,  setSuccess]  = React.useState('');
  const [newName,  setNewName]  = React.useState('');
  const [adding,   setAdding]   = React.useState(false);
  const [editId,   setEditId]   = React.useState(null);
  const [editName, setEditName] = React.useState('');

  React.useEffect(() => {
    oaRolesApi('')
      .then(r => setRoles(r.roles || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function flash(type, msg) {
    if (type === 'success') { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); }
    else                    { setError(msg);   setTimeout(() => setError(''),   4000); }
  }

  async function handleToggle(role) {
    try {
      const r = await oaRolesApi(`/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !role.is_active }),
      });
      setRoles(prev => prev.map(ro => ro.id === role.id ? r.role : ro));
      flash('success', `${role.name} ${r.role.is_active ? 'activated' : 'deactivated'}`);
    } catch (e) { flash('error', e.message); }
  }

  async function handleRename(role) {
    if (!editName.trim() || editName.trim() === role.name) { setEditId(null); return; }
    try {
      const r = await oaRolesApi(`/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editName.trim() }),
      });
      setRoles(prev => prev.map(ro => ro.id === role.id ? r.role : ro));
      setEditId(null);
      flash('success', 'Role renamed');
    } catch (e) { flash('error', e.message); }
  }

  async function handleDelete(role) {
    if (!window.confirm(`Delete "${role.name}"? Team members with this role will have it cleared.`)) return;
    try {
      await oaRolesApi(`/${role.id}`, { method: 'DELETE' });
      setRoles(prev => prev.filter(ro => ro.id !== role.id));
      flash('success', 'Role deleted');
    } catch (e) { flash('error', e.message); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const r = await oaRolesApi('', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setRoles(prev => [...prev, r.role]);
      setNewName('');
      flash('success', 'Role created');
    } catch (e) { flash('error', e.message); }
    finally { setAdding(false); }
  }

  if (loading) return <div className="sv-loading">Loading roles…</div>;

  const systemRoles = roles.filter(r => r.is_system);
  const customRoles = roles.filter(r => !r.is_system);

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🎭 Organization Roles</h2>
          <p className="sv-panel-desc">
            Roles are used across your entire organization — in deal teams, prospecting playbooks,
            and any future workflows. Each playbook selects which roles are relevant via its ⚙ Roles config.
            System roles can be activated or deactivated. Custom roles can be renamed or deleted.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">✓ {success}</div>}

      <div className="sv-panel-body">

        {/* System roles */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>System Roles</h3>
            <p className="sv-hint">Built-in roles used across deals and prospecting. Toggle to hide from role pickers — cannot be renamed or deleted.</p>
            <div className="oa-roles-list">
              {systemRoles.map(role => (
                <div key={role.id} className={`oa-role-row ${!role.is_active ? 'oa-role-row--inactive' : ''}`}>
                  <div className="oa-role-row__info">
                    <span className="oa-role-row__name">{role.name}</span>
                    {!role.is_active && <span className="oa-role-row__tag">Inactive</span>}
                  </div>
                  <button
                    className={`sv-btn-sm ${role.is_active ? 'sv-btn-sm--danger' : 'sv-btn-sm--primary'}`}
                    onClick={() => handleToggle(role)}
                  >
                    {role.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Custom roles */}
        <div className="sv-section">
          <div className="sv-card">
            <h3>Custom Roles</h3>
            <p className="sv-hint">Create roles specific to your organisation's workflows. Click a name to rename it.</p>

            {customRoles.length === 0 && (
              <p className="sv-empty">No custom roles yet. Add one below.</p>
            )}

            <div className="oa-roles-list">
              {customRoles.map(role => (
                <div key={role.id} className="oa-role-row">
                  <div className="oa-role-row__info">
                    {editId === role.id ? (
                      <input
                        className="oa-input oa-input--inline"
                        value={editName}
                        autoFocus
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter')  handleRename(role);
                          if (e.key === 'Escape') setEditId(null);
                        }}
                        onBlur={() => handleRename(role)}
                      />
                    ) : (
                      <span
                        className="oa-role-row__name oa-role-row__name--editable"
                        onClick={() => { setEditId(role.id); setEditName(role.name); }}
                        title="Click to rename"
                      >
                        {role.name} ✏️
                      </span>
                    )}
                  </div>
                  <button
                    className="sv-btn-sm sv-btn-sm--danger"
                    onClick={() => handleDelete(role)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>

            {/* Add new custom role */}
            <div className="oa-role-add-row">
              <input
                className="oa-input"
                placeholder="New role name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
              <button
                className="sv-btn-primary"
                onClick={handleAdd}
                disabled={adding || !newName.trim()}
              >
                {adding ? '…' : '+ Add Role'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}



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
function OAModuleSeedPanel({ seedDone, seeding, seedMsg, onSeed, color, playbookName, playbookDesc }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Info card */}
      <div style={{
        background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10,
        padding: '20px 22px',
      }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 6 }}>
          🌱 GoWarm Sample Playbook
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px', lineHeight: 1.6 }}>
          Seed the <strong>{playbookName}</strong> — a pre-built set of plays built by the GoWarm team
          to give your org a running start. {playbookDesc}
        </p>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 18px', lineHeight: 1.5 }}>
          This is a <strong>one-time action</strong>. The playbook will appear in your Playbooks list where
          you can edit, rename, or clone it. Existing playbooks are not affected.
        </p>

        {seedDone ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8,
            background: color + '15', border: `1px solid ${color}40`,
            color, fontSize: 13, fontWeight: 600,
          }}>
            ✓ Sample playbook already seeded — find it in Playbooks
          </div>
        ) : (
          <button
            disabled={seeding}
            onClick={onSeed}
            style={{
              padding: '9px 22px', borderRadius: 8, border: 'none',
              background: color, color: '#fff',
              fontSize: 13, fontWeight: 600,
              cursor: seeding ? 'not-allowed' : 'pointer',
              opacity: seeding ? 0.7 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {seeding ? '⏳ Seeding…' : '🌱 Seed GoWarm Sample Playbook'}
          </button>
        )}

        {seedMsg && (
          <div style={{
            marginTop: 12, padding: '8px 14px', borderRadius: 7, fontSize: 13,
            background: seedMsg.startsWith('Error') ? '#fef2f2' : '#f0fdf4',
            color:      seedMsg.startsWith('Error') ? '#991b1b'  : '#166534',
            border:     `1px solid ${seedMsg.startsWith('Error') ? '#fecaca' : '#bbf7d0'}`,
          }}>
            {seedMsg}
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleSubTabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', marginBottom: 24 }}>
      {tabs.map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          padding: '9px 20px', fontSize: 13,
          fontWeight: active === key ? 600 : 400,
          color: active === key ? '#6366f1' : '#6b7280',
          background: 'none', border: 'none',
          borderBottom: active === key ? '2px solid #6366f1' : '2px solid transparent',
          cursor: 'pointer', marginBottom: -1,
        }}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Generic module General tab ───────────────────────────────────────
// Reusable enable/disable toggle for any module.
// moduleKey: 'contracts' | 'prospecting' | 'handovers' | 'service'
// toggleFn: async (enabled: bool) => Promise  (calls the relevant apiService method)
function OAModuleGeneral({ moduleKey, icon, label, desc, toggleFn }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => {
        const mods = r.data.org?.settings?.modules || {};
        setEnabled(mods[moduleKey] || false);
      })
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false));
  }, [moduleKey]);

  const handleToggle = async (newVal) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await toggleFn(newVal);
      setEnabled(newVal);
      setSuccess(`${label} ${newVal ? 'enabled' : 'disabled'} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      window.dispatchEvent(new CustomEvent('moduleToggle', { detail: { module: moduleKey, enabled: newVal } }));
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

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ fontSize: 28 }}>{icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Enable {label}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3 }}>{desc}</div>
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

      {enabled ? (
        <div style={{ padding: '12px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9, fontSize: 13, color: '#166534' }}>
          ✅ Module is active and visible to all members.
          {/* If module has extra sub-tabs, a hint to switch tabs */}
        </div>
      ) : (
        <div style={{ padding: '12px 16px', background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 13, color: '#6b7280' }}>
          Module is disabled. Enable it above to make it visible to your team.
          Existing data is preserved when re-enabled.
        </div>
      )}
    </div>
  );
}

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
        tabs={[['general', 'General'], ['ai', 'AI Settings'], ['playbook', 'Playbook']]}
        active={subTab}
        onChange={setSubTab}
      />

      {/* ── General sub-tab ── */}
      {subTab === 'general' && (
        <OAModuleGeneral
          moduleKey="prospecting"
          icon="🎯"
          label="Prospecting"
          desc="Enables the prospect pipeline, ICP scoring, outreach sequencing, and prospecting playbooks for your whole organisation."
          toggleFn={(enabled) => apiService.prospects.toggleModule(enabled)}
        />
      )}

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

function ToggleSwitch({ on, onChange, color = '#6366f1' }) {
  return (
    <div
      onClick={onChange}
      style={{
        flexShrink: 0, width: 44, height: 24, borderRadius: 12,
        background: on ? color : '#d1d5db',
        position: 'relative', cursor: 'pointer', transition: 'background .2s',
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3,
        left: on ? 23 : 3,
        transition: 'left .2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </div>
  );
}

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
