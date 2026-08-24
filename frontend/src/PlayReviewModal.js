// ─────────────────────────────────────────────────────────────────────────────
// PlayReviewModal.js — the review loop on a checklist task (2026_130)
//
//   mode 'submit'   assignee sends work for review, with evidence
//   mode 'approve'  manager accepts it, reading the evidence that was submitted
//   mode 'reject'   manager sends it back, with a reason
//
// Modal rather than inline, for the same reason PlayDateModal is: asking
// someone else to trust your work, and revoking that trust, are both acts that
// should take a deliberate click. An inline control invites them to happen by
// accident, and an accidental rejection lands in somebody's inbox.
//
// Styling deliberately mirrors ProjectPlayModals.js — same Shell, same palette,
// same button shapes. This is one more step in an existing flow, not a new
// surface, and it should not announce itself as one.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { apiService } from './apiService';

const C = {
  line: '#e5e7eb', muted: '#6b7280', danger: '#b91c1c',
  warn: '#b45309', warnBg: '#fef3c7', ok: '#047857', accent: '#0369a1',
};

const TARGET_LABEL = {
  completed: 'Completed',
  skipped:   'Skipped',
  cancelled: 'Cancelled',
};

const TARGET_HELP = {
  completed: 'The work is done and ready to be accepted.',
  skipped:   'This step will not happen and does not need to.',
  cancelled: 'This step is being removed from the plan.',
};

function Shell({ title, onClose, children, width = 520 }) {
  return (
    <>
      <div onClick={onClose}
           style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2000 }} />
      <div role="dialog" aria-label={title}
           style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                    width: `min(${width}px, 94vw)`, maxHeight: '86vh', overflowY: 'auto',
                    background: '#fff', borderRadius: 10, zIndex: 2001,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.22)' }}>
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.line}`,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <button onClick={onClose} aria-label="Close"
                  style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: C.muted }}>×</button>
        </div>
        <div style={{ padding: '16px 18px' }}>{children}</div>
      </div>
    </>
  );
}

const inputStyle = {
  width: '100%', padding: '8px 10px', border: `1px solid ${C.line}`,
  borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box',
};

function Btn({ children, onClick, disabled, tone = 'default' }) {
  const tones = {
    default: { bg: '#fff',    fg: '#374151', bd: C.line },
    primary: { bg: '#1d4ed8', fg: '#fff',    bd: '#1d4ed8' },
    ok:      { bg: C.ok,      fg: '#fff',    bd: C.ok },
    danger:  { bg: '#fff',    fg: C.danger,  bd: '#fecaca' },
  };
  const t = tones[tone] || tones.default;
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        padding: '7px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600,
        border: `1px solid ${t.bd}`, background: t.bg, color: t.fg,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}>
      {children}
    </button>
  );
}

/**
 * @param {object}   play      the checklist row
 * @param {string}   mode      'submit' | 'approve' | 'reject'
 * @param {function} onDone    called after a successful transition
 */
export function PlayReviewModal({ handoverId, play, mode, onClose, onDone }) {
  const [target,   setTarget]   = useState('completed');
  const [evidence, setEvidence] = useState('');
  const [reason,   setReason]   = useState('');
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState(null);
  const [blockers, setBlockers] = useState(null);

  useEffect(() => {
    setTarget(play?.reviewTargetStatus || 'completed');
    setEvidence('');
    setReason('');
    setErr(null);
    setBlockers(null);
  }, [play?.playInstanceId, mode, play?.reviewTargetStatus]);

  if (!play) return null;

  const submittedEvidence = play.reviewEvidence?.snippet || null;

  const run = async (body) => {
    setSaving(true); setErr(null); setBlockers(null);
    try {
      await apiService.handovers.transitionPlay(handoverId, play.playInstanceId, body);
      onDone?.();
      onClose?.();
    } catch (e) {
      const payload = e?.response?.data?.error;
      setErr(payload?.message || 'That did not go through. Try again.');
      // Name what is actually in the way. "Blocked by: Foundation sign-off" is
      // something the person can go and fix; "409" is not.
      const names = [
        ...(payload?.blockedBy || []).map(b => b.title),
        ...(payload?.stageBlockedBy || []).map(n => `stage ${n}`),
      ];
      if (names.length) setBlockers(names);
    } finally {
      setSaving(false);
    }
  };

  // ── Submit ───────────────────────────────────────────────────────────────
  if (mode === 'submit') {
    return (
      <Shell title={`Send for review — ${play.title}`} onClose={onClose}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          What are you asking for?
        </label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          {Object.keys(TARGET_LABEL).map(k => (
            <button key={k} onClick={() => setTarget(k)}
              style={{
                flex: 1, padding: '8px 6px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                cursor: 'pointer',
                border: `1px solid ${target === k ? '#bfdbfe' : C.line}`,
                background: target === k ? '#eff6ff' : '#fff',
                color: target === k ? '#1d4ed8' : '#6b7280',
              }}>
              {TARGET_LABEL[k]}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>{TARGET_HELP[target]}</div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          Evidence <span style={{ color: C.danger }}>(required)</span>
        </label>
        <textarea
          value={evidence} onChange={e => setEvidence(e.target.value)} rows={5}
          placeholder="What was done, and where it landed. A drawing number, a link, a summary of the call — whatever lets the reviewer check it without asking you."
          style={{ ...inputStyle, resize: 'vertical' }} />
        <div style={{ fontSize: 11, color: C.muted, margin: '6px 0 16px' }}>
          Text is fine. Files go on the task itself and stay attached to it.
        </div>

        {err && <ErrorBox message={err} blockers={blockers} />}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn tone="primary" disabled={saving || !evidence.trim()}
               onClick={() => run({ to: 'in_review', targetStatus: target, evidence: evidence.trim() })}>
            {saving ? 'Sending…' : 'Send for review'}
          </Btn>
        </div>
      </Shell>
    );
  }

  // ── Approve ──────────────────────────────────────────────────────────────
  if (mode === 'approve') {
    const asked = play.reviewTargetStatus || 'completed';
    return (
      <Shell title={`Review — ${play.title}`} onClose={onClose}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
          {play.reviewSubmittedByName || 'The assignee'} asked for this to be marked
          {' '}<strong style={{ color: '#111827' }}>{TARGET_LABEL[asked].toLowerCase()}</strong>.
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, margin: '14px 0 6px' }}>Evidence submitted</div>
        <div style={{
          border: `1px solid ${C.line}`, borderRadius: 6, padding: '10px 12px',
          background: '#f8fafc', fontSize: 13, whiteSpace: 'pre-wrap',
          color: submittedEvidence ? '#111827' : C.muted, marginBottom: 16,
        }}>
          {submittedEvidence || 'Nothing was submitted with this.'}
        </div>

        {err && <ErrorBox message={err} blockers={blockers} />}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <Btn tone="danger" disabled={saving}
               onClick={() => { setErr(null); onDone?.('reject'); }}>
            Send back
          </Btn>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={onClose} disabled={saving}>Close</Btn>
            <Btn tone="ok" disabled={saving} onClick={() => run({ to: asked })}>
              {saving ? 'Approving…' : `Approve as ${TARGET_LABEL[asked].toLowerCase()}`}
            </Btn>
          </div>
        </div>
      </Shell>
    );
  }

  // ── Reject ───────────────────────────────────────────────────────────────
  return (
    <Shell title={`Send back — ${play.title}`} onClose={onClose}>
      <div style={{
        border: `1px solid #fde68a`, background: C.warnBg, color: C.warn,
        borderRadius: 6, padding: '9px 11px', fontSize: 12, marginBottom: 14,
      }}>
        This moves the task back to In progress and tells the assignee and everyone
        on the alert list. Any work queued off its completion is withdrawn.
      </div>

      {submittedEvidence && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Evidence submitted</div>
          <div style={{
            border: `1px solid ${C.line}`, borderRadius: 6, padding: '10px 12px',
            background: '#f8fafc', fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 14,
          }}>{submittedEvidence}</div>
        </>
      )}

      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Why is it going back? <span style={{ color: C.danger }}>(required)</span>
      </label>
      <textarea
        value={reason} onChange={e => setReason(e.target.value)} rows={4}
        placeholder="What is missing or wrong, and what would make it acceptable."
        style={{ ...inputStyle, resize: 'vertical' }} />
      <div style={{ fontSize: 11, color: C.muted, margin: '6px 0 16px' }}>
        This is saved to the task's notes, so it is still there the next time
        anyone looks at why this slipped.
      </div>

      {err && <ErrorBox message={err} blockers={blockers} />}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
        <Btn tone="danger" disabled={saving || !reason.trim()}
             onClick={() => run({ to: 'in_progress', reason: reason.trim() })}>
          {saving ? 'Sending back…' : 'Send back'}
        </Btn>
      </div>
    </Shell>
  );
}

function ErrorBox({ message, blockers }) {
  return (
    <div style={{
      border: '1px solid #fecaca', background: '#fef2f2', color: C.danger,
      borderRadius: 6, padding: '9px 11px', fontSize: 12, marginBottom: 14,
    }}>
      <div>{message}</div>
      {blockers?.length > 0 && (
        <div style={{ marginTop: 6, fontWeight: 600 }}>
          Waiting on: {blockers.join(', ')}
        </div>
      )}
    </div>
  );
}

export default PlayReviewModal;
