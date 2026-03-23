// ─────────────────────────────────────────────────────────────────────────────
// UserTranscriptSettings.js
// Rep-level personal transcript tool connection
//
// Rendered as a sub-section inside SettingsView → Connections → My Connections.
// Allows individual reps to connect their personal Fireflies / Fathom account.
//
// Storage: oauth_tokens.webhook_config jsonb column (added in Phase 1 migration)
// The rep's personal webhook URL is:
//   /webhooks/transcript/:provider/user/:userId
//
// This component:
//   - Shows available personal tools (Fireflies personal, Fathom)
//   - Gives each rep their unique webhook URL to paste into the tool
//   - Stores/updates the webhook secret via PATCH /users/me/transcript-tools
//   - Shows connected status per tool
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL;

const PERSONAL_TOOLS = [
  {
    id:          'fireflies',
    label:       'Fireflies.ai',
    icon:        '🔥',
    description: 'Fireflies joins your calls automatically and sends transcripts to your personal webhook.',
    docsUrl:     'https://fireflies.ai/integrations',
    secretLabel: 'Fireflies webhook token',
  },
  {
    id:          'fathom',
    label:       'Fathom',
    icon:        '🐳',
    description: 'Fathom records and transcribes your calls. Connect your personal Fathom account here.',
    docsUrl:     'https://fathom.video',
    secretLabel: 'Fathom webhook secret',
  },
  {
    id:          'zoom',
    label:       'Zoom (personal)',
    icon:        '📹',
    description: 'If you have a personal Zoom account separate from your org\'s corporate account.',
    docsUrl:     'https://developers.zoom.us/docs/api/rest/webhook-only-app/',
    secretLabel: 'Zoom webhook secret token',
  },
];

const S = {
  section:     { marginBottom: 24 },
  heading:     { fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 },
  subheading:  { fontSize: 13, color: '#6b7280', marginBottom: 16, lineHeight: 1.5 },
  card:        { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '16px 20px', marginBottom: 12 },
  cardHeader:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0 },
  cardLeft:    { display: 'flex', alignItems: 'center', gap: 10 },
  icon:        { fontSize: 22 },
  title:       { fontSize: 14, fontWeight: 600, color: '#111827' },
  desc:        { fontSize: 12, color: '#9ca3af', marginTop: 2 },
  badge:       (active) => ({
    padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
    background: active ? '#d1fae5' : '#f3f4f6',
    color:      active ? '#065f46' : '#9ca3af',
  }),
  fieldRow:    { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 14, marginBottom: 10 },
  label:       { fontSize: 12, fontWeight: 600, color: '#374151' },
  urlBox:      { display: 'flex', gap: 8 },
  urlInput:    { flex: 1, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', background: '#f9fafb', color: '#374151' },
  secretInput: { flex: 1, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  secretRow:   { display: 'flex', gap: 8, alignItems: 'center' },
  btnSmall:    { padding: '5px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, cursor: 'pointer', color: '#374151', flexShrink: 0 },
  btnPrimary:  { padding: '6px 16px', borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnDanger:   { padding: '6px 12px', borderRadius: 7, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', fontSize: 12, cursor: 'pointer' },
  actions:     { display: 'flex', gap: 8, marginTop: 12 },
  docsLink:    { fontSize: 11, color: '#6366f1', textDecoration: 'none', marginLeft: 4 },
  alert:       (type) => ({
    padding: '9px 14px', borderRadius: 7, fontSize: 13, marginBottom: 12,
    background: type === 'error' ? '#fef2f2' : '#f0fdf4',
    color:      type === 'error' ? '#dc2626' : '#15803d',
    border:     `1px solid ${type === 'error' ? '#fecaca' : '#bbf7d0'}`,
  }),
  divider:     { border: 'none', borderTop: '1px solid #f3f4f6', margin: '12px 0 0' },
  noteBox:     { padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7, fontSize: 12, color: '#92400e', marginBottom: 16 },
};

export default function UserTranscriptSettings() {
  const [connected, setConnected] = useState({});  // { provider: { enabled, hasSecret } }
  const [userId,    setUserId]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState('');

  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await fetch(`${API}/users/me/transcript-tools`, { headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to load');
      setConnected(d.tools || {});
      setUserId(d.userId);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  const handleSave = async (toolId, secret, enabled) => {
    setError(''); setSuccess('');
    try {
      const r = await fetch(`${API}/users/me/transcript-tools`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ provider: toolId, webhook_secret: secret, enabled }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to save');
      setSuccess(`${PERSONAL_TOOLS.find(t => t.id === toolId)?.label} connected ✓`);
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDisconnect = async (toolId) => {
    if (!window.confirm('Disconnect this tool? Webhooks from it will be rejected.')) return;
    setError(''); setSuccess('');
    try {
      const r = await fetch(`${API}/users/me/transcript-tools`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ provider: toolId, enabled: false }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to disconnect');
      setSuccess('Tool disconnected');
      setTimeout(() => setSuccess(''), 3000);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>Loading…</div>;

  return (
    <div style={S.section}>
      <div style={S.heading}>🎙️ Personal transcript tools</div>
      <div style={S.subheading}>
        Connect your personal AI notetaker. Transcripts from your calls will be automatically
        linked to matching CRM meetings and analysed.
        {' '}
        <strong style={{ color: '#374151' }}>Note:</strong> if your org has a company-wide integration (e.g. Gong or corporate Zoom),
        those transcripts arrive automatically — no setup needed here.
      </div>

      {error   && <div style={S.alert('error')}>⚠️ {error}</div>}
      {success && <div style={S.alert('success')}>✅ {success}</div>}

      {PERSONAL_TOOLS.map(tool => (
        <PersonalToolCard
          key={tool.id}
          tool={tool}
          existing={connected[tool.id] || null}
          userId={userId}
          onSave={handleSave}
          onDisconnect={handleDisconnect}
        />
      ))}
    </div>
  );
}

// ── PersonalToolCard ───────────────────────────────────────────────────────────
function PersonalToolCard({ tool, existing, userId, onSave, onDisconnect }) {
  const isConnected = existing?.enabled === true;
  const [expanded,  setExpanded]  = useState(false);
  const [secret,    setSecret]    = useState('');
  const [revealed,  setRevealed]  = useState(false);
  const [copied,    setCopied]    = useState(false);
  const [saving,    setSaving]    = useState(false);

  const webhookUrl = userId
    ? `${process.env.REACT_APP_API_URL}/webhooks/transcript/${tool.id}/user/${userId}`
    : '(loading…)';

  const handleCopy = () => {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleSave = async () => {
    if (!secret.trim() && !isConnected) {
      alert('Please enter the webhook secret from your provider dashboard.');
      return;
    }
    setSaving(true);
    await onSave(tool.id, secret.trim() || null, true);
    setSaving(false);
    setSecret('');
    setExpanded(false);
  };

  return (
    <div style={{ ...S.card, borderLeft: isConnected ? '3px solid #10b981' : '3px solid #e5e7eb' }}>
      <div style={S.cardHeader}>
        <div style={S.cardLeft}>
          <span style={S.icon}>{tool.icon}</span>
          <div>
            <div style={S.title}>{tool.label}</div>
            <div style={S.desc}>{tool.description}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={S.badge(isConnected)}>{isConnected ? '● Connected' : '○ Not connected'}</span>
          <button style={S.btnSmall} onClick={() => setExpanded(e => !e)}>
            {expanded ? 'Hide' : isConnected ? 'Edit' : 'Connect'}
          </button>
        </div>
      </div>

      {expanded && (
        <>
          <hr style={S.divider} />

          {/* Webhook URL */}
          <div style={S.fieldRow}>
            <label style={S.label}>
              Your personal webhook URL
              <a href={tool.docsUrl} target="_blank" rel="noreferrer" style={S.docsLink}>
                {tool.label} docs ↗
              </a>
            </label>
            <div style={S.urlBox}>
              <input
                readOnly
                value={webhookUrl}
                style={S.urlInput}
                onClick={e => e.target.select()}
              />
              <button style={S.btnSmall} onClick={handleCopy}>
                {copied ? '✓' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Secret */}
          <div style={S.fieldRow}>
            <label style={S.label}>
              {tool.secretLabel}
              {isConnected && <span style={{ color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>(leave blank to keep existing)</span>}
            </label>
            <div style={S.secretRow}>
              <input
                type={revealed ? 'text' : 'password'}
                value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder={isConnected ? '••••••••' : 'Paste from your provider settings'}
                style={S.secretInput}
                autoComplete="off"
              />
              <button style={S.btnSmall} onClick={() => setRevealed(r => !r)}>
                {revealed ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div style={S.actions}>
            <button
              style={{ ...S.btnPrimary, opacity: saving ? 0.6 : 1 }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving…' : isConnected ? 'Update' : 'Connect'}
            </button>
            {isConnected && (
              <button style={S.btnDanger} onClick={() => onDisconnect(tool.id)}>
                Disconnect
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
