/**
 * OutboundInsightEngine.js
 *
 * Phase 3 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * The aggregate-level sibling of ProspectDiagnosticsEngine: reads the daily
 * snapshot (`prospecting_metric_daily`), detects metric movements against a
 * baseline, isolates the narrowest explaining segment, attributes a cause
 * from the fixed taxonomy, quantifies impact, attaches evidence row IDs, and
 * upserts the top findings into `prospecting_insights` (resolving findings
 * whose condition has cleared).
 *
 * Quality bar enforced here (design doc §1):
 *   (a) delta vs explicit baseline   — 7 complete org-local days ending
 *       YESTERDAY vs the 28 days before that (partial today excluded)
 *   (b) narrowest-segment isolation  — single-dimension greedy: the segment
 *       must explain ≥ ISOLATION_SHARE of the total delta impact with its own
 *       minimum sample, else the finding stays org-wide and says so
 *   (c) causal hypothesis w/evidence — cause_code + hypothesis text + sampled
 *       raw-row IDs (step logs / prospects / delivery events, ≤50 each)
 *   (d) sample-size suppression      — below min sends, NOTHING is emitted;
 *       a digest reps can't trust is worse than no digest
 *   (e) quantified impact + lever    — impact_estimate + recommended_action
 *   Cap: top MAX_INSIGHTS per org per night, ranked by impact. If multiple
 *   dimensions changed simultaneously, the engine says 'mixed_confounded'
 *   rather than guessing.
 *
 * Detectors (v1 — problems only, decision D29):
 *   bounce_rate  — spike vs baseline (email-channel denominator)
 *   reply_rate   — drop vs baseline (all channels)
 *   send_volume  — weekly sends drop vs baseline weekly average
 *   list_runway  — forward-looking: enrollable prospects nearly exhausted
 *
 * Config: organizations.settings.insight_engine (defaults below).
 * Scheduling: runs inside the 03:30 UTC cron in syncScheduler.js, AFTER
 * MetricSnapshotService so tonight's snapshot is what it reads.
 *
 * Every INSERT carries org_id. Keep it that way.
 */

const crypto = require('crypto');
const db = require('../config/database');
const MetricSnapshotService = require('./MetricSnapshotService');

// ── tunables (org-overridable via settings.insight_engine) ───────────────────

const DEFAULTS = {
  minCurrentSends: 30,     // suppression floor for the current window
  minBaselineSends: 60,    // and for the baseline window
  relDeltaThreshold: 0.30, // 30% relative move required
  bounceRateAbsFloor: 0.02,// +2pt absolute bounce-rate rise required
  isolationShare: 0.60,    // segment must explain ≥60% of the delta impact
  minSegmentSends: 20,     // and have its own minimum sample
  lowRunwayCount: 20,      // "list exhaustion" when enrollable prospects ≤ this
  overdueTasksFloor: 10,   // rep_execution attribution floor
  maxInsights: 5,
  evidenceCap: 50,
};

const CUR_DAYS = 7;
const BASE_DAYS = 28;

const ISOLATION_DIMS = [
  'sequence_step_id', 'sequence_id', 'sender_account_id',
  'fit_band', 'owner_id', 'campaign_id',
];

const DIM_CAUSE = {
  sequence_step_id: 'message_step',
  sequence_id: 'message_step',
  sender_account_id: 'deliverability_sender',
  fit_band: 'list_targeting',
  owner_id: 'rep_execution',
  campaign_id: 'list_targeting',
};

// ── small helpers ────────────────────────────────────────────────────────────

function segmentHash(segment) {
  return crypto.createHash('md5').update(JSON.stringify(segment || {})).digest('hex');
}

function rate(n, d) { return d > 0 ? n / d : 0; }
function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function r1(x) { return Math.round(x * 10) / 10; }

async function getInsightConfig(orgId) {
  const r = await db.query(
    `SELECT settings -> 'insight_engine' AS ie FROM organizations WHERE id = $1`, [orgId]
  );
  const ie = r.rows[0]?.ie || {};
  return {
    minCurrentSends: Number.isFinite(ie.min_current_sends) ? ie.min_current_sends : DEFAULTS.minCurrentSends,
    minBaselineSends: Number.isFinite(ie.min_baseline_sends) ? ie.min_baseline_sends : DEFAULTS.minBaselineSends,
    relDeltaThreshold: Number.isFinite(ie.rel_delta_threshold) ? ie.rel_delta_threshold : DEFAULTS.relDeltaThreshold,
    bounceRateAbsFloor: Number.isFinite(ie.bounce_rate_abs_floor) ? ie.bounce_rate_abs_floor : DEFAULTS.bounceRateAbsFloor,
    isolationShare: DEFAULTS.isolationShare,
    minSegmentSends: DEFAULTS.minSegmentSends,
    lowRunwayCount: Number.isFinite(ie.low_runway_count) ? ie.low_runway_count : DEFAULTS.lowRunwayCount,
    overdueTasksFloor: DEFAULTS.overdueTasksFloor,
    maxInsights: Number.isFinite(ie.max_insights) ? ie.max_insights : DEFAULTS.maxInsights,
    evidenceCap: DEFAULTS.evidenceCap,
  };
}

/** Sum a measure over rows matching an optional predicate. */
function sum(rows, measure, pred) {
  let t = 0;
  for (const r of rows) if (!pred || pred(r)) t += Number(r[measure] || 0);
  return t;
}

function bounceTotal(rows, pred) {
  return sum(rows, 'bounces_hard', pred) + sum(rows, 'bounces_soft', pred) + sum(rows, 'blocks', pred);
}

/** Distinct non-sentinel values of a dim across rows. */
function dimValues(rows, dim) {
  const s = new Set();
  for (const r of rows) {
    const v = r[dim];
    if (v !== null && v !== undefined && v !== 0 && v !== '0' && v !== 'none' && v !== 'unknown') s.add(String(v));
  }
  return [...s];
}

// ── label resolution (best-effort, for human-readable segments) ─────────────

async function dimLabel(orgId, dim, value) {
  try {
    if (dim === 'sender_account_id') {
      const r = await db.query(`SELECT COALESCE(label, email) AS l FROM prospecting_sender_accounts WHERE id = $1 AND org_id = $2`, [value, orgId]);
      return r.rows[0]?.l || `sender #${value}`;
    }
    if (dim === 'owner_id') {
      const r = await db.query(`SELECT COALESCE(name, email) AS l FROM users WHERE id = $1`, [value]);
      return r.rows[0]?.l || `user #${value}`;
    }
    if (dim === 'sequence_id') {
      const r = await db.query(`SELECT name AS l FROM sequences WHERE id = $1 AND org_id = $2`, [value, orgId]);
      return r.rows[0]?.l ? `sequence "${r.rows[0].l}"` : `sequence #${value}`;
    }
    if (dim === 'sequence_step_id') {
      const r = await db.query(
        `SELECT s.name AS seq, ss.step_order, ss.channel FROM sequence_steps ss
          JOIN sequences s ON s.id = ss.sequence_id WHERE ss.id = $1`, [value]);
      const row = r.rows[0];
      return row ? `step ${row.step_order} (${row.channel}) of "${row.seq}"` : `step #${value}`;
    }
    if (dim === 'campaign_id') {
      const r = await db.query(`SELECT name AS l FROM prospecting_campaigns WHERE id = $1 AND org_id = $2`, [value, orgId]);
      return r.rows[0]?.l ? `campaign "${r.rows[0].l}"` : `campaign #${value}`;
    }
    if (dim === 'fit_band') return `${value}-fit prospects`;
  } catch (e) { /* label is cosmetic — never fail the run */ }
  return `${dim}=${value}`;
}

// ── isolation ────────────────────────────────────────────────────────────────

/**
 * Greedy single-dimension isolation for a RATE metric.
 * impact(seg) = (baseRate_seg - curRate_seg) * curDenom_seg  [for drops]
 * Returns { dim, value, share, segCur, segBase } or null (org-wide).
 */
function isolateRateDrop(curRows, baseRows, numMeasureFn, denomMeasureFn, totalImpact, cfg, direction = 'drop', dims = ISOLATION_DIMS) {
  const totalCurD = denomMeasureFn(curRows, null);
  let best = null;
  for (const dim of dims) {
    for (const v of dimValues(curRows.concat(baseRows), dim)) {
      const p = (r) => String(r[dim]) === v;
      const curD = denomMeasureFn(curRows, p);
      const baseD = denomMeasureFn(baseRows, p);
      if (curD < cfg.minSegmentSends || baseD < cfg.minSegmentSends) continue;
      // A segment that IS (nearly) the whole population explains nothing —
      // isolation means narrowing. Cap coverage at 90% of the denominator.
      if (totalCurD > 0 && curD > 0.9 * totalCurD) continue;
      const curR = rate(numMeasureFn(curRows, p), curD);
      const baseR = rate(numMeasureFn(baseRows, p), baseD);
      const impact = direction === 'drop' ? (baseR - curR) * curD : (curR - baseR) * curD;
      if (impact <= 0) continue;
      const share = totalImpact > 0 ? impact / totalImpact : 0;
      if (!best || impact > best.impact) {
        best = { dim, value: v, impact, share, segCurRate: curR, segBaseRate: baseR, segCurN: curD, segBaseN: baseD };
      }
    }
  }
  return best && best.share >= cfg.isolationShare ? best : null;
}

/** Per-dim breakdown table for evidence (drill level 2). */
function breakdownFor(curRows, baseRows, dim, numFn, denFn) {
  const out = [];
  for (const v of dimValues(curRows.concat(baseRows), dim)) {
    const p = (r) => String(r[dim]) === v;
    const curD = denFn(curRows, p); const baseD = denFn(baseRows, p);
    if (curD === 0 && baseD === 0) continue;
    out.push({
      dim, value: v,
      cur_rate: r1(rate(numFn(curRows, p), curD) * 1000) / 10,   // % with 1dp
      base_rate: r1(rate(numFn(baseRows, p), baseD) * 1000) / 10,
      cur_n: curD, base_n: baseD,
    });
  }
  return out.sort((a, b) => b.cur_n - a.cur_n).slice(0, 12);
}

// ── evidence sampling (the double-click, D16) ────────────────────────────────

const SEGMENT_SQL = {
  owner_id: 'p.owner_id = $SEG',
  campaign_id: 'COALESCE(p.campaign_id, 0) = $SEG',
  sequence_id: 'se.sequence_id = $SEG',
  sequence_step_id: 'ssl.sequence_step_id = $SEG',
  sender_account_id: 'e.sender_account_id = $SEG',
  fit_band: `(CASE WHEN p.icp_score IS NULL THEN 'unknown' WHEN p.icp_score >= 70 THEN 'high' WHEN p.icp_score >= 40 THEN 'medium' ELSE 'low' END) = $SEG`,
};

async function sampleStepLogEvidence(orgId, winStart, winEnd, segment, cap) {
  const params = [orgId, winStart, winEnd];
  let segClause = '';
  if (segment && segment.dim && SEGMENT_SQL[segment.dim]) {
    params.push(segment.dim === 'fit_band' ? segment.value : Number(segment.value));
    segClause = 'AND ' + SEGMENT_SQL[segment.dim].replace('$SEG', `$${params.length}`);
  }
  params.push(cap);
  const r = await db.query(
    `SELECT ssl.id AS step_log_id, ssl.prospect_id
       FROM sequence_step_logs ssl
       JOIN sequence_enrollments se ON se.id = ssl.enrollment_id AND se.org_id = ssl.org_id
       JOIN prospects p ON p.id = ssl.prospect_id AND p.org_id = ssl.org_id
       LEFT JOIN emails e ON e.id = ssl.email_id AND e.org_id = ssl.org_id
      WHERE ssl.org_id = $1
        AND ssl.status IN ('sent','completed','replied','failed')
        AND ssl.fired_at >= $2::date - INTERVAL '1 day'
        AND ssl.fired_at <  $3::date + INTERVAL '2 days'
        ${segClause}
      ORDER BY ssl.fired_at DESC
      LIMIT $${params.length}`,
    params
  );
  return {
    step_log_ids: r.rows.map((x) => Number(x.step_log_id)),
    prospect_ids: [...new Set(r.rows.map((x) => x.prospect_id).filter(Boolean))],
  };
}

async function sampleDeliveryEvidence(orgId, winStart, winEnd, segment, cap) {
  const params = [orgId, winStart, winEnd];
  let segClause = '';
  if (segment && segment.dim === 'sender_account_id') {
    params.push(Number(segment.value));
    segClause = `AND ede.sender_account_id = $${params.length}`;
  } else if (segment && segment.dim === 'campaign_id') {
    params.push(Number(segment.value));
    segClause = `AND COALESCE(ede.campaign_id, 0) = $${params.length}`;
  } else if (segment && segment.dim === 'owner_id') {
    params.push(Number(segment.value));
    segClause = `AND p.owner_id = $${params.length}`;
  }
  params.push(cap);
  const r = await db.query(
    `SELECT ede.id, ede.prospect_id, ede.step_log_id
       FROM email_delivery_events ede
       LEFT JOIN prospects p ON p.id = ede.prospect_id AND p.org_id = ede.org_id
      WHERE ede.org_id = $1
        AND ede.detected_at >= $2::date - INTERVAL '1 day'
        AND ede.detected_at <  $3::date + INTERVAL '2 days'
        ${segClause}
      ORDER BY ede.detected_at DESC
      LIMIT $${params.length}`,
    params
  );
  return {
    delivery_event_ids: r.rows.map((x) => Number(x.id)),
    prospect_ids: [...new Set(r.rows.map((x) => x.prospect_id).filter(Boolean))],
    step_log_ids: [...new Set(r.rows.map((x) => x.step_log_id).filter(Boolean).map(Number))],
  };
}

// ── detectors ────────────────────────────────────────────────────────────────

async function detectBounceSpike(ctx) {
  const { orgId, curRows, baseRows, cfg, windows } = ctx;
  const emailPred = (r) => r.channel === 'email';
  const curSent = sum(ctx.curRows, 'sent', emailPred);
  const baseSent = sum(ctx.baseRows, 'sent', emailPred);
  if (curSent < cfg.minCurrentSends || baseSent < cfg.minBaselineSends) return null;

  const curB = bounceTotal(curRows, emailPred);
  const baseB = bounceTotal(baseRows, emailPred);
  const curRate = rate(curB, curSent);
  const baseRate = rate(baseB, baseSent);

  const spiked = curRate >= baseRate + cfg.bounceRateAbsFloor &&
                 (baseRate === 0 || curRate >= baseRate * 1.5);
  if (!spiked) return null;

  const totalImpact = (curRate - baseRate) * curSent;
  // Deliverability-relevant dims only: message copy cannot cause bounces,
  // so step/sequence/fit are excluded even when collinear with a sender.
  const iso = isolateRateDrop(
    curRows.filter(emailPred), baseRows.filter(emailPred),
    bounceTotal, (rows, p) => sum(rows, 'sent', p),
    totalImpact, cfg, 'spike',
    ['sender_account_id', 'campaign_id', 'owner_id']
  );

  // Composition decides the cause when not sender-isolated.
  const hardShare = rate(sum(curRows, 'bounces_hard', emailPred), curB || 1);
  const blockShare = rate(sum(curRows, 'blocks', emailPred), curB || 1);
  let cause = 'deliverability_sender';
  if (iso && iso.dim === 'sender_account_id') cause = 'deliverability_sender';
  else if (blockShare >= 0.5) cause = 'deliverability_domain';
  else if (hardShare >= 0.5) cause = 'list_targeting';

  const segment = iso ? { dim: iso.dim, value: iso.value, label: await dimLabel(orgId, iso.dim, iso.value) } : {};
  const where = iso ? `isolated to ${segment.label} (${pct(iso.segCurRate)} vs ${pct(iso.segBaseRate)} baseline)` : 'broad-based across segments';
  const causeText = {
    deliverability_sender: 'a specific sender account is failing — check its auth (SPF/DKIM) and recent volume',
    deliverability_domain: 'rejections are policy/reputation blocks (5.7.x) — check domain auth and Postmaster spam rate',
    list_targeting: 'mostly hard bounces (bad addresses) — recent list/enrichment quality is the likely cause',
  }[cause];

  const evidence = await sampleDeliveryEvidence(orgId, windows.curStart, windows.curEnd, segment.dim ? segment : null, cfg.evidenceCap);
  evidence.breakdown = breakdownFor(curRows.filter(emailPred), baseRows.filter(emailPred),
    iso ? iso.dim : 'sender_account_id', bounceTotal, (rows, p) => sum(rows, 'sent', p));

  return {
    metric: 'bounce_rate', cause_code: cause, segment,
    observed: curRate, baseline: baseRate, observed_n: curSent, baseline_n: baseSent,
    delta_rel: baseRate > 0 ? (curRate - baseRate) / baseRate : null,
    headline: `Bounce rate rose to ${pct(curRate)} (baseline ${pct(baseRate)}), ${where}`,
    hypothesis: `${curB} bounce/block events on ${curSent} email sends this week vs ${baseB}/${baseSent} in the baseline. Composition: ${pct(hardShare)} hard, ${pct(blockShare)} blocks — ${causeText}.`,
    impact_estimate: `~${r1(totalImpact)} extra failed deliveries/week`,
    recommended_action: cause === 'list_targeting'
      ? 'Audit the most recent prospect imports/enrichment for address quality; hard-bounced prospects were auto-stopped.'
      : 'Pause the affected sender, verify SPF/DKIM/DMARC, and re-warm before resuming volume.',
    evidence,
    impactScore: totalImpact * 3, // deliverability problems compound — rank high
  };
}

async function detectReplyDrop(ctx) {
  const { orgId, curRows, baseRows, cfg, windows, bounceSpikeActive } = ctx;
  const curSent = sum(curRows, 'sent');
  const baseSent = sum(baseRows, 'sent');
  if (curSent < cfg.minCurrentSends || baseSent < cfg.minBaselineSends) return null;

  const curRate_ = rate(sum(curRows, 'replies'), curSent);
  const baseRate_ = rate(sum(baseRows, 'replies'), baseSent);
  if (baseRate_ === 0) return null;
  const deltaRel = (curRate_ - baseRate_) / baseRate_;
  if (deltaRel > -cfg.relDeltaThreshold) return null;

  const totalImpact = (baseRate_ - curRate_) * curSent;
  // With an active bounce spike, deliverability is the prior: check the
  // sender dimension first so a collinear step/sender drop attributes to
  // the sender rather than the copy.
  const replyDims = bounceSpikeActive
    ? ['sender_account_id', ...ISOLATION_DIMS.filter((d) => d !== 'sender_account_id')]
    : ISOLATION_DIMS;
  const iso = isolateRateDrop(
    curRows, baseRows,
    (rows, p) => sum(rows, 'replies', p), (rows, p) => sum(rows, 'sent', p),
    totalImpact, cfg, 'drop', replyDims
  );

  let cause = iso ? DIM_CAUSE[iso.dim] : 'mixed_confounded';
  const segment = iso ? { dim: iso.dim, value: iso.value, label: await dimLabel(orgId, iso.dim, iso.value) } : {};

  let hypothesis;
  if (iso) {
    hypothesis = `Drop concentrates in ${segment.label}: ${pct(iso.segCurRate)} this week vs ${pct(iso.segBaseRate)} baseline (n=${iso.segCurN}/${iso.segBaseN}), explaining ~${pct(iso.share)} of the total decline.`;
  } else {
    hypothesis = `Decline is broad-based — no single rep, step, sender, fit band, or campaign explains ≥${pct(cfg.isolationShare)} of it. Multiple variables may have changed simultaneously; treat any single-cause story with suspicion.`;
  }
  if (bounceSpikeActive) {
    cause = iso && iso.dim === 'sender_account_id' ? 'deliverability_sender' : cause;
    hypothesis += ' Note: a bounce-rate spike is active in the same window — deliverability may be suppressing replies; resolve that first.';
  }

  const evidence = await sampleStepLogEvidence(orgId, windows.curStart, windows.curEnd, segment.dim ? segment : null, cfg.evidenceCap);
  evidence.breakdown = breakdownFor(curRows, baseRows, iso ? iso.dim : 'owner_id',
    (rows, p) => sum(rows, 'replies', p), (rows, p) => sum(rows, 'sent', p));

  return {
    metric: 'reply_rate', cause_code: cause, segment,
    observed: curRate_, baseline: baseRate_, observed_n: curSent, baseline_n: baseSent,
    delta_rel: deltaRel,
    headline: `Reply rate fell to ${pct(curRate_)} (baseline ${pct(baseRate_)}, ${pct(Math.abs(deltaRel))} relative drop)${iso ? `, isolated to ${segment.label}` : ', broad-based'}`,
    hypothesis,
    impact_estimate: `~${r1(totalImpact)} lost replies/week at current volume`,
    recommended_action: {
      message_step: 'Review and A/B the copy for the isolated step/sequence against its previous variant.',
      list_targeting: 'Check the fit-gate config and recent enrollment mix — lower-fit prospects are diluting the rate.',
      deliverability_sender: 'Treat as deliverability: verify the sender account before touching copy.',
      rep_execution: 'Review the rep\u2019s send timing and follow-up lag for the window.',
      mixed_confounded: 'Identify what changed this week (copy, list, sender, cadence) and re-test one variable at a time.',
    }[cause],
    evidence,
    impactScore: totalImpact * 2,
  };
}

async function detectVolumeDrop(ctx) {
  const { orgId, curRows, baseRows, cfg } = ctx;
  const curSent = sum(curRows, 'sent');
  const baseWeekly = sum(baseRows, 'sent') / (BASE_DAYS / 7);
  if (baseWeekly < cfg.minCurrentSends) return null;
  const deltaRel = (curSent - baseWeekly) / baseWeekly;
  if (deltaRel > -cfg.relDeltaThreshold) return null;

  // State checks for cause attribution.
  const overdueRes = await db.query(
    `SELECT COALESCE(SUM(tasks_overdue), 0)::int AS n
       FROM prospecting_metric_daily
      WHERE org_id = $1 AND metric_date >= CURRENT_DATE - 1`, [orgId]);
  const overdue = overdueRes.rows[0].n;
  const runwayRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM prospects p
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
        AND p.stage NOT IN ('converted','disqualified','archived')
        AND NOT EXISTS (SELECT 1 FROM sequence_enrollments se
                         WHERE se.prospect_id = p.id AND se.org_id = p.org_id
                           AND se.status = 'active')`, [orgId]);
  const runway = runwayRes.rows[0].n;

  let cause = 'capacity_volume';
  let hypothesis = `Sends fell to ${curSent}/week vs a ${r1(baseWeekly)}/week baseline.`;
  let action = 'Check scheduled-send queues, sender daily limits, and campaign pacing settings.';
  if (runway <= cfg.lowRunwayCount) {
    cause = 'list_exhaustion';
    hypothesis += ` Only ${runway} enrollable prospects remain — the pipeline is starving for input, not failing at execution.`;
    action = 'Source and enroll new prospects matching the ICP; volume cannot recover otherwise.';
  } else if (overdue >= cfg.overdueTasksFloor) {
    cause = 'rep_execution';
    hypothesis += ` ${overdue} prospecting tasks are currently overdue — execution lag, not capacity, is the likely constraint.`;
    action = 'Clear the overdue task queue; check whether auto-send is stalled for any rep.';
  }

  return {
    metric: 'send_volume', cause_code: cause, segment: {},
    observed: curSent, baseline: r1(baseWeekly), observed_n: curSent, baseline_n: Math.round(baseWeekly * 4),
    delta_rel: deltaRel,
    headline: `Send volume dropped ${pct(Math.abs(deltaRel))}: ${curSent} sends this week vs ~${Math.round(baseWeekly)}/week baseline`,
    hypothesis,
    impact_estimate: `~${Math.round(baseWeekly - curSent)} sends/week below baseline (downstream: ~${r1((baseWeekly - curSent) * rate(sum(baseRows, 'replies'), sum(baseRows, 'sent')))} replies/week)`,
    recommended_action: action,
    evidence: { step_log_ids: [], prospect_ids: [], delivery_event_ids: [], breakdown: breakdownFor(curRows, baseRows, 'owner_id', (rows, p) => sum(rows, 'sent', p), (rows, p) => sum(rows, 'sent', p) || 1) },
    impactScore: (baseWeekly - curSent) * rate(sum(baseRows, 'replies'), sum(baseRows, 'sent')) * 2,
    _state: { runway, overdue },
  };
}

async function detectListRunway(ctx, volumeInsight) {
  // Forward-looking exhaustion warning, skipped when the volume detector
  // already attributed list_exhaustion (avoid a duplicate finding).
  if (volumeInsight && volumeInsight.cause_code === 'list_exhaustion') return null;
  const { orgId, curRows, cfg } = ctx;
  if (sum(curRows, 'sent') < cfg.minCurrentSends) return null;

  const runwayRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM prospects p
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
        AND p.stage NOT IN ('converted','disqualified','archived')
        AND NOT EXISTS (SELECT 1 FROM sequence_enrollments se
                         WHERE se.prospect_id = p.id AND se.org_id = p.org_id
                           AND se.status = 'active')`, [orgId]);
  const runway = runwayRes.rows[0].n;
  if (runway > cfg.lowRunwayCount) return null;

  const weeklyEnroll = sum(ctx.baseRows, 'enrolled') / (BASE_DAYS / 7) || 1;
  return {
    metric: 'list_runway', cause_code: 'list_exhaustion', segment: {},
    observed: runway, baseline: cfg.lowRunwayCount, observed_n: runway, baseline_n: 0,
    delta_rel: null,
    headline: `Only ${runway} enrollable prospects remain — roughly ${r1(runway / weeklyEnroll)} week(s) of runway at the current enrollment pace`,
    hypothesis: `Prospects in non-terminal stages with no active enrollment: ${runway}. Send volume will decay regardless of execution once this pool empties.`,
    impact_estimate: `Volume cliff in ~${Math.max(1, Math.round(runway / weeklyEnroll))} week(s)`,
    recommended_action: 'Source new prospects now — list building has multi-day lead time (capture, enrichment, fit-gating).',
    evidence: { step_log_ids: [], prospect_ids: [], delivery_event_ids: [], breakdown: [] },
    impactScore: 5, // always relevant when it fires, but below an active fire
  };
}

async function detectDomainSpamRate(ctx) {
  // Phase 6 — reads domain_health_daily (Postmaster v2 pull). Thresholds per
  // Gmail sender guidelines (D15): <0.1% safe, >=0.3% Gmail may reject.
  // Latest reading per domain within the last 5 days (Postmaster lags 1-3d).
  const { orgId, cfg } = ctx;
  const r = await db.query(
    `SELECT DISTINCT ON (domain) domain, metric_date::text AS d, spam_rate
       FROM domain_health_daily
      WHERE org_id = $1 AND source = 'postmaster_v2'
        AND spam_rate IS NOT NULL
        AND metric_date >= CURRENT_DATE - 5
      ORDER BY domain, metric_date DESC`,
    [orgId]
  );

  const findings = [];
  for (const row of r.rows) {
    const sr = Number(row.spam_rate);
    if (sr < 0.001) continue;
    const critical = sr >= 0.003;

    const hist = await db.query(
      `SELECT metric_date::text AS d, spam_rate
         FROM domain_health_daily
        WHERE org_id = $1 AND domain = $2 AND source = 'postmaster_v2'
          AND spam_rate IS NOT NULL AND metric_date >= CURRENT_DATE - 14
        ORDER BY metric_date`,
      [orgId, row.domain]
    );

    findings.push({
      metric: 'spam_rate', cause_code: 'deliverability_domain',
      segment: { dim: 'domain', value: row.domain, label: row.domain },
      observed: sr, baseline: 0.001, observed_n: 0, baseline_n: 0,
      delta_rel: null,
      headline: critical
        ? `Gmail spam rate for ${row.domain} is ${pct(sr)} — at/above the 0.3% level where Gmail may start rejecting mail`
        : `Gmail spam rate for ${row.domain} is ${pct(sr)} — above the 0.1% safe threshold`,
      hypothesis: `Google Postmaster reports user-marked spam at ${pct(sr)} on ${row.d} (latest reading). Gmail guidelines: stay under 0.1%; sustained 0.3%+ risks bulk rejection. Recent trend: ${hist.rows.map((h) => `${h.d.slice(5)}: ${pct(Number(h.spam_rate))}`).join(', ') || 'single reading'}.`,
      impact_estimate: critical ? 'Risk of Gmail rejecting/spam-foldering the domain\u2019s mail' : 'Early-warning level',
      recommended_action: 'Reduce volume to that domain\u2019s coldest segments, tighten the fit gate, verify one-click unsubscribe, and review recent copy for spam triggers. Re-check Postmaster daily until under 0.1%.',
      evidence: { step_log_ids: [], prospect_ids: [], delivery_event_ids: [],
        breakdown: hist.rows.map((h) => ({ dim: 'date', value: h.d, label: h.d, cur_rate: Math.round(Number(h.spam_rate) * 1000) / 10, base_rate: 0.1, cur_n: 0, base_n: 0 })) },
      impactScore: critical ? 50 : 8,
    });
  }
  return findings;
}

// ── persistence (upsert-and-resolve) ─────────────────────────────────────────

async function upsertInsight(orgId, w, ins) {
  const hash = segmentHash(ins.segment);
  const r = await db.query(
    `INSERT INTO prospecting_insights
       (org_id, metric, cause_code, segment, segment_hash,
        current_window_start, current_window_end, baseline_window_start, baseline_window_end,
        observed, baseline, observed_n, baseline_n, delta_rel,
        headline, hypothesis, impact_estimate, recommended_action, evidence,
        status, first_detected_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'new',now(),now())
     ON CONFLICT (org_id, metric, cause_code, segment_hash)
     DO UPDATE SET
       segment = EXCLUDED.segment,
       current_window_start = EXCLUDED.current_window_start,
       current_window_end   = EXCLUDED.current_window_end,
       baseline_window_start = EXCLUDED.baseline_window_start,
       baseline_window_end   = EXCLUDED.baseline_window_end,
       observed = EXCLUDED.observed, baseline = EXCLUDED.baseline,
       observed_n = EXCLUDED.observed_n, baseline_n = EXCLUDED.baseline_n,
       delta_rel = EXCLUDED.delta_rel,
       headline = EXCLUDED.headline, hypothesis = EXCLUDED.hypothesis,
       impact_estimate = EXCLUDED.impact_estimate,
       recommended_action = EXCLUDED.recommended_action,
       evidence = EXCLUDED.evidence,
       last_seen_at = now(),
       status = CASE WHEN prospecting_insights.status = 'resolved' THEN 'new'
                     ELSE prospecting_insights.status END,
       resolved_at = CASE WHEN prospecting_insights.status = 'resolved' THEN NULL
                          ELSE prospecting_insights.resolved_at END
     RETURNING id`,
    [
      orgId, ins.metric, ins.cause_code, JSON.stringify(ins.segment || {}), hash,
      w.curStart, w.curEnd, w.baseStart, w.baseEnd,
      ins.observed, ins.baseline, ins.observed_n, ins.baseline_n, ins.delta_rel,
      ins.headline, ins.hypothesis, ins.impact_estimate, ins.recommended_action,
      JSON.stringify(ins.evidence || {}),
    ]
  );
  return r.rows[0].id;
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Run the insight engine for one org. Reads prospecting_metric_daily (written
 * earlier in the same nightly job), writes/refreshes prospecting_insights,
 * auto-resolves cleared findings.
 *
 * @returns {{ generated: number, resolved: number, suppressed: boolean }}
 */
async function runForOrg(orgId) {
  const startTime = Date.now();
  const cfg = await getInsightConfig(orgId);
  const cal = await MetricSnapshotService.getOrgCalendar(orgId);

  // Windows: 7 complete org-local days ending yesterday; 28 days before that.
  const wRes = await db.query(
    `SELECT ((now() AT TIME ZONE $1::text)::date - 1)::text                AS cur_end,
            ((now() AT TIME ZONE $1::text)::date - $2::int)::text          AS cur_start,
            ((now() AT TIME ZONE $1::text)::date - $2::int - 1)::text      AS base_end,
            ((now() AT TIME ZONE $1::text)::date - $2::int - $3::int)::text AS base_start`,
    [cal.timezone, CUR_DAYS, BASE_DAYS]
  );
  const w = {
    curStart: wRes.rows[0].cur_start, curEnd: wRes.rows[0].cur_end,
    baseStart: wRes.rows[0].base_start, baseEnd: wRes.rows[0].base_end,
  };

  const rowsRes = await db.query(
    `SELECT *, metric_date::text AS md FROM prospecting_metric_daily
      WHERE org_id = $1 AND metric_date BETWEEN $2::date AND $3::date`,
    [orgId, w.baseStart, w.curEnd]
  );
  const curRows = rowsRes.rows.filter((r) => r.md >= w.curStart);
  const baseRows = rowsRes.rows.filter((r) => r.md < w.curStart);

  const ctx = { orgId, curRows, baseRows, cfg, windows: w };

  const findings = [];
  const bounce = await detectBounceSpike(ctx);
  if (bounce) findings.push(bounce);
  ctx.bounceSpikeActive = !!bounce;

  const reply = await detectReplyDrop(ctx);
  if (reply) findings.push(reply);

  const volume = await detectVolumeDrop(ctx);
  if (volume) findings.push(volume);

  const runway = await detectListRunway(ctx, volume);
  if (runway) findings.push(runway);

  // Phase 6 — Postmaster spam-rate findings (no-op until domain_health_daily
  // has data; never fails the run).
  try {
    findings.push(...await detectDomainSpamRate(ctx));
  } catch (err) {
    console.error(`[InsightEngine] org=${orgId} spam-rate detector error:`, err.message);
  }

  // Rank by impact, cap (quality over quantity — design doc §1).
  findings.sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0));
  const kept = findings.slice(0, cfg.maxInsights);

  const keptIds = [];
  for (const ins of kept) {
    try {
      keptIds.push(await upsertInsight(orgId, w, ins));
    } catch (err) {
      console.error(`[InsightEngine] org=${orgId} upsert failed (${ins.metric}/${ins.cause_code}):`, err.message);
    }
  }

  // Resolve findings whose condition no longer holds.
  const resolveRes = await db.query(
    `UPDATE prospecting_insights
        SET status = 'resolved', resolved_at = now()
      WHERE org_id = $1 AND status IN ('new','acknowledged')
        ${keptIds.length ? `AND id <> ALL($2::bigint[])` : ''}
      RETURNING id`,
    keptIds.length ? [orgId, keptIds] : [orgId]
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[InsightEngine] org=${orgId} done in ${duration}s — ` +
    `generated=${keptIds.length} resolved=${resolveRes.rows.length} ` +
    `window=${w.curStart}..${w.curEnd} vs ${w.baseStart}..${w.baseEnd}`
  );
  return { generated: keptIds.length, resolved: resolveRes.rows.length, suppressed: findings.length === 0 };
}

module.exports = {
  runForOrg,
  DEFAULTS,
  // exported for tests
  getInsightConfig,
  segmentHash,
};
