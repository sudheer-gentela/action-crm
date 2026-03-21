// =============================================================================
// workflowRules.middleware.js  —  v2 (Phase 2)
// =============================================================================
// Express middleware factory for workflow rule evaluation.
// Supports two execution paths, run in series:
//
//   PATH A — Standalone rules (step_id IS NULL, Phase 1 compatible)
//     Loaded directly from workflow_rules. Run first for backwards compatibility.
//     Uses ruleEvaluator.service.js directly (no engine overhead).
//
//   PATH B — Workflow engine (Phase 2+, step-based workflows)
//     Calls workflowEngine.service.executeWorkflowsForTrigger().
//     Only runs if active workflows with steps exist for the entity + trigger.
//     Sync steps block; async steps are queued via setImmediate.
//
// Both paths write to req.mutatedPayload and req.ruleWarnings.
// Any block violation from either path returns a 400 and stops the request.
//
// Usage in route files (unchanged from Phase 1):
//   const { workflowRulesMiddleware } = require('../middleware/workflowRules.middleware');
//   router.post('/', workflowRulesMiddleware('deal', 'create'), async (req, res) => { ... });
//   router.put('/:id', workflowRulesMiddleware('deal', 'update'), async (req, res) => { ... });
//
// After this middleware runs, route handlers have access to:
//   req.mutatedPayload       — req.body with auto_set / transform mutations applied
//   req.ruleWarnings         — Array<{ field, message, severity }> (empty if none)
//   req.workflowExecutionIds — Array<number> of workflow_executions.id for this request
// =============================================================================

'use strict';

const db = require('../config/database');
const { evaluateRule, applyMutationRules } = require('../services/ruleEvaluator.service');
const { executeWorkflowsForTrigger }        = require('../services/workflowEngine.service');

/**
 * Returns Express middleware for a specific entity + trigger combination.
 *
 * @param {string} entity   — 'deal' | 'contact' | 'account' (extensible)
 * @param {string} trigger  — 'create' | 'update' | 'stage_change'
 * @returns {Function}      — Express middleware (req, res, next)
 */
function workflowRulesMiddleware(entity, trigger) {
  return async function workflowRulesHandler(req, res, next) {
    // Initialise req properties so route handlers can always destructure safely.
    req.ruleWarnings         = [];
    req.mutatedPayload       = { ...req.body };
    req.workflowExecutionIds = [];

    try {
      const orgId  = req.orgId;
      const userId = req.user?.userId;

      if (!orgId) {
        return next();
      }

      // ── Fetch existing record for update / stage_change triggers ──────────
      let existingRecord = null;
      if (trigger === 'update' || trigger === 'stage_change') {
        existingRecord = await fetchExistingRecord(entity, req.params?.id, orgId);
      }

      // ── Build shared evaluation context ───────────────────────────────────
      const context = {
        entity,
        orgId,
        userId,
        trigger,
        existingRecord,
        stageChangingTo: req.body?.stage || null,
        entityId:        req.params?.id  ? Number(req.params.id) : null,
      };

      // ═════════════════════════════════════════════════════════════════════
      // PATH A — Standalone rules (step_id IS NULL)
      // Phase 1 rules. Still run first, always.
      // ═════════════════════════════════════════════════════════════════════
      const standaloneResult = await runStandaloneRules(
        entity, trigger, orgId, req.body, context
      );

      if (standaloneResult.blocked) {
        return res.status(400).json({
          error: {
            message:    'Request blocked by workflow rules',
            violations: standaloneResult.blockViolations,
          },
        });
      }

      // Carry standalone mutations into the current working payload.
      let workingPayload = standaloneResult.mutatedPayload;
      const warnings     = [...standaloneResult.warnViolations];

      // ═════════════════════════════════════════════════════════════════════
      // PATH B — Workflow engine (step-based workflows, Phase 2+)
      // ═════════════════════════════════════════════════════════════════════
      const engineResult = await executeWorkflowsForTrigger(
        entity, trigger, workingPayload, context
      );

      if (engineResult.blocked) {
        return res.status(400).json({
          error: {
            message:    'Request blocked by workflow rules',
            violations: engineResult.violations,
          },
        });
      }

      // Merge engine mutations and warnings.
      workingPayload = engineResult.mutatedPayload;
      warnings.push(...engineResult.warnings);

      // ── Populate req properties ───────────────────────────────────────────
      req.mutatedPayload       = workingPayload;
      req.ruleWarnings         = warnings;
      req.workflowExecutionIds = engineResult.executionIds || [];

      return next();
    } catch (err) {
      // Unexpected infrastructure failure — fail open, log loudly.
      // The entity write takes priority over enforcement.
      console.error('[workflowRules] Middleware infrastructure error:', err);
      req.mutatedPayload       = { ...req.body };
      req.ruleWarnings         = [];
      req.workflowExecutionIds = [];
      return next();
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runStandaloneRules  (Path A — unchanged from Phase 1 logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads and evaluates standalone rules (step_id IS NULL).
 * Platform rules first, org rules second, sorted by sort_order.
 *
 * @returns {{ blocked, blockViolations, warnViolations, mutatedPayload }}
 */
async function runStandaloneRules(entity, trigger, orgId, payload, context) {
  const rulesResult = await db.query(
    `SELECT wr.*
     FROM workflow_rules wr
     WHERE wr.entity    = $1
       AND wr.trigger   = $2
       AND wr.is_active = TRUE
       AND wr.step_id   IS NULL
       AND (wr.org_id IS NULL OR wr.org_id = $3)
     ORDER BY
       CASE WHEN wr.org_id IS NULL THEN 0 ELSE 1 END,
       wr.sort_order ASC`,
    [entity, trigger, orgId]
  );

  const rules = rulesResult.rows;

  if (rules.length === 0) {
    return {
      blocked:         false,
      blockViolations: [],
      warnViolations:  [],
      mutatedPayload:  { ...payload },
    };
  }

  const MUTATION_TYPES   = new Set(['auto_set', 'transform']);
  const validationRules  = rules.filter(r => !MUTATION_TYPES.has(r.rule_type));
  const mutationRules    = rules.filter(r =>  MUTATION_TYPES.has(r.rule_type));

  const blockViolations = [];
  const warnViolations  = [];

  for (const rule of validationRules) {
    try {
      const result = await evaluateRule(rule, payload, context);
      if (!result.passed) {
        for (const v of result.violations) {
          if (v.severity === 'block') {
            blockViolations.push(v);
          } else {
            warnViolations.push(v);
          }
        }
      }
    } catch (err) {
      console.error(
        `[workflowRules] Error evaluating standalone rule id=${rule.id} "${rule.name}":`,
        err
      );
    }
  }

  if (blockViolations.length > 0) {
    return {
      blocked:         true,
      blockViolations,
      warnViolations,
      mutatedPayload:  { ...payload },
    };
  }

  // Apply mutations only when there are no blocks.
  const mutatedPayload = await applyMutationRules(mutationRules, payload, context);

  return {
    blocked:         false,
    blockViolations: [],
    warnViolations,
    mutatedPayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchExistingRecord  (unchanged from Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

const ENTITY_TABLE = {
  deal:    { table: 'deals',    ownerCol: 'owner_id' },
  contact: { table: 'contacts', ownerCol: 'user_id'  },
  account: { table: 'accounts', ownerCol: 'owner_id' },
};

async function fetchExistingRecord(entity, recordId, orgId) {
  if (!recordId) return null;

  const meta = ENTITY_TABLE[entity];
  if (!meta) return null;

  try {
    const result = await db.query(
      `SELECT * FROM ${meta.table} WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [recordId, orgId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error(
      `[workflowRules] fetchExistingRecord failed for ${entity} id=${recordId}:`, err
    );
    return null;
  }
}

module.exports = { workflowRulesMiddleware };
