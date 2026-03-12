/**
 * SequenceBuilder.js
 *
 * Full sequence builder UI:
 *  - Create / edit a sequence name + description
 *  - Add / edit / remove / reorder steps (channel, delay, subject template, body template)
 *  - "AI Fill" button — given a prospect, calls /api/sequences/:id/ai-generate
 *    and populates step subject/body previews
 *  - Save sequence
 *
 * Props:
 *   sequence    — existing sequence object (null = create new)
 *   onSave      — called with saved sequence
 *   onClose     — close/cancel handler
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

const CHANNEL_OPTIONS = [
  { value: 'email',    label: '✉️  Email',    hasContent: true  },
  { value: 'linkedin', label: '🔗  LinkedIn',  hasContent: true  },
  { value: 'call',     label: '📞  Call',      hasContent: false },
  { value: 'task',     label: '📋  Task',      hasContent: false },
];

const TEAL = '#0F9D8E';

const TEMPLATE_TOKENS = ['{{first_name}}', '{{last_name}}', '{{full_name}}', '{{title}}', '{{company}}', '{{industry}}'];

// ── Empty step factory ───────────────────────────────────────────────────────
function blankStep(order) {
  return {
    _id:              Date.now() + Math.random(), // client-only temp id
    id:               null,
    step_order:       order,
    channel:          'email',
    delay_days:       order === 1 ? 0 : 2,
    subject_template: '',
    body_template:    '',
    task_note:        '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function SequenceBuilder({ sequence: initialSequence, onSave, onClose }) {
  const isEdit = !!initialSequence?.id;

  const [name,        setName]        = useState(initialSequence?.name        || '');
  const [description, setDescription] = useState(initialSequence?.description || '');
  const [steps,       setSteps]       = useState(
    (initialSequence?.steps || []).length > 0
      ? initialSequence.steps.map(s => ({ ...s, _id: s.id }))
      : [blankStep(1)]
  );
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState('');
  const [aiLoading,   setAiLoading]   = useState(false);
  const [aiPreviewId, setAiPreviewId] = useState(null); // prospectId used for AI preview
  const [aiPreviewInput, setAiPreviewInput] = useState('');
  const [showAiInput, setShowAiInput] = useState(false);
  const [expandedStep, setExpandedStep] = useState(steps[0]?._id || null);

  // ── Step CRUD ──────────────────────────────────────────────────────────────

  const addStep = () => {
    const newStep = blankStep(steps.length + 1);
    setSteps(prev => [...prev, newStep]);
    setExpandedStep(newStep._id);
  };

  const removeStep = (tempId) => {
    setSteps(prev => {
      const next = prev.filter(s => s._id !== tempId);
      return next.map((s, i) => ({ ...s, step_order: i + 1 }));
    });
  };

  const updateStep = useCallback((tempId, field, value) => {
    setSteps(prev => prev.map(s => s._id === tempId ? { ...s, [field]: value } : s));
  }, []);

  const moveStep = (tempId, dir) => {
    setSteps(prev => {
      const idx = prev.findIndex(s => s._id === tempId);
      if (idx < 0) return prev;
      const next = [...prev];
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= next.length) return prev;
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next.map((s, i) => ({ ...s, step_order: i + 1 }));
    });
  };

  // ── AI Fill ────────────────────────────────────────────────────────────────

  const handleAiFill = async () => {
    if (!aiPreviewInput.trim()) return;
    if (!isEdit) {
      setError('Save the sequence first before AI-filling steps.');
      return;
    }
    setAiLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/sequences/${initialSequence.id}/ai-generate`, {
        method: 'POST',
        body: JSON.stringify({ prospectId: parseInt(aiPreviewInput) }),
      });
      const generatedMap = {};
      (res.generatedSteps || []).forEach(g => { generatedMap[g.step_order] = g; });
      setSteps(prev => prev.map(s => {
        const g = generatedMap[s.step_order];
        if (!g) return s;
        return { ...s, subject_template: g.subject || s.subject_template, body_template: g.body || s.body_template };
      }));
      setAiPreviewId(parseInt(aiPreviewInput));
      setShowAiInput(false);
    } catch (err) {
      setError('AI fill failed: ' + err.message);
    } finally {
      setAiLoading(false);
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!name.trim()) { setError('Sequence name is required'); return; }
    setSaving(true);
    setError('');
    try {
      let saved;
      if (isEdit) {
        // Update name/description
        await apiFetch(`/sequences/${initialSequence.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, description }),
        });

        // Sync steps: delete removed, update existing, add new
        const existingIds = (initialSequence.steps || []).map(s => s.id);
        const currentIds  = steps.filter(s => s.id).map(s => s.id);

        // Delete removed steps
        for (const eid of existingIds) {
          if (!currentIds.includes(eid)) {
            await apiFetch(`/sequences/${initialSequence.id}/steps/${eid}`, { method: 'DELETE' });
          }
        }
        // Update / create steps
        for (const step of steps) {
          if (step.id) {
            await apiFetch(`/sequences/${initialSequence.id}/steps/${step.id}`, {
              method: 'PUT',
              body: JSON.stringify(step),
            });
          } else {
            await apiFetch(`/sequences/${initialSequence.id}/steps`, {
              method: 'POST',
              body: JSON.stringify(step),
            });
          }
        }
        // Reorder
        const ids = steps.filter(s => s.id).map(s => s.id);
        if (ids.length) {
          await apiFetch(`/sequences/${initialSequence.id}/steps/reorder`, {
            method: 'POST',
            body: JSON.stringify({ order: ids }),
          });
        }
        const reloaded = await apiFetch(`/sequences/${initialSequence.id}`);
        saved = reloaded.sequence;
      } else {
        // Create new
        const res = await apiFetch('/sequences', {
          method: 'POST',
          body: JSON.stringify({ name, description, steps }),
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

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '18px 24px 14px', borderBottom: '1px solid #e5e7eb',
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
            {isEdit ? 'Edit Sequence' : 'New Sequence'}
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
            {steps.length} step{steps.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isEdit && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowAiInput(v => !v)}
                disabled={aiLoading}
                style={{
                  padding: '7px 14px', borderRadius: 7, border: '1px solid #0F9D8E',
                  background: aiLoading ? '#f0fdfa' : '#fff',
                  color: '#0F9D8E', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {aiLoading ? '⏳ Filling…' : '✨ AI Fill'}
              </button>
              {showAiInput && (
                <div style={{
                  position: 'absolute', right: 0, top: '110%', zIndex: 100,
                  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
                  padding: 14, width: 260,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
                }}>
                  <p style={{ margin: '0 0 8px', fontSize: 12, color: '#374151', fontWeight: 600 }}>
                    AI-fill steps for a prospect
                  </p>
                  <input
                    placeholder="Prospect ID"
                    value={aiPreviewInput}
                    onChange={e => setAiPreviewInput(e.target.value)}
                    style={{
                      width: '100%', padding: '6px 10px', borderRadius: 6,
                      border: '1px solid #d1d5db', fontSize: 12, marginBottom: 8,
                      boxSizing: 'border-box',
                    }}
                  />
                  <button
                    onClick={handleAiFill}
                    disabled={!aiPreviewInput.trim() || aiLoading}
                    style={{
                      width: '100%', padding: '7px', borderRadius: 6,
                      background: TEAL, color: '#fff', border: 'none',
                      fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Generate
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '7px 18px', borderRadius: 7, border: 'none',
              background: saving ? '#9ca3af' : TEAL,
              color: '#fff', fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save Sequence'}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '7px 12px', borderRadius: 7, border: '1px solid #e5e7eb',
              background: '#fff', color: '#6b7280', fontSize: 12, cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          margin: '10px 24px 0', padding: '8px 12px',
          background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 7, fontSize: 12, color: '#dc2626',
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>

        {/* Name + Description */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
            Sequence Name *
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Cold Outreach — SaaS CFOs"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 7,
              border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box',
            }}
          />
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Optional description"
            style={{
              width: '100%', padding: '7px 12px', borderRadius: 7,
              border: '1px solid #d1d5db', fontSize: 12, marginTop: 8,
              boxSizing: 'border-box', color: '#6b7280',
            }}
          />
        </div>

        {/* Token hint */}
        <div style={{
          marginBottom: 14, padding: '8px 12px',
          background: '#f0fdf4', border: '1px solid #bbf7d0',
          borderRadius: 7, fontSize: 11, color: '#065f46',
        }}>
          💡 Use tokens in templates: {TEMPLATE_TOKENS.join(' ')}
        </div>

        {/* ── Steps ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {steps.map((step, idx) => (
            <StepCard
              key={step._id}
              step={step}
              index={idx}
              total={steps.length}
              expanded={expandedStep === step._id}
              onToggle={() => setExpandedStep(expandedStep === step._id ? null : step._id)}
              onChange={(field, val) => updateStep(step._id, field, val)}
              onRemove={() => removeStep(step._id)}
              onMoveUp={() => moveStep(step._id, 'up')}
              onMoveDown={() => moveStep(step._id, 'down')}
            />
          ))}
        </div>

        <button
          onClick={addStep}
          style={{
            width: '100%', marginTop: 12, padding: '10px',
            border: '2px dashed #d1d5db', borderRadius: 8,
            background: '#fafafa', color: '#6b7280',
            fontSize: 13, fontWeight: 500, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          + Add Step
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP CARD
// ─────────────────────────────────────────────────────────────────────────────

function StepCard({ step, index, total, expanded, onToggle, onChange, onRemove, onMoveUp, onMoveDown }) {
  const channelCfg = CHANNEL_OPTIONS.find(c => c.value === step.channel) || CHANNEL_OPTIONS[0];
  const hasContent = channelCfg.hasContent;

  return (
    <div style={{
      border: `1px solid ${expanded ? '#0F9D8E' : '#e5e7eb'}`,
      borderRadius: 10,
      background: '#fff',
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      {/* ── Step header ─────────────────────────────────────────────────── */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', cursor: 'pointer',
          background: expanded ? '#f0fdf4' : '#fff',
          userSelect: 'none',
        }}
      >
        {/* Step number */}
        <div style={{
          width: 24, height: 24, borderRadius: '50%',
          background: expanded ? '#0F9D8E' : '#f3f4f6',
          color: expanded ? '#fff' : '#6b7280',
          fontSize: 11, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {index + 1}
        </div>

        <span style={{ fontSize: 13, color: '#374151' }}>{channelCfg.label}</span>

        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          {step.delay_days === 0
            ? index === 0 ? 'Day 0 (on enroll)' : 'same day'
            : `+${step.delay_days}d`}
        </span>

        {step.subject_template && (
          <span style={{
            flex: 1, fontSize: 12, color: '#6b7280',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {step.subject_template}
          </span>
        )}

        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {index > 0 && (
            <button onClick={e => { e.stopPropagation(); onMoveUp(); }}
              style={iconBtn}>▲</button>
          )}
          {index < total - 1 && (
            <button onClick={e => { e.stopPropagation(); onMoveDown(); }}
              style={iconBtn}>▼</button>
          )}
          <button
            onClick={e => { e.stopPropagation(); if (window.confirm('Remove this step?')) onRemove(); }}
            style={{ ...iconBtn, color: '#ef4444' }}
          >✕</button>
        </div>
      </div>

      {/* ── Step body ───────────────────────────────────────────────────── */}
      {expanded && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Channel + delay row */}
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Channel</label>
              <select
                value={step.channel}
                onChange={e => onChange('channel', e.target.value)}
                style={selectStyle}
              >
                {CHANNEL_OPTIONS.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div style={{ width: 130 }}>
              <label style={labelStyle}>
                {index === 0 ? 'Delay (days from enroll)' : 'Delay (days from prev step)'}
              </label>
              <input
                type="number" min="0" max="365"
                value={step.delay_days}
                onChange={e => onChange('delay_days', parseInt(e.target.value) || 0)}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
          </div>

          {/* Email/LinkedIn content */}
          {hasContent ? (
            <>
              <div>
                <label style={labelStyle}>Subject Template</label>
                <input
                  value={step.subject_template}
                  onChange={e => onChange('subject_template', e.target.value)}
                  placeholder="e.g. Quick question for you, {{first_name}}"
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div>
                <label style={labelStyle}>Body Template</label>
                <textarea
                  value={step.body_template}
                  onChange={e => onChange('body_template', e.target.value)}
                  placeholder={`Hi {{first_name}},\n\nI noticed {{company}} recently...\n\nWould it make sense to connect?`}
                  rows={6}
                  style={{
                    ...inputStyle, width: '100%', resize: 'vertical',
                    lineHeight: 1.6, fontFamily: 'inherit',
                  }}
                />
              </div>
            </>
          ) : (
            <div>
              <label style={labelStyle}>Task Note</label>
              <input
                value={step.task_note}
                onChange={e => onChange('task_note', e.target.value)}
                placeholder="e.g. Call and introduce yourself. Reference the email sent on day 1."
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared micro-styles ───────────────────────────────────────────────────────
const iconBtn = {
  padding: '2px 6px', borderRadius: 4, border: '1px solid #e5e7eb',
  background: '#fff', color: '#6b7280', fontSize: 11, cursor: 'pointer',
};

const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3,
};

const inputStyle = {
  padding: '7px 10px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box',
};

const selectStyle = {
  ...inputStyle, width: '100%', background: '#fff',
};
