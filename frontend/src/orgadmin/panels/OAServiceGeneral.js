/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAServiceGeneral. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

export default function OAServiceGeneral() {
  const [enabled, setEnabled] = useState(false);
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => {
        const s = r.data.org?.settings || {};
        setEnabled(s.modules?.service || false);
      })
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false));

    // Load case stats if module is on
    apiService.support?.getDashboard?.('all')
      .then(d => setStats(d?.stats || null))
      .catch(() => {});
  }, []);

  const handleToggle = async (newVal) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await apiService.support.toggleModule(newVal);
      setEnabled(newVal);
      setSuccess(`Service module ${newVal ? 'enabled' : 'disabled'} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      window.dispatchEvent(new CustomEvent('moduleToggle', { detail: { module: 'service', enabled: newVal } }));
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {/* Enable / disable toggle */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>Enable Service Module</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 3 }}>
            When enabled, agents can create and manage support cases from the 🎧 Service tab. Default SLA tiers are created automatically on first enable.
          </div>
        </div>
        <div
          onClick={() => !saving && handleToggle(!enabled)}
          style={{
            flexShrink: 0, width: 44, height: 24, borderRadius: 12,
            background: enabled ? '#6366f1' : '#d1d5db',
            position: 'relative', cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'background .2s', opacity: saving ? 0.7 : 1,
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: '50%', background: '#fff',
            position: 'absolute', top: 3,
            left: enabled ? 23 : 3,
            transition: 'left .2s',
            boxShadow: '0 1px 3px rgba(0,0,0,.2)',
          }} />
        </div>
      </div>

      {/* Stats summary (only if enabled and data loaded) */}
      {enabled && stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {[
            { label: 'Total Open',          value: stats.totalOpen,          color: '#6366f1' },
            { label: 'Response Breaches',   value: stats.responseBreaches,   color: '#ef4444' },
            { label: 'Resolution Breaches', value: stats.resolutionBreaches, color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '14px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: s.value > 0 ? s.color : '#d1d5db', marginTop: 4 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {enabled && !stats && (
        <div style={{ padding: '14px 18px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 9, fontSize: 13, color: '#166534' }}>
          ✅ Service module is active. No open cases yet.
        </div>
      )}
    </div>
  );
}
