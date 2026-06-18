/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAHandoverModule. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';
import { ModuleSubTabs, OAModuleGeneral, OAModuleSeedPanel } from '../shared';

export default function OAHandoverModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [subTab, setSubTab]     = useState('general');
  const [seedDone, setSeedDone] = useState(false);
  const [seeding, setSeeding]   = useState(false);
  const [seedMsg, setSeedMsg]   = useState('');

  useEffect(() => {
    fetch(`${API}/org/admin/seed-status`, { headers })
      .then(r => r.json())
      .then(data => setSeedDone(!!data?.status?.handovers))
      .catch(() => {});
  }, []); // eslint-disable-line

  const handleSeedHandovers = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'handovers' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm Handover sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🤝 Sales → Implementation Handover</h2>
          <p className="sv-panel-desc">Structured handover workflow when a deal closes — ensures sales captures everything the implementation team needs.</p>
        </div>
      </div>
      <ModuleSubTabs
        tabs={[['general', 'General'], ['playbook', 'Playbook']]}
        active={subTab}
        onChange={setSubTab}
      />
      {subTab === 'general' && (
        <OAModuleGeneral
          moduleKey="handovers"
          icon="🤝"
          label="Sales → Implementation Handover"
          desc="Automatically creates a handover checklist when a deal closes. Ensures the implementation team receives everything they need before the handoff."
          toggleFn={(enabled) => apiService.handovers.toggleModule(enabled)}
        />
      )}
      {subTab === 'playbook' && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedHandovers}
          color="#0369a1"
          playbookName="GoWarm Handover Playbook"
          playbookDesc="15 plays across 5 stages: Assign Service Owner → Document Stakeholders → Record Commitments & Risks → Confirm Go-Live & Commercial → Attach Docs & Sign-off."
        />
      )}
    </div>
  );
}
