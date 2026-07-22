/**
 * baseline/metricDefs.js
 *
 * DROP-IN LOCATION: backend/services/baseline/metricDefs.js
 *
 * The versioned metric definitions behind baseline_snapshots. Pure functions:
 * (stage events + open-deal rows + config) in, numbers + evidence out. No DB,
 * no CRM — fully unit-testable, which is the point of splitting it from
 * BaselineCaptureService.
 *
 * METRIC_DEFS_VERSION is stamped onto every snapshot. Change a definition →
 * bump the version → old snapshots stay interpretable. Never edit a
 * definition without bumping.
 *
 * Locked semantics (2026-07-22):
 *   cycle_calc default 'sum_dwell' — total dwell per stage including
 *     re-entries; regression rate always reported separately. 'first_entry'
 *     configurable per connection.
 *   Conversion is cohort-based over closed cohorts only (created earlier than
 *     maxCycleDays before capture) to avoid understating late-stage rates.
 *   Stall threshold self-calibrates: dwell > that stage's own historical p75.
 *   Cells with n < min_cell_n are suppressed (value null, n reported).
 *
 * Input shapes:
 *   stageEvents: NormalizedStageEvent[] from crm/stageHistory.js —
 *     RAW stage labels; this module resolves them via stageResolver.
 *   openDeals:   [{ crmId, stage(raw), amount, createdAt, stageChangedAt,
 *                   ownerId?, ownerName?, segmentValues: {axisKey: value},
 *                   contactRoleCount?, activityLast14?, activityLast30? }]
 *   stageResolver: {
 *     resolve(rawLabel) → { key, isClosed, isWon, sortOrder } | null
 *       (null = unmapped — collected into warnings, never dropped silently)
 *     activeStagesInOrder() → [key,...]
 *   }
 */

const METRIC_DEFS_VERSION = '1.0.0';

// ── small stats helpers ──────────────────────────────────────────────────────

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
function median(xs) { return percentile([...xs].sort((a, b) => a - b), 0.5); }
function p75(xs)    { return percentile([...xs].sort((a, b) => a - b), 0.75); }
const DAY_MS = 86400000;

// ─────────────────────────────────────────────────────────────────────────────
// Per-deal stage timeline assembly (shared by cycle time, conversion, stall)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups events per deal into an ordered timeline with resolved stages.
 * Returns { timelines: Map<crmId, {entries, terminal, regressed}>,
 *           unmappedStages: Map<rawLabel, count> }
 * where entries = [{ stageKey, rawStage, enteredAt, exitedAt|null }].
 */
function buildTimelines(stageEvents, stageResolver, captureAt) {
  const byDeal = new Map();
  for (const ev of stageEvents) {
    if (!byDeal.has(ev.dealCrmId)) byDeal.set(ev.dealCrmId, []);
    byDeal.get(ev.dealCrmId).push(ev);
  }

  const timelines = new Map();
  const unmappedStages = new Map();
  const noteUnmapped = (raw) =>
    unmappedStages.set(raw, (unmappedStages.get(raw) || 0) + 1);

  for (const [crmId, evs] of byDeal) {
    evs.sort((a, b) => new Date(a.changedAt) - new Date(b.changedAt));
    const entries = [];
    let terminal = null;   // { isWon, at, amount } once a closed stage is entered
    let regressed = false;
    const seenOrder = [];

    for (const ev of evs) {
      const resolved = stageResolver.resolve(ev.toStage);
      if (!resolved) { noteUnmapped(ev.toStage); continue; }

      const enteredAt = new Date(ev.changedAt).getTime();
      if (entries.length) entries[entries.length - 1].exitedAt = enteredAt;
      entries.push({
        stageKey: resolved.key, rawStage: ev.toStage,
        enteredAt, exitedAt: null,
        sortOrder: resolved.sortOrder,
      });

      if (seenOrder.length &&
          resolved.sortOrder != null &&
          resolved.sortOrder < seenOrder[seenOrder.length - 1]) {
        regressed = true;
      }
      if (resolved.sortOrder != null) seenOrder.push(resolved.sortOrder);

      if (resolved.isClosed && !terminal) {
        terminal = { isWon: !!resolved.isWon, at: enteredAt, amount: ev.amount };
      }
    }
    // Open-ended final entry dwells until capture.
    if (entries.length && entries[entries.length - 1].exitedAt === null) {
      entries[entries.length - 1].exitedAt = terminal ? terminal.at
        : new Date(captureAt).getTime();
      if (entries[entries.length - 1].exitedAt < entries[entries.length - 1].enteredAt) {
        entries[entries.length - 1].exitedAt = entries[entries.length - 1].enteredAt;
      }
    }
    timelines.set(crmId, { entries, terminal, regressed });
  }
  return { timelines, unmappedStages };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 1 — cycle time by stage (median, p75) + regression rate
// ─────────────────────────────────────────────────────────────────────────────

function computeCycleTime({ timelines }, config) {
  const mode = config.cycle_calc || 'sum_dwell';
  const perStage = new Map(); // stageKey → [days,...] (closed deals only)
  let closedCount = 0, regressedCount = 0;
  const evidence = {}; // stageKey → [crmId,...]

  for (const [crmId, tl] of timelines) {
    if (!tl.terminal) continue;                 // open deals excluded (locked)
    closedCount++;
    if (tl.regressed) regressedCount++;

    const dwell = new Map(); // stageKey → ms
    const seen = new Set();
    for (const e of tl.entries) {
      if (e.exitedAt == null) continue;
      if (mode === 'first_entry' && seen.has(e.stageKey)) continue;
      seen.add(e.stageKey);
      dwell.set(e.stageKey, (dwell.get(e.stageKey) || 0) + (e.exitedAt - e.enteredAt));
    }
    for (const [k, ms] of dwell) {
      if (!perStage.has(k)) { perStage.set(k, []); evidence[k] = []; }
      perStage.get(k).push(ms / DAY_MS);
      evidence[k].push(crmId);
    }
  }

  const byStage = {};
  for (const [k, days] of perStage) {
    byStage[k] = {
      medianDays: median(days) != null ? Number(median(days).toFixed(1)) : null,
      p75Days:    p75(days)    != null ? Number(p75(days).toFixed(1))    : null,
      n:          days.length,
    };
  }
  return {
    metrics: {
      mode,
      byStage,
      closedDealsAnalyzed: closedCount,
      regressionRate: closedCount ? Number((regressedCount / closedCount).toFixed(4)) : null,
    },
    evidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 2 — stage-to-stage conversion (cohort-based, closed cohorts only)
// ─────────────────────────────────────────────────────────────────────────────

function computeConversion({ timelines }, stageResolver, config, captureAt) {
  const order = stageResolver.activeStagesInOrder();
  const maxCycleDays = config.max_cycle_days || 270; // cohort-maturity cutoff
  const cutoff = new Date(captureAt).getTime() - maxCycleDays * DAY_MS;

  const entered = new Map(order.map(k => [k, new Set()]));
  const won = new Set();
  let cohortSize = 0;

  for (const [crmId, tl] of timelines) {
    if (!tl.entries.length) continue;
    const firstSeen = tl.entries[0].enteredAt;
    // Closed-cohort discipline: deal must be terminal OR old enough that
    // still-open counts as a real non-conversion, not an immature cohort.
    if (!tl.terminal && firstSeen > cutoff) continue;
    cohortSize++;
    for (const e of tl.entries) {
      if (entered.has(e.stageKey)) entered.get(e.stageKey).add(crmId);
    }
    if (tl.terminal && tl.terminal.isWon) won.add(crmId);
  }

  const transitions = [];
  for (let i = 0; i < order.length - 1; i++) {
    const a = entered.get(order[i]).size;
    const b = [...entered.get(order[i + 1])]
      .filter(id => entered.get(order[i]).has(id)).length;
    transitions.push({
      from: order[i], to: order[i + 1],
      rate: a > 0 ? Number((b / a).toFixed(4)) : null,
      n: a,
    });
  }
  const firstStageN = order.length ? entered.get(order[0]).size : 0;

  return {
    metrics: {
      cohortSize,
      maxCycleDays,
      transitions,
      overallWinRate: firstStageN ? Number((won.size / firstStageN).toFixed(4)) : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 3 — open-deal age distribution + stall (self-calibrated vs p75)
// ─────────────────────────────────────────────────────────────────────────────

function computeStall(openDeals, cycleByStage, stageResolver, captureAt) {
  const now = new Date(captureAt).getTime();
  const ages = [];
  const stalled = [];
  let unmappedOpen = 0;

  for (const d of openDeals) {
    const resolved = stageResolver.resolve(d.stage);
    if (!resolved) { unmappedOpen++; continue; }
    if (resolved.isClosed) continue;

    const ageDays = d.createdAt ? (now - new Date(d.createdAt).getTime()) / DAY_MS : null;
    if (ageDays != null) ages.push(ageDays);

    const dwellDays = d.stageChangedAt
      ? (now - new Date(d.stageChangedAt).getTime()) / DAY_MS : null;
    const threshold = cycleByStage[resolved.key] && cycleByStage[resolved.key].p75Days;
    if (dwellDays != null && threshold != null && dwellDays > threshold) {
      stalled.push({
        crmId: d.crmId, stage: resolved.key,
        dwellDays: Number(dwellDays.toFixed(1)),
        thresholdDays: threshold,
        amount: d.amount != null ? Number(d.amount) : null,
      });
    }
  }

  const sorted = [...ages].sort((a, b) => a - b);
  const dollarsStalled = stalled.reduce((s, x) => s + (x.amount || 0), 0);
  return {
    metrics: {
      openDeals: openDeals.length,
      ageDistributionDays: {
        median: median(ages) != null ? Number(median(ages).toFixed(1)) : null,
        p75:    p75(ages)    != null ? Number(p75(ages).toFixed(1))    : null,
        p90:    percentile(sorted, 0.9) != null ? Number(percentile(sorted, 0.9).toFixed(1)) : null,
      },
      stalledCount: stalled.length,
      stallRate: openDeals.length ? Number((stalled.length / openDeals.length).toFixed(4)) : null,
      dollarsStalled: Number(dollarsStalled.toFixed(2)),
      unmappedOpen,
    },
    evidence: { stalledDeals: stalled },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 4 — activity coverage (+ hygiene honesty)
// ─────────────────────────────────────────────────────────────────────────────

function computeActivityCoverage(openDeals) {
  const known = openDeals.filter(d => d.activityLast14 != null || d.activityLast30 != null);
  const c14 = known.filter(d => (d.activityLast14 || 0) > 0).length;
  const c30 = known.filter(d => (d.activityLast30 || 0) > 0).length;
  return {
    metrics: {
      dealsWithActivityData: known.length,
      coverage14d: known.length ? Number((c14 / known.length).toFixed(4)) : null,
      coverage30d: known.length ? Number((c30 / known.length).toFixed(4)) : null,
      // Hygiene finding, reported SEPARATELY so low coverage doesn't
      // silently libel reps who simply don't log in the CRM.
      loggingHygieneNote: known.length < openDeals.length
        ? `${openDeals.length - known.length} open deals had no readable activity data`
        : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 5 — win rate by segment axes and by rep (min_cell_n suppression)
// ─────────────────────────────────────────────────────────────────────────────

function computeWinRates({ timelines }, closedDealMeta, config) {
  // closedDealMeta: Map<crmId, { ownerName?, segmentValues: {axisKey: value} }>
  const minN = config.min_cell_n || 5;
  const axes = (config.segment_axes || []).map(a => a.field);

  const cells = { byRep: {}, byAxis: {} };
  for (const axis of axes) cells.byAxis[axis] = {};

  for (const [crmId, tl] of timelines) {
    if (!tl.terminal) continue;
    const meta = closedDealMeta.get(crmId) || { segmentValues: {} };
    const isWon = tl.terminal.isWon;

    const bump = (bucket, key) => {
      if (key == null || key === '') key = '(blank)';
      if (!bucket[key]) bucket[key] = { won: 0, n: 0 };
      bucket[key].n++;
      if (isWon) bucket[key].won++;
    };
    bump(cells.byRep, meta.ownerName);
    for (const axis of axes) bump(cells.byAxis[axis], (meta.segmentValues || {})[axis]);
  }

  const finalize = (bucket) => {
    const out = {};
    for (const [k, v] of Object.entries(bucket)) {
      out[k] = v.n >= minN
        ? { winRate: Number((v.won / v.n).toFixed(4)), n: v.n }
        : { winRate: null, n: v.n, suppressed: true };   // n < floor: no noise
    }
    return out;
  };

  return {
    metrics: {
      minCellN: minN,
      byRep: finalize(cells.byRep),
      byAxis: Object.fromEntries(axes.map(a => [a, finalize(cells.byAxis[a])])),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric 6 — single- vs multi-threaded (hygiene-caveated)
// ─────────────────────────────────────────────────────────────────────────────

function computeThreading(openDeals) {
  const known = openDeals.filter(d => d.contactRoleCount != null);
  const single = known.filter(d => d.contactRoleCount <= 1).length;
  return {
    metrics: {
      dealsWithRoleData: known.length,
      singleThreadedRate: known.length ? Number((single / known.length).toFixed(4)) : null,
      hygieneNote: known.length < openDeals.length
        ? `${openDeals.length - known.length} open deals had no contact-role data (weak signal where role hygiene is poor)`
        : null,
    },
  };
}

module.exports = {
  METRIC_DEFS_VERSION,
  buildTimelines,
  computeCycleTime,
  computeConversion,
  computeStall,
  computeActivityCoverage,
  computeWinRates,
  computeThreading,
};
