// ActivityTab — Team Reporting → Activity tab.
//
// Rendered inside TeamReportingView; inherits the shared depth + window
// controls as props and fetches its own data (LinkedInRiskPanel pattern):
//   GET /reporting/activity              — raw atoms (calls, action states,
//                                          notification deliveries), scoped
//                                          server-side via ReportingScopeService
//   GET/PUT /reporting/activity-definition — roll-up definitions
//
// All rate arithmetic is CLIENT-SIDE over atoms. A "definition" picks which
// action-state buckets form the numerator/denominator; resolution order is
// user's active saved definition → org default → system default. The formula
// is always displayed next to any rate so a number can never be quoted
// without its definition.
//
// Action-state model (server-derived, seven mutually exclusive states):
//   pending · in_progress · snoozed · skipped · failed · rep_completed ·
//   auto_cleared — see routes/reporting.routes.js ACTION_STATE_CASE.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import './ActivityTab.css';

const STATE_LABELS = {
  pending:       'Pending',
  in_progress:   'In prog',
  snoozed:       'Snoozed',
  skipped:       'Skipped',
  failed:        'Failed',
  rep_completed: 'Rep done',
  auto_cleared:  'Auto-cleared',
};

const SOURCE_LABELS = {
  auto_generated: 'diagnostic',
  signal:         'signal',
  sequence_draft: 'sequence draft',
  playbook:       'playbook',
  manual:         'manual',
};

function fmtNum(n)   { return (n ?? 0).toLocaleString(); }
function fmtMins(s)  {
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
function fmtAge(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  return `${days}d`;
}
function windowQuery(windowState) {
  if (windowState?.kind === 'custom' && windowState.startDate && windowState.endDate) {
    return `startDate=${windowState.startDate}&endDate=${windowState.endDate}`;
  }
  return `windowDays=${windowState?.windowDays || 7}`;
}
function sameDef(a, b) {
  if (!a || !b) return false;
  const s = (x) => [...x].sort().join(',');
  return s(a.numerator) === s(b.numerator) && s(a.denominator) === s(b.denominator);
}
function computeRate(stateTotals, def) {
  if (!def) return { num: 0, den: 0, pct: null };
  const sum = (list) => list.reduce((acc, st) => acc + (stateTotals[st] || 0), 0);
  const num = sum(def.numerator);
  const den = sum(def.denominator);
  return { num, den, pct: den > 0 ? Math.round((100 * num) / den) : null };
}

export default function ActivityTab({ depth, windowState, scope }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  // Definitions
  const [defs, setDefs]           = useState(null);   // GET /activity-definition payload
  const [selection, setSelection] = useState(null);   // 'org' | saved name
  const [workingDef, setWorkingDef] = useState(null); // {numerator:[], denominator:[]}
  const [defBusy, setDefBusy]     = useState(false);
  const [defMsg, setDefMsg]       = useState(null);

  // Drill-down
  const [drillUserId, setDrillUserId] = useState(null);
  const [drillData, setDrillData]     = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const isAdminScope = scope?.scope === 'admin';
  const qs = useMemo(
    () => `depth=${depth || 'direct'}&${windowQuery(windowState)}`,
    [depth, windowState]
  );

  // ── Load atoms ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!depth) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/reporting/activity?${qs}`)
      .then(res => { if (!cancelled) setData(res); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [qs, depth]);

  // ── Load definitions (once) ────────────────────────────────────────────
  const hydrateDefs = useCallback((payload) => {
    setDefs(payload);
    const activeName = payload?.user?.active;
    if (activeName && payload.user.definitions[activeName]) {
      setSelection(activeName);
      setWorkingDef(payload.user.definitions[activeName]);
    } else {
      setSelection('org');
      setWorkingDef(payload?.org_default?.definition || payload?.system_default);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/reporting/activity-definition')
      .then(res => { if (!cancelled) hydrateDefs(res); })
      .catch(() => { /* builder falls back to system default below */ });
    return () => { cancelled = true; };
  }, [hydrateDefs]);

  // ── Drill-down fetch ───────────────────────────────────────────────────
  useEffect(() => {
    if (!drillUserId) { setDrillData(null); return; }
    let cancelled = false;
    setDrillLoading(true);
    apiFetch(`/reporting/activity?${qs}&userId=${drillUserId}`)
      .then(res => { if (!cancelled) setDrillData(res); })
      .catch(() => { if (!cancelled) setDrillData(null); })
      .finally(() => { if (!cancelled) setDrillLoading(false); });
    return () => { cancelled = true; };
  }, [drillUserId, qs]);

  // ── Derived rollups ────────────────────────────────────────────────────
  const states = data?.states
    || ['pending','in_progress','snoozed','skipped','failed','rep_completed','auto_cleared'];

  const derived = useMemo(() => {
    if (!data) return null;
    const repName = {};
    (data.reps || []).forEach(r => { repName[r.user_id] = r.name; });

    // module·source rows + org-wide state totals
    const sourceRows = {};                       // key "module|source" → {module, source, states{}}
    const orgTotals  = {};                       // state → n
    const perRep     = {};                       // userId → { states{}, generated }
    (data.actionAtoms || []).forEach(a => {
      const key = `${a.module}|${a.source}`;
      if (!sourceRows[key]) sourceRows[key] = { module: a.module, source: a.source, states: {} };
      sourceRows[key].states[a.state] = (sourceRows[key].states[a.state] || 0) + a.n;
      orgTotals[a.state] = (orgTotals[a.state] || 0) + a.n;
      if (!perRep[a.user_id]) perRep[a.user_id] = { states: {}, generated: 0 };
      perRep[a.user_id].states[a.state] = (perRep[a.user_id].states[a.state] || 0) + a.n;
      perRep[a.user_id].generated += a.n;
    });

    // calls per rep + org
    const callsPerRep = {};
    let callCount = 0, callSeconds = 0;
    (data.calls || []).forEach(c => {
      if (!callsPerRep[c.user_id]) callsPerRep[c.user_id] = { n: 0, seconds: 0 };
      callsPerRep[c.user_id].n += c.n;
      callsPerRep[c.user_id].seconds += c.duration_seconds;
      callCount += c.n;
      callSeconds += c.duration_seconds;
    });

    // deliveries by channel + per-rep failures
    const byChannel = {};
    const failsPerRep = {};
    let sentTotal = 0, failedTotal = 0;
    (data.deliveries || []).forEach(d => {
      if (!byChannel[d.channel]) byChannel[d.channel] = { sent: 0, failed: 0, skipped: 0 };
      byChannel[d.channel][d.status] = (byChannel[d.channel][d.status] || 0) + d.n;
      if (d.status === 'sent')   sentTotal   += d.n;
      if (d.status === 'failed') {
        failedTotal += d.n;
        failsPerRep[d.user_id] = (failsPerRep[d.user_id] || 0) + d.n;
      }
    });

    const generatedTotal = Object.values(orgTotals).reduce((a, b) => a + b, 0);

    const rows = Object.values(sourceRows)
      .sort((a, b) => (a.module + a.source).localeCompare(b.module + b.source));

    const repRows = (data.scope?.userIds || [])
      .map(id => ({
        userId: id,
        name: repName[id] || `User ${id}`,
        calls: callsPerRep[id]?.n || 0,
        talkSeconds: callsPerRep[id]?.seconds || 0,
        states: perRep[id]?.states || {},
        generated: perRep[id]?.generated || 0,
        notifFails: failsPerRep[id] || 0,
      }))
      .sort((a, b) => b.generated - a.generated || a.name.localeCompare(b.name));

    return { rows, orgTotals, generatedTotal, callCount, callSeconds,
             byChannel, sentTotal, failedTotal, repRows, repName };
  }, [data]);

  // ── Definition helpers ─────────────────────────────────────────────────
  const orgDef    = defs?.org_default?.definition || defs?.system_default
    || { numerator: ['rep_completed'],
         denominator: ['pending','in_progress','snoozed','skipped','failed','rep_completed'] };
  const savedDefs = defs?.user?.definitions || {};
  const baseDef   = selection === 'org' ? orgDef : (savedDefs[selection] || orgDef);
  const effectiveDef = workingDef || baseDef;
  const isDirty   = !sameDef(effectiveDef, baseDef);
  const activeLabel = isDirty ? 'Custom (unsaved)'
    : (selection === 'org' ? 'Org default' : selection);

  const toggleState = (side, st) => {
    setDefMsg(null);
    setWorkingDef(prev => {
      const cur = prev || baseDef;
      const list = cur[side].includes(st)
        ? cur[side].filter(x => x !== st)
        : [...cur[side], st];
      return { ...cur, [side]: list };
    });
  };

  const putDefinition = async (body, successMsg) => {
    setDefBusy(true);
    setDefMsg(null);
    try {
      const res = await apiFetch('/reporting/activity-definition', {
        method: 'PUT', body: JSON.stringify(body),
      });
      if (res.user) setDefs(d => ({ ...d, user: res.user }));
      if (res.org_default) setDefs(d => ({ ...d, org_default: res.org_default }));
      setDefMsg(successMsg);
      return res;
    } catch (err) {
      setDefMsg(err.message);
      return null;
    } finally {
      setDefBusy(false);
    }
  };

  const onSelectDefinition = async (value) => {
    setSelection(value);
    setDefMsg(null);
    if (value === 'org') {
      setWorkingDef(orgDef);
      await putDefinition({ scope: 'user', action: 'set_active', name: null }, null);
    } else {
      setWorkingDef(savedDefs[value]);
      await putDefinition({ scope: 'user', action: 'set_active', name: value }, null);
    }
  };

  const onSave = async () => {
    if (selection === 'org') return onSaveAs();
    const res = await putDefinition(
      { scope: 'user', action: 'save', name: selection, definition: effectiveDef },
      `Saved '${selection}'`);
    if (res) setWorkingDef(res.user.definitions[selection]);
  };

  const onSaveAs = async () => {
    const name = window.prompt('Name this definition (e.g. "Execution rate strict"):');
    if (!name) return;
    const res = await putDefinition(
      { scope: 'user', action: 'save', name, definition: effectiveDef },
      `Saved '${name.trim()}'`);
    if (res) setSelection(name.trim());
  };

  const onDelete = async () => {
    if (selection === 'org') return;
    if (!window.confirm(`Delete saved definition '${selection}'?`)) return;
    const res = await putDefinition(
      { scope: 'user', action: 'delete', name: selection }, `Deleted '${selection}'`);
    if (res) { setSelection('org'); setWorkingDef(orgDef); }
  };

  const onSetOrgDefault = async () => {
    if (!window.confirm('Set this formula as the org default for every user?')) return;
    await putDefinition({ scope: 'org', definition: effectiveDef }, 'Org default updated');
  };

  // ── Render ─────────────────────────────────────────────────────────────
  if (loading && !data) return <div className="trv-empty">Loading activity…</div>;
  if (error)  return <div className="trv-empty">Failed to load activity: {error}</div>;
  if (!derived) return null;

  const orgRate = computeRate(derived.orgTotals, effectiveDef);
  const formulaText = `${effectiveDef.numerator.map(s => STATE_LABELS[s]).join(' + ')} ÷ ${effectiveDef.denominator.map(s => STATE_LABELS[s]).join(' + ')}`;

  return (
    <div className="atv-root">

      <div className="trv-tiles">
        <div className="trv-tile">
          <div className="trv-tile-label">Calls made</div>
          <div className="trv-tile-value">{fmtNum(derived.callCount)}</div>
          <div className="trv-tile-sub">{fmtMins(derived.callSeconds)} talk time</div>
        </div>
        <div className="trv-tile">
          <div className="trv-tile-label">Actions generated</div>
          <div className="trv-tile-value">{fmtNum(derived.generatedTotal)}</div>
          <div className="trv-tile-sub">cohort: created in window</div>
        </div>
        <div className="trv-tile">
          <div className="trv-tile-label">{activeLabel}</div>
          <div className="trv-tile-value">{orgRate.pct === null ? '—' : `${orgRate.pct}%`}</div>
          <div className="trv-tile-sub">{orgRate.num} ÷ {orgRate.den}</div>
        </div>
        <div className="trv-tile">
          <div className="trv-tile-label">Notifications sent</div>
          <div className="trv-tile-value">{fmtNum(derived.sentTotal)}</div>
          <div className={`trv-tile-sub ${derived.failedTotal > 0 ? 'atv-danger' : ''}`}>
            {derived.failedTotal > 0 ? `${derived.failedTotal} failed` : 'no failures'}
          </div>
        </div>
      </div>

      {/* ── Atoms grid ─────────────────────────────────────────────────── */}
      <div className="atv-section">
        <div className="atv-section-title">Actions · atomic view</div>
        <div className="atv-section-sub">each action counts in exactly one state · cohort = created in window, state as of now</div>
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th>Source</th>
                <th className="num">Generated</th>
                {states.map(st => <th key={st} className="num">{STATE_LABELS[st]}</th>)}
              </tr>
            </thead>
            <tbody>
              {derived.rows.map(r => {
                const gen = states.reduce((a, st) => a + (r.states[st] || 0), 0);
                return (
                  <tr key={`${r.module}|${r.source}`}>
                    <td>{r.module === 'deals' ? 'Deals' : 'Prospecting'} · {SOURCE_LABELS[r.source] || r.source}</td>
                    <td className="num">{fmtNum(gen)}</td>
                    {states.map(st => <td key={st} className="num">{fmtNum(r.states[st] || 0)}</td>)}
                  </tr>
                );
              })}
              {derived.rows.length === 0 && (
                <tr><td colSpan={2 + states.length} className="atv-muted">No actions created in this window</td></tr>
              )}
              {derived.rows.length > 0 && (
                <tr className="atv-total-row">
                  <td>All</td>
                  <td className="num">{fmtNum(derived.generatedTotal)}</td>
                  {states.map(st => <td key={st} className="num">{fmtNum(derived.orgTotals[st] || 0)}</td>)}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Roll-up builder ────────────────────────────────────────────── */}
      <div className="atv-section atv-builder">
        <div className="atv-builder-head">
          <div className="atv-section-title">Roll-up definition</div>
          <select
            className="trv-select"
            value={selection || 'org'}
            onChange={e => onSelectDefinition(e.target.value)}
            disabled={defBusy}
          >
            <option value="org">Org default</option>
            {Object.keys(savedDefs).sort().map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          {isDirty && <span className="atv-dirty-badge">Custom (unsaved)</span>}
        </div>

        <div className="atv-builder-grid">
          <div>
            <div className="atv-builder-side-label">Numerator</div>
            {states.map(st => (
              <label key={st} className="atv-check">
                <input
                  type="checkbox"
                  checked={effectiveDef.numerator.includes(st)}
                  onChange={() => toggleState('numerator', st)}
                />
                {STATE_LABELS[st]} ({fmtNum(derived.orgTotals[st] || 0)})
              </label>
            ))}
          </div>
          <div>
            <div className="atv-builder-side-label">Denominator</div>
            {states.map(st => (
              <label key={st} className="atv-check">
                <input
                  type="checkbox"
                  checked={effectiveDef.denominator.includes(st)}
                  onChange={() => toggleState('denominator', st)}
                />
                {STATE_LABELS[st]} ({fmtNum(derived.orgTotals[st] || 0)})
              </label>
            ))}
          </div>
        </div>

        <div className="atv-formula-row">
          <span className="atv-formula">{formulaText}</span>
          <span className="atv-formula-rate">{orgRate.pct === null ? '—' : `${orgRate.pct}%`}</span>
        </div>

        <div className="atv-builder-actions">
          {isDirty && selection !== 'org' && (
            <button onClick={onSave} disabled={defBusy}>Save</button>
          )}
          {isDirty && (
            <button onClick={onSaveAs} disabled={defBusy}>Save as…</button>
          )}
          {isDirty && (
            <button onClick={() => { setWorkingDef(baseDef); setDefMsg(null); }} disabled={defBusy}>
              Reset to {selection === 'org' ? 'org default' : `'${selection}'`}
            </button>
          )}
          {!isDirty && selection !== 'org' && (
            <button onClick={onDelete} disabled={defBusy}>Delete</button>
          )}
          {isAdminScope && (
            <button className="atv-admin-btn" onClick={onSetOrgDefault} disabled={defBusy}>
              Set as org default
            </button>
          )}
          {defMsg && <span className="atv-def-msg">{defMsg}</span>}
        </div>
      </div>

      {/* ── Per-rep table ──────────────────────────────────────────────── */}
      <div className="atv-section">
        <div className="atv-section-title">By rep</div>
        <div className="atv-section-sub">rate uses: {activeLabel} — {formulaText}</div>
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th>Rep</th>
                <th className="num">Calls</th>
                <th className="num">Talk time</th>
                <th className="num">Actions gen</th>
                <th className="num">Rep done</th>
                <th className="num">Auto-cleared</th>
                <th className="num">Rate</th>
                <th className="num">Notif fails</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {derived.repRows.map(r => {
                const rate = computeRate(r.states, effectiveDef);
                return (
                  <tr key={r.userId}>
                    <td>{r.name}</td>
                    <td className="num">{fmtNum(r.calls)}</td>
                    <td className="num">{fmtMins(r.talkSeconds)}</td>
                    <td className="num">{fmtNum(r.generated)}</td>
                    <td className="num">{fmtNum(r.states.rep_completed || 0)}</td>
                    <td className="num">{fmtNum(r.states.auto_cleared || 0)}</td>
                    <td className="num">{rate.pct === null ? '—' : `${rate.pct}%`}</td>
                    <td className={`num ${r.notifFails > 0 ? 'atv-danger' : ''}`}>{fmtNum(r.notifFails)}</td>
                    <td className="num">
                      <button className="atv-view-btn" onClick={() => setDrillUserId(r.userId)}>View</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Deliveries by channel ──────────────────────────────────────── */}
      <div className="atv-section">
        <div className="atv-section-title">Notification deliveries</div>
        <div className="trv-table-wrap">
          <table className="trv-table atv-narrow">
            <thead>
              <tr><th>Channel</th><th className="num">Sent</th><th className="num">Failed</th><th className="num">Skipped</th></tr>
            </thead>
            <tbody>
              {Object.entries(derived.byChannel).sort().map(([ch, s]) => (
                <tr key={ch}>
                  <td>{ch}</td>
                  <td className="num">{fmtNum(s.sent)}</td>
                  <td className={`num ${s.failed > 0 ? 'atv-danger' : ''}`}>{fmtNum(s.failed)}</td>
                  <td className="num">{fmtNum(s.skipped)}</td>
                </tr>
              ))}
              {Object.keys(derived.byChannel).length === 0 && (
                <tr><td colSpan={4} className="atv-muted">No notification deliveries in this window</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Rep drill-down panel ───────────────────────────────────────── */}
      {drillUserId && (
        <div className="atv-panel">
          <div className="atv-panel-head">
            <div>
              <div className="atv-panel-title">{derived.repName[drillUserId] || 'Rep'}</div>
              <div className="atv-section-sub">Activity detail · {data?.window?.description || ''}</div>
            </div>
            <button className="atv-panel-close" onClick={() => setDrillUserId(null)}>✕</button>
          </div>

          {drillLoading && <div className="trv-empty">Loading…</div>}

          {!drillLoading && drillData?.drilldown && (
            <div className="atv-panel-body">
              <div className="atv-panel-section">
                <div className="atv-section-title">Recent calls</div>
                {(drillData.drilldown.recentCalls || []).map(c => (
                  <div key={c.id} className="atv-panel-row">
                    <span>{c.prospect_name || c.company_name || '—'}</span>
                    <span className="atv-muted">
                      {c.outcome || '—'}{c.duration_seconds ? ` · ${fmtMins(c.duration_seconds)}` : ''}
                    </span>
                  </div>
                ))}
                {(drillData.drilldown.recentCalls || []).length === 0 && (
                  <div className="atv-muted">No calls in window</div>
                )}
              </div>

              <div className="atv-panel-section">
                <div className="atv-section-title">Open actions (oldest first)</div>
                {(drillData.drilldown.openActions || []).map(a => (
                  <div key={`${a.module}-${a.id}`} className="atv-panel-row">
                    <span>{a.title}{a.about ? ` · ${a.about}` : ''}</span>
                    <span className="atv-muted">{a.module} · open {fmtAge(a.created_at)}</span>
                  </div>
                ))}
                {(drillData.drilldown.openActions || []).length === 0 && (
                  <div className="atv-muted">Nothing open</div>
                )}
              </div>

              <div className="atv-panel-section">
                <div className="atv-section-title">Delivery failures</div>
                {(drillData.drilldown.deliveryFailures || []).map((f, i) => (
                  <div key={i} className="atv-panel-row">
                    <span className="atv-danger">{f.channel} · {f.reason || 'unknown reason'}</span>
                    <span className="atv-muted">{new Date(f.created_at).toLocaleDateString()}</span>
                  </div>
                ))}
                {(drillData.drilldown.deliveryFailures || []).length === 0 && (
                  <div className="atv-muted">No failures in window</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
