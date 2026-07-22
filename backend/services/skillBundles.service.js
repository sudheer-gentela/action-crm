/**
 * skillBundles.service.js
 *
 * DROP-IN LOCATION: backend/services/skillBundles.service.js
 *
 * The Phase 2 skill-versioning layer (2026_63). Owns:
 *
 *   resolveForRun(orgId, skillName, methodology, allowedMethodologies)
 *       → { bundle, bundleId, version, source: 'org'|'platform' } | null
 *     Resolution: org pin → newest published platform bundle → null (the
 *     runner falls back to its own disk loader — no import cycle, and 'disk'
 *     attribution stays in the runner). Cached 60s per (orgId, skillName),
 *     same TTL pattern as requireModule. The returned runtime bundle matches
 *     loadSkill()'s shape exactly: { skillMd, methodology, files } with only
 *     the REQUESTED methodology file included — publish stores all
 *     methodology files, runtime filters, identical to disk behaviour.
 *
 *   publishFromDisk(skillName, { version, scope, orgId, publishedBy })
 *     Repo-based authoring stays exactly what it is today: author under
 *     backend/skills/<name>/, publish captures the folder into a bundle row.
 *     Version must be strictly greater than the newest existing version in
 *     that scope. Reads SKILL.md + templates/ reference/ schema/
 *     methodologies/ (ALL methodology files — runtime filters).
 *
 *   installBundle / uninstall — explicit version pins (org_skill_installs).
 *     Install validates manifest.requires.playbook_stages against the org's
 *     deal_stages; unmet requirements block unless { force: true }.
 *
 *   exportBundle / importBundle — the transferable artifact:
 *       { format: 'gowarm-skill-bundle@1', name, version, manifest, files,
 *         checksum }
 *     Checksum is sha256 integrity (tamper detection), NOT authenticity —
 *     stated plainly so nobody mistakes it for signing. Import creates an
 *     ORG-scoped bundle owned by the importing org (partner registry is the
 *     Phase 4 extension of exactly this path).
 *
 *   diffBundles(idA, idB, orgId) — per-file added/removed/changed + compact
 *     line-level LCS diff for the approval/review UI.
 *
 * Published bundles are immutable by service contract: new version = new row;
 * archive, never edit.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { pool } = require('../config/database');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const BUNDLE_FORMAT = 'gowarm-skill-bundle@1';

const MAX_FILES        = 200;
const MAX_TOTAL_BYTES  = 2 * 1024 * 1024;  // 2 MB per bundle
const MAX_DIFF_BYTES   = 200 * 1024;       // per-file diff ceiling

// ── semver (strict X.Y.Z) ────────────────────────────────────────────────────

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGt(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

// ── checksum ─────────────────────────────────────────────────────────────────

function computeChecksum(name, version, files) {
  const h = crypto.createHash('sha256');
  h.update(`${name}@${version}`);
  for (const key of Object.keys(files).sort()) {
    h.update('\u0000' + key + '\u0000');
    h.update(String(files[key]));
  }
  return h.digest('hex');
}

// ── resolution cache ─────────────────────────────────────────────────────────

const _cache = new Map(); // `${orgId}:${skillName}` → { row|null, ts }
const TTL = 60_000;

function bustCache() { _cache.clear(); }

async function _resolveRow(orgId, skillName) {
  const key = `${orgId}:${skillName}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.row;

  // 1. org pin
  const pin = await pool.query(`
    SELECT sb.* FROM org_skill_installs osi
    JOIN skill_bundles sb ON sb.id = osi.bundle_id
    WHERE osi.org_id = $1 AND osi.skill_name = $2 AND sb.status = 'published'
  `, [orgId, skillName]);
  let row = pin.rows[0] || null;

  // 2. newest platform bundle (semver order, not published_at — a re-publish
  //    of an old version must not shadow a newer one)
  if (!row) {
    const plats = await pool.query(`
      SELECT * FROM skill_bundles
      WHERE scope = 'platform' AND name = $1 AND status = 'published'
    `, [skillName]);
    for (const r of plats.rows) {
      if (!row || semverGt(r.version, row.version)) row = r;
    }
  }

  _cache.set(key, { row, ts: Date.now() });
  return row;
}

/** DB bundle row → runtime bundle in loadSkill()'s exact shape. */
function toRuntimeBundle(row, methodology, allowedMethodologies) {
  const files = row.files || {};
  const skillMd = files['SKILL.md'];
  if (!skillMd) return null;   // malformed bundle — caller falls back to disk

  const out = { skillMd, methodology: methodology || null, files: {} };
  for (const [rel, content] of Object.entries(files)) {
    if (rel === 'SKILL.md') continue;
    if (rel.startsWith('methodologies/')) continue;   // filtered below
    out.files[rel] = content;
  }
  if (methodology && (!allowedMethodologies || allowedMethodologies.has(methodology))) {
    const mKey = `methodologies/${methodology}.md`;
    if (files[mKey]) out.files[mKey] = files[mKey];
    else console.warn(`[skill-bundles] methodology file not in bundle ${row.id}: ${mKey}`);
  }
  return out;
}

async function resolveForRun(orgId, skillName, methodology, allowedMethodologies) {
  try {
    const row = await _resolveRow(orgId, skillName);
    if (!row) return null;
    const bundle = toRuntimeBundle(row, methodology, allowedMethodologies);
    if (!bundle) {
      console.warn(`[skill-bundles] bundle ${row.id} (${row.name}@${row.version}) has no SKILL.md — falling back to disk`);
      return null;
    }
    return {
      bundle,
      bundleId: row.id,
      version: row.version,
      source: row.scope === 'org' ? 'org' : 'platform',
    };
  } catch (err) {
    // Resolution must never take the skill runner down — disk always works.
    console.warn(`[skill-bundles] resolve failed for ${skillName} org ${orgId}: ${err.message}`);
    return null;
  }
}

// ── disk read (publish path) ─────────────────────────────────────────────────

function readSkillDirAsFiles(skillName) {
  const root = path.join(SKILLS_DIR, skillName);
  const mdPath = path.join(root, 'SKILL.md');
  if (!fs.existsSync(mdPath)) {
    throw Object.assign(new Error(`Skill folder not found on disk: ${skillName}`), { statusCode: 404 });
  }
  const files = { 'SKILL.md': fs.readFileSync(mdPath, 'utf8') };
  for (const sub of ['templates', 'reference', 'schema', 'methodologies']) {
    const subPath = path.join(root, sub);
    if (!fs.existsSync(subPath)) continue;
    for (const file of fs.readdirSync(subPath)) {
      const full = path.join(subPath, file);
      if (!fs.statSync(full).isFile()) continue;
      files[`${sub}/${file}`] = fs.readFileSync(full, 'utf8');
    }
  }
  return files;
}

function _validateFiles(files) {
  const keys = Object.keys(files || {});
  if (!keys.length) throw Object.assign(new Error('Bundle has no files'), { statusCode: 400 });
  if (!files['SKILL.md']) throw Object.assign(new Error('Bundle must contain SKILL.md'), { statusCode: 400 });
  if (keys.length > MAX_FILES) throw Object.assign(new Error(`Bundle exceeds ${MAX_FILES} files`), { statusCode: 400 });
  let total = 0;
  for (const k of keys) {
    if (typeof files[k] !== 'string') throw Object.assign(new Error(`File ${k} is not text`), { statusCode: 400 });
    if (k.includes('..') || k.startsWith('/') || /[\u0000\\]/.test(k)) {
      throw Object.assign(new Error(`Illegal file path in bundle: ${k}`), { statusCode: 400 });
    }
    total += Buffer.byteLength(files[k], 'utf8');
  }
  if (total > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error(`Bundle exceeds ${MAX_TOTAL_BYTES} bytes`), { statusCode: 400 });
  }
}

// ── publish ──────────────────────────────────────────────────────────────────

async function publishFromDisk(skillName, { version, scope = 'platform', orgId = null, publishedBy = null, manifest = {} }) {
  if (!parseSemver(version)) {
    throw Object.assign(new Error('version must be strict semver X.Y.Z'), { statusCode: 400 });
  }
  if (scope === 'org' && !orgId) {
    throw Object.assign(new Error('org scope requires orgId'), { statusCode: 400 });
  }

  const files = readSkillDirAsFiles(skillName);
  _validateFiles(files);

  // Monotonic version rule within the scope.
  const existing = await pool.query(
    scope === 'platform'
      ? `SELECT version FROM skill_bundles WHERE scope='platform' AND name=$1`
      : `SELECT version FROM skill_bundles WHERE scope='org' AND owner_org_id=$2 AND name=$1`,
    scope === 'platform' ? [skillName] : [skillName, orgId]);
  for (const r of existing.rows) {
    if (!semverGt(version, r.version)) {
      throw Object.assign(
        new Error(`version ${version} must be greater than existing ${r.version}`),
        { statusCode: 409 });
    }
  }

  const finalManifest = { ...manifest, published_from: 'disk' };
  const checksum = computeChecksum(skillName, version, files);

  const ins = await pool.query(`
    INSERT INTO skill_bundles
      (scope, owner_org_id, name, version, manifest, files, checksum, published_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
  `, [scope, scope === 'org' ? orgId : null, skillName, version,
      JSON.stringify(finalManifest), JSON.stringify(files), checksum, publishedBy]);

  bustCache();
  return { bundleId: ins.rows[0].id, name: skillName, version, scope, checksum, fileCount: Object.keys(files).length };
}

// ── install / uninstall (pins) ───────────────────────────────────────────────

async function installBundle(orgId, bundleId, { installedBy = null, force = false } = {}) {
  const b = await pool.query(`
    SELECT * FROM skill_bundles
    WHERE id = $1 AND status = 'published'
      AND (owner_org_id IS NULL OR owner_org_id = $2)
  `, [bundleId, orgId]);
  if (!b.rows.length) {
    throw Object.assign(new Error('Bundle not found or not visible to this org'), { statusCode: 404 });
  }
  const row = b.rows[0];

  // Dependency check: required playbook stages must exist in this org.
  const requires = (row.manifest && row.manifest.requires) || {};
  const unmet = [];
  if (Array.isArray(requires.playbook_stages) && requires.playbook_stages.length) {
    const st = await pool.query(`SELECT key FROM deal_stages WHERE org_id = $1`, [orgId]);
    const have = new Set(st.rows.map(r => r.key));
    for (const need of requires.playbook_stages) {
      if (!have.has(need)) unmet.push(`playbook stage '${need}'`);
    }
  }
  if (unmet.length && !force) {
    throw Object.assign(
      new Error(`Unmet requirements: ${unmet.join(', ')}. Pass force=true to install anyway.`),
      { statusCode: 409, unmet });
  }

  await pool.query(`
    INSERT INTO org_skill_installs (org_id, skill_name, bundle_id, installed_by)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (org_id, skill_name)
    DO UPDATE SET bundle_id = EXCLUDED.bundle_id,
                  installed_by = EXCLUDED.installed_by,
                  installed_at = NOW()
  `, [orgId, row.name, row.id, installedBy]);

  bustCache();
  return { installed: true, skillName: row.name, version: row.version, unmetOverridden: unmet };
}

async function uninstall(orgId, skillName) {
  const res = await pool.query(
    `DELETE FROM org_skill_installs WHERE org_id = $1 AND skill_name = $2`,
    [orgId, skillName]);
  bustCache();
  return { removed: res.rowCount > 0 };
}

// ── export / import ──────────────────────────────────────────────────────────

async function exportBundle(bundleId, orgId) {
  const b = await pool.query(`
    SELECT * FROM skill_bundles
    WHERE id = $1 AND (owner_org_id IS NULL OR owner_org_id = $2)
  `, [bundleId, orgId]);
  if (!b.rows.length) throw Object.assign(new Error('Bundle not found'), { statusCode: 404 });
  const row = b.rows[0];
  return {
    format: BUNDLE_FORMAT,
    name: row.name,
    version: row.version,
    manifest: row.manifest,
    files: row.files,
    checksum: row.checksum,
  };
}

async function importBundle(orgId, payload, { publishedBy = null } = {}) {
  if (!payload || payload.format !== BUNDLE_FORMAT) {
    throw Object.assign(new Error(`Unsupported bundle format (expected ${BUNDLE_FORMAT})`), { statusCode: 400 });
  }
  const { name, version, files } = payload;
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(String(name || ''))) {
    throw Object.assign(new Error('Invalid bundle name'), { statusCode: 400 });
  }
  if (!parseSemver(version)) {
    throw Object.assign(new Error('Invalid semver version'), { statusCode: 400 });
  }
  _validateFiles(files);

  // Integrity (not authenticity): recompute and compare.
  const expected = computeChecksum(name, version, files);
  if (payload.checksum !== expected) {
    throw Object.assign(new Error('Checksum mismatch — bundle was modified in transit'), { statusCode: 400 });
  }

  const dup = await pool.query(
    `SELECT id FROM skill_bundles WHERE scope='org' AND owner_org_id=$1 AND name=$2 AND version=$3`,
    [orgId, name, version]);
  if (dup.rows.length) {
    throw Object.assign(new Error(`${name}@${version} already imported`), { statusCode: 409 });
  }

  const manifest = { ...(payload.manifest || {}), published_from: 'import', imported_checksum: expected };
  const ins = await pool.query(`
    INSERT INTO skill_bundles
      (scope, owner_org_id, name, version, manifest, files, checksum, published_by)
    VALUES ('org',$1,$2,$3,$4,$5,$6,$7) RETURNING id
  `, [orgId, name, version, JSON.stringify(manifest), JSON.stringify(files), expected, publishedBy]);

  bustCache();
  return { bundleId: ins.rows[0].id, name, version, checksum: expected };
}

// ── listing ──────────────────────────────────────────────────────────────────

async function listBundles(orgId, { name } = {}) {
  const params = [orgId];
  let where = `(sb.owner_org_id IS NULL OR sb.owner_org_id = $1)`;
  if (name) { params.push(name); where += ` AND sb.name = $${params.length}`; }
  const rows = await pool.query(`
    SELECT sb.id, sb.scope, sb.owner_org_id, sb.name, sb.version, sb.status,
           sb.manifest, sb.checksum, sb.published_at,
           (osi.id IS NOT NULL) AS pinned_by_this_org
    FROM skill_bundles sb
    LEFT JOIN org_skill_installs osi
      ON osi.bundle_id = sb.id AND osi.org_id = $1
    WHERE ${where}
    ORDER BY sb.name, string_to_array(sb.version, '.')::int[] DESC
  `, params);
  return rows.rows;
}

async function archiveBundle(bundleId, orgId) {
  // Org bundles: owner archives. Platform bundles: super-admin surface only
  // (route enforces). Refuse to archive a bundle that is currently pinned.
  const pinned = await pool.query(
    `SELECT org_id FROM org_skill_installs WHERE bundle_id = $1 LIMIT 1`, [bundleId]);
  if (pinned.rows.length) {
    throw Object.assign(new Error('Bundle is pinned by at least one org — unpin before archiving'), { statusCode: 409 });
  }
  const res = await pool.query(`
    UPDATE skill_bundles SET status = 'archived'
    WHERE id = $1 AND (owner_org_id IS NULL OR owner_org_id = $2)
  `, [bundleId, orgId]);
  if (!res.rowCount) throw Object.assign(new Error('Bundle not found'), { statusCode: 404 });
  bustCache();
  return { archived: true };
}

// ── diff ─────────────────────────────────────────────────────────────────────

function _lineDiff(aText, bText) {
  const a = String(aText).split('\n');
  const b = String(bText).split('\n');
  // LCS table (fine at these sizes; both inputs capped by MAX_DIFF_BYTES).
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', line: a[i++] });
  while (j < m) ops.push({ t: '+', line: b[j++] });
  return ops;
}

async function diffBundles(idA, idB, orgId) {
  const rows = await pool.query(`
    SELECT * FROM skill_bundles
    WHERE id = ANY($1::int[]) AND (owner_org_id IS NULL OR owner_org_id = $2)
  `, [[idA, idB], orgId]);
  const A = rows.rows.find(r => r.id === Number(idA));
  const B = rows.rows.find(r => r.id === Number(idB));
  if (!A || !B) throw Object.assign(new Error('Bundle(s) not found'), { statusCode: 404 });

  const filesA = A.files || {}, filesB = B.files || {};
  const allPaths = [...new Set([...Object.keys(filesA), ...Object.keys(filesB)])].sort();
  const files = [];
  for (const p of allPaths) {
    const inA = p in filesA, inB = p in filesB;
    if (inA && !inB) { files.push({ path: p, status: 'removed' }); continue; }
    if (!inA && inB) { files.push({ path: p, status: 'added' }); continue; }
    if (filesA[p] === filesB[p]) { files.push({ path: p, status: 'unchanged' }); continue; }
    const tooBig = Buffer.byteLength(filesA[p]) > MAX_DIFF_BYTES
                || Buffer.byteLength(filesB[p]) > MAX_DIFF_BYTES;
    files.push({
      path: p, status: 'changed',
      diff: tooBig ? null : _lineDiff(filesA[p], filesB[p]),
      diffTruncated: tooBig,
    });
  }
  return {
    from: { id: A.id, name: A.name, version: A.version },
    to:   { id: B.id, name: B.name, version: B.version },
    files,
  };
}

module.exports = {
  resolveForRun,
  toRuntimeBundle,
  publishFromDisk,
  readSkillDirAsFiles,
  installBundle,
  uninstall,
  exportBundle,
  importBundle,
  listBundles,
  archiveBundle,
  diffBundles,
  computeChecksum,
  bustCache,
  semverGt,
  BUNDLE_FORMAT,
};
