// OAProspectingSkillConfig.js
//
// Org-admin editor for prospecting_config — the shared baseline the
// outreach-personalization skill draws on. Rendered as a sub-tab inside
// OAProspectingModule (OrgAdminView). Owner/admin only (gated server-side).
//
// Backend: GET/PUT /api/prospecting-config/org
//
// Built as its own file so OrgAdminView.js doesn't grow — and so the
// upcoming OrgAdminView split has one less component to extract.

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL;

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// Empty shape — matches config/prospectingConfigSchema.js emptyOrgConfig().
const EMPTY = {
  products: [],
  default_value_props: [],
  default_target_personas: [],
  default_case_study_summaries: [],
  guardrails: { banned_phrasings: [], required_disclaimers: [] },
};

export default function OAProspectingSkillConfig() {
  const [config,  setConfig]  = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [dirty,   setDirty]   = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/prospecting-config/org`, { headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Load failed');
      setConfig({ ...EMPTY, ...data.config, guardrails: { ...EMPTY.guardrails, ...(data.config?.guardrails || {}) } });
      setDirty(false);
    } catch (err) {
      showFlash('error', err.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Mutators — every change marks the form dirty.
  const update = (patch) => { setConfig(prev => ({ ...prev, ...patch })); setDirty(true); };
  const updateGuardrails = (patch) =>
    update({ guardrails: { ...config.guardrails, ...patch } });

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/prospecting-config/org`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ config }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Save failed');
      setConfig({ ...EMPTY, ...data.config, guardrails: { ...EMPTY.guardrails, ...(data.config?.guardrails || {}) } });
      setDirty(false);
      showFlash('success', 'Prospecting skill inputs saved');
    } catch (err) {
      showFlash('error', err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>Loading skill inputs…</div>;
  }

  return (
    <div style={{ paddingBottom: 80 }}>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 18px' }}>
        The shared baseline every rep's outreach skill draws on. Reps can add their
        own items or exclude individual ones on their personal “My outreach style” screen.
      </p>

      {flash && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, fontSize: 13, marginBottom: 14,
          background: flash.type === 'error' ? '#fef2f2' : '#ecfdf5',
          color:      flash.type === 'error' ? '#991b1b' : '#065f46',
          border: '1px solid ' + (flash.type === 'error' ? '#fecaca' : '#a7f3d0'),
        }}>{flash.msg}</div>
      )}

      {/* Products — ordered list */}
      <OrderedListEditor
        title="Products"
        hint="Priority order — the skill anchors to the first product unless a later one better matches the prospect."
        items={config.products}
        onChange={(products) => update({ products })}
        placeholder="Add a product…"
      />

      {/* Value props */}
      <TagListEditor
        title="Value propositions"
        items={config.default_value_props}
        onChange={(v) => update({ default_value_props: v })}
        placeholder="Add a value prop…"
      />

      {/* Target personas */}
      <TagListEditor
        title="Target personas"
        items={config.default_target_personas}
        onChange={(v) => update({ default_target_personas: v })}
        placeholder="Add a persona…"
      />

      {/* Case studies — structured */}
      <CaseStudyEditor
        items={config.default_case_study_summaries}
        onChange={(v) => update({ default_case_study_summaries: v })}
      />

      {/* Guardrails */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Guardrails</div>
        <TagListEditor
          title="Banned phrasings"
          hint="The skill will never use these in an email or LinkedIn note."
          items={config.guardrails.banned_phrasings}
          onChange={(v) => updateGuardrails({ banned_phrasings: v })}
          placeholder="Add a phrase to ban…"
          danger
          nested
        />
        <TagListEditor
          title="Required disclaimers"
          items={config.guardrails.required_disclaimers}
          onChange={(v) => updateGuardrails({ required_disclaimers: v })}
          placeholder="Add a required disclaimer…"
          nested
        />
      </div>

      {/* Save bar */}
      <div style={{
        position: 'sticky', bottom: 0, marginTop: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10,
        padding: '12px 0', background: '#fff', borderTop: '1px solid #e5e7eb',
      }}>
        <span style={{ flex: 1, fontSize: 12, color: dirty ? '#b45309' : '#9ca3af' }}>
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <button
          onClick={load}
          disabled={!dirty || saving}
          style={btnStyle(false, !dirty || saving)}
        >Discard</button>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          style={btnStyle(true, !dirty || saving)}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function btnStyle(primary, disabled) {
  return {
    padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
    fontWeight: 600, opacity: disabled ? 0.5 : 1,
    border: '1px solid ' + (primary ? '#6366f1' : '#d1d5db'),
    background: primary ? '#6366f1' : '#fff',
    color: primary ? '#fff' : '#374151',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TagListEditor — chip list of strings with an add-input.
// ─────────────────────────────────────────────────────────────────────────────
function TagListEditor({ title, hint, items, onChange, placeholder, danger, nested }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(''); return; }
    onChange([...items, v]);
    setDraft('');
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  return (
    <div style={{ marginBottom: nested ? 12 : 22 }}>
      <div style={{ fontSize: nested ? 13 : 14, fontWeight: nested ? 500 : 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>None yet</span>
        )}
        {items.map((it, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
            padding: '4px 10px', borderRadius: 14,
            background: danger ? '#fef2f2' : '#f3f4f6',
            color:      danger ? '#991b1b' : '#374151',
          }}>
            {it}
            <span onClick={() => remove(i)} style={{ cursor: 'pointer', fontWeight: 700 }}>×</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ flex: 1, fontSize: 13, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
        />
        <button onClick={add} style={btnStyle(false, false)}>+ Add</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OrderedListEditor — like TagList but rows, with up/down reordering.
// ─────────────────────────────────────────────────────────────────────────────
function OrderedListEditor({ title, hint, items, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(''); return; }
    onChange([...items, v]);
    setDraft('');
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>None yet</span>
        )}
        {items.map((it, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#f9fafb', borderRadius: 6, padding: '7px 10px',
          }}>
            <span style={{
              fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: 'center',
              borderRadius: 4, padding: '1px 4px',
              background: i === 0 ? '#e0e7ff' : '#e5e7eb',
              color:      i === 0 ? '#3730a3' : '#6b7280',
            }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 13 }}>{it}</span>
            <span onClick={() => move(i, -1)} style={{ cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.3 : 1, fontSize: 13 }}>▲</span>
            <span onClick={() => move(i, 1)}  style={{ cursor: i === items.length - 1 ? 'default' : 'pointer', opacity: i === items.length - 1 ? 0.3 : 1, fontSize: 13 }}>▼</span>
            <span onClick={() => remove(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700 }}>×</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ flex: 1, fontSize: 13, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
        />
        <button onClick={add} style={btnStyle(false, false)}>+ Add</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CaseStudyEditor — structured {id, customer, summary}. The id is opaque and
// minted server-side on save; the UI shows customer as the label. New rows are
// added with id:null and the backend assigns one.
// ─────────────────────────────────────────────────────────────────────────────
function CaseStudyEditor({ items, onChange }) {
  const [addingCustomer, setAddingCustomer] = useState('');
  const [addingSummary,  setAddingSummary]  = useState('');

  const addCase = () => {
    const customer = addingCustomer.trim();
    const summary  = addingSummary.trim();
    if (!customer && !summary) return;
    // id omitted — the backend mints an opaque id on save.
    onChange([...items, { customer, summary }]);
    setAddingCustomer(''); setAddingSummary('');
  };
  const removeCase = (i) => onChange(items.filter((_, idx) => idx !== i));
  const editCase = (i, field, value) => {
    const next = items.slice();
    next[i] = { ...next[i], [field]: value };
    onChange(next);
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Case studies</div>
      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>
        Stored as structured entries so reps can exclude individual ones.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>None yet</span>
        )}
        {items.map((cs, i) => (
          <div key={cs.id || `new-${i}`} style={{
            border: '1px solid #e5e7eb', borderRadius: 6, padding: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <input
                value={cs.customer || ''}
                onChange={(e) => editCase(i, 'customer', e.target.value)}
                placeholder="Customer name"
                style={{ flex: 1, fontSize: 13, fontWeight: 600, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5 }}
              />
              <span onClick={() => removeCase(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700, fontSize: 16 }}>×</span>
            </div>
            <textarea
              value={cs.summary || ''}
              onChange={(e) => editCase(i, 'summary', e.target.value)}
              placeholder="One-line outcome the skill can reference"
              rows={2}
              style={{ width: '100%', fontSize: 12, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, resize: 'vertical' }}
            />
            {cs.id && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                ref: {cs.id} — used as the exclusion key
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ border: '1px dashed #d1d5db', borderRadius: 6, padding: 10 }}>
        <input
          value={addingCustomer}
          onChange={(e) => setAddingCustomer(e.target.value)}
          placeholder="New case study — customer name"
          style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, marginBottom: 6 }}
        />
        <textarea
          value={addingSummary}
          onChange={(e) => setAddingSummary(e.target.value)}
          placeholder="One-line outcome…"
          rows={2}
          style={{ width: '100%', fontSize: 12, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, resize: 'vertical', marginBottom: 6 }}
        />
        <button onClick={addCase} style={btnStyle(false, false)}>+ Add case study</button>
      </div>
    </div>
  );
}
