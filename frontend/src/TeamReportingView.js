// ────────────────────────────────────────────────────────────────────────────
// TeamReportingView.js — Phase 4 of the sequence-reporting feature
// ────────────────────────────────────────────────────────────────────────────
//
// Top-level view reached from sidebar "Reporting". Only mounted when the
// logged-in user's resolved scope is 'team' or 'admin' (App.js gates this).
//
// Three primary tabs over /reporting/sequences/*:
//   • "By rep"      → /team-by-rep        (default)
//   • "By campaign" → /team-overview      (clickable rows open drill-down)
//   • "By sequence" → /team-by-sequence
//
// Drill-down (side panel, Option B from the design discussion): reachable
// ONLY from the "By campaign" tab. Clicking a campaign row collapses the
// table into a compact list on the left and opens the campaign's
// /prospecting-campaigns/:id/sequence-health on the right with
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
import WbrGrid from './prospecting/WbrGrid';                  // Insights/WBR Phase 5
import InsightsPanel from './prospecting/InsightsPanel';      // Insights/WBR Phase 5
import LinkedInRiskPanel from './prospecting/LinkedInRiskPanel';
import ActivityTab from './prospecting/ActivityTab';
import './TeamReportingView.css';
import LinkedInFunnelPanel from './prospecting/LinkedInFunnelPanel';

// ── Constants ──────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────
export default function TeamReportingView({ drilldownCampaignId = null, onDrilldownConsumed = null }) {
  // ── Toolbar state ──────────────────────────────────────────────────────
  // Tab default per design: "By rep". External drill-down forces "By campaign".
  const [tab, setTab] = useState(drilldownCampaignId ? 'campaign' : 'rep');
  const [tabExplicitlySet, setTabExplicitlySet] = useState(!!drilldownCampaignId);
  const [scope, setScope] = useState(null);   // hydrated from /reporting-scope
  const [depth, setDepth] = useState(null);   // null until scope loads
  const [windowState, setWindowState] = useState({ kind: 'preset', windowDays: 30 });
  const [campaignFilter, setCampaignFilter] = useState([]);   // multi-select campaign IDs
  const [allCampaigns, setAllCampaigns] = useState([]);       // for the multi-select dropdown
  // Agency Phase 4: client dimension. clients=[] (fetch failed / module off /
  // none exist) hides both the filter and the "By client" tab entirely, so
  // non-agency orgs see a byte-identical UI.
  const [clients, setClients] = useState([]);
  const [clientFilter, setClientFilter] = useState('');       // '' = all clients
  const [showCampaignDropdown, setShowCampaignDropdown] = useState(false);
  const [error, setError] = useState(null);

  // ── Drill-down state ───────────────────────────────────────────────────
  const [drillCampaignId, setDrillCampaignId] = useState(drilldownCampaignId);
  // ── Insights/WBR Phase 5 state ──────────────────────────────────────────
  const [insightMetrics, setInsightMetrics] = useState(new Set());  // metric keys with open insights (WBR dots)
  const [focusMetric, setFocusMetric] = useState(null);             // set when jumping WBR → Insights

  // Pre-fetch open insights once so the WBR grid can annotate rows before
  // the Insights tab is ever visited. InsightsPanel refreshes this on load.
  useEffect(() => {
    apiFetch('/prospecting-insights')
      .then(res => {
        const open = (res.insights || []).filter(i => i.status !== 'resolved');
        setInsightMetrics(new Set(open.map(i =>
          i.metric === 'send_volume' ? 'sends' : i.metric)));
      })
      .catch(() => {});
  }, []);

  // Track which sub-tabs of the drill-down are open (per-sequence and per-rep
  // both render, but allowing collapse/expand keeps it manageable).
  const [drillData,    setDrillData]    = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError,   setDrillError]   = useState(null);

  // ── Phase 4 (later add): Prospect-list panel state ─────────────────────
  // Side panel showing enrolled prospects for a given sequence or campaign.
  // Two modes:
  //   - { sequenceId, sequenceName }  → list prospects in that sequence
  //   - { campaignId, campaignName }  → list prospects in that campaign
  // Plus an optional drilled-in enrollment for the timeline view.
  const [prospectPanel, setProspectPanel]               = useState(null);
  const [prospectPanelEnrollId, setProspectPanelEnrollId] = useState(null);

  // A metric cell was clicked. The cell hands over its own filter tuple —
  // whatever grain it was rendered at — plus the value it displayed. We add
  // depth + window from the toolbar (already encoded in `queryString`) and let
  // the panel fetch. Opening a drill always resets timeline mode, otherwise the
  // panel would show the previous prospect's steps under a new title.
  const openDrill = useCallback((drill) => {
    setProspectPanelEnrollId(null);
    setProspectPanel({ drill });
  }, []);

  // ── Per-tab data state ─────────────────────────────────────────────────
  const [repData,        setRepData]        = useState(null);
  const [campaignData,   setCampaignData]   = useState(null);
  const [sequenceData,   setSequenceData]   = useState(null);
  const [clientData,     setClientData]     = useState(null);   // Agency Phase 4
  const [tabLoading,     setTabLoading]     = useState(false);

  // Refs to avoid stale closures in async loads
  const lastReqRef = useRef(0);

  // ── Initial scope load + depth hydration ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    apiFetch('/users/me/preferences/reporting')
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

  // Agency Phase 4: load clients for the filter + "By client" tab. 404 when
  // the agency module is off (requireModule) — swallow and hide the feature.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/clients')
      .then(r => { if (!cancelled) setClients(r.clients || []); })
      .catch(() => { if (!cancelled) setClients([]); });
    return () => { cancelled = true; };
  }, []);

  // Fetch the resolved scope whenever depth changes. Scope drives the title
  // descriptor ("Showing 2 direct reports") and provides reports[] for the
  // depth-badge annotations.
  useEffect(() => {
    if (!depth) return;
    let cancelled = false;
    apiFetch(`/users/me/reporting-scope?depth=${depth}`)
      .then(res => {
        if (cancelled) return;
        const newScope = res.scope || null;
        setScope(newScope);
        // For solo users (no team), the "By rep" tab shows one row (just
        // them) — no insight. If the user hasn't manually picked a tab yet,
        // switch them to "By campaign" which is more informative.
        if (newScope && newScope.scope === 'self' && !tabExplicitlySet) {
          setTab('campaign');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setError('Could not load reporting scope: ' + err.message);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  // ── Persist depth change ───────────────────────────────────────────────
  const onDepthChange = useCallback((newDepth) => {
    setDepth(newDepth);
    // Fire-and-forget; if it fails the user sees no error (the in-session
    // depth still applies). Worst case: their preference doesn't persist.
    apiFetch('/users/me/preferences/reporting', {
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
    if (clientFilter) q += `&clientId=${clientFilter}`;
    return q;
  }, [depth, windowState, campaignFilter, clientFilter]);

  const loadTab = useCallback(async (which) => {
    if (!depth) return;     // wait for scope hydration

    let url;
    if (which === 'rep')      url = `/reporting/sequences/team-by-rep?${queryString}`;
    if (which === 'campaign') url = `/reporting/sequences/team-overview?${queryString}`;
    if (which === 'sequence') url = `/reporting/sequences/team-by-sequence?${queryString}`;
    if (which === 'client')   url = `/reporting/sequences/team-by-client?${queryString}`;
    if (!url) return;       // 'wbr' and 'insights' tabs fetch their own data
                            // (WbrGrid / InsightsPanel) — without this guard the
                            // generic loader fired apiFetch(undefined) → /apiundefined 404

    const reqId = ++lastReqRef.current;
    setTabLoading(true);
    setError(null);

    try {
      const res = await apiFetch(url);
      if (reqId !== lastReqRef.current) return;   // stale
      if (which === 'rep')      setRepData(res);
      if (which === 'campaign') setCampaignData(res);
      if (which === 'sequence') setSequenceData(res);
      if (which === 'client')   setClientData(res);
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
    const url = `/prospecting-campaigns/${drillCampaignId}/sequence-health?${queryString}&groupBy=both`;
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
      setAllCampaigns(campaignData.campaigns.map(c => ({ id: c.campaignId, name: c.name })));
    }
  }, [campaignData]);

  // If we haven't loaded the campaign tab yet but the user is on Rep or
  // Sequence and wants to use the campaign filter, fetch the list lazily.
  useEffect(() => {
    if (allCampaigns.length === 0 && tab !== 'campaign' && depth) {
      apiFetch(`/reporting/sequences/team-overview?depth=${depth}&windowDays=30`)
        .then(res => {
          if (res?.campaigns) {
            setAllCampaigns(res.campaigns.map(c => ({ id: c.campaignId, name: c.name })));
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
          setTabExplicitlySet(true);
          if (t !== 'campaign') setDrillCampaignId(null);   // exit drill-down
        }}
        showClientTab={clients.length > 0}
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
        clients={clients}
        clientFilter={clientFilter}
        onClientFilterChange={setClientFilter}
        showClientFilter={clients.length > 0 && tab !== 'client' && tab !== 'insights' && tab !== 'linkedin' && tab !== 'activity' && tab !== 'lifunnel' && tab !== 'wbr'}   // 'By client' IS the client rollup
        showCampaignFilter={tab !== 'campaign' && tab !== 'insights' && tab !== 'linkedin' && tab !== 'activity' && tab !== 'lifunnel'}   // tab 'campaign' IS the campaign list; insights org-level; LinkedIn risk has no campaign filter; activity spans modules beyond campaigns
        showWindowPicker={tab !== 'wbr' && tab !== 'insights' && tab !== 'linkedin' && tab !== 'lifunnel'}           // WBR/insight windows fixed; LinkedIn risk has its own window picker
      />

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {tab === 'rep' && (
        <RepTab data={repData} loading={tabLoading} scope={scope} windowState={windowState}
                onSetWindow={setWindowState} onDrill={openDrill} />
      )}

      {tab === 'campaign' && !drilledIn && (
        <CampaignTab
          data={campaignData}
          loading={tabLoading}
          scope={scope}
          onDrillIn={(campaignId) => setDrillCampaignId(campaignId)}
          onOpenProspects={(campaignId, campaignName) =>
            setProspectPanel({ campaignId, campaignName })}
          windowState={windowState}
          onSetWindow={setWindowState}
          onDrill={openDrill}
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
          onOpenProspects={(sequenceId, sequenceName) =>
            setProspectPanel({ sequenceId, sequenceName })}
          onDrill={openDrill}
        />
      )}

      {tab === 'client' && (
        <ClientTab data={clientData} loading={tabLoading} windowState={windowState}
                   onSetWindow={setWindowState} />
      )}

      {tab === 'sequence' && (
        <SequenceTab
          data={sequenceData}
          loading={tabLoading}
          scope={scope}
          windowState={windowState}
          onSetWindow={setWindowState}
          onOpenProspects={(sequenceId, sequenceName) =>
            setProspectPanel({ sequenceId, sequenceName })}
          onDrill={openDrill}
        />
      )}

      {/* ── Insights/WBR Phase 5 tabs ──────────────────────────────────── */}
      {tab === 'wbr' && (
        <WbrGrid
          depth={depth}
          campaignFilter={campaignFilter}
          insightMetrics={insightMetrics}
          onJumpToInsight={(metricKey) => {
            // WBR metric keys → insight metric keys ('sends' insight is 'send_volume')
            setFocusMetric(metricKey === 'sends' ? 'send_volume' : metricKey);
            setTab('insights');
            setTabExplicitlySet(true);
          }}
        />
      )}

      {tab === 'insights' && (
        <InsightsPanel
          focusMetric={focusMetric}
          onInsightsLoaded={(list) => {
            const open = list.filter(i => i.status !== 'resolved');
            setInsightMetrics(new Set(open.map(i =>
              i.metric === 'send_volume' ? 'sends' : i.metric)));
          }}
        />
      )}

      {tab === 'linkedin' && (
        <LinkedInRiskPanel depth={depth} />
      )}

      {tab === 'lifunnel' && (
        <LinkedInFunnelPanel />
      )}

      {tab === 'activity' && (
        <ActivityTab depth={depth} windowState={windowState} scope={scope} />
      )}

      {prospectPanel && (
        <ProspectListPanel
          context={prospectPanel}
          queryString={queryString}
          enrollmentId={prospectPanelEnrollId}
          onPickEnrollment={(id) => setProspectPanelEnrollId(id)}
          onBackToList={() => setProspectPanelEnrollId(null)}
          onClose={() => {
            setProspectPanel(null);
            setProspectPanelEnrollId(null);
          }}
        />
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
    else if (scope.scope === 'self')  descriptor = 'Your activity';
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
function TabBar({ tab, onTabChange, showClientTab = false }) {
  const tabs = [
    { key: 'rep',      label: 'By rep' },
    { key: 'campaign', label: 'By campaign' },
    // Agency Phase 4: only rendered for orgs that actually have clients.
    ...(showClientTab ? [{ key: 'client', label: 'By client' }] : []),
    { key: 'sequence', label: 'By sequence' },
    { key: 'wbr',      label: 'WBR' },        // Insights/WBR Phase 5
    { key: 'insights', label: 'Insights' },   // Insights/WBR Phase 5
    { key: 'linkedin', label: 'LinkedIn risk' },
    { key: 'lifunnel', label: 'LinkedIn funnel' },
    { key: 'activity', label: 'Activity' },
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
  // Agency Phase 4
  clients = [], clientFilter = '', onClientFilterChange = null, showClientFilter = false,
  showWindowPicker = true,   // Insights/WBR Phase 5: WBR/Insights tabs use fixed windows
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

      {showWindowPicker && (
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
      )}

      {showClientFilter && (
        <div className="trv-toolbar-group trv-toolbar-right">
          <span className="trv-toolbar-label">Client:</span>
          <select
            className="trv-window-btn"
            value={clientFilter}
            onChange={e => onClientFilterChange && onClientFilterChange(e.target.value)}
            style={{ cursor: 'pointer' }}
          >
            <option value="">All</option>
            {clients.map(cl => (
              <option key={cl.id} value={cl.id}>{cl.name}</option>
            ))}
          </select>
        </div>
      )}

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
// SmartEmpty — when rows are technically present but all-zero, give the
// user something to do besides stare at zeros. The most common cause of
// "I see my team but everyone has 0" is "no activity in this window";
// the fastest unblock is a longer window. We surface a one-click "Try 90d"
// button when we detect that pattern.
// ──────────────────────────────────────────────────────────────────────────
function SmartEmpty({ rowsExist, allZero, windowState, onSetWindow, entityLabel }) {
  if (!rowsExist) {
    return <div className="trv-empty">No {entityLabel} visible in your scope. Try a different depth.</div>;
  }
  if (allZero) {
    const isShortWindow = windowState.kind === 'preset' && windowState.windowDays <= 30;
    return (
      <div className="trv-empty-actionable">
        <div className="trv-empty-msg">
          Your team has no {entityLabel} activity in {windowDescription(windowState)}.
        </div>
        {isShortWindow && (
          <div className="trv-empty-actions">
            <button
              className="trv-empty-cta"
              onClick={() => onSetWindow({ kind: 'preset', windowDays: 90 })}
            >
              Try last 90 days →
            </button>
            <button
              className="trv-empty-cta-secondary"
              onClick={() => onSetWindow({ kind: 'preset', windowDays: 365 })}
            >
              Try last year
            </button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

// Inline helper — same as windowToQueryParams but returns a human label.
function windowDescription(window) {
  if (window.kind === 'custom') return `${window.startDate} → ${window.endDate}`;
  if (window.windowDays === 1) return 'the last 24 hours';
  return `the last ${window.windowDays} days`;
}

// ──────────────────────────────────────────────────────────────────────────
// MetricTiles — shared 4-up tile strip
// ──────────────────────────────────────────────────────────────────────────

// ── Channel-split presentation ────────────────────────────────────────────
// `sent` counts every step log regardless of channel, so a blended reply rate
// divides EMAIL replies by EMAIL + LINKEDIN sends. On a sequence whose step 1
// is a LinkedIn touch, that halves the apparent email reply rate. The tables
// below therefore show each channel's sends and replies side by side, and the
// tiles report both rates rather than one meaningless blend.
const GROUP_EDGE = { borderLeft: '1px solid var(--trv-border, #e5e7eb)' };

/** "161 email · 166 LinkedIn" — the sub-line under a tile. */
function channelSub(email, linkedin) {
  return `${fmtNum(email)} email · ${fmtNum(linkedin)} LinkedIn`;
}

// ── Delivery ──────────────────────────────────────────────────────────────
// `Sent` is attempted, not delivered. A hard-bounced address never had the
// chance to reply, so it is subtracted out of the reply-rate denominator
// server-side and shown here as its own column. Soft bounces are a retry, not
// a dead address — they appear in the sub-line and the drill list, and are
// never subtracted.
//
//   Delivered   = Email sent − (hard_bounce + block)
//   Delivered % = Delivered / Email sent
//
// A delivery rate below ~95% is worth a look; below 90% the list is the
// problem, not the copy. Tint at those thresholds rather than making the rep
// do the arithmetic.
const DELIVERY_WARN = 95;
const DELIVERY_BAD  = 90;

function deliveryClass(rate, sentEmail) {
  if (!sentEmail) return '';
  if (rate < DELIVERY_BAD)  return 'trv-danger';
  if (rate < DELIVERY_WARN) return 'trv-warning';
  return '';
}

// ── Absence of evidence is not evidence of delivery ───────────────────────
// There is no positive delivery confirmation anywhere in this system: no SMTP
// success DSN, no ESP webhook. `Delivered` means "sent, and no bounce came
// back". When email_delivery_events is empty that is simply "sent" — and the
// first version of this screen rendered a confident 100.0% for every campaign
// in the org, which reads exactly like a healthy list and means nothing at all.
//
// So: no telemetry → Bounced and Deliv % render as an em-dash, never as 0 and
// 100%. A zero should never be mistaken for a measurement.
const NO_DATA = '—';

/** true when the API has told us delivery events exist for this org. */
function hasTelemetry(t) {
  return !!(t && t.hasEvents);
}

/**
 * The window opened before bounce capture began, so some of these sends could
 * never have produced a delivery event. The rate is optimistic by an unknown
 * amount and the UI has to say so — a partially-covered 98% is not a 98%.
 */
function telemetryGap(t, period) {
  if (!hasTelemetry(t) || !t.since || !period?.startDate) return false;
  return new Date(period.startDate).getTime() < new Date(t.since).getTime();
}

/** "51 hard · 12 soft" — the sub-line under the Bounced tile. */
function bounceSub(hard, block, soft) {
  const parts = [];
  if (hard)  parts.push(`${fmtNum(hard)} hard`);
  if (block) parts.push(`${fmtNum(block)} blocked`);
  if (soft)  parts.push(`${fmtNum(soft)} soft`);
  return parts.length ? parts.join(' · ') : 'none';
}

/** Bounced cell: drillable when measured, inert em-dash when not. */
function BouncedCell({ row, telemetry, drill, onDrill, style }) {
  if (!hasTelemetry(telemetry)) {
    return (
      <td className="num trv-muted-cell" style={style} title="No delivery telemetry recorded">
        {NO_DATA}
      </td>
    );
  }
  return (
    <MetricCell
      value={row.bounced}
      onDrill={onDrill}
      style={style}
      className={row.bounced > 0 ? 'trv-danger' : ''}
      title={bounceSub(row.bouncedHard, row.bouncedBlock, row.bouncedSoft)}
      drill={drill}
    />
  );
}

/** Delivered-% cell. Em-dash when unmeasured or when nothing was sent. */
function DeliveryRateCell({ row, telemetry }) {
  if (!hasTelemetry(telemetry)) {
    return <td className="num trv-muted-cell" title="No delivery telemetry recorded">{NO_DATA}</td>;
  }
  if (!row.sentEmail) return <td className="num trv-muted-cell">{NO_DATA}</td>;
  return (
    <td className={`num ${deliveryClass(row.deliveredRate, row.sentEmail)}`}>
      {fmtPct(row.deliveredRate)}
    </td>
  );
}

/** Delivered count cell. Drillable since the metric-drill endpoint gained a
 *  'delivered' branch (sends with no hard-bounce event) — the subtraction now
 *  has a row source of its own. */
function DeliveredCell({ row, telemetry, drill, onDrill }) {
  if (!hasTelemetry(telemetry)) {
    return <td className="num trv-muted-cell" title="No delivery telemetry recorded">{NO_DATA}</td>;
  }
  return (
    <MetricCell
      value={row.deliveredEmail}
      onDrill={onDrill}
      drill={drill}
    />
  );
}

// ── Engagement ────────────────────────────────────────────────────────────
// Opened/Clicked are message-grain human events from the tracking pixels.
// Same honesty rule as delivery: with tracking never armed, every row scores
// a 0 that reads exactly like nobody-cares. No engagement telemetry → em-dash,
// never 0. Opens carry the directional caveat (Apple MPP / Gmail proxies) in
// the column header; clicks are trustworthy.
function hasEngTelemetry(t) {
  return !!(t && t.hasEvents);
}

/** Opened / Clicked cell: drillable when measured, inert em-dash when not. */
function EngagedCell({ value, telemetry, drill, onDrill, style }) {
  if (!hasEngTelemetry(telemetry)) {
    return (
      <td className="num trv-muted-cell" style={style} title="No engagement tracking events recorded">
        {NO_DATA}
      </td>
    );
  }
  return <MetricCell value={value} onDrill={onDrill} style={style} drill={drill} />;
}

/**
 * The two delivery tiles, which have to degrade honestly rather than print
 * 100%. Also fixes an adjacency problem: `Sent` is email + LinkedIn, and a
 * `Delivered` tile next to it invited the reader to subtract 1,063 − 661 and
 * conclude 402 sends failed. The label and sub-line now name their denominator.
 */
function deliveryTiles(totals, telemetry) {
  if (!hasTelemetry(telemetry)) {
    return [
      { label: 'Email delivered', value: NO_DATA, sub: 'no delivery telemetry' },
      { label: 'Bounced',         value: NO_DATA, sub: 'no delivery telemetry' },
    ];
  }
  return [
    { label: 'Email delivered', value: fmtNum(totals.deliveredEmail),
      sub: `${fmtPct(totals.deliveredRate)} of ${fmtNum(totals.sentEmail)} email sent` },
    // `bounced` is hard bounces — the subtracted quantity. The sub-line names
    // the blocks and soft bounces that were counted but left in `delivered`.
    { label: 'Bounced',         value: fmtNum(totals.bounced),
      sub: bounceSub(totals.bouncedHard, totals.bouncedBlock, totals.bouncedSoft) },
  ];
}

/** Reply-rate denominator names itself, because it changes with telemetry. */
function replyRateSub(totals, telemetry) {
  const li = `LinkedIn ${fmtPct(totals.linkedinRepliedRate)}`;
  return hasTelemetry(telemetry) ? `of delivered · ${li}` : `of email sent · ${li}`;
}

/**
 * A one-line, page-level statement of what the delivery columns can and cannot
 * tell you. Rendered above the table so it is read before the numbers, not
 * after someone has already acted on them.
 */
function DeliveryTelemetryNote({ telemetry, period }) {
  if (!telemetry) return null;
  if (!hasTelemetry(telemetry)) {
    return (
      <div className="trv-telemetry-note">
        No delivery telemetry has been recorded for this org, so <strong>Bounced</strong> and{' '}
        <strong>Deliv %</strong> are unavailable. Bounce capture writes to{' '}
        <code>email_delivery_events</code> when an NDR arrives on a synced mailbox.
        Until then, a send is not known to have been delivered — only to have been attempted.
      </div>
    );
  }
  if (telemetryGap(telemetry, period)) {
    return (
      <div className="trv-telemetry-note">
        Bounce capture began {fmtDate(telemetry.since)}. This window opens earlier, so sends before
        that date could not have produced a bounce and <strong>Deliv %</strong> is optimistic for them.
      </div>
    );
  }
  return null;
}

// ── Metric drill-through ──────────────────────────────────────────────────
// Every numeric cell below is evidence for a claim. Clicking one asks
// GET /reporting/metric-drill for the rows that produced it, and the answer
// opens in the same right-side panel that already shows prospects and
// enrollment timelines.
//
// The filter tuple a cell carries IS the grain of the aggregate it renders:
//   Campaign tab  → { campaignId }
//   Rep tab       → { userId }
//   Sequence tab  → { sequenceId }
//   Drill-down    → { campaignId, sequenceId } or { campaignId, userId }
// plus `channel` on the per-channel columns. The backend reuses the aggregate's
// own predicates, so the list length always equals the number that was clicked.
//
// Zero renders as inert text — there is nothing to look at, and a clickable 0
// invites a click that opens an empty panel.
const DRILLABLE = ['replied', 'sent', 'bounced', 'drafts', 'failed', 'enrolled', 'stalled', 'delivered', 'opened', 'clicked'];

/** Human label for a panel opened on a given metric/channel. */
function drillTitle(metric, channel) {
  const chan = channel === 'email' ? 'Email ' : channel === 'linkedin' ? 'LinkedIn ' : '';
  const noun = {
    replied:  'replies',
    sent:     'sends',
    bounced:  'bounces',
    drafts:   'drafts',
    failed:   'failures',
    enrolled: 'enrollments',
    stalled:  'stalled enrollments',
    delivered: 'delivered',
    opened:    'opened (directional)',
    clicked:   'clicked',
  }[metric] || metric;
  return `${chan}${noun}`.replace(/^./, c => c.toUpperCase());
}

/**
 * A numeric table cell that can open the evidence panel.
 *
 * `drill` is the filter tuple; omit it (or pass a zero value) and the cell
 * degrades to the plain <td> it always was. `expected` rides along so the
 * panel can assert the row count it gets back matches the number on screen —
 * a silent divergence between a cell and its own evidence is the exact class
 * of bug that let the campaign row show 5 replies over a drill-down showing 0.
 */
function MetricCell({ value, drill, onDrill, className = '', style, title }) {
  const n = Number(value) || 0;
  const canDrill = onDrill && drill && DRILLABLE.includes(drill.metric) && n > 0;
  return (
    <td className={`num ${className}`} style={style} title={title}>
      {canDrill ? (
        <button
          type="button"
          className="trv-metric-cell"
          onClick={(e) => { e.stopPropagation(); onDrill({ ...drill, expected: n }); }}
          aria-label={`Show the ${n} ${drillTitle(drill.metric, drill.channel).toLowerCase()} behind this number`}
        >
          {fmtNum(n)}
        </button>
      ) : fmtNum(n)}
    </td>
  );
}

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
// RepTab — per-rep table from /team-by-rep. Rows are expandable to reveal
// top campaigns + last activity, both already in the response shape.
// ──────────────────────────────────────────────────────────────────────────
function RepTab({ data, loading, scope, windowState, onSetWindow, onDrill }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const reps = data.reps || [];
  const telemetry = data.deliveryTelemetry;
  const engTelemetry = data.engagementTelemetry;
  const allZero = reps.length > 0 && reps.every(r =>
    (r.sent || 0) === 0 && (r.enrolled || 0) === 0 && (r.drafts || 0) === 0 && (r.replied || 0) === 0
  );
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Active reps', value: fmtNum(reps.filter(r => r.sent > 0 || r.enrolled > 0).length) },
          { label: 'Enrolled',    value: fmtNum(totals.enrolled) },
          { label: 'Sent',        value: fmtNum(totals.sent),
            sub: channelSub(totals.sentEmail, totals.sentLinkedin) },
          ...deliveryTiles(totals, telemetry).slice(1),
          { label: 'Email reply rate', value: fmtPct(totals.emailRepliedRate),
            sub: replyRateSub(totals, telemetry) },
        ]}
      />
      <SmartEmpty rowsExist={reps.length > 0} allZero={allZero} windowState={windowState}
                  onSetWindow={onSetWindow} entityLabel="rep" />
      {reps.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Rep</th>
                <th className="num">Enrolled</th>
                <th className="num">Drafts</th>
                <th className="num" style={GROUP_EDGE}>Email sent</th>
                <th className="num" title="Hard bounces. Subtracted from Delivered. Blocks and soft bounces are counted but not subtracted.">Bounced</th>
                <th className="num" title="(Email sent − hard bounces) ÷ Email sent. There is no positive delivery confirmation; this is mail we sent that did not hard-bounce.">Deliv %</th>
                                <th className="num" title="Messages with at least one human open, over sends fired in the window. DIRECTIONAL: Apple Mail and Gmail image proxies auto-load pixels the bot filter cannot catch.">Opened*</th>
                <th className="num" title="Messages with at least one human link click, over sends fired in the window.">Clicked</th>
                <th className="num">Email replied</th>
                <th className="num">Email reply %</th>
                <th className="num" style={GROUP_EDGE}>LI sent</th>
                <th className="num">LI replied</th>
                <th className="num">LI reply %</th>
                <th className="num" style={GROUP_EDGE}>Failed</th>
                <th className="num">Stalled</th>
              </tr>
            </thead>
            <tbody>
              {reps.map(r => {
                const isZero = (r.sent || 0) === 0 && (r.enrolled || 0) === 0 && (r.drafts || 0) === 0;
                const expanded = expandedId === r.userId;
                return (
                  <React.Fragment key={r.userId}>
                    <tr
                      className={`trv-row-click ${isZero ? 'trv-row-muted' : ''}`}
                      onClick={() => setExpandedId(expanded ? null : r.userId)}
                    >
                      <td className="trv-chevron">{expanded ? '▾' : '›'}</td>
                      <td>
                        {r.name}
                        {depthBadge(r)}
                      </td>
                      <MetricCell value={r.enrolled} onDrill={onDrill}
                        drill={{ metric: 'enrolled', userId: r.userId, subject: r.name }} />
                      <MetricCell value={r.drafts} onDrill={onDrill}
                        drill={{ metric: 'drafts', userId: r.userId, subject: r.name }} />
                      <MetricCell value={r.sentEmail} onDrill={onDrill} style={GROUP_EDGE}
                        drill={{ metric: 'sent', channel: 'email', userId: r.userId, subject: r.name }} />
                      <BouncedCell row={r} telemetry={telemetry} onDrill={onDrill}
                        drill={{ metric: 'bounced', channel: 'email', userId: r.userId, subject: r.name }} />
                      <DeliveryRateCell row={r} telemetry={telemetry} />
                      <EngagedCell value={r.opened} telemetry={engTelemetry} onDrill={onDrill}
                        drill={{ metric: 'opened', channel: 'email', userId: r.userId, subject: r.name }} />
                      <EngagedCell value={r.clicked} telemetry={engTelemetry} onDrill={onDrill}
                        drill={{ metric: 'clicked', channel: 'email', userId: r.userId, subject: r.name }} />
                      <MetricCell value={r.repliedEmail} onDrill={onDrill}
                        drill={{ metric: 'replied', channel: 'email', userId: r.userId, subject: r.name }} />
                      <td className="num">{fmtPct(r.emailRepliedRate)}</td>
                      <MetricCell value={r.sentLinkedin} onDrill={onDrill} style={GROUP_EDGE}
                        drill={{ metric: 'sent', channel: 'linkedin', userId: r.userId, subject: r.name }} />
                      <MetricCell value={r.repliedLinkedin} onDrill={onDrill}
                        drill={{ metric: 'replied', channel: 'linkedin', userId: r.userId, subject: r.name }} />
                      <td className="num">{fmtPct(r.linkedinRepliedRate)}</td>
                      <MetricCell value={r.failed} onDrill={onDrill} style={GROUP_EDGE}
                        drill={{ metric: 'failed', userId: r.userId, subject: r.name }} />
                      <MetricCell value={r.stalled} onDrill={onDrill}
                        className={r.stalled > 0 ? 'trv-warning' : ''}
                        drill={{ metric: 'stalled', userId: r.userId, subject: r.name }} />
                    </tr>
                    {expanded && (
                      <tr className="trv-expand-row">
                        <td colSpan={16}>
                          <div className="trv-expand-grid">
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Last activity</div>
                              <div className="trv-expand-val">{fmtDate(r.lastActivityAt)}</div>
                            </div>
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Top campaigns ({(r.topCampaigns || []).length})</div>
                              {(r.topCampaigns || []).length === 0 ? (
                                <div className="trv-expand-val trv-muted">none</div>
                              ) : (
                                <div className="trv-chip-list">
                                  {r.topCampaigns.map(tc => (
                                    <span key={tc.campaignId} className="trv-topuser-chip">
                                      {tc.name || '(unnamed)'} <span className="trv-topuser-sub">{tc.sent} sent</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Role in your scope</div>
                              <div className="trv-expand-val">
                                {r.depthFromManager === 0 ? 'You' :
                                 r.isDirect ? 'Direct report' :
                                 `Indirect (${r.depthFromManager} levels down)`}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
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
// CampaignTab — per-campaign table from /team-overview.
// Click a row to expand inline (shows last activity + a "View detailed
// breakdown →" button that opens the side-panel drill-down). This gives
// the user a hint of what's there before committing to the full drill.
// ──────────────────────────────────────────────────────────────────────────
function CampaignTab({ data, loading, scope, onDrillIn, onOpenProspects, windowState, onSetWindow, onDrill }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const campaigns = data.campaigns || [];
  const telemetry = data.deliveryTelemetry;
  const engTelemetry = data.engagementTelemetry;
  const allZero = campaigns.length > 0 && campaigns.every(c =>
    (c.sent || 0) === 0 && (c.enrolled || 0) === 0 && (c.drafts || 0) === 0 && (c.replied || 0) === 0
  );
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Active campaigns', value: fmtNum(totals.activeCampaigns) },
          { label: 'Enrolled',         value: fmtNum(totals.enrolled) },
          { label: 'Sent',             value: fmtNum(totals.sent),
            sub: channelSub(totals.sentEmail, totals.sentLinkedin) },
          ...deliveryTiles(totals, telemetry),
          { label: 'Email reply rate', value: fmtPct(totals.emailRepliedRate),
            sub: replyRateSub(totals, telemetry) },
        ]}
      />
      <DeliveryTelemetryNote telemetry={telemetry} period={data.period} />
      <SmartEmpty rowsExist={campaigns.length > 0} allZero={allZero} windowState={windowState}
                  onSetWindow={onSetWindow} entityLabel="campaign" />
      {campaigns.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Campaign</th>
                <th>Owner</th>
                <th className="num">Enrolled</th>
                <th className="num" style={GROUP_EDGE}>Email sent</th>
                <th className="num">Delivered</th>
                <th className="num" title="Hard bounces. Subtracted from Delivered. Blocks and soft bounces are counted but not subtracted.">Bounced</th>
                <th className="num" title="(Email sent − hard bounces) ÷ Email sent. There is no positive delivery confirmation; this is mail we sent that did not hard-bounce.">Deliv %</th>
                <th className="num" title="Messages with at least one human open, over sends fired in the window. DIRECTIONAL: Apple Mail and Gmail image proxies auto-load pixels the bot filter cannot catch.">Opened*</th>
                <th className="num" title="Messages with at least one human link click, over sends fired in the window.">Clicked</th>
                <th className="num">Email replied</th>
                <th className="num">Email reply %</th>
                <th className="num" style={GROUP_EDGE}>LI sent</th>
                <th className="num">LI replied</th>
                <th className="num">LI reply %</th>
                <th className="num" style={GROUP_EDGE}>Stalled</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => {
                const isZero = (c.sent || 0) === 0 && (c.enrolled || 0) === 0;
                const expanded = expandedId === c.campaignId;
                return (
                  <React.Fragment key={c.campaignId}>
                    <tr
                      className={`trv-row-click ${isZero ? 'trv-row-muted' : ''}`}
                      onClick={() => setExpandedId(expanded ? null : c.campaignId)}
                    >
                      <td className="trv-chevron">{expanded ? '▾' : '›'}</td>
                      <td className="trv-link">
                        {c.name || <span className="trv-muted">(unnamed campaign)</span>}
                        {c.clientName && (
                          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#0F766E',
                                         background: '#F0FDFA', border: '1px solid #CCFBF1',
                                         borderRadius: 10, padding: '1px 7px', whiteSpace: 'nowrap' }}>
                            🏢 {c.clientName}
                          </span>
                        )}
                      </td>
                      <td>
                        {c.owner ? c.owner.name : <span className="trv-muted">—</span>}
                        {c.owner && depthBadge(c.owner)}
                      </td>
                      <MetricCell value={c.enrolled} onDrill={onDrill}
                        drill={{ metric: 'enrolled', campaignId: c.campaignId, subject: c.name }} />
                      <MetricCell value={c.sentEmail} onDrill={onDrill} style={GROUP_EDGE}
                        drill={{ metric: 'sent', channel: 'email', campaignId: c.campaignId, subject: c.name }} />
                      <DeliveredCell row={c} telemetry={telemetry} onDrill={onDrill}
                        drill={{ metric: 'delivered', channel: 'email', campaignId: c.campaignId, subject: c.name }} />
                      <BouncedCell row={c} telemetry={telemetry} onDrill={onDrill}
                        drill={{ metric: 'bounced', channel: 'email', campaignId: c.campaignId, subject: c.name }} />
                      <DeliveryRateCell row={c} telemetry={telemetry} />
                      <EngagedCell value={c.opened} telemetry={engTelemetry} onDrill={onDrill}
                        drill={{ metric: 'opened', channel: 'email', campaignId: c.campaignId, subject: c.name }} />
                      <EngagedCell value={c.clicked} telemetry={engTelemetry} onDrill={onDrill}
                        drill={{ metric: 'clicked', channel: 'email', campaignId: c.campaignId, subject: c.name }} />
                      <MetricCell value={c.repliedEmail} onDrill={onDrill}
                        drill={{ metric: 'replied', channel: 'email', campaignId: c.campaignId, subject: c.name }} />
                      <td className="num">{fmtPct(c.emailRepliedRate)}</td>
                      <MetricCell value={c.sentLinkedin} onDrill={onDrill} style={GROUP_EDGE}
                        drill={{ metric: 'sent', channel: 'linkedin', campaignId: c.campaignId, subject: c.name }} />
                      <MetricCell value={c.repliedLinkedin} onDrill={onDrill}
                        drill={{ metric: 'replied', channel: 'linkedin', campaignId: c.campaignId, subject: c.name }} />
                      <td className="num">{fmtPct(c.linkedinRepliedRate)}</td>
                      <MetricCell value={c.stalled} onDrill={onDrill} style={GROUP_EDGE}
                        className={c.stalled > 0 ? 'trv-warning' : ''}
                        drill={{ metric: 'stalled', campaignId: c.campaignId, subject: c.name }} />
                    </tr>
                    {expanded && (
                      <tr className="trv-expand-row">
                        <td colSpan={16}>
                          <div className="trv-expand-grid">
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Last activity</div>
                              <div className="trv-expand-val">{fmtDate(c.lastActivityAt)}</div>
                            </div>
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Drafts pending</div>
                              <div className="trv-expand-val">{fmtNum(c.drafts)}</div>
                            </div>
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Failed</div>
                              <div className="trv-expand-val">{fmtNum(c.failed)}</div>
                            </div>
                            <div className="trv-expand-block trv-expand-action">
                              <button
                                className="trv-cta-primary"
                                onClick={(e) => { e.stopPropagation(); onDrillIn(c.campaignId); }}
                              >
                                View detailed breakdown →
                              </button>
                              <div className="trv-expand-hint">per-sequence and per-rep view</div>
                              <button
                                className="trv-cta-secondary"
                                style={{ marginTop: 8 }}
                                onClick={(e) => { e.stopPropagation(); onOpenProspects(c.campaignId, c.name); }}
                              >
                                View prospects →
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
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
// SequenceTab — per-sequence table from /team-by-sequence. Surfaces the
// orphan-bucket activity (sequences run on prospects with no campaign)
// which is invisible to the campaign tab. Expandable rows show all top
// users with their numbers + last activity.
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// ClientTab — Agency Phase 4: per-client rollup (/team-by-client)
//
// Campaign-grain attribution: a client's numbers are the sum of its
// campaigns' numbers, so this tab and "By campaign" reconcile exactly.
// Campaigns without a client roll into the "No client" row.
// ──────────────────────────────────────────────────────────────────────────
function ClientTab({ data, loading, windowState, onSetWindow }) {
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const rows = data.clients || [];
  const allZero = rows.length > 0 && rows.every(r =>
    (r.sent || 0) === 0 && (r.enrolled || 0) === 0 && (r.replied || 0) === 0
  );
  const totals = rows.reduce((a, r) => ({
    campaigns: a.campaigns + (r.campaigns || 0),
    enrolled:  a.enrolled  + (r.enrolled  || 0),
    sent:      a.sent      + (r.sent      || 0),
    replied:   a.replied   + (r.replied   || 0),
    bounced:   a.bounced   + (r.bounced   || 0),
  }), { campaigns: 0, enrolled: 0, sent: 0, replied: 0, bounced: 0 });
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Clients',   value: fmtNum(rows.filter(r => r.clientId).length) },
          { label: 'Campaigns', value: fmtNum(totals.campaigns) },
          { label: 'Enrolled',  value: fmtNum(totals.enrolled) },
          { label: 'Sent',      value: fmtNum(totals.sent) },
          { label: 'Replied',   value: fmtNum(totals.replied) },
          { label: 'Bounced',   value: fmtNum(totals.bounced) },
        ]}
      />
      <SmartEmpty rowsExist={rows.length > 0} allZero={allZero} windowState={windowState}
                  onSetWindow={onSetWindow} entityLabel="client" />
      {rows.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">Campaigns</th>
                <th className="num">Enrolled</th>
                <th className="num" style={GROUP_EDGE}>Email sent</th>
                <th className="num">Email replied</th>
                <th className="num" title="Hard bounces + blocks + soft bounces across the client's campaigns.">Bounced</th>
                <th className="num" style={GROUP_EDGE}>LI sent</th>
                <th className="num">LI replied</th>
                <th className="num" style={GROUP_EDGE}>Reply %</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isZero = (r.sent || 0) === 0 && (r.enrolled || 0) === 0;
                return (
                  <tr key={r.clientId ?? 'none'} className={isZero ? 'trv-row-muted' : ''}>
                    <td className="trv-link">
                      {r.clientId
                        ? <>🏢 {r.clientName}</>
                        : <span className="trv-muted">No client (internal)</span>}
                    </td>
                    <td className="num">{fmtNum(r.campaigns)}</td>
                    <td className="num">{fmtNum(r.enrolled)}</td>
                    <td className="num" style={GROUP_EDGE}>{fmtNum(r.sentEmail)}</td>
                    <td className="num">{fmtNum(r.repliedEmail)}</td>
                    <td className="num">{fmtNum(r.bounced)}</td>
                    <td className="num" style={GROUP_EDGE}>{fmtNum(r.sentLinkedin)}</td>
                    <td className="num">{fmtNum(r.repliedLinkedin)}</td>
                    <td className="num" style={GROUP_EDGE}>{fmtPct(r.repliedRate)}</td>
                    <td>{fmtDate(r.lastActivityAt)}</td>
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

function SequenceTab({ data, loading, scope, windowState, onSetWindow, onOpenProspects, onDrill }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const sequences = data.sequences || [];
  const telemetry = data.deliveryTelemetry;
  const allZero = sequences.length > 0 && sequences.every(s =>
    (s.sent || 0) === 0 && (s.enrolled || 0) === 0 && (s.drafts || 0) === 0 && (s.replied || 0) === 0
  );
  return (
    <div className="trv-tab-body">
      <MetricTiles
        tiles={[
          { label: 'Active sequences', value: fmtNum(totals.activeSequences) },
          { label: 'Enrolled',         value: fmtNum(totals.enrolled) },
          { label: 'Sent',             value: fmtNum(totals.sent) },
          ...deliveryTiles(totals, telemetry).slice(1),
          { label: 'Email reply rate', value: fmtPct(totals.emailRepliedRate),
            sub: replyRateSub(totals, telemetry) },
        ]}
      />
      <SmartEmpty rowsExist={sequences.length > 0} allZero={allZero} windowState={windowState}
                  onSetWindow={onSetWindow} entityLabel="sequence" />
      {sequences.length > 0 && (
        <div className="trv-table-wrap">
          <table className="trv-table">
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
                <th>Sequence</th>
                <th>Owner</th>
                <th className="num">Enrolled</th>
                <th className="num">Sent</th>
                <th className="num" title="Hard bounces. Subtracted from Delivered. Blocks and soft bounces are counted but not subtracted.">Bounced</th>
                <th className="num" title="(Email sent − hard bounces) ÷ Email sent. There is no positive delivery confirmation; this is mail we sent that did not hard-bounce.">Deliv %</th>
                <th className="num">Connected</th>
                <th className="num">Replied</th>
                <th className="num">Stalled</th>
                <th>Top users</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map(s => {
                const isZero = (s.sent || 0) === 0 && (s.enrolled || 0) === 0;
                const expanded = expandedId === s.sequenceId;
                return (
                  <React.Fragment key={s.sequenceId}>
                    <tr
                      className={`trv-row-click ${isZero ? 'trv-row-muted' : ''}`}
                      onClick={() => setExpandedId(expanded ? null : s.sequenceId)}
                    >
                      <td className="trv-chevron">{expanded ? '▾' : '›'}</td>
                      <td>{s.name}</td>
                      <td>
                        {s.owner ? s.owner.name : <span className="trv-muted">—</span>}
                        {s.owner && depthBadge(s.owner)}
                      </td>
                      <MetricCell value={s.enrolled} onDrill={onDrill}
                        drill={{ metric: 'enrolled', sequenceId: s.sequenceId, subject: s.name }} />
                      <MetricCell value={s.sent} onDrill={onDrill}
                        drill={{ metric: 'sent', sequenceId: s.sequenceId, subject: s.name }} />
                      <BouncedCell row={s} telemetry={telemetry} onDrill={onDrill}
                        drill={{ metric: 'bounced', channel: 'email', sequenceId: s.sequenceId, subject: s.name }} />
                      <DeliveryRateCell row={s} telemetry={telemetry} />
                      {/* `connected` is a LinkedIn acceptance state, not a drillable
                          metric — no row source to list. Left inert. */}
                      <td className="num" title={s.enrolled > 0 ? `${Math.round((s.connected / s.enrolled) * 100)}% of enrolled accepted` : undefined}>
                        {s.connected > 0
                          ? <span style={{ color: '#059669', fontWeight: 600 }}>{fmtNum(s.connected)}</span>
                          : fmtNum(s.connected)}
                      </td>
                      <MetricCell value={s.replied} onDrill={onDrill}
                        drill={{ metric: 'replied', sequenceId: s.sequenceId, subject: s.name }} />
                      <MetricCell value={s.stalled} onDrill={onDrill}
                        className={s.stalled > 0 ? 'trv-warning' : ''}
                        drill={{ metric: 'stalled', sequenceId: s.sequenceId, subject: s.name }} />
                      <td className="trv-topusers">
                        {(s.topUsers || []).slice(0, 3).map((u) => (
                          <span key={u.userId} className="trv-topuser-chip">
                            {u.name} <span className="trv-topuser-sub">({u.sent})</span>
                          </span>
                        ))}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="trv-expand-row">
                        <td colSpan={11}>
                          <div className="trv-expand-grid">
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Last activity</div>
                              <div className="trv-expand-val">{fmtDate(s.lastActivityAt)}</div>
                            </div>
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Drafts</div>
                              <div className="trv-expand-val">{fmtNum(s.drafts)}</div>
                            </div>
                            <div className="trv-expand-block">
                              <div className="trv-expand-label">Failed</div>
                              <div className="trv-expand-val">{fmtNum(s.failed)}</div>
                            </div>
                            <div className="trv-expand-block trv-expand-fullwidth">
                              <div className="trv-expand-label">All contributing reps ({(s.topUsers || []).length})</div>
                              {(s.topUsers || []).length === 0 ? (
                                <div className="trv-expand-val trv-muted">none</div>
                              ) : (
                                <table className="trv-mini-table">
                                  <thead>
                                    <tr>
                                      <th>Rep</th>
                                      <th className="num">Enrolled</th>
                                      <th className="num">Sent</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {s.topUsers.map(u => (
                                      <tr key={u.userId}>
                                        <td>{u.name}</td>
                                        <td className="num">{fmtNum(u.enrolled)}</td>
                                        <td className="num">{fmtNum(u.sent)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                            <div className="trv-expand-block trv-expand-fullwidth" style={{ paddingTop: 4 }}>
                              <button
                                className="trv-cta-primary"
                                onClick={(e) => { e.stopPropagation(); onOpenProspects(s.sequenceId, s.name); }}
                              >
                                View prospects in this sequence →
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
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
// DrilldownView — Option B side-panel layout
// Left: compact campaign list. Right: selected campaign's sequence-health
// with byUser block. Reachable only from the Campaign tab.
// ──────────────────────────────────────────────────────────────────────────
function DrilldownView({
  campaigns, currentCampaignId, onPickCampaign, onExitDrill,
  drillData, drillLoading, drillError, scope, window: win, onOpenProspects, onDrill,
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
              <div className="trv-drill-item-name">{c.name || '(unnamed)'}</div>
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
        {drillData && (
          <DrilldownDetail
            data={drillData}
            scope={scope}
            onOpenProspects={onOpenProspects}
            onDrill={onDrill}
            campaignId={currentCampaignId}
          />
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DrilldownDetail — body of the right-side panel
// Per-sequence table + per-rep table, both from the same response.
//
// 2026-07 FIX. This panel used to disagree with the campaign row that opened
// it, in two ways:
//
//   1. It summed `h.last7d.*`, a bucket the backend hardcodes to NOW() - 7
//      days. The toolbar's window picker (24h / 7d / 30d / Custom) never
//      reached those numbers. With "30d" selected, the tiles showed 7d totals
//      while the By-rep table underneath showed 30d totals — two windows on
//      one screen. It now reads `h.window.*`, which the backend bounds by the
//      requested window. Tiles are relabelled accordingly (the window is
//      already displayed in the toolbar, so "7d sent" was doubly wrong).
//
//   2. `replied` came from sequence_step_logs.status = 'replied', which
//      nothing writes, so every reply count and rate here was 0. The backend
//      now sources replies from the shared reply_events CTE.
//
// Columns mirror CampaignTab / RepTab: sends and replies are split by channel,
// because a blended rate divides EMAIL replies by EMAIL + LINKEDIN sends.
// ──────────────────────────────────────────────────────────────────────────
function DrilldownDetail({ data, scope, onOpenProspects, onDrill, campaignId }) {
  const health = data.health || [];
  const byUser = data.byUser || [];
  const telemetry = data.deliveryTelemetry;

  // Roll the per-sequence window blocks up to campaign level. These now match
  // what the top-level campaign row showed — same window, same reply source.
  const totals = health.reduce((acc, h) => {
    const w = h.window || {};
    acc.sent            += w.sent            || 0;
    acc.sentEmail       += w.sentEmail       || 0;
    acc.sentLinkedin    += w.sentLinkedin    || 0;
    acc.replied         += w.replied         || 0;
    acc.repliedEmail    += w.repliedEmail    || 0;
    acc.repliedLinkedin += w.repliedLinkedin || 0;
    acc.bouncedHard     += w.bouncedHard     || 0;
    acc.bouncedBlock    += w.bouncedBlock    || 0;
    acc.bouncedSoft     += w.bouncedSoft     || 0;
    acc.bounced         += w.bounced         || 0;
    acc.failed          += w.failed          || 0;
    acc.drafts          += w.drafts          || 0;
    acc.stalled         += h.stalledEnrollments || 0;
    return acc;
  }, {
    sent: 0, sentEmail: 0, sentLinkedin: 0,
    replied: 0, repliedEmail: 0, repliedLinkedin: 0,
    bouncedHard: 0, bouncedBlock: 0, bouncedSoft: 0, bounced: 0,
    failed: 0, drafts: 0, stalled: 0,
  });

  // Rates are recomputed from the summed numerator and denominator, never
  // averaged across sequences. Same discipline the backend applies.
  const pct = (num, den) => (den > 0 ? (num / den) * 100 : 0);
  const deliveredEmail = Math.max(0, totals.sentEmail - totals.bounced);
  const deliveredRate  = pct(deliveredEmail, totals.sentEmail);

  return (
    <div className="trv-drill-detail">
      <div className="trv-drill-detail-tiles">
        <MetricTiles
          tiles={[
            { label: 'Sent',    value: fmtNum(totals.sent),
              sub: channelSub(totals.sentEmail, totals.sentLinkedin) },
            // Delivered/Bounced were added here in the previous drop and the
            // Replied and Stalled tiles were dropped by accident along the way.
            // Restored; the panel wraps to two rows and that is fine.
            ...deliveryTiles({ ...totals, deliveredEmail, deliveredRate }, telemetry),
            { label: 'Replied', value: fmtNum(totals.replied),
              sub: channelSub(totals.repliedEmail, totals.repliedLinkedin) },
            { label: 'Email reply rate',
              value: fmtPct(pct(totals.repliedEmail, hasTelemetry(telemetry) ? deliveredEmail : totals.sentEmail)),
              sub: replyRateSub(
                { linkedinRepliedRate: pct(totals.repliedLinkedin, totals.sentLinkedin) },
                telemetry
              ) },
            { label: 'Stalled', value: fmtNum(totals.stalled) },
          ]}
        />
      </div>
      <DeliveryTelemetryNote telemetry={telemetry} period={data.period} />

      <div className="trv-drill-section">
        <div className="trv-section-title">By sequence</div>
        {health.length === 0 ? (
          <EmptyState message="No sequences in this campaign." />
        ) : (
          <table className="trv-table trv-table-compact">
            <thead>
              <tr>
                <th>Sequence</th>
                <th className="num" style={GROUP_EDGE}>Email sent</th>
                <th className="num" title="Hard bounces. Subtracted from Delivered. Blocks and soft bounces are counted but not subtracted.">Bounced</th>
                <th className="num" title="(Email sent − hard bounces) ÷ Email sent. There is no positive delivery confirmation; this is mail we sent that did not hard-bounce.">Deliv %</th>
                <th className="num">Email replied</th>
                <th className="num">Email reply %</th>
                <th className="num" style={GROUP_EDGE}>LI sent</th>
                <th className="num">LI replied</th>
                <th className="num">LI reply %</th>
                <th className="num" style={GROUP_EDGE}>Stalled</th>
                <th className="num">Last activity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {health.map(h => {
                const w = h.window || {};
                return (
                  <tr key={h.sequenceId}>
                    <td>{h.sequenceName}</td>
                    <MetricCell value={w.sentEmail} onDrill={onDrill} style={GROUP_EDGE}
                      drill={{ metric: 'sent', channel: 'email', campaignId, sequenceId: h.sequenceId, subject: h.sequenceName }} />
                    <BouncedCell row={w} telemetry={telemetry} onDrill={onDrill}
                      drill={{ metric: 'bounced', channel: 'email', campaignId, sequenceId: h.sequenceId, subject: h.sequenceName }} />
                    <DeliveryRateCell row={w} telemetry={telemetry} />
                    <MetricCell value={w.repliedEmail} onDrill={onDrill}
                      drill={{ metric: 'replied', channel: 'email', campaignId, sequenceId: h.sequenceId, subject: h.sequenceName }} />
                    <td className="num">{fmtPct(w.emailRepliedRate)}</td>
                    <MetricCell value={w.sentLinkedin} onDrill={onDrill} style={GROUP_EDGE}
                      drill={{ metric: 'sent', channel: 'linkedin', campaignId, sequenceId: h.sequenceId, subject: h.sequenceName }} />
                    <MetricCell value={w.repliedLinkedin} onDrill={onDrill}
                      drill={{ metric: 'replied', channel: 'linkedin', campaignId, sequenceId: h.sequenceId, subject: h.sequenceName }} />
                    <td className="num">{fmtPct(w.linkedinRepliedRate)}</td>
                    <MetricCell value={h.stalledEnrollments} onDrill={onDrill} style={GROUP_EDGE}
                      className={h.stalledEnrollments > 0 ? 'trv-warning' : ''}
                      drill={{ metric: 'stalled', campaignId, sequenceId: h.sequenceId, subject: h.sequenceName }} />
                    <td className="num">{fmtDate(h.lastFiredAt)}</td>
                    <td>
                      {onOpenProspects && (
                        <button
                          className="trv-link-btn"
                          onClick={() => onOpenProspects(h.sequenceId, h.sequenceName)}
                        >
                          prospects →
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
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
                <th className="num" style={GROUP_EDGE}>Email sent</th>
                <th className="num" title="Hard bounces. Subtracted from Delivered. Blocks and soft bounces are counted but not subtracted.">Bounced</th>
                <th className="num" title="(Email sent − hard bounces) ÷ Email sent. There is no positive delivery confirmation; this is mail we sent that did not hard-bounce.">Deliv %</th>
                <th className="num">Email replied</th>
                <th className="num">Email reply %</th>
                <th className="num" style={GROUP_EDGE}>LI sent</th>
                <th className="num">LI replied</th>
                <th className="num">LI reply %</th>
                <th className="num" style={GROUP_EDGE}>Stalled</th>
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
                  <MetricCell value={u.enrolled} onDrill={onDrill}
                    drill={{ metric: 'enrolled', campaignId, userId: u.userId, subject: u.name }} />
                  <MetricCell value={u.sentEmail} onDrill={onDrill} style={GROUP_EDGE}
                    drill={{ metric: 'sent', channel: 'email', campaignId, userId: u.userId, subject: u.name }} />
                  <BouncedCell row={u} telemetry={telemetry} onDrill={onDrill}
                    drill={{ metric: 'bounced', channel: 'email', campaignId, userId: u.userId, subject: u.name }} />
                  <DeliveryRateCell row={u} telemetry={telemetry} />
                  <MetricCell value={u.repliedEmail} onDrill={onDrill}
                    drill={{ metric: 'replied', channel: 'email', campaignId, userId: u.userId, subject: u.name }} />
                  <td className="num">{fmtPct(u.emailRepliedRate)}</td>
                  <MetricCell value={u.sentLinkedin} onDrill={onDrill} style={GROUP_EDGE}
                    drill={{ metric: 'sent', channel: 'linkedin', campaignId, userId: u.userId, subject: u.name }} />
                  <MetricCell value={u.repliedLinkedin} onDrill={onDrill}
                    drill={{ metric: 'replied', channel: 'linkedin', campaignId, userId: u.userId, subject: u.name }} />
                  <td className="num">{fmtPct(u.linkedinRepliedRate)}</td>
                  <MetricCell value={u.stalled} onDrill={onDrill} style={GROUP_EDGE}
                    className={u.stalled > 0 ? 'trv-warning' : ''}
                    drill={{ metric: 'stalled', campaignId, userId: u.userId, subject: u.name }} />
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

// ──────────────────────────────────────────────────────────────────────────
// ProspectListPanel — right-side overlay panel
//
// Three modes, determined by props:
//   • context.drill set      → "evidence mode" — the rows behind one clicked
//     metric cell. Rows carry an enrollmentId, so a row click falls straight
//     through to timeline mode.
//   • enrollmentId === null  → "list mode" — shows enrolled prospects in the
//     given sequence/campaign, with current step + status + last activity.
//   • enrollmentId !== null  → "timeline mode" — shows the per-step timeline
//     (executed + future) for one prospect's enrollment.
//
// Evidence mode takes precedence over list mode when both could apply; the
// drill context always names a metric, list mode never does.
//
// Fetches:
//   Evidence   → GET /reporting/metric-drill?metric=…&<grain>&<window>
//   List mode  → GET /sequences/enrollments?sequenceId= or ?campaignId=
//   Timeline   → GET /sequences/enrollments/:enrollmentId
//
// The panel is fixed to the right edge of the viewport, ~440px wide.
// Clicking outside the panel does NOT close it (the underlying reporting
// view is interactive and the user may want to switch tabs while keeping
// the prospect list open). Only the explicit ✕ button closes it.
// ──────────────────────────────────────────────────────────────────────────
function ProspectListPanel({ context, queryString, enrollmentId, onPickEnrollment, onBackToList, onClose }) {
  const drill = context.drill || null;

  // ── Evidence-mode state ──────────────────────────────────────────────
  const [drillRes,     setDrillRes]     = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillErr,     setDrillErr]     = useState(null);

  const drillQuery = useMemo(() => {
    if (!drill) return null;
    const p = new URLSearchParams();
    p.set('metric', drill.metric);
    if (drill.channel)    p.set('channel',    drill.channel);
    if (drill.campaignId) p.set('campaignId', String(drill.campaignId));
    if (drill.sequenceId) p.set('sequenceId', String(drill.sequenceId));
    if (drill.userId)     p.set('userId',     String(drill.userId));
    p.set('limit', '200');
    // queryString already carries depth + windowDays/startDate+endDate. Its
    // campaignIds= (the toolbar multi-select) is ignored by the endpoint —
    // the cell's own campaignId is the grain that produced the number.
    return `${p.toString()}&${queryString}`;
  }, [drill, queryString]);

  useEffect(() => {
    if (!drill || enrollmentId) return;   // timeline mode handles its own fetch
    let cancelled = false;
    setDrillLoading(true);
    setDrillErr(null);
    apiFetch(`/reporting/metric-drill?${drillQuery}`)
      .then(res => {
        if (cancelled) return;
        setDrillRes(res);
        // The cell said N. The evidence says res.total. If those ever disagree,
        // an aggregate and its drill have drifted apart — the precise failure
        // that produced "5 replies" over a drill-down reading 0. Loud in dev,
        // silent in prod: the user still gets the rows.
        if (typeof drill.expected === 'number' && res?.total !== drill.expected
            && process.env.NODE_ENV !== 'production') {
          console.warn(
            `[metric-drill] cell showed ${drill.expected} but evidence returned ${res?.total} ` +
            `for metric=${drill.metric} channel=${drill.channel || '-'} ` +
            `campaignId=${drill.campaignId || '-'} sequenceId=${drill.sequenceId || '-'} ` +
            `userId=${drill.userId || '-'}. Aggregate and drill predicates have drifted.`
          );
        }
      })
      .catch(err => { if (!cancelled) setDrillErr(err.message); })
      .finally(() => { if (!cancelled) setDrillLoading(false); });
    return () => { cancelled = true; };
  }, [drill, drillQuery, enrollmentId]);

  // ── List-mode state ──────────────────────────────────────────────────
  const [enrollments, setEnrollments] = useState(null);
  const [listTotal,   setListTotal]   = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listError,   setListError]   = useState(null);

  const LIST_PAGE_SIZE = 200;
  const listParams = context.sequenceId
    ? `sequenceId=${context.sequenceId}`
    : `campaignId=${context.campaignId}`;

  useEffect(() => {
    if (enrollmentId) return;   // timeline mode handles its own fetch
    if (drill) return;          // evidence mode owns the body
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    apiFetch(`/sequences/enrollments?${listParams}&limit=${LIST_PAGE_SIZE}&offset=0`)
      .then(res => {
        if (cancelled) return;
        const page = res?.enrollments || [];
        setListTotal(typeof res?.total === 'number' ? res.total : page.length);
        setEnrollments(page);
      })
      .catch(err => {
        if (cancelled) return;
        setListError(err.message);
      })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [enrollmentId, listParams, drill]);

  // Append the next page. Offset = how many we already hold, so it walks
  // forward regardless of page size. Stable ordering on the server (enrolled_at
  // DESC, id DESC) guarantees no skips/dupes across pages.
  const loadMore = () => {
    const offset = enrollments?.length || 0;
    setListLoadingMore(true);
    apiFetch(`/sequences/enrollments?${listParams}&limit=${LIST_PAGE_SIZE}&offset=${offset}`)
      .then(res => {
        const page = res?.enrollments || [];
        setListTotal(typeof res?.total === 'number' ? res.total : offset + page.length);
        setEnrollments(prev => ([...(prev || []), ...page]));
      })
      .catch(err => setListError(err.message))
      .finally(() => setListLoadingMore(false));
  };

  // ── Timeline-mode state ──────────────────────────────────────────────
  const [timeline, setTimeline] = useState(null);
  const [tlEnrollment, setTlEnrollment] = useState(null);
  const [tlLoading, setTlLoading] = useState(false);
  const [tlError,   setTlError]   = useState(null);

  useEffect(() => {
    if (!enrollmentId) return;
    let cancelled = false;
    setTlLoading(true);
    setTlError(null);
    apiFetch(`/sequences/enrollments/${enrollmentId}`)
      .then(res => {
        if (cancelled) return;
        setTimeline(res?.logs || []);
        setTlEnrollment(res?.enrollment || null);
      })
      .catch(err => {
        if (cancelled) return;
        setTlError(err.message);
      })
      .finally(() => { if (!cancelled) setTlLoading(false); });
    return () => { cancelled = true; };
  }, [enrollmentId]);

  // ── Render ───────────────────────────────────────────────────────────
  let title;
  let subtitle;
  if (enrollmentId) {
    title = tlEnrollment
      ? ([tlEnrollment.first_name, tlEnrollment.last_name].filter(Boolean).join(' ').trim() || tlEnrollment.email)
      : 'Loading…';
    subtitle = tlEnrollment?.email || '';
  } else if (drill) {
    title = drillTitle(drill.metric, drill.channel);
    subtitle = [drill.subject, drillRes?.period?.description].filter(Boolean).join(' · ');
  } else {
    title = context.sequenceName || context.campaignName || '';
    subtitle = context.sequenceId ? 'Enrolled prospects' : 'Prospects in this campaign';
  }

  // In evidence mode the back button returns to the evidence list, not to a
  // prospect list that was never open.
  const contextLabel = drill ? 'Evidence' : (context.sequenceId ? 'Sequence' : 'Campaign');

  return (
    <>
      <div className="trv-prospect-overlay" onClick={onClose} aria-hidden="true" />
      <div className="trv-prospect-panel" role="dialog" aria-label="Prospect list">
        <div className="trv-pp-header">
          {enrollmentId ? (
            <button className="trv-back-btn" onClick={onBackToList}>
              ← Back to list
            </button>
          ) : (
            <div className="trv-pp-context">{contextLabel}</div>
          )}
          <button className="trv-pp-close" onClick={onClose} aria-label="Close panel">✕</button>
        </div>
        <div className="trv-pp-title-block">
          <div className="trv-pp-title">{title}</div>
          <div className="trv-pp-subtitle">{subtitle}</div>
        </div>

        <div className="trv-pp-body">
          {!enrollmentId && drill && (
            <MetricDrillBody
              loading={drillLoading}
              error={drillErr}
              result={drillRes}
              metric={drill.metric}
              onPick={onPickEnrollment}
            />
          )}
          {!enrollmentId && !drill && (
            <ProspectListBody
              loading={listLoading}
              error={listError}
              enrollments={enrollments}
              total={listTotal}
              loadingMore={listLoadingMore}
              onLoadMore={loadMore}
              onPick={onPickEnrollment}
            />
          )}
          {enrollmentId && (
            <ProspectTimelineBody
              loading={tlLoading}
              error={tlError}
              timeline={timeline}
              enrollment={tlEnrollment}
            />
          )}
        </div>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// MetricDrillBody — the rows behind one clicked number
//
// Rendered inside the same panel shell as ProspectListBody, and it reuses the
// same row chrome so a drill list and a prospect list look like siblings.
// Every row carries an enrollmentId, so clicking one hands off to timeline
// mode — number → people → this person's whole sequence.
// ──────────────────────────────────────────────────────────────────────────
function MetricDrillBody({ loading, error, result, metric, onPick }) {
  if (loading && !result) return <LoadingState />;
  if (error) return <ErrorBanner message={error} />;
  if (!result || !result.rows || result.rows.length === 0) {
    return <EmptyState message="Nothing behind this number for the selected window." />;
  }

  const { rows, total, unattributedReplies } = result;
  const showChannel = ['replied', 'sent', 'drafts', 'failed'].includes(metric);
  const isBounce = metric === 'bounced';
  const mismatches = isBounce ? rows.filter(r => r.addressMismatch).length : 0;

  return (
    <div className="trv-pp-list">
      <div className="trv-pp-count">
        {rows.length === total
          ? `${total} ${total === 1 ? 'row' : 'rows'}`
          : `Showing ${rows.length} of ${total}`}
      </div>

      {rows.map((r, i) => (
        <button
          key={`${r.prospectId}-${r.occurredAt || i}`}
          className="trv-pp-row trv-pp-row-drill"
          onClick={() => r.enrollmentId && onPick(r.enrollmentId)}
          disabled={!r.enrollmentId}
        >
          <div className="trv-pp-row-main">
            <div className="trv-pp-row-name">{r.name}</div>
            <div className="trv-pp-row-meta">
              {r.company && <span>{r.company}</span>}
              {r.company && r.title && <span className="trv-pp-row-dot">·</span>}
              {r.title && <span>{r.title}</span>}
            </div>
            {r.subject && <div className="trv-pp-subject">{r.subject}</div>}
            {(metric === 'opened' || metric === 'clicked') && (
              <div className="trv-pp-snippet">
                {r.opens > 0 && `opened ${r.opens}×${r.lastOpenAt ? ` · last ${fmtDate(r.lastOpenAt)}` : ''}`}
                {r.opens > 0 && r.clicks > 0 && ' · '}
                {r.clicks > 0 && `clicked ${r.clicks}×${(r.clickedUrls || []).length ? ` · ${[...new Set(r.clickedUrls.map(u => { try { return new URL(u).hostname; } catch (_) { return u; } }))].slice(0, 3).join(', ')}` : ''}`}
              </div>
            )}
            {r.snippet && <div className="trv-pp-snippet">{r.snippet}</div>}
            {r.errorMessage && <div className="trv-pp-snippet trv-warning">{r.errorMessage}</div>}
            {isBounce && (
              <div className="trv-tl-inbound-diag">
                {r.smtpCode && <span className="trv-tl-smtp">{r.smtpCode}</span>}
                {r.failedRecipient && <span className="trv-tl-failed">{r.failedRecipient}</span>}
              </div>
            )}
            {isBounce && r.addressMismatch && (
              <div className="trv-pp-snippet trv-warning">
                Rejected address differs from the address on this prospect.
              </div>
            )}
            {isBounce && r.diagnostic && <div className="trv-pp-snippet">{r.diagnostic}</div>}
            <div className="trv-pp-row-meta">
              {r.repName && <span>{r.repName}</span>}
              {r.repName && r.sequenceName && <span className="trv-pp-row-dot">·</span>}
              {r.sequenceName && <span>{r.sequenceName}</span>}
            </div>
          </div>
          <div className="trv-pp-row-right">
            {isBounce ? (
              <span className="trv-pp-status trv-status-danger">hard</span>
            ) : showChannel && r.channel && (
              <span className={`trv-pp-status ${r.channel === 'email' ? 'trv-status-neutral' : 'trv-status-success'}`}>
                {r.channel === 'linkedin' ? 'LinkedIn' : 'email'}
              </span>
            )}
            <div className="trv-pp-row-time">{fmtDate(r.occurredAt)}</div>
            {isBounce && r.enrollmentStopped && (
              <div className="trv-pp-row-time trv-warning">stopped</div>
            )}
          </div>
        </button>
      ))}

      {/* Not a row source — a reconciliation note. Replies from prospects who
          were never enrolled have no rep or sequence to attribute to, so no
          count on this page includes them. The campaign detail panel's funnel
          keys off campaign_id alone and does. Saying so beats being asked. */}
      {/* The rejected address is parsed from the NDR body and is authoritative.
          The pre-Gate-0 ingest attached bounces to whichever prospect shared the
          sending domain, so a mismatch is a stale record or a misattribution —
          the most actionable line here, and worth counting up front. */}
      {isBounce && mismatches > 0 && (
        <div className="trv-pp-footnote">
          {mismatches} of these bounced from an address that isn't on the prospect record.
          Either the record is stale or the bounce was misattributed by the old ingest path.
        </div>
      )}

      {/* Only hard bounces are subtracted from Delivered, so only hard bounces
          are listed here — the list and the number that opened it must be the
          same set. Blocks and soft bounces are counted in the column tooltip. */}
      {isBounce && (
        <div className="trv-pp-footnote">
          Hard bounces only — the sends removed from Delivered. Blocks (5.7.x) and soft bounces
          are shown in the column tooltip and are <strong>not</strong> subtracted.
        </div>
      )}

      {metric === 'opened' && (
        <div className="trv-pp-footnote">
          Opens are directional — Apple Mail and Gmail image proxies auto-load tracking
          pixels that the bot filter cannot catch. Treat this as an upper bound; clicks
          and replies are the trustworthy signals.
        </div>
      )}

      {metric === 'delivered' && (
        <div className="trv-pp-footnote">
          Delivered = sent with no hard bounce returned. There is no positive delivery
          confirmation; blocks and soft bounces remain in this list.
        </div>
      )}

      {metric === 'replied' && unattributedReplies > 0 && (
        <div className="trv-pp-footnote">
          {unattributedReplies} further {unattributedReplies === 1 ? 'reply' : 'replies'} in this
          campaign came from prospects with no prior enrollment. They can't be attributed to a rep
          or a sequence, so they're excluded from every count on this page.
        </div>
      )}

      {rows.length < total && (
        <div className="trv-pp-footnote">
          Showing the {rows.length} most recent. Narrow the window to see the rest.
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ProspectListBody — table of enrollments rendered inside the panel
// ──────────────────────────────────────────────────────────────────────────
function ProspectListBody({ loading, error, enrollments, total, loadingMore, onLoadMore, onPick }) {
  if (loading && !enrollments) return <LoadingState />;
  if (error) return <ErrorBanner message={error} />;
  if (!enrollments || enrollments.length === 0) {
    return <EmptyState message="No enrolled prospects." />;
  }
  const totalCount = typeof total === 'number' && total > 0 ? total : enrollments.length;
  const hasMore = enrollments.length < totalCount;
  return (
    <div className="trv-pp-list">
      <div className="trv-pp-count">
        {enrollments.length === totalCount
          ? `${totalCount} prospect${totalCount === 1 ? '' : 's'}`
          : `Showing ${enrollments.length} of ${totalCount} prospects`}
      </div>
      {enrollments.map(e => {
        const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim() || e.email;
        const stepLabel = e.total_steps
          ? `step ${e.current_step ?? '—'} of ${e.total_steps}`
          : `step ${e.current_step ?? '—'}`;
        const statusColor =
          e.status === 'replied'   ? 'trv-status-success' :
          e.status === 'stopped'   ? 'trv-status-muted' :
          e.status === 'completed' ? 'trv-status-success' :
          e.status === 'paused'    ? 'trv-status-warning' :
          'trv-status-neutral';
        return (
          <button key={e.id} className="trv-pp-row" onClick={() => onPick(e.id)}>
            <div className="trv-pp-row-main">
              <div className="trv-pp-row-name">{name}</div>
              <div className="trv-pp-row-meta">
                {e.company_name && <span>{e.company_name}</span>}
                {e.company_name && <span className="trv-pp-row-dot">·</span>}
                <span>{stepLabel}</span>
              </div>
            </div>
            <div className="trv-pp-row-right">
              <span className={`trv-pp-status ${statusColor}`}>{e.status}</span>
              <div className="trv-pp-row-time">{fmtDate(e.last_fired_at || e.enrolled_at)}</div>
            </div>
          </button>
        );
      })}
      {hasMore && (
        <button
          className="trv-pp-loadmore"
          onClick={onLoadMore}
          disabled={loadingMore}
          style={{
            width: '100%', padding: '10px 0', marginTop: 8,
            border: '1px solid #d1d5db', borderRadius: 8,
            background: loadingMore ? '#f3f4f6' : '#fff',
            color: '#374151', fontSize: 12, fontWeight: 600,
            cursor: loadingMore ? 'default' : 'pointer',
          }}
        >
          {loadingMore ? 'Loading…' : `Load more (${totalCount - enrollments.length} left)`}
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ProspectTimelineBody — step-by-step view for one enrollment
// Uses the existing /sequences/enrollments/:id response shape — each step
// includes either log data (if fired) or scheduled metadata (if future).
// ──────────────────────────────────────────────────────────────────────────
function ProspectTimelineBody({ loading, error, timeline, enrollment }) {
  if (loading && !timeline) return <LoadingState />;
  if (error) return <ErrorBanner message={error} />;
  if (!timeline || timeline.length === 0) {
    return <EmptyState message="No timeline data for this enrollment." />;
  }
  return (
    <div className="trv-tl">
      {enrollment && (
        <div className="trv-tl-summary">
          <div><span className="trv-tl-summary-label">Sequence:</span> {enrollment.sequence_name}</div>
          <div><span className="trv-tl-summary-label">Status:</span> {enrollment.status}</div>
          <div><span className="trv-tl-summary-label">Enrolled:</span> {fmtDate(enrollment.enrolled_at)}</div>
        </div>
      )}
      <div className="trv-tl-steps">
        {timeline.map((step, idx) => (
          <TimelineStep key={step.log_id || `future-${step.step_order}-${idx}`} step={step} />
        ))}
      </div>
    </div>
  );
}

function TimelineStep({ step }) {
  const [expanded, setExpanded] = useState(false);
  const isFuture = step.is_future;
  const statusBadgeClass =
    step.status === 'replied'   ? 'trv-tl-badge-success' :
    step.status === 'completed' || step.status === 'sent' ? 'trv-tl-badge-info' :
    step.status === 'failed'    ? 'trv-tl-badge-danger'  :
    step.status === 'draft'     ? 'trv-tl-badge-warning' :
    'trv-tl-badge-muted';
  return (
    <div className={`trv-tl-step ${isFuture ? 'trv-tl-step-future' : ''}`}>
      <div className="trv-tl-step-dot" />
      <div className="trv-tl-step-card">
        <div className="trv-tl-step-header" onClick={() => setExpanded(!expanded)}>
          <div className="trv-tl-step-meta">
            <span className="trv-tl-step-num">Step {step.step_order}</span>
            <span className="trv-tl-channel">{step.channel}</span>
            <span className={`trv-tl-badge ${statusBadgeClass}`}>{step.status}</span>
          </div>
          <div className="trv-tl-step-time">
            {step.fired_at ? fmtDate(step.fired_at) :
             step.scheduled_send_at ? `scheduled ${fmtDate(step.scheduled_send_at)}` : ''}
          </div>
        </div>
        {(step.subject || step.subject_template) && (
          <div className="trv-tl-step-subject">{step.subject || step.subject_template}</div>
        )}
        {expanded && (step.body || step.body_template) && (
          <div className="trv-tl-step-body" style={{ whiteSpace: 'pre-wrap' }}>
            {step.body || step.body_template || ''}
          </div>
        )}
        {expanded && step.task_note && (
          <div className="trv-tl-step-task">Note: {step.task_note}</div>
        )}
        {expanded && step.error_message && (
          <div className="trv-tl-step-error">Error: {step.error_message}</div>
        )}
        {(step.body || step.body_template || step.task_note) && (
          <button className="trv-tl-step-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'hide details' : 'show details'}
          </button>
        )}
      </div>

      {(step.inbound || []).length > 0 && (
        <div className="trv-tl-inbound-group">
          {step.inbound.map(ev => (
            <TimelineInboundEvent key={`${ev.kind}-${ev.id}`} event={ev} />
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TimelineInboundEvent — what came back, nested under the step it answers
//
// Three kinds, one card. A reply reads as a message; a bounce reads as a
// delivery failure. Both hang off the step that caused them, so the panel
// finally tells the whole story: we sent this, and this is what happened.
//
// `address_mismatch` on a bounce means the address the mail server actually
// rejected is not the address on the prospect record. That is a stale contact
// or a misattributed bounce, and it is the single most actionable thing on
// this screen — so it gets called out rather than buried in the diagnostic.
// ──────────────────────────────────────────────────────────────────────────
function TimelineInboundEvent({ event: ev }) {
  const [expanded, setExpanded] = useState(false);
  const isBounce = ev.kind === 'bounce';

  const label =
    ev.kind === 'email_reply'    ? 'Reply' :
    ev.kind === 'linkedin_reply' ? 'LinkedIn reply' :
    ev.event_type === 'hard_bounce' ? 'Hard bounce' :
    ev.event_type === 'soft_bounce' ? 'Soft bounce' :
    ev.event_type === 'block'        ? 'Blocked' : 'Bounce';

  const badgeClass = isBounce
    ? (ev.event_type === 'soft_bounce' ? 'trv-tl-badge-warning' : 'trv-tl-badge-danger')
    : 'trv-tl-badge-success';

  const hasBody = !!ev.body;

  return (
    <div className={`trv-tl-inbound ${isBounce ? 'trv-tl-inbound-bounce' : ''}`}>
      <div className="trv-tl-inbound-arrow" aria-hidden="true">↩</div>
      <div className="trv-tl-inbound-card">
        <div className="trv-tl-inbound-header">
          <div className="trv-tl-step-meta">
            <span className={`trv-tl-badge ${badgeClass}`}>{label}</span>
            {ev.sentiment && <span className="trv-tl-channel">{ev.sentiment}</span>}
            {isBounce && ev.enrollment_stopped && (
              <span className="trv-tl-badge trv-tl-badge-warning">enrollment stopped</span>
            )}
          </div>
          <div className="trv-tl-step-time">{fmtDate(ev.occurred_at)}</div>
        </div>

        {ev.from && <div className="trv-tl-inbound-from">{ev.from}</div>}
        {ev.subject && <div className="trv-tl-step-subject">{ev.subject}</div>}

        {isBounce && (
          <div className="trv-tl-inbound-diag">
            {ev.smtp_code && <span className="trv-tl-smtp">{ev.smtp_code}</span>}
            {ev.failed_recipient && <span className="trv-tl-failed">{ev.failed_recipient}</span>}
          </div>
        )}
        {isBounce && ev.address_mismatch && (
          <div className="trv-tl-inbound-mismatch">
            The rejected address differs from the address on this prospect.
          </div>
        )}
        {isBounce && ev.diagnostic && (
          <div className="trv-tl-inbound-body">{ev.diagnostic}</div>
        )}

        {!isBounce && hasBody && expanded && (
          <div className="trv-tl-inbound-body" style={{ whiteSpace: 'pre-wrap' }}>{ev.body}</div>
        )}
        {!isBounce && hasBody && (
          <button className="trv-tl-step-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'hide message' : 'show message'}
          </button>
        )}
      </div>
    </div>
  );
}
