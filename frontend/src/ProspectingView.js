// ProspectingView.js — top-level orchestrator for the Prospecting feature.
//
// As of the 2026 module split, the individual views, panels, and modals live
// in ./prospecting/*. This file keeps ONLY the ProspectingView component, which
// owns shared state (prospects, scope, selection) and routes between views.
// Shared helpers/constants/context now live in ./prospecting/prospectingShared.

import React, { useState, useEffect, useCallback, useRef } from 'react';

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
import { useCustomFieldColumns, useSelectedColumns, CustomFieldColumnPicker } from './customfields/customFieldColumns';
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

// ── URL-hash sub-navigation ──────────────────────────────────────────────────
// App.js owns the FIRST hash segment (#/prospecting). This view owns the
// SECOND (#/prospecting/campaigns), so a browser refresh restores not just
// the Prospecting module but the sub-view the rep was on. The THIRD segment
// (a campaign id, #/prospecting/campaigns/14) is owned by CampaignsView.
// Each owner reads its own segment on mount and rewrites the hash only when
// ITS segment changes — never touching segments it doesn't own.
const PV_HASH_MODES = ['pipeline', 'list', 'account', 'campaigns', 'research', 'inbox', 'sequences', 'calls'];

// Sub-views where the GLOBAL prospect-pool strips (stage pills + LinkedIn
// funnel banner) are hidden — these views are about a different entity
// (campaigns, sequences, calls, research queue) and render their own
// aggregates instead.
const GLOBAL_STRIPS_HIDDEN_MODES = ['campaigns', 'sequences', 'calls', 'research', 'inbox'];

function hashSegment(n) {
  const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/');
  const seg = parts[n];
  return seg ? seg.toLowerCase() : null;
}

export default function ProspectingView() {
  const [prospects, setProspects] = useState([]);
  const [pipelineSummary, setPipelineSummary] = useState({ pipeline: [], metrics: {} });
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('mine');
  // Scope capabilities (server-authoritative). The localStorage user does NOT
  // carry subordinateIds, so the toggle must be gated on this, not on the user.
  const [scopeCaps, setScopeCaps] = useState({ hasSubordinates: false, isAdmin: false });
  // pipeline | list | account | campaigns | research | inbox | sequences | calls
  // Restored from the hash's second segment on mount (refresh-survival);
  // 'pipeline' is the default and is represented by NO second segment.
  const [viewMode, setViewMode] = useState(() => {
    if (hashSegment(0) === 'prospecting') {
      const m = hashSegment(1);
      if (m && PV_HASH_MODES.includes(m)) return m;
    }
    return 'pipeline';
  });
  const [searchQuery, setSearchQuery] = useState('');

  // Write the second hash segment when the sub-view changes. Guard: only
  // while the tab segment is ours (App.js owns tab switches), and skip the
  // write when the segment already matches — that's what preserves a
  // deeper campaign-id segment written by CampaignsView. Changing the
  // sub-view intentionally resets the deeper segments (the drawer unmounts
  // with the view anyway).
  useEffect(() => {
    if (hashSegment(0) !== 'prospecting') return;
    const seg1 = hashSegment(1);
    // A numeric segment-1 is a prospect id under the default pipeline
    // mode (#/prospecting/321) — owned by the prospect-drawer effect,
    // not a mode mismatch. Treat it as "no mode segment".
    const seg1Mode = seg1 && !/^\d+$/.test(seg1) ? seg1 : null;
    const want = viewMode === 'pipeline' ? null : viewMode;
    if (seg1Mode === want) return;
    window.history.replaceState(null, '', want ? `#/prospecting/${want}` : '#/prospecting');
  }, [viewMode]);
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
  // Prospect id from the URL hash awaiting the prospects load
  // (refresh-survival). Hash shape: #/prospecting[/<mode>]/<id> — the
  // numeric segment sits right after the mode (or right after
  // 'prospecting' for the default pipeline mode). NOT used in campaigns
  // mode, where the numeric segment is a campaign id owned by
  // CampaignsView.
  const [pendingHashProspectId, setPendingHashProspectId] = useState(() => {
    const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0]?.toLowerCase() !== 'prospecting') return null;
    if (parts[1]?.toLowerCase() === 'campaigns') return null;
    // id is parts[1] (pipeline default) or parts[2] (explicit mode)
    const candidate = PV_HASH_MODES.includes(parts[1]?.toLowerCase()) ? parts[2] : parts[1];
    const id = parseInt(candidate, 10);
    return Number.isInteger(id) && id > 0 && String(id) === candidate ? id : null;
  });

  // Guards the one-shot id-fetch fallback so it fires at most one request
  // even if the effect re-runs while that request is in flight (loading
  // toggles on every refetch). pendingHashProspectId is itself one-shot
  // (set once on mount, never re-set), so this never needs resetting.
  const fallbackProspectFetched = useRef(false);

  // Restore the prospect drawer for a deep-linked id (#/prospecting/<id>,
  // e.g. the extension's "Open in GoWarmCRM" link). Two paths, one-shot:
  //
  //   Fast path — the id is in the loaded list (the rep's own in-scope
  //   pipeline): open that row directly. No extra request; unchanged from
  //   before.
  //
  //   Fallback — the id is valid but NOT in the loaded set (owned by a
  //   subordinate while scope='mine', filtered out, or paginated away, or
  //   the list legitimately came back empty): confirm it's accessible in
  //   this org via GET /prospects/:id, then open the drawer with a minimal
  //   { id }. The drawer (ProspectDetailPanel) self-fetches full detail by
  //   id, so it only needs the id — it does NOT depend on the list-row
  //   shape. A cross-org / deleted id 404s here and is dropped silently;
  //   the hash-mirror effect below then trims the stale segment.
  //
  // Gated on `loading` (not prospects.length) so an out-of-scope id still
  // resolves when the in-scope list comes back empty.
  useEffect(() => {
    if (!pendingHashProspectId || loading) return;

    const wantedId = pendingHashProspectId;
    const target   = prospects.find(pr => pr.id === wantedId);
    if (target) {
      setSelectedProspect(target);
      setPendingHashProspectId(null);
      return;
    }

    if (fallbackProspectFetched.current) return; // already attempted the fetch
    fallbackProspectFetched.current = true;

    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/prospects/${wantedId}`);
        if (!cancelled && res?.prospect?.id) {
          // Minimal object — the drawer loads everything else by id.
          setSelectedProspect({ id: res.prospect.id });
        }
      } catch (_) {
        // Not found / not permitted in this org — fall back to the list.
      } finally {
        if (!cancelled) setPendingHashProspectId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [pendingHashProspectId, prospects, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror the open prospect into the hash. Skipped in campaigns mode
  // (numeric segment there belongs to CampaignsView).
  useEffect(() => {
    if (hashSegment(0) !== 'prospecting' || viewMode === 'campaigns') return;
    if (pendingHashProspectId) return;
    const base = viewMode === 'pipeline' ? ['prospecting'] : ['prospecting', viewMode];
    const parts = (window.location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    const desired = '#/' + base.concat(selectedProspect?.id ? [String(selectedProspect.id)] : []).join('/');
    if (('#/' + parts.join('/')) !== desired) {
      window.history.replaceState(null, '', desired);
    }
  }, [selectedProspect, viewMode, pendingHashProspectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  // Campaign filter — set when the user clicks "View in Pipeline" from a
  // campaign in the Campaigns tab. Holds { campaignId, campaignName } or null.
  // When active, the Pipeline/List/Account boards are scoped to that campaign
  // and a dismissible banner is shown.
  const [campaignFilter, setCampaignFilter] = useState(null);

  // Set when a campaign filter targets a campaign the user isn't allowed to
  // view (server returns 403). Drives a visible empty-state message instead of
  // a silent failure. Cleared at the start of every prospects fetch.
  const [campaignAccessError, setCampaignAccessError] = useState(null);

  // Drafts deep-link context, set when arriving from a campaign's "Preview
  // drafts". { campaignId, campaignName } | null.
  const [draftsDeepLink, setDraftsDeepLink] = useState(null);

  // Slice 5: list of active campaigns the user can switch between from the
  // filter banner. Loaded at the board's current scope (so a manager in Team
  // scope sees subordinates' active campaigns too) and reloaded on scope
  // change. Without the scope match, a subordinate's active campaign would be
  // absent here and the banner would mislabel it as "(not active)".
  const [activeCampaigns, setActiveCampaigns] = useState([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/prospecting-campaigns?status=active&scope=${scope}`);
        if (!cancelled) setActiveCampaigns(r.campaigns || []);
      } catch (_) {
        if (!cancelled) setActiveCampaigns([]);
      }
    })();
    return () => { cancelled = true; };
  }, [scope]);

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
  // Bulk "Move to ▾" stage control (context-aware forward progression).
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [movingStage, setMovingStage]   = useState(false);
  // Sequence to pre-select when "Move to → Outreach" opens the enroll preview
  // (the campaign's own default sequence, so it's one click inside a campaign).
  const [enrollPreSeqId, setEnrollPreSeqId] = useState(null);
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
      setCampaignFilter({ campaignId: detail.campaignId, campaignName: detail.campaignName, defaultSequenceId: detail.defaultSequenceId ?? null });
      if (detail.scope) setScope(detail.scope);
      setCampaignAccessError(null);
      setViewMode('pipeline');
    }
    window.addEventListener('campaign-filter', onCampaignFilter);
    return () => window.removeEventListener('campaign-filter', onCampaignFilter);
  }, []);

  // Reverse of the campaign-filter bridge: reopen the campaign drawer the rep
  // came from. Set the hash first so CampaignsView's mount initializer reads
  // the campaign id and opens that drawer; then switch to the Campaigns view.
  // The viewMode hash-sync effect leaves the id intact because segment-1
  // already matches 'campaigns'. campaignFilter is left set so returning to
  // the pipeline keeps the same scope.
  const backToCampaign = () => {
    if (!campaignFilter?.campaignId) return;
    window.location.hash = `#/prospecting/campaigns/${campaignFilter.campaignId}`;
    setViewMode('campaigns');
  };

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

  // ── Bulk stage movement (context-aware) ──────────────────────────────────
  // The "Move to" menu only makes sense when the whole selection sits in ONE
  // stage, because the valid forward targets depend on where each prospect
  // currently is. Mixed-stage selections disable the control.
  const selectedProspects = prospects.filter(p => selectedIds.has(p.id));
  const selectedStages = [...new Set(selectedProspects.map(p => p.stage).filter(Boolean))];
  const selectionStage = selectedStages.length === 1 ? selectedStages[0] : null;

  // ── Bulk activation eligibility ──────────────────────────────────────────
  // bulk-activate is campaign-scoped (enrolls into that campaign's default
  // sequence) and only accepts research-stage prospects, so "Activate selected"
  // is offered only when the whole selection sits in ONE campaign and is all in
  // research. Derived from the selected prospects themselves, not the filter,
  // so it's correct even when the pipeline isn't campaign-filtered.
  const selectedCampaignIds = [...new Set(selectedProspects.map(p => p.campaign_id).filter(Boolean))];
  const selectionCampaignId = selectedCampaignIds.length === 1 ? selectedCampaignIds[0] : null;
  const allResearchSelected = selectedProspects.length > 0 && selectedProspects.every(p => p.stage === 'research');
  const canActivateSelected = !!selectionCampaignId && allResearchSelected;
  const activateSelectedReason = canActivateSelected
    ? `Activate ${selectedIds.size} selected — enroll in the campaign's default sequence`
    : !allResearchSelected
      ? 'Select research-stage prospects to activate'
      : selectedCampaignIds.length > 1
        ? 'Selected prospects span multiple campaigns — select one campaign\u2019s prospects'
        : 'Selected prospects aren\u2019t in a campaign';

  // Forward targets for the selection's current stage, using the org's
  // configured pipeline order. Entering "outreach" is special: it starts real
  // outreach, so it's routed through the enroll PREVIEW rather than a silent
  // stage write. From "target" we also offer the skip-research jump straight
  // to outreach.
  const stageOrder = PROSPECT_STAGES.map(s => s.key);
  const forwardStageOptions = (() => {
    if (!selectionStage) return [];
    const idx = stageOrder.indexOf(selectionStage);
    if (idx < 0) return [];
    const opts = [];
    const next = stageOrder[idx + 1];
    if (next) opts.push(next);
    if (selectionStage === 'target' && stageOrder.includes('outreach') && !opts.includes('outreach')) {
      opts.push('outreach');
    }
    return opts;
  })();
  const stageLabel = (key) => PROSPECT_STAGES.find(s => s.key === key)?.label || key;

  // Move the current selection to a stage. "outreach" opens the enroll preview
  // (nothing fires without an explicit confirm); everything else is a plain
  // stage write via /prospects/bulk-stage.
  const handleBulkStageMove = async (toStage) => {
    if (!selectionStage || selectedIds.size === 0) return;
    setShowMoveMenu(false);
    if (toStage === 'outreach') {
      setEnrollPreSeqId(campaignFilter?.defaultSequenceId ?? null);
      setShowBulkEnrollModal(true);
      return;
    }
    setMovingStage(true);
    try {
      await apiFetch('/prospects/bulk-stage', {
        method: 'POST',
        body: JSON.stringify({
          fromStage: selectionStage,
          toStage,
          prospectIds: [...selectedIds],
          campaignId: campaignFilter?.campaignId ?? null,
        }),
      });
      clearSelection();
      fetchProspects();
    } catch (err) {
      alert(`Move failed: ${err.message}`);
    } finally {
      setMovingStage(false);
    }
  };

  // ── Activation (single + bulk) ────────────────────────────────────────────
  // Both paths POST to the campaign-scoped bulk-activate endpoint with an
  // explicit prospectIds list — the backend validates that each is in the
  // campaign, in research stage, and not already enrolled, then enrolls them
  // in the campaign's default sequence (runSkill omitted → defaults to the
  // sequence's AI setting). Returns { activated, skipped, warning, sequenceName }.
  const [activating, setActivating] = useState(false);

  const activateProspectIds = async (campaignId, ids) => {
    const res = await apiFetch(`/prospecting-campaigns/${campaignId}/bulk-activate`, {
      method: 'POST',
      body: JSON.stringify({ prospectIds: ids }),
    });
    if (!res.activated) {
      // Nothing enrolled — surface the backend's reason rather than "Activated 0".
      alert(res.message || 'No prospects were activated — they may already be enrolled or not in the research stage.');
      return res;
    }
    const parts = [`Activated ${res.activated} prospect${res.activated === 1 ? '' : 's'}` +
      (res.sequenceName ? ` in "${res.sequenceName}"` : '')];
    if (Array.isArray(res.skipped) && res.skipped.length) {
      parts.push(`${res.skipped.length} skipped`);
    }
    if (res.warning?.message) parts.push(res.warning.message);
    alert(parts.join('\n'));
    return res;
  };

  // Single-prospect activation from the row menu. Guarded by the menu (only
  // shown for research-stage prospects in a campaign), but we re-check here so
  // a stale row can't fire an invalid request.
  const handleSingleActivate = async (prospect) => {
    if (!prospect?.campaign_id || prospect.stage !== 'research') {
      alert('This prospect must be in a campaign and in the research stage to activate.');
      return;
    }
    if (activating) return;
    setActivating(true);
    try {
      await activateProspectIds(prospect.campaign_id, [prospect.id]);
      fetchProspects();
    } catch (err) {
      alert(`Activation failed: ${err.message}`);
    } finally {
      setActivating(false);
    }
  };

  // Bulk activation of the current selection. Enabled only when the selection
  // is one campaign + all research (see canActivateSelected).
  const handleBulkActivate = async () => {
    if (!canActivateSelected || selectedIds.size === 0 || activating) return;
    const ids = [...selectedIds];
    const ok = window.confirm(
      `Activate ${ids.length} prospect${ids.length === 1 ? '' : 's'}? ` +
      `They'll be enrolled in the campaign's default sequence and Step 1 will be drafted.`
    );
    if (!ok) return;
    setActivating(true);
    try {
      await activateProspectIds(selectionCampaignId, ids);
      clearSelection();
      fetchProspects();
    } catch (err) {
      alert(`Activation failed: ${err.message}`);
    } finally {
      setActivating(false);
    }
  };

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

  // Scope capabilities from the server — decides whether Team/Org are offered.
  useEffect(() => {
    apiFetch('/prospecting-campaigns/me/context')
      .then(c => setScopeCaps({ hasSubordinates: !!c?.hasSubordinates, isAdmin: !!c?.isAdmin }))
      .catch(() => { /* keep defaults; only "My Prospects" shown */ });
  }, []);

  // Scope options are server-authoritative. Never infer from the localStorage
  // user (it doesn't carry subordinateIds, so reports/managers would be hidden).
  const canTeam = scopeCaps.hasSubordinates;
  const canOrg  = scopeCaps.isAdmin;
  const hasTeam = canTeam || canOrg;

  // ── Data fetching ──────────────────────────────────────────────────────────

  // Monotonic request counter — guards against out-of-order responses when
  // scope/search/campaign change while a fetch is still in flight (an older
  // response must never overwrite a newer one).
  const fetchSeq = useRef(0);

  const fetchProspects = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      setLoading(true);
      setCampaignAccessError(null);

      const campaignQS = campaignFilter ? `&campaignId=${campaignFilter.campaignId}` : '';

      const [prospectsRes, summaryRes] = await Promise.all([
        apiFetch(`/prospects?scope=${scope}${debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : ''}${campaignQS}`),
        apiFetch(`/prospects/pipeline/summary?scope=${scope}${campaignQS}`),
      ]);

      if (seq !== fetchSeq.current) return; // stale response — a newer fetch superseded this one

      setProspects(prospectsRes.prospects || []);
      setPipelineSummary(summaryRes);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      console.error('Failed to fetch prospects:', err);
      if (err?.status === 403 && campaignFilter) {
        // Filtered to a campaign this user isn't allowed to see — surface a
        // clear message instead of failing silently, and empty the board.
        setProspects([]);
        setPipelineSummary({ pipeline: [], metrics: {} });
        setCampaignAccessError(
          err.message || "You don't have permission to view this campaign's prospects."
        );
      }
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
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

  // ── Custom-field columns for the list view (durable values) ────────────────
  const cfEntityIds = visibleProspects.map(p => p.id);
  const { defs: cfDefs, byEntity: cfByEntity } = useCustomFieldColumns({
    entityType: 'prospect', entityIds: cfEntityIds,
  });
  const [cfCols, setCfCols] = useSelectedColumns('prospect');
  const prospectCustomColumns = { keys: cfCols, defs: cfDefs, byEntity: cfByEntity };

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
  // Status vocabulary matches what the backend writes (sequences.routes.js
  // and prospects.routes.js): the canonical ladder is
  //   connection_request_sent → connection_accepted → message_sent
  //   → reply_received → meeting_booked
  //
  // "connected" is counted from linkedin.connected_at, NOT from the status
  // pointer. The sequence step firer can push a prospect straight to
  // 'message_sent' on schedule without an acceptance ever happening; a
  // status-pointer count (status ∈ {connection_accepted, message_sent, …})
  // would report those leapfroggers as connected. connected_at is set ONLY by
  // a real connection_accepted event, so it can't be inflated that way.
  // messaged/replied likewise key off their own timestamps/counters rather
  // than the single status pointer.
  const liMetrics = React.useMemo(() => {
    const li = p => p.channel_data?.linkedin || {};
    const sent      = prospects.filter(p => li(p).connection_status || li(p).request_sent_at).length;
    const connected = prospects.filter(p => li(p).connected_at).length;
    const messaged  = prospects.filter(p => li(p).last_message_at || (li(p).message_count || 0) > 0).length;
    const replied   = prospects.filter(p => li(p).last_reply_at || (li(p).reply_count || 0) > 0 || li(p).connection_status === 'reply_received').length;
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
              {['mine', 'team', 'org']
                .filter(s => s === 'mine' || (s === 'team' && canTeam) || (s === 'org' && canOrg))
                .map(s => (
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

          {(viewMode === 'list') && (
            <CustomFieldColumnPicker
              entityType="prospect"
              entityIds={cfEntityIds}
              selected={cfCols}
              onChange={setCfCols}
            />
          )}

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

      {/* ── Metrics Bar (clickable stage chips + performance group) ───────────
          Hidden in entity-focused modes: these are GLOBAL prospect-pool
          numbers (all stages, all campaigns), which read as wrong context
          above a campaign / sequence / call / research list — those views
          show their own aggregates instead. */}
      <div className="pv-metrics-bar" style={{ gap: 8, display: GLOBAL_STRIPS_HIDDEN_MODES.includes(viewMode) ? 'none' : undefined }}>
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

      {/* ── LinkedIn Funnel Strip ───────────────────────────────────────────
          Also global-scope (all prospects, all campaigns) — hidden in the
          same entity-focused modes as the metrics bar above. */}
      {!GLOBAL_STRIPS_HIDDEN_MODES.includes(viewMode) && liMetrics.sent > 0 && (
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
                  defaultSequenceId: next?.default_sequence_id ?? null,
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <button
              onClick={backToCampaign}
              title={`Back to "${campaignFilter.campaignName}" campaign`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: '#fff', border: '1px solid #FBCF9D', borderRadius: 5,
                cursor: 'pointer', color: '#9a3412', fontSize: 13, fontWeight: 600,
                padding: '4px 10px',
              }}
            >← Back to campaign</button>
            <button
              onClick={() => setCampaignFilter(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#92400e', fontSize: 13, fontWeight: 600,
              }}
            >✕ Clear filter</button>
          </div>
        </div>
      )}

      {campaignAccessError && ['pipeline', 'list', 'account'].includes(viewMode) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8,
          padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#b91c1c',
        }}>
          <span>⚠</span>
          <span>{campaignAccessError} Use “Clear filter” above to return to your prospects.</span>
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
          onActivate={handleSingleActivate}
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
          onActivate={handleSingleActivate}
          overdueCallProspectIds={overdueCallProspectIds}
          customColumns={prospectCustomColumns}
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
        <CampaignsView scope={scope} onScopeChange={setScope} />
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
          onScopeChange={setScope}
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
          preSequenceId={enrollPreSeqId}
          onEnrolled={() => {
            setShowBulkEnrollModal(false);
            setEnrollPreSeqId(null);
            clearSelection();
            fetchProspects();
          }}
          onClose={() => { setShowBulkEnrollModal(false); setEnrollPreSeqId(null); }}
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
          {/* Activate selected — enrolls the selection into its campaign's
              default sequence. Enabled only for a single-campaign, all-research
              selection (see canActivateSelected). */}
          <button
            onClick={handleBulkActivate}
            disabled={!canActivateSelected || activating}
            title={activateSelectedReason}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none',
              background: (!canActivateSelected || activating) ? '#9ca3af' : '#0F9D8E',
              color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: (!canActivateSelected || activating) ? 'default' : 'pointer',
            }}
          >
            {activating ? '⟳ Activating…' : `⚡ Activate ${selectedIds.size} selected`}
          </button>
          {/* Context-aware stage movement. Disabled when the selection spans
              multiple stages (valid targets differ per stage) or there's no
              forward stage. "Outreach" routes through the enroll preview so
              nothing fires without an explicit confirm. */}
          {showMoveMenu && (
            <div
              onClick={() => setShowMoveMenu(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 940 }}
            />
          )}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowMoveMenu(v => !v)}
              disabled={movingStage || !selectionStage || forwardStageOptions.length === 0}
              title={
                !selectionStage
                  ? 'Select prospects in the same stage to move them'
                  : forwardStageOptions.length === 0
                    ? 'No forward stage available from here'
                    : `Move selected from ${stageLabel(selectionStage)}`
              }
              style={{
                padding: '7px 16px', borderRadius: 7, border: 'none',
                background: (movingStage || !selectionStage || forwardStageOptions.length === 0) ? '#9ca3af' : '#0F9D8E',
                color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: (movingStage || !selectionStage || forwardStageOptions.length === 0) ? 'default' : 'pointer',
              }}
            >
              {movingStage ? '⟳ Moving…' : '➡ Move to ▾'}
            </button>
            {showMoveMenu && selectionStage && forwardStageOptions.length > 0 && (
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, marginBottom: 6,
                background: '#fff', border: '1px solid #e2e4ea', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.16)', overflow: 'hidden',
                minWidth: 220, zIndex: 950,
              }}>
                {forwardStageOptions.map(key => (
                  <button
                    key={key}
                    onClick={() => handleBulkStageMove(key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '10px 14px', border: 'none', background: '#fff',
                      color: '#111827', fontSize: 13, textAlign: 'left', cursor: 'pointer',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    <span>{stageLabel(key)}</span>
                    {key === 'outreach' && (
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: '#92400e', background: '#fef3c7', padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}>
                        starts outreach · preview
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
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

