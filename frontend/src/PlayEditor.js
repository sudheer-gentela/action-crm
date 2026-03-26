import { apiService } from './apiService';
// ============================================================
// ActionCRM Playbook Builder — C5: PlayEditor
// File: frontend/src/PlayEditor.js
// Schema-corrected: priority is text ('high'|'medium'|'low'),
// action_type removed (column doesn't exist), org_id required.
// ============================================================

import React, { useState } from 'react';
import './PlayEditor.css';

const CHANNELS = ['email', 'call', 'meeting', 'task', 'document', 'slack', 'crm', 'sms'];
const TRIGGER_MODES = ['stage_change', 'on_demand', 'scheduled'];
const GENERATION_MODES = ['template', 'ai', 'hybrid'];
const AI_TONES = ['professional', 'consultative', 'assertive', 'friendly'];
const CONDITION_OPERATORS = [
  'equals', 'not_equals', 'contains',
  'greater_than', 'less_than', 'is_set', 'is_not_set',
];
// playbook_plays.priority is text, not integer
const PRIORITIES = [
  { value: 'high',   label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low' },
];

const EMPTY_CONDITION = { field: '', operator: 'equals', value: '' };

const DEFAULT_FORM = {
  title: '',
  description: '',
  channel: 'task',
  priority: 'medium',        // text — not integer
  trigger_mode: 'stage_change',
  schedule_config: { cron: '', offset_days: '' },
  fire_conditions: [],
  generation_mode: 'template',
  ai_config: { tone: 'professional', custom_system_prompt: '' },
  suggested_action: '',
  role_id: '',
  // action_type intentionally omitted — column does not exist on playbook_plays
};

// org_id is NOT NULL on playbook_plays — parent must pass it
export default function PlayEditor({ playbook_id, org_id, stage_key, play, onSave, onCancel }) {
  const isNew = !play;

  const [form, setForm] = useState(() => {
    if (!play) return { ...DEFAULT_FORM };
    return {
      ...DEFAULT_FORM,
      ...play,
      fire_conditions: play.fire_conditions
        ? (typeof play.fire_conditions === 'string'
            ? JSON.parse(play.fire_conditions)
            : play.fire_conditions)
        : [],
      schedule_config: play.schedule_config
        ? (typeof play.schedule_config === 'string'
            ? JSON.parse(play.schedule_config)
            : play.schedule_config)
        : DEFAULT_FORM.schedule_config,
      ai_config: play.ai_config
        ? (typeof play.ai_config === 'string'
            ? JSON.parse(play.ai_config)
            : play.ai_config)
        : DEFAULT_FORM.ai_config,
      role_id: play.role_id ?? '',
      priority: play.priority || 'medium',
    };
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const setNested = (parent, key, value) =>
    setForm((f) => ({ ...f, [parent]: { ...f[parent], [key]: value } }));

  const addCondition = () =>
    set('fire_conditions', [...form.fire_conditions, { ...EMPTY_CONDITION }]);
  const removeCondition = (i) =>
    set('fire_conditions', form.fire_conditions.filter((_, idx) => idx !== i));
  const updateCondition = (i, key, value) =>
    set('fire_conditions', form.fire_conditions.map((c, idx) => idx === i ? { ...c, [key]: value } : c));

  const handleSave = async () => {
    if (!form.title.trim()) return setError('Title is required');
    if (!form.channel) return setError('Channel is required');
    if (!org_id) return setError('Internal error: org_id missing. Please reload and try again.');
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...form,
        org_id,                 // required NOT NULL
        stage_key,
        fire_conditions: form.fire_conditions.length ? form.fire_conditions : [],
        schedule_config: form.trigger_mode === 'scheduled' ? form.schedule_config : null,
        ai_config: ['ai', 'hybrid'].includes(form.generation_mode) ? form.ai_config : null,
        role_id: form.role_id ? parseInt(form.role_id, 10) : null,
        // Strip action_type — column doesn't exist
        action_type: undefined,
      };
      if (isNew) {
        await apiService.playbookBuilder.createPlay(playbook_id, payload);
      } else {
        await apiService.playbookBuilder.updatePlay(playbook_id, play.id, payload);
      }
      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="play-editor">
      <div className="play-editor-header">
        <h4>{isNew ? 'Add Play' : 'Edit Play'}</h4>
        <button className="btn-icon" onClick={onCancel} type="button">✕</button>
      </div>

      {error && <div className="play-editor-error">{error}</div>}

      <div className="play-editor-body">
        {/* Basic fields */}
        <div className="form-section">
          <div className="form-row">
            <label className="form-label">
              Title *
              <input
                type="text"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="e.g. Send introduction email"
              />
            </label>
          </div>

          <div className="form-row form-row--2col">
            <label className="form-label">
              Channel *
              <select value={form.channel} onChange={(e) => set('channel', e.target.value)}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="form-label">
              Priority
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
          </div>

          <div className="form-row">
            <label className="form-label">
              Description
              <textarea
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="What should the assignee do?"
                rows={3}
              />
            </label>
          </div>
        </div>

        {/* Trigger mode */}
        <div className="form-section">
          <h5 className="form-section-title">Trigger</h5>
          <div className="form-row form-row--3col">
            {TRIGGER_MODES.map((mode) => (
              <label key={mode} className={`radio-card ${form.trigger_mode === mode ? 'radio-card--active' : ''}`}>
                <input
                  type="radio"
                  name="trigger_mode"
                  value={mode}
                  checked={form.trigger_mode === mode}
                  onChange={() => set('trigger_mode', mode)}
                />
                <span>{mode.replace(/_/g, ' ')}</span>
              </label>
            ))}
          </div>

          {form.trigger_mode === 'scheduled' && (
            <div className="form-row form-row--2col mt-2">
              <label className="form-label">
                Cron expression
                <input
                  type="text"
                  value={form.schedule_config.cron}
                  onChange={(e) => setNested('schedule_config', 'cron', e.target.value)}
                  placeholder="0 9 * * 1"
                />
              </label>
              <label className="form-label">
                Or offset (days after stage entry)
                <input
                  type="number"
                  value={form.schedule_config.offset_days}
                  onChange={(e) => setNested('schedule_config', 'offset_days', e.target.value)}
                  placeholder="3"
                />
              </label>
            </div>
          )}
        </div>

        {/* Fire conditions */}
        <div className="form-section">
          <div className="form-section-header">
            <h5 className="form-section-title">Fire Conditions</h5>
            <button type="button" className="btn-link" onClick={addCondition}>
              + Add condition
            </button>
          </div>
          {form.fire_conditions.length === 0 && (
            <p className="form-hint">No conditions — play fires unconditionally on trigger.</p>
          )}
          {form.fire_conditions.map((cond, i) => (
            <div key={i} className="condition-row">
              <input
                type="text"
                placeholder="field (e.g. deal.value)"
                value={cond.field}
                onChange={(e) => updateCondition(i, 'field', e.target.value)}
                className="condition-field"
              />
              <select
                value={cond.operator}
                onChange={(e) => updateCondition(i, 'operator', e.target.value)}
                className="condition-operator"
              >
                {CONDITION_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              {!['is_set', 'is_not_set'].includes(cond.operator) && (
                <input
                  type="text"
                  placeholder="value"
                  value={cond.value}
                  onChange={(e) => updateCondition(i, 'value', e.target.value)}
                  className="condition-value"
                />
              )}
              <button type="button" className="btn-icon btn-icon--danger" onClick={() => removeCondition(i)}>✕</button>
            </div>
          ))}
        </div>

        {/* Generation mode */}
        <div className="form-section">
          <h5 className="form-section-title">Generation Mode</h5>
          <div className="form-row form-row--3col">
            {GENERATION_MODES.map((mode) => (
              <label key={mode} className={`radio-card ${form.generation_mode === mode ? 'radio-card--active' : ''}`}>
                <input
                  type="radio"
                  name="generation_mode"
                  value={mode}
                  checked={form.generation_mode === mode}
                  onChange={() => set('generation_mode', mode)}
                />
                <span>{mode}</span>
              </label>
            ))}
          </div>

          {['ai', 'hybrid'].includes(form.generation_mode) && (
            <div className="ai-config-block">
              <div className="form-row form-row--2col">
                <label className="form-label">
                  AI Tone
                  <select value={form.ai_config.tone} onChange={(e) => setNested('ai_config', 'tone', e.target.value)}>
                    {AI_TONES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              </div>
              <label className="form-label">
                Custom system prompt (optional)
                <textarea
                  value={form.ai_config.custom_system_prompt}
                  onChange={(e) => setNested('ai_config', 'custom_system_prompt', e.target.value)}
                  placeholder="Override the default AI instruction for this play…"
                  rows={3}
                />
              </label>
            </div>
          )}
        </div>

        {/* Suggested action text */}
        <div className="form-section">
          <label className="form-label">
            Suggested Action Text
            <input
              type="text"
              value={form.suggested_action}
              onChange={(e) => set('suggested_action', e.target.value)}
              placeholder="Short instruction shown to the user in their action card"
              maxLength={120}
            />
          </label>
          <p className="form-hint">Shown on the action card in ActionsView. Max 120 characters.</p>
        </div>
      </div>

      <div className="play-editor-footer">
        <button className="btn-secondary" onClick={onCancel} disabled={saving} type="button">Cancel</button>
        <button className="btn-primary" onClick={handleSave} disabled={saving} type="button">
          {saving ? 'Saving…' : isNew ? 'Add Play' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
