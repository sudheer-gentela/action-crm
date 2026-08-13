// ─────────────────────────────────────────────────────────────────────────────
// planVariance.service.js — plan vs actual for project plays (2026_111)
//
// Two variances, because they answer different questions:
//
//   vs BASELINE      total slip. The number for the client and the post-mortem.
//   vs CURRENT DUE   forecast accuracy. Did we hit the date we most recently
//                    promised? This is what says whether the estimates are
//                    worth anything.
//
// And a third signal that neither captures: REVISION COUNT. A play moved once
// by 30 days and a play moved six times by 5 days have identical baseline
// variance and are completely different situations.
//
// Deliberate choices, each of which changes the numbers:
//
//   • Open plays get a variance too, measured against today. Counting only
//     completed work hides live slippage, which is the thing a project manager
//     most needs to see.
//   • Ad-hoc plays have NO baseline — they were never in the plan. Scoring
//     them against one would make every project look worse than it was.
//   • Cancelled and skipped plays are excluded entirely. Work that was called
//     off is not late.
//   • baseline_source is surfaced, not hidden. Every pre-migration baseline is
//     'inferred' (back-filled from the then-current due date), so variance
//     against it UNDERSTATES the real slip. A report that quietly mixes
//     inferred and original baselines is misleading precision.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../config/database');

// Terminal states that are not "late" — the work stopped on purpose.
const EXCLUDED_STATUSES = ['cancelled', 'skipped'];

/**
 * Per-play variance for one project.
 *
 * @param {number} handoverId
 * @param {number} orgId
 * @returns {{ summary: object, plays: object[] }}
 */
async function getProjectVariance(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT
       p.id,
       p.title,
       p.stage_key,
       p.status,
       p.is_manual,
       p.sort_order,
       p.due_date,
       p.baseline_due_date,
       p.baseline_source,
       p.completed_at,
       ps.name       AS stage_name,
       ps.sort_order AS stage_order,
       ou.first_name || ' ' || ou.last_name AS owner_name,

       -- Variance in whole days. completed_at is a timestamptz and the dates
       -- are DATE, so both sides are cast to date first: without that a play
       -- finished at 09:00 on its due date reads as -1 day early.
       CASE
         WHEN p.baseline_due_date IS NULL THEN NULL
         WHEN p.completed_at IS NOT NULL
           THEN (p.completed_at AT TIME ZONE 'UTC')::date - p.baseline_due_date
         WHEN p.status = ANY($2::text[]) THEN NULL
         ELSE CURRENT_DATE - p.baseline_due_date
       END AS baseline_variance_days,

       CASE
         WHEN p.due_date IS NULL THEN NULL
         WHEN p.completed_at IS NOT NULL
           THEN (p.completed_at AT TIME ZONE 'UTC')::date - p.due_date
         WHEN p.status = ANY($2::text[]) THEN NULL
         ELSE CURRENT_DATE - p.due_date
       END AS current_variance_days,

       (SELECT count(*) FROM play_due_date_revisions rv
         WHERE rv.project_play_instance_id = p.id)::int AS revision_count,
       (SELECT count(*) FROM play_due_date_revisions rv
         WHERE rv.project_play_instance_id = p.id AND rv.is_rebaseline)::int AS rebaseline_count,
       (SELECT count(*) FROM play_evidence e
         WHERE e.project_play_instance_id = p.id AND e.revoked_at IS NULL)::int AS evidence_count

     FROM project_play_instances p
     LEFT JOIN sales_handovers h  ON h.id = p.handover_id
     LEFT JOIN playbook_stages ps ON ps.playbook_id = h.playbook_id AND ps.key = p.stage_key
     LEFT JOIN users ou           ON ou.id = p.owner_user_id
    WHERE p.handover_id = $1
      AND p.org_id = $3
      AND NOT (p.status = ANY($2::text[]))
    ORDER BY ps.sort_order ASC NULLS LAST, p.stage_key ASC, p.sort_order ASC, p.id ASC`,
    [handoverId, EXCLUDED_STATUSES, orgId]
  );

  const plays = rows.map(r => ({
    id:                r.id,
    title:             r.title,
    stageKey:          r.stage_key,
    stageName:         r.stage_name || r.stage_key,
    status:            r.status,
    isAdHoc:           r.is_manual || r.baseline_due_date == null,
    ownerName:         r.owner_name,
    baselineDueDate:   r.baseline_due_date,
    baselineSource:    r.baseline_source,
    dueDate:           r.due_date,
    completedAt:       r.completed_at,
    completed:         r.completed_at != null,
    baselineVariance:  r.baseline_variance_days,
    currentVariance:   r.current_variance_days,
    revisionCount:     r.revision_count,
    rebaselineCount:   r.rebaseline_count,
    evidenceCount:     r.evidence_count,
    // "still open and already past its date" — the number a PM acts on today,
    // as distinct from a completed play that happened to run late.
    overdue:           r.completed_at == null && r.baseline_variance_days > 0,
  }));

  return { summary: summarise(plays), plays };
}

/**
 * Roll the per-play rows into headline numbers.
 *
 * Kept in JS rather than SQL so the definitions sit next to the caveats that
 * qualify them — these are the figures someone will quote in a status meeting,
 * and how they were derived should not be buried in a CASE expression.
 */
function summarise(plays) {
  const measurable = plays.filter(p => p.baselineVariance !== null);
  const completed  = measurable.filter(p => p.completed);

  const onTime = completed.filter(p => p.baselineVariance <= 0).length;

  const slips = completed.map(p => p.baselineVariance).filter(v => v > 0);
  const avgSlip = slips.length
    ? Math.round((slips.reduce((a, b) => a + b, 0) / slips.length) * 10) / 10
    : 0;

  const worst = measurable.reduce(
    (acc, p) => (acc === null || p.baselineVariance > acc.baselineVariance ? p : acc),
    null
  );

  return {
    totalPlays:      plays.length,
    measurable:      measurable.length,
    completed:       completed.length,
    // Percentage of COMPLETED measurable plays that finished on or before
    // baseline. Null rather than 0 when nothing has completed — 0% would read
    // as "everything was late" on a project that has simply not finished
    // anything yet.
    onTimePct:       completed.length ? Math.round((onTime / completed.length) * 100) : null,
    onTimeCount:     onTime,
    // Mean slip across LATE completed plays only. Including early finishes
    // would net the number down and make a late project look punctual.
    avgSlipDays:     avgSlip,
    lateCount:       slips.length,
    openOverdue:     plays.filter(p => p.overdue).length,
    totalRevisions:  plays.reduce((a, p) => a + p.revisionCount, 0),
    rebaselined:     plays.filter(p => p.rebaselineCount > 0).length,
    withEvidence:    plays.filter(p => p.evidenceCount > 0).length,
    adHoc:           plays.filter(p => p.isAdHoc).length,
    // How much of the baseline is guesswork. Non-zero means the headline
    // understates the real slip, and the UI must say so.
    inferredBaselines: measurable.filter(p => p.baselineSource === 'inferred').length,
    worstPlay:       worst ? { id: worst.id, title: worst.title, days: worst.baselineVariance } : null,
  };
}

/**
 * Variance rolled up per stage — where in the plan the time is going.
 */
async function getStageVariance(handoverId, orgId) {
  const { plays } = await getProjectVariance(handoverId, orgId);
  const byStage = new Map();

  for (const p of plays) {
    if (!byStage.has(p.stageKey)) {
      byStage.set(p.stageKey, {
        stageKey: p.stageKey, stageName: p.stageName,
        total: 0, completed: 0, late: 0, openOverdue: 0, slipDays: [],
      });
    }
    const s = byStage.get(p.stageKey);
    s.total++;
    if (p.completed) s.completed++;
    if (p.overdue) s.openOverdue++;
    if (p.baselineVariance > 0) { s.late++; s.slipDays.push(p.baselineVariance); }
  }

  return {
    stages: [...byStage.values()].map(s => ({
      stageKey:    s.stageKey,
      stageName:   s.stageName,
      total:       s.total,
      completed:   s.completed,
      late:        s.late,
      openOverdue: s.openOverdue,
      avgSlipDays: s.slipDays.length
        ? Math.round((s.slipDays.reduce((a, b) => a + b, 0) / s.slipDays.length) * 10) / 10
        : 0,
    })),
  };
}

module.exports = {
  getProjectVariance,
  getStageVariance,
};
