// prospecting/SenderSummaryTile.js
//
// Slice 4 + Slice 5 fix — "Sending from" tile shown in CampaignDetailDrawer.
//
// Slice 5 changes:
//   - Surfaces ALL active senders, not just next-to-fire. SequenceStepFirer
//     round-robins across active senders, so showing only one is misleading.
//   - The "Manage senders →" link dispatches a 'navigate' event with
//     detail='settings' which App.js listens for and switches the tab.
//     Previously it dispatched 'app-navigate' which had no listener.
//
// Backend: GET /api/prospecting-campaigns/:id/sender-summary

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';
import { writeHash } from '../hashNav';

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

// Navigation helper -- App.js listens for a 'navigate' window event with a
// string detail (the tab name). Used to take the user to Settings without
// breaking the SPA into a fresh page load.
function goToSettings(e) {
  if (e?.preventDefault) e.preventDefault();
  // Land on the actual senders section, not the Settings default tab:
  // write the hash FIRST so SettingsView's initializer (which reads
  // #/settings/<section> on mount) restores 'preferences' (My Preferences,
  // where sender accounts live), THEN switch the tab. App.js's hash-write
  // effect sees the tab segment already correct and keeps the sub-segment.
  writeHash(['settings', 'preferences']);
  window.dispatchEvent(new CustomEvent('navigate', { detail: 'settings' }));
}

export default function SenderSummaryTile({ campaignId }) {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [expanded, setExpanded] = useState(false);

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
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading sender info...</div>
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
  // Slice 5: backend returns senders[]. Pre-Slice-5 backend only has top-level
  // fields; fall back to a synthesised single-sender list.
  const senders = Array.isArray(email.senders) && email.senders.length > 0
    ? email.senders
    : email.configured
      ? [{
          id: 'compat-1',
          email: email.email,
          provider: email.provider,
          display_name: email.display_name,
          is_active: email.is_active,
          emails_sent_today: email.emails_sent_today,
          daily_limit: email.daily_limit,
          health: email.health,
          health_reason: email.health_reason,
        }]
      : [];
  const activeCount = email.active_count ?? senders.filter(s => s.is_active).length;
  const inactiveCount = email.inactive_count ?? senders.filter(s => !s.is_active).length;

  return (
    <div style={tileStyle}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C', marginBottom: 10 }}>
        📤 Sending from
      </div>

      <div style={{
        background: '#fff', border: `1px solid ${emailHealth.border}`, borderRadius: 6,
        padding: '10px 12px', marginBottom: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 13 }}>✉️</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C', flex: 1 }}>
            {email.configured
              ? (activeCount > 1
                  ? `${activeCount} active senders (round-robin)`
                  : (senders[0]?.email || 'Configured sender'))
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

        {email.configured && activeCount === 1 && senders[0] && (
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            {PROVIDER_LABEL[senders[0].provider] || senders[0].provider} - {email.owner_name} - {senders[0].daily_limit > 0
              ? `${senders[0].emails_sent_today}/${senders[0].daily_limit} sent today`
              : `${senders[0].emails_sent_today} sent today`}
          </div>
        )}

        {email.configured && activeCount > 1 && (
          <>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
              Owner: {email.owner_name} - Next to fire: <strong>{email.next_to_fire?.email}</strong>
            </div>
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#0F9D8E', fontSize: 11, fontWeight: 600, padding: 0,
                marginBottom: expanded ? 6 : 0,
              }}
            >
              {expanded ? '▲ Hide senders' : `▼ Show all ${senders.length} senders`}
            </button>
            {expanded && (
              <div style={{
                border: '1px solid #f1f5f9', borderRadius: 4, overflow: 'hidden',
                marginTop: 6,
              }}>
                {senders.map((s, idx) => {
                  const sHealth = HEALTH_STYLES[s.health] || HEALTH_STYLES.unconfigured;
                  return (
                    <div
                      key={s.id || idx}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 10px', fontSize: 11,
                        borderTop: idx > 0 ? '1px solid #f1f5f9' : 'none',
                        background: s.is_active ? '#fff' : '#f9fafb',
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: sHealth.dot, flexShrink: 0 }} />
                      <span style={{ flex: 1, color: s.is_active ? '#1A3A5C' : '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.email}
                      </span>
                      <span style={{ color: '#6b7280', fontSize: 10 }}>
                        {PROVIDER_LABEL[s.provider] || s.provider}
                      </span>
                      <span style={{ color: s.is_active ? '#6b7280' : '#9ca3af', fontSize: 10, minWidth: 60, textAlign: 'right' }}>
                        {s.is_active
                          ? (s.daily_limit > 0
                              ? `${s.emails_sent_today}/${s.daily_limit}`
                              : `${s.emails_sent_today} today`)
                          : 'inactive'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {email.health_reason && (
          <div style={{
            fontSize: 11, color: emailHealth.fg, marginTop: 8,
            padding: '6px 8px', background: emailHealth.bg, borderRadius: 4,
          }}>
            {emailHealth.label === 'Not connected' ? '⚠ ' : 'ℹ '}{email.health_reason}
          </div>
        )}

        {inactiveCount > 0 && activeCount > 0 && (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
            {inactiveCount} inactive sender{inactiveCount === 1 ? '' : 's'} not in rotation.
          </div>
        )}

        <button
          type="button"
          onClick={goToSettings}
          style={{
            display: 'inline-block', marginTop: 8, fontSize: 11, color: '#0F9D8E',
            textDecoration: 'none', fontWeight: 600,
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          }}
        >
          {email.configured ? 'Manage senders →' : 'Connect a sender →'}
        </button>
      </div>

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
        {Array.isArray(linkedin.seats) && linkedin.seats.length > 0 ? (
          // Bound LinkedIn identity(ies) from user_linkedin_seats — captured
          // the first time the rep ran "Check & update" in the extension.
          <div style={{ marginTop: 2 }}>
            {linkedin.seats.map(s => (
              <div key={s.public_identifier} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, color: '#374151', padding: '3px 0',
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{s.display_name || s.public_identifier}</span>
                <a
                  href={`https://www.linkedin.com/in/${s.public_identifier}/`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: '#0077B5', textDecoration: 'none', fontSize: 11 }}
                >
                  in/{s.public_identifier} ↗
                </a>
                {s.last_seen_at && (
                  <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                    verified {new Date(s.last_seen_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            Whoever's signed in on the rep's browser at task time.
            <span style={{ display: 'block', color: '#92400e', marginTop: 2 }}>
              No LinkedIn account verified yet — run "Check &amp; update" in the
              extension once to bind it.
            </span>
          </div>
        )}
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
