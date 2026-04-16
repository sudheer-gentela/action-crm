/**
 * SalesforceConnect.js
 *
 * DROP-IN LOCATION: frontend/src/SalesforceConnect.js
 *
 * Org Admin settings panel for Salesforce integration.
 * Tabs:
 *   1. Connection   — connect / disconnect / status / manual sync trigger
 *   2. Sync Mode    — sf_primary / gowarm_primary / bidirectional
 *   3. Stage Mapping — SF stage names → GoWarm stage keys
 *   4. Field Mapping — arbitrary SF field → GoWarm field mappings
 *   5. Write-back   — enable/disable + mode (nightly/realtime) [SuperAdmin gate]
 */

import React, { useState, useEffect, useCallback } from 'react';
import './SalesforceConnect.css';
import { salesforceAPI } from './apiService';

// ── GoWarm stage options (canonical keys) ─────────────────────────────────────
const GW_STAGE_OPTIONS = {
  prospect: [
    { value: 'target',        label: 'Target' },
    { value: 'research',      label: 'Research' },
    { value: 'outreach',      label: 'Outreach' },
    { value: 'engaged',       label: 'Engaged' },
    { value: 'discovery_call',label: 'Discovery Call' },
    { value: 'qualified_sal', label: 'Qualified (SAL)' },
    { value: 'converted',     label: 'Converted' },
    { value: 'disqualified',  label: 'Disqualified' },
  ],
  deal: [
    { value: 'discovery',     label: 'Discovery' },
    { value: 'qualification', label: 'Qualification' },
    { value: 'demo',          label: 'Demo' },
    { value: 'proposal',      label: 'Proposal' },
    { value: 'negotiation',   label: 'Negotiation' },
    { value: 'closed_won',    label: 'Closed Won' },
    { value: 'closed_lost',   label: 'Closed Lost' },
  ],
};

const GW_ENTITY_OPTIONS = [
  { value: 'deal',     label: 'Deal', fields: ['name','value','stage','expected_close_date','probability','notes'] },
  { value: 'contact',  label: 'Contact', fields: ['first_name','last_name','email','phone','title','location','linkedin_url','role_type'] },
  { value: 'account',  label: 'Account', fields: ['name','domain','industry','size','location','description'] },
  { value: 'prospect', label: 'Prospect', fields: ['first_name','last_name','email','phone','title','company_name','company_domain','company_industry','source','icp_score'] },
];

const DIRECTION_OPTIONS = [
  { value: 'sf_to_gw', label: '← SF → GoWarm only' },
  { value: 'gw_to_sf', label: '→ GoWarm → SF only' },
  { value: 'both',     label: '↔ Both directions' },
];

// ── Main component ─────────────────────────────────────────────────────────────

export default function SalesforceConnect({ onConnectionChange }) {
  const [subTab,      setSubTab]      = useState('connection');
  const [status,      setStatus]      = useState(null);
  const [settings,    setSettings]    = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState('');
  const [success,     setSuccess]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, settingsRes] = await Promise.all([
        salesforceAPI.getStatus(),
        salesforceAPI.getSettings(),
      ]);
      setStatus(statusRes.data);
      setSettings(settingsRes.data?.settings || {});
    } catch (e) {
      setError('Failed to load Salesforce settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.get('salesforce_connected') === 'true') {
      setSuccess('✅ Salesforce connected successfully!');
      load();
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error') === 'salesforce_auth_failed') {
      const msg = params.get('message') || 'Authentication failed';
      setError(`Salesforce connection failed: ${msg}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [load]);

  const saveSetting = async (updates) => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await salesforceAPI.updateSettings(updates);
      setSettings(prev => ({ ...prev, ...updates }));
      setSuccess('Settings saved ✓');
      setTimeout(() => setSuccess(''), 3000);
      if (onConnectionChange) onConnectionChange();
    } catch (e) {
      setError(e.message || 'Failed to save settings');
    } finally {
      setSaving(false); }
  };

  if (loading) return <div className="sf-connect loading">Loading Salesforce settings…</div>;

  const isConnected = status?.connected;

  const SUB_TABS = [
    { id: 'connection',    label: '🔌 Connection' },
    { id: 'sync-mode',     label: '⚙️ Sync Mode',     disabled: !isConnected },
    { id: 'stage-map',     label: '🗺 Stage Mapping',  disabled: !isConnected },
    { id: 'field-map',     label: '🔧 Field Mapping',  disabled: !isConnected },
    { id: 'write-back',    label: '📤 Write-back',     disabled: !isConnected },
  ];

  return (
    <div className="sf-connect">
      {/* Header */}
      <div className="sf-header">
        <div className="sf-icon">☁️</div>
        <div className="sf-header-info">
          <h3>Salesforce Integration</h3>
          {isConnected ? (
            <p className="sf-connected-badge">
              ✓ Connected — {status.sfEmail || status.sfUsername || status.instanceUrl}
            </p>
          ) : (
            <p className="sf-desc">
              Sync contacts, accounts, opportunities, and leads between Salesforce and GoWarm.
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
        {subTab === 'connection'  && <ConnectionTab  status={status}   onConnect={load} onDisconnect={load} setError={setError} setSuccess={setSuccess} onConnectionChange={onConnectionChange} />}
        {subTab === 'sync-mode'   && <SyncModeTab    settings={settings} onSave={saveSetting} saving={saving} />}
        {subTab === 'stage-map'   && <StageMappingTab settings={settings} onSave={saveSetting} saving={saving} />}
        {subTab === 'field-map'   && <FieldMappingTab settings={settings} onSave={saveSetting} saving={saving} />}
        {subTab === 'write-back'  && <WriteBackTab   settings={settings} onSave={saveSetting} saving={saving} />}
      </div>
    </div>
  );
}

// ── ConnectionTab ──────────────────────────────────────────────────────────────

function ConnectionTab({ status, onConnect, onDisconnect, setError, setSuccess, onConnectionChange }) {
  const [syncing, setSyncing] = useState(false);

  const handleConnect = async () => {
    try {
      const res = await salesforceAPI.getAuthUrl();
      if (res.success && res.authUrl) window.location.href = res.authUrl;
      else throw new Error(res.error || 'Invalid response');
    } catch (e) {
      setError('Failed to start Salesforce connection. Check env vars are set.');
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Salesforce? This will stop syncing but won\'t delete existing GoWarm records.')) return;
    try {
      await salesforceAPI.disconnect();
      setSuccess('Salesforce disconnected');
      onDisconnect();
      if (onConnectionChange) onConnectionChange();
    } catch (e) {
      setError('Failed to disconnect Salesforce');
    }
  };

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await salesforceAPI.triggerSync();
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
          Connect your Salesforce org to sync contacts, accounts, opportunities, and leads.
          GoWarm will sync nightly at 04:00 UTC after the connection is made.
        </p>
        <div className="sf-prereqs">
          <div className="sf-prereq-title">Before connecting:</div>
          <ul>
            <li>Create a Connected App in Salesforce Setup → Apps → App Manager</li>
            <li>Enable OAuth with scopes: <code>api</code>, <code>refresh_token</code>, <code>offline_access</code></li>
            <li>Set the callback URL to your GoWarm backend + <code>/api/salesforce/callback</code></li>
            <li>Add env vars: <code>SALESFORCE_CLIENT_ID</code>, <code>SALESFORCE_CLIENT_SECRET</code>, <code>SALESFORCE_REDIRECT_URI</code></li>
          </ul>
        </div>
        <button className="sf-btn sf-btn--primary" onClick={handleConnect}>
          Connect Salesforce
        </button>
      </div>
    );
  }

  return (
    <div className="sf-section">
      <div className="sf-status-card">
        <div className="sf-status-row">
          <span className="sf-status-label">Instance</span>
          <span className="sf-status-value">{status.instanceUrl}</span>
        </div>
        <div className="sf-status-row">
          <span className="sf-status-label">Connected as</span>
          <span className="sf-status-value">{status.sfEmail || status.sfUsername || '—'}</span>
        </div>
        <div className="sf-status-row">
          <span className="sf-status-label">Connected at</span>
          <span className="sf-status-value">{status.connectedAt ? new Date(status.connectedAt).toLocaleString() : '—'}</span>
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
          Disconnect Salesforce
        </button>
      </div>
    </div>
  );
}

// ── SyncModeTab ────────────────────────────────────────────────────────────────

function SyncModeTab({ settings, onSave, saving }) {
  const [mode, setMode] = useState(settings?.sf_sync_mode || 'sf_primary');

  const MODES = [
    {
      value: 'sf_primary',
      label: 'Salesforce Primary',
      desc:  'Salesforce is the source of truth. Contact/deal/account fields synced from SF become read-only in GoWarm. Reps can still initiate actions, sequences, and plays from GoWarm.',
      recommended: true,
    },
    {
      value: 'gowarm_primary',
      label: 'GoWarm Primary',
      desc:  'GoWarm is the source of truth. Salesforce is read-only — your team manages everything in GoWarm and changes sync back to SF.',
    },
    {
      value: 'bidirectional',
      label: 'Bidirectional',
      desc:  'Both systems can be edited. When conflicts arise, the most recently modified version wins. Use with caution — can cause data inconsistency if both systems are edited simultaneously.',
    },
  ];

  return (
    <div className="sf-section">
      <p className="sf-section-desc">
        Choose how GoWarm and Salesforce share authority over your data.
        This affects which fields can be edited directly in GoWarm.
      </p>
      <div className="sf-mode-options">
        {MODES.map(m => (
          <label key={m.value} className={`sf-mode-option ${mode === m.value ? 'selected' : ''}`}>
            <input type="radio" name="sf_sync_mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
            <div className="sf-mode-body">
              <div className="sf-mode-title">
                {m.label}
                {m.recommended && <span className="sf-badge sf-badge--recommended">Recommended</span>}
              </div>
              <div className="sf-mode-desc">{m.desc}</div>
            </div>
          </label>
        ))}
      </div>
      <button
        className="sf-btn sf-btn--primary"
        onClick={() => onSave({ sf_sync_mode: mode })}
        disabled={saving || mode === settings?.sf_sync_mode}
      >
        {saving ? 'Saving…' : 'Save Sync Mode'}
      </button>
    </div>
  );
}

// ── StageMappingTab ────────────────────────────────────────────────────────────

function StageMappingTab({ settings, onSave, saving }) {
  const [stageMap, setStageMap] = useState(settings?.stage_map || {});
  const [newSfStage, setNewSfStage] = useState('');
  const [newGwStage, setNewGwStage] = useState('');
  const [gwEntity,   setGwEntity]   = useState('deal');
  const [dirty, setDirty] = useState(false);

  // Sync stageMap when settings load (useState only runs once on mount,
  // so if settings arrive after first render the map would stay empty)
  useEffect(() => {
    if (settings?.stage_map && !dirty) {
      setStageMap(settings.stage_map);
    }
  }, [settings?.stage_map]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMapping = () => {
    const sfKey = newSfStage.trim();
    if (!sfKey || !newGwStage) return;
    setStageMap(prev => ({ ...prev, [sfKey]: newGwStage }));
    setNewSfStage(''); setNewGwStage(''); setDirty(true);
  };

  const removeMapping = (sfStage) => {
    setStageMap(prev => { const n = { ...prev }; delete n[sfStage]; return n; });
    setDirty(true);
  };

  const stageOptions = GW_STAGE_OPTIONS[gwEntity] || GW_STAGE_OPTIONS.deal;

  return (
    <div className="sf-section">
      <p className="sf-section-desc">
        Map Salesforce stage names to GoWarm stages. Without a mapping, stage won't sync.
        Salesforce stage names are case-sensitive — enter them exactly as they appear in SF.
      </p>

      <div className="sf-field-row" style={{ marginBottom: 16 }}>
        <label className="sf-label">GoWarm entity type</label>
        <select className="sf-select" value={gwEntity} onChange={e => setGwEntity(e.target.value)}>
          <option value="deal">Deal (from SF Opportunity)</option>
          <option value="prospect">Prospect (from SF Lead)</option>
        </select>
      </div>

      {/* Existing mappings */}
      {Object.keys(stageMap).length > 0 && (
        <div className="sf-map-table">
          <div className="sf-map-header">
            <span>Salesforce Stage</span>
            <span>→</span>
            <span>GoWarm Stage</span>
            <span></span>
          </div>
          {Object.entries(stageMap).map(([sfStage, gwStage]) => (
            <div key={sfStage} className="sf-map-row">
              <span className="sf-map-cell sf-map-cell--sf">{sfStage}</span>
              <span className="sf-map-arrow">→</span>
              <span className="sf-map-cell sf-map-cell--gw">
                {stageOptions.find(s => s.value === gwStage)?.label || gwStage}
              </span>
              <button className="sf-map-remove" onClick={() => removeMapping(sfStage)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {Object.keys(stageMap).length === 0 && (
        <div className="sf-empty-state">No stage mappings yet. Add your first mapping below.</div>
      )}

      {/* Add new */}
      <div className="sf-add-mapping">
        <input
          className="sf-input"
          placeholder="SF stage name (e.g. Prospecting)"
          value={newSfStage}
          onChange={e => setNewSfStage(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addMapping()}
        />
        <span className="sf-map-arrow">→</span>
        <select className="sf-select" value={newGwStage} onChange={e => setNewGwStage(e.target.value)}>
          <option value="">Select GoWarm stage…</option>
          {stageOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button className="sf-btn sf-btn--ghost" onClick={addMapping} disabled={!newSfStage || !newGwStage}>
          Add
        </button>
      </div>

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

// ── FieldMappingTab ────────────────────────────────────────────────────────────

function FieldMappingTab({ settings, onSave, saving }) {
  const [fieldMap, setFieldMap] = useState(settings?.field_map || []);

  // Sync fieldMap when settings load
  useEffect(() => {
    if (settings?.field_map && !dirty) {
      setFieldMap(settings.field_map);
    }
  }, [settings?.field_map]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sfFields, setSfFields] = useState({});
  const [newMapping, setNewMapping] = useState({ sf_object: 'Opportunity', sf_field: '', gw_entity: 'deal', gw_field: '', direction: 'sf_to_gw' });
  const [loadingFields, setLoadingFields] = useState({});
  const [dirty, setDirty] = useState(false);

  const loadSfFields = async (sfObject) => {
    if (sfFields[sfObject] || loadingFields[sfObject]) return;
    setLoadingFields(prev => ({ ...prev, [sfObject]: true }));
    try {
      const res = await salesforceAPI.describeObject(sfObject);
      setSfFields(prev => ({ ...prev, [sfObject]: res.data?.fields || [] }));
    } catch {
      setSfFields(prev => ({ ...prev, [sfObject]: [] }));
    } finally {
      setLoadingFields(prev => ({ ...prev, [sfObject]: false }));
    }
  };

  const handleSfObjectChange = (obj) => {
    setNewMapping(prev => ({ ...prev, sf_object: obj, sf_field: '' }));
    loadSfFields(obj);
  };

  const addMapping = () => {
    if (!newMapping.sf_field || !newMapping.gw_field) return;
    const exists = fieldMap.find(m => m.sf_object === newMapping.sf_object && m.sf_field === newMapping.sf_field);
    if (exists) return;
    setFieldMap(prev => [...prev, { ...newMapping }]);
    setNewMapping(prev => ({ ...prev, sf_field: '', gw_field: '' }));
    setDirty(true);
  };

  const removeMapping = (idx) => {
    setFieldMap(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const SF_OBJECTS = ['Contact', 'Account', 'Opportunity', 'Lead'];
  const gwFields   = GW_ENTITY_OPTIONS.find(e => e.value === newMapping.gw_entity)?.fields || [];
  const availableSfFields = sfFields[newMapping.sf_object] || [];

  return (
    <div className="sf-section">
      <p className="sf-section-desc">
        Map additional Salesforce fields to GoWarm fields. Useful for custom fields that affect
        action completion, ICP scoring, or enrichment. Changes apply on the next sync.
      </p>

      {fieldMap.length > 0 && (
        <div className="sf-map-table sf-map-table--5col">
          <div className="sf-map-header sf-map-header--5col">
            <span>SF Object</span><span>SF Field</span><span>Direction</span><span>GoWarm Field</span><span></span>
          </div>
          {fieldMap.map((m, i) => (
            <div key={i} className="sf-map-row sf-map-row--5col">
              <span className="sf-map-cell">{m.sf_object}</span>
              <span className="sf-map-cell sf-map-cell--sf">{m.sf_field}</span>
              <span className="sf-map-cell">{DIRECTION_OPTIONS.find(d => d.value === m.direction)?.label || m.direction}</span>
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
          <label className="sf-label">Salesforce Object</label>
          <select className="sf-select" value={newMapping.sf_object} onChange={e => handleSfObjectChange(e.target.value)}>
            {SF_OBJECTS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">Salesforce Field</label>
          <select
            className="sf-select"
            value={newMapping.sf_field}
            onChange={e => setNewMapping(prev => ({ ...prev, sf_field: e.target.value }))}
            onFocus={() => loadSfFields(newMapping.sf_object)}
          >
            <option value="">{loadingFields[newMapping.sf_object] ? 'Loading fields…' : 'Select SF field…'}</option>
            {availableSfFields.map(f => (
              <option key={f.name} value={f.name}>{f.label} ({f.name}){f.custom ? ' ✦' : ''}</option>
            ))}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">Direction</label>
          <select className="sf-select" value={newMapping.direction} onChange={e => setNewMapping(prev => ({ ...prev, direction: e.target.value }))}>
            {DIRECTION_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">GoWarm Entity</label>
          <select className="sf-select" value={newMapping.gw_entity} onChange={e => setNewMapping(prev => ({ ...prev, gw_entity: e.target.value, gw_field: '' }))}>
            {GW_ENTITY_OPTIONS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
        </div>
        <div className="sf-field-row">
          <label className="sf-label">GoWarm Field</label>
          <select className="sf-select" value={newMapping.gw_field} onChange={e => setNewMapping(prev => ({ ...prev, gw_field: e.target.value }))}>
            <option value="">Select GoWarm field…</option>
            {gwFields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <button className="sf-btn sf-btn--ghost" onClick={addMapping} disabled={!newMapping.sf_field || !newMapping.gw_field} style={{ alignSelf: 'flex-end' }}>
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

// ── WriteBackTab ───────────────────────────────────────────────────────────────

function WriteBackTab({ settings, onSave, saving }) {
  const [enabled, setEnabled] = useState(settings?.write_back_enabled || false);
  const [mode, setMode]       = useState(settings?.write_back_mode || 'nightly');
  const [dirty, setDirty]     = useState(false);

  return (
    <div className="sf-section">
      <div className="sf-info-box">
        <strong>ℹ️ Platform gate</strong> — Write-back must be enabled by your GoWarm platform
        administrator before you can turn it on here.
      </div>
      <p className="sf-section-desc" style={{ marginTop: 12 }}>
        When enabled, completed GoWarm actions are automatically pushed to Salesforce as Tasks.
        A <code>GoWarm_Source__c</code> custom field on the SF Task prevents echo loops.
      </p>

      <div className="sf-toggle-row">
        <label className="sf-toggle-label">
          <span>Enable write-back to Salesforce</span>
          <div
            className={`sf-toggle ${enabled ? 'on' : ''}`}
            onClick={() => { setEnabled(p => !p); setDirty(true); }}
          >
            <div className="sf-toggle-knob" />
          </div>
        </label>
      </div>

      {enabled && (
        <div className="sf-mode-options" style={{ marginTop: 16 }}>
          {[
            { value: 'nightly',  label: 'Nightly batch (04:30 UTC)', desc: 'Safe and reliable. Completed actions from the past 25 hours are pushed once nightly.' },
            { value: 'realtime', label: 'Real-time', desc: 'Actions are pushed to SF immediately on completion. Lower latency but adds a small delay to the action completion response.' },
          ].map(m => (
            <label key={m.value} className={`sf-mode-option ${mode === m.value ? 'selected' : ''}`}>
              <input type="radio" name="write_back_mode" value={m.value} checked={mode === m.value}
                onChange={() => { setMode(m.value); setDirty(true); }} />
              <div className="sf-mode-body">
                <div className="sf-mode-title">{m.label}</div>
                <div className="sf-mode-desc">{m.desc}</div>
              </div>
            </label>
          ))}
        </div>
      )}

      <button
        className="sf-btn sf-btn--primary"
        style={{ marginTop: 20 }}
        onClick={() => { onSave({ write_back_enabled: enabled, write_back_mode: mode }); setDirty(false); }}
        disabled={saving || !dirty}
      >
        {saving ? 'Saving…' : 'Save Write-back Settings'}
      </button>
    </div>
  );
}
