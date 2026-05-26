// ────────────────────────────────────────────────────────────────────────────
// TeamReportingView.js — Phase 4 of the sequence-reporting feature
// ────────────────────────────────────────────────────────────────────────────
//
// Top-level view reached from sidebar "Reporting". Only mounted when the
// logged-in user's resolved scope is 'team' or 'admin' (App.js gates this).
//
// Three primary tabs over /api/reporting/sequences/*:
//   • "By rep"      → /team-by-rep        (default)
//   • "By campaign" → /team-overview      (clickable rows open drill-down)
//   • "By sequence" → /team-by-sequence
//
// Drill-down (side panel, Option B from the design discussion): reachable
// ONLY from the "By campaign" tab. Clicking a campaign row collapses the
// table into a compact list on the left and opens the campaign's
// /api/prospecting-campaigns/:id/sequence-health on the right with
// groupBy=both (per-sequence + per-rep). Closing returns to the full table.
//
// External entry: when App.js renders this view with a non-null
// `drilldownCampaignId` prop (set by CampaignsView's "Team Activity →" link),
// the view jumps straight to the By-campaign tab with that drill-down open.
//
// Shared toolbar:
//   • Depth selector — persists to /api/users/me/preferences/reporting via PATCH
//   • Time window picker — 24h/7d/30d/custom (custom date inputs inline)
//   • Campaign multi-select (only on tabs 1 and 3 — tab 2 IS the campaign list)
//
// All requests go through apiFetch (token refresh built in). The view is
// pure presentation — no global state, no Redux. Each tab owns its own
// data fetch, retriggered when scope/window/campaignFilter changes.
// ────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from './prospecting/prospectingShared';
import './TeamReportingView.css';

// ── Constants ──────────────────────────────────────────────────────────────
const TEAL = '#0F9D8E';
const DEPTH_OPTIONS = [
  { value: 'direct', label: 'Direct only' },
  { value: 'plus1',  label: 'Direct + 1' },
  { value: 'plus2',  label: 'Direct + 2' },
  { value: 'all',    label: 'All levels' },
];
const WINDOW_PRESETS = [
  { key: '24h', label: '24h', days: 1 },
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
];

// ── Small helpers ──────────────────────────────────────────────────────────
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return `${num.toFixed(1)}%`;
}
function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return Number(n).toLocaleString();
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const now = Date.now();
  const diff = now - dt.getTime();
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)}d ago`;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function depthBadge(meta) {
  // Render "↑ N levels" indirect-report annotation. Returns null for direct
  // reports, viewer-self, and undefined meta.
  if (!meta) return null;
  if (meta.isDirect) return null;
  if (meta.depthFromManager === 0) return null;  // it's the viewer themselves
  const n = meta.depthFromManager;
  if (!n || n < 2) return null;
  return (
    <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 6 }}>
      ↑ {n} levels
    </span>
  );
}
function csvIntsToArray(s) {
  if (!s) return null;
  if (Array.isArray(s)) return s;
  return String(s).split(',').map(t => parseInt(t.trim(), 10)).filter(Number.isInteger);
}
function arrayToCsv(arr) {
  if (!arr || !arr.length) return '';
  return arr.join(',');
}

// ── Window state encoding ──────────────────────────────────────────────────
// The window picker has 3 preset buttons + a "Custom" toggle. We store the
// state as either { kind: 'preset', windowDays } or { kind: 'custom',
// startDate, endDate } — converted to query-string params at fetch time.
function windowToQueryParams(window) {
  if (window.kind === 'custom') {
    return `&startDate=${encodeURIComponent(window.startDate)}&endDate=${encodeURIComponent(window.endDate)}`;
  }
  return `&windowDays=${window.windowDays}`;
}
function windowDescription(window) {
  if (window.kind === 'custom') return `${window.startDate} to ${window.endDate}`;
  return `last ${window.windowDays} days`;
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────
export default function TeamReportingView({ drilldownCampaignId = null, onDrilldownConsumed = null }) {
  // ── Toolbar state ──────────────────────────────────────────────────────
  // Tab default per design: "By rep". External drill-down forces "By campaign".
  const [tab, setTab] = useState(drilldownCampaignId ? 'campaign' : 'rep');
  const [scope, setScope] = useState(null);   // hydrated from /reporting-scope
  const [depth, setDepth] = useState(null);   // null until scope loads
  const [windowState, setWindowState] = useState({ kind: 'preset', windowDays: 7 });
  const [campaignFilter, setCampaignFilter] = useState([]);   // multi-select campaign IDs
  const [allCampaigns, setAllCampaigns] = useState([]);       // for the multi-select dropdown
  const [showCampaignDropdown, setShowCampaignDropdown] = useState(false);
  const [error, setError] = useState(null);

  // ── Drill-down state ───────────────────────────────────────────────────
  const [drillCampaignId, setDrillCampaignId] = useState(drilldownCampaignId);

  // Track which sub-tabs of the drill-down are open (per-sequence and per-rep
  // both render, but allowing collapse/expand keeps it manageable).
  const [drillData,    setDrillData]    = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError,   setDrillError]   = useState(null);

  // ── Per-tab data state ─────────────────────────────────────────────────
  const [repData,        setRepData]        = useState(null);
  const [campaignData,   setCampaignData]   = useState(null);
  const [sequenceData,   setSequenceData]   = useState(null);
  const [tabLoading,     setTabLoading]     = useState(false);

  // Refs to avoid stale closures in async loads
  const lastReqRef = useRef(0);

  // ── Initial scope load + depth hydration ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/users/me/preferences/reporting')
      .then(prefs => {
        if (cancelled) return;
        const d = prefs?.preferences?.depth || 'direct';
        setDepth(d);
        // Don't immediately fetch scope — the depth-effect below will do it.
      })
      .catch(err => {
        if (cancelled) return;
        // If prefs endpoint fails, default depth and continue.
        setDepth('direct');
      });
    return () => { cancelled = true; };
  }, []);

  // Fetch the resolved scope whenever depth changes. Scope drives the title
  // descriptor ("Showing 2 direct reports") and provides reports[] for the
  // depth-badge annotations.
  useEffect(() => {
    if (!depth) return;
    let cancelled = false;
    apiFetch(`/api/users/me/reporting-scope?depth=${depth}`)
      .then(res => {
        if (cancelled) return;
        setScope(res.scope || null);
      })
      .catch(err => {
        if (cancelled) return;
        setError('Could not load reporting scope: ' + err.message);
      });
    return () => { cancelled = true; };
  }, [depth]);

  // ── Persist depth change ───────────────────────────────────────────────
  const onDepthChange = useCallback((newDepth) => {
    setDepth(newDepth);
    // Fire-and-forget; if it fails the user sees no error (the in-session
    // depth still applies). Worst case: their preference doesn't persist.
    apiFetch('/api/users/me/preferences/reporting', {
      method: 'PATCH',
      body: JSON.stringify({ depth: newDepth }),
    }).catch(() => {});
  }, []);

  // ── Tab data fetch ─────────────────────────────────────────────────────
  // Each tab fetches when the toolbar inputs (depth/window/campaignFilter)
  // change. lastReqRef guards against out-of-order responses.
  const queryString = useMemo(() => {
    let q = `depth=${depth || 'direct'}`;
    q += windowToQueryParams(windowState);
    if (campaignFilter.length > 0) q += `&campaignIds=${arrayToCsv(campaignFilter)}`;
    return q;
  }, [depth, windowState, campaignFilter]);

  const loadTab = useCallback(async (which) => {
    if (!depth) return;     // wait for scope hydration
    const reqId = ++lastReqRef.current;
    setTabLoading(true);
    setError(null);

    let url;
    if (which === 'rep')      url = `/api/reporting/sequences/team-by-rep?${queryString}`;
    if (which === 'campaign') url = `/api/reporting/sequences/team-overview?${queryString}`;
    if (which === 'sequence') url = `/api/reporting/sequences/team-by-sequence?${queryString}`;

    try {
      const res = await apiFetch(url);
      if (reqId !== lastReqRef.current) return;   // stale
      if (which === 'rep')      setRepData(res);
      if (which === 'campaign') setCampaignData(res);
      if (which === 'sequence') setSequenceData(res);
    } catch (err) {
      if (reqId !== lastReqRef.current) return;
      setError(`Failed to load ${which}: ${err.message}`);
    } finally {
      if (reqId === lastReqRef.current) setTabLoading(false);
    }
  }, [depth, queryString]);

  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  // ── Drill-down data fetch ──────────────────────────────────────────────
  useEffect(() => {
    if (!drillCampaignId || !depth) {
      setDrillData(null);
      return;
    }
    let cancelled = false;
    setDrillLoading(true);
    setDrillError(null);
    const url = `/api/prospecting-campaigns/${drillCampaignId}/sequence-health?${queryString}&groupBy=both`;
    apiFetch(url)
      .then(res => {
        if (cancelled) return;
        setDrillData(res);
      })
      .catch(err => {
        if (cancelled) return;
        setDrillError(err.message);
      })
      .finally(() => {
        if (!cancelled) setDrillLoading(false);
      });
    return () => { cancelled = true; };
  }, [drillCampaignId, depth, queryString]);

  // External drilldownCampaignId prop — when CampaignsView passes one in,
  // open the drill-down once and then notify the parent so it doesn't keep
  // re-opening it on subsequent renders.
  useEffect(() => {
    if (drilldownCampaignId && drilldownCampaignId !== drillCampaignId) {
      setTab('campaign');
      setDrillCampaignId(drilldownCampaignId);
      onDrilldownConsumed && onDrilldownConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drilldownCampaignId]);

  // ── Campaign list for the multi-select dropdown ────────────────────────
  // We pull from team-overview's response — campaigns[] is the canonical list
  // of in-scope campaigns. Refresh whenever campaign tab data updates.
  useEffect(() => {
    if (campaignData?.campaigns) {
      setAllCampaigns(campaignData.campaigns.map(c => ({ id: c.campaignId, name: c.campaignName })));
    }
  }, [campaignData]);

  // If we haven't loaded the campaign tab yet but the user is on Rep or
  // Sequence and wants to use the campaign filter, fetch the list lazily.
  useEffect(() => {
    if (allCampaigns.length === 0 && tab !== 'campaign' && depth) {
      apiFetch(`/api/reporting/sequences/team-overview?depth=${depth}&windowDays=30`)
        .then(res => {
          if (res?.campaigns) {
            setAllCampaigns(res.campaigns.map(c => ({ id: c.campaignId, name: c.campaignName })));
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, depth]);

  // ── Render ─────────────────────────────────────────────────────────────
  const drilledIn = !!drillCampaignId && tab === 'campaign';

  return (
    <div className="trv-root">
      <Header scope={scope} />
      <TabBar
        tab={tab}
        onTabChange={(t) => {
          setTab(t);
          if (t !== 'campaign') setDrillCampaignId(null);   // exit drill-down
        }}
      />
      <Toolbar
        depth={depth}
        onDepthChange={onDepthChange}
        windowState={windowState}
        onWindowChange={setWindowState}
        campaignFilter={campaignFilter}
        onCampaignFilterChange={setCampaignFilter}
        allCampaigns={allCampaigns}
        showCampaignDropdown={showCampaignDropdown}
        onToggleCampaignDropdown={() => setShowCampaignDropdown(s => !s)}
        showCampaignFilter={tab !== 'campaign'}   // tab 'campaign' IS the campaign list
      />

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {tab === 'rep' && (
        <RepTab data={repData} loading={tabLoading} scope={scope} />
      )}

      {tab === 'campaign' && !drilledIn && (
        <CampaignTab
          data={campaignData}
          loading={tabLoading}
          scope={scope}
          onDrillIn={(campaignId) => setDrillCampaignId(campaignId)}
        />
      )}

      {tab === 'campaign' && drilledIn && (
        <DrilldownView
          campaigns={campaignData?.campaigns || []}
          currentCampaignId={drillCampaignId}
          onPickCampaign={(id) => setDrillCampaignId(id)}
          onExitDrill={() => setDrillCampaignId(null)}
          drillData={drillData}
          drillLoading={drillLoading}
          drillError={drillError}
          scope={scope}
          window={windowState}
        />
      )}

      {tab === 'sequence' && (
        <SequenceTab data={sequenceData} loading={tabLoading} scope={scope} />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header — page title + scope descriptor
// ──────────────────────────────────────────────────────────────────────────
function Header({ scope }) {
  let descriptor = 'Loading scope...';
  if (scope) {
    if (scope.scope === 'admin')      descriptor = `Showing all ${scope.userIds.length} org users (admin)`;
    else if (scope.scope === 'team')  descriptor = scope.sizeNote || `Showing ${scope.reports?.length || 0} reports`;
    else if (scope.scope === 'self')  descriptor = 'No team configured — showing your activity only';
  }
  return (
    <div className="trv-header">
      <div className="trv-title">Team reporting</div>
      <div className="trv-scope-note">
        <span className="trv-scope-icon">ⓘ</span> {descriptor}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TabBar
// ──────────────────────────────────────────────────────────────────────────
function TabBar({ tab, onTabChange }) {
  const tabs = [
    { key: 'rep',      label: 'By rep' },
    { key: 'campaign', label: 'By campaign' },
    { key: 'sequence', label: 'By sequence' },
  ];
  return (
    <div className="trv-tabbar">
      {tabs.map(t => (
        <button
          key={t.key}
          className={`trv-tab ${tab === t.key ? 'active' : ''}`}
          onClick={() => onTabChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Toolbar — depth, window, campaign filter
// ──────────────────────────────────────────────────────────────────────────
function Toolbar({
  depth, onDepthChange,
  windowState, onWindowChange,
  campaignFilter, onCampaignFilterChange,
  allCampaigns, showCampaignDropdown, onToggleCampaignDropdown,
  showCampaignFilter,
}) {
  const isPreset = windowState.kind === 'preset';
  const [customStart, setCustomStart] = useState(
    windowState.kind === 'custom' ? windowState.startDate :
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  );
  const [customEnd, setCustomEnd] = useState(
    windowState.kind === 'custom' ? windowState.endDate :
    new Date().toISOString().slice(0, 10)
  );

  return (
    <div className="trv-toolbar">
      <div className="trv-toolbar-group">
        <span className="trv-toolbar-label">Depth:</span>
        <select
          className="trv-select"
          value={depth || 'direct'}
          onChange={e => onDepthChange(e.target.value)}
        >
          {DEPTH_OPTIONS.map(d => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>

      <div className="trv-toolbar-group">
        <span className="trv-toolbar-label">Window:</span>
        {WINDOW_PRESETS.map(p => (
          <button
            key={p.key}
            className={`trv-window-btn ${isPreset && windowState.windowDays === p.days ? 'active' : ''}`}
            onClick={() => onWindowChange({ kind: 'preset', windowDays: p.days })}
          >
            {p.label}
          </button>
        ))}
        <button
          className={`trv-window-btn ${windowState.kind === 'custom' ? 'active' : ''}`}
          onClick={() => onWindowChange({ kind: 'custom', startDate: customStart, endDate: customEnd })}
        >
          Custom
        </button>
        {windowState.kind === 'custom' && (
          <span className="trv-custom-dates">
            <input
              type="date"
              className="trv-date"
              value={customStart}
              onChange={e => {
                setCustomStart(e.target.value);
                onWindowChange({ kind: 'custom', startDate: e.target.value, endDate: customEnd });
              }}
            />
            <span style={{ color: '#94a3b8' }}>→</span>
            <input
              type="date"
              className="trv-date"
              value={customEnd}
              onChange={e => {
                setCustomEnd(e.target.value);
                onWindowChange({ kind: 'custom', startDate: customStart, endDate: e.target.value });
              }}
            />
          </span>
        )}
      </div>

      {showCampaignFilter && (
        <div className="trv-toolbar-group trv-toolbar-right">
          <span className="trv-toolbar-label">Campaigns:</span>
          <div className="trv-campaign-filter">
            <button className="trv-window-btn" onClick={onToggleCampaignDropdown}>
              {campaignFilter.length === 0 ? 'All' : `${campaignFilter.length} selected`}
              <span style={{ marginLeft: 4 }}>▾</span>
            </button>
            {showCampaignDropdown && (
              <div className="trv-campaign-dropdown">
                <div className="trv-dropdown-actions">
                  <button onClick={() => onCampaignFilterChange([])}>Clear</button>
                </div>
                {allCampaigns.length === 0 && (
                  <div className="trv-dropdown-empty">No campaigns available</div>
                )}
                {allCampaigns.map(c => {
                  const checked = campaignFilter.includes(c.id);
                  return (
                    <label key={c.id} className="trv-dropdown-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          if (checked) onCampaignFilterChange(campaignFilter.filter(id => id !== c.id));
                          else         onCampaignFilterChange([...campaignFilter, c.id]);
                        }}
                      />
                      <span>{c.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// MetricTiles — shared 4-up tile strip
// ──────────────────────────────────────────────────────────────────────────
function MetricTiles({ tiles }) {
  return (
    <div className="trv-tiles">
      {tiles.map((t, i) => (
        <div key={i} className="trv-tile">
          <div className="trv-tile-label">{t.label}</div>
          <div className="trv-tile-value">{t.value}</div>
          {t.sub && <div className="trv-tile-sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// RepTab — per-rep table from /team-by-rep
// ──────────────────────────────────────────────────────────────────────────
function RepTab({ data, loading, scope }) {
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const reps = data.reps || [];
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Active reps',  value: fmtNum(reps.filter(r => r.sent > 0 || r.enrolled > 0).length) },
          { label: 'Enrolled',     value: fmtNum(totals.enrolled) },
          { label: 'Sent',         value: fmtNum(totals.sent) },
          { label: 'Reply rate',   value: fmtPct(totals.repliedRate) },
        ]}
      />
      {reps.length === 0 && <EmptyState message="No rep activity in this window." />}
      {reps.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th>Rep</th>
                <th className="num">Enrolled</th>
                <th className="num">Drafts</th>
                <th className="num">Sent</th>
                <th className="num">Replied</th>
                <th className="num">Failed</th>
                <th className="num">Stalled</th>
                <th className="num">Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {reps.map(r => {
                const isZero = (r.sent || 0) === 0 && (r.enrolled || 0) === 0 && (r.drafts || 0) === 0;
                return (
                  <tr key={r.userId} className={isZero ? 'trv-row-muted' : ''}>
                    <td>
                      {r.name}
                      {depthBadge(r)}
                    </td>
                    <td className="num">{fmtNum(r.enrolled)}</td>
                    <td className="num">{fmtNum(r.drafts)}</td>
                    <td className="num">{fmtNum(r.sent)}</td>
                    <td className="num">{fmtNum(r.replied)}</td>
                    <td className="num">{fmtNum(r.failed)}</td>
                    <td className={`num ${r.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(r.stalled)}</td>
                    <td className="num">{fmtPct(r.repliedRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CampaignTab — per-campaign table from /team-overview
// Rows are clickable to drill in.
// ──────────────────────────────────────────────────────────────────────────
function CampaignTab({ data, loading, scope, onDrillIn }) {
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const campaigns = data.campaigns || [];
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Active campaigns', value: fmtNum(totals.activeCampaigns) },
          { label: 'Enrolled',         value: fmtNum(totals.enrolled) },
          { label: 'Sent',             value: fmtNum(totals.sent) },
          { label: 'Reply rate',       value: fmtPct(totals.repliedRate) },
        ]}
      />
      {campaigns.length === 0 && <EmptyState message="No campaign activity in this window." />}
      {campaigns.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Owner</th>
                <th className="num">Enrolled</th>
                <th className="num">Sent</th>
                <th className="num">Replied</th>
                <th className="num">Stalled</th>
                <th className="num">Reply rate</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <tr key={c.campaignId} className="trv-row-click" onClick={() => onDrillIn(c.campaignId)}>
                  <td className="trv-link">{c.campaignName}</td>
                  <td>
                    {c.owner ? c.owner.name : <span className="trv-muted">—</span>}
                    {c.owner && depthBadge(c.owner)}
                  </td>
                  <td className="num">{fmtNum(c.enrolled)}</td>
                  <td className="num">{fmtNum(c.sent)}</td>
                  <td className="num">{fmtNum(c.replied)}</td>
                  <td className={`num ${c.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(c.stalled)}</td>
                  <td className="num">{fmtPct(c.repliedRate)}</td>
                  <td className="trv-arrow-cell">→</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SequenceTab — per-sequence table from /team-by-sequence
// Surfaces the orphan-bucket activity (sequences run on prospects with no
// campaign) which is invisible to the campaign tab.
// ──────────────────────────────────────────────────────────────────────────
function SequenceTab({ data, loading, scope }) {
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const sequences = data.sequences || [];
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Active sequences', value: fmtNum(totals.activeSequences) },
          { label: 'Enrolled',         value: fmtNum(totals.enrolled) },
          { label: 'Sent',             value: fmtNum(totals.sent) },
          { label: 'Reply rate',       value: fmtPct(totals.repliedRate) },
        ]}
      />
      {sequences.length === 0 && <EmptyState message="No sequence activity in this window." />}
      {sequences.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th>Sequence</th>
                <th>Owner</th>
                <th className="num">Enrolled</th>
                <th className="num">Sent</th>
                <th className="num">Replied</th>
                <th className="num">Stalled</th>
                <th>Top users</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map(s => (
                <tr key={s.sequenceId}>
                  <td>{s.name}</td>
                  <td>
                    {s.owner ? s.owner.name : <span className="trv-muted">—</span>}
                    {s.owner && depthBadge(s.owner)}
                  </td>
                  <td className="num">{fmtNum(s.enrolled)}</td>
                  <td className="num">{fmtNum(s.sent)}</td>
                  <td className="num">{fmtNum(s.replied)}</td>
                  <td className={`num ${s.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(s.stalled)}</td>
                  <td className="trv-topusers">
                    {(s.topUsers || []).slice(0, 3).map((u, i) => (
                      <span key={u.userId} className="trv-topuser-chip">
                        {u.name} <span className="trv-topuser-sub">({u.sent})</span>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DrilldownView — Option B side-panel layout
// Left: compact campaign list. Right: selected campaign's sequence-health
// with byUser block. Reachable only from the Campaign tab.
// ──────────────────────────────────────────────────────────────────────────
function DrilldownView({
  campaigns, currentCampaignId, onPickCampaign, onExitDrill,
  drillData, drillLoading, drillError, scope, window: win,
}) {
  return (
    <div className="trv-tab-body trv-drill-root">
      <div className="trv-drill-list">
        <div className="trv-drill-list-header">
          <button className="trv-back-btn" onClick={onExitDrill}>
            ← Back to all
          </button>
        </div>
        <div className="trv-drill-list-scroll">
          {campaigns.length === 0 && (
            <div className="trv-drill-empty">No campaigns visible.</div>
          )}
          {campaigns.map(c => (
            <button
              key={c.campaignId}
              className={`trv-drill-list-item ${c.campaignId === currentCampaignId ? 'active' : ''}`}
              onClick={() => onPickCampaign(c.campaignId)}
            >
              <div className="trv-drill-item-name">{c.campaignName}</div>
              <div className="trv-drill-item-sub">
                {fmtNum(c.sent)} sent · {fmtNum(c.enrolled)} enrolled
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="trv-drill-panel">
        {drillLoading && !drillData && <LoadingState />}
        {drillError && <ErrorBanner message={drillError} />}
        {drillData && <DrilldownDetail data={drillData} scope={scope} />}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DrilldownDetail — body of the right-side panel
// Per-sequence table + per-rep table, both from the same response.
// ──────────────────────────────────────────────────────────────────────────
function DrilldownDetail({ data, scope }) {
  const health = data.health || [];
  const byUser = data.byUser || [];

  // Build totals from the per-sequence health rows. These match what the
  // top-level campaign row showed — just rolled up from a different angle.
  const totals = health.reduce((acc, h) => {
    acc.sent     += h.last7d?.sent     || 0;
    acc.replied  += h.last7d?.replied  || 0;
    acc.failed   += h.last7d?.failed   || 0;
    acc.drafts   += h.last7d?.drafts   || 0;
    acc.stalled  += h.stalledEnrollments || 0;
    return acc;
  }, { sent: 0, replied: 0, failed: 0, drafts: 0, stalled: 0 });
  const replyRate = totals.sent > 0 ? (totals.replied / totals.sent) * 100 : 0;

  return (
    <div className="trv-drill-detail">
      <div className="trv-drill-detail-tiles">
        <MetricTiles
          tiles={[
            { label: '7d sent',     value: fmtNum(totals.sent) },
            { label: '7d replied',  value: fmtNum(totals.replied) },
            { label: 'Reply rate',  value: fmtPct(replyRate) },
            { label: 'Stalled',     value: fmtNum(totals.stalled) },
          ]}
        />
      </div>

      <div className="trv-drill-section">
        <div className="trv-section-title">By sequence</div>
        {health.length === 0 ? (
          <EmptyState message="No sequences in this campaign." />
        ) : (
          <table className="trv-table trv-table-compact">
            <thead>
              <tr>
                <th>Sequence</th>
                <th className="num">24h sent</th>
                <th className="num">7d sent</th>
                <th className="num">7d replied</th>
                <th className="num">Stalled</th>
                <th className="num">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {health.map(h => (
                <tr key={h.sequenceId}>
                  <td>{h.sequenceName}</td>
                  <td className="num">{fmtNum(h.last24h?.sent)}</td>
                  <td className="num">{fmtNum(h.last7d?.sent)}</td>
                  <td className="num">{fmtNum(h.last7d?.replied)}</td>
                  <td className={`num ${h.stalledEnrollments > 0 ? 'trv-warning' : ''}`}>{fmtNum(h.stalledEnrollments)}</td>
                  <td className="num">{fmtDate(h.lastFiredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="trv-drill-section">
        <div className="trv-section-title">By rep (this campaign, current window)</div>
        {byUser.length === 0 ? (
          <EmptyState message="No rep activity in this campaign for the selected window." />
        ) : (
          <table className="trv-table trv-table-compact">
            <thead>
              <tr>
                <th>Rep</th>
                <th className="num">Enrolled</th>
                <th className="num">Sent</th>
                <th className="num">Replied</th>
                <th className="num">Stalled</th>
                <th className="num">Last fired</th>
              </tr>
            </thead>
            <tbody>
              {byUser.map(u => (
                <tr key={u.userId}>
                  <td>
                    {u.name}
                    {depthBadge(u)}
                  </td>
                  <td className="num">{fmtNum(u.enrolled)}</td>
                  <td className="num">{fmtNum(u.sent)}</td>
                  <td className="num">{fmtNum(u.replied)}</td>
                  <td className={`num ${u.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(u.stalled)}</td>
                  <td className="num">{fmtDate(u.lastFiredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helper sub-components
// ──────────────────────────────────────────────────────────────────────────
function LoadingState() {
  return <div className="trv-loading">Loading…</div>;
}
function EmptyState({ message }) {
  return <div className="trv-empty">{message}</div>;
}
function ErrorBanner({ message, onDismiss }) {
  return (
    <div className="trv-error">
      <span>⚠️ {message}</span>
      {onDismiss && <button onClick={onDismiss} className="trv-error-close">✕</button>}
    </div>
  );
}
