// prospecting/PreviewDraftsModal.js
//
// Slice 4 — Preview personalisation for 1-5 prospects WITHOUT enrolling them
// or sending anything. Calls POST /api/sequences/:id/preview which runs the
// dispatcher in-memory and returns the full personalised steps.
//
// Usage: opened from CampaignDetailDrawer's "Preview drafts" button. Caller
// passes the sequenceId (from campaign.default_sequence_id) and a list of
// prospect IDs to preview (capped at 5).

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

const TEAL = '#0F9D8E';

const INTENT_LABEL = {
  first_touch:         'First touch',
  follow_up:           'Follow-up',
  breakup:             'Breakup',
  connection_request:  'Connection req',
  post_accept_message: 'Post-accept DM',
  nurture_dm:          'Nurture DM',
};
const INTENT_COLOR = {
  first_touch:         { bg: '#dcfce7', fg: '#166534' },
  follow_up:           { bg: '#dbeafe', fg: '#1e40af' },
  breakup:             { bg: '#fee2e2', fg: '#991b1b' },
  connection_request:  { bg: '#e0e7ff', fg: '#3730a3' },
  post_accept_message: { bg: '#fef3c7', fg: '#92400e' },
  nurture_dm:          { bg: '#f3e8ff', fg: '#6b21a8' },
};

const CHANNEL_ICON = {
  email:    '✉️',
  linkedin: '🔗',
  call:     '📞',
  task:     '📋',
};

// Hook categories the skill can emit. The "generic" set means no prospect-
// specific signal was available and the draft fell back to role/segment-level
// framing — the rep should know that before sending.
const HOOK_LABEL = {
  prospect_post:      'Recent post',
  prospect_bio:       'Profile / experience',
  account_post:       'Company post',
  account_event:      'Company event',
  tech_stack:         'Tech stack',
  role_curiosity:     'Role curiosity',
  researcher_override: 'Researcher note',
  none_available:     'No signal',
};
const GENERIC_HOOKS = new Set(['tech_stack', 'role_curiosity', 'none_available']);

// Cost is small per preview; show enough precision to be meaningful without
// pretending to bill-grade accuracy. Under a tenth of a cent reads as "<$0.001".
function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.001) return '<$0.001';
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  return `${(v / 1000).toFixed(1)}k`;
}

export default function PreviewDraftsModal({ sequenceId, prospectIds, runSkill: runSkillProp = true, onClose }) {
  const [loading, setLoading] = useState(true);
  const [data, setData]       = useState(null);
  const [error, setError]     = useState('');
  const [selectedProspect, setSelectedProspect] = useState(0);
  // Mirrors BatchActivateModal's "Run AI personalisation" toggle. When OFF the
  // backend renders the sequence templates verbatim (no skill calls, no
  // tokens), so a non-AI campaign previews exactly what it will send.
  const [runSkill, setRunSkill] = useState(runSkillProp !== false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const r = await apiFetch(`/sequences/${sequenceId}/preview`, {
          method: 'POST',
          body: JSON.stringify({ prospectIds: prospectIds.slice(0, 5), runSkill }),
        });
        if (!cancelled) setData(r);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Preview failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sequenceId, prospectIds, runSkill]);

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()}
           style={{ maxWidth: 920, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="pv-modal-header">
          <h3>👁️ Preview drafts</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: '#1A3A5C' }}>
            <input
              type="checkbox"
              checked={runSkill}
              onChange={e => setRunSkill(e.target.checked)}
            />
            <span>Run AI personalisation per prospect</span>
          </label>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6, marginLeft: 22 }}>
            {runSkill
              ? 'Generates personalisation for the selected prospects without enrolling them. Nothing is sent. Skill calls consume API tokens — refreshing re-runs the calls.'
              : 'Shows the sequence templates exactly as they will send when AI is off. No skill calls, no API tokens used.'}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#6b7280' }}>
            <div style={{ fontSize: 14 }}>
              {runSkill ? '🪄 Running dispatcher' : '📋 Rendering templates'} for {prospectIds.length} prospect{prospectIds.length === 1 ? '' : 's'}…
            </div>
            {runSkill && (
              <div style={{ fontSize: 12, marginTop: 6, color: '#9ca3af' }}>~3-6 seconds per step per prospect.</div>
            )}
          </div>
        ) : error ? (
          <div style={{ padding: 30 }}>
            <div style={{
              background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
              padding: 14, borderRadius: 8, fontSize: 13,
            }}>{error}</div>
          </div>
        ) : data ? (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* Left sidebar: prospect picker */}
            <div style={{
              width: 260, borderRight: '1px solid #e5e7eb', overflowY: 'auto',
              background: '#fafafa', padding: '8px 0',
            }}>
              <div style={{
                fontSize: 11, color: '#9ca3af', fontWeight: 600, padding: '6px 14px', letterSpacing: 0.4,
              }}>
                PROSPECTS ({data.previews.length})
              </div>
              {data.previews.map((p, idx) => {
                const isActive = idx === selectedProspect;
                const hasError = !!p.error;
                return (
                  <div
                    key={p.prospectId}
                    onClick={() => setSelectedProspect(idx)}
                    style={{
                      padding: '10px 14px', cursor: 'pointer',
                      background: isActive ? '#fff' : 'transparent',
                      borderLeft: '3px solid ' + (isActive ? TEAL : 'transparent'),
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: hasError ? '#991b1b' : '#1A3A5C' }}>
                      {p.prospectName || `Prospect ${p.prospectId}`}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      {p.prospectCompany || '—'}
                    </div>
                    <div style={{ fontSize: 10, color: hasError ? '#991b1b' : '#9ca3af', marginTop: 4 }}>
                      {hasError
                        ? '⚠ error'
                        : (p.steps?.length || 0) === 0
                          ? <span style={{ color: '#991b1b' }}>⚠ 0 steps</span>
                          : `${p.steps?.length || 0} step${p.steps.length === 1 ? '' : 's'}${runSkill ? ' personalised' : ''}`}
                    </div>
                    {runSkill && !hasError && p.cost && p.cost.runCount > 0 && (
                      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
                        {formatUsd(p.cost.costUsd)} · {formatTokens(p.cost.inputTokens + p.cost.outputTokens)} tokens
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Right: selected prospect's steps */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
              <PreviewStepsPanel preview={data.previews[selectedProspect]} />
            </div>
          </div>
        ) : null}

        {/* Footer */}
        <div style={{
          padding: '12px 20px', borderTop: '1px solid #f0f0f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 12, color: '#6b7280',
        }}>
          <div>
            {data && (
              <>
                ✓ {data.summary.succeeded} of {data.summary.requested} previewed
                {data.summary.failed > 0 && <span style={{ color: '#991b1b', marginLeft: 6 }}>· {data.summary.failed} failed</span>}
                {runSkill && data.costSummary && data.costSummary.runCount > 0 && (
                  <span style={{ marginLeft: 6 }}>
                    · this preview cost {formatUsd(data.costSummary.totalCostUsd)}
                    {' '}({formatTokens(data.costSummary.inputTokens + data.costSummary.outputTokens)} tokens, {data.costSummary.runCount} skill {data.costSummary.runCount === 1 ? 'call' : 'calls'})
                  </span>
                )}
              </>
            )}
          </div>
          <button className="pv-btn-primary" onClick={onClose}>Close preview</button>
        </div>
      </div>
    </div>
  );
}

function PreviewStepsPanel({ preview }) {
  if (!preview) return null;

  if (preview.error) {
    return (
      <div style={{
        background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
        padding: 14, borderRadius: 8, fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Preview failed for this prospect</div>
        <div>{preview.error}</div>
      </div>
    );
  }

  if (!preview.steps || preview.steps.length === 0) {
    // Slice-6: empty steps is the dispatcher's "nothing personalisable" signal,
    // which can happen for two reasons:
    //   1. Sequence really has no email/linkedin steps (all call/task) — rare
    //   2. Every step errored — usually because the skill couldn't find enough
    //      data on the prospect (no LinkedIn profile captured, no research
    //      notes, sparse account_events)
    //
    // Surface the dispatcher's error list prominently so the rep knows what
    // to fix. If errors mention data gaps, point at LinkedIn capture + research
    // approval as the fix paths.
    const errs = preview.errors || [];
    const dispatchTotal = preview.dispatchSummary?.total || 0;
    const dispatchErrored = preview.dispatchSummary?.errored || 0;
    const dispatchSkipped = preview.dispatchSummary?.skipped || 0;
    const allErrored = dispatchTotal > 0 && dispatchErrored === dispatchTotal;

    return (
      <div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#1A3A5C' }}>{preview.prospectName}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{preview.prospectCompany || '—'}</div>
        </div>
        <div style={{
          background: allErrored ? '#fef2f2' : '#fffbeb',
          border: `1px solid ${allErrored ? '#fecaca' : '#fde68a'}`,
          color: allErrored ? '#991b1b' : '#92400e',
          padding: 14, borderRadius: 8, fontSize: 13, marginBottom: 10,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {allErrored ? 'Personalisation failed for every step' : 'No personalisable steps produced'}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            {dispatchTotal > 0 ? (
              <>
                Out of {dispatchTotal} step{dispatchTotal === 1 ? '' : 's'}: {' '}
                {dispatchErrored > 0 && <>{dispatchErrored} errored</>}
                {dispatchErrored > 0 && dispatchSkipped > 0 && ', '}
                {dispatchSkipped > 0 && <>{dispatchSkipped} skipped (call/task steps)</>}.
              </>
            ) : (
              <>The sequence has no email or LinkedIn steps to personalise.</>
            )}
          </div>
          {allErrored && (
            <div style={{ fontSize: 12, marginTop: 10, padding: 10, background: 'rgba(255,255,255,0.5)', borderRadius: 4 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Most common cause: not enough data on this prospect.</div>
              <ol style={{ margin: '6px 0 0 18px', padding: 0, lineHeight: 1.6 }}>
                <li><strong>Capture their LinkedIn profile.</strong> Open the prospect's LinkedIn page with the Chrome extension installed — it auto-fills the prospect's headline, about, and experience into the database.</li>
                <li><strong>Approve research with notes.</strong> Use the Research Queue tab to write a 1-3 sentence signal observation (what's compelling about them right now), then approve.</li>
                <li><strong>Re-run this preview</strong> after capturing the data.</li>
              </ol>
            </div>
          )}
        </div>
        {errs.length > 0 && (
          <div style={{
            padding: 12, borderRadius: 6,
            background: '#f8fafc', border: '1px solid #e5e7eb', fontSize: 11, color: '#475569',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Dispatcher details:</div>
            <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
              {errs.map((e, i) => (
                <li key={i}>Step {e.stepOrder} ({e.channel}): {e.reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1A3A5C' }}>{preview.prospectName}</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{preview.prospectCompany || '—'}</div>
      </div>

      {preview.steps.map((step, idx) => (
        <PreviewStepCard key={idx} step={step} />
      ))}

      {preview.errors && preview.errors.length > 0 && (
        <div style={{
          marginTop: 16, padding: 12, borderRadius: 6,
          background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 12,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Dispatcher notes:</div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {preview.errors.map((e, i) => (
              <li key={i}>Step {e.stepOrder}: {e.reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PreviewStepCard({ step }) {
  const channelIcon = CHANNEL_ICON[step.channel] || '📋';
  const intentLabel = step.intent ? INTENT_LABEL[step.intent] : null;
  const intentColor = step.intent ? INTENT_COLOR[step.intent] : null;
  const isEmail = step.channel === 'email';

  const hookCategory = step.personalize_sources?.hook?.category || null;
  const hookLabel = hookCategory ? (HOOK_LABEL[hookCategory] || hookCategory) : null;
  const isGenericHook = hookCategory ? GENERIC_HOOKS.has(hookCategory) : false;

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
      marginBottom: 12, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
      }}>
        <span style={{
          background: '#fff', border: '1px solid #d1d5db', borderRadius: 12,
          padding: '2px 10px', fontSize: 11, fontWeight: 600, color: '#374151',
        }}>
          Step {step.step_order}
        </span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>{channelIcon} {step.channel}</span>
        {intentLabel && intentColor && (
          <span style={{
            fontSize: 10, fontWeight: 600,
            padding: '2px 8px', borderRadius: 10,
            background: intentColor.bg, color: intentColor.fg,
          }}>
            {intentLabel}
            {step.intent_source === 'override' && (
              <span style={{ marginLeft: 4, opacity: 0.7 }}>●</span>
            )}
          </span>
        )}
        {hookLabel && (
          <span
            title={isGenericHook
              ? 'No prospect-specific signal — generic fallback. Consider capturing a recent post or adding a research note.'
              : `Hook: ${hookLabel}`}
            style={{
              fontSize: 10, fontWeight: 600, marginLeft: 'auto',
              padding: '2px 8px', borderRadius: 10,
              background: isGenericHook ? '#fef3c7' : '#dcfce7',
              color: isGenericHook ? '#92400e' : '#166534',
            }}
          >
            {isGenericHook ? '⚠ ' : ''}{hookLabel}
          </span>
        )}
      </div>

      <div style={{ padding: 14 }}>
        {isEmail && step.subject && (
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            <span style={{ color: '#9ca3af' }}>Subject:</span> <strong>{step.subject}</strong>
          </div>
        )}
        {!isEmail && step.task_note && (
          <div style={{
            fontSize: 11, color: '#6b7280', marginBottom: 8,
            background: '#f3f4f6', padding: '6px 10px', borderRadius: 6,
          }}>
            🔹 {step.task_note}
          </div>
        )}
        <div style={{
          fontSize: 13, color: '#374151', lineHeight: 1.6,
          whiteSpace: 'pre-wrap', fontFamily: 'inherit',
        }}>
          {step.body || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>(empty)</span>}
        </div>
        {!isEmail && (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
            {(step.body || '').length} characters
          </div>
        )}
      </div>
    </div>
  );
}
