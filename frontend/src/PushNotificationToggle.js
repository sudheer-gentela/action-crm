// PushNotificationToggle.js
//
// Per-device opt-in for web push, rendered inside NotificationSettings.
//
// "Per-device" is the important word and the reason this does not look like the
// other settings on that screen. Every other toggle there is an account
// preference that follows you everywhere. A push subscription belongs to one
// browser on one machine — enabling it on your laptop does nothing for your
// phone. The copy says so explicitly, because a toggle that silently means
// something narrower than the ones above it is a trap.

import React, { useState, useEffect, useCallback } from 'react';
import {
  pushSupported,
  isSubscribed,
  subscribeToPush,
  unsubscribeFromPush,
  permission,
  isIos,
  isStandalone,
} from './serviceWorkerRegistration';

const EMBER = '#E8630A';

export default function PushNotificationToggle() {
  const [on, setOn]         = useState(false);
  const [busy, setBusy]     = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    isSubscribed().then((v) => { if (alive) { setOn(v); setLoaded(true); } });
    return () => { alive = false; };
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    setMessage('');
    const res = on ? await unsubscribeFromPush() : await subscribeToPush();
    if (res.ok) {
      setOn(!on);
    } else {
      setMessage(res.reason || 'Could not change this setting.');
    }
    setBusy(false);
  }, [on]);

  if (!pushSupported()) {
    return (
      <div className="ns-card">
        <div style={{ fontSize: 13, color: '#6b7280', padding: '4px 0' }}>
          This browser cannot deliver push notifications. Everything still shows
          in the bell menu when GoWarm is open.
        </div>
      </div>
    );
  }

  // iOS refuses push to a Safari tab — the app has to be on the home screen
  // first. Say that instead of offering a control that cannot work.
  const iosNeedsInstall = isIos() && !isStandalone();
  const blocked = permission() === 'denied';

  return (
    <div className="ns-card">
      <div className="ns-toggle-row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1a202c', marginBottom: 2 }}>
            Push notifications on this device
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
            Alerts reach you when GoWarm is closed. This applies to this browser
            only — turn it on separately on your phone.
          </div>

          {iosNeedsInstall && (
            <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7',
                          border: '1px solid #fde68a', borderRadius: 6,
                          padding: '8px 10px', marginTop: 8, lineHeight: 1.5 }}>
              Add GoWarm to your home screen first — tap Share, then
              "Add to Home Screen". Safari only delivers notifications to an
              installed app.
            </div>
          )}

          {blocked && !iosNeedsInstall && (
            <div style={{ fontSize: 12, color: '#991b1b', background: '#fee2e2',
                          border: '1px solid #fecaca', borderRadius: 6,
                          padding: '8px 10px', marginTop: 8, lineHeight: 1.5 }}>
              Notifications are blocked for this site. Re-enable them in your
              browser's site settings, then come back.
            </div>
          )}

          {message && (
            <div style={{ fontSize: 12, color: '#991b1b', marginTop: 8, lineHeight: 1.5 }}>
              {message}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggle}
          disabled={busy || !loaded || iosNeedsInstall || blocked}
          style={{
            flexShrink: 0, minHeight: 44, padding: '9px 16px', borderRadius: 8,
            border: `1px solid ${on ? '#d1d5db' : EMBER}`,
            background: on ? '#fff' : EMBER,
            color: on ? '#4b5563' : '#fff',
            fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            cursor: (busy || iosNeedsInstall || blocked) ? 'not-allowed' : 'pointer',
            opacity: (busy || iosNeedsInstall || blocked) ? 0.6 : 1,
          }}
        >
          {busy ? 'Working…' : on ? 'Turn off' : 'Turn on'}
        </button>
      </div>
    </div>
  );
}
