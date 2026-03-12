/**
 * SequenceEnrollModal.js
 *
 * Modal for enrolling one or multiple prospects into a sequence.
 *
 * Flow:
 *  1. Pick (or confirm) sequence from list
 *  2. Show step preview — AI-fill option per prospect
 *  3. Review → Enroll
 *
 * Props:
 *   prospects     — array of prospect objects to enroll (single or bulk)
 *   preSequenceId — optional: pre-select a specific sequence
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

const TEAL = '#0F9D8E';

const CHANNEL_ICONS = { email: '✉️', linkedin: '🔗', call: '📞', task: '📋' };

export default function SequenceEnrollModal({ prospects, preSequenceId, onEnrolled, onClose }) {
  const isBulk = prospects.length > 1;

  // Step 1: pick sequence
  const [sequences,       setSequences]       = useState([]);
  const [seqLoading,      setSeqLoading]       = useState(true);
  const [selectedSeqId,   setSelectedSeqId]    = useState(preSequenceId || null);
  const [selectedSeq,     setSelectedSeq]      = useState(null);

  // Step 2: AI preview
  const [aiGenerating,    setAiGenerating]     = useState(false);
  const [aiDrafts,        setAiDrafts]         = useState({});   // keyed by prospectId
  const [previewProspect, setPreviewProspect]  = useState(prospects[0]?.id || null);

  // Step 3: enroll
  const [enrolling,       setEnrolling]        = useState(false);
  const [error,           setError]            = useState('');
  const [step,            setStep]             = useState(1); // 1 = pick, 2 = preview, 3 = done

  useEffect(() => {
    apiFetch('/sequences')
      .then(r => {
        setSequences(r.sequences || []);
        if (preSequenceId) {
          const found = r.sequences.find(s => s.id === preSequenceId);
          if (found) setSelectedSeq(found);
        }
      })
      .catch(() => setSequences([]))
      .finally(() => setSeqLoading(false));
  }, [preSequenceId]);

  const handleSelectSeq = async (seq) => {
    setSelectedSeqId(seq.id);
    setError('');
    // Load full sequence with steps
    try {
      const r = await apiFetch(`/sequences/${seq.id}`);
      setSelectedSeq(r.sequence);
      setStep(2);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAiGenerate = async () => {
    if (!selectedSeq?.id || !previewProspect) return;
    setAiGenerating(true);
    setError('');
    try {
      const r = await apiFetch(`/sequences/${selectedSeq.id}/ai-generate`, {
        method: 'POST',
        body: JSON.stringify({ prospectId: previewProspect }),
      });
      setAiDrafts(prev => ({ ...prev, [previewProspect]: r.generatedSteps || [] }));
    } catch (err) {
      setError('AI generation failed: ' + err.message);
    } finally {
      setAiGenerating(false);
    }
  };

  const handleEnroll = async () => {
    setEnrolling(true);
    setError('');
    try {
      const r = await apiFetch('/sequences/enroll', {
        method: 'POST',
        body: JSON.stringify({
          sequenceId: selectedSeq.id,
          prospectIds: prospects.map(p => p.id),
        }),
      });
      setStep(3);
      onEnrolled(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnrolling(false);
    }
  };

  const currentProspect = prospects.find(p => p.id === previewProspect);
  const draftsForProspect = aiDrafts[previewProspect] || [];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14,
          width: 640, maxWidth: '95vw', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}
      >
        {/* ── Modal Header ──────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 22px 14px', borderBottom: '1px solid #f3f4f6',
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
              {step === 3 ? '✅ Enrolled!' : 'Enroll in Sequence'}
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {isBulk
                ? `${prospects.length} prospects selected`
                : `${prospects[0]?.first_name} ${prospects[0]?.last_name}`}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb',
              background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 14,
            }}
          >✕</button>
        </div>

        {/* ── Stepper ───────────────────────────────────────────────────── */}
        {step < 3 && (
          <div style={{
            display: 'flex', gap: 0, padding: '12px 22px 0',
            borderBottom: '1px solid #f3f4f6',
          }}>
            {[
              { n: 1, label: 'Choose Sequence' },
              { n: 2, label: 'Preview & AI Fill' },
            ].map(({ n, label }) => (
              <div
                key={n}
                style={{
                  flex: 1, textAlign: 'center', paddingBottom: 10,
                  borderBottom: step === n ? `2px solid ${TEAL}` : '2px solid transparent',
                  fontSize: 12, fontWeight: step === n ? 700 : 400,
                  color: step === n ? TEAL : '#9ca3af',
                  cursor: n < step ? 'pointer' : 'default',
                }}
                onClick={() => n < step && setStep(n)}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 20, height: 20, borderRadius: '50%',
                  background: step >= n ? TEAL : '#f3f4f6',
                  color: step >= n ? '#fff' : '#9ca3af',
                  fontSize: 11, fontWeight: 700, marginRight: 6,
                }}>{n}</span>
                {label}
              </div>
            ))}
          </div>
        )}

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>

          {error && (
            <div style={{
              marginBottom: 12, padding: '8px 12px',
              background: '#fef2f2', border: '1px solid #fecaca',
              borderRadius: 7, fontSize: 12, color: '#dc2626',
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* ── STEP 1: Pick sequence ─────────────────────────────────── */}
          {step === 1 && (
            <div>
              {seqLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading sequences…</div>
              ) : sequences.length === 0 ? (
                <div style={{
                  textAlign: 'center', padding: 40, color: '#6b7280',
                }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>📭</div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>No sequences yet</div>
                  <div style={{ fontSize: 12 }}>Create a sequence first from the Sequences tab.</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sequences.map(seq => (
                    <div
                      key={seq.id}
                      onClick={() => handleSelectSeq(seq)}
                      style={{
                        padding: '12px 16px', borderRadius: 9,
                        border: `1px solid ${selectedSeqId === seq.id ? TEAL : '#e5e7eb'}`,
                        background: selectedSeqId === seq.id ? '#f0fdf4' : '#fff',
                        cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: 12,
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <div style={{
                        width: 38, height: 38, borderRadius: 8,
                        background: '#f0fdf4', border: '1px solid #bbf7d0',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 18, flexShrink: 0,
                      }}>📨</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{seq.name}</div>
                        {seq.description && (
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>{seq.description}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8, fontSize: 11, color: '#9ca3af' }}>
                        <span>{seq.step_count || 0} steps</span>
                        {seq.enrollment_count > 0 && (
                          <span style={{ color: TEAL }}>{seq.enrollment_count} active</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 2: Preview ───────────────────────────────────────── */}
          {step === 2 && selectedSeq && (
            <div>
              {/* Prospect picker for preview (bulk only) */}
              {isBulk && (
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>
                    PREVIEW FOR PROSPECT
                  </label>
                  <select
                    value={previewProspect}
                    onChange={e => { setPreviewProspect(parseInt(e.target.value)); setAiDrafts({}); }}
                    style={{
                      padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db',
                      fontSize: 12, background: '#fff',
                    }}
                  >
                    {prospects.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.first_name} {p.last_name} — {p.company_name || p.account?.name || ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* AI fill */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                marginBottom: 14, padding: '10px 14px',
                background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0',
              }}>
                <div style={{ flex: 1, fontSize: 12, color: '#374151' }}>
                  <strong>✨ AI Fill</strong> — personalise subject + body for{' '}
                  <strong>{currentProspect?.first_name} {currentProspect?.last_name}</strong>
                  {' '}using their research data
                </div>
                <button
                  onClick={handleAiGenerate}
                  disabled={aiGenerating}
                  style={{
                    padding: '6px 14px', borderRadius: 7,
                    background: aiGenerating ? '#f0fdfa' : TEAL,
                    color: aiGenerating ? TEAL : '#fff',
                    border: `1px solid ${TEAL}`,
                    fontSize: 12, fontWeight: 600, cursor: aiGenerating ? 'wait' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {aiGenerating ? '⏳ Generating…' : 'Generate'}
                </button>
              </div>

              {/* Steps preview */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(selectedSeq.steps || []).map((step, idx) => {
                  const draft = draftsForProspect.find(d => d.step_order === step.step_order);
                  const subject = draft?.subject || step.subject_template;
                  const body    = draft?.body    || step.body_template;

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
                          fontSize: 11, fontWeight: 700,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>{idx + 1}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                          {CHANNEL_ICONS[step.channel] || '📋'} {step.channel}
                        </span>
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>
                          {step.delay_days === 0
                            ? idx === 0 ? 'Day 0' : 'same day'
                            : `+${step.delay_days} days`}
                        </span>
                        {draft && (
                          <span style={{
                            marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                            color: '#065f46', background: '#d1fae5',
                            padding: '2px 7px', borderRadius: 10,
                          }}>✨ AI filled</span>
                        )}
                      </div>
                      {(subject || body || step.task_note) && (
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
                            }}>
                              {body}
                            </div>
                          )}
                          {step.task_note && (
                            <div style={{ fontSize: 12, color: '#6b7280', fontStyle: 'italic' }}>
                              {step.task_note}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {isBulk && (
                <div style={{
                  marginTop: 14, padding: '10px 14px',
                  background: '#fffbeb', border: '1px solid #fde68a',
                  borderRadius: 7, fontSize: 12, color: '#92400e',
                }}>
                  ⚠️ Preview shown for <strong>{currentProspect?.first_name}</strong>.
                  All <strong>{prospects.length}</strong> selected prospects will be enrolled
                  — each will use their own research data when steps fire.
                </div>
              )}
            </div>
          )}

          {/* ── STEP 3: Done ──────────────────────────────────────────── */}
          {step === 3 && (
            <div style={{ textAlign: 'center', padding: '30px 20px' }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>🚀</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 6 }}>
                Enrolled {prospects.length > 1 ? `${prospects.length} prospects` : prospects[0]?.first_name}
              </div>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
                In <strong>{selectedSeq?.name}</strong> — first step will fire on schedule.
              </div>
              <button
                onClick={onClose}
                style={{
                  padding: '9px 28px', borderRadius: 7, border: 'none',
                  background: TEAL, color: '#fff', fontSize: 13,
                  fontWeight: 600, cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        {step < 3 && (
          <div style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            padding: '12px 22px', borderTop: '1px solid #f3f4f6',
          }}>
            {step === 2 && (
              <button
                onClick={() => setStep(1)}
                style={{
                  padding: '8px 18px', borderRadius: 7, border: '1px solid #e5e7eb',
                  background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer',
                }}
              >
                ← Back
              </button>
            )}
            {step === 2 && (
              <button
                onClick={handleEnroll}
                disabled={enrolling || !selectedSeq}
                style={{
                  padding: '8px 22px', borderRadius: 7, border: 'none',
                  background: enrolling ? '#9ca3af' : TEAL,
                  color: '#fff', fontSize: 13, fontWeight: 600,
                  cursor: enrolling ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {enrolling ? '⏳ Enrolling…' : `🚀 Enroll${isBulk ? ` ${prospects.length} Prospects` : ''}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
