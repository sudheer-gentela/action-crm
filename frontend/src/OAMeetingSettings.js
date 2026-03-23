// ─────────────────────────────────────────────────────────────────────────────
// OAMeetingSettings.js
// Org Admin — Meeting & Transcript Integrations
//
// Rendered as a sub-tab inside the existing OrgAdminView "Integrations" panel.
// Manages org-level transcript provider configuration stored in org_integrations.
//
// Providers configured here (org-level):
//   zoom_org     — Zoom corporate account webhook
//   teams        — Microsoft Teams Graph API webhook
//   fireflies_org — Fireflies org plan webhook
//   gong         — Gong webhook (listed but marked "coming soon")
//
// Each provider card shows:
//   - Current enabled/disabled status
//   - Their org-specific webhook URL to paste into the provider dashboard
//   - Webhook secret (masked, with reveal toggle)
//   - Auto-analyze toggle
//   - Save / Disable controls
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL;

// ── Provider definitions ──────────────────────────────────────────────────────
const PROVIDERS = [
  {
    id:          'zoom_org',
    label:       'Zoom',
    icon:        '📹',
    description: 'Receive transcripts from your corporate Zoom account when a recorded meeting ends.',
    docsUrl:     'https://developers.zoom.us/docs/api/rest/webhook-only-app/',
    secretLabel: 'Zoom webhook secret token',
    comingSoon:  false,
  },
  {
    id:          'teams',
    label:       'Microsoft Teams',
    icon:        '💬',
    description: 'Receive transcripts via Microsoft Graph API change notifications on Teams call recordings.',
    docsUrl:     'https://learn.microsoft.com/en-us/graph/api/resources/calltranscript',
    secretLabel: 'Microsoft Graph client state token',
    comingSoon:  false,
  },
  {
    id:          'fireflies_org',
    label:       'Fireflies.ai (Org)',
    icon:        '🔥',
    description: 'Org-wide Fireflies integration. All reps\' calls are captured under one org webhook.',
    docsUrl:     'https://fireflies.ai/integrations',
    secretLabel: 'Fireflies webhook token',
    comingSoon:  false,
  },
  {
    id:          'gong',
    label:       'Gong',
    icon:        '🔔',
    description: 'Receive enriched transcripts from Gong — includes speaker turns, sentiment, and topics.',
    docsUrl:     'https://developers.gong.io/docs/webhooks',
    secretLabel: 'Gong webhook signing key',
    comingSoon:  true,
  },
];

// ── Styles (inline, matching OrgAdminView aesthetic) ─────────────────────────
const S = {
  container:   { display: 'flex', flexDirection: 'column', gap: 16 },
  card:        { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 24px' },
  cardHeader:  { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 },
  cardLeft:    { display: 'flex', alignItems: 'flex-start', gap: 12 },
  icon:        { fontSize: 26, lineHeight: 1, marginTop: 2 },
  title:       { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 3 },
  desc:        { fontSize: 13, color: '#6b7280', lineHeight: 1.5 },
  badge:       (active) => ({
    padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
    background: active ? '#d1fae5' : '#f3f4f6',
    color:      active ? '#065f46' : '#9ca3af',
    flexShrink: 0, marginTop: 2,
  }),
  comingSoon:  { padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#92400e', flexShrink: 0, marginTop: 2 },
  fieldRow:    { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 },
  label:       { fontSize: 12, fontWeight: 600, color: '#374151' },
  urlBox:      { display: 'flex', gap: 8, alignItems: 'center' },
  urlInput:    { flex: 1, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'monospace', background: '#f9fafb', color: '#374151', cursor: 'text' },
  secretWrap:  { display: 'flex', gap: 8, alignItems: 'center' },
  secretInput: { flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, color: '#111827' },
  toggleRow:   { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 },
  toggleLabel: { fontSize: 13, color: '#374151' },
  actions:     { display: 'flex', gap: 8, marginTop: 4 },
  btnPrimary:  { padding: '7px 18px', borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnDanger:   { padding: '7px 14px', borderRadius: 7, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', fontSize: 13, cursor: 'pointer' },
  btnSecondary:{ padding: '7px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer' },
  btnCopy:     { padding: '5px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151', flexShrink: 0 },
  btnReveal:   { padding: '5px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151', flexShrink: 0 },
  docsLink:    { fontSize: 12, color: '#6366f1', textDecoration: 'none', marginLeft: 4 },
  alert:       (type) => ({
    padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12,
    background: type === 'error' ? '#fef2f2' : '#f0fdf4',
    color:      type === 'error' ? '#dc2626'  : '#15803d',
    border:     `1px solid ${type === 'error' ? '#fecaca' : '#bbf7d0'}`,
  }),
  divider:     { border: 'none', borderTop: '1px solid #f3f4f6', margin: '14px 0' },
  infoBox:     { padding: '12px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, color: '#6b7280', lineHeight: 1.6 },
};

// ── Main component ─────────────────────────────────────────────────────────────
export default function OAMeetingSettings({ orgId }) {
  const [integrations, setIntegrations] = useState({});  // { provider_id: row }
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState('');

  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await fetch(`${API}/org/admin/meeting-settings`, { headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to load');
      // Index by integration_type for easy lookup
      const map = {};
      (d.integrations || []).forEach(i => { map[i.integration_type] = i; });
      setIntegrations(map);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  const handleSave = async (providerId, secret, autoAnalyze) => {
    setError(''); setSuccess('');
    try {
      const r = await fetch(`${API}/org/admin/meeting-settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ provider: providerId, webhook_secret: secret, auto_analyze: autoAnalyze, enabled: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to save');
      setSuccess(`${PROVIDERS.find(p => p.id === providerId)?.label} integration saved ✓`);
      setTimeout(() => setSuccess(''), 4000);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDisable = async (providerId) => {
    if (!window.confirm('Disable this integration? Webhooks from this provider will be rejected until re-enabled.')) return;
    setError(''); setSuccess('');
    try {
      const r = await fetch(`${API}/org/admin/meeting-settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ provider: providerId, enabled: false }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to disable');
      setSuccess(`Integration disabled`);
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>Loading integrations…</div>;

  return (
    <div style={S.container}>
      {error   && <div style={S.alert('error')}>⚠️ {error}</div>}
      {success && <div style={S.alert('success')}>✅ {success}</div>}

      <div style={S.infoBox}>
        <strong style={{ color: '#374151' }}>How this works:</strong> Each provider sends a webhook to your unique URL when a meeting transcript is ready.
        Copy the webhook URL for your provider and paste it into that provider's dashboard.
        Set the webhook secret to match what the provider signs requests with.
        Transcripts are automatically analysed and linked to matching CRM meetings.
      </div>

      {PROVIDERS.map(provider => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          existing={integrations[provider.id] || null}
          orgId={orgId}
          onSave={handleSave}
          onDisable={handleDisable}
        />
      ))}
    </div>
  );
}

// ── ProviderCard ───────────────────────────────────────────────────────────────
function ProviderCard({ provider, existing, orgId, onSave, onDisable }) {
  const isActive    = existing?.status === 'active';
  const [expanded,  setExpanded]  = useState(isActive);   // expand if already configured
  const [secret,    setSecret]    = useState('');
  const [autoAnalyze, setAutoAnalyze] = useState(existing?.config?.auto_analyze !== false);
  const [revealed,  setRevealed]  = useState(false);
  const [copied,    setCopied]    = useState(false);
  const [saving,    setSaving]    = useState(false);

  // Build webhook URL — orgId comes from parent
  const webhookUrl = orgId
    ? `${process.env.REACT_APP_API_URL}/webhooks/transcript/${provider.id}/org/${orgId}`
    : '(loading…)';

  const handleCopy = () => {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSave = async () => {
    if (!secret.trim()) { alert('Please enter the webhook secret from your provider dashboard.'); return; }
    setSaving(true);
    await onSave(provider.id, secret.trim(), autoAnalyze);
    setSaving(false);
    setSecret('');
  };

  return (
    <div style={{ ...S.card, borderLeft: isActive ? '3px solid #6366f1' : '3px solid #e5e7eb' }}>
      {/* Header row */}
      <div style={S.cardHeader}>
        <div style={S.cardLeft}>
          <span style={S.icon}>{provider.icon}</span>
          <div>
            <div style={S.title}>{provider.label}</div>
            <div style={S.desc}>{provider.description}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          {provider.comingSoon
            ? <span style={S.comingSoon}>Coming soon</span>
            : <span style={S.badge(isActive)}>{isActive ? '● Active' : '○ Not configured'}</span>
          }
          {!provider.comingSoon && (
            <button
              style={S.btnSecondary}
              onClick={() => setExpanded(e => !e)}
            >
              {expanded ? 'Hide' : (isActive ? 'Edit' : 'Configure')}
            </button>
          )}
        </div>
      </div>

      {/* Expanded config form */}
      {expanded && !provider.comingSoon && (
        <>
          <hr style={S.divider} />

          {/* Webhook URL */}
          <div style={S.fieldRow}>
            <label style={S.label}>
              Your webhook URL — paste this into {provider.label}
              <a href={provider.docsUrl} target="_blank" rel="noreferrer" style={S.docsLink}>
                Provider docs ↗
              </a>
            </label>
            <div style={S.urlBox}>
              <input
                readOnly
                value={webhookUrl}
                style={S.urlInput}
                onClick={e => e.target.select()}
              />
              <button style={S.btnCopy} onClick={handleCopy}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Webhook secret */}
          <div style={S.fieldRow}>
            <label style={S.label}>
              {provider.secretLabel}
              {isActive && <span style={{ color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>(leave blank to keep existing)</span>}
            </label>
            <div style={S.secretWrap}>
              <input
                type={revealed ? 'text' : 'password'}
                value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder={isActive ? '••••••••••••••••' : 'Paste secret from provider dashboard'}
                style={S.secretInput}
                autoComplete="off"
              />
              <button style={S.btnReveal} onClick={() => setRevealed(r => !r)}>
                {revealed ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          {/* Auto-analyze toggle */}
          <div style={S.toggleRow}>
            <label style={{ ...S.toggleLabel, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoAnalyze}
                onChange={e => setAutoAnalyze(e.target.checked)}
              />
              Automatically analyse transcript with AI when received
            </label>
          </div>

          {/* Actions */}
          <div style={S.actions}>
            <button
              style={{ ...S.btnPrimary, opacity: saving ? 0.6 : 1 }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : isActive ? 'Update' : 'Enable integration'}
            </button>
            {isActive && (
              <button style={S.btnDanger} onClick={() => onDisable(provider.id)}>
                Disable
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
