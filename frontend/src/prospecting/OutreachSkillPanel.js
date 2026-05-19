// prospecting/OutreachSkillPanel.js
//
// The outreach-personalization skill UI. Rendered as a section inside the
// Intel tab of ProspectDetailPanel. Lets a rep generate a first-touch
// outreach package (email + LinkedIn note), see the hook rationale and
// confidence notes, push the email into the OutreachComposer, and browse
// past runs for this prospect.
//
// Backend:
//   POST /api/skills/outreach-personalization/run   { prospectId, hookPreferences? }
//   GET  /api/skill-runs?skill_name=outreach-personalization&prospect_id=<id>
//   GET  /api/skill-runs/:id
//
// Props:
//   prospectId   {number}
//   onUseDraft   {fn}  ({ messageSubject, messageBody }) => void
//                       — opens the OutreachComposer pre-filled. The panel
//                       owns the composer; this just hands it a draft.

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

const TEAL = '#0F9D8E';

export default function OutreachSkillPanel({ prospectId, onUseDraft }) {
  const [hook, setHook]           = useState('');
  const [running, setRunning]     = useState(false);
  const [result, setResult]       = useState(null);   // current ephemeral result
  const [error, setError]         = useState(null);
  const [copied, setCopied]       = useState(null);    // 'email' | 'linkedin'

  // Past runs for this prospect.
  const [runs, setRuns]           = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState(null);

  // ── Load past runs (Intel tab open / after a new run) ──
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const r = await apiFetch(
        `/skill-runs?skill_name=outreach-personalization&prospect_id=${prospectId}&limit=20`
      );
      setRuns(Array.isArray(r.runs) ? r.runs : []);
    } catch (_) {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, [prospectId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // ── Generate ──
  const handleGenerate = async () => {
    setRunning(true);
    setError(null);
    setExpandedRunId(null);
    try {
      const body = { prospectId };
      if (hook) body.hookPreferences = [hook];
      const res = await apiFetch('/skills/outreach-personalization/run', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res && res.ok && res.status === 'ok') {
        setResult({
          runId: res.runId,
          output: res.output,
          model: res.usage ? null : null, // model not in run response; shown via runs list
          status: 'ok',
        });
      } else if (res && res.status === 'parse_failed') {
        setError('The model returned output that could not be parsed. Try regenerating.');
      } else {
        setError('Generation did not complete. Try again.');
      }
      loadRuns(); // refresh history
    } catch (err) {
      setError(err?.message || 'Failed to generate outreach.');
    } finally {
      setRunning(false);
    }
  };

  // ── Expand a past run — fetch its full detail ──
  const handleExpandRun = async (runId) => {
    if (expandedRunId === runId) { setExpandedRunId(null); return; }
    setExpandedRunId(runId);
    setError(null);
    try {
      const detail = await apiFetch(`/skill-runs/${runId}`);
      // skill_runs.output is the stored JSONB skill output
      if (detail && detail.output) {
        setResult({
          runId: detail.id,
          output: typeof detail.output === 'string'
            ? JSON.parse(detail.output)
            : detail.output,
          model: detail.model || null,
          status: detail.status,
          historical: true,
        });
      } else {
        setError('That run has no stored output.');
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

  const out = result?.output || null;
  const email = out?.email || {};
  const liNote = out?.linkedin_note || '';

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: TEAL, marginBottom: 2 }}>
        ✨ GENERATE OUTREACH
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
        First-touch email + LinkedIn note, personalized from this prospect's signals.
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
          {running ? '⏳ Generating…' : '▶ Generate'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12,
          background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca',
        }}>{error}</div>
      )}

      {/* Result */}
      {out && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 11, background: '#E1F5EE', color: '#0F6E56', padding: '3px 9px', borderRadius: 12 }}>
              ⚓ hook: {HOOK_LABELS[out.hook?.category] || out.hook?.category || 'n/a'}
            </span>
            {result.model && (
              <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', padding: '3px 9px', borderRadius: 12 }}>
                {result.model}
              </span>
            )}
            <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', padding: '3px 9px', borderRadius: 12 }}>
              run #{result.runId}{result.historical ? ' · past' : ''}
            </span>
          </div>

          {/* Email card */}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>✉️ Email</span>
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
            </div>
          </div>

          {/* LinkedIn note card */}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>🔗 LinkedIn note</span>
              <button onClick={() => copy(liNote, 'linkedin')} style={miniBtn(false)}>
                {copied === 'linkedin' ? '✓ Copied' : '⧉ Copy'}
              </button>
            </div>
            <div style={{ padding: '10px 12px', fontSize: 12, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {liNote || '—'}
              <span style={{ display: 'block', fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                {(liNote || '').length} / 280 characters
              </span>
            </div>
          </div>

          {/* Rationale + confidence notes */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {out.rationale && (
              <div style={{ flex: 1, minWidth: 200, background: '#f3f4f6', borderRadius: 6, padding: '9px 11px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 3 }}>💡 WHY THIS HOOK</div>
                <div style={{ fontSize: 11, color: '#4b5563', lineHeight: 1.55 }}>{out.rationale}</div>
              </div>
            )}
            {out.confidence_notes && (
              <div style={{ flex: 1, minWidth: 200, background: '#FAEEDA', borderRadius: 6, padding: '9px 11px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#633806', marginBottom: 3 }}>⚠ CONFIDENCE NOTES</div>
                <div style={{ fontSize: 11, color: '#633806', lineHeight: 1.55 }}>{out.confidence_notes}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Past runs */}
      <div style={{ marginTop: 8 }}>
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
                key={run.id}
                onClick={() => handleExpandRun(run.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                  fontSize: 12, padding: '6px 10px', borderRadius: 6,
                  background: expandedRunId === run.id ? '#e0f2f1' : '#f9fafb',
                  border: '1px solid ' + (expandedRunId === run.id ? '#a7d8d4' : '#f0f0f0'),
                }}
              >
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
