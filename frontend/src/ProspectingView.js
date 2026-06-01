// ProspectingView.js — top-level orchestrator for the Prospecting feature.
//
// As of the 2026 module split, the individual views, panels, and modals live
// in ./prospecting/*. This file keeps ONLY the ProspectingView component, which
// owns shared state (prospects, scope, selection) and routes between views.
// Shared helpers/constants/context now live in ./prospecting/prospectingShared.

import React, { useState, useEffect, useCallback } from 'react';

import {
  DEFAULT_PROSPECT_STAGES,
  DEFAULT_TERMINAL_STAGES,
  STAGE_ICONS,
  StagesContext,
  TEAL,
  apiFetch,
  downloadCsv,
  readDebugFlag,
} from './prospecting/prospectingShared';

import PipelineBoard        from './prospecting/PipelineBoard';
import ListView             from './prospecting/ListView';
import AccountView          from './prospecting/AccountView';
import ProspectCreateModal  from './prospecting/ProspectCreateModal';
import ProspectDetailPanel  from './prospecting/ProspectDetailPanel';
import DiscardProspectModal from './prospecting/DiscardProspectModal';
import SequencesView        from './prospecting/SequencesView';
import CampaignsView        from './prospecting/CampaignsView';
import ResearchQueueView    from './prospecting/ResearchQueueView';
import CallsInboxView       from './prospecting/CallsInboxView';
import ProspectingInbox     from './prospecting/ProspectingInbox';

import SequenceEnrollModal  from './SequenceEnrollModal';
import CSVImportModal       from './CSVImportModal';

import './ProspectingView.css';
import './OutreachComposer.css';

export default function ProspectingView() {
  const [prospects, setProspects] = useState([]);
  const [pipelineSummary, setPipelineSummary] = useState({ pipeline: [], metrics: {} });
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('mine');
  const [viewMode, setViewMode] = useState('pipeline'); // pipeline | list | account
  const [searchQuery, setSearchQuery] = useState('');
  // Debounced mirror of searchQuery. The input stays bound to searchQuery for
  // responsiveness; the data fetches (prospects + the Inbox/Sequences/Calls
  // views) key off debouncedSearch so we don't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Ask #2: clickable stage-chip filter for the flat List/Accounts views.
  // null = "All active" (no stage filter). The Pipeline board is already
  // columnar, so it is intentionally NOT filtered by this (no-op there).
  const [stageFilter, setStageFilter] = useState(null);
  // Whether the "Later stages ▾" dropdown (collapsed zero-count stages) is open.
  const [laterStagesOpen, setLaterStagesOpen] = useState(false);
  const [selectedProspect, setSelectedProspect] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  // Campaign filter — set when the user clicks "View in Pipeline" from a
  // campaign in the Campaigns tab. Holds { campaignId, campaignName } or null.
  // When active, the Pipeline/List/Account boards are scoped to that campaign
  // and a dismissible banner is shown.
  const [campaignFilter, setCampaignFilter] = useState(null);

  // Drafts deep-link context, set when arriving from a campaign's "Preview
  // drafts". { campaignId, campaignName } | null.
  const [draftsDeepLink, setDraftsDeepLink] = useState(null);

  // Slice 5: list of active campaigns the user can switch between from the
  // filter banner. Loaded once on mount and on campaign-filter changes so the
  // dropdown always reflects the current set. Pinned campaigns surface first.
  const [activeCampaigns, setActiveCampaigns] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch('/prospecting-campaigns?status=active');
        if (!cancelled) setActiveCampaigns(r.campaigns || []);
      } catch (_) {
        if (!cancelled) setActiveCampaigns([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Phase 2: set of prospect_ids that have an overdue call task (either a
  // sequence step past scheduled_send_at, or a callback_requested past its
  // callback_requested_at). Fetched separately so the prospects list query
  // doesn't have to do correlated subqueries. Refreshed on scope change.
  const [overdueCallProspectIds, setOverdueCallProspectIds] = useState(() => new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/prospect-calls/inbox?scope=${scope}&filter=overdue&limit=200`);
        if (cancelled) return;
        const ids = new Set((r.items || []).map(i => i.prospect_id).filter(Boolean));
        setOverdueCallProspectIds(ids);
      } catch (_) { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // ── Bulk selection state ──────────────────────────────────────────────────
  // A set of prospect IDs the user has checked for bulk actions (currently
  // only "Enroll in sequence"). Capped at BULK_ENROLL_CAP because the enroll
  // modal itself doesn't accept more than that.
  const BULK_ENROLL_CAP = 20;
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showBulkEnrollModal, setShowBulkEnrollModal] = useState(false);
  const [showBulkDiscardModal, setShowBulkDiscardModal] = useState(false);
  // Single-prospect discard (from a card/row ⋯ menu). Holds the prospect
  // whose menu was used; modal opens when non-null.
  const [discardTargetProspect, setDiscardTargetProspect] = useState(null);

  // ── Debug mode keyboard shortcut ─────────────────────────────────────────
  // Ctrl+Shift+D (Cmd+Shift+D on Mac) toggles the gowarm_debug flag in
  // localStorage, which controls visibility of the DB-IDs strip in the
  // ProspectDetailPanel. We listen at the top level so the shortcut works
  // whether or not a drawer is open. State is broadcast to children via a
  // 'gowarm-debug-changed' window event.
  const [debugToast, setDebugToast] = useState(null);
  useEffect(() => {
    function onKeyDown(e) {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod || !e.shiftKey) return;
      if (e.key !== 'D' && e.key !== 'd') return;
      // Skip when typing in editable fields.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const next = !readDebugFlag();
      try {
        if (next) window.localStorage.setItem('gowarm_debug', '1');
        else      window.localStorage.removeItem('gowarm_debug');
      } catch (_) { /* swallow */ }
      // Broadcast so any open ProspectDetailPanel re-renders its strip.
      try {
        window.dispatchEvent(new CustomEvent('gowarm-debug-changed', { detail: next }));
      } catch (_) { /* swallow */ }
      setDebugToast(next ? 'Debug mode ON' : 'Debug mode OFF');
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (!debugToast) return;
    const t = setTimeout(() => setDebugToast(null), 1400);
    return () => clearTimeout(t);
  }, [debugToast]);

  // Campaign-filter bridge: CampaignsView's "View in Pipeline" dispatches a
  // 'campaign-filter' window event. We catch it, store the filter, and switch
  // to the Pipeline board so the user lands on the scoped view.
  useEffect(() => {
    function onCampaignFilter(e) {
      const detail = e.detail || {};
      if (!detail.campaignId) return;
      setCampaignFilter({ campaignId: detail.campaignId, campaignName: detail.campaignName });
      setViewMode('pipeline');
    }
    window.addEventListener('campaign-filter', onCampaignFilter);
    return () => window.removeEventListener('campaign-filter', onCampaignFilter);
  }, []);

  // Drafts deep-link bridge: CampaignsView's "Preview drafts" dispatches a
  // 'drafts-deep-link' window event. We catch it, store the campaign context,
  // and switch to the Inbox so the user lands on Drafts pre-filtered to that
  // campaign (with a back-to-campaign breadcrumb).
  useEffect(() => {
    function onDraftsDeepLink(e) {
      const detail = e.detail || {};
      if (!detail.campaignId) return;
      setDraftsDeepLink({ campaignId: detail.campaignId, campaignName: detail.campaignName });
      setViewMode('inbox');
    }
    window.addEventListener('drafts-deep-link', onDraftsDeepLink);
    return () => window.removeEventListener('drafts-deep-link', onDraftsDeepLink);
  }, []);

  const isSelected = (id) => selectedIds.has(id);
  const clearSelection = () => setSelectedIds(new Set());
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Hard cap: can't add a 21st.
        if (next.size >= BULK_ENROLL_CAP) return prev;
        next.add(id);
      }
      return next;
    });
  };
  // Select every prospect in the given array, up to the cap. Prospects already
  // selected stay selected; new IDs get added until the cap is reached.
  const selectMany = (ids) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (next.size >= BULK_ENROLL_CAP) break;
        next.add(id);
      }
      return next;
    });
  };
  // Unselect every prospect in the given array.
  const unselectMany = (ids) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  };

  // Remove the selected prospects from the campaign currently in view. Only
  // available when a campaign filter is active. Changes campaign membership
  // only — does NOT disqualify or change stage (unlike Discard).
  const [removingCampaign, setRemovingCampaign] = useState(false);
  const handleRemoveFromCampaign = async () => {
    if (!campaignFilter || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const ok = window.confirm(
      `Remove ${ids.length} prospect${ids.length === 1 ? '' : 's'} from "${campaignFilter.campaignName}"? ` +
      `They stay in your prospect list and are not disqualified.`
    );
    if (!ok) return;
    setRemovingCampaign(true);
    try {
      const res = await apiFetch('/prospects/bulk-campaign', {
        method: 'POST',
        body: JSON.stringify({ prospectIds: ids, campaignId: null }),
      });
      clearSelection();
      fetchProspects();
      if (res?.updated != null) {
        // Light, non-blocking confirmation.
        console.log(`Removed ${res.updated} from campaign`);
      }
    } catch (err) {
      alert(`Could not remove from campaign: ${err.message}`);
    } finally {
      setRemovingCampaign(false);
    }
  };

  // Clear selection when the user switches views or changes the search query.
  // Prevents stale selections (prospect might be filtered out of the current
  // view) from lingering invisibly and confusing the rep.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [viewMode, searchQuery, scope]);

  const handleExportProspects = async () => {
    // Scope the export to the campaign currently in view, if any — otherwise
    // export all live prospects in scope. The downloaded sheet carries the
    // immutable id + a do_not_edit_check column for the "update by ID" reimport.
    try {
      const qs = campaignFilter ? `?campaignId=${campaignFilter.campaignId}` : '';
      await downloadCsv(`/prospects/export.csv${qs}`, 'prospects.csv');
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  };

  const handleImportProspects = async (rows, opts = {}) => {
    const mode = opts.mode || 'insert';
    const res = await apiFetch('/prospects/bulk', {
      method: 'POST',
      body: JSON.stringify({
        prospects: rows,
        source: 'csv_import',
        mode,
        ...(mode === 'upsert' ? { matchField: 'linkedin_url' } : {}),
      }),
    });
    fetchProspects();
    return res; // { imported, updated, skipped, errors }
  };

  // Dynamic stages from API
  const [PROSPECT_STAGES, setProspectStages] = useState(DEFAULT_PROSPECT_STAGES);
  const [TERMINAL_STAGES, setTerminalStages] = useState(DEFAULT_TERMINAL_STAGES);
  const ALL_STAGES = [...PROSPECT_STAGES, ...TERMINAL_STAGES];

  // Fetch org-customised prospect stages
  useEffect(() => {
    apiFetch('/pipeline-stages/prospecting')
      .then(data => {
        const stages = (data.stages || []).sort((a, b) => a.sort_order - b.sort_order);
        if (stages.length > 0) {
          const active    = stages.filter(s => s.is_active && !s.is_terminal);
          const terminal  = stages.filter(s => s.is_active && s.is_terminal);
          setProspectStages(active.map(s => ({
            key: s.key, label: s.name,
            icon: STAGE_ICONS[s.stage_type] || '⚙️',
            color: s.color || '#6b7280',
          })));
          setTerminalStages(terminal.map(s => ({
            key: s.key, label: s.name,
            icon: STAGE_ICONS[s.stage_type] || '⚙️',
            color: s.color || '#6b7280',
          })));
        }
      })
      .catch(() => { /* fallback to defaults */ });
  }, []);

  // Check if user has team
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const hasTeam = user.subordinateIds?.length > 0 || user.role === 'manager' || user.role === 'admin';

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchProspects = useCallback(async () => {
    try {
      setLoading(true);

      const campaignQS = campaignFilter ? `&campaignId=${campaignFilter.campaignId}` : '';

      const [prospectsRes, summaryRes] = await Promise.all([
        apiFetch(`/prospects?scope=${scope}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ''}${campaignQS}`),
        apiFetch(`/prospects/pipeline/summary?scope=${scope}`),
      ]);

      setProspects(prospectsRes.prospects || []);
      setPipelineSummary(summaryRes);
    } catch (err) {
      console.error('Failed to fetch prospects:', err);
    } finally {
      setLoading(false);
    }
  }, [scope, debouncedSearch, campaignFilter]);

  useEffect(() => { fetchProspects(); }, [fetchProspects]);

  // ── Stage change handler ───────────────────────────────────────────────────

  const handleStageChange = async (prospectId, newStage, reason) => {
    try {
      await apiFetch(`/prospects/${prospectId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: newStage, reason }),
      });
      fetchProspects();
    } catch (err) {
      alert(err.message);
    }
  };

  // ── Create prospect ────────────────────────────────────────────────────────

  const handleCreateProspect = async (data) => {
    try {
      await apiFetch('/prospects', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      setShowCreateForm(false);
      fetchProspects();
    } catch (err) {
      alert(err.message);
    }
  };

  // ── Group by stage for pipeline ────────────────────────────────────────────

  const groupedByStage = {};
  PROSPECT_STAGES.forEach(s => {
    groupedByStage[s.key] = prospects.filter(p => p.stage === s.key);
  });

  // Terminal counts
  const convertedCount = prospects.filter(p => p.stage === 'converted').length;
  const disqualifiedCount = prospects.filter(p => p.stage === 'disqualified').length;
  const nurtureCount = prospects.filter(p => p.stage === 'nurture').length;

  // ── Stage-filtered set for the flat List/Accounts views ────────────────────
  // groupedByStage (above) and the metrics chips (below) intentionally stay on
  // the FULL prospects set so chip counts reflect the whole scope; only the
  // List/Accounts data path narrows when a stage chip is active. This composes
  // (ANDs) with scope + campaignFilter, which are already applied server-side.
  const visibleProspects = stageFilter
    ? prospects.filter(p => p.stage === stageFilter)
    : prospects;

  // ── Group by account for account view ──────────────────────────────────────

  const groupedByAccount = {};
  visibleProspects.forEach(p => {
    const key = p.account_id || p.company_name || 'Unlinked';
    if (!groupedByAccount[key]) {
      groupedByAccount[key] = {
        accountId: p.account_id,
        accountName: p.account?.name || p.company_name || 'Unlinked',
        domain: p.account?.domain || p.company_domain,
        prospects: [],
      };
    }
    groupedByAccount[key].prospects.push(p);
  });

  // ── Metrics bar ────────────────────────────────────────────────────────────

  const totalActive = prospects.filter(p => !['converted', 'disqualified'].includes(p.stage)).length;

  // LinkedIn funnel metrics (computed from channel_data on loaded prospects).
  // Status vocabulary must match what the backend writes (sequences.routes.js
  // and prospects.routes.js): the canonical ladder is
  //   connection_request_sent → connection_accepted → message_sent
  //   → reply_received → meeting_booked
  // Each funnel stage counts that status plus everything downstream of it.
  const liMetrics = React.useMemo(() => {
    const CONNECTED_PLUS = ['connection_accepted', 'message_sent', 'reply_received', 'meeting_booked'];
    const MESSAGED_PLUS  = ['message_sent', 'reply_received', 'meeting_booked'];
    const REPLIED_PLUS   = ['reply_received', 'meeting_booked'];
    const sent      = prospects.filter(p => p.channel_data?.linkedin?.connection_status).length;
    const connected = prospects.filter(p => CONNECTED_PLUS.includes(p.channel_data?.linkedin?.connection_status)).length;
    const messaged  = prospects.filter(p => MESSAGED_PLUS.includes(p.channel_data?.linkedin?.connection_status)).length;
    const replied   = prospects.filter(p => REPLIED_PLUS.includes(p.channel_data?.linkedin?.connection_status)).length;
    const acceptRate = sent > 0 ? Math.round((connected / sent) * 100) : null;
    const replyRate  = messaged > 0 ? Math.round((replied / messaged) * 100) : null;
    return { sent, connected, messaged, replied, acceptRate, replyRate };
  }, [prospects]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // Stage-chip click. Toggles the filter (clicking the active chip clears it).
  // The chip filter only affects the flat List/Accounts views; if the user is
  // on a view that can't show it (Pipeline is columnar; Campaigns/Research/
  // Inbox/Sequences/Calls are unrelated), switch to List so the click has a
  // visible effect. "All active" (key = null) never switches the view.
  const handleStageChipClick = (key) => {
    setLaterStagesOpen(false);
    if (key == null) { setStageFilter(null); return; }
    const next = stageFilter === key ? null : key;
    setStageFilter(next);
    if (next && !['list', 'account'].includes(viewMode)) setViewMode('list');
  };

  const stagesCtx = { prospectStages: PROSPECT_STAGES, terminalStages: TERMINAL_STAGES, allStages: ALL_STAGES };

  return (
    <StagesContext.Provider value={stagesCtx}>
    <div className="pv-container">
      {/* Debug-mode toast — appears briefly when Ctrl+Shift+D toggles the
          flag. Position: fixed so it's pinned to the viewport regardless
          of scroll or drawer state. */}
      {debugToast && (
        <div style={{
          position: 'fixed', top: 16, left: '50%',
          transform: 'translateX(-50%)',
          background: '#1F2937', color: '#FEF3C7',
          fontSize: 12, padding: '6px 14px', borderRadius: 14,
          fontWeight: 600, letterSpacing: 0.4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          pointerEvents: 'none', zIndex: 9999,
        }}>
          {debugToast}
        </div>
      )}
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="pv-header">
        <div className="pv-header-left">
          <h2 className="pv-title">
            <span style={{ color: TEAL }}>🎯</span> Prospecting
          </h2>

          {hasTeam && (
            <div className="pv-scope-toggle">
              {['mine', 'team', 'org'].map(s => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`pv-scope-btn ${scope === s ? 'active' : ''}`}
                >
                  {s === 'mine' ? 'My Prospects' : s === 'team' ? 'My Team' : 'All Org'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pv-header-right">
          <div className="pv-search">
            <input
              type="text"
              placeholder="Search prospects..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pv-search-input"
            />
          </div>

          <div className="pv-view-toggle">
            {[
              { key: 'pipeline',  icon: '▦',  label: 'Pipeline' },
              { key: 'list',      icon: '≡',  label: 'List' },
              { key: 'account',   icon: '🏢', label: 'Accounts' },
              { key: 'campaigns', icon: '🚀', label: 'Campaigns' },
              { key: 'research',  icon: '🔬', label: 'Research Queue' },
              { key: 'inbox',     icon: '📥', label: 'Inbox' },
              { key: 'sequences', icon: '📨', label: 'Sequences' },
              { key: 'calls',     icon: '📞', label: 'Calls' },
            ].map(v => (
              <button
                key={v.key}
                onClick={() => setViewMode(v.key)}
                className={`pv-view-btn ${viewMode === v.key ? 'active' : ''}`}
                title={v.label}
              >
                {v.icon}
              </button>
            ))}
          </div>

          <button className="pv-btn-secondary" onClick={() => {
            window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'playbooks', playbookFilter: 'prospecting' } }));
          }}>
            📋 Playbooks
          </button>

          <button className="pv-btn-secondary" onClick={handleExportProspects}
            title={campaignFilter ? `Export "${campaignFilter.campaignName}" prospects` : 'Export prospects'}>
            ⬇ Export CSV
          </button>

          <button className="pv-btn-secondary" onClick={() => setShowImportModal(true)}>
            ⬆ Import CSV
          </button>

          <button className="pv-add-btn" onClick={() => setShowCreateForm(true)}>
            + Add Prospect
          </button>
        </div>
      </div>

      {/* ── Metrics Bar (clickable stage chips + performance group) ─────────── */}
      <div className="pv-metrics-bar" style={{ gap: 8 }}>
        {(() => {
          const EMBER = '#E8630A';
          const chipStyle = (active) => ({
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 11px', borderRadius: 16, cursor: 'pointer',
            fontSize: 12, fontWeight: active ? 700 : 500, lineHeight: 1.4,
            border: active ? `1px solid ${EMBER}` : '1px solid #e5e7eb',
            background: active ? '#FEF1E7' : '#fff',
            color: active ? EMBER : '#374151',
            whiteSpace: 'nowrap',
          });
          const countStyle = (active, accent) => ({
            fontWeight: 700, color: active ? EMBER : (accent || '#6b7280'),
          });

          // Split the (non-terminal) stages into visible (count > 0, or the one
          // currently filtered) and collapsed (zero-count) — dynamic, not a
          // fixed list, since stages are org-configurable.
          const visible = [];
          const collapsed = [];
          PROSPECT_STAGES.forEach(s => {
            const count = (groupedByStage[s.key] || []).length;
            if (count > 0 || s.key === stageFilter) visible.push({ s, count });
            else collapsed.push({ s, count });
          });

          return (
            <>
              {/* All active */}
              <button
                type="button"
                onClick={() => handleStageChipClick(null)}
                style={chipStyle(stageFilter === null, TEAL)}
                title="Show all active prospects"
              >
                <span>All active</span>
                <span style={countStyle(stageFilter === null, TEAL)}>{totalActive}</span>
              </button>

              {/* Visible stage chips */}
              {visible.map(({ s, count }) => {
                const active = stageFilter === s.key;
                return (
                  <button
                    type="button"
                    key={s.key}
                    onClick={() => handleStageChipClick(s.key)}
                    style={chipStyle(active, s.color)}
                    title={`Filter List/Accounts to ${s.label}`}
                  >
                    <span>{s.label}</span>
                    <span style={countStyle(active, s.color)}>{count}</span>
                  </button>
                );
              })}

              {/* Later stages (collapsed zero-count stages) */}
              {collapsed.length > 0 && (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <button
                    type="button"
                    onClick={() => setLaterStagesOpen(o => !o)}
                    style={{
                      ...chipStyle(false),
                      color: '#6b7280', borderStyle: 'dashed',
                    }}
                    title="Show later stages with no prospects yet"
                  >
                    <span>Later stages</span>
                    <span style={{ fontSize: 10 }}>{laterStagesOpen ? '▴' : '▾'}</span>
                  </button>
                  {laterStagesOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 6,
                      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
                      boxShadow: '0 6px 18px rgba(0,0,0,0.10)', padding: 8, zIndex: 50,
                      display: 'flex', flexDirection: 'column', gap: 6, minWidth: 160,
                    }}>
                      {collapsed.map(({ s, count }) => {
                        const active = stageFilter === s.key;
                        return (
                          <button
                            type="button"
                            key={s.key}
                            onClick={() => handleStageChipClick(s.key)}
                            style={{ ...chipStyle(active, s.color), justifyContent: 'space-between', width: '100%' }}
                          >
                            <span>{s.label}</span>
                            <span style={countStyle(active, s.color)}>{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}

        {/* Divider before the performance group */}
        <div className="pv-metric-separator" style={{ marginLeft: 'auto' }} />

        {/* This-week performance group — visually separated so these read as
            rates/throughput, not pipeline stage counts. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#9ca3af',
            textTransform: 'uppercase', letterSpacing: 0.5, alignSelf: 'center',
          }}>This week</span>
          <div className="pv-metric">
            <span className="pv-metric-value" style={{ color: '#f59e0b' }}>
              {pipelineSummary.metrics?.outreachThisWeek || 0}
            </span>
            <span className="pv-metric-label">Outreach</span>
          </div>
          <div className="pv-metric">
            <span className="pv-metric-value" style={{ color: TEAL }}>
              {pipelineSummary.metrics?.responsesThisWeek || 0}
            </span>
            <span className="pv-metric-label">Responses</span>
          </div>
          <div className="pv-metric">
            <span className="pv-metric-value" style={{ color: '#059669' }}>{convertedCount}</span>
            <span className="pv-metric-label">Converted</span>
          </div>
        </div>
      </div>

      {/* ── LinkedIn Funnel Strip ───────────────────────────────────────────── */}
      {liMetrics.sent > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 0,
          background: '#f8fafc', border: '1px solid #e2e8f0',
          borderRadius: 8, padding: '8px 16px', marginBottom: 12, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#0077B5', marginRight: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ background: '#0077B5', color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>in</span>
            LinkedIn Funnel
          </span>
          {[
            { label: 'Requests',  value: liMetrics.sent,      rate: null },
            { label: 'Connected', value: liMetrics.connected, rate: liMetrics.acceptRate != null ? `${liMetrics.acceptRate}% accepted` : null },
            { label: 'Messaged',  value: liMetrics.messaged,  rate: null },
            { label: 'Replied',   value: liMetrics.replied,   rate: liMetrics.replyRate != null ? `${liMetrics.replyRate}% reply rate` : null },
          ].map((step, i) => (
            <React.Fragment key={step.label}>
              {i > 0 && <span style={{ color: '#cbd5e1', fontSize: 16, margin: '0 8px' }}>›</span>}
              <div style={{ textAlign: 'center' }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#1e293b' }}>{step.value}</span>
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 4 }}>{step.label}</span>
                {step.rate && (
                  <span style={{ fontSize: 10, color: '#059669', marginLeft: 6, fontWeight: 600 }}>{step.rate}</span>
                )}
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* ── Campaign Filter Banner ─────────────────────────────────────────── */}
      {/* Slice 5: banner now includes a switcher dropdown so the rep can
          change campaigns without leaving the pipeline view. */}
      {campaignFilter && ['pipeline', 'list', 'account'].includes(viewMode) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between',
          background: '#fff8f0', border: '1px solid #FBCF9D', borderRadius: 8,
          padding: '8px 14px', marginBottom: 12, fontSize: 13, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 auto' }}>
            <span style={{ color: '#92400e' }}>🚀 Showing prospects in campaign:</span>
            <select
              value={campaignFilter.campaignId}
              onChange={(e) => {
                const id = parseInt(e.target.value, 10);
                if (!id) {
                  setCampaignFilter(null);
                  return;
                }
                const next = activeCampaigns.find(c => c.id === id);
                setCampaignFilter({
                  campaignId: id,
                  campaignName: next?.name || `Campaign ${id}`,
                });
              }}
              style={{
                fontSize: 13, fontWeight: 600, padding: '4px 8px',
                border: '1px solid #FBCF9D', borderRadius: 5,
                background: '#fff', color: '#92400e', cursor: 'pointer',
                maxWidth: 320,
              }}
            >
              {/* If the current filter isn't in the active campaigns list (e.g.
                  paused or completed), surface it as a synthetic option so the
                  rep can still see what they're filtered to. */}
              {!activeCampaigns.some(c => c.id === campaignFilter.campaignId) && (
                <option value={campaignFilter.campaignId}>
                  {campaignFilter.campaignName} (not active)
                </option>
              )}
              {activeCampaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setCampaignFilter(null)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#92400e', fontSize: 13, fontWeight: 600,
            }}
          >✕ Clear filter</button>
        </div>
      )}

      {/* ── Content Area ───────────────────────────────────────────────────── */}
      {loading ? (
        <div className="pv-loading">Loading prospects...</div>
      ) : viewMode === 'pipeline' ? (
        <PipelineBoard
          stages={PROSPECT_STAGES}
          groupedByStage={groupedByStage}
          onSelect={setSelectedProspect}
          onStageChange={handleStageChange}
          terminalCounts={{ converted: convertedCount, disqualified: disqualifiedCount, nurture: nurtureCount }}
          isSelected={isSelected}
          onToggleSelect={toggleSelect}
          selectionActive={selectedIds.size > 0}
          atCap={selectedIds.size >= BULK_ENROLL_CAP}
          onDiscard={setDiscardTargetProspect}
          overdueCallProspectIds={overdueCallProspectIds}
        />
      ) : viewMode === 'list' ? (
        <ListView
          prospects={visibleProspects}
          onSelect={setSelectedProspect}
          isSelected={isSelected}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          onUnselectMany={unselectMany}
          selectedCount={selectedIds.size}
          atCap={selectedIds.size >= BULK_ENROLL_CAP}
          bulkCap={BULK_ENROLL_CAP}
          onDiscard={setDiscardTargetProspect}
          overdueCallProspectIds={overdueCallProspectIds}
        />
      ) : viewMode === 'account' ? (
        <AccountView
          groups={Object.values(groupedByAccount)}
          onSelect={setSelectedProspect}
          isSelected={isSelected}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
          onUnselectMany={unselectMany}
          atCap={selectedIds.size >= BULK_ENROLL_CAP}
          onDiscard={setDiscardTargetProspect}
        />
      ) : viewMode === 'sequences' ? (
        <SequencesView prospects={prospects} search={debouncedSearch} />
      ) : viewMode === 'campaigns' ? (
        <CampaignsView />
      ) : viewMode === 'research' ? (
        <ResearchQueueView />
      ) : viewMode === 'calls' ? (
        <CallsInboxView
          scope={scope}
          search={debouncedSearch}
          onSelectProspect={(prospectId) => {
            // Open the prospect drawer at the Calls tab
            const p = prospects.find(x => x.id === prospectId);
            if (p) setSelectedProspect({ ...p, _openTab: 'calls' });
          }}
        />
      ) : (
        <ProspectingInbox
          key={draftsDeepLink ? `dl-${draftsDeepLink.campaignId}` : 'inbox'}
          scope={scope}
          search={debouncedSearch}
          initialTab={draftsDeepLink ? 'drafts' : undefined}
          initialCampaignId={draftsDeepLink?.campaignId}
          campaignName={draftsDeepLink?.campaignName}
          onBackToCampaign={draftsDeepLink ? () => { setDraftsDeepLink(null); setViewMode('campaigns'); } : undefined}
        />
      )}

      {/* ── Bulk Enroll Modal ──────────────────────────────────────────────── */}
      {showBulkEnrollModal && (
        <SequenceEnrollModal
          prospects={prospects.filter(p => selectedIds.has(p.id))}
          onEnrolled={() => {
            setShowBulkEnrollModal(false);
            clearSelection();
            fetchProspects();
          }}
          onClose={() => setShowBulkEnrollModal(false)}
        />
      )}

      {/* ── Bulk Discard Modal ─────────────────────────────────────────────── */}
      {showBulkDiscardModal && (
        <DiscardProspectModal
          prospects={prospects.filter(p => selectedIds.has(p.id))}
          onDiscarded={() => {
            setShowBulkDiscardModal(false);
            clearSelection();
            fetchProspects();
          }}
          onClose={() => setShowBulkDiscardModal(false)}
        />
      )}

      {/* ── Per-card Discard Modal (from ⋯ menu) ───────────────────────────── */}
      {discardTargetProspect && (
        <DiscardProspectModal
          prospects={[discardTargetProspect]}
          onDiscarded={() => {
            setDiscardTargetProspect(null);
            fetchProspects();
          }}
          onClose={() => setDiscardTargetProspect(null)}
        />
      )}

      {/* ── Bulk selection action bar (bottom, fixed) ─────────────────────── */}
      {/* Fixed at viewport bottom so it's always visible during selection,  */}
      {/* without needing to scroll. Hidden while a prospect detail panel is */}
      {/* open — that overlay (z-index 999) would cover it anyway.           */}
      {selectedIds.size > 0 && !selectedProspect && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: '#ecfdf5',
          borderTop: '2px solid #6ee7b7',
          padding: '10px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          zIndex: 900,
          boxShadow: '0 -4px 12px rgba(15, 157, 142, 0.12)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#065f46' }}>
            ✓ {selectedIds.size} selected
          </span>
          {selectedIds.size >= BULK_ENROLL_CAP && (
            <span style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 4 }}>
              Max {BULK_ENROLL_CAP} reached
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setShowBulkEnrollModal(true)}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none',
              background: '#0F9D8E', color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            📨 Enroll in sequence
          </button>
          {campaignFilter && (
            <button
              onClick={handleRemoveFromCampaign}
              disabled={removingCampaign}
              title={`Remove selected from "${campaignFilter.campaignName}" (does not disqualify)`}
              style={{
                padding: '7px 14px', borderRadius: 7, border: '1px solid #fed7aa',
                background: '#fff7ed', color: '#c2410c',
                fontSize: 13, fontWeight: 600, cursor: removingCampaign ? 'default' : 'pointer',
                opacity: removingCampaign ? 0.6 : 1,
              }}
            >
              {removingCampaign ? '⟳ Removing…' : '↩ Remove from campaign'}
            </button>
          )}
          <button
            onClick={() => setShowBulkDiscardModal(true)}
            style={{
              padding: '7px 14px', borderRadius: 7, border: '1px solid #fecaca',
              background: '#fef2f2', color: '#dc2626',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            🗑 Discard
          </button>
          <button
            onClick={clearSelection}
            style={{
              padding: '7px 14px', borderRadius: 7, border: '1px solid #9FE1CB',
              background: '#fff', color: '#065f46',
              fontSize: 13, cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Create Form Modal ──────────────────────────────────────────────── */}
      {showCreateForm && (
        <ProspectCreateModal
          onSave={handleCreateProspect}
          onClose={() => setShowCreateForm(false)}
        />
      )}

      {/* ── CSV Import Modal ───────────────────────────────────────────────── */}
      {showImportModal && (
        <CSVImportModal
          entity="prospects"
          onImport={handleImportProspects}
          supportsUpsert={true}
          upsertMatchLabel="LinkedIn URL"
          onClose={() => setShowImportModal(false)}
        />
      )}

      {/* ── Detail Panel ───────────────────────────────────────────────────── */}
      {selectedProspect && (
        <ProspectDetailPanel
          prospectId={selectedProspect.id || selectedProspect}
          initialTab={selectedProspect._openTab || 'overview'}
          onClose={() => setSelectedProspect(null)}
          onUpdate={fetchProspects}
        />
      )}

    </div>
    </StagesContext.Provider>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PIPELINE BOARD
// ═════════════════════════════════════════════════════════════════════════════

