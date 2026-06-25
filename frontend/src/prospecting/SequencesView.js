// SequencesView.js — extracted from ProspectingView.js (2026 module split).
// Verbatim component bodies; only imports added. No behavior changes.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch, stripHtml } from './prospectingShared';
import DraftCard from './DraftCard';
import ScheduledQueue from './ScheduledQueue';
import SequenceBuilder from '../SequenceBuilder';
import SequenceEnrollModal from '../SequenceEnrollModal';
import EntityIdHint from '../EntityIdHint';

function SequencesView({ prospects, search }) {
  const [subTab,       setSubTab]       = useState('library');   // library | drafts | enrollments | stats
  const [sequences,    setSequences]    = useState([]);
  const [enrollments,  setEnrollments]  = useState([]);
  const [enrTotal,     setEnrTotal]     = useState(0);
  const [enrLoadingMore, setEnrLoadingMore] = useState(false);
  const [drafts,       setDrafts]       = useState([]);
  const [loadingSeq,   setLoadingSeq]   = useState(true);
  const [loadingEnr,   setLoadingEnr]   = useState(false);

  const ENR_PAGE_SIZE = 200;
  const [loadingDrafts,setLoadingDrafts]= useState(false);
  const [showBuilder,  setShowBuilder]  = useState(false);
  const [editingSeq,   setEditingSeq]   = useState(null);
  const [viewingSeq,   setViewingSeq]   = useState(null); // full sequence for read-only view
  const [showEnroll,   setShowEnroll]   = useState(false);
  const [enrollSeqId,  setEnrollSeqId]  = useState(null);
  const [selectedProspects, setSelectedProspects] = useState([]);
  const [error,        setError]        = useState('');

  // ── User context (2026_13) ──────────────────────────────────────────────
  // Sequences remain org-shared (no ownership scoping) but archiving a
  // sequence with active enrollments is admin-only. We load context from
  // the same /me/context endpoint the campaigns view uses; it returns the
  // caller's role + isAdmin flag from org_users, server-authoritative.
  const [userContext, setUserContext] = useState(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/prospecting-campaigns/me/context')
      .then(ctx => { if (!cancelled) setUserContext(ctx); })
      .catch(() => {
        if (!cancelled) setUserContext({ userId: null, role: 'member', isAdmin: false, hasSubordinates: false });
      });
    return () => { cancelled = true; };
  }, []);
  const isAdmin = !!userContext?.isAdmin;

  // Mine/Team scope for the activity tabs (Library / Health / Enrollments /
  // Stats). Members always see only their own; the toggle is shown to managers
  // and admins. 'team' maps to depth=all (whole subtree; admins → all org).
  const [scope, setScope] = useState('mine');
  const canTeam = !!(userContext?.hasSubordinates || userContext?.isAdmin);

  // Enrollment drill-down
  const [expandedEnrollId,   setExpandedEnrollId]   = useState(null);
  const [expandedLogs,       setExpandedLogs]       = useState([]);
  const [loadingLogs,        setLoadingLogs]        = useState(false);
  const [expandedStepBody,   setExpandedStepBody]   = useState({}); // { [step_order]: bool }

  // Draft inline-edit state: { [draftId]: { subject, body, editing, sending, error } }
  const [draftEdits,   setDraftEdits]   = useState({});
  // Bulk-select state for the drafts list (Set of enrollmentIds).
  const [selectedEnrollIds, setSelectedEnrollIds] = useState(() => new Set());
  const [bulkUndoing, setBulkUndoing] = useState(false);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkDiscarding, setBulkDiscarding] = useState(false);

  // Open builder in edit mode — fetches full sequence (with steps) before opening.
  // The list endpoint only returns step_count, not the steps array.
  const openBuilderForEdit = async (seq) => {
    // Warn when editing a sequence with active enrollments — changes to
    // steps affect in-flight outreach (future steps render from the new
    // templates). The user always has visibility into what they're about
    // to do; we don't block on this, just confirm.
    const activeCount = parseInt(seq.enrollment_count || 0, 10);
    if (activeCount > 0) {
      const ok = window.confirm(
        `This sequence has ${activeCount} active enrollment${activeCount === 1 ? '' : 's'}.\n\n` +
        `Editing now affects in-flight outreach — future steps for those prospects will render from the new templates.\n\n` +
        `Continue?`
      );
      if (!ok) return;
    }
    try {
      const r = await apiFetch(`/sequences/${seq.id}`);
      setEditingSeq(r.sequence);
      setShowBuilder(true);
    } catch (err) {
      setError('Failed to load sequence: ' + (err.message || 'unknown error'));
    }
  };

  // Open read-only view panel — fetches full sequence with steps.
  const openViewPanel = async (seq) => {
    try {
      const r = await apiFetch(`/sequences/${seq.id}`);
      setViewingSeq(r.sequence);
    } catch (err) {
      setError('Failed to load sequence: ' + (err.message || 'unknown error'));
    }
  };

  const toggleEnrollLogs = async (enrollId) => {
    if (expandedEnrollId === enrollId) {
      setExpandedEnrollId(null);
      setExpandedLogs([]);
      setExpandedStepBody({});
      return;
    }
    setExpandedEnrollId(enrollId);
    setExpandedLogs([]);
    setExpandedStepBody({});
    setLoadingLogs(true);
    try {
      const r = await apiFetch(`/sequences/enrollments/${enrollId}`);
      setExpandedLogs(r.logs || []);
    } catch (err) {
      setError('Failed to load step history: ' + err.message);
    } finally {
      setLoadingLogs(false);
    }
  };

  const loadDrafts = useCallback(async () => {
    setLoadingDrafts(true);
    try {
      const qs = (search && String(search).trim() !== '')
        ? `?${new URLSearchParams({ search })}`
        : '';
      const r = await apiFetch(`/sequences/drafts${qs}`);
      setDrafts(r.drafts || []);
    } catch (err) {
      setError('Failed to load drafts: ' + err.message);
    } finally {
      setLoadingDrafts(false);
    }
  }, [search]);

  const handleConvertAndSendDraft = async (draft) => {
    const edit = draftEdits[draft.id] || {};
    const subject = edit.subject !== undefined ? edit.subject : draft.subject;
    if (!subject) {
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], error: 'Please enter a subject line before sending.' } }));
      return;
    }
    setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      // Patch channel to email and ensure subject is saved, then send
      await apiFetch(`/sequences/drafts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ channel: 'email', subject }),
      });
      await apiFetch(`/sequences/drafts/${draft.id}/send`, { method: 'POST', body: JSON.stringify({}) });
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
    } catch (err) {
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  const handleSendDraft = async (draft) => {
    if (draft.channel && draft.channel !== 'email') { console.error(`handleSendDraft called on ${draft.channel} draft — blocked`); return; }
    const edit = draftEdits[draft.id] || {};
    setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: true, error: null } }));
    try {
      // Save edits first if any
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
      // Backend returns { ok, emailSent, sendError } — if emailSent is false the
      // draft was marked sent in DB but the email never left. With the new fail-fast
      // backend this shouldn't happen, but guard here too.
      if (sendRes && sendRes.emailSent === false && sendRes.sendError) {
        setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: sendRes.sendError } }));
        return;
      }
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
    } catch (err) {
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], sending: false, error: err.message } }));
    }
  };

  // Approve a single draft → queue for PACED sending (vs. Send Now's immediate
  // dispatch). Flips the draft to a 'scheduled' row; the firer delivers it
  // honoring per-account delay, daily limit, and send window.
  const handleApproveDraft = async (draft) => {
    if (draft.channel && draft.channel !== 'email') { console.error(`handleApproveDraft called on ${draft.channel} draft — blocked`); return; }
    const edit = draftEdits[draft.id] || {};
    setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], approving: true, error: null } }));
    try {
      // Save edits first so the queued copy matches what the rep sees.
      if (edit.subject !== undefined || edit.body !== undefined) {
        await apiFetch(`/sequences/drafts/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            subject: edit.subject !== undefined ? edit.subject : draft.subject,
            body:    edit.body    !== undefined ? edit.body    : draft.body,
          }),
        });
      }
      const res = await apiFetch(`/sequences/drafts/${draft.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      if (!res || !res.approved) {
        setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], approving: false, error: 'Could not queue (already queued or not an email draft).' } }));
        return;
      }
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draft.id]; return n; });
    } catch (err) {
      const reconnect = err.status === 409 && err.body?.needs_reconnect;
      const msg = reconnect
        ? `${(err.body.senders?.[0]?.email) || 'Your email sender'} is disconnected — reconnect it in Settings → My Preferences → Outreach Sender Accounts, then approve again.`
        : err.message;
      setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], approving: false, error: msg } }));
    }
  };


  const handleDiscardDraft = async (draftId) => {
    if (!window.confirm('Discard this draft? The step will be skipped and the sequence will advance.')) return;
    try {
      await apiFetch(`/sequences/drafts/${draftId}`, { method: 'DELETE' });
      setDrafts(prev => prev.filter(d => d.id !== draftId));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
    } catch (err) {
      setError('Failed to discard draft: ' + err.message);
    }
  };

  // Slice 4: stop-and-undo the entire enrollment. Discards ALL unsent drafts
  // tied to this enrollment plus reverts the prospect's stage.
  const handleUndoEnrollment = async (draft) => {
    if (!draft.enrollmentId) {
      window.alert('This draft is not associated with an enrollment.');
      return;
    }
    if (!window.confirm(
      'Stop this enrollment and discard all unsent drafts?\n\n' +
      'Sent emails and LinkedIn touches cannot be recalled — they stay in history.'
    )) return;
    try {
      const result = await apiFetch(`/sequences/enrollments/${draft.enrollmentId}/undo`, {
        method: 'POST',
      });
      if (result.wasAlreadyTerminal) {
        window.alert('This enrollment was already stopped.');
        return;
      }
      // Drop all drafts for this enrollment.
      setDrafts(prev => prev.filter(d => d.enrollmentId !== draft.enrollmentId));
      window.alert(
        `Enrollment stopped. ${result.draftsDiscarded || 0} draft(s) discarded.` +
        (result.stageReverted ? ` Stage reverted to '${result.stageReverted}'.` : '')
      );
    } catch (err) {
      setError('Failed to undo enrollment: ' + err.message);
    }
  };

  // ── Bulk unenroll (drafts list) ──────────────────────────────────────────
  // Distinct enrollmentIds currently shown (a single enrollment can have
  // multiple draft steps; we de-dupe so the checkbox represents the enrollment).
  const draftEnrollIds = [...new Set(drafts.map(d => d.enrollmentId).filter(Boolean))];
  const allSelected = draftEnrollIds.length > 0 && draftEnrollIds.every(id => selectedEnrollIds.has(id));

  // "Approve & queue" only applies to EMAIL drafts — those are the only channel
  // the firer can auto-send. LinkedIn/call/task steps are manual, so they're
  // never queued (the button only counts and acts on email drafts).
  const selectedEmailLogIds = drafts
    .filter(d => d.enrollmentId && selectedEnrollIds.has(d.enrollmentId) && (!d.channel || d.channel === 'email'))
    .map(d => d.id);
  const selectedEmailCount = selectedEmailLogIds.length;

  // "Discard" applies to ALL channels (it just skips the step + advances the
  // sequence), so unlike Approve it counts every selected draft, not only email.
  const selectedDraftLogIds = drafts
    .filter(d => d.enrollmentId && selectedEnrollIds.has(d.enrollmentId))
    .map(d => d.id);
  const selectedDraftCount = selectedDraftLogIds.length;

  const toggleSelectEnroll = (enrollmentId) => {
    if (!enrollmentId) return;
    setSelectedEnrollIds(prev => {
      const next = new Set(prev);
      if (next.has(enrollmentId)) next.delete(enrollmentId); else next.add(enrollmentId);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedEnrollIds(prev => {
      if (draftEnrollIds.length > 0 && draftEnrollIds.every(id => prev.has(id))) return new Set();
      return new Set(draftEnrollIds);
    });
  };

  const handleBulkUndo = async () => {
    const ids = [...selectedEnrollIds];
    if (!ids.length) return;
    if (!window.confirm(
      `Stop ${ids.length} enrollment${ids.length === 1 ? '' : 's'} and discard all their unsent drafts?\n\n` +
      'Sent emails and LinkedIn touches cannot be recalled — they stay in history.'
    )) return;
    setBulkUndoing(true);
    try {
      const result = await apiFetch('/sequences/enrollments/bulk-undo', {
        method: 'POST',
        body: JSON.stringify({ enrollmentIds: ids }),
      });
      // Drop all drafts whose enrollment was in the selection.
      const removed = new Set(ids);
      setDrafts(prev => prev.filter(d => !removed.has(d.enrollmentId)));
      setSelectedEnrollIds(new Set());
      window.alert(
        `Stopped ${result.undone || 0} enrollment(s). ${result.draftsDiscarded || 0} draft(s) discarded.` +
        (result.skippedAlreadyTerminal ? ` ${result.skippedAlreadyTerminal} already stopped.` : '')
      );
    } catch (err) {
      setError('Bulk unenroll failed: ' + err.message);
    } finally {
      setBulkUndoing(false);
    }
  };

  const handleBulkApprove = async () => {
    // Email only — LinkedIn/call/task steps are manual and can't be auto-sent.
    const targets = drafts.filter(d =>
      d.enrollmentId && selectedEnrollIds.has(d.enrollmentId) && (!d.channel || d.channel === 'email')
    );
    const logIds = targets.map(d => d.id);
    if (!logIds.length) return;
    if (!window.confirm(
      `Approve and queue ${logIds.length} email${logIds.length === 1 ? '' : 's'} for paced sending?\n\n` +
      'They move to the Scheduled queue and send automatically — respecting your per-account ' +
      'delay, daily limit, and send window. Only email steps can be queued; LinkedIn, call, and ' +
      'task steps are completed manually and are not affected.'
    )) return;
    setBulkApproving(true);
    try {
      // Persist unsaved inline edits before queuing so the queued copy matches.
      for (const d of targets) {
        const e = draftEdits[d.id];
        if (e && (e.subject !== undefined || e.body !== undefined)) {
          await apiFetch(`/sequences/drafts/${d.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              subject: e.subject !== undefined ? e.subject : d.subject,
              body:    e.body    !== undefined ? e.body    : d.body,
            }),
          });
        }
      }
      const result = await apiFetch('/sequences/drafts/approve', {
        method: 'POST',
        body: JSON.stringify({ logIds }),
      });
      const approved = new Set(result.approvedIds || []);
      setDrafts(prev => prev.filter(d => !approved.has(d.id)));
      setSelectedEnrollIds(new Set());
      window.alert(
        `Queued ${result.approved || 0} email(s) for paced sending.` +
        (result.skipped ? ` ${result.skipped} skipped (not an email draft or already queued).` : '')
      );
    } catch (err) {
      if (err.status === 409 && err.body?.needs_reconnect) {
        const who = err.body.senders?.[0]?.email || 'Your email sender';
        setError(`${who} is disconnected — reconnect it in Settings → My Preferences → Outreach Sender Accounts, then approve again.`);
      } else {
        setError('Approve & queue failed: ' + err.message);
      }
    } finally {
      setBulkApproving(false);
    }
  };

  // Bulk version of the per-card 🗑 Discard. Skips each selected draft step and
  // advances its sequence — it does NOT stop the enrollment (that's Unenroll).
  // Applies to every channel, not just email.
  const handleBulkDiscard = async () => {
    const logIds = selectedDraftLogIds;
    if (!logIds.length) return;
    if (!window.confirm(
      `Discard ${logIds.length} draft${logIds.length === 1 ? '' : 's'}?\n\n` +
      'Each step is skipped and its sequence advances to the next step. This does ' +
      'NOT stop the enrollment — use "Unenroll" for that. Already-sent touches are unaffected.'
    )) return;
    setBulkDiscarding(true);
    try {
      const result = await apiFetch('/sequences/drafts/bulk-discard', {
        method: 'POST',
        body: JSON.stringify({ logIds }),
      });
      const removed = new Set(result.discardedIds || []);
      setDrafts(prev => prev.filter(d => !removed.has(d.id)));
      setDraftEdits(prev => {
        const n = { ...prev };
        for (const id of removed) delete n[id];
        return n;
      });
      setSelectedEnrollIds(new Set());
      window.alert(
        `Discarded ${result.discarded || 0} draft(s).` +
        (result.skipped ? ` ${result.skipped} skipped (already actioned or enrolled by someone else).` : '')
      );
    } catch (err) {
      setError('Bulk discard failed: ' + err.message);
    } finally {
      setBulkDiscarding(false);
    }
  };

  const handleMarkDoneDraft = async (draftId) => {
    setDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: true, error: null } }));
    try {
      await apiFetch(`/sequences/drafts/${draftId}/complete`, { method: 'POST', body: JSON.stringify({}) });
      setDrafts(prev => prev.filter(d => d.id !== draftId));
      setDraftEdits(prev => { const n = { ...prev }; delete n[draftId]; return n; });
    } catch (err) {
      setDraftEdits(prev => ({ ...prev, [draftId]: { ...prev[draftId], sending: false, error: err.message } }));
    }
  };

  // Stats
  const [statsSeqId,   setStatsSeqId]   = useState(null);
  const [stats,        setStats]        = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);

  // Status drill-down: click an Enrollment Status pill to list the prospects
  // in that status for the selected sequence. Reuses the paginated
  // /sequences/enrollments?sequenceId=&status= endpoint.
  const [statusDrill,  setStatusDrill]  = useState(null);   // { status, label } | null
  const [drillRows,    setDrillRows]    = useState([]);
  const [drillTotal,   setDrillTotal]   = useState(0);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillMore,    setDrillMore]    = useState(false);
  const DRILL_PAGE = 200;

  const loadStats = useCallback(async (seqId) => {
    setLoadingStats(true);
    setStats(null);
    setError('');
    try {
      const qs = scope === 'mine' ? 'scope=mine' : 'depth=all';
      const r = await apiFetch(`/sequences/${seqId}/stats?${qs}`);
      setStats(r);
    } catch (err) {
      setError('Failed to load stats: ' + err.message);
    } finally {
      setLoadingStats(false);
    }
  }, [scope]);

  const loadStatusDrill = useCallback(async (status, { offset = 0 } = {}) => {
    if (!statsSeqId) return;
    const append = offset > 0;
    if (append) setDrillMore(true); else setDrillLoading(true);
    try {
      const qs = scope === 'mine' ? 'scope=mine' : 'depth=all';
      const r = await apiFetch(
        `/sequences/enrollments?sequenceId=${statsSeqId}&status=${status}&limit=${DRILL_PAGE}&offset=${offset}&${qs}`
      );
      const page = r.enrollments || [];
      setDrillTotal(typeof r.total === 'number' ? r.total : page.length);
      setDrillRows(prev => (append ? [...prev, ...page] : page));
    } catch (err) {
      setError('Failed to load prospects: ' + err.message);
    } finally {
      if (append) setDrillMore(false); else setDrillLoading(false);
    }
  }, [statsSeqId, scope]);

  const openStatusDrill = (status, label) => {
    setStatusDrill({ status, label });
    setDrillRows([]);
    setDrillTotal(0);
    loadStatusDrill(status, { offset: 0 });
  };
  const closeStatusDrill = () => { setStatusDrill(null); setDrillRows([]); setDrillTotal(0); };

  const openStats = (seqId) => {
    setStatsSeqId(seqId);
    setSubTab('stats');
    closeStatusDrill();
    loadStats(seqId);
  };

  const loadSequences = useCallback(async () => {
    setLoadingSeq(true);
    setError('');
    try {
      const qs = scope === 'mine' ? 'scope=mine' : 'depth=all';
      const r = await apiFetch(`/sequences?${qs}`);
      setSequences(r.sequences || []);
    } catch (err) {
      setError('Failed to load sequences: ' + err.message);
    } finally {
      setLoadingSeq(false);
    }
  }, [scope]);

  const loadEnrollments = useCallback(async ({ offset = 0 } = {}) => {
    const append = offset > 0;
    if (append) setEnrLoadingMore(true);
    else        setLoadingEnr(true);
    try {
      const qs = scope === 'mine' ? 'scope=mine' : 'depth=all';
      const r = await apiFetch(`/sequences/enrollments?limit=${ENR_PAGE_SIZE}&offset=${offset}&${qs}`);
      const page = r.enrollments || [];
      setEnrTotal(typeof r.total === 'number' ? r.total : page.length);
      setEnrollments(prev => (append ? [...prev, ...page] : page));
    } catch (err) {
      setError('Failed to load enrollments: ' + err.message);
    } finally {
      if (append) setEnrLoadingMore(false);
      else        setLoadingEnr(false);
    }
  }, [scope]);

  const loadMoreEnrollments = useCallback(() => {
    loadEnrollments({ offset: enrollments.length });
  }, [enrollments.length, loadEnrollments]);

  useEffect(() => { loadSequences(); }, [loadSequences]);
  useEffect(() => {
    if (subTab === 'enrollments') loadEnrollments();
    if (subTab === 'drafts')      loadDrafts();
  }, [subTab, loadEnrollments, loadDrafts]);
  // Re-load the open Stats view when the Mine/Team scope changes.
  useEffect(() => {
    if (subTab === 'stats' && statsSeqId) {
      closeStatusDrill();
      loadStats(statsSeqId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const handleArchive = async (seq) => {
    // Backwards-compat: the click handler used to take just an id. We now
    // pass the full sequence object so we can use enrollment_count for a
    // smarter confirm. Tolerate both shapes for safety.
    const seqId = typeof seq === 'object' ? seq.id : seq;
    const activeCount = typeof seq === 'object' ? parseInt(seq.enrollment_count || 0, 10) : 0;

    // Build the confirm message based on what we know up-front. If there
    // are active enrollments we surface the real consequence (next steps
    // stop firing); for admins, this also tells them they'll need to
    // confirm force-archive. The actual force flag is added on the
    // network call when the user accepts.
    let msg;
    if (activeCount > 0) {
      if (isAdmin) {
        msg = `Archive this sequence?\n\n` +
              `⚠️  ${activeCount} active enrollment${activeCount === 1 ? '' : 's'} will silently stop advancing — their next steps won't fire.\n\n` +
              `As an admin you can force-archive. Continue?`;
      } else {
        msg = `Cannot archive — ${activeCount} active enrollment${activeCount === 1 ? '' : 's'} would silently stall.\n\n` +
              `Stop them first, or ask an admin to force-archive.`;
        window.alert(msg);
        return;
      }
    } else {
      msg = 'Archive this sequence?';
    }
    if (!window.confirm(msg)) return;

    try {
      // Force-flag only when needed (admin + active enrollments). The
      // backend returns 409 with requiresForce:true if we try a regular
      // archive on a sequence with active enrollments — handle that as a
      // safety net in case enrollment_count was stale.
      const url = activeCount > 0
        ? `/sequences/${seqId}?force=true`
        : `/sequences/${seqId}`;
      await apiFetch(url, { method: 'DELETE' });
      loadSequences();
    } catch (err) {
      // Surface the server message verbatim — it explains why the archive
      // was blocked (e.g. enrollment-count guard).
      setError(err.message);
    }
  };

  const handleStopEnrollment = async (enrollId) => {
    if (!window.confirm('Stop this enrollment? No further steps will fire.')) return;
    try {
      await apiFetch(`/sequences/enrollments/${enrollId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'manual' }) });
      loadEnrollments();
    } catch (err) {
      setError(err.message);
    }
  };

  const openEnroll = (seqId) => {
    setEnrollSeqId(seqId);
    // Use all prospects or let user pick — for now open modal with full list
    setSelectedProspects(prospects.slice(0, 1)); // default: first prospect; bulk via checkboxes TBD
    setShowEnroll(true);
  };

  const STATUS_COLORS = {
    active:    { bg: '#d1fae5', color: '#065f46' },
    paused:    { bg: '#fef3c7', color: '#92400e' },
    completed: { bg: '#eff6ff', color: '#1d4ed8' },
    stopped:   { bg: '#fee2e2', color: '#991b1b' },
    replied:   { bg: '#f0fdf4', color: '#166534' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Sequence aggregates strip ────────────────────────────────────
          Replaces the global prospect-pool strips (hidden by
          ProspectingView in sequences mode). Summed client-side from the
          loaded library so it always matches the cards below. */}
      {sequences.length > 0 && (() => {
        const agg = sequences.reduce((a, s) => ({
          steps:  a.steps  + (parseInt(s.step_count, 10)       || 0),
          active: a.active + (parseInt(s.enrollment_count, 10) || 0),
        }), { steps: 0, active: 0 });
        const M = ({ value, label, color }) => (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 76 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: color || '#1f2937' }}>{value}</span>
            <span style={{ fontSize: 10.5, color: '#9ca3af', whiteSpace: 'nowrap' }}>{label}</span>
          </div>
        );
        return (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
            background: '#f8fafc', border: '1px solid #e2e8f0',
            borderRadius: 8, padding: '8px 14px', margin: '0 0 10px',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginRight: 10, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Sequences — totals
            </span>
            <M value={sequences.length} label="sequences" />
            <M value={agg.steps}        label="steps" />
            <M value={agg.active}       label="active enrollments" color="#0F9D8E" />
            {drafts.length > 0 && <M value={drafts.length} label="drafts awaiting review" color="#92400e" />}
          </div>
        );
      })()}

      {/* ── Sub-tab bar ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid #e5e7eb', background: '#fff', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 0 }}>
          {[
            { key: 'library',     label: `📚 Library (${sequences.length})` },
            { key: 'drafts',      label: `📋 Drafts${drafts.length > 0 ? ` (${drafts.length})` : ''}` },
            { key: 'scheduled',   label: '🕒 Scheduled' },
            { key: 'enrollments', label: '🗓 Enrollments' },
            { key: 'stats',       label: '📊 Stats' },
            { key: 'health',      label: '❤️ Health' },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              style={{
                padding: '6px 16px', border: 'none', borderRadius: 7,
                background: subTab === t.key ? '#0F9D8E' : 'transparent',
                color: subTab === t.key ? '#fff' : '#6b7280',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                marginRight: 2,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canTeam && ['library', 'enrollments', 'stats', 'health'].includes(subTab) && (
            <div style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 7, overflow: 'hidden' }}
                 title="Whose sequences and activity to show">
              {['mine', 'team'].map(s => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  style={{
                    padding: '5px 12px', border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 600,
                    background: scope === s ? '#0F9D8E' : '#fff',
                    color: scope === s ? '#fff' : '#6b7280',
                  }}
                >
                  {s === 'mine' ? 'Mine' : 'Team'}
                </button>
              ))}
            </div>
          )}

          {subTab === 'library' && (
            <button
              onClick={() => { setEditingSeq(null); setShowBuilder(true); }}
              style={{
                padding: '7px 16px', borderRadius: 7, border: 'none',
                background: '#0F9D8E', color: '#fff',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              + New Sequence
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ margin: '10px 16px 0', padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626' }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── Library tab ─────────────────────────────────────────────────── */}
      {subTab === 'library' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loadingSeq ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading sequences…</div>
          ) : sequences.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>📨</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No sequences yet</div>
              <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 18 }}>
                Build a multi-step outreach sequence, then enroll prospects to automate follow-ups.
              </div>
              <button
                onClick={() => { setEditingSeq(null); setShowBuilder(true); }}
                style={{
                  padding: '9px 22px', borderRadius: 8, border: 'none',
                  background: '#0F9D8E', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Create First Sequence
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {sequences.map(seq => (
                <div key={seq.id} style={{
                  border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff',
                  overflow: 'hidden',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                }}>
                  <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#111827', lineHeight: 1.3 }}>
                        {seq.name}
                        {seq.visibility === 'private' && (
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: '#E8630A', background: '#fef3e9', padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>
                            🔒 Private
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button
                          onClick={() => openViewPanel(seq)}
                          title="View steps"
                          style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
                        >
                          👁
                        </button>
                        {seq.can_edit && (
                          <>
                            <button
                              onClick={() => openBuilderForEdit(seq)}
                              title="Edit"
                              style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer' }}
                            >
                              ✏️
                            </button>
                            <button
                              onClick={() => handleArchive(seq)}
                              title={seq.enrollment_count > 0
                                ? (isAdmin
                                    ? `Archive (admin force — ${seq.enrollment_count} active)`
                                    : `Cannot archive — ${seq.enrollment_count} active enrollment${seq.enrollment_count === 1 ? '' : 's'}`)
                                : 'Archive'}
                              style={{
                                padding: '3px 8px', borderRadius: 5,
                                border: '1px solid #e5e7eb',
                                background: '#fff',
                                color: (seq.enrollment_count > 0 && !isAdmin) ? '#d1d5db' : '#9ca3af',
                                fontSize: 11,
                                cursor: (seq.enrollment_count > 0 && !isAdmin) ? 'not-allowed' : 'pointer',
                              }}
                            >
                              🗃
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {seq.description && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{seq.description}</div>
                    )}
                    {/* Created by — soft social signal, no enforcement. Falls
                        back gracefully when creator metadata is missing
                        (legacy rows or removed users). */}
                    {(seq.creator_first_name || seq.creator_last_name) && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                        Created by {[seq.creator_first_name, seq.creator_last_name].filter(Boolean).join(' ')}
                        {seq.created_at ? ` · ${new Date(seq.created_at).toLocaleDateString()}` : ''}
                      </div>
                    )}
                  </div>

                  <div style={{ padding: '10px 16px', display: 'flex', gap: 16, fontSize: 12 }}>
                    <span style={{ color: '#374151', fontWeight: 600 }}>{seq.step_count || 0} steps</span>
                    {seq.enrollment_count > 0 && (
                      <span style={{ color: '#0F9D8E', fontWeight: 600 }}>{seq.enrollment_count} active</span>
                    )}
                    <span style={{ color: '#9ca3af', fontSize: 11 }}>
                      {seq.created_at ? new Date(seq.created_at).toLocaleDateString() : ''}
                    </span>
                  </div>

                  <div style={{ padding: '0 16px 14px', display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => openEnroll(seq.id)}
                      style={{
                        flex: 1, padding: '7px', borderRadius: 7,
                        background: '#f0fdf4', border: '1px solid #bbf7d0',
                        color: '#065f46', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      🚀 Enroll Prospect
                    </button>
                    <button
                      onClick={() => { setSubTab('enrollments'); loadEnrollments(); }}
                      style={{
                        padding: '7px 10px', borderRadius: 7,
                        border: '1px solid #e5e7eb', background: '#fff',
                        color: '#6b7280', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      🗓
                    </button>
                    <button
                      onClick={() => openStats(seq.id)}
                      style={{
                        padding: '7px 10px', borderRadius: 7,
                        border: '1px solid #e5e7eb', background: '#fff',
                        color: '#6b7280', fontSize: 12, cursor: 'pointer',
                      }}
                    >
                      📊
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Drafts tab ──────────────────────────────────────────────────── */}
      {subTab === 'drafts' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loadingDrafts ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading drafts…</div>
          ) : drafts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#374151', marginBottom: 6 }}>No drafts waiting</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>
                Drafted emails will appear here when sequences fire steps that require review.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Bulk-select bar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 12px', background: '#f8fafc',
                border: '1px solid #e5e7eb', borderRadius: 8,
                position: 'sticky', top: 0, zIndex: 1,
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                  Select all ({draftEnrollIds.length} enrollment{draftEnrollIds.length === 1 ? '' : 's'})
                </label>
                {selectedEnrollIds.size > 0 && (
                  <>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>
                      {selectedEnrollIds.size} selected
                    </span>
                    {selectedEmailCount > 0 && (
                      <button
                        onClick={handleBulkApprove}
                        disabled={bulkApproving}
                        style={{
                          marginLeft: 'auto', padding: '6px 14px', borderRadius: 6,
                          border: '1px solid #6ee7b7', background: bulkApproving ? '#d1fae5' : '#fff',
                          color: '#047857', fontSize: 13, fontWeight: 600,
                          cursor: bulkApproving ? 'not-allowed' : 'pointer',
                        }}
                        title="Auto-send applies to email steps only. LinkedIn, call, and task steps are completed manually."
                      >
                        {bulkApproving ? 'Queuing…' : `✅ Approve & queue ${selectedEmailCount} email${selectedEmailCount === 1 ? '' : 's'}`}
                      </button>
                    )}
                    {selectedDraftCount > 0 && (
                      <button
                        onClick={handleBulkDiscard}
                        disabled={bulkDiscarding}
                        style={{
                          ...(selectedEmailCount > 0 ? {} : { marginLeft: 'auto' }),
                          padding: '6px 14px', borderRadius: 6,
                          border: '1px solid #fcd34d', background: bulkDiscarding ? '#fef3c7' : '#fff',
                          color: '#92400e', fontSize: 13, fontWeight: 600,
                          cursor: bulkDiscarding ? 'not-allowed' : 'pointer',
                        }}
                        title="Skip these draft steps and advance each sequence. Does not stop the enrollment."
                      >
                        {bulkDiscarding ? 'Discarding…' : `🗑 Discard ${selectedDraftCount} draft${selectedDraftCount === 1 ? '' : 's'}`}
                      </button>
                    )}
                    <button
                      onClick={handleBulkUndo}
                      disabled={bulkUndoing}
                      style={{
                        padding: '6px 14px', borderRadius: 6,
                        border: '1px solid #fca5a5', background: bulkUndoing ? '#fee2e2' : '#fff',
                        color: '#b91c1c', fontSize: 13, fontWeight: 600,
                        cursor: bulkUndoing ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {bulkUndoing ? 'Unenrolling…' : `⏹ Unenroll ${selectedEnrollIds.size} selected`}
                    </button>
                  </>
                )}
              </div>
              {drafts.map(draft => {
                const edit    = draftEdits[draft.id] || {};
                const subject = edit.subject !== undefined ? edit.subject : draft.subject;
                const body    = edit.body    !== undefined ? edit.body    : draft.body;
                const isOpen  = !!edit.open;
                const checked = !!draft.enrollmentId && selectedEnrollIds.has(draft.enrollmentId);
                return (
                  <div key={draft.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!draft.enrollmentId}
                      onChange={() => toggleSelectEnroll(draft.enrollmentId)}
                      title={draft.enrollmentId ? 'Select this enrollment for bulk unenroll' : 'No enrollment linked'}
                      style={{ marginTop: 16 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <DraftCard
                        draft={draft}
                        subject={subject}
                        body={body}
                        isOpen={isOpen}
                        sending={!!edit.sending}
                        sendError={edit.error || null}
                        onToggle={() => setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], open: !isOpen } }))}
                        onSubjectChange={v => setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], subject: v } }))}
                        onBodyChange={v => setDraftEdits(prev => ({ ...prev, [draft.id]: { ...prev[draft.id], body: v } }))}
                        onSend={() => handleSendDraft(draft)}
                        onApprove={() => handleApproveDraft(draft)}
                        approving={!!edit.approving}
                        onComplete={() => handleMarkDoneDraft(draft.id)}
                        onDiscard={() => handleDiscardDraft(draft.id)}
                        onConvertAndSend={() => handleConvertAndSendDraft(draft)}
                        onUndoEnrollment={() => handleUndoEnrollment(draft)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Scheduled tab ───────────────────────────────────────────────── */}
      {subTab === 'scheduled' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          <ScheduledQueue onChanged={() => { if (subTab === 'enrollments') loadEnrollments(); }} />
        </div>
      )}

      {/* ── Enrollments tab ─────────────────────────────────────────────── */}
      {subTab === 'enrollments' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingEnr ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
          ) : enrollments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
              No enrollments yet. Enroll prospects from the Library tab.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                  {['Prospect', 'Sequence', 'Enrolled by', 'Status', 'Step', 'Next Due', 'Enrolled', ''].map(h => (
                    <th key={h} style={{
                      padding: '9px 14px', textAlign: 'left', fontSize: 11,
                      fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
                      letterSpacing: 0.5, whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enrollments.map(e => {
                  const sc = STATUS_COLORS[e.status] || { bg: '#f3f4f6', color: '#6b7280' };
                  const isExpanded = expandedEnrollId === e.id;
                  return (
                    <React.Fragment key={e.id}>
                      <tr
                        style={{ borderBottom: isExpanded ? 'none' : '1px solid #f3f4f6', cursor: 'pointer' }}
                        onClick={() => toggleEnrollLogs(e.id)}
                      >
                        <td style={{ padding: '9px 14px' }}>
                          <div style={{ fontWeight: 600, color: '#1a202c' }}>{e.first_name} {e.last_name}</div>
                          {e.email && <div style={{ fontSize: 11, color: '#94a3b8' }}>{e.email}</div>}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#374151' }}>{e.sequence_name}</td>
                        <td style={{ padding: '9px 14px', color: '#374151', whiteSpace: 'nowrap' }}>
                          {[e.enrolled_by_first_name, e.enrolled_by_last_name].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{
                            padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                            background: sc.bg, color: sc.color,
                          }}>
                            {e.status}
                          </span>
                          {e.stop_reason && (
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{e.stop_reason}</div>
                          )}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#374151', textAlign: 'center' }}>
                          {e.status === 'active' ? e.current_step : '—'}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {e.next_step_due && e.status === 'active'
                            ? new Date(e.next_step_due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                            : '—'}
                        </td>
                        <td style={{ padding: '9px 14px', color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' }}>
                          {new Date(e.enrolled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td style={{ padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          {e.status === 'active' && (
                            <button
                              onClick={(ev) => { ev.stopPropagation(); handleStopEnrollment(e.id); }}
                              style={{
                                padding: '3px 10px', borderRadius: 6, fontSize: 11,
                                border: '1px solid #fecaca', background: '#fef2f2',
                                color: '#dc2626', cursor: 'pointer', fontWeight: 500,
                              }}
                            >
                              Stop
                            </button>
                          )}
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>{isExpanded ? '▲' : '▼'}</span>
                        </td>
                      </tr>

                      {/* ── Step timeline drill-down ──────────────────────── */}
                      {isExpanded && (
                        <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td colSpan={8} style={{ padding: '0 14px 14px 40px', background: '#f9fafb' }}>
                            {loadingLogs ? (
                              <div style={{ padding: '12px 0', fontSize: 12, color: '#9ca3af' }}>Loading timeline…</div>
                            ) : expandedLogs.length === 0 ? (
                              <div style={{ padding: '12px 0', fontSize: 12, color: '#9ca3af' }}>No steps yet.</div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingTop: 12 }}>
                                {expandedLogs.map((step, idx) => {
                                  const STEP_CHANNEL_ICONS = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋', manual: '📋' };
                                  const icon = STEP_CHANNEL_ICONS[step.channel] || '📋';
                                  const isFuture  = step.is_future;
                                  const isDraft   = step.status === 'draft';
                                  const isSent    = step.status === 'sent';
                                  const isSkipped = step.status === 'skipped';
                                  const isFailed  = step.status === 'failed';
                                  const isLast    = idx === expandedLogs.length - 1;

                                  // Status pill config
                                  const pillCfg = isSent    ? { bg: '#d1fae5', color: '#065f46', label: 'Sent' }
                                    : isDraft   ? { bg: '#fef3c7', color: '#92400e', label: 'Draft – awaiting send' }
                                    : isSkipped ? { bg: '#f3f4f6', color: '#6b7280', label: 'Skipped' }
                                    : isFailed  ? { bg: '#fee2e2', color: '#dc2626', label: 'Failed' }
                                    : isFuture  ? { bg: '#eff6ff', color: '#3b82f6', label: 'Planned' }
                                    :             { bg: '#f3f4f6', color: '#6b7280', label: step.status };

                                  // Timestamp to show
                                  const timestamp = isSent || isDraft
                                    ? (step.fired_at || step.scheduled_send_at)
                                    : step.scheduled_send_at;

                                  const formattedDate = timestamp
                                    ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                                    : null;

                                  // Content to show: actual subject for sent, template for planned
                                  const displaySubject = step.subject || step.subject_template || null;
                                  const displayNote    = step.task_note || null;

                                  return (
                                    <div key={step.step_order} style={{ display: 'flex', gap: 0 }}>
                                      {/* Timeline spine */}
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 32, flexShrink: 0 }}>
                                        <div style={{
                                          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                                          background: isSent ? '#0F9D8E' : isFuture ? '#e5e7eb' : isDraft ? '#f59e0b' : '#6b7280',
                                          color: isSent ? '#fff' : isFuture ? '#9ca3af' : '#fff',
                                          fontSize: 11, fontWeight: 700,
                                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                                          border: isFuture ? '2px dashed #d1d5db' : 'none',
                                        }}>
                                          {isSent ? '✓' : step.step_order}
                                        </div>
                                        {!isLast && (
                                          <div style={{
                                            width: 2, flex: 1, minHeight: 16,
                                            background: isFuture ? '#e5e7eb' : '#0F9D8E',
                                            margin: '2px 0',
                                          }} />
                                        )}
                                      </div>

                                      {/* Step content */}
                                      <div style={{
                                        flex: 1, marginLeft: 10, marginBottom: isLast ? 0 : 12,
                                        padding: '8px 12px',
                                        background: isFuture ? '#f9fafb' : '#fff',
                                        border: `1px solid ${isDraft ? '#fde68a' : isFuture ? '#e5e7eb' : '#e5e7eb'}`,
                                        borderRadius: 8,
                                        opacity: isSkipped ? 0.5 : 1,
                                      }}>
                                        {/* Top row: channel + status + date */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                          <span style={{ fontSize: 13 }}>{icon}</span>
                                          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>
                                            {step.channel}
                                          </span>
                                          {step.delay_days > 0 && (
                                            <span style={{ fontSize: 11, color: '#9ca3af' }}>
                                              +{step.delay_days}d
                                            </span>
                                          )}
                                          <span style={{
                                            fontSize: 10, fontWeight: 700, padding: '2px 8px',
                                            borderRadius: 10, background: pillCfg.bg, color: pillCfg.color,
                                          }}>
                                            {pillCfg.label}
                                          </span>
                                          {formattedDate && (
                                            <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 'auto' }}>
                                              {isSent ? '✉ Sent ' : isFuture ? '📅 Due ' : ''}{formattedDate}
                                            </span>
                                          )}
                                        </div>

                                        {/* Subject / task note */}
                                        {displaySubject && (
                                          <div style={{
                                            fontSize: 12, color: isFuture ? '#9ca3af' : '#1a202c',
                                            fontWeight: isFuture ? 400 : 500,
                                            marginTop: 5,
                                            fontStyle: isFuture && !step.subject ? 'italic' : 'normal',
                                          }}>
                                            {displaySubject}
                                            {isFuture && !step.subject && (
                                              <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>(template)</span>
                                            )}
                                          </div>
                                        )}
                                        {!displaySubject && displayNote && (
                                          <div style={{ fontSize: 12, color: isFuture ? '#9ca3af' : '#374151', marginTop: 5 }}>
                                            {displayNote}
                                          </div>
                                        )}

                                        {/* Body preview — sent emails only */}
                                        {isSent && step.body && (
                                          <div style={{ marginTop: 4 }}>
                                            <div style={{
                                              fontSize: 11, color: '#6b7280', lineHeight: 1.6,
                                              whiteSpace: 'pre-wrap',
                                              maxHeight: expandedStepBody[step.step_order] ? 'none' : 48,
                                              overflow: 'hidden',
                                              ...(!expandedStepBody[step.step_order] ? {
                                                maskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                                                WebkitMaskImage: 'linear-gradient(to bottom, black 40%, transparent)',
                                              } : {}),
                                            }}>
                                              {stripHtml(step.body)}
                                            </div>
                                            <button
                                              onClick={() => setExpandedStepBody(prev => ({ ...prev, [step.step_order]: !prev[step.step_order] }))}
                                              style={{
                                                marginTop: 4, padding: '2px 8px',
                                                fontSize: 11, fontWeight: 600,
                                                color: '#0F9D8E', background: 'none',
                                                border: '1px solid #0F9D8E',
                                                borderRadius: 5, cursor: 'pointer',
                                              }}
                                            >
                                              {expandedStepBody[step.step_order] ? '▲ Collapse' : '▼ View full email'}
                                            </button>
                                          </div>
                                        )}

                                        {/* Body template — future email steps */}
                                        {isFuture && step.channel === 'email' && step.body_template && (
                                          <div style={{ marginTop: 4 }}>
                                            {expandedStepBody[step.step_order] && (
                                              <div style={{
                                                fontSize: 11, color: '#9ca3af', lineHeight: 1.6,
                                                whiteSpace: 'pre-wrap',
                                                padding: '8px 10px',
                                                background: '#f9fafb',
                                                border: '1px dashed #e5e7eb',
                                                borderRadius: 6,
                                                marginBottom: 4,
                                              }}>
                                                {step.body_template}
                                                {!step.is_personalised && (
                                                  <div style={{ marginTop: 6, fontSize: 10, color: '#d1d5db', fontStyle: 'italic' }}>
                                                    Template — tokens like {'{{first_name}}'} will be replaced when sent
                                                  </div>
                                                )}
                                              </div>
                                            )}
                                            <button
                                              onClick={() => setExpandedStepBody(prev => ({ ...prev, [step.step_order]: !prev[step.step_order] }))}
                                              style={{
                                                marginTop: 2, padding: '2px 8px',
                                                fontSize: 11, fontWeight: 600,
                                                color: '#6b7280', background: 'none',
                                                border: '1px solid #d1d5db',
                                                borderRadius: 5, cursor: 'pointer',
                                              }}
                                            >
                                              {expandedStepBody[step.step_order] ? '▲ Hide template' : '▼ Preview template'}
                                            </button>
                                          </div>
                                        )}

                                        {/* Error message */}
                                        {isFailed && step.error_message && (
                                          <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>
                                            ⚠️ {step.error_message}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {!loadingEnr && enrollments.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 12, padding: '14px 0 20px', fontSize: 12, color: '#6b7280',
            }}>
              <span>Showing {enrollments.length} of {enrTotal}</span>
              {enrollments.length < enrTotal && (
                <button
                  onClick={loadMoreEnrollments}
                  disabled={enrLoadingMore}
                  style={{
                    padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    border: '1px solid #d1d5db', background: enrLoadingMore ? '#f3f4f6' : '#fff',
                    color: '#374151', cursor: enrLoadingMore ? 'default' : 'pointer',
                  }}
                >
                  {enrLoadingMore ? 'Loading…' : `Load more (${enrTotal - enrollments.length} left)`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Stats tab ───────────────────────────────────────────────────── */}
      {subTab === 'stats' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {/* Sequence picker */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>
              Select Sequence
            </label>
            <select
              value={statsSeqId || ''}
              onChange={e => { const v = parseInt(e.target.value); setStatsSeqId(v); closeStatusDrill(); loadStats(v); }}
              style={{ padding: '7px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, background: '#fff', minWidth: 260 }}
            >
              <option value="">— choose a sequence —</option>
              {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {loadingStats && (
            <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading stats…</div>
          )}

          {!loadingStats && !stats && !statsSeqId && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
              Select a sequence above to view its performance stats.
            </div>
          )}

          {!loadingStats && stats && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Top-line numbers */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                {[
                  { label: 'Enrolled',    value: stats.totalEnrolled,              color: '#374151' },
                  { label: 'Replied',     value: stats.totalReplied,               color: '#0F9D8E' },
                  { label: 'Reply Rate',  value: `${stats.replyRate}%`,            color: '#0F9D8E' },
                  { label: 'Avg Reply At',value: stats.avgReplyStep ? `Step ${stats.avgReplyStep}` : '—', color: '#6b7280' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{
                    padding: '14px 16px', background: '#fff',
                    border: '1px solid #e5e7eb', borderRadius: 10,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                  }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Status breakdown */}
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12 }}>Enrollment Status</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { key: 'active',    label: 'Active',    bg: '#d1fae5', color: '#065f46' },
                    { key: 'replied',   label: 'Replied',   bg: '#ccfbf1', color: '#0d9488' },
                    { key: 'completed', label: 'Completed', bg: '#eff6ff', color: '#1d4ed8' },
                    { key: 'paused',    label: 'Paused',    bg: '#fef3c7', color: '#92400e' },
                    { key: 'stopped',   label: 'Stopped',   bg: '#fee2e2', color: '#991b1b' },
                  ].map(({ key, label, bg, color }) => {
                    const count     = stats.statusBreakdown[key] || 0;
                    const clickable = count > 0;
                    const isActive  = statusDrill?.status === key;
                    return (
                      <button
                        key={key}
                        onClick={() => clickable && openStatusDrill(key, label)}
                        disabled={!clickable}
                        title={clickable ? `View ${label.toLowerCase()} prospects` : undefined}
                        style={{
                          padding: '6px 14px', borderRadius: 20, background: bg,
                          fontSize: 12, fontWeight: 600, color,
                          border: isActive ? `2px solid ${color}` : '2px solid transparent',
                          cursor: clickable ? 'pointer' : 'default',
                          opacity: clickable ? 1 : 0.55,
                        }}
                      >
                        {label}: {count}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Status drill-down — prospects in the clicked status */}
              {statusDrill && (
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>
                      {statusDrill.label} prospects{drillTotal ? ` (${drillTotal})` : ''}
                    </div>
                    <button
                      onClick={closeStatusDrill}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 12, fontWeight: 600 }}
                    >
                      ✕ Close
                    </button>
                  </div>
                  {drillLoading ? (
                    <div style={{ padding: 16, color: '#9ca3af', fontSize: 12 }}>Loading…</div>
                  ) : drillRows.length === 0 ? (
                    <div style={{ padding: 16, color: '#9ca3af', fontSize: 12 }}>No prospects in this status.</div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {drillRows.map(e => (
                          <div key={e.id} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '7px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13,
                          }}>
                            <div style={{ minWidth: 0 }}>
                              <span style={{ fontWeight: 600, color: '#1a202c' }}>{e.first_name} {e.last_name}</span>
                              {e.company_name && <span style={{ color: '#94a3b8', marginLeft: 8 }}>{e.company_name}</span>}
                              {e.email && <div style={{ fontSize: 11, color: '#cbd5e1' }}>{e.email}</div>}
                            </div>
                            <div style={{ color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap', marginLeft: 12 }}>
                              {e.status === 'active' && e.total_steps
                                ? `step ${e.current_step} of ${e.total_steps}`
                                : (e.stop_reason || e.status)}
                            </div>
                          </div>
                        ))}
                      </div>
                      {drillRows.length < drillTotal && (
                        <button
                          onClick={() => loadStatusDrill(statusDrill.status, { offset: drillRows.length })}
                          disabled={drillMore}
                          style={{
                            marginTop: 10, padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                            border: '1px solid #d1d5db', background: drillMore ? '#f3f4f6' : '#fff',
                            color: '#374151', cursor: drillMore ? 'default' : 'pointer',
                          }}
                        >
                          {drillMore ? 'Loading…' : `Load more (${drillTotal - drillRows.length} left)`}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Step funnel */}
              {stats.stepFunnel && stats.stepFunnel.length > 0 && (
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Step Funnel</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {stats.stepFunnel.map((s) => {
                      const barMax   = stats.totalEnrolled || 1;
                      const barPct   = Math.round((s.sent / barMax) * 100);
                      const replyPct = s.sent > 0 ? Math.round((s.replied_here / s.sent) * 100) : 0;
                      return (
                        <div key={s.step_order}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                            <div style={{
                              width: 22, height: 22, borderRadius: '50%',
                              background: '#0F9D8E', color: '#fff',
                              fontSize: 11, fontWeight: 700,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                              {s.step_order}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{
                                height: 10, borderRadius: 5, background: '#f3f4f6', overflow: 'hidden',
                              }}>
                                <div style={{
                                  width: `${barPct}%`, height: '100%',
                                  background: 'linear-gradient(90deg, #0F9D8E, #0d8a7c)',
                                  borderRadius: 5, transition: 'width 0.4s ease',
                                }} />
                              </div>
                            </div>
                            <div style={{ fontSize: 12, color: '#374151', minWidth: 70, textAlign: 'right' }}>
                              <strong>{s.sent}</strong> <span style={{ color: '#9ca3af' }}>sent</span>
                            </div>
                            {s.replied_here > 0 && (
                              <div style={{
                                fontSize: 11, color: '#0d9488', fontWeight: 600,
                                background: '#ccfbf1', padding: '2px 8px', borderRadius: 10,
                                minWidth: 80, textAlign: 'center',
                              }}>
                                {s.replied_here} replied ({replyPct}%)
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {stats.totalEnrolled === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px 0', color: '#9ca3af', fontSize: 13 }}>
                      No steps fired yet — enroll some prospects to start seeing data.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Sequence View Panel ─────────────────────────────────────────── */}
      {viewingSeq && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex', justifyContent: 'flex-end',
        }}
          onClick={e => { if (e.target === e.currentTarget) setViewingSeq(null); }}
        >
          <div style={{
            width: 520, maxWidth: '95vw', height: '100%',
            background: '#fff', overflowY: 'auto',
            boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb',
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#0F9D8E', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  SEQUENCE
                </div>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#111827', lineHeight: 1.3 }}>
                  {viewingSeq.name}
                  <EntityIdHint id={viewingSeq.id} type="sequence" />
                </div>
                {viewingSeq.description && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 1.5 }}>
                    {viewingSeq.description}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, color: '#9ca3af', alignItems: 'center' }}>
                  <span>{(viewingSeq.steps || []).length} steps</span>
                  <span>Draft before sending: {viewingSeq.require_approval ? 'Yes' : 'No'}</span>
                  <span>·</span>
                  <span
                    onClick={async () => {
                      const next = !(viewingSeq.ai_enabled !== false);
                      try {
                        await apiFetch(`/sequences/${viewingSeq.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ ai_enabled: next }),
                        });
                        setViewingSeq({ ...viewingSeq, ai_enabled: next });
                      } catch (e) {
                        alert(`Couldn't update AI setting: ${e.message}`);
                      }
                    }}
                    title="When on, drafts are written by AI (just-in-time at send). When off, the sequence uses its templates verbatim."
                    style={{ cursor: 'pointer', color: '#0F766E', fontWeight: 600 }}
                  >
                    AI personalisation: {viewingSeq.ai_enabled !== false ? 'On' : 'Off'} ✎
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => { setViewingSeq(null); openBuilderForEdit(viewingSeq); }}
                  style={{
                    padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                    background: '#1A3A5C', color: '#fff', border: 'none', cursor: 'pointer',
                  }}
                >
                  ✏️ Edit
                </button>
                <button
                  onClick={() => setViewingSeq(null)}
                  style={{
                    padding: '6px 10px', borderRadius: 7, fontSize: 16,
                    background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Steps */}
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(viewingSeq.steps || []).length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No steps yet</div>
              ) : (
                (viewingSeq.steps || []).map((step, idx) => {
                  const channelEmoji = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋' }[step.channel] || '📋';
                  const hasContent   = step.subject_template || step.body_template || step.task_note;
                  return (
                    <div key={step.id || idx} style={{
                      border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden',
                    }}>
                      {/* Step header */}
                      <div style={{
                        padding: '10px 14px',
                        background: '#f8fafc',
                        display: 'flex', alignItems: 'center', gap: 10,
                        borderBottom: hasContent ? '1px solid #e5e7eb' : 'none',
                      }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: '50%',
                          background: '#0F9D8E', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 700, flexShrink: 0,
                        }}>
                          {idx + 1}
                        </div>
                        <span style={{ fontSize: 14 }}>{channelEmoji}</span>
                        <span style={{ fontWeight: 600, fontSize: 13, color: '#111827', textTransform: 'capitalize' }}>
                          {step.channel}
                        </span>
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>
                          {step.delay_days === 0 ? 'Day 0 (on enroll)' : `Day +${step.delay_days}`}
                        </span>
                        {step.require_approval === true && (
                          <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                            Draft
                          </span>
                        )}
                        {step.require_approval === false && (
                          <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#dcfce7', color: '#166534', fontWeight: 600 }}>
                            Auto-send
                          </span>
                        )}
                      </div>
                      {/* Step content */}
                      {hasContent && (
                        <div style={{ padding: '12px 14px' }}>
                          {step.subject_template && (
                            <div style={{ marginBottom: 8 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Subject</div>
                              <div style={{ fontSize: 13, color: '#111827', fontWeight: 500 }}>{step.subject_template}</div>
                            </div>
                          )}
                          {step.body_template && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Body</div>
                              <div style={{
                                fontSize: 12, color: '#374151', lineHeight: 1.6,
                                whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto',
                                background: '#f9fafb', borderRadius: 6, padding: '8px 10px',
                              }}>
                                {step.body_template}
                              </div>
                            </div>
                          )}
                          {step.task_note && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Note</div>
                              <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.6 }}>{step.task_note}</div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── SequenceBuilder slide-over ───────────────────────────────────── */}
      {showBuilder && (
        <div
          onClick={() => setShowBuilder(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            zIndex: 900, display: 'flex', justifyContent: 'flex-end',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 620, maxWidth: '95vw', height: '100%',
              background: '#fff', boxShadow: '-8px 0 32px rgba(0,0,0,0.12)',
              display: 'flex', flexDirection: 'column', overflowY: 'auto',
            }}
          >
            <SequenceBuilder
              sequence={editingSeq}
              onSave={(saved) => {
                loadSequences();
                // Fetch full sequence (with steps) then re-open in edit mode
                openBuilderForEdit(saved);
              }}
              onClose={() => { setShowBuilder(false); setEditingSeq(null); }}
            />
          </div>
        </div>
      )}

      {/* ── SequenceEnrollModal ──────────────────────────────────────────── */}
      {showEnroll && selectedProspects.length > 0 && (
        <SequenceEnrollModal
          prospects={selectedProspects}
          preSequenceId={enrollSeqId}
          onEnrolled={(result) => {
            setShowEnroll(false);
            loadEnrollments();
            setSubTab('enrollments');
          }}
          onClose={() => setShowEnroll(false)}
        />
      )}

      {/* ── Health panel (Sprint 4) ──────────────────────────────────────────
          Org-wide sequence telemetry. Reads /api/sequences/health which
          returns per-sequence drafts/sent/replied/failed counts over the
          last 24h and 7d, plus stalled-enrollment counts and top error
          messages. Mirrors the campaign-scoped tile, but covers ALL active
          sequences in the org. */}
      {subTab === 'health' && <OrgSequenceHealthPanel onOpenSequence={openStats} scope={scope} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OrgSequenceHealthPanel — Health tab body. Same data shape as the
// SequenceHealthTile in CampaignsView, but org-scoped (lists every active
// sequence, not just those touched by a particular campaign).
//
// Render is intentionally near-identical to the campaign tile so a rep who
// learned to read one reads the other immediately. The big difference is
// that we render this as a full-screen list rather than a compact tile —
// the global view is the place to triage health issues across the org.
// ─────────────────────────────────────────────────────────────────────────────
function OrgSequenceHealthPanel({ onOpenSequence, scope = 'mine' }) {
  const [health,   setHealth]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = scope === 'mine' ? 'scope=mine' : 'depth=all';
    apiFetch(`/sequences/health?${qs}`)
      .then(r => { if (!cancelled) setHealth(r.health || []); })
      .catch(() => { if (!cancelled) setHealth([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope]);

  const statusFor = (h) => {
    if (h.last24h.failed > 0)     return { bg: '#fef2f2', fg: '#991b1b', label: 'Failing' };
    if (h.stalledEnrollments > 0) return { bg: '#fffbeb', fg: '#b45309', label: 'Stalled' };
    if ((h.last7d.sent + h.last7d.drafts + h.last7d.replied) === 0)
      return { bg: '#f3f4f6', fg: '#6b7280', label: 'Idle' };
    return { bg: '#ecfdf5', fg: '#059669', label: 'Healthy' };
  };

  if (loading) {
    return <div style={{ padding: 24, color: '#9ca3af', fontSize: 13 }}>Loading sequence health…</div>;
  }
  if (!health || health.length === 0) {
    return (
      <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>
        No active sequences in this org yet. Create one in the Library tab.
      </div>
    );
  }

  // Roll-up banner: any failing sequences in the last 24h? Surfaced at the
  // top so the rep doesn't have to scan every row to spot a red one.
  const failingCount = health.filter(h => h.last24h.failed > 0).length;
  const stalledCount = health.filter(h => h.stalledEnrollments > 0 && h.last24h.failed === 0).length;

  return (
    <div style={{ padding: 16, overflowY: 'auto' }}>
      {(failingCount > 0 || stalledCount > 0) && (
        <div style={{
          padding: '10px 14px', marginBottom: 12, borderRadius: 6,
          background: failingCount > 0 ? '#fef2f2' : '#fffbeb',
          color:      failingCount > 0 ? '#991b1b' : '#b45309',
          border: `1px solid ${failingCount > 0 ? '#fecaca' : '#fcd34d'}`,
          fontSize: 13,
        }}>
          {failingCount > 0 && <><strong>{failingCount}</strong> sequence{failingCount === 1 ? '' : 's'} failing in the last 24h.</>}
          {failingCount > 0 && stalledCount > 0 && ' '}
          {stalledCount > 0 && <><strong>{stalledCount}</strong> additional sequence{stalledCount === 1 ? '' : 's'} with stalled enrollments.</>}
          {' '}Expand the rows below to see error details.
        </div>
      )}

      <div style={{
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
        overflow: 'hidden',
      }}>
        {health.map((h, idx) => {
          const status = statusFor(h);
          const isExpanded = !!expanded[h.sequenceId];
          return (
            <div key={h.sequenceId} style={{
              borderTop: idx === 0 ? 'none' : '1px solid #f3f4f6',
            }}>
              <div style={{ display: 'flex', alignItems: 'stretch' }}>
              <button
                onClick={() => setExpanded(prev => ({ ...prev, [h.sequenceId]: !isExpanded }))}
                style={{
                  flex: 1, padding: '12px 14px', background: '#fff',
                  border: 'none', cursor: 'pointer', textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}
              >
                <span style={{
                  padding: '3px 10px', fontSize: 11, fontWeight: 700,
                  background: status.bg, color: status.fg, borderRadius: 10,
                  minWidth: 64, textAlign: 'center',
                }}>
                  {status.label}
                </span>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: '#111827' }}>
                  {h.sequenceName}
                </span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  <strong>{h.last24h.sent}</strong> sent · {h.last24h.drafts} drafts
                  {h.last24h.failed > 0 && (
                    <>, <span style={{ color: '#dc2626' }}><strong>{h.last24h.failed}</strong> failed</span></>
                  )}
                  <span style={{ color: '#9ca3af', marginLeft: 8 }}>last 24h</span>
                </span>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                  {isExpanded ? '▾' : '▸'}
                </span>
              </button>
              <button
                onClick={() => onOpenSequence && onOpenSequence(h.sequenceId)}
                title="Open this sequence's stats"
                style={{
                  padding: '0 16px', background: '#fff', border: 'none',
                  borderLeft: '1px solid #f3f4f6', cursor: 'pointer',
                  color: '#0F9D8E', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                }}
              >
                View →
              </button>
              </div>

              {isExpanded && (
                <div style={{ padding: '4px 14px 14px', fontSize: 12, color: '#374151' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>Last 7 days</div>
                      <div style={{ color: '#6b7280', fontSize: 11 }}>
                        {h.last7d.sent} sent · {h.last7d.replied} replied · {h.last7d.drafts} drafts
                        {h.last7d.failed > 0 && <span style={{ color: '#dc2626' }}> · {h.last7d.failed} failed</span>}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>Stalled enrollments</div>
                      <div style={{ color: h.stalledEnrollments > 0 ? '#b45309' : '#6b7280', fontSize: 11 }}>
                        {h.stalledEnrollments} active enrollment{h.stalledEnrollments === 1 ? '' : 's'} with no activity in 7d
                      </div>
                    </div>
                  </div>
                  {h.lastFiredAt && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>
                      Last activity: {new Date(h.lastFiredAt).toLocaleString()}
                    </div>
                  )}
                  {h.topErrors && h.topErrors.length > 0 && (
                    <div style={{
                      marginTop: 6, padding: 10,
                      background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6,
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>
                        Top failure reasons (last 7d)
                      </div>
                      {h.topErrors.map((e, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#7f1d1d', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>
                          <strong>{e.count}×</strong> {e.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// CALLS INBOX VIEW
// Top-level Calls view. Unified stream of:
//   - Completed calls (logged via LogCallModal)
//   - Pending sequence call tasks (sequence_step_logs WHERE channel='call' AND status='draft')
//   - Pending callback requests (calls WHERE outcome='callback_requested' AND no newer call)
//
// Tabs: All / Pending / Overdue / Completed
// Row click → opens prospect drawer at the Calls tab
// Pending rows have a "Log call" button that opens LogCallModal pre-filled
// ═════════════════════════════════════════════════════════════════════════════


export default SequencesView;
