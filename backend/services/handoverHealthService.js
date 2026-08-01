// ─────────────────────────────────────────────────────────────────────────────
// handoverHealthService.js
//
// Project (handover) health — the R/Y/G lens for the reporting rollup.
//
// Deals already have a weighted-score engine (dealHealthService). Projects have
// harder signals (something is overdue or it isn't), so this is a RULES engine:
// a project's signals are checked against thresholds → green / yellow / red, with
// human-readable reasons so a red is never a mystery.
//
// Signals come from the handover_deliverable_rollup view (already in the DB):
//   plays_overdue, gates_open, commitments_total/closed/overdue, days_to_go_live.
//
// STANDARD_RULES are sensible defaults; they're structured so an org / program /
// project override can later be merged on top (getRules hook) without touching
// callers. Tune the numbers freely — the shape stays the same.
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');

const STANDARD_RULES = {
  red: {
    golive_passed_incomplete: true,   // go-live date is in the past and not completed
    commitments_overdue_gte: 1,       // any overdue commitment is serious
    plays_overdue_gte: 3,             // several overdue plays
    golive_days_with_open_gates_lte: 7,   // go-live within a week AND gates still open
  },
  yellow: {
    plays_overdue_gte: 1,             // any overdue play
    golive_days_with_open_gates_lte: 14,  // go-live within two weeks AND gates open
    open_commitments_near_golive_days_lte: 14, // unclosed commitments as go-live nears
  },
};

// Merge-over-defaults hook. For now returns the standard; later this can pull an
// org/program/project override row and deep-merge it.
async function getRules(/* orgId, scope */) {
  return STANDARD_RULES;
}

/**
 * Compute a project's health from its signals.
 * @returns {{ status:'green'|'yellow'|'red'|'neutral', active:boolean, reasons:string[] }}
 */
function computeHealth(s, rules = STANDARD_RULES) {
  const status = String(s.status || '');
  // Not "in flight" → no R/Y/G health to roll up.
  if (status === 'completed') return { status: 'green',   active: false, reasons: ['Completed'] };
  if (status === 'cancelled') return { status: 'neutral', active: false, reasons: ['Cancelled'] };
  if (status === 'draft')     return { status: 'neutral', active: false, reasons: ['Draft — not yet active'] };

  const playsOverdue       = Number(s.plays_overdue ?? s.playsOverdue ?? 0);
  const gatesOpen          = Number(s.gates_open ?? s.gatesOpen ?? 0);
  const commitmentsTotal   = Number(s.commitments_total ?? s.commitmentsTotal ?? 0);
  const commitmentsClosed  = Number(s.commitments_closed ?? s.commitmentsClosed ?? 0);
  const commitmentsOverdue = Number(s.commitments_overdue ?? s.commitmentsOverdue ?? 0);
  const daysToGoLive       = (s.days_to_go_live ?? s.daysToGoLive);
  const dGoLive            = daysToGoLive === null || daysToGoLive === undefined ? null : Number(daysToGoLive);
  const openCommitments    = Math.max(0, commitmentsTotal - commitmentsClosed);

  const reasons = [];
  const R = rules.red || {}, Y = rules.yellow || {};

  // ── RED checks ──
  if (R.golive_passed_incomplete && dGoLive !== null && dGoLive < 0)
    reasons.push('Go-live date has passed');
  if (R.commitments_overdue_gte != null && commitmentsOverdue >= R.commitments_overdue_gte)
    reasons.push(`${commitmentsOverdue} overdue commitment${commitmentsOverdue === 1 ? '' : 's'}`);
  if (R.plays_overdue_gte != null && playsOverdue >= R.plays_overdue_gte)
    reasons.push(`${playsOverdue} overdue plays`);
  if (R.golive_days_with_open_gates_lte != null && dGoLive !== null && dGoLive >= 0
      && dGoLive <= R.golive_days_with_open_gates_lte && gatesOpen > 0)
    reasons.push(`Go-live in ${dGoLive}d with ${gatesOpen} gate${gatesOpen === 1 ? '' : 's'} open`);
  if (reasons.length) return { status: 'red', active: true, reasons };

  // ── YELLOW checks ──
  if (Y.plays_overdue_gte != null && playsOverdue >= Y.plays_overdue_gte)
    reasons.push(`${playsOverdue} overdue play${playsOverdue === 1 ? '' : 's'}`);
  if (Y.golive_days_with_open_gates_lte != null && dGoLive !== null && dGoLive >= 0
      && dGoLive <= Y.golive_days_with_open_gates_lte && gatesOpen > 0)
    reasons.push(`Go-live in ${dGoLive}d with ${gatesOpen} gate${gatesOpen === 1 ? '' : 's'} open`);
  if (Y.open_commitments_near_golive_days_lte != null && dGoLive !== null && dGoLive >= 0
      && dGoLive <= Y.open_commitments_near_golive_days_lte && openCommitments > 0)
    reasons.push(`${openCommitments} open commitment${openCommitments === 1 ? '' : 's'} near go-live`);
  if (reasons.length) return { status: 'yellow', active: true, reasons };

  return { status: 'green', active: true, reasons: ['On track'] };
}

/**
 * All projects for an org with computed health + the grouping dimensions the
 * reporting rollup needs. (PM/team/region get added as those attributes land.)
 */
async function listWithHealth(orgId, { includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `SELECT h.id, h.status, h.account_id, h.assigned_service_owner_id AS service_owner_id,
            COALESCE(h.name, d.name) AS project_name, a.name AS account_name,
            h.project_kind,
            (so.first_name || ' ' || so.last_name) AS service_owner_name,
            r.plays_overdue, r.gates_open, r.commitments_total, r.commitments_closed,
            r.commitments_overdue, r.days_to_go_live
       FROM sales_handovers h
       LEFT JOIN deals d ON d.id = h.deal_id
       LEFT JOIN accounts a ON a.id = h.account_id
       LEFT JOIN users so ON so.id = h.assigned_service_owner_id
       LEFT JOIN handover_deliverable_rollup r ON r.handover_id = h.id
      WHERE h.org_id = $1`, [orgId]);

  const rules = await getRules(orgId);
  const projects = rows.map(row => {
    const health = computeHealth(row, rules);
    return {
      id: row.id,
      name: row.project_name || row.account_name || `Project #${row.id}`,
      status: row.status,
      accountId: row.account_id, accountName: row.account_name,
      projectKind: row.project_kind || 'customer',
      serviceOwnerId: row.service_owner_id, serviceOwnerName: row.service_owner_name || 'Unassigned',
      health: health.status, active: health.active, reasons: health.reasons,
    };
  });
  return includeInactive ? projects : projects.filter(p => p.active || p.health === 'green');
}

module.exports = { STANDARD_RULES, getRules, computeHealth, listWithHealth };
