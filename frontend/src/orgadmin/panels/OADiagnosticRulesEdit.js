/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OADiagnosticRulesEdit. Includes co-located single-consumer constants/helpers. */
import React, { useState, useEffect } from 'react';

const DIAGNOSTIC_MODULE_DEFS = [
  {
    key: 'deals',
    label: 'Deals',
    icon: '💼',
    fields: [
      { key: 'stagnant_days_realtime', label: 'Stagnant days (real-time)',  unit: 'days',  hint: 'Days without stage change before real-time stagnant alert fires' },
      { key: 'stagnant_days_nightly',  label: 'Stagnant days (nightly)',    unit: 'days',  hint: 'Days without stage change before nightly sweep alert fires' },
      { key: 'close_imminent_days',    label: 'Close imminent window',      unit: 'days',  hint: 'Days until close date that triggers the final checklist alert' },
      { key: 'high_value_threshold',   label: 'High-value threshold',       unit: 'USD',   hint: 'Deal value above which the executive touchpoint rule fires' },
    ],
  },
  {
    key: 'cases',
    label: 'Cases',
    icon: '🎧',
    fields: [
      { key: 'stale_days',            label: 'Stale case days',            unit: 'days',  hint: 'Days without activity before stale alert fires (excludes pending_customer)' },
      { key: 'pending_too_long_days', label: 'Pending customer days',      unit: 'days',  hint: 'Days waiting on customer reply before follow-up alert fires' },
    ],
  },
  {
    key: 'handovers',
    label: 'Handovers',
    icon: '🤝',
    fields: [
      { key: 'no_kickoff_days', label: 'No kickoff days',    unit: 'days',  hint: 'Days after handover creation before no-kickoff alert fires' },
      { key: 'stalled_days',    label: 'Stalled days',       unit: 'days',  hint: 'Days without any update before stalled alert fires' },
    ],
  },
  {
    key: 'prospecting',
    label: 'Prospecting',
    icon: '🎯',
    fields: [
      { key: 'stale_days',                      label: 'Stale outreach days',         unit: 'days',  hint: 'Days since last outreach before stale alert fires' },
      { key: 'ghosting_days',                   label: 'Ghosting days',               unit: 'days',  hint: 'Days since last outreach (3+ attempts, 0 replies) before ghosting alert fires' },
      { key: 'hot_lead_response_days',          label: 'Hot lead response window',    unit: 'days',  hint: 'Max days since last response to be considered a hot lead' },
      { key: 'low_icp_threshold',               label: 'Low ICP threshold',           unit: 'score', hint: 'ICP score (0–100) below which the low fit alert fires' },
      { key: 'wrong_channel_min_attempts',      label: 'Wrong channel min attempts',  unit: 'count', hint: 'Minimum outreach attempts before wrong channel alert fires' },
      { key: 'wrong_channel_max_response_rate', label: 'Wrong channel max response',  unit: '%',     hint: 'Response rate below which wrong channel alert fires (e.g. 10 = 10%)' },
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    icon: '🏢',
    fields: [
      { key: 'stale_days',              label: 'Stale account days',        unit: 'days',  hint: 'Days without email or deal activity before account gone dark alert fires' },
      { key: 'expansion_stalled_days',  label: 'Expansion stalled days',    unit: 'days',  hint: 'Days an open deal has had no updates before flagged as stalled' },
      { key: 'renewal_window_days',     label: 'Renewal window days',       unit: 'days',  hint: 'Days before deal close anniversary within which renewal risk alert fires' },
      { key: 'whitespace_min_roles',    label: 'Whitespace min roles',      unit: 'count', hint: 'Minimum distinct contact role types below which whitespace alert fires' },
      { key: 'whitespace_min_contacts', label: 'Whitespace min contacts',   unit: 'count', hint: 'Minimum contact count below which whitespace alert fires' },
    ],
  },
  {
    key: 'strap',
    label: 'STRAP',
    icon: '⚡',
    fields: [
      { key: 'min_age_hours', label: 'STRAP min age before re-validation', unit: 'hours', hint: 'Hours a STRAP must be active before nightly sweep re-validates it' },
    ],
  },
];

export default function OADiagnosticRulesEdit() {
  const API    = process.env.REACT_APP_API_URL || '';
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [defaults,   setDefaults]   = useState(null);
  const [customised, setCustomised] = useState({});
  const [drafts,     setDrafts]     = useState({});   // { module: { key: value } }
  const [saving,     setSaving]     = useState(null); // module key being saved
  const [expanded,   setExpanded]   = useState('deals');
  const [error,      setError]      = useState('');
  const [success,    setSuccess]    = useState('');
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    fetch(`${API}/org/admin/diagnostic-rules`, { headers })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => {
        setDefaults(data.defaults);
        setCustomised(data.customised || {});
        // Initialise drafts from current config
        const initial = {};
        for (const mod of DIAGNOSTIC_MODULE_DEFS) {
          initial[mod.key] = { ...(data.config[mod.key] || {}) };
          // Convert wrong_channel_max_response_rate to percentage for display
          if (mod.key === 'prospecting' && initial[mod.key].wrong_channel_max_response_rate !== undefined) {
            initial[mod.key].wrong_channel_max_response_rate =
              Math.round(initial[mod.key].wrong_channel_max_response_rate * 100);
          }
        }
        setDrafts(initial);
      })
      .catch(() => setError('Failed to load diagnostic rules'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleChange = (moduleKey, fieldKey, value) => {
    setDrafts(prev => ({
      ...prev,
      [moduleKey]: { ...prev[moduleKey], [fieldKey]: value === '' ? '' : Number(value) },
    }));
  };

  const handleSave = async (moduleKey) => {
    setSaving(moduleKey);
    setError('');
    setSuccess('');
    try {
      let updates = { ...drafts[moduleKey] };
      // Convert response rate from percentage back to ratio before saving
      if (moduleKey === 'prospecting' && updates.wrong_channel_max_response_rate !== undefined) {
        updates = {
          ...updates,
          wrong_channel_max_response_rate: updates.wrong_channel_max_response_rate / 100,
        };
      }
      const r = await fetch(`${API}/org/admin/diagnostic-rules`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ module: moduleKey, updates }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Save failed');
      // Reload customised map
      const cfgR = await fetch(`${API}/org/admin/diagnostic-rules`, { headers });
      const cfgData = await cfgR.json();
      setCustomised(cfgData.customised || {});
      setSuccess(`${DIAGNOSTIC_MODULE_DEFS.find(m => m.key === moduleKey)?.label} rules saved ✓`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  const handleReset = async (moduleKey) => {
    if (!defaults) return;
    // Reset drafts to defaults for this module
    const defaultVals = { ...defaults[moduleKey] };
    if (moduleKey === 'prospecting' && defaultVals.wrong_channel_max_response_rate !== undefined) {
      defaultVals.wrong_channel_max_response_rate =
        Math.round(defaultVals.wrong_channel_max_response_rate * 100);
    }
    setDrafts(prev => ({ ...prev, [moduleKey]: defaultVals }));
    // Save defaults to DB (effectively clears overrides)
    setSaving(moduleKey);
    setError('');
    try {
      const updates = { ...defaults[moduleKey] };
      const r = await fetch(`${API}/org/admin/diagnostic-rules`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ module: moduleKey, updates }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Reset failed');
      setSuccess(`${DIAGNOSTIC_MODULE_DEFS.find(m => m.key === moduleKey)?.label} rules reset to defaults ✓`);
      setTimeout(() => setSuccess(''), 3000);
      const cfgR = await fetch(`${API}/org/admin/diagnostic-rules`, { headers });
      const cfgData = await cfgR.json();
      setCustomised(cfgData.customised || {});
    } catch (e) {
      setError(e.message || 'Failed to reset');
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <div className="sv-loading">Loading diagnostic rules…</div>;

  return (
    <div style={{ paddingTop: 16 }}>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        Configure the thresholds that control when diagnostic alerts fire for each module.
        Changes take effect at the next nightly sweep or real-time event.
        Values shown in <strong style={{ color: '#1d4ed8' }}>blue</strong> have been customised from the system default.
      </p>

      {error   && <div className="sv-alert sv-alert--error"   style={{ marginBottom: 16 }}>⚠️ {error}</div>}
      {success && <div className="sv-alert sv-alert--success" style={{ marginBottom: 16 }}>✅ {success}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {DIAGNOSTIC_MODULE_DEFS.map(mod => {
          const isExpanded  = expanded === mod.key;
          const isSaving    = saving === mod.key;
          const modDraft    = drafts[mod.key] || {};
          const modCustom   = customised[mod.key] || {};
          const hasCustom   = Object.values(modCustom).some(Boolean);

          return (
            <div key={mod.key} style={{
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              overflow: 'hidden',
              background: '#fff',
            }}>
              {/* Section header */}
              <button
                onClick={() => setExpanded(isExpanded ? null : mod.key)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '14px 20px',
                  background: isExpanded ? '#f8fafc' : '#fff',
                  border: 'none', cursor: 'pointer',
                  borderBottom: isExpanded ? '1px solid #e5e7eb' : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18 }}>{mod.icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 15, color: '#1e293b' }}>{mod.label}</span>
                  {hasCustom && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 7px',
                      borderRadius: 10, background: '#dbeafe', color: '#1d4ed8',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                    }}>Customised</span>
                  )}
                </div>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</span>
              </button>

              {/* Section body */}
              {isExpanded && (
                <div style={{ padding: '20px 24px' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 20,
                    marginBottom: 20,
                  }}>
                    {mod.fields.map(field => {
                      const isCustom  = !!modCustom[field.key];
                      const currVal   = modDraft[field.key];
                      const defVal    = defaults?.[mod.key]?.[field.key];

                      return (
                        <div key={field.key}>
                          <label style={{
                            display: 'block',
                            fontSize: 12,
                            fontWeight: isCustom ? 700 : 600,
                            color: isCustom ? '#1d4ed8' : '#374151',
                            marginBottom: 4,
                          }}>
                            {field.label}
                            {isCustom && <span style={{ marginLeft: 6, fontSize: 10, color: '#3b82f6' }}>● customised</span>}
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              type="number"
                              min={0}
                              step={field.unit === '%' ? 1 : (field.unit === 'USD' ? 1000 : 1)}
                              value={currVal ?? ''}
                              onChange={e => handleChange(mod.key, field.key, e.target.value)}
                              style={{
                                width: 90, padding: '6px 10px',
                                border: `1px solid ${isCustom ? '#93c5fd' : '#d1d5db'}`,
                                borderRadius: 6, fontSize: 14,
                                background: isCustom ? '#eff6ff' : '#fff',
                                fontWeight: isCustom ? 600 : 400,
                              }}
                            />
                            <span style={{ fontSize: 12, color: '#6b7280' }}>{field.unit}</span>
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                            {field.hint}
                            {defVal !== undefined && (
                              <span style={{ marginLeft: 4, color: '#cbd5e1' }}>
                                (default: {field.unit === '%' ? Math.round(defVal * 100) : defVal})
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Save / Reset row */}
                  <div style={{ display: 'flex', gap: 10, paddingTop: 16, borderTop: '1px solid #f1f5f9' }}>
                    <button
                      onClick={() => handleSave(mod.key)}
                      disabled={isSaving}
                      style={{
                        padding: '8px 20px', borderRadius: 7,
                        background: '#1A3A5C', color: '#fff',
                        border: 'none', cursor: isSaving ? 'not-allowed' : 'pointer',
                        opacity: isSaving ? 0.6 : 1, fontSize: 13, fontWeight: 600,
                      }}
                    >
                      {isSaving ? 'Saving…' : `Save ${mod.label} Rules`}
                    </button>
                    {hasCustom && (
                      <button
                        onClick={() => handleReset(mod.key)}
                        disabled={isSaving}
                        style={{
                          padding: '8px 16px', borderRadius: 7,
                          background: '#fff', color: '#6b7280',
                          border: '1px solid #d1d5db',
                          cursor: isSaving ? 'not-allowed' : 'pointer',
                          fontSize: 13,
                        }}
                      >
                        Reset to defaults
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
