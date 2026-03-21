// =============================================================================
// workflowEngine.service.js
// =============================================================================
// Phase 2 — Full workflow execution engine.
//
// Executes workflows sequentially through their steps, logging each step result
// into workflow_executions.step_results. Sync steps block before returning.
// Async steps are queued via setImmediate and do not block the API response.
//
// Consumed by workflowRules.middleware.js (v2) which calls executeWorkflowsForTrigger()
// instead of loading standalone rules directly.
//
// Phase 1 standalone rules (step_id IS NULL) are still handled inside
// workflowRules.middleware.js and are NOT routed through this engine.
// Both paths coexist and run independently.
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

// ─────────────────────────────────────────────────────────────────────────────
// executeWorkflowsForTrigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads all active workflows for the given entity + trigger scoped to the org,
 * then executes each one in series (platform workflows first, org workflows after).
 *
 * This is the entry point called by workflowRules.middleware.js (v2).
 * Standalone rules (step_id IS NULL) are handled separately in the middleware
 * and are NOT executed here.
 *
 * @param {string} entity   — 'deal' | 'contact' | 'account'
 * @param {string} trigger  — 'create' | 'update' | 'stage_change'
 * @param {Object} payload  — entity fields being written (req.body)
 * @param {Object} context  — { orgId, userId, trigger, existingRecord, stageChangingTo? }
 * @returns {Promise<{
 *   blocked:        boolean,
 *   violations:     Array<violation>,
 *   warnings:       Array<violation>,
 *   executionIds:   number[],
 *   mutatedPayload: Object
 * }>}
 */
async function executeWorkflowsForTrigger(entity, trigger, payload, context) {
  // Load active workflows: platform-scoped first (org_id IS NULL), then org-scoped.
  // We deliberately use two separate queries and concat to guarantee ordering —
  // a single ORDER BY CASE could be reordered by the planner on large tables.
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

  // Execute each workflow in series. Stop on first hard block so downstream
  // workflows don't run against an already-invalid request.
  let currentPayload = { ...payload };
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

    // Carry mutations forward so subsequent workflows see the updated payload.
    currentPayload = result.mutatedPayload;

    if (result.blocked) {
      // Hard block — stop processing further workflows.
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
 * Executes a single workflow from its first step to completion.
 * Sync steps (exec_mode = 'sync') run inline and block this function.
 * Async steps (exec_mode = 'async') are queued via setImmediate and return
 * immediately — they are NOT awaited.
 *
 * Creates a workflow_executions row (status = 'running') before step execution,
 * then updates it to 'passed' | 'failed' | 'partial' when sync execution ends.
 * Async steps update the execution row independently after the API response.
 *
 * @param {number}  workflowId
 * @param {string}  entity
 * @param {Object}  payload
 * @param {Object}  context  — { orgId, userId, trigger, existingRecord, stageChangingTo?, entityId? }
 * @returns {Promise<{
 *   blocked:        boolean,
 *   violations:     Array<violation>,
 *   warnings:       Array<violation>,
 *   executionId:    number,
 *   mutatedPayload: Object
 * }>}
 */
async function executeWorkflow(workflowId, entity, payload, context) {
  // ── Create execution record ───────────────────────────────────────────────
  let executionId;
  try {
    const execResult = await db.query(
      `INSERT INTO workflow_executions
         (workflow_id, entity_id, entity_type, status, triggered_by, trigger, step_results)
       VALUES ($1, $2, $3, 'running', $4, $5, '{}')
       RETURNING id`,
      [
        workflowId,
        context.entityId   || null,
        entity,
        context.userId     || null,
        context.trigger,
      ]
    );
    executionId = execResult.rows[0].id;
  } catch (err) {
    // Execution logging failure must not block the request.
    // Degrade gracefully: run steps without logging, return a synthetic result.
    console.error(
      `[workflowEngine] Failed to create execution record for workflow ${workflowId}:`,
      err
    );
    return await executeStepsWithoutLogging(workflowId, entity, payload, context);
  }

  // ── Load steps ordered by sort_order ─────────────────────────────────────
  const stepsResult = await db.query(
    `SELECT id, step_type, name, sort_order, on_pass, on_fail, exec_mode, depends_on
     FROM workflow_steps
     WHERE workflow_id = $1
     ORDER BY sort_order ASC`,
    [workflowId]
  );

  const steps = stepsResult.rows;

  if (steps.length === 0) {
    // Workflow has no steps — mark complete immediately.
    await finaliseExecution(executionId, 'passed', {});
    return {
      blocked:        false,
      violations:     [],
      warnings:       [],
      executionId,
      mutatedPayload: { ...payload },
    };
  }

  // ── Split into sync and async ─────────────────────────────────────────────
  const syncSteps  = steps.filter(s => s.exec_mode !== 'async');
  const asyncSteps = steps.filter(s => s.exec_mode === 'async');

  // ── Execute sync steps in sort_order ─────────────────────────────────────
  const stepResults    = {};    // { [stepId]: StepResult }
  const blockViolations = [];
  const warnViolations  = [];
  let   currentPayload  = { ...payload };
  let   executionStatus = 'passed';

  for (const step of syncSteps) {
    const started = Date.now();

    // ── Check depends_on ───────────────────────────────────────────────────
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

    // ── Execute step ───────────────────────────────────────────────────────
    let stepOutcome;
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

    // Carry payload mutations forward.
    if (stepOutcome.mutatedPayload) {
      currentPayload = stepOutcome.mutatedPayload;
    }

    // Collect violations.
    for (const v of stepOutcome.violations || []) {
      if (v.severity === 'block') {
        blockViolations.push(v);
      } else {
        warnViolations.push(v);
      }
    }

    if (stepOutcome.blocked) {
      executionStatus = 'failed';
      // Persist the partial step_results we have so far, then stop.
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
      executionStatus = 'failed';
    }
  }

  // ── Queue async steps (fire-and-forget) ───────────────────────────────────
  if (asyncSteps.length > 0) {
    // Mark status as 'partial' — async steps are still outstanding.
    executionStatus = executionStatus === 'failed' ? 'failed' : 'partial';
    setImmediate(() => {
      runAsyncSteps(asyncSteps, currentPayload, context, executionId, stepResults)
        .catch(err =>
          console.error(
            `[workflowEngine] Async steps failed for execution ${executionId}:`, err
          )
        );
    });
  }

  // ── Finalise sync execution ───────────────────────────────────────────────
  const finalStatus = asyncSteps.length > 0 ? executionStatus : executionStatus;
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
 * Dispatches a single step to the appropriate handler based on step_type.
 *
 * @param {Object} step
 * @param {Object} payload
 * @param {Object} context
 * @param {Object} priorStepResults  — results of steps already executed (for branch awareness)
 * @returns {Promise<StepOutcome>}
 *
 * StepOutcome shape:
 * {
 *   status:         'passed' | 'failed' | 'skipped',
 *   duration_ms:    number,
 *   violations:     Array<violation>,
 *   skipped_reason: string | null,
 *   mutatedPayload: Object,   // payload after any mutations this step applied
 *   blocked:        boolean,  // true if a 'block'-severity violation was raised
 * }
 */
async function executeStep(step, payload, context, priorStepResults) {
  const started = Date.now();

  switch (step.step_type) {
    case 'rule':
      return executeRuleStep(step, payload, context, started);

    case 'branch':
      // Phase 3 will implement full branch routing.
      // Phase 2 stubs: evaluate the branch condition and log, but do not re-route.
      return executeBranchStepStub(step, payload, context, started);

    case 'action':
      // Phase 4 will implement side-effect actions (webhook, email, etc.).
      // Phase 2 stubs: log as passed, no side effects.
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
// executeRuleStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads the workflow_rules attached to a step and evaluates each one.
 * Mutation rules (auto_set / transform) are applied to produce a mutated payload.
 *
 * @param {Object} step
 * @param {Object} payload
 * @param {Object} context
 * @param {number} started  — Date.now() at step start (for accurate duration)
 * @returns {Promise<StepOutcome>}
 */
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

  const MUTATION_TYPES   = new Set(['auto_set', 'transform']);
  const validationRules  = rules.filter(r => !MUTATION_TYPES.has(r.rule_type));
  const mutationRules    = rules.filter(r =>  MUTATION_TYPES.has(r.rule_type));

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
      // A single rule error must never bring down the step.
      console.error(
        `[workflowEngine] Rule id=${rule.id} "${rule.name}" threw:`, err
      );
    }
  }

  // Apply mutation rules even when there are warn violations — warnings are non-blocking.
  // Do NOT mutate when blocked — the write won't happen anyway.
  let mutatedPayload = payload;
  if (!blocked) {
    mutatedPayload = await applyMutationRules(mutationRules, payload, context);
  }

  const status = blocked ? 'failed'
    : stepViolations.length > 0 ? 'failed'
    : 'passed';

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
// executeBranchStepStub  (Phase 2 stub — replaced in Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 2 stub for branch steps. Evaluates the branch condition for logging
 * purposes but does not re-route execution (that's Phase 3 — dependencyResolver).
 */
async function executeBranchStepStub(step, payload, context, started) {
  const branchesResult = await db.query(
    `SELECT id, condition, true_step_id, false_step_id, sort_order
     FROM workflow_branches
     WHERE step_id = $1
     ORDER BY sort_order ASC`,
    [step.id]
  );

  const branches = branchesResult.rows;

  // Evaluate first matching branch condition for logging; ignore routing.
  for (const branch of branches) {
    try {
      const matched = await evaluateConditionTree(branch.condition, payload, context);
      if (matched) {
        // Log which branch would be taken (Phase 3 will act on this).
        break;
      }
    } catch (err) {
      console.error(
        `[workflowEngine] Branch id=${branch.id} condition threw:`, err
      );
    }
  }

  return {
    status:         'passed', // Branches always pass in Phase 2 (no routing enforcement yet)
    duration_ms:    Date.now() - started,
    violations:     [],
    skipped_reason: null,
    mutatedPayload: payload,
    blocked:        false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runAsyncSteps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called via setImmediate after the API response is sent.
 * Executes async steps in sort_order and updates the execution record.
 * Errors are caught and logged — must not crash the process.
 *
 * @param {Array<Object>} asyncSteps
 * @param {Object}        payload         — mutated payload after sync steps
 * @param {Object}        context
 * @param {number}        executionId
 * @param {Object}        syncStepResults — already-completed sync step results (for merge)
 */
async function runAsyncSteps(asyncSteps, payload, context, executionId, syncStepResults) {
  const stepResults    = { ...syncStepResults };
  let   currentPayload = { ...payload };
  let   failed         = false;

  for (const step of asyncSteps) {
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

    if (stepOutcome.mutatedPayload) {
      currentPayload = stepOutcome.mutatedPayload;
    }

    if (stepOutcome.status === 'failed') {
      failed = true;
    }
  }

  // Update execution to final status now that all async steps have run.
  const finalStatus = failed ? 'partial' : 'passed'; // async failures → 'partial', not 'failed'
  await finaliseExecution(executionId, finalStatus, stepResults);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Updates a workflow_executions row to a terminal status with final step_results.
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
 * Fallback path when we cannot create an execution record.
 * Runs steps through executeStep() without logging anything.
 * Prevents execution logging failure from breaking the API write.
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

  const steps          = stepsResult.rows;
  const stepResults    = {};
  const blockViolations = [];
  const warnViolations  = [];
  let   currentPayload  = { ...payload };

  for (const step of steps) {
    const dependencyFailed = (step.depends_on || []).some(depId => {
      const depResult = stepResults[String(depId)];
      return !depResult || depResult.status !== 'passed';
    });

    if (dependencyFailed) {
      stepResults[String(step.id)] = { status: 'skipped' };
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
        blocked:        true,
        violations:     blockViolations,
        warnings:       warnViolations,
        executionId:    null,
        mutatedPayload: currentPayload,
      };
    }
  }

  return {
    blocked:        false,
    violations:     blockViolations,
    warnings:       warnViolations,
    executionId:    null,
    mutatedPayload: currentPayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  executeWorkflow,
  executeWorkflowsForTrigger,
};
