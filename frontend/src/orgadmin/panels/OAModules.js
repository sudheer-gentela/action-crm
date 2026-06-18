/* Extracted from OrgAdminView.js — Phase 3 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAModules. */
import React, { useState, useEffect } from 'react';
import { apiService } from '../../apiService';

export default function OAModules() {
  // modules state holds { allowed: bool, enabled: bool } per key
  const [modules, setModules] = useState({
    contracts:   { allowed: false, enabled: false },
    prospecting: { allowed: false, enabled: false },
    handovers:   { allowed: false, enabled: false },
    service:     { allowed: false, enabled: false },
    agency:      { allowed: false, enabled: false },
  });
  // seedStatus holds { prospecting, sales, clm, service, handovers } booleans
  const [seedStatus, setSeedStatus] = useState({});
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(null);   // module key being toggled
  const [seeding, setSeeding]       = useState(null);   // module key being seeded
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');

  const API    = process.env.REACT_APP_API_URL || '';
  const token  = localStorage.getItem('token') || localStorage.getItem('authToken');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  useEffect(() => {
    Promise.all([
      apiService.orgAdmin.getProfile(),
      fetch(`${API}/org/admin/seed-status`, { headers }).then(r => r.json()),
    ])
      .then(([profileRes, seedRes]) => {
        const normalised = profileRes.data.modules;
        if (normalised) {
          setModules({
            contracts:   normalised.contracts   || { allowed: false, enabled: false },
            prospecting: normalised.prospecting || { allowed: false, enabled: false },
            handovers:   normalised.handovers   || { allowed: false, enabled: false },
            service:     normalised.service     || { allowed: false, enabled: false },
            agency:      normalised.agency      || { allowed: false, enabled: false },
          });
        } else {
          const mods = profileRes.data.org?.settings?.modules || {};
          const toLegacy = (v) => { const b = v === true || v === 'true'; return { allowed: b, enabled: b }; };
          setModules({
            contracts:   toLegacy(mods.contracts),
            prospecting: toLegacy(mods.prospecting),
            handovers:   toLegacy(mods.handovers),
            service:     toLegacy(mods.service),
            agency:      toLegacy(mods.agency),
          });
        }
        setSeedStatus(seedRes.status || {});
      })
      .catch(() => setError('Failed to load module settings'))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  const MODULE_TOGGLE_API = {
    contracts:   (enabled) => apiService.contracts.toggleModule(enabled),
    prospecting: (enabled) => apiService.prospects.toggleModule(enabled),
    handovers:   (enabled) => apiService.handovers.toggleModule(enabled),
    service:     (enabled) => apiService.support.toggleModule(enabled),
    agency:      (enabled) => apiService.agency.toggleModule(enabled),
  };

  // Maps module key → the playbook seed key used by the backend
  const MODULE_SEED_KEY = {
    prospecting: 'prospecting',
    contracts:   'clm',
    handovers:   'handovers',
    service:     'service',
    agency:      null, // no sample playbook for agency
  };

  const handleToggle = async (moduleName, newEnabled) => {
    setSaving(moduleName);
    setError('');
    try {
      await MODULE_TOGGLE_API[moduleName](newEnabled);
      setModules(prev => ({
        ...prev,
        [moduleName]: { ...prev[moduleName], enabled: newEnabled },
      }));
      const label = MODULE_DEFS.find(m => m.key === moduleName)?.label || moduleName;
      setSuccess(`${label} module ${newEnabled ? 'enabled' : 'disabled'} ✓`);
      setTimeout(() => setSuccess(''), 3000);
      window.dispatchEvent(new CustomEvent('moduleToggle', { detail: { module: moduleName, enabled: newEnabled } }));
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message || 'Failed to update module';
      setError(msg);
    } finally {
      setSaving(null);
    }
  };

  const handleSeed = async (moduleName) => {
    const seedKey = MODULE_SEED_KEY[moduleName];
    if (!seedKey) return;
    setSeeding(moduleName);
    setError('');
    try {
      const r = await fetch(`${API}/org/admin/seed-module`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ module: seedKey }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Seed failed');
      if (data.seeded) {
        setSeedStatus(prev => ({ ...prev, [seedKey]: true }));
        setSuccess(`GoWarm sample playbook seeded for ${MODULE_DEFS.find(m => m.key === moduleName)?.label || moduleName} ✓`);
        setTimeout(() => setSuccess(''), 4000);
      } else {
        setSuccess(data.message || 'Already seeded.');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (e) {
      setError(e.message || 'Failed to seed playbook');
    } finally {
      setSeeding(null);
    }
  };

  // MODULE_DEFS is unchanged from original — copy it from the existing OAModules
  const MODULE_DEFS = [
    {
      key: 'prospecting',
      icon: '🎯',
      label: 'Prospecting',
      desc: 'Full prospecting pipeline — manage prospect lists, track outreach stages, ICP scoring, coverage scorecards, and prospecting playbooks.',
      features: [
        'Prospect pipeline with customisable stages',
        'ICP scoring and fit analysis',
        'Outreach sequencing and action tracking',
        'Account coverage scorecards against playbooks',
        'Prospect-to-deal conversion workflow',
        'Prospecting playbooks with stage guidance',
      ],
      color: '#0F9D8E',
    },
    {
      key: 'contracts',
      icon: '📄',
      label: 'Contract Lifecycle Management',
      desc: 'Full CLM workflow — create contracts, legal review queue, approval chains, e-signature tracking, document versioning, and automated expiry notifications.',
      features: [
        'NDA, MSA, SOW, Order Form, Amendment support',
        'Legal team review queue and assignment',
        'Internal approval chains (by role, value, type)',
        'Document version history with major/minor tracking',
        'Signatory management and signature tracking',
        'Deal-linked contracts visible in deal detail view',
        'Automated expiry and unsigned follow-up notifications',
      ],
      color: '#6366f1',
    },
    {
      key: 'handovers',
      icon: '🤝',
      label: 'Sales → Implementation Handover',
      desc: 'Structured handover workflow when a deal closes — ensures sales captures everything the implementation team needs before handing off.',
      features: [
        'Handover automatically created when a deal is marked Closed Won',
        'Play-driven checklist with gate enforcement before submission',
        'Customer stakeholder mapping with implementation roles',
        'Commitments, promises, risks, and red flags log',
        'Commercial terms summary and go-live date tracking',
        'Service owner assignment and acknowledgement workflow',
        'Implementation notes visible to the service team',
      ],
      color: '#0369a1',
    },
    {
      key: 'service',
      icon: '🎧',
      label: 'Customer Support & Service',
      desc: 'Full case management — log, track, and resolve customer support cases with SLA tracking, playbook-driven workflows, and team assignment.',
      features: [
        'Case creation with priority and source tracking',
        'SLA tiers — response and resolution target hours',
        'SLA breach detection and dashboard alerts',
        'Status workflow: Open → In Progress → Pending Customer → Resolved → Closed',
        'Playbook-driven plays fired on case creation and status change',
        'Team and individual assignment with activity log',
        'Internal notes and customer-facing comments',
      ],
      color: '#0891b2',
    },
    {
      key: 'agency',
      icon: '🏢',
      label: 'Agency Client Management',
      desc: 'Manage client accounts on behalf of your customers — dedicated portals, team assignment, outreach tracking, and client-scoped dashboards.',
      features: [
        'Client records linked to existing accounts',
        'Team assignment — assign internal users as client leads or members',
        'Prospect, account, and sequence scoping per client',
        'Client portal with magic-link access for external stakeholders',
        'Client-branded sender accounts for outreach sequences',
        'Per-client outreach dashboard and reply tracking',
      ],
      color: '#7c3aed',
    },
  ];

  // Render — same outer structure as original, but with locked state for disallowed modules
  return (
    <div className="sv-panel">
      <div className="sv-panel-header">
        <div>
          <h2>🧩 Modules</h2>
          <p className="sv-panel-desc">
            Enable or disable product modules for your organisation.
            Modules must be provisioned by the platform before they can be activated.
          </p>
        </div>
      </div>

      {error   && <div className="sv-error">⚠️ {error}</div>}
      {success && <div className="sv-success">{success}</div>}

      {loading ? (
        <div className="sv-loading">Loading modules…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {MODULE_DEFS.map(mod => {
            const state     = modules[mod.key] || { allowed: false, enabled: false };
            const isAllowed = state.allowed;
            const isEnabled = state.enabled;
            const isSaving  = saving === mod.key;
            const isLocked  = !isAllowed;

            return (
              <div
                key={mod.key}
                style={{
                  border: `1px solid ${isLocked ? '#e5e7eb' : isEnabled ? mod.color + '40' : '#e5e7eb'}`,
                  borderRadius: 12,
                  padding: '18px 20px',
                  background: isLocked ? '#fafafa' : isEnabled ? mod.color + '08' : '#fff',
                  opacity: isLocked ? 0.65 : 1,
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  {/* Icon */}
                  <div style={{ fontSize: 28, marginTop: 2, flexShrink: 0 }}>{mod.icon}</div>

                  {/* Content */}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{mod.label}</div>
                      {/* Status chip */}
                      {isLocked ? (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: '#f3f4f6', color: '#9ca3af',
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          🔒 Not included in plan
                        </span>
                      ) : isEnabled ? (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: mod.color + '20', color: mod.color,
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          Active
                        </span>
                      ) : (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                          background: '#f3f4f6', color: '#9ca3af',
                          textTransform: 'uppercase', letterSpacing: 0.4,
                        }}>
                          Available — not active
                        </span>
                      )}
                    </div>

                    <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px', lineHeight: 1.5 }}>
                      {isLocked
                        ? 'This module is not included in your current plan. Contact support to upgrade.'
                        : mod.desc
                      }
                    </p>

                    {/* Feature list — only show when not locked */}
                    {!isLocked && mod.features && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {mod.features.map(f => (
                          <span key={f} style={{
                            fontSize: 11, padding: '2px 8px', borderRadius: 20,
                            background: '#f3f4f6', color: '#374151',
                          }}>
                            ✓ {f}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* GoWarm sample playbook seed button — only when enabled and seed key exists */}
                    {!isLocked && isEnabled && MODULE_SEED_KEY[mod.key] && (() => {
                      const sk      = MODULE_SEED_KEY[mod.key];
                      const seeded  = !!seedStatus[sk];
                      const isBusy  = seeding === mod.key;
                      return (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <button
                            disabled={seeded || isBusy}
                            onClick={() => !seeded && !isBusy && handleSeed(mod.key)}
                            title={seeded ? 'Sample playbook already seeded' : 'Seed the GoWarm sample playbook for this module'}
                            style={{
                              padding: '6px 14px',
                              borderRadius: 7,
                              border: `1px solid ${seeded ? '#d1d5db' : mod.color}`,
                              background: seeded ? '#f9fafb' : mod.color + '15',
                              color: seeded ? '#9ca3af' : mod.color,
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: seeded || isBusy ? 'not-allowed' : 'pointer',
                              opacity: isBusy ? 0.7 : 1,
                              transition: 'all 0.15s',
                            }}
                          >
                            {isBusy ? '⏳ Seeding…' : seeded ? '✓ Sample Playbook Seeded' : '🌱 Seed GoWarm Sample Playbook'}
                          </button>
                          {!seeded && (
                            <span style={{ fontSize: 11, color: '#9ca3af' }}>
                              One-time — loads all v2 plays and stages for this module
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Toggle — disabled for locked modules */}
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <button
                      disabled={isLocked || isSaving}
                      onClick={() => !isLocked && handleToggle(mod.key, !isEnabled)}
                      title={
                        isLocked
                          ? 'Not included in your plan — contact support'
                          : isEnabled ? 'Disable module' : 'Enable module'
                      }
                      style={{
                        position: 'relative', width: 46, height: 26, borderRadius: 13,
                        border: 'none',
                        background: isLocked ? '#e5e7eb' : isEnabled ? mod.color : '#d1d5db',
                        cursor: isLocked || isSaving ? 'not-allowed' : 'pointer',
                        opacity: isSaving ? 0.7 : 1,
                        transition: 'background 0.2s',
                      }}
                    >
                      <span style={{
                        position: 'absolute', top: 4,
                        left: (!isLocked && isEnabled) ? 23 : 4,
                        width: 18, height: 18, borderRadius: '50%',
                        background: isLocked ? '#9ca3af' : '#fff',
                        transition: 'left 0.2s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }} />
                    </button>
                    <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>
                      {isSaving ? '…' : isEnabled ? 'On' : 'Off'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
