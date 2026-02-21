import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import ActionsSettings from './ActionsSettings';
import OutlookConnect from './OutlookConnect';
import './SettingsView.css';
import DealHealthSettings from './DealHealthSettings';

// ── Sub-imports for existing editors ────────────────────────
// SettingsView hosts the content directly — no modal wrappers needed

// ── Deal Health parameter definitions ───────────────────────

const CATEGORIES = [
  { id: 1, label: 'Close Date Credibility',     icon: '📅' },
  { id: 2, label: 'Buyer Engagement & Power',   icon: '👥' },
  { id: 3, label: 'Process Completion',         icon: '⚙️' },
  { id: 4, label: 'Deal Size Realism',          icon: '💰' },
  { id: 5, label: 'Competitive & Pricing Risk', icon: '🥊' },
  { id: 6, label: 'Momentum & Activity',        icon: '⚡' },
];

const PARAMS = [
  { key: '1a_close_confirmed',   cat: 1, label: 'Buyer-confirmed close date',          defaultWeight:  15, direction: 'positive', requiresAI: true,  auto: false, description: 'Close date has been explicitly confirmed by the buyer.', captureMethod: 'AI detected from transcript/email + manual checkbox' },
  { key: '1b_close_slipped',     cat: 1, label: 'Close date slipped',                  defaultWeight: -20, direction: 'negative', requiresAI: false, auto: true,  description: 'The expected close date has been pushed out at least once.', captureMethod: 'Automatic — tracked from deal history on every date change' },
  { key: '1c_buyer_event',       cat: 1, label: 'Close date tied to buyer event',      defaultWeight:  10, direction: 'positive', requiresAI: true,  auto: false, description: 'Close date is linked to a specific buyer-side event (e.g. board meeting, budget cycle).', captureMethod: 'AI detected from transcript/email + manual checkbox' },
  { key: '2a_economic_buyer',    cat: 2, label: 'Economic buyer identified',           defaultWeight:  20, direction: 'positive', requiresAI: false, auto: false, description: 'The person with budget authority has been identified and tagged as a contact.', captureMethod: 'User tags a contact as Economic Buyer. Falls back to Decision Maker role.' },
  { key: '2b_exec_meeting',      cat: 2, label: 'Exec meeting held',                   defaultWeight:  15, direction: 'positive', requiresAI: false, auto: true,  description: 'At least one meeting has been held with an executive-level contact.', captureMethod: 'Automatic — matches contact titles against exec title keyword list + calendar' },
  { key: '2c_multi_threaded',    cat: 2, label: 'Multi-threaded (>2 stakeholders)',    defaultWeight:  10, direction: 'positive', requiresAI: false, auto: true,  description: 'More than 2 meaningful stakeholders are engaged with the deal.', captureMethod: 'Automatic — counts contacts with meaningful roles' },
  { key: '3a_legal_engaged',     cat: 3, label: 'Legal / procurement engaged',         defaultWeight:  25, direction: 'positive', requiresAI: true,  auto: false, description: 'Legal or procurement team from the buyer side is actively involved.', captureMethod: 'Contact role tag + title keyword match + AI detection + manual flag' },
  { key: '3b_security_review',   cat: 3, label: 'Security / IT review started',        defaultWeight:  20, direction: 'positive', requiresAI: true,  auto: false, description: 'Security or IT team has initiated a review of the solution.', captureMethod: 'Contact role tag + title keyword match + AI detection + manual flag' },
  { key: '4a_value_vs_segment',  cat: 4, label: 'Deal value >2× segment average',     defaultWeight: -15, direction: 'negative', requiresAI: false, auto: true,  description: 'Deal value significantly exceeds typical segment size — may indicate unrealistic sizing.', captureMethod: 'Automatic — compares deal value against segment averages' },
  { key: '4b_deal_expanded',     cat: 4, label: 'Deal expanded in last 30 days',       defaultWeight:  15, direction: 'positive', requiresAI: false, auto: true,  description: 'The deal value has increased in the last 30 days — positive signal of growing scope.', captureMethod: 'Automatic — tracked from deal value history' },
  { key: '4c_scope_approved',    cat: 4, label: 'Buyer explicitly approved scope',     defaultWeight:  20, direction: 'positive', requiresAI: true,  auto: false, description: 'The buyer has explicitly agreed to the proposed scope.', captureMethod: 'AI detected from transcript/email + manual checkbox' },
  { key: '5a_competitive',       cat: 5, label: 'Competitive deal',                   defaultWeight: -20, direction: 'negative', requiresAI: true,  auto: true,  description: 'A known competitor is involved in this deal evaluation.', captureMethod: 'Automatic — AI scans emails/transcripts for competitor names from registry' },
  { key: '5b_price_sensitivity', cat: 5, label: 'Price sensitivity flagged',          defaultWeight: -15, direction: 'negative', requiresAI: true,  auto: false, description: 'The buyer has expressed concern about pricing or budget.', captureMethod: 'AI detected from transcript/email + manual checkbox' },
  { key: '5c_discount_pending',  cat: 5, label: 'Discount approval pending',          defaultWeight: -10, direction: 'negative', requiresAI: true,  auto: false, description: 'A discount request is in progress and awaiting internal approval.', captureMethod: 'AI detected from internal email + manual checkbox' },
  { key: '6a_no_meeting_14d',    cat: 6, label: 'No buyer meeting in last 14 days',   defaultWeight: -25, direction: 'negative', requiresAI: false, auto: true,  description: 'No meeting has been held with the buyer in the configured number of days.', captureMethod: 'Automatic — calculated from calendar meetings linked to the deal' },
  { key: '6b_slow_response',     cat: 6, label: 'Avg response time > historical norm',defaultWeight: -15, direction: 'negative', requiresAI: false, auto: true,  description: 'Email response times are slower than the historical average — may signal disengagement.', captureMethod: 'Automatic — calculated from email thread timestamps' },
];

const DEFAULT_WEIGHTS  = Object.fromEntries(PARAMS.map(p => [p.key, p.defaultWeight]));
const DEFAULT_ENABLED  = Object.fromEntries(PARAMS.map(p => [p.key, true]));

// ── Top-level Settings Tabs ──────────────────────────────────

const SETTINGS_TABS = [
  { id: 'integrations', label: 'Integrations',  icon: '🔌' },
  { id: 'health',       label: 'Deal Health',   icon: '🏥' },
  { id: 'playbook',     label: 'Sales Playbook',icon: '📘' },
  { id: 'prompts',      label: 'AI Prompts',    icon: '🤖' },
  { id: 'actions',      label: 'Actions',       icon: '🎯' },
];

// ── Deal Health inner tabs ───────────────────────────────────

const HEALTH_TABS = [
  { id: 'ai',          label: '🤖 AI Usage'        },
  { id: 'parameters',  label: '📋 Parameters'      },
  { id: 'weights',     label: '⚖️ Weights'         },
  { id: 'titles',      label: '🏷️ Title Keywords'  },
  { id: 'segments',    label: '📊 Segments'        },
  { id: 'competitors', label: '🥊 Competitors'     },
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
