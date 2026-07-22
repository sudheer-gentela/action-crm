/**
 * skill-bundles.routes.js
 *
 * DROP-IN LOCATION: backend/routes/skill-bundles.routes.js
 *
 * Mount in server.js (next to the skills mounts ~line 195):
 *   app.use('/api/skill-bundles', require('./routes/skill-bundles.routes'));
 *
 * The versioned-skills surface (2026_63). Auth + orgContext on everything;
 * mutations require admin/owner. Platform-scope publishing is super-admin
 * territory and lives on the CLI (scripts/publish-skill.js) + the super-admin
 * router if/when a UI is wanted — deliberately NOT exposed here.
 *
 *   GET    /                       — bundles visible to this org (platform +
 *                                    own), with pinned_by_this_org flag
 *   GET    /installed              — this org's pins
 *   GET    /:id                    — bundle detail incl. file list (no bodies)
 *   GET    /:id/files/:path        — one file body (path URL-encoded)
 *   GET    /diff?from=:id&to=:id   — per-file diff between two versions
 *   POST   /:id/install            — pin this org to a bundle
 *                                    body: { force?: bool } to override unmet
 *                                    requirements
 *   DELETE /installed/:skillName   — unpin (revert to platform/disk)
 *   GET    /:id/export             — download the transferable artifact
 *   POST   /import                 — import a bundle artifact (org-scoped)
 *   POST   /publish-from-disk      — org-scope publish of a disk skill
 *                                    (repo-based authoring for org custom
 *                                    methodologies; platform scope is CLI-only)
 *   POST   /:id/archive            — archive an org-owned bundle
 */

const express = require('express');
const router  = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const { orgContext, requireRole } = require('../middleware/orgContext.middleware');
const skillBundles = require('../services/skillBundles.service');
const { SKILL_REGISTRY } = require('../services/SkillRunnerService');

router.use(authenticateToken);
router.use(orgContext);

function _err(res, err) {
  const status = err.statusCode || 500;
  if (status >= 500) console.error('[skill-bundles]', err.message);
  res.status(status).json({ success: false, error: err.message, unmet: err.unmet });
}

// ── GET / ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const bundles = await skillBundles.listBundles(req.orgId, { name: req.query.name });
    // Flag bundles whose skill name isn't runnable (not in the code registry).
    const known = new Set(Object.keys(SKILL_REGISTRY));
    res.json({
      success: true,
      bundles: bundles.map(b => ({ ...b, runnable: known.has(b.name) })),
    });
  } catch (err) { _err(res, err); }
});

// ── GET /installed ───────────────────────────────────────────────────────────

router.get('/installed', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const rows = await pool.query(`
      SELECT osi.skill_name, osi.bundle_id, osi.installed_at,
             sb.version, sb.scope, sb.checksum
      FROM org_skill_installs osi
      JOIN skill_bundles sb ON sb.id = osi.bundle_id
      WHERE osi.org_id = $1
      ORDER BY osi.skill_name
    `, [req.orgId]);
    res.json({ success: true, installs: rows.rows });
  } catch (err) { _err(res, err); }
});

// ── GET /diff (before /:id so 'diff' isn't captured as an id) ────────────────

router.get('/diff', async (req, res) => {
  try {
    const from = parseInt(req.query.from, 10);
    const to   = parseInt(req.query.to, 10);
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from and to bundle ids required' });
    }
    const diff = await skillBundles.diffBundles(from, to, req.orgId);
    res.json({ success: true, ...diff });
  } catch (err) { _err(res, err); }
});

// ── GET /:id ─────────────────────────────────────────────────────────────────

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const rows = await pool.query(`
      SELECT id, scope, owner_org_id, name, version, status, manifest,
             checksum, published_at, published_by, files
      FROM skill_bundles
      WHERE id = $1 AND (owner_org_id IS NULL OR owner_org_id = $2)
    `, [req.params.id, req.orgId]);
    if (!rows.rows.length) return res.status(404).json({ success: false, error: 'Bundle not found' });
    const b = rows.rows[0];
    const fileIndex = Object.entries(b.files || {}).map(([p, c]) => ({
      path: p, bytes: Buffer.byteLength(String(c), 'utf8'),
    }));
    delete b.files;
    res.json({ success: true, bundle: { ...b, files: fileIndex } });
  } catch (err) { _err(res, err); }
});

// ── GET /:id/files/:path ─────────────────────────────────────────────────────

router.get('/:id(\\d+)/files/*', async (req, res) => {
  try {
    const { pool } = require('../config/database');
    const rel = decodeURIComponent(req.params[0] || '');
    const rows = await pool.query(`
      SELECT files -> $3 AS body FROM skill_bundles
      WHERE id = $1 AND (owner_org_id IS NULL OR owner_org_id = $2)
    `, [req.params.id, req.orgId, rel]);
    if (!rows.rows.length || rows.rows[0].body == null) {
      return res.status(404).json({ success: false, error: 'File not found in bundle' });
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(rows.rows[0].body);
  } catch (err) { _err(res, err); }
});

// ── POST /:id/install ────────────────────────────────────────────────────────

router.post('/:id(\\d+)/install', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await skillBundles.installBundle(req.orgId, parseInt(req.params.id, 10), {
      installedBy: req.userId,
      force: req.body && req.body.force === true,
    });
    res.json({ success: true, ...result });
  } catch (err) { _err(res, err); }
});

// ── DELETE /installed/:skillName ─────────────────────────────────────────────

router.delete('/installed/:skillName', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await skillBundles.uninstall(req.orgId, req.params.skillName);
    res.json({ success: true, ...result });
  } catch (err) { _err(res, err); }
});

// ── GET /:id/export ──────────────────────────────────────────────────────────

router.get('/:id(\\d+)/export', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const artifact = await skillBundles.exportBundle(parseInt(req.params.id, 10), req.orgId);
    res.set('Content-Disposition',
      `attachment; filename="${artifact.name}-${artifact.version}.gowarm-skill.json"`);
    res.json(artifact);
  } catch (err) { _err(res, err); }
});

// ── POST /import ─────────────────────────────────────────────────────────────

router.post('/import', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await skillBundles.importBundle(req.orgId, req.body, { publishedBy: req.userId });
    res.json({ success: true, ...result });
  } catch (err) { _err(res, err); }
});

// ── POST /publish-from-disk (org scope only from this surface) ───────────────

router.post('/publish-from-disk', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const { skill_name, version, manifest } = req.body || {};
    if (!skill_name || !version) {
      return res.status(400).json({ success: false, error: 'skill_name and version required' });
    }
    const result = await skillBundles.publishFromDisk(skill_name, {
      version, scope: 'org', orgId: req.orgId,
      publishedBy: req.userId, manifest: manifest || {},
    });
    res.json({ success: true, ...result });
  } catch (err) { _err(res, err); }
});

// ── POST /:id/archive ────────────────────────────────────────────────────────

router.post('/:id(\\d+)/archive', requireRole('admin', 'owner'), async (req, res) => {
  try {
    const result = await skillBundles.archiveBundle(parseInt(req.params.id, 10), req.orgId);
    res.json({ success: true, ...result });
  } catch (err) { _err(res, err); }
});

module.exports = router;
