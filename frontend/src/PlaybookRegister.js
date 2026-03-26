import { apiService } from './apiService';
// ============================================================
// ActionCRM Playbook Builder — C7: PlaybookRegister
// File: frontend/src/PlaybookRegister.js
// 4-step wizard: Define → Stages & Plays → Access → Submit
// ============================================================

import React, { useState } from 'react';
import './PlaybookRegister.css';

const STEPS = [
  { number: 1, label: 'Define',         key: 'define' },
  { number: 2, label: 'Stages & Plays', key: 'stages' },
  { number: 3, label: 'Access',         key: 'access' },
  { number: 4, label: 'Submit',         key: 'submit' },
];

const PLAYBOOK_TYPES  = ['sales', 'clm', 'hr', 'legal', 'custom'];
const ENTITY_TYPES    = ['deals', 'contracts', 'cases', 'prospects', 'registration'];
const TRIGGER_MODES   = ['stage_change', 'on_demand', 'scheduled'];
const CONFLICT_RULES  = ['run_alongside', 'override', 'supplement'];

const EMPTY_FORM = {
  name:               '',
  type:               'sales',
  department:         '',
  owner_team_id:      '',
  purpose:            '',
  entity_type:        'deals',
  trigger_mode:       'stage_change',
  conflict_rule:      'run_alongside',
  eligibility_filter: '',
  stages_description: '',  // UI-only, not sent to API
  access_note:        '',  // UI-only, not sent to API
};

export default function PlaybookRegister({ onSuccess, onCancel }) {
  const goBack = () => {
    if (onCancel) onCancel();
    else window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'playbooks' } }));
  };
  const goSuccess = () => {
    if (onSuccess) onSuccess();
    else window.dispatchEvent(new CustomEvent('navigate', { detail: { tab: 'playbooks' } }));
  };
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [savedRegId, setSavedRegId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const canProceedStep1 =
    form.name.trim().length > 0 && form.purpose.trim().length >= 80;

  const handleNext = async () => {
    setError(null);

    if (step === 1) {
      // If we already saved a draft (e.g. user went back to step 1),
      // don't create a second registration — just advance.
      if (savedRegId) {
        setStep(2);
        return;
      }
      setSaving(true);
      try {
        const res = await apiService.playbookBuilder.createRegistration({
          name:               form.name,
          type:               form.type,
          department:         form.department || undefined,
          owner_team_id:      form.owner_team_id ? parseInt(form.owner_team_id, 10) : undefined,
          purpose:            form.purpose,
          entity_type:        form.entity_type,
          trigger_mode:       form.trigger_mode,
          conflict_rule:      form.conflict_rule,
          eligibility_filter: form.eligibility_filter || undefined,
        });
        setSavedRegId(res.registration.id);
        setStep(2);
      } catch (err) {
        setError(err.message);
      } finally {
        setSaving(false);
      }
      return;
    }

    if (step < 4) {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
  };

  const handleSubmit = async () => {
    if (!savedRegId) return setError('No registration to submit');
    setSaving(true);
    setError(null);
    try {
      await apiService.playbookBuilder.submitRegistration(savedRegId);
      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (submitted) {
    return (
      <div className="reg-success">
        <div className="reg-success-icon">✓</div>
        <h2>Registration Submitted</h2>
        <p>
          Your playbook registration has been submitted for review. You'll be
          notified when it's approved or if changes are requested.
        </p>
        <div className="reg-success-actions">
          <button className="btn-primary" onClick={goSuccess}>
            Back to Playbooks
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="playbook-register">
      <div className="reg-header">
        <button className="btn-link" onClick={goBack}>
          ← Back
        </button>
        <h1>Register a Playbook</h1>
        <p>
          Tell us about the playbook you want to create. An org admin will
          review your request.
        </p>
      </div>

      {/* Step progress */}
      <div className="reg-steps">
        {STEPS.map((s) => (
          <div
            key={s.key}
            className={[
              'reg-step',
              step === s.number ? 'reg-step--active' : '',
              step > s.number  ? 'reg-step--done'   : '',
            ].join(' ')}
          >
            <div className="reg-step-circle">
              {step > s.number ? '✓' : s.number}
            </div>
            <span className="reg-step-label">{s.label}</span>
            {s.number < STEPS.length && <div className="reg-step-line" />}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="reg-body">
        {error && <div className="reg-error">{error}</div>}
        {step === 1 && <Step1Define form={form} set={set} />}
        {step === 2 && <Step2Stages form={form} set={set} />}
        {step === 3 && <Step3Access form={form} set={set} />}
        {step === 4 && <Step4Submit form={form} />}
      </div>

      {/* Navigation */}
      <div className="reg-footer">
        <button
          className="btn-secondary"
          onClick={handleBack}
          disabled={step === 1 || saving}
          type="button"
        >
          Back
        </button>
        {step < 4 ? (
          <button
            className="btn-primary"
            onClick={handleNext}
            disabled={saving || (step === 1 && !canProceedStep1)}
            type="button"
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>
        ) : (
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={saving}
            type="button"
          >
            {saving ? 'Submitting…' : 'Submit for Approval'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step components ──────────────────────────────────────────

function Step1Define({ form, set }) {
  const purposeLen = form.purpose.trim().length;
  return (
    <div className="reg-step-content">
      <h2>Define Your Playbook</h2>

      <label className="form-label">
        Playbook Name *
        <input
          type="text"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. Enterprise Deal Acceleration"
        />
      </label>

      <div className="form-row--2col">
        <label className="form-label">
          Type
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            {PLAYBOOK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="form-label">
          Department
          <input
            type="text"
            value={form.department}
            onChange={(e) => set('department', e.target.value)}
            placeholder="e.g. Sales, Legal, HR"
          />
        </label>
      </div>

      <label className="form-label">
        Purpose *{' '}
        <span className="form-hint">({purposeLen}/80 min)</span>
        <textarea
          value={form.purpose}
          onChange={(e) => set('purpose', e.target.value)}
          placeholder="Describe the business problem this playbook solves and what outcomes it drives. Minimum 80 characters."
          rows={5}
        />
        {purposeLen > 0 && purposeLen < 80 && (
          <span className="form-error">{80 - purposeLen} more characters needed</span>
        )}
      </label>

      <div className="form-row--2col">
        <label className="form-label">
          Entity Type
          <select
            value={form.entity_type}
            onChange={(e) => set('entity_type', e.target.value)}
          >
            {ENTITY_TYPES.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
        <label className="form-label">
          Trigger Mode
          <select
            value={form.trigger_mode}
            onChange={(e) => set('trigger_mode', e.target.value)}
          >
            {TRIGGER_MODES.map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-row--2col">
        <label className="form-label">
          Conflict Rule
          <select
            value={form.conflict_rule}
            onChange={(e) => set('conflict_rule', e.target.value)}
          >
            {CONFLICT_RULES.map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="form-label">
        Eligibility Filter{' '}
        <span className="form-hint">(JEXL — optional)</span>
        <input
          type="text"
          value={form.eligibility_filter}
          onChange={(e) => set('eligibility_filter', e.target.value)}
          placeholder="e.g. deal.value > 50000 && deal.region == 'EMEA'"
        />
      </label>
    </div>
  );
}

function Step2Stages({ form, set }) {
  return (
    <div className="reg-step-content">
      <h2>Stages &amp; Plays</h2>
      <div className="reg-info-box">
        <p>
          Once your registration is approved, you'll build the full stage pipeline
          and individual plays in the Playbook Builder.
        </p>
        <p>
          Briefly describe the stages you're planning. This helps the reviewer
          understand your intent.
        </p>
      </div>
      <label className="form-label">
        Stage &amp; Play Overview (optional)
        <textarea
          value={form.stages_description}
          onChange={(e) => set('stages_description', e.target.value)}
          placeholder="e.g. 5 stages: Qualification (3 plays), Discovery (4 plays), Proposal (5 plays), Negotiation (3 plays), Close (2 plays)."
          rows={6}
        />
      </label>
    </div>
  );
}

function Step3Access({ form, set }) {
  return (
    <div className="reg-step-content">
      <h2>Access</h2>
      <div className="reg-info-box">
        <p>
          After approval, access will be configured by your org admin based on
          your org's team structure and the playbook dimension.
        </p>
        <p>Describe who should have access and at what level.</p>
      </div>
      <label className="form-label">
        Access Notes (optional)
        <textarea
          value={form.access_note}
          onChange={(e) => set('access_note', e.target.value)}
          placeholder="e.g. All AEs in the EMEA Sales team should have reader access. The Sales Enablement team should be owners."
          rows={5}
        />
      </label>
    </div>
  );
}

function Step4Submit({ form }) {
  return (
    <div className="reg-step-content">
      <h2>Review &amp; Submit</h2>
      <div className="reg-review-card">
        <div className="reg-review-row"><strong>Name:</strong> {form.name}</div>
        <div className="reg-review-row"><strong>Type:</strong> {form.type}</div>
        {form.department && (
          <div className="reg-review-row">
            <strong>Department:</strong> {form.department}
          </div>
        )}
        <div className="reg-review-row"><strong>Entity:</strong> {form.entity_type}</div>
        <div className="reg-review-row"><strong>Trigger:</strong> {form.trigger_mode}</div>
        <div className="reg-review-row"><strong>Conflict rule:</strong> {form.conflict_rule}</div>
        <div className="reg-review-row"><strong>Purpose:</strong> {form.purpose}</div>
        {form.stages_description && (
          <div className="reg-review-row">
            <strong>Stages overview:</strong> {form.stages_description}
          </div>
        )}
      </div>
      <p className="reg-submit-note">
        By submitting, you're requesting org admin approval to create this
        playbook. You'll be notified of the outcome and can make changes if
        requested.
      </p>
    </div>
  );
}
