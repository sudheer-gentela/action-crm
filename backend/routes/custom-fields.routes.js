/**
 * /api/custom-fields
 *
 * The custom-fields subsystem API (Phase B). Self-contained: it does not touch
 * the prospect/account route handlers — the frontend composes custom-field
 * values alongside entity data via the /values endpoints (bulk read supported).
 *
 * DEFINITIONS (custom_field_defs) — the org's catalog of custom columns.
 *   GET    /defs            List defs. ?targetEntity=account|prospect
 *                           ?campaignId=<id> also returns that campaign's
 *                           campaign-only defs. ?includeInactive=true to show
 *                           deactivated ones. (any org user)
 *   POST   /defs            Create a def. (admin)
 *   PUT    /defs/:id         Update label/type/options/order/active. (admin)
 *   DELETE /defs/:id         Deactivate (soft delete). (admin)
 *
 * VALUES (entity_custom_fields) — durable (entity-level) + campaign-scoped.
 *   GET    /values          Read values for one entity (?entityId=) or many
 *                           (?entityIds=1,2,3). ?campaignId= adds the scoped
 *                           plane; ?includeDurable=false to omit the durable one.
 *   PUT    /values          Write one value. Must match a defined field (the
 *                           governing def is resolved; campaign-specific wins).
 *   POST   /values/promote  Promote a campaign-scoped value to the durable twin.
 *   DELETE /values          Clear one value (durable or campaign-scoped).
 *
 * Authz: prospecting module required for all. Any org user may read defs and
 * read/write values (reps fill data during research). Only owner/admin may
 * create/update/deactivate definitions.
 */

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const requireModule = require('../middleware/requireModule.middleware');

const Defs = require('../services/CustomFieldDefService');
const CF   = require('../services/CustomFieldService');
const Import = require('../services/CustomFieldImportService');

router.use(authenticateToken);
router.use(orgContext);
router.use(requireModule('prospecting'));

const adminOnly = requireRole('owner', 'admin');

const VALUE_ENTITY_TYPES = new Set(['account', 'prospect']); // defs target these
const VALID_SOURCES = new Set(['manual', 'csv', 'ai_research', 'crm_sync']);

const bad   = (res, msg, code = 400) => res.status(code).json({ error: { message: msg } });
const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/defs', async (req, res) => {
  try {
    const targetEntity = req.query.targetEntity || null;
    if (targetEntity && !Defs.VALID_TARGET.has(targetEntity)) {
      return bad(res, 'targetEntity must be account or prospect');
    }
    const campaignId = req.query.campaignId != null ? toInt(req.query.campaignId) : null;
    if (req.query.campaignId != null && campaignId === null) return bad(res, 'campaignId must be an integer');

    const defs = await Defs.listDefs({
      orgId: req.orgId,
      targetEntity,
      campaignId,
      includeInactive: req.query.includeInactive === 'true',
    });
    return res.json({ defs });
  } catch (err) {
    console.error('custom-fields GET /defs error:', err);
    return bad(res, 'Failed to list custom field definitions', 500);
  }
});

router.post('/defs', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const campaignId = b.campaignId != null ? toInt(b.campaignId) : null;
    if (b.campaignId != null && campaignId === null) return bad(res, 'campaignId must be an integer');

    const def = await Defs.createDef({
      orgId: req.orgId,
      targetEntity: b.targetEntity,
      fieldKey: b.fieldKey,
      label: b.label ?? null,
      fieldType: b.fieldType || 'text',
      picklistOptions: b.picklistOptions ?? [],
      displayOrder: Number.isInteger(b.displayOrder) ? b.displayOrder : 0,
      campaignId,
    });
    return res.status(201).json({ def });
  } catch (err) {
    if (err.code === '23505') return bad(res, 'A field with this key already exists in this scope', 409);
    if (err.code === '23503') return bad(res, 'Referenced campaign does not exist', 400);
    if (/invalid|must be/i.test(err.message)) return bad(res, err.message, 400);
    console.error('custom-fields POST /defs error:', err);
    return bad(res, 'Failed to create custom field definition', 500);
  }
});

router.put('/defs/:id', adminOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (id === null) return bad(res, 'invalid id');
    const def = await Defs.updateDef({ orgId: req.orgId, id, patch: req.body || {} });
    if (!def) return bad(res, 'Definition not found', 404);
    return res.json({ def });
  } catch (err) {
    if (/invalid|must be/i.test(err.message)) return bad(res, err.message, 400);
    console.error('custom-fields PUT /defs/:id error:', err);
    return bad(res, 'Failed to update custom field definition', 500);
  }
});

router.delete('/defs/:id', adminOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    if (id === null) return bad(res, 'invalid id');
    const def = await Defs.deactivateDef({ orgId: req.orgId, id });
    if (!def) return bad(res, 'Definition not found', 404);
    return res.json({ def, deactivated: true });
  } catch (err) {
    console.error('custom-fields DELETE /defs/:id error:', err);
    return bad(res, 'Failed to deactivate custom field definition', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VALUES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/values', async (req, res) => {
  try {
    const entityType = req.query.entityType;
    if (!VALUE_ENTITY_TYPES.has(entityType)) return bad(res, 'entityType must be account or prospect');

    let entityIds = [];
    if (req.query.entityIds) {
      entityIds = String(req.query.entityIds).split(',').map(toInt).filter(n => n !== null);
    } else if (req.query.entityId) {
      const one = toInt(req.query.entityId);
      if (one === null) return bad(res, 'entityId must be an integer');
      entityIds = [one];
    }
    if (entityIds.length === 0) return bad(res, 'provide entityId or entityIds');

    const campaignId = req.query.campaignId != null ? toInt(req.query.campaignId) : null;
    if (req.query.campaignId != null && campaignId === null) return bad(res, 'campaignId must be an integer');
    const includeDurable = req.query.includeDurable !== 'false';

    const map = await CF.readValues({
      orgId: req.orgId, entityType, entityIds, campaignId, includeDurable,
    });

    // Single-entity callers get a flat array; bulk callers get a keyed object.
    if (req.query.entityId && !req.query.entityIds) {
      return res.json({ values: map.get(entityIds[0]) || [] });
    }
    const out = {};
    for (const id of entityIds) out[id] = map.get(id) || [];
    return res.json({ values: out });
  } catch (err) {
    console.error('custom-fields GET /values error:', err);
    return bad(res, 'Failed to read custom field values', 500);
  }
});

router.put('/values', async (req, res) => {
  try {
    const b = req.body || {};
    const { entityType, fieldKey } = b;
    const entityId = toInt(b.entityId);
    if (!VALUE_ENTITY_TYPES.has(entityType)) return bad(res, 'entityType must be account or prospect');
    if (entityId === null) return bad(res, 'entityId must be an integer');
    if (!fieldKey) return bad(res, 'fieldKey is required');

    const campaignId = b.campaignId != null ? toInt(b.campaignId) : null;
    if (b.campaignId != null && campaignId === null) return bad(res, 'campaignId must be an integer');

    const source = b.source || 'manual';
    if (!VALID_SOURCES.has(source)) return bad(res, `source must be one of ${[...VALID_SOURCES].join(', ')}`);

    // A value can only be written against a defined field (campaign-specific wins).
    const def = await Defs.resolveDef({ orgId: req.orgId, targetEntity: entityType, fieldKey, campaignId });
    if (!def) return bad(res, `No active "${fieldKey}" field defined for ${entityType} in this scope`, 400);

    // Picklist guard.
    if (def.field_type === 'picklist' && b.value != null && b.value !== '') {
      const opts = Array.isArray(def.picklist_options) ? def.picklist_options : [];
      if (opts.length && !opts.includes(b.value)) {
        return bad(res, `value must be one of: ${opts.join(', ')}`);
      }
    }

    const row = await CF.writeValue({
      orgId: req.orgId, entityType, entityId, fieldKey,
      fieldType: def.field_type, fieldLabel: def.label, fieldDefId: def.id,
      value: b.value, campaignId, source,
    });
    return res.json({ value: row });
  } catch (err) {
    if (err.code === '23503') return bad(res, 'Referenced campaign does not exist', 400);
    if (/invalid|required|unknown field_type/i.test(err.message)) return bad(res, err.message, 400);
    console.error('custom-fields PUT /values error:', err);
    return bad(res, 'Failed to write custom field value', 500);
  }
});

router.post('/values/promote', async (req, res) => {
  try {
    const b = req.body || {};
    const { entityType, fieldKey } = b;
    const entityId = toInt(b.entityId);
    const campaignId = toInt(b.campaignId);
    if (!VALUE_ENTITY_TYPES.has(entityType)) return bad(res, 'entityType must be account or prospect');
    if (entityId === null) return bad(res, 'entityId must be an integer');
    if (!fieldKey) return bad(res, 'fieldKey is required');
    if (campaignId === null) return bad(res, 'campaignId is required (the source scope)');

    const source = b.source || 'manual';
    if (!VALID_SOURCES.has(source)) return bad(res, `source must be one of ${[...VALID_SOURCES].join(', ')}`);

    const row = await CF.promote({ orgId: req.orgId, entityType, entityId, fieldKey, campaignId, source });
    if (!row) return bad(res, 'No campaign-scoped value to promote', 404);
    return res.json({ value: row, promoted: true });
  } catch (err) {
    console.error('custom-fields POST /values/promote error:', err);
    return bad(res, 'Failed to promote custom field value', 500);
  }
});

router.delete('/values', async (req, res) => {
  try {
    const src = Object.keys(req.body || {}).length ? req.body : req.query;
    const { entityType, fieldKey } = src;
    const entityId = toInt(src.entityId);
    if (!VALUE_ENTITY_TYPES.has(entityType)) return bad(res, 'entityType must be account or prospect');
    if (entityId === null) return bad(res, 'entityId must be an integer');
    if (!fieldKey) return bad(res, 'fieldKey is required');

    const campaignId = src.campaignId != null ? toInt(src.campaignId) : null;
    if (src.campaignId != null && campaignId === null) return bad(res, 'campaignId must be an integer');

    const result = await CF.deleteValue({ orgId: req.orgId, entityType, entityId, fieldKey, campaignId });
    return res.json(result);
  } catch (err) {
    console.error('custom-fields DELETE /values error:', err);
    return bad(res, 'Failed to delete custom field value', 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BULK IMPORT (CSV → durable values). Admin only; dry-run by default.
// Body: { targetEntity, rows[], matchBy, columnMap[], createDefs?, dryRun?, campaignId? }
//   rows       — parsed CSV rows (objects keyed by header); frontend parses CSV.
//   matchBy    — which key identifies the entity (prospect: id|email|linkedin_url,
//                account: id|domain|name).
//   columnMap  — [{ column, fieldKey, fieldType?, label? }, …]
//   createDefs — auto-create missing defs (effective only on a committed run).
//   dryRun     — defaults TRUE: preview match/cast/def outcomes, write nothing.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/import', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (!VALUE_ENTITY_TYPES.has(b.targetEntity)) return bad(res, 'targetEntity must be account or prospect');
    if (!Array.isArray(b.rows) || b.rows.length === 0) return bad(res, 'rows must be a non-empty array');
    if (!b.matchBy) return bad(res, 'matchBy is required');
    if (!Array.isArray(b.columnMap) || b.columnMap.length === 0) return bad(res, 'columnMap must be a non-empty array');

    const campaignId = b.campaignId != null ? toInt(b.campaignId) : null;
    if (b.campaignId != null && campaignId === null) return bad(res, 'campaignId must be an integer');

    // dry-run-first: anything other than an explicit false is treated as a dry run.
    const dryRun = b.dryRun !== false;

    const summary = await Import.runImport({
      orgId: req.orgId,
      targetEntity: b.targetEntity,
      rows: b.rows,
      matchBy: b.matchBy,
      columnMap: b.columnMap,
      createDefs: b.createDefs === true,
      dryRun,
      campaignId,
    });
    return res.json(summary);
  } catch (err) {
    if (/Maximum|must be|unsupported|non-empty/i.test(err.message)) return bad(res, err.message, 400);
    if (err.code === '23503') return bad(res, 'Referenced campaign does not exist', 400);
    console.error('custom-fields POST /import error:', err);
    return bad(res, 'Failed to import custom field values', 500);
  }
});

module.exports = router;
