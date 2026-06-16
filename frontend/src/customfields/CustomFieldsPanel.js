// prospecting/CustomFieldsPanel.js
// Renders and edits custom field values for one entity (prospect | account |
// contact). When a campaignId is supplied it shows the campaign view: the
// durable value (lives on the entity) alongside the campaign-scoped value,
// with a "Promote" action to copy the campaign value onto the entity.
//
// Drop-in usage:
//   <CustomFieldsPanel entityType="prospect" entityId={prospect.id} campaignId={campaignId} />
//   <CustomFieldsPanel entityType="account"  entityId={account.id} />

import React, { useEffect, useState, useCallback } from 'react';
import * as CFApi from './customFieldsApi';
import './CustomFields.css';

const toDateInput = (v) => (v ? String(v).slice(0, 10) : '');

function FieldInput({ def, value, onCommit, disabled }) {
  const [local, setLocal] = useState(value ?? '');
  useEffect(() => { setLocal(value ?? ''); }, [value]);

  const commit = (v) => { if (v !== (value ?? '')) onCommit(v === '' ? null : v); };

  if (def.field_type === 'boolean') {
    return (
      <select className="cf-input" disabled={disabled}
        value={local === null || local === '' ? '' : String(local)}
        onChange={e => { setLocal(e.target.value); commit(e.target.value); }}>
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (def.field_type === 'picklist') {
    const opts = Array.isArray(def.picklist_options) ? def.picklist_options : [];
    return (
      <select className="cf-input" disabled={disabled}
        value={local ?? ''} onChange={e => { setLocal(e.target.value); commit(e.target.value); }}>
        <option value="">—</option>
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const type = def.field_type === 'number' ? 'number' : def.field_type === 'date' ? 'date' : 'text';
  return (
    <input className="cf-input" type={type} disabled={disabled}
      value={def.field_type === 'date' ? toDateInput(local) : (local ?? '')}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
  );
}

const SourceBadge = ({ source }) => source
  ? <span className={`cf-badge cf-src-${source}`}>{source.replace('_', ' ')}</span> : null;

export default function CustomFieldsPanel({ entityType, entityId, campaignId = null, title = 'Custom fields' }) {
  const [defs, setDefs]       = useState([]);
  const [durable, setDurable] = useState({}); // field_key → value row
  const [scoped, setScoped]   = useState({}); // field_key → value row (campaign)
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const inCampaign = campaignId != null;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [d, vals] = await Promise.all([
        CFApi.listDefs({ targetEntity: entityType, campaignId: campaignId ?? undefined }),
        CFApi.getValues({ entityType, entityId, campaignId: campaignId ?? undefined, includeDurable: true }),
      ]);
      setDefs(d.filter(x => x.active !== false));
      const dur = {}, sc = {};
      (vals || []).forEach(v => { (v.scope === 'campaign' ? sc : dur)[v.field_key] = v; });
      setDurable(dur); setScoped(sc);
    } catch (e) {
      setError(e.message || 'Failed to load custom fields');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, campaignId]);

  useEffect(() => { if (entityId) load(); }, [load, entityId]);

  const saveDurable = async (def, value) => {
    try {
      const row = await CFApi.writeValue({ entityType, entityId, fieldKey: def.field_key, value });
      setDurable(prev => ({ ...prev, [def.field_key]: row }));
    } catch (e) { setError(e.message); }
  };
  const saveScoped = async (def, value) => {
    try {
      const row = await CFApi.writeValue({ entityType, entityId, fieldKey: def.field_key, value, campaignId, source: 'manual' });
      setScoped(prev => ({ ...prev, [def.field_key]: row }));
    } catch (e) { setError(e.message); }
  };
  const promote = async (def) => {
    try {
      const row = await CFApi.promoteValue({ entityType, entityId, fieldKey: def.field_key, campaignId });
      setDurable(prev => ({ ...prev, [def.field_key]: row }));
    } catch (e) { setError(e.message); }
  };

  if (loading) return <div className="cf-panel cf-muted">Loading custom fields…</div>;

  return (
    <div className="cf-panel">
      <div className="cf-panel-head">
        <span className="cf-panel-title">{title}</span>
        {inCampaign && <span className="cf-panel-hint">Editing in campaign context</span>}
      </div>

      {error && <div className="cf-error">{error}</div>}

      {defs.length === 0 ? (
        <div className="cf-empty">No custom fields defined for {entityType}s. An admin can add them in Settings.</div>
      ) : (
        <table className="cf-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>On {entityType}</th>
              {inCampaign && <th>This campaign</th>}
              {inCampaign && <th></th>}
            </tr>
          </thead>
          <tbody>
            {defs.map(def => {
              const dv = durable[def.field_key];
              const sv = scoped[def.field_key];
              const hasScoped = sv && sv.value !== null && sv.value !== undefined && sv.value !== '';
              return (
                <tr key={def.id}>
                  <td className="cf-label">
                    {def.label || def.field_key}
                    {def.campaign_id != null && <span className="cf-badge cf-src-campaign">campaign field</span>}
                  </td>
                  <td>
                    <FieldInput def={def} value={dv ? dv.value : ''} onCommit={v => saveDurable(def, v)} />
                    {dv && <SourceBadge source={dv.source} />}
                  </td>
                  {inCampaign && (
                    <td>
                      <FieldInput def={def} value={sv ? sv.value : ''} onCommit={v => saveScoped(def, v)} />
                      {sv && <SourceBadge source={sv.source} />}
                    </td>
                  )}
                  {inCampaign && (
                    <td>
                      {hasScoped && (
                        <button type="button" className="cf-btn cf-btn-promote"
                          title="Copy this campaign's value onto the entity"
                          onClick={() => promote(def)}>Promote →</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
