import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import ActionsSettings from './ActionsSettings';
import OutlookConnect from './OutlookConnect';
import './SettingsView.css';

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
        {settingsTab === 'health'       && <DealHealthSettings />}
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

function DealHealthSettings() {
  const [healthTab, setHealthTab] = useState('ai');
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  // State
  const [aiEnabled, setAiEnabled]         = useState(true);
  const [paramsEnabled, setParamsEnabled] = useState(DEFAULT_ENABLED);
  const [expandedParam, setExpandedParam] = useState(null);
  const [catWeights, setCatWeights]       = useState({ close_date: 20, buyer_engagement: 25, process: 15, deal_size: 10, competitive: 15, momentum: 15 });
  const [paramWeights, setParamWeights]   = useState(DEFAULT_WEIGHTS);
  const [thresholds, setThresholds]       = useState({ healthy: 80, watch: 50 });
  const [titleKws, setTitleKws]           = useState({ exec: ['CEO','CTO','CFO','VP','SVP','EVP','President','Director'], legal: ['Legal','Counsel','Attorney','Contract','Compliance'], procurement: ['Procurement','Purchasing','Vendor','Sourcing'], security: ['CISO','Security','InfoSec','IT Director','Infrastructure'] });
  const [segments, setSegments]           = useState({ smb: 10000, midmarket: 35000, enterprise: 100000, multiplier: 2.0, noMeetingDays: 14, responseMultiplier: 1.5, multiThreadMin: 2 });
  const [competitors, setCompetitors]     = useState([]);
  const [newComp, setNewComp]             = useState({ name: '', aliases: '', website: '' });
  const [editComp, setEditComp]           = useState(null);

  const catWeightTotal   = Object.values(catWeights).reduce((a, b) => a + Number(b), 0);
  const aiRequiredParams = PARAMS.filter(p => p.requiresAI && paramsEnabled[p.key] !== false);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const [cfgRes, compRes] = await Promise.all([
        apiService.healthConfig.get(),
        apiService.competitors.getAll(),
      ]);
      const c = cfgRes.data.config;
      setAiEnabled(c.ai_enabled !== false);
      setCatWeights({ close_date: c.weight_close_date, buyer_engagement: c.weight_buyer_engagement, process: c.weight_process, deal_size: c.weight_deal_size, competitive: c.weight_competitive, momentum: c.weight_momentum });
      setParamWeights({ ...DEFAULT_WEIGHTS, ...(c.param_weights || {}) });
      setParamsEnabled({ ...DEFAULT_ENABLED, ...(c.params_enabled || {}) });
      setThresholds({ healthy: c.threshold_healthy, watch: c.threshold_watch });
      setTitleKws({ exec: c.exec_titles || [], legal: c.legal_titles || [], procurement: c.procurement_titles || [], security: c.security_titles || [] });
      setSegments({ smb: c.segment_avg_smb, midmarket: c.segment_avg_midmarket, enterprise: c.segment_avg_enterprise, multiplier: c.segment_size_multiplier, noMeetingDays: c.no_meeting_days, responseMultiplier: c.response_time_multiplier, multiThreadMin: c.multi_thread_min_contacts });
      setCompetitors(compRes.data.competitors || []);
    } catch { setError('Failed to load configuration'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    if (healthTab !== 'competitors' && catWeightTotal !== 100) {
      setError(`Category weights must sum to 100 (currently ${catWeightTotal})`); return;
    }
    try {
      setSaving(true); setError(''); setSuccess('');
      await apiService.healthConfig.save({ aiEnabled, paramsEnabled, weightCloseDate: catWeights.close_date, weightBuyerEngagement: catWeights.buyer_engagement, weightProcess: catWeights.process, weightDealSize: catWeights.deal_size, weightCompetitive: catWeights.competitive, weightMomentum: catWeights.momentum, paramWeights, thresholdHealthy: thresholds.healthy, thresholdWatch: thresholds.watch, execTitles: titleKws.exec, legalTitles: titleKws.legal, procurementTitles: titleKws.procurement, securityTitles: titleKws.security, segmentAvgSmb: segments.smb, segmentAvgMidmarket: segments.midmarket, segmentAvgEnterprise: segments.enterprise, segmentSizeMultiplier: segments.multiplier, noMeetingDays: segments.noMeetingDays, responseTimeMultiplier: segments.responseMultiplier, multiThreadMinContacts: segments.multiThreadMin });
      setSuccess('Configuration saved ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) { setError(e.response?.data?.error?.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  const handleAddCompetitor    = async () => {
    if (!newComp.name.trim()) return;
    try {
      const aliases = newComp.aliases.split(',').map(a => a.trim()).filter(Boolean);
      const r = await apiService.competitors.create({ ...newComp, aliases });
      setCompetitors([...competitors, r.data.competitor]);
      setNewComp({ name: '', aliases: '', website: '' });
    } catch { setError('Failed to add competitor'); }
  };
  const handleDeleteCompetitor = async (id) => { try { await apiService.competitors.delete(id); setCompetitors(competitors.filter(c => c.id !== id)); } catch { setError('Failed to delete'); } };
  const handleSaveCompetitor   = async () => {
    try {
      const aliases = typeof editComp.aliases === 'string' ? editComp.aliases.split(',').map(a => a.trim()).filter(Boolean) : editComp.aliases;
      const r = await apiService.competitors.update(editComp.id, { ...editComp, aliases });
      setCompetitors(competitors.map(c => c.id === editComp.id ? r.data.competitor : c));
      setEditComp(null);
    } catch { setError('Failed to save'); }
  };

  const updateTitleKw = (type, idx, val) => { const arr = [...titleKws[type]]; arr[idx] = val; setTitleKws({ ...titleKws, [type]: arr }); };
  const removeTitleKw = (type, idx)      => setTitleKws({ ...titleKws, [type]: titleKws[type].filter((_, i) => i !== idx) });
  const addTitleKw    = (type)           => setTitleKws({ ...titleKws, [type]: [...titleKws[type], ''] });

  if (loading) return <div className="sv-loading">Loading health configuration...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🏥 Deal Health Scoring</h2>
          <p className="sv-panel-desc">Define the 16 parameters used to score every deal in your pipeline. Changes apply to all deals immediately on next score.</p>
        </div>
        {healthTab !== 'competitors' && (
          <button className="sv-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '⏳ Saving...' : '💾 Save Changes'}
          </button>
        )}
      </div>

      {/* Health inner tabs */}
      <div className="sv-inner-tabs">
        {HEALTH_TABS.map(t => (
          <button key={t.id} className={`sv-inner-tab ${healthTab === t.id ? 'active' : ''}`} onClick={() => setHealthTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body">

        {/* ── AI USAGE ─────────────────────────────────── */}
        {healthTab === 'ai' && (
          <div className="sv-section">
            <div className={`sv-ai-master ${aiEnabled ? 'enabled' : 'disabled'}`}>
              <div className="sv-ai-master-left">
                <div className="sv-ai-title">{aiEnabled ? '🤖 AI Analysis Enabled' : '⛔ AI Analysis Disabled'}</div>
                <p className="sv-ai-desc">
                  {aiEnabled
                    ? 'Claude AI is active. Signals from emails, transcripts and documents will be automatically detected. You will be charged for API usage.'
                    : 'AI analysis is OFF. No Claude API calls will be made. Only automatic rule-based signals and manual flags will be used. No API charges will be incurred.'}
                </p>
                {aiEnabled && <div className="sv-ai-cost">💡 Estimated cost: ~$0.04 per transcript · ~$0.02 per email scan</div>}
              </div>
              <div className="sv-ai-master-right">
                <button className={`sv-toggle ${aiEnabled ? 'on' : 'off'}`} onClick={() => setAiEnabled(!aiEnabled)}>
                  <span className="sv-toggle-knob" />
                </button>
                <span className="sv-toggle-label">{aiEnabled ? 'ON' : 'OFF'}</span>
              </div>
            </div>

            <div className="sv-card">
              <h3>Parameters that use AI <span className="sv-count-badge">{aiRequiredParams.length}</span></h3>
              <p className="sv-hint">{!aiEnabled && 'These parameters will fall back to manual-only capture when AI is off.'}</p>
              <div className="sv-ai-param-list">
                {PARAMS.filter(p => p.requiresAI).map(p => {
                  const cat = CATEGORIES.find(c => c.id === p.cat);
                  return (
                    <div key={p.key} className={`sv-ai-param-row ${paramsEnabled[p.key] === false ? 'muted' : ''}`}>
                      <span className="sv-ai-param-cat">{cat?.icon}</span>
                      <div className="sv-ai-param-info">
                        <span className="sv-ai-param-label">{p.label}</span>
                        <span className="sv-ai-param-method">{p.captureMethod}</span>
                      </div>
                      {!aiEnabled
                        ? <span className="sv-badge warning">Manual only</span>
                        : <span className="sv-badge ai">🤖 Active</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── PARAMETERS ───────────────────────────────── */}
        {healthTab === 'parameters' && (
          <div className="sv-section">
            <p className="sv-hint">Enable or disable individual parameters. Disabled parameters are excluded from health scoring entirely. Click any parameter to expand its details and edit its weight.</p>
            {CATEGORIES.map(cat => (
              <div key={cat.id} className="sv-param-group">
                <div className="sv-param-group-header">
                  <span>{cat.icon}</span>
                  <span className="sv-param-group-title">{cat.label}</span>
                  <span className="sv-param-group-count">
                    {PARAMS.filter(p => p.cat === cat.id && paramsEnabled[p.key] !== false).length}/
                    {PARAMS.filter(p => p.cat === cat.id).length} active
                  </span>
                </div>
                {PARAMS.filter(p => p.cat === cat.id).map(p => {
                  const enabled  = paramsEnabled[p.key] !== false;
                  const expanded = expandedParam === p.key;
                  const weight   = paramWeights[p.key] ?? p.defaultWeight;
                  return (
                    <div key={p.key} className={`sv-param-card ${enabled ? '' : 'inactive'}`}>
                      <div className="sv-param-card-top">
                        <label className="sv-param-toggle">
                          <input type="checkbox" checked={enabled} onChange={e => setParamsEnabled({ ...paramsEnabled, [p.key]: e.target.checked })} />
                          <span className="sv-param-slider" />
                        </label>
                        <div className="sv-param-card-info" onClick={() => setExpandedParam(expanded ? null : p.key)}>
                          <span className="sv-param-card-label">{p.label}</span>
                          <div className="sv-param-badges">
                            <span className={`sv-badge ${p.direction === 'positive' ? 'pos' : 'neg'}`}>{weight > 0 ? '+' : ''}{weight} pts</span>
                            {p.auto && <span className="sv-badge auto">⚡ Auto</span>}
                            {p.requiresAI && <span className={`sv-badge ${aiEnabled ? 'ai' : 'ai-off'}`}>{aiEnabled ? '🤖 AI' : '🤖 Off'}</span>}
                            {!p.auto && !p.requiresAI && <span className="sv-badge manual">👤 Manual</span>}
                          </div>
                        </div>
                        <button className="sv-expand-btn" onClick={() => setExpandedParam(expanded ? null : p.key)}>{expanded ? '▲' : '▼'}</button>
                      </div>
                      {expanded && (
                        <div className="sv-param-detail">
                          <p className="sv-param-desc">{p.description}</p>
                          <div className="sv-param-meta">
                            <div className="sv-meta-row"><span className="sv-meta-label">Capture method</span><span className="sv-meta-val">{p.captureMethod}</span></div>
                            <div className="sv-meta-row"><span className="sv-meta-label">Direction</span><span className={`sv-meta-val ${p.direction}`}>{p.direction === 'positive' ? '✅ Adds to score' : '🔴 Deducts from score'}</span></div>
                            <div className="sv-meta-row">
                              <span className="sv-meta-label">Weight (points)</span>
                              <div className="sv-weight-inline">
                                <input type="number" min="-100" max="100" value={paramWeights[p.key] ?? p.defaultWeight} onChange={e => setParamWeights({ ...paramWeights, [p.key]: Number(e.target.value) })} />
                                <span className="sv-hint">pts</span>
                              </div>
                            </div>
                            {!aiEnabled && p.requiresAI && <div className="sv-meta-warning">⚠️ AI is disabled — this parameter will only use manual inputs.</div>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* ── WEIGHTS ──────────────────────────────────── */}
        {healthTab === 'weights' && (
          <div className="sv-section">
            <div className="sv-card">
              <h3>Category Weights <span className={`sv-weight-total ${catWeightTotal !== 100 ? 'error' : 'ok'}`}>({catWeightTotal}/100)</span></h3>
              <p className="sv-hint">Must sum to exactly 100. Controls the relative importance of each category in the final score.</p>
              <div className="sv-cat-grid">
                {CATEGORIES.map(cat => {
                  const key = ['close_date','buyer_engagement','process','deal_size','competitive','momentum'][cat.id-1];
                  return (
                    <div key={cat.id} className="sv-cat-row">
                      <span>{cat.icon}</span>
                      <label>{cat.label}</label>
                      <div className="sv-weight-input">
                        <input type="number" min="0" max="100" value={catWeights[key]} onChange={e => setCatWeights({ ...catWeights, [key]: Number(e.target.value) })} />
                        <span>%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="sv-card">
              <h3>Health Thresholds</h3>
              <div className="sv-threshold-grid">
                {[{ key:'healthy', dot:'healthy', label:'Healthy ≥' }, { key:'watch', dot:'watch', label:'Watch ≥' }].map(({ key, dot, label }) => (
                  <div key={key} className="sv-threshold-row">
                    <span className={`sv-health-dot ${dot}`} />
                    <label>{label}</label>
                    <input type="number" min="1" max="100" value={thresholds[key]} onChange={e => setThresholds({ ...thresholds, [key]: Number(e.target.value) })} />
                  </div>
                ))}
                <div className="sv-threshold-row"><span className="sv-health-dot risk" /><label className="sv-hint">Risk &lt; {thresholds.watch}</label></div>
              </div>
            </div>
          </div>
        )}

        {/* ── TITLE KEYWORDS ───────────────────────────── */}
        {healthTab === 'titles' && (
          <div className="sv-section">
            <p className="sv-hint">Keywords matched against contact job titles to auto-detect roles. Case-insensitive partial match.</p>
            {[
              { key: 'exec',        label: '👔 Executive Titles',     desc: 'Used for parameter 2b — exec meeting held' },
              { key: 'legal',       label: '⚖️ Legal Titles',          desc: 'Used for parameter 3a — legal engaged' },
              { key: 'procurement', label: '📦 Procurement Titles',   desc: 'Used for parameter 3a — procurement engaged' },
              { key: 'security',    label: '🔒 Security / IT Titles', desc: 'Used for parameter 3b — security review' },
            ].map(({ key, label, desc }) => (
              <div key={key} className="sv-card">
                <h4>{label}</h4>
                <p className="sv-hint">{desc}</p>
                <div className="sv-tags">
                  {titleKws[key].map((kw, i) => (
                    <div key={i} className="sv-tag">
                      <input value={kw} onChange={e => updateTitleKw(key, i, e.target.value)} />
                      <button onClick={() => removeTitleKw(key, i)}>×</button>
                    </div>
                  ))}
                  <button className="sv-add-tag" onClick={() => addTitleKw(key)}>+ Add keyword</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── SEGMENTS ─────────────────────────────────── */}
        {healthTab === 'segments' && (
          <div className="sv-section">
            <div className="sv-card">
              <h3>Deal Size Segments</h3>
              <p className="sv-hint">Used for parameter 4a — flags deals significantly above typical size for their segment.</p>
              <div className="sv-seg-grid">
                {[{ key:'smb', label:'SMB average deal ($)', hint:'Deals under $10K' }, { key:'midmarket', label:'Mid-Market average deal ($)', hint:'Deals $10K–$50K' }, { key:'enterprise', label:'Enterprise average deal ($)', hint:'Deals over $50K' }, { key:'multiplier', label:'Oversize multiplier', hint:'Flag if value > avg × this' }].map(({ key, label, hint }) => (
                  <div key={key} className="sv-seg-row">
                    <div><label>{label}</label><p className="sv-hint">{hint}</p></div>
                    <input type="number" step={key === 'multiplier' ? '0.1' : '1000'} value={segments[key]} onChange={e => setSegments({ ...segments, [key]: Number(e.target.value) })} />
                  </div>
                ))}
              </div>
            </div>
            <div className="sv-card">
              <h3>Momentum Thresholds</h3>
              <div className="sv-seg-grid">
                {[{ key:'noMeetingDays', label:'No-meeting alert (days)', hint:'Parameter 6a — flag if no meeting in X days' }, { key:'responseMultiplier', label:'Slow response multiplier', hint:'Parameter 6b — flag if avg response > norm × X' }, { key:'multiThreadMin', label:'Multi-thread min contacts', hint:'Parameter 2c — minimum stakeholder count' }].map(({ key, label, hint }) => (
                  <div key={key} className="sv-seg-row">
                    <div><label>{label}</label><p className="sv-hint">{hint}</p></div>
                    <input type="number" step={key === 'responseMultiplier' ? '0.1' : '1'} value={segments[key]} onChange={e => setSegments({ ...segments, [key]: Number(e.target.value) })} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── COMPETITORS ──────────────────────────────── */}
        {healthTab === 'competitors' && (
          <div className="sv-section">
            <p className="sv-hint">
              Any competitor name or alias found in emails/transcripts automatically flags the deal as competitive (parameter 5a).
              {!aiEnabled && ' ⚠️ AI is currently disabled — competitor detection from emails/transcripts is inactive.'}
            </p>
            <div className="sv-card">
              <h3>Add Competitor</h3>
              <div className="sv-comp-form">
                <input placeholder="Name *" value={newComp.name} onChange={e => setNewComp({ ...newComp, name: e.target.value })} />
                <input placeholder="Aliases (comma-separated, e.g. SFDC, Force.com)" value={newComp.aliases} onChange={e => setNewComp({ ...newComp, aliases: e.target.value })} />
                <input placeholder="Website (optional)" value={newComp.website} onChange={e => setNewComp({ ...newComp, website: e.target.value })} />
                <button className="sv-btn-primary" onClick={handleAddCompetitor}>+ Add</button>
              </div>
            </div>
            <div className="sv-comp-list">
              {competitors.length === 0 && <div className="sv-empty">No competitors added yet. Add your first one above.</div>}
              {competitors.map(comp => (
                <div key={comp.id} className="sv-comp-row">
                  {editComp?.id === comp.id ? (
                    <div className="sv-comp-edit">
                      <input value={editComp.name} onChange={e => setEditComp({ ...editComp, name: e.target.value })} />
                      <input placeholder="Aliases" value={Array.isArray(editComp.aliases) ? editComp.aliases.join(', ') : editComp.aliases} onChange={e => setEditComp({ ...editComp, aliases: e.target.value })} />
                      <input placeholder="Website" value={editComp.website || ''} onChange={e => setEditComp({ ...editComp, website: e.target.value })} />
                      <div className="sv-comp-edit-btns">
                        <button className="sv-btn-primary" onClick={handleSaveCompetitor}>Save</button>
                        <button className="sv-btn-secondary" onClick={() => setEditComp(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="sv-comp-info">
                        <span className="sv-comp-name">{comp.name}</span>
                        {comp.aliases?.length > 0 && <span className="sv-comp-aliases">{(Array.isArray(comp.aliases) ? comp.aliases : []).join(' · ')}</span>}
                        {comp.website && <span className="sv-comp-website">{comp.website}</span>}
                      </div>
                      <div className="sv-comp-actions">
                        <button className="sv-icon-btn" onClick={() => setEditComp({ ...comp, aliases: Array.isArray(comp.aliases) ? comp.aliases.join(', ') : '' })}>✏️</button>
                        <button className="sv-icon-btn" onClick={() => handleDeleteCompetitor(comp.id)}>🗑️</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PLAYBOOK SETTINGS  (wraps existing PlaybookEditor logic)
// ════════════════════════════════════════════════════════════

function PlaybookSettings() {
  const [playbook, setPlaybook]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');
  const [editingStage, setEditingStage] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await apiService.playbook.get();
        const raw = r.data.playbook || r.data;
        // API may return 'stages' or 'deal_stages' — normalise to deal_stages
        if (raw && raw.stages && !raw.deal_stages) {
          raw.deal_stages = raw.stages;
          delete raw.stages;
        }
        setPlaybook(raw);
      } catch { setError('Failed to load playbook'); }
      finally { setLoading(false); }
    };
    load();
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true); setError(''); setSuccess('');
      await apiService.playbook.save(playbook);
      setSuccess('Playbook saved ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch { setError('Failed to save playbook'); }
    finally { setSaving(false); }
  };

  // deal_stages can be either an array OR a keyed object — normalise to array
  // Also handles API returning 'stages' instead of 'deal_stages'
  const _stagesSource = playbook?.deal_stages || playbook?.stages;
  const stagesArray = _stagesSource
    ? Array.isArray(_stagesSource)
      ? _stagesSource
      : Object.entries(_stagesSource).map(([id, val]) => ({ id, ...val }))
    : [];

  // Update a stage field, writing back to whatever shape the original was
  const updateStageField = (stageId, fieldKey, value) => {
    if (Array.isArray(playbook.deal_stages)) {
      const stages = playbook.deal_stages.map(s =>
        (s.id === stageId || s.name === stageId) ? { ...s, [fieldKey]: value } : s
      );
      setPlaybook({ ...playbook, deal_stages: stages });
    } else {
      setPlaybook({
        ...playbook,
        deal_stages: {
          ...playbook.deal_stages,
          [stageId]: { ...playbook.deal_stages[stageId], [fieldKey]: value }
        }
      });
    }
  };

  // Company info — API may return it as playbook.company or playbook.company_context
  const companyData = playbook?.company || playbook?.company_context || null;
  const companyKey  = playbook?.company ? 'company' : 'company_context';

  if (loading) return <div className="sv-loading">Loading playbook...</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📘 Sales Playbook</h2>
          <p className="sv-panel-desc">Define your sales process, stage goals, and deal criteria. Used by AI to generate context-aware actions and analysis.</p>
        </div>
        <button className="sv-btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '⏳ Saving...' : '💾 Save Playbook'}
        </button>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      <div className="sv-panel-body sv-section">
        {!playbook ? (
          <div className="sv-empty">No playbook data found.</div>
        ) : (
          <>
            {/* Company / context block */}
            {companyData && typeof companyData === 'object' && (
              <div className="sv-card">
                <h3>Company Context</h3>
                <div className="sv-form-grid">
                  {Object.entries(companyData).map(([key, val]) =>
                    typeof val === 'string' ? (
                      <div key={key} className="sv-form-row">
                        <label>{key.replace(/_/g, ' ')}</label>
                        <input
                          value={val}
                          onChange={e => setPlaybook({
                            ...playbook,
                            [companyKey]: { ...companyData, [key]: e.target.value }
                          })}
                        />
                      </div>
                    ) : null
                  )}
                </div>
              </div>
            )}

            {/* Deal stages */}
            {stagesArray.length > 0 && (
              <div className="sv-card">
                <h3>Deal Stages</h3>
                <div className="sv-stages-list">
                  {stagesArray.map((stage, i) => {
                    const stageId = stage.id || stage.name || String(i);
                    return (
                      <div key={stageId} className="sv-stage-row">
                        <div className="sv-stage-header" onClick={() => setEditingStage(editingStage === stageId ? null : stageId)}>
                          <span className="sv-stage-num">{i + 1}</span>
                          <span className="sv-stage-name">{stage.name || stageId}</span>
                          <span className="sv-hint sv-stage-goal">
                            {stage.goal?.substring(0, 60)}{stage.goal?.length > 60 ? '…' : ''}
                          </span>
                          <span className="sv-expand-btn">{editingStage === stageId ? '▲' : '▼'}</span>
                        </div>
                        {editingStage === stageId && (
                          <div className="sv-stage-detail">
                            {Object.entries(stage)
                              .filter(([k]) => k !== 'id' && k !== 'key_actions' && k !== 'success_criteria')
                              .map(([key, val]) =>
                                typeof val === 'string' ? (
                                  <div key={key} className="sv-form-row">
                                    <label>{key.replace(/_/g, ' ')}</label>
                                    <textarea
                                      rows={val.length > 80 ? 3 : 1}
                                      value={val}
                                      onChange={e => updateStageField(stageId, key, e.target.value)}
                                    />
                                  </div>
                                ) : null
                              )
                            }
                            {/* key_actions list */}
                            {Array.isArray(stage.key_actions) && (
                              <div className="sv-form-row">
                                <label>key actions</label>
                                <div style={{ flex: 1 }}>
                                  {stage.key_actions.map((action, ai) => (
                                    <div key={ai} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                                      <input
                                        value={action}
                                        style={{ flex: 1 }}
                                        onChange={e => {
                                          const actions = [...stage.key_actions];
                                          actions[ai] = e.target.value;
                                          updateStageField(stageId, 'key_actions', actions);
                                        }}
                                      />
                                      <button className="sv-icon-btn" onClick={() => {
                                        const actions = stage.key_actions.filter((_, idx) => idx !== ai);
                                        updateStageField(stageId, 'key_actions', actions);
                                      }}>×</button>
                                    </div>
                                  ))}
                                  <button className="sv-add-tag" onClick={() =>
                                    updateStageField(stageId, 'key_actions', [...stage.key_actions, ''])
                                  }>+ Add action</button>
                                </div>
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

            {/* Typical deal size if present */}
            {playbook.typical_deal_size && typeof playbook.typical_deal_size === 'object' && (
              <div className="sv-card">
                <h3>Deal Size Benchmarks</h3>
                <div className="sv-form-grid">
                  {Object.entries(playbook.typical_deal_size).map(([key, val]) => (
                    <div key={key} className="sv-form-row">
                      <label>{key.replace(/_/g, ' ')}</label>
                      <input
                        value={val || ''}
                        onChange={e => setPlaybook({
                          ...playbook,
                          typical_deal_size: { ...playbook.typical_deal_size, [key]: e.target.value }
                        })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
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
