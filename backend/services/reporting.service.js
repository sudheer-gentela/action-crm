// ─────────────────────────────────────────────────────────────────────────────
// reporting.service.js
//
// Health rollup for the portfolio view. Takes every project's computed health
// (handoverHealthService) and groups it by a chosen lens — account, service
// owner, status (PM/team/region slot in as those attributes land) — aggregating
// each group to R/Y/G. Aggregation is strict: a group is red if ANY active
// project is red, yellow if any yellow, else green. Counts are always returned
// so "1 of 12 red" stays visible.
// ─────────────────────────────────────────────────────────────────────────────
const handoverHealth = require('./handoverHealthService');

const GROUPERS = {
  account:       p => ({ key: p.accountId ?? 0,       label: p.accountName || 'No account' }),
  service_owner: p => ({ key: p.serviceOwnerId ?? 0,  label: p.serviceOwnerName || 'Unassigned' }),
  status:        p => ({ key: p.status || 'unknown',  label: p.status || 'unknown' }),
  none:          () => ({ key: 'all',                 label: 'All projects' }),
};

const RANK = { red: 0, yellow: 1, green: 2, neutral: 3 };
const aggregate = (c) => c.red > 0 ? 'red' : c.yellow > 0 ? 'yellow' : c.green > 0 ? 'green' : 'neutral';

async function healthRollup(orgId, groupBy = 'account') {
  const projects = await handoverHealth.listWithHealth(orgId);
  const grouper  = GROUPERS[groupBy] || GROUPERS.account;

  const groups  = new Map();
  const overall = { red: 0, yellow: 0, green: 0, neutral: 0, total: 0 };

  for (const p of projects) {
    const { key, label } = grouper(p);
    if (!groups.has(key)) groups.set(key, { key, label, red: 0, yellow: 0, green: 0, neutral: 0, total: 0, projects: [] });
    const g = groups.get(key);
    g[p.health] = (g[p.health] || 0) + 1;
    g.total += 1;
    g.projects.push({ id: p.id, name: p.name, health: p.health, status: p.status, reasons: p.reasons });
    overall[p.health] = (overall[p.health] || 0) + 1;
    overall.total += 1;
  }

  const groupList = [...groups.values()]
    .map(g => ({ ...g, health: aggregate(g), projects: g.projects.sort((a, b) => RANK[a.health] - RANK[b.health]) }))
    .sort((a, b) => RANK[a.health] - RANK[b.health] || b.total - a.total); // worst groups first, then biggest

  return {
    groupBy,
    overall: { ...overall, health: aggregate(overall) },
    groups: groupList,
    lenses: Object.keys(GROUPERS),
  };
}

module.exports = { healthRollup };
