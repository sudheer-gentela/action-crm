/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OADuplicateSettings. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

export default function OADuplicateSettings() {
  const [config, setConfig]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const flash = (type, msg) => {
    if (type === 'success') { setSuccess(msg); setError(''); }
    else                    { setError(msg);   setSuccess(''); }
    setTimeout(() => { setSuccess(''); setError(''); }, 4000);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await apiService.orgAdmin.getDuplicateSettings();
        setConfig(res.data.duplicate_detection);
      } catch (e) {
        setError('Failed to load settings');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleToggle = async (key, value) => {
    setSaving(true);
    try {
      const res = await apiService.orgAdmin.updateDuplicateSettings({ [key]: value });
      setConfig(prev => ({ ...prev, ...res.data.duplicate_detection }));
      flash('success', 'Setting saved ✓');
    } catch (e) {
      flash('error', e.response?.data?.error?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading duplicate settings…</div>;

  const sectionStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    padding: '20px 24px', marginBottom: 16,
  };
  const headingStyle = { fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 12 };
  const rowStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 0', borderBottom: '1px solid #f3f4f6',
  };
  const labelStyle = { fontSize: 13, fontWeight: 500, color: '#374151' };
  const descStyle = { fontSize: 12, color: '#9ca3af', marginTop: 2 };
  const toggleStyle = (on) => ({
    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: saving ? 'wait' : 'pointer',
    background: on ? '#4f46e5' : '#d1d5db', position: 'relative', transition: 'background 0.2s',
  });
  const dotStyle = (on) => ({
    width: 18, height: 18, borderRadius: '50%', background: '#fff',
    position: 'absolute', top: 3, left: on ? 23 : 3, transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  });
  const selectStyle = {
    padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13,
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 0' }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: '#111827' }}>🔍 Duplicate Detection</h2>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>Configure which rules detect duplicates and who can see them.</p>

      {error   && <div className="sv-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
      {success && <div className="sv-success" style={{ marginBottom: 12 }}>{success}</div>}

      {/* ── Contact Duplicate Rules ─────────────────── */}
      <div style={sectionStyle}>
        <div style={headingStyle}>👤 Contact Duplicate Rules</div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Email match</div>
            <div style={descStyle}>Flag contacts with the same email address as duplicates</div>
          </div>
          <button style={toggleStyle(config?.contact_email_match)} disabled={saving}
            onClick={() => handleToggle('contact_email_match', !config?.contact_email_match)}>
            <div style={dotStyle(config?.contact_email_match)} />
          </button>
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Name + Account match</div>
            <div style={descStyle}>Flag contacts with the same first name, last name, and account</div>
          </div>
          <button style={toggleStyle(config?.contact_name_account_match)} disabled={saving}
            onClick={() => handleToggle('contact_name_account_match', !config?.contact_name_account_match)}>
            <div style={dotStyle(config?.contact_name_account_match)} />
          </button>
        </div>

        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <div>
            <div style={labelStyle}>Who can see contact duplicates?</div>
            <div style={descStyle}>
              {config?.contact_visibility === 'org'
                ? 'All members see duplicates across the entire org (default)'
                : 'Members only see duplicates within their own contacts'}
            </div>
          </div>
          <select style={selectStyle} value={config?.contact_visibility || 'org'} disabled={saving}
            onChange={e => handleToggle('contact_visibility', e.target.value)}>
            <option value="org">Entire org (default)</option>
            <option value="own">Own contacts only</option>
          </select>
        </div>
      </div>

      {/* ── Account Duplicate Rules ─────────────────── */}
      <div style={sectionStyle}>
        <div style={headingStyle}>🏢 Account Duplicate Rules</div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Domain match</div>
            <div style={descStyle}>Flag accounts with the same website domain as duplicates</div>
          </div>
          <button style={toggleStyle(config?.account_domain_match)} disabled={saving}
            onClick={() => handleToggle('account_domain_match', !config?.account_domain_match)}>
            <div style={dotStyle(config?.account_domain_match)} />
          </button>
        </div>

        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Name match</div>
            <div style={descStyle}>Flag accounts with the same name (case-insensitive)</div>
          </div>
          <button style={toggleStyle(config?.account_name_match)} disabled={saving}
            onClick={() => handleToggle('account_name_match', !config?.account_name_match)}>
            <div style={dotStyle(config?.account_name_match)} />
          </button>
        </div>

        <div style={{ ...rowStyle, borderBottom: 'none' }}>
          <div>
            <div style={labelStyle}>Who can see account duplicates?</div>
            <div style={descStyle}>
              {config?.account_visibility === 'org'
                ? 'All members see duplicates across the entire org (default)'
                : 'Members only see duplicates within their own accounts'}
            </div>
          </div>
          <select style={selectStyle} value={config?.account_visibility || 'org'} disabled={saving}
            onChange={e => handleToggle('account_visibility', e.target.value)}>
            <option value="org">Entire org (default)</option>
            <option value="own">Own accounts only</option>
          </select>
        </div>
      </div>
    </div>
  );
}
