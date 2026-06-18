/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAProspectingEnrichment. */
import React, { useState, useEffect } from 'react';

export default function OAProspectingEnrichment() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [config,          setConfig]        = useState(null);
  const [validProviders,  setValidProviders] = useState([]);
  const [configured,      setConfigured]    = useState([]);
  const [credentials,     setCredentials]   = useState([]);
  const [usage,           setUsage]         = useState(null);
  const [loading,         setLoading]       = useState(true);
  const [saving,          setSaving]        = useState(false);
  const [dirty,           setDirty]         = useState(false);
  const [flash,           setFlash]         = useState(null);
  const [newKeyProvider,  setNewKeyProvider] = useState('');
  const [newKeyValue,     setNewKeyValue]    = useState('');
  const [newKeyLabel,     setNewKeyLabel]    = useState('');

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  // Helper — load all three: config, credentials, usage.
  const reload = async () => {
    try {
      const [cfg, creds, use] = await Promise.all([
        fetch(`${API}/org/admin/enrichment-config`,      { headers }).then(r => r.json()),
        fetch(`${API}/org/admin/enrichment-credentials`, { headers }).then(r => r.json()),
        fetch(`${API}/org/admin/enrichment-usage`,       { headers }).then(r => r.json()),
      ]);
      setConfig(cfg.config || {});
      setValidProviders(cfg.valid_providers || []);
      setConfigured(cfg.configured_providers || []);
      setCredentials(creds.credentials || []);
      setUsage(use);
    } catch (e) {
      showFlash('error', 'Failed to load enrichment settings');
    }
  };

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = (key, val) => {
    setConfig(prev => ({ ...prev, [key]: val }));
    setDirty(true);
  };

  // Chain editor — move a provider up or down in the order, or toggle whether
  // it's in the chain at all.
  const toggleProviderInChain = (chainKey, provider) => {
    const current = Array.isArray(config[chainKey]) ? config[chainKey] : [];
    const next = current.includes(provider)
      ? current.filter(p => p !== provider)
      : [...current, provider];
    if (next.length === 0) {
      showFlash('error', 'At least one provider must be in the chain');
      return;
    }
    setField(chainKey, next);
  };

  const moveProviderInChain = (chainKey, provider, dir) => {
    const current = [...(config[chainKey] || [])];
    const idx = current.indexOf(provider);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= current.length) return;
    [current[idx], current[target]] = [current[target], current[idx]];
    setField(chainKey, current);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/org/admin/enrichment-config`, {
        method: 'PUT', headers,
        body: JSON.stringify({
          chain_company: config.chain_company,
          chain_person:  config.chain_person,
          monthly_cap:   config.monthly_cap,
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Save failed');
      setConfig(res.config);
      setDirty(false);
      showFlash('success', 'Enrichment configuration saved');
    } catch (e) {
      showFlash('error', e.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleAddKey = async () => {
    if (!newKeyProvider || !newKeyValue) {
      showFlash('error', 'Pick a provider and paste the API key');
      return;
    }
    try {
      const r = await fetch(`${API}/org/admin/enrichment-credentials`, {
        method: 'POST', headers,
        body: JSON.stringify({
          provider: newKeyProvider,
          api_key:  newKeyValue,
          label:    newKeyLabel || null,
        }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Failed to store key');
      setNewKeyProvider('');
      setNewKeyValue('');
      setNewKeyLabel('');
      showFlash('success', `Stored ${newKeyProvider} credential ending …${res.credential?.key_last4 || ''}`);
      await reload();
    } catch (e) {
      showFlash('error', e.message || 'Failed to store key');
    }
  };

  if (loading || !config) {
    return <div style={{ padding: 24, color: '#6b7280' }}>Loading enrichment settings…</div>;
  }

  const cardStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
    padding: 16, marginBottom: 12,
  };
  const helpStyle = { fontSize: 11, color: '#6b7280', marginTop: 4 };

  const PROVIDER_LABELS = {
    coresignal: 'CoreSignal',
    apollo:     'Apollo.io',
  };

  // Render one chain editor (company OR person). Shows providers in order
  // with up/down buttons and a toggle to include/exclude each.
  const ChainEditor = ({ chainKey, label, allowed }) => {
    const current = Array.isArray(config[chainKey]) ? config[chainKey] : [];
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 }}>{label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {current.map((prov, i) => (
            <div key={prov} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', background: '#f9fafb',
              border: '1px solid #e5e7eb', borderRadius: 6,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, color: '#6b7280', minWidth: 16,
              }}>{i + 1}.</span>
              <span style={{ flex: 1, fontSize: 13 }}>{PROVIDER_LABELS[prov] || prov}</span>
              {configured.includes(prov)
                ? <span style={{ fontSize: 10, color: '#16a34a' }}>● key configured</span>
                : <span style={{ fontSize: 10, color: '#f59e0b' }}>● no key</span>}
              <button
                disabled={i === 0}
                onClick={() => moveProviderInChain(chainKey, prov, -1)}
                style={{ padding: '2px 6px', fontSize: 11, cursor: i === 0 ? 'default' : 'pointer' }}
                title="Move up"
              >▲</button>
              <button
                disabled={i === current.length - 1}
                onClick={() => moveProviderInChain(chainKey, prov, +1)}
                style={{ padding: '2px 6px', fontSize: 11, cursor: i === current.length - 1 ? 'default' : 'pointer' }}
                title="Move down"
              >▼</button>
              <button
                onClick={() => toggleProviderInChain(chainKey, prov)}
                style={{ padding: '2px 6px', fontSize: 11, color: '#991b1b', cursor: 'pointer' }}
                title="Remove from chain"
              >✕</button>
            </div>
          ))}
        </div>
        {/* Providers not yet in the chain */}
        {allowed.filter(p => !current.includes(p)).length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
            Add:&nbsp;
            {allowed.filter(p => !current.includes(p)).map(p => (
              <button
                key={p}
                onClick={() => toggleProviderInChain(chainKey, p)}
                style={{
                  padding: '2px 8px', fontSize: 11, marginRight: 6,
                  background: '#fff', border: '1px solid #d1d5db', borderRadius: 4,
                  cursor: 'pointer', color: '#374151',
                }}
              >+ {PROVIDER_LABELS[p] || p}</button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 8, maxWidth: 820 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>
        💎 Enrichment
      </h3>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>
        Configure which providers enrich your prospects, in what order, and the
        monthly credit cap.
      </p>

      {flash && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
          background: flash.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      flash.type === 'error' ? '#991b1b' : '#166534',
          border: `1px solid ${flash.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* ── Usage tile ───────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 8 }}>
          This month's usage
        </div>
        {usage ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>{usage.total || 0}</span>
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                credits used
                {usage.cap ? ` of ${usage.cap} cap` : ' (no cap set)'}
              </span>
            </div>
            {usage.cap && (
              <div style={{ marginTop: 8, height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width:  `${Math.min(100, usage.percent_used || 0)}%`,
                  height: '100%',
                  background: usage.percent_used >= 90 ? '#dc2626'
                            : usage.percent_used >= 70 ? '#f59e0b'
                            : '#10b981',
                }} />
              </div>
            )}
            {Array.isArray(usage.by_provider) && usage.by_provider.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {usage.by_provider.map(p => (
                  <span key={p.provider} style={{
                    padding: '3px 8px', background: '#f3f4f6',
                    border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 11,
                  }}>
                    <strong>{PROVIDER_LABELS[p.provider] || p.provider}</strong>
                    <span style={{ color: '#6b7280', marginLeft: 6 }}>
                      {p.credits} credits · {p.calls} calls
                      {p.errors > 0 ? ` · ${p.errors} errors` : ''}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ color: '#9ca3af', fontSize: 12 }}>No usage data yet this month.</div>
        )}
      </div>

      {/* ── Monthly cap ─────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Monthly credit cap</div>
        <div style={helpStyle}>
          Hard stop. Enrichment calls return an error after this many credits
          in the current calendar month. Set to 0 (or leave blank) for no cap.
          At 90% of cap, all org admins get a one-time warning notification.
        </div>
        <div style={{ marginTop: 8 }}>
          <input
            type="number" min={0}
            value={config.monthly_cap ?? ''}
            placeholder="No cap"
            onChange={e => {
              const v = e.target.value.trim();
              setField('monthly_cap', v === '' ? null : parseInt(v) || 0);
            }}
            style={{
              width: 160, padding: '6px 10px', fontSize: 13,
              border: '1px solid #d1d5db', borderRadius: 6,
            }}
          />
          <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>credits / month</span>
        </div>
      </div>

      {/* ── Chains ──────────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>
          Provider chain
        </div>
        <div style={{ ...helpStyle, marginBottom: 10 }}>
          Providers are tried in order. If the first returns no_found or no key
          is configured, the next one is tried.
        </div>
        <ChainEditor chainKey="chain_company" label="Account / company enrichment" allowed={validProviders} />
        <ChainEditor chainKey="chain_person"  label="Person enrichment"           allowed={validProviders.filter(p => p === 'apollo')} />
      </div>

      {/* ── API keys ────────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>API keys</div>
        <div style={helpStyle}>
          Stored encrypted with AES-256-GCM. Only the last 4 characters are
          shown back. Rotating a key auto-revokes the previous one.
        </div>

        {/* Existing keys */}
        {credentials.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {credentials.map(c => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', background: '#f9fafb',
                border: '1px solid #e5e7eb', borderRadius: 6,
              }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{PROVIDER_LABELS[c.provider] || c.provider}</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>•••• {c.key_last4}</span>
                {c.label && <span style={{ fontSize: 11, color: '#9ca3af' }}>({c.label})</span>}
                <span style={{ flex: 1 }} />
                <span style={{
                  fontSize: 10,
                  color: c.status === 'active' ? '#16a34a' : c.status === 'invalid' ? '#dc2626' : '#6b7280',
                }}>● {c.status}</span>
              </div>
            ))}
          </div>
        )}

        {/* Add new key */}
        <div style={{
          marginTop: 12, padding: 12,
          background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Add a key</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              value={newKeyProvider}
              onChange={e => setNewKeyProvider(e.target.value)}
              style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}
            >
              <option value="">Select provider…</option>
              {validProviders.map(p => (
                <option key={p} value={p}>{PROVIDER_LABELS[p] || p}</option>
              ))}
            </select>
            <input
              type="password"
              placeholder="API key"
              value={newKeyValue}
              onChange={e => setNewKeyValue(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={newKeyLabel}
              onChange={e => setNewKeyLabel(e.target.value)}
              style={{ width: 180, padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6 }}
            />
            <button
              onClick={handleAddKey}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 600,
                color: '#fff', background: '#0F9D8E', border: 'none', borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Store key
            </button>
          </div>
        </div>
      </div>

      {/* ── Save bar ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            color: '#fff', background: dirty && !saving ? '#0F9D8E' : '#9ca3af',
            border: 'none', borderRadius: 6,
            cursor: dirty && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Saving…' : 'Save configuration'}
        </button>
      </div>
    </div>
  );
}
