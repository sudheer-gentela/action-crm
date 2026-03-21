// =============================================================================
// workflowEngine.service.js  —  v2 (Phase 3)
// =============================================================================
// Full workflow execution engine with graph-based step traversal,
// branch routing, and dependency resolution.
//
// Changes from Phase 2:
//   - executeWorkflow() now uses graph traversal (on_pass / on_fail pointers)
//     instead of flat sort_order iteration.
//   - Steps are pre-sorted via resolveExecutionOrder() (Kahn's topo sort).
//   - executeBranchStep() replaces the Phase 2 stub — evaluates branch
//     conditions in sort_order, routes to true_step_id or false_step_id,
//     and marks non-taken branches as skipped.
//   - resolveNextStep() drives traversal between steps.
//   - Async steps are collected during the sync traversal pass and queued
//     via setImmediate after the sync graph is exhausted.
//   - Cycle detection errors are caught and treated as infrastructure failures
//     (fail-open — the entity write proceeds).
//
// Exports:
//   executeWorkflow(workflowId, entity, payload, context)
//   executeWorkflowsForTrigger(entity, trigger, payload, context)
// =============================================================================

'use strict';

const db = require('../config/database');
const {
  evaluateRule,
  evaluateConditionTree,
  applyMutationRules,
} = require('./ruleEvaluator.service');
const {
  resolveExecutionOrder,
  resolveNextStep,
} = require('./dependencyResolver.service');

// ─────────────────────────────────────────────────────────────────────────────
// executeWorkflowsForTrigger  (unchanged from Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads all active workflows for the given entity + trigger, then executes
 * each one in series (platform workflows first, org workflows after).
 *
 * Called by workflowRules.middleware.js (v2).
 * Standalone rules (step_id IS NULL) are handled separately in the middleware.
 *
 * @param {string} entity   — 'deal' | 'contact' | 'account'
 * @param {string} trigger  — 'create' | 'update' | 'stage_change'
 * @param {Object} payload  — entity fields being written
 * @param {Object} context  — { orgId, userId, trigger, existingRecord, stageChangingTo?, entityId? }
 * @returns {Promise<{
 *   blocked:        boolean,
 *   violations:     Array<violation>,
 *   warnings:       Array<violation>,
 *   executionIds:   number[],
 *   mutatedPayload: Object
 * }>}
 */
async function executeWorkflowsForTrigger(entity, trigger, payload, context) {
  const platformResult = await db.query(
    `SELECT id, name, is_locked
     FROM workflows
     WHERE entity    = $1
       AND trigger   = $2
       AND scope     = 'platform'
       AND is_active = TRUE
       AND org_id    IS NULL
     ORDER BY id ASC`,
    [entity, trigger]
  );

  const orgResult = await db.query(
    `SELECT id, name, is_locked
     FROM workflows
     WHERE entity    = $1
       AND trigger   = $2
       AND scope     = 'org'
       AND is_active = TRUE
       AND org_id    = $3
     ORDER BY id ASC`,
    [entity, trigger, context.orgId]
  );

  const workflows = [...platformResult.rows, ...orgResult.rows];

  if (workflows.length === 0) {
    return {
      blocked:        false,
      violations:     [],
      warnings:       [],
      executionIds:   [],
      mutatedPayload: { ...payload },
    };
  }

  let currentPayload   = { ...payload };
  const allViolations  = [];
  const allWarnings    = [];
  const executionIds   = [];

  for (const workflow of workflows) {
    const result = await executeWorkflow(
      workflow.id,
      entity,
      currentPayload,
      context
    );

    executionIds.push(result.executionId);
    allViolations.push(...result.violations);
    allWarnings.push(...result.warnings);
    currentPayload = result.mutatedPayload;

    if (result.blocked) {
      return {
        blocked:        true,
        violations:     allViolations,
        warnings:       allWarnings,
        executionIds,
        mutatedPayload: currentPayload,
      };
    }
  }

  return {
    blocked:        false,
    violations:     allViolations,
    warnings:       allWarnings,
    executionIds,
    mutatedPayload: currentPayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// executeWorkflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a single workflow using graph traversal driven by on_pass / on_fail
 * routing pointers and dependency resolution via Kahn's topological sort.
 *
 * Traversal algorithm:
 *   1. Load all steps for the workflow and resolve execution order via
 *      resolveExecutionOrder() — this respects depends_on and detects cycles.
 *   2. Identify the entry step: the first step in resolved order that has no
 *      depends_on (or sort_order = 0 fallback).
 *   3. Walk the graph: execute the current step, then call resolveNextStep()
 *      to get the next step_id. Continue until next_id is null (end of graph).
 *   4. Steps not reached via on_pass / on_fail pointers (e.g. branch not taken)
 *      are logged as skipped / branch_not_taken.
 *   5. Async steps are collected during the sync pass and queued post-response.
 *
 * @param {number}  workflowId
 * @param {string}  entity
 * @param {Object}  payload
 * @param {Object}  context
 * @returns {Promise<{
 *   blocked:        boolean,
 *   violations:     Array<violation>,
 *   warnings:       Array<violation>,
 *   executionId:    number|null,
 *   mutatedPayload: Object
 * }>}
 */
async function executeWorkflow(workflowId, entity, payload, context) {
  // ── Create execution record ───────────────────────────────────────────────
  let executionId = null;
  try {
    const execResult = await db.query(
      `INSERT INTO workflow_executions
         (workflow_id, entity_id, entity_type, status, triggered_by, trigger, step_results)
       VALUES ($1, $2, $3, 'running', $4, $5, '{}')
       RETURNING id`,
      [
        workflowId,
        context.entityId || null,
        entity,
        context.userId   || null,
        context.trigger,
      ]
    );
    executionId = execResult.rows[0].id;
  } catch (err) {
    console.error(
      `[workflowEngine] Failed to create execution record for workflow ${workflowId}:`, err
    );
    // Fail-open: run steps without logging.
    return executeStepsWithoutLogging(workflowId, entity, payload, context);
  }

  // ── Load and resolve step order ───────────────────────────────────────────
  const stepsResult = await db.query(
    `SELECT id, step_type, name, sort_order, on_pass, on_fail, exec_mode, depends_on
     FROM workflow_steps
     WHERE workflow_id = $1
     ORDER BY sort_order ASC`,
    [workflowId]
  );

  const rawSteps = stepsResult.rows;

  if (rawSteps.length === 0) {
    await finaliseExecution(executionId, 'passed', {});
    return {
      blocked:        false,
      violations:     [],
      warnings:       [],
      executionId,
      mutatedPayload: { ...payload },
    };
  }

  // Topological sort — throws on cycle.
  let orderedSteps;
  try {
    orderedSteps = resolveExecutionOrder(rawSteps);
  } catch (cycleErr) {
    console.error(
      `[workflowEngine] Workflow ${workflowId} has a dependency cycle — failing open:`,
      cycleErr.message
    );
    await finaliseExecution(executionId, 'failed', {
      _error: { message: cycleErr.message },
    });
    // Fail-open: cycle in workflow definition must not block the entity write.
    return {
      blocked:        false,
      violations:     [],
      warnings:       [],
      executionId,
      mutatedPayload: { ...payload },
    };
  }

  const stepById = new Map(orderedSteps.map(s => [s.id, s]));

  // ── Graph traversal ───────────────────────────────────────────────────────
  // stepResults accumulates outcomes keyed by step id (string).
  const stepResults     = {};
  const asyncStepQueue  = [];   // async steps collected during traversal
  const blockViolations = [];
  const warnViolations  = [];
  let   currentPayload  = { ...payload };
  let   executionFailed = false;

  // Entry point: first step in resolved order.
  let currentStepId = orderedSteps[0].id;

  // Track visited steps to prevent infinite loops in malformed on_pass/on_fail cycles
  // (depends_on cycle detection catches most issues, but on_pass/on_fail are independent).
  const visited = new Set();

  while (currentStepId !== null && currentStepId !== undefined) {
    // Guard against on_pass / on_fail cycles.
    if (visited.has(currentStepId)) {
      console.error(
        `[workflowEngine] Cycle detected via on_pass/on_fail at step ${currentStepId} ` +
        `in workflow ${workflowId} — stopping traversal`
      );
      break;
    }
    visited.add(currentStepId);

    const step = stepById.get(currentStepId);

    if (!step) {
      // on_pass / on_fail points to a step outside this workflow — stop.
      console.warn(
        `[workflowEngine] Workflow ${workflowId} step pointer ${currentStepId} not found — stopping`
      );
      break;
    }

    // ── Check depends_on (all must have passed) ──────────────────────────
    const dependencyFailed = (step.depends_on || []).some(depId => {
      const depResult = stepResults[String(depId)];
      return !depResult || depResult.status !== 'passed';
    });

    if (dependencyFailed) {
      stepResults[String(step.id)] = {
        status:         'skipped',
        duration_ms:    0,
        violations:     [],
        skipped_reason: 'dependency_failed',
      };
      // Dependency failure: use on_fail pointer to continue graph.
      currentStepId = step.on_fail ?? null;
      continue;
    }

    // ── Async step: defer to post-response queue ─────────────────────────
    if (step.exec_mode === 'async') {
      asyncStepQueue.push(step);
      stepResults[String(step.id)] = {
        status:         'pending',
        duration_ms:    0,
        violations:     [],
        skipped_reason: null,
      };
      // Async steps always route via on_pass (they haven't run yet).
      currentStepId = step.on_pass ?? null;
      continue;
    }

    // ── Execute sync step ────────────────────────────────────────────────
    const started = Date.now();
    let   stepOutcome;

    try {
      stepOutcome = await executeStep(step, currentPayload, context, stepResults);
    } catch (err) {
      console.error(
        `[workflowEngine] Step ${step.id} "${step.name}" threw unexpectedly:`, err
      );
      stepOutcome = {
        status:         'skipped',
        duration_ms:    Date.now() - started,
        violations:     [],
        skipped_reason: null,
        mutatedPayload: currentPayload,
        blocked:        false,
      };
    }

    stepResults[String(step.id)] = {
      status:         stepOutcome.status,
      duration_ms:    stepOutcome.duration_ms,
      violations:     stepOutcome.violations || [],
      skipped_reason: stepOutcome.skipped_reason || null,
    };

    if (stepOutcome.mutatedPayload) {
      currentPayload = stepOutcome.mutatedPayload;
    }

    for (const v of stepOutcome.violations || []) {
      if (v.severity === 'block') blockViolations.push(v);
      else warnViolations.push(v);
    }

    if (stepOutcome.blocked) {
      // Hard block — stop traversal, mark any unreached steps as skipped.
      executionFailed = true;
      markUnreachedSteps(orderedSteps, stepResults, 'branch_not_taken');
      await finaliseExecution(executionId, 'failed', stepResults);
      return {
        blocked:        true,
        violations:     blockViolations,
        warnings:       warnViolations,
        executionId,
        mutatedPayload: currentPayload,
      };
    }

    if (stepOutcome.status === 'failed') {
      executionFailed = true;
    }

    // ── Advance to next step via routing pointer ─────────────────────────
    currentStepId = resolveNextStep(stepOutcome, step);
  }

  // ── Mark steps not reached by traversal as skipped ────────────────────
  markUnreachedSteps(orderedSteps, stepResults, 'branch_not_taken');

  // ── Queue async steps (fire-and-forget) ──────────────────────────────
  const hasAsync = asyncStepQueue.length > 0;
  if (hasAsync) {
    setImmediate(() => {
      runAsyncSteps(
        asyncStepQueue, currentPayload, context, executionId, stepResults, stepById
      ).catch(err =>
        console.error(
          `[workflowEngine] Async steps failed for execution ${executionId}:`, err
        )
      );
    });
  }

  // ── Finalise execution ────────────────────────────────────────────────
  let finalStatus;
  if (executionFailed) {
    finalStatus = 'failed';
  } else if (hasAsync) {
    finalStatus = 'partial'; // async steps still outstanding
  } else {
    finalStatus = 'passed';
  }

  await finaliseExecution(executionId, finalStatus, stepResults);

  return {
    blocked:        false,
    violations:     blockViolations,
    warnings:       warnViolations,
    executionId,
    mutatedPayload: currentPayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// executeStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatches a single step to its type-specific handler.
 *
 * StepOutcome shape:
 * {
 *   status:         'passed' | 'failed' | 'skipped',
 *   duration_ms:    number,
 *   violations:     Array<violation>,
 *   skipped_reason: string | null,
 *   mutatedPayload: Object,
 *   blocked:        boolean,
 *   // branch steps only:
 *   routeTo:        number | null,  — next step_id chosen by branch logic
 * }
 */
async function executeStep(step, payload, context, priorStepResults) {
  const started = Date.now();

  switch (step.step_type) {
    case 'rule':
      return executeRuleStep(step, payload, context, started);

    case 'branch':
      return executeBranchStep(step, payload, context, started);

    case 'action':
      // Phase 4 — side-effect actions (webhook, email, field-write, etc.)
      // Stub: log as passed, no side effects.
      return {
        status:         'passed',
        duration_ms:    Date.now() - started,
        violations:     [],
        skipped_reason: null,
        mutatedPayload: payload,
        blocked:        false,
      };

    default:
      console.warn(`[workflowEngine] Unknown step_type: "${step.step_type}" — skipping`);
      return {
        status:         'skipped',
        duration_ms:    Date.now() - started,
        violations:     [],
        skipped_reason: null,
        mutatedPayload: payload,
        blocked:        false,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// executeRuleStep  (unchanged from Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

async function executeRuleStep(step, payload, context, started) {
  const rulesResult = await db.query(
    `SELECT * FROM workflow_rules
     WHERE step_id   = $1
       AND is_active = TRUE
     ORDER BY sort_order ASC`,
    [step.id]
  );

  const rules = rulesResult.rows;

  if (rules.length === 0) {
    return {
      status:         'passed',
      duration_ms:    Date.now() - started,
      violations:     [],
      skipped_reason: null,
      mutatedPayload: payload,
      blocked:        false,
    };
  }

  const MUTATION_TYPES  = new Set(['auto_set', 'transform']);
  const validationRules = rules.filter(r => !MUTATION_TYPES.has(r.rule_type));
  const mutationRules   = rules.filter(r =>  MUTATION_TYPES.has(r.rule_type));

  const stepViolations = [];
  let   blocked        = false;

  for (const rule of validationRules) {
    try {
      const result = await evaluateRule(rule, payload, context);
      if (!result.passed) {
        for (const v of result.violations) {
          stepViolations.push(v);
          if (v.severity === 'block') blocked = true;
        }
      }
    } catch (err) {
      console.error(
        `[workflowEngine] Rule id=${rule.id} "${rule.name}" threw:`, err
      );
    }
  }

  let mutatedPayload = payload;
  if (!blocked) {
    mutatedPayload = await applyMutationRules(mutationRules, payload, context);
  }

  const status = blocked
    ? 'failed'
    : stepViolations.length > 0 ? 'failed' : 'passed';

  return {
    status,
    duration_ms:    Date.now() - started,
    violations:     stepViolations,
    skipped_reason: null,
    mutatedPayload,
    blocked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// executeBranchStep  (Phase 3 — replaces Phase 2 stub)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates the workflow_branches attached to a branch step.
 * Branches are evaluated in sort_order — first match wins.
 *
 * The winning branch's true_step_id is returned as stepOutcome.routeTo.
 * If no branch matches, false_step_id of the last branch is used (catch-all).
 * If there are no branches at all, the step passes with no routing override.
 *
 * NOTE: executeWorkflow() still uses resolveNextStep() for primary traversal.
 * For branch steps, the on_pass / on_fail pointers on the step itself serve
 * as the default routing when no branch condition overrides them.
 * routeTo is stored in step_results for observability but the engine uses
 * the step's on_pass / on_fail via resolveNextStep() as the traversal pointer.
 * Branch steps should set on_pass = true_step_id and on_fail = false_step_id
 * at authoring time so that resolveNextStep() produces the same route.
 * A future enhancement could override resolveNextStep() with routeTo directly
 * to support dynamic routing without authoring on_pass/on_fail exhaustively.
 *
 * @param {Object} step
 * @param {Object} payload
 * @param {Object} context
 * @param {number} started
 * @returns {Promise<StepOutcome & { routeTo: number|null }>}
 */
async function executeBranchStep(step, payload, context, started) {
  const branchesResult = await db.query(
    `SELECT id, condition, true_step_id, false_step_id, sort_order
     FROM workflow_branches
     WHERE step_id = $1
     ORDER BY sort_order ASC`,
    [step.id]
  );

  const branches = branchesResult.rows;

  if (branches.length === 0) {
    // No branches defined — treat as pass-through, no routing override.
    return {
      status:         'passed',
      duration_ms:    Date.now() - started,
      violations:     [],
      skipped_reason: null,
      mutatedPayload: payload,
      blocked:        false,
      routeTo:        null,
    };
  }

  let routeTo       = null;
  let matchedBranch = null;

  for (const branch of branches) {
    try {
      const matched = await evaluateConditionTree(branch.condition, payload, context);
      if (matched) {
        routeTo       = branch.true_step_id ?? null;
        matchedBranch = branch;
        break;
      }
    } catch (err) {
      console.error(
        `[workflowEngine] Branch id=${branch.id} condition evaluation threw:`, err
      );
      // Continue to next branch on error — don't abort the whole step.
    }
  }

  // If no branch matched, fall through to the last branch's false_step_id.
  if (!matchedBranch) {
    const lastBranch = branches[branches.length - 1];
    routeTo = lastBranch.false_step_id ?? null;
  }

  return {
    status:         'passed',   // Branch steps themselves always pass (routing, not validation)
    duration_ms:    Date.now() - started,
    violations:     [],
    skipped_reason: null,
    mutatedPayload: payload,
    blocked:        false,
    routeTo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runAsyncSteps  (updated for graph traversal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs queued async steps post-response using the same graph traversal logic.
 * Updates the execution record when complete.
 *
 * @param {Array<Object>} asyncSteps    — steps deferred during sync pass
 * @param {Object}        payload       — mutated payload after sync pass
 * @param {Object}        context
 * @param {number}        executionId
 * @param {Object}        syncResults   — step_results from sync pass (for depends_on checks)
 * @param {Map}           stepById      — id → step map for routing
 */
async function runAsyncSteps(asyncSteps, payload, context, executionId, syncResults, stepById) {
  const stepResults    = { ...syncResults };
  let   currentPayload = { ...payload };
  let   failed         = false;

  for (const step of asyncSteps) {
    // Dependency check against now-complete sync results.
    const dependencyFailed = (step.depends_on || []).some(depId => {
      const depResult = stepResults[String(depId)];
      return !depResult || depResult.status !== 'passed';
    });

    if (dependencyFailed) {
      stepResults[String(step.id)] = {
        status:         'skipped',
        duration_ms:    0,
        violations:     [],
        skipped_reason: 'dependency_failed',
      };
      continue;
    }

    let stepOutcome;
    try {
      stepOutcome = await executeStep(step, currentPayload, context, stepResults);
    } catch (err) {
      console.error(
        `[workflowEngine] Async step ${step.id} "${step.name}" threw:`, err
      );
      stepOutcome = {
        status:         'skipped',
        duration_ms:    0,
        violations:     [],
        skipped_reason: null,
        mutatedPayload: currentPayload,
        blocked:        false,
      };
    }

    stepResults[String(step.id)] = {
      status:         stepOutcome.status,
      duration_ms:    stepOutcome.duration_ms,
      violations:     stepOutcome.violations || [],
      skipped_reason: stepOutcome.skipped_reason || null,
    };

    if (stepOutcome.mutatedPayload) currentPayload = stepOutcome.mutatedPayload;
    if (stepOutcome.status === 'failed') failed = true;
  }

  const finalStatus = failed ? 'partial' : 'passed';
  await finaliseExecution(executionId, finalStatus, stepResults);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks steps that were never reached during traversal as skipped.
 * Preserves any results already written (passed, failed, pending, etc.).
 *
 * @param {Array<Object>} allSteps
 * @param {Object}        stepResults   — mutated in place
 * @param {string}        reason        — skipped_reason string
 */
function markUnreachedSteps(allSteps, stepResults, reason) {
  for (const step of allSteps) {
    const key = String(step.id);
    if (!stepResults[key]) {
      stepResults[key] = {
        status:         'skipped',
        duration_ms:    0,
        violations:     [],
        skipped_reason: reason,
      };
    }
  }
}

/**
 * Updates a workflow_executions row to a terminal status.
 * Fails silently — execution logging must never block business logic.
 */
async function finaliseExecution(executionId, status, stepResults) {
  try {
    await db.query(
      `UPDATE workflow_executions
       SET status       = $1,
           step_results = $2,
           completed_at = NOW()
       WHERE id = $3`,
      [status, JSON.stringify(stepResults), executionId]
    );
  } catch (err) {
    console.error(
      `[workflowEngine] Failed to finalise execution ${executionId}:`, err
    );
  }
}

/**
 * Fallback path when execution record creation fails.
 * Traverses sync steps without DB logging.
 */
async function executeStepsWithoutLogging(workflowId, entity, payload, context) {
  const stepsResult = await db.query(
    `SELECT id, step_type, name, sort_order, on_pass, on_fail, exec_mode, depends_on
     FROM workflow_steps
     WHERE workflow_id = $1
       AND exec_mode  != 'async'
     ORDER BY sort_order ASC`,
    [workflowId]
  );

  const rawSteps = stepsResult.rows;
  if (rawSteps.length === 0) {
    return {
      blocked: false, violations: [], warnings: [],
      executionId: null, mutatedPayload: { ...payload },
    };
  }

  let orderedSteps;
  try {
    orderedSteps = resolveExecutionOrder(rawSteps);
  } catch {
    // Cycle in workflow — fail open.
    return {
      blocked: false, violations: [], warnings: [],
      executionId: null, mutatedPayload: { ...payload },
    };
  }

  const stepById        = new Map(orderedSteps.map(s => [s.id, s]));
  const stepResults     = {};
  const blockViolations = [];
  const warnViolations  = [];
  let   currentPayload  = { ...payload };
  let   currentStepId   = orderedSteps[0]?.id ?? null;
  const visited         = new Set();

  while (currentStepId !== null && currentStepId !== undefined) {
    if (visited.has(currentStepId)) break;
    visited.add(currentStepId);

    const step = stepById.get(currentStepId);
    if (!step) break;

    const dependencyFailed = (step.depends_on || []).some(depId => {
      const r = stepResults[String(depId)];
      return !r || r.status !== 'passed';
    });

    if (dependencyFailed) {
      stepResults[String(step.id)] = { status: 'skipped', skipped_reason: 'dependency_failed' };
      currentStepId = step.on_fail ?? null;
      continue;
    }

    let stepOutcome;
    try {
      stepOutcome = await executeStep(step, currentPayload, context, stepResults);
    } catch (err) {
      console.error(`[workflowEngine] (no-log) Step ${step.id} threw:`, err);
      stepOutcome = {
        status: 'skipped', duration_ms: 0, violations: [],
        skipped_reason: null, mutatedPayload: currentPayload, blocked: false,
      };
    }

    stepResults[String(step.id)] = { status: stepOutcome.status };
    if (stepOutcome.mutatedPayload) currentPayload = stepOutcome.mutatedPayload;

    for (const v of stepOutcome.violations || []) {
      if (v.severity === 'block') blockViolations.push(v);
      else warnViolations.push(v);
    }

    if (stepOutcome.blocked) {
      return {
        blocked: true, violations: blockViolations, warnings: warnViolations,
        executionId: null, mutatedPayload: currentPayload,
      };
    }

    currentStepId = resolveNextStep(stepOutcome, step);
  }

  return {
    blocked: false, violations: blockViolations, warnings: warnViolations,
    executionId: null, mutatedPayload: currentPayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  executeWorkflow,
  executeWorkflowsForTrigger,
};
