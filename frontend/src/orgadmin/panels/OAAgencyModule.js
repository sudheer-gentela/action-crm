/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAAgencyModule. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

export default function OAAgencyModule() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiService.orgAdmin.getProfile()
      .then(r => setEnabled(r.data.org?.settings?.modules?.agency || false))
      .catch(console.error)
      .finally(() => setLoading(false));

    const handler = (e) => {
      if (e.detail.module === 'agency') setEnabled(e.detail.enabled);
    };
    window.addEventListener('moduleToggle', handler);
    return () => window.removeEventListener('moduleToggle', handler);
  }, []);

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🏢 Agency Client Management</h2>
          <p className="sv-panel-desc">
            Manage client accounts on behalf of your customers — dedicated portals, team assignment,
            outreach tracking, and client-scoped dashboards.
          </p>
        </div>
      </div>

      {!enabled && (
        <div style={{ padding: '20px 0', color: '#6b7280', fontSize: 13 }}>
          This module is currently disabled. Enable it from the{' '}
          <strong>Modules</strong> tab to access agency settings.
        </div>
      )}

      {enabled && (
        <div style={{ marginTop: 8 }}>
          <div style={{
            background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
            padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#166534',
          }}>
            ✅ Agency module is enabled. Create and manage clients from the Agency tab in the main navigation.
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '18px 20px' }}>
            <h4 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: '#111827' }}>Portal Configuration</h4>
            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
              Client portal invites are sent via magic link. Each link is one-time use and expires after 7 days.
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>
              To wire up email delivery for portal invites, configure{' '}
              <code style={{ fontSize: 12, background: '#f3f4f6', padding: '1px 5px', borderRadius: 4 }}>
                backend/services/portalEmailService.js
              </code>{' '}
              with your email provider.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
