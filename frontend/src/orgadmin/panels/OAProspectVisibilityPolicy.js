/* Org-admin toggle for the prospect cross-owner visibility policy.
 * Reads/writes GET|PUT /prospecting-campaigns/org/prospect-visibility-policy,
 * persisted in org_action_config.campaign_settings.restrict_prospect_view_to_scope.
 * Mirrors OAManagerEditPolicy. Panel: OAProspectVisibilityPolicy. */
import React, { useState, useEffect } from 'react';
import { ToggleSwitch } from '../shared';

export default function OAProspectVisibilityPolicy() {
  const API     = process.env.REACT_APP_API_URL || '';
  const token   = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  useEffect(() => {
    fetch(`${API}/prospecting-campaigns/org/prospect-visibility-policy`, { headers })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then(d => setEnabled(d?.enabled === true))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const handleToggle = async () => {
    const next = !enabled;
    setEnabled(next);          // optimistic
    setSaving(true);
    try {
      const r = await fetch(`${API}/prospecting-campaigns/org/prospect-visibility-policy`, {
        method: 'PUT', headers, body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || 'Save failed');
      setEnabled(d?.enabled === true);
      showFlash('success', 'Prospect-visibility policy saved ✓');
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
          <h3 style={{ marginBottom: 4 }}>Restrict prospects to their owner’s team</h3>
          <p style={{ margin: 0, fontSize: 13, color: '#718096', lineHeight: 1.5, maxWidth: 560 }}>
            When off (default), anyone in the org can open any prospect’s detail —
            the owner is always shown. When on, a rep can open the full detail only
            for prospects whose owner is on their team (their own, plus their
            reports for a manager; admins see all). Other prospects show only that
            they’re owned by another rep in the org. The creator of a prospect is
            recorded separately and never changes when ownership is reassigned.
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
