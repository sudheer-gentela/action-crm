// ─────────────────────────────────────────────────────────────────────────────
// prospecting/StagedCampaignModal.js
//
// Signal-Based Campaigns — Phase 3: the STAGED New Campaign flow (D2).
// Three steps, in order:
//
//   1. Purpose & basics — name, purpose (activity_type), solution, description.
//   2. Targeting        — start from a Target Profile (org-shared library) and/or
//                         add Filter / Prioritize criteria inline. Composes the
//                         `targeting` block sent to the backend, which copies it
//                         into the campaign's config override (template, not
//                         live link).
//   3. Execution        — playbook, sequence, goal, schedule. CONDITIONAL on
//                         purpose = outreach (D2): non-outreach campaigns skip
//                         this step entirely; execution surfaces come later (P11).
//
// This handles the CREATE path only. Editing an existing campaign stays on the
// single-screen CampaignFormModal (settings surface, not a staged flow).
//
// Rep-facing language is Filter / Prioritize (D9). Reliability/Source are never
// shown. The signal catalog + rep-simple "+ Create" builder land in P4; here we
// pick from the existing catalog (GET /api/signal-catalog once P4 ships) and
// fall back gracefully to a free-key entry when the catalog endpoint isn't
// present yet, so this screen is useful the moment P3 is deployed.
//
// Styling reuses the app's pv-* modal/form system (see ProspectingView.css)
// plus a small scoped block appended there for the stepper + criteria rows.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';

const ACTIVITY_TYPES = [
  { value: 'outreach',    label: 'Outreach',    hint: 'Sequenced email + LinkedIn to a prospect pool.' },
  { value: 'field_event', label: 'Field event', hint: 'Drive and track attendance for an event.' },
  { value: 'digital',     label: 'Digital',     hint: 'Digital / paid motion; capture and route inbound.' },
  { value: 'discovery',   label: 'Discovery',   hint: 'Research a market before committing to outreach.' },
];

// Predicate operators offered per rep-chosen "what are you looking for" shape.
// Kept in lockstep with prospectingConfigSchema.TARGETING_OPERATORS.
const OPERATORS = [
  { value: 'is_true',     label: 'is true',            needsValue: false },
  { value: 'is_false',    label: 'is false',           needsValue: false },
  { value: 'exists',      label: 'is known',           needsValue: false },
  { value: 'one_of',      label: 'is one of',          needsValue: 'set' },
  { value: 'gte',         label: 'is at least',        needsValue: 'number' },
  { value: 'lte',         label: 'is at most',         needsValue: 'number' },
  { value: 'within_days', label: 'happened within (days)', needsValue: 'number' },
  { value: 'in_geo',      label: 'is in region',       needsValue: 'set' },
];

const STEPS_OUTREACH = ['Purpose & basics', 'Targeting', 'Execution'];
const STEPS_OTHER    = ['Purpose & basics', 'Targeting'];

let _cidSeq = 0;
const newRowId = () => `c${Date.now()}_${_cidSeq++}`;

function emptyCriterion(role) {
  return { _rid: newRowId(), role, signal_key: '', label: '', operator: 'exists', value: '' };
}

// Turn a UI criterion row into the API shape ({signal_key, predicate, label}).
// Returns null for incomplete rows so they're dropped silently (matches the
// backend sanitizer's forgiving contract).
function toApiCriterion(row) {
  const signalKey = (row.signal_key || '').trim();
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(signalKey)) return null;
  const op = OPERATORS.find(o => o.value === row.operator);
  if (!op) return null;
  const predicate = { operator: row.operator };
  if (op.needsValue === 'number') {
    const n = Number(row.value);
    if (!Number.isFinite(n)) return null;
    predicate.value = n;
  } else if (op.needsValue === 'set') {
    const vals = String(row.value || '').split(',').map(s => s.trim()).filter(Boolean);
    if (vals.length === 0) return null;
    predicate.value = vals;
  }
  const out = { signal_key: signalKey, predicate };
  if (row.label && row.label.trim()) out.label = row.label.trim();
  return out;
}

export default function StagedCampaignModal({ onSaved, onClose }) {
  const [step, setStep] = useState(0);

  // Step 1 — purpose & basics
  const [name, setName] = useState('');
  const [activityType, setActivityType] = useState('outreach');
  const [solution, setSolution] = useState('');
  const [description, setDescription] = useState('');

  // Step 2 — targeting
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');       // '' = start blank
  const [functionKey, setFunctionKey] = useState('');   // primary target function
  const [functions, setFunctions] = useState([]);
  const [filters, setFilters] = useState([]);
  const [prioritizers, setPrioritizers] = useState([]);

  // Step 3 — execution (outreach only)
  const [playbooks, setPlaybooks] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [playbookId, setPlaybookId] = useState('');
  const [sequenceId, setSequenceId] = useState('');
  const [goalQualified, setGoalQualified] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isOutreach = activityType === 'outreach';
  const steps = isOutreach ? STEPS_OUTREACH : STEPS_OTHER;

  // Load the shared libraries the targeting + execution steps need. All are
  // best-effort — a missing endpoint (e.g. signal catalog before P4) never
  // blocks the flow.
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/target-profiles');
        setProfiles(r.profiles || []);
      } catch { setProfiles([]); }
      try {
        const r = await apiFetch('/prospecting-functions');   // P2 taxonomy (if routed)
        setFunctions(r.functions || []);
      } catch { setFunctions([]); }
      try {
        const pb = await apiFetch('/playbooks?type=prospecting');
        setPlaybooks(pb.playbooks || []);
      } catch { setPlaybooks([]); }
      try {
        const sq = await apiFetch('/sequences');
        setSequences((sq.sequences || []).filter(s => s.status === 'active'));
      } catch { setSequences([]); }
    })();
  }, []);

  // Selecting a profile seeds its function tag + a read-only preview of what it
  // brings; the actual criteria copy happens server-side (template semantics),
  // so we don't merge its rows into the editable lists — we just show a count.
  const selectedProfile = profiles.find(p => String(p.id) === String(profileId)) || null;

  const addRow = (role) => {
    if (role === 'filter') setFilters(prev => [...prev, emptyCriterion('filter')]);
    else setPrioritizers(prev => [...prev, emptyCriterion('prioritize')]);
  };
  const updateRow = (role, rid, patch) => {
    const upd = (arr) => arr.map(r => (r._rid === rid ? { ...r, ...patch } : r));
    if (role === 'filter') setFilters(upd); else setPrioritizers(upd);
  };
  const removeRow = (role, rid) => {
    if (role === 'filter') setFilters(prev => prev.filter(r => r._rid !== rid));
    else setPrioritizers(prev => prev.filter(r => r._rid !== rid));
  };

  const canNext = () => {
    if (step === 0) return !!name.trim();
    return true;
  };

  const goNext = () => {
    setError('');
    if (step === 0 && !name.trim()) { setError('Give the campaign a name to continue.'); return; }
    setStep(s => Math.min(s + 1, steps.length - 1));
  };
  const goBack = () => { setError(''); setStep(s => Math.max(s - 1, 0)); };

  const buildTargeting = () => {
    const f = filters.map(toApiCriterion).filter(Boolean);
    const p = prioritizers.map(toApiCriterion).filter(Boolean);
    const targeting = { filters: f, prioritizers: p };
    if (functionKey) targeting.function_key = functionKey;
    // Only send a targeting block if there's something in it (or a function
    // pin); otherwise let the profile alone seed it, or leave it blank.
    const hasInline = f.length || p.length || functionKey;
    return hasInline ? targeting : null;
  };

  const handleCreate = async () => {
    if (!name.trim()) { setStep(0); setError('Give the campaign a name.'); return; }
    setBusy(true);
    setError('');
    const payload = {
      name: name.trim(),
      description: description || null,
      solution: solution || null,
      activity_type: activityType,
      status: 'active',
    };
    // Targeting seed: profile id (server copies its criteria) + any inline block.
    if (profileId) payload.target_profile_id = parseInt(profileId, 10);
    const targeting = buildTargeting();
    if (targeting) payload.targeting = targeting;

    // Execution — outreach only.
    if (isOutreach) {
      if (playbookId) payload.playbook_id = parseInt(playbookId, 10);
      if (sequenceId) payload.default_sequence_id = parseInt(sequenceId, 10);
      if (goalQualified) payload.goal_qualified = parseInt(goalQualified, 10);
      if (startDate) payload.start_date = startDate;
      if (endDate) payload.end_date = endDate;
    }

    try {
      await apiFetch('/prospecting-campaigns', { method: 'POST', body: JSON.stringify(payload) });
      onSaved();
    } catch (err) {
      setError('Create failed: ' + err.message);
      setBusy(false);
    }
  };

  const isLastStep = step === steps.length - 1;

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()}>
        <div className="pv-modal-header">
          <h3>New campaign</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Stepper */}
        <div className="pv-stepper">
          {steps.map((s, i) => (
            <div
              key={s}
              className={'pv-step' + (i === step ? ' is-active' : '') + (i < step ? ' is-done' : '')}
            >
              <span className="pv-step-dot">{i < step ? '✓' : i + 1}</span>
              <span className="pv-step-label">{s}</span>
            </div>
          ))}
        </div>

        <div className="pv-form">
          {/* ── Step 1: Purpose & basics ─────────────────────────────────── */}
          {step === 0 && (
            <>
              <div className="pv-form-section">
                <h4>Campaign</h4>
                <input
                  placeholder="Campaign name *"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                />
                <input
                  placeholder="Solution (e.g. SAP S/4HANA migration)"
                  value={solution}
                  onChange={e => setSolution(e.target.value)}
                />
                <textarea
                  placeholder="Description (optional)"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={2}
                />
              </div>
              <div className="pv-form-section">
                <h4>Purpose</h4>
                <div className="pv-purpose-grid">
                  {ACTIVITY_TYPES.map(a => (
                    <button
                      type="button"
                      key={a.value}
                      className={'pv-purpose-card' + (activityType === a.value ? ' is-selected' : '')}
                      onClick={() => setActivityType(a.value)}
                    >
                      <span className="pv-purpose-title">{a.label}</span>
                      <span className="pv-purpose-hint">{a.hint}</span>
                    </button>
                  ))}
                </div>
                {!isOutreach && (
                  <p className="pv-help">
                    Non-outreach campaigns skip the execution step for now — you set purpose and
                    targeting, and run the activity outside sequences.
                  </p>
                )}
              </div>
            </>
          )}

          {/* ── Step 2: Targeting ────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <div className="pv-form-section">
                <h4>Start from a profile</h4>
                <select value={profileId} onChange={e => setProfileId(e.target.value)}>
                  <option value="">Start blank</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.repAdded ? ' · rep-added' : ''}
                    </option>
                  ))}
                </select>
                {selectedProfile && (
                  <p className="pv-help">
                    Brings {selectedProfile.criteria?.filters?.length || 0} filter(s) and{' '}
                    {selectedProfile.criteria?.prioritizers?.length || 0} prioritizer(s). You can add
                    more below; anything you add layers on top.
                  </p>
                )}
              </div>

              {functions.length > 0 && (
                <div className="pv-form-section">
                  <h4>Target function</h4>
                  <select value={functionKey} onChange={e => setFunctionKey(e.target.value)}>
                    <option value="">Any / inherit</option>
                    {functions.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <CriteriaEditor
                title="Filter"
                subtitle="Must be true — defines who's in the pool."
                role="filter"
                rows={filters}
                onAdd={() => addRow('filter')}
                onUpdate={(rid, patch) => updateRow('filter', rid, patch)}
                onRemove={(rid) => removeRow('filter', rid)}
              />
              <CriteriaEditor
                title="Prioritize"
                subtitle="Ranks higher and picks the angle — excludes nobody."
                role="prioritize"
                rows={prioritizers}
                onAdd={() => addRow('prioritize')}
                onUpdate={(rid, patch) => updateRow('prioritize', rid, patch)}
                onRemove={(rid) => removeRow('prioritize', rid)}
              />

              {!profileId && filters.length === 0 && prioritizers.length === 0 && (
                <p className="pv-help">
                  No targeting yet — that's fine. The campaign starts empty and fills as a source
                  connects or you add contacts; each filter becomes a confirmation while you work.
                </p>
              )}
            </>
          )}

          {/* ── Step 3: Execution (outreach only) ────────────────────────── */}
          {step === 2 && isOutreach && (
            <>
              <div className="pv-form-section">
                <h4>Playbook &amp; sequence</h4>
                <select value={playbookId} onChange={e => setPlaybookId(e.target.value)}>
                  <option value="">No prospecting playbook</option>
                  {playbooks.map(pb => (
                    <option key={pb.id} value={pb.id}>{pb.is_default ? '★ ' : ''}{pb.name}</option>
                  ))}
                </select>
                <select value={sequenceId} onChange={e => setSequenceId(e.target.value)}>
                  <option value="">No default sequence</option>
                  {sequences.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="pv-form-section">
                <h4>Goal &amp; dates</h4>
                <input
                  type="number" min="0"
                  placeholder="Goal — qualified (SAL) count"
                  value={goalQualified}
                  onChange={e => setGoalQualified(e.target.value)}
                />
                <div className="pv-form-row">
                  <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
                  <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
                <p className="pv-help">
                  Sending schedule uses your org defaults. You can override it on the campaign after
                  it's created.
                </p>
              </div>
            </>
          )}

          {error && <div className="pv-form-error">{error}</div>}

          <div className="pv-form-actions">
            {step > 0
              ? <button type="button" className="pv-btn-secondary" onClick={goBack}>Back</button>
              : <button type="button" className="pv-btn-secondary" onClick={onClose}>Cancel</button>}
            {isLastStep
              ? (
                <button type="button" className="pv-btn-primary" disabled={busy} onClick={handleCreate}>
                  {busy ? 'Creating…' : 'Create campaign'}
                </button>
              ) : (
                <button type="button" className="pv-btn-primary" disabled={!canNext()} onClick={goNext}>
                  Next
                </button>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Filter / Prioritize criteria editor ──────────────────────────────────────
function CriteriaEditor({ title, subtitle, role, rows, onAdd, onUpdate, onRemove }) {
  return (
    <div className="pv-form-section">
      <h4>{title}</h4>
      <p className="pv-help pv-help-tight">{subtitle}</p>
      {rows.map(row => {
        const op = OPERATORS.find(o => o.value === row.operator);
        return (
          <div className="pv-criterion" key={row._rid}>
            <input
              className="pv-criterion-key"
              placeholder="signal key (e.g. raised_recently)"
              value={row.signal_key}
              onChange={e => onUpdate(row._rid, { signal_key: e.target.value })}
            />
            <select
              className="pv-criterion-op"
              value={row.operator}
              onChange={e => onUpdate(row._rid, { operator: e.target.value })}
            >
              {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {op && op.needsValue && (
              <input
                className="pv-criterion-val"
                placeholder={op.needsValue === 'set' ? 'a, b, c' : 'value'}
                value={row.value}
                onChange={e => onUpdate(row._rid, { value: e.target.value })}
              />
            )}
            <button type="button" className="pv-criterion-remove" onClick={() => onRemove(row._rid)}>×</button>
          </div>
        );
      })}
      <button type="button" className="pv-add-criterion" onClick={onAdd}>+ Add {title.toLowerCase()}</button>
    </div>
  );
}
