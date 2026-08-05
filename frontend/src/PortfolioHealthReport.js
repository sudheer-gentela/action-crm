// ─────────────────────────────────────────────────────────────────────────────
// PortfolioHealthReport.js
//
// DROP-IN LOCATION: frontend/src/PortfolioHealthReport.js
//
// Reusable R/Y/G portfolio-health rollup. Used in Handovers → Dashboard and in
// the Reporting section (Delivery health tab). Group projects by a chosen lens;
// each group aggregates to red/yellow/green with counts and drill-down.
//
// onOpenProject(id) is optional — defaults to hash-navigating to the project.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useMemo } from 'react';
import { apiService } from './apiService';

const RYG = { red: '#dc2626', yellow: '#d97706', green: '#16a34a', neutral: '#9ca3af' };
const RYG_LABEL = { red: 'Red', yellow: 'Yellow', green: 'Green', neutral: '—' };
// The `service_owner` KEY is the API contract and does not change — the rollup
// endpoint groups on it, and renaming it here would just break the request.
// Only the label shown to a human is negotiable, and it follows the org's own
// vocabulary (2026_90): project override → org default → 'Project Manager'.
//
// The literal below is the same default the database uses, so the label is
// already correct before the lookup returns and does not flicker.
const DEFAULT_LENSES = [
  { k: 'account',       label: 'Account' },
  { k: 'service_owner', label: 'Project Manager' },
  { k: 'status',        label: 'Status' },
  { k: 'none',          label: 'Overall' },
];

function Dot({ health, size = 12 }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: RYG[health] || RYG.neutral }} />;
}

export default function PortfolioHealthReport({ onOpenProject, title = 'Portfolio health', fetcher, lenses = DEFAULT_LENSES, noun = 'projects' }) {
  const load = fetcher || apiService.handovers.healthRollup;
  const [groupBy, setGroupBy]   = useState(lenses[0]?.k || 'none');
  const [data, setData]         = useState(null);
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading]   = useState(true);
  const [managerLabel, setManagerLabel] = useState(null);

  // Only worth a request when a manager lens is actually on offer. The deals
  // rollup passes its own lenses and has no such grouping, so it should not pay
  // for a lookup it will never display.
  const needsManagerLabel = lenses.some(l => l.k === 'service_owner');

  useEffect(() => {
    if (!needsManagerLabel) return undefined;
    let live = true;
    apiService.handovers.projectAccess()
      .then(r => { if (live && r.data?.managerLabel) setManagerLabel(r.data.managerLabel); })
      // Silent on failure: the hard-coded default is already the right answer
      // for almost every org, and a grouping control is not worth an error
      // banner over a label.
      .catch(() => {});
    return () => { live = false; };
  }, [needsManagerLabel]);

  const shownLenses = useMemo(
    () => lenses.map(l => (l.k === 'service_owner' && managerLabel ? { ...l, label: managerLabel } : l)),
    [lenses, managerLabel]
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    load(groupBy)
      .then(r => { if (live) setData(r.data); })
      .catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [groupBy, load]);

  const openProject = (id) => {
    if (onOpenProject) onOpenProject(id);
    else window.location.hash = `#/handovers/${id}`;
  };

  const overall = data?.overall;

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h3>
        {overall && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 8, background: '#f8fafc' }}>
            <Dot health={overall.health} size={16} />
            <span style={{ fontWeight: 700, fontSize: 14, color: RYG[overall.health] }}>{RYG_LABEL[overall.health]}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {overall.red}R · {overall.yellow}Y · {overall.green}G{overall.neutral ? ` · ${overall.neutral} n/a` : ''} ({overall.total})
            </span>
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>Group by</span>
          <select value={groupBy} onChange={e => { setGroupBy(e.target.value); setExpanded({}); }}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db' }}>
            {shownLenses.map(l => <option key={l.k} value={l.k}>{l.label}</option>)}
          </select>
        </div>
      </div>

      {loading ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        : !data || !data.groups.length ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No active {noun}.</div>
        : data.groups.map(g => (
          <div key={g.key} style={{ borderTop: '1px solid #f3f4f6' }}>
            <div onClick={() => setExpanded(x => ({ ...x, [g.key]: !x[g.key] }))}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', cursor: 'pointer' }}>
              <Dot health={g.health} />
              <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{g.label}</span>
              <span style={{ fontSize: 11, color: '#6b7280' }}>
                {g.red > 0 && <span style={{ color: RYG.red }}>{g.red}R </span>}
                {g.yellow > 0 && <span style={{ color: RYG.yellow }}>{g.yellow}Y </span>}
                {g.green > 0 && <span style={{ color: RYG.green }}>{g.green}G</span>}
                <span style={{ marginLeft: 6, color: '#9ca3af' }}>({g.total})</span>
              </span>
              <span style={{ fontSize: 10, color: '#9ca3af' }}>{expanded[g.key] ? '▾' : '▸'}</span>
            </div>
            {expanded[g.key] && g.projects.map(p => (
              <div key={p.id} onClick={() => openProject(p.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px 5px 24px', cursor: 'pointer', fontSize: 12 }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                <Dot health={p.health} size={9} />
                <span style={{ flex: 1 }}>{p.name}</span>
                <span style={{ color: '#9ca3af' }}>{(p.reasons || []).slice(0, 1).join('')}</span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
