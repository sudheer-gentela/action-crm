// ProspectDetailPanel.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect, useCallback } from 'react';
import { useStages, CHANNEL_ICONS, LI_EVENTS, getLiStatus, getLiDotColor, apiFetch, API, formatDate, timeAgo, readDebugFlag } from './prospectingShared';
import CallsPanel from './CallsPanel';
import DiscardProspectModal from './DiscardProspectModal';
import DraftCard from './DraftCard';
import EntityIdHint from '../EntityIdHint';
import InfoRow from './InfoRow';
import LogCallModal from './LogCallModal';
import OutreachComposer from '../OutreachComposer';
import OutreachSkillPanel from './OutreachSkillPanel';
import StrapPanel from '../StrapPanel';
import SequenceEnrollModal from '../SequenceEnrollModal';
import TwilioCallModal from '../TwilioCallModal';

function ProspectDetailPanel({ prospectId, initialTab, onClose, onUpdate }) {
  const { allStages, prospectStages } = useStages();
  const [prospect, setProspect] = useState(null);
  const [actions, setActions] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(initialTab || 'overview');
  const [editMode, setEditMode]   = useState(false);
  const [editForm, setEditForm]   = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError]   = useState(null);
  const [showStageMenu, setShowStageMenu] = useState(false);
  const [showOutreach, setShowOutreach] = useState(false);
  const [outreachChannel, setOutreachChannel] = useState(null);
  const [outreachAction, setOutreachAction] = useState(null);
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [activeEnrollment, setActiveEnrollment] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [contextData, setContextData] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [showDiscardModal, setShowDiscardModal] = useState(false);

  // ── Call logging state ───────────────────────────────────────────────────
  // showLogCallModal toggles the modal. `calls` is the list of past calls
  // for this prospect, loaded on mount and refreshed after each save. The
  // outcomes-list config is loaded once into `callSettings` so the modal
  // can render the dropdown with the org's customized labels.
  const [showLogCallModal, setShowLogCallModal] = useState(false);
  // Phase 2: when the LogCallModal is opened from a sequence step (via
  // "Log call & complete" on a draft card), we pass through the step log id
  // and task note so the modal can pre-fill and the backend can advance
  // the sequence on save. null means "manual log call" — no sequence context.
// ── Twilio click-to-dial state ───────────────────────────────────────────
  // activeTwilioCallId is the calls.id of an in-progress Twilio call. When
  // set, TwilioCallModal renders. When the call reaches status='completed',
  // it hands off to LogCallModal pre-filled with duration_seconds.
  const [activeTwilioCallId,       setActiveTwilioCallId]       = useState(null);
  // editingTwilioCallId is the calls.id of an EXISTING (terminal) call row
  // whose outcome was never captured. When set, LogCallModal opens in edit
  // mode and PATCHes that row instead of POSTing a new call.
  const [editingTwilioCallId,      setEditingTwilioCallId]      = useState(null);
  const [prefilledCallDurationSec, setPrefilledCallDurationSec] = useState(null);
  const [isInitiatingTwilio,       setIsInitiatingTwilio]       = useState(false);

  const [callModalSequenceContext, setCallModalSequenceContext] = useState(null);
  const [calls,            setCalls]            = useState([]);
  const [callSettings,     setCallSettings]     = useState(null);
  const refreshCalls = async () => {
    if (!prospect?.id) return;
    try {
      const r = await apiFetch(`/prospect-calls?prospect_id=${prospect.id}`);
      setCalls(r.calls || []);
    } catch (err) {
      // Non-fatal: the rest of the drawer still works
      console.warn('Refresh calls failed:', err.message);
    }
  };

  // ── Initiate a Twilio call ───────────────────────────────────────────────
  // Calls POST /prospect-calls/initiate. On success, sets activeTwilioCallId
  // which causes TwilioCallModal to render and start polling.
  //
  // We use a raw fetch here (not apiFetch) so we can read both the error
  // message AND the error.code from the backend — apiFetch flattens errors
  // into Error(message). The code lets us render specific CTAs for each
  // failure mode (REP_PHONE_MISSING → open prefs, REP_DID_MISSING → admin
  // notified, etc.).
  const initiateTwilioCall = async () => {
    if (isInitiatingTwilio || !prospect?.id) return;
    setIsInitiatingTwilio(true);
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('authToken');
      const r = await fetch(`${API}/prospect-calls/initiate`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${token}`,
        },
        body: JSON.stringify({ prospect_id: prospect.id }),
      });
      const body = await r.json().catch(() => ({}));

      if (!r.ok) {
        const code = body?.error?.code;
        const msg  = body?.error?.message || 'Failed to start call';
        if (code === 'REP_PHONE_MISSING') {
          alert("Add your phone number in My Preferences before making calls.");
        } else if (code === 'REP_DID_MISSING') {
          alert("Your admin needs to provision a Twilio phone number for you. They've been notified.");
        } else if (code === 'PROSPECT_PHONE_MISSING') {
          alert("This prospect has no phone number on file.");
        } else if (code === 'USER_RATE_LIMIT' || code === 'ORG_RATE_LIMIT') {
          alert(msg);
        } else if (code === 'TWILIO_NOT_CONFIGURED') {
          alert("Twilio is not set up on this deployment. Contact support.");
        } else if (code === 'TWILIO_21219') {
          alert("Trial account: this prospect's phone must be verified in the Twilio console first.");
        } else {
          alert(msg);
        }
        return;
      }

      setActiveTwilioCallId(body.call.id);
    } catch (err) {
      alert(err.message || 'Failed to start call');
    } finally {
      setIsInitiatingTwilio(false);
    }
  };
  useEffect(() => {
    if (!prospect?.id) return;
    refreshCalls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospect?.id]);
  useEffect(() => {
    // Settings are org-wide so load once. Falling back to null leaves the
    // modal in a loading state until this resolves.
    (async () => {
      try {
        const r = await apiFetch('/org/call-settings');
        setCallSettings(r.settings || null);
      } catch (err) {
        console.warn('Load call settings failed:', err.message);
      }
    })();
  }, []);

  // Debug mode for showing DB IDs. Read directly from localStorage so the
  // drawer picks up the current value at render time. The keyboard
  // shortcut (Ctrl+Shift+D / Cmd+Shift+D) and toast feedback are owned
  // by the top-level ProspectingView component — see useEffect there.
  // We re-read on every render via a window-storage subscription below.
  const [debugMode, setDebugMode] = useState(() => readDebugFlag());
  useEffect(() => {
    // The toggle is dispatched as a custom 'gowarm-debug-changed' event by
    // the top-level handler. We listen here so an open drawer updates
    // immediately on toggle without waiting for a re-render trigger.
    function onChanged(e) { setDebugMode(!!e.detail); }
    window.addEventListener('gowarm-debug-changed', onChanged);
    return () => window.removeEventListener('gowarm-debug-changed', onChanged);
  }, []);


  // Drafts for this prospect (pinned in Activity tab)
  const [prospectDrafts,        setProspectDrafts]        = useState([]);
  const [prospectDraftEdits,    setProspectDraftEdits]    = useState({});
  const [loadingProspectDrafts, setLoadingProspectDrafts] = useState(false);

  // Track which DraftCards have the personalize drawer open. We widen the
  // side panel whenever any card has its drawer open.
  const [openDrawers, setOpenDrawers] = useState({}); // { [draftId]: true }
  const anyDrawerOpen = Object.values(openDrawers).some(Boolean);

  const loadProspectDrafts = useCallback(async () => {
    setLoadingProspectDrafts(true);
    try {
      const r = await apiFetch(`/sequences/drafts?prospectId=${prospectId}`);
      setProspectDrafts(r.drafts || []);
    } catch (err) {
      console.error('Failed to load prospect drafts:', err);
    } finally {
      setLoadingProspectDrafts(false);
    }
  }, [prospectId]);

  const handleConvertAndSendProspectDraft = async (draft) => {
    const edit = prospectDraftEdits[draft.id] || {};
    const subject = edit.subject !== undefined ? edit.subject : draft.subject;
    if (!subject) {
      setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], error: 'Please enter a subject line before sending.' } }));
      return;
    }
    setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      await apiFetch(`/sequences/drafts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ channel: 'email', subject }),
      });
      await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      setProspectDrafts(prev => prev.filter(d => d.id !== draft.id));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleSendProspectDraft = async (draft) => {
    if (draft.channel && draft.channel !== 'email') { console.error(`handleSendProspectDraft called on ${draft.channel} draft — blocked`); return; }
    const edit = prospectDraftEdits[draft.id] || {};
    setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      if (edit.subject !== undefined || edit.body !== undefined) {
        await apiFetch(`/sequences/drafts/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            subject: edit.subject !== undefined ? edit.subject : draft.subject,
            body:    edit.body    !== undefined ? edit.body    : draft.body,
          }),
        });
      }
      const sendRes = await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      if (sendRes && sendRes.emailSent === false && sendRes.sendError) {
        setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: sendRes.sendError } }));
        return;
      }
      setProspectDrafts(prev => prev.filter(d => d.id !== draft.id));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
      // Refresh activity feed to show the sent step
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleDiscardProspectDraft = async (draftId) => {
    if (!window.confirm('Discard this draft? The step will be skipped and the sequence will advance.')) return;
    try {
      await apiFetch(`/sequences/drafts/${draftId}`, { method: 'DELETE' });
      setProspectDrafts(prev => prev.filter(d => d.id !== draftId));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
      // Refresh activities to show skipped step
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      console.error('Failed to discard draft:', err);
    }
  };

  // Slice 4: Stop-and-undo the whole enrollment. Distinct from discarding a
  // single draft — this stops the entire sequence enrollment, discards ALL
  // unsent drafts (this one plus any future steps), and reverts the prospect's
  // stage from 'outreach' back to 'research' (or 'target' if no research_notes).
  // Already-sent emails and LinkedIn touches cannot be recalled — they stay
  // in the audit trail.
  const handleUndoEnrollment = async (draft) => {
    if (!draft.enrollmentId) {
      window.alert('This draft is not associated with an enrollment.');
      return;
    }
    if (!window.confirm(
      'Stop this enrollment and discard all unsent drafts?\n\n' +
      'Sent emails and LinkedIn touches cannot be recalled — they stay in history.\n' +
      'The prospect can be re-enrolled fresh after this.'
    )) return;
    try {
      const result = await apiFetch(`/sequences/enrollments/${draft.enrollmentId}/undo`, {
        method: 'POST',
      });
      if (result.wasAlreadyTerminal) {
        window.alert('This enrollment was already stopped.');
        return;
      }
      // Remove all drafts tied to that enrollment from the local list.
      setProspectDrafts(prev => prev.filter(d => d.enrollmentId !== draft.enrollmentId));
      // Refresh activities so the audit entry shows up.
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
      window.alert(
        `Enrollment stopped. ${result.draftsDiscarded || 0} draft(s) discarded.` +
        (result.stageReverted ? ` Stage reverted to '${result.stageReverted}'.` : '')
      );
    } catch (err) {
      console.error('Failed to undo enrollment:', err);
      window.alert('Failed to undo enrollment: ' + (err.message || 'unknown error'));
    }
  };

  const handleMarkDoneProspectDraft = async (draftId) => {
    // Phase 2: for call-channel drafts, open the LogCallModal instead of
    // hitting /complete directly. The modal's save handler will POST to
    // /prospect-calls with sequence_step_log_id which advances the step
    // and writes the call log in one transaction.
    const draft = prospectDrafts.find(d => d.id === draftId);
    if (draft?.channel === 'call' && prospect) {
      setShowLogCallModal(true);
      setCallModalSequenceContext({
        sequenceStepLogId: draft.id,
        taskNote: draft.task_note || draft.body || '',
        sequenceContext: {
          sequence_name: draft.sequence_name || draft.sequence?.name,
          step_order:    draft.step_order,
        },
      });
      return;
    }

    setProspectDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: true, error: null } }));
    try {
      await apiFetch(`/sequences/drafts/${draftId}/complete`, { method: 'POST', body: JSON.stringify({}) });
      setProspectDrafts(prev => prev.filter(d => d.id !== draftId));
      setProspectDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
      try {
        const res = await apiFetch(`/prospects/${prospectId}`);
        setActivities(res.activities || []);
      } catch (_) {}
    } catch (err) {
      setProspectDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: false, error: err.message } }));
    }
  };

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        setLoading(true);
        const res = await apiFetch(`/prospects/${prospectId}`);
        setProspect(res.prospect);
        setActions(res.actions || []);
        setActivities(res.activities || []);
        // Check for active enrollment so button can be disabled
        try {
          const er = await apiFetch(`/sequences/enrollments?prospectId=${prospectId}&status=active`);
          setActiveEnrollment((er.enrollments || [])[0] || null);
        } catch (_) {}
        // Load drafts upfront so they show immediately on Activity tab
        try {
          const dr = await apiFetch(`/sequences/drafts?prospectId=${prospectId}`);
          setProspectDrafts(dr.drafts || []);
        } catch (_) {}
      } catch (err) {
        console.error('Failed to load prospect:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetail();
  }, [prospectId]);

  const fetchContext = useCallback(async ({ force = false } = {}) => {
    if (!force && (contextData || contextLoading)) return;
    setContextLoading(true);
    try {
      const res = await apiFetch(`/prospect-context/${prospectId}`);
      setContextData(res);
    } catch (err) {
      console.error('Failed to load prospect context:', err);
    } finally {
      setContextLoading(false);
    }
  }, [prospectId, contextData, contextLoading]);

  const handleTabChange = (t) => {
    setActiveTab(t);
    if (t === 'intel')    fetchContext();
    if (t === 'activity') loadProspectDrafts();
  };

  const handleEditSave = async () => {
    setEditSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/prospects/${prospectId}`, {
        method: 'PATCH',
        body: JSON.stringify(editForm),
      });
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setEditMode(false);
      setEditForm({});
      onUpdate();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleStageChange = async (newStage) => {
    // Disqualify takes the structured-reason modal route — not a prompt.
    if (newStage === 'disqualified') {
      setShowStageMenu(false);
      setShowDiscardModal(true);
      return;
    }
    try {
      await apiFetch(`/prospects/${prospectId}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: newStage }),
      });
      // Refresh
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActivities(res.activities || []);
      setShowStageMenu(false);
      onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleConvert = async () => {
    const dealName = prompt('Deal name (leave empty for default):');
    if (dealName === null) return;
    try {
      const res = await apiFetch(`/prospects/${prospectId}/convert`, {
        method: 'POST',
        body: JSON.stringify({ dealName: dealName || undefined, createDeal: true }),
      });
      alert(`Converted! Contact #${res.contactId}${res.dealId ? `, Deal #${res.dealId}` : ''}`);
      onClose();
      onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCompleteAction = async (actionId, outcome) => {
    try {
      await apiFetch(`/prospecting-actions/${actionId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed', outcome }),
      });
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActions(res.actions || []);
      setActivities(res.activities || []);
      onUpdate();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleGenerateActions = async () => {
    if (!prospect?.playbook_id) {
      alert('Assign a playbook to this prospect first (in the Overview tab).');
      return;
    }
    setGenerating(true);
    try {
      const res = await apiFetch('/prospecting-actions/generate', {
        method: 'POST',
        body: JSON.stringify({ prospectId }),
      });
      const msg = res.message || `Created ${res.created} action(s), skipped ${res.skipped} duplicate(s).`;
      if (res.created === 0 && res.skipped === 0 && res.message) {
        alert(msg);
      }
      // Refresh detail
      const detail = await apiFetch(`/prospects/${prospectId}`);
      setProspect(detail.prospect);
      setActions(detail.actions || []);
      setActivities(detail.activities || []);
      onUpdate();
    } catch (err) {
      alert(err.message);
    } finally {
      setGenerating(false);
    }
  };

  // ── Research state ────────────────────────────────────────────────────────
  const [researching,    setResearching]    = useState(false);
  const [researchResult, setResearchResult] = useState(null);
  const [researchError,  setResearchError]  = useState('');

  const handleResearch = async () => {
    setResearching(true);
    setResearchError('');
    try {
      const res = await apiFetch(`/prospects/${prospectId}/research`, {
        method: 'POST',
        body:   JSON.stringify({}),
      });
      setResearchResult(res);
      // Refresh prospect so research_notes updates in overview tab
      const detail = await apiFetch(`/prospects/${prospectId}`);
      setProspect(detail.prospect);
      onUpdate();
    } catch (err) {
      setResearchError(err.message || 'Research failed');
    } finally {
      setResearching(false);
    }
  };

  // ── Enrich-account state ──────────────────────────────────────────────────
  // Calls POST /prospects/:id/enrich-from-coresignal. The backend resolves
  // the prospect's account, calls the configured firmographic provider, and
  // applies the result with strict "fill blanks only" rules. Two prospects
  // at the same account share the same enrichment — the destination is the
  // account row, not the prospect.
  //
  // After success we force-refetch contextData so the Account &
  // Relationships section reflects the new firmographics. The cached
  // guard in fetchContext would otherwise leave stale data on screen.
  const [enriching,     setEnriching]     = useState(false);
  const [enrichResult,  setEnrichResult]  = useState(null);   // { kind: 'ok'|'error', message }
  const handleEnrichAccount = async () => {
    setEnriching(true);
    setEnrichResult(null);
    try {
      // Direct fetch (not apiFetch) because we need the structured body
      // on non-2xx responses — apiFetch only surfaces error.message and
      // drops the rest, which would lose `reason` for the friendly map.
      const token = localStorage.getItem('token') || localStorage.getItem('authToken');
      const r = await fetch(`${API}/prospects/${prospectId}/enrich-from-coresignal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });
      let body = {};
      try { body = await r.json(); } catch (_) {}

      if (!r.ok || body.ok === false) {
        const reason = body.reason || 'unknown';
        const friendly = {
          prospect_has_no_account:  'This prospect has no account linked yet.',
          no_identifier_on_account: 'No LinkedIn URL or real domain on the account — nothing to look up.',
          not_found:                'CoreSignal had no match for this company.',
          ambiguous:                `Multiple candidates found${body.hit_count ? ` (${body.hit_count})` : ''}. Needs human review.`,
          no_credits:               'Out of CoreSignal credits.',
          auth_failed:              'CoreSignal auth failed — check API key.',
          rate_limited:             'CoreSignal rate-limited the request. Try again in a minute.',
          timeout:                  'CoreSignal timed out.',
          no_api_key:               'CoreSignal API key not configured.',
        }[reason] || `Enrichment failed: ${reason}`;
        setEnrichResult({ kind: 'error', message: friendly });
        return;
      }

      // Success shape: { ok, accountId, status, enriched: {...}, provider }
      const fields = body.enriched
        ? Object.keys(body.enriched).filter(k => k !== 'needs_domain_review_cleared')
        : [];
      const cleared = body.enriched?.needs_domain_review_cleared;
      let message;
      if (fields.length === 0 && !cleared) {
        message = 'No new data — fields were already populated.';
      } else {
        const fragments = [];
        if (cleared) fragments.push('domain resolved');
        if (fields.length > 0) fragments.push(`updated: ${fields.join(', ')}`);
        message = fragments.join(' · ');
      }
      setEnrichResult({ kind: 'ok', message });
      // Refresh account-derived context so Account & Relationships reflects
      // the new firmographics. Force=true bypasses the once-per-mount guard.
      await fetchContext({ force: true });
      onUpdate();
    } catch (err) {
      setEnrichResult({ kind: 'error', message: err.message || 'Enrichment failed' });
    } finally {
      setEnriching(false);
    }
  };

  const openOutreach = (channel, action) => {
    setOutreachChannel(channel || null);
    setOutreachAction(action || null);
    setShowOutreach(true);
  };

  const handleOutreachComplete = async () => {
    setShowOutreach(false);
    setOutreachAction(null);
    // Refresh data
    try {
      const res = await apiFetch(`/prospects/${prospectId}`);
      setProspect(res.prospect);
      setActions(res.actions || []);
      setActivities(res.activities || []);
      onUpdate();
    } catch (err) {
      console.error('Refresh after outreach:', err);
    }
  };

  if (loading) {
    return (
      <div className="pv-detail-overlay" onClick={onClose}>
        <div className={`pv-detail-panel${anyDrawerOpen ? ' pv-detail-panel--with-drawer' : ''}`} onClick={e => e.stopPropagation()}>
          <div className="pv-loading">Loading...</div>
        </div>
      </div>
    );
  }

  if (!prospect) return null;

  // stageCfg was previously used to drive the stage pill at the top of
  // the detail header — removed because the stage progress bar below the
  // action row already shows the current stage, and Move Stage dropdown
  // handles transitions. Keep this comment as a breadcrumb in case the
  // pill is ever re-introduced.
  const currentStageIdx = prospectStages.findIndex(s => s.key === prospect.stage);

  return (
    <div className="pv-detail-overlay" onClick={onClose}>
      <div className={`pv-detail-panel${anyDrawerOpen ? ' pv-detail-panel--with-drawer' : ''}`} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="pv-detail-header">
          <div className="pv-detail-header-left">
            <h3>{prospect.first_name} {prospect.last_name}<EntityIdHint id={prospect.id} type="prospect" /></h3>
            {prospect.title && <span className="pv-detail-title">{prospect.title}</span>}
            {(prospect.company_name || prospect.account?.name) && (
              <span className="pv-detail-company">at {prospect.account?.name || prospect.company_name}</span>
            )}
            {/* Active enrollment scheduled-fire indicator. When there's an
                active enrollment with a future next_step_due, show when the
                next step will fire. Helps the rep see "this prospect is
                scheduled — don't manually message them." */}
            <NextFireBadge enrollment={activeEnrollment} />
            {/* Debug IDs strip — visible only when debug mode is on.
                Toggle with Ctrl+Shift+D (Cmd+Shift+D on Mac) anywhere in
                the app. State is persisted to localStorage['gowarm_debug']
                so it survives reloads. Used during testing to copy
                prospect_id and account_id without DB lookups. */}
            {debugMode && (
              <span style={{
                display: 'inline-block', marginTop: 4,
                padding: '2px 8px', borderRadius: 4,
                background: '#FEF3C7', border: '1px solid #FDE68A',
                color: '#78350F', fontSize: 10,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                letterSpacing: 0.4,
              }}>
                DEBUG · prospect: {prospect.id}
                {(prospect.account?.id || prospect.account_id) && (
                  <> · account: {prospect.account?.id || prospect.account_id}</>
                )}
              </span>
            )}
          </div>
          <button className="pv-detail-close" onClick={onClose}>×</button>
        </div>

        {/* Stage indicator + actions
            Stage pill removed — the stage progress bar (below this row) and
            Move Stage dropdown together cover both "what stage am I in" and
            "let me change it". The pill was a third surface for the same
            information and made the row noisier than it needed to be.

            Log call button removed — the Calls tab on this same panel has
            its own Log Call entry point (handled via onLogCall there), and
            sequence-step call drafts open the modal directly. The header
            button was duplication. */}
        <div className="pv-detail-stage-row">
          <div className="pv-detail-stage-actions">
            <button
              style={{
                fontSize: '12px', padding: '5px 12px',
                background: '#ecfdf5',
                border: '1px solid #6ee7b7',
                color: '#065f46',
                borderRadius: 6,
                cursor: prospect.phone ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                opacity: prospect.phone ? 1 : 0.5,
              }}
              onClick={() => prospect.phone && initiateTwilioCall()}
              disabled={!prospect.phone || isInitiatingTwilio}
              title={prospect.phone
                ? `Call ${prospect.phone} via Twilio`
                : 'Add a phone number to enable calling'}
            >
              {isInitiatingTwilio ? '⏳ Starting…' : '📞 Call via Twilio'}
            </button>
            <button className="pv-btn-primary" style={{ fontSize: '12px', padding: '5px 12px' }} onClick={() => openOutreach()}>
              📤 New Outreach
            </button>
            <button
              style={{
                fontSize: '12px', padding: '5px 12px',
                background: activeEnrollment ? '#f3f4f6' : '#f0fdf4',
                border: `1px solid ${activeEnrollment ? '#e5e7eb' : '#bbf7d0'}`,
                color: activeEnrollment ? '#9ca3af' : '#065f46',
                borderRadius: 6,
                cursor: activeEnrollment ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
              onClick={() => !activeEnrollment && setShowEnrollModal(true)}
              disabled={!!activeEnrollment}
              title={activeEnrollment ? `Active in: ${activeEnrollment.sequence_name}` : 'Enroll in Sequence'}
            >
              📨 {activeEnrollment ? `In Sequence: ${activeEnrollment.sequence_name}` : 'Enroll in Sequence'}
            </button>
            {prospect.stage === 'qualified_sal' && (
              <button className="pv-btn-convert" onClick={handleConvert}>🎉 Convert</button>
            )}
            <div className="pv-stage-menu-wrap" style={{ position: 'relative' }}>
              <button className="pv-btn-secondary" onClick={() => setShowStageMenu(!showStageMenu)}>
                Move Stage ▾
              </button>
              {showStageMenu && (
                <div className="pv-stage-dropdown">
                  {allStages.filter(s => s.key !== prospect.stage).map(s => (
                    <button key={s.key} onClick={() => handleStageChange(s.key)} className="pv-stage-option">
                      {s.icon} {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Stage progress bar */}
        {currentStageIdx >= 0 && (
          <div className="pv-stage-progress">
            {prospectStages.map((s, idx) => (
              <div
                key={s.key}
                className={`pv-stage-step ${idx <= currentStageIdx ? 'active' : ''}`}
                style={{ '--stage-color': s.color }}
              >
                <span className="pv-stage-step-dot" />
                <span className="pv-stage-step-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="pv-detail-tabs">
          {['overview', 'linkedin', 'calls', 'intel', 'actions', 'activity'].map(t => (
            <button
              key={t}
              className={`pv-detail-tab ${activeTab === t ? 'active' : ''}`}
              onClick={() => handleTabChange(t)}
            >
              {t === 'overview' ? 'Overview'
                : t === 'linkedin' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ background: '#0077B5', color: '#fff', borderRadius: 2, padding: '0px 4px', fontSize: 9, fontWeight: 700 }}>in</span>
                    LinkedIn
                    {getLiStatus(prospect) && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: getLiDotColor(getLiStatus(prospect)), marginLeft: 2 }} />
                    )}
                  </span>
                )
                : t === 'calls' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    📞 Calls
                    {calls.length > 0 && (
                      <span style={{
                        fontSize: 10, fontWeight: 600, color: '#9a3412',
                        background: '#fff7ed', padding: '0px 5px', borderRadius: 8,
                      }}>{calls.length}</span>
                    )}
                  </span>
                )
                : t === 'intel' ? '🎯 Intel'
                : t === 'actions' ? `Actions (${actions.filter(a => a.status === 'pending').length})`
                : 'Activity'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="pv-detail-content">
          {activeTab === 'overview' && (
            <div className="pv-overview-tab">

              {/* Edit / Save toolbar */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 6 }}>
                {editMode ? (
                  <>
                    <button onClick={() => { setEditMode(false); setEditForm({}); setEditError(null); }}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#6b7280' }}>
                      Cancel
                    </button>
                    <button onClick={handleEditSave} disabled={editSaving}
                      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: 'none', background: '#0F9D8E', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
                      {editSaving ? 'Saving…' : 'Save'}
                    </button>
                  </>
                ) : (
                  <button onClick={() => { setEditMode(true); setEditForm({
                    email: prospect.email || '', phone: prospect.phone || '',
                    linkedin_url: prospect.linkedin_url || '', location: prospect.location || '',
                    company_name: prospect.company_name || '', company_domain: prospect.company_domain || '',
                    company_size: prospect.company_size || '', company_industry: prospect.company_industry || '',
                  }); }}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#374151' }}>
                    ✏️ Edit
                  </button>
                )}
              </div>
              {editError && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>{editError}</div>}

              <div className="pv-info-grid">
                <InfoRow label="Email"    value={prospect.email}    editMode={editMode} editValue={editForm.email}    onEdit={v => setEditForm(f => ({...f, email: v}))} />
                <InfoRow label="Phone"    value={prospect.phone}    editMode={editMode} editValue={editForm.phone}    onEdit={v => setEditForm(f => ({...f, phone: v}))} />
                <InfoRow label="LinkedIn" value={prospect.linkedin_url ? <a href={prospect.linkedin_url} target="_blank" rel="noreferrer">Profile ↗</a> : null}
                                          editMode={editMode} editValue={editForm.linkedin_url} onEdit={v => setEditForm(f => ({...f, linkedin_url: v}))} />
                <InfoRow label="Location" value={prospect.location}  editMode={editMode} editValue={editForm.location} onEdit={v => setEditForm(f => ({...f, location: v}))} />
                <InfoRow label="Source"           value={prospect.source} />
                <InfoRow label="Outreach Count"   value={prospect.outreach_count} />
                <InfoRow label="Response Count"   value={prospect.response_count} />
                <InfoRow label="Last Outreach"    value={prospect.last_outreach_at ? formatDate(prospect.last_outreach_at) : null} />
                <InfoRow label="Last Response"    value={prospect.last_response_at ? formatDate(prospect.last_response_at) : null} />
                <InfoRow label="Preferred Channel" value={prospect.preferred_channel} optional />
                <InfoRow label="ICP Score"        value={prospect.icp_score} optional />
              </div>

              {prospect.research_notes && (
                <div className="pv-research-notes">
                  <h4>🔍 Research Notes</h4>
                  {prospect.research_notes.split('\n').map((line, i) => (
                    line.trim() ? (
                      <p key={i} style={{
                        margin: '4px 0',
                        paddingLeft: line.startsWith('•') ? 0 : 8,
                        fontWeight: line.startsWith('💡') || line.startsWith('✉️') || line.startsWith('📧') ? 600 : 400,
                        borderTop: line.startsWith('💡') ? '1px solid #e5e7eb' : 'none',
                        paddingTop: line.startsWith('💡') ? 8 : 0,
                        marginTop:  line.startsWith('💡') ? 8 : 4,
                      }}>{line}</p>
                    ) : <br key={i} />
                  ))}
                  {prospect.research_meta && (
                    <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6', paddingTop: 6 }}>
                      Generated with {prospect.research_meta.model || prospect.research_meta.provider || 'AI'}
                      {prospect.research_meta.generated_at ? ` · ${new Date(prospect.research_meta.generated_at).toLocaleDateString()}` : ''}
                      {prospect.research_meta.stage2_prompt_source ? ` · ${prospect.research_meta.stage2_prompt_source} prompt` : ''}
                    </div>
                  )}
                </div>
              )}

              <div className="pv-info-grid" style={{ marginTop: 16 }}>
                <InfoRow label="Company"  value={prospect.company_name}     editMode={editMode} editValue={editForm.company_name}     onEdit={v => setEditForm(f => ({...f, company_name: v}))} />
                <InfoRow label="Domain"   value={prospect.company_domain}   editMode={editMode} editValue={editForm.company_domain}   onEdit={v => setEditForm(f => ({...f, company_domain: v}))} />
                <InfoRow label="Size"     value={prospect.company_size}     editMode={editMode} editValue={editForm.company_size}     onEdit={v => setEditForm(f => ({...f, company_size: v}))} optional />
                <InfoRow label="Industry" value={prospect.company_industry} editMode={editMode} editValue={editForm.company_industry} onEdit={v => setEditForm(f => ({...f, company_industry: v}))} optional />
              </div>

              {prospect.account && (
                <div className="pv-linked-entity">
                  🏢 Linked Account: <strong>{prospect.account.name}</strong>
                </div>
              )}
              {prospect.linkedContact && (
                <div className="pv-linked-entity">
                  👤 Linked Contact: <strong>{prospect.linkedContact.first_name} {prospect.linkedContact.last_name}</strong>
                </div>
              )}

              {/* STRAP — Strategy & Action Plan */}
              <div style={{ marginTop: 16 }}>
                <StrapPanel entityType="prospect" entityId={prospect.id} />
              </div>
            </div>
          )}

          {activeTab === 'linkedin' && (
            <LinkedInPanel
              prospect={prospect}
              onEventLogged={async () => {
                try {
                  const res = await apiFetch(`/prospects/${prospectId}`);
                  setProspect(res.prospect);
                  setActivities(res.activities || []);
                  onUpdate();
                } catch (_) {}
              }}
            />
          )}

          {activeTab === 'calls' && (
            <CallsPanel
              prospect={prospect}
              calls={calls}
              pendingCallTasks={prospectDrafts.filter(d => d.channel === 'call')}
              onLogCall={() => setShowLogCallModal(true)}
              onLogCallFromTask={(draft) => {
                setShowLogCallModal(true);
                setCallModalSequenceContext({
                  sequenceStepLogId: draft.id,
                  taskNote: draft.task_note || draft.body || '',
                  sequenceContext: {
                    sequence_name: draft.sequence_name || draft.sequence?.name,
                    step_order:    draft.step_order,
                  },
                });
              }}
              onCaptureOutcome={(call) => {
                // "Outcome not captured" recovery: open LogCallModal in
                // editing mode for an existing Twilio call row that has
                // status='completed' (or terminal but failed/no_answer
                // where rep wants to record context) and outcome=NULL.
                setEditingTwilioCallId(call.id);
                setPrefilledCallDurationSec(call.duration_seconds || null);
                setShowLogCallModal(true);
              }}
            />
          )}

          {activeTab === 'intel' && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                  {/* Generate Research Notes — calls POST /prospects/:id/research,
                      which runs TWO AI calls in sequence: stage-1 account research
                      (cached 30 days per account — re-used across prospects at the
                      same company) and stage-2 person research (per-prospect).
                      Approximate cost on Haiku 4.5:
                        cold (first prospect at the account):  ~$0.012
                        warm (account research cached):        ~$0.005
                      Numbers above reflect Anthropic Haiku 4.5 list pricing and
                      do not include the prompt-caching discount (these calls use
                      free-text prompts, not skill bundles, so caching gain is
                      lower than for outreach skills). Cost is logged per-call
                      in ai_token_usage with call_type ∈ {research_account,
                      research_person}; ai_token_usage.estimated_cost_usd is the
                      authoritative number — the figures here are guidance for
                      the rep, not a billing source. */}
                  <button
                    onClick={handleResearch}
                    disabled={researching}
                    title={
                      researching
                        ? 'Calling the AI research model — usually 5-15 seconds.'
                        : (prospect.research_notes
                            ? 'Re-run AI research. Approx cost: ~$0.005 if the account research is still cached (last 30 days), ~$0.012 otherwise.'
                            : 'Run AI research on this prospect. Approx cost: ~$0.012 first time at this account, ~$0.005 if another prospect at the same account was researched in the last 30 days.')
                    }
                    style={{
                      padding: '8px 18px', background: researching ? '#e5e7eb' : '#0F9D8E',
                      color: researching ? '#6b7280' : '#fff', border: 'none', borderRadius: 7,
                      fontSize: 13, fontWeight: 600, cursor: researching ? 'wait' : 'pointer',
                    }}
                  >
                    {researching
                      ? '⏳ Generating notes…'
                      : prospect.research_notes
                        ? '🔄 Re-generate Research Notes'
                        : '📝 Generate Research Notes'}
                  </button>
                  {/* Enrich Account — fills account firmographics from CoreSignal.
                      Operates on the account, not the prospect, so two prospects
                      at the same company share one enrichment. Backend never
                      overwrites real values — only fills blanks. */}
                  <button
                    onClick={handleEnrichAccount}
                    disabled={enriching}
                    title="Fill account firmographics (industry, size, location, domain) from CoreSignal"
                    style={{
                      padding: '8px 18px', background: enriching ? '#e5e7eb' : '#fff',
                      color: enriching ? '#6b7280' : '#1A3A5C',
                      border: '1px solid ' + (enriching ? '#e5e7eb' : '#1A3A5C'),
                      borderRadius: 7,
                      fontSize: 13, fontWeight: 600, cursor: enriching ? 'wait' : 'pointer',
                    }}
                  >
                    {enriching ? '⏳ Enriching…' : '🏢 Enrich Account'}
                  </button>
                  {prospect.research_meta?.generated_at && (
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>
                      Last research {new Date(prospect.research_meta.generated_at).toLocaleDateString()}
                      {' · '}{prospect.research_meta.model || prospect.research_meta.provider || 'AI'}
                      {prospect.research_meta.account_research_cached ? ' · account cached ✓' : ''}
                    </span>
                  )}
                </div>

                {/* Inline AI-cost hint was previously rendered here. We removed
                    it because the rep-facing prospect detail screen is not the
                    right home for cost reporting — the AI Usage tab in Org
                    Admin (which now has a "Cost per Feature" section with
                    per-org accurate numbers) is the authoritative place.
                    Keeping the cost-aware tooltip on the button itself so a
                    rep who hovers can still see it without ever leaving the
                    workflow. */}

                {researchError && (
                  <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, color: '#dc2626', marginBottom: 12 }}>
                    ⚠️ {researchError}
                  </div>
                )}

                {enrichResult && (
                  <div style={{
                    padding: '8px 12px',
                    background:   enrichResult.kind === 'ok' ? '#f0fdf4' : '#fef2f2',
                    border: '1px solid ' + (enrichResult.kind === 'ok' ? '#bbf7d0' : '#fecaca'),
                    borderRadius: 6, fontSize: 13,
                    color:        enrichResult.kind === 'ok' ? '#065f46' : '#dc2626',
                    marginBottom: 12,
                  }}>
                    {enrichResult.kind === 'ok' ? '✅' : '⚠️'} {enrichResult.message}
                  </div>
                )}

                {/* Structured research result (current run) */}
                {researchResult && (
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#065f46', marginBottom: 10 }}>✅ Research complete</div>

                    {researchResult.researchBullets?.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>KEY INSIGHTS</div>
                        {researchResult.researchBullets.map((b, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, fontSize: 13 }}>
                            <span style={{ color: '#0F9D8E', flexShrink: 0 }}>•</span>
                            <span style={{ color: '#374151' }}>{b}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {researchResult.pitchAngle && (
                      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#fff', borderRadius: 7, border: '1px solid #d1fae5' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>💡 PITCH ANGLE</div>
                        <div style={{ fontSize: 13, color: '#1a202c' }}>{researchResult.pitchAngle}</div>
                      </div>
                    )}

                    {researchResult.crispPitch && (
                      <div style={{ marginBottom: 12, padding: '10px 12px', background: '#fff', borderRadius: 7, border: '1px solid #d1fae5' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>✉️ CRISP PITCH</div>
                        <div style={{ fontSize: 13, color: '#1a202c', lineHeight: 1.6 }}>{researchResult.crispPitch}</div>
                      </div>
                    )}

                    {researchResult.suggestedSubject && (
                      <div style={{ padding: '8px 12px', background: '#fff', borderRadius: 7, border: '1px solid #d1fae5' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#065f46', marginBottom: 4 }}>📧 SUGGESTED SUBJECT</div>
                        <div style={{ fontSize: 13, color: '#1a202c', fontStyle: 'italic' }}>{researchResult.suggestedSubject}</div>
                      </div>
                    )}

                    <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
                      {researchResult.meta?.provider} · {researchResult.meta?.model}
                      {researchResult.accountResearchCached ? ' · account research from cache' : ' · fresh account research'}
                      {researchResult.confidence ? ` · ${Math.round(researchResult.confidence * 100)}% confidence` : ''}
                    </div>
                  </div>
                )}

                {/* Persisted research notes (from previous runs) */}
                {!researchResult && prospect.research_notes && (
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>SAVED RESEARCH NOTES</div>
                    {prospect.research_notes.split('\n').map((line, i) => (
                      line.trim() ? (
                        <div key={i} style={{
                          display: 'flex', gap: 8, marginBottom: 4, fontSize: 13,
                          fontWeight: line.startsWith('💡') || line.startsWith('✉️') || line.startsWith('📧') ? 600 : 400,
                          borderTop: line.startsWith('💡') ? '1px solid #e5e7eb' : 'none',
                          paddingTop: line.startsWith('💡') ? 8 : 0,
                          marginTop:  line.startsWith('💡') ? 8 : 0,
                        }}>
                          {line.startsWith('•') && <span style={{ color: '#0F9D8E', flexShrink: 0 }}></span>}
                          <span style={{ color: '#374151' }}>{line}</span>
                        </div>
                      ) : <br key={i} />
                    ))}
                    {prospect.research_meta && (
                      <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af', borderTop: '1px solid #e5e7eb', paddingTop: 6 }}>
                        {prospect.research_meta.model || prospect.research_meta.provider || 'AI'}
                        {prospect.research_meta.generated_at ? ` · ${new Date(prospect.research_meta.generated_at).toLocaleDateString()}` : ''}
                        {' · '}{prospect.research_meta.stage2_prompt_source || 'system'} prompt
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Intel summary card. The old "Generate AI Outreach" CTA on
                  this card was removed because it duplicated the GENERATE
                  OUTREACH section below (OutreachSkillPanel). The composer
                  is still reachable from the header "📝 New Outreach"
                  button, the Actions tab, and the "Use draft" buttons
                  inside OutreachSkillPanel after a draft is generated. */}
              <ProspectIntelCard
                contextData={contextData}
                loading={contextLoading}
                prospect={prospect}
              />

              {/* Outreach skill — generate first-touch email + LinkedIn note.
                  onUseDraft opens the OutreachComposer pre-filled (the bridge);
                  openOutreach already accepts an actionToExecute payload. */}
              <OutreachSkillPanel
                prospectId={prospectId}
                onUseDraft={({ messageSubject, messageBody }) =>
                  openOutreach('email', {
                    channel: 'email',
                    messageSubject,
                    messageBody,
                  })
                }
              />
            </div>
          )}

          {activeTab === 'actions' && (
            <div className="pv-actions-tab">
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <button
                  className="pv-btn-secondary"
                  style={{ fontSize: '11px', padding: '5px 10px' }}
                  onClick={handleGenerateActions}
                  disabled={generating}
                >
                  {generating ? '⏳ Generating...' : '🤖 Generate from Playbook'}
                </button>
              </div>
              {actions.length === 0 ? (
                <div className="pv-empty-state">No actions yet. {prospect?.playbook_id ? 'Click "Generate from Playbook" to create actions.' : 'Assign a playbook to auto-generate actions.'}</div>
              ) : (
                actions.map(a => (
                  <div key={a.id} className={`pv-action-card ${a.status}`}>
                    <div className="pv-action-top">
                      <span className="pv-action-type">
                        {a.channel ? CHANNEL_ICONS[a.channel] : '📋'} {a.title}
                      </span>
                      <span className={`pv-action-status ${a.status}`}>
                        {a.status === 'pending' ? '○' : a.status === 'completed' ? '●' : '◑'} {a.status}
                      </span>
                    </div>
                    {a.description && <p className="pv-action-desc">{a.description}</p>}
                    {a.source === 'playbook' && (
                      <span style={{ fontSize: '10px', color: '#0F9D8E', fontWeight: 600 }}>📋 Playbook</span>
                    )}
                    {a.due_date && (
                      <span style={{ fontSize: '10px', color: '#9ca3af', marginLeft: 8 }}>Due: {formatDate(a.due_date)}</span>
                    )}
                    {a.status === 'pending' && (
                      <div className="pv-action-buttons">
                        {a.channel && (
                          <button
                            className="pv-btn-sm"
                            style={{ background: '#0F9D8E', color: '#fff', border: 'none' }}
                            onClick={() => openOutreach(a.channel, a)}
                          >
                            📤 Start Outreach
                          </button>
                        )}
                        <button
                          className="pv-btn-sm"
                          onClick={() => handleCompleteAction(a.id, 'completed')}
                        >
                          ✓ Complete
                        </button>
                        {a.channel && (
                          <button
                            className="pv-btn-sm"
                            onClick={() => {
                              const outcome = prompt('Outcome? (replied, no_response, bounced, call_connected, voicemail, meeting_booked)');
                              if (outcome) handleCompleteAction(a.id, outcome);
                            }}
                          >
                            Log Outcome
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="pv-activity-tab">

              {/* ── Pending drafts pinned at top ─────────────────────────── */}
              {loadingProspectDrafts && (
                <div style={{ padding: '10px 0', fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                  Loading drafts…
                </div>
              )}
              {!loadingProspectDrafts && (
                <div style={{ marginBottom: prospectDrafts.length > 0 ? 16 : 8 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#374151',
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span>📋 Pending Drafts</span>
                    <span style={{
                      background: prospectDrafts.length > 0 ? '#fef3c7' : '#f3f4f6',
                      color: prospectDrafts.length > 0 ? '#92400e' : '#9ca3af',
                      fontSize: 10, fontWeight: 700,
                      padding: '1px 7px', borderRadius: 10,
                      border: `1px solid ${prospectDrafts.length > 0 ? '#fde68a' : '#e5e7eb'}`,
                    }}>
                      {prospectDrafts.length}
                    </span>
                  </div>
                  {prospectDrafts.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#9ca3af', padding: '6px 0 4px', fontStyle: 'italic' }}>
                      No pending drafts — sequence emails will appear here for review before sending.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {prospectDrafts.map(draft => {
                        const edit    = prospectDraftEdits[draft.id] || {};
                        const subject = edit.subject !== undefined ? edit.subject : draft.subject;
                        const body    = edit.body    !== undefined ? edit.body    : draft.body;
                        const isOpen  = !!edit.open;
                        return (
                          <DraftCard
                            key={draft.id}
                            draft={draft}
                            subject={subject}
                            body={body}
                            isOpen={isOpen}
                            compact={true}
                            sending={!!edit.sending}
                            sendError={edit.error || null}
                            onToggle={() => setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], open: !isOpen } }))}
                            onSubjectChange={v => setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], subject: v } }))}
                            onBodyChange={v => setProspectDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], body: v } }))}
                            onSend={() => handleSendProspectDraft(draft)}
                            onComplete={() => handleMarkDoneProspectDraft(draft.id)}
                            onDiscard={() => handleDiscardProspectDraft(draft.id)}
                            onConvertAndSend={() => handleConvertAndSendProspectDraft(draft)}
                            onUndoEnrollment={() => handleUndoEnrollment(draft)}
                            onDrawerToggle={(open) => setOpenDrawers(prev => ({ ...prev, [draft.id]: open }))}
                          />
                        );
                      })}
                    </div>
                  )}
                  <div style={{ borderTop: '1px solid #f0f0f0', margin: '12px 0 10px' }} />
                </div>
              )}

              {/* ── Activity feed ────────────────────────────────────────── */}
              {activities.length === 0 && prospectDrafts.length === 0 ? (
                <div className="pv-empty-state">No activity yet</div>
              ) : activities.length > 0 ? (
                activities.map(a => (
                  <div key={a.id} className="pv-activity-item">
                    <span className="pv-activity-type">{a.activity_type}</span>
                    <span className="pv-activity-desc">{a.description}</span>
                    <span className="pv-activity-time">{formatDate(a.created_at)}</span>
                  </div>
                ))
              ) : null}
            </div>
          )}
        </div>

        {/* SequenceEnrollModal */}
        {showEnrollModal && prospect && (
          <SequenceEnrollModal
            prospects={[prospect]}
            onEnrolled={async () => {
              setShowEnrollModal(false);
              // Fix 1: refresh prospect so Intel tab shows updated research_notes
              // Fix 2: refresh activities so Activity tab shows sequence_enrolled entry
              // Fix 3: refresh activeEnrollment so button becomes disabled
              try {
                const res = await apiFetch(`/prospects/${prospectId}`);
                setProspect(res.prospect);
                setActivities(res.activities || []);
              } catch (err) {
                console.error('Refresh after enrollment:', err);
              }
              try {
                const er = await apiFetch(`/sequences/enrollments?prospectId=${prospectId}&status=active`);
                setActiveEnrollment((er.enrollments || [])[0] || null);
              } catch (_) {}
            }}
            onClose={() => setShowEnrollModal(false)}
          />
        )}

        {/* TwilioCallModal — shown while a Twilio call is in progress */}
        {activeTwilioCallId && prospect && (
          <TwilioCallModal
            callId={activeTwilioCallId}
            prospect={prospect}
            onCompleted={(callId, durationSec) => {
              // Call ended normally. Close the in-progress modal and open
              // LogCallModal so the rep can pick an outcome + add notes.
              // duration_seconds was set by the status webhook on the calls
              // row server-side; LogCallModal will pull it via refreshCalls.
              setActiveTwilioCallId(null);
              setPrefilledCallDurationSec(durationSec);
              setShowLogCallModal(true);
            }}
            onClosed={(reason) => {
              setActiveTwilioCallId(null);
              if (reason !== 'user_closed') {
                // Call ended abnormally (no_answer / busy / failed / canceled)
                // — refresh the calls list so the row shows up in the drawer.
                refreshCalls();
              }
            }}
          />
        )}

        {/* LogCallModal */}
        {showLogCallModal && prospect && (
          <LogCallModal
            prospect={prospect}
            settings={callSettings}
            editingCallId={editingTwilioCallId}
            prefilledDurationSec={prefilledCallDurationSec}
            sequenceStepLogId={callModalSequenceContext?.sequenceStepLogId || null}
            taskNote={callModalSequenceContext?.taskNote || ''}
            sequenceContext={callModalSequenceContext?.sequenceContext || null}
            onSaved={async () => {
              const wasSequenceCall = !!callModalSequenceContext?.sequenceStepLogId;
              setShowLogCallModal(false);
              setCallModalSequenceContext(null);
              setPrefilledCallDurationSec(null);
              setEditingTwilioCallId(null);
              await refreshCalls();
              // Refresh prospect so updated channel_data.call drives the
              // timeline CALL line; also refreshes activities for the
              // mirror call_logged entry.
              try {
                const res = await apiFetch(`/prospects/${prospectId}`);
                setProspect(res.prospect);
                setActivities(res.activities || []);
              } catch (err) {
                console.error('Refresh after call log:', err);
              }
              // If this was a sequence-driven call, the step is now completed
              // and the draft should disappear from the list. Refresh drafts.
              if (wasSequenceCall) {
                try {
                  const dr = await apiFetch(`/sequences/drafts?prospectId=${prospectId}`);
                  setProspectDrafts(dr.drafts || []);
                } catch (_) {}
              }
            }}
            onClose={() => {
              setShowLogCallModal(false);
              setCallModalSequenceContext(null);
              setPrefilledCallDurationSec(null);
              setEditingTwilioCallId(null);
            }}
          />
        )}

        {/* OutreachComposer slide-out */}
        {showOutreach && prospect && (
          <OutreachComposer
            prospect={prospect}
            initialChannel={outreachChannel}
            actionToExecute={outreachAction}
            onComplete={handleOutreachComplete}
            onClose={() => { setShowOutreach(false); setOutreachAction(null); }}
          />
        )}

        {/* DiscardProspectModal — structured disqualify flow */}
        {showDiscardModal && prospect && (
          <DiscardProspectModal
            prospects={[prospect]}
            onDiscarded={async () => {
              setShowDiscardModal(false);
              try {
                const res = await apiFetch(`/prospects/${prospectId}`);
                setProspect(res.prospect);
                setActivities(res.activities || []);
              } catch (_) {}
              onUpdate();
            }}
            onClose={() => setShowDiscardModal(false)}
          />
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LINKEDIN PANEL
// ═════════════════════════════════════════════════════════════════════════════

function LinkedInPanel({ prospect, onEventLogged }) {
  const li = prospect?.channel_data?.linkedin || {};
  const currentStatus = li.connection_status || null;

  const [saving, setSaving] = useState(null);   // key of event being saved
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState(null);

  const TIMELINE_STEPS = [
    { key: 'request_sent', label: 'Connection request sent',    tsField: 'request_sent_at' },
    { key: 'connected',    label: 'Connection accepted',        tsField: 'connected_at',     extra: () => {
      if (li.request_sent_at && li.connected_at) {
        const days = Math.round((new Date(li.connected_at) - new Date(li.request_sent_at)) / 86400000);
        return days === 0 ? 'same day' : `${days}d to accept`;
      }
      return null;
    }},
    { key: 'message_sent', label: 'Follow-up message sent',     tsField: 'last_message_at',  extra: () => li.message_count > 1 ? `${li.message_count} messages sent` : null },
    { key: 'replied',      label: 'Reply received',             tsField: 'last_reply_at' },
  ];

  // Which steps are done — a step is done if status is at or past it
  const ORDER = ['request_sent', 'connected', 'message_sent', 'replied'];
  const currentIdx = ORDER.indexOf(currentStatus);
  const isDone = (key) => currentIdx >= ORDER.indexOf(key);

  const handleEvent = async (eventKey) => {
    setSaving(eventKey);
    setError(null);
    try {
      await apiFetch(`/prospects/${prospect.id}/linkedin-event`, {
        method: 'POST',
        body: JSON.stringify({ event: eventKey, note: note.trim() || undefined }),
      });
      setNote('');
      setShowNote(false);
      await onEventLogged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  };

  // Next logical action — the step immediately after current status
  const nextIdx = currentIdx + 1;
  const nextEvent = nextIdx < ORDER.length ? ORDER[nextIdx] : null;
  // If nothing logged yet, next is request_sent
  const promptedEvent = currentStatus ? nextEvent : 'request_sent';


  return (
    <div style={{ padding: '4px 0' }}>

      {/* Profile link row */}
      {prospect.linkedin_url && (
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: '#0077B5', color: '#fff', borderRadius: 3, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>in</span>
          <a
            href={prospect.linkedin_url}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 13, color: '#0077B5', textDecoration: 'none', fontWeight: 500 }}
          >
            Open LinkedIn profile ↗
          </a>
        </div>
      )}

      {/* Timeline */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
          Outreach timeline
        </div>
        {TIMELINE_STEPS.map((step, idx) => {
          const done = isDone(step.key);
          const ts   = li[step.tsField];
          const extraText = step.extra ? step.extra() : null;
          const isLast = idx === TIMELINE_STEPS.length - 1;
          return (
            <div key={step.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {/* Dot + connector line */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, paddingTop: 2 }}>
                <div style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: done ? getLiDotColor(step.key) : 'transparent',
                  border: done ? `2px solid ${getLiDotColor(step.key)}` : '2px solid #d1d5db',
                  flexShrink: 0,
                }} />
                {!isLast && (
                  <div style={{ width: 1, height: 22, background: done ? getLiDotColor(step.key) : '#e5e7eb', marginTop: 2, opacity: done ? 0.4 : 1 }} />
                )}
              </div>
              {/* Label */}
              <div style={{ paddingBottom: isLast ? 0 : 10, flex: 1 }}>
                <div style={{ fontSize: 13, color: done ? '#1a202c' : '#9ca3af', fontWeight: done ? 500 : 400 }}>
                  {step.label}
                </div>
                {done && (ts || extraText) && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1, display: 'flex', gap: 8 }}>
                    {ts && <span>{formatDate(ts)}</span>}
                    {extraText && <span style={{ color: getLiDotColor(step.key), fontWeight: 500 }}>· {extraText}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Record an event section */}
      <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Record an event
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {LI_EVENTS.map(ev => {
            const alreadyDone = isDone(ev.key);
            const isNext = ev.key === promptedEvent;
            return (
              <button
                key={ev.key}
                onClick={() => handleEvent(ev.key)}
                disabled={!!saving}
                style={{
                  fontSize: 12, padding: '5px 12px',
                  borderRadius: 6,
                  border: `1px solid ${alreadyDone ? ev.color : '#e5e7eb'}`,
                  background: alreadyDone ? ev.bg : isNext ? '#f9fafb' : '#fff',
                  color: alreadyDone ? ev.color : isNext ? '#374151' : '#6b7280',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: alreadyDone ? 600 : 400,
                  opacity: saving && saving !== ev.key ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {saving === ev.key ? '⏳' : (
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: alreadyDone ? ev.color : '#d1d5db', flexShrink: 0 }} />
                )}
                {alreadyDone ? `✓ ${ev.label}` : ev.label}
              </button>
            );
          })}
        </div>

        {/* Optional note toggle */}
        <button
          onClick={() => setShowNote(v => !v)}
          style={{
            fontSize: 11, color: '#6b7280', background: 'none', border: 'none',
            padding: 0, cursor: 'pointer', marginBottom: showNote ? 8 : 0,
          }}
        >
          {showNote ? '▾ Hide note' : '▸ Add a note (optional)'}
        </button>

        {showNote && (
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="e.g. 'Sent intro message referencing their recent Series B' or paste the reply summary..."
            rows={3}
            style={{
              width: '100%', fontSize: 12, padding: '8px 10px',
              border: '1px solid #e5e7eb', borderRadius: 6,
              resize: 'vertical', color: '#374151', lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
          />
        )}

        {error && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626', padding: '6px 10px', background: '#fef2f2', borderRadius: 6 }}>
            ⚠️ {error}
          </div>
        )}
      </div>

      {/* Stats summary if anything logged */}
      {currentStatus && (
        <div style={{ marginTop: 16, background: '#f8fafc', borderRadius: 8, padding: '10px 14px', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            LinkedIn stats
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {li.message_count > 0 && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#1a202c' }}>{li.message_count}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Messages sent</div>
              </div>
            )}
            {li.connected_at && li.request_sent_at && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#1a202c' }}>
                  {Math.max(0, Math.round((new Date(li.connected_at) - new Date(li.request_sent_at)) / 86400000))}d
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Days to accept</div>
              </div>
            )}
            {li.last_reply_at && li.connected_at && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#059669' }}>Replied</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{formatDate(li.last_reply_at)}</div>
              </div>
            )}
            {!li.last_reply_at && li.last_message_at && (
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#d97706' }}>{timeAgo(li.last_message_at)}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>Since last message</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Profile data captured from LinkedIn extension */}
      <LinkedInProfileSection prospect={prospect} />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LinkedIn Profile Section — captured profile data display
// ═════════════════════════════════════════════════════════════════════════════

function cleanAbout(text) {
  if (!text) return '';
  return text.replace(/^About\s*\n+/i, '').trim();
}

function cleanRelativeTime(s) {
  if (!s) return '';
  // Strip trailing "· …" artifacts: "2mo •" → "2mo", "1w • Edited •" → "1w"
  return s.replace(/\s*[•·]\s*Edited\s*[•·]?\s*$/i, '')
          .replace(/\s*[•·]\s*$/, '')
          .trim();
}

function formatMonthRange(months) {
  if (!months || months < 1) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}mo`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}mo`;
}

function formatExpDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function LinkedInProfileSection({ prospect }) {
  const [profile, setProfile] = useState(undefined); // undefined = loading, null = not found, object = loaded
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({ about: true, experience: true, education: false, activity: false });
  const [aboutExpanded, setAboutExpanded] = useState(false);
  const [expDescOpen, setExpDescOpen] = useState({}); // index -> bool

  const linkedinUrl = prospect?.linkedin_url;

  useEffect(() => {
    let cancelled = false;
    if (!linkedinUrl) {
      setProfile(null);
      return;
    }
    setProfile(undefined);
    setError(null);
    apiFetch(`/linkedin-profiles/by-url?url=${encodeURIComponent(linkedinUrl)}`)
      .then(r => {
        if (cancelled) return;
        setProfile(r.profile || null);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message || 'Failed to load profile');
        setProfile(null);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedinUrl]);

  const toggle = (k) => setOpen(prev => ({ ...prev, [k]: !prev[k] }));

  // ── Empty / missing states ────────────────────────────────────────────────
  if (!linkedinUrl) {
    return (
      <div style={{ marginTop: 20, padding: '14px 16px', background: '#f9fafb', borderRadius: 8, border: '1px dashed #d1d5db' }}>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          No LinkedIn URL on this prospect. Add one to enable LinkedIn data capture.
        </div>
      </div>
    );
  }

  if (profile === undefined) {
    return (
      <div style={{ marginTop: 20, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading LinkedIn profile data…</div>
      </div>
    );
  }

  if (error && profile === null) {
    return (
      <div style={{ marginTop: 20, padding: '14px 16px', background: '#fef2f2', borderRadius: 8, border: '1px solid #fecaca' }}>
        <div style={{ fontSize: 12, color: '#dc2626' }}>⚠️ {error}</div>
      </div>
    );
  }

  if (profile === null) {
    return (
      <div style={{ marginTop: 20, padding: '14px 16px', background: '#f9fafb', borderRadius: 8, border: '1px dashed #d1d5db' }}>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          Profile not yet captured.
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Visit this prospect's LinkedIn page with the GoWarmCRM extension installed to capture their profile data.
        </div>
        <a
          href={linkedinUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'inline-block', fontSize: 12, padding: '5px 12px', borderRadius: 6,
            background: '#0077B5', color: '#fff', textDecoration: 'none', fontWeight: 500,
          }}
        >
          Open LinkedIn profile ↗
        </a>
      </div>
    );
  }

  // ── Loaded ────────────────────────────────────────────────────────────────
  const about = cleanAbout(profile.about);
  const experience = Array.isArray(profile.experience) ? profile.experience : [];
  const education = Array.isArray(profile.education) ? profile.education : [];
  const activity = Array.isArray(profile.activity) ? profile.activity : [];

  const ABOUT_PREVIEW_LEN = 220;
  const showAboutToggle = about.length > ABOUT_PREVIEW_LEN;
  const aboutDisplay = aboutExpanded || !showAboutToggle ? about : about.slice(0, ABOUT_PREVIEW_LEN).trim() + '…';

  const sectionHeaderStyle = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, fontWeight: 600, color: '#374151',
    background: 'none', border: 'none', padding: '8px 0',
    cursor: 'pointer', width: '100%', textAlign: 'left',
  };
  const caret = (isOpen) => (
    <span style={{ fontSize: 10, color: '#9ca3af', width: 10, display: 'inline-block' }}>
      {isOpen ? '▾' : '▸'}
    </span>
  );

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 14 }}>
      {/* Header with provenance */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Profile data
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 8 }}>
          {profile.last_captured_at && (
            <span>Captured {timeAgo(profile.last_captured_at).toLowerCase()}</span>
          )}
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noreferrer"
            title="Open LinkedIn profile to recapture"
            style={{ color: '#0077B5', textDecoration: 'none', fontSize: 11 }}
          >
            ↻
          </a>
        </div>
      </div>

      {/* Headline + location (always visible if present) */}
      {(profile.headline || profile.location) && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#4b5563', lineHeight: 1.45 }}>
          {profile.headline && <div style={{ fontWeight: 500, color: '#1a202c' }}>{profile.headline}</div>}
          {profile.location && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{profile.location}</div>}
        </div>
      )}

      {/* Backfill hint */}
      {profile.source === 'backfill' && (
        <div style={{ marginBottom: 12, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 11, color: '#92400e' }}>
          Limited data — recapture from LinkedIn for full experience, education, and activity details.
        </div>
      )}

      {/* About */}
      <button onClick={() => toggle('about')} style={sectionHeaderStyle}>
        {caret(open.about)}
        <span>About</span>
        {!about && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>— not captured</span>}
      </button>
      {open.about && about && (
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5, paddingLeft: 16, marginBottom: 6, whiteSpace: 'pre-wrap' }}>
          {aboutDisplay}
          {showAboutToggle && (
            <button
              onClick={() => setAboutExpanded(v => !v)}
              style={{ marginLeft: 6, background: 'none', border: 'none', color: '#0077B5', fontSize: 11, cursor: 'pointer', padding: 0 }}
            >
              {aboutExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Experience */}
      <button onClick={() => toggle('experience')} style={sectionHeaderStyle}>
        {caret(open.experience)}
        <span>Experience{experience.length > 0 ? ` (${experience.length})` : ''}</span>
        {experience.length === 0 && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>— not captured</span>}
      </button>
      {open.experience && experience.length > 0 && (
        <div style={{ paddingLeft: 16, marginBottom: 6 }}>
          {experience.map((exp, i) => {
            const start = formatExpDate(exp.start_date);
            const end   = exp.end_date ? formatExpDate(exp.end_date) : 'Present';
            const dur   = formatMonthRange(exp.duration_months);
            const dateLine = [start && end ? `${start} – ${end}` : (start || end), dur].filter(Boolean).join(' · ');
            const hasDesc = exp.description && exp.description.trim().length > 0;
            const descOpen = !!expDescOpen[i];
            return (
              <div key={i} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: i < experience.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#1a202c' }}>
                  {exp.title || <span style={{ color: '#9ca3af', fontStyle: 'italic', fontWeight: 400 }}>(no title captured)</span>}
                </div>
                {exp.company && (
                  <div style={{ fontSize: 12, color: '#4b5563', marginTop: 1 }}>{exp.company}</div>
                )}
                {dateLine && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{dateLine}</div>
                )}
                {exp.location && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{exp.location}</div>
                )}
                {hasDesc && (
                  <button
                    onClick={() => setExpDescOpen(prev => ({ ...prev, [i]: !prev[i] }))}
                    style={{ marginTop: 4, background: 'none', border: 'none', color: '#0077B5', fontSize: 11, cursor: 'pointer', padding: 0 }}
                  >
                    {descOpen ? '▾ Hide description' : '▸ Show description'}
                  </button>
                )}
                {hasDesc && descOpen && (
                  <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                    {exp.description}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Education */}
      <button onClick={() => toggle('education')} style={sectionHeaderStyle}>
        {caret(open.education)}
        <span>Education{education.length > 0 ? ` (${education.length})` : ''}</span>
        {education.length === 0 && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>— not captured</span>}
      </button>
      {open.education && education.length > 0 && (
        <div style={{ paddingLeft: 16, marginBottom: 6 }}>
          {education.map((ed, i) => {
            const yrs = ed.start_year && ed.end_year ? `${ed.start_year} – ${ed.end_year}` : (ed.start_year || ed.end_year || '');
            const detail = [ed.degree, ed.field_of_study].filter(Boolean).join(' · ');
            return (
              <div key={i} style={{ paddingBottom: 8, marginBottom: 8, borderBottom: i < education.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#1a202c' }}>{ed.school || '(school not captured)'}</div>
                {detail && <div style={{ fontSize: 12, color: '#4b5563', marginTop: 1 }}>{detail}</div>}
                {yrs && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{yrs}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* Activity */}
      <button onClick={() => toggle('activity')} style={sectionHeaderStyle}>
        {caret(open.activity)}
        <span>Recent activity{activity.length > 0 ? ` (${activity.length})` : ''}</span>
        {activity.length === 0 && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>— not captured</span>}
      </button>
      {open.activity && activity.length > 0 && (
        <div style={{ paddingLeft: 16, marginBottom: 6 }}>
          {activity.map((item, i) => {
            const rel = cleanRelativeTime(item.relative_time);
            const kindLabel = item.kind === 'reaction' ? (item.action || 'reacted') : (item.kind || '');
            return (
              <div key={item.id || i} style={{ paddingBottom: 8, marginBottom: 8, borderBottom: i < activity.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {kindLabel && <span style={{ textTransform: 'capitalize', fontWeight: 500, color: '#4b5563' }}>{kindLabel}</span>}
                  {rel && <span>· {rel}</span>}
                  {item.source_url && (
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ marginLeft: 'auto', color: '#0077B5', textDecoration: 'none', fontSize: 11 }}
                    >
                      view ↗
                    </a>
                  )}
                </div>
                {item.text && (
                  <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                    {item.text.length > 280 ? item.text.slice(0, 280).trim() + '…' : item.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProspectIntelCard({ contextData, loading, prospect }) {
  const [expanded, setExpanded] = useState({});
  const toggle = (k) => setExpanded(prev => ({ ...prev, [k]: !prev[k] }));
  const [techExpanded, setTechExpanded] = useState(false);

  if (loading) {
    return <div className="pv-empty-state" style={{ textAlign: 'center', padding: 32 }}>⏳ Loading intelligence...</div>;
  }
  if (!contextData) {
    return <div className="pv-empty-state">No context data available. Try refreshing.</div>;
  }

  const { derived, icpBreakdown, stageGuidance, account, teamEngagement } = contextData;
  const d = derived || {};
  const icp = icpBreakdown || {};

  // Build situation lines
  const situationLines = [];
  if (d.isExistingCustomer) situationLines.push({ text: `Existing customer — $${((d.totalAccountRevenue || 0) / 1000).toFixed(0)}K lifetime`, type: 'positive' });
  if (d.hasOpenDeal && d.openDeals?.length > 0) situationLines.push({ text: `Open deal: ${d.openDeals[0].name} ($${(parseFloat(d.openDeals[0].value || 0) / 1000).toFixed(0)}K at ${d.openDeals[0].stage})`, type: 'info' });
  if (d.isLostAccount) situationLines.push({ text: `Previously lost account`, type: 'warning' });
  if (d.isGhosting) situationLines.push({ text: `Ghosting — ${prospect.outreach_count || 0} touches with no response`, type: 'warning' });
  if (d.isHotLead) situationLines.push({ text: `Hot lead — responded ${d.daysSinceLastResponse}d ago`, type: 'positive' });
  if (d.isStale) situationLines.push({ text: `Going stale — last outreach ${d.daysSinceLastOutreach}d ago`, type: 'warning' });
  if (d.engagedSiblings?.length > 0) situationLines.push({ text: `${d.engagedSiblings.length} other contact(s) engaged at this company`, type: 'info' });
  if (d.hasReplied && !d.isHotLead) situationLines.push({ text: `Has replied (${Math.round((d.responseRate || 0) * 100)}% response rate)`, type: 'positive' });
  if (d.unansweredCount > 0) situationLines.push({ text: `${d.unansweredCount} unanswered outreach`, type: 'neutral' });
  if (d.overdueActions?.length > 0) situationLines.push({ text: `${d.overdueActions.length} overdue action(s)`, type: 'warning' });

  const lineColors = { positive: '#059669', warning: '#d97706', info: '#2563eb', neutral: '#6b7280' };
  const lineBgs = { positive: '#ecfdf5', warning: '#fffbeb', info: '#eff6ff', neutral: '#f9fafb' };
  const scoreColor = (s) => s >= 70 ? '#059669' : s >= 40 ? '#d97706' : '#dc2626';

  const icpCategories = [
    { key: 'firmographic', label: 'Firm' },
    { key: 'persona', label: 'Persona' },
    { key: 'engagement', label: 'Engage' },
    { key: 'timing', label: 'Timing' },
  ];

  return (
    <div className="pv-intel-card">
      {/* Situation summary */}
      {situationLines.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="pv-intel-section-label">Situation</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {situationLines.map((line, i) => (
              <div key={i} style={{
                fontSize: 12, padding: '6px 10px', borderRadius: 6,
                background: lineBgs[line.type], color: lineColors[line.type],
                fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: lineColors[line.type], flexShrink: 0 }} />
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Playbook guidance */}
      {stageGuidance && (
        <div style={{
          padding: '12px 16px', background: '#f0fdfa', borderRadius: 8,
          border: '1px solid #ccfbf1', marginBottom: 16,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#0F9D8E', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Next Move — {prospect.stage}
          </div>
          <div style={{ fontSize: 13, color: '#065f46', fontWeight: 500, marginBottom: 6 }}>
            {stageGuidance.goal}
          </div>
          {stageGuidance.timeline && (
            <div style={{ fontSize: 11, color: '#0F9D8E', marginBottom: 8 }}>
              ⏱ {stageGuidance.timeline}
            </div>
          )}
          {(stageGuidance.key_actions || []).slice(0, 3).map((a, i) => (
            <div key={i} style={{
              fontSize: 12, color: '#115e59', padding: '4px 0 4px 14px',
              position: 'relative', lineHeight: 1.5,
            }}>
              <span style={{ position: 'absolute', left: 0, top: 4, fontSize: 8, color: '#0F9D8E' }}>▸</span>
              {a}
            </div>
          ))}
        </div>
      )}

      {/* ICP Score breakdown */}
      {icp.score != null && (
        <div style={{ marginBottom: 16 }}>
          <button onClick={() => toggle('icp')} style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 0', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              ICP Score
              <span style={{
                fontSize: 14, fontWeight: 700, color: scoreColor(icp.score),
                padding: '2px 8px', borderRadius: 12,
                background: scoreColor(icp.score) + '12', border: `1px solid ${scoreColor(icp.score)}30`,
              }}>
                {icp.score}
              </span>
            </span>
            <span style={{ fontSize: 9, transition: 'transform 0.2s', transform: expanded.icp ? 'rotate(180deg)' : 'none' }}>▼</span>
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {icpCategories.map(c => {
              const cat = icp[c.key];
              if (!cat) return null;
              return (
                <div key={c.key} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4 }}>{c.label}</div>
                  <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
                    <div style={{ width: `${cat.score}%`, height: '100%', background: scoreColor(cat.score), borderRadius: 2, transition: 'width 0.5s ease' }} />
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: scoreColor(cat.score) }}>{cat.score}</div>
                </div>
              );
            })}
          </div>
          {expanded.icp && (
            <div style={{ padding: '8px 0', marginTop: 4 }}>
              {icpCategories.map(c => {
                const cat = icp[c.key];
                if (!cat?.signals?.length) return null;
                return (
                  <div key={c.key} style={{ marginBottom: 6 }}>
                    {cat.signals.map((s, i) => (
                      <div key={i} style={{
                        fontSize: 11, color: '#6b7280', paddingLeft: 10, lineHeight: 1.7,
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}>
                        <span style={{
                          fontSize: 11,
                          color: s.match === true ? '#22c55e' : s.match === 'partial' ? '#eab308' : '#64748b',
                        }}>
                          {s.match === true ? '●' : s.match === 'partial' ? '◐' : '○'}
                        </span>
                        {s.detail}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Account & Relationships */}
      <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginBottom: 16 }}>
        <button onClick={() => toggle('account')} style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 0 8px', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8,
        }}>
          <span>Account & Relationships</span>
          <span style={{ fontSize: 9, transition: 'transform 0.2s', transform: expanded.account ? 'rotate(180deg)' : 'none' }}>▼</span>
        </button>
        <div style={{ fontSize: 12, color: '#374151' }}>
          {account ? account.name : (prospect.company_name || 'No account linked')}
          {' · '}{d.knownContactCount || 0} contacts · {d.teamMembersEngaged || 0} team engaged
        </div>
        {/* Compact firmographics row — always visible when we have any.
            Each chip is its own conditional so we don't render empty separators. */}
        {account && (account.industry || account.size || account.location || (account.domain && account.domain !== 'catchalldomain.com')) && (
          <div style={{
            marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6,
            fontSize: 11, color: '#4b5563',
          }}>
            {account.industry && (
              <span style={{ background: '#f3f4f6', padding: '2px 8px', borderRadius: 10 }}>{account.industry}</span>
            )}
            {account.size && (
              <span style={{ background: '#f3f4f6', padding: '2px 8px', borderRadius: 10 }}>{account.size}</span>
            )}
            {account.location && (
              <span style={{ background: '#f3f4f6', padding: '2px 8px', borderRadius: 10 }}>📍 {account.location}</span>
            )}
            {account.domain && account.domain !== 'catchalldomain.com' && (
              <a
                href={`https://${account.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ background: '#eff6ff', color: '#1d4ed8', padding: '2px 8px', borderRadius: 10, textDecoration: 'none' }}
              >
                {account.domain} ↗
              </a>
            )}
          </div>
        )}
        {expanded.account && (
          <div style={{ paddingTop: 10 }}>
            {/* Description from enrichment, if present */}
            {account?.description && (
              <div style={{
                fontSize: 12, color: '#374151', lineHeight: 1.5,
                padding: '8px 10px', background: '#f9fafb', borderRadius: 6,
                marginBottom: 10,
              }}>
                {account.description}
              </div>
            )}
            {/* LinkedIn company link, if known */}
            {account?.linkedinCompanyUrl && (
              <div style={{ fontSize: 11, marginBottom: 8 }}>
                <a
                  href={account.linkedinCompanyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#0a66c2', textDecoration: 'none' }}
                >
                  in Company on LinkedIn ↗
                </a>
              </div>
            )}
            {/* Enrichment freshness footer */}
            {account?.enrichedAt && (
              <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 8 }}>
                Enriched {new Date(account.enrichedAt).toLocaleDateString()}
                {account.enrichmentProvider ? ` · ${account.enrichmentProvider}` : ''}
              </div>
            )}
            {(d.pastDealsWon || []).map((deal, i) => (
              <div key={i} style={{ fontSize: 11, color: '#059669', paddingLeft: 10, lineHeight: 1.7 }}>
                ✓ Won: {deal.name} — ${(parseFloat(deal.value || 0) / 1000).toFixed(0)}K
              </div>
            ))}
            {(d.pastDealsLost || []).map((deal, i) => (
              <div key={i} style={{ fontSize: 11, color: '#dc2626', paddingLeft: 10, lineHeight: 1.7 }}>
                ✗ Lost: {deal.name}
              </div>
            ))}
            {(d.openDeals || []).map((deal, i) => (
              <div key={i} style={{ fontSize: 11, color: '#2563eb', paddingLeft: 10, lineHeight: 1.7 }}>
                ◎ Open: {deal.name} — ${(parseFloat(deal.value || 0) / 1000).toFixed(0)}K at {deal.stage}
              </div>
            ))}
            {(teamEngagement || []).length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
                Team engaged: {teamEngagement.map(t => `${t.first_name} ${t.last_name}`).join(', ')}
              </div>
            )}
            {(d.otherProspectsAtCompany || []).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, fontWeight: 600 }}>
                  OTHER PROSPECTS AT {(prospect.company_name || '').toUpperCase()}
                </div>
                {d.otherProspectsAtCompany.map((p, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', fontSize: 12,
                    padding: '4px 0', color: '#374151',
                  }}>
                    <span>{p.first_name} {p.last_name} <span style={{ color: '#9ca3af' }}>· {p.title}</span></span>
                    <span style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 3,
                      background: ['engaged', 'discovery_call', 'qualified_sal', 'converted'].includes(p.stage) ? '#eff6ff' : '#f3f4f6',
                      color: ['engaged', 'discovery_call', 'qualified_sal', 'converted'].includes(p.stage) ? '#2563eb' : '#6b7280',
                    }}>
                      {p.stage}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Technographics — tech stack from CoreSignal (research_meta.coresignal.normalized.tech_stack).
          Top-level section so it's visible whenever Intel is open, without
          needing to expand Account & Relationships. Shows the first 5 chips by
          default; "View full stack" toggles into "Show less" and reveals all
          chips inline below. Hidden entirely if no tech data. */}
      {(account?.techStack || []).length > 0 && (
        <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginBottom: 16 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: '#6b7280',
            textTransform: 'uppercase', letterSpacing: 0.8,
            padding: '4px 0 8px',
          }}>
            Technographics
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {(techExpanded ? account.techStack : account.techStack.slice(0, 5)).map((tech, i) => (
              <span key={i} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10,
                background: '#f3f4f6', color: '#374151',
                marginRight: 2, marginBottom: 2,
              }}>
                {tech}
              </span>
            ))}
            {account.techStack.length > 5 && (
              <button
                onClick={() => setTechExpanded(prev => !prev)}
                style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 10,
                  background: 'transparent', color: '#1A3A5C', border: 'none',
                  cursor: 'pointer', fontWeight: 600, textDecoration: 'underline',
                  marginLeft: 2,
                }}
              >
                {techExpanded
                  ? 'Show less'
                  : `+${account.techStack.length - 5} more · View full stack`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Engagement stats */}
      <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginBottom: 16 }}>
        <button onClick={() => toggle('engagement')} style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 0 8px', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.8,
        }}>
          <span>Engagement</span>
          <span style={{ fontSize: 9, transition: 'transform 0.2s', transform: expanded.engagement ? 'rotate(180deg)' : 'none' }}>▼</span>
        </button>
        <div style={{ fontSize: 12, color: '#374151' }}>
          {d.sentEmailCount || 0} sent · {d.receivedEmailCount || 0} received · {Math.round((d.responseRate || 0) * 100)}% response rate
        </div>
        {expanded.engagement && (
          <div style={{ paddingTop: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
              {[
                { label: 'Sent', value: d.sentEmailCount || 0 },
                { label: 'Received', value: d.receivedEmailCount || 0 },
                { label: 'Unanswered', value: d.unansweredCount || 0 },
                { label: 'Response', value: `${Math.round((d.responseRate || 0) * 100)}%` },
              ].map((m, i) => (
                <div key={i} style={{ textAlign: 'center', padding: 8, background: '#f9fafb', borderRadius: 6, border: '1px solid #f3f4f6' }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>{m.value}</div>
                  <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>{m.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>
              {d.daysSinceLastOutreach != null && `Last outreach ${d.daysSinceLastOutreach}d ago`}
              {d.daysSinceLastOutreach != null && d.daysSinceLastResponse != null && ' · '}
              {d.daysSinceLastResponse != null && `Last reply ${d.daysSinceLastResponse}d ago`}
            </div>
          </div>
        )}
      </div>

      {/* The "Generate AI Outreach" CTA that used to live here was removed
          because it duplicated the GENERATE OUTREACH section directly below
          this card (which calls the actual outreach-email and outreach-linkedin
          skills and produces drafts inline with a hook picker). This CTA
          opened the OutreachComposer modal — a manual-send surface — and the
          name implied AI generation it didn't actually do. The composer is
          still reachable from:
            - The "Use draft" buttons inside the GENERATE OUTREACH section
              after a draft is produced (the canonical happy path).
            - The "📝 New Outreach" button in the detail-panel header.
            - The "Start Outreach" button on each pending action in the
              Actions tab.
          No functionality was stranded by this removal. */}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// DRAFT CARD  — reused in SequencesView Drafts tab and prospect Activity tab
// ─────────────────────────────────────────────────────────────────────────────

export default ProspectDetailPanel;
export { LinkedInPanel, LinkedInProfileSection, ProspectIntelCard };

// ─────────────────────────────────────────────────────────────────────────────
// NextFireBadge — small inline indicator for "this prospect's next sequence
// step is scheduled to fire at X." Renders nothing if there's no active
// enrollment or no future next_step_due. Used in the prospect detail header.
// ─────────────────────────────────────────────────────────────────────────────
function NextFireBadge({ enrollment }) {
  if (!enrollment || !enrollment.next_step_due) return null;
  const due = new Date(enrollment.next_step_due);
  const diffMs = due.getTime() - Date.now();
  // Only show if in the future (≥ 1 minute). Past-due will be picked up by
  // the firer momentarily — no useful info to show.
  if (diffMs < 60000) return null;

  const label = formatRelativeFireTime(due);
  const isToday = isSameLocalDay(due, new Date());
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        marginTop: 4, padding: '3px 8px',
        background: isToday ? '#ecfdf5' : '#f0f9ff',
        border: `1px solid ${isToday ? '#a7f3d0' : '#bae6fd'}`,
        color:  isToday ? '#065f46' : '#075985',
        fontSize: 11, borderRadius: 10, fontWeight: 500,
      }}
      title={`Next step fires at ${due.toLocaleString()}`}
    >
      ⏱ Next fires {label}
    </span>
  );
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
}

function formatRelativeFireTime(due) {
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffMin = diffMs / 60000;
  const diffHr  = diffMin / 60;
  const timeStr = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (diffMin < 60)        return `in ${Math.round(diffMin)} min`;
  if (isSameLocalDay(due, now)) return `today ${timeStr}`;
  // Tomorrow check
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameLocalDay(due, tomorrow)) return `tomorrow ${timeStr}`;
  // Within a week → day of week + time
  if (diffHr < 24 * 7) {
    const dow = due.toLocaleDateString([], { weekday: 'short' });
    return `${dow} ${timeStr}`;
  }
  // Otherwise full date
  return due.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
}
