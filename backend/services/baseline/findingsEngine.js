/**
 * baseline/findingsEngine.js
 *
 * DROP-IN LOCATION: backend/services/baseline/findingsEngine.js
 *
 * Deterministic findings from a FROZEN baseline snapshot (+ its frozen schema
 * snapshot). Pure function: same inputs → same findings, every dollar figure
 * traceable to snapshot evidence. No DB, no AI, no CRM.
 *
 * Finding shape:
 *   { id, category, severity: 'high'|'medium'|'info',
 *     headline, detail, dollars?, data?, evidenceRef? }
 *
 * evidenceRef points INTO the snapshot's evidence payload (e.g.
 * 'stall.stalledDeals') so the QBR drill-through is a lookup, not a recompute.
 *
 * Thresholds are constants at the top — deliberately visible and boring.
 * They are editorial judgments, not statistics; when one changes, the report's
 * methodology footnote (reportService) states the value used, so a finding is
 * always checkable against its rule.
 */

const T = {
  STALL_HIGH_MIN_DEALS:        3,     // ≥3 stalled deals → high (else medium)
  LEAKAGE_WORST_TRANSITIONS:   2,     // report the N worst transitions
  LEAKAGE_MIN_N:               8,     // transition needs ≥n entrants to be a finding
  SLOW_STAGE_P75_FACTOR:       1.5,   // p75 > 1.5× cross-stage median p75 → slow
  REGRESSION_RATE_MEDIUM:      0.15,  // >15% of closed deals regressed
  ACTIVITY_COVERAGE_30D_HIGH:  0.50,  // <50% coverage → high
  ACTIVITY_COVERAGE_30D_MED:   0.70,  // <70% → medium
  SINGLE_THREADED_MEDIUM:      0.60,  // >60% single-threaded → medium
  REP_WINRATE_SPREAD_MEDIUM:   0.30,  // max−min win rate across reps > 30pts
  CONFIG_DEBT_FILL_FLOOR:      0.10,  // custom fields under 10% fill = debt
  CONFIG_DEBT_MEDIUM_COUNT:    10,    // ≥10 such fields → medium finding
};

function _fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function _pct(x) { return x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`; }

/**
 * @param {object} snapshot   baseline_snapshots row (metrics, warnings, baseline_config)
 * @param {object|null} schemaPayload  crm_schema_snapshots.schema (config-debt inputs)
 * @returns {{ findings: object[], scoreboard: object }}
 */
function computeFindings(snapshot, schemaPayload) {
  const m = snapshot.metrics || {};
  const cfg = snapshot.baseline_config || {};
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  const findings = [];

  // ── F1: stalled pipeline dollars ─────────────────────────────────────────
  const stall = m.stall || {};
  if ((stall.stalledCount || 0) > 0) {
    findings.push({
      id: 'stalled_pipeline',
      category: 'execution',
      severity: stall.stalledCount >= T.STALL_HIGH_MIN_DEALS ? 'high' : 'medium',
      headline: `${_fmtUsd(stall.dollarsStalled) || 'Pipeline'} sitting in stalled deals`,
      detail:
        `${stall.stalledCount} of ${stall.openDeals} open deals (${_pct(stall.stallRate)}) ` +
        `have been in their current stage longer than that stage's own historical p75 dwell — ` +
        `the threshold is calibrated from this pipeline's history, not an industry guess.`,
      dollars: stall.dollarsStalled ?? null,
      data: { stalledCount: stall.stalledCount, openDeals: stall.openDeals, stallRate: stall.stallRate },
      evidenceRef: 'stall.stalledDeals',
    });
  }

  // ── F2: worst stage-to-stage leakage ─────────────────────────────────────
  const conv = m.conversion || {};
  const eligible = (conv.transitions || [])
    .filter(t => t.rate != null && t.n >= T.LEAKAGE_MIN_N)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, T.LEAKAGE_WORST_TRANSITIONS);
  for (const t of eligible) {
    findings.push({
      id: `leakage_${t.from}_${t.to}`,
      category: 'funnel',
      severity: t.rate < 0.35 ? 'high' : 'medium',
      headline: `Largest funnel leak: ${t.from} → ${t.to} converts at ${_pct(t.rate)}`,
      detail:
        `Of ${t.n} deals that entered ${t.from} in the analysis cohort, only ${_pct(t.rate)} ` +
        `ever reached ${t.to}. Cohort discipline: only deals old enough to have resolved ` +
        `(> ${conv.maxCycleDays} days) or already closed are counted, so this is not an ` +
        `artifact of young deals still in flight.`,
      data: { from: t.from, to: t.to, rate: t.rate, n: t.n },
    });
  }

  // ── F3: slow stages (p75 outliers vs the pipeline's own norm) ────────────
  const cycle = m.cycleTime || {};
  const stageEntries = Object.entries(cycle.byStage || {})
    .filter(([, v]) => v.p75Days != null && v.n >= 3);
  if (stageEntries.length >= 3) {
    const p75s = stageEntries.map(([, v]) => v.p75Days).sort((a, b) => a - b);
    const medP75 = p75s[Math.floor(p75s.length / 2)];
    for (const [stage, v] of stageEntries) {
      if (v.p75Days > medP75 * T.SLOW_STAGE_P75_FACTOR) {
        findings.push({
          id: `slow_stage_${stage}`,
          category: 'execution',
          severity: 'medium',
          headline: `${stage} is the slow stage: p75 dwell ${v.p75Days} days`,
          detail:
            `A quarter of deals spend more than ${v.p75Days} days in ${stage} ` +
            `(median ${v.medianDays}d, n=${v.n}) — ${(v.p75Days / medP75).toFixed(1)}× this ` +
            `pipeline's own typical stage p75 of ${medP75}d.`,
          data: { stage, p75Days: v.p75Days, medianDays: v.medianDays, n: v.n },
          evidenceRef: `cycleTime.${stage}`,
        });
      }
    }
  }

  // ── F4: stage regression ─────────────────────────────────────────────────
  if ((cycle.regressionRate || 0) > T.REGRESSION_RATE_MEDIUM) {
    findings.push({
      id: 'stage_regression',
      category: 'process',
      severity: 'medium',
      headline: `${_pct(cycle.regressionRate)} of closed deals moved backwards through stages`,
      detail:
        `Backwards stage moves usually mean stage definitions are being used as a ` +
        `to-do list rather than a state machine, or that qualification happens after ` +
        `commit stages. Cycle times above use total dwell including re-entries ` +
        `(cycle_calc=${cycle.mode}), so regression does not hide time.`,
      data: { regressionRate: cycle.regressionRate, closedDealsAnalyzed: cycle.closedDealsAnalyzed },
    });
  }

  // ── F5: activity coverage ────────────────────────────────────────────────
  const act = m.activityCoverage || {};
  if (act.coverage30d != null) {
    const sev = act.coverage30d < T.ACTIVITY_COVERAGE_30D_HIGH ? 'high'
      : act.coverage30d < T.ACTIVITY_COVERAGE_30D_MED ? 'medium' : null;
    if (sev) {
      findings.push({
        id: 'activity_gap',
        category: 'execution',
        severity: sev,
        headline: `Only ${_pct(act.coverage30d)} of open deals show logged activity in 30 days`,
        detail:
          `14-day coverage is ${_pct(act.coverage14d)}. Measured from the CRM's own ` +
          `last-activity roll-up, so it reflects LOGGED activity: some of this gap is ` +
          `execution, some is logging hygiene — the report treats those as separate ` +
          `problems with separate fixes.` +
          (act.loggingHygieneNote ? ` (${act.loggingHygieneNote}.)` : ''),
        data: { coverage14d: act.coverage14d, coverage30d: act.coverage30d },
      });
    }
  }

  // ── F6: single-threading ─────────────────────────────────────────────────
  const thr = m.threading || {};
  if (thr.singleThreadedRate != null && thr.singleThreadedRate > T.SINGLE_THREADED_MEDIUM) {
    findings.push({
      id: 'single_threaded',
      category: 'risk',
      severity: 'medium',
      headline: `${_pct(thr.singleThreadedRate)} of open deals are single-threaded`,
      detail:
        `Measured from contact roles/associations on ${thr.dealsWithRoleData} deals. ` +
        `Single-threaded deals carry champion-departure risk and stall harder in ` +
        `procurement.` + (thr.hygieneNote ? ` Caveat: ${thr.hygieneNote}.` : ''),
      data: { singleThreadedRate: thr.singleThreadedRate, dealsWithRoleData: thr.dealsWithRoleData },
    });
  }

  // ── F7: rep win-rate spread ──────────────────────────────────────────────
  const wr = m.winRates || {};
  const repCells = Object.entries(wr.byRep || {})
    .filter(([, v]) => v.winRate != null && !v.suppressed);
  if (repCells.length >= 3) {
    const rates = repCells.map(([, v]) => v.winRate);
    const spread = Math.max(...rates) - Math.min(...rates);
    if (spread > T.REP_WINRATE_SPREAD_MEDIUM) {
      findings.push({
        id: 'rep_winrate_spread',
        category: 'coaching',
        severity: 'medium',
        headline: `${(spread * 100).toFixed(0)}-point win-rate spread across reps`,
        detail:
          `Across ${repCells.length} reps with at least ${wr.minCellN} closed deals each, ` +
          `win rates range from ${_pct(Math.min(...rates))} to ${_pct(Math.max(...rates))}. ` +
          `A spread this wide usually means the playbook lives in the top performers' ` +
          `heads rather than in the process. Cells under n=${wr.minCellN} are suppressed, ` +
          `not shown as noise.`,
        data: { spread, reps: repCells.length },
      });
    }
  }

  // ── F8: configuration debt (from the frozen schema snapshot) ─────────────
  if (schemaPayload) {
    const oppFields = (schemaPayload.fields || {}).Opportunity
                   || (schemaPayload.fields || {}).deals || [];
    const custom = oppFields.filter(f => f.custom);
    const dead = custom.filter(f => f.fillRate != null && f.fillRate < T.CONFIG_DEBT_FILL_FLOOR);
    if (custom.length > 0) {
      findings.push({
        id: 'config_debt_fields',
        category: 'config_debt',
        severity: dead.length >= T.CONFIG_DEBT_MEDIUM_COUNT ? 'medium' : 'info',
        headline: `${custom.length} custom deal fields; ${dead.length} are effectively unused`,
        detail:
          `${dead.length} custom fields are under ${T.CONFIG_DEBT_FILL_FLOOR * 100}% populated ` +
          `over the analysis window${custom.some(f => f.fillRateSampled) ? ' (sampled)' : ''}. ` +
          `Each is a question reps answer with silence — candidates for retirement before ` +
          `any new process is layered on top.`,
        data: {
          customFieldCount: custom.length,
          deadFieldCount: dead.length,
          deadFields: dead.slice(0, 15).map(f => ({ name: f.name, label: f.label, fillRate: f.fillRate })),
        },
      });
    }
    const vrs = (schemaPayload.validation_rules || []).filter(v => v.active);
    if (vrs.length > 0) {
      findings.push({
        id: 'config_debt_validation',
        category: 'config_debt',
        severity: 'info',
        headline: `${vrs.length} active validation rules shape what reps can save`,
        detail:
          `Validation rules explain data patterns before they get misread (required-field ` +
          `rules produce "TBD" compliance, stage-gate rules produce batch updates). Rules ` +
          `touching Opportunity: ${vrs.filter(v => v.object === 'Opportunity').length}.`,
        data: { total: vrs.length, byObject: vrs.reduce((a, v) => { a[v.object] = (a[v.object] || 0) + 1; return a; }, {}) },
      });
    }
    if ((schemaPayload.pipelines || []).length > 1) {
      findings.push({
        id: 'multi_pipeline',
        category: 'config_debt',
        severity: 'info',
        headline: `${schemaPayload.pipelines.length} pipelines / record types in use`,
        detail:
          `Aggregate metrics in this report blend pipelines where the stage map merges ` +
          `them; per-pipeline splits are the recommended follow-up cut before acting on ` +
          `stage-level numbers.`,
      });
    }
  }

  // ── F9: unmapped historical stages (honesty finding) ─────────────────────
  const unmapped = warnings.find(w => w.kind === 'unmapped_historical_stages');
  if (unmapped && unmapped.detail && Object.keys(unmapped.detail).length) {
    const labels = Object.entries(unmapped.detail);
    const total = labels.reduce((s, [, c]) => s + c, 0);
    findings.push({
      id: 'unmapped_history',
      category: 'data_quality',
      severity: 'info',
      headline: `${total} historical stage events were outside the approved stage map`,
      detail:
        `Stages seen only in history (renamed or retired): ` +
        `${labels.slice(0, 6).map(([l, c]) => `"${l}" (${c})`).join(', ')}` +
        `${labels.length > 6 ? '…' : ''}. These events are excluded rather than guessed — ` +
        `extend the stage map and re-capture if they should count.`,
      data: { stages: Object.fromEntries(labels) },
    });
  }

  // ── Scoreboard (headline table for the report cover) ─────────────────────
  const scoreboard = {
    openDeals:          stall.openDeals ?? null,
    dollarsStalled:     stall.dollarsStalled ?? null,
    stallRate:          stall.stallRate ?? null,
    overallWinRate:     conv.overallWinRate ?? null,
    closedAnalyzed:     cycle.closedDealsAnalyzed ?? null,
    regressionRate:     cycle.regressionRate ?? null,
    activityCoverage30: act.coverage30d ?? null,
    singleThreadedRate: thr.singleThreadedRate ?? null,
  };

  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity]));

  return { findings, scoreboard, thresholds: T };
}

module.exports = { computeFindings, THRESHOLDS: T };
