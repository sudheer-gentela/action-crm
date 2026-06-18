/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAProspectingEscalation. */
import React, { useState, useEffect } from 'react';

export default function OAProspectingEscalation() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // policy starts undefined so we can distinguish "still loading" from
  // "loaded but empty". Defaults from the server come back inside the
  // policy object — we never have to hardcode them client-side.
  const [policy,   setPolicy]   = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [dirty,    setDirty]    = useState(false);
  const [flash,    setFlash]    = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/org/admin/prospecting-escalation`, { headers })
      .then(r => r.json())
      .then(res => {
        setPolicy(res.policy || {});
        setDefaults(res.defaults || {});
      })
      .catch(() => showFlash('error', 'Failed to load escalation policy'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single field setter — works for booleans, numbers, arrays.
  const set = (key, value) => {
    setPolicy(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  // Channel multi-select. The policy stores an array; UI is two checkboxes.
  const toggleChannel = (ch) => {
    const current = Array.isArray(policy.channels) ? policy.channels : [];
    const next = current.includes(ch)
      ? current.filter(c => c !== ch)
      : [...current, ch];
    // Don't allow empty — validation on the backend would reject it, but
    // better to short-circuit the UI so the user sees what's happening.
    if (next.length === 0) {
      showFlash('error', 'At least one delivery channel must be selected');
      return;
    }
    set('channels', next);
  };

  const handleSave = async () => {
    // Client-side monotonicity guard mirrors the server check — gives a
    // clearer error before the round trip.
    if (!(policy.tier1_hours < policy.tier2_hours && policy.tier2_hours < policy.tier3_hours)) {
      showFlash('error', 'Tier hours must be strictly increasing: Tier 1 < Tier 2 < Tier 3');
      return;
    }

    setSaving(true);
    try {
      const r = await fetch(`${API}/org/admin/prospecting-escalation`, {
        method: 'PUT', headers,
        body: JSON.stringify(policy),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res?.error?.message || 'Save failed');
      setPolicy(res.policy);
      setDirty(false);
      showFlash('success', 'Escalation policy saved');
    } catch (e) {
      showFlash('error', e.message || 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!defaults) return;
    if (!window.confirm('Reset all escalation settings to system defaults? Unsaved changes will be lost.')) return;
    setPolicy({ ...defaults });
    setDirty(true);
  };

  if (loading || !policy) {
    return <div style={{ padding: 24, color: '#6b7280' }}>Loading escalation settings…</div>;
  }

  // Reused styles — kept inline to match the rest of OrgAdminView.js, which
  // doesn't import a CSS module for these subtabs.
  const cardStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
    padding: 16, marginBottom: 12,
  };
  const labelStyle = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4,
  };
  const inputStyle = {
    width: 120, padding: '6px 10px', fontSize: 13,
    border: '1px solid #d1d5db', borderRadius: 6,
  };
  const helpStyle = {
    fontSize: 11, color: '#6b7280', marginTop: 4,
  };

  // Build the digest-hour dropdown. We label each UTC hour with its
  // corresponding IST and PT time so the admin can pick by their morning,
  // not by guessing offsets. 24 options.
  const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
    const istHour = (h + 5) % 24;
    const istMin  = 30;
    const ptHour  = (h + 24 - 8) % 24;  // PST baseline, ignores DST
    const fmt = (hr, min = 0) => {
      const pm = hr >= 12;
      const h12 = hr % 12 === 0 ? 12 : hr % 12;
      return `${h12}:${String(min).padStart(2,'0')} ${pm ? 'PM' : 'AM'}`;
    };
    return {
      value: h,
      label: `${String(h).padStart(2,'0')}:00 UTC  (${fmt(istHour, istMin)} IST · ${fmt(ptHour)} PT)`,
    };
  });

  return (
    <div style={{ marginTop: 8, maxWidth: 760 }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>📣 Escalation Policy</h3>
          <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
            How overdue prospecting actions are surfaced to reps and escalated to managers.
          </p>
        </div>
        <button
          onClick={handleReset}
          style={{
            padding: '6px 12px', fontSize: 12, color: '#6b7280',
            background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Reset to defaults
        </button>
      </div>

      {flash && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
          background: flash.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      flash.type === 'error' ? '#991b1b' : '#166534',
          border: `1px solid ${flash.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* ── Master enable ──────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Escalation enabled</div>
            <div style={helpStyle}>Master switch. When off, no alerts or escalations fire for this org.</div>
          </div>
          <label className="ns-toggle" style={{ position: 'relative', display: 'inline-block', width: 38, height: 22 }}>
            <input
              type="checkbox"
              checked={!!policy.enabled}
              onChange={e => set('enabled', e.target.checked)}
              style={{ display: 'none' }}
            />
            <span style={{
              position: 'absolute', cursor: 'pointer', inset: 0,
              background: policy.enabled ? '#10b981' : '#d1d5db',
              borderRadius: 11, transition: 'background 0.15s',
            }} />
            <span style={{
              position: 'absolute', top: 2, left: policy.enabled ? 18 : 2,
              width: 18, height: 18, background: '#fff', borderRadius: '50%',
              transition: 'left 0.15s',
            }} />
          </label>
        </div>
      </div>

      {/* When master is off, dim the rest. Still editable so the admin can
          tweak settings before turning the policy on. */}
      <div style={{ opacity: policy.enabled ? 1 : 0.5 }}>

        {/* ── Immediate alert ────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Immediate alert</div>
              <div style={helpStyle}>Notify the rep when an action has been overdue for the threshold below.</div>
            </div>
            <input
              type="checkbox"
              checked={!!policy.immediate_alert_enabled}
              onChange={e => set('immediate_alert_enabled', e.target.checked)}
              style={{ marginTop: 4 }}
            />
          </div>
          {policy.immediate_alert_enabled && (
            <div>
              <label style={labelStyle}>Alert after</label>
              <input
                type="number" min={1} max={720}
                value={policy.immediate_hours}
                onChange={e => set('immediate_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>hours past due</span>
            </div>
          )}
        </div>

        {/* ── Daily digest ───────────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>Daily digest</div>
              <div style={helpStyle}>
                One summary per rep per day, sent at the time you pick below.
                Defaults to 03:00 UTC = 8:30 AM IST.
              </div>
            </div>
            <input
              type="checkbox"
              checked={!!policy.daily_digest_enabled}
              onChange={e => set('daily_digest_enabled', e.target.checked)}
              style={{ marginTop: 4 }}
            />
          </div>
          {policy.daily_digest_enabled && (
            <div>
              <label style={labelStyle}>Send digest at</label>
              <select
                value={policy.digest_hour_utc}
                onChange={e => set('digest_hour_utc', parseInt(e.target.value))}
                style={{ ...inputStyle, width: 360 }}
              >
                {HOUR_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* ── Escalation tiers ───────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>Escalation tiers</div>
          <div style={{ ...helpStyle, marginBottom: 14 }}>
            When an action stays overdue, escalate up the hierarchy at these
            thresholds. Tier 2 notifies the rep's reporting manager; Tier 3
            also notifies the manager's manager (or all org admins as a
            fallback if no skip-level manager exists).
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Tier 1 — rep nudge</label>
              <input
                type="number" min={1} max={720}
                value={policy.tier1_hours}
                onChange={e => set('tier1_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <div style={helpStyle}>hours past due</div>
            </div>
            <div>
              <label style={labelStyle}>Tier 2 — loop in manager</label>
              <input
                type="number" min={1} max={720}
                value={policy.tier2_hours}
                onChange={e => set('tier2_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <div style={helpStyle}>hours past due</div>
            </div>
            <div>
              <label style={labelStyle}>Tier 3 — skip-level</label>
              <input
                type="number" min={1} max={720}
                value={policy.tier3_hours}
                onChange={e => set('tier3_hours', parseInt(e.target.value) || 1)}
                style={inputStyle}
              />
              <div style={helpStyle}>hours past due</div>
            </div>
          </div>
        </div>

        {/* ── Delivery channels ──────────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>Delivery channels</div>
          <div style={{ ...helpStyle, marginBottom: 14 }}>
            How notifications are delivered. In-app notifications appear in
            the bell icon. Email notifications go to each recipient's
            registered address.
          </div>

          <div style={{ display: 'flex', gap: 24 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={(policy.channels || []).includes('in_app')}
                onChange={() => toggleChannel('in_app')}
              />
              In-app
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={(policy.channels || []).includes('email')}
                onChange={() => toggleChannel('email')}
              />
              Email
            </label>
          </div>
        </div>
      </div>

      {/* ── Save bar ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            padding: '8px 18px', fontSize: 13, fontWeight: 600,
            color: '#fff', background: dirty && !saving ? '#0F9D8E' : '#9ca3af',
            border: 'none', borderRadius: 6,
            cursor: dirty && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      </div>
    </div>
  );
}
