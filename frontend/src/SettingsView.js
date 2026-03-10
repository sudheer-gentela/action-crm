import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import ActionsSettings from './ActionsSettings';
import OutlookConnect from './OutlookConnect';
import GoogleConnect from './GoogleConnect';
import './SettingsView.css';
import DealHealthSettings from './DealHealthSettings';
import NotificationSettings from './NotificationSettings';

// ── Sub-imports for existing editors ────────────────────────
// SettingsView hosts the content directly — no modal wrappers needed

// ── Top-level Settings Tabs ──────────────────────────────────

const SETTINGS_TABS = [
  { id: 'integrations', label: 'Integrations',    icon: '🔌' },
  { id: 'health',       label: 'Deal Health',     icon: '🏥' },
  { id: 'prompts',      label: 'AI Prompts',      icon: '🤖' },
  { id: 'actions',      label: 'Actions',         icon: '🎯' },
  { id: 'ai-agent',     label: 'AI Agent',        icon: '🤖' },
  { id: 'notifications',label: 'Notifications',   icon: '🔔' },
  { id: 'preferences',  label: 'My Preferences',  icon: '🎛️' },
];


// ════════════════════════════════════════════════════════════
// SETTINGS VIEW
// ════════════════════════════════════════════════════════════

export default function SettingsView({ initialTab }) {
  const [settingsTab, setSettingsTab] = useState(initialTab || 'integrations');

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h1>Settings</h1>
        <p className="settings-subtitle">Configure how your CRM works across all deals</p>
      </div>

      {/* Top-level tab bar */}
      <div className="settings-tabs">
        {SETTINGS_TABS.map(t => (
          <button
            key={t.id}
            className={`settings-tab ${settingsTab === t.id ? 'active' : ''}`}
            onClick={() => setSettingsTab(t.id)}
          >
            <span className="settings-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-body">
        {settingsTab === 'integrations' && <IntegrationsSettings />}
        {settingsTab === 'health'       && <DealHealthSettings readOnly={(sessionStorage.getItem('activeRole') || 'member') === 'member'} />}
        {settingsTab === 'prompts'      && <PromptsSettings />}
        {settingsTab === 'actions'      && <ActionsSettings />}
        {settingsTab === 'ai-agent'     && <AgentUserSettings />}
        {settingsTab === 'notifications'   && <NotificationSettings />}
        {settingsTab === 'preferences'  && <UserPreferencesSettings />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PROMPTS SETTINGS  (wraps existing PromptEditor logic)
// ════════════════════════════════════════════════════════════

const PROMPT_KEYS = [
  { key: 'email_analysis',    label: 'Email Analysis',    desc: 'Used when AI analyses incoming emails to generate actions and insights.' },
  { key: 'deal_health_check', label: 'Deal Health Check', desc: 'Used when AI scores a deal\'s health from transcript and email content.' },
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
          <p className="sv-panel-desc">Customise the instructions sent to Claude when analysing your deals. Use PLACEHOLDER variables — they are replaced automatically at runtime.</p>
        </div>
        <button className="sv-btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '⏳ Saving...' : '💾 Save Prompts'}
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">
        {/* Prompt selector */}
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
              <p className="sv-hint sv-hint-bottom">
                Available variables: <code>DEAL_NAME_PLACEHOLDER</code> · <code>DEAL_STAGE_PLACEHOLDER</code> · <code>CONTACT_NAME_PLACEHOLDER</code> · <code>EMAIL_THREAD_PLACEHOLDER</code> and more — see backend aiPrompts.js for full list.
              </p>
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

function IntegrationsSettings() {
  const userId = JSON.parse(localStorage.getItem('user') || '{}').id;
  const orgRole = sessionStorage.getItem('activeRole') || 'member';
  const isAdmin = orgRole === 'org-admin' || orgRole === 'super-admin';
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
        {/* ── My Connections ─────────────────────────────────── */}
        <div className="sv-section">
          <h3 className="sv-section-heading">My Connections</h3>
          <p className="sv-hint" style={{ marginBottom: 16 }}>
            Connect your personal accounts. These connections are private to you.
          </p>

          {/* Microsoft / Outlook */}
          <div className="sv-card sv-integration-card">
            <div className="sv-integration-header">
              <div className="sv-integration-logo">📧</div>
              <div>
                <h3>Microsoft Account</h3>
                <p className="sv-hint">
                  Outlook email, calendar sync, and OneDrive file import — all with a single sign-in.
                </p>
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

          {/* Google */}
          <div className="sv-card sv-integration-card" style={{ marginTop: 16 }}>
            <div className="sv-integration-header">
              <div className="sv-integration-logo">🟢</div>
              <div>
                <h3>Google Account</h3>
                <p className="sv-hint">
                  Gmail, Google Calendar, and Google Drive — all with a single sign-in.
                </p>
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

        {/* ── Org-level Integrations ────────────────────────── */}
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

// ─────────────────────────────────────────────────────────────────
// AI AGENT — personal preferences + token usage
// ─────────────────────────────────────────────────────────────────

function AgentUserSettings() {
  const [agentStatus, setAgentStatus]   = useState(null);
  const [tokenUsage, setTokenUsage]     = useState(null);
  const [loading, setLoading]           = useState(true);
  const [period, setPeriod]             = useState(30);

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
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            View your personal AI token usage and agent status.
          </p>
        </div>
      </div>

      <div className="sv-panel-body">
        {/* Org status */}
        {!orgEnabled && (
          <div style={{ padding: '14px 20px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#92400e' }}>
              ⚠️ The AI Agent is not enabled for your organisation. Ask your admin to enable it in Org Admin → AI Agent.
            </div>
          </div>
        )}

        {orgEnabled && (
          <div style={{ padding: '14px 20px', background: '#d1fae5', border: '1px solid #a7f3d0', borderRadius: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#065f46' }}>
              🟢 AI Agent is active. Proposals will appear in your Agent Inbox for review and approval.
            </div>
          </div>
        )}

        {/* Personal Token Usage */}
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

            {tokenUsage.byType?.length > 0 && (
              <div style={{ padding: '14px 20px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>Breakdown by Type</div>
                {tokenUsage.byType.map((t, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ fontWeight: 500 }}>{t.call_type.replace(/_/g, ' ')}</span>
                    <span style={{ color: '#6b7280' }}>
                      {parseInt(t.total_tokens).toLocaleString()} tokens · ${parseFloat(t.estimated_cost || 0).toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {(!tokenUsage.byType || tokenUsage.byType.length === 0) && (
              <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                No AI usage recorded yet. Usage will appear here as you generate actions, process emails, and use AI features.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════════════
// MY PREFERENCES — per-user UI settings stored in DB
// Covers: Actions view preferences (recently generated panel)
// ════════════════════════════════════════════════════════════

const ALL_RECENT_WINDOWS = [
  { value: '12h', label: 'Last 12 hours' },
  { value: '1d',  label: 'Last 1 day' },
  { value: '1w',  label: 'Last 1 week' },
];

function UserPreferencesSettings() {
  const [prefs,   setPrefs]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState('');
  const [error,   setError]   = useState('');

  // Load from backend on mount
  useEffect(() => {
    apiService.userPreferences.get()
      .then(data => setPrefs(data.preferences))
      .catch(() => setError('Failed to load preferences'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const data = await apiService.userPreferences.update(prefs);
      setPrefs(data.preferences);
      setSuccess('Saved ✓');
      setTimeout(() => setSuccess(''), 2500);
    } catch {
      setError('Failed to save preferences');
    } finally {
      setSaving(false);
    }
  }

  function toggleWindow(value) {
    const current = prefs.actions_recent_windows || [];
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    // Always keep at least one window
    if (next.length === 0) return;
    // Preserve canonical order
    const ordered = ALL_RECENT_WINDOWS.map(w => w.value).filter(v => next.includes(v));
    setPrefs(p => ({ ...p, actions_recent_windows: ordered }));
  }

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading preferences…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>🎛️ My Preferences</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Personal UI settings — saved to your account and shared across devices.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {success && <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 500 }}>{success}</span>}
          {error   && <span style={{ fontSize: 13, color: '#dc2626' }}>{error}</span>}
          <button className="sv-btn-primary" onClick={handleSave} disabled={saving || !prefs}>
            {saving ? '⏳ Saving…' : '💾 Save'}
          </button>
        </div>
      </div>

      {prefs && (
        <div className="sv-panel-body">

          {/* ── Actions — Recently Generated panel ── */}
          <div className="sv-section">
            <h3 className="sv-section-heading">⚡ Actions — Recently Generated</h3>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
              Controls the "🕐 Recent" panel that appears after generating actions,
              letting you verify what rules fired and what was created.
            </p>

            {/* Sparkline toggle */}
            <div className="sv-pref-row">
              <div className="sv-pref-info">
                <div className="sv-pref-label">Show activity sparkline</div>
                <div className="sv-pref-hint">
                  Displays a bar chart showing when actions were generated within the selected window.
                  Off by default — turn on if you want a visual activity summary.
                </div>
              </div>
              <label className="sv-toggle">
                <input
                  type="checkbox"
                  checked={!!prefs.actions_show_sparkline}
                  onChange={e => setPrefs(p => ({ ...p, actions_show_sparkline: e.target.checked }))}
                />
                <span className="sv-toggle-slider" />
              </label>
            </div>

            {/* Time window checkboxes */}
            <div className="sv-pref-row sv-pref-row--top">
              <div className="sv-pref-info">
                <div className="sv-pref-label">Visible time windows</div>
                <div className="sv-pref-hint">
                  Choose which time window options appear in the Recently Generated panel.
                  At least one must be selected.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ALL_RECENT_WINDOWS.map(w => (
                  <label key={w.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={(prefs.actions_recent_windows || []).includes(w.value)}
                      onChange={() => toggleWindow(w.value)}
                      disabled={
                        (prefs.actions_recent_windows || []).includes(w.value) &&
                        (prefs.actions_recent_windows || []).length === 1
                      }
                    />
                    {w.label}
                  </label>
                ))}
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
