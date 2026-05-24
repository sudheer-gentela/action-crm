// prospecting/ResearchQueueView.js
//
// Slice 2 — Researcher workflow. A focused, one-prospect-at-a-time editor for
// the researcher to write the signal observation that feeds personalisation.
//
// Flow:
//   1. Pick a campaign (campaign picker at top)
//   2. Queue loads `target`-stage prospects in that campaign
//   3. Current prospect shows: LinkedIn URL (click-out), account research
//      (read-only), signal summary textarea, signal category dropdown,
//      optional source URL
//   4. Approve → POST /:id/approve-research → next prospect
//   5. Skip / Disqualify → mark as disqualified with a reason
//
// Backend:
//   GET  /api/prospecting-campaigns/:id/research-queue
//   POST /api/prospects/:id/approve-research
//   PATCH /api/prospects/:id   (for disqualify)

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const HOOK_CATEGORIES = [
  { value: 'prospect_post',   label: "Prospect's own post" },
  { value: 'prospect_comment',label: "Prospect's comment on someone else's post" },
  { value: 'account_event',   label: 'Account event (funding, hiring, launch)' },
  { value: 'account_post',    label: 'Company post' },
  { value: 'tech_stack',      label: 'Tech stack overlap' },
  { value: 'role_curiosity',  label: 'Role + stage curiosity (no specific signal)' },
];

export default function ResearchQueueView() {
  const [campaigns,   setCampaigns]   = useState([]);
  const [campaignId,  setCampaignId]  = useState(null);
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

  useEffect(() => { if (campaignId) loadQueue(campaignId); }, [campaignId, loadQueue]);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 3000);
  };

  const advance = () => {
    if (idx + 1 < queue.length) {
      setIdx(idx + 1);
    } else {
      // End of current batch — reload to fetch next set.
      loadQueue(campaignId);
    }
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
      setQueue(q => q.filter((_, i) => i !== idx));
      setTotal(t => Math.max(0, t - 1));
      // idx stays the same → naturally points at the next prospect, or to the
      // end if we just removed the last one.
      if (idx >= queue.length - 1) {
        // We're at the end now; if there are more on the server, refetch.
        if (total > queue.length) loadQueue(campaignId);
      }
    } catch (err) {
      showFlash('error', 'Approve failed: ' + err.message);
    }
  };

  const handleDisqualify = async (reason) => {
    const prospect = queue[idx];
    if (!window.confirm(`Disqualify ${prospect.firstName} ${prospect.lastName}? They will be removed from outreach.`)) return;
    try {
      await apiFetch(`/prospects/${prospect.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'disqualified', reason_code: reason || 'researcher_disqualified' }),
      });
      showFlash('success', `${prospect.firstName} ${prospect.lastName} disqualified`);
      setQueue(q => q.filter((_, i) => i !== idx));
      setTotal(t => Math.max(0, t - 1));
    } catch (err) {
      showFlash('error', 'Disqualify failed: ' + err.message);
    }
  };

  const current = queue[idx];
  const remaining = queue.length - idx;

  return (
    <div className="pv-research-queue" style={{ padding: '14px 0', maxWidth: 860, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18, color: '#1A3A5C' }}>🔬 Research Queue</h3>
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
        {total > 0 && (
          <span style={{
            fontSize: 12, color: '#6b7280',
            background: '#f3f4f6', padding: '3px 10px', borderRadius: 12,
          }}>
            {remaining} of {total} pending
          </span>
        )}
      </div>

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
        <EmptyState campaignId={campaignId} />
      ) : (
        <ProspectCard
          key={current.id}
          prospect={current}
          onApprove={handleApprove}
          onDisqualify={handleDisqualify}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProspectCard — the per-prospect editor.
// ─────────────────────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onApprove, onDisqualify }) {
  const [summary,  setSummary]  = useState('');
  const [category, setCategory] = useState('prospect_post');
  const [source,   setSource]   = useState('');
  const [busy,     setBusy]     = useState(false);

  // Pre-populate from existing research_meta when re-editing an already-approved.
  useEffect(() => {
    const meta = prospect.researchMeta || {};
    setSummary(meta.signal_summary || prospect.researchNotes || '');
    setCategory(meta.signal_category || 'prospect_post');
    setSource(meta.signal_source_url || '');
  }, [prospect.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    if (!summary.trim()) return;
    setBusy(true);
    try {
      await onApprove({
        signalSummary:   summary,
        signalCategory:  category,
        signalSourceUrl: source || null,
      });
    } finally {
      setBusy(false);
    }
  };

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

      {/* Signal capture */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#374151' }}>
          Signal observation
          <span style={{ color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>
            (1–3 sentences of factual observation — what you saw on their LinkedIn)
          </span>
        </label>
        <textarea
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder={`e.g. "Posted on Apr 12 about CSAT dropping in their managed services practice. Comments thread shows 40+ peer engagements."`}
          rows={4}
          style={{
            width: '100%', fontSize: 13, padding: '8px 10px',
            border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          {summary.length} / 4000 chars · Don't write pitch or pain — just what you saw.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#374151' }}>
            Signal category
          </label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 5 }}
          >
            {HOOK_CATEGORIES.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: '#374151' }}>
            Source URL <span style={{ color: '#9ca3af', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            value={source}
            onChange={e => setSource(e.target.value)}
            placeholder="https://linkedin.com/posts/..."
            style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 5 }}
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
        <div style={{ flex: 1 }} />
        <button
          onClick={approve}
          disabled={busy || !summary.trim()}
          style={{
            padding: '7px 16px', fontSize: 13, fontWeight: 600,
            background: !summary.trim() ? '#cbd5e1' : '#10b981',
            color: '#fff', border: 'none', borderRadius: 6,
            cursor: (busy || !summary.trim()) ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Approving…' : '✓ Approve → next'}
        </button>
      </div>
    </div>
  );
}

function EmptyState({ campaignId }) {
  return (
    <div style={{
      padding: 40, textAlign: 'center', color: '#6b7280',
      background: '#f9fafb', borderRadius: 10, border: '1px dashed #e5e7eb',
    }}>
      {campaignId ? (
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
