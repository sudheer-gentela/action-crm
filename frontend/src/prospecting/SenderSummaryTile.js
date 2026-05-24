// prospecting/SenderSummaryTile.js
//
// Slice 4 — "Sending from" tile shown in CampaignDetailDrawer. Surfaces
// which email sender will fire this campaign's emails plus the LinkedIn
// model (chrome extension), so reps don't have to navigate to Settings to
// find out before activating.
//
// Backend: GET /api/prospecting-campaigns/:id/sender-summary

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

const HEALTH_STYLES = {
  healthy:      { bg: '#ecfdf5', fg: '#065f46', border: '#a7f3d0', dot: '#10b981', label: 'Healthy' },
  warning:      { bg: '#fffbeb', fg: '#92400e', border: '#fde68a', dot: '#f59e0b', label: 'Warning' },
  over_limit:   { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', dot: '#ef4444', label: 'Over limit' },
  unconfigured: { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb', dot: '#9ca3af', label: 'Not connected' },
};

const PROVIDER_LABEL = {
  google:  'Gmail',
  outlook: 'Outlook',
};

export default function SenderSummaryTile({ campaignId }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await apiFetch(`/prospecting-campaigns/${campaignId}/sender-summary`);
        if (!cancelled) { setData(r); setError(''); }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load sender info');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId]);

  if (loading) {
    return (
      <div style={tileStyle}>
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading sender info…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div style={tileStyle}>
        <div style={{ fontSize: 12, color: '#991b1b' }}>Sender info unavailable: {error}</div>
      </div>
    );
  }
  if (!data) return null;

  const { email, linkedin } = data;
  const emailHealth = HEALTH_STYLES[email.health] || HEALTH_STYLES.unconfigured;

  return (
    <div style={tileStyle}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C', marginBottom: 10 }}>
        📤 Sending from
      </div>

      {/* Email sender row */}
      <div style={{
        background: '#fff', border: `1px solid ${emailHealth.border}`, borderRadius: 6,
        padding: '10px 12px', marginBottom: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13 }}>✉️</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {email.configured
              ? (email.email || 'Configured sender')
              : 'No sender connected'}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600,
            padding: '2px 8px', borderRadius: 10,
            background: emailHealth.bg, color: emailHealth.fg,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: emailHealth.dot }} />
            {emailHealth.label}
          </span>
        </div>
        {email.configured && (
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            {PROVIDER_LABEL[email.provider] || email.provider} ·{' '}
            {email.owner_name} ·{' '}
            {email.daily_limit > 0
              ? `${email.emails_sent_today}/${email.daily_limit} sent today`
              : `${email.emails_sent_today} sent today`}
          </div>
        )}
        {email.health_reason && (
          <div style={{
            fontSize: 11, color: emailHealth.fg, marginTop: 6,
            padding: '6px 8px', background: emailHealth.bg, borderRadius: 4,
          }}>
            {emailHealth.label === 'Not connected' ? '⚠ ' : 'ℹ '}{email.health_reason}
          </div>
        )}
        <a
          href="/settings/email"
          onClick={(e) => {
            // Try in-app navigation if a routing handler is wired up; else
            // fall back to standard navigation.
            const ev = new CustomEvent('app-navigate', { detail: { path: '/settings/email' } });
            window.dispatchEvent(ev);
          }}
          style={{
            display: 'inline-block', marginTop: 6, fontSize: 11, color: '#0F9D8E',
            textDecoration: 'none', fontWeight: 600,
          }}
        >
          {email.configured ? 'Change sender →' : 'Connect a sender →'}
        </a>
      </div>

      {/* LinkedIn row */}
      <div style={{
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6,
        padding: '10px 12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13 }}>🔗</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C', flex: 1 }}>
            {linkedin.owner_name}'s LinkedIn (Chrome extension)
          </span>
        </div>
        <div style={{ fontSize: 11, color: '#6b7280' }}>
          Whoever's signed in on the rep's browser at task time.
        </div>
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#6b7280' }}>
            How LinkedIn sending works
          </summary>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.5 }}>
            {linkedin.note}
          </div>
        </details>
      </div>
    </div>
  );
}

const tileStyle = {
  marginTop: 16,
  padding: 14,
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
};
