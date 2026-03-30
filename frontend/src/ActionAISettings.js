/**
 * ActionAISettings.js
 *
 * Renders under Settings → AI → Preferences.
 * Two tabs: "Action system" and "Provider & model".
 *
 * Reads:  GET  /api/action-config  (merged org defaults + user overrides)
 * Writes: PATCH /api/action-config (user overrides only)
 *
 * The config response shape:
 *   config.ai_settings            — fully resolved (org + user merged)
 *   config.org_ai_settings        — org defaults only (for badge display)
 *   config.generation_mode        — array e.g. ["playbook","rules","ai"]
 */

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL;

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODULES = [
  { key: 'deals',       label: 'Deals',             hint: 'AI-enhanced action generation for deal opportunities' },
  { key: 'straps',      label: 'STRAPs',             hint: 'AI generation of relationship and account actions' },
  { key: 'clm',         label: 'Contracts (CLM)',    hint: 'AI suggestions for contract workflows' },
  { key: 'prospecting', label: 'Prospecting',        hint: 'AI-generated actions for prospect pipelines' },
];

const SOURCES = [
  { key: 'playbook', label: 'Playbook',       hint: 'Generate actions from your sales playbook' },
  { key: 'rules',    label: 'Rules engine',   hint: 'Run diagnostic rules on deal health and activity' },
  { key: 'ai',       label: 'AI enhancement', hint: 'Add AI-generated context-aware actions on top of rules' },
];

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic', sub: 'Claude models' },
  { value: 'openai',    label: 'OpenAI',    sub: 'GPT-4 models' },
  { value: 'gemini',    label: 'Google',    sub: 'Gemini models' },
];

const MODELS = {
  anthropic: [
    { value: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku',  hint: 'Fast and economical' },
    { value: 'claude-sonnet-4-6',          label: 'Claude Sonnet', hint: 'Balanced' },
    { value: 'claude-opus-4-6',            label: 'Claude Opus',   hint: 'Most capable' },
  ],
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini', hint: 'Fast and economical' },
    { value: 'gpt-4o',      label: 'GPT-4o',      hint: 'Most capable' },
  ],
  gemini: [
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', hint: 'Fast' },
    { value: 'gemini-1.5-pro',   label: 'Gemini 1.5 Pro',   hint: 'Most capable' },
  ],
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => !disabled && onChange(!on)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: on && !disabled ? '#534AB7' : '#d1d5db',
        position: 'relative', flexShrink: 0, padding: 0,
        opacity: disabled ? 0.4 : 1, transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, width: 16, height: 16,
        borderRadius: '50%', background: '#fff',
        left: on ? 18 : 2, transition: 'left .15s',
        boxShadow: '0 1px 2px rgba(0,0,0,.2)',
      }} />
    </button>
  );
}

function OrgBadge({ on, isOverride, orgLabel }) {
  if (isOverride) {
    return (
      <span style={{
        fontSize: 10, padding: '2px 7px', borderRadius: 4, fontWeight: 500,
        background: '#FAEEDA', color: '#854F0B', whiteSpace: 'nowrap', flexShrink: 0,
      }}>Your override</span>
    );
  }
  return (
    <span style={{
      fontSize: 10, padding: '2px 7px', borderRadius: 4, fontWeight: 500,
      background: on ? '#E1F5EE' : '#F1EFE8',
      color:      on ? '#0F6E56' : '#5F5E5A',
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {orgLabel || (on ? 'Org: on' : 'Org: off')}
    </span>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: 10, padding: '16px 18px', marginBottom: 12, ...style,
    }}>
      {children}
    </div>
  );
}

function Flash({ flash }) {
  if (!flash) return null;
  return (
    <div style={{
      margin: '0 0 12px', padding: '9px 14px', borderRadius: 8,
      fontSize: 13, fontWeight: 500,
      background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
      color:      flash.type === 'success' ? '#065f46'  : '#991b1b',
      border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
    }}>
      {flash.msg}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ActionAISettings() {
  const [config,      setConfig]      = useState(null);
  const [orgSettings, setOrgSettings] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [flash,       setFlash]       = useState(null);
  const [activeTab,   setActiveTab]   = useState('modules');

  // Pending changes — built up locally, sent on Save
  const [pending, setPending] = useState({});

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch(`${API}/action-config`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Failed to load');
      setConfig(data.config);
      setOrgSettings(data.config.org_ai_settings || {});
      setPending({});
    } catch (err) {
      showFlash('error', 'Could not load AI settings: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derived values (pending overrides resolved config) ───────────────────

  const ai       = config?.ai_settings || {};
  const orgAI    = orgSettings || {};

  const masterOn  = pending.ai_settings?.master_enabled    !== undefined
    ? pending.ai_settings.master_enabled
    : ai.master_enabled ?? true;

  const genSources = pending.generation_mode !== undefined
    ? pending.generation_mode
    : (config?.generation_mode || ai.generation_mode || ['playbook','rules','ai']);

  const provider = pending.ai_settings?.ai_provider !== undefined
    ? pending.ai_settings.ai_provider
    : ai.ai_provider || 'anthropic';

  const model = pending.ai_settings?.default_model !== undefined
    ? pending.ai_settings.default_model
    : ai.default_model || '';

  function getModuleOn(mod) {
    if (pending.ai_settings?.modules?.[mod] !== undefined)
      return pending.ai_settings.modules[mod];
    return ai.modules?.[mod] ?? true;
  }

  function isModuleOverride(mod) {
    if (pending.ai_settings?.modules?.[mod] !== undefined)
      return pending.ai_settings.modules[mod] !== (orgAI.modules?.[mod] ?? true);
    return ai._userSet?.[mod] && ai.modules?.[mod] !== (orgAI.modules?.[mod] ?? true);
  }

  function isMasterOverride() {
    if (pending.ai_settings?.master_enabled !== undefined)
      return pending.ai_settings.master_enabled !== (orgAI.master_enabled ?? true);
    return ai._userSet?.master_enabled && ai.master_enabled !== (orgAI.master_enabled ?? true);
  }

  // ── Patch helpers ─────────────────────────────────────────────────────────

  function patchAI(key, value) {
    setPending(prev => ({
      ...prev,
      ai_settings: { ...(prev.ai_settings || {}), [key]: value },
    }));
  }

  function patchModule(mod, value) {
    setPending(prev => ({
      ...prev,
      ai_settings: {
        ...(prev.ai_settings || {}),
        modules: { ...(prev.ai_settings?.modules || {}), [mod]: value },
      },
    }));
  }

  function patchSource(src, checked) {
    const current = [...genSources];
    const next = checked
      ? [...new Set([...current, src])]
      : current.filter(s => s !== src);
    setPending(prev => ({ ...prev, generation_mode: next }));
  }

  function resetToOrgDefaults() {
    // Clear all user overrides by sending explicit org values
    const orgModules = orgAI.modules || {};
    setPending({
      ai_settings: {
        master_enabled: orgAI.master_enabled ?? true,
        modules: {
          deals:       orgModules.deals       ?? true,
          straps:      orgModules.straps      ?? true,
          clm:         orgModules.clm         ?? false,
          prospecting: orgModules.prospecting ?? false,
        },
        ai_provider:   orgAI.ai_provider   || 'anthropic',
        default_model: orgAI.default_model || '',
      },
      generation_mode: orgAI.generation_mode || ['playbook','rules','ai'],
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (Object.keys(pending).length === 0) {
      showFlash('success', 'No changes to save.');
      return;
    }
    setSaving(true);
    try {
      const res  = await fetch(`${API}/action-config`, {
        method:  'PATCH',
        headers: authHeaders(),
        body:    JSON.stringify(pending),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Save failed');
      setConfig(data.config);
      setOrgSettings(data.config.org_ai_settings || {});
      setPending({});
      showFlash('success', 'AI settings saved.');
    } catch (err) {
      showFlash('error', 'Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="sv-panel">
      <div style={{ padding: 32, color: '#9ca3af', fontSize: 13 }}>Loading AI settings…</div>
    </div>
  );

  const tabStyle = (id) => ({
    fontSize: 13, padding: '7px 16px', border: 'none', background: 'none',
    cursor: 'pointer', borderBottom: `2px solid ${activeTab === id ? '#534AB7' : 'transparent'}`,
    color: activeTab === id ? '#534AB7' : '#6b7280',
    fontWeight: activeTab === id ? 500 : 400, marginBottom: -1,
  });

  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
    borderBottom: '1px solid #f3f4f6',
  };
  const lastRowStyle = { ...rowStyle, borderBottom: 'none', paddingBottom: 0 };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>AI preferences</h2>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Your personal AI settings. Badges show the org default — changing a value creates your own override.
          </p>
        </div>
      </div>

      <div className="sv-panel-body">
        <Flash flash={flash} />

        {/* ── Tab row ── */}
        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: 16 }}>
          <button style={tabStyle('modules')} onClick={() => setActiveTab('modules')}>Action system</button>
          <button style={tabStyle('provider')} onClick={() => setActiveTab('provider')}>Provider &amp; model</button>
        </div>

        {/* ══ ACTION SYSTEM TAB ══ */}
        {activeTab === 'modules' && (
          <>
            {/* Master toggle */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: masterOn ? '#EEEDFE' : '#f9fafb',
              border: `1px solid ${masterOn ? '#AFA9EC' : '#e5e7eb'}`,
              borderRadius: 8, padding: '11px 14px', marginBottom: 12,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: masterOn ? '#3C3489' : '#6b7280' }}>
                  {masterOn ? 'AI enabled' : 'AI disabled'}
                </div>
                <div style={{ fontSize: 11, color: masterOn ? '#534AB7' : '#9ca3af', marginTop: 2 }}>
                  {masterOn ? 'All AI features active for your account' : 'AI is off — module toggles are inactive'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <OrgBadge
                  on={orgAI.master_enabled ?? true}
                  isOverride={isMasterOverride()}
                  orgLabel={`Org default: ${(orgAI.master_enabled ?? true) ? 'on' : 'off'}`}
                />
                <Toggle on={masterOn} onChange={v => patchAI('master_enabled', v)} />
              </div>
            </div>

            {/* Module toggles */}
            <Card>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>Modules</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
                Turn off any module where you don't want AI running for your account.
              </div>
              {MODULES.map((mod, i) => (
                <div key={mod.key} style={i === MODULES.length - 1 ? lastRowStyle : rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: '#111827' }}>{mod.label}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{mod.hint}</div>
                  </div>
                  <OrgBadge
                    on={orgAI.modules?.[mod.key] ?? (mod.key === 'deals' || mod.key === 'straps')}
                    isOverride={isModuleOverride(mod.key)}
                  />
                  <Toggle
                    on={getModuleOn(mod.key)}
                    onChange={v => patchModule(mod.key, v)}
                    disabled={!masterOn}
                  />
                </div>
              ))}
            </Card>

            {/* Generation sources multi-select */}
            <Card>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>Generation sources</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
                Which sources generate actions for your deals. Uncheck all = manual mode.
              </div>
              {SOURCES.map((src, i) => {
                // Playbook and Rules engine are independent of the AI master toggle.
                // Only AI enhancement requires master AI to be on.
                const isDisabled = src.key === 'ai' && !masterOn;
                return (
                  <div key={src.key} style={i === SOURCES.length - 1 ? lastRowStyle : rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: isDisabled ? '#9ca3af' : '#111827' }}>{src.label}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{src.hint}</div>
                      {isDisabled && (
                        <div style={{ fontSize: 10, color: '#d97706', marginTop: 2 }}>
                          Enable master AI toggle above to use this source
                        </div>
                      )}
                    </div>
                    <input
                      type="checkbox"
                      checked={genSources.includes(src.key)}
                      onChange={e => patchSource(src.key, e.target.checked)}
                      disabled={isDisabled}
                      style={{ width: 15, height: 15, accentColor: '#534AB7', cursor: isDisabled ? 'not-allowed' : 'pointer', flexShrink: 0, opacity: isDisabled ? 0.4 : 1 }}
                    />
                  </div>
                );
              })}
              {genSources.length === 0 && (
                <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 8, padding: '6px 10px', background: '#fef3c7', borderRadius: 6 }}>
                  All sources off — actions will not be generated automatically (manual mode).
                </div>
              )}
            </Card>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
              <button
                onClick={resetToOrgDefaults}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: 'none', color: '#6b7280', cursor: 'pointer' }}
              >
                Reset to org defaults
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ fontSize: 13, padding: '7px 20px', borderRadius: 6, border: 'none', background: '#534AB7', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}

        {/* ══ PROVIDER & MODEL TAB ══ */}
        {activeTab === 'provider' && (
          <>
            <Card>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>AI provider</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
                Which provider powers action generation for your account.
                {orgAI.ai_provider && (
                  <span style={{ marginLeft: 6, color: '#0F6E56', fontWeight: 500 }}>
                    Org default: {orgAI.ai_provider}
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {PROVIDERS.map(p => (
                  <button
                    key={p.value}
                    onClick={() => patchAI('ai_provider', p.value)}
                    style={{
                      border: provider === p.value ? '2px solid #534AB7' : '1px solid #e5e7eb',
                      borderRadius: 8, padding: '10px 12px', cursor: 'pointer', textAlign: 'left',
                      background: provider === p.value ? '#EEEDFE' : '#fff',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 500, color: '#111827' }}>{p.label}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{p.sub}</div>
                    {(orgAI.ai_provider || 'anthropic') === p.value && (
                      <div style={{ fontSize: 10, color: '#0F6E56', marginTop: 4, fontWeight: 500 }}>Org default</div>
                    )}
                  </button>
                ))}
              </div>
            </Card>

            <Card>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>Model</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
                Specific model to use. Faster models cost less but may produce less nuanced actions.
              </div>
              {(MODELS[provider] || MODELS.anthropic).map((m, i, arr) => (
                <div key={m.value} style={i === arr.length - 1 ? lastRowStyle : rowStyle}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: '#111827' }}>{m.label}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{m.hint}</div>
                  </div>
                  {(orgAI.default_model || (MODELS[provider]?.[0]?.value)) === m.value && (
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: '#E1F5EE', color: '#0F6E56', fontWeight: 500 }}>
                      Org default
                    </span>
                  )}
                  <input
                    type="radio"
                    name="ai-model"
                    checked={model === m.value || (!model && i === 0)}
                    onChange={() => patchAI('default_model', m.value)}
                    style={{ accentColor: '#534AB7', width: 15, height: 15, flexShrink: 0, cursor: 'pointer' }}
                  />
                </div>
              ))}
            </Card>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 4 }}>
              <button
                onClick={resetToOrgDefaults}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: 'none', color: '#6b7280', cursor: 'pointer' }}
              >
                Reset to org defaults
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{ fontSize: 13, padding: '7px 20px', borderRadius: 6, border: 'none', background: '#534AB7', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
