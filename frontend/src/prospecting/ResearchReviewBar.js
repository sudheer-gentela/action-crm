// prospecting/ResearchReviewBar.js
//
// Step 1.1b — research status and sign-off for one prospect, shown in the
// prospect panel's Intel tab.
//
//   Not flagged / failed / reviewed → "Flag for background research"
//   Queued or failed                → "Remove flag"
//   Ready for review                → "Approve research" (target → research)
//                                     and "Reject research" (reason required)
//
// Research never moves the stage by itself any more — including the manual
// "Generate Research Notes" button — so this bar is where a person signs off
// from the panel. Approve here sends no hook note; to add one, use the
// Research Queue, which has the full note / category / override form.
//
// Rejecting judges the research, not the prospect: stage unchanged, stored in
// research_review_* (never Disqualify / Nurture), and the prospect can be
// flagged again.

import React, { useState } from 'react';
import { apiFetch } from './prospectingShared';

const PRE_OUTREACH = ['target', 'research'];

const STATUS = {
  queued:           { label: 'Queued for research',  bg: '#EEF2FF', fg: '#3730A3' },
  researching:      { label: 'Researching now…',     bg: '#EEF2FF', fg: '#3730A3' },
  ready_for_review: { label: 'Ready for review',     bg: '#FEF3C7', fg: '#92400E' },
  failed:           { label: 'Research failed',      bg: '#FCEBEB', fg: '#A32D2D' },
};

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).endsWith('Z') || String(ts).includes('+') ? ts : `${ts}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function ResearchReviewBar({ prospect, onChanged }) {
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason,    setReason]    = useState('');

  if (!prospect) return null;
  const status   = prospect.research_status || null;
  const outcome  = prospect.research_review_outcome || null;
  const preOut   = PRE_OUTREACH.includes(prospect.stage);
  const fit      = prospect.research_fit || null;

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setRejecting(false);
      setReason('');
      if (onChanged) await onChanged();
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const flag    = () => run(() => apiFetch(`/prospects/${prospect.id}/flag-research`, { method: 'POST', body: '{}' }));
  const unflag  = () => run(() => apiFetch(`/prospects/${prospect.id}/flag-research`, { method: 'DELETE' }));
  const approve = () => run(() => apiFetch(`/prospects/${prospect.id}/approve-research`, {
    method: 'POST',
    body: JSON.stringify({ signalSummary: null, signalCategory: null, signalSourceUrl: null, signalOverride: false }),
  }));
  const reject  = () => run(() => apiFetch(`/prospects/${prospect.id}/reject-research`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason.trim() }),
  }));

  const chip = STATUS[status];
  const canFlag   = preOut && (!status || status === 'failed' || status === 'reviewed');
  const canUnflag = status === 'queued' || status === 'failed';
  const canReview = status === 'ready_for_review';

  // Nothing useful to show for a prospect past Research that was never in the pipeline.
  if (!preOut && !status && !outcome) return null;

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', marginBottom: 12,
      background: canReview ? '#FFFBEB' : '#fff',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Research</span>
        {chip ? (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: chip.bg, color: chip.fg }}>
            {chip.label}
          </span>
        ) : outcome ? (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            background: outcome === 'approved' ? '#E1F5EE' : '#FAEEDA',
            color:      outcome === 'approved' ? '#0F6E56' : '#854F0B',
          }}>
            {outcome === 'approved' ? 'Approved' : 'Research rejected'}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: '#6b7280' }}>Not flagged</span>
        )}
        {status === 'queued' && prospect.research_next_attempt_at && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>runs after {fmtWhen(prospect.research_next_attempt_at)}</span>
        )}
        {outcome && prospect.research_reviewed_at && !chip && (
          <span style={{ fontSize: 11, color: '#6b7280' }}>{fmtWhen(prospect.research_reviewed_at)}</span>
        )}

        <div style={{ flex: 1 }} />

        {canReview && (
          <>
            <button onClick={approve} disabled={busy} style={btn('#10b981', '#fff', 'none')}
                    title={prospect.stage === 'target' ? 'Approve and move to Research' : 'Approve this research'}>
              ✓ Approve research
            </button>
            <button onClick={() => setRejecting(r => !r)} disabled={busy} style={btn('#fff', '#92400E', '1px solid #FCD34D')}
                    title="The research isn't good enough. The prospect stays where they are and can be flagged again.">
              ↺ Reject research
            </button>
          </>
        )}
        {canFlag && (
          <button onClick={flag} disabled={busy} style={btn('#fff', '#0F766E', '1px solid #0F9D8E')}
                  title="Queue background AI research. You'll approve or reject the result.">
            🔎 {status === 'failed' ? 'Try research again' : 'Flag for background research'}
          </button>
        )}
        {canUnflag && (
          <button onClick={unflag} disabled={busy} style={btn('#fff', '#374151', '1px solid #d1d5db')}>
            Remove flag
          </button>
        )}
      </div>

      {status === 'failed' && prospect.research_last_error && (
        <div style={{ fontSize: 12, color: '#991b1b', marginTop: 6 }}>Last error: {prospect.research_last_error}</div>
      )}
      {status === 'queued' && prospect.research_last_error && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Paused: {prospect.research_last_error}</div>
      )}
      {outcome === 'rejected' && !chip && prospect.research_review_reason && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Reason: {prospect.research_review_reason}</div>
      )}
      {!status && fit && fit.verdict === 'disqualified' && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          Not flagged when added — fit check: {(fit.reasons || []).join('; ') || 'did not pass'}.
          You can still flag them.
        </div>
      )}
      {canReview && (
        <div style={{ fontSize: 11, color: '#92400E', marginTop: 6 }}>
          Approving here adds no hook note. To add one, use Prospecting → Research → Ready for review.
        </div>
      )}

      {rejecting && (
        <div style={{ marginTop: 10 }}>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="What was wrong with the research? (required)"
            style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button onClick={() => { setRejecting(false); setReason(''); }} disabled={busy} style={btn('#fff', '#374151', '1px solid #d1d5db')}>
              Cancel
            </button>
            <button onClick={reject} disabled={busy || !reason.trim()}
                    style={btn(reason.trim() ? '#B45309' : '#d1d5db', '#fff', 'none')}>
              {busy ? 'Rejecting…' : 'Reject research'}
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>⚠️ {error}</div>}
    </div>
  );
}

function btn(bg, fg, border) {
  return {
    padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6,
    background: bg, color: fg, border, cursor: 'pointer',
  };
}
