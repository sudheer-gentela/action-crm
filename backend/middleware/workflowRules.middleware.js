// =============================================================================
// workflowRules.middleware.js
// =============================================================================
// Express middleware factory for Phase 1 standalone rule evaluation.
// Mounts per-route on POST / PUT — never on bulk import routes.
//
// Usage in route files:
//   const { workflowRulesMiddleware } = require('../middleware/workflowRules.middleware');
//   router.post('/', workflowRulesMiddleware('deal', 'create'), async (req, res) => { ... });
//   router.put('/:id', workflowRulesMiddleware('deal', 'update'), async (req, res) => { ... });
//
// After this middleware runs, route handlers have access to:
//   req.mutatedPayload  — req.body with auto_set / transform mutations applied
//   req.ruleWarnings    — Array<{ field, message, severity }> (empty if none)
//
// Route handlers opt in with one line:
//   const p = req.mutatedPayload || req.body;
// =============================================================================

const db                = require('../config/database');
const { evaluateRule, applyMutationRules } = require('../services/ruleEvaluator.service');

/**
 * Returns Express middleware for a specific entity + trigger combination.
 *
 * @param {string} entity   — 'deal' | 'contact' | 'account' (extensible)
 * @param {string} trigger  — 'create' | 'update' | 'stage_change'
 * @returns {Function}      — Express middleware (req, res, next)
 */
function workflowRulesMiddleware(entity, trigger) {
  return async function workflowRulesHandler(req, res, next) {
    // Initialise req properties so route handlers can always destructure safely
    req.ruleWarnings    = [];
    req.mutatedPayload  = { ...req.body };

    try {
      const orgId  = req.orgId;
      const userId = req.user?.userId;

      if (!orgId) {
        // Should never happen after authenticateToken + orgContext, but be safe
        return next();
      }

      // ── Load standalone rules ─────────────────────────────────────────────
      // Phase 1: step_id IS NULL only.
      // Platform rules (org_id IS NULL) first, then org rules — combined and
      // sorted by sort_order so platform rules always run before org rules at
      // the same sort position.
      const rulesResult = await db.query(
        `SELECT wr.*
         FROM workflow_rules wr
         WHERE wr.entity    = $1
           AND wr.trigger   = $2
           AND wr.is_active = TRUE
           AND wr.step_id   IS NULL
           AND (wr.org_id IS NULL OR wr.org_id = $3)
         ORDER BY
           CASE WHEN wr.org_id IS NULL THEN 0 ELSE 1 END,  -- platform first
           wr.sort_order ASC`,
        [entity, trigger, orgId]
      );

      const rules = rulesResult.rows;

      if (rules.length === 0) {
        // No rules configured — passthrough
        return next();
      }

      // ── Fetch existing record for update / stage_change triggers ──────────
      let existingRecord = null;
      if (trigger === 'update' || trigger === 'stage_change') {
        existingRecord = await fetchExistingRecord(entity, req.params?.id, orgId);
      }

      // ── Build evaluation context ──────────────────────────────────────────
      const context = {
        entity,
        orgId,
        userId,
        trigger,
        existingRecord,
        stageChangingTo: req.body?.stage || null,
      };

      // ── Separate validation rules from mutation rules ─────────────────────
      const MUTATION_TYPES = new Set(['auto_set', 'transform']);
      const validationRules = rules.filter(r => !MUTATION_TYPES.has(r.rule_type));
      const mutationRules   = rules.filter(r => MUTATION_TYPES.has(r.rule_type));

      // ── Run validation rules ──────────────────────────────────────────────
      const blockViolations = [];
      const warnViolations  = [];

      for (const rule of validationRules) {
        try {
          const result = await evaluateRule(rule, req.body, context);
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
          // A single rule error must never bring down the request — log and skip
          console.error(
            `[workflowRules] Error evaluating rule id=${rule.id} "${rule.name}":`,
            err
          );
        }
      }

      // ── Hard block — return 400 before any DB write ───────────────────────
      if (blockViolations.length > 0) {
        return res.status(400).json({
          error: {
            message: 'Request blocked by workflow rules',
            violations: blockViolations,
          },
        });
      }

      // ── Apply mutation rules to produce req.mutatedPayload ────────────────
      // Even if there are warn violations we still mutate — warnings are non-blocking.
      const mutated = await applyMutationRules(mutationRules, req.body, context);
      req.mutatedPayload = mutated;

      // ── Attach warnings for the route handler to include in the response ──
      req.ruleWarnings = warnViolations;

      return next();
    } catch (err) {
      // Unexpected infrastructure failure — do NOT block the request.
      // Log loudly and let the route handler proceed with the original payload.
      console.error('[workflowRules] Middleware infrastructure error:', err);
      req.mutatedPayload = { ...req.body };
      req.ruleWarnings   = [];
      return next();
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchExistingRecord
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
    console.error(`[workflowRules] fetchExistingRecord failed for ${entity} id=${recordId}:`, err);
    return null;
  }
}

module.exports = { workflowRulesMiddleware };
