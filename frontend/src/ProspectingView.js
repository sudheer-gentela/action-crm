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
  const [selectedProspect, setSelectedProspect] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  // Campaign filter — set when the user clicks "View in Pipeline" from a
  // campaign in the Campaigns tab. Holds { campaignId, campaignName } or null.
  // When active, the Pipeline/List/Account boards are scoped to that campaign
  // and a dismissible banner is shown.
  const [campaignFilter, setCampaignFilter] = useState(null);

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

  // Clear selection when the user switches views or changes the search query.
  // Prevents stale selections (prospect might be filtered out of the current
  // view) from lingering invisibly and confusing the rep.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [viewMode, searchQuery, scope]);

  const handleImportProspects = async (rows) => {
    const res = await apiFetch('/prospects/bulk', {
      method: 'POST',
      body: JSON.stringify({ prospects: rows, source: 'csv_import' }),
    });
    fetchProspects();
    return res; // { imported, skipped, errors }
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
        apiFetch(`/prospects?scope=${scope}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ''}${campaignQS}`),
        apiFetch(`/prospects/pipeline/summary?scope=${scope}`),
      ]);

      setProspects(prospectsRes.prospects || []);
      setPipelineSummary(summaryRes);
    } catch (err) {
      console.error('Failed to fetch prospects:', err);
    } finally {
      setLoading(false);
    }
  }, [scope, searchQuery, campaignFilter]);

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

  // ── Group by account for account view ──────────────────────────────────────

  const groupedByAccount = {};
  prospects.forEach(p => {
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

  // LinkedIn funnel metrics (computed from channel_data on loaded prospects)
  const liMetrics = React.useMemo(() => {
    const sent      = prospects.filter(p => p.channel_data?.linkedin?.connection_status).length;
    const connected = prospects.filter(p => ['connected','message_sent','replied'].includes(p.channel_data?.linkedin?.connection_status)).length;
    const messaged  = prospects.filter(p => ['message_sent','replied'].includes(p.channel_data?.linkedin?.connection_status)).length;
    const replied   = prospects.filter(p => p.channel_data?.linkedin?.connection_status === 'replied').length;
    const acceptRate = sent > 0 ? Math.round((connected / sent) * 100) : null;
    const replyRate  = messaged > 0 ? Math.round((replied / messaged) * 100) : null;
    return { sent, connected, messaged, replied, acceptRate, replyRate };
  }, [prospects]);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

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

          <button className="pv-btn-secondary" onClick={() => setShowImportModal(true)}>
            ⬆ Import CSV
          </button>

          <button className="pv-add-btn" onClick={() => setShowCreateForm(true)}>
            + Add Prospect
          </button>
        </div>
      </div>

      {/* ── Metrics Bar ────────────────────────────────────────────────────── */}
      <div className="pv-metrics-bar">
        <div className="pv-metric">
          <span className="pv-metric-value">{totalActive}</span>
          <span className="pv-metric-label">Active</span>
        </div>
        {PROSPECT_STAGES.map(s => {
          const count = (groupedByStage[s.key] || []).length;
          return (
            <div className="pv-metric" key={s.key}>
              <span className="pv-metric-value" style={{ color: s.color }}>{count}</span>
              <span className="pv-metric-label">{s.label}</span>
            </div>
          );
        })}
        <div className="pv-metric-separator" />
        <div className="pv-metric">
          <span className="pv-metric-value" style={{ color: '#059669' }}>{convertedCount}</span>
          <span className="pv-metric-label">Converted</span>
        </div>
        <div className="pv-metric">
          <span className="pv-metric-value" style={{ color: '#f59e0b' }}>
            {pipelineSummary.metrics?.outreachThisWeek || 0}
          </span>
          <span className="pv-metric-label">Outreach / wk</span>
        </div>
        <div className="pv-metric">
          <span className="pv-metric-value" style={{ color: TEAL }}>
            {pipelineSummary.metrics?.responsesThisWeek || 0}
          </span>
          <span className="pv-metric-label">Responses / wk</span>
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
      {campaignFilter && ['pipeline', 'list', 'account'].includes(viewMode) && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#fff8f0', border: '1px solid #FBCF9D', borderRadius: 8,
          padding: '8px 14px', marginBottom: 12, fontSize: 13,
        }}>
          <span style={{ color: '#92400e' }}>
            🚀 Showing prospects in campaign:{' '}
            <strong>{campaignFilter.campaignName}</strong>
          </span>
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
          prospects={prospects}
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
        <SequencesView prospects={prospects} />
      ) : viewMode === 'campaigns' ? (
        <CampaignsView />
      ) : viewMode === 'research' ? (
        <ResearchQueueView />
      ) : viewMode === 'calls' ? (
        <CallsInboxView
          scope={scope}
          onSelectProspect={(prospectId) => {
            // Open the prospect drawer at the Calls tab
            const p = prospects.find(x => x.id === prospectId);
            if (p) setSelectedProspect({ ...p, _openTab: 'calls' });
          }}
        />
      ) : (
        <ProspectingInbox scope={scope} />
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

