/**
 * SequenceEnrollModal.js  v2.0
 *
 * Changes from v1:
 *   - Hard cap: max 20 prospects. UI blocks > 20 with a clear message.
 *   - AI personalisation available for 1–10 prospects only.
 *     For 11–20, enroll works but AI is hidden with an explanation.
 *   - "Personalise with AI ✨" button runs parallel AI calls per prospect
 *     using prospect data + account research notes.
 *   - Prospects with no research notes get a yellow warning badge.
 *   - Personalised content stored against enrollment only — master template untouched.
 *   - Preview per prospect before confirming.
 *
 * Props:
 *   prospects     — array of prospect objects to enroll
 *   preSequenceId — optional: pre-select a sequence
 *   onEnrolled    — callback({ enrolled, skipped })
 *   onClose
 */

import React, { useState, useEffect } from 'react';

const API = process.env.REACT_APP_API_URL || '';

function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    ...options,
  }).then(r => {
    if (!r.ok) return r.json().then(e => Promise.reject(new Error(e?.error?.message || r.statusText)));
    return r.json();
  });
}

const TEAL       = '#0F9D8E';
const TEAL_LIGHT = '#e6f7f6';
const TEAL_MID   = '#0d8a7c';

const CHANNEL_ICONS = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋' };

const MAX_ENROLL       = 20;
const MAX_AI_PERSONALISE = 10;

export default function SequenceEnrollModal({ prospects, preSequenceId, onEnrolled, onClose }) {
  const count   = prospects.length;
  const isBulk  = count > 1;
  const canAI   = count <= MAX_AI_PERSONALISE;
  const tooMany = count > MAX_ENROLL;

  // ── State ──────────────────────────────────────────────────────────────────
  const [sequences,       setSequences]      = useState([]);
  const [seqLoading,      setSeqLoading]     = useState(true);
  const [selectedSeqId,   setSelectedSeqId]  = useState(preSequenceId || null);
  const [selectedSeq,     setSelectedSeq]    = useState(null);

  const [personalising,   setPersonalising]  = useState(false);
  const [personalised,    setPersonalised]   = useState(false);
  // aiDrafts: { [prospectId]: { [stepOrder]: { subject, body, task_note } } }
  const [aiDrafts,        setAiDrafts]       = useState({});
  const [previewProspect, setPreviewProspect] = useState(prospects[0]?.id || null);

  const [enrolling,       setEnrolling]      = useState(false);
  const [error,           setError]          = useState('');
  const [modalStep,       setModalStep]      = useState(1); // 1=pick 2=preview 3=done

  // Research progress per prospect: 'pending'|'researching'|'done'|'failed'|'skipped'
  const [researchProgress, setResearchProgress] = useState({});
  const [freshlyResearched, setFreshlyResearched] = useState({});

  // ── Load sequences ─────────────────────────────────────────────────────────
  useEffect(() => {
    apiFetch('/sequences')
      .then(r => {
        setSequences(r.sequences || []);
        if (preSequenceId) {
          const found = (r.sequences || []).find(s => s.id === preSequenceId);
          if (found) setSelectedSeq(found);
        }
      })
      .catch(() => setSequences([]))
      .finally(() => setSeqLoading(false));
  }, [preSequenceId]);

  // ── Select sequence ────────────────────────────────────────────────────────
  const handleSelectSeq = async (seq) => {
    setSelectedSeqId(seq.id);
    setError('');
    setAiDrafts({});
    setPersonalised(false);
    try {
      const r = await apiFetch(`/sequences/${seq.id}`);
      setSelectedSeq(r.sequence);
      setModalStep(2);
    } catch (err) {
      setError(err.message);
    }
  };

  // ── AI Personalise (with auto-research for unresearched prospects) ──────────
  // Phase 1: sequentially research any prospects with no research_notes
  // Phase 2: parallel personalisation calls for all prospects
  const handlePersonalise = async () => {
    if (!selectedSeq?.id || !canAI) return;
    setPersonalising(true);
    setError('');
    setPersonalised(false);

    // Identify which prospects need research first
    const needsResearch = prospects.filter(p => !p.research_notes && !p.account?.research_notes);
    const alreadyHas    = prospects.filter(p => p.research_notes || p.account?.research_notes);

    // Initialise progress map
    const initProgress = {};
    prospects.forEach(p => {
      initProgress[p.id] = needsResearch.find(n => n.id === p.id) ? 'pending' : 'skipped';
    });
    setResearchProgress(initProgress);

    // Phase 1: Research unresearched prospects sequentially
    // (sequential to avoid hammering AI provider; each call is 8-15s)
    const freshResearch = {};
    if (needsResearch.length > 0) {
      for (const prospect of needsResearch) {
        setResearchProgress(prev => ({ ...prev, [prospect.id]: 'researching' }));
        try {
          await apiFetch(`/prospects/${prospect.id}/research`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          setResearchProgress(prev => ({ ...prev, [prospect.id]: 'done' }));
          freshResearch[prospect.id] = true;
        } catch (err) {
          // Research failed — personalisation will still run using basic info
          setResearchProgress(prev => ({ ...prev, [prospect.id]: 'failed' }));
        }
      }
      setFreshlyResearched(freshResearch);
    }

    // Phase 2: Personalise all prospects in parallel
    // (backend will re-fetch prospect data including any just-written research_notes)
    try {
      const results = await Promise.allSettled(
        prospects.map(p =>
          apiFetch('/sequences/ai-personalise-enrollment', {
            method: 'POST',
            body: JSON.stringify({
              sequenceId: selectedSeq.id,
              prospectId: p.id,
            }),
          }).then(r => ({ prospectId: p.id, steps: r.steps || [] }))
        )
      );

      const drafts = {};
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          const { prospectId, steps } = result.value;
          drafts[prospectId] = {};
          steps.forEach(s => { drafts[prospectId][s.step_order] = s; });
        }
      });

      setAiDrafts(drafts);
      setPersonalised(true);

      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        setError(`Personalisation completed with ${failed} error${failed > 1 ? 's' : ''}. Those prospects will use the standard template.`);
      }
    } catch (err) {
      setError('AI personalisation failed: ' + err.message);
    } finally {
      setPersonalising(false);
      setResearchProgress({});
    }
  };

  // ── Enroll ─────────────────────────────────────────────────────────────────
  const handleEnroll = async () => {
    setEnrolling(true);
    setError('');
    try {
      const r = await apiFetch('/sequences/enroll', {
        method: 'POST',
        body: JSON.stringify({
          sequenceId:        selectedSeq.id,
          prospectIds:       prospects.map(p => p.id),
          // Pass per-prospect AI drafts if available — backend stores against enrollment
          personalisedSteps: Object.keys(aiDrafts).length > 0 ? aiDrafts : undefined,
        }),
      });
      setModalStep(3);
      onEnrolled(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnrolling(false);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const currentProspect     = prospects.find(p => p.id === previewProspect);
  const draftsForProspect   = aiDrafts[previewProspect] || {};
  const hasNoResearch       = (p) => !p.research_notes && !p.account?.research_notes;
  const noResearchCount     = prospects.filter(hasNoResearch).length;

  // ── Too many prospects guard ───────────────────────────────────────────────
  if (tooMany) {
    return (
      <div onClick={onClose} style={overlayStyle}>
        <div onClick={e => e.stopPropagation()} style={modalStyle}>
          <div style={{ padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🚫</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 8 }}>
              Too many prospects selected
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24, lineHeight: 1.6 }}>
              You've selected <strong>{count} prospects</strong>. The maximum per enroll is <strong>{MAX_ENROLL}</strong>.
              Please reduce your selection and try again.
            </div>
            <button onClick={onClose} style={primaryBtn}>Got it</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main modal ─────────────────────────────────────────────────────────────
  return (
    <div onClick={onClose} style={overlayStyle}>
      <div onClick={e => e.stopPropagation()} style={modalStyle}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 22px 14px', borderBottom: '1px solid #f3f4f6', flexShrink: 0,
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
              {modalStep === 3 ? '✅ Enrolled!' : 'Enroll in Sequence'}
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {isBulk
                ? `${count} prospects selected`
                : `${prospects[0]?.first_name} ${prospects[0]?.last_name}${prospects[0]?.company_name ? ` · ${prospects[0].company_name}` : ''}`}
            </p>
          </div>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>

        {/* Stepper */}
        {modalStep < 3 && (
          <div style={{ display: 'flex', padding: '0 22px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
            {[{ n: 1, label: 'Choose Sequence' }, { n: 2, label: 'Preview & Personalise' }].map(({ n, label }) => (
              <div
                key={n}
                onClick={() => n < modalStep && setModalStep(n)}
                style={{
                  flex: 1, textAlign: 'center', padding: '12px 0 10px',
                  borderBottom: modalStep === n ? `2px solid ${TEAL}` : '2px solid transparent',
                  fontSize: 12, fontWeight: modalStep === n ? 700 : 400,
                  color: modalStep === n ? TEAL : '#9ca3af',
                  cursor: n < modalStep ? 'pointer' : 'default',
                }}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, borderRadius: '50%',
                  background: modalStep >= n ? TEAL : '#f3f4f6',
                  color: modalStep >= n ? '#fff' : '#9ca3af',
                  fontSize: 11, fontWeight: 700, marginRight: 6,
                }}>{n}</span>
                {label}
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>

          {error && (
            <div style={{ padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626', marginBottom: 14 }}>
              ⚠️ {error}
            </div>
          )}

          {/* ── STEP 1: Choose sequence ─────────────────────────────────── */}
          {modalStep === 1 && (
            <div>
              {seqLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading sequences…</div>
              ) : sequences.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <div style={{ fontSize: 13, color: '#6b7280' }}>No sequences available. Create one in the Sequences library first.</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sequences.map(seq => (
                    <div
                      key={seq.id}
                      onClick={() => handleSelectSeq(seq)}
                      style={{
                        padding: '12px 16px', borderRadius: 10,
                        border: `1.5px solid ${selectedSeqId === seq.id ? TEAL : '#e5e7eb'}`,
                        background: selectedSeqId === seq.id ? TEAL_LIGHT : '#fff',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{seq.name}</div>
                        <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#9ca3af' }}>
                          <span>{seq.step_count || 0} steps</span>
                          {seq.enrollment_count > 0 && (
                            <span style={{ color: TEAL, fontWeight: 600 }}>{seq.enrollment_count} active</span>
                          )}
                        </div>
                      </div>
                      {seq.description && (
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{seq.description}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 2: Preview & Personalise ──────────────────────────── */}
          {modalStep === 2 && selectedSeq && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* AI personalisation panel */}
              {canAI ? (
                <div style={{
                  padding: '14px 16px', borderRadius: 10,
                  background: personalised ? TEAL_LIGHT : '#f8fafc',
                  border: `1px solid ${personalised ? TEAL + '50' : '#e2e8f0'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 3 }}>
                        ✨ AI Personalisation
                      </div>
                      <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
                        {personalised
                          ? `Steps personalised for ${count} prospect${count > 1 ? 's' : ''}${Object.keys(freshlyResearched).length > 0 ? ` (${Object.keys(freshlyResearched).length} researched on the fly)` : ''}.`
                          : noResearchCount > 0
                            ? `Rewrites each step using research data. ${noResearchCount} prospect${noResearchCount > 1 ? 's' : ''} will be auto-researched first — no manual Intel tab visit needed.`
                            : `Rewrites each step using prospect research notes & account data. Each prospect gets a unique version — the master template is not changed.`}
                      </div>

                      {/* Research progress / pre-flight info */}
                      {personalising && Object.keys(researchProgress).some(id => researchProgress[id] !== 'skipped') && (
                        <div style={{
                          marginTop: 8, padding: '8px 10px',
                          background: '#f0fdf4', border: '1px solid #bbf7d0',
                          borderRadius: 6, fontSize: 11, color: '#065f46',
                          display: 'flex', flexDirection: 'column', gap: 4,
                        }}>
                          <div style={{ fontWeight: 600, marginBottom: 2 }}>
                            Phase 1 of 2 — Researching unresearched prospects…
                          </div>
                          {prospects.map(p => {
                            const st = researchProgress[p.id];
                            if (!st || st === 'skipped') return null;
                            const icon = st === 'researching' ? '⏳' : st === 'done' ? '✓' : st === 'failed' ? '⚠️' : '○';
                            const col  = st === 'done' ? '#059669' : st === 'failed' ? '#dc2626' : st === 'researching' ? TEAL : '#9ca3af';
                            return (
                              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: col }}>
                                <span>{icon}</span>
                                <span>{p.first_name} {p.last_name}</span>
                                {st === 'failed' && <span style={{ color: '#9ca3af' }}>(will use basic info)</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Pre-flight info when not yet running */}
                      {!personalising && !personalised && noResearchCount > 0 && (
                        <div style={{
                          marginTop: 8, padding: '7px 10px',
                          background: '#f0fdf4', border: '1px solid #bbf7d0',
                          borderRadius: 6, fontSize: 11, color: '#065f46',
                        }}>
                          🔍 {noResearchCount} prospect{noResearchCount > 1 ? 's have' : ' has'} no Intel data — will auto-research before personalising.
                        </div>
                      )}
                    </div>
                    <button
                      onClick={handlePersonalise}
                      disabled={personalising}
                      style={{
                        padding: '8px 16px', borderRadius: 8, border: 'none',
                        background: personalising ? '#f0fdfa' : personalised ? '#fff' : TEAL,
                        color: personalising ? TEAL : personalised ? TEAL : '#fff',
                        border: personalised ? `1px solid ${TEAL}` : 'none',
                        fontSize: 12, fontWeight: 600,
                        cursor: personalising ? 'wait' : 'pointer',
                        whiteSpace: 'nowrap', flexShrink: 0,
                      }}
                    >
                      {personalising
                        ? (() => {
                            const researching = Object.values(researchProgress).filter(s => s === 'researching').length;
                            const researchDone = Object.values(researchProgress).filter(s => s === 'done' || s === 'failed').length;
                            const researchTotal = Object.values(researchProgress).filter(s => s !== 'skipped').length;
                            if (researchTotal > 0 && researchDone < researchTotal) {
                              return `🔍 Researching… (${researchDone}/${researchTotal})`;
                            }
                            return `⏳ Personalising…`;
                          })()
                        : personalised
                          ? '✓ Re-personalise'
                          : noResearchCount > 0
                            ? `✨ Research & Personalise (${noResearchCount} need research)`
                            : '✨ Personalise with AI'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{
                  padding: '12px 14px', background: '#f8fafc',
                  border: '1px solid #e2e8f0', borderRadius: 8,
                  fontSize: 12, color: '#6b7280',
                }}>
                  ℹ️ AI personalisation is available for up to {MAX_AI_PERSONALISE} prospects. You're enrolling {count} — steps will use the template as-is with tokens replaced at send time.
                </div>
              )}

              {/* Prospect picker for preview (bulk only) */}
              {isBulk && (
                <div>
                  <label style={labelStyle}>Preview for prospect</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {prospects.map(p => {
                      const noResearch = hasNoResearch(p);
                      const isSelected = previewProspect === p.id;
                      const isDrafted  = !!aiDrafts[p.id];
                      return (
                        <div
                          key={p.id}
                          onClick={() => setPreviewProspect(p.id)}
                          style={{
                            padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                            fontSize: 12, fontWeight: isSelected ? 600 : 400,
                            border: `1.5px solid ${isSelected ? TEAL : '#e5e7eb'}`,
                            background: isSelected ? TEAL_LIGHT : '#fff',
                            color: isSelected ? TEAL_MID : '#374151',
                            display: 'flex', alignItems: 'center', gap: 5,
                          }}
                        >
                          {p.first_name} {p.last_name}
                          {noResearch && !freshlyResearched[p.id] && <span title="No research data">⚠️</span>}
                          {freshlyResearched[p.id] && <span title="Freshly researched" style={{ color: '#059669' }}>🔍</span>}
                          {isDrafted && <span title="AI personalised" style={{ color: TEAL }}>✨</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Steps preview */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(selectedSeq.steps || []).map((step, idx) => {
                  const draft   = draftsForProspect[step.step_order];
                  const subject = draft?.subject || step.subject_template;
                  const body    = draft?.body    || step.body_template;
                  const note    = draft?.task_note || step.task_note;

                  return (
                    <div key={step.id} style={{
                      border: '1px solid #e5e7eb', borderRadius: 9,
                      overflow: 'hidden', background: '#fff',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '9px 14px', background: '#f9fafb',
                        borderBottom: '1px solid #f3f4f6',
                      }}>
                        <span style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: TEAL, color: '#fff',
                          fontSize: 11, fontWeight: 700, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>{idx + 1}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                          {CHANNEL_ICONS[step.channel] || '📋'} {step.channel}
                        </span>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>
                          {step.delay_days === 0 ? (idx === 0 ? 'Day 0' : 'same day') : `+${step.delay_days} days`}
                        </span>
                        {draft && (
                          <span style={{
                            marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                            color: TEAL_MID, background: TEAL_LIGHT,
                            padding: '2px 8px', borderRadius: 10,
                          }}>✨ AI personalised</span>
                        )}
                      </div>
                      {(subject || body || note) && (
                        <div style={{ padding: '10px 14px' }}>
                          {subject && (
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#1a202c', marginBottom: 4 }}>
                              {subject}
                            </div>
                          )}
                          {body && (
                            <div style={{
                              fontSize: 12, color: '#374151', lineHeight: 1.6,
                              whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden',
                              maskImage: 'linear-gradient(to bottom, black 60%, transparent)',
                              WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent)',
                            }}>
                              {body}
                            </div>
                          )}
                          {note && !subject && (
                            <div style={{ fontSize: 12, color: '#6b7280', fontStyle: 'italic' }}>{note}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── STEP 3: Done ────────────────────────────────────────────── */}
          {modalStep === 3 && (
            <div style={{ textAlign: 'center', padding: '30px 20px' }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>🚀</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 6 }}>
                {count > 1 ? `${count} prospects enrolled!` : `${prospects[0]?.first_name} enrolled!`}
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
                In <strong>{selectedSeq?.name}</strong>
              </div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 24 }}>
                First step will fire on schedule. Track progress in the Enrollments tab.
              </div>
              <button onClick={onClose} style={primaryBtn}>Done</button>
            </div>
          )}
        </div>

        {/* Footer */}
        {modalStep < 3 && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 22px', borderTop: '1px solid #f3f4f6', flexShrink: 0,
          }}>
            <div>
              {modalStep === 2 && isBulk && (
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                  Enrolling {count} prospect{count > 1 ? 's' : ''}
                  {personalised ? ' with AI personalisation' : ''}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {modalStep === 2 && (
                <button onClick={() => setModalStep(1)} style={ghostBtn}>← Back</button>
              )}
              {modalStep === 2 && (
                <button
                  onClick={handleEnroll}
                  disabled={enrolling || !selectedSeq}
                  style={{
                    ...primaryBtn,
                    background: enrolling ? '#9ca3af' : TEAL,
                    cursor: enrolling ? 'not-allowed' : 'pointer',
                    opacity: enrolling ? 0.8 : 1,
                  }}
                >
                  {enrolling
                    ? '⏳ Enrolling…'
                    : `🚀 Enroll${isBulk ? ` ${count} Prospects` : ''}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
};

const modalStyle = {
  background: '#fff', borderRadius: 14,
  width: 660, maxWidth: '95vw', maxHeight: '90vh',
  display: 'flex', flexDirection: 'column',
  boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
  overflow: 'hidden',
};

const closeBtn = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb',
  background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 14,
};

const primaryBtn = {
  padding: '9px 24px', borderRadius: 8, border: 'none',
  background: TEAL, color: '#fff',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

const ghostBtn = {
  padding: '8px 18px', borderRadius: 7, border: '1px solid #e5e7eb',
  background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer',
};

const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3,
};
