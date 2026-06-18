/* Extracted from OrgAdminView.js — Phase 4 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAHubSpotSettings. */
import React from 'react';
import HubSpotConnect from '../../HubSpotConnect';

export default function OAHubSpotSettings() {
  return (
    <div className="oa-panel">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>
          🟠 HubSpot Integration
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
          Connect your HubSpot portal to sync companies, contacts, and deals.
          Records sync nightly at 04:00 UTC. Stage and field mapping is configurable per org.
        </p>
      </div>
      <HubSpotConnect />
    </div>
  );
}
