/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OACLMESignConfig. */
import React, { useState, useEffect } from 'react';

export default function OACLMESignConfig() {
  const API  = process.env.REACT_APP_API_URL;
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const PROVIDER_LABELS = { none: 'None (manual)', docusign: 'DocuSign', hellosign: 'HelloSign / Dropbox Sign', adobe_sign: 'Adobe Acrobat Sign' };

  const [config, setConfig]   = useState({ provider: 'none', apiKey: '', accountId: '', webhookSecret: '', sandboxMode: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetch(`${API}/org/admin/esign-config`, { headers })
      .then(r => r.json())
      .then(d => {
        if (d.config) setConfig({ provider: 'none', apiKey: '', accountId: '', webhookSecret: '', sandboxMode: false, ...d.config });
      })
      .catch(() => setError('Failed to load eSign configuration'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await fetch(`${API}/org/admin/esign-config`, {
        method: 'POST',
        headers,
        body: JSON.stringify(config),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Save failed');
      setSuccess('eSign configuration saved ✓');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading eSign configuration…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Provider picker */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 6 }}>eSignature Provider</div>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 14px' }}>
          Choose your e-signature integration. Contracts sent for signature will use this provider.
          Select <strong>None</strong> to use manual signature tracking only.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {Object.entries(PROVIDER_LABELS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setConfig(c => ({ ...c, provider: key }))}
              style={{
                padding: '12px 16px', borderRadius: 9, textAlign: 'left', cursor: 'pointer',
                border: config.provider === key ? '2px solid #6366f1' : '1px solid #e5e7eb',
                background: config.provider === key ? '#eef2ff' : '#fff',
                fontWeight: config.provider === key ? 700 : 400,
                fontSize: 13, color: config.provider === key ? '#4338ca' : '#374151',
                transition: 'all .15s',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Provider credentials — shown only when a real provider is chosen */}
      {config.provider !== 'none' && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 22px' }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 14 }}>
            {PROVIDER_LABELS[config.provider]} — Credentials
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label className="sv-label">API Key / Integration Key</label>
              <input
                className="sv-input"
                type="password"
                placeholder="Paste API key from your provider dashboard"
                value={config.apiKey}
                onChange={e => setConfig(c => ({ ...c, apiKey: e.target.value }))}
              />
            </div>
            <div>
              <label className="sv-label">Account ID {config.provider === 'docusign' ? '(DocuSign Account GUID)' : '(optional)'}</label>
              <input
                className="sv-input"
                placeholder={config.provider === 'docusign' ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' : 'Account ID if required'}
                value={config.accountId}
                onChange={e => setConfig(c => ({ ...c, accountId: e.target.value }))}
              />
            </div>
            <div>
              <label className="sv-label">Webhook Secret (optional)</label>
              <input
                className="sv-input"
                type="password"
                placeholder="Used to verify incoming webhook events from the provider"
                value={config.webhookSecret}
                onChange={e => setConfig(c => ({ ...c, webhookSecret: e.target.value }))}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={config.sandboxMode}
                onChange={e => setConfig(c => ({ ...c, sandboxMode: e.target.checked }))}
              />
              <span>
                <strong>Sandbox / Test mode</strong>
                <span style={{ color: '#6b7280', marginLeft: 6 }}>— Uses the provider's sandbox environment. Disable for production.</span>
              </span>
            </label>
          </div>
        </div>
      )}

      <div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ padding: '9px 24px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}
