/**
 * MyLinkedInAutoConnectSettings.js
 *
 * Per-rep opt-in for LinkedIn connection-request auto-send.
 *
 *   GET /api/me/linkedin-auto-connect   (my opt-in + resolved effective state)
 *   PUT /api/me/linkedin-auto-connect   body { opted_in: boolean }
 *
 * Auto-send only happens when BOTH the org master toggle (set by an admin in
 * Org Admin → Prospecting → LinkedIn automation) AND this opt-in are on. We
 * surface the org state explicitly so a rep understands why their opt-in may
 * not yet be taking effect.
 *
 * Drop-in location: frontend/src/MyLinkedInAutoConnectSettings.js
 * Mount: rendered by SettingsView.js under a new sidebar id (see handover doc).
 */

import React, { useState, useEffect } from 'react';

export default function MyLinkedInAutoConnectSettings() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [state, setState]     = useState(null);   // { opted_in, effective_enabled, org_enabled, source }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [flash, setFlash]     = useState(null);
  const showFlash = (type, msg) => { setFlash({ type, msg }); setTimeout(() => setFlash(null), 4000); };

  const load = () =>
    fetch(`${API}/me/linkedin-auto-connect`, { headers })
      .then(r => r.json())
      .then(d => { if (d.ok) setState(d); })
      .catch(() => showFlash('error', 'Failed to load'))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOptIn = async (val) => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/me/linkedin-auto-connect`, {
        method: 'PUT', headers, body: JSON.stringify({ opted_in: val }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Save failed');
      setState(s => ({ ...s, opted_in: d.opted_in, effective_enabled: d.effective_enabled, source: d.source }));
      showFlash('success', val ? 'Opted in to connection auto-send' : 'Opted out');
    } catch (e) {
      showFlash('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !state) return <div style={{ padding: 24 }}>Loading…</div>;

  const orgOff = !state.org_enabled;

  return (
    <div style={{ maxWidth: 640, padding: '8px 4px' }}>
      <h3 style={{ margin: '0 0 4px' }}>LinkedIn connection auto-send</h3>
      <p style={{ color: '#5b6b7b', margin: '0 0 16px', fontSize: 14 }}>
        When on, your sequences' LinkedIn connection-request steps are sent
        automatically from your own browser while you're signed in to LinkedIn —
        instead of waiting for you to send each one by hand.
      </p>

      <div style={{ background: '#FFF4E5', border: '1px solid #F5A623', borderRadius: 8, padding: '12px 14px', marginBottom: 18, fontSize: 13, color: '#5b4a1f' }}>
        <strong>Please understand the risk.</strong> Automating connection
        requests breaks LinkedIn's User Agreement and can get your LinkedIn
        account restricted or banned. GoWarm throttles heavily (a daily cap,
        random delays, your working hours, and an immediate stop if LinkedIn
        shows a security check), but the risk is on your account. Opting in means
        you accept that.
      </div>

      {flash && (
        <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 6, fontSize: 13,
          background: flash.type === 'error' ? '#FDECEA' : '#E6F4EA',
          color: flash.type === 'error' ? '#A4262C' : '#1E7E34' }}>
          {flash.msg}
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, fontSize: 15 }}>
        <input
          type="checkbox"
          checked={state.opted_in === true}
          disabled={saving}
          onChange={e => setOptIn(e.target.checked)}
        />
        Auto-send my LinkedIn connection requests
      </label>

      <div style={{ marginTop: 14, fontSize: 13 }}>
        {state.effective_enabled ? (
          <span style={{ color: '#1E7E34' }}>● Active — eligible connection-request steps will auto-send within your limits.</span>
        ) : orgOff && state.opted_in ? (
          <span style={{ color: '#8a6d1f' }}>● You're opted in, but your admin hasn't enabled connection auto-send for the org yet. It will start once they do.</span>
        ) : orgOff ? (
          <span style={{ color: '#8a97a6' }}>● Your admin hasn't enabled connection auto-send for the org.</span>
        ) : (
          <span style={{ color: '#8a97a6' }}>● Off — your connection-request steps stay manual.</span>
        )}
      </div>

      <p style={{ color: '#8a97a6', fontSize: 12, marginTop: 18 }}>
        Sends only happen while you have LinkedIn open and you're inside the
        working-hours window your admin configured. The extension stops
        immediately if LinkedIn shows any security challenge.
      </p>
    </div>
  );
}
