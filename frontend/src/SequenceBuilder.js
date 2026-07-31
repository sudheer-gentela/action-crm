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

import React, { useState, useCallback, useEffect, useRef } from 'react';
import DesktopOnlyNotice from './DesktopOnlyNotice';
import PersonalizeConfigBlock from './PersonalizeConfigBlock';
import SequenceABPanel from './SequenceABPanel';   // A/B variants (2026_46)

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

// Slice 3: per-step intent override for the personalization dispatcher.
// `null` (the default) means "auto-infer from channel + position + engagement
// history." Explicit values override inference. Email and LinkedIn channels
// have different intent enums — the UI in StepRow surfaces only the ones
// valid for the step's channel.
const EMAIL_INTENT_OPTIONS = [
  { value: '',             label: 'Auto (recommended)' },
  { value: 'first_touch',  label: 'First touch' },
  { value: 'follow_up',    label: 'Follow-up' },
  { value: 'breakup',      label: 'Breakup' },
];
const LINKEDIN_INTENT_OPTIONS = [
  { value: '',                     label: 'Auto (recommended)' },
  { value: 'connection_request',   label: 'Connection request' },
  { value: 'post_accept_message',  label: 'Post-accept DM' },
  { value: 'nurture_dm',           label: 'Nurture DM' },
];

function blankStep(order) {
  return {
    _id:              Date.now() + Math.random(),
    id:               null,
    step_order:       order,
    channel:          'email',
    delay_days:       order === 1 ? 0 : 3,
    delay_hours:      0,
    mode:             'ai',
    ai_generated:     false,
    subject_template: '',
    body_template:    '',
    task_note:        '',
    include_signature: true,   // 2026_74 — matches the DB default
    require_approval:    null, // null = inherit from sequence
    personalize_config:  null, // null = inherit from sequence default → user pref → SYSTEM_DEFAULT
    step_intent:         null, // Slice 3: null = auto-infer; explicit = override
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function SequenceBuilder(props) {
  return (
    <DesktopOnlyNotice
      title="The sequence builder needs a wider screen"
      detail="Steps, delays, A/B variants and the message editor sit side by side. Below about 900px the columns collapse into each other and it becomes easy to edit the wrong step."
    >
      <SequenceBuilderInner {...props} />
    </DesktopOnlyNotice>
  );
}

function SequenceBuilderInner({ sequence: initialSequence, onSave, onClose }) {
  const isEdit = !!initialSequence?.id;

  const [name,            setName]            = useState(initialSequence?.name        || '');
  const [toneGoal,        setToneGoal]        = useState(initialSequence?.description || '');
  const [requireApproval, setRequireApproval] = useState(
    initialSequence?.require_approval !== undefined ? initialSequence.require_approval : true
  );
  // Visibility: 'shared' (in the org Library for everyone) or 'private' (only
  // the owner sees it; a manager/admin can still see it via their read scope).
  // Default shared. Server enforces; this just sets the flag on save.
  const [visibility, setVisibility] = useState(
    initialSequence?.visibility === 'private' ? 'private' : 'shared'
  );
  // Per-sequence opt-in: let the owner's manager edit THIS sequence even when
  // the org-wide "managers can edit" policy is off. Default off.
  const [allowManagerEdit, setAllowManagerEdit] = useState(
    initialSequence?.allow_manager_edit === true
  );
  // Master switch: does this sequence use AI personalization at all? When off,
  // all AI config below is hidden, steps are saved as plain templates, and
  // preview/activate default to NOT calling any skill.
  const [aiEnabled, setAiEnabled] = useState(
    initialSequence?.ai_enabled !== undefined ? initialSequence.ai_enabled !== false : true
  );
  // WS2: stop enrollments automatically when the prospect accepts the
  // LinkedIn connection request (enrollment → status 'connected'). Default
  // off — existing sequences keep running through acceptance unless the
  // owner opts in here.
  const [stopOnConnectionAccept, setStopOnConnectionAccept] = useState(
    initialSequence?.stop_on_connection_accept === true
  );

  // 2026_71: threaded replies + sender pin
  const [threadReplies, setThreadReplies] = useState(
    initialSequence?.thread_replies === true
  );
  const [pinSender, setPinSender] = useState(
    initialSequence?.pin_sender === true
  );
  // 2026_76 — wire format. Locked while the sequence has active enrollments; the
  // PUT returns 409 BODY_FORMAT_LOCKED and the save handler surfaces that message.
  const [bodyFormat, setBodyFormat] = useState(
    initialSequence?.body_format === 'plain' ? 'plain' : 'html'
  );
  const [threadSubjectMode, setThreadSubjectMode] = useState(
    initialSequence?.thread_subject_mode === 're' ? 're' : 'keep'
  );
  const [threadFailoverMode, setThreadFailoverMode] = useState(
    initialSequence?.thread_failover_mode === 'break' ? 'break' : 'defer'
  );
  // Threading forces pinning on (mandatory); the pin toggle is shown checked+disabled.
  const pinEffective = threadReplies || pinSender;
  const tglTrack = (on, disabled = false) => ({
    position: 'relative', width: 40, height: 22, borderRadius: 11, border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0,
    background: on ? TEAL : '#d1d5db', opacity: disabled ? 0.6 : 1, transition: 'background 0.2s',
  });
  const tglKnob = (on) => ({
    position: 'absolute', top: 3, left: on ? 21 : 3, width: 16, height: 16,
    borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  });
  const segButton = (val, cur, set, label, hint) => (
    <button
      type="button"
      onClick={() => set(val)}
      style={{
        flex: 1, textAlign: 'left', padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
        background: cur === val ? TEAL_LIGHT : '#fff',
        border: `1px solid ${cur === val ? TEAL : '#e5e7eb'}`,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: cur === val ? TEAL : '#374151' }}>{label}</div>
      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{hint}</div>
    </button>
  );
  const [steps, setSteps] = useState(
    (initialSequence?.steps || []).length > 0
      ? initialSequence.steps.map(s => ({
          ...s,
          // 2026_74 — must come AFTER the spread, or ...s reinstates the raw
          // (possibly undefined) value. undefined means signature on.
          include_signature: s.include_signature !== false,
          _id:                s.id,
          mode:               s.mode || 'manual',
          ai_generated:       false,
          delay_hours:        s.delay_hours ?? 0,        // WS3: pre-migration rows
          require_approval:   s.require_approval !== undefined ? s.require_approval : null,
          personalize_config: s.personalize_config !== undefined ? s.personalize_config : null,
          step_intent:        s.step_intent || null,   // Slice 3
        }))
      : [blankStep(1)]
  );

  const [saving,       setSaving]       = useState(false);
  const [generating,   setGenerating]   = useState(false);
  const [error,        setError]        = useState('');
  const [generated,    setGenerated]    = useState(false);
  const [expandedStep, setExpandedStep] = useState(steps[0]?._id || null);

  // ── LinkedIn personalization config ────────────────────────────────────────
  // Sequence-level default — null means inherit from user pref → SYSTEM_DEFAULT.
  const [personalizeConfigDefault, setPersonalizeConfigDefault] = useState(
    initialSequence?.personalize_config_default ?? null
  );
  // User-level preference, fetched once on mount, used as the inherited preview
  // when sequence-level is null. null = user has no pref set.
  const [userPersonalizePref, setUserPersonalizePref] = useState(null);
  // "Set as my default" feedback toast (sequence-level only).
  const [savedAsDefault,       setSavedAsDefault]     = useState(false);
  const [savingAsDefault,      setSavingAsDefault]    = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/users/me/preferences/personalize-linkedin')
      .then(r => { if (!cancelled) setUserPersonalizePref(r.config || null); })
      .catch(() => { /* non-fatal — falls through to SYSTEM_DEFAULT preview */ });
    return () => { cancelled = true; };
  }, []);

  const handleSetAsMyDefault = async () => {
    setSavingAsDefault(true);
    try {
      const r = await apiFetch('/users/me/preferences/personalize-linkedin', {
        method: 'PATCH',
        body:   JSON.stringify({ config: personalizeConfigDefault }),
      });
      setUserPersonalizePref(r.config || null);
      setSavedAsDefault(true);
      setTimeout(() => setSavedAsDefault(false), 2000);
    } catch (e) {
      setError('Failed to save default: ' + e.message);
    } finally {
      setSavingAsDefault(false);
    }
  };

  const aiStepCount = steps.filter(s => s.mode === 'ai').length;

  // ── Dirty-state tracking ─────────────────────────────────────────────────────
  // The "Save Changes" button must stay disabled until the user has actually
  // changed something. We serialize every field that handleSave persists into a
  // canonical string, capture a baseline on first render (every piece of state
  // is initialised synchronously from `initialSequence`, so first render === the
  // pristine state, and the userPersonalizePref fetch in useEffect touches no
  // field below), then compare. Reverting an edit back to its original value
  // re-disables the button, which is the behaviour users expect.
  const stateSnapshot = JSON.stringify({
    name,
    toneGoal,
    requireApproval,
    visibility,
    allowManagerEdit,
    aiEnabled,
    stopOnConnectionAccept,
    personalizeConfigDefault,
    steps: steps.map(s => ({
      id:                 s.id ?? null,
      step_order:         s.step_order,
      channel:            s.channel,
      delay_days:         s.delay_days,
      delay_hours:        s.delay_hours ?? 0,
      mode:               s.mode,
      subject_template:   s.subject_template || '',
      body_template:      s.body_template    || '',
      task_note:          s.task_note        || '',
      require_approval:   s.require_approval   ?? null,
      personalize_config: s.personalize_config ?? null,
      step_intent:        s.step_intent        || null,
    })),
  });

  const baselineSnapshotRef = useRef(null);
  if (baselineSnapshotRef.current === null) {
    baselineSnapshotRef.current = stateSnapshot;
  }
  const isDirty = stateSnapshot !== baselineSnapshotRef.current;
  // Create mode keeps its original "always enabled" behaviour (a brand-new
  // sequence has nothing to diff against); only edit mode gates on unsaved
  // changes. Either way, we never allow a click while a save is in flight.
  const canSave = saving ? false : (isEdit ? isDirty : true);

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
        .map(s => ({ step_order: s.step_order, channel: s.channel, delay_days: s.delay_days, delay_hours: s.delay_hours ?? 0 }));

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

    // When AI is off, every step is saved as a plain manual template and all
    // AI metadata is cleared so the dispatcher has nothing to act on and the
    // campaign screen sees a truly non-AI sequence.
    const stepsPayload = steps.map(s => ({
      ...s,
      mode: aiEnabled ? s.mode : 'manual',
      personalize_config: aiEnabled ? s.personalize_config : null,
      // Slice 3: empty string from the dropdown means "Auto" — send null so the
      // DB column is NULL (inference applies at fire time). LinkedIn intent is
      // persisted even when AI is off, because it also gates LinkedIn auto-send
      // (the firer reads the literal value before falling back to inference);
      // email intent only matters when AI is on.
      step_intent: (s.step_intent && s.step_intent.length > 0 && (aiEnabled || s.channel === 'linkedin'))
        ? s.step_intent
        : null,
    }));
    // Sequence-level personalization default is meaningless with AI off.
    const effectivePersonalizeDefault = aiEnabled ? personalizeConfigDefault : null;

    try {
      let saved;
      if (isEdit) {
        await apiFetch(`/sequences/${initialSequence.id}`, {
          method: 'PUT',
          body:   JSON.stringify({
            name,
            description: toneGoal,
            require_approval: requireApproval,
            ai_enabled: aiEnabled,
            visibility,
            allow_manager_edit: allowManagerEdit,
            stop_on_connection_accept: stopOnConnectionAccept,
            thread_replies: threadReplies,
            pin_sender: threadReplies ? true : pinSender,
            body_format:         bodyFormat,
            thread_subject_mode: threadSubjectMode,
            thread_failover_mode: threadFailoverMode,
            personalize_config_default: effectivePersonalizeDefault,
          }),
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
          // Backend expects { steps: [{ id, step_order }] }
          const reorderPayload = stepsPayload
            .filter(s => s.id)
            .map((s, idx) => ({ id: s.id, step_order: idx + 1 }));
          await apiFetch(`/sequences/${initialSequence.id}/steps/reorder`, {
            method: 'POST', body: JSON.stringify({ steps: reorderPayload }),
          });
        }
        const reloaded = await apiFetch(`/sequences/${initialSequence.id}`);
        saved = reloaded.sequence;
      } else {
        const res = await apiFetch('/sequences', {
          method: 'POST',
          body:   JSON.stringify({
            name,
            description: toneGoal,
            require_approval: requireApproval,
            ai_enabled: aiEnabled,
            visibility,
            allow_manager_edit: allowManagerEdit,
            stop_on_connection_accept: stopOnConnectionAccept,
            thread_replies: threadReplies,
            pin_sender: threadReplies ? true : pinSender,
            body_format:         bodyFormat,
            thread_subject_mode: threadSubjectMode,
            thread_failover_mode: threadFailoverMode,
            personalize_config_default: effectivePersonalizeDefault,
            steps: stepsPayload,
          }),
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
            disabled={!canSave}
            title={isEdit && !isDirty && !saving ? 'No changes to save' : undefined}
            style={{
              padding: '8px 20px', borderRadius: 8, border: 'none',
              background: !canSave ? '#9ca3af' : TEAL, color: '#fff',
              fontSize: 13, fontWeight: 600,
              cursor: !canSave ? 'not-allowed' : 'pointer',
              opacity: !canSave ? 0.7 : 1,
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

        {/* Master AI toggle — gates all AI config on this screen */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', borderRadius: 8,
          background: aiEnabled ? TEAL_LIGHT : '#f9fafb',
          border: `1px solid ${aiEnabled ? TEAL + '40' : '#e5e7eb'}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              ✨ Use AI personalization
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {aiEnabled
                ? 'AI writes and personalizes steps per prospect. Skill calls consume API tokens.'
                : 'Steps send their templates as-is. No AI, no token cost.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAiEnabled(v => !v)}
            style={{
              position: 'relative', width: 40, height: 22, borderRadius: 11,
              border: 'none', cursor: 'pointer', flexShrink: 0,
              background: aiEnabled ? TEAL : '#d1d5db',
              transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: 3,
              left: aiEnabled ? 21 : 3,
              width: 16, height: 16, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        {/* WS2: stop-on-connection-accept toggle. Only meaningful for
            sequences with a LinkedIn CR step, but always shown so the owner
            can set it before adding the step. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', borderRadius: 8,
          background: stopOnConnectionAccept ? TEAL_LIGHT : '#f9fafb',
          border: `1px solid ${stopOnConnectionAccept ? TEAL + '40' : '#e5e7eb'}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              🤝 Stop when connection is accepted
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {stopOnConnectionAccept
                ? 'Prospects who accept your LinkedIn request exit the sequence (status: connected). Remaining steps are skipped.'
                : 'Prospects continue through all steps even after accepting your LinkedIn request.'}
            </div>
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
              Acceptance is detected when the Chrome extension syncs (“Check &amp; update accepted”) — run it regularly for timely exits.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setStopOnConnectionAccept(v => !v)}
            style={{
              position: 'relative', width: 40, height: 22, borderRadius: 11,
              border: 'none', cursor: 'pointer', flexShrink: 0,
              background: stopOnConnectionAccept ? TEAL : '#d1d5db',
              transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: 3,
              left: stopOnConnectionAccept ? 21 : 3,
              width: 16, height: 16, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        {/* 2026_71: Threaded replies + sender pin */}
        <div style={{
          padding: '12px 14px', borderRadius: 8,
          background: threadReplies ? TEAL_LIGHT : '#f9fafb',
          border: `1px solid ${threadReplies ? TEAL + '40' : '#e5e7eb'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                🧵 Send follow-ups as threaded replies
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                {threadReplies
                  ? 'Each email step after the first is sent as a reply in the same thread — same subject, same mailbox.'
                  : 'Each email step is sent as a new standalone email (default).'}
              </div>
            </div>
            <button type="button" onClick={() => setThreadReplies(v => !v)} style={tglTrack(threadReplies)}>
              <span style={tglKnob(threadReplies)} />
            </button>
          </div>

          {/* Pin to one mailbox — forced + disabled while threading is on */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                📌 Pin to one sending mailbox
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                {threadReplies
                  ? 'Required for threaded replies — every step sends from the mailbox that opened the thread. Rotation is off.'
                  : (pinSender
                      ? 'One mailbox for the whole enrollment. Sender rotation is off.'
                      : 'Sender rotation is on (default) — steps may go from different mailboxes.')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { if (!threadReplies) setPinSender(v => !v); }}
              disabled={threadReplies}
              title={threadReplies ? 'Pinning is required while threaded replies are on' : undefined}
              style={tglTrack(pinEffective, threadReplies)}
            >
              <span style={tglKnob(pinEffective)} />
            </button>
          </div>

          {/* Email format — independent of threading */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Email format
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {segButton('html', bodyFormat, setBodyFormat, 'HTML', 'Formatted links and line breaks; open and click tracking available')}
              {segButton('plain', bodyFormat, setBodyFormat, 'Plain text', 'Sent as text/plain — no tracking possible')}
            </div>
            {bodyFormat === 'plain' && (
              <div style={{ fontSize: 11, color: '#b45309', marginTop: 6, lineHeight: 1.5 }}>
                Plain text disables <strong>open and click tracking</strong> for this
                sequence. A tracking pixel is an image and rewritten links are anchor
                tags — neither survives plain text, so reporting will show zero opens
                and zero clicks here. That is expected, not a fault.
              </div>
            )}
            {initialSequence?.id && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                Format can’t be changed while enrollments are active — replies would
                mix formats and break their quoted history. Pause them first, or clone
                the sequence.
              </div>
            )}
          </div>

          {/* Reply subject — threading only */}
          {threadReplies && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Reply subject</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {segButton('keep', threadSubjectMode, setThreadSubjectMode, 'Keep original', 'Reuse the first email\'s subject as-is')}
                {segButton('re', threadSubjectMode, setThreadSubjectMode, 'Add “Re:”', 'Prefix the subject with Re:')}
              </div>
            </div>
          )}

          {/* Failover — relevant whenever a mailbox is pinned */}
          {pinEffective && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                If the pinned mailbox can’t send
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {segButton('defer', threadFailoverMode, setThreadFailoverMode, 'Pause & notify', 'Pause the enrollment and remind the owner daily until fixed')}
                {segButton('break', threadFailoverMode, setThreadFailoverMode, 'Switch sender', 'Send from another mailbox (thread resets)')}
              </div>
            </div>
          )}
        </div>

        {/* Tone & Goal */}
        {/* Description — doubles as the AI brief (Tone & Goal) when AI is on,
            and as free-form sequence notes when AI is off. Always available so
            non-AI sequences still have somewhere to capture context. */}
        <div>
          <label style={labelStyle}>
            {aiEnabled ? 'Tone & Goal' : 'Notes'}
            <span style={{ marginLeft: 6, fontSize: 10, color: '#9ca3af', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              {aiEnabled
                ? '— AI uses this to write all AI steps'
                : '— internal notes about this sequence (not sent to prospects)'}
            </span>
          </label>
          <textarea
            value={toneGoal}
            onChange={e => setToneGoal(e.target.value)}
            placeholder={aiEnabled
              ? 'e.g. Professional but conversational. Targeting VP Finance at mid-market SaaS. Focus on cost savings and reducing manual reporting time.'
              : 'e.g. Pain-led outreach for VP Sales. Manual templates reviewed by RevOps. Use for Q3 dogfood test cohort.'}
            rows={3}
            style={{ ...inputStyle, width: '100%', resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

        {/* Sequence-level LinkedIn personalization default */}
        {aiEnabled && (
        <div>
          <PersonalizeConfigBlock
            value={personalizeConfigDefault}
            onChange={setPersonalizeConfigDefault}
            inheritedFrom={userPersonalizePref ? 'your preferences' : 'off (system default)'}
            inheritedValue={userPersonalizePref}
          />
          {/* Save-as-default action — only meaningful when sequence has its own override */}
          {personalizeConfigDefault && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, paddingLeft: 4 }}>
              <button
                type="button"
                onClick={handleSetAsMyDefault}
                disabled={savingAsDefault}
                style={{
                  padding: '5px 12px', borderRadius: 6,
                  border: '1px solid #d1d5db', background: '#fff',
                  color: '#374151', fontSize: 11, fontWeight: 500,
                  cursor: savingAsDefault ? 'wait' : 'pointer',
                }}
              >
                {savingAsDefault ? 'Saving…' : 'Set as my default'}
              </button>
              {savedAsDefault && (
                <span style={{ fontSize: 11, color: TEAL, fontWeight: 500 }}>
                  ✓ Saved as your default
                </span>
              )}
              <span style={{ fontSize: 10.5, color: '#9ca3af' }}>
                Applies to future sequences with no override
              </span>
            </div>
          )}
        </div>
        )}

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

        {/* Visibility — shared to the org Library, or private to the owner */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: 8,
          background: visibility === 'private' ? '#fef9f5' : '#f9fafb',
          border: `1px solid ${visibility === 'private' ? '#f5d6bd' : '#e5e7eb'}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              {visibility === 'private' ? '🔒 Private to me' : '👥 Shared with the org'}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {visibility === 'private'
                ? "Hidden from the org Library — only you (and your manager/admin) can see it"
                : 'Listed in the org Library for everyone to use (default)'}
            </div>
          </div>
          <button
            onClick={() => setVisibility(v => (v === 'private' ? 'shared' : 'private'))}
            style={{
              position: 'relative', width: 40, height: 22, borderRadius: 11,
              border: 'none', cursor: 'pointer', flexShrink: 0,
              background: visibility === 'private' ? '#E8630A' : '#d1d5db',
              transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: 3,
              left: visibility === 'private' ? 21 : 3,
              width: 16, height: 16, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        </div>

        {/* Per-sequence manager edit opt-in */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: 8,
          background: allowManagerEdit ? '#eef6ff' : '#f9fafb',
          border: `1px solid ${allowManagerEdit ? '#bfdbfe' : '#e5e7eb'}`,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
              🧑‍💼 Let my manager edit this sequence
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {allowManagerEdit
                ? 'Your manager can edit this specific sequence'
                : 'Only you (and admins) can edit it — managers are view-only'}
            </div>
          </div>
          <button
            onClick={() => setAllowManagerEdit(v => !v)}
            style={{
              position: 'relative', width: 40, height: 22, borderRadius: 11,
              border: 'none', cursor: 'pointer', flexShrink: 0,
              background: allowManagerEdit ? '#3b82f6' : '#d1d5db',
              transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: 3,
              left: allowManagerEdit ? 21 : 3,
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
            {aiEnabled && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                {aiStepCount} AI · {steps.length - aiStepCount} Manual
              </div>
            )}
          </div>
          {aiEnabled && (
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
          )}
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
              threadReplies={threadReplies}
              /* With threading on, every email step AFTER the first is sent as a
                 reply and the firer reuses the root subject — the step's own
                 subject_template is discarded. Tell the card so it can show the
                 inherited value read-only instead of inviting an edit that has
                 no effect. */
              isThreadReplyStep={
                threadReplies &&
                step.channel === 'email' &&
                idx > steps.findIndex(s => s.channel === 'email')
              }
              inheritedSubject={(() => {
                const root = steps.find(s => s.channel === 'email');
                const base = (root?.subject_template || '').trim();
                if (!base) return '';
                return threadSubjectMode === 're' && !/^re:/i.test(base) ? `Re: ${base}` : base;
              })()}
              aiEnabled={aiEnabled}
              expanded={expandedStep === step._id}
              seqRequireApproval={requireApproval}
              seqPersonalizeDefault={personalizeConfigDefault}
              userPersonalizePref={userPersonalizePref}
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

        {/* A/B variants (2026_46). Self-contained: owns its own fetches, writes
            straight to the API on click, and stays OUT of `stateSnapshot` — a
            weight nudge must not light up "Save Changes", and an unsaved reorder
            must not rewrite arm content. `initialSequence?.id` (not a local id)
            because arms attach to a saved step. */}
        <SequenceABPanel
          sequenceId={initialSequence?.id ?? null}
          steps={steps}
          aiEnabled={aiEnabled}
          apiFetch={apiFetch}
        />

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

function StepCard({ step, index, total, aiEnabled = true, expanded, seqRequireApproval, seqPersonalizeDefault, userPersonalizePref, threadReplies = false, isThreadReplyStep = false, inheritedSubject = '', onToggle, onChange, onRemove, onToggleMode, onMoveUp, onMoveDown }) {
  const channelCfg = CHANNEL_OPTIONS.find(c => c.value === step.channel) || CHANNEL_OPTIONS[0];
  // When the sequence's master AI switch is off, every step behaves as a plain
  // manual template regardless of its stored mode — and the AI affordances
  // (mode pill, intent override, personalization) are hidden.
  const isAI       = aiEnabled && step.mode === 'ai';
  const hasContent = channelCfg.hasContent;

  const isEmailChannel = step.channel === 'email';

  // Threaded replies inherit the root subject; the firer discards this step's own
  // subject_template (SequenceStepFirer resolves outSubject from
  // thread_root_subject). Render the inherited value read-only rather than an
  // editable box whose contents never reach the wire.
  // 2026_74: per-step signature control. Email only — LinkedIn signature handling
  // is separate and connection requests never carry one.
  const includeSignature = step.include_signature !== false;
  const signatureToggle = isEmailChannel ? (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
        fontSize: 12, color: '#374151', cursor: 'pointer',
      }}
      title="When off, this step's email is sent without the sender's signature."
    >
      <input
        type="checkbox"
        checked={includeSignature}
        onChange={e => onChange('include_signature', e.target.checked)}
      />
      Append sender signature
      {!includeSignature && (
        <span style={{ color: '#9ca3af' }}>— this step sends without a signature</span>
      )}
    </label>
  ) : null;

  const inheritedSubjectBlock = (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>
        Subject{' '}
        <span style={{ fontWeight: 400, color: '#9ca3af', textTransform: 'none', letterSpacing: 0 }}>
          — inherited from the first email
        </span>
      </label>
      <div
        style={{
          ...inputStyle,
          width: '100%',
          background: '#f3f4f6',
          color: inheritedSubject ? '#374151' : '#9ca3af',
          cursor: 'not-allowed',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={inheritedSubject || 'Set a subject on the first email step'}
      >
        {inheritedSubject || 'Set a subject on the first email step'}
      </div>
      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
        Replies stay in the same thread, so they reuse the first email's subject.
        Change it on the first step, or switch Keep&nbsp;original / Add&nbsp;“Re:” in
        the Threaded&nbsp;replies panel above.
      </div>
    </div>
  );

  // Personalization is meaningful only on channels where the AI writes copy
  // (email + linkedin) AND only when AI is enabled for the sequence.
  const showPersonalize = aiEnabled && (step.channel === 'email' || step.channel === 'linkedin');

  // What the step inherits when its own personalize_config is null:
  //   sequence default → user pref → null (which displays as SYSTEM_DEFAULT)
  const stepInheritedFrom  = seqPersonalizeDefault
    ? 'sequence default'
    : (userPersonalizePref ? 'your preferences' : 'off (system default)');
  const stepInheritedValue = seqPersonalizeDefault || userPersonalizePref || null;

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
          {(() => {
            const dd = step.delay_days || 0;
            const dh = step.delay_hours || 0;
            if (dd === 0 && dh === 0) return index === 0 ? 'Day 0' : 'same day';
            return `+${dd > 0 ? `${dd}d` : ''}${dh > 0 ? `${dh}h` : ''}`;
          })()}
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
          {aiEnabled && (
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
          )}
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
            <div style={{ width: 110 }}>
              <label style={labelStyle}>{index === 0 ? 'Delay (days)' : 'Delay from prev (days)'}</label>
              <input
                type="number" min="0" max="365"
                value={step.delay_days}
                onChange={e => onChange('delay_days', parseInt(e.target.value) || 0)}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
            <div style={{ width: 90 }}>
              <label style={labelStyle}>+ hours</label>
              <input
                type="number" min="0" max="23"
                value={step.delay_hours ?? 0}
                onChange={e => {
                  const v = parseInt(e.target.value) || 0;
                  onChange('delay_hours', Math.min(23, Math.max(0, v)));
                }}
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>
          </div>

          {/* Slice 3: Step intent override. Auto = let the dispatcher infer
              based on channel + position + engagement history. Explicit
              picks bypass inference — useful for forcing a breakup or
              skipping straight to a post-accept DM. */}
          {((aiEnabled && step.channel === 'email') || step.channel === 'linkedin') && (
            <div>
              <label style={labelStyle}>
                Step intent <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 10 }}>
                  {step.channel === 'linkedin'
                    ? '— "Connection request" turns on LinkedIn auto-send for this step (and picks the AI template when AI is on)'
                    : '— controls which AI template runs for this step'}
                </span>
              </label>
              <select
                value={step.step_intent || ''}
                onChange={e => onChange('step_intent', e.target.value || null)}
                style={selectStyle}
              >
                {(step.channel === 'email' ? EMAIL_INTENT_OPTIONS : LINKEDIN_INTENT_OPTIONS).map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {step.step_intent && (
                <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>
                  Set explicitly — this intent is used as-is, bypassing auto-inference.
                </div>
              )}
            </div>
          )}

          {/* Step-level approval override (email + LinkedIn steps) */}
          {(isEmailChannel || step.channel === 'linkedin') && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderRadius: 7,
              background: '#f9fafb', border: '1px solid #e5e7eb',
            }}>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                <span style={{ fontWeight: 600, color: '#374151' }}>Draft setting: </span>
                {step.require_approval === null || step.require_approval === undefined
                  ? `Use sequence default (${seqRequireApproval ? 'draft' : 'auto-send'})`
                  : step.require_approval
                    ? 'Always draft'
                    : (step.channel === 'linkedin' ? 'Auto-send when enabled' : 'Always auto-send')}
                {step.channel === 'linkedin' && (
                  <span style={{ display: 'block', color: '#9ca3af', marginTop: 2 }}>
                    “Send” auto-sends the connection request only when LinkedIn auto-send is enabled; otherwise it creates a draft.
                  </span>
                )}
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
                  {isThreadReplyStep ? inheritedSubjectBlock : (
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ ...labelStyle, color: TEAL }}>
                      Subject <span style={{ fontWeight: 400, color: '#9ca3af', textTransform: 'none', letterSpacing: 0 }}>— AI generated, editable</span>
                    </label>
                    <input value={step.subject_template} onChange={e => onChange('subject_template', e.target.value)}
                      style={{ ...inputStyle, width: '100%', background: '#fff' }} />
                  </div>
                  )}
                  {signatureToggle}
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
              {isThreadReplyStep ? inheritedSubjectBlock : (
              <div>
                <label style={labelStyle}>Subject Template</label>
                <input value={step.subject_template} onChange={e => onChange('subject_template', e.target.value)}
                  placeholder="e.g. Quick question for {{first_name}}" style={{ ...inputStyle, width: '100%' }} />
              </div>
              )}
              {signatureToggle}
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

          {/* Per-step LinkedIn personalization (email + linkedin only) */}
          {showPersonalize && (
            <PersonalizeConfigBlock
              value={step.personalize_config}
              onChange={(cfg) => onChange('personalize_config', cfg)}
              inheritedFrom={stepInheritedFrom}
              inheritedValue={stepInheritedValue}
              compact
            />
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
