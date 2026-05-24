// prospecting/OutreachSkillPanel.js
//
// Slice 3 rewrite — the panel now calls TWO skills in parallel for the
// first-touch package:
//   POST /api/skills/outreach-email/run     (step_intent: first_touch)
//   POST /api/skills/outreach-linkedin/run  (step_intent: connection_request)
//
// The retired outreach-personalization skill emitted both at once; this UI
// preserves that user experience by aggregating two separate skill calls.
// Each call produces its own skill_runs row, so the past-runs list shows
// email runs and LinkedIn runs interleaved by timestamp.
//
// Props:
//   prospectId   {number}
//   onUseDraft   {fn}  ({ messageSubject, messageBody }) => void
//                       — opens the OutreachComposer pre-filled.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

// Hook options — values match the skill's preferred_categories enum.
const HOOK_OPTIONS = [
  { value: '',               label: 'Auto — let the skill choose' },
  { value: 'prospect_post',  label: "Prospect's own post / comment" },
  { value: 'account_event',  label: 'Account event (funding, leadership change)' },
  { value: 'tech_stack',     label: 'Tech stack overlap' },
  { value: 'role_curiosity', label: 'Role + stage curiosity' },
];

const HOOK_LABELS = {
  prospect_post:   'prospect post',
  prospect_comment:'prospect comment',
  account_post:    'account post',
  account_event:   'account event',
  tech_stack:      'tech stack',
  role_curiosity:  'role curiosity',
};

const SKILL_LABELS = {
  'outreach-email':    '✉️ Email',
  'outreach-linkedin': '🔗 LinkedIn',
};

const TEAL = '#0F9D8E';

export default function OutreachSkillPanel({ prospectId, onUseDraft }) {
  const [hook, setHook]           = useState('');
  const [running, setRunning]     = useState(false);
  const [emailResult, setEmailResult]       = useState(null);    // { runId, output, status }
  const [linkedinResult, setLinkedinResult] = useState(null);
  const [error, setError]         = useState(null);
  const [copied, setCopied]       = useState(null);   // 'email' | 'linkedin'

  // Past runs across BOTH skills, sorted newest-first.
  const [runs, setRuns]           = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState(null);

  // ── Load past runs across both new skills ──────────────────────────────────
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const [er, lr] = await Promise.all([
        apiFetch(`/skill-runs?skill_name=outreach-email&prospect_id=${prospectId}&limit=20`)
          .catch(() => ({ runs: [] })),
        apiFetch(`/skill-runs?skill_name=outreach-linkedin&prospect_id=${prospectId}&limit=20`)
          .catch(() => ({ runs: [] })),
      ]);
      const combined = [
        ...((er && Array.isArray(er.runs)) ? er.runs : []),
        ...((lr && Array.isArray(lr.runs)) ? lr.runs : []),
      ];
      // Newest first; some rows lack created_at, push them to the bottom.
      combined.sort((a, b) => {
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      });
      setRuns(combined.slice(0, 30));
    } catch (_) {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, [prospectId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // ── Generate — calls both skills in parallel ──────────────────────────────
  const handleGenerate = async () => {
    setRunning(true);
    setError(null);
    setExpandedRunId(null);
    setEmailResult(null);
    setLinkedinResult(null);
    try {
      const body = { prospectId };
      if (hook) body.hookPreferences = [hook];

      // Two skill calls in parallel. Each returns its own runId.
      const [er, lr] = await Promise.all([
        apiFetch('/skills/outreach-email/run', {
          method: 'POST',
          body: JSON.stringify({ ...body, stepIntent: 'first_touch' }),
        }).catch(err => ({ ok: false, errorMessage: err.message })),
        apiFetch('/skills/outreach-linkedin/run', {
          method: 'POST',
          body: JSON.stringify({ ...body, stepIntent: 'connection_request' }),
        }).catch(err => ({ ok: false, errorMessage: err.message })),
      ]);

      if (er && er.ok && er.status === 'ok') {
        setEmailResult({ runId: er.runId, output: er.output, status: 'ok' });
      } else if (er && er.errorMessage) {
        // One side can fail without aborting the whole flow — surface the
        // partial result. UI shows the LinkedIn output even if email failed.
        setError(prev => (prev ? prev + ' · ' : '') + 'Email: ' + er.errorMessage);
      } else if (er && er.status === 'parse_failed') {
        setError(prev => (prev ? prev + ' · ' : '') + 'Email: model output unparseable');
      }

      if (lr && lr.ok && lr.status === 'ok') {
        setLinkedinResult({ runId: lr.runId, output: lr.output, status: 'ok' });
      } else if (lr && lr.errorMessage) {
        setError(prev => (prev ? prev + ' · ' : '') + 'LinkedIn: ' + lr.errorMessage);
      } else if (lr && lr.status === 'parse_failed') {
        setError(prev => (prev ? prev + ' · ' : '') + 'LinkedIn: model output unparseable');
      }

      loadRuns();
    } catch (err) {
      setError(err?.message || 'Failed to generate outreach.');
    } finally {
      setRunning(false);
    }
  };

  // ── Expand a past run — fetch its full detail and load into the right card ─
  const handleExpandRun = async (run) => {
    if (expandedRunId === run.id) { setExpandedRunId(null); return; }
    setExpandedRunId(run.id);
    setError(null);
    try {
      const detail = await apiFetch(`/skill-runs/${run.id}`);
      if (!detail || !detail.output) {
        setError('That run has no stored output.');
        return;
      }
      const output = typeof detail.output === 'string'
        ? JSON.parse(detail.output)
        : detail.output;

      // Decide which card to populate based on the run's skill_name.
      if (run.skill_name === 'outreach-email') {
        setEmailResult({ runId: detail.id, output, status: detail.status, historical: true });
      } else if (run.skill_name === 'outreach-linkedin') {
        setLinkedinResult({ runId: detail.id, output, status: detail.status, historical: true });
      }
    } catch (err) {
      setError('Could not load that run.');
    }
  };

  const copy = (text, which) => {
    navigator.clipboard?.writeText(text || '');
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  };

  const email = emailResult?.output?.email || {};
  const linkedinBody = linkedinResult?.output?.linkedin?.body || '';
  const emailHook    = emailResult?.output?.hook;
  const linkedinHook = linkedinResult?.output?.hook;

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: TEAL, marginBottom: 2 }}>
        ✨ GENERATE OUTREACH
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        First-touch email + LinkedIn note, generated independently by two skills.
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: '#6b7280' }}>Hook</span>
        <select
          value={hook}
          onChange={(e) => setHook(e.target.value)}
          disabled={running}
          style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, flex: 1, minWidth: 180 }}
        >
          {HOOK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          onClick={handleGenerate}
          disabled={running}
          style={{
            fontSize: 12, fontWeight: 600, padding: '7px 16px', borderRadius: 6,
            border: 'none', cursor: running ? 'wait' : 'pointer',
            background: running ? '#e5e7eb' : TEAL,
            color: running ? '#6b7280' : '#fff',
          }}
        >
          {running ? '⏳ Generating both…' : '▶ Generate'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12,
          background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca',
        }}>{error}</div>
      )}

      {/* Email card */}
      {emailResult && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 11, background: '#E1F5EE', color: '#0F6E56', padding: '3px 9px', borderRadius: 12 }}>
              ⚓ hook: {HOOK_LABELS[emailHook?.category] || emailHook?.category || 'n/a'}
            </span>
            <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', padding: '3px 9px', borderRadius: 12 }}>
              run #{emailResult.runId}{emailResult.historical ? ' · past' : ''}
            </span>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>✉️ Email (first-touch)</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => copy(
                    `Subject: ${email.subject || ''}\n\n${email.body || ''}`, 'email'
                  )}
                  style={miniBtn(false)}
                >{copied === 'email' ? '✓ Copied' : '⧉ Copy'}</button>
                <button
                  onClick={() => onUseDraft && onUseDraft({
                    messageSubject: email.subject || '',
                    messageBody:    email.body || '',
                  })}
                  style={miniBtn(true)}
                >→ Use this draft</button>
              </div>
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: 12, marginBottom: 5 }}>
                <span style={{ color: '#9ca3af' }}>Subject:</span> {email.subject || '—'}
              </div>
              {email.preview_text && (
                <div style={{ fontSize: 12, marginBottom: 5 }}>
                  <span style={{ color: '#9ca3af' }}>Preview:</span> {email.preview_text}
                </div>
              )}
              <div style={{
                fontSize: 12, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                borderTop: '1px dashed #e5e7eb', paddingTop: 6,
              }}>{email.body || '—'}</div>
              {emailResult.output.rationale && (
                <div style={{
                  marginTop: 8, background: '#f3f4f6', borderRadius: 6, padding: '7px 10px',
                  fontSize: 11, color: '#4b5563',
                }}>
                  <strong style={{ color: '#6b7280' }}>Why this hook:</strong> {emailResult.output.rationale}
                </div>
              )}
              {emailResult.output.confidence_notes && (
                <div style={{
                  marginTop: 6, background: '#FAEEDA', borderRadius: 6, padding: '7px 10px',
                  fontSize: 11, color: '#633806',
                }}>
                  <strong>⚠ Confidence notes:</strong> {emailResult.output.confidence_notes}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* LinkedIn card */}
      {linkedinResult && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 11, background: '#E1F5EE', color: '#0F6E56', padding: '3px 9px', borderRadius: 12 }}>
              ⚓ hook: {HOOK_LABELS[linkedinHook?.category] || linkedinHook?.category || 'n/a'}
            </span>
            <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', padding: '3px 9px', borderRadius: 12 }}>
              run #{linkedinResult.runId}{linkedinResult.historical ? ' · past' : ''}
            </span>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>🔗 LinkedIn connection request</span>
              <button onClick={() => copy(linkedinBody, 'linkedin')} style={miniBtn(false)}>
                {copied === 'linkedin' ? '✓ Copied' : '⧉ Copy'}
              </button>
            </div>
            <div style={{ padding: '10px 12px', fontSize: 12, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {linkedinBody || '—'}
              <span style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                {(linkedinBody || '').length} / 280 characters
              </span>
              {linkedinResult.output.confidence_notes && (
                <div style={{
                  marginTop: 8, background: '#FAEEDA', borderRadius: 6, padding: '7px 10px',
                  fontSize: 11, color: '#633806',
                }}>
                  <strong>⚠ Confidence notes:</strong> {linkedinResult.output.confidence_notes}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Past runs */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', letterSpacing: 0.3, marginBottom: 6 }}>
          PAST RUNS FOR THIS PROSPECT
        </div>
        {runsLoading ? (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>
        ) : runs.length === 0 ? (
          <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
            No outreach generated for this prospect yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {runs.map(run => (
              <div
                key={`${run.skill_name}_${run.id}`}
                onClick={() => handleExpandRun(run)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                  fontSize: 12, padding: '6px 10px', borderRadius: 6,
                  background: expandedRunId === run.id ? '#e0f2f1' : '#f9fafb',
                  border: '1px solid ' + (expandedRunId === run.id ? '#a7d8d4' : '#f0f0f0'),
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600 }}>
                  {SKILL_LABELS[run.skill_name] || run.skill_name}
                </span>
                <span style={{ color: '#6b7280' }}>
                  {run.created_at ? new Date(run.created_at).toLocaleDateString() : '—'}
                </span>
                <span style={{ flex: 1, color: '#374151' }}>
                  {run.hook_category ? (HOOK_LABELS[run.hook_category] || run.hook_category) : 'no hook'}
                </span>
                <span style={{
                  fontSize: 10, padding: '1px 7px', borderRadius: 8,
                  background: run.status === 'ok' ? '#dcfce7' : '#fee2e2',
                  color:      run.status === 'ok' ? '#166534' : '#991b1b',
                }}>{run.status}</span>
                <span style={{ color: '#9ca3af', fontSize: 11 }}>#{run.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function miniBtn(primary) {
  return {
    fontSize: 11, height: 28, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid ' + (primary ? '#0F9D8E' : '#d1d5db'),
    background: primary ? '#0F9D8E' : '#fff',
    color: primary ? '#fff' : '#374151',
    fontWeight: primary ? 600 : 400,
  };
}
