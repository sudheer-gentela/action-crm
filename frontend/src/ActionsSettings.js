import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import './ActionsSettings.css';

function ActionsSettings() {
  const [config, setConfig]               = useState(null);
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState(null);
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const response = await apiService.actions.getConfig();
      setConfig(response.data.config);
      setError(null);
    } catch (err) {
      console.error('Error loading action config:', err);
      setError('Failed to load configuration');
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);
      setError(null);
      await apiService.actions.updateConfig(config);
      setSuccessMessage('✅ Configuration saved successfully');
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err) {
      console.error('Error saving config:', err);
      setError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (key, value) => setConfig({ ...config, [key]: value });

  // Helper to read/write nested ai_settings keys
  const getAI = (key, fallback) => config?.ai_settings?.[key] ?? fallback;
  const setAI = (key, value) => setConfig(prev => ({
    ...prev,
    ai_settings: { ...(prev.ai_settings || {}), [key]: value },
  }));

  if (loading) return <div className="actions-settings"><div className="loading">Loading configuration...</div></div>;
  if (!config)  return <div className="actions-settings"><div className="error">Failed to load configuration</div></div>;

  const masterEnabled        = getAI('master_enabled', true);
  const strapGenMode         = getAI('strap_generation_mode', 'both');
  const strapAIProvider      = getAI('strap_ai_provider', 'anthropic');
  const aiDisabledForStraps  = !masterEnabled;

  return (
    <div className="actions-settings">
      <h2>⚙️ Actions Configuration</h2>
      <p className="subtitle">Configure how actions are generated and completed</p>

      {error          && <div className="error-message">{error}</div>}
      {successMessage && <div className="success-message">{successMessage}</div>}

      {/* ── GENERATION SETTINGS ── */}
      <section className="settings-section">
        <h3>📘 Action Generation</h3>

        <div className="setting-group">
          <label className="setting-label">Generation Mode</label>
          <select
            className="setting-select"
            value={config.generation_mode}
            onChange={e => updateConfig('generation_mode', e.target.value)}
          >
            <option value="playbook">Sales Playbook (Recommended)</option>
            <option value="rules">Standard Rules Engine</option>
            <option value="manual">Manual Only</option>
          </select>
          {config.generation_mode === 'playbook' && (
            <p className="help-text">ℹ️ Actions will be automatically generated from your Sales Playbook when deals change stage.</p>
          )}
          {config.generation_mode === 'rules' && (
            <p className="help-text">ℹ️ Actions will be generated using the built-in rules engine based on deal activity.</p>
          )}
          {config.generation_mode === 'manual' && (
            <p className="help-text">⚠️ Actions will not be auto-generated. You'll need to create all actions manually.</p>
          )}
        </div>

        <div className="setting-group">
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={config.ai_enhanced_generation}
              onChange={e => updateConfig('ai_enhanced_generation', e.target.checked)}
              disabled={config.generation_mode === 'manual'}
            />
            <span>Enable AI-powered action generation</span>
          </label>
          <p className="help-text">AI will enhance action descriptions with deal-specific context and insights.</p>
        </div>

        <div className="setting-group">
          <label className="setting-label">Trigger Action Generation When:</label>
          <label className="setting-checkbox">
            <input type="checkbox" checked={config.generate_on_stage_change}
              onChange={e => updateConfig('generate_on_stage_change', e.target.checked)}
              disabled={config.generation_mode === 'manual'} />
            <span>Deal stage changes</span>
          </label>
          <label className="setting-checkbox">
            <input type="checkbox" checked={config.generate_on_meeting_scheduled}
              onChange={e => updateConfig('generate_on_meeting_scheduled', e.target.checked)}
              disabled={config.generation_mode === 'manual'} />
            <span>Meeting is scheduled</span>
          </label>
          <label className="setting-checkbox">
            <input type="checkbox" checked={config.generate_on_email_next_steps}
              onChange={e => updateConfig('generate_on_email_next_steps', e.target.checked)}
              disabled={config.generation_mode === 'manual'} />
            <span>Email mentions next steps</span>
          </label>
        </div>
      </section>

      {/* ── STRAP GENERATION (user-level override) ── */}
      <section className="settings-section">
        <h3>🎯 STRAP Generation</h3>
        <p className="subtitle" style={{ marginBottom: 16 }}>
          Override the org-level STRAP generation settings for your own account.
          When you click "Generate STRAP" on a deal, account, or prospect, this controls
          what you see.
        </p>

        {/* Generation mode radio */}
        <div className="setting-group">
          <label className="setting-label">How should STRAPs be generated for you?</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {[
              { value: 'both',     icon: '⚖️', label: 'Both (I choose)',    desc: 'Show me both playbook and AI versions side-by-side so I can compare and pick.' },
              { value: 'playbook', icon: '📘', label: 'Playbook template',  desc: 'Always use the playbook — fast, no AI needed.' },
              { value: 'ai',       icon: '🤖', label: 'AI-generated',       desc: 'Always use AI. Falls back to playbook if AI is unavailable.' },
            ].map(opt => {
              const isSelected = strapGenMode === opt.value;
              const isAiOpt    = opt.value !== 'playbook';
              const dimmed     = isAiOpt && aiDisabledForStraps;
              return (
                <label
                  key={opt.value}
                  className={`strap-mode-option${isSelected ? ' strap-mode-option--selected' : ''}${dimmed ? ' strap-mode-option--disabled' : ''}`}
                >
                  <input
                    type="radio"
                    name="strap_generation_mode"
                    value={opt.value}
                    checked={isSelected}
                    disabled={dimmed}
                    onChange={() => !dimmed && setAI('strap_generation_mode', opt.value)}
                  />
                  <div className="strap-mode-option-body">
                    <span className="strap-mode-option-label">{opt.icon} {opt.label}</span>
                    <span className="strap-mode-option-desc">{opt.desc}</span>
                  </div>
                </label>
              );
            })}
          </div>
          {aiDisabledForStraps && (
            <p className="help-text" style={{ color: '#d97706', marginTop: 8 }}>
              ⚠️ Master AI is disabled — only Playbook mode is available. Enable AI in your
              org admin settings to unlock AI generation.
            </p>
          )}
        </div>

        {/* AI Provider — only shown when mode includes AI and master is on */}
        {(strapGenMode === 'ai' || strapGenMode === 'both') && !aiDisabledForStraps && (
          <div className="setting-group">
            <label className="setting-label">AI Provider for STRAP generation</label>
            <select
              className="setting-select"
              value={strapAIProvider}
              onChange={e => setAI('strap_ai_provider', e.target.value)}
            >
              <option value="anthropic">Anthropic (Claude) — Default</option>
              <option value="openai">OpenAI (GPT-4o mini)</option>
              <option value="grok">Grok (xAI)</option>
            </select>
            <p className="help-text">
              If the selected provider's API key is not configured in the system,
              generation will fall back to the playbook template automatically and
              show you a warning.
            </p>
          </div>
        )}
      </section>

      {/* ── COMPLETION DETECTION SETTINGS ── */}
      <section className="settings-section">
        <h3>✨ Action Completion Detection</h3>

        <div className="setting-group">
          <label className="setting-label">Detection Mode</label>
          <select
            className="setting-select"
            value={config.detection_mode}
            onChange={e => updateConfig('detection_mode', e.target.value)}
          >
            <option value="hybrid">Hybrid (Rules + AI) - Recommended</option>
            <option value="ai_only">AI Only</option>
            <option value="rules_only">Rules Only</option>
            <option value="manual">Manual Only</option>
          </select>
          {config.detection_mode === 'hybrid' && (
            <div className="info-box">
              <strong>Hybrid Mode:</strong>
              <ul>
                <li>Simple matches use fast rule-based detection</li>
                <li>Ambiguous cases are analyzed by AI</li>
                <li>Best accuracy with minimal AI costs</li>
              </ul>
            </div>
          )}
          {config.detection_mode === 'ai_only' && (
            <p className="help-text">🤖 All completion detection will use AI analysis. More accurate but higher API costs.</p>
          )}
          {config.detection_mode === 'rules_only' && (
            <p className="help-text">⚡ Fast keyword-based detection. No AI costs but lower accuracy.</p>
          )}
          {config.detection_mode === 'manual' && (
            <p className="help-text">⚠️ No automatic detection. You'll need to manually mark all actions as complete.</p>
          )}
        </div>

        {config.detection_mode !== 'manual' && (
          <>
            <div className="setting-group">
              <label className="setting-label">
                Confidence Threshold: <strong>{config.confidence_threshold}%</strong>
              </label>
              <input type="range" min="50" max="100" step="5"
                value={config.confidence_threshold}
                onChange={e => updateConfig('confidence_threshold', parseInt(e.target.value))}
                className="setting-slider" />
              <div className="slider-labels">
                <span>50% (More suggestions)</span>
                <span>100% (Fewer, high-confidence)</span>
              </div>
              <p className="help-text">Minimum confidence level to suggest an action might be complete.</p>
            </div>

            <div className="setting-group">
              <label className="setting-label">
                Auto-Complete Threshold: <strong>{config.auto_complete_threshold}%</strong>
              </label>
              <input type="range" min="50" max="100" step="5"
                value={config.auto_complete_threshold}
                onChange={e => updateConfig('auto_complete_threshold', parseInt(e.target.value))}
                className="setting-slider" />
              <div className="slider-labels">
                <span>50% (Auto-complete more)</span>
                <span>100% (Always ask first)</span>
              </div>
              <p className="help-text">Actions with confidence above this will be auto-completed without asking.</p>
            </div>

            <div className="setting-group">
              <label className="setting-label">Detect Completions From:</label>
              <label className="setting-checkbox">
                <input type="checkbox" checked={config.detect_from_emails}
                  onChange={e => updateConfig('detect_from_emails', e.target.checked)} />
                <span>📧 Emails sent/received</span>
              </label>
              <label className="setting-checkbox">
                <input type="checkbox" checked={config.detect_from_meetings}
                  onChange={e => updateConfig('detect_from_meetings', e.target.checked)} />
                <span>📅 Meetings scheduled/completed</span>
              </label>
              <label className="setting-checkbox">
                <input type="checkbox" checked={config.detect_from_documents} disabled />
                <span>📄 Documents uploaded (Coming Soon)</span>
              </label>
            </div>

            <div className="setting-group">
              <label className="setting-checkbox">
                <input type="checkbox" checked={config.enable_learning}
                  onChange={e => updateConfig('enable_learning', e.target.checked)} />
                <span>Enable learning from my feedback</span>
              </label>
              <p className="help-text">System will improve accuracy over time based on which suggestions you accept/dismiss.</p>
            </div>
          </>
        )}
      </section>

      {/* ── SAVE ── */}
      <div className="settings-actions">
        <button onClick={saveConfig} disabled={saving} className="save-button">
          {saving ? 'Saving...' : '💾 Save Configuration'}
        </button>
        <button onClick={loadConfig} className="cancel-button">↺ Reset</button>
      </div>

      {/* ── HELP ── */}
      <section className="settings-section help-section">
        <h3>💡 How It Works</h3>
        <div className="help-cards">
          <div className="help-card">
            <h4>🎯 STRAP Generation</h4>
            <p>When you click "Generate STRAP", the system identifies the most critical hurdle
            for the entity and builds a strategy. In "Both" mode you see a playbook version and
            an AI version side-by-side — pick the one you prefer, edit it, then confirm.</p>
          </div>
          <div className="help-card">
            <h4>📘 Playbook Mode</h4>
            <p>When a deal moves to "Demo" stage, the system reads your playbook and creates actions like:</p>
            <ul>
              <li>"Customize demo deck for prospect"</li>
              <li>"Schedule product demonstration"</li>
              <li>"Invite technical stakeholders"</li>
            </ul>
          </div>
          <div className="help-card">
            <h4>✨ Auto-Detection</h4>
            <p>When you send an email with "demo deck" + attachment, the system:</p>
            <ul>
              <li>Finds the "Customize demo deck" action</li>
              <li>Analyses the email (keywords, attachment, recipient)</li>
              <li>Suggests completion at 85% confidence</li>
              <li>You can accept or dismiss the suggestion</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

export default ActionsSettings;
