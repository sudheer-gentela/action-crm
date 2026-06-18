// prospecting/CustomFieldDefsEditor.js
// Admin editor for custom field definitions. Use campaignId=null for org-level
// fields (Settings) or a campaign id for campaign-only fields (Campaign config).
//
//   <CustomFieldDefsEditor />                      // org-level
//   <CustomFieldDefsEditor campaignId={campaign.id} />  // campaign-only
//
// Writes require owner/admin (the API enforces it; non-admins see the 403 message).

import React, { useEffect, useState, useCallback } from 'react';
import * as CFApi from './customFieldsApi';
import CustomFieldsImportModal from './CustomFieldsImportModal';
import './CustomFields.css';

const ENTITIES = ['prospect', 'account', 'contact', 'deal'];
const blankDraft = () => ({ fieldKey: '', label: '', fieldType: 'text', picklistText: '', displayOrder: 0 });

export default function CustomFieldDefsEditor({ campaignId = null }) {
  const [targetEntity, setTargetEntity] = useState('prospect');
  const [defs, setDefs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [draft, setDraft]     = useState(blankDraft());
  const [showInactive, setShowInactive] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const scopeLabel = campaignId != null ? 'campaign-only' : 'org-level';

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const all = await CFApi.listDefs({ targetEntity, campaignId: campaignId ?? undefined, includeInactive: true });
      // Only show defs that belong to THIS scope (org-level vs this campaign).
      setDefs(all.filter(d => (campaignId == null ? d.campaign_id == null : d.campaign_id === campaignId)));
    } catch (e) {
      setError(e.message || 'Failed to load definitions');
    } finally { setLoading(false); }
  }, [targetEntity, campaignId]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!draft.fieldKey) { setError('Field key is required'); return; }
    try {
      await CFApi.createDef({
        targetEntity,
        fieldKey: draft.fieldKey.trim(),
        label: draft.label || draft.fieldKey,
        fieldType: draft.fieldType,
        picklistOptions: draft.fieldType === 'picklist'
          ? draft.picklistText.split(',').map(s => s.trim()).filter(Boolean) : [],
        displayOrder: Number(draft.displayOrder) || 0,
        campaignId: campaignId ?? undefined,
      });
      setDraft(blankDraft());
      await load();
    } catch (e) { setError(e.message); }
  };

  const patch = async (def, p) => {
    try { await CFApi.updateDef(def.id, p); await load(); }
    catch (e) { setError(e.message); }
  };
  const deactivate = async (def) => {
    try { await CFApi.deactivateDef(def.id); await load(); }
    catch (e) { setError(e.message); }
  };

  const visible = defs.filter(d => showInactive || d.active !== false);

  return (
    <div className="cf-editor">
      <div className="cf-editor-head">
        <div className="cf-tabs">
          {ENTITIES.map(e => (
            <button key={e} type="button"
              className={`cf-tab ${targetEntity === e ? 'is-active' : ''}`}
              onClick={() => setTargetEntity(e)}>{CFApi.ENTITY_LABEL[e]}</button>
          ))}
        </div>
        <div className="cf-head-actions" style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
          <label className="cf-check">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <button type="button" className="cf-btn" onClick={() => setShowImport(true)}>
            Import values (CSV)
          </button>
        </div>
      </div>
      <p className="cf-muted cf-scope-note">Defining <strong>{scopeLabel}</strong> {targetEntity} fields.</p>

      {error && <div className="cf-error">{error}</div>}

      {loading ? <div className="cf-muted">Loading…</div> : (
        <table className="cf-table">
          <thead>
            <tr><th>Key</th><th>Label</th><th>Type</th><th>Options</th><th>Order</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map(def => (
              <tr key={def.id} className={def.active === false ? 'cf-row-inactive' : ''}>
                <td className="cf-mono">{def.field_key}</td>
                <td>
                  <input className="cf-input" defaultValue={def.label || ''}
                    onBlur={e => { if (e.target.value !== (def.label || '')) patch(def, { label: e.target.value }); }} />
                </td>
                <td>{def.field_type}</td>
                <td className="cf-muted">
                  {def.field_type === 'picklist' ? (Array.isArray(def.picklist_options) ? def.picklist_options.join(', ') : '') : '—'}
                </td>
                <td>
                  <input className="cf-input cf-input-sm" type="number" defaultValue={def.display_order ?? 0}
                    onBlur={e => { const n = Number(e.target.value) || 0; if (n !== def.display_order) patch(def, { display_order: n }); }} />
                </td>
                <td>{def.active === false ? <span className="cf-badge cf-src-crm_sync">inactive</span> : 'active'}</td>
                <td>
                  {def.active === false
                    ? <button type="button" className="cf-btn" onClick={() => patch(def, { active: true })}>Reactivate</button>
                    : <button type="button" className="cf-btn cf-btn-danger" onClick={() => deactivate(def)}>Deactivate</button>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={7} className="cf-empty">No {scopeLabel} {targetEntity} fields yet.</td></tr>
            )}
          </tbody>
        </table>
      )}

      <div className="cf-add">
        <input className="cf-input cf-mono" placeholder="field_key" value={draft.fieldKey}
          onChange={e => setDraft({ ...draft, fieldKey: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
        <input className="cf-input" placeholder="Label" value={draft.label}
          onChange={e => setDraft({ ...draft, label: e.target.value })} />
        <select className="cf-input" value={draft.fieldType} onChange={e => setDraft({ ...draft, fieldType: e.target.value })}>
          {CFApi.FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {draft.fieldType === 'picklist' && (
          <input className="cf-input" placeholder="Options (comma-separated)" value={draft.picklistText}
            onChange={e => setDraft({ ...draft, picklistText: e.target.value })} />
        )}
        <input className="cf-input cf-input-sm" type="number" placeholder="Order" value={draft.displayOrder}
          onChange={e => setDraft({ ...draft, displayOrder: e.target.value })} />
        <button type="button" className="cf-btn cf-btn-primary" onClick={add}>Add field</button>
      </div>

      {showImport && (
        <CustomFieldsImportModal
          targetEntity={targetEntity}
          campaignId={campaignId}
          onClose={() => setShowImport(false)}
          onDone={() => { load(); }}
        />
      )}
    </div>
  );
}
