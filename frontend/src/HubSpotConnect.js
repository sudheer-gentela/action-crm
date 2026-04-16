/**
 * HubSpotConnect.js
 *
 * DROP-IN LOCATION: frontend/src/HubSpotConnect.js
 *
 * Org Admin settings panel for HubSpot integration.
 * Tabs:
 *   1. Connection   — connect / disconnect / status / manual sync trigger
 *   2. Stage Mapping — HubSpot deal stage → GoWarm stage keys
 *   3. Field Mapping — HubSpot property → GoWarm field mappings
 *
 * Reuses SalesforceConnect.css for all styling — no new CSS needed.
 */

import React, { useState, useEffect, useCallback } from 'react';
import './SalesforceConnect.css';
import { hubspotAPI } from './apiService';

// ── GoWarm stage options (same canonical keys as SF) ──────────────────────────
const GW_STAGE_OPTIONS = {
  deal: [
    { value: 'discovery',     label: 'Discovery' },
    { value: 'qualification', label: 'Qualification' },
    { value: 'demo',          label: 'Demo' },
    { value: 'proposal',      label: 'Proposal' },
    { value: 'negotiation',   label: 'Negotiation' },
    { value: 'closed_won',    label: 'Closed Won' },
    { value: 'closed_lost',   label: 'Closed Lost' },
  ],
  prospect: [
    { value: 'target',         label: 'Target' },
    { value: 'research',       label: 'Research' },
    { value: 'outreach',       label: 'Outreach' },
    { value: 'engaged',        label: 'Engaged' },
    { value: 'discovery_call', label: 'Discovery Call' },
    { value: 'qualified_sal',  label: 'Qualified (SAL)' },
    { value: 'converted',      label: 'Converted' },
    { value: 'disqualified',   label: 'Disqualified' },
  ],
};

// HubSpot object names — used in field mapping
const HS_OBJECTS = ['Company', 'Contact', 'Deal'];

const GW_ENTITY_OPTIONS = [
  { value: 'account',  label: 'Account',  hsObject: 'Company',  fields: ['name','domain','industry','size','location','description'] },
  { value: 'contact',  label: 'Contact',  hsObject: 'Contact',  fields: ['first_name','last_name','email','phone','title','location','linkedin_url'] },
  { value: 'deal',     label: 'Deal',     hsObject: 'Deal',     fields: ['name','value','stage','expected_close_date','probability','notes'] },
  { value: 'prospect', label: 'Prospect', hsObject: 'Contact',  fields: ['first_name','last_name','email','phone','title','company_name','company_domain','company_industry','source','icp_score'] },
];

const DIRECTION_OPTIONS = [
  { value: 'sf_to_gw', label: '← HubSpot → GoWarm only' },
  { value: 'gw_to_sf', label: '→ GoWarm → HubSpot only' },
  { value: 'both',     label: '↔ Both directions' },
];

// ── Main component ─────────────────────────────────────────────────────────────

export default function HubSpotConnect({ onConnectionChange }) {
  const [subTab,   setSubTab]   = useState('connection');
  const [status,   setStatus]   = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, settingsRes] = await Promise.all([
        hubspotAPI.getStatus(),
        hubspotAPI.getSettings(),
      ]);
      setStatus(statusRes.data);
      setSettings(settingsRes.data?.settings || {});
    } catch (e) {
      setError('Failed to load HubSpot settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.get('hubspot_connected') === 'true') {
      setSuccess('✅ HubSpot connected successfully!');
      load();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error') === 'hubspot_auth_failed') {
      const msg = params.get('message') || 'Authentication failed';
      setError(`HubSpot connection failed: ${msg}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [load]);

  const saveSetting = async (updates) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await hubspotAPI.updateSettings(updates);
      setSettings(prev => ({ ...prev, ...updates }));
      setSuccess('Settings saved ✓');
      setTimeout(() => setSuccess(''), 3000);
      if (onConnectionChange) onConnectionChange();
    } catch (e) {
      setError(e.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="sf-connect loading">Loading HubSpot settings…</div>;

  const isConnected = status?.connected;

  const SUB_TABS = [
    { id: 'connection', label: '🔌 Connection' },
    { id: 'stage-map',  label: '🗺 Stage Mapping',  disabled: !isConnected },
    { id: 'field-map',  label: '🔧 Field Mapping',  disabled: !isConnected },
  ];

  return (
    <div className="sf-connect">
      {/* Header */}
      <div className="sf-header">
        <div className="sf-icon">🟠</div>
        <div className="sf-header-info">
          <h3>HubSpot Integration</h3>
          {isConnected ? (
            <p className="sf-connected-badge">
              ✓ Connected — {status.email || status.instanceUrl}
            </p>
          ) : (
            <p className="sf-desc">
              Sync contacts, companies, deals, and leads between HubSpot and GoWarm.
            </p>
          )}
        </div>
      </div>

      {error   && <div className="sf-alert sf-alert--error">{error}<button onClick={() => setError('')}>✕</button></div>}
      {success && <div className="sf-alert sf-alert--success">{success}</div>}

      {/* Sub-tabs */}
      <div className="sf-tabs">
        {SUB_TABS.map(t => (
          <button
            key={t.id}
            className={`sf-tab ${subTab === t.id ? 'active' : ''} ${t.disabled ? 'disabled' : ''}`}
            onClick={() => !t.disabled && setSubTab(t.id)}
            disabled={t.disabled}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="sf-tab-content">
        {subTab === 'connection' && (
          <HSConnectionTab
            status={status}
            onConnect={load}
            onDisconnect={load}
            setError={setError}
            setSuccess={setSuccess}
            onConnectionChange={onConnectionChange}
          />
        )}
        {subTab === 'stage-map' && (
          <HSStageMappingTab settings={settings} onSave={saveSetting} saving={saving} />
        )}
        {subTab === 'field-map' && (
          <HSFieldMappingTab settings={settings} onSave={saveSetting} saving={saving} />
        )}
      </div>
    </div>
  );
}

// ── HSConnectionTab ────────────────────────────────────────────────────────────

function HSConnectionTab({ status, onConnect, onDisconnect, setError, setSuccess, onConnectionChange }) {
  const [syncing, setSyncing] = useState(false);

  const handleConnect = async () => {
    try {
      const res = await hubspotAPI.getAuthUrl();
      if (res.success && res.authUrl) window.location.href = res.authUrl;
      else throw new Error(res.error || 'Invalid response');
    } catch (e) {
      setError('Failed to start HubSpot connection. Check env vars are set.');
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect HubSpot? This will stop syncing but won\'t delete existing GoWarm records.')) return;
    try {
      await hubspotAPI.disconnect();
      setSuccess('HubSpot disconnected');
      onDisconnect();
      if (onConnectionChange) onConnectionChange();
    } catch (e) {
      setError('Failed to disconnect HubSpot');
    }
  };

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await hubspotAPI.triggerSync();
      setSuccess('Sync started — records will update within a few minutes');
    } catch (e) {
      setError(e.message || 'Failed to trigger sync');
    } finally {
      setSyncing(false);
    }
  };

  if (!status?.connected) {
    return (
      <div className="sf-section">
        <p className="sf-section-desc">
          Connect your HubSpot portal to sync companies, contacts, and deals.
          GoWarm will sync nightly at 04:00 UTC after the connection is made.
        </p>
        <div className="sf-prereqs">
          <div className="sf-prereq-title">Before connecting:</div>
          <ul>
            <li>Create a Public Legacy App in your HubSpot developer account</li>
            <li>Add scopes: <code>crm.objects.companies.read</code>, <code>crm.objects.contacts.read</code>, <code>crm.objects.deals.read</code>, <code>crm.objects.owners.read</code>, <code>crm.schemas.deals.read</code></li>
            <li>Set callback URL to your GoWarm backend + <code>/api/hubspot/callback</code></li>
            <li>Add env vars: <code>HUBSPOT_CLIENT_ID</code>, <code>HUBSPOT_CLIENT_SECRET</code>, <code>HUBSPOT_REDIRECT_URI</code></li>
          </ul>
        </div>
        <button className="sf-btn sf-btn--primary" onClick={handleConnect}>
          Connect HubSpot
        </button>
      </div>
    );
  }

  return (
    <div className="sf-section">
      <div className="sf-status-card">
        <div className="sf-status-row">
          <span className="sf-status-label">Portal</span>
          <span className="sf-status-value">{status.instanceUrl}</span>
        </div>
        <div className="sf-status-row">
          <span className="sf-status-label">Connected as</span>
          <span className="sf-status-value">{status.email || '—'}</span>
        </div>
        <div className="sf-status-row">
          <span className="sf-status-label">Hub ID</span>
          <span className="sf-status-value">{status.hubId || '—'}</span>
        </div>
        <div className="sf-status-row">
          <span className="sf-status-label">Connected at</span>
          <span className="sf-status-value">
            {status.connectedAt ? new Date(status.connectedAt).toLocaleString() : '—'}
          </span>
        </div>
        <div className="sf-status-row">
          <span className="sf-status-label">Last sync</span>
          <span className="sf-status-value">
            {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Never'}
            {status.syncStatus === 'running' && <span className="sf-badge sf-badge--running"> running…</span>}
            {status.syncStatus === 'error'   && <span className="sf-badge sf-badge--error"> error</span>}
          </span>
        </div>
        {status.lastSyncError && (
          <div className="sf-status-row sf-status-row--error">
            <span className="sf-status-label">Last error</span>
            <span className="sf-status-value sf-error-text">{status.lastSyncError}</span>
          </div>
        )}
      </div>

      <div className="sf-actions">
        <button
          className="sf-btn sf-btn--secondary"
          onClick={handleManualSync}
          disabled={syncing || status.syncStatus === 'running'}
        >
          {syncing ? 'Starting…' : '↻ Run Sync Now'}
        </button>
        <button className="sf-btn sf-btn--danger" onClick={handleDisconnect}>
          Disconnect HubSpot
        </button>
      </div>
    </div>
  );
}

// ── HSStageMappingTab ──────────────────────────────────────────────────────────

function HSStageMappingTab({ settings, onSave, saving }) {
  const [stageMap,           setStageMap]           = useState(settings?.stage_map || {});
  const [hsStages,           setHsStages]           = useState([]);
  const [hsStagesLoading,    setHsStagesLoading]    = useState(true);
  const [hsStagesError,      setHsStagesError]      = useState('');
  const [newHsStage,         setNewHsStage]         = useState('');
  const [newGwStage,         setNewGwStage]         = useState('');
  const [gwEntity,           setGwEntity]           = useState('deal');
  const [dirty,              setDirty]              = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHsStagesLoading(true);
    hubspotAPI.getStages()
      .then(res => { if (!cancelled) setHsStages(res.data || []); })
      .catch(() => {
        if (!cancelled) setHsStagesError('Could not load HubSpot stages — enter stage name manually.');
      })
      .finally(() => { if (!cancelled) setHsStagesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (settings?.stage_map && !dirty) setStageMap(settings.stage_map);
  }, [settings?.stage_map]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMapping = () => {
    const hsKey = newHsStage.trim();
    if (!hsKey || !newGwStage) return;
    setStageMap(prev => ({ ...prev, [hsKey]: newGwStage }));
    setNewHsStage(''); setNewGwStage(''); setDirty(true);
  };

  const removeMapping = (hsStage) => {
    setStageMap(prev => { const n = { ...prev }; delete n[hsStage]; return n; });
    setDirty(true);
  };

  const stageOptions   = GW_STAGE_OPTIONS[gwEntity] || GW_STAGE_OPTIONS.deal;
  const unmappedStages = hsStages.filter(s => !(s.value in stageMap));

  return (
    <div className="sf-section">
      <p className="sf-section-desc">
        Map HubSpot deal pipeline stages to GoWarm stages.
        Without a mapping, the deal stage won't sync.
      </p>

      <div className="sf-field-row" style={{ marginBottom: 16 }}>
        <label className="sf-label">GoWarm entity type</label>
        <select className="sf-select" value={gwEntity} onChange={e => setGwEntity(e.target.value)}>
          <option value="deal">Deal (from HubSpot Deal)</option>
          <option value="prospect">Prospect (from HubSpot Contact/Lead)</option>
        </select>
      </div>

      {/* Existing mappings */}
      {Object.keys(stageMap).length > 0 && (
        <div className="sf-map-table">
          <div className="sf-map-header">
            <span>HubSpot Stage</span><span>→</span><span>GoWarm Stage</span><span></span>
          </div>
          {Object.entries(stageMap).map(([hsStage, gwStage]) => (
            <div key={hsStage} className="sf-map-row">
              <span className="sf-map-cell sf-map-cell--sf">{hsStage}</span>
              <span className="sf-map-arrow">→</span>
              <span className="sf-map-cell sf-map-cell--gw">
                {stageOptions.find(s => s.value === gwStage)?.label || gwStage}
              </span>
              <button className="sf-map-remove" onClick={() => removeMapping(hsStage)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {Object.keys(stageMap).length === 0 && (
        <div className="sf-empty-state">No stage mappings yet. Add your first mapping below.</div>
      )}

      {/* Add new */}
      <div className="sf-add-mapping" style={{ marginTop: 16 }}>
        {hsStagesLoading ? (
          <div className="sf-input sf-input--loading">Loading HubSpot stages…</div>
        ) : hsStages.length > 0 ? (
          <select className="sf-select" value={newHsStage} onChange={e => setNewHsStage(e.target.value)}>
            <option value="">Select HubSpot stage…</option>
            {(unmappedStages.length > 0 ? unmappedStages : hsStages).map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        ) : (
          <>
            {hsStagesError && <div className="sf-inline-warn">{hsStagesError}</div>}
            <input
              className="sf-input"
              placeholder="HubSpot stage ID (e.g. appointmentscheduled)"
              value={newHsStage}
              onChange={e => setNewHsStage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addMapping()}
            />
          </>
        )}

        <span className="sf-map-arrow">→</span>

        <select className="sf-select" value={newGwStage} onChange={e => setNewGwStage(e.target.value)}>
          <option value="">Select GoWarm stage…</option>
          {stageOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        <button className="sf-btn sf-btn--ghost" onClick={addMapping} disabled={!newHsStage || !newGwStage}>
          Add
        </button>
      </div>

      {hsStages.length > 0 && (
        <div className="sf-stage-coverage">
          {Object.keys(stageMap).length} of {hsStages.length} HubSpot stage{hsStages.length !== 1 ? 's' : ''} mapped
          {Object.keys(stageMap).length < hsStages.length && (
            <span className="sf-stage-coverage--warn">
              {' '}— {hsStages.filter(s => !(s.value in stageMap)).map(s => s.label).join(', ')} {hsStages.length - Object.keys(stageMap).length === 1 ? 'is' : 'are'} unmapped
            </span>
          )}
        </div>
      )}

      <button
        className="sf-btn sf-btn--primary"
        style={{ marginTop: 16 }}
        onClick={() => { onSave({ stage_map: stageMap }); setDirty(false); }}
        disabled={saving || !dirty}
      >
        {saving ? 'Saving…' : 'Save Stage Map'}
      </button>
    </div>
  );
}

// ── HSFieldMappingTab ──────────────────────────────────────────────────────────

function HSFieldMappingTab({ settings, onSave, saving }) {
  const [fieldMap,      setFieldMap]      = useState(settings?.field_map || []);
  const [newMapping,    setNewMapping]    = useState({
    sf_object: 'Company', sf_field: '', gw_entity: 'account', gw_field: '', direction: 'sf_to_gw',
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings?.field_map && !dirty) setFieldMap(settings.field_map);
  }, [settings?.field_map]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMapping = () => {
    if (!newMapping.sf_field || !newMapping.gw_field) return;
    const exists = fieldMap.find(
      m => m.sf_object === newMapping.sf_object && m.sf_field === newMapping.sf_field
    );
    if (exists) return;
    setFieldMap(prev => [...prev, { ...newMapping }]);
    setNewMapping(prev => ({ ...prev, sf_field: '', gw_field: '' }));
    setDirty(true);
  };

  const removeMapping = (idx) => {
    setFieldMap(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const gwFields = GW_ENTITY_OPTIONS.find(e => e.value === newMapping.gw_entity)?.fields || [];

  // Filter entity options to those matching the selected HS object
  const compatibleEntities = GW_ENTITY_OPTIONS.filter(
    e => e.hsObject === newMapping.sf_object
  );

  return (
    <div className="sf-section">
      <p className="sf-section-desc">
        Map HubSpot custom properties to GoWarm fields. Use this for any non-standard
        fields you want to sync. Changes apply on the next sync.
      </p>

      {fieldMap.length > 0 && (
        <div className="sf-map-table sf-map-table--5col">
          <div className="sf-map-header sf-map-header--5col">
            <span>HS Object</span><span>HS Property</span><span>Direction</span><span>GoWarm Field</span><span></span>
          </div>
          {fieldMap.map((m, i) => (
            <div key={i} className="sf-map-row sf-map-row--5col">
              <span className="sf-map-cell">{m.sf_object}</span>
              <span className="sf-map-cell sf-map-cell--sf">{m.sf_field}</span>
              <span className="sf-map-cell">
                {DIRECTION_OPTIONS.find(d => d.value === m.direction)?.label || m.direction}
              </span>
              <span className="sf-map-cell sf-map-cell--gw">{m.gw_entity}.{m.gw_field}</span>
              <button className="sf-map-remove" onClick={() => removeMapping(i)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {fieldMap.length === 0 && <div className="sf-empty-state">No field mappings yet.</div>}

      {/* Add new */}
      <div className="sf-add-field-mapping">
        <div className="sf-field-row">
          <label className="sf-label">HubSpot Object</label>
          <select
            className="sf-select"
            value={newMapping.sf_object}
            onChange={e => {
              const obj = e.target.value;
              const firstCompatible = GW_ENTITY_OPTIONS.find(en => en.hsObject === obj);
              setNewMapping(prev => ({
                ...prev,
                sf_object: obj,
                sf_field: '',
                gw_entity: firstCompatible?.value || prev.gw_entity,
                gw_field: '',
              }));
            }}
          >
            {HS_OBJECTS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">HubSpot Property Name</label>
          <input
            className="sf-input"
            placeholder="e.g. hs_annual_revenue"
            value={newMapping.sf_field}
            onChange={e => setNewMapping(prev => ({ ...prev, sf_field: e.target.value }))}
          />
        </div>
        <div className="sf-field-row">
          <label className="sf-label">Direction</label>
          <select
            className="sf-select"
            value={newMapping.direction}
            onChange={e => setNewMapping(prev => ({ ...prev, direction: e.target.value }))}
          >
            {DIRECTION_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">GoWarm Entity</label>
          <select
            className="sf-select"
            value={newMapping.gw_entity}
            onChange={e => setNewMapping(prev => ({ ...prev, gw_entity: e.target.value, gw_field: '' }))}
          >
            {compatibleEntities.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">GoWarm Field</label>
          <select
            className="sf-select"
            value={newMapping.gw_field}
            onChange={e => setNewMapping(prev => ({ ...prev, gw_field: e.target.value }))}
          >
            <option value="">Select GoWarm field…</option>
            {gwFields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <button
          className="sf-btn sf-btn--ghost"
          onClick={addMapping}
          disabled={!newMapping.sf_field || !newMapping.gw_field}
          style={{ alignSelf: 'flex-end' }}
        >
          Add Mapping
        </button>
      </div>

      <button
        className="sf-btn sf-btn--primary"
        style={{ marginTop: 16 }}
        onClick={() => { onSave({ field_map: fieldMap }); setDirty(false); }}
        disabled={saving || !dirty}
      >
        {saving ? 'Saving…' : 'Save Field Mappings'}
      </button>
    </div>
  );
}
