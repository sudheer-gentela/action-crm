/**
 * OAAIProviderSettings.js
 *
 * Drop-in tab for OrgAdminView. Replaces the AI provider/model section
 * that lives in OAActionsAI today, expanding it to:
 *   - Multi-provider selection (registry-driven, not hardcoded)
 *   - Per-call-type model overrides
 *   - Org API key management (encrypted at rest)
 *   - Policy flags: allow_user_override, allow_user_byok
 *
 * Matches the existing OrgAdmin aesthetic: inline styles, ToggleSwitch from
 * the host file, Card-style sections, sticky save bar.
 *
 * Wire in OrgAdminView.js:
 *   import OAAIProviderSettings from './OAAIProviderSettings';
 *   ...
 *   { id: 'ai-providers', icon: '🧠', label: 'AI Providers' },   // in 'Auto Action Execution' group
 *   ...
 *   {tab === 'ai-providers' && <OAAIProviderSettings />}
 */

import React, { useState, useEffect, useCallback } from 'react';
import { EffectiveRoutingTable, ModelSlotSelect } from './AIModelRouting';

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

// ── Shared mini-components matching the host file's aesthetic ───────────────

function ToggleSwitch({ on, onChange, color = '#6366f1', disabled }) {
  return (
    <div
      onClick={() => !disabled && onChange()}
      style={{
        flexShrink: 0, width: 44, height: 24, borderRadius: 12,
        background: on ? color : '#d1d5db',
        position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background .2s', opacity: disabled ? 0.5 : 1,
      }}>
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3, left: on ? 23 : 3,
        transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </div>
  );
}

function Section({ title, desc, children, style }) {
  return (
    <div style={{ marginBottom: 28, ...style }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{title}</div>
      {desc && <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14, lineHeight: 1.5 }}>{desc}</p>}
      {children}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: '14px 18px', marginBottom: 10, ...style,
    }}>{children}</div>
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

function Pill({ children, tone = 'neutral' }) {
  const palette = {
    neutral: { bg: '#F1EFE8', fg: '#444441' },
    ok:      { bg: '#E1F5EE', fg: '#0F6E56' },
    warn:    { bg: '#FAEEDA', fg: '#854F0B' },
    danger:  { bg: '#FCEBEB', fg: '#A32D2D' },
    info:    { bg: '#E6F1FB', fg: '#0C447C' },
  }[tone] || { bg: '#F1EFE8', fg: '#444441' };
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 500,
      background: palette.bg, color: palette.fg, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function OAAIProviderSettings() {
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [dirty,    setDirty]    = useState(false);
  const [flash,    setFlash]    = useState(null);   // {kind, msg}

  const [providers,    setProviders]    = useState([]);
  const [callTypes,    setCallTypes]    = useState([]);
  const [config,       setConfig]       = useState(null);   // ai_settings
  const [providerStatus, setProviderStatus] = useState({}); // {provider: {has_org_key}}
  const [credentials,  setCredentials]  = useState([]);
  const [credsConfigured, setCredsConfigured] = useState(true);

  const [showAddKey,  setShowAddKey]  = useState(false);
  const [newKey,      setNewKey]      = useState({ provider: 'anthropic', api_key: '', label: '', endpoint_url: '' });
  const [addingKey,   setAddingKey]   = useState(false);

  const [discovery,   setDiscovery]   = useState(null);   // { last_run_at, last_run_status }
  const [refreshing,  setRefreshing]  = useState(false);
  // Bumped after every successful save/load so the effective-routing table
  // re-resolves against the backend (the table is resolver output, not a
  // client-side computation — it can never disagree with what actually runs).
  const [effectiveKey, setEffectiveKey] = useState(0);

  const showFlash = (kind, msg) => {
    setFlash({ kind, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [provRes, cfgRes, credsRes] = await Promise.all([
        apiFetch('/org/admin/ai/providers'),
        apiFetch('/org/admin/ai/config'),
        apiFetch('/org/admin/ai/credentials'),
      ]);
      setProviders(provRes.providers || []);
      setCallTypes(provRes.call_types || []);
      setCredsConfigured(provRes.credentials_configured);
      setDiscovery(provRes.discovery || null);
      setConfig(cfgRes.ai_settings);
      setProviderStatus(cfgRes.provider_status || {});
      setCredentials(credsRes.credentials || []);
      setDirty(false);
    } catch (e) {
      showFlash('error', 'Failed to load: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !config) {
    return <div style={{ padding: 32, color: '#6b7280' }}>Loading…</div>;
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const currentProvider = providers.find(p => p.id === config.ai_provider) || providers[0];
  const availableModels = currentProvider?.models || [];

  function updateConfig(patch) {
    setConfig(prev => ({ ...prev, ...patch }));
    setDirty(true);
  }

  function setCallTypeModel(callType, model) {
    setConfig(prev => ({
      ...prev,
      models_by_call_type: { ...(prev.models_by_call_type || {}), [callType]: model || undefined },
    }));
    setDirty(true);
  }

  function clearCallTypeModel(callType) {
    setConfig(prev => {
      const next = { ...(prev.models_by_call_type || {}) };
      delete next[callType];
      return { ...prev, models_by_call_type: next };
    });
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch('/org/admin/ai/config', {
        method: 'PATCH',
        body: JSON.stringify({
          ai_provider:         config.ai_provider,
          default_model:       config.default_model,
          models_by_call_type: config.models_by_call_type || {},
          allow_user_override: config.allow_user_override,
          allow_user_byok:     config.allow_user_byok,
        }),
      });
      setDirty(false);
      setEffectiveKey(k => k + 1);
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
      await apiFetch('/org/admin/ai/credentials', {
        method: 'POST',
        body: JSON.stringify(newKey),
      });
      setShowAddKey(false);
      setNewKey({ provider: 'anthropic', api_key: '', label: '', endpoint_url: '' });
      showFlash('success', 'Key added and validated ✓');
      await load();
    } catch (e) {
      showFlash('error', 'Could not add key: ' + e.message);
    } finally {
      setAddingKey(false);
    }
  }

  async function handleTestKey(credId) {
    try {
      const r = await apiFetch(`/org/admin/ai/credentials/${credId}/test`, { method: 'POST' });
      if (r.ok) showFlash('success', 'Test passed ✓');
      else showFlash('error', 'Test failed: ' + (r.error || 'unknown'));
      await load();
    } catch (e) {
      showFlash('error', 'Test failed: ' + e.message);
    }
  }

  async function handleRevokeKey(credId) {
    if (!window.confirm('Revoke this key? AI calls will fall back to a lower-priority key or the platform default.')) return;
    try {
      await apiFetch(`/org/admin/ai/credentials/${credId}`, { method: 'DELETE' });
      showFlash('success', 'Key revoked');
      await load();
    } catch (e) {
      showFlash('error', 'Revoke failed: ' + e.message);
    }
  }

  async function refreshModels() {
    setRefreshing(true);
    try {
      const r = await apiFetch('/org/admin/ai/refresh-models', { method: 'POST' });
      if (r.ran) {
        showFlash('success', r.message || 'Model list refreshed.');
        await load();   // re-pull /providers to pick up newly-discovered models
      } else if (r.reason === 'debounced') {
        showFlash('success', r.message || 'Models are already current.');
        await load();
      } else if (r.reason === 'disabled') {
        showFlash('error', r.message || 'On-demand refresh is disabled by the platform admin.');
      } else {
        showFlash('success', r.message || 'Done.');
      }
    } catch (e) {
      showFlash('error', 'Refresh failed: ' + e.message);
    } finally {
      setRefreshing(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 820, padding: '24px 0' }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>🧠 AI Providers</h2>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>
        Choose which AI provider and model power your org's AI features. Users can
        override these (unless you lock it below) and bring their own keys (if you allow it).
      </p>

      {!credsConfigured && (
        <Flash kind="error" msg="⚠️ Server key storage is not configured (AI_CREDS_KEY missing). Org-level keys cannot be saved. Calls will use the platform fallback." />
      )}
      {flash && <Flash kind={flash.kind} msg={flash.msg} />}

      {/* ── Model list freshness / refresh ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10,
        padding: '10px 16px', marginBottom: 20,
      }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          {discovery?.last_run_at
            ? <>Model lists last updated{' '}
                <strong style={{ color: '#374151' }}>
                  {timeAgo(discovery.last_run_at)}
                </strong>
                {discovery.last_run_status === 'error' && (
                  <span style={{ color: '#A32D2D', marginLeft: 6 }}>(last run had errors)</span>
                )}
              </>
            : 'Model lists have not been refreshed yet.'}
        </div>
        <button
          onClick={refreshModels}
          disabled={refreshing}
          style={{
            padding: '7px 14px', fontSize: 13, fontWeight: 500,
            background: refreshing ? '#cbd5e1' : '#fff',
            color: refreshing ? '#64748b' : '#334155',
            border: '1px solid #cbd5e1', borderRadius: 7,
            cursor: refreshing ? 'default' : 'pointer', whiteSpace: 'nowrap',
          }}>
          {refreshing ? 'Refreshing…' : '↻ Refresh models'}
        </button>
      </div>

      {/* ── Default provider & model ── */}
      <Section title="Default provider & model"
               desc="Used for every AI call unless you set a per-task override below.">
        <Card>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 6 }}>
                Provider
              </label>
              <select
                value={config.ai_provider}
                onChange={(e) => {
                  const newProv = e.target.value;
                  const provDef = providers.find(p => p.id === newProv);
                  const firstModel = provDef?.models?.[0]?.id || '';
                  updateConfig({ ai_provider: newProv, default_model: firstModel });
                }}
                style={selectStyle}
              >
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <ProviderKeyHint provider={currentProvider} status={providerStatus[config.ai_provider]} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 6 }}>
                Model
              </label>
              {currentProvider?.allowFreeFormModel ? (
                <input
                  type="text"
                  value={config.default_model || ''}
                  onChange={(e) => updateConfig({ default_model: e.target.value })}
                  placeholder="e.g. llama3.1, mistral-7b, …"
                  style={inputStyle}
                />
              ) : (
                <select
                  value={config.default_model || ''}
                  onChange={(e) => updateConfig({ default_model: e.target.value })}
                  style={selectStyle}
                >
                  {availableModels.map(m => (
                    <option key={m.id} value={m.id}>
                      {modelOptionLabel(m)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </Card>
      </Section>

      {/* ── Per-call-type overrides ── */}
      <Section title="Per-task model overrides"
               desc="Use a different model for specific tasks — any provider, not just the default one. Task overrides beat default models (yours and your users'). Leave blank to use the default above.">
        <Card style={{ padding: 0 }}>
          {Object.entries(groupBy(callTypes, 'group')).map(([group, items]) => (
            <div key={group}>
              <div style={{ padding: '10px 18px', background: '#f9fafb', borderBottom: '1px solid #f1f1ec', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                {group}
              </div>
              {items.map((ct, idx) => {
                const override = config.models_by_call_type?.[ct.id];
                const isLast = idx === items.length - 1;
                return (
                  <div key={ct.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 18px', borderBottom: isLast ? 'none' : '1px solid #f1f1ec', gap: 12,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{ct.label}</div>
                      <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{ct.id}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ModelSlotSelect
                        providers={providers}
                        value={override || ''}
                        legacyProvider={config.ai_provider}
                        onChange={(v) => v ? setCallTypeModel(ct.id, v) : clearCallTypeModel(ct.id)}
                        emptyLabel={`Use default (${modelLabel(config.default_model, availableModels)})`}
                        style={{ ...selectStyle, minWidth: 220, maxWidth: 280 }}
                      />
                      {override && (
                        <button onClick={() => clearCallTypeModel(ct.id)}
                                style={iconBtnStyle} title="Clear override">×</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </Card>
      </Section>

      {/* ── Effective routing (resolver output, not a client-side guess) ── */}
      <Section title="Effective routing"
               desc="What will actually serve each task right now, and which setting decided it — straight from the resolver. Per-user overrides may differ; this is the org-level view (a user with no personal overrides).">
        <Card style={{ padding: 0 }}>
          <EffectiveRoutingTable
            fetcher={apiFetch}
            endpoint="/org/admin/ai/effective"
            callTypes={callTypes}
            refreshKey={effectiveKey}
          />
        </Card>
        {dirty && (
          <p style={{ fontSize: 12, color: '#854F0B', marginTop: 6 }}>
            ⚠️ You have unsaved changes — this table reflects the last saved config.
          </p>
        )}
      </Section>

      {/* ── API keys ── */}
      <Section title="Org API keys"
               desc="Keys are encrypted at rest. If no org key exists for the active provider, calls fall back to the platform key (free tier).">
        <Card style={{ padding: 0 }}>
          {credentials.length === 0 && (
            <div style={{ padding: 18, fontSize: 13, color: '#6b7280' }}>
              No org-level keys configured. AI calls use the platform key.
            </div>
          )}
          {credentials.map((c, idx) => {
            const provDef = providers.find(p => p.id === c.provider);
            const isLast  = idx === credentials.length - 1;
            return (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 18px', borderBottom: isLast ? 'none' : '1px solid #f1f1ec', gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{provDef?.label || c.provider}</span>
                    {c.label && <Pill tone="neutral">{c.label}</Pill>}
                    {c.status === 'active'  && <Pill tone="ok">active</Pill>}
                    {c.status === 'invalid' && <Pill tone="danger">invalid</Pill>}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>
                    ••••{c.key_last4}{c.endpoint_url ? `  ·  ${c.endpoint_url}` : ''}
                  </div>
                  {c.last_validation_error && (
                    <div style={{ fontSize: 12, color: '#A32D2D', marginTop: 4 }}>
                      Last test: {c.last_validation_error}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => handleTestKey(c.id)} style={ghostBtnStyle}>Test</button>
                  <button onClick={() => handleRevokeKey(c.id)} style={dangerBtnStyle}>Revoke</button>
                </div>
              </div>
            );
          })}
        </Card>

        {!showAddKey ? (
          <button onClick={() => setShowAddKey(true)} style={primaryBtnStyle}>+ Add API key</button>
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
                  placeholder="e.g. Production key"
                  style={inputStyle}
                />
              </div>
            </div>
            {(() => {
              const provDef = providers.find(p => p.id === newKey.provider);
              if (!provDef?.requiresEndpoint) return null;
              return (
                <div style={{ marginBottom: 12 }}>
                  <label style={fieldLabelStyle}>Endpoint URL (required for {provDef.label})</label>
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
                We'll validate the key with a 1-token test call before saving. Plaintext is never stored or logged.
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
      </Section>

      {/* ── Policy ── */}
      <Section title="User policy"
               desc="Control how much flexibility individual users have.">
        <Card>
          <PolicyRow
            icon="🎚"
            title="Allow users to override the model"
            desc="When on, each user can pick their own provider and model in their personal Settings. When off, everyone uses the org default."
            on={config.allow_user_override !== false}
            onChange={() => updateConfig({ allow_user_override: !(config.allow_user_override !== false) })}
            color="#6366f1"
          />
        </Card>
        <Card>
          <PolicyRow
            icon="🔑"
            title="Allow users to bring their own API key"
            desc="When on, users can supply personal API keys for any provider. Useful for enterprise rollouts where individual users manage their own AI billing."
            on={config.allow_user_byok === true}
            onChange={() => updateConfig({ allow_user_byok: !(config.allow_user_byok === true) })}
            color="#534AB7"
          />
        </Card>
      </Section>

      {/* ── Sticky save bar ── */}
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function PolicyRow({ icon, title, desc, on, onChange, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{icon} {title}</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3, lineHeight: 1.5 }}>{desc}</div>
      </div>
      <ToggleSwitch on={on} onChange={onChange} color={color} />
    </div>
  );
}

function ProviderKeyHint({ provider, status }) {
  if (!provider) return null;
  const hasKey = status?.has_org_key;
  return (
    <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
      {hasKey
        ? <Pill tone="ok">Org key set</Pill>
        : <Pill tone="warn">Using platform fallback</Pill>}
      <span>· {provider.label}</span>
    </div>
  );
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || 'other';
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}

function modelLabel(modelId, models) {
  if (!modelId) return '—';
  const m = models.find(x => x.id === modelId);
  return m ? m.label : modelId;
}

// Label for an <option> in a model dropdown. Discovered-only models (not yet
// in the static registry) are tagged "NEW" — they're selectable immediately;
// only their cost is pending a registry backfill.
function modelOptionLabel(m) {
  let s = m.label || m.id;
  if (m.tier) s += ` — ${m.tier}`;
  if (m.source === 'discovered') s += '  • NEW';
  return s;
}

// Compact relative time, e.g. "3 minutes ago", "2 days ago".
function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ── Style tokens that match the existing OrgAdmin pages ─────────────────────

const selectStyle = {
  width: '100%', padding: '7px 10px', fontSize: 14,
  border: '1px solid #d1d5db', borderRadius: 7, background: '#fff',
  color: '#111827', outline: 'none',
};
const inputStyle = {
  width: '100%', padding: '7px 10px', fontSize: 14,
  border: '1px solid #d1d5db', borderRadius: 7, background: '#fff',
  color: '#111827', outline: 'none', boxSizing: 'border-box',
};
const fieldLabelStyle = {
  fontSize: 12, fontWeight: 500, color: '#6b7280', display: 'block', marginBottom: 6,
};
const primaryBtnStyle = {
  padding: '8px 16px', fontSize: 13, fontWeight: 500,
  background: '#E8630A', color: '#fff', border: 'none', borderRadius: 7,
  cursor: 'pointer', marginTop: 10,
};
const ghostBtnStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500,
  background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7,
  cursor: 'pointer',
};
const dangerBtnStyle = {
  padding: '7px 14px', fontSize: 13, fontWeight: 500,
  background: '#fff', color: '#A32D2D', border: '1px solid #fecaca', borderRadius: 7,
  cursor: 'pointer',
};
const iconBtnStyle = {
  width: 26, height: 26, padding: 0, border: '1px solid #d1d5db',
  borderRadius: 6, background: '#fff', cursor: 'pointer',
  fontSize: 16, color: '#6b7280', lineHeight: 1,
};
const saveBarStyle = {
  position: 'sticky', bottom: 0, marginTop: 24,
  padding: '14px 20px', background: '#FEF3C7', border: '1px solid #FCD34D',
  borderRadius: 10, display: 'flex', justifyContent: 'space-between',
  alignItems: 'center', boxShadow: '0 -2px 6px rgba(0,0,0,0.04)',
  zIndex: 5,
};
