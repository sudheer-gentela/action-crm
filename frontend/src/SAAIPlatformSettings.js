/**
 * SAAIPlatformSettings.js
 *
 * SuperAdmin sub-tab under Platform Settings. Read-mostly view of:
 *   - Which providers are enabled platform-wide (allowlist)
 *   - Status of each provider's fallback env-var key
 *   - Whether AI_CREDS_KEY is configured for org-level secret storage
 *   - 30-day usage rollup by provider & key source
 *
 * Env-var keys are NOT editable here. They live in the deploy environment.
 * This screen lets SuperAdmin verify deployment without shelling into Railway.
 *
 * Wire in SuperAdminView.js SAPlatformSettings():
 *   const SUB_TABS = [
 *     { id: 'email-filter', label: '📧 Email Filter Defaults' },
 *     { id: 'integrations', label: '🔌 CRM Integrations' },
 *     { id: 'ai',           label: '🧠 AI Providers' },        // ← new
 *   ];
 *   ...
 *   {subTab === 'ai' && <SAAIPlatformSettings />}
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

function Pill({ children, tone }) {
  const palette = {
    ok:     { bg: '#E1F5EE', fg: '#0F6E56' },
    warn:   { bg: '#FAEEDA', fg: '#854F0B' },
    danger: { bg: '#FCEBEB', fg: '#A32D2D' },
    neutral:{ bg: '#F1EFE8', fg: '#444441' },
  }[tone] || { bg: '#F1EFE8', fg: '#444441' };
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 500,
      background: palette.bg, color: palette.fg, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function ToggleSwitch({ on, onChange, color = '#6366f1' }) {
  return (
    <div onClick={onChange}
         style={{ flexShrink: 0, width: 44, height: 24, borderRadius: 12,
                  background: on ? color : '#d1d5db',
                  position: 'relative', cursor: 'pointer', transition: 'background .2s' }}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 3, left: on ? 23 : 3,
                    transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }} />
    </div>
  );
}

export default function SAAIPlatformSettings() {
  const [status,  setStatus]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/super-admin/ai/status');
      setStatus(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleProvider(providerId, enabled) {
    setSaving(true);
    setError(''); setSuccess('');
    try {
      const current = status.allowlist?.providers || status.provider_env.map(p => p.id);
      const next    = enabled
        ? Array.from(new Set([...current, providerId]))
        : current.filter(p => p !== providerId);
      // If next now contains every provider, store null = "allow all"
      const isAll = next.length === status.provider_env.length;
      await apiFetch('/super-admin/ai/allowlist', {
        method: 'PATCH',
        body: JSON.stringify({ providers: isAll ? null : next }),
      });
      setSuccess('Saved ✓');
      setTimeout(() => setSuccess(''), 2000);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !status) {
    return <div style={{ padding: 32, color: '#6b7280' }}>Loading…</div>;
  }

  const allowedSet = status.allowlist?.providers
    ? new Set(status.allowlist.providers)
    : null;  // null = all allowed

  const isAllowed = (id) => allowedSet === null || allowedSet.has(id);

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>
          🧠 AI Provider Configuration
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Control which AI providers are exposed to org admins, and verify that
          platform fallback keys are configured in the deploy environment.
        </p>
      </div>

      {error   && <div style={alertStyle('error')}>{error}</div>}
      {success && <div style={alertStyle('success')}>{success}</div>}

      {/* ── Secret storage status ── */}
      <div style={{
        background: status.credentials_storage_configured ? '#F0FDF4' : '#FEF2F2',
        border: `1px solid ${status.credentials_storage_configured ? '#BBF7D0' : '#FECACA'}`,
        borderRadius: 10, padding: '14px 18px', marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20 }}>{status.credentials_storage_configured ? '✓' : '⚠️'}</span>
          <div>
            <div style={{ fontWeight: 500, fontSize: 14 }}>
              {status.credentials_storage_configured
                ? 'Encrypted credential storage configured'
                : 'AI_CREDS_KEY env var not set'}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
              {status.credentials_storage_configured
                ? 'Org admins and users can store API keys. Keys are encrypted with AES-256-GCM at rest.'
                : 'Org-level and user-level API keys cannot be stored until AI_CREDS_KEY is set in the environment. AI calls fall back to platform env-var keys.'}
            </div>
          </div>
        </div>
      </div>

      {/* ── Provider table ── */}
      <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Providers</h4>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12, lineHeight: 1.5 }}>
        Toggle a provider off to hide it from all org admin dropdowns. Existing org configurations
        pointing at a disabled provider keep working but cannot be changed to it.
      </p>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 28 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={thStyle}>Provider</th>
              <th style={thStyle}>Env var</th>
              <th style={thStyle}>Platform key</th>
              <th style={thStyle}>Endpoint required</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {status.provider_env.map(p => (
              <tr key={p.id} style={{ borderTop: '1px solid #f1f1ec' }}>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 500 }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{p.id}</div>
                </td>
                <td style={{ ...tdStyle, fontFamily: 'monospace', color: '#6b7280' }}>
                  {p.env_var || '—'}
                </td>
                <td style={tdStyle}>
                  {p.env_var
                    ? (p.has_platform_key ? <Pill tone="ok">configured</Pill> : <Pill tone="warn">not set</Pill>)
                    : <Pill tone="neutral">n/a</Pill>}
                </td>
                <td style={tdStyle}>
                  {p.requires_endpoint ? <Pill tone="neutral">yes</Pill> : '—'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>
                  <ToggleSwitch
                    on={isAllowed(p.id)}
                    onChange={() => !saving && toggleProvider(p.id, !isAllowed(p.id))}
                    color="#10b981"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Usage rollup ── */}
      <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Usage (last 30 days)</h4>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12, lineHeight: 1.5 }}>
        Tokens consumed by each provider, broken down by who paid for the key.
        Only <code>platform</code>-sourced tokens are billed to your AI provider account.
      </p>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        {status.usage_30d.length === 0 ? (
          <div style={{ padding: 20, fontSize: 13, color: '#6b7280', textAlign: 'center' }}>
            No usage in the last 30 days.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={thStyle}>Provider</th>
                <th style={thStyle}>Key source</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Calls</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {status.usage_30d.map((u, i) => (
                <tr key={i} style={{ borderTop: '1px solid #f1f1ec' }}>
                  <td style={tdStyle}>{u.provider}</td>
                  <td style={tdStyle}>
                    {u.key_source === 'platform'
                      ? <Pill tone="warn">platform — billed</Pill>
                      : u.key_source === 'org'
                      ? <Pill tone="ok">org — pass-through</Pill>
                      : u.key_source === 'user'
                      ? <Pill tone="ok">user — pass-through</Pill>
                      : <Pill tone="neutral">{u.key_source}</Pill>}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {Number(u.call_count).toLocaleString()}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {u.total_tokens ? Number(u.total_tokens).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const thStyle = {
  padding: '10px 14px', textAlign: 'left', fontSize: 11,
  fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3,
};
const tdStyle = { padding: '12px 14px', verticalAlign: 'middle' };

function alertStyle(kind) {
  const isOk = kind === 'success';
  return {
    padding: '10px 14px', borderRadius: 8, fontSize: 14, marginBottom: 16,
    background: isOk ? '#d1fae5' : '#fef2f2',
    color:      isOk ? '#065f46' : '#991b1b',
    border:     `1px solid ${isOk ? '#a7f3d0' : '#fecaca'}`,
  };
}
