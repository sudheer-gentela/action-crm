// ─────────────────────────────────────────────────────────────────────────────
// dealsReporting.service.js
//
// Deals module reporting — Tier 1:
//   • pipelineHealth(groupBy)  — deal health (R/Y/G) rolled up by owner/stage/account
//   • funnel()                 — open deals by stage (count + value)
//   • forecast(bucket)         — weighted pipeline (value × probability) by period
//   • winLoss(windowDays, by)  — won/lost + win rate over a window
//
// Deal classification: won = stage 'closed_won' (or stage_type 'won'); lost =
// 'closed_lost'; open = anything else. Deal health lives on deals.health
// (healthy/watch/risk from dealHealthService) → mapped to green/yellow/red.
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('../config/database');

const HEALTH_MAP = { healthy: 'green', watch: 'yellow', risk: 'red' };
const RANK = { red: 0, yellow: 1, green: 2, neutral: 3 };
const aggregate = (c) => c.red > 0 ? 'red' : c.yellow > 0 ? 'yellow' : c.green > 0 ? 'green' : 'neutral';

const OPEN_CLAUSE = `d.stage NOT IN ('closed_won','closed_lost') AND COALESCE(ps.stage_type,'') NOT IN ('won','lost')`;

// ── Pipeline health (R/Y/G) ──────────────────────────────────────────────────
const HEALTH_GROUPERS = {
  owner:   d => ({ key: d.owner_id ?? 0,   label: d.owner_name || 'Unassigned' }),
  stage:   d => ({ key: d.stage,           label: d.stage_name || d.stage }),
  account: d => ({ key: d.account_id ?? 0, label: d.account_name || 'No account' }),
  none:    () => ({ key: 'all',            label: 'All deals' }),
};

async function pipelineHealth(orgId, groupBy = 'owner') {
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.health, d.stage, d.owner_id, d.account_id,
            (o.first_name || ' ' || o.last_name) AS owner_name,
            a.name AS account_name, ps.name AS stage_name
       FROM deals d
       LEFT JOIN users o ON o.id = d.owner_id
       LEFT JOIN accounts a ON a.id = d.account_id
       LEFT JOIN pipeline_stages ps ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
      WHERE d.org_id = $1 AND ${OPEN_CLAUSE}`, [orgId]);

  const grouper = HEALTH_GROUPERS[groupBy] || HEALTH_GROUPERS.owner;
  const groups = new Map();
  const overall = { red: 0, yellow: 0, green: 0, neutral: 0, total: 0 };

  for (const d of rows) {
    const health = HEALTH_MAP[d.health] || 'neutral';
    const { key, label } = grouper(d);
    if (!groups.has(key)) groups.set(key, { key, label, red: 0, yellow: 0, green: 0, neutral: 0, total: 0, projects: [] });
    const g = groups.get(key);
    g[health] += 1; g.total += 1;
    g.projects.push({ id: d.id, name: d.name, health, reasons: [] });
    overall[health] += 1; overall.total += 1;
  }

  const groupList = [...groups.values()]
    .map(g => ({ ...g, health: aggregate(g), projects: g.projects.sort((a, b) => RANK[a.health] - RANK[b.health]) }))
    .sort((a, b) => RANK[a.health] - RANK[b.health] || b.total - a.total);

  return { groupBy, overall: { ...overall, health: aggregate(overall) }, groups: groupList,
           lenses: Object.keys(HEALTH_GROUPERS) };
}

// ── Funnel (open deals by stage) ─────────────────────────────────────────────
async function funnel(orgId) {
  const { rows } = await pool.query(
    `SELECT d.stage, ps.name AS stage_name, COALESCE(ps.sort_order, 999) AS sort_order,
            COUNT(*)::int AS count, COALESCE(SUM(d.value), 0)::float AS value
       FROM deals d
       LEFT JOIN pipeline_stages ps ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
      WHERE d.org_id = $1 AND ${OPEN_CLAUSE}
      GROUP BY d.stage, ps.name, ps.sort_order
      ORDER BY sort_order`, [orgId]);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  return { stages: rows.map(r => ({ stage: r.stage, label: r.stage_name || r.stage, count: r.count, value: r.value })),
           totalValue, totalCount };
}

// ── Forecast (weighted pipeline by period bucket) ────────────────────────────
const BUCKETS = ['week', 'month', 'quarter', 'half'];

function bucketOf(date, bucket) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  if (bucket === 'week') {
    const onejan = new Date(Date.UTC(y, 0, 1));
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
    return { key: `${y}-W${String(week).padStart(2, '0')}`, label: `W${week} ${y}` };
  }
  if (bucket === 'quarter') { const q = Math.floor(d.getUTCMonth() / 3) + 1; return { key: `${y}-Q${q}`, label: `Q${q} ${y}` }; }
  if (bucket === 'half')    { const h = d.getUTCMonth() < 6 ? 1 : 2;         return { key: `${y}-H${h}`, label: `H${h} ${y}` }; }
  const m = d.getUTCMonth();
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return { key: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MON[m]} ${y}` };
}

async function forecast(orgId, bucket = 'month') {
  if (!BUCKETS.includes(bucket)) bucket = 'month';
  const { rows } = await pool.query(
    `SELECT d.value::float AS value, COALESCE(d.probability, 50) AS probability, d.expected_close_date
       FROM deals d
       LEFT JOIN pipeline_stages ps ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
      WHERE d.org_id = $1 AND ${OPEN_CLAUSE} AND d.expected_close_date IS NOT NULL`, [orgId]);

  const map = new Map();
  let totalWeighted = 0, totalRaw = 0;
  for (const r of rows) {
    const { key, label } = bucketOf(r.expected_close_date, bucket);
    const weighted = r.value * (r.probability / 100);
    if (!map.has(key)) map.set(key, { key, label, weighted: 0, raw: 0, count: 0 });
    const b = map.get(key);
    b.weighted += weighted; b.raw += r.value; b.count += 1;
    totalWeighted += weighted; totalRaw += r.value;
  }
  const buckets = [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map(b => ({ ...b, weighted: Math.round(b.weighted), raw: Math.round(b.raw) }));
  return { bucket, buckets, totalWeighted: Math.round(totalWeighted), totalRaw: Math.round(totalRaw), available: BUCKETS };
}

// ── Win / loss ───────────────────────────────────────────────────────────────
async function winLoss(orgId, windowDays = 90, groupBy = 'owner') {
  const { rows } = await pool.query(
    `SELECT d.stage, d.owner_id, d.value::float AS value,
            (o.first_name || ' ' || o.last_name) AS owner_name,
            ps.name AS stage_name,
            CASE WHEN d.stage = 'closed_won' OR ps.stage_type = 'won' THEN 'won'
                 WHEN d.stage = 'closed_lost' THEN 'lost' ELSE 'other' END AS outcome
       FROM deals d
       LEFT JOIN users o ON o.id = d.owner_id
       LEFT JOIN pipeline_stages ps ON ps.org_id = d.org_id AND ps.pipeline = 'sales' AND ps.key = d.stage
      WHERE d.org_id = $1 AND d.closed_at IS NOT NULL
        AND d.closed_at >= NOW() - ($2 || ' days')::interval`, [orgId, windowDays]);

  const mk = () => ({ won: 0, lost: 0, wonValue: 0, lostValue: 0 });
  const overall = mk();
  const groups = new Map();
  const keyOf = (r) => groupBy === 'stage'
    ? { key: r.stage, label: r.stage_name || r.stage }
    : { key: r.owner_id ?? 0, label: r.owner_name || 'Unassigned' };

  for (const r of rows) {
    if (r.outcome === 'other') continue;
    const { key, label } = keyOf(r);
    if (!groups.has(key)) groups.set(key, { key, label, ...mk() });
    const g = groups.get(key);
    if (r.outcome === 'won') { g.won++; g.wonValue += r.value; overall.won++; overall.wonValue += r.value; }
    else { g.lost++; g.lostValue += r.value; overall.lost++; overall.lostValue += r.value; }
  }
  const rate = (c) => (c.won + c.lost) ? Math.round((c.won / (c.won + c.lost)) * 100) : 0;
  const groupList = [...groups.values()]
    .map(g => ({ ...g, winRate: rate(g), wonValue: Math.round(g.wonValue), lostValue: Math.round(g.lostValue) }))
    .sort((a, b) => (b.won + b.lost) - (a.won + a.lost));

  return { windowDays, groupBy,
           overall: { ...overall, winRate: rate(overall), wonValue: Math.round(overall.wonValue), lostValue: Math.round(overall.lostValue) },
           groups: groupList };
}

module.exports = { pipelineHealth, funnel, forecast, winLoss };
