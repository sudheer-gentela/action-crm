/**
 * ActionsSettings.js
 *
 * Workflow → Actions settings panel.
 *
 * WHAT THIS PANEL CONTROLS:
 *   - Trigger conditions (when to auto-generate actions)
 *   - STRAP generation mode (playbook / AI / both) + provider
 *   - Action completion detection (mode, thresholds, sources)
 *
 * WHAT WAS REMOVED (now lives in Settings → AI → Preferences):
 *   - Generation Mode dropdown         → AI Preferences / Generation sources
 *   - Enable AI-powered generation     → AI Preferences / Master toggle
 *   - AI per Module toggles            → AI Preferences / Module toggles
 *
 * The save still calls apiService.actions.updateConfig() which hits the
 * existing actions config route — no route change needed here.
 */

import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';
import './ActionsSettings.css';

function ActionsSettings() {
  const [config, setConfig]                 = useState(null);
  const [loading, setLoading]               = useState(true);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState(null);
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

  const getAI = (key, fallback) => config?.ai_settings?.[key] ?? fallback;
  const setAI = (key, value)    => setConfig(prev => ({
    ...prev,
    ai_settings: { ...(prev.ai_settings || {}), [key]: value },
  }));

  if (loading) return <div className="actions-settings"><div className="loading">Loading configuration...</div></div>;
  if (!config)  return <div className="actions-settings"><div className="error">Failed to load configuration</div></div>;

  const strapGenMode    = getAI('strap_generation_mode', 'both');
  const strapAIProvider = getAI('strap_ai_provider', 'anthropic');
  // Master AI enabled — read-only here, controlled in AI → Preferences
  const masterEnabled   = config?.ai_settings?.master_enabled ?? true;

  // Derive whether generation sources are active (array or legacy string)
  const genSources = Array.isArray(config.generation_mode)
    ? config.generation_mode
    : config.generation_mode === 'manual' ? [] : ['playbook', 'rules', 'ai'];
  const isManual = genSources.length === 0;

  return (
    <div className="actions-settings">
      <h2>⚙️ Actions Configuration</h2>
      <p className="subtitle">Configure how actions are generated and completed</p>

      {error          && <div className="error-message">{error}</div>}
      {successMessage && <div className="success-message">{successMessage}</div>}

      {/* ── AI SETTINGS REDIRECT NOTICE ── */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: '#EEEDFE', border: '1px solid #AFA9EC',
        borderRadius: 8, padding: '11px 14px', marginBottom: 20,
      }}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>🤖</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#3C3489', marginBottom: 2 }}>
            AI settings have moved
          </div>
          <div style={{ fontSize: 12, color: '#534AB7', lineHeight: 1.5 }}>
            Generation sources (Playbook, Rules engine, AI enhancement), module toggles,
            and provider selection are now in{' '}
            <strong>Settings → AI → Preferences</strong>.
            Changes there take effect immediately — no need to save here.
          </div>
        </div>
      </div>

      {/* ── TRIGGER CONDITIONS ── */}
      <section className="settings-section">
        <h3>📘 Action Generation Triggers</h3>
        <p className="subtitle" style={{ marginBottom: 12 }}>
          When should the system automatically run action generation?
        </p>

        {isManual && (
          <div style={{
            fontSize: 12, color: '#92400e', background: '#fef3c7',
            border: '1px solid #fde68a', borderRadius: 6,
            padding: '8px 12px', marginBottom: 12,
          }}>
            ⚠️ All generation sources are off (manual mode) — these triggers will have no effect
            until you enable at least one source in AI → Preferences.
          </div>
        )}

        <div className="setting-group">
          <label className="setting-label">Trigger Action Generation When:</label>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={config.generate_on_stage_change}
              onChange={e => updateConfig('generate_on_stage_change', e.target.checked)}
            />
            <span>Deal stage changes</span>
          </label>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={config.generate_on_meeting_scheduled}
              onChange={e => updateConfig('generate_on_meeting_scheduled', e.target.checked)}
            />
            <span>Meeting is scheduled</span>
          </label>
          <label className="setting-checkbox">
            <input
              type="checkbox"
              checked={config.generate_on_email_next_steps}
              onChange={e => updateConfig('generate_on_email_next_steps', e.target.checked)}
            />
            <span>Email mentions next steps</span>
          </label>
        </div>
      </section>

      {/* ── STRAP GENERATION ── */}
      <section className="settings-section">
        <h3>🎯 STRAP Generation</h3>
        <p className="subtitle" style={{ marginBottom: 16 }}>
          When you click "Generate STRAP" on a deal, account, or prospect, this controls
          what you see.
        </p>

        <div className="setting-group">
          <label className="setting-label">How should STRAPs be generated for you?</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {[
              { value: 'both',     icon: '⚖️', label: 'Both (I choose)',    desc: 'Show me both playbook and AI versions side-by-side so I can compare and pick.' },
              { value: 'playbook', icon: '📘', label: 'Playbook template',  desc: 'Always use the playbook — fast, no AI needed.' },
              { value: 'ai',       icon: '🤖', label: 'AI-generated',       desc: 'Always use AI. Falls back to playbook if AI is unavailable.' },
            ].map(opt => {
              const isSelected = strapGenMode === opt.value;
              const dimmed     = opt.value !== 'playbook' && !masterEnabled;
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
          {!masterEnabled && (
            <p className="help-text" style={{ color: '#d97706', marginTop: 8 }}>
              ⚠️ Master AI is off — only Playbook mode is available. Enable AI in
              Settings → AI → Preferences to unlock AI generation.
            </p>
          )}
        </div>

        {/* AI Provider for STRAP — only shown when AI mode is active */}
        {(strapGenMode === 'ai' || strapGenMode === 'both') && masterEnabled && (
          <div className="setting-group">
            <label className="setting-label">AI provider for STRAP generation</label>
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
              If the selected provider's API key is not configured, generation will
              fall back to playbook template automatically.
            </p>
          </div>
        )}
      </section>

      {/* ── COMPLETION DETECTION ── */}
      <section className="settings-section">
        <h3>✨ Action Completion Detection</h3>

        <div className="setting-group">
          <label className="setting-label">Detection Mode</label>
          <select
            className="setting-select"
            value={config.detection_mode}
            onChange={e => updateConfig('detection_mode', e.target.value)}
          >
            <option value="hybrid">Hybrid (Rules + AI) — Recommended</option>
            <option value="ai_only">AI Only</option>
            <option value="rules_only">Rules Only</option>
            <option value="manual">Manual Only</option>
          </select>
          {config.detection_mode === 'hybrid' && (
            <div className="info-box">
              <strong>Hybrid Mode:</strong>
              <ul>
                <li>Simple matches use fast rule-based detection</li>
                <li>Ambiguous cases are analysed by AI</li>
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
              <input
                type="range" min="50" max="100" step="5"
                value={config.confidence_threshold}
                onChange={e => updateConfig('confidence_threshold', parseInt(e.target.value))}
                className="setting-slider"
              />
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
              <input
                type="range" min="50" max="100" step="5"
                value={config.auto_complete_threshold}
                onChange={e => updateConfig('auto_complete_threshold', parseInt(e.target.value))}
                className="setting-slider"
              />
              <div className="slider-labels">
                <span>50% (Auto-complete more)</span>
                <span>100% (Always ask first)</span>
              </div>
              <p className="help-text">Actions with confidence above this will be auto-completed without asking.</p>
            </div>

            <div className="setting-group">
              <label className="setting-label">Detect completions from:</label>
              <label className="setting-checkbox">
                <input
                  type="checkbox"
                  checked={config.detect_from_emails}
                  onChange={e => updateConfig('detect_from_emails', e.target.checked)}
                />
                <span>📧 Emails sent/received</span>
              </label>
              <label className="setting-checkbox">
                <input
                  type="checkbox"
                  checked={config.detect_from_meetings}
                  onChange={e => updateConfig('detect_from_meetings', e.target.checked)}
                />
                <span>📅 Meetings scheduled/completed</span>
              </label>
              <label className="setting-checkbox">
                <input type="checkbox" checked={config.detect_from_documents} disabled />
                <span>📄 Documents uploaded (coming soon)</span>
              </label>
            </div>

            <div className="setting-group">
              <label className="setting-checkbox">
                <input
                  type="checkbox"
                  checked={config.enable_learning}
                  onChange={e => updateConfig('enable_learning', e.target.checked)}
                />
                <span>Enable learning from my feedback</span>
              </label>
              <p className="help-text">
                System will improve accuracy over time based on which suggestions you accept or dismiss.
              </p>
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
            <h4>📘 Generation Sources</h4>
            <p>Control which sources generate actions in Settings → AI → Preferences.
            Playbook generates from your stage plays, Rules engine adds diagnostic alerts,
            and AI enhancement adds context-aware actions on top.</p>
          </div>
          <div className="help-card">
            <h4>✨ Auto-Detection</h4>
            <p>When you send an email with "demo deck" + attachment, the system:</p>
            <ul>
              <li>Finds the "Customise demo deck" action</li>
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
