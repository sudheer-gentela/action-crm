/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAServiceModule. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';
import { ModuleSubTabs, OAModuleSeedPanel } from '../shared';
import OAServiceGeneral from './OAServiceGeneral';
import OAServiceSLATiers from './OAServiceSLATiers';

export default function OAServiceModule() {
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
        setEnabled(profileRes.data.org?.settings?.modules?.service || false);
        setSeedDone(!!seedRes?.status?.service);
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    const handler = (e) => {
      if (e.detail.module === 'service') {
        setEnabled(e.detail.enabled);
        if (!e.detail.enabled) setSubTab('general');
      }
    };
    window.addEventListener('moduleToggle', handler);
    return () => window.removeEventListener('moduleToggle', handler);
  }, []); // eslint-disable-line

  const handleSeedService = async () => {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST', headers,
        body: JSON.stringify({ module: 'service' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      setSeedDone(true);
      setSeedMsg(data.seeded ? 'GoWarm Service sample playbook seeded ✓' : data.message);
      setTimeout(() => setSeedMsg(''), 4000);
    } catch (e) {
      setSeedMsg('Error: ' + (e.message || 'Failed to seed'));
    } finally {
      setSeeding(false);
    }
  };

  const tabs = [
    ['general', 'General'],
    ...(enabled ? [['sla', 'SLA Settings'], ['playbook', 'Playbook']] : []),
  ];

  if (loading) return <div className="sv-loading">Loading…</div>;

  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🎧 Customer Support &amp; Service</h2>
          <p className="sv-panel-desc">Full case management with SLA tracking, playbook-driven workflows, and team assignment.</p>
        </div>
      </div>
      <ModuleSubTabs tabs={tabs} active={subTab} onChange={setSubTab} />
      {subTab === 'general'  && <OAServiceGeneral />}
      {subTab === 'sla'      && enabled && <OAServiceSLATiers />}
      {subTab === 'playbook' && enabled && (
        <OAModuleSeedPanel
          seedDone={seedDone}
          seeding={seeding}
          seedMsg={seedMsg}
          onSeed={handleSeedService}
          color="#0891b2"
          playbookName="GoWarm Service Playbook"
          playbookDesc="16 plays across 5 stages: Open → In Progress → Pending Customer → Resolved → Closed."
        />
      )}
    </div>
  );
}
