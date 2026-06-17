// customFields/customFieldColumns.js
// Reusable tools to add custom-field COLUMNS to any existing list/table view
// and to export them to CSV — without rewriting the host list component.
//
// Typical wiring in a list view:
//   const ids = rows.map(r => r.id);
//   const { defs, byEntity } = useCustomFieldColumns({ entityType: 'prospect', entityIds: ids });
//   const [selected] = useSelectedColumns('prospect');
//   // toolbar:  <CustomFieldColumnPicker entityType="prospect" entityIds={ids} />
//   // header:   {selected.map(k => <th key={k}>{(defs.find(d=>d.field_key===k)||{}).label||k}</th>)}
//   // each row: {selected.map(k => <td key={k}>{formatCustomValue(defs.find(d=>d.field_key===k), byEntity[row.id]?.[k])}</td>)}

import React, { useEffect, useState, useCallback } from 'react';
import * as CFApi from './customFieldsApi';
import { API } from '../prospecting/prospectingShared';
import './CustomFields.css';

const LS_KEY = (e) => `cf_cols_${e}`;

// Persisted per-entity selection of which custom fields show as columns.
export function useSelectedColumns(entityType) {
  const read = () => { try { return JSON.parse(localStorage.getItem(LS_KEY(entityType)) || '[]'); } catch { return []; } };
  const [sel, setSel] = useState(read);
  // read() is intentionally not a dependency — re-reading localStorage only when
  // entityType changes is the desired behaviour.
  useEffect(() => { setSel(read()); }, [entityType]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((next) => {
    setSel(next);
    try { localStorage.setItem(LS_KEY(entityType), JSON.stringify(next)); } catch { /* ignore */ }
  }, [entityType]);
  return [sel, update];
}

// Bulk-load defs + values for the visible rows. campaign-scoped value (if any)
// overrides the durable one in the collapsed `byEntity` map.
export function useCustomFieldColumns({ entityType, entityIds, campaignId = null }) {
  const [defs, setDefs] = useState([]);
  const [byEntity, setByEntity] = useState({});
  const [loading, setLoading] = useState(false);
  const idsKey = (entityIds || []).join(',');

  const refresh = useCallback(async () => {
    if (!entityType) return;
    setLoading(true);
    try {
      const d = await CFApi.listDefs({ targetEntity: entityType, campaignId: campaignId ?? undefined });
      setDefs(d.filter(x => x.active !== false));
      const ids = idsKey ? idsKey.split(',').map(Number) : [];
      if (ids.length) {
        const map = await CFApi.getValuesBulk({ entityType, entityIds: ids, campaignId: campaignId ?? undefined, includeDurable: true });
        const out = {};
        Object.entries(map).forEach(([id, arr]) => {
          const byKey = {};
          (arr || []).forEach(v => { if (byKey[v.field_key] === undefined || v.scope === 'campaign') byKey[v.field_key] = v.value; });
          out[id] = byKey;
        });
        setByEntity(out);
      } else {
        setByEntity({});
      }
    } catch {
      setDefs([]); setByEntity({});
    } finally {
      setLoading(false);
    }
  }, [entityType, idsKey, campaignId]);

  useEffect(() => { refresh(); }, [refresh]);
  return { defs, byEntity, loading, refresh };
}

export function formatCustomValue(def, value) {
  if (value === null || value === undefined || value === '') return '';
  const t = def && def.field_type;
  if (t === 'boolean') return (value === true || value === 'true') ? 'Yes' : (value === false || value === 'false') ? 'No' : '';
  if (t === 'date') return String(value).slice(0, 10);
  return String(value);
}

// Streams the server-side CSV export (identity + selected custom columns).
export function downloadCustomFieldsCsv({ entityType, fields, entityIds, campaignId }) {
  const params = new URLSearchParams({ entityType });
  if (fields && fields.length) params.set('fields', fields.join(','));
  if (entityIds && entityIds.length) params.set('ids', entityIds.join(','));
  if (campaignId != null) params.set('campaignId', String(campaignId));
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}/custom-fields/export.csv?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${entityType}_custom_fields.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });
}

// Toolbar control: pick which custom fields appear as columns + export.
// Selection is uncontrolled (localStorage) by default; pass `selected` + `onChange`
// to control it from a parent (so a list can render the chosen columns reactively).
export function CustomFieldColumnPicker({ entityType, entityIds = [], campaignId = null, selected: selectedProp, onChange }) {
  const { defs } = useCustomFieldColumns({ entityType, entityIds: [], campaignId });
  const [internalSel, setInternalSel] = useSelectedColumns(entityType);
  const selected = selectedProp !== undefined ? selectedProp : internalSel;
  const setSelected = onChange || setInternalSel;
  const [open, setOpen] = useState(false);
  const toggle = (key) => setSelected(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key]);

  return (
    <div className="cf-colpicker">
      <button type="button" className="cf-btn" onClick={() => setOpen(o => !o)}>
        Custom columns{selected.length ? ` (${selected.length})` : ''}
      </button>
      <button type="button" className="cf-btn"
        onClick={() => downloadCustomFieldsCsv({ entityType, fields: selected, entityIds, campaignId })}>
        Export CSV
      </button>
      {open && (
        <div className="cf-colpicker-menu" onMouseLeave={() => setOpen(false)}>
          {defs.length === 0
            ? <div className="cf-muted">No custom fields defined for {entityType}s.</div>
            : defs.map(d => (
              <label key={d.id} className="cf-colpicker-item">
                <input type="checkbox" checked={selected.includes(d.field_key)} onChange={() => toggle(d.field_key)} />
                {d.label || d.field_key}
              </label>
            ))}
        </div>
      )}
    </div>
  );
}
