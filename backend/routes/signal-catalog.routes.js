// ─────────────────────────────────────────────────────────────────────────────
// routes/signal-catalog.routes.js
//
// Signal-Based Campaigns — Phase 4: the org-shared Signal Catalog API + the
// function-taxonomy read the catalog screen and the Targeting step consume.
//
// Two resources, one router (both are "the catalog surface"):
//
//   GET    /api/signal-catalog                list signals (resolved per ?function)
//   POST   /api/signal-catalog                role-aware create (rep vs admin)
//   GET    /api/signal-catalog/:key           one signal (resolved per ?function)
//   PUT    /api/signal-catalog/:key           edit rep-visible dimensions
//   PUT    /api/signal-catalog/:key/inferred  fix source/reliability/rep-added — admin only
//   DELETE /api/signal-catalog/:key           retire (soft) — admin only
//   GET    /api/signal-catalog/functions      the org's effective function taxonomy
//
// Org-shared (D10): any authenticated member can list/read and CREATE (a
// rep-created signal is tagged "rep-added"). Retiring is admin/owner-only —
// removing a signal affects everyone's campaigns, so it's the one destructive
// action we gate. Editing rep-visible fields is open (shared library, managed
// together); the HIDDEN dimensions (reliability/source_kind) are never writable
// through this surface — they're inferred, and only the admin-only setInferred
// path (not exposed here) can change them.
//
// RESOLUTION: role-relative signals (scope='target_role') carry placeholder
// tokens in their label ("New {leader} in seat"). The catalog screen shows a
// resolved_label per the selected function (?function=finance → "New CFO in
// seat"); with no function, the raw template is returned plus a flag so the UI
// renders the placeholder chip (design §4: "role-relative signals show a
// placeholder; fixed ones don't").
//
// Reps NEVER see reliability/source in responses — those fields are stripped
// from the rep view (design §4/D9). An ?admin=true view (admin/owner only)
// includes them for the Settings management table.
//
// All queries are org-scoped via req.orgId (set by orgContext).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const SignalRegistry = require('../services/SignalRegistryService');
const FunctionTaxonomy = require('../services/FunctionTaxonomyService');
const SignalPhraseInference = require('../services/SignalPhraseInference');

router.use(authenticateToken);
router.use(orgContext);

const adminOnly = requireRole('owner', 'admin');

// ─────────────────────────────────────────────────────────────────────────────
// Shaping helpers
// ─────────────────────────────────────────────────────────────────────────────

// Rep view: strip the hidden dimensions (reliability, sourceKind). Admin view:
// keep them for the management table.
function toRepView(def) {
  const { reliability, sourceKind, ...rest } = def;
  return rest;
}

// Resolve a def's label against a function (if role-relative). Returns the
// def plus resolved_label + is_role_relative. `fnMap` is a Map(key → fn).
function resolveDef(def, fn) {
  const isRoleRelative = def.scope === 'target_role' && FunctionTaxonomy.hasPlaceholders(def.label);
  const resolvedLabel = (isRoleRelative && fn)
    ? FunctionTaxonomy.resolveText(def.label, fn)
    : def.label;
  return { ...def, resolvedLabel, isRoleRelative };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET / — list the catalog
//   ?function=<key>   resolve role-relative labels for this function
//   ?functionTag=<k>  only signals offered in this function (tag match OR Any)
//   ?capability=filter|prioritize
//   ?admin=true       include hidden dimensions (admin/owner only)
//   ?includeInactive=true (admin/owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const functionKey = typeof req.query.function === 'string' && req.query.function.trim()
      ? req.query.function.trim().toLowerCase() : null;
    const functionTag = typeof req.query.functionTag === 'string' && req.query.functionTag.trim()
      ? req.query.functionTag.trim().toLowerCase() : null;
    const capability = ['filter', 'prioritize'].includes(req.query.capability)
      ? req.query.capability : null;

    const wantAdmin = req.query.admin === 'true';
    const includeInactive = req.query.includeInactive === 'true';
    const isAdmin = wantAdmin || includeInactive
      ? await isCallerAdmin(req) : false;

    const defs = await SignalRegistry.listDefs({
      orgId: req.orgId,
      functionTag,
      capability,
      includeInactive: includeInactive && isAdmin,
    });

    // Resolve labels against the selected function, if any.
    let fn = null;
    if (functionKey) {
      fn = await FunctionTaxonomy.getFunction({ orgId: req.orgId, key: functionKey });
    }

    const wantHidden = wantAdmin && isAdmin;
    const signals = defs.map((d) => {
      const resolved = resolveDef(d, fn);
      return wantHidden ? resolved : toRepView(resolved);
    });

    res.json({ signals, function: functionKey });
  } catch (err) {
    console.error('signal-catalog GET /', err);
    res.status(500).json({ error: { message: 'Failed to list signals' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /functions — the org's effective function taxonomy (P2).
// Used by the catalog's function selector and the Targeting step. Placeholders
// included so the UI can render resolved previews client-side.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/functions', async (req, res) => {
  try {
    const functions = await FunctionTaxonomy.listFunctions({ orgId: req.orgId });
    res.json({ functions });
  } catch (err) {
    console.error('signal-catalog GET /functions', err);
    res.status(500).json({ error: { message: 'Failed to list functions' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST / — create a signal. ROLE-AWARE (fix for "admin creates show rep-added"):
//
//   • Rep (member): rep-simple create, unchanged. Hidden dimensions inferred by
//     createRepSignal (source_kind='rep_validate' ⇒ reliability 'low' ⇒ clamped
//     to Prioritize-only + confirm-on-page). created_by set ⇒ "rep-added".
//
//   • Admin/owner: a deliberate CATALOG create via createDef. created_by is NOT
//     set (no rep-added tag), and the admin may state where the data comes from
//     (body.source_kind: list|enrich|harvest|dataset|rep_validate). Reliability
//     is inferred from that source (RULE 1 still clamps — an admin who leaves
//     source as 'rep_validate' still gets a Prioritize-only signal). Default
//     source for admins is 'dataset' (medium reliability ⇒ Filter allowed).
//
// Body: { key, label, description?, capability?, scope?, function_tags?,
//         predicate_type?, ttl_days?, default_hook?, source_kind? (admin only) }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    key, label, description,
    capability, scope, function_tags, predicate_type, ttl_days, default_hook,
    source_kind,
  } = req.body;

  if (!key || !String(key).trim()) return res.status(400).json({ error: { message: 'key is required' } });
  if (!label || !String(label).trim()) return res.status(400).json({ error: { message: 'label is required' } });

  try {
    const common = {
      orgId: req.orgId,
      key: String(key).trim(),
      label: String(label).trim(),
      description: description ?? null,
      capability: capability || 'prioritize',
      scope: scope || 'company',
      functionTags: Array.isArray(function_tags) ? function_tags : [],
      predicateType: predicate_type || 'boolean',
      ttlDays: Number.isInteger(ttl_days) ? ttl_days : null,
      defaultHook: default_hook ?? null,
    };

    let def;
    if (await isCallerAdmin(req)) {
      const sk = typeof source_kind === 'string' && source_kind.trim()
        ? source_kind.trim() : 'dataset';
      if (!SignalRegistry.VALID_SOURCE_KIND.has(sk)) {
        return res.status(400).json({ error: { message: `invalid source_kind "${sk}"` } });
      }
      def = await SignalRegistry.createDef({
        ...common,
        sourceKind: sk,            // reliability inferred from source
        createdBy: null,           // catalog signal — NOT "rep-added"
      });
    } else {
      def = await SignalRegistry.createRepSignal({
        ...common,
        userId: req.userId,        // ⇒ "rep-added"
      });
    }

    const functionKey = typeof req.query.function === 'string' && req.query.function.trim()
      ? req.query.function.trim().toLowerCase() : null;
    const fn = functionKey ? await FunctionTaxonomy.getFunction({ orgId: req.orgId, key: functionKey }) : null;

    res.status(201).json({ signal: toRepView(resolveDef(def, fn)) });
  } catch (err) {
    if (/already exists/.test(err.message)) return res.status(409).json({ error: { message: err.message } });
    if (/invalid|required/i.test(err.message)) return res.status(400).json({ error: { message: err.message } });
    console.error('signal-catalog POST /', err);
    res.status(500).json({ error: { message: 'Failed to create signal' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /infer-role — Light Inference (Q-B) for the create flow.
// The rep types a plain-words label; if it embeds a recognized role title
// ("New CFO hired"), we propose a tokenized, function-general version
// ("New {leader} hired") + a resolved preview per candidate function. The rep
// confirms — nothing is auto-applied. Ambiguous titles return >1 function so
// the UI can ask. MUST be declared before GET '/:key'.
// Body: { label }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/infer-role', async (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label : '';
  try {
    const suggestion = await SignalPhraseInference.inferForOrg({ orgId: req.orgId, label });
    res.json({ suggestion });
  } catch (err) {
    console.error('signal-catalog POST /infer-role', err);
    res.status(500).json({ error: { message: 'Failed to analyze the label' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:key — one signal, resolved per ?function.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:key', async (req, res) => {
  try {
    const def = await SignalRegistry.getDef({ orgId: req.orgId, key: req.params.key });
    if (!def) return res.status(404).json({ error: { message: 'Signal not found' } });

    const functionKey = typeof req.query.function === 'string' && req.query.function.trim()
      ? req.query.function.trim().toLowerCase() : null;
    const fn = functionKey ? await FunctionTaxonomy.getFunction({ orgId: req.orgId, key: functionKey }) : null;

    const wantHidden = req.query.admin === 'true' && await isCallerAdmin(req);
    const resolved = resolveDef(def, fn);
    res.json({ signal: wantHidden ? resolved : toRepView(resolved) });
  } catch (err) {
    console.error('signal-catalog GET /:key', err);
    res.status(500).json({ error: { message: 'Failed to load signal' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:key — edit rep-visible dimensions (label, description, capability,
// scope, function_tags, predicate_type, ttl_days, default_hook, active).
// Hidden dimensions are NOT accepted here. capability is re-clamped by the
// service against stored reliability (RULE 1 can't be escaped by edit).
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:key', async (req, res) => {
  const patch = {};
  const b = req.body || {};
  if (Object.prototype.hasOwnProperty.call(b, 'label'))          patch.label = b.label;
  if (Object.prototype.hasOwnProperty.call(b, 'description'))    patch.description = b.description;
  if (Object.prototype.hasOwnProperty.call(b, 'capability'))     patch.capability = b.capability;
  if (Object.prototype.hasOwnProperty.call(b, 'scope'))          patch.scope = b.scope;
  if (Object.prototype.hasOwnProperty.call(b, 'function_tags'))  patch.function_tags = b.function_tags;
  if (Object.prototype.hasOwnProperty.call(b, 'predicate_type')) patch.predicate_type = b.predicate_type;
  if (Object.prototype.hasOwnProperty.call(b, 'ttl_days'))       patch.ttl_days = b.ttl_days;
  if (Object.prototype.hasOwnProperty.call(b, 'default_hook'))   patch.default_hook = b.default_hook;
  if (Object.prototype.hasOwnProperty.call(b, 'active'))         patch.active = b.active === true;

  try {
    const def = await SignalRegistry.updateDef({ orgId: req.orgId, key: req.params.key, patch });
    res.json({ signal: toRepView(def) });
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    if (/invalid/i.test(err.message)) return res.status(400).json({ error: { message: err.message } });
    console.error('signal-catalog PUT /:key', err);
    res.status(500).json({ error: { message: 'Failed to update signal' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:key/inferred — admin/owner only: correct the HIDDEN dimensions of an
// existing signal (the setInferred path, now exposed). Used to rescue signals
// mis-created through the rep path: fixing source_kind re-infers reliability
// (unless reliability is given explicitly) and re-clamps capability. Pass
// clear_rep_added=true to also drop the "rep-added" attribution ("promote to
// catalog signal").
//
// Body: { reliability?, source_kind?, clear_rep_added? }
// NOTE: declared before nothing that conflicts — PUT '/:key' matches a single
// path segment only, so '/:key/inferred' is unambiguous either way.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:key/inferred', adminOnly, async (req, res) => {
  const b = req.body || {};
  try {
    const def = await SignalRegistry.setInferred({
      orgId: req.orgId,
      key: req.params.key,
      reliability: typeof b.reliability === 'string' && b.reliability.trim() ? b.reliability.trim() : null,
      sourceKind: typeof b.source_kind === 'string' && b.source_kind.trim() ? b.source_kind.trim() : null,
      clearCreatedBy: b.clear_rep_added === true,
    });
    res.json({ signal: def });   // admin surface — hidden dimensions included
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    if (/invalid/i.test(err.message)) return res.status(400).json({ error: { message: err.message } });
    console.error('signal-catalog PUT /:key/inferred', err);
    res.status(500).json({ error: { message: 'Failed to update signal data quality' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:key — retire (soft). Admin/owner only (affects every campaign).
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:key', adminOnly, async (req, res) => {
  try {
    const def = await SignalRegistry.retireDef({ orgId: req.orgId, key: req.params.key });
    res.json({ signal: toRepView(def) });
  } catch (err) {
    if (/not found/.test(err.message)) return res.status(404).json({ error: { message: err.message } });
    console.error('signal-catalog DELETE /:key', err);
    res.status(500).json({ error: { message: 'Failed to retire signal' } });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// isCallerAdmin — authoritative role check (same source as requireRole), used
// for the ?admin=true / ?includeInactive views. A non-admin who passes those
// flags just gets the rep view rather than a 403, so the flags are harmless.
// ─────────────────────────────────────────────────────────────────────────────
async function isCallerAdmin(req) {
  const { pool } = require('../config/database');
  const { rows } = await pool.query(
    `SELECT role FROM org_users WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE`,
    [req.userId, req.orgId]
  );
  const role = rows[0]?.role;
  return role === 'owner' || role === 'admin';
}

module.exports = router;
