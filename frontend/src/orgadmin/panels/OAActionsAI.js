/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAActionsAI. */
import React, { useState, useEffect } from 'react';
import { ToggleSwitch } from '../shared';

export default function OAActionsAI() {
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
