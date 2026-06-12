/**
 * MetricFrameService.js
 *
 * Phase 4 of the Outbound Insights & WBR system (docs/INSIGHTS_WBR_DESIGN.md).
 *
 * Computes WBR frames: trailing 4 COMPLETE weeks (org week-start) with WoW,
 * plus MTD / QTD / YTD each paired with a SAME-DAYS-ELAPSED prior-year
 * comparable. All periods end at YESTERDAY (org-local) — complete days only.
 *
 * Architecture (decision D6 — reusable across modules):
 *   - FRAME CORE (computePeriods, buildFrame): domain-agnostic. Knows org
 *     calendars and period math; knows nothing about prospecting.
 *   - METRIC REGISTRY (REGISTRIES): per-module metric definitions mapping a
 *     metric key to SQL expressions over that module's DAILY-GRAIN COUNTS
 *     table. Prospecting registers against prospecting_metric_daily here.
 *     A future Deals module adds a registry entry + its own snapshot job —
 *     the frame core never changes and NEVER queries transactional tables.
 *
 * Rate discipline (D1): rates are NEVER averaged across periods — every cell
 * recomputes numerator/denominator sums for that period. Cells with a zero
 * denominator return value=null (renders "n/a"), as do prior-year cells with
 * no data (D29 expectation: YoY reads n/a until a year of history exists).
 *
 * Period semantics (D9, D10):
 *   - W-1..W-4 are the four complete weeks before the current (partial) week.
 *   - MTD/QTD/YTD run from the period start through YESTERDAY; their _ly
 *     twins cover the same calendar span one year earlier (Feb-29 clamped).
 *   - Quarters derive from fiscal_year_start_month (org calendar, D2/D3).
 */

const db = require('../config/database');
const MetricSnapshotService = require('./MetricSnapshotService');

// ── metric registries (per module) ───────────────────────────────────────────
// type: 'count' → value = SUM(num)
//       'rate'  → value = SUM(num)/SUM(den), n = SUM(den)
// where: optional row filter applied to BOTH num and den for this metric only.

const REGISTRIES = {
  prospecting: {
    table: 'prospecting_metric_daily',
    dateCol: 'metric_date',
    filterCols: {           // query-level filters → column mapping
      ownerIds: 'owner_id',
      campaignIds: 'campaign_id',
      sequenceIds: 'sequence_id',
      channel: 'channel',
      fitBand: 'fit_band',
    },
    metrics: {
      prospects_added:      { label: 'Prospects added',    type: 'count', num: 'prospects_added' },
      enrolled:             { label: 'Enrolled',           type: 'count', num: 'enrolled' },
      sends:                { label: 'Sends',              type: 'count', num: 'sent' },
      failed:               { label: 'Send failures',      type: 'count', num: 'failed' },
      replies:              { label: 'Replies',            type: 'count', num: 'replies' },
      reply_rate:           { label: 'Reply rate',         type: 'rate',  num: 'replies', den: 'sent' },
      bounces:              { label: 'Bounces/blocks',     type: 'count', num: '(bounces_hard + bounces_soft + blocks)', where: "channel = 'email'" },
      bounce_rate:          { label: 'Bounce rate',        type: 'rate',  num: '(bounces_hard + bounces_soft + blocks)', den: 'sent', where: "channel = 'email'" },
      opens:                { label: 'Opens (directional)', type: 'count', num: 'opens', where: "channel = 'email'" },
      open_rate:            { label: 'Open rate (directional)', type: 'rate', num: 'opens', den: 'sent', where: "channel = 'email'" },
      clicks:               { label: 'Link clicks',        type: 'count', num: 'clicks', where: "channel = 'email'" },
      click_rate:           { label: 'Click rate',         type: 'rate',  num: 'clicks', den: 'sent', where: "channel = 'email'" },
      connections_sent:     { label: 'LI connections sent', type: 'count', num: 'connections_sent' },
      connections_accepted: { label: 'LI connections accepted', type: 'count', num: 'connections_accepted' },
      connection_accept_rate: { label: 'LI accept rate',   type: 'rate',  num: 'connections_accepted', den: 'connections_sent' },
      calls_logged:         { label: 'Calls logged',       type: 'count', num: 'calls_logged' },
      meetings_booked:      { label: 'Meetings booked',    type: 'count', num: 'meetings_booked' },
      qualified:            { label: 'Qualified',          type: 'count', num: 'qualified' },
      converted:            { label: 'Converted',          type: 'count', num: 'converted' },
    },
    defaultMetrics: [
      'sends', 'reply_rate', 'open_rate', 'click_rate', 'bounce_rate', 'connections_sent',
      'connections_accepted', 'meetings_booked', 'qualified', 'converted',
    ],
  },
};

// ── date helpers (string-based YYYY-MM-DD; no TZ pitfalls) ───────────────────

function toUTC(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function fromUTC(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(s, n) { return fromUTC(toUTC(s) + n * 86400000); }
function jsDow(s) { return new Date(toUTC(s)).getUTCDay(); } // 0=Sun..6=Sat
function ymd(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }

/** Same calendar date one year earlier, Feb-29 clamped to Feb-28. */
function minusOneYear(s) {
  const { y, m, d } = ymd(s);
  const day = (m === 2 && d === 29) ? 28 : d;
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Frame core: all period boundaries from the org calendar + "today" (local).
 * Every period ends at yesterday (complete days only).
 */
function computePeriods(todayLocal, calendar) {
  const yesterday = addDays(todayLocal, -1);
  const { y, m } = ymd(todayLocal);

  // Weeks. weekStartDay: 1=Mon..7=Sun → JS dow target.
  const targetDow = calendar.weekStartDay % 7;
  const sinceStart = (jsDow(todayLocal) - targetDow + 7) % 7;
  const currentWeekStart = addDays(todayLocal, -sinceStart);
  const weeks = {};
  for (let i = 1; i <= 4; i++) {
    const start = addDays(currentWeekStart, -7 * i);
    weeks[`w${i}`] = { start, end: addDays(start, 6) };
  }

  // MTD (calendar month).
  const mtdStart = `${y}-${String(m).padStart(2, '0')}-01`;

  // Fiscal quarter + year starts.
  const fyStartMonth = calendar.fiscalYearStartMonth; // 1..12
  const monthsSinceFy = (m - fyStartMonth + 12) % 12;
  const qStartMonthIdx0 = (fyStartMonth - 1) + (Math.floor(monthsSinceFy / 3) * 3); // may exceed 11
  const qYear = y - (m < fyStartMonth ? 1 : 0) + Math.floor(qStartMonthIdx0 / 12);
  const qMonth = (qStartMonthIdx0 % 12) + 1;
  const qtdStart = `${qYear}-${String(qMonth).padStart(2, '0')}-01`;
  const fyYear = y - (m < fyStartMonth ? 1 : 0);
  const ytdStart = `${fyYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  const span = (start) => ({ start, end: yesterday });
  const ly = (p) => ({ start: minusOneYear(p.start), end: minusOneYear(p.end) });

  const periods = {
    w4: weeks.w4, w3: weeks.w3, w2: weeks.w2, w1: weeks.w1,
    mtd: span(mtdStart), qtd: span(qtdStart), ytd: span(ytdStart),
  };
  periods.mtd_ly = ly(periods.mtd);
  periods.qtd_ly = ly(periods.qtd);
  periods.ytd_ly = ly(periods.ytd);
  return { asOf: yesterday, periods };
}

// ── SQL assembly ─────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bucketExpr(period, expr, where, dateCol) {
  // Period dates are internally generated; validate shape then inline
  // (parametrizing ~40 date bounds adds nothing but param-counting bugs).
  if (!DATE_RE.test(period.start) || !DATE_RE.test(period.end)) throw new Error('bad period date');
  const cond = `${dateCol} BETWEEN '${period.start}'::date AND '${period.end}'::date` +
               (where ? ` AND ${where}` : '');
  return `COALESCE(SUM(CASE WHEN ${cond} THEN (${expr}) ELSE 0 END), 0)::numeric`;
}

function cell(type, num, den) {
  num = Number(num); den = den === undefined ? null : Number(den);
  if (type === 'count') return { value: num, n: num };
  return den > 0 ? { value: num / den, n: den } : { value: null, n: den || 0 };
}

function delta(curCell, prevCell, type) {
  if (curCell.value === null || prevCell.value === null) return { delta: null, delta_rel: null };
  const d = curCell.value - prevCell.value;
  return { delta: d, delta_rel: prevCell.value !== 0 ? d / prevCell.value : null };
}

/**
 * Build a WBR frame.
 *
 * @param {number} orgId
 * @param {object} opts
 *   module:   registry key (default 'prospecting')
 *   metrics:  array of metric keys (default registry.defaultMetrics)
 *   filters:  { ownerIds:[], campaignIds:[], sequenceIds:[], channel, fitBand }
 *             ownerIds is how route-layer scoping is enforced (D-scope).
 * @returns {{ asOf, calendar, periods, metrics: [{key,label,type,cells}] }}
 */
async function getFrame(orgId, opts = {}) {
  const reg = REGISTRIES[opts.module || 'prospecting'];
  if (!reg) throw new Error(`Unknown metrics module: ${opts.module}`);
  const metricKeys = (opts.metrics && opts.metrics.length ? opts.metrics : reg.defaultMetrics)
    .filter((k) => reg.metrics[k]);

  const calendar = await MetricSnapshotService.getOrgCalendar(orgId);
  const todayRes = await db.query(`SELECT (now() AT TIME ZONE $1::text)::date::text AS d`, [calendar.timezone]);
  const { asOf, periods } = computePeriods(todayRes.rows[0].d, calendar);

  // WHERE clause from query-level filters (+ org).
  const params = [orgId];
  const wheres = ['org_id = $1'];
  const f = opts.filters || {};
  for (const [k, col] of Object.entries(reg.filterCols)) {
    const v = f[k];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) {
      params.push(v.map(Number).filter(Number.isFinite));
      wheres.push(`${col} = ANY($${params.length}::int[])`);
    } else {
      params.push(String(v));
      wheres.push(`${col} = $${params.length}`);
    }
  }

  // One scan: every (period × metric-part) as a CASE-bucketed sum.
  const selects = [];
  for (const key of metricKeys) {
    const m = reg.metrics[key];
    for (const [pName, p] of Object.entries(periods)) {
      selects.push(`${bucketExpr(p, m.num, m.where, reg.dateCol)} AS "${key}__${pName}__num"`);
      if (m.type === 'rate') {
        selects.push(`${bucketExpr(p, m.den, m.where, reg.dateCol)} AS "${key}__${pName}__den"`);
      }
    }
  }

  const sql = `SELECT ${selects.join(',\n       ')}
                 FROM ${reg.table}
                WHERE ${wheres.join(' AND ')}`;
  const row = (await db.query(sql, params)).rows[0] || {};

  const metrics = metricKeys.map((key) => {
    const m = reg.metrics[key];
    const cells = {};
    for (const pName of Object.keys(periods)) {
      cells[pName] = cell(m.type, row[`${key}__${pName}__num`], row[`${key}__${pName}__den`]);
    }
    cells.wow = delta(cells.w1, cells.w2, m.type);
    cells.mtd_yoy = delta(cells.mtd, cells.mtd_ly, m.type);
    cells.qtd_yoy = delta(cells.qtd, cells.qtd_ly, m.type);
    cells.ytd_yoy = delta(cells.ytd, cells.ytd_ly, m.type);
    return { key, label: m.label, type: m.type, cells };
  });

  return { asOf, calendar, periods, metrics };
}

module.exports = {
  getFrame,
  computePeriods,   // exported for tests
  REGISTRIES,
};
