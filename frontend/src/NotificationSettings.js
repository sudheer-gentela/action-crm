// NotificationSettings.js
// User preference panel for notification notifications.
// Rendered as a section inside SettingsView.js.
//
// GET  /api/team-notifications/preferences  → load current prefs
// PATCH /api/team-notifications/preferences → save
// GET  /api/team-notifications/org-members  → load members for specific_users selector

import React, { useState, useEffect, useCallback } from 'react';
import api from './apiService';
import './NotificationSettings.css';

const RECIPIENT_MODES = [
  {
    value: 'reporting_manager',
    label: 'Reporting manager',
    description: 'If no deal team: notify your direct manager in the org hierarchy',
  },
  {
    value: 'specific_users',
    label: 'Specific people',
    description: 'If no deal team: always notify a fixed list of people',
  },
  {
    value: 'none',
    label: 'Just me',
    description: 'Only notify you — no notification to others',
  },
];

const HOURS_OPTIONS = [
  { value: 1,   label: '1 hour' },
  { value: 4,   label: '4 hours' },
  { value: 8,   label: '8 hours' },
  { value: 12,  label: '12 hours' },
  { value: 24,  label: '24 hours (1 day)' },
  { value: 48,  label: '48 hours (2 days)' },
  { value: 72,  label: '72 hours (3 days)' },
  { value: 168, label: '1 week' },
];

export default function NotificationSettings() {
  const [prefs,       setPrefs]       = useState(null);
  const [members,     setMembers]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [error,       setError]       = useState('');

  // ── Load prefs + members ────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [prefsRes, membersRes] = await Promise.all([
        api.get('/team-notifications/preferences'),
        api.get('/team-notifications/org-members'),
      ]);
      setPrefs(prefsRes.data.preferences);
      setMembers(membersRes.data.members || []);
    } catch (err) {
      setError('Failed to load notification settings');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await api.patch('/team-notifications/preferences', prefs);
      setPrefs(res.data.preferences);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError('Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  // ── Toggle specific user ────────────────────────────────────────────────────
  const toggleSpecificUser = (userId) => {
    setPrefs(prev => {
      const ids = prev.specific_user_ids || [];
      const next = ids.includes(userId)
        ? ids.filter(id => id !== userId)
        : [...ids, userId];
      return { ...prev, specific_user_ids: next };
    });
  };

  if (loading) {
    return (
      <div className="esc-loading">
        <div className="esc-spinner" />
        <span>Loading notification settings…</span>
      </div>
    );
  }

  if (!prefs) {
    return <div className="esc-error">{error || 'Failed to load settings'}</div>;
  }

  return (
    <div className="esc-panel">
      <div className="esc-header">
        <div className="esc-header-icon">🚨</div>
        <div>
          <h3 className="esc-title">Action Notification</h3>
          <p className="esc-subtitle">
            Get notified when actions are overdue and not completed.
          </p>
        </div>
      </div>

      {error && <div className="esc-error-banner">{error}</div>}

      {/* ── Immediate alert ─────────────────────────────────────────────────── */}
      <div className="esc-section">
        <div className="esc-section-header">
          <div className="esc-toggle-row">
            <div>
              <div className="esc-section-title">Immediate alert</div>
              <div className="esc-section-desc">
                Notify when an action has been overdue for a set amount of time.
                Fires once per action.
              </div>
            </div>
            <label className="esc-toggle">
              <input
                type="checkbox"
                checked={prefs.immediate_alert}
                onChange={e => setPrefs(p => ({ ...p, immediate_alert: e.target.checked }))}
              />
              <span className="esc-toggle-track" />
            </label>
          </div>

          {prefs.immediate_alert && (
            <div className="esc-sub-field">
              <label className="esc-sub-label">Alert after:</label>
              <select
                className="esc-select"
                value={prefs.immediate_hours}
                onChange={e => setPrefs(p => ({ ...p, immediate_hours: parseInt(e.target.value) }))}
              >
                {HOURS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* ── Daily digest ────────────────────────────────────────────────────── */}
      <div className="esc-section">
        <div className="esc-section-header">
          <div className="esc-toggle-row">
            <div>
              <div className="esc-section-title">Daily digest</div>
              <div className="esc-section-desc">
                A daily summary of all overdue actions, sent at 9:00 AM UTC.
              </div>
            </div>
            <label className="esc-toggle">
              <input
                type="checkbox"
                checked={prefs.daily_digest}
                onChange={e => setPrefs(p => ({ ...p, daily_digest: e.target.checked }))}
              />
              <span className="esc-toggle-track" />
            </label>
          </div>
        </div>
      </div>

      {/* ── Recipient mode ───────────────────────────────────────────────────── */}
      {(prefs.immediate_alert || prefs.daily_digest) && (
        <div className="esc-section">
          <div className="esc-section-title">Who gets notified</div>
          <div className="esc-section-desc" style={{ marginBottom: 12 }}>
            When an action tied to a <strong>deal</strong> is overdue, the <strong>deal team</strong> is always notified automatically.
            The setting below applies when an action has no deal — for example, a standalone task or prospecting action.
          </div>

          <div className="esc-deal-team-banner">
            🤝 <strong>Deal actions</strong> → deal team notified automatically
            <span className="esc-deal-team-fallback"> · Fallback for non-deal actions:</span>
          </div>

          <div className="esc-radio-group">
            {RECIPIENT_MODES.map(mode => (
              <label key={mode.value} className="esc-radio-item">
                <input
                  type="radio"
                  name="recipient_mode"
                  value={mode.value}
                  checked={prefs.recipient_mode === mode.value}
                  onChange={() => setPrefs(p => ({ ...p, recipient_mode: mode.value }))}
                />
                <div className="esc-radio-content">
                  <span className="esc-radio-label">{mode.label}</span>
                  <span className="esc-radio-desc">{mode.description}</span>
                </div>
              </label>
            ))}
          </div>

          {/* Specific users selector */}
          {prefs.recipient_mode === 'specific_users' && (
            <div className="esc-specific-users">
              <div className="esc-specific-users-label">Select people to notify:</div>
              {members.length === 0 ? (
                <div className="esc-no-members">No other members in your org.</div>
              ) : (
                <div className="esc-members-list">
                  {members.map(m => {
                    const selected = (prefs.specific_user_ids || []).includes(m.id);
                    return (
                      <label key={m.id} className={`esc-member-item ${selected ? 'esc-member-item--selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSpecificUser(m.id)}
                        />
                        <div className="esc-member-avatar" style={{ background: avatarGradient(m.name) }}>
                          {initials(m.name)}
                        </div>
                        <div className="esc-member-info">
                          <span className="esc-member-name">{m.name}</span>
                          <span className="esc-member-email">{m.email}</span>
                        </div>
                        {selected && <span className="esc-member-check">✓</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Save button ──────────────────────────────────────────────────────── */}
      <div className="esc-footer">
        <button
          className="esc-save-btn"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save preferences'}
        </button>
        {saved && <span className="esc-saved-msg">Preferences saved</span>}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function initials(name) {
  const parts = (name || '').split(' ').filter(Boolean);
  return parts.length >= 2
    ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
    : (parts[0]?.[0] || '?').toUpperCase();
}

function avatarGradient(name) {
  const colors = [
    'linear-gradient(135deg, #1e40af, #3b82f6)',
    'linear-gradient(135deg, #065f46, #10b981)',
    'linear-gradient(135deg, #6b21a8, #a78bfa)',
    'linear-gradient(135deg, #92400e, #f59e0b)',
    'linear-gradient(135deg, #7f1d1d, #f87171)',
    'linear-gradient(135deg, #064e3b, #34d399)',
    'linear-gradient(135deg, #3730a3, #818cf8)',
  ];
  return colors[(name?.charCodeAt(0) || 0) % colors.length];
}
