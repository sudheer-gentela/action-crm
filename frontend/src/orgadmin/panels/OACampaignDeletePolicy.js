/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OACampaignDeletePolicy. */
import React, { useState, useEffect } from 'react';
import { ToggleSwitch } from '../shared';

export default function OACampaignDeletePolicy() {
  const API     = process.env.REACT_APP_API_URL || '';
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/prospecting-campaigns/org/delete-policy`, { headers })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then(d => setEnabled(d?.enabled !== false))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleToggle = async () => {
    const next = !enabled;
    setEnabled(next);          // optimistic
    setSaving(true);
    try {
      const r = await fetch(`${API}/prospecting-campaigns/org/delete-policy`, {
        method: 'PUT', headers, body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Save failed');
      setEnabled(d?.enabled !== false);
      showFlash('success', 'Campaign-delete policy saved ✓');
    } catch (err) {
      setEnabled(!next);       // revert on failure
      showFlash('error', err.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sv-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, justifyContent: 'space-between' }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ marginBottom: 4 }}>Campaign deletion by owners</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#718096', lineHeight: 1.5, maxWidth: 560 }}>
            When on, a campaign’s owner can delete their own campaign (along with its
            prospects), unless that specific campaign has been locked against deletion.
            When off, only admins can delete campaigns. Admins are never restricted by
            this switch.
          </p>
        </div>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          {loading
            ? <span style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</span>
            : <ToggleSwitch on={enabled} onChange={saving ? () => {} : handleToggle} color="#E8630A" />}
        </div>
      </div>
      {flash && (
        <div style={{
          marginTop: 10, fontSize: 12,
          color: flash.type === 'error' ? '#b91c1c' : '#15803d',
        }}>
          {flash.msg}
        </div>
      )}
    </div>
  );
}
