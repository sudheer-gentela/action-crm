// =============================================================================
// auditWorker.service.js
// =============================================================================
// Phase 4 — Nightly audit worker for workflow rules with trigger = 'audit'.
//
// Audit rules are NOT evaluated in the request middleware (they would be too
// expensive to run on every API write). Instead this worker runs on a nightly
// cron schedule, scanning every active record for every org against every
// active audit rule for that org.
//
// For each record:
//   - If the record FAILS an audit rule → write a rule_violations row
//     (or no-op if an unresolved violation already exists for that rule + record)
//   - If the record PASSES an audit rule → resolve any open violation for
//     that rule + record by setting resolved_at = NOW()
//
// Results summary is returned and logged by the scheduler.
//
// Exports:
//   runAuditForOrg(orgId)   — scan one org (called by nightly cron and also
//                             callable from super admin routes for manual runs)
//   runNightlyAudit()       — iterates all active orgs in series
// =============================================================================

'use strict';

const { pool } = require('../config/database');
const { evaluateConditionTree } = require('./ruleEvaluator.service');

// ─────────────────────────────────────────────────────────────────────────────
// Entity scan config
// Maps entity name to the table and column names needed to fetch records.
// To add a new entity: add a block here. No migration needed.
// ─────────────────────────────────────────────────────────────────────────────
const ENTITY_SCAN = {
  deal: {
    table:      'deals',
    orgCol:     'org_id',
    deletedCol: null,           // deals has no soft-delete column
  },
  contact: {
    table:      'contacts',
    orgCol:     'org_id',
    deletedCol: 'deleted_at',
  },
  account: {
    table:      'accounts',
    orgCol:     'org_id',
    deletedCol: 'deleted_at',
  },
};

// Batch size for record scanning — keeps individual queries manageable.
const BATCH_SIZE = 200;

// ─────────────────────────────────────────────────────────────────────────────
// runNightlyAudit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry point for the nightly cron job.
 * Fetches all active orgs and runs runAuditForOrg() for each in series
 * (to avoid overwhelming the DB with concurrent full-table scans).
 *
 * @returns {Promise<{ orgsScanned: number, totalScanned: number, totalNewViolations: number, totalResolved: number }>}
 */
async function runNightlyAudit() {
  console.log('[auditWorker] Nightly audit started');

  let orgsScanned        = 0;
  let totalScanned       = 0;
  let totalNewViolations = 0;
  let totalResolved      = 0;

  let orgs;
  try {
    const result = await pool.query(
      `SELECT id FROM organizations WHERE status = 'active' ORDER BY id ASC`
    );
    orgs = result.rows;
  } catch (err) {
    console.error('[auditWorker] Failed to load active orgs:', err);
    return { orgsScanned: 0, totalScanned: 0, totalNewViolations: 0, totalResolved: 0 };
  }

  for (const org of orgs) {
    try {
      const summary = await runAuditForOrg(org.id);
      orgsScanned++;
      totalScanned       += summary.scanned;
      totalNewViolations += summary.newViolations;
      totalResolved      += summary.resolved;
    } catch (err) {
      // One org failing must not abort the rest.
      console.error(`[auditWorker] Org ${org.id} audit failed:`, err);
    }

    // Brief pause between orgs to reduce DB pressure.
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(
    `[auditWorker] Nightly audit complete — orgs: ${orgsScanned}, ` +
    `records scanned: ${totalScanned}, new violations: ${totalNewViolations}, resolved: ${totalResolved}`
  );

  return { orgsScanned, totalScanned, totalNewViolations, totalResolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// runAuditForOrg
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs all audit-trigger workflow rules against all entity records for one org.
 *
 * Algorithm:
 *   1. Load all active audit rules for this org (platform + org-scoped).
 *   2. Group rules by entity so we scan each entity table at most once.
 *   3. For each entity group, page through records in batches of BATCH_SIZE.
 *   4. For each record, evaluate every audit rule for that entity.
 *   5. Write new violations / resolve cleared violations.
 *
 * @param {number} orgId
 * @returns {Promise<{ scanned: number, newViolations: number, resolved: number }>}
 */
async function runAuditForOrg(orgId) {
  let scanned       = 0;
  let newViolations = 0;
  let resolved      = 0;

  // ── Load audit rules (platform + org) ─────────────────────────────────────
  const rulesResult = await pool.query(
    `SELECT id, entity, conditions, action, severity
     FROM workflow_rules
     WHERE trigger   = 'audit'
       AND is_active = TRUE
       AND step_id   IS NULL
       AND (org_id IS NULL OR org_id = $1)
     ORDER BY
       CASE WHEN org_id IS NULL THEN 0 ELSE 1 END,
       sort_order ASC`,
    [orgId]
  );

  const rules = rulesResult.rows;

  if (rules.length === 0) return { scanned, newViolations, resolved };

  // ── Group by entity ───────────────────────────────────────────────────────
  const rulesByEntity = {};
  for (const rule of rules) {
    if (!rulesByEntity[rule.entity]) rulesByEntity[rule.entity] = [];
    rulesByEntity[rule.entity].push(rule);
  }

  // ── Scan each entity ──────────────────────────────────────────────────────
  for (const [entity, entityRules] of Object.entries(rulesByEntity)) {
    const scanConfig = ENTITY_SCAN[entity];
    if (!scanConfig) {
      console.warn(`[auditWorker] No scan config for entity "${entity}" — skipping`);
      continue;
    }

    const entityResult = await scanEntity(
      orgId, entity, entityRules, scanConfig
    );

    scanned       += entityResult.scanned;
    newViolations += entityResult.newViolations;
    resolved      += entityResult.resolved;
  }

  return { scanned, newViolations, resolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// scanEntity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pages through all records for one entity in one org, evaluating each audit
 * rule against each record.
 */
async function scanEntity(orgId, entity, rules, scanConfig) {
  let scanned       = 0;
  let newViolations = 0;
  let resolved      = 0;
  let offset        = 0;

  // Build soft-delete filter.
  const deletedFilter = scanConfig.deletedCol
    ? `AND ${scanConfig.deletedCol} IS NULL`
    : '';

  while (true) {
    const batchResult = await pool.query(
      `SELECT *
       FROM ${scanConfig.table}
       WHERE ${scanConfig.orgCol} = $1
         ${deletedFilter}
       ORDER BY id ASC
       LIMIT $2 OFFSET $3`,
      [orgId, BATCH_SIZE, offset]
    );

    const records = batchResult.rows;
    if (records.length === 0) break;

    for (const record of records) {
      const context = {
        entity,
        orgId,
        userId:         null,   // no user for nightly audit
        trigger:        'audit',
        existingRecord: record,
        stageChangingTo: null,
      };

      for (const rule of rules) {
        try {
          const passed = await evaluateAuditRule(rule, record, context);

          if (!passed) {
            const written = await writeViolation(rule, record, entity, orgId);
            if (written) newViolations++;
          } else {
            const resolvedCount = await resolveViolation(rule, record, entity);
            resolved += resolvedCount;
          }
        } catch (err) {
          console.error(
            `[auditWorker] Rule ${rule.id} against ${entity} ${record.id} threw:`, err
          );
        }
      }

      scanned++;
    }

    offset += records.length;
    if (records.length < BATCH_SIZE) break;  // last page
  }

  return { scanned, newViolations, resolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateAuditRule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates an audit rule against a single record.
 * Audit rules use the conditions tree to identify records that FAIL the check.
 * A record passes the rule when the conditions tree is FALSE (i.e. the
 * problematic condition is not present).
 *
 * Convention: the conditions tree describes the VIOLATION state.
 *   conditions = { operator: 'AND', groups: [{ conditions: [{ field: 'email', op: 'is_empty' }] }] }
 *   → record FAILS the audit rule when email IS empty.
 *   → record PASSES when email is present.
 *
 * @param {Object} rule    — workflow_rules row
 * @param {Object} record  — entity DB row
 * @param {Object} context
 * @returns {Promise<boolean>} — true = record is clean, false = violation exists
 */
async function evaluateAuditRule(rule, record, context) {
  // An empty conditions tree means "always flag every record" — treat as failing.
  if (!rule.conditions || !rule.conditions.groups || rule.conditions.groups.length === 0) {
    return false;
  }

  // Conditions tree describes the VIOLATION. If the tree is true → violation.
  const violationPresent = await evaluateConditionTree(rule.conditions, record, context);
  return !violationPresent;  // true = clean, false = violation
}

// ─────────────────────────────────────────────────────────────────────────────
// writeViolation / resolveViolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes a new rule_violations row if no unresolved violation already exists
 * for this rule + entity record combination.
 *
 * @returns {boolean} — true if a new row was inserted, false if already exists
 */
async function writeViolation(rule, record, entity, orgId) {
  // Check for existing open violation.
  const existing = await pool.query(
    `SELECT id FROM rule_violations
     WHERE rule_id     = $1
       AND entity_id   = $2
       AND entity_type = $3
       AND resolved_at IS NULL
     LIMIT 1`,
    [rule.id, record.id, entity]
  );

  if (existing.rows.length > 0) return false;  // already flagged, no duplicate

  await pool.query(
    `INSERT INTO rule_violations
       (rule_id, entity_id, entity_type, detected_at, metadata)
     VALUES ($1, $2, $3, NOW(), $4)`,
    [
      rule.id,
      record.id,
      entity,
      JSON.stringify({
        field:   rule.action?.field   || null,
        message: rule.action?.message || null,
      }),
    ]
  );

  return true;
}

/**
 * Resolves any open violations for this rule + entity record.
 * Sets resolved_at = NOW() on all matching unresolved rows.
 *
 * @returns {number} — count of rows resolved (0 if none were open)
 */
async function resolveViolation(rule, record, entity) {
  const result = await pool.query(
    `UPDATE rule_violations
     SET resolved_at = NOW()
     WHERE rule_id     = $1
       AND entity_id   = $2
       AND entity_type = $3
       AND resolved_at IS NULL`,
    [rule.id, record.id, entity]
  );

  return result.rowCount || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  runAuditForOrg,
  runNightlyAudit,
};
