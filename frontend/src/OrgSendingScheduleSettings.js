// ─────────────────────────────────────────────────────────────────────────────
// OrgSendingScheduleSettings.js
//
// Settings panel wrapper that loads the org-level sending schedule, lets the
// admin edit it via the reusable SendingScheduleSettings form, and saves
// back to /org/outreach-limits.
//
// Used in SettingsView under the Workflow group, admin-only.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospecting/prospectingShared';
import SendingScheduleSettings from './SendingScheduleSettings';

export default function OrgSendingScheduleSettings({ readOnly }) {
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/org/outreach-limits');
        const limits = r?.limits || {};
        setSettings({
          startMode:             limits.startMode      ?? 'fixed_or_now',
          pacingMode:            limits.pacingMode      ?? 'cadence',
          cadenceMinutes:        limits.cadenceMinutes  ?? 5,
          sendWindowStartHour:   limits.sendWindowStartHour   ?? 8,
          sendWindowStartMinute: limits.sendWindowStartMinute ?? 0,
          sendWindowEndHour:     limits.sendWindowEndHour      ?? 11,
          sendWindowDays:        Array.isArray(limits.sendWindowDays) ? limits.sendWindowDays : [1,2,3,4,5],
          sendWindowTimezone:    limits.sendWindowTimezone     ?? 'America/New_York',
          linkedinReleaseCap:    limits.linkedinReleaseCap     ?? 25,
        });
        setLoading(false);
      } catch (err) {
        setError('Failed to load settings: ' + (err.message || 'unknown error'));
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await apiFetch('/org/outreach-limits', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSavedAt(new Date());
    } catch (err) {
      setError('Save failed: ' + (err.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24, color: '#6b7280' }}>Loading...</div>;
  }
  if (!settings) {
    return <div style={{ padding: 24, color: '#ef4444' }}>{error || 'Unable to load settings'}</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>📅 Sending Schedule</h2>
      <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 24, lineHeight: 1.5 }}>
        Controls when emails leave the system and when LinkedIn / task steps appear
        in the rep's queue. These are <strong>org defaults</strong> — individual
        campaigns can override any field.
      </p>

      {readOnly && (
        <div style={{
          background: '#fef3c7', border: '1px solid #fde68a',
          padding: '10px 14px', borderRadius: 6, fontSize: 12, color: '#92400e',
          marginBottom: 16,
        }}>
          Only org admins can edit these settings.
        </div>
      )}

      <SendingScheduleSettings
        mode="org"
        value={settings}
        onChange={setSettings}
        disabled={readOnly || saving}
      />

      {error && (
        <div style={{
          background: '#fee2e2', color: '#991b1b',
          padding: '8px 12px', borderRadius: 4,
          fontSize: 12, marginTop: 12,
        }}>{error}</div>
      )}

      <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleSave}
          disabled={readOnly || saving}
          style={{
            padding: '8px 16px', borderRadius: 6, border: 'none',
            background: readOnly ? '#d1d5db' : '#0F9D8E',
            color: '#fff', fontWeight: 600, fontSize: 13,
            cursor: (readOnly || saving) ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save changes'}
        </button>
        {savedAt && !saving && (
          <span style={{ fontSize: 12, color: '#10b981' }}>
            ✓ Saved at {savedAt.toLocaleTimeString()}
          </span>
        )}
      </div>

      <div style={{
        marginTop: 32, padding: 16, background: '#f9fafb',
        borderRadius: 6, fontSize: 12, color: '#4b5563',
      }}>
        <strong style={{ display: 'block', marginBottom: 6 }}>How this works</strong>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>
            <strong>Email steps</strong> fire on the chosen days, starting per the
            start mode, paced by cadence (every N minutes) or even spread.
          </li>
          <li>
            <strong>Email volume</strong> is governed per sending account
            (Settings → Outreach → daily limit), not here. A campaign's capacity
            is the sum across its sender's active accounts.
          </li>
          <li>
            <strong>LinkedIn</strong> requests use a soft per-day release cap —
            tasks are handed to the rep at that rate, but the actual connection
            request is sent manually on LinkedIn.
          </li>
          <li>
            <strong>Auto-send stops at the cap;</strong> a rep can still send a
            drafted email past it (with a confirm) when they choose to.
          </li>
          <li>
            <strong>Call / task</strong> steps have no daily cap — they're limited
            only by the active days/window and released for the rep to action.
          </li>
        </ul>
      </div>
    </div>
  );
}
