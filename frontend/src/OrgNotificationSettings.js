/**
 * OrgNotificationSettings.js
 *
 * DROP-IN LOCATION: frontend/src/OrgNotificationSettings.js   (NEW FILE)
 *
 * Org-level notification policy (2026_141).
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * Until now there was no org-level notification settings screen at all.
 * Settings → Alerts renders NotificationSettings, which is entirely PER-USER —
 * your channels, your categories, your digest mode. Nothing in it is policy.
 *
 * Org notification config existed only as keys written straight into
 * organizations.settings with no way to set them:
 *
 *   settings->'notifications'->>'bell_poll_seconds'   — asked for by the bell,
 *                                                       served by nothing
 *   settings->'dailywork'->>'reminder_hour'           — read by the reminder
 *                                                       job, settable nowhere
 *
 * A config nobody can set is how the bell came to 404 on every login for
 * months. This is the home for both; the poll interval is the first one wired.
 *
 * ── READ-ONLY FOR NON-ADMINS, NOT HIDDEN ────────────────────────────────────
 *
 * SettingsView marks org-policy pages adminOnly, which strips them from the nav
 * for non-admins. This component ALSO degrades gracefully if it is somehow
 * rendered for one, because the value governs their bell too and "why does mine
 * refresh so slowly" is a fair question to be able to answer without asking an
 * admin.
 */
import React, { useState, useEffect, useCallback } from 'react';
// Default export, like NotificationBell uses — `api` is the raw axios
// instance; `apiService` is the named export of grouped helpers.
import api from './apiService';

/** Seconds → the words an admin actually thinks in. */
function describe(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec} seconds`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
}

// The options an admin will actually want, rather than a free-text box that
// invites 47. Every value sits inside the server's bounds; the server clamps
// regardless, because a UI is not a validation layer.
const PRESETS = [30, 60, 300, 900, 1800, 3600, 7200, 10800];

export default function OrgNotificationSettings({ isAdmin = true }) {
  const [cfg, setCfg]   = useState(null);
  const [value, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/team-notifications/config');
      setCfg(data);
      setVal(String(data.pollSeconds));
    } catch {
      // Before this window's backend ships, this route 404s. Rendering nothing
      // is better than an error for a page whose whole subject is a setting
      // that does not exist yet.
      setCfg(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data } = await api.patch('/team-notifications/config',
        { pollSeconds: Number(value) });
      setCfg(data);
      setVal(String(data.pollSeconds));
      setMsg({ ok: true, text: 'Saved. People will pick this up next time they load the app.' });
    } catch (e) {
      setMsg({ ok: false, text: e?.response?.data?.error || 'Could not save that.' });
    } finally { setBusy(false); }
  };

  if (!cfg) return null;

  const n = Number(value);
  const valid = Number.isInteger(n) && n >= cfg.min && n <= cfg.max;
  const dirty = String(cfg.pollSeconds) !== String(value);

  return (
    <div className="sv-section">
      <h2 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 4px' }}>
        Notifications
      </h2>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 18px', lineHeight: 1.6 }}>
        Applies to everyone in the organisation. Each person still chooses their own
        channels and categories under Alerts.
      </p>

      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>
        How often the notification bell checks for new items
      </h3>
      <p style={{ fontSize: 12.5, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.6 }}>
        {/* Says what the cost IS, since it is not obvious that one person's
            setting is multiplied by everybody logged in. */}
        This runs for every signed-in person, so a short interval means a lot of
        requests. Notifications still arrive by email and Slack on their own
        schedule — this only governs how quickly the bell in the header notices
        them.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={PRESETS.includes(n) ? String(n) : 'custom'}
          disabled={!isAdmin || busy}
          onChange={e => { if (e.target.value !== 'custom') setVal(e.target.value); }}
          style={{ padding: '7px 9px', borderRadius: 6, border: '1px solid #d1d5db',
                   fontSize: 13, fontFamily: 'inherit', minWidth: 160 }}>
          {PRESETS.map(p => (
            <option key={p} value={String(p)}>
              {describe(p)}{p === cfg.default ? ' (default)' : ''}
            </option>
          ))}
          {/* Only appears when the stored value is not one of the presets —
              somebody set it through the API. Selectable-looking options that
              do nothing are worse than an option that explains itself. */}
          {!PRESETS.includes(n) && <option value="custom">{describe(n)} (custom)</option>}
        </select>

        {isAdmin && (
          <button onClick={save} disabled={busy || !valid || !dirty}
            style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: 'none',
                     background: busy || !valid || !dirty ? '#9ca3af' : '#0f2f4a',
                     color: '#fff', cursor: busy || !valid || !dirty ? 'default' : 'pointer' }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}

        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          {cfg.isDefault
            ? `Not set — using the default of ${describe(cfg.default)}`
            : `Set to ${describe(cfg.pollSeconds)}`}
        </span>
      </div>

      {!isAdmin && (
        <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 10 }}>
          👁 View only — this is set by your org admin.
        </p>
      )}

      {msg && (
        <div style={{ marginTop: 12, fontSize: 12.5, borderRadius: 6, padding: '7px 10px',
                      background: msg.ok ? '#ecfdf5' : '#fee2e2',
                      color:      msg.ok ? '#065f46' : '#991b1b' }}>
          {msg.text}
        </div>
      )}

      <p style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 14, lineHeight: 1.6 }}>
        Anything between {describe(cfg.min)} and {describe(cfg.max)} is allowed. The
        bounds and the default come from the server, so this list cannot drift from
        what it will accept.
      </p>
    </div>
  );
}
