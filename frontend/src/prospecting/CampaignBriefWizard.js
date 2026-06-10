// prospecting/CampaignBriefWizard.js
//
// Guided "campaign brief" creation flow. A rep describes the campaign the way
// they think about it — audience, ICP, pitch, proof, fallback outreach — and
// the wizard writes to the SAME stores the power-user surfaces edit:
//
//   POST /api/prospecting-campaigns                 → campaign row
//        (name, solution, description, default_sequence_id)
//   PUT  /api/prospecting-campaigns/:id/config      → prospecting_config_override
//        (pitch, default_target_personas, default_value_props, products,
//         default_case_study_summaries, fit_rules)
//
// There is deliberately NO new resolution logic and NO generation at creation
// time: the override flows through sanitizeCampaignConfig on the backend and
// is resolved by SkillContextService's org → campaign → user cascade exactly
// like a config typed into CampaignConfigPanel. Generation stays where it is
// (enroll → PersonalizationDispatcher → drafts) so the FitGate keeps running
// before any model call.
//
// CampaignConfigPanel remains the editor for the same config after creation —
// one source of truth, two entry points.

import React, { useState, useEffect } from 'react';
import { apiFetch } from './prospectingShared';
import { FitRulesEditor } from '../ProspectingFitGateConfig';

const TEAL = '#0F9D8E';

const S = {
  label:   { display: 'block', fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3 },
  hint:    { fontSize: 12, color: '#6b7280', margin: '0 0 10px', lineHeight: 1.5 },
  input:   { width: '100%', padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' },
  textarea:{ width: '100%', padding: '8px 11px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', color: '#111', resize: 'vertical', lineHeight: 1.5 },
  section: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  chip:    { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 12, background: '#f0fdfa', border: '1px solid #99f6e4', fontSize: 12, color: '#115e59' },
  chipX:   { cursor: 'pointer', color: '#0d9488', fontWeight: 700 },
};

// ── Chip-list input — small string-array editor (personas, value props) ──────
function ChipListInput({ items, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const list = Array.isArray(items) ? items : [];
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!list.some(x => x.toLowerCase() === v.toLowerCase())) onChange([...list, v]);
    setDraft('');
  };
  return (
    <div>
      {list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {list.map((it, i) => (
            <span key={i} style={S.chip}>
              {it}
              <span style={S.chipX} onClick={() => onChange(list.filter((_, idx) => idx !== i))}>×</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ ...S.input, flex: 1 }}
        />
        <button type="button" onClick={add} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>
          + Add
        </button>
      </div>
    </div>
  );
}

// ── Compact case-study editor — matches the v2 schema shape ──────────────────
// {customer, their_problem, what_we_did, outcome}; id is minted server-side by
// sanitizeCampaignConfig when missing. Entries with no content field are
// dropped by the sanitizer, so the wizard mirrors that rule in canAdd.
function CaseStudyEditor({ items, onChange }) {
  const list = Array.isArray(items) ? items : [];
  const blank = { customer: '', their_problem: '', what_we_did: '', outcome: '' };
  const [draft, setDraft] = useState(blank);
  const set = (k, v) => setDraft(prev => ({ ...prev, [k]: v }));
  const canAdd = !!(draft.their_problem.trim() || draft.what_we_did.trim() || draft.outcome.trim());
  const add = () => {
    if (!canAdd) return;
    onChange([...list, {
      customer:      draft.customer.trim(),
      their_problem: draft.their_problem.trim(),
      what_we_did:   draft.what_we_did.trim(),
      outcome:       draft.outcome.trim(),
    }]);
    setDraft(blank);
  };
  return (
    <div>
      {list.map((cs, i) => (
        <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', marginBottom: 8, background: '#f9fafb', position: 'relative' }}>
          <span
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
            style={{ position: 'absolute', top: 8, right: 10, cursor: 'pointer', color: '#9ca3af', fontWeight: 700 }}
          >×</span>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
            {cs.customer || 'Unnamed customer'}
          </div>
          {cs.their_problem && <div style={{ fontSize: 12, color: '#6b7280' }}><strong>Problem:</strong> {cs.their_problem}</div>}
          {cs.what_we_did  && <div style={{ fontSize: 12, color: '#6b7280' }}><strong>What we did:</strong> {cs.what_we_did}</div>}
          {cs.outcome      && <div style={{ fontSize: 12, color: '#6b7280' }}><strong>Outcome:</strong> {cs.outcome}</div>}
        </div>
      ))}
      <div style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input style={S.input} value={draft.customer}      onChange={e => set('customer', e.target.value)}      placeholder='Customer (anonymize if needed, e.g. "an energy management firm")' />
        <input style={S.input} value={draft.their_problem} onChange={e => set('their_problem', e.target.value)} placeholder="Their problem — what was broken before" />
        <input style={S.input} value={draft.what_we_did}   onChange={e => set('what_we_did', e.target.value)}   placeholder="What we did — the concrete work" />
        <input style={S.input} value={draft.outcome}       onChange={e => set('outcome', e.target.value)}       placeholder="Outcome — the result (numbers if you have them)" />
        <button
          type="button"
          onClick={add}
          disabled={!canAdd}
          title={canAdd ? '' : 'Fill at least one of problem / what we did / outcome'}
          style={{ alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 7, border: '1px solid #d1d5db', background: canAdd ? '#fff' : '#f3f4f6', color: canAdd ? '#374151' : '#9ca3af', fontSize: 12, fontWeight: 600, cursor: canAdd ? 'pointer' : 'not-allowed' }}
        >
          + Add case study
        </button>
      </div>
    </div>
  );
}

// ── Wizard ────────────────────────────────────────────────────────────────────
const STEPS = ['Basics', 'Audience & ICP', 'Pitch', 'Proof', 'Outreach', 'Review'];

export default function CampaignBriefWizard({ onSaved, onClose }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Campaign row fields
  const [name, setName]         = useState('');
  const [solution, setSolution] = useState('');
  const [description, setDescription] = useState('');
  const [sequenceId, setSequenceId]   = useState('');

  // Config override fields (sanitizeCampaignConfig shape)
  const [personas, setPersonas]       = useState([]);
  const [fitRules, setFitRules]       = useState([]);
  const [pitch, setPitch]             = useState('');
  const [valueProps, setValueProps]   = useState([]);
  const [caseStudies, setCaseStudies] = useState([]);

  const [sequences, setSequences] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const sq = await apiFetch('/sequences');
        setSequences((sq.sequences || []).filter(s => s.status === 'active'));
      } catch { setSequences([]); }
    })();
  }, []);

  const hasOverride = !!(pitch.trim() || personas.length || valueProps.length || caseStudies.length || fitRules.length);

  const handleCreate = async () => {
    if (!name.trim()) { setError('Campaign name is required.'); setStep(0); return; }
    setBusy(true);
    setError('');
    try {
      // 1. Create the campaign row.
      const created = await apiFetch('/prospecting-campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name:                name.trim(),
          solution:            solution.trim() || null,
          description:         description.trim() || null,
          default_sequence_id: sequenceId ? parseInt(sequenceId, 10) : null,
          status:              'active',
        }),
      });
      const campaignId = created?.campaign?.id;
      if (!campaignId) throw new Error('Campaign was created but no id came back.');

      // 2. Write the brief as the campaign's config override (skipped when
      //    nothing was filled in — the campaign just inherits org defaults).
      if (hasOverride) {
        try {
          await apiFetch(`/prospecting-campaigns/${campaignId}/config`, {
            method: 'PUT',
            body: JSON.stringify({
              override: {
                pitch:                        pitch.trim(),
                default_target_personas:      personas,
                default_value_props:          valueProps,
                default_case_study_summaries: caseStudies,
                fit_rules:                    fitRules,
              },
            }),
          });
        } catch (cfgErr) {
          // The campaign exists; don't strand the user. Surface a precise
          // message so they can finish the brief in the campaign's config tab.
          setBusy(false);
          setError(`Campaign "${name.trim()}" was created, but saving the brief failed (${cfgErr.message}). Open the campaign's AI Config to finish it.`);
          return;
        }
      }
      onSaved();
    } catch (err) {
      setBusy(false);
      setError('Create failed: ' + err.message);
    }
  };

  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  return (
    <div className="pv-modal-overlay" onClick={onClose}>
      <div className="pv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="pv-modal-header">
          <h3>New Campaign — guided brief</h3>
          <button className="pv-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 4, padding: '10px 18px 0' }}>
          {STEPS.map((label, i) => (
            <div
              key={label}
              onClick={() => i < step && setStep(i)}
              style={{
                flex: 1, textAlign: 'center', fontSize: 10, fontWeight: 600,
                color: i === step ? TEAL : i < step ? '#374151' : '#c4c8cf',
                cursor: i < step ? 'pointer' : 'default',
                borderBottom: `3px solid ${i <= step ? TEAL : '#e5e7eb'}`,
                paddingBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3,
              }}
            >
              {label}
            </div>
          ))}
        </div>

        <div className="pv-form" style={{ padding: 18, minHeight: 320 }}>
          {error && (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          {/* ── Step 0: Basics ─────────────────────────────────────────── */}
          {step === 0 && (
            <>
              <p style={S.hint}>What is this campaign, and what are you selling in it?</p>
              <div style={S.section}>
                <label style={S.label}>Campaign name *</label>
                <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder='e.g. "VP Sales — Q3 pipeline-visibility push"' />
              </div>
              <div style={S.section}>
                <label style={S.label}>Solution</label>
                <input style={S.input} value={solution} onChange={e => setSolution(e.target.value)} placeholder="The product / solution this campaign prospects for" />
              </div>
              <div style={S.section}>
                <label style={S.label}>Description (optional)</label>
                <textarea style={S.textarea} rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Internal note about this campaign" />
              </div>
            </>
          )}

          {/* ── Step 1: Audience & ICP ─────────────────────────────────── */}
          {step === 1 && (
            <>
              <p style={S.hint}>
                Who is this campaign for? <strong>Personas</strong> tell the AI who it is writing to.
                <strong> Fit rules</strong> are the hard gate — titles, seniority, and company characteristics
                a prospect must (or must not) match before any draft is generated.
              </p>
              <div style={S.section}>
                <label style={S.label}>Target personas</label>
                <ChipListInput items={personas} onChange={setPersonas} placeholder='e.g. "VP Sales at 11–50 person B2B SaaS"' />
              </div>
              <div style={S.section}>
                <FitRulesEditor value={fitRules} onChange={setFitRules} />
              </div>
            </>
          )}

          {/* ── Step 2: Pitch ──────────────────────────────────────────── */}
          {step === 2 && (
            <>
              <p style={S.hint}>
                The story for this audience — what we say and why. The AI <strong>paraphrases</strong> this
                as each email's framing; it never quotes it, and it still personalizes the opener to the
                prospect's own signals.
              </p>
              <div style={S.section}>
                <label style={S.label}>Pitch</label>
                <textarea
                  style={S.textarea} rows={4} maxLength={2000}
                  value={pitch} onChange={e => setPitch(e.target.value)}
                  placeholder='e.g. "Sales leaders at small B2B SaaS firms have playbooks their reps don&#39;t follow. We sit on top of their CRM and turn the playbook into a prioritized daily action queue, so execution stops depending on memory."'
                />
              </div>
              <div style={S.section}>
                <label style={S.label}>Value props (the AI uses ONE per email)</label>
                <ChipListInput items={valueProps} onChange={setValueProps} placeholder='e.g. "Reps know their next action without being chased"' />
              </div>
            </>
          )}

          {/* ── Step 3: Proof ──────────────────────────────────────────── */}
          {step === 3 && (
            <>
              <p style={S.hint}>
                Case studies the AI may reference as social proof. It will never invent details —
                only what you write here can appear in an email.
              </p>
              <CaseStudyEditor items={caseStudies} onChange={setCaseStudies} />
            </>
          )}

          {/* ── Step 4: Outreach fallback ──────────────────────────────── */}
          {step === 4 && (
            <>
              <p style={S.hint}>
                The default sequence enrolls this campaign's prospects across email / LinkedIn / call / task
                steps. Each AI draft can always be reverted to this sequence's own template with one click
                during review.
              </p>
              <div style={S.section}>
                <label style={S.label}>Default (fallback) sequence</label>
                <select style={S.input} value={sequenceId} onChange={e => setSequenceId(e.target.value)}>
                  <option value="">No default sequence (pick per-enrollment)</option>
                  {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </>
          )}

          {/* ── Step 5: Review ─────────────────────────────────────────── */}
          {step === 5 && (
            <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7 }}>
              <p style={S.hint}>Everything below is editable later in the campaign's AI Config panel.</p>
              <div><strong>Name:</strong> {name || <em style={{ color: '#dc2626' }}>missing — required</em>}</div>
              {solution && <div><strong>Solution:</strong> {solution}</div>}
              <div><strong>Personas:</strong> {personas.length ? personas.join('; ') : <em>inherit org defaults</em>}</div>
              <div><strong>Fit rules:</strong> {fitRules.length ? `${fitRules.length} override rule(s) + inherited defaults` : <em>default ICP rules</em>}</div>
              <div><strong>Pitch:</strong> {pitch.trim() ? `"${pitch.trim().slice(0, 160)}${pitch.trim().length > 160 ? '…' : ''}"` : <em>inherit org pitch</em>}</div>
              <div><strong>Value props:</strong> {valueProps.length ? valueProps.join('; ') : <em>inherit org defaults</em>}</div>
              <div><strong>Case studies:</strong> {caseStudies.length ? `${caseStudies.length} added` : <em>inherit org defaults</em>}</div>
              <div><strong>Fallback sequence:</strong> {sequenceId ? (sequences.find(s => String(s.id) === String(sequenceId))?.name || `#${sequenceId}`) : <em>none</em>}</div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid #f3f4f6' }}>
          <button
            type="button"
            onClick={step === 0 ? onClose : back}
            disabled={busy}
            style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={next}
              disabled={busy || (step === 0 && !name.trim())}
              title={step === 0 && !name.trim() ? 'Enter a campaign name first' : ''}
              style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: (step === 0 && !name.trim()) ? '#9ca3af' : TEAL, color: '#fff', fontSize: 12, fontWeight: 600, cursor: (step === 0 && !name.trim()) ? 'not-allowed' : 'pointer' }}
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy || !name.trim()}
              style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: busy ? '#9ca3af' : TEAL, color: '#fff', fontSize: 12, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              {busy ? '⏳ Creating…' : '✓ Create campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
