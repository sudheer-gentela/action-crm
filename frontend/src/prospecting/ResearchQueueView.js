// prospecting/ResearchQueueView.js
//
// Slice 2 — Researcher workflow. A focused, one-prospect-at-a-time editor for
// the researcher to optionally write a hook note that feeds personalisation.
//
// Flow:
//   1. Pick a campaign (campaign picker at top)
//   2. Queue loads `target`-stage prospects in that campaign
//   3. Current prospect shows: LinkedIn URL (click-out), LinkedIn-capture
//      status badge, account research (read-only), researcher note textarea
//      (OPTIONAL), signal category dropdown, optional source URL, and an
//      "Use this as the hook" override checkbox.
//   4. Approve → POST /:id/approve-research → next prospect
//      - With no note: prospect advances; the skill auto-picks a hook from
//        LinkedIn activity + account enrichment.
//      - With a note (hint mode): the note flows to the skill as additional
//        context; the skill chooses whether to use it.
//      - With a note + override checked: the skill MUST anchor on the note.
//   5. Skip / Disqualify → mark as disqualified with a reason
//
// Step 1.1b adds a second view, "Ready for review": prospects whose
// background AI research has finished (flagged at intake, from the extension,
// by hand or by the agent). The card shows that research, and next to
// Approve there's "Reject research" (reason required). Rejecting judges the
// RESEARCH, not the prospect: the stage is unchanged and it is stored apart
// from Disqualify / Nurture. "All targets" is the original per-campaign view.
//   GET  /api/prospects/research-review?scope=mine|all&campaignId=
//   POST /api/prospects/:id/reject-research
//
// The capture badge is informational only — it doesn't block approval.
// Researchers use the GoWarmCRM Chrome extension on the prospect's LinkedIn
// page to populate the linkedin_profiles row that the badge reflects.
//
// Backend:
//   GET  /api/prospecting-campaigns/:id/research-queue
//   POST /api/prospects/:id/approve-research
//   PATCH /api/prospects/:id   (for disqualify)

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const HOOK_CATEGORIES = [
  { value: 'prospect_post',       label: "Prospect's own post" },
  { value: 'prospect_comment',    label: "Prospect's comment on someone else's post" },
  { value: 'account_event',       label: 'Account event (funding, hiring, launch)' },
  { value: 'account_post',        label: 'Company post' },
  { value: 'tech_stack',          label: 'Tech stack overlap' },
  { value: 'role_curiosity',      label: 'Role + stage curiosity (no specific signal)' },
  // researcher_override is the category the backend defaults to when the
  // researcher writes a note. It's last in the list because most researchers
  // who categorise their note will pick one of the six above — picking
  // researcher_override is appropriate when the note doesn't fit any
  // category (e.g., context from a conversation, a referral, a podcast).
  { value: 'researcher_override', label: "Researcher's own note (doesn't fit other categories)" },
];

// How a prospect came to be researched (prospects.research_flag_source).
const FLAG_SOURCE_LABELS = {
  intake:    'at intake (fit check passed)',
  extension: 'from the extension',
  manual:    'by hand',
  agent:     'by the agent',
};

// Human-readable "X days ago" for the capture badge.
function formatRelative(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60)        return 'just now';
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400)     return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / (86400 * 7))}w ago`;
  return `${Math.floor(sec / (86400 * 30))}mo ago`;
}

export default function ResearchQueueView() {
  const [campaigns,   setCampaigns]   = useState([]);
  const [campaignId,  setCampaignId]  = useState(null);
  // 'review' = background research waiting for sign-off (step 1.1b);
  // 'target' = the original per-campaign list of target-stage prospects.
  const [mode,        setMode]        = useState('review');
  const [scope,       setScope]       = useState('mine');
  const [reviewCampaignId, setReviewCampaignId] = useState('');
  const [counts,      setCounts]      = useState(null);
  const [queue,       setQueue]       = useState([]);    // current page of prospects
  const [total,       setTotal]       = useState(0);
  const [idx,         setIdx]         = useState(0);     // index into queue
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [flash,       setFlash]       = useState(null);

  // Load campaigns on mount.
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/prospecting-campaigns?status=active');
        const list = r.campaigns || [];
        setCampaigns(list);
        if (list.length > 0) setCampaignId(list[0].id);
      } catch (err) {
        setError('Failed to load campaigns: ' + err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load queue when campaign changes.
  const loadQueue = useCallback(async (cid) => {
    if (!cid) return;
    setLoading(true);
    setError('');
    try {
      const r = await apiFetch(`/prospecting-campaigns/${cid}/research-queue?limit=50&offset=0&stage=target`);
      setQueue(r.prospects || []);
      setTotal(r.total || 0);
      setIdx(0);
    } catch (err) {
      setError('Failed to load research queue: ' + err.message);
      setQueue([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReview = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ scope, limit: '50', offset: '0' });
      if (reviewCampaignId) q.set('campaignId', String(reviewCampaignId));
      const r = await apiFetch(`/prospects/research-review?${q.toString()}`);
      setQueue(r.prospects || []);
      setTotal(r.total || 0);
      setCounts(r.counts || null);
      setIdx(0);
    } catch (err) {
      setError('Failed to load research waiting for review: ' + err.message);
      setQueue([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [scope, reviewCampaignId]);

  useEffect(() => {
    if (mode === 'review') loadReview();
    else if (campaignId) loadQueue(campaignId);
  }, [mode, campaignId, loadQueue, loadReview]);

  const reload = () => (mode === 'review' ? loadReview() : loadQueue(campaignId));

  // Drop the current card locally (after approve / reject / disqualify).
  const removeCurrent = () => {
    setQueue(q => q.filter((_, i) => i !== idx));
    setTotal(t => Math.max(0, t - 1));
    if (mode === 'review') {
      setCounts(c => c ? { ...c, ready_for_review: Math.max(0, (c.ready_for_review || 0) - 1) } : c);
    }
  };

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 3000);
  };

  const handleApprove = async (payload) => {
    const prospect = queue[idx];
    try {
      await apiFetch(`/prospects/${prospect.id}/approve-research`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showFlash('success', `${prospect.firstName} ${prospect.lastName} approved`);
      // Remove approved prospect from the queue locally; don't refetch.
      removeCurrent();
      // idx stays the same → naturally points at the next prospect, or to the
      // end if we just removed the last one.
      if (idx >= queue.length - 1) {
        // We're at the end now; if there are more on the server, refetch.
        if (total > queue.length) reload();
      }
    } catch (err) {
      showFlash('error', 'Approve failed: ' + err.message);
    }
  };

  const handleDisqualify = async (reason) => {
    const prospect = queue[idx];
    if (!window.confirm(`Disqualify ${prospect.firstName} ${prospect.lastName}? They will be removed from outreach.`)) return;
    try {
      await apiFetch(`/prospects/${prospect.id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stage: 'disqualified', reasonCode: reason || 'other' }),
      });
      showFlash('success', `${prospect.firstName} ${prospect.lastName} disqualified`);
      removeCurrent();
    } catch (err) {
      showFlash('error', 'Disqualify failed: ' + err.message);
    }
  };

  // Reject the research (not the prospect) — step 1.1b. Returns true on
  // success so the card can close its reason box.
  const handleRejectResearch = async (reason) => {
    const prospect = queue[idx];
    try {
      await apiFetch(`/prospects/${prospect.id}/reject-research`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      showFlash('success', `Research for ${prospect.firstName} ${prospect.lastName} rejected — they stay in ${prospect.stage === 'research' ? 'Research' : 'Target'}`);
      removeCurrent();
      return true;
    } catch (err) {
      showFlash('error', 'Reject failed: ' + err.message);
      return false;
    }
  };

  const current = queue[idx];
  const remaining = queue.length - idx;

  return (
    <div className="pv-research-queue" style={{ padding: '14px 0', maxWidth: 860, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, color: '#1A3A5C' }}>🔬 Research Queue</h3>
        <div style={{ display: 'inline-flex', border: '1px solid #d1d5db', borderRadius: 6, overflow: 'hidden' }}>
          {[['review', 'Ready for review'], ['target', 'All targets']].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setMode(k)}
              aria-pressed={mode === k}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 600, border: 'none',
                background: mode === k ? '#1A3A5C' : '#fff',
                color:      mode === k ? '#fff' : '#374151',
                cursor: 'pointer',
              }}
            >
              {label}
              {k === 'review' && counts?.ready_for_review ? ` (${counts.ready_for_review})` : ''}
            </button>
          ))}
        </div>
        {mode === 'review' ? (
          <>
            <select
              value={scope}
              onChange={e => setScope(e.target.value)}
              style={{ fontSize: 13, padding: '5px 8px', borderRadius: 5, border: '1px solid #d1d5db' }}
            >
              <option value="mine">My prospects</option>
              <option value="all">Everyone's</option>
            </select>
            <select
              value={reviewCampaignId}
              onChange={e => setReviewCampaignId(e.target.value ? parseInt(e.target.value, 10) : '')}
              style={{ fontSize: 13, padding: '5px 8px', borderRadius: 5, border: '1px solid #d1d5db' }}
            >
              <option value="">All campaigns</option>
              {campaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </>
        ) : (
          <select
            value={campaignId || ''}
            onChange={e => setCampaignId(parseInt(e.target.value, 10))}
            style={{ fontSize: 13, padding: '5px 8px', borderRadius: 5, border: '1px solid #d1d5db' }}
          >
            <option value="">— Pick a campaign —</option>
            {campaigns.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        {total > 0 && (
          <span style={{
            fontSize: 12, color: '#6b7280',
            background: '#f3f4f6', padding: '3px 10px', borderRadius: 12,
          }}>
            {remaining} of {total} pending
          </span>
        )}
      </div>

      {mode === 'review' && counts && (counts.queued + counts.researching + counts.failed) > 0 && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          In the pipeline: {counts.queued} waiting to run · {counts.researching} researching now
          {counts.failed ? <> · <span style={{ color: '#991b1b' }}>{counts.failed} failed</span> (re-flag them from the prospect panel)</> : null}
          {' · '}
          <button onClick={reload} style={{ background: 'none', border: 'none', padding: 0, color: '#4F46E5', cursor: 'pointer', fontSize: 12 }}>
            ↻ Refresh
          </button>
        </div>
      )}

      {flash && (
        <div style={{
          padding: '6px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12,
          background: flash.type === 'error' ? '#fef2f2' : '#ecfdf5',
          color:      flash.type === 'error' ? '#991b1b' : '#065f46',
          border: '1px solid ' + (flash.type === 'error' ? '#fecaca' : '#a7f3d0'),
        }}>{flash.msg}</div>
      )}

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : error ? (
        <div style={{ padding: 16, color: '#991b1b', fontSize: 13 }}>{error}</div>
      ) : !current ? (
        <EmptyState campaignId={campaignId} mode={mode} />
      ) : (
        <ProspectCard
          key={current.id}
          prospect={current}
          onApprove={handleApprove}
          onDisqualify={handleDisqualify}
          onRejectResearch={handleRejectResearch}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProspectCard — the per-prospect editor.
//
// Three approval modes, all available from one form:
//   • Blank note  → skill auto-picks hook from LinkedIn + account enrichment.
//   • Note typed  → skill receives note as additional context; chooses freely.
//   • Note + "Use this as the hook" checked → skill MUST anchor on the note.
//
// The Approve button is always enabled. The LinkedIn capture badge is
// informational — researchers can leave the queue, run the Chrome extension
// on the LinkedIn profile, and come back; the badge updates on next queue
// refresh. The badge never blocks approval.
// ─────────────────────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onApprove, onDisqualify, onRejectResearch }) {
  const [summary,  setSummary]  = useState('');
  const [rejecting,    setRejecting]    = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [category, setCategory] = useState('researcher_override');
  const [source,   setSource]   = useState('');
  const [override, setOverride] = useState(false);
  const [busy,     setBusy]     = useState(false);

  // Pre-populate from existing research_meta when re-editing an already-approved.
  // When meta exists, we restore everything — including the override flag.
  // For first-time edits the category defaults to researcher_override
  // (the most honest default when there's no recorded category).
  useEffect(() => {
    const meta = prospect.researchMeta || {};
    // When research_notes holds AI research (meta.ai_research), don't put it
    // in the note box: approving would send the AI's bullets to the email
    // skill as if a person had written the hook. The AI research is shown
    // separately above; the reviewer can copy the pitch angle in on purpose.
    setSummary(meta.signal_summary || (meta.ai_research ? '' : prospect.researchNotes) || '');
    setCategory(meta.signal_category || 'researcher_override');
    setSource(meta.signal_source_url || '');
    setOverride(meta.signal_override === true);
  }, [prospect.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const hasNote = summary.trim().length > 0;

  // When the user types into an empty box, the checkbox becomes enabled but
  // stays unchecked. When they clear the box, the override flag silently
  // resets so it doesn't get submitted alongside an empty summary.
  useEffect(() => {
    if (!hasNote && override) setOverride(false);
  }, [hasNote, override]);

  const ai = prospect.researchMeta?.ai_research || null;
  const canReject = ['ready_for_review', 'failed'].includes(prospect.researchStatus);

  const submitReject = async () => {
    if (!rejectReason.trim()) return;
    setBusy(true);
    try {
      const ok = await onRejectResearch(rejectReason.trim());
      if (ok) { setRejecting(false); setRejectReason(''); }
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      await onApprove({
        // Send nulls (not empty strings) when blank — keeps research_meta
        // honest and lets the backend distinguish "no note" from "empty note".
        signalSummary:   hasNote ? summary : null,
        signalCategory:  hasNote ? category : null,
        signalSourceUrl: hasNote && source.trim() ? source.trim() : null,
        signalOverride:  hasNote && override,
      });
    } finally {
      setBusy(false);
    }
  };

  // LinkedIn capture status — green badge when a linkedin_profiles row exists,
  // amber prompt-to-capture badge when not. The data comes from the queue
  // endpoint (linkedinCapturedAt joined from linkedin_profiles).
  const captureAt   = prospect.linkedinCapturedAt;
  const activityAt  = prospect.linkedinActivityCapturedAt;
  const captureRel  = formatRelative(captureAt);
  const activityRel = formatRelative(activityAt);

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: 18,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#1A3A5C' }}>
            {prospect.firstName} {prospect.lastName}
          </div>
          <div style={{ fontSize: 13, color: '#374151', marginTop: 2 }}>
            {prospect.title}{prospect.companyName ? ` · ${prospect.companyName}` : ''}
          </div>
          {prospect.companyIndustry && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{prospect.companyIndustry}</div>
          )}

          {/* LinkedIn capture badge */}
          <div style={{ marginTop: 10 }}>
            {captureAt ? (
              <span
                title={`Captured via Chrome extension${activityAt ? ` · activity ${activityRel}` : ''}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 11, fontWeight: 600,
                  padding: '3px 9px', borderRadius: 999,
                  background: '#ecfdf5', color: '#047857',
                  border: '1px solid #a7f3d0',
                }}
              >
                ✓ LinkedIn captured · {captureRel}
                {activityAt && (
                  <span style={{ color: '#059669', fontWeight: 500 }}>
                    · {activityRel} activity
                  </span>
                )}
              </span>
            ) : (
              <span
                title="No LinkedIn capture yet — use the GoWarmCRM Chrome extension on their profile to capture about/experience/activity"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 11, fontWeight: 600,
                  padding: '3px 9px', borderRadius: 999,
                  background: '#fef3c7', color: '#92400e',
                  border: '1px solid #fcd34d',
                }}
              >
                ⚠ No LinkedIn capture — extension recommended
              </span>
            )}
          </div>
        </div>
        {prospect.linkedinUrl && (
          <a
            href={prospect.linkedinUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 12, fontWeight: 600,
              padding: '7px 12px', borderRadius: 6,
              background: '#0a66c2', color: '#fff', textDecoration: 'none',
            }}
          >
            🔗 Open LinkedIn ↗
          </a>
        )}
      </div>

      {/* AI research (step 1.1b) — what the reviewer is signing off on */}
      {ai && (
        <div style={{
          background: '#F8FAFF', border: '1px solid #E0E7FF', borderRadius: 8,
          padding: '12px 14px', marginBottom: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#3730A3' }}>🤖 AI research</span>
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {ai.model || 'AI'}
              {ai.generated_at ? ` · ${formatRelative(ai.generated_at)}` : ''}
              {prospect.researchFlagSource ? ` · flagged ${FLAG_SOURCE_LABELS[prospect.researchFlagSource] || prospect.researchFlagSource}` : ''}
              {ai.linkedin_used && (ai.linkedin_used.about || ai.linkedin_used.roles || ai.linkedin_used.posts)
                ? ` · used LinkedIn capture${ai.linkedin_used.posts ? ` (${ai.linkedin_used.posts} post${ai.linkedin_used.posts === 1 ? '' : 's'})` : ''}`
                : ' · no LinkedIn capture used'}
            </span>
            {prospect.createdVia === 'agent' && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: '#EDE9FE', color: '#5B21B6' }}>
                Added by agent
              </span>
            )}
          </div>
          {Array.isArray(ai.bullets) && ai.bullets.length > 0 ? (
            <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 13, color: '#1f2937', lineHeight: 1.5 }}>
              {ai.bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          ) : (
            <div style={{ fontSize: 13, color: '#1f2937', whiteSpace: 'pre-wrap', marginBottom: 8 }}>{ai.notes_text}</div>
          )}
          {ai.pitch_angle && (
            <div style={{ fontSize: 13, color: '#1f2937', marginBottom: 4 }}>
              <strong>Pitch angle:</strong> {ai.pitch_angle}{' '}
              <button
                onClick={() => setSummary(ai.pitch_angle)}
                title="Put the pitch angle in the researcher note so the email skill gets it as context"
                style={{ background: 'none', border: 'none', padding: 0, color: '#4F46E5', cursor: 'pointer', fontSize: 12 }}
              >
                Use as note
              </button>
            </div>
          )}
          {ai.subject_line && (
            <div style={{ fontSize: 12, color: '#4b5563' }}><strong>Subject idea:</strong> {ai.subject_line}</div>
          )}
          {ai.crisp_pitch && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#4F46E5' }}>Show draft pitch</summary>
              <div style={{ fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', marginTop: 4 }}>{ai.crisp_pitch}</div>
            </details>
          )}
        </div>
      )}

      {/* Account research callout (read-only) */}
      {(prospect.accountResearch || prospect.accountResearchMeta) && (
        <details style={{ marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6366f1', fontWeight: 600 }}>
            ▸ Show account-level research (read-only)
          </summary>
          <div style={{
            background: '#f5f3ff', padding: '10px 12px', borderRadius: 6, marginTop: 6,
            fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto',
          }}>
            {prospect.accountResearch || '(no account notes)'}
          </div>
        </details>
      )}

      {/* Researcher note (optional) */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#374151' }}>
          Researcher note <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span>
          <span style={{ color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
            — leave blank to let the AI pick its own hook from the LinkedIn capture and account data
          </span>
        </label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder={`Optional — e.g. "Mentioned at the FleetForward panel that data fragmentation is their #1 issue." Skip entirely if there's nothing specific to add.`}
          rows={4}
          style={{
            width: '100%', fontSize: 13, padding: '8px 10px',
            border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          {summary.length} / 4000 chars · Factual observation only — no pitch, no pain.
        </div>

        {/* Override checkbox — only meaningful when there's a note to override with. */}
        <label
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            marginTop: 10,
            fontSize: 12, color: hasNote ? '#374151' : '#9ca3af',
            cursor: hasNote ? 'pointer' : 'default',
          }}
        >
          <input
            type="checkbox"
            checked={override}
            disabled={!hasNote}
            onChange={e => setOverride(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            <span style={{ fontWeight: 600 }}>Use this as the hook</span>
            <span style={{ color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
              (overrides AI auto-detection — only check this if you're sure your note is stronger than any LinkedIn or account signal the AI might find)
            </span>
          </span>
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: hasNote ? '#374151' : '#9ca3af' }}>
            Signal category
          </label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            disabled={!hasNote}
            style={{
              width: '100%', fontSize: 13, padding: '6px 8px',
              border: '1px solid #d1d5db', borderRadius: 5,
              background: hasNote ? '#fff' : '#f9fafb',
              color: hasNote ? '#1a202c' : '#9ca3af',
            }}
          >
            {HOOK_CATEGORIES.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: hasNote ? '#374151' : '#9ca3af' }}>
            Source URL <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            value={source}
            onChange={e => setSource(e.target.value)}
            disabled={!hasNote}
            placeholder="https://linkedin.com/posts/..."
            style={{
              width: '100%', fontSize: 13, padding: '6px 8px',
              border: '1px solid #d1d5db', borderRadius: 5,
              background: hasNote ? '#fff' : '#f9fafb',
              color: hasNote ? '#1a202c' : '#9ca3af',
            }}
          />
        </div>
      </div>

      {/* Actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        paddingTop: 14, borderTop: '1px solid #f1f5f9',
      }}>
        <button
          onClick={() => onDisqualify('account_not_fit')}
          disabled={busy}
          style={{
            padding: '7px 12px', fontSize: 12, fontWeight: 600,
            background: '#fff', color: '#991b1b',
            border: '1px solid #fecaca', borderRadius: 6,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          ✗ Disqualify
        </button>
        {canReject && onRejectResearch && (
          <button
            onClick={() => setRejecting(r => !r)}
            disabled={busy}
            title="The research isn't good enough. The prospect stays where they are and can be flagged again."
            style={{
              padding: '7px 12px', fontSize: 12, fontWeight: 600,
              background: '#fff', color: '#92400E',
              border: '1px solid #FCD34D', borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            ↺ Reject research
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={approve}
          disabled={busy}
          title={
            hasNote
              ? (override
                  ? 'Approve — your note will be used as the email hook'
                  : 'Approve — your note will be additional context for the AI')
              : 'Approve — the AI will pick a hook from LinkedIn capture + account data'
          }
          style={{
            padding: '7px 16px', fontSize: 13, fontWeight: 600,
            background: '#10b981',
            color: '#fff', border: 'none', borderRadius: 6,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Approving…' : '✓ Approve → next'}
        </button>
      </div>

      {rejecting && (
        <div style={{ marginTop: 12, padding: 12, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#92400E' }}>
            What was wrong with the research? (required — this is how we judge research quality)
          </label>
          <textarea
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="e.g. Wrong company — they left Acme last year"
            style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button
              onClick={() => { setRejecting(false); setRejectReason(''); }}
              disabled={busy}
              style={{ padding: '6px 12px', fontSize: 12, background: '#fff', border: '1px solid #d1d5db', borderRadius: 5, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={submitReject}
              disabled={busy || !rejectReason.trim()}
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 600, border: 'none', borderRadius: 5,
                background: rejectReason.trim() ? '#B45309' : '#d1d5db', color: '#fff',
                cursor: rejectReason.trim() ? 'pointer' : 'default',
              }}
            >
              {busy ? 'Rejecting…' : 'Reject research'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ campaignId, mode }) {
  return (
    <div style={{
      padding: 40, textAlign: 'center', color: '#6b7280',
      background: '#f9fafb', borderRadius: 10, border: '1px dashed #e5e7eb',
    }}>
      {mode === 'review' ? (
        <>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1A3A5C' }}>Nothing waiting for review</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Flag prospects for research from the prospect list or panel. Results appear here once
            background research finishes (usually within a few minutes).
          </div>
        </>
      ) : campaignId ? (
        <>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎉</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1A3A5C' }}>Queue clear</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            All target-stage prospects in this campaign have been researched.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13 }}>Pick a campaign to start researching.</div>
      )}
    </div>
  );
}
