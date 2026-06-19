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
import './TeamReportingView.css';

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
    return q;
  }, [depth, windowState, campaignFilter]);

  const loadTab = useCallback(async (which) => {
    if (!depth) return;     // wait for scope hydration

    let url;
    if (which === 'rep')      url = `/reporting/sequences/team-by-rep?${queryString}`;
    if (which === 'campaign') url = `/reporting/sequences/team-overview?${queryString}`;
    if (which === 'sequence') url = `/reporting/sequences/team-by-sequence?${queryString}`;
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
        showCampaignFilter={tab !== 'campaign' && tab !== 'insights' && tab !== 'linkedin'}   // tab 'campaign' IS the campaign list; insights org-level; LinkedIn risk has no campaign filter
        showWindowPicker={tab !== 'wbr' && tab !== 'insights' && tab !== 'linkedin'}           // WBR/insight windows fixed; LinkedIn risk has its own window picker
      />

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {tab === 'rep' && (
        <RepTab data={repData} loading={tabLoading} scope={scope} windowState={windowState} onSetWindow={setWindowState} />
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
        />
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

      {prospectPanel && (
        <ProspectListPanel
          context={prospectPanel}
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
function TabBar({ tab, onTabChange }) {
  const tabs = [
    { key: 'rep',      label: 'By rep' },
    { key: 'campaign', label: 'By campaign' },
    { key: 'sequence', label: 'By sequence' },
    { key: 'wbr',      label: 'WBR' },        // Insights/WBR Phase 5
    { key: 'insights', label: 'Insights' },   // Insights/WBR Phase 5
    { key: 'linkedin', label: 'LinkedIn risk' },
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
function RepTab({ data, loading, scope, windowState, onSetWindow }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const reps = data.reps || [];
  const allZero = reps.length > 0 && reps.every(r =>
    (r.sent || 0) === 0 && (r.enrolled || 0) === 0 && (r.drafts || 0) === 0 && (r.replied || 0) === 0
  );
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
                      <td className="num">{fmtNum(r.enrolled)}</td>
                      <td className="num">{fmtNum(r.drafts)}</td>
                      <td className="num">{fmtNum(r.sent)}</td>
                      <td className="num">{fmtNum(r.replied)}</td>
                      <td className="num">{fmtNum(r.failed)}</td>
                      <td className={`num ${r.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(r.stalled)}</td>
                      <td className="num">{fmtPct(r.repliedRate)}</td>
                    </tr>
                    {expanded && (
                      <tr className="trv-expand-row">
                        <td colSpan={9}>
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
function CampaignTab({ data, loading, scope, onDrillIn, onOpenProspects, windowState, onSetWindow }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const campaigns = data.campaigns || [];
  const allZero = campaigns.length > 0 && campaigns.every(c =>
    (c.sent || 0) === 0 && (c.enrolled || 0) === 0 && (c.drafts || 0) === 0 && (c.replied || 0) === 0
  );
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
                <th className="num">Sent</th>
                <th className="num">Replied</th>
                <th className="num">Stalled</th>
                <th className="num">Reply rate</th>
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
                      <td className="trv-link">{c.name || <span className="trv-muted">(unnamed campaign)</span>}</td>
                      <td>
                        {c.owner ? c.owner.name : <span className="trv-muted">—</span>}
                        {c.owner && depthBadge(c.owner)}
                      </td>
                      <td className="num">{fmtNum(c.enrolled)}</td>
                      <td className="num">{fmtNum(c.sent)}</td>
                      <td className="num">{fmtNum(c.replied)}</td>
                      <td className={`num ${c.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(c.stalled)}</td>
                      <td className="num">{fmtPct(c.repliedRate)}</td>
                    </tr>
                    {expanded && (
                      <tr className="trv-expand-row">
                        <td colSpan={8}>
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
function SequenceTab({ data, loading, scope, windowState, onSetWindow, onOpenProspects }) {
  const [expandedId, setExpandedId] = useState(null);
  if (loading && !data) return <LoadingState />;
  if (!data) return null;
  const totals = data.totals || {};
  const sequences = data.sequences || [];
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
          { label: 'Connected',        value: fmtNum(totals.connected) },
          { label: 'Reply rate',       value: fmtPct(totals.repliedRate) },
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
                      <td className="num">{fmtNum(s.enrolled)}</td>
                      <td className="num">{fmtNum(s.sent)}</td>
                      <td className="num" title={s.enrolled > 0 ? `${Math.round((s.connected / s.enrolled) * 100)}% of enrolled accepted` : undefined}>
                        {s.connected > 0
                          ? <span style={{ color: '#059669', fontWeight: 600 }}>{fmtNum(s.connected)}</span>
                          : fmtNum(s.connected)}
                      </td>
                      <td className="num">{fmtNum(s.replied)}</td>
                      <td className={`num ${s.stalled > 0 ? 'trv-warning' : ''}`}>{fmtNum(s.stalled)}</td>
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
                        <td colSpan={9}>
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
  drillData, drillLoading, drillError, scope, window: win, onOpenProspects,
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
        {drillData && <DrilldownDetail data={drillData} scope={scope} onOpenProspects={onOpenProspects} />}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DrilldownDetail — body of the right-side panel
// Per-sequence table + per-rep table, both from the same response.
// ──────────────────────────────────────────────────────────────────────────
function DrilldownDetail({ data, scope, onOpenProspects }) {
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
                <th></th>
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

// ──────────────────────────────────────────────────────────────────────────
// ProspectListPanel — right-side overlay panel
//
// Two modes determined by props:
//   • enrollmentId === null → "list mode" — shows enrolled prospects in the
//     given sequence/campaign, with current step + status + last activity.
//   • enrollmentId !== null → "timeline mode" — shows the per-step timeline
//     (executed + future) for one prospect's enrollment.
//
// Fetches:
//   List mode  → GET /sequences/enrollments?sequenceId= or ?campaignId=
//   Timeline   → GET /sequences/enrollments/:enrollmentId
//
// The panel is fixed to the right edge of the viewport, ~440px wide.
// Clicking outside the panel does NOT close it (the underlying reporting
// view is interactive and the user may want to switch tabs while keeping
// the prospect list open). Only the explicit ✕ button closes it.
// ──────────────────────────────────────────────────────────────────────────
function ProspectListPanel({ context, enrollmentId, onPickEnrollment, onBackToList, onClose }) {
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
  }, [enrollmentId, listParams]);

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
  const title = enrollmentId
    ? (tlEnrollment
        ? `${[tlEnrollment.first_name, tlEnrollment.last_name].filter(Boolean).join(' ').trim() || tlEnrollment.email}`
        : 'Loading…')
    : (context.sequenceName || context.campaignName || '');
  const subtitle = enrollmentId
    ? (tlEnrollment?.email || '')
    : (context.sequenceId ? 'Enrolled prospects' : 'Prospects in this campaign');

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
            <div className="trv-pp-context">{context.sequenceId ? 'Sequence' : 'Campaign'}</div>
          )}
          <button className="trv-pp-close" onClick={onClose} aria-label="Close panel">✕</button>
        </div>
        <div className="trv-pp-title-block">
          <div className="trv-pp-title">{title}</div>
          <div className="trv-pp-subtitle">{subtitle}</div>
        </div>

        <div className="trv-pp-body">
          {!enrollmentId && (
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
    </div>
  );
}
