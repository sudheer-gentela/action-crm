/**
 * OALinkedInAutomation.js
 *
 * Org-admin sub-tab: the MASTER toggle + guardrails for optional LinkedIn
 * connection-request auto-send.
 *
 *   GET   /api/org/linkedin-automation          (effective config + limits)
 *   PATCH /api/org/admin/linkedin-automation    (admin update)
 *
 * The per-rep opt-in lives in MyLinkedInAutoConnectSettings.js (Settings →
 * a rep's own settings). A rep is only ever auto-sending when BOTH this org
 * toggle is on AND they opted in.
 *
 * Drop-in location: frontend/src/OALinkedInAutomation.js
 * Mount: imported + rendered by OAProspectingModule() in OrgAdminView.js as a
 * new sub-tab (see handover doc for the 2-line mount).
 */

import React, { useState, useEffect } from 'react';

const DAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' }, { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
];

export default function OALinkedInAutomation() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [config, setConfig]   = useState(null);
  const [limits, setLimits]   = useState(null);
  const [dirty, setDirty]     = useState(false);
  const [saving, setSaving]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash]     = useState(null);
  const showFlash = (type, msg) => { setFlash({ type, msg }); setTimeout(() => setFlash(null), 5000); };

  useEffect(() => {
    fetch(`${API}/org/linkedin-automation`, { headers })
      .then(r => r.json())
      .then(d => { if (d.ok) { setConfig(d.config); setLimits(d.limits); } })
      .catch(() => showFlash('error', 'Failed to load settings'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (mut) => { setConfig(c => { const next = mut({ ...c }); return next; }); setDirty(true); };

  const toggleDay = (n) => patch(c => {
    const days = new Set(c.human_hours.days);
    if (days.has(n)) days.delete(n); else days.add(n);
    return { ...c, human_hours: { ...c.human_hours, days: [...days].sort((a, b) => a - b) } };
  });

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        auto_connect_enabled: config.auto_connect_enabled,
        daily_cap:            config.daily_cap,
        jitter_seconds:       config.jitter_seconds,
        human_hours:          config.human_hours,
        lease_minutes:        config.lease_minutes,
      };
      const r = await fetch(`${API}/org/admin/linkedin-automation`, {
        method: 'PATCH', headers, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Save failed');
      setConfig(d.config); setDirty(false);
      showFlash('success', 'LinkedIn automation settings saved');
    } catch (e) {
      showFlash('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 720, padding: '8px 4px' }}>
      <h3 style={{ margin: '0 0 4px' }}>LinkedIn connection auto-send</h3>
      <p style={{ color: '#5b6b7b', margin: '0 0 16px', fontSize: 14 }}>
        Lets sequences send LinkedIn connection requests automatically, in each
        rep's own browser, instead of leaving them as manual tasks. Off by
        default. Each rep must also opt in individually before anything sends.
      </p>

      {/* Disclaimer — this is a knowing ToS tradeoff. Keep it prominent. */}
      <div style={{ background: '#FFF4E5', border: '1px solid #F5A623', borderRadius: 8, padding: '12px 14px', marginBottom: 18, fontSize: 13, color: '#5b4a1f' }}>
        <strong>Read before enabling.</strong> Automating LinkedIn connection
        requests violates LinkedIn's User Agreement and is the most common cause
        of account restriction or permanent ban. GoWarm keeps it low-and-slow
        (a hard daily cap, randomized delays, your working-hours window, and an
        immediate stop on any LinkedIn security challenge), but the risk is real
        and falls on the account owner. Enable only if your team understands and
        accepts that risk.
      </div>

      {flash && (
        <div style={{ marginBottom: 14, padding: '8px 12px', borderRadius: 6, fontSize: 13,
          background: flash.type === 'error' ? '#FDECEA' : '#E6F4EA',
          color: flash.type === 'error' ? '#A4262C' : '#1E7E34' }}>
          {flash.msg}
        </div>
      )}

      {/* Master toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={!!config.auto_connect_enabled}
          onChange={e => patch(c => ({ ...c, auto_connect_enabled: e.target.checked }))}
        />
        Enable connection-request auto-send for this org
      </label>

      <fieldset disabled={!config.auto_connect_enabled}
        style={{ border: '1px solid #E3E8EE', borderRadius: 8, padding: 16, opacity: config.auto_connect_enabled ? 1 : 0.55 }}>
        <legend style={{ padding: '0 6px', fontSize: 13, color: '#5b6b7b' }}>Guardrails</legend>

        <Row label="Daily cap per rep" hint={`Max auto-sends per rep per rolling 24h (1–${limits?.daily_cap_max || 40}).`}>
          <input type="number" min={1} max={limits?.daily_cap_max || 40}
            value={config.daily_cap}
            onChange={e => patch(c => ({ ...c, daily_cap: Number(e.target.value) }))}
            style={numStyle} />
        </Row>

        <Row label="Delay between sends" hint={`Randomized gap, in seconds (min ≥ ${limits?.jitter_min_floor || 20}).`}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min={limits?.jitter_min_floor || 20}
              value={config.jitter_seconds.min}
              onChange={e => patch(c => ({ ...c, jitter_seconds: { ...c.jitter_seconds, min: Number(e.target.value) } }))}
              style={numStyle} />
            <span style={{ color: '#5b6b7b' }}>to</span>
            <input type="number" min={config.jitter_seconds.min}
              value={config.jitter_seconds.max}
              onChange={e => patch(c => ({ ...c, jitter_seconds: { ...c.jitter_seconds, max: Number(e.target.value) } }))}
              style={numStyle} />
            <span style={{ color: '#5b6b7b' }}>sec</span>
          </span>
        </Row>

        <Row label="Working hours" hint="Sends only happen in the rep's LOCAL time, inside this window.">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min={0} max={23}
              value={config.human_hours.start_hour}
              onChange={e => patch(c => ({ ...c, human_hours: { ...c.human_hours, start_hour: Number(e.target.value) } }))}
              style={numStyle} />
            <span style={{ color: '#5b6b7b' }}>to</span>
            <input type="number" min={1} max={24}
              value={config.human_hours.end_hour}
              onChange={e => patch(c => ({ ...c, human_hours: { ...c.human_hours, end_hour: Number(e.target.value) } }))}
              style={numStyle} />
            <span style={{ color: '#5b6b7b' }}>(24h)</span>
          </span>
        </Row>

        <Row label="Active days" hint="">
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DAYS.map(d => {
              const on = config.human_hours.days.includes(d.n);
              return (
                <button key={d.n} type="button" onClick={() => toggleDay(d.n)}
                  style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #C9D2DD', cursor: 'pointer',
                    background: on ? '#0F9D8E' : '#fff', color: on ? '#fff' : '#5b6b7b', fontSize: 13 }}>
                  {d.label}
                </button>
              );
            })}
          </span>
        </Row>
      </fieldset>

      <div style={{ marginTop: 18 }}>
        <button onClick={save} disabled={!dirty || saving}
          style={{ padding: '8px 18px', borderRadius: 6, border: 'none', cursor: dirty ? 'pointer' : 'default',
            background: dirty ? '#E8630A' : '#C9D2DD', color: '#fff', fontWeight: 600 }}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

const numStyle = { width: 80, padding: '6px 8px', border: '1px solid #C9D2DD', borderRadius: 6, fontSize: 14 };

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '10px 0', borderBottom: '1px solid #F0F3F7' }}>
      <div style={{ flex: '0 0 180px' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        {hint ? <div style={{ color: '#8a97a6', fontSize: 12, marginTop: 2 }}>{hint}</div> : null}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
