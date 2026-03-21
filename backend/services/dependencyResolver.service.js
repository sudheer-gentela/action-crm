// =============================================================================
// dependencyResolver.service.js
// =============================================================================
// Phase 3 — Dependency resolution and branch routing for the workflow engine.
//
// Two responsibilities:
//
//   1. resolveExecutionOrder(steps)
//      Topological sort of workflow_steps rows respecting depends_on constraints.
//      Throws on cycle detection. Pure function — no DB calls.
//
//   2. resolveNextStep(stepResult, step)
//      Given a completed step's outcome and its on_pass / on_fail pointers,
//      returns the next step_id to execute (or null for end-of-workflow).
//      Pure function — no DB calls.
//
// Both functions are consumed by workflowEngine.service.js (v2).
//
// Exports:
//   resolveExecutionOrder(steps)
//   resolveNextStep(stepResult, step)
// =============================================================================

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// resolveExecutionOrder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns workflow steps in valid execution order, respecting depends_on
 * constraints via Kahn's algorithm (BFS topological sort).
 *
 * Steps with no dependencies come first. Among steps at the same dependency
 * depth, sort_order is used as the tiebreaker (ascending).
 *
 * @param {Array<Object>} steps  — workflow_steps rows (must include: id, sort_order, depends_on)
 * @returns {Array<Object>}      — steps in safe execution order
 * @throws {Error}               — if a dependency cycle is detected
 */
function resolveExecutionOrder(steps) {
  if (!steps || steps.length === 0) return [];

  // Build an id → step index map for fast lookup.
  const stepById = new Map(steps.map(s => [s.id, s]));

  // Validate that all depends_on references point to steps within this workflow.
  // Unknown IDs are dropped with a warning rather than hard-throwing — a missing
  // dependency is safer to ignore than to crash the whole request.
  const validIds = new Set(steps.map(s => s.id));

  // in-degree: how many unresolved dependencies each step has.
  const inDegree = new Map(steps.map(s => [s.id, 0]));
  // dependents: for each step, which steps are waiting on it.
  const dependents = new Map(steps.map(s => [s.id, []]));

  for (const step of steps) {
    const deps = (step.depends_on || []).filter(depId => {
      if (!validIds.has(depId)) {
        console.warn(
          `[dependencyResolver] Step ${step.id} "${step.name}" depends_on unknown step ${depId} — ignored`
        );
        return false;
      }
      return true;
    });

    inDegree.set(step.id, deps.length);

    for (const depId of deps) {
      dependents.get(depId).push(step.id);
    }
  }

  // Kahn's BFS — start with all steps that have no dependencies.
  // Sort the initial queue by sort_order so deterministic ordering is preserved
  // even when there are no dependency constraints.
  const queue = steps
    .filter(s => inDegree.get(s.id) === 0)
    .sort((a, b) => a.sort_order - b.sort_order);

  const ordered = [];

  while (queue.length > 0) {
    // Take the lowest sort_order step available.
    const step = queue.shift();
    ordered.push(step);

    // Decrement in-degree for everything that depended on this step.
    const waitingIds = dependents.get(step.id) || [];
    const nowReady   = [];

    for (const waitingId of waitingIds) {
      const newDegree = inDegree.get(waitingId) - 1;
      inDegree.set(waitingId, newDegree);
      if (newDegree === 0) {
        nowReady.push(stepById.get(waitingId));
      }
    }

    // Insert newly-unblocked steps in sort_order and continue.
    nowReady.sort((a, b) => a.sort_order - b.sort_order);
    queue.push(...nowReady);
  }

  // If we haven't placed every step, a cycle exists.
  if (ordered.length !== steps.length) {
    const cycleIds = steps
      .filter(s => inDegree.get(s.id) > 0)
      .map(s => `${s.id} ("${s.name}")`)
      .join(', ');
    throw new Error(
      `[dependencyResolver] Cycle detected in workflow steps — cannot resolve order. ` +
      `Involved steps: ${cycleIds}`
    );
  }

  return ordered;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveNextStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the next step_id to execute after a step completes, based on
 * the step's on_pass / on_fail routing pointers.
 *
 * Rules:
 *   - If the step passed  → return step.on_pass  (null = end of workflow)
 *   - If the step failed  → return step.on_fail  (null = end of workflow)
 *   - If the step was skipped → return null (do not continue from a skipped step)
 *
 * @param {{ status: 'passed' | 'failed' | 'skipped' }} stepResult
 * @param {{ on_pass: number|null, on_fail: number|null }}  step
 * @returns {number|null}  — next step_id, or null to end the workflow
 */
function resolveNextStep(stepResult, step) {
  switch (stepResult.status) {
    case 'passed':
      return step.on_pass ?? null;
    case 'failed':
      return step.on_fail ?? null;
    case 'skipped':
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  resolveExecutionOrder,
  resolveNextStep,
};
