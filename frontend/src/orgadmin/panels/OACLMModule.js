/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OACLMModule. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';
import { ModuleSubTabs, OAModuleGeneral, OAModuleSeedPanel } from '../shared';
import OACLMESignConfig from './OACLMESignConfig';
import OACLMTemplates from './OACLMTemplates';

export default function OACLMModule() {
  const API    = process.env.REACT_APP_API_URL;
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const [enabled, setEnabled]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [subTab, setSubTab]     = useState('general');
  const [seedDone, setSeedDone] = useState(false);
  const [seeding, setSeeding]   = useState(false);
  const [seedMsg, setSeedMsg]   = useState('');

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getProfile(),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
    ])
      .then(([profileRes, seedRes]) => {
        setEnabled(profileRes.data.org?.settings?.modules?.contracts || false);
        setSeedDone(!!seedRes?.status?.clm);
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    const handler = (e) => {
      if (e.detail.module === 'contracts') {
        setEnabled(e.detail.enabled);
        if (!e.detail.enabled) setSubTab('general');
      }
    };
    window.addEventListener('moduleToggle', handler);
    return () => window.removeEventListener('moduleToggle', handler);
  }, []); // eslint-disable-line

  const handleSeedCLM = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'clm' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm CLM sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  const tabs = [
    ['general', 'General'],
    ...(enabled ? [['esign', 'eSign Configuration'], ['templates', 'CLM Templates'], ['playbook', 'Playbook']] : []),
  ];

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>📄 Contract Lifecycle Management</h2>
          <p className="sv-panel-desc">Full CLM workflow — contracts, legal review, approval chains, e-signatures, and document versioning.</p>
        </div>
      </div>
      <ModuleSubTabs tabs={tabs} active={subTab} onChange={setSubTab} />
      {subTab === 'general' && (
        <OAModuleGeneral
          moduleKey="contracts"
          icon="📄"
          label="Contract Lifecycle Management"
          desc="Enables the full CLM workflow for your organisation — contract creation, legal review queues, approval chains, e-signature tracking, and document versioning."
          toggleFn={(enabled) => apiService.contracts.toggleModule(enabled)}
        />
      )}
      {subTab === 'esign'     && enabled && <OACLMESignConfig />}
      {subTab === 'templates' && enabled && <OACLMTemplates />}
      {subTab === 'playbook'  && enabled && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedCLM}
          color="#6366f1"
          playbookName="GoWarm CLM Playbook"
          playbookDesc="40 plays across 9 stages: Draft → In Review (Legal/Sales/Customer) → In Signatures → Active → Voided / Terminated / Expired."
        />
      )}
    </div>
  );
}
