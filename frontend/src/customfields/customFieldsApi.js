// prospecting/customFieldsApi.js
// Thin wrappers over apiFetch for the /api/custom-fields subsystem.
// apiFetch resolves to parsed JSON and throws on non-2xx (message on err.message).

import { apiFetch } from '../prospecting/prospectingShared';

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.append(k, v);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ── Definitions ──────────────────────────────────────────────────────────────
export const listDefs = ({ targetEntity, campaignId, includeInactive } = {}) =>
  apiFetch(`/custom-fields/defs${qs({ targetEntity, campaignId, includeInactive })}`).then(r => r.defs || []);

export const createDef = (body) =>
  apiFetch('/custom-fields/defs', { method: 'POST', body: JSON.stringify(body) }).then(r => r.def);

export const updateDef = (id, patch) =>
  apiFetch(`/custom-fields/defs/${id}`, { method: 'PUT', body: JSON.stringify(patch) }).then(r => r.def);

export const deactivateDef = (id) =>
  apiFetch(`/custom-fields/defs/${id}`, { method: 'DELETE' });

// ── Values ───────────────────────────────────────────────────────────────────
// Single entity → returns an array. Bulk (entityIds) → returns a keyed object.
export const getValues = ({ entityType, entityId, campaignId, includeDurable } = {}) =>
  apiFetch(`/custom-fields/values${qs({ entityType, entityId, campaignId, includeDurable })}`).then(r => r.values || []);

export const getValuesBulk = ({ entityType, entityIds, campaignId, includeDurable } = {}) =>
  apiFetch(`/custom-fields/values${qs({ entityType, entityIds: (entityIds || []).join(','), campaignId, includeDurable })}`)
    .then(r => r.values || {});

export const writeValue = (body) =>
  apiFetch('/custom-fields/values', { method: 'PUT', body: JSON.stringify(body) }).then(r => r.value);

export const promoteValue = (body) =>
  apiFetch('/custom-fields/values/promote', { method: 'POST', body: JSON.stringify(body) }).then(r => r.value);

export const deleteValue = (body) =>
  apiFetch('/custom-fields/values', { method: 'DELETE', body: JSON.stringify(body) });

// ── Import ───────────────────────────────────────────────────────────────────
export const importValues = (body) =>
  apiFetch('/custom-fields/import', { method: 'POST', body: JSON.stringify(body) });

export const ENTITY_LABEL = { prospect: 'Prospect', account: 'Account', contact: 'Contact', deal: 'Deal' };
export const MATCH_KEYS = {
  prospect: ['email', 'linkedin_url', 'id'],
  account:  ['domain', 'name', 'id'],
  contact:  ['email', 'linkedin_url', 'id'],
  deal:     ['external_crm_deal_id', 'name', 'id'],
};
export const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'picklist'];
