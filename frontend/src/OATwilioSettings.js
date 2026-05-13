/**
 * OATwilioSettings.js
 *
 * Sub-tab inside OAProspectingModule. Two sections:
 *
 *   1. Org-level settings — recording toggles + rate limits
 *      PATCH /api/org/admin/twilio/settings
 *
 *   2. Per-rep DID management — provision/release Twilio phone numbers
 *      GET   /api/org/admin/twilio/reps
 *      POST  /api/org/admin/twilio/provision-did/:userId  body { area_code }
 *      POST  /api/org/admin/twilio/release-did/:userId
 *
 * Drop-in location: frontend/src/OATwilioSettings.js
 * Imported and rendered by OrgAdminView.js (see patch instructions).
 */

import React, { useState, useEffect } from 'react';

export default function OATwilioSettings() {
  const API     = process.env.REACT_APP_API_URL;
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── State ───────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState({
    recording_enabled:            true,
    recording_disclosure_enabled: true,
    rate_limits: { per_user_per_minute: 10, per_org_per_minute: 100 },
  });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [reps, setReps]               = useState([]);
  const [repsLoading, setRepsLoading] = useState(true);
  const [provisioning, setProvisioning] = useState({});  // userId → bool
  const [areaCodes, setAreaCodes]     = useState({});    // userId → "415"

  const [flash, setFlash] = useState(null);
  const showFlash = (type, msg) => { setFlash({ type, msg }); setTimeout(() => setFlash(null), 5000); };

  // ── Load on mount ───────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch(`${API}/org/call-settings`, { headers }).then(r => r.json()),
      fetch(`${API}/org/admin/twilio/reps`, { headers }).then(r => r.json()),
    ])
      .then(([cs, rp]) => {
        const s = cs.settings || {};
        setSettings({
          recording_enabled:            s.recording_enabled !== false,
          recording_disclosure_enabled: s.recording_disclosure_enabled !== false,
          rate_limits: {
            per_user_per_minute: s.rate_limits?.per_user_per_minute || 10,
            per_org_per_minute:  s.rate_limits?.per_org_per_minute  || 100,
          },
        });
        setReps(rp.reps || []);
      })
      .catch(() => showFlash('error', 'Failed to load Twilio settings'))
      .finally(() => setRepsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Save org settings ──────────────────────────────────────────────────
  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      const r = await fetch(`${API}/org/admin/twilio/settings`, {
        method: 'PATCH', headers,
        body: JSON.stringify(settings),
      });
      if (!r.ok) {
        const j = await r.json();
        throw new Error(j?.error?.message || 'Save failed');
      }
      setSettingsDirty(false);
      showFlash('success', 'Twilio settings saved ✓');
    } catch (err) {
      showFlash('error', err.message);
    } finally {
      setSettingsSaving(false);
    }
  };

  // ── Provision DID ──────────────────────────────────────────────────────
  const provisionDid = async (userId) => {
    const areaCode = areaCodes[userId];
    if (!/^\d{3}$/.test(areaCode || '')) {
      showFlash('error', 'Enter a 3-digit US area code first (e.g. 415)');
      return;
    }
    if (!window.confirm(`Provision a new Twilio phone number in area code ${areaCode}? This will cost ~$1/month.`)) {
      return;
    }
    setProvisioning(p => ({ ...p, [userId]: true }));
    try {
      const r = await fetch(`${API}/org/admin/twilio/provision-did/${userId}`, {
        method: 'POST', headers,
        body: JSON.stringify({ area_code: areaCode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || 'Provision failed');

      // Update the rep row inline.
      setReps(prev => prev.map(rep =>
        rep.id === userId
          ? { ...rep,
              twilio_did:                j.twilio_did,
              twilio_did_sid:            j.twilio_did_sid,
              twilio_did_provisioned_at: j.twilio_did_provisioned_at,
              ready_to_call:             !!rep.phone,
            }
          : rep
      ));
      setAreaCodes(p => ({ ...p, [userId]: '' }));
      showFlash('success', `DID ${j.twilio_did} provisioned ✓`);
    } catch (err) {
      showFlash('error', err.message);
    } finally {
      setProvisioning(p => ({ ...p, [userId]: false }));
    }
  };

  // ── Release DID ────────────────────────────────────────────────────────
  const releaseDid = async (userId) => {
    const rep = reps.find(r => r.id === userId);
    if (!rep) return;
    if (!window.confirm(`Release ${rep.twilio_did} back to Twilio? This rep will no longer be able to make calls until a new DID is assigned.`)) {
      return;
    }
    setProvisioning(p => ({ ...p, [userId]: true }));
    try {
      const r = await fetch(`${API}/org/admin/twilio/release-did/${userId}`, {
        method: 'POST', headers,
      });
      const j = await r.json();
      if (!r.ok && r.status !== 207) throw new Error(j?.error?.message || 'Release failed');

      setReps(prev => prev.map(rep =>
        rep.id === userId
          ? { ...rep, twilio_did: null, twilio_did_sid: null, twilio_did_provisioned_at: null, ready_to_call: false }
          : rep
      ));
      showFlash('success', r.status === 207
        ? 'DID unassigned but Twilio release failed — check console'
        : 'DID released ✓');
    } catch (err) {
      showFlash('error', err.message);
    } finally {
      setProvisioning(p => ({ ...p, [userId]: false }));
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: '#111827' }}>📞 Twilio Click-to-Dial</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
            Org-level toggles + per-rep DID (phone number) provisioning.
          </p>
        </div>
      </div>

      {flash && (
        <div style={{
          marginBottom: 16, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: flash.type === 'success' ? '#d1fae5' : '#fef2f2',
          color:      flash.type === 'success' ? '#065f46' : '#991b1b',
          border:     `1px solid ${flash.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
        }}>
          {flash.msg}
        </div>
      )}

      {/* ── Org-level settings ───────────────────────────────────────────── */}
      <section style={{ marginBottom: 32, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fafafa' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1f2937' }}>Org-wide settings</h4>
          <button
            onClick={saveSettings}
            disabled={!settingsDirty || settingsSaving}
            style={{
              padding: '6px 16px',
              background: settingsDirty ? '#0F9D8E' : '#d1d5db',
              color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600,
              cursor: settingsDirty ? 'pointer' : 'not-allowed',
            }}
          >
            {settingsSaving ? '⏳ Saving…' : '💾 Save'}
          </button>
        </div>

        <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.recording_enabled}
            onChange={e => { setSettings(s => ({ ...s, recording_enabled: e.target.checked })); setSettingsDirty(true); }}
            style={{ marginRight: 8 }}
          />
          <strong>Record all calls</strong>
          <span style={{ marginLeft: 24, display: 'block', color: '#6b7280', fontSize: 12 }}>
            Both legs of every Twilio call are recorded by Twilio. Recordings appear on the call detail row.
          </span>
        </label>

        <label style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={settings.recording_disclosure_enabled}
            disabled={!settings.recording_enabled}
            onChange={e => { setSettings(s => ({ ...s, recording_disclosure_enabled: e.target.checked })); setSettingsDirty(true); }}
            style={{ marginRight: 8 }}
          />
          <strong>Play disclosure announcement</strong>
          <span style={{ marginLeft: 24, display: 'block', color: '#6b7280', fontSize: 12 }}>
            Plays "This call may be recorded." at the start of each call. Required in two-party-consent jurisdictions.
          </span>
        </label>

        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4, fontWeight: 600 }}>
              Per-rep rate limit
            </label>
            <input
              type="number" min={1} max={100}
              value={settings.rate_limits.per_user_per_minute}
              onChange={e => {
                const n = parseInt(e.target.value, 10);
                setSettings(s => ({ ...s, rate_limits: { ...s.rate_limits, per_user_per_minute: n } }));
                setSettingsDirty(true);
              }}
              style={{ width: 80, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
            />
            <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>calls / minute</span>
          </div>

          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 4, fontWeight: 600 }}>
              Org-wide rate limit
            </label>
            <input
              type="number" min={1} max={1000}
              value={settings.rate_limits.per_org_per_minute}
              onChange={e => {
                const n = parseInt(e.target.value, 10);
                setSettings(s => ({ ...s, rate_limits: { ...s.rate_limits, per_org_per_minute: n } }));
                setSettingsDirty(true);
              }}
              style={{ width: 80, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
            />
            <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>calls / minute</span>
          </div>
        </div>
      </section>

      {/* ── Per-rep DIDs ─────────────────────────────────────────────────── */}
      <section>
        <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: '#1f2937' }}>
          Rep phone numbers ({reps.length})
        </h4>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 16px' }}>
          Each rep needs their own Twilio phone number (DID) before they can make calls. Reps also need to add their personal phone in My Preferences.
        </p>

        {repsLoading ? (
          <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading reps…</div>
        ) : reps.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: 13 }}>No active reps in this org.</div>
        ) : (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={th}>Rep</th>
                  <th style={th}>Personal phone</th>
                  <th style={th}>Twilio DID</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {reps.map(rep => (
                  <tr key={rep.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>{rep.name}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{rep.email} · {rep.role}</div>
                    </td>
                    <td style={td}>
                      {rep.phone || <span style={{ color: '#9ca3af' }}>Not set</span>}
                    </td>
                    <td style={td}>
                      {rep.twilio_did ? (
                        <div>
                          <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{rep.twilio_did}</div>
                          <div style={{ fontSize: 11, color: '#6b7280' }}>
                            since {new Date(rep.twilio_did_provisioned_at).toLocaleDateString()}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: '#9ca3af' }}>No DID</span>
                      )}
                    </td>
                    <td style={td}>
                      {rep.twilio_did ? (
                        <button
                          onClick={() => releaseDid(rep.id)}
                          disabled={provisioning[rep.id]}
                          style={btnDanger}
                        >
                          {provisioning[rep.id] ? '⏳' : 'Release'}
                        </button>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            placeholder="Area code (e.g. 415)"
                            value={areaCodes[rep.id] || ''}
                            onChange={e => setAreaCodes(p => ({ ...p, [rep.id]: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
                            style={{ width: 110, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                          />
                          <button
                            onClick={() => provisionDid(rep.id)}
                            disabled={provisioning[rep.id]}
                            style={btnPrimary}
                          >
                            {provisioning[rep.id] ? '⏳' : 'Provision'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────
const th = { textAlign: 'left', padding: '10px 12px', fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const td = { padding: '10px 12px', verticalAlign: 'top' };
const btnPrimary = { padding: '5px 12px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnDanger  = { padding: '5px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
