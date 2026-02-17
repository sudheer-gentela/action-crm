import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import './DealHealthConfig.css';

// ── Parameter definitions (single source of truth) ──────────

const CATEGORIES = [
  { id: 1, label: 'Close Date Credibility',    icon: '📅' },
  { id: 2, label: 'Buyer Engagement & Power',  icon: '👥' },
  { id: 3, label: 'Process Completion',        icon: '⚙️' },
  { id: 4, label: 'Deal Size Realism',         icon: '💰' },
  { id: 5, label: 'Competitive & Pricing Risk',icon: '🥊' },
  { id: 6, label: 'Momentum & Activity',       icon: '⚡' },
];

const PARAMS = [
  {
    key: '1a_close_confirmed',   cat: 1,
    label: 'Buyer-confirmed close date',
    description: 'Close date has been explicitly confirmed by the buyer.',
    defaultWeight: 15,  direction: 'positive',
    captureMethod: 'AI detected from transcript/email + manual checkbox',
    requiresAI: true,  auto: false,
  },
  {
    key: '1b_close_slipped',     cat: 1,
    label: 'Close date slipped',
    description: 'The expected close date has been pushed out at least once.',
    defaultWeight: -20, direction: 'negative',
    captureMethod: 'Automatic — tracked from deal history on every date change',
    requiresAI: false, auto: true,
  },
  {
    key: '1c_buyer_event',       cat: 1,
    label: 'Close date tied to buyer event',
    description: 'Close date is linked to a specific buyer-side event (e.g. board meeting, budget cycle).',
    defaultWeight: 10,  direction: 'positive',
    captureMethod: 'AI detected from transcript/email + manual checkbox',
    requiresAI: true,  auto: false,
  },
  {
    key: '2a_economic_buyer',    cat: 2,
    label: 'Economic buyer identified',
    description: 'The person with budget authority has been identified and tagged as a contact.',
    defaultWeight: 20,  direction: 'positive',
    captureMethod: 'User tags a contact as Economic Buyer. Falls back to Decision Maker role.',
    requiresAI: false, auto: false,
  },
  {
    key: '2b_exec_meeting',      cat: 2,
    label: 'Exec meeting held',
    description: 'At least one meeting has been held with an executive-level contact.',
    defaultWeight: 15,  direction: 'positive',
    captureMethod: 'Automatic — matches contact titles against exec title keyword list + calendar',
    requiresAI: false, auto: true,
  },
  {
    key: '2c_multi_threaded',    cat: 2,
    label: 'Multi-threaded (>2 stakeholders)',
    description: 'More than 2 meaningful stakeholders are engaged with the deal.',
    defaultWeight: 10,  direction: 'positive',
    captureMethod: 'Automatic — counts contacts with meaningful roles (not User)',
    requiresAI: false, auto: true,
  },
  {
    key: '3a_legal_engaged',     cat: 3,
    label: 'Legal / procurement engaged',
    description: 'Legal or procurement team from the buyer side is actively involved.',
    defaultWeight: 25,  direction: 'positive',
    captureMethod: 'Contact role tag + title keyword match + AI detection in emails/transcripts + manual flag',
    requiresAI: true,  auto: false,
  },
  {
    key: '3b_security_review',   cat: 3,
    label: 'Security / IT review started',
    description: 'Security or IT team has initiated a review of the solution.',
    defaultWeight: 20,  direction: 'positive',
    captureMethod: 'Contact role tag + title keyword match + AI detection in emails/transcripts + manual flag',
    requiresAI: true,  auto: false,
  },
  {
    key: '4a_value_vs_segment',  cat: 4,
    label: 'Deal value >2× segment average',
    description: 'Deal value significantly exceeds the typical deal size for this segment — may indicate unrealistic sizing.',
    defaultWeight: -15, direction: 'negative',
    captureMethod: 'Automatic — compares deal value against segment averages defined in Segments tab',
    requiresAI: false, auto: true,
  },
  {
    key: '4b_deal_expanded',     cat: 4,
    label: 'Deal expanded in last 30 days',
    description: 'The deal value has increased in the last 30 days — positive signal of growing scope.',
    defaultWeight: 15,  direction: 'positive',
    captureMethod: 'Automatic — tracked from deal value history on every value change',
    requiresAI: false, auto: true,
  },
  {
    key: '4c_scope_approved',    cat: 4,
    label: 'Buyer explicitly approved scope',
    description: 'The buyer has explicitly agreed to the proposed scope.',
    defaultWeight: 20,  direction: 'positive',
    captureMethod: 'AI detected from transcript/email + manual checkbox',
    requiresAI: true,  auto: false,
  },
  {
    key: '5a_competitive',       cat: 5,
    label: 'Competitive deal',
    description: 'A known competitor is involved in this deal evaluation.',
    defaultWeight: -20, direction: 'negative',
    captureMethod: 'Automatic — AI scans emails/transcripts for competitor names from the Competitors registry',
    requiresAI: true,  auto: true,
  },
  {
    key: '5b_price_sensitivity', cat: 5,
    label: 'Price sensitivity flagged',
    description: 'The buyer has expressed concern about pricing or budget.',
    defaultWeight: -15, direction: 'negative',
    captureMethod: 'AI detected from transcript/email + manual checkbox',
    requiresAI: true,  auto: false,
  },
  {
    key: '5c_discount_pending',  cat: 5,
    label: 'Discount approval pending',
    description: 'A discount request is in progress and awaiting internal approval.',
    defaultWeight: -10, direction: 'negative',
    captureMethod: 'AI detected from internal email communications + manual checkbox',
    requiresAI: true,  auto: false,
  },
  {
    key: '6a_no_meeting_14d',    cat: 6,
    label: 'No buyer meeting in last 14 days',
    description: 'No meeting has been held with the buyer in the configured number of days.',
    defaultWeight: -25, direction: 'negative',
    captureMethod: 'Automatic — calculated from calendar meetings linked to the deal',
    requiresAI: false, auto: true,
  },
  {
    key: '6b_slow_response',     cat: 6,
    label: 'Avg response time > historical norm',
    description: 'Email response times are slower than the historical average for this deal — may signal disengagement.',
    defaultWeight: -15, direction: 'negative',
    captureMethod: 'Automatic — calculated from email thread timestamps',
    requiresAI: false, auto: true,
  },
];

const DEFAULT_WEIGHTS = Object.fromEntries(PARAMS.map(p => [p.key, p.defaultWeight]));
const DEFAULT_ENABLED = Object.fromEntries(PARAMS.map(p => [p.key, true]));

const TABS = [
  { id: 'ai',          label: '🤖 AI Usage'       },
  { id: 'parameters',  label: '📋 Parameters'     },
  { id: 'weights',     label: '⚖️ Weights'        },
  { id: 'titles',      label: '🏷️ Title Keywords' },
  { id: 'segments',    label: '📊 Segments'       },
  { id: 'competitors', label: '🥊 Competitors'    },
];

// ── Component ────────────────────────────────────────────────

export default function DealHealthConfig({ onClose }) {
  const [tab, setTab]         = useState('ai');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  // AI Usage
  const [aiEnabled, setAiEnabled] = useState(true);

  // Parameters
  const [paramsEnabled, setParamsEnabled] = useState(DEFAULT_ENABLED);
  const [expandedParam, setExpandedParam] = useState(null);

  // Weights
  const [catWeights, setCatWeights] = useState({
    close_date: 20, buyer_engagement: 25, process: 15,
    deal_size: 10, competitive: 15, momentum: 15,
  });
  const [paramWeights, setParamWeights] = useState(DEFAULT_WEIGHTS);
  const [thresholds, setThresholds]     = useState({ healthy: 80, watch: 50 });

  // Title keywords
  const [titleKws, setTitleKws] = useState({
    exec: ['CEO','CTO','CFO','COO','VP','SVP','EVP','President','Director'],
    legal: ['Legal','Counsel','Attorney','Contract','Compliance'],
    procurement: ['Procurement','Purchasing','Vendor','Sourcing'],
    security: ['CISO','Security','InfoSec','IT Director','Infrastructure'],
  });

  // Segments
  const [segments, setSegments] = useState({
    smb: 10000, midmarket: 35000, enterprise: 100000,
    multiplier: 2.0, noMeetingDays: 14,
    responseMultiplier: 1.5, multiThreadMin: 2,
  });

  // Competitors
  const [competitors, setCompetitors] = useState([]);
  const [newComp, setNewComp]         = useState({ name: '', aliases: '', website: '' });
  const [editComp, setEditComp]       = useState(null);

  const catWeightTotal = Object.values(catWeights).reduce((a, b) => a + Number(b), 0);
  const aiRequiredParams = PARAMS.filter(p => p.requiresAI && paramsEnabled[p.key]);

  // ── Load config ──────────────────────────────────────────

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      const [cfgRes, compRes] = await Promise.all([
        apiService.healthConfig.get(),
        apiService.competitors.getAll(),
      ]);
      const c = cfgRes.data.config;

      setAiEnabled(c.ai_enabled !== false);
      setCatWeights({
        close_date: c.weight_close_date, buyer_engagement: c.weight_buyer_engagement,
        process: c.weight_process, deal_size: c.weight_deal_size,
        competitive: c.weight_competitive, momentum: c.weight_momentum,
      });
      setParamWeights({ ...DEFAULT_WEIGHTS, ...(c.param_weights || {}) });
      setParamsEnabled({ ...DEFAULT_ENABLED, ...(c.params_enabled || {}) });
      setThresholds({ healthy: c.threshold_healthy, watch: c.threshold_watch });
      setTitleKws({
        exec: c.exec_titles || [],
        legal: c.legal_titles || [],
        procurement: c.procurement_titles || [],
        security: c.security_titles || [],
      });
      setSegments({
        smb: c.segment_avg_smb, midmarket: c.segment_avg_midmarket,
        enterprise: c.segment_avg_enterprise, multiplier: c.segment_size_multiplier,
        noMeetingDays: c.no_meeting_days, responseMultiplier: c.response_time_multiplier,
        multiThreadMin: c.multi_thread_min_contacts,
      });
      setCompetitors(compRes.data.competitors || []);
    } catch (e) {
      setError('Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // ── Save config ──────────────────────────────────────────

  const handleSave = async () => {
    if (tab !== 'competitors' && catWeightTotal !== 100) {
      setError(`Category weights must sum to 100 (currently ${catWeightTotal})`);
      return;
    }
    try {
      setSaving(true); setError(''); setSuccess('');
      await apiService.healthConfig.save({
        aiEnabled,
        paramsEnabled,
        weightCloseDate: catWeights.close_date,
        weightBuyerEngagement: catWeights.buyer_engagement,
        weightProcess: catWeights.process,
        weightDealSize: catWeights.deal_size,
        weightCompetitive: catWeights.competitive,
        weightMomentum: catWeights.momentum,
        paramWeights,
        thresholdHealthy: thresholds.healthy,
        thresholdWatch: thresholds.watch,
        execTitles: titleKws.exec,
        legalTitles: titleKws.legal,
        procurementTitles: titleKws.procurement,
        securityTitles: titleKws.security,
        segmentAvgSmb: segments.smb,
        segmentAvgMidmarket: segments.midmarket,
        segmentAvgEnterprise: segments.enterprise,
        segmentSizeMultiplier: segments.multiplier,
        noMeetingDays: segments.noMeetingDays,
        responseTimeMultiplier: segments.responseMultiplier,
        multiThreadMinContacts: segments.multiThreadMin,
      });
      setSuccess('Configuration saved ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ── Competitor handlers ──────────────────────────────────

  const handleAddCompetitor = async () => {
    if (!newComp.name.trim()) return;
    try {
      const aliases = newComp.aliases.split(',').map(a => a.trim()).filter(Boolean);
      const r = await apiService.competitors.create({ ...newComp, aliases });
      setCompetitors([...competitors, r.data.competitor]);
      setNewComp({ name: '', aliases: '', website: '' });
    } catch { setError('Failed to add competitor'); }
  };

  const handleDeleteCompetitor = async (id) => {
    try {
      await apiService.competitors.delete(id);
      setCompetitors(competitors.filter(c => c.id !== id));
    } catch { setError('Failed to delete'); }
  };

  const handleSaveCompetitor = async () => {
    try {
      const aliases = typeof editComp.aliases === 'string'
        ? editComp.aliases.split(',').map(a => a.trim()).filter(Boolean)
        : editComp.aliases;
      const r = await apiService.competitors.update(editComp.id, { ...editComp, aliases });
      setCompetitors(competitors.map(c => c.id === editComp.id ? r.data.competitor : c));
      setEditComp(null);
    } catch { setError('Failed to save competitor'); }
  };

  const updateTitleKw = (type, idx, val) => {
    const arr = [...titleKws[type]]; arr[idx] = val;
    setTitleKws({ ...titleKws, [type]: arr });
  };
  const removeTitleKw = (type, idx) => setTitleKws({ ...titleKws, [type]: titleKws[type].filter((_, i) => i !== idx) });
  const addTitleKw    = (type)       => setTitleKws({ ...titleKws, [type]: [...titleKws[type], ''] });

  // ── Render ───────────────────────────────────────────────

  if (loading) return (
    <div className="dhc-modal">
      <div className="dhc-overlay" onClick={onClose} />
      <div className="dhc-content dhc-loading-wrap"><div className="dhc-loading">Loading configuration...</div></div>
    </div>
  );

  return (
    <div className="dhc-modal">
      <div className="dhc-overlay" onClick={onClose} />
      <div className="dhc-content">

        {/* Header */}
        <div className="dhc-header">
          <div>
            <h2>⚙️ Deal Health Configuration</h2>
            <p className="dhc-header-sub">Configure how deal health is scored across your pipeline</p>
          </div>
          <button className="dhc-close" onClick={onClose}>×</button>
        </div>

        {/* Tabs */}
        <div className="dhc-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`dhc-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="dhc-body">

          {/* ══ AI USAGE TAB ═══════════════════════════════ */}
          {tab === 'ai' && (
            <div className="dhc-section">

              {/* Master toggle */}
              <div className={`dhc-ai-master ${aiEnabled ? 'enabled' : 'disabled'}`}>
                <div className="dhc-ai-master-left">
                  <div className="dhc-ai-master-title">
                    {aiEnabled ? '🤖 AI Analysis Enabled' : '⛔ AI Analysis Disabled'}
                  </div>
                  <p className="dhc-ai-master-desc">
                    {aiEnabled
                      ? 'Claude AI is active. Signals from emails, transcripts and documents will be automatically detected. You will be charged for API usage.'
                      : 'AI analysis is OFF. No Claude API calls will be made. Only automatic rule-based signals and manual flags will be used for health scoring. No charges will be incurred.'}
                  </p>
                  {aiEnabled && (
                    <div className="dhc-ai-cost-note">
                      💡 Estimated cost: ~$0.04 per transcript analysis · ~$0.02 per email scan
                    </div>
                  )}
                </div>
                <div className="dhc-ai-master-right">
                  <button
                    className={`dhc-toggle ${aiEnabled ? 'on' : 'off'}`}
                    onClick={() => setAiEnabled(!aiEnabled)}
                  >
                    <span className="dhc-toggle-knob" />
                  </button>
                  <span className="dhc-toggle-label">{aiEnabled ? 'ON' : 'OFF'}</span>
                </div>
              </div>

              {/* AI-dependent parameters */}
              <div className="dhc-ai-params-section">
                <h3>Parameters that use AI</h3>
                <p className="dhc-hint">
                  These {aiRequiredParams.length} parameters rely on AI to auto-detect signals.
                  {!aiEnabled && ' They will fall back to manual-only capture when AI is off.'}
                </p>
                <div className="dhc-ai-param-list">
                  {PARAMS.filter(p => p.requiresAI).map(p => {
                    const enabled = paramsEnabled[p.key] !== false;
                    const cat = CATEGORIES.find(c => c.id === p.cat);
                    return (
                      <div key={p.key} className={`dhc-ai-param-row ${enabled ? '' : 'muted'}`}>
                        <span className="dhc-ai-param-cat">{cat?.icon}</span>
                        <div className="dhc-ai-param-info">
                          <span className="dhc-ai-param-label">{p.label}</span>
                          <span className="dhc-ai-param-method">{p.captureMethod}</span>
                        </div>
                        <div className="dhc-ai-param-badges">
                          {!aiEnabled && <span className="dhc-badge-warning">AI off — manual only</span>}
                          {aiEnabled  && <span className="dhc-badge-ai">🤖 AI active</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          )}

          {/* ══ PARAMETERS TAB ═════════════════════════════ */}
          {tab === 'parameters' && (
            <div className="dhc-section">
              <p className="dhc-hint">
                Enable or disable individual parameters. Disabled parameters are excluded from health scoring entirely.
                Click a parameter to see full details.
              </p>

              {CATEGORIES.map(cat => (
                <div key={cat.id} className="dhc-param-group-card">
                  <div className="dhc-param-group-header">
                    <span className="dhc-param-group-icon">{cat.icon}</span>
                    <span className="dhc-param-group-title">{cat.label}</span>
                    <span className="dhc-param-group-count">
                      {PARAMS.filter(p => p.cat === cat.id && paramsEnabled[p.key] !== false).length}/
                      {PARAMS.filter(p => p.cat === cat.id).length} active
                    </span>
                  </div>

                  {PARAMS.filter(p => p.cat === cat.id).map(p => {
                    const enabled  = paramsEnabled[p.key] !== false;
                    const expanded = expandedParam === p.key;
                    const weight   = paramWeights[p.key] ?? p.defaultWeight;

                    return (
                      <div key={p.key} className={`dhc-param-card ${enabled ? 'active' : 'inactive'}`}>
                        <div className="dhc-param-card-top">
                          {/* Enable toggle */}
                          <label className="dhc-param-toggle-wrap">
                            <input type="checkbox" checked={enabled}
                              onChange={e => setParamsEnabled({ ...paramsEnabled, [p.key]: e.target.checked })} />
                            <span className="dhc-param-toggle-slider" />
                          </label>

                          {/* Label + badges */}
                          <div className="dhc-param-card-info" onClick={() => setExpandedParam(expanded ? null : p.key)}>
                            <span className="dhc-param-card-label">{p.label}</span>
                            <div className="dhc-param-card-badges">
                              <span className={`dhc-badge ${p.direction === 'positive' ? 'pos' : 'neg'}`}>
                                {weight > 0 ? '+' : ''}{weight} pts
                              </span>
                              {p.auto     && <span className="dhc-badge auto">⚡ Auto</span>}
                              {p.requiresAI && <span className={`dhc-badge ${aiEnabled ? 'ai' : 'ai-off'}`}>
                                {aiEnabled ? '🤖 AI' : '🤖 AI off'}
                              </span>}
                              {!p.auto && !p.requiresAI && <span className="dhc-badge manual">👤 Manual</span>}
                            </div>
                          </div>

                          <button className="dhc-param-expand-btn"
                            onClick={() => setExpandedParam(expanded ? null : p.key)}>
                            {expanded ? '▲' : '▼'}
                          </button>
                        </div>

                        {/* Expanded detail */}
                        {expanded && (
                          <div className="dhc-param-card-detail">
                            <p className="dhc-param-card-desc">{p.description}</p>
                            <div className="dhc-param-card-meta">
                              <div className="dhc-meta-row">
                                <span className="dhc-meta-label">How it's captured</span>
                                <span className="dhc-meta-val">{p.captureMethod}</span>
                              </div>
                              <div className="dhc-meta-row">
                                <span className="dhc-meta-label">Direction</span>
                                <span className={`dhc-meta-val ${p.direction}`}>
                                  {p.direction === 'positive' ? '✅ Adds to score' : '🔴 Deducts from score'}
                                </span>
                              </div>
                              <div className="dhc-meta-row">
                                <span className="dhc-meta-label">Weight (points)</span>
                                <div className="dhc-weight-input-inline">
                                  <input type="number" min="-100" max="100"
                                    value={paramWeights[p.key] ?? p.defaultWeight}
                                    onChange={e => setParamWeights({ ...paramWeights, [p.key]: Number(e.target.value) })} />
                                  <span className="dhc-hint">pts</span>
                                </div>
                              </div>
                              {!aiEnabled && p.requiresAI && (
                                <div className="dhc-meta-row dhc-meta-warning">
                                  ⚠️ AI is currently disabled. This parameter will only capture manual inputs.
                                </div>
                              )}
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

          {/* ══ WEIGHTS TAB ════════════════════════════════ */}
          {tab === 'weights' && (
            <div className="dhc-section">

              <div className="dhc-card">
                <h3>Category Weights
                  <span className={`dhc-total ${catWeightTotal !== 100 ? 'error' : 'ok'}`}> ({catWeightTotal}/100)</span>
                </h3>
                <p className="dhc-hint">Must sum to exactly 100. Controls relative importance of each category.</p>
                <div className="dhc-cat-grid">
                  {CATEGORIES.map(cat => {
                    const key = ['close_date','buyer_engagement','process','deal_size','competitive','momentum'][cat.id-1];
                    return (
                      <div key={cat.id} className="dhc-cat-row">
                        <span className="dhc-cat-icon">{cat.icon}</span>
                        <label>{cat.label}</label>
                        <div className="dhc-weight-input">
                          <input type="number" min="0" max="100" value={catWeights[key]}
                            onChange={e => setCatWeights({ ...catWeights, [key]: Number(e.target.value) })} />
                          <span>%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="dhc-card">
                <h3>Health Thresholds</h3>
                <div className="dhc-threshold-grid">
                  {[
                    { key: 'healthy', dot: 'healthy', label: 'Healthy ≥' },
                    { key: 'watch',   dot: 'watch',   label: 'Watch ≥' },
                  ].map(({ key, dot, label }) => (
                    <div key={key} className="dhc-threshold-row">
                      <span className={`dhc-health-dot ${dot}`} />
                      <label>{label}</label>
                      <input type="number" min="1" max="100" value={thresholds[key]}
                        onChange={e => setThresholds({ ...thresholds, [key]: Number(e.target.value) })} />
                    </div>
                  ))}
                  <div className="dhc-threshold-row">
                    <span className="dhc-health-dot risk" />
                    <label className="dhc-hint">Risk &lt; {thresholds.watch}</label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══ TITLE KEYWORDS TAB ═════════════════════════ */}
          {tab === 'titles' && (
            <div className="dhc-section">
              <p className="dhc-hint">Keywords matched against contact job titles to auto-detect roles. Case-insensitive partial match.</p>
              {[
                { key: 'exec',        label: '👔 Executive Titles',    desc: 'Used for parameter 2b — exec meeting held' },
                { key: 'legal',       label: '⚖️ Legal Titles',        desc: 'Used for parameter 3a — legal engaged' },
                { key: 'procurement', label: '📦 Procurement Titles',  desc: 'Used for parameter 3a — procurement engaged' },
                { key: 'security',    label: '🔒 Security / IT Titles',desc: 'Used for parameter 3b — security review' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="dhc-card">
                  <h4>{label}</h4>
                  <p className="dhc-hint">{desc}</p>
                  <div className="dhc-tags">
                    {titleKws[key].map((kw, i) => (
                      <div key={i} className="dhc-tag">
                        <input value={kw} onChange={e => updateTitleKw(key, i, e.target.value)} />
                        <button onClick={() => removeTitleKw(key, i)}>×</button>
                      </div>
                    ))}
                    <button className="dhc-add-tag" onClick={() => addTitleKw(key)}>+ Add keyword</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ══ SEGMENTS TAB ═══════════════════════════════ */}
          {tab === 'segments' && (
            <div className="dhc-section">
              <div className="dhc-card">
                <h3>Deal Size Segments</h3>
                <p className="dhc-hint">Used for parameter 4a — flags deals significantly above typical size for their segment.</p>
                <div className="dhc-seg-grid">
                  {[
                    { key: 'smb',        label: 'SMB average deal ($)',        hint: 'Deals under $10K' },
                    { key: 'midmarket',  label: 'Mid-Market average deal ($)', hint: 'Deals $10K–$50K' },
                    { key: 'enterprise', label: 'Enterprise average deal ($)', hint: 'Deals over $50K' },
                    { key: 'multiplier', label: 'Oversize multiplier',         hint: 'Flag if value > avg × this' },
                  ].map(({ key, label, hint }) => (
                    <div key={key} className="dhc-seg-row">
                      <div><label>{label}</label><p className="dhc-hint">{hint}</p></div>
                      <input type="number" step={key === 'multiplier' ? '0.1' : '1000'} value={segments[key]}
                        onChange={e => setSegments({ ...segments, [key]: Number(e.target.value) })} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="dhc-card">
                <h3>Momentum Thresholds</h3>
                <div className="dhc-seg-grid">
                  {[
                    { key: 'noMeetingDays',       label: 'No-meeting alert (days)',    hint: 'Parameter 6a — flag if no meeting in X days' },
                    { key: 'responseMultiplier',  label: 'Slow response multiplier',   hint: 'Parameter 6b — flag if avg response > norm × X' },
                    { key: 'multiThreadMin',       label: 'Multi-thread min contacts', hint: 'Parameter 2c — minimum stakeholder count' },
                  ].map(({ key, label, hint }) => (
                    <div key={key} className="dhc-seg-row">
                      <div><label>{label}</label><p className="dhc-hint">{hint}</p></div>
                      <input type="number" step={key === 'responseMultiplier' ? '0.1' : '1'} value={segments[key]}
                        onChange={e => setSegments({ ...segments, [key]: Number(e.target.value) })} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ══ COMPETITORS TAB ════════════════════════════ */}
          {tab === 'competitors' && (
            <div className="dhc-section">
              <p className="dhc-hint">
                Any competitor name or alias found in emails/transcripts automatically flags the deal as competitive (parameter 5a).
                {!aiEnabled && ' ⚠️ AI is currently disabled — competitor detection from emails/transcripts is inactive.'}
              </p>

              <div className="dhc-card">
                <h3>Add Competitor</h3>
                <div className="dhc-comp-form">
                  <input placeholder="Name *" value={newComp.name}
                    onChange={e => setNewComp({ ...newComp, name: e.target.value })} />
                  <input placeholder="Aliases (comma-separated)" value={newComp.aliases}
                    onChange={e => setNewComp({ ...newComp, aliases: e.target.value })} />
                  <input placeholder="Website (optional)" value={newComp.website}
                    onChange={e => setNewComp({ ...newComp, website: e.target.value })} />
                  <button className="dhc-btn-primary" onClick={handleAddCompetitor}>+ Add</button>
                </div>
              </div>

              <div className="dhc-comp-list">
                {competitors.length === 0 && <div className="dhc-empty">No competitors added yet</div>}
                {competitors.map(comp => (
                  <div key={comp.id} className="dhc-comp-row">
                    {editComp?.id === comp.id ? (
                      <div className="dhc-comp-edit">
                        <input value={editComp.name} onChange={e => setEditComp({ ...editComp, name: e.target.value })} />
                        <input placeholder="Aliases" value={Array.isArray(editComp.aliases) ? editComp.aliases.join(', ') : editComp.aliases}
                          onChange={e => setEditComp({ ...editComp, aliases: e.target.value })} />
                        <input placeholder="Website" value={editComp.website || ''}
                          onChange={e => setEditComp({ ...editComp, website: e.target.value })} />
                        <div className="dhc-comp-edit-actions">
                          <button className="dhc-btn-primary" onClick={handleSaveCompetitor}>Save</button>
                          <button className="dhc-btn-secondary" onClick={() => setEditComp(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="dhc-comp-info">
                          <span className="dhc-comp-name">{comp.name}</span>
                          {comp.aliases?.length > 0 && <span className="dhc-comp-aliases">{(Array.isArray(comp.aliases) ? comp.aliases : []).join(' · ')}</span>}
                          {comp.website && <span className="dhc-comp-website">{comp.website}</span>}
                        </div>
                        <div className="dhc-comp-actions">
                          <button className="dhc-btn-icon" onClick={() => setEditComp({ ...comp, aliases: Array.isArray(comp.aliases) ? comp.aliases.join(', ') : '' })}>✏️</button>
                          <button className="dhc-btn-icon" onClick={() => handleDeleteCompetitor(comp.id)}>🗑️</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Messages */}
        {error   && <div className="dhc-error">⚠️ {error}</div>}
        {success && <div className="dhc-success">{success}</div>}

        {/* Footer */}
        <div className="dhc-footer">
          <button className="dhc-btn-secondary" onClick={onClose}>Close</button>
          {tab !== 'competitors' && (
            <button className="dhc-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '⏳ Saving...' : '💾 Save Configuration'}
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
