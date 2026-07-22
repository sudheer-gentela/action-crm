/**
 * crmConnections.service.js
 *
 * DROP-IN LOCATION: backend/services/crmConnections.service.js
 *
 * Shared helpers around the crm_connections table (2026_60). One place for:
 *
 *   upsertPointerConnection({ orgId, crmType, integrationId, instanceUrl,
 *                             connectedBy, purpose })
 *       Called from the OAuth exchangeCode paths (salesforce.auth.js /
 *       hubspot.auth.js) inside their own transaction — pass the txn client.
 *       Targets the partial unique index (org_id, crm_type) WHERE client_id
 *       IS NULL, so reconnects update rather than duplicate.
 *
 *   mirrorSettings(orgId, crmType, updates)
 *       Keeps the org-level pointer row's settings in step with
 *       org_integrations.settings whenever the legacy PATCH /settings
 *       endpoints write (stage_map / field_map / sync_objects /
 *       write_back_enabled). One-directional: org_integrations remains
 *       authoritative for the live sync engine until Phase 3a flips the
 *       orchestrator; crm_connections.settings is authoritative for
 *       baseline/assessment (BaselineCaptureService reads stage_map here).
 *
 *   assertOrgWritesAllowed(orgId)
 *       The assessment hard gate. Throws Err(statusCode 403) when
 *       organizations.type = 'assessment'. Used by:
 *         - PATCH /api/salesforce/settings (enabling write_back)
 *         - salesforce.sync.service.js runWriteBackForOrg
 *         - crm/writeBack.js runWriteBackForOrg
 *       so the answer to "can it write?" is "that code path returns 403 /
 *       skips for this org type" — showable, not configurable.
 *
 *   requireNonAssessmentOrg
 *       Express middleware wrapper over assertOrgWritesAllowed for routes.
 *
 *   getOrgType(orgId) — cached 60s, same TTL pattern as requireModule.
 */

const { pool } = require('../config/database');

const _typeCache = new Map(); // orgId -> { type, ts }
const TTL = 60_000;

async function getOrgType(orgId) {
  const key = String(orgId);
  const hit = _typeCache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.type;
  const res = await pool.query(
    `SELECT type FROM organizations WHERE id = $1`, [orgId]);
  const type = res.rows.length ? (res.rows[0].type || 'standard') : 'standard';
  _typeCache.set(key, { type, ts: Date.now() });
  return type;
}

function invalidateOrgType(orgId) { _typeCache.delete(String(orgId)); }

// ── assessment write gate ────────────────────────────────────────────────────

async function assertOrgWritesAllowed(orgId) {
  const type = await getOrgType(orgId);
  if (type === 'assessment') {
    const err = new Error(
      'This is an assessment organisation: CRM write-back is disabled at the ' +
      'platform level and cannot be enabled. Convert the org to standard to ' +
      'unlock write-back.'
    );
    err.statusCode = 403;
    err.code = 'ASSESSMENT_ORG_READONLY';
    throw err;
  }
}

/** Express middleware form. Assumes orgContext has run (req.orgId set). */
function requireNonAssessmentOrg(req, res, next) {
  assertOrgWritesAllowed(req.orgId)
    .then(() => next())
    .catch(err => {
      const status = err.statusCode || 500;
      res.status(status).json({ success: false, error: err.message, code: err.code });
    });
}

// ── pointer-row upsert (OAuth callback path) ─────────────────────────────────

/**
 * @param {object} txnClient  pg client inside the caller's open transaction
 * @param {object} p          { orgId, crmType, integrationId, instanceUrl,
 *                              connectedBy, purpose }
 * purpose defaults from the org type: assessment orgs always get
 * purpose='assessment' regardless of what the state param claimed.
 */
async function upsertPointerConnection(txnClient, p) {
  const orgType = await getOrgType(p.orgId);
  const purpose = orgType === 'assessment' ? 'assessment' : (p.purpose || 'standard');

  const res = await txnClient.query(`
    INSERT INTO crm_connections
      (org_id, client_id, crm_type, purpose, integration_id, instance_url,
       settings, status, write_back_enabled, sync_status,
       connected_by, connected_at, created_at, updated_at)
    VALUES ($1, NULL, $2, $3, $4, $5,
            COALESCE((SELECT settings FROM org_integrations WHERE id = $4), '{}'::jsonb),
            'active', FALSE, 'idle',
            $6, NOW(), NOW(), NOW())
    ON CONFLICT (org_id, crm_type) WHERE client_id IS NULL
    DO UPDATE SET
      purpose        = EXCLUDED.purpose,
      integration_id = EXCLUDED.integration_id,
      instance_url   = EXCLUDED.instance_url,
      status         = 'active',
      connected_by   = EXCLUDED.connected_by,
      connected_at   = NOW(),
      updated_at     = NOW()
    RETURNING id
  `, [p.orgId, p.crmType, purpose, p.integrationId, p.instanceUrl || null, p.connectedBy || null]);

  return res.rows[0].id;
}

// ── settings mirror (legacy PATCH /settings endpoints) ───────────────────────

const MIRRORED_KEYS = new Set([
  'stage_map', 'field_map', 'sync_objects', 'write_back_enabled',
]);

/**
 * Mirror a settings-update object onto the org-level pointer row. Only keys
 * in MIRRORED_KEYS are copied; anything else stays org_integrations-only.
 * Best-effort by design: a missing pointer row (org never re-connected after
 * 2026_60) logs and returns rather than failing the caller's request.
 */
async function mirrorSettings(orgId, crmType, updates) {
  const mirrored = Object.fromEntries(
    Object.entries(updates || {}).filter(([k]) => MIRRORED_KEYS.has(k)));
  if (!Object.keys(mirrored).length) return;

  try {
    let expr = 'settings';
    const params = [orgId, crmType];
    Object.entries(mirrored).forEach(([key, val], i) => {
      expr = `jsonb_set(${expr}, '{${key}}', $${i + 3}::jsonb)`;
      params.push(JSON.stringify(val));
    });
    // write_back_enabled also lands in its own column (per-connection grant).
    const wbCol = ('write_back_enabled' in mirrored)
      ? `, write_back_enabled = ${mirrored.write_back_enabled === true ? 'TRUE' : 'FALSE'}`
      : '';
    const res = await pool.query(
      `UPDATE crm_connections
          SET settings = ${expr}${wbCol}, updated_at = NOW()
        WHERE org_id = $1 AND crm_type = $2 AND client_id IS NULL`,
      params
    );
    if (res.rowCount === 0) {
      console.warn(`[crmConnections] no pointer row to mirror for org ${orgId} ${crmType} — run 2026_60 backfill or reconnect`);
    }
  } catch (err) {
    console.warn(`[crmConnections] settings mirror failed for org ${orgId} ${crmType}: ${err.message}`);
  }
}

// ── loaders used by the baseline routes ──────────────────────────────────────

async function listConnections(orgId) {
  const res = await pool.query(`
    SELECT cc.id, cc.org_id, cc.client_id, c.name AS client_name,
           cc.crm_type, cc.purpose, cc.integration_id, cc.instance_url,
           cc.status, cc.write_back_enabled, cc.sync_status, cc.last_sync_at,
           cc.connected_at,
           (cc.settings -> 'stage_map')       AS stage_map,
           (cc.settings -> 'baseline_config') AS baseline_config
    FROM crm_connections cc
    LEFT JOIN clients c ON c.id = cc.client_id
    WHERE cc.org_id = $1
    ORDER BY cc.client_id NULLS FIRST, cc.crm_type
  `, [orgId]);
  return res.rows;
}

async function getConnection(orgId, connectionId) {
  const res = await pool.query(
    `SELECT * FROM crm_connections WHERE id = $1 AND org_id = $2`,
    [connectionId, orgId]);
  return res.rows[0] || null;
}

module.exports = {
  getOrgType,
  invalidateOrgType,
  assertOrgWritesAllowed,
  requireNonAssessmentOrg,
  upsertPointerConnection,
  mirrorSettings,
  listConnections,
  getConnection,
};
