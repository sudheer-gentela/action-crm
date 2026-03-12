import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import ActionsSettings from './ActionsSettings';
import OutlookConnect from './OutlookConnect';
import GoogleConnect from './GoogleConnect';
import './SettingsView.css';
import DealHealthSettings from './DealHealthSettings';
import NotificationSettings from './NotificationSettings';

// ── Sidebar nav structure ────────────────────────────────────────────────────
// Each group has a label and items. Items with `children` expand inline.
// `adminOnly` items are visible to all but marked read-only for non-admins.
const NAV_GROUPS = [
  {
    group: 'Personal',
    items: [
      { id: 'alerts',       label: 'Alerts',            icon: '🔔' },
      {
        id: 'connections', label: 'Connections', icon: '🔗',
        children: [
          { id: 'connections-my',  label: 'My Connections'  },
          { id: 'connections-org', label: 'Org Connections', adminOnly: true },
        ],
      },
      { id: 'usage',        label: 'Usage & Billing',   icon: '📊' },
      { id: 'preferences',  label: 'My Preferences',    icon: '🎛️' },
    ],
  },
  {
    group: 'AI',
    items: [
      {
        id: 'ai', label: 'AI Settings', icon: '🤖',
        children: [
          { id: 'ai-prefs',   label: 'Preferences'  },
          { id: 'ai-prompts', label: 'Prompts', adminOnly: true },
          { id: 'ai-agent',   label: 'AI Agent'     },
        ],
      },
    ],
  },
  {
    group: 'Workflow',
    items: [
      { id: 'deal-health', label: 'Deal Health', icon: '🏥', adminOnly: true },
      { id: 'actions',     label: 'Actions',     icon: '⚡', adminOnly: true },
    ],
  },
];

// Flat map for reverse-lookup (child id → parent id)
const CHILD_PARENT = {};
NAV_GROUPS.forEach(g => g.items.forEach(item => {
  if (item.children) item.children.forEach(c => { CHILD_PARENT[c.id] = item.id; });
}));

export default function SettingsView({ initialTab }) {
  const orgRole  = sessionStorage.getItem('activeRole') || 'member';
  const isAdmin  = orgRole === 'org-admin' || orgRole === 'super-admin';
  const readOnly = !isAdmin;

  // Default to 'alerts' unless a specific tab is requested
  const [activeId,   setActiveId]   = useState(initialTab || 'alerts');
  // Track which parent groups are expanded { 'connections': true, 'ai': true }
  // Auto-expand the group containing initialTab if it's a child item
  function getInitialExpanded() {
    const state = { connections: true, ai: false };
    if (initialTab) {
      const parent = CHILD_PARENT[initialTab];
      if (parent) state[parent] = true;
    }
    return state;
  }
  const [expanded,   setExpanded]   = useState(getInitialExpanded);
  // Sidebar collapsed to icons (narrow/mobile)
  const [collapsed,  setCollapsed]  = useState(false);

  // Allow other parts of the app to navigate here with a specific sub-tab
  useEffect(() => {
    const handler = (e) => {
      if (!e.detail?.settingsTab) return;
      const id = e.detail.settingsTab;
      setActiveId(id);
      // Auto-expand parent if navigating to a child
      const parent = CHILD_PARENT[id];
      if (parent) setExpanded(prev => ({ ...prev, [parent]: true }));
    };
    window.addEventListener('navigate', handler);
    return () => window.removeEventListener('navigate', handler);
  }, []);

  function handleNavClick(item) {
    if (item.children) {
      // Toggle expansion and activate first child
      setExpanded(prev => ({ ...prev, [item.id]: !prev[item.id] }));
      if (!expanded[item.id]) {
        // Opening — jump to first child
        setActiveId(item.children[0].id);
      }
    } else {
      setActiveId(item.id);
      // Auto-expand parent group if this is a child
      const parent = CHILD_PARENT[item.id];
      if (parent) setExpanded(prev => ({ ...prev, [parent]: true }));
    }
  }

  // Determine active label + optional parent for breadcrumb
  function getActiveLabel() {
    for (const g of NAV_GROUPS) {
      for (const item of g.items) {
        if (item.id === activeId) return { icon: item.icon, label: item.label, parent: null };
        if (item.children) {
          const child = item.children.find(c => c.id === activeId);
          if (child) return { icon: item.icon, label: child.label, parent: item.label };
        }
      }
    }
    return { icon: '⚙️', label: 'Settings', parent: null };
  }

  const { icon: activeIcon, label: activeLabel, parent: activeParent } = getActiveLabel();

  return (
    <div className={`sv2-layout ${collapsed ? 'sv2-collapsed' : ''}`}>

      {/* ── Sidebar ── */}
      <nav className="sv2-sidebar">
        <div className="sv2-sidebar-header">
          <span className="sv2-sidebar-title">Settings</span>
          <button className="sv2-collapse-btn" onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '›' : '‹'}
          </button>
        </div>

        {NAV_GROUPS.map(group => (
          <div key={group.group} className="sv2-nav-group">
            {!collapsed && <div className="sv2-nav-group-label">{group.group}</div>}
            {group.items.map(item => {
              const isParentActive = item.id === activeId || (item.children && item.children.some(c => c.id === activeId));
              const isExpanded     = expanded[item.id];
              return (
                <div key={item.id}>
                  <button
                    className={`sv2-nav-item ${isParentActive ? 'active' : ''}`}
                    onClick={() => handleNavClick(item)}
                    title={collapsed ? item.label : undefined}
                  >
                    <span className="sv2-nav-icon">{item.icon}</span>
                    {!collapsed && (
                      <>
                        <span className="sv2-nav-label">{item.label}</span>
                        {item.adminOnly && <span className="sv2-nav-badge sv2-badge-admin">Admin</span>}
                        {item.children && (
                          <span className="sv2-nav-chevron">{isExpanded ? '▾' : '›'}</span>
                        )}
                      </>
                    )}
                  </button>
                  {/* Sub-items */}
                  {item.children && isExpanded && !collapsed && (
                    <div className="sv2-nav-children">
                      {item.children.map(child => (
                        <button
                          key={child.id}
                          className={`sv2-nav-child ${activeId === child.id ? 'active' : ''}`}
                          onClick={() => setActiveId(child.id)}
                        >
                          <span className="sv2-child-dot">›</span>
                          {child.label}
                          {child.adminOnly && <span className="sv2-nav-badge sv2-badge-admin">Admin</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── Main content ── */}
      <main className="sv2-content">
        <div className="sv2-page-header">
          {activeParent && (
            <div className="sv2-breadcrumb">{activeParent} <span className="sv2-breadcrumb-sep">›</span> {activeLabel}</div>
          )}
          <h1><span className="sv2-page-icon">{activeIcon}</span>{activeParent ? activeLabel : activeLabel}</h1>
        </div>

        <div className="sv2-pane">
          {/* Personal */}
          {activeId === 'alerts'           && <NotificationSettings />}
          {activeId === 'connections-my'   && <ConnectionsMy isAdmin={isAdmin} />}
          {activeId === 'connections-org'  && <IntegrationsSettings readOnly={readOnly} />}
          {activeId === 'usage'            && <UserAIUsageSettings />}
          {activeId === 'preferences'      && <UserPreferencesSettings />}
          {/* AI */}
          {activeId === 'ai-prefs'         && <AIPreferencesPanel />}
          {activeId === 'ai-prompts'       && <PromptsSettings readOnly={readOnly} />}
          {activeId === 'ai-agent'         && <AgentUserSettings />}
          {/* Workflow */}
          {activeId === 'deal-health'      && <DealHealthSettings readOnly={readOnly} />}
          {activeId === 'actions'          && <ActionsSettings readOnly={readOnly} />}
        </div>
      </main>
    </div>
  );
}

// ── ConnectionsMy — personal OAuth + outreach senders ────────────────────────
// Extracts the "My Connections" section from the old IntegrationsSettings
// so it can live under Personal > Connections > My Connections
function ConnectionsMy({ isAdmin }) {
  // Renders the personal OAuth connections (Outlook / Google)
  // The sender accounts section is owned by UserPreferencesSettings —
  // we embed a lightweight version here for discoverability
  return (
    <div>
      <IntegrationsSettings showPersonalOnly={true} />
    </div>
  );
}

// ── AIPreferencesPanel — provider + model + product context ──────────────────
// Extracts the Prospecting AI section from UserPreferencesSettings
// so it lives under AI > Preferences
function AIPreferencesPanel() {
  // The full AI prefs UI already lives inside UserPreferencesSettings.
  // Until we extract it, we render UserPreferencesSettings scoped to AI prefs only.
  // Pass a prop to let UserPreferencesSettings know to show only the AI section.
  return <UserPreferencesSettings showAIOnly={true} />;
}

// ════════════════════════════════════════════════════════════
// PROMPTS SETTINGS
// ════════════════════════════════════════════════════════════

const PROMPT_KEYS = [
  { key: 'email_analysis',                label: 'Email Analysis',              desc: 'Used when AI analyses incoming emails to generate actions and insights.' },
  { key: 'deal_health_check',             label: 'Deal Health Check',           desc: 'Used when AI scores a deal\'s health from transcript and email content.' },
  { key: 'prospecting_research_account',  label: 'Prospecting — Account',       desc: 'Stage 1: AI researches the company. Cached per account for 30 days. Use {{companyInfo}} and {{productContext}}.' },
  { key: 'prospecting_research',          label: 'Prospecting — Person',        desc: 'Stage 2: AI researches the individual using account context. Use {{prospectInfo}}, {{accountResearch}}, and {{productContext}}.' },
  { key: 'prospecting_draft',             label: 'Prospecting — Draft Email',   desc: 'Used when AI drafts an outreach email. Use {{prospectInfo}}, {{researchNotes}}, and {{productContext}}.' },
];

function PromptsSettings() {
  const [prompts, setPrompts]   = useState({});
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [activePrompt, setActivePrompt] = useState('email_analysis');

  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiService.prompts.get();
        setPrompts(r.data.prompts || {});
      } catch { setError('Failed to load prompts'); }
      finally { setLoading(false); }
    };
    load();
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true); setError(''); setSuccess('');
      await apiService.prompts.save({ prompts });
      setSuccess('Prompts saved ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch { setError('Failed to save prompts'); }
    finally { setSaving(false); }
  };

  const handleReset = async (key) => {
    if (!window.confirm('Reset this prompt to the default? Your customisation will be lost.')) return;
    try {
      await apiService.prompts.reset(key);
      const r = await apiService.prompts.get();
      setPrompts(r.data.prompts || {});
      setSuccess('Prompt reset to default ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch { setError('Failed to reset prompt'); }
  };

  if (loading) return <div className="sv-loading">Loading prompts...</div>;
  const meta = PROMPT_KEYS.find(p => p.key === activePrompt);

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🤖 AI Prompt Templates</h2>
          <p className="sv-panel-desc">Customise the instructions sent to Claude when analysing your deals.</p>
        </div>
        <button className="sv-btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '⏳ Saving...' : '💾 Save Prompts'}
        </button>
      </div>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}
      <div className="sv-panel-body">
        <div className="sv-prompt-tabs">
          {PROMPT_KEYS.map(p => (
            <button key={p.key} className={`sv-prompt-tab ${activePrompt === p.key ? 'active' : ''}`} onClick={() => setActivePrompt(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        {meta && (
          <div className="sv-section">
            <div className="sv-card">
              <div className="sv-prompt-header">
                <div>
                  <h3>{meta.label}</h3>
                  <p className="sv-hint">{meta.desc}</p>
                </div>
                <button className="sv-btn-secondary" onClick={() => handleReset(activePrompt)}>↺ Reset to Default</button>
              </div>
              <textarea
                className="sv-prompt-editor"
                value={prompts[activePrompt] || ''}
                onChange={e => setPrompts({ ...prompts, [activePrompt]: e.target.value })}
                spellCheck={false}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// INTEGRATIONS SETTINGS
// ════════════════════════════════════════════════════════════

function IntegrationsSettings({ readOnly = false, showPersonalOnly = false }) {
  const userId = JSON.parse(localStorage.getItem('user') || '{}').id;
  const orgRole  = sessionStorage.getItem('activeRole') || 'member';
  const isAdmin  = orgRole === 'org-admin' || orgRole === 'super-admin';
  // readOnly derived from props + role — used for future admin-gating
  const [orgIntegrations, setOrgIntegrations] = useState(null);

  useEffect(() => {
    apiService.orgAdmin.getIntegrations()
      .then(r => setOrgIntegrations(r.data.integrations || []))
      .catch(() => setOrgIntegrations([]));
  }, []);

  const getOrgStatus = (type) => {
    if (!orgIntegrations) return null;
    return orgIntegrations.find(i => i.integration_type === type);
  };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🔌 Integrations</h2>
          <p className="sv-panel-desc">Connect external accounts to sync emails, calendar, and cloud files.</p>
        </div>
      </div>
      <div className="sv-panel-body">
        <div className="sv-section">
          <h3 className="sv-section-heading">My Connections</h3>
          <p className="sv-hint" style={{ marginBottom: 16 }}>Connect your personal accounts. These connections are private to you.</p>

          <div className="sv-card sv-integration-card">
            <div className="sv-integration-header">
              <div className="sv-integration-logo">📧</div>
              <div>
                <h3>Microsoft Account</h3>
                <p className="sv-hint">Outlook email, calendar sync, and OneDrive file import.</p>
              </div>
            </div>
            <OutlookConnect userId={userId} />
            <div className="sv-integration-scopes">
              <p className="sv-hint"><strong>Permissions requested:</strong></p>
              <ul className="sv-scope-list">
                <li>📧 <strong>Mail.Read / Send</strong> — read and send Outlook email</li>
                <li>📅 <strong>Calendars.Read</strong> — sync calendar events</li>
                <li>☁️ <strong>Files.Read</strong> — browse and import OneDrive files</li>
                <li>👤 <strong>User.Read</strong> — identify your account</li>
              </ul>
            </div>
          </div>

          <div className="sv-card sv-integration-card" style={{ marginTop: 16 }}>
            <div className="sv-integration-header">
              <div className="sv-integration-logo">🟢</div>
              <div>
                <h3>Google Account</h3>
                <p className="sv-hint">Gmail, Google Calendar, and Google Drive.</p>
              </div>
            </div>
            <GoogleConnect userId={userId} />
            <div className="sv-integration-scopes">
              <p className="sv-hint"><strong>Permissions requested:</strong></p>
              <ul className="sv-scope-list">
                <li>📧 <strong>Gmail</strong> — read and send email</li>
                <li>📅 <strong>Calendar</strong> — view upcoming events</li>
                <li>📁 <strong>Drive</strong> — browse and import files</li>
                <li>👤 <strong>Profile</strong> — identify your account</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="sv-section" style={{ marginTop: 32 }}>
          <h3 className="sv-section-heading">Organisation Integrations</h3>
          <p className="sv-hint" style={{ marginBottom: 16 }}>
            {isAdmin
              ? 'Manage integrations enabled for your entire organisation. Go to Org Admin → Integrations for full control.'
              : 'Integrations enabled by your organisation admin.'}
          </p>
          <div className="sv-org-integrations-grid">
            {['microsoft', 'google'].map(type => {
              const integration = getOrgStatus(type);
              const enabled = integration?.status === 'active';
              const label = type === 'microsoft' ? 'Microsoft (Outlook/OneDrive)' : 'Google (Gmail/Drive/Calendar)';
              const icon = type === 'microsoft' ? '📧' : '🟢';
              return (
                <div key={type} className={`sv-org-integration-card ${enabled ? 'sv-org-int--active' : 'sv-org-int--inactive'}`}>
                  <span className="sv-org-int-icon">{icon}</span>
                  <div className="sv-org-int-info">
                    <div className="sv-org-int-name">{label}</div>
                    <div className={`sv-org-int-status ${enabled ? 'enabled' : 'disabled'}`}>
                      {enabled ? '✓ Enabled for org' : '○ Not configured'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {isAdmin && (
            <p className="sv-hint" style={{ marginTop: 12 }}>
              💡 Manage org-level integrations in the <strong>Org Admin → Integrations</strong> tab.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// AI AGENT
// ════════════════════════════════════════════════════════════

function AgentUserSettings() {
  const [agentStatus, setAgentStatus] = useState(null);
  const [tokenUsage, setTokenUsage]   = useState(null);
  const [loading, setLoading]         = useState(true);
  const [period, setPeriod]           = useState(30);

  useEffect(() => {
    (async () => {
      try {
        const [statusRes, usageRes] = await Promise.all([
          apiService.agent.getStatus(),
          apiService.agent.getTokenUsage(period),
        ]);
        setAgentStatus(statusRes.data);
        setTokenUsage(usageRes.data);
      } catch (e) {
        console.log('Agent user settings load:', e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [period]);

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading AI Agent settings…</div>;

  const orgEnabled = agentStatus?.enabled;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🤖 AI Agent</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>View your personal AI token usage and agent status.</p>
        </div>
      </div>
      <div className="sv-panel-body">
        {!orgEnabled && (
          <div style={{ padding: '14px 20px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#92400e' }}>⚠️ The AI Agent is not enabled for your organisation. Ask your admin to enable it in Org Admin → AI Agent.</div>
          </div>
        )}
        {orgEnabled && (
          <div style={{ padding: '14px 20px', background: '#d1fae5', border: '1px solid #a7f3d0', borderRadius: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#065f46' }}>🟢 AI Agent is active. Proposals will appear in your Agent Inbox for review and approval.</div>
          </div>
        )}
        {tokenUsage && (
          <div style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>
              🔢 Your AI Token Usage
              <select value={period} onChange={e => setPeriod(parseInt(e.target.value))}
                style={{ marginLeft: 12, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </h3>
            <div style={{ padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', gap: 32, flexWrap: 'wrap', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Total Tokens</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>{parseInt(tokenUsage.totals?.total_tokens || 0).toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Est. Cost</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>${parseFloat(tokenUsage.totals?.estimated_cost || 0).toFixed(4)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>API Calls</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#374151' }}>{parseInt(tokenUsage.totals?.call_count || 0).toLocaleString()}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MY PREFERENCES — outreach sender management + rotation
// ════════════════════════════════════════════════════════════

const PROVIDER_BADGE = {
  gmail:   { label: 'G', color: '#ea4335', bg: '#fef2f2' },
  outlook: { label: 'O', color: '#0078d4', bg: '#eff6ff' },
};

function ProviderPill({ provider }) {
  const cfg = PROVIDER_BADGE[provider] || { label: '?', color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}30`,
    }}>
      <span style={{ fontWeight: 800 }}>{cfg.label}</span>
      {provider === 'gmail' ? 'Gmail' : 'Outlook'}
    </span>
  );
}

const AI_MODELS = {
  anthropic: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, economical)' },
    { value: 'claude-sonnet-4-5-20251022', label: 'Claude Sonnet (balanced)' },
    { value: 'claude-opus-4-5-20251022', label: 'Claude Opus (most capable)' },
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

function UserPreferencesSettings({ showAIOnly = false }) {
  const [senders, setSenders]       = useState([]);
  const [orgLimits, setOrgLimits]   = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [flash, setFlash]           = useState(null); // { type: 'success'|'error', msg }
  const [connecting, setConnecting] = useState(null); // 'gmail'|'outlook'|null
  const [editingId, setEditingId]   = useState(null);
  const [editValues, setEditValues] = useState({});

  // ── Prospecting AI preferences ────────────────────────────────────────────
  const [aiPrefs, setAiPrefs]         = useState({
    ai_provider:     '',   // '' = use org default
    ai_model:        '',
    product_context: '',
  });
  const [orgAiDefaults, setOrgAiDefaults] = useState({});
  const [aiSaving, setAiSaving]           = useState(false);
  const [userResearchPrompt, setUserResearchPrompt] = useState('');
  const [userDraftPrompt, setUserDraftPrompt]       = useState('');

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  // ── Load senders + org limits ──────────────────────────────────────────────
  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const API   = process.env.REACT_APP_API_URL;
      const token = localStorage.getItem('token') || localStorage.getItem('authToken');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const [sendersRes, limitsRes, prefsRes, orgCfgRes, userPromptsRes] = await Promise.all([
        apiService.prospectingSenders.getAll(),
        apiService.prospectingSenders.getOrgLimits(),
        fetch(`${API}/users/me/preferences/prospecting`, { headers }).then(r => r.json()),
        fetch(`${API}/org/admin/prospecting/ai-config`, { headers }).then(r => r.json()),
        fetch(`${API}/prompts/user/prospecting`, { headers }).then(r => r.json()),
      ]);

      setSenders(sendersRes.data?.senders || []);
      setOrgLimits(limitsRes.data?.limits || null);

      // AI preferences
      const prospPrefs = prefsRes?.preferences || {};
      setAiPrefs({
        ai_provider:     prospPrefs.ai_provider     || '',
        ai_model:        prospPrefs.ai_model        || '',
        product_context: prospPrefs.product_context || '',
      });

      // Org defaults for placeholder text
      const orgCfg = orgCfgRes?.config || {};
      setOrgAiDefaults(orgCfg);

      // User prompt overrides
      setUserResearchPrompt(userPromptsRes?.prompts?.prospecting_research || '');
      setUserDraftPrompt(userPromptsRes?.prompts?.prospecting_draft       || '');

    } catch (e) {
      setError('Failed to load settings: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveAiPrefs = async () => {
    setAiSaving(true);
    try {
      const API   = process.env.REACT_APP_API_URL;
      const token = localStorage.getItem('token') || localStorage.getItem('authToken');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      // Save user_preferences (prospecting namespace)
      await fetch(`${API}/users/me/preferences/prospecting`, {
        method:  'PATCH',
        headers,
        body: JSON.stringify(aiPrefs),
      });

      // Save user prompt overrides
      await fetch(`${API}/prompts/user/prospecting`, {
        method:  'PUT',
        headers,
        body: JSON.stringify({
          prompts: { prospecting_research: userResearchPrompt, prospecting_draft: userDraftPrompt },
        }),
      });

      showFlash('success', 'AI preferences saved.');
    } catch (e) {
      showFlash('error', 'Failed to save AI preferences: ' + e.message);
    } finally {
      setAiSaving(false);
    }
  };

  useEffect(() => {
    loadData();

    // Re-load if user returns from OAuth flow
    const handleFocus = () => {
      if (document.URL.includes('prospecting_sender_connected')) loadData();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Also watch for the OAuth redirect param on mount
  useEffect(() => {
    if (window.location.search.includes('prospecting_sender_connected')) {
      loadData();
      // Clean the URL
      window.history.replaceState({}, '', window.location.pathname);
      showFlash('success', 'Sender account connected successfully!');
    }
  }, []);

  // ── Connect a new sender ──────────────────────────────────────────────────
  const handleConnect = async (provider) => {
    setConnecting(provider);
    try {
      const label = window.prompt(`Optional label for this ${provider === 'gmail' ? 'Gmail' : 'Outlook'} account (e.g. "Work email"):`) || '';
      const res = await apiService.prospectingSenders.getConnectUrl(provider, label);
      const { authUrl } = res.data;
      window.location.href = authUrl;
    } catch (e) {
      showFlash('error', 'Failed to start connection: ' + (e.response?.data?.error?.message || e.message));
      setConnecting(null);
    }
  };

  // ── Start editing a sender row ────────────────────────────────────────────
  const startEdit = (sender) => {
    setEditingId(sender.id);
    setEditValues({
      label:           sender.label || '',
      dailyLimit:      sender.dailyLimit ?? '',
      minDelayMinutes: sender.minDelayMinutes ?? '',
      isActive:        sender.isActive,
    });
  };

  const cancelEdit = () => { setEditingId(null); setEditValues({}); };

  const saveEdit = async (senderId) => {
    try {
      const payload = {
        label:           editValues.label || null,
        isActive:        editValues.isActive,
        dailyLimit:      editValues.dailyLimit !== '' ? parseInt(editValues.dailyLimit) : undefined,
        minDelayMinutes: editValues.minDelayMinutes !== '' ? parseInt(editValues.minDelayMinutes) : undefined,
      };
      await apiService.prospectingSenders.update(senderId, payload);
      showFlash('success', 'Sender account updated.');
      setEditingId(null);
      loadData();
    } catch (e) {
      showFlash('error', e.response?.data?.error?.message || 'Failed to save changes.');
    }
  };

  // ── Remove a sender ───────────────────────────────────────────────────────
  const handleRemove = async (sender) => {
    if (!window.confirm(`Remove ${sender.email} from outreach? Sent email history is preserved.`)) return;
    try {
      await apiService.prospectingSenders.remove(sender.id);
      showFlash('success', `${sender.email} removed.`);
      loadData();
    } catch (e) {
      showFlash('error', 'Failed to remove sender: ' + e.message);
    }
  };

  if (loading) return <div className="sv-panel"><div style={{ padding: 32, color: '#6b7280' }}>Loading preferences…</div></div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🎛️ My Preferences</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Personal settings saved to your account and shared across devices.
          </p>
        </div>
      </div>

      {flash && (
        <div style={{
          margin: '0 0 12px', padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
          color:      flash.type === 'success' ? '#065f46'  : '#991b1b',
          border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {error && <div className="sv-error">⚠️ {error}</div>}

      <div className="sv-panel-body">

        {/* ── Outreach Sender Accounts ─────────────────────────────────────── */}
        {!showAIOnly && <div className="sv-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <h3 className="sv-section-heading" style={{ margin: 0 }}>📧 Outreach Sender Accounts</h3>
              <p className="sv-hint" style={{ margin: '4px 0 0' }}>
                Email accounts used exclusively for prospecting outreach. Separate from your main email integration.
              </p>
            </div>
          </div>

          {/* Org limits reminder */}
          {orgLimits && (
            <div style={{
              padding: '10px 14px', background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#64748b',
            }}>
              <strong>Org limits:</strong> max {orgLimits.dailyLimitCeiling} emails/day per account ·
              min {orgLimits.minDelayMinutesCeiling}min between sends.
              Individual account limits apply up to these ceilings.
            </div>
          )}

          {/* Sender accounts list */}
          {senders.length === 0 ? (
            <div style={{
              padding: '32px 24px', textAlign: 'center', background: '#f9fafb',
              borderRadius: 10, border: '1px dashed #d1d5db',
            }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>No outreach accounts yet</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
                Connect a Gmail or Outlook account to send prospecting emails directly from Action CRM.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {senders.map(sender => (
                <div key={sender.id} style={{
                  border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px',
                  background: sender.isActive ? '#fff' : '#f9fafb',
                  opacity: sender.isActive ? 1 : 0.7,
                }}>
                  {editingId === sender.id ? (
                    // ── Edit mode ───────────────────────────────────────────
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <ProviderPill provider={sender.provider} />
                        <strong style={{ fontSize: 14 }}>{sender.email}</strong>
                      </div>
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Label</label>
                          <input
                            type="text"
                            value={editValues.label}
                            onChange={e => setEditValues(p => ({ ...p, label: e.target.value }))}
                            placeholder="e.g. Work"
                            style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                          />
                        </div>
                        <div style={{ width: 110 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                            Daily limit{orgLimits ? ` (max ${orgLimits.dailyLimitCeiling})` : ''}
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={orgLimits?.dailyLimitCeiling || 500}
                            value={editValues.dailyLimit}
                            onChange={e => setEditValues(p => ({ ...p, dailyLimit: e.target.value }))}
                            placeholder={`${orgLimits?.defaultDailyLimit || 50}`}
                            style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                          />
                        </div>
                        <div style={{ width: 130 }}>
                          <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                            Min delay (min){orgLimits ? ` (min ${orgLimits.minDelayMinutesCeiling})` : ''}
                          </label>
                          <input
                            type="number"
                            min={orgLimits?.minDelayMinutesCeiling || 0}
                            value={editValues.minDelayMinutes}
                            onChange={e => setEditValues(p => ({ ...p, minDelayMinutes: e.target.value }))}
                            placeholder={`${orgLimits?.defaultMinDelayMinutes || 5}`}
                            style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={editValues.isActive}
                            onChange={e => setEditValues(p => ({ ...p, isActive: e.target.checked }))}
                          />
                          Active (include in rotation)
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => saveEdit(sender.id)}
                          style={{ padding: '6px 16px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          style={{ padding: '6px 16px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    // ── View mode ───────────────────────────────────────────
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <ProviderPill provider={sender.provider} />
                          <strong style={{ fontSize: 14, color: '#1a202c' }}>{sender.email}</strong>
                          {sender.label && (
                            <span style={{ fontSize: 11, padding: '1px 7px', background: '#f3f4f6', borderRadius: 10, color: '#6b7280' }}>
                              {sender.label}
                            </span>
                          )}
                          {!sender.isActive && (
                            <span style={{ fontSize: 11, padding: '1px 7px', background: '#fef3c7', borderRadius: 10, color: '#92400e' }}>
                              Paused
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280' }}>
                          <span>
                            <strong style={{ color: '#374151' }}>{sender.emailsSentToday ?? 0}</strong>
                            {sender.dailyLimit ? ` / ${sender.dailyLimit}` : ''} sent today
                          </span>
                          {sender.minDelayMinutes != null && (
                            <span>{sender.minDelayMinutes}min gap</span>
                          )}
                          {sender.lastSentAt && (
                            <span>Last sent {new Date(sender.lastSentAt).toLocaleDateString()}</span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={() => startEdit(sender)}
                          style={{ padding: '5px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRemove(sender)}
                          style={{ padding: '5px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#dc2626', cursor: 'pointer' }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Connect new account buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={() => handleConnect('gmail')}
              disabled={connecting === 'gmail'}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 16px', border: '1px solid #ea4335', borderRadius: 8,
                background: connecting === 'gmail' ? '#fef2f2' : '#fff',
                color: '#ea4335', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 16 }}>G</span>
              {connecting === 'gmail' ? 'Connecting…' : 'Connect Gmail'}
            </button>
            <button
              onClick={() => handleConnect('outlook')}
              disabled={connecting === 'outlook'}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 16px', border: '1px solid #0078d4', borderRadius: 8,
                background: connecting === 'outlook' ? '#eff6ff' : '#fff',
                color: '#0078d4', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 16 }}>⊞</span>
              {connecting === 'outlook' ? 'Connecting…' : 'Connect Outlook'}
            </button>
          </div>

          <p className="sv-hint" style={{ marginTop: 10 }}>
            These accounts are separate from your main Outlook/Gmail integration and are used only for outreach.
            You can connect multiple accounts — they will be rotated automatically using the least-used strategy.
          </p>
        </div>}

        {/* ── Prospecting AI Preferences ──────────────────────────────────── */}
        <div className="sv-section" style={{ marginTop: showAIOnly ? 0 : 32 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h3 className="sv-section-heading" style={{ margin: 0 }}>🤖 Prospecting AI</h3>
              <p className="sv-hint" style={{ margin: '4px 0 0' }}>
                Personal AI settings for prospecting. Leave blank to use org defaults.
              </p>
            </div>
            <button
              onClick={saveAiPrefs}
              disabled={aiSaving}
              style={{ padding: '7px 18px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
            >
              {aiSaving ? '⏳ Saving…' : '💾 Save AI Prefs'}
            </button>
          </div>

          {/* AI Provider + Model */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                AI Provider <span style={{ color: '#9ca3af' }}>(org default: {orgAiDefaults.ai_provider || 'Anthropic'})</span>
              </label>
              <select
                value={aiPrefs.ai_provider}
                onChange={e => setAiPrefs(p => ({ ...p, ai_provider: e.target.value, ai_model: '' }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
              >
                <option value="">Use org default</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI (GPT)</option>
                <option value="gemini">Google (Gemini)</option>
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                Model <span style={{ color: '#9ca3af' }}>(org default: {orgAiDefaults.ai_model || 'Claude Haiku'})</span>
              </label>
              <select
                value={aiPrefs.ai_model}
                onChange={e => setAiPrefs(p => ({ ...p, ai_model: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
              >
                <option value="">Use org default</option>
                {(AI_MODELS[aiPrefs.ai_provider] || AI_MODELS.anthropic).map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Product context */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
              What you sell / your pitch context
              <span style={{ color: '#9ca3af' }}> — personal override (leave blank to use org default)</span>
            </label>
            <textarea
              value={aiPrefs.product_context}
              onChange={e => setAiPrefs(p => ({ ...p, product_context: e.target.value }))}
              rows={3}
              placeholder={orgAiDefaults.product_context || 'e.g. I sell revenue operations software to B2B SaaS companies. Key pain: manual reporting and siloed data…'}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>

          {/* Prompt overrides */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
              Research prompt override
              <span style={{ color: '#9ca3af' }}> — leave blank to use org/system default. Use <code>{'{{prospectInfo}}'}</code> as placeholder.</span>
            </label>
            <textarea
              value={userResearchPrompt}
              onChange={e => setUserResearchPrompt(e.target.value)}
              rows={4}
              placeholder="Leave blank to use org default…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>
              Draft email prompt override
              <span style={{ color: '#9ca3af' }}> — leave blank to use org/system default. Use <code>{'{{prospectInfo}}'}</code> and <code>{'{{researchNotes}}'}</code>.</span>
            </label>
            <textarea
              value={userDraftPrompt}
              onChange={e => setUserDraftPrompt(e.target.value)}
              rows={4}
              placeholder="Leave blank to use org default…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box' }}
            />
          </div>
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UserAIUsageSettings — per-user AI token usage dashboard
// ─────────────────────────────────────────────────────────────────────────────
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function UserAIUsageSettings() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { Authorization: `Bearer ${token}` };

  const [days,    setDays]    = useState(30);
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/users/me/ai-usage?days=${days}`, { headers })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError('Failed to load usage data'); setLoading(false); });
  }, [days]); // eslint-disable-line

  const panelStyle = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 24px', marginBottom: 16 };
  const statBoxStyle = { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 18px', flex: 1, minWidth: 140 };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📊 My AI Usage</h2>
          <p className="sv-panel-desc">Token usage across all AI features — research, drafts, deal analysis, and more.</p>
        </div>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      <div className="sv-panel-body">
        {loading && <div style={{ color: '#9ca3af', fontSize: 13, padding: 16 }}>Loading…</div>}
        {error   && <div style={{ color: '#dc2626', fontSize: 13, padding: 16 }}>{error}</div>}
        {!loading && !error && data && (<>

          {/* Summary stats */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            {[
              { label: 'Total Tokens',  value: fmtTokens(data.totals?.total_tokens),  sub: `${data.totals?.call_count || 0} calls` },
              { label: 'Est. Cost',     value: data.totals?.estimated_cost > 0 ? '$' + parseFloat(data.totals.estimated_cost).toFixed(2) : '$0.00' },
              { label: 'Avg / Call',    value: data.totals?.call_count > 0 ? fmtTokens(Math.round(data.totals.total_tokens / data.totals.call_count)) : '—' },
            ].map(s => (
              <div key={s.label} style={statBoxStyle}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{s.value}</div>
                {s.sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* By module */}
          {(data.byModule || []).length > 0 && (
            <div style={panelStyle}>
              <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 600, color: '#111827' }}>By Module</h3>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(data.byModule || []).map(m => {
                  const moduleColor = m.module === 'prospecting' ? '#0F9D8E' : m.module === 'deals' ? '#6366f1' : '#9ca3af';
                  return (
                    <div key={m.module} style={{ flex: '1 1 130px', background: '#f9fafb', border: `2px solid ${moduleColor}`, borderRadius: 10, padding: '12px 16px' }}>
                      <div style={{ fontSize: 11, color: moduleColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{m.label}</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#111827' }}>{fmtTokens(m.total_tokens)}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{m.call_count} calls · {m.estimated_cost > 0 ? '$' + parseFloat(m.estimated_cost).toFixed(3) : '$0.000'}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* By feature type */}
          {(data.byType || []).length > 0 && (() => {
            const LABELS = { action_generation: 'Action Generation', ai_enhancement: 'AI Enhancement', email_analysis: 'Email Analysis', deal_health_check: 'Deal Health Check', prospecting_research: 'Prospect Research', prospecting_research_account: 'Account Research', prospecting_draft: 'Draft Email', agent_proposal: 'Agent Proposal' };
            const maxT = (data.byType || []).reduce((m, r) => Math.max(m, parseInt(r.total_tokens)||0), 0);
            return (
              <div style={panelStyle}>
                <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 600, color: '#111827' }}>Usage by Feature</h3>
                {(data.byType || []).map(row => {
                  const pct = maxT > 0 ? Math.round((parseInt(row.total_tokens)||0) / maxT * 100) : 0;
                  return (
                    <div key={row.call_type} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ fontWeight: 500, color: '#374151' }}>{LABELS[row.call_type] || row.call_type}</span>
                        <span style={{ color: '#6b7280' }}>{fmtTokens(row.total_tokens)} · {row.call_count} calls</span>
                      </div>
                      <div style={{ height: 6, background: '#f3f4f6', borderRadius: 3 }}>
                        <div style={{ height: 6, borderRadius: 3, background: '#0F9D8E', width: `${pct}%`, transition: 'width .4s' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* By call type */}
          {(data.daily || []).length > 0 && (
            <div style={panelStyle}>
              <h3 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 600, color: '#111827' }}>Daily History</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    {['Date', 'Calls', 'Tokens', 'Est. Cost'].map(h => (
                      <th key={h} style={{ textAlign: h === 'Date' ? 'left' : 'right', padding: '5px 8px', color: '#9ca3af', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data.daily || []).slice(0, 14).map(row => (
                    <tr key={row.day} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '5px 8px', color: '#374151' }}>{row.day}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280' }}>{row.call_count}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#374151' }}>{fmtTokens(row.total_tokens)}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280' }}>{row.estimated_cost > 0 ? '$' + parseFloat(row.estimated_cost).toFixed(3) : '$0.000'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(!data.totals?.call_count || data.totals.call_count === 0) && (
            <div style={{ textAlign: 'center', padding: '48px 24px', color: '#9ca3af', fontSize: 14 }}>
              No AI usage recorded in this period yet.<br />
              <span style={{ fontSize: 12 }}>Use Research, AI Draft, Deal Analysis, or other AI features to see usage here.</span>
            </div>
          )}
        </>)}
      </div>
    </div>
  );
}
