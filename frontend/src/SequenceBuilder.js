/**
 * SequenceBuilder.js  v2.0
 *
 * Changes from v1:
 *   - Each step has an AI / Manual mode toggle (default: AI)
 *   - description field repurposed as "Tone & Goal" — AI brief for whole sequence
 *   - Single "Generate AI Steps ✨" button writes all AI-mode steps at once
 *     via POST /sequences/ai-build
 *   - Manual steps are fully editable and never touched by AI
 *   - AI steps show a placeholder until generated; fields are editable after
 *   - Re-generating overwrites AI steps silently
 *
 * Props:
 *   sequence  — existing sequence object (null = create new)
 *   onSave    — called with saved sequence
 *   onClose   — close / cancel handler
 */

import React, { useState, useCallback } from 'react';

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

const CHANNEL_OPTIONS = [
  { value: 'email',    label: '✉️  Email',    hasContent: true  },
  { value: 'linkedin', label: '🔗  LinkedIn',  hasContent: true  },
  { value: 'call',     label: '📞  Call',      hasContent: false },
  { value: 'task',     label: '📋  Task',      hasContent: false },
];

const TEMPLATE_TOKENS = ['{{first_name}}', '{{last_name}}', '{{full_name}}', '{{title}}', '{{company}}', '{{industry}}'];

function blankStep(order) {
  return {
    _id:              Date.now() + Math.random(),
    id:               null,
    step_order:       order,
    channel:          'email',
    delay_days:       order === 1 ? 0 : 3,
    mode:             'ai',
    ai_generated:     false,
    subject_template: '',
    body_template:    '',
    task_note:        '',
    require_approval: null, // null = inherit from sequence
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function SequenceBuilder({ sequence: initialSequence, onSave, onClose }) {
  const isEdit = !!initialSequence?.id;

  const [name,            setName]            = useState(initialSequence?.name        || '');
  const [toneGoal,        setToneGoal]        = useState(initialSequence?.description || '');
  const [requireApproval, setRequireApproval] = useState(
    initialSequence?.require_approval !== undefined ? initialSequence.require_approval : true
  );
  const [steps, setSteps] = useState(
    (initialSequence?.steps || []).length > 0
      ? initialSequence.steps.map(s => ({
          ...s,
          _id:              s.id,
          mode:             s.mode || 'manual',
          ai_generated:     false,
          require_approval: s.require_approval !== undefined ? s.require_approval : null,
        }))
      : [blankStep(1)]
  );

  const [saving,       setSaving]       = useState(false);
  const [generating,   setGenerating]   = useState(false);
  const [error,        setError]        = useState('');
  const [generated,    setGenerated]    = useState(false);
  const [expandedStep, setExpandedStep] = useState(steps[0]?._id || null);

  const aiStepCount = steps.filter(s => s.mode === 'ai').length;

  // ── Step CRUD ──────────────────────────────────────────────────────────────

  const addStep = () => {
    const ns = blankStep(steps.length + 1);
    setSteps(prev => [...prev, ns]);
    setExpandedStep(ns._id);
  };

  const removeStep = (tempId) => {
    setSteps(prev =>
      prev.filter(s => s._id !== tempId).map((s, i) => ({ ...s, step_order: i + 1 }))
    );
  };

  const updateStep = useCallback((tempId, field, value) => {
    setSteps(prev => prev.map(s => s._id === tempId ? { ...s, [field]: value } : s));
  }, []);

  const toggleMode = useCallback((tempId) => {
    setSteps(prev => prev.map(s => {
      if (s._id !== tempId) return s;
      const newMode = s.mode === 'ai' ? 'manual' : 'ai';
      return { ...s, mode: newMode, ai_generated: newMode === 'manual' ? false : s.ai_generated };
    }));
  }, []);

  const moveStep = (tempId, dir) => {
    setSteps(prev => {
      const idx     = prev.findIndex(s => s._id === tempId);
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (idx < 0 || swapIdx < 0 || swapIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next.map((s, i) => ({ ...s, step_order: i + 1 }));
    });
  };

  // ── AI Generate ────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!name.trim()) { setError('Please enter a sequence name first.'); return; }
    if (aiStepCount === 0) { setError('Mark at least one step as AI to generate.'); return; }

    setGenerating(true);
    setError('');
    setGenerated(false);

    try {
      const aiSteps = steps
        .filter(s => s.mode === 'ai')
        .map(s => ({ step_order: s.step_order, channel: s.channel, delay_days: s.delay_days }));

      const res = await apiFetch('/sequences/ai-build', {
        method: 'POST',
        body: JSON.stringify({
          goal:      (toneGoal || name).trim(),
          stepCount: aiSteps.length,
          channels:  [...new Set(aiSteps.map(s => s.channel))],
          steps:     aiSteps,
        }),
      });

      // Map generated content back by step_order
      const generatedMap = {};
      (res.steps || []).forEach(g => { generatedMap[g.step_order] = g; });

      setSteps(prev => prev.map(s => {
        if (s.mode !== 'ai') return s;
        const g = generatedMap[s.step_order];
        if (!g) return s;
        return {
          ...s,
          subject_template: g.subject_template || s.subject_template,
          body_template:    g.body_template    || s.body_template,
          task_note:        g.task_note        || s.task_note,
          ai_generated:     true,
        };
      }));

      setGenerated(true);
      const firstAiStep = steps.find(s => s.mode === 'ai');
      if (firstAiStep) setExpandedStep(firstAiStep._id);

    } catch (err) {
      setError('AI generation failed: ' + err.message);
    } finally {
      setGenerating(false);
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!name.trim()) { setError('Sequence name is required.'); return; }
    setSaving(true);
    setError('');

    const stepsPayload = steps.map(s => ({ ...s, mode: s.mode }));

    try {
      let saved;
      if (isEdit) {
        await apiFetch(`/sequences/${initialSequence.id}`, {
          method: 'PUT',
          body:   JSON.stringify({ name, description: toneGoal, require_approval: requireApproval }),
        });
        const existingIds = (initialSequence.steps || []).map(s => s.id);
        const currentIds  = stepsPayload.filter(s => s.id).map(s => s.id);
        for (const eid of existingIds) {
          if (!currentIds.includes(eid)) {
            await apiFetch(`/sequences/${initialSequence.id}/steps/${eid}`, { method: 'DELETE' });
          }
        }
        for (const step of stepsPayload) {
          if (step.id) {
            await apiFetch(`/sequences/${initialSequence.id}/steps/${step.id}`, {
              method: 'PUT', body: JSON.stringify(step),
            });
          } else {
            await apiFetch(`/sequences/${initialSequence.id}/steps`, {
              method: 'POST', body: JSON.stringify(step),
            });
          }
        }
        const ids = stepsPayload.filter(s => s.id).map(s => s.id);
        if (ids.length) {
          await apiFetch(`/sequences/${initialSequence.id}/steps/reorder`, {
            method: 'POST', body: JSON.stringify({ order: ids }),
          });
        }
        const reloaded = await apiFetch(`/sequences/${initialSequence.id}`);
        saved = reloaded.sequence;
      } else {
        const res = await apiFetch('/sequences', {
          method: 'POST',
          body:   JSON.stringify({ name, description: toneGoal, require_approval: requireApproval, steps: stepsPayload }),
        });
        saved = res.sequence;
      }
      onSave(saved);
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 24px 14px', borderBottom: '1px solid #e5e7eb', flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: TEAL, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>
            Sequence Builder
          </div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
            {isEdit ? 'Edit Sequence' : 'New Sequence'}
          </h3>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '8px 20px', borderRadius: 8, border: 'none',
              background: saving ? '#9ca3af' : TEAL, color: '#fff',
              fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Sequence'}
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {error && (
          <div style={{ padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#dc2626' }}>
            ⚠️ {error}
          </div>
        )}

        {/* Sequence name */}
        <div>
          <label style={labelStyle}>Sequence Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. VP Finance Cold Outreach — Q3"
            style={{ ...inputStyle, width: '100%' }}
          />
        </div>

        {/* Tone & Goal */}
        <div>
          <label style={labelStyle}>
            Tone & Goal
            <span style={{ marginLeft: 6, fontSize: 10, color: '#9ca3af', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              — AI uses this to write all AI steps
            </span>
          </label>
          <textarea
            value={toneGoal}
            onChange={e => setToneGoal(e.target.value)}
            placeholder="e.g. Professional but conversational. Targeting VP Finance at mid-market SaaS. Focus on cost savings and reducing manual reporting time."
            rows={3}
            style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

        {/* Draft approval setting */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: 8,
          background: requireApproval ? '#f0fdf4' : '#f9fafb',
          border: `1px solid ${requireApproval ? '#bbf7d0' : '#e5e7eb'}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              📋 Draft before sending
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {requireApproval
                ? 'Email steps go to Drafts for review before sending (default)'
                : 'Email steps fire automatically when due'}
            </div>
          </div>
          <button
            onClick={() => setRequireApproval(v => !v)}
            style={{
              position: 'relative', width: 40, height: 22, borderRadius: 11,
              border: 'none', cursor: 'pointer', flexShrink: 0,
              background: requireApproval ? TEAL : '#d1d5db',
              transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: 3,
              left: requireApproval ? 21 : 3,
              width: 16, height: 16, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        <div style={{ borderTop: '1px solid #f0f0f0' }} />

        {/* Steps header + Generate button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Steps</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              {aiStepCount} AI · {steps.length - aiStepCount} Manual
            </div>
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating || aiStepCount === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', borderRadius: 9,
              background: aiStepCount === 0 ? '#f3f4f6' : generating ? TEAL_MID : TEAL,
              color: aiStepCount === 0 ? '#9ca3af' : '#fff',
              border: 'none', fontSize: 13, fontWeight: 600,
              cursor: aiStepCount === 0 ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s',
              boxShadow: aiStepCount > 0 && !generating ? '0 2px 8px rgba(15,157,142,0.25)' : 'none',
            }}
          >
            {generating
              ? '⟳ Generating…'
              : `✨ Generate ${aiStepCount > 0 ? aiStepCount + ' ' : ''}AI Step${aiStepCount !== 1 ? 's' : ''}`}
          </button>
        </div>

        {/* Success banner */}
        {generated && !generating && (
          <div style={{
            padding: '10px 14px', background: TEAL_LIGHT,
            border: `1px solid ${TEAL}40`, borderRadius: 8,
            fontSize: 12, color: TEAL_MID, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            ✅ AI steps generated — review and edit below, then save.
          </div>
        )}

        {/* Steps list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {steps.map((step, idx) => (
            <StepCard
              key={step._id}
              step={step}
              index={idx}
              total={steps.length}
              expanded={expandedStep === step._id}
              seqRequireApproval={requireApproval}
              onToggle={() => setExpandedStep(expandedStep === step._id ? null : step._id)}
              onChange={(field, val) => updateStep(step._id, field, val)}
              onRemove={() => removeStep(step._id)}
              onToggleMode={() => toggleMode(step._id)}
              onMoveUp={() => moveStep(step._id, 'up')}
              onMoveDown={() => moveStep(step._id, 'down')}
            />
          ))}
        </div>

        {/* Add step */}
        <button onClick={addStep} style={{
          width: '100%', padding: '10px',
          border: '2px dashed #e5e7eb', borderRadius: 8,
          background: '#fafafa', color: '#9ca3af',
          fontSize: 13, fontWeight: 500, cursor: 'pointer',
        }}>
          + Add Step
        </button>

        {/* Token hint */}
        <div style={{
          padding: '8px 12px', background: '#fffbeb',
          border: '1px solid #fde68a', borderRadius: 7,
          fontSize: 11, color: '#92400e',
        }}>
          💡 Tokens: {TEMPLATE_TOKENS.map(t => (
            <code key={t} style={{ background: '#fef3c7', padding: '1px 4px', borderRadius: 3, marginRight: 4 }}>{t}</code>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP CARD
// ─────────────────────────────────────────────────────────────────────────────

function StepCard({ step, index, total, expanded, seqRequireApproval, onToggle, onChange, onRemove, onToggleMode, onMoveUp, onMoveDown }) {
  const channelCfg = CHANNEL_OPTIONS.find(c => c.value === step.channel) || CHANNEL_OPTIONS[0];
  const isAI       = step.mode === 'ai';
  const hasContent = channelCfg.hasContent;

  // Effective approval for display: step override wins, else sequence setting
  const effectiveApproval = step.require_approval !== null && step.require_approval !== undefined
    ? step.require_approval
    : seqRequireApproval;
  const isEmailChannel = step.channel === 'email';

  return (
    <div style={{
      border: `1.5px solid ${expanded ? TEAL : '#e5e7eb'}`,
      borderRadius: 10, background: '#fff', overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', cursor: 'pointer',
        background: expanded ? TEAL_LIGHT : '#fff', userSelect: 'none',
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: '50%',
          background: expanded ? TEAL : '#f3f4f6',
          color: expanded ? '#fff' : '#6b7280',
          fontSize: 11, fontWeight: 700, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {index + 1}
        </div>

        <span style={{ fontSize: 13, color: '#374151' }}>{channelCfg.label}</span>
        <span style={{ fontSize: 11, color: '#9ca3af' }}>
          {step.delay_days === 0 ? (index === 0 ? 'Day 0' : 'same day') : `+${step.delay_days}d`}
        </span>

        {isAI && !step.ai_generated && (
          <span style={{
            fontSize: 10, fontWeight: 600, color: TEAL,
            background: TEAL_LIGHT, padding: '2px 7px', borderRadius: 20,
            border: `1px solid ${TEAL}40`,
          }}>✨ AI</span>
        )}

        {(step.subject_template || step.task_note) && (
          <span style={{
            flex: 1, fontSize: 11, color: '#6b7280',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {step.subject_template || step.task_note}
          </span>
        )}

        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
          <div
            onClick={e => { e.stopPropagation(); onToggleMode(); }}
            style={{
              padding: '3px 10px', borderRadius: 20,
              border: `1px solid ${isAI ? TEAL : '#d1d5db'}`,
              background: isAI ? TEAL_LIGHT : '#f9fafb',
              cursor: 'pointer', fontSize: 11, fontWeight: 600,
              color: isAI ? TEAL : '#6b7280', transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}
          >
            {isAI ? '✨ AI' : '✏️ Manual'}
          </div>
          {index > 0 && (
            <button onClick={e => { e.stopPropagation(); onMoveUp(); }} style={iconBtn}>▲</button>
          )}
          {index < total - 1 && (
            <button onClick={e => { e.stopPropagation(); onMoveDown(); }} style={iconBtn}>▼</button>
          )}
          <button
            onClick={e => { e.stopPropagation(); if (window.confirm('Remove this step?')) onRemove(); }}
            style={{ ...iconBtn, color: '#ef4444', borderColor: '#fecaca' }}
          >✕</button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '14px', borderTop: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Channel</label>
              <select value={step.channel} onChange={e => onChange('channel', e.target.value)} style={selectStyle}>
                {CHANNEL_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div style={{ width: 150 }}>
              <label style={labelStyle}>{index === 0 ? 'Delay from enroll (days)' : 'Delay from prev (days)'}</label>
              <input
                type="number" min="0" max="365"
                value={step.delay_days}
                onChange={e => onChange('delay_days', parseInt(e.target.value) || 0)}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
          </div>

          {/* Step-level approval override (email steps only) */}
          {isEmailChannel && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderRadius: 7,
              background: '#f9fafb', border: '1px solid #e5e7eb',
            }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                <span style={{ fontWeight: 600, color: '#374151' }}>Draft setting: </span>
                {step.require_approval === null || step.require_approval === undefined
                  ? `Use sequence default (${seqRequireApproval ? 'draft' : 'auto-send'})`
                  : step.require_approval ? 'Always draft' : 'Always auto-send'}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[
                  { label: 'Inherit', value: null },
                  { label: 'Draft',   value: true  },
                  { label: 'Send',    value: false  },
                ].map(opt => (
                  <button
                    key={String(opt.value)}
                    onClick={() => onChange('require_approval', opt.value)}
                    style={{
                      padding: '3px 9px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                      border: '1px solid',
                      borderColor: step.require_approval === opt.value ? TEAL : '#e5e7eb',
                      background:  step.require_approval === opt.value ? TEAL : '#fff',
                      color:       step.require_approval === opt.value ? '#fff' : '#6b7280',
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* AI mode */}
          {isAI && (
            <div style={{
              padding: '12px 14px',
              background: step.ai_generated ? '#f8fffd' : TEAL_LIGHT,
              border: `1px solid ${TEAL}25`, borderRadius: 8,
            }}>
              {!step.ai_generated ? (
                <div style={{ fontSize: 12, color: TEAL_MID, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>✨</span>
                  <span>AI will write this step using the <strong>Tone & Goal</strong> above. Hit <strong>Generate AI Steps</strong> when ready.</span>
                </div>
              ) : hasContent ? (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ ...labelStyle, color: TEAL }}>
                      Subject <span style={{ fontWeight: 400, color: '#9ca3af', textTransform: 'none', letterSpacing: 0 }}>— AI generated, editable</span>
                    </label>
                    <input value={step.subject_template} onChange={e => onChange('subject_template', e.target.value)}
                      style={{ ...inputStyle, width: '100%', background: '#fff' }} />
                  </div>
                  <div>
                    <label style={{ ...labelStyle, color: TEAL }}>
                      Body <span style={{ fontWeight: 400, color: '#9ca3af', textTransform: 'none', letterSpacing: 0 }}>— AI generated, editable</span>
                    </label>
                    <textarea value={step.body_template} onChange={e => onChange('body_template', e.target.value)}
                      rows={7} style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit', background: '#fff' }} />
                  </div>
                </>
              ) : (
                <div>
                  <label style={{ ...labelStyle, color: TEAL }}>
                    Task Note <span style={{ fontWeight: 400, color: '#9ca3af', textTransform: 'none', letterSpacing: 0 }}>— AI generated, editable</span>
                  </label>
                  <input value={step.task_note} onChange={e => onChange('task_note', e.target.value)}
                    style={{ ...inputStyle, width: '100%', background: '#fff' }} />
                </div>
              )}
            </div>
          )}

          {/* Manual mode */}
          {!isAI && hasContent && (
            <>
              <div>
                <label style={labelStyle}>Subject Template</label>
                <input value={step.subject_template} onChange={e => onChange('subject_template', e.target.value)}
                  placeholder="e.g. Quick question for {{first_name}}" style={{ ...inputStyle, width: '100%' }} />
              </div>
              <div>
                <label style={labelStyle}>Body Template</label>
                <textarea value={step.body_template} onChange={e => onChange('body_template', e.target.value)}
                  placeholder={`Hi {{first_name}},\n\nI noticed {{company}} recently...\n\nWould it make sense to connect?`}
                  rows={7} style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }} />
              </div>
            </>
          )}
          {!isAI && !hasContent && (
            <div>
              <label style={labelStyle}>Task Note</label>
              <input value={step.task_note} onChange={e => onChange('task_note', e.target.value)}
                placeholder="e.g. Call and introduce yourself, reference the email sent on day 0"
                style={{ ...inputStyle, width: '100%' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Micro-styles ──────────────────────────────────────────────────────────────
const iconBtn = {
  padding: '2px 6px', borderRadius: 4, border: '1px solid #e5e7eb',
  background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer',
};
const ghostBtn = {
  padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb',
  background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer',
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3,
};
const inputStyle = {
  padding: '8px 11px', borderRadius: 7,
  border: '1px solid #e5e7eb', fontSize: 13,
  boxSizing: 'border-box', outline: 'none',
  fontFamily: 'inherit', color: '#111', background: '#fff',
};
const selectStyle = { ...inputStyle, width: '100%' };
