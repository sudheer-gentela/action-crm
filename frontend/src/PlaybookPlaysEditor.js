import React, { useState, useEffect, useCallback } from 'react';
import './PlaybookPlaysEditor.css';

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

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNELS = [
  { value: '',              label: 'None' },
  { value: 'email',         label: '✉️ Email' },
  { value: 'call',          label: '📞 Call' },
  { value: 'meeting',       label: '🤝 Meeting' },
  { value: 'linkedin',      label: '💼 LinkedIn' },
  { value: 'whatsapp',      label: '💬 WhatsApp' },
  { value: 'sms',           label: '📱 SMS' },
  { value: 'phone',         label: '☎️ Phone' },
  { value: 'slack',         label: '🟣 Slack' },
  { value: 'document',      label: '📄 Document' },
  { value: 'internal_task', label: '🏠 Internal Task' },
];

const PRIORITIES = ['high', 'medium', 'low'];

// ── PlayForm (create/edit) ──────────────────────────────────────────────────

function PlayForm({ play, roles, allPlays, onSave, onCancel, saving }) {
  const [title, setTitle]             = useState(play?.title || '');
  const [description, setDescription] = useState(play?.description || '');
  const [channel, setChannel]         = useState(play?.channel || '');
  const [priority, setPriority]       = useState(play?.priority || 'medium');
  const [executionType, setExecutionType] = useState(play?.execution_type || 'parallel');
  const [isGate, setIsGate]           = useState(play?.is_gate || false);
  const [unlocksPlayId, setUnlocksPlayId] = useState(play?.unlocks_play_id || null);
  const [dueOffsetDays, setDueOffsetDays] = useState(play?.due_offset_days ?? 3);
  const [suggestedAction, setSuggestedAction] = useState(play?.suggested_action || '');
  const [triggerMode, setTriggerMode] = useState(play?.trigger_mode || 'stage_change');
  const [scheduleFrequency, setScheduleFrequency] = useState(play?.schedule_config?.frequency || 'daily');
  const [scheduleDay, setScheduleDay] = useState(play?.schedule_config?.day || 'monday');
  const [generationMode, setGenerationMode] = useState(play?.generation_mode || 'template');
  const [aiTone, setAiTone]           = useState(play?.ai_config?.tone || '');
  const [aiSourcePlaybookId, setAiSourcePlaybookId] = useState(play?.ai_config?.source_playbook_id || '');
  const [aiCustomPrompt, setAiCustomPrompt] = useState(play?.ai_config?.custom_system_prompt || '');
  const [selectedRoles, setSelectedRoles] = useState(
    (play?.roles || []).filter(r => r.ownership_type === 'co_owner').map(r => r.role_id)
  );
  const [dependsOn, setDependsOn]     = useState(play?.depends_on || []);
  const [fireConditions, setFireConditions] = useState(
    Array.isArray(play?.fire_conditions) ? play.fire_conditions : []
  );

  function toggleRole(roleId) {
    setSelectedRoles(prev =>
      prev.includes(roleId) ? prev.filter(id => id !== roleId) : [...prev, roleId]
    );
  }

  function toggleDep(playId) {
    setDependsOn(prev =>
      prev.includes(playId) ? prev.filter(id => id !== playId) : [...prev, playId]
    );
  }

  function handleSubmit() {
    if (!title.trim()) return;
    const scheduleConfig = triggerMode === 'scheduled'
      ? { frequency: scheduleFrequency, ...(scheduleFrequency === 'weekly' ? { day: scheduleDay } : {}) }
      : null;
    const aiConfig = generationMode !== 'template'
      ? {
          ...(aiTone               ? { tone: aiTone }                                     : {}),
          ...(aiSourcePlaybookId   ? { source_playbook_id: parseInt(aiSourcePlaybookId) } : {}),
          ...(aiCustomPrompt.trim() ? { custom_system_prompt: aiCustomPrompt.trim() }     : {}),
        }
      : null;
    onSave({
      title: title.trim(),
      description: description.trim() || null,
      channel: channel || null,
      priority,
      executionType,
      isGate,
      unlocksPlayId: isGate ? (unlocksPlayId || null) : null,
      dueOffsetDays: parseInt(dueOffsetDays) || 3,
      suggestedAction: suggestedAction.trim() || null,
      triggerMode,
      scheduleConfig,
      generationMode,
      aiConfig: Object.keys(aiConfig || {}).length > 0 ? aiConfig : null,
      roleIds: selectedRoles,
      dependsOn: executionType === 'sequential' ? dependsOn : null,
      fireConditions,
    });
  }

  // Other plays for dependency selection (exclude self)
  const otherPlays = allPlays.filter(p => p.id !== play?.id);

  return (
    <div className="ppe-form">
      <div className="ppe-form__group">
        <label>Title <span className="ppe-required">*</span></label>
        <input
          className="ppe-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g., Schedule discovery call"
          autoFocus
        />
      </div>

      <div className="ppe-form__group">
        <label>Description</label>
        <textarea
          className="ppe-textarea"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Detailed guidance for this play…"
          rows={2}
        />
      </div>

      <div className="ppe-form__group">
        <label>Suggested Action</label>
        <textarea
          className="ppe-textarea"
          value={suggestedAction}
          onChange={e => setSuggestedAction(e.target.value)}
          placeholder="How-to guidance shown to the rep when completing this action…"
          rows={2}
        />
        <div className="ppe-form__hint">Shown as a coaching tip when the rep opens this action.</div>
      </div>

      <div className="ppe-form__row">
        <div className="ppe-form__group ppe-form__group--sm">
          <label>Channel</label>
          <select className="ppe-select" value={channel} onChange={e => setChannel(e.target.value)}>
            {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>

        <div className="ppe-form__group ppe-form__group--sm">
          <label>Priority</label>
          <select className="ppe-select" value={priority} onChange={e => setPriority(e.target.value)}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
        </div>

        <div className="ppe-form__group ppe-form__group--sm">
          <label>Due (days after stage entry)</label>
          <input
            className="ppe-input"
            type="number"
            min="1"
            max="90"
            value={dueOffsetDays}
            onChange={e => setDueOffsetDays(e.target.value)}
          />
        </div>
      </div>

      <div className="ppe-form__row">
        <div className="ppe-form__group ppe-form__group--sm">
          <label>Execution</label>
          <select className="ppe-select" value={executionType} onChange={e => setExecutionType(e.target.value)}>
            <option value="parallel">⚡ Parallel — starts immediately</option>
            <option value="sequential">🔗 Sequential — waits for dependencies</option>
          </select>
        </div>

        <div className="ppe-form__group ppe-form__group--sm">
          <label className="ppe-checkbox-label">
            <input type="checkbox" checked={isGate} onChange={e => setIsGate(e.target.checked)} />
            🚧 Gate — must complete to advance stage
          </label>
        </div>
      </div>

      {/* Unlocks play — only visible when this play is marked as a gate */}
      {isGate && (
        <div className="ppe-form__group">
          <label>🔓 Unlocks play when completed</label>
          <select
            className="ppe-select"
            value={unlocksPlayId || ''}
            onChange={e => setUnlocksPlayId(e.target.value ? parseInt(e.target.value) : null)}
          >
            <option value="">— No unlock (gate only, no auto-next) —</option>
            {otherPlays.map(p => (
              <option key={p.id} value={p.id}>
                {p.title.length > 55 ? p.title.slice(0, 55) + '…' : p.title}
              </option>
            ))}
          </select>
          <div className="ppe-form__hint">
            When a rep completes this gate action, the selected play will be automatically generated as their next action.
          </div>
        </div>
      )}

      {executionType === 'sequential' && otherPlays.length > 0 && (
        <div className="ppe-form__group">
          <label>Depends on (must complete before this play starts)</label>
          <div className="ppe-dep-list">
            {otherPlays.map(p => (
              <label key={p.id} className={`ppe-dep-chip ${dependsOn.includes(p.id) ? 'ppe-dep-chip--selected' : ''}`}>
                <input type="checkbox" checked={dependsOn.includes(p.id)} onChange={() => toggleDep(p.id)} />
                {p.title.length > 40 ? p.title.slice(0, 40) + '…' : p.title}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Trigger Mode */}
      <div className="ppe-form__group">
        <label>Trigger Mode</label>
        <select className="ppe-select" value={triggerMode} onChange={e => setTriggerMode(e.target.value)}>
          <option value="stage_change">🔀 Stage Change — fires when deal enters this stage</option>
          <option value="on_demand">🖱️ On Demand — fires when Generate Actions is clicked</option>
          <option value="scheduled">⏰ Scheduled — fires on a recurring schedule (nightly sweep)</option>
        </select>
      </div>

      {triggerMode === 'scheduled' && (
        <div className="ppe-form__row">
          <div className="ppe-form__group ppe-form__group--sm">
            <label>Frequency</label>
            <select className="ppe-select" value={scheduleFrequency} onChange={e => setScheduleFrequency(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="hourly">Hourly</option>
            </select>
          </div>
          {scheduleFrequency === 'weekly' && (
            <div className="ppe-form__group ppe-form__group--sm">
              <label>Day of Week</label>
              <select className="ppe-select" value={scheduleDay} onChange={e => setScheduleDay(e.target.value)}>
                {['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d => (
                  <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Generation Mode */}
      <div className="ppe-form__group">
        <label>Generation Mode</label>
        <select className="ppe-select" value={generationMode} onChange={e => setGenerationMode(e.target.value)}>
          <option value="template">📋 Template — use play title/description as-is</option>
          <option value="ai">🤖 AI — Claude enriches action with entity context</option>
          <option value="hybrid">⚡ Hybrid — template shape, AI-enriched description</option>
        </select>
        <div className="ppe-form__hint">
          {generationMode === 'template' && 'Always uses template regardless of playbook AI setting.'}
          {generationMode === 'ai'       && 'Always calls Claude regardless of playbook AI toggle.'}
          {generationMode === 'hybrid'   && 'Uses template structure, AI fills in the description.'}
        </div>
      </div>

      {generationMode !== 'template' && (
        <div className="ppe-form" style={{ background: '#fdf4ff', borderColor: '#e9d5ff', marginTop: 0, marginBottom: 14 }}>
          <div className="ppe-form__group">
            <label>Tone</label>
            <select className="ppe-select" value={aiTone} onChange={e => setAiTone(e.target.value)}>
              <option value="">— Default (no tone preamble) —</option>
              <option value="formal">🎩 Formal — precise, no contractions, senior-stakeholder appropriate</option>
              <option value="consultative">🤝 Consultative — advisory, trusted-partner positioning</option>
              <option value="direct">⚡ Direct — concise, lead with the action, skip preamble</option>
              <option value="friendly">😊 Friendly — warm, personable, supportive</option>
            </select>
          </div>
          <div className="ppe-form__group">
            <label>Cross-Playbook Context (source_playbook_id)</label>
            <input
              className="ppe-input"
              type="number"
              placeholder="Playbook ID — pulls that playbook's plays as extra context"
              value={aiSourcePlaybookId}
              onChange={e => setAiSourcePlaybookId(e.target.value)}
            />
            <div className="ppe-form__hint">Optional. Useful for CLM plays that need sales playbook context.</div>
          </div>
          <div className="ppe-form__group">
            <label>Custom System Prompt</label>
            <textarea
              className="ppe-textarea"
              rows={4}
              placeholder={"Full prompt override. Supports: {{entity_summary}}, {{plays_summary}}, {{stage_key}}, {{guidance_summary}}"}
              value={aiCustomPrompt}
              onChange={e => setAiCustomPrompt(e.target.value)}
            />
            <div className="ppe-form__hint">When set, overrides all module-level prompt logic. Leave blank to use default.</div>
          </div>
        </div>
      )}

      <div className="ppe-form__group">
        <label>Role Co-Owners</label>
        <div className="ppe-role-grid">
          {roles.map(role => (
            <label
              key={role.id}
              className={`ppe-role-chip ${selectedRoles.includes(role.id) ? 'ppe-role-chip--selected' : ''}`}
              title={role.org_role_key
                ? `Team queue: org_role_key="${role.org_role_key}" — matched team exists`
                : 'No team queue configured for this role — will fall back to entity owner'}
            >
              <input type="checkbox" checked={selectedRoles.includes(role.id)} onChange={() => toggleRole(role.id)} />
              {role.name}
              {role.org_role_key
                ? <span className="ppe-role-chip__queue-indicator ppe-role-chip__queue-indicator--matched" title={`Team queue: ${role.org_role_key}`}>✓</span>
                : <span className="ppe-role-chip__queue-indicator ppe-role-chip__queue-indicator--missing" title="No team queue">–</span>
              }
            </label>
          ))}
        </div>
        {selectedRoles.length === 0 && (
          <div className="ppe-form__hint">Select at least one role to own this play</div>
        )}
        <div className="ppe-form__hint">
          ✓ = team queue configured (org_role_key set on a team) &nbsp;·&nbsp; – = falls back to entity owner
        </div>
      </div>

      {/* Fire Conditions — controls when this play generates an action */}
      <FireConditionsBuilder
        conditions={fireConditions}
        onChange={setFireConditions}
      />

      <div className="ppe-form__actions">
        <button className="ppe-btn ppe-btn--primary" onClick={handleSubmit} disabled={saving || !title.trim()}>
          {saving ? 'Saving…' : (play ? 'Update Play' : 'Create Play')}
        </button>
        <button className="ppe-btn ppe-btn--secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── FireConditionsBuilder ─────────────────────────────────────────────────────
//
// Lets admins attach fire conditions to a play.
// Each condition is evaluated at action-generation time against deal context.
// Empty conditions = fire unconditionally (safe default).

const CONDITION_TYPES = [
  // ── Deal / Sales ───────────────────────────────────────────────────────────
  { value: 'no_meeting_this_stage',  label: '📅 No meeting yet this stage',        module: 'deal',     params: [] },
  { value: 'meeting_not_scheduled',  label: '📅 No meeting currently scheduled',   module: 'deal',     params: [] },
  { value: 'no_email_since_meeting', label: '✉️ No follow-up email after meeting', module: 'deal',     params: [] },
  { value: 'no_contact_role',        label: '👤 Missing contact role',             module: 'deal',     params: ['role'] },
  { value: 'no_file_matching',       label: '📄 No file matching pattern',         module: 'deal',     params: ['pattern'] },
  { value: 'days_in_stage',          label: '⏱ Days in stage',                    module: 'deal',     params: ['operator', 'value'] },
  { value: 'days_until_close',       label: '📆 Days until close date',            module: 'deal',     params: ['operator', 'value'] },
  { value: 'health_param_state',     label: '❤️ Health parameter state',           module: 'deal',     params: ['param', 'state'] },
  // ── CLM / Contract ─────────────────────────────────────────────────────────
  { value: 'contract_status_is',     label: '📃 Contract status is',               module: 'clm',      params: ['contract_status'] },
  { value: 'review_sub_status_is',   label: '🔍 Review sub-status is',             module: 'clm',      params: ['review_sub_status'] },
  { value: 'days_to_expiry',         label: '⏳ Days to expiry',                   module: 'clm',      params: ['operator', 'value'] },
  { value: 'has_no_renewal',         label: '🔄 Has no renewal contract',          module: 'clm',      params: [] },
  // ── Service / Cases ────────────────────────────────────────────────────────
  { value: 'priority_is',            label: '🚨 Case priority is',                 module: 'service',  params: ['case_priority'] },
  { value: 'sla_tier_is',            label: '🏷️ SLA tier is',                      module: 'service',  params: ['string_value'] },
  { value: 'response_breached',      label: '⚠️ Response SLA breached',            module: 'service',  params: [] },
  { value: 'resolution_breached',    label: '🔴 Resolution SLA breached',          module: 'service',  params: [] },
  // ── Prospect ───────────────────────────────────────────────────────────────
  { value: 'icp_score_above',        label: '🎯 ICP score above',                  module: 'prospect', params: ['value'] },
  { value: 'outreach_count_above',   label: '📤 Outreach count above',             module: 'prospect', params: ['value'] },
];

const CONTACT_ROLES = [
  { value: 'decision_maker', label: 'Decision Maker' },
  { value: 'champion',       label: 'Champion' },
  { value: 'executive',      label: 'Executive' },
  { value: 'influencer',     label: 'Influencer' },
];

const OPERATORS = [
  { value: '>',  label: 'more than' },
  { value: '>=', label: 'at least' },
  { value: '<',  label: 'less than' },
  { value: '<=', label: 'at most' },
];

const HEALTH_PARAMS = [
  { value: '1a', label: '1a — Close date credibility' },
  { value: '1b', label: '1b — Close date slippage' },
  { value: '1c', label: '1c — Urgency driver' },
  { value: '2a', label: '2a — Economic buyer' },
  { value: '2b', label: '2b — Executive engagement' },
  { value: '2c', label: '2c — Stakeholder coverage' },
  { value: '3a', label: '3a — Legal / procurement' },
  { value: '3b', label: '3b — Security / IT review' },
  { value: '4a', label: '4a — Deal size' },
  { value: '4c', label: '4c — Scope sign-off' },
  { value: '5a', label: '5a — Competitive' },
  { value: '5b', label: '5b — Price sensitivity' },
  { value: '5c', label: '5c — Discount approval' },
  { value: '6a', label: '6a — Meeting cadence' },
  { value: '6b', label: '6b — Response time' },
];

const HEALTH_STATES = [
  { value: 'absent',    label: 'Absent' },
  { value: 'unknown',   label: 'Unknown' },
  { value: 'confirmed', label: 'Confirmed' },
];

const CONTRACT_STATUSES = [
  { value: 'draft',         label: 'Draft' },
  { value: 'in_review',     label: 'In Review' },
  { value: 'in_signatures', label: 'In Signatures' },
  { value: 'active',        label: 'Active' },
  { value: 'expired',       label: 'Expired' },
];

const REVIEW_SUB_STATUSES = [
  { value: 'with_legal',    label: 'With Legal' },
  { value: 'with_sales',    label: 'With Sales' },
  { value: 'with_customer', label: 'With Customer' },
];

const CASE_PRIORITIES = [
  { value: 'critical', label: 'Critical' },
  { value: 'high',     label: 'High' },
  { value: 'medium',   label: 'Medium' },
  { value: 'low',      label: 'Low' },
];

function FireConditionsBuilder({ conditions, onChange }) {
  function addCondition() {
    onChange([...conditions, { type: 'no_meeting_this_stage' }]);
  }

  function removeCondition(idx) {
    onChange(conditions.filter((_, i) => i !== idx));
  }

  function updateCondition(idx, updates) {
    onChange(conditions.map((c, i) => i === idx ? { ...c, ...updates } : c));
  }

  const condMeta = (type) => CONDITION_TYPES.find(ct => ct.value === type) || CONDITION_TYPES[0];

  return (
    <div className="ppe-conditions">
      <div className="ppe-conditions__header">
        <label className="ppe-conditions__title">
          🎯 Fire Conditions
          <span className="ppe-conditions__hint">
            {conditions.length === 0
              ? ' — fires unconditionally'
              : ` — fires only when ALL ${conditions.length} condition${conditions.length > 1 ? 's' : ''} pass`}
          </span>
        </label>
        <button
          type="button"
          className="ppe-btn ppe-btn--sm ppe-btn--secondary"
          onClick={addCondition}
        >
          + Add Condition
        </button>
      </div>

      {conditions.length === 0 && (
        <p className="ppe-conditions__empty">
          No conditions set — this play will generate an action for every deal in this stage.
          Add conditions to make it context-aware.
        </p>
      )}

      {conditions.map((cond, idx) => {
        const meta = condMeta(cond.type);
        return (
          <div key={idx} className="ppe-condition-row">
            <select
              className="ppe-select ppe-select--condition-type"
              value={cond.type}
              onChange={e => updateCondition(idx, { type: e.target.value })}
            >
              {CONDITION_TYPES.map(ct => (
                <option key={ct.value} value={ct.value}>{ct.label}</option>
              ))}
            </select>

            {/* role param */}
            {meta.params.includes('role') && (
              <select
                className="ppe-select ppe-select--sm"
                value={cond.role || 'decision_maker'}
                onChange={e => updateCondition(idx, { role: e.target.value })}
              >
                {CONTACT_ROLES.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            )}

            {/* pattern param */}
            {meta.params.includes('pattern') && (
              <input
                className="ppe-input ppe-input--sm"
                placeholder="e.g. proposal|quote|pricing"
                value={cond.pattern || ''}
                onChange={e => updateCondition(idx, { pattern: e.target.value })}
              />
            )}

            {/* operator + value params */}
            {meta.params.includes('operator') && (
              <>
                <select
                  className="ppe-select ppe-select--sm"
                  value={cond.operator || '>'}
                  onChange={e => updateCondition(idx, { operator: e.target.value })}
                >
                  {OPERATORS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <input
                  className="ppe-input ppe-input--xs"
                  type="number"
                  min="0"
                  max="365"
                  placeholder="days"
                  value={cond.value ?? ''}
                  onChange={e => updateCondition(idx, { value: parseInt(e.target.value) || 0 })}
                />
                <span className="ppe-condition-unit">days</span>
              </>
            )}

            {/* health param + state */}
            {meta.params.includes('param') && (
              <>
                <select
                  className="ppe-select ppe-select--sm"
                  value={cond.param || '2a'}
                  onChange={e => updateCondition(idx, { param: e.target.value })}
                >
                  {HEALTH_PARAMS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <span className="ppe-condition-unit">is</span>
                <select
                  className="ppe-select ppe-select--sm"
                  value={cond.state || 'absent'}
                  onChange={e => updateCondition(idx, { state: e.target.value })}
                >
                  {HEALTH_STATES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </>
            )}

            {/* contract_status param */}
            {meta.params.includes('contract_status') && (
              <select
                className="ppe-select ppe-select--sm"
                value={cond.value || 'in_review'}
                onChange={e => updateCondition(idx, { value: e.target.value })}
              >
                {CONTRACT_STATUSES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}

            {/* review_sub_status param */}
            {meta.params.includes('review_sub_status') && (
              <select
                className="ppe-select ppe-select--sm"
                value={cond.value || 'with_legal'}
                onChange={e => updateCondition(idx, { value: e.target.value })}
              >
                {REVIEW_SUB_STATUSES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}

            {/* case_priority param */}
            {meta.params.includes('case_priority') && (
              <select
                className="ppe-select ppe-select--sm"
                value={cond.value || 'high'}
                onChange={e => updateCondition(idx, { value: e.target.value })}
              >
                {CASE_PRIORITIES.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            )}

            {/* plain string_value param (e.g. SLA tier id) */}
            {meta.params.includes('string_value') && (
              <input
                className="ppe-input ppe-input--sm"
                placeholder="value"
                value={cond.value || ''}
                onChange={e => updateCondition(idx, { value: e.target.value })}
              />
            )}

            {/* plain numeric value param (no operator — e.g. icp_score_above) */}
            {meta.params.includes('value') && !meta.params.includes('operator') && (
              <input
                className="ppe-input ppe-input--xs"
                type="number"
                min="0"
                placeholder="value"
                value={cond.value ?? ''}
                onChange={e => updateCondition(idx, { value: parseInt(e.target.value) || 0 })}
              />
            )}

            <button
              type="button"
              className="ppe-condition-remove"
              onClick={() => removeCondition(idx)}
              title="Remove condition"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Play Card (read-only view) ──────────────────────────────────────────────

function PlayCard({ play, index, canEdit, onEdit, onDelete, allPlays = [], entityId = null }) {
  const [deleting, setDeleting] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState(null);
  const roles = (play.roles || []).filter(r => r.ownership_type === 'co_owner');

  async function handleDelete() {
    if (!window.confirm(`Delete "${play.title}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await onDelete(play.id);
    } finally {
      setDeleting(false);
    }
  }

  async function handleSimulate() {
    if (!entityId) { setSimResult({ error: 'No entity selected for simulation.' }); return; }
    setSimulating(true);
    setSimResult(null);
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('authToken');
      const API = process.env.REACT_APP_API_URL || '';
      const res = await fetch(
        `${API}/api/playbook-plays/${play.id}/simulate?entityId=${entityId}&entityType=deal`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      setSimResult(data);
    } catch (err) {
      setSimResult({ error: err.message });
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div className={`ppe-card ${play.is_gate ? 'ppe-card--gate' : ''} ${!play.is_active ? 'ppe-card--inactive' : ''}`}>
      <div className="ppe-card__order">{index + 1}</div>

      <div className="ppe-card__body">
        <div className="ppe-card__title-row">
          {play.channel && <span className="ppe-card__channel">{CHANNELS.find(c => c.value === play.channel)?.label.split(' ')[0] || '📋'}</span>}
          <span className="ppe-card__title">{play.title}</span>
          {play.is_gate && (
            <span className="ppe-card__gate-badge">
              🚧 GATE
              {play.unlocks_play_id && (
                <span className="ppe-card__gate-unlocks">
                  {' → 🔓 '}
                  {allPlays?.find(p => p.id === play.unlocks_play_id)?.title?.slice(0, 30) || `Play #${play.unlocks_play_id}`}
                </span>
              )}
            </span>
          )}
          <span className={`ppe-card__exec-badge ppe-card__exec-badge--${play.execution_type}`}>
            {play.execution_type === 'sequential' ? '🔗 sequential' : '⚡ parallel'}
          </span>
        </div>

        {play.description && (
          <div className="ppe-card__desc">{play.description}</div>
        )}

        <div className="ppe-card__meta">
          <span className="ppe-card__priority" data-priority={play.priority}>{play.priority}</span>
          <span className="ppe-card__due">+{play.due_offset_days}d</span>
          {play.depends_on && play.depends_on.length > 0 && (
            <span className="ppe-card__deps">depends on {play.depends_on.length} play{play.depends_on.length !== 1 ? 's' : ''}</span>
          )}
        </div>

        {roles.length > 0 && (
          <div className="ppe-card__roles">
            {roles.map((r, i) => (
              <span key={r.role_id || i} className="ppe-card__role-pill">{r.role_name}</span>
            ))}
          </div>
        )}
      </div>

      {canEdit && (
        <div className="ppe-card__actions">
          <button className="ppe-btn ppe-btn--icon" onClick={() => onEdit(play)} title="Edit">✏️</button>
          <button
            className="ppe-btn ppe-btn--icon"
            onClick={handleSimulate}
            disabled={simulating}
            title="Simulate — test if this play would fire for an entity"
          >
            {simulating ? '⏳' : '▶️'}
          </button>
          <button className="ppe-btn ppe-btn--icon ppe-btn--danger" onClick={handleDelete} disabled={deleting} title="Delete">
            {deleting ? '…' : '🗑️'}
          </button>
        </div>
      )}

      {simResult && (
        <div className={`ppe-sim-result ${simResult.error || simResult.would_fire === false ? 'ppe-sim-result--miss' : 'ppe-sim-result--hit'}`}>
          {simResult.error
            ? `⚠️ ${simResult.error}`
            : simResult.would_fire
              ? `✅ Would fire — ${simResult.reason || 'all conditions passed'}`
              : `⛔ Would not fire — ${simResult.reason || 'condition not met'}`
          }
          <button className="ppe-sim-result__close" onClick={() => setSimResult(null)}>×</button>
        </div>
      )}
    </div>
  );
}

// ── Roles Config Panel ──────────────────────────────────────────────────────

function RolesConfigPanel({ allOrgRoles, currentRoleIds, rolesSource, onSave, onCancel, saving }) {
  const [selected, setSelected] = useState(
    currentRoleIds.length > 0 ? new Set(currentRoleIds) : new Set()
  );
  const isUsingDefaults = rolesSource === 'org_default' && selected.size === 0;

  function toggle(roleId) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(allOrgRoles.map(r => r.id)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  return (
    <div className="ppe-roles-config">
      <div className="ppe-roles-config__header">
        <span className="ppe-roles-config__title">Configure Playbook Roles</span>
        <span className="ppe-roles-config__hint">
          {isUsingDefaults
            ? 'Currently using all org roles. Select specific roles to customize this playbook.'
            : `${selected.size} role${selected.size !== 1 ? 's' : ''} selected. Clear all to revert to org defaults.`}
        </span>
      </div>

      <div className="ppe-roles-config__grid">
        {allOrgRoles.map(role => (
          <label
            key={role.id}
            className={`ppe-role-chip ${selected.has(role.id) ? 'ppe-role-chip--selected' : ''}`}
          >
            <input type="checkbox" checked={selected.has(role.id)} onChange={() => toggle(role.id)} />
            {role.name}
            {role.is_system && <span className="ppe-roles-config__system">system</span>}
          </label>
        ))}
      </div>

      <div className="ppe-roles-config__actions">
        <button className="ppe-btn ppe-btn--primary" onClick={() => onSave([...selected])} disabled={saving}>
          {saving ? 'Saving…' : selected.size > 0 ? `Save ${selected.size} Roles` : 'Use All Org Roles'}
        </button>
        <button className="ppe-btn ppe-btn--secondary" onClick={onCancel}>Cancel</button>
        <div style={{ flex: 1 }} />
        <button className="ppe-btn ppe-btn--tiny-text" onClick={selectAll}>Select All</button>
        <button className="ppe-btn ppe-btn--tiny-text" onClick={clearAll}>Clear All</button>
      </div>
    </div>
  );
}

// ── Main: PlaybookPlaysEditor ───────────────────────────────────────────────

export default function PlaybookPlaysEditor({ playbookId, readOnly = false }) {
  const [stages, setStages]         = useState([]);
  const [playsByStage, setPlaysByStage] = useState({});
  const [roles, setRoles]           = useState([]);         // roles available for this playbook
  const [allOrgRoles, setAllOrgRoles] = useState([]);       // all org roles (for config)
  const [rolesSource, setRolesSource] = useState('org_default'); // 'playbook' or 'org_default'
  const [playbookType, setPlaybookType] = useState(null);   // 'sales' or 'prospecting'
  const [activeStage, setActiveStage] = useState('');
  const [editingPlay, setEditingPlay] = useState(null);   // null | 'new' | play object
  const [filterRole, setFilterRole]   = useState('all');
  const [showRolesConfig, setShowRolesConfig] = useState(false);
  const [savingRoles, setSavingRoles] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
  const userOrgRole = currentUser.org_role || currentUser.role || currentUser.orgRole || '';
  const activeNavRole = sessionStorage.getItem('activeRole') || '';
  const isAdmin = !readOnly && (userOrgRole === 'owner' || userOrgRole === 'admin'
    || activeNavRole === 'org-admin' || activeNavRole === 'super-admin');

  const fetchData = useCallback(async () => {
    if (!playbookId) return;
    try {
      // First get playbook info to determine type
      const pbRes = await apiFetch(`/playbooks/${playbookId}`);
      const pb = pbRes.playbook || pbRes;
      setPlaybookType(pb.type || 'sales');

      // All stage sources unified through /org/admin/playbook-stages/:playbookId
      // Backend routes to deal_stages, prospect_stages, or playbook_stages table
      // based on the playbook's type — no branching needed here.
      const stagesPromise = apiFetch(`/org/admin/playbook-stages/${playbookId}`)
        .then(d => ({ stages: d.stages }));

      // Fetch plays, playbook-specific roles, and correct stages in parallel
      const [playsRes, pbRolesRes, stagesRes] = await Promise.all([
        apiFetch(`/playbook-plays/playbook/${playbookId}/all`),
        apiFetch(`/playbook-plays/playbook/${playbookId}/roles`),
        stagesPromise,
      ]);

      // Roles: try /org-roles first, fall back to /deal-roles for backward compat
      let allRolesRes;
      try {
        allRolesRes = await apiFetch('/org-roles');
      } catch {
        allRolesRes = await apiFetch('/deal-roles');
      }

      const allStages = (stagesRes.stages || []).filter(s => s.is_active && !s.is_terminal);
      setStages(allStages);
      setPlaysByStage(playsRes.plays || {});

      // Roles: use playbook-specific if configured, else all org roles
      const pbRoles = pbRolesRes.roles || [];
      const orgRoles = (allRolesRes.roles || []).filter(r => r.is_active);
      setAllOrgRoles(orgRoles);
      setRoles(pbRoles.length > 0 ? pbRoles : orgRoles);
      setRolesSource(pbRolesRes.source || 'org_default');

      if (!activeStage && allStages.length > 0) {
        setActiveStage(allStages[0].key);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [playbookId, activeStage]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const currentPlays = playsByStage[activeStage] || [];

  // ── Role filter ────────────────────────────────────────────────────────────
  const filteredPlays = filterRole === 'all'
    ? currentPlays
    : currentPlays.filter(p =>
        (p.roles || []).some(r => String(r.role_id) === String(filterRole))
      );

  // Collect unique roles across ALL plays in the active stage for the dropdown
  const stageRoles = [];
  const seenRoleIds = new Set();
  for (const p of currentPlays) {
    for (const r of (p.roles || [])) {
      if (r.role_id && !seenRoleIds.has(r.role_id)) {
        seenRoleIds.add(r.role_id);
        stageRoles.push({ id: r.role_id, name: r.role_name, key: r.role_key });
      }
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async function handleSavePlay(data) {
    setSaving(true);
    setError('');
    try {
      if (editingPlay && editingPlay !== 'new') {
        // Update
        await apiFetch(`/playbook-plays/${editingPlay.id}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        });
        // Update roles separately
        await apiFetch(`/playbook-plays/${editingPlay.id}/roles`, {
          method: 'PUT',
          body: JSON.stringify({ roles: data.roleIds.map(id => ({ roleId: id, ownershipType: 'co_owner' })) }),
        });
      } else {
        // Create
        await apiFetch('/playbook-plays', {
          method: 'POST',
          body: JSON.stringify({ playbookId, stageKey: activeStage, ...data }),
        });
      }
      setEditingPlay(null);
      fetchData();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePlay(playId) {
    try {
      await apiFetch(`/playbook-plays/${playId}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      setError(err.message);
    }
  }

  // ── Save playbook roles config ─────────────────────────────────────────────

  async function handleSavePlaybookRoles(selectedRoleIds) {
    setSavingRoles(true);
    setError('');
    try {
      const res = await apiFetch(`/playbook-plays/playbook/${playbookId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds: selectedRoleIds }),
      });
      const newRoles = res.roles || [];
      setRoles(newRoles.length > 0 ? newRoles : allOrgRoles);
      setRolesSource(res.source || (newRoles.length > 0 ? 'playbook' : 'org_default'));
      setShowRolesConfig(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingRoles(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="ppe-loading">Loading playbook plays…</div>;
  }

  const stageNoun = playbookType === 'prospecting' ? 'prospect stage'
    : playbookType === 'clm' ? 'contract stage'
    : playbookType === 'service' ? 'case status'
    : playbookType === 'handover_s2i' ? 'handover stage'
    : 'stage';

  return (
    <div className="ppe-root">
      <div className="ppe-header">
        <div>
          <h3 className="ppe-header__title">Plays by Stage</h3>
          <p className="ppe-header__subtitle">
            Define the plays each role executes at every {stageNoun}.
            {!isAdmin && ' You can view plays but only admins can edit.'}
          </p>
        </div>
        {isAdmin && (
          <button
            className={`ppe-btn ${showRolesConfig ? 'ppe-btn--secondary' : 'ppe-btn--roles'}`}
            onClick={() => setShowRolesConfig(v => !v)}
          >
            {showRolesConfig ? 'Close' : `⚙ Roles (${roles.length})`}
          </button>
        )}
      </div>

      {/* Roles config panel */}
      {showRolesConfig && isAdmin && (
        <RolesConfigPanel
          allOrgRoles={allOrgRoles}
          currentRoleIds={rolesSource === 'playbook' ? roles.map(r => r.id) : []}
          rolesSource={rolesSource}
          onSave={handleSavePlaybookRoles}
          onCancel={() => setShowRolesConfig(false)}
          saving={savingRoles}
        />
      )}

      {error && <div className="ppe-error">{error} <button onClick={() => setError('')}>✕</button></div>}

      {/* Stage tabs */}
      <div className="ppe-stage-tabs">
        {stages.map(stage => {
          const count = (playsByStage[stage.key] || []).length;
          const gateCount = (playsByStage[stage.key] || []).filter(p => p.is_gate).length;
          return (
            <button
              key={stage.key}
              className={`ppe-stage-tab ${activeStage === stage.key ? 'ppe-stage-tab--active' : ''}`}
              onClick={() => { setActiveStage(stage.key); setEditingPlay(null); setFilterRole('all'); }}
            >
              {stage.name}
              {count > 0 && (
                <span className="ppe-stage-tab__count">
                  {count}{gateCount > 0 ? ` · ${gateCount}🚧` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Plays for active stage */}
      <div className="ppe-stage-content">
        {activeStage && (
          <>
            <div className="ppe-stage-content__header">
              <span className="ppe-stage-content__label">
                {filterRole === 'all'
                  ? `${currentPlays.length} play${currentPlays.length !== 1 ? 's' : ''} in ${stages.find(s => s.key === activeStage)?.name || activeStage}`
                  : `${filteredPlays.length} of ${currentPlays.length} plays for ${stageRoles.find(r => String(r.id) === String(filterRole))?.name || 'role'}`
                }
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {stageRoles.length > 1 && (
                  <select
                    className="ppe-select"
                    style={{ width: 'auto', minWidth: 160, fontSize: 12, padding: '5px 10px' }}
                    value={filterRole}
                    onChange={e => setFilterRole(e.target.value)}
                  >
                    <option value="all">All Roles ({currentPlays.length})</option>
                    {stageRoles.map(r => {
                      const count = currentPlays.filter(p => (p.roles || []).some(pr => String(pr.role_id) === String(r.id))).length;
                      return <option key={r.id} value={r.id}>{r.name} ({count})</option>;
                    })}
                  </select>
                )}
                {isAdmin && !editingPlay && (
                  <button className="ppe-btn ppe-btn--primary" onClick={() => setEditingPlay('new')}>
                    + Add Play
                  </button>
                )}
              </div>
            </div>

            {/* Play cards */}
            {filteredPlays.length === 0 && !editingPlay && (
              <div className="ppe-empty">
                {filterRole === 'all'
                  ? <>No plays defined for this stage.{isAdmin && ' Click "+ Add Play" to create one.'}</>
                  : <>No plays assigned to {stageRoles.find(r => String(r.id) === String(filterRole))?.name || 'this role'} in this stage.</>
                }
              </div>
            )}

            <div className="ppe-cards">
              {filteredPlays.map((play, idx) => (
                <PlayCard
                  key={play.id}
                  play={play}
                  index={idx}
                  canEdit={isAdmin}
                  onEdit={p => setEditingPlay(p)}
                  onDelete={handleDeletePlay}
                  allPlays={Object.values(playsByStage).flat()}
                />
              ))}
            </div>

            {/* Create/Edit form */}
            {editingPlay && (
              <PlayForm
                play={editingPlay === 'new' ? null : editingPlay}
                roles={roles}
                allPlays={currentPlays}
                onSave={handleSavePlay}
                onCancel={() => setEditingPlay(null)}
                saving={saving}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
