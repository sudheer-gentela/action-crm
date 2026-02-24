import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import ActionsSettings from './ActionsSettings';
import OutlookConnect from './OutlookConnect';
import './SettingsView.css';
import DealHealthSettings from './DealHealthSettings';

// ── Sub-imports for existing editors ────────────────────────
// SettingsView hosts the content directly — no modal wrappers needed

// ── Top-level Settings Tabs ──────────────────────────────────

const SETTINGS_TABS = [
  { id: 'integrations', label: 'Integrations',  icon: '🔌' },
  { id: 'health',       label: 'Deal Health',   icon: '🏥' },
  { id: 'playbook',     label: 'Sales Playbook',icon: '📘' },
  { id: 'prompts',      label: 'AI Prompts',    icon: '🤖' },
  { id: 'actions',      label: 'Actions',       icon: '🎯' },
  { id: 'ai-agent',     label: 'AI Agent',      icon: '🤖' },
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
        {settingsTab === 'playbook'     && <PlaybookSettings />}
        {settingsTab === 'prompts'      && <PromptsSettings />}
        {settingsTab === 'actions'      && <ActionsSettings />}
        {settingsTab === 'ai-agent'     && <AgentUserSettings />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// DEAL HEALTH SETTINGS
// ════════════════════════════════════════════════════════════

function PlaybookSettings() {
  const [playbooks, setPlaybooks]       = useState([]);
  const [selectedId, setSelectedId]     = useState(null);
  const [playbook, setPlaybook]         = useState(null);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');
  const [success, setSuccess]           = useState('');
  const [showNewForm, setShowNewForm]   = useState(false);
  const [newPbData, setNewPbData]       = useState({ name: '', type: 'custom', description: '' });
  const [editingStage, setEditingStage] = useState(null);
  const [creating, setCreating]         = useState(false);
  const [deleting, setDeleting]         = useState(false);
  const [showCompany, setShowCompany]   = useState(false);

  const activeRole = sessionStorage.getItem('activeRole') || 'member';
  const canEdit    = activeRole === 'org-admin' || activeRole === 'super-admin';

  // Load playbook list
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const r = await apiService.playbooks.getAll();
        const list = r.data.playbooks || [];
        setPlaybooks(list);
        const def = list.find(p => p.is_default) || list[0];
        if (def) setSelectedId(def.id);
      } catch { setError('Failed to load playbooks'); }
      finally  { setLoading(false); }
    })();
  }, []);

  // Load selected playbook content
  useEffect(() => {
    if (!selectedId) return;
    setPlaybook(null);
    setEditingStage(null);
    (async () => {
      try {
        const r   = await apiService.playbooks.getById(selectedId);
        const raw = r.data.playbook;
        if (raw?.content?.stages && !raw.content.deal_stages) {
          raw.content.deal_stages = raw.content.stages;
          delete raw.content.stages;
        }
        setPlaybook(raw);
      } catch { setError('Failed to load playbook content'); }
    })();
  }, [selectedId]);

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 3000);
  };

  const handleSave = async () => {
    if (!playbook || !canEdit) return;
    setSaving(true);
    try {
      await apiService.playbooks.update(selectedId, { content: playbook.content });
      flash('success', 'Playbook saved ✓');
    } catch { flash('error', 'Failed to save playbook'); }
    finally  { setSaving(false); }
  };

  const handleSetDefault = async (id) => {
    if (!canEdit) return;
    try {
      await apiService.playbooks.setDefault(id);
      setPlaybooks(prev => prev.map(p => ({ ...p, is_default: p.id === id })));
      flash('success', 'Default playbook updated ✓');
    } catch { flash('error', 'Failed to set default'); }
  };

  const handleCreate = async () => {
    if (!newPbData.name.trim()) { flash('error', 'Name is required'); return; }
    setCreating(true);
    try {
      const r  = await apiService.playbooks.create({ ...newPbData, content: { deal_stages: {}, company: {} } });
      const nb = r.data.playbook;
      setPlaybooks(prev => [...prev, nb]);
      setSelectedId(nb.id);
      setShowNewForm(false);
      setNewPbData({ name: '', type: 'custom', description: '' });
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

  const stagesSource = playbook?.content?.deal_stages || playbook?.content?.stages;
  const stagesArray  = stagesSource
    ? Array.isArray(stagesSource)
      ? stagesSource
      : Object.entries(stagesSource).map(([id, val]) => ({ id, ...val }))
    : [];

  const updateStageField = (stageId, fieldKey, value) => {
    const ds = playbook.content.deal_stages;
    if (Array.isArray(ds)) {
      setPlaybook({ ...playbook, content: { ...playbook.content, deal_stages: ds.map(s => (s.id === stageId || s.name === stageId) ? { ...s, [fieldKey]: value } : s) } });
    } else {
      setPlaybook({ ...playbook, content: { ...playbook.content, deal_stages: { ...ds, [stageId]: { ...ds[stageId], [fieldKey]: value } } } });
    }
  };

  const TYPE_LABELS = { market: '\u{1F30D} Market', product: '\u{1F4E6} Product', custom: '\u2699\uFE0F Custom' };
  const TYPE_COLORS = { market: '#3182ce', product: '#38a169', custom: '#718096' };

  if (loading) return <div className="sv-loading">Loading playbooks...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📘 Sales Playbooks</h2>
          <p className="sv-panel-desc">Manage playbooks per market or product. Each deal can use a specific playbook; the default is used when none is selected.</p>
        </div>
        {canEdit && (
          <button className="sv-btn sv-btn-primary" onClick={() => setShowNewForm(true)}>+ New Playbook</button>
        )}
      </div>

      {error   && <div className="sv-alert sv-alert-error">{error}</div>}
      {success && <div className="sv-alert sv-alert-success">{success}</div>}

      {showNewForm && canEdit && (
        <div className="sv-card pb-new-form">
          <h4 style={{ marginTop: 0, marginBottom: 16 }}>New Playbook</h4>
          <div className="sv-form-grid">
            <div className="sv-field">
              <label>Name</label>
              <input className="sv-input" placeholder="e.g. EMEA Enterprise" value={newPbData.name}
                onChange={e => setNewPbData(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="sv-field">
              <label>Type</label>
              <select className="sv-input" value={newPbData.type} onChange={e => setNewPbData(p => ({ ...p, type: e.target.value }))}>
                <option value="market">🌍 Market</option>
                <option value="product">📦 Product</option>
                <option value="custom">⚙️ Custom</option>
              </select>
            </div>
          </div>
          <div className="sv-field" style={{ marginTop: 12 }}>
            <label>Description (optional)</label>
            <input className="sv-input" placeholder="e.g. For deals in EMEA region" value={newPbData.description}
              onChange={e => setNewPbData(p => ({ ...p, description: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="sv-btn sv-btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Playbook'}
            </button>
            <button className="sv-btn sv-btn-secondary" onClick={() => setShowNewForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="pb-layout">
        <div className="pb-sidebar">
          {playbooks.length === 0 ? (
            <div className="sv-empty">No playbooks yet</div>
          ) : playbooks.map(pb => (
            <div key={pb.id} className={`pb-list-item ${selectedId === pb.id ? 'active' : ''}`}
              onClick={() => setSelectedId(pb.id)}>
              <div className="pb-list-item-main">
                <span className="pb-list-name">{pb.name}</span>
                {pb.is_default && <span className="pb-default-star" title="Default">★</span>}
              </div>
              <div className="pb-list-meta">
                <span className="pb-type-badge" style={{ color: TYPE_COLORS[pb.type] }}>{TYPE_LABELS[pb.type]}</span>
              </div>
              {selectedId === pb.id && canEdit && (
                <div className="pb-list-actions">
                  {!pb.is_default && (
                    <button className="sv-btn-link" onClick={e => { e.stopPropagation(); handleSetDefault(pb.id); }}>Set default</button>
                  )}
                  {!pb.is_default && (
                    <button className="sv-btn-link sv-btn-danger" onClick={e => { e.stopPropagation(); handleDelete(pb.id); }} disabled={deleting}>Delete</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="pb-editor">
          {!playbook ? (
            <div className="sv-loading">Select a playbook...</div>
          ) : (
            <>
              <div className="pb-editor-header">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h3 style={{ margin: 0 }}>{playbook.name}</h3>
                    {playbook.is_default && <span className="pb-default-badge">Default</span>}
                    <span className="pb-type-badge" style={{ color: TYPE_COLORS[playbook.type] }}>{TYPE_LABELS[playbook.type]}</span>
                  </div>
                  {playbook.description && <p style={{ margin: '4px 0 0', color: '#718096', fontSize: 13 }}>{playbook.description}</p>}
                </div>
                {canEdit && (
                  <button className="sv-btn sv-btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? '⏳ Saving...' : '💾 Save'}
                  </button>
                )}
              </div>

              {!canEdit && (
                <div className="sv-alert" style={{ background: '#ebf8ff', borderColor: '#bee3f8', color: '#2b6cb0', marginBottom: 16 }}>
                  👁 View only — switch to Org Admin to edit playbooks
                </div>
              )}

              {playbook.content && (
                <div className="sv-card" style={{ marginBottom: 20 }}>
                  <div className="pb-company-header" onClick={() => setShowCompany(v => !v)}>
                    <span>🏢 Company Context</span>
                    {!showCompany && (playbook.content?.company?.name || playbook.content?.company?.industry || playbook.content?.company?.product) && (
                      <span className="pb-company-summary">
                        {[playbook.content.company.name, playbook.content.company.industry, playbook.content.company.product].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span className="sv-expand-btn" style={{ marginLeft: 'auto' }}>{showCompany ? '▲' : '▼'}</span>
                  </div>
                  {showCompany && (
                    <div style={{ marginTop: 14 }}>
                      {['name', 'industry', 'product'].map(field => (
                        <div key={field} className="sv-field" style={{ marginBottom: 12 }}>
                          <label style={{ textTransform: 'capitalize' }}>{field}</label>
                          <input className="sv-input"
                            value={playbook.content?.company?.[field] || ''}
                            disabled={!canEdit}
                            onChange={e => setPlaybook({ ...playbook, content: { ...playbook.content, company: { ...playbook.content.company, [field]: e.target.value } } })} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {stagesArray.length > 0 && (
                <div className="sv-card">
                  <h4 style={{ marginTop: 0, marginBottom: 16, fontSize: 15 }}>📋 Deal Stages</h4>
                  <div className="sv-stages-list">
                    {stagesArray.map((stage, i) => {
                      const stageId = stage.id || stage.name || String(i);
                      return (
                        <div key={stageId} className="sv-stage-row">
                          <div className="sv-stage-header" onClick={() => setEditingStage(editingStage === stageId ? null : stageId)}>
                            <span className="sv-stage-num">{i + 1}</span>
                            <span className="sv-stage-name">{stage.name || stageId}</span>
                            <span className="sv-hint sv-stage-goal">{stage.goal?.substring(0, 60)}{stage.goal?.length > 60 ? '…' : ''}</span>
                            <span className="sv-expand-btn">{editingStage === stageId ? '▲' : '▼'}</span>
                          </div>
                          {editingStage === stageId && (
                            <div className="sv-stage-detail">
                              {Object.entries(stage).filter(([k]) => k !== 'id' && k !== 'key_actions' && k !== 'success_criteria').map(([key, val]) => (
                                <div key={key} className="sv-field" style={{ marginBottom: 10 }}>
                                  <label style={{ textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</label>
                                  <input className="sv-input" value={val || ''} disabled={!canEdit} onChange={e => updateStageField(stageId, key, e.target.value)} />
                                </div>
                              ))}
                              {Array.isArray(stage.key_actions) && (
                                <div className="sv-field" style={{ marginTop: 8 }}>
                                  <label>Key Actions</label>
                                  {stage.key_actions.map((action, ai) => (
                                    <div key={ai} className="pb-action-row">
                                      <span className="pb-action-num">{ai + 1}</span>
                                      {canEdit ? (
                                        <textarea
                                          className="sv-input pb-action-textarea"
                                          value={action}
                                          rows={Math.max(1, Math.ceil(action.length / 60))}
                                          onChange={e => { const a = [...stage.key_actions]; a[ai] = e.target.value; updateStageField(stageId, 'key_actions', a); }}
                                        />
                                      ) : (
                                        <span className="pb-action-text">{action}</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {stagesArray.length === 0 && (
                <div className="sv-empty">No stages defined in this playbook yet.</div>
              )}
            </>
          )}
        </div>
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

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🔌 Integrations</h2>
          <p className="sv-panel-desc">Connect external accounts to sync emails, calendar, and cloud files.</p>
        </div>
      </div>

      <div className="sv-panel-body">
        {/* Microsoft / Outlook */}
        <div className="sv-section">
          <div className="sv-card sv-integration-card">
            <div className="sv-integration-header">
              <div className="sv-integration-logo">📧</div>
              <div>
                <h3>Microsoft Account</h3>
                <p className="sv-hint">
                  Connects Outlook email, calendar sync, and OneDrive file import — all with a single sign-in.
                </p>
              </div>
            </div>

            <OutlookConnect userId={userId} />

            <div className="sv-integration-scopes">
              <p className="sv-hint"><strong>Permissions requested:</strong></p>
              <ul className="sv-scope-list">
                <li>📧 <strong>Mail.Read</strong> — read your Outlook inbox</li>
                <li>📅 <strong>Calendars.Read</strong> — sync calendar events</li>
                <li>☁️ <strong>Files.Read</strong> — browse and import OneDrive files</li>
                <li>👤 <strong>User.Read</strong> — identify your account</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Google Drive — coming soon */}
        <div className="sv-section">
          <div className="sv-card sv-integration-card sv-integration-card--disabled">
            <div className="sv-integration-header">
              <div className="sv-integration-logo">🟢</div>
              <div>
                <h3>Google Drive <span className="sv-badge-soon">Coming soon</span></h3>
                <p className="sv-hint">Browse and import files from Google Drive into your deals.</p>
              </div>
            </div>
          </div>
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
