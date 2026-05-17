/**
 * UserAIProviderSettings.js
 *
 * Drop-in panel for SettingsView under AI > Preferences. Sits alongside
 * (or replaces) ActionAISettings. Shows:
 *   - Effective provider/model with org defaults as ghost text
 *   - Personal per-call-type overrides (only if allow_user_override)
 *   - Personal BYOK key management (only if allow_user_byok)
 *
 * Both sections collapse with a clear lock message when the org has
 * disabled the relevant policy.
 *
 * Wire in SettingsView.js:
 *   import UserAIProviderSettings from './UserAIProviderSettings';
 *   ...
 *   { id: 'ai-providers', label: 'Providers & Keys' }   // under AI Settings children
 *   ...
 *   {activeId === 'ai-providers' && <UserAIProviderSettings />}
 */

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL || '';

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function apiFetch(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || r.statusText);
  return data;
}

// ── Local mini-components (kept inline to match other Settings panels) ─────

function Card({ children, style }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: '16px 18px', marginBottom: 12, ...style,
    }}>{children}</div>
  );
}

function Pill({ children, tone = 'neutral' }) {
  const palette = {
    neutral: { bg: '#F1EFE8', fg: '#444441' },
    ok:      { bg: '#E1F5EE', fg: '#0F6E56' },
    warn:    { bg: '#FAEEDA', fg: '#854F0B' },
    danger:  { bg: '#FCEBEB', fg: '#A32D2D' },
    locked:  { bg: '#E6E5DE', fg: '#5F5E5A' },
  }[tone];
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 500,
      background: palette.bg, color: palette.fg, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Flash({ kind, msg }) {
  if (!msg) return null;
  const isOk = kind === 'success';
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8, fontSize: 14, marginBottom: 16,
      background: isOk ? '#d1fae5' : '#fef2f2',
      color:      isOk ? '#065f46' : '#991b1b',
      border:     `1px solid ${isOk ? '#a7f3d0' : '#fecaca'}`,
    }}>{msg}</div>
  );
}

function LockedSection({ icon, title, msg }) {
  return (
    <div style={{
      background: '#fafaf7', border: '1px dashed #d1d5db', borderRadius: 10,
      padding: '20px 22px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 14,
    }}>
      <div style={{ fontSize: 22 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          {title} <Pill tone="locked">Org policy</Pill>
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', margin: 0, lineHeight: 1.5 }}>{msg}</p>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function UserAIProviderSettings() {
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [dirty,      setDirty]      = useState(false);
  const [flash,      setFlash]      = useState(null);

  const [data,       setData]       = useState(null);  // {policy, user_settings, providers, call_types}
  const [credentials, setCredentials] = useState([]);

  const [showAddKey, setShowAddKey] = useState(false);
  const [newKey,     setNewKey]     = useState({ provider: 'anthropic', api_key: '', label: '', endpoint_url: '' });
  const [addingKey,  setAddingKey]  = useState(false);

  const showFlash = (kind, msg) => {
    setFlash({ kind, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, credsRes] = await Promise.all([
        apiFetch('/me/ai/config'),
        apiFetch('/me/ai/credentials').catch(() => ({ credentials: [] })),
      ]);
      setData(cfgRes);
      setCredentials(credsRes.credentials || []);
      setDirty(false);
    } catch (e) {
      showFlash('error', 'Failed to load: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return <div style={{ padding: 32, color: '#6b7280' }}>Loading…</div>;
  }

  const { policy, user_settings, providers } = data;

  // The effective provider/model — what the user is actually getting
  const effectiveProvider = user_settings.ai_provider || policy.org_provider;
  const effectiveModel    = user_settings.default_model || policy.org_model;
  const provDef           = providers.find(p => p.id === effectiveProvider);

  function setOverride(patch) {
    setData(prev => ({
      ...prev,
      user_settings: { ...prev.user_settings, ...patch },
    }));
    setDirty(true);
  }

  function clearOverride() {
    setData(prev => ({
      ...prev,
      user_settings: { ai_provider: null, default_model: null, models_by_call_type: {} },
    }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch('/me/ai/config', {
        method: 'PATCH',
        body: JSON.stringify({
          ai_provider:         user_settings.ai_provider,
          default_model:       user_settings.default_model,
          models_by_call_type: user_settings.models_by_call_type || {},
        }),
      });
      setDirty(false);
      showFlash('success', 'Saved ✓');
    } catch (e) {
      showFlash('error', 'Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddKey() {
    setAddingKey(true);
    try {
      await apiFetch('/me/ai/credentials', {
        method: 'POST',
        body: JSON.stringify(newKey),
      });
      setShowAddKey(false);
      setNewKey({ provider: 'anthropic', api_key: '', label: '', endpoint_url: '' });
      showFlash('success', 'Key added ✓');
      await load();
    } catch (e) {
      showFlash('error', 'Could not add key: ' + e.message);
    } finally {
      setAddingKey(false);
    }
  }

  async function handleRevoke(credId) {
    if (!window.confirm('Revoke this key? AI calls will fall back to your org default.')) return;
    try {
      await apiFetch(`/me/ai/credentials/${credId}`, { method: 'DELETE' });
      showFlash('success', 'Revoked');
      await load();
    } catch (e) {
      showFlash('error', 'Revoke failed: ' + e.message);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 700, padding: '24px 0' }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>🧠 AI Providers & Keys</h2>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>
        Override your org's default AI model for your own work, and optionally use your own API key.
      </p>

      {flash && <Flash kind={flash.kind} msg={flash.msg} />}

      {/* ── Effective settings card ── */}
      <Card style={{ background: '#FAFBFD', border: '1px solid #DDE4ED' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 8 }}>
          What you're using right now
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>{provDef?.label || effectiveProvider}</span>
          <span style={{ fontSize: 13, color: '#6b7280' }}>·</span>
          <span style={{ fontSize: 14, fontFamily: 'monospace', color: '#374151' }}>{effectiveModel}</span>
          {user_settings.ai_provider || user_settings.default_model
            ? <Pill tone="warn">Your override</Pill>
            : <Pill tone="ok">Org default</Pill>}
        </div>
      </Card>

      {/* ── Override section ── */}
      {policy.allow_user_override ? (
        <>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginTop: 28, marginBottom: 4 }}>
            Personal override
          </h3>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12, lineHeight: 1.5 }}>
            Use a different provider or model than your org default. Leave blank to inherit from your org.
          </p>
          <Card>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
              <div>
                <label style={fieldLabelStyle}>Provider</label>
                <select
                  value={user_settings.ai_provider || ''}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setOverride({ ai_provider: v, default_model: null });
                  }}
                  style={selectStyle}
                >
                  <option value="">Use org default ({providerLabel(policy.org_provider, providers)})</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={fieldLabelStyle}>Model</label>
                {(() => {
                  const targetProv = user_settings.ai_provider || policy.org_provider;
                  const def = providers.find(p => p.id === targetProv);
                  const models = def?.models || [];
                  if (def?.allowFreeFormModel) {
                    return (
                      <input
                        type="text"
                        value={user_settings.default_model || ''}
                        onChange={(e) => setOverride({ default_model: e.target.value || null })}
                        placeholder="model id"
                        style={inputStyle}
                      />
                    );
                  }
                  return (
                    <select
                      value={user_settings.default_model || ''}
                      onChange={(e) => setOverride({ default_model: e.target.value || null })}
                      style={selectStyle}
                    >
                      <option value="">Use org default ({policy.org_model})</option>
                      {models.map(m => (
                        <option key={m.id} value={m.id}>{m.label}{m.tier ? ` — ${m.tier}` : ''}</option>
                      ))}
                    </select>
                  );
                })()}
              </div>
            </div>
            {(user_settings.ai_provider || user_settings.default_model) && (
              <button onClick={clearOverride} style={ghostBtnStyle}>
                Clear override & use org default
              </button>
            )}
          </Card>
        </>
      ) : (
        <LockedSection
          icon="🎚"
          title="Personal model override"
          msg="Your organization requires everyone to use the same model. Contact your org admin if you need a different one."
        />
      )}

      {/* ── BYOK section ── */}
      {policy.allow_user_byok ? (
        <>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginTop: 28, marginBottom: 4 }}>
            Your API keys
          </h3>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12, lineHeight: 1.5 }}>
            Add your own API keys to bill AI usage to your personal account. Keys are encrypted at rest and never shared.
          </p>

          <Card style={{ padding: 0 }}>
            {credentials.length === 0 && (
              <div style={{ padding: 18, fontSize: 13, color: '#6b7280' }}>
                No personal keys. AI calls use your org's key (or the platform key).
              </div>
            )}
            {credentials.map((c, idx) => {
              const provLabel = providers.find(p => p.id === c.provider)?.label || c.provider;
              const isLast = idx === credentials.length - 1;
              return (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 18px', borderBottom: isLast ? 'none' : '1px solid #f1f1ec', gap: 12,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{provLabel}</span>
                      {c.label && <Pill tone="neutral">{c.label}</Pill>}
                      {c.status === 'active'  && <Pill tone="ok">active</Pill>}
                      {c.status === 'invalid' && <Pill tone="danger">invalid</Pill>}
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>
                      ••••{c.key_last4}{c.endpoint_url ? `  ·  ${c.endpoint_url}` : ''}
                    </div>
                  </div>
                  <button onClick={() => handleRevoke(c.id)} style={dangerBtnStyle}>Revoke</button>
                </div>
              );
            })}
          </Card>

          {!showAddKey ? (
            <button onClick={() => setShowAddKey(true)} style={primaryBtnStyle}>+ Add my API key</button>
          ) : (
            <Card style={{ background: '#f9fafb', border: '1px dashed #d1d5db', marginTop: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={fieldLabelStyle}>Provider</label>
                  <select
                    value={newKey.provider}
                    onChange={(e) => setNewKey(k => ({ ...k, provider: e.target.value, endpoint_url: '' }))}
                    style={selectStyle}
                  >
                    {providers.map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={fieldLabelStyle}>Label (optional)</label>
                  <input
                    type="text"
                    value={newKey.label}
                    onChange={(e) => setNewKey(k => ({ ...k, label: e.target.value }))}
                    placeholder="e.g. Personal"
                    style={inputStyle}
                  />
                </div>
              </div>
              {(() => {
                const provDef = providers.find(p => p.id === newKey.provider);
                if (!provDef?.requiresEndpoint) return null;
                return (
                  <div style={{ marginBottom: 12 }}>
                    <label style={fieldLabelStyle}>Endpoint URL</label>
                    <input
                      type="text"
                      value={newKey.endpoint_url}
                      onChange={(e) => setNewKey(k => ({ ...k, endpoint_url: e.target.value }))}
                      placeholder="https://your-llm-gateway.example.com/v1"
                      style={inputStyle}
                    />
                  </div>
                );
              })()}
              <div style={{ marginBottom: 12 }}>
                <label style={fieldLabelStyle}>API key</label>
                <input
                  type="password"
                  value={newKey.api_key}
                  onChange={(e) => setNewKey(k => ({ ...k, api_key: e.target.value }))}
                  placeholder={providers.find(p => p.id === newKey.provider)?.keyHint || ''}
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                />
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                  We'll validate the key with a tiny test call before saving. Plaintext is never stored or logged.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowAddKey(false)} style={ghostBtnStyle} disabled={addingKey}>Cancel</button>
                <button onClick={handleAddKey} style={primaryBtnStyle} disabled={addingKey || !newKey.api_key}>
                  {addingKey ? 'Validating…' : 'Add & validate'}
                </button>
              </div>
            </Card>
          )}
        </>
      ) : (
        <LockedSection
          icon="🔑"
          title="Bring your own API key"
          msg="Your organization has not enabled bring-your-own-key. AI usage runs on the org or platform key."
        />
      )}

      {/* ── Save bar ── */}
      {dirty && (
        <div style={saveBarStyle}>
          <span style={{ fontSize: 13, color: '#92400e' }}>You have unsaved changes</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => load()} style={ghostBtnStyle} disabled={saving}>Discard</button>
            <button onClick={handleSave} style={primaryBtnStyle} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function providerLabel(id, providers) {
  return providers.find(p => p.id === id)?.label || id;
}

// ── Styles — keep identical to OAAIProviderSettings for visual consistency ──
const selectStyle  = { width: '100%', padding: '7px 10px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 7, background: '#fff', color: '#111827', outline: 'none' };
const inputStyle   = { width: '100%', padding: '7px 10px', fontSize: 14, border: '1px solid #d1d5db', borderRadius: 7, background: '#fff', color: '#111827', outline: 'none', boxSizing: 'border-box' };
const fieldLabelStyle = { fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 6 };
const primaryBtnStyle = { padding: '8px 16px', fontSize: 13, fontWeight: 500, background: '#E8630A', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', marginTop: 10 };
const ghostBtnStyle   = { padding: '7px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7, cursor: 'pointer' };
const dangerBtnStyle  = { padding: '7px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#A32D2D', border: '1px solid #fecaca', borderRadius: 7, cursor: 'pointer' };
const saveBarStyle    = { position: 'sticky', bottom: 0, marginTop: 24, padding: '14px 20px', background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: '0 -2px 6px rgba(0,0,0,0.04)', zIndex: 5 };
