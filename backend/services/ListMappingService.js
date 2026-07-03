/**
 * services/ListMappingService.js
 *
 * DROP-IN LOCATION: backend/services/ListMappingService.js
 *
 * CRUD for the org-shared list_signal_mappings library (P6) — reusable
 * column→signal mapping templates. Thin store, same shape/discipline as
 * TargetProfileService. Mappings are shape-validated through
 * ListSignalIngestService.cleanMappings so a stored template and a live ingest
 * are guaranteed identical.
 *
 * Org-shared (D10); created_by ⇒ "rep-added". No RLS — explicit org_id.
 */

const { pool } = require('../config/database');
const { cleanMappings } = require('./ListSignalIngestService');

const VALID_SOURCE_KINDS = new Set(['apollo', 'zoominfo', 'csv', 'other']);

function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    sourceKind: row.source_kind,
    mappings: Array.isArray(row.mappings) ? row.mappings : [],
    createdBy: row.created_by,
    repAdded: row.created_by != null,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createTemplate({ orgId, name, sourceKind = 'csv', mappings = [], createdBy = null, client }) {
  if (!orgId) throw new Error('ListMappingService.createTemplate: orgId is required');
  if (typeof name !== 'string' || !name.trim()) throw new Error('mapping name is required');
  const exec = client || pool;
  const kind = VALID_SOURCE_KINDS.has(sourceKind) ? sourceKind : 'other';
  const cleaned = cleanMappings(mappings);

  const { rows } = await exec.query(
    `INSERT INTO list_signal_mappings (org_id, name, source_kind, mappings, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [orgId, name.trim(), kind, JSON.stringify(cleaned), createdBy]
  ).catch((err) => {
    if (err && err.code === '23505') throw new Error(`a mapping named "${name.trim()}" already exists in this org`);
    throw err;
  });
  return rowToTemplate(rows[0]);
}

async function listTemplates({ orgId, includeInactive = false, client } = {}) {
  if (!orgId) throw new Error('ListMappingService.listTemplates: orgId is required');
  const exec = client || pool;
  const where = ['org_id = $1'];
  if (!includeInactive) where.push('active = true');
  const { rows } = await exec.query(
    `SELECT * FROM list_signal_mappings WHERE ${where.join(' AND ')} ORDER BY name ASC`,
    [orgId]
  );
  return rows.map(rowToTemplate);
}

async function getTemplate({ orgId, id, client }) {
  if (!orgId || !id) throw new Error('ListMappingService.getTemplate: orgId and id are required');
  const exec = client || pool;
  const { rows } = await exec.query(
    'SELECT * FROM list_signal_mappings WHERE org_id = $1 AND id = $2',
    [orgId, id]
  );
  return rowToTemplate(rows[0]);
}

async function updateTemplate({ orgId, id, patch, client }) {
  if (!orgId || !id) throw new Error('ListMappingService.updateTemplate: orgId and id are required');
  if (!patch || typeof patch !== 'object') throw new Error('patch object required');
  const exec = client || pool;
  const existing = await getTemplate({ orgId, id, client });
  if (!existing) throw new Error('mapping template not found');

  const sets = [];
  const params = [orgId, id];
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('name cannot be empty');
    params.push(patch.name.trim()); sets.push(`name = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceKind')) {
    params.push(VALID_SOURCE_KINDS.has(patch.sourceKind) ? patch.sourceKind : 'other');
    sets.push(`source_kind = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'mappings')) {
    params.push(JSON.stringify(cleanMappings(patch.mappings)));
    sets.push(`mappings = $${params.length}::jsonb`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'active')) {
    params.push(patch.active === true); sets.push(`active = $${params.length}`);
  }
  if (sets.length === 0) return existing;

  const { rows } = await exec.query(
    `UPDATE list_signal_mappings SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`,
    params
  ).catch((err) => {
    if (err && err.code === '23505') throw new Error('a mapping with that name already exists in this org');
    throw err;
  });
  return rowToTemplate(rows[0]);
}

async function retireTemplate({ orgId, id, client }) {
  return updateTemplate({ orgId, id, patch: { active: false }, client });
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  retireTemplate,
  rowToTemplate,
  VALID_SOURCE_KINDS,
};
