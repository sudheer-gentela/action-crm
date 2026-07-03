// ─────────────────────────────────────────────────────────────────────────────
// routes/list-mappings.routes.js
//
// Signal-Based Campaigns — Phase 6: the list column→signal mapping template
// library API. Org-shared, rep-addable (D10). These templates are selected in
// the import flow so a rep's Apollo/ZoomInfo export maps its qualifier columns
// to catalog signals without re-specifying the mapping each time.
//
//   GET    /api/list-mappings            list (?includeInactive)
//   POST   /api/list-mappings            create
//   GET    /api/list-mappings/:id        one
//   PUT    /api/list-mappings/:id        update
//   DELETE /api/list-mappings/:id        retire (soft)
//
// Org-scoped via req.orgId.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext } = require('../middleware/orgContext.middleware');
const ListMappingService = require('../services/ListMappingService');

router.use(authenticateToken);
router.use(orgContext);

router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const templates = await ListMappingService.listTemplates({ orgId: req.orgId, includeInactive });
    res.json({ templates });
  } catch (err) {
    console.error('list-mappings GET /', err);
    res.status(500).json({ error: { message: 'Failed to list mapping templates' } });
  }
});

router.post('/', async (req, res) => {
  const { name, source_kind, mappings } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: { message: 'name is required' } });
  try {
    const template = await ListMappingService.createTemplate({
      orgId: req.orgId,
      name,
      sourceKind: source_kind || 'csv',
      mappings: Array.isArray(mappings) ? mappings : [],
      createdBy: req.user.userId,
    });
    res.status(201).json({ template });
  } catch (err) {
    if (/already exists/.test(err.message)) return res.status(409).json({ error: { message: err.message } });
    if (/required|empty/i.test(err.message)) return res.status(400).json({ error: { message: err.message } });
    console.error('list-mappings POST /', err);
    res.status(500).json({ error: { message: 'Failed to create mapping template' } });
  }
});

router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'invalid id' } });
  try {
    const template = await ListMappingService.getTemplate({ orgId: req.orgId, id });
    if (!template) return res.status(404).json({ error: { message: 'Mapping template not found' } });
    res.json({ template });
  } catch (err) {
    console.error('list-mappings GET /:id', err);
    res.status(500).json({ error: { message: 'Failed to load mapping template' } });
  }
});

router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'invalid id' } });
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'name'))        patch.name = req.body.name;
  if (Object.prototype.hasOwnProperty.call(req.body, 'source_kind')) patch.sourceKind = req.body.source_kind;
  if (Object.prototype.hasOwnProperty.call(req.body, 'mappings'))    patch.mappings = req.body.mappings;
  if (Object.prototype.hasOwnProperty.call(req.body, 'active'))      patch.active = req.body.active;
  try {
    const template = await ListMappingService.updateTemplate({ orgId: req.orgId, id, patch });
    res.json({ template });
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    if (/already exists/.test(err.message)) return res.status(409).json({ error: { message: err.message } });
    if (/empty|invalid/i.test(err.message)) return res.status(400).json({ error: { message: err.message } });
    console.error('list-mappings PUT /:id', err);
    res.status(500).json({ error: { message: 'Failed to update mapping template' } });
  }
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: { message: 'invalid id' } });
  try {
    const template = await ListMappingService.retireTemplate({ orgId: req.orgId, id });
    res.json({ template });
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    console.error('list-mappings DELETE /:id', err);
    res.status(500).json({ error: { message: 'Failed to retire mapping template' } });
  }
});

module.exports = router;
