/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAIntegrations. */
import React, { useState, useEffect } from 'react';
import OAMeetingSettings from '../../OAMeetingSettings';
import { apiService } from '../../apiService';

export default function OAIntegrations({ orgId }) {
  const [subTab, setSubTab] = useState('email-calendar');
  const [integrations, setIntegrations] = useState([]);
  const [outreachLimits, setOutreachLimits] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(null);
  const [flash, setFlash]         = useState(null);
  const [limitsEditing, setLimitsEditing] = useState(false);
  const [limitsForm, setLimitsForm] = useState({});
  const [limitsSaving, setLimitsSaving] = useState(false);

  const PROVIDERS = [
    {
      type: 'microsoft',
      label: 'Microsoft (Outlook + OneDrive)',
      icon: '📧',
      desc: 'Enable Outlook email sync, calendar, and OneDrive file access for all org members.',
      envHint: 'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID',
      scopes: ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'Files.Read', 'User.Read'],
    },
    {
      type: 'google',
      label: 'Google (Gmail + Drive + Calendar)',
      icon: '🟢',
      desc: 'Enable Gmail sync, Google Calendar events, and Google Drive file access for all org members.',
      envHint: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET',
      scopes: ['Gmail', 'Calendar', 'Drive', 'Profile'],
    },
  ];

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getIntegrations(),
      apiService.outreachLimits.get(),
    ])
      .then(([intRes, limRes]) => {
        setIntegrations(intRes.data.integrations || []);
        setOutreachLimits(limRes.data.limits || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const getStatus    = (type) => integrations.find(i => i.integration_type === type)?.status || 'inactive';
  const getLastSynced = (type) => integrations.find(i => i.integration_type === type)?.last_synced_at;

  const handleToggle = async (type, newStatus) => {
    setSaving(type);
    setFlash(null);
    try {
      const r = await apiService.orgAdmin.updateIntegration(type, { status: newStatus });
      setIntegrations(prev => [...prev.filter(i => i.integration_type !== type), r.data.integration]);
      setFlash({ type: 'success', message: `${type === 'microsoft' ? 'Microsoft' : 'Google'} integration ${newStatus === 'active' ? 'enabled' : 'disabled'}.` });
    } catch (err) {
      setFlash({ type: 'error', message: err?.response?.data?.error?.message || 'Failed to update integration.' });
    } finally {
      setSaving(null);
    }
  };

  const startEditLimits = () => {
    setLimitsForm({
      dailyLimitCeiling:    outreachLimits?.dailyLimitCeiling    ?? 100,
      minDelayMinutesCeiling: outreachLimits?.minDelayMinutesCeiling ?? 2,
      defaultDailyLimit:    outreachLimits?.defaultDailyLimit    ?? 50,
      defaultMinDelayMinutes: outreachLimits?.defaultMinDelayMinutes ?? 5,
    });
    setLimitsEditing(true);
  };

  const saveLimits = async () => {
    setLimitsSaving(true);
    try {
      const r = await apiService.outreachLimits.update(limitsForm);
      setOutreachLimits(r.data.limits);
      setLimitsEditing(false);
      setFlash({ type: 'success', message: 'Outreach limits saved.' });
    } catch (err) {
      setFlash({ type: 'error', message: err?.response?.data?.error?.message || 'Failed to save limits.' });
    } finally {
      setLimitsSaving(false);
    }
  };

  const cardStyle = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 24, marginBottom: 16 };
  const toggleBtn = (active, disabled) => ({
    padding: '8px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
    border: active ? '1px solid #dcfce7' : '1px solid #e5e7eb',
    background: active ? '#dcfce7' : '#f3f4f6',
    color: active ? '#166534' : '#6b7280',
    cursor: disabled ? 'wait' : 'pointer', transition: 'all 0.15s',
  });
  const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 };
  const labelStyle = { fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 };
  const inputStyle = { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, width: 100 };

  if (loading) return <div style={{ padding: 24, color: '#6b7280' }}>Loading integrations...</div>;

  const SUB_TABS = [
    { id: 'email-calendar', label: '📧 Email & Calendar' },
    { id: 'meeting',        label: '🎙️ Meeting & Transcripts' },
  ];

  const subTabStyle = (id) => ({
    padding: '7px 16px',
    borderRadius: '7px 7px 0 0',
    border: '1px solid transparent',
    borderBottom: 'none',
    background: subTab === id ? '#fff' : 'transparent',
    borderColor: subTab === id ? '#e5e7eb' : 'transparent',
    borderBottomColor: subTab === id ? '#fff' : 'transparent',
    fontSize: 13,
    fontWeight: subTab === id ? 600 : 500,
    color: subTab === id ? '#111827' : '#6b7280',
    cursor: 'pointer',
    marginBottom: -1,
  });

  return (
    <div>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
        {SUB_TABS.map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)} style={subTabStyle(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Email & Calendar tab ───────────────────────────────────── */}
      {subTab === 'email-calendar' && (
        <div>
          {flash && (
            <div style={{
              padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 14, fontWeight: 500,
              background: flash.type === 'success' ? '#dcfce7' : '#fef2f2',
              color:      flash.type === 'success' ? '#166534' : '#991b1b',
            }}>
              {flash.message}
            </div>
          )}

          <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20, lineHeight: 1.6 }}>
            Enable or disable third-party integrations for your organisation. When enabled, individual
            team members can connect their personal accounts from <strong>Settings → Integrations</strong>.
          </p>

          {/* ── Email / calendar providers ─────────────────────────── */}
          {PROVIDERS.map(provider => {
            const active   = getStatus(provider.type) === 'active';
            const lastSync = getLastSynced(provider.type);
            const isSaving = saving === provider.type;
            return (
              <div key={provider.type} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
                    <span style={{ fontSize: 28 }}>{provider.icon}</span>
                    <div>
                      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#1a202c' }}>{provider.label}</h3>
                      <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>{provider.desc}</p>
                    </div>
                  </div>
                  <button style={toggleBtn(active, isSaving)} disabled={isSaving}
                    onClick={() => handleToggle(provider.type, active ? 'inactive' : 'active')}>
                    {isSaving ? '...' : active ? '✓ Enabled' : 'Enable'}
                  </button>
                </div>
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Status</div>
                      <div style={{ fontSize: 14, fontWeight: 500, color: active ? '#059669' : '#6b7280', marginTop: 2 }}>
                        {active ? 'Active' : 'Inactive'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Scopes</div>
                      <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2 }}>{provider.scopes.join(', ')}</div>
                    </div>
                    {lastSync && (
                      <div>
                        <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>Last synced</div>
                        <div style={{ fontSize: 13, color: '#4b5563', marginTop: 2 }}>{new Date(lastSync).toLocaleString()}</div>
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 12, padding: '8px 12px', background: '#f8fafc', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
                  💡 Requires env vars: <code style={{ background: '#e5e7eb', padding: '1px 4px', borderRadius: 3 }}>{provider.envHint}</code>
                </div>
              </div>
            );
          })}

          {/* ── Prospecting Email Limits ────────────────────────────── */}
          <div style={{ ...cardStyle, marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1 }}>
                <span style={{ fontSize: 28 }}>📤</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#1a202c' }}>Prospecting Email Limits</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
                    Set org-wide ceilings for outreach volume and send cadence. Individual reps can set
                    lower limits on their own sender accounts, but cannot exceed these ceilings.
                  </p>
                </div>
              </div>
              {!limitsEditing && (
                <button
                  style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#f3f4f6', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                  onClick={startEditLimits}
                >
                  Edit
                </button>
              )}
            </div>

            {limitsEditing ? (
              <div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Daily limit ceiling</label>
                    <input type="number" min={1} style={inputStyle} value={limitsForm.dailyLimitCeiling}
                      onChange={e => setLimitsForm(p => ({ ...p, dailyLimitCeiling: parseInt(e.target.value) || 1 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Max emails/day per account</span>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Min delay ceiling (min)</label>
                    <input type="number" min={0} style={inputStyle} value={limitsForm.minDelayMinutesCeiling}
                      onChange={e => setLimitsForm(p => ({ ...p, minDelayMinutesCeiling: parseInt(e.target.value) || 0 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Minimum gap enforced between sends</span>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Default daily limit</label>
                    <input type="number" min={1} style={inputStyle} value={limitsForm.defaultDailyLimit}
                      onChange={e => setLimitsForm(p => ({ ...p, defaultDailyLimit: parseInt(e.target.value) || 1 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Applied when rep has no custom limit</span>
                  </div>
                  <div style={fieldStyle}>
                    <label style={labelStyle}>Default min delay (min)</label>
                    <input type="number" min={0} style={inputStyle} value={limitsForm.defaultMinDelayMinutes}
                      onChange={e => setLimitsForm(p => ({ ...p, defaultMinDelayMinutes: parseInt(e.target.value) || 0 }))} />
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>Applied when rep has no custom delay</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={saveLimits} disabled={limitsSaving}
                    style={{ padding: '8px 18px', background: '#0F9D8E', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: limitsSaving ? 'wait' : 'pointer' }}
                  >
                    {limitsSaving ? 'Saving…' : 'Save Limits'}
                  </button>
                  <button
                    onClick={() => setLimitsEditing(false)}
                    style={{ padding: '8px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : outreachLimits ? (
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                {[
                  { label: 'Daily Limit Ceiling',      value: `${outreachLimits.dailyLimitCeiling} emails/day` },
                  { label: 'Min Delay Ceiling',         value: `${outreachLimits.minDelayMinutesCeiling} min` },
                  { label: 'Default Daily Limit',       value: `${outreachLimits.defaultDailyLimit} emails/day` },
                  { label: 'Default Min Delay',         value: `${outreachLimits.defaultMinDelayMinutes} min` },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 600, letterSpacing: 0.3 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 2 }}>{value}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#9ca3af' }}>No limits configured — click Edit to set org-wide defaults.</div>
            )}
          </div>

          <div style={{ marginTop: 8, padding: 16, background: '#fffbeb', borderRadius: 8, border: '1px solid #fde68a', fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
            <strong>How org integrations work:</strong><br />
            Enabling an integration here allows members to connect their personal accounts.
            Each member still authorises individually via Settings → Integrations — you are not
            granting access to a shared mailbox. This switch controls whether the option is <em>available</em> to your team.
          </div>
        </div>
      )}

      {/* ── Meeting & Transcripts tab ──────────────────────────────── */}
      {subTab === 'meeting' && <OAMeetingSettings orgId={orgId} />}
    </div>
  );
}
