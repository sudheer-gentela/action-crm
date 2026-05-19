// MyOutreachStyleSettings.js
//
// Per-user editor for prospecting_config — the rep's personal overrides on
// top of the org baseline. Rendered as a nav item inside SettingsView.
// Available to every authenticated user (no admin gate).
//
// Backend: GET/PUT /api/prospecting-config/me
//   The GET also returns org_baseline (the org config) and org_competitors
//   (the org's competitor table rows), so this screen renders in one call.
//
// Override model — for each shared category the rep sees the org baseline as
// tickable rows: unticking a row adds it to excluded_*; an "add your own"
// input appends to custom_*.

import React, { useState, useEffect, useCallback } from 'react';

const API = process.env.REACT_APP_API_URL;

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

const HOOK_OPTIONS = [
  { value: '',               label: 'No preference — let the skill choose' },
  { value: 'prospect_post',  label: "Prospect's own post / comment" },
  { value: 'account_event',  label: 'Account event (funding, leadership change)' },
  { value: 'tech_stack',     label: 'Tech stack overlap' },
  { value: 'role_curiosity', label: 'Role + stage curiosity' },
];

const EMPTY_USER = {
  custom_products: [], custom_value_props: [], custom_target_personas: [],
  custom_case_studies: [], custom_competitors: [],
  excluded_products: [], excluded_value_props: [], excluded_target_personas: [],
  excluded_case_studies: [], excluded_competitors: [],
  rep: { title_for_signature: '', email_signature_block: '' },
  voice: { avoid_phrases: [] },
  hook_preferences: { preferred_categories: [] },
};

const EMPTY_ORG = {
  products: [], default_value_props: [], default_target_personas: [],
  default_case_study_summaries: [], guardrails: { banned_phrasings: [], required_disclaimers: [] },
};

export default function MyOutreachStyleSettings() {
  const [config,  setConfig]  = useState(EMPTY_USER);
  const [orgBase, setOrgBase] = useState(EMPTY_ORG);
  const [orgComp, setOrgComp] = useState([]);   // [{id, name}]
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [dirty,   setDirty]   = useState(false);
  const [flash,   setFlash]   = useState(null);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 4000);
  };

  const normalize = (c) => ({
    ...EMPTY_USER, ...c,
    rep:   { ...EMPTY_USER.rep,   ...(c?.rep   || {}) },
    voice: { ...EMPTY_USER.voice, ...(c?.voice || {}) },
    hook_preferences: { ...EMPTY_USER.hook_preferences, ...(c?.hook_preferences || {}) },
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/prospecting-config/me`, { headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Load failed');
      setConfig(normalize(data.config));
      setOrgBase({ ...EMPTY_ORG, ...(data.org_baseline || {}) });
      setOrgComp(Array.isArray(data.org_competitors) ? data.org_competitors : []);
      setDirty(false);
    } catch (err) {
      showFlash('error', err.message || 'Failed to load your config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = (patch) => { setConfig(prev => ({ ...prev, ...patch })); setDirty(true); };

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/prospecting-config/me`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ config }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Save failed');
      setConfig(normalize(data.config));
      setDirty(false);
      showFlash('success', 'Your outreach style was saved');
    } catch (err) {
      showFlash('error', err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>Loading your outreach style…</div>;
  }

  // org case studies use a structured shape; tick-list keys on the id, label
  // shows the customer name.
  const caseRows = orgBase.default_case_study_summaries.map(cs => ({
    key: cs.id, label: cs.customer || '(unnamed)', sub: cs.summary,
  }));
  const compRows = orgComp.map(c => ({ key: c.name, label: c.name }));

  return (
    <div className="sv-panel" style={{ paddingBottom: 90 }}>
      <div className="sv-panel-header">
        <div>
          <h2>✨ My outreach style</h2>
          <p className="sv-panel-desc">
            Tailor what the outreach skill uses for you. Org defaults are shown —
            untick to skip them, or add your own. Changes apply to your outreach only.
          </p>
        </div>
      </div>

      {flash && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, fontSize: 13, margin: '0 0 16px',
          background: flash.type === 'error' ? '#fef2f2' : '#ecfdf5',
          color:      flash.type === 'error' ? '#991b1b' : '#065f46',
          border: '1px solid ' + (flash.type === 'error' ? '#fecaca' : '#a7f3d0'),
        }}>{flash.msg}</div>
      )}

      <OverrideSection
        title="Products"
        orgItems={orgBase.products.map(p => ({ key: p, label: p }))}
        excluded={config.excluded_products}
        custom={config.custom_products}
        onExcluded={(v) => update({ excluded_products: v })}
        onCustom={(v) => update({ custom_products: v })}
        addPlaceholder="Add a product you pitch…"
      />

      <OverrideSection
        title="Value propositions"
        orgItems={orgBase.default_value_props.map(v => ({ key: v, label: v }))}
        excluded={config.excluded_value_props}
        custom={config.custom_value_props}
        onExcluded={(v) => update({ excluded_value_props: v })}
        onCustom={(v) => update({ custom_value_props: v })}
        addPlaceholder="Add your own value prop…"
      />

      <OverrideSection
        title="Target personas"
        orgItems={orgBase.default_target_personas.map(p => ({ key: p, label: p }))}
        excluded={config.excluded_target_personas}
        custom={config.custom_target_personas}
        onExcluded={(v) => update({ excluded_target_personas: v })}
        onCustom={(v) => update({ custom_target_personas: v })}
        addPlaceholder="Add a persona you target…"
      />

      <OverrideSection
        title="Case studies"
        orgItems={caseRows}
        excluded={config.excluded_case_studies}
        custom={null}   /* custom case studies are structured — omitted from v1 add UI */
        onExcluded={(v) => update({ excluded_case_studies: v })}
        onCustom={null}
        addPlaceholder=""
      />

      <OverrideSection
        title="Competitors"
        hint="Org competitor list — untick any you don't want the skill to be aware of for you."
        orgItems={compRows}
        excluded={config.excluded_competitors}
        custom={config.custom_competitors}
        onExcluded={(v) => update({ excluded_competitors: v })}
        onCustom={(v) => update({ custom_competitors: v })}
        addPlaceholder="Add a competitor…"
      />

      {/* My voice */}
      <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16, marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>My voice</div>

        <ChipInput
          label="Phrases to avoid — on top of the org's banned list"
          items={config.voice.avoid_phrases}
          onChange={(v) => update({ voice: { ...config.voice, avoid_phrases: v } })}
          placeholder="Add a phrase…"
        />

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>Email signature block</div>
          <textarea
            value={config.rep.email_signature_block}
            onChange={(e) => update({ rep: { ...config.rep, email_signature_block: e.target.value } })}
            rows={3}
            placeholder={'Your name\nYour title, Company\nyou@company.com'}
            style={{ width: '100%', fontSize: 13, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical' }}
          />
        </div>

        <div style={{ marginTop: 10, maxWidth: 320 }}>
          <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>Title for signature</div>
          <input
            value={config.rep.title_for_signature}
            onChange={(e) => update({ rep: { ...config.rep, title_for_signature: e.target.value } })}
            placeholder="e.g. Account Executive"
            style={{ width: '100%', fontSize: 13, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
          />
        </div>
      </div>

      {/* Hook preference */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Default hook preference</div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>
          Your standing preference for which signal the skill anchors to. Can still be overridden per run.
        </div>
        <select
          value={config.hook_preferences.preferred_categories[0] || ''}
          onChange={(e) => {
            const v = e.target.value;
            update({ hook_preferences: { preferred_categories: v ? [v] : [] } });
          }}
          style={{ width: '100%', maxWidth: 420, fontSize: 13, padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
        >
          {HOOK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
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
        <button onClick={load} disabled={!dirty || saving} style={btnStyle(false, !dirty || saving)}>Discard</button>
        <button onClick={handleSave} disabled={!dirty || saving} style={btnStyle(true, !dirty || saving)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
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
// OverrideSection — org baseline as tick rows (untick = exclude) + optional
// "add your own" chip input for custom_* items.
//
// orgItems: [{ key, label, sub? }]
// excluded: string[] of keys the user has excluded
// custom:   string[] of the user's own additions (null = no custom UI)
// ─────────────────────────────────────────────────────────────────────────────
function OverrideSection({ title, hint, orgItems, excluded, custom, onExcluded, onCustom, addPlaceholder }) {
  const isExcluded = (key) => excluded.includes(key);
  const toggle = (key) => {
    if (isExcluded(key)) onExcluded(excluded.filter(k => k !== key));
    else                 onExcluded([...excluded, key]);
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: hint ? 2 : 6 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      <div style={{ fontSize: 11, color: '#9ca3af', letterSpacing: 0.3, marginBottom: 4 }}>
        FROM YOUR ORG — untick to skip in your outreach
      </div>
      {orgItems.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 6 }}>
          Nothing set at the org level yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {orgItems.map(it => {
            const ex = isExcluded(it.key);
            return (
              <label key={it.key} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer',
                color: ex ? '#9ca3af' : '#374151',
              }}>
                <input type="checkbox" checked={!ex} onChange={() => toggle(it.key)}
                  style={{ width: 15, height: 15, marginTop: 2 }} />
                <span style={{ flex: 1 }}>
                  <span style={{ textDecoration: ex ? 'line-through' : 'none' }}>{it.label}</span>
                  {it.sub && (
                    <span style={{ display: 'block', fontSize: 11, color: '#9ca3af' }}>{it.sub}</span>
                  )}
                </span>
                {ex && (
                  <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '1px 6px' }}>
                    excluded
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {custom !== null && onCustom && (
        <>
          <div style={{ fontSize: 11, color: '#9ca3af', letterSpacing: 0.3, marginBottom: 4 }}>
            YOUR OWN ADDITIONS
          </div>
          <ChipInput
            items={custom}
            onChange={onCustom}
            placeholder={addPlaceholder}
            tone="add"
          />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ChipInput — a chip list of strings with an add-input. `tone` controls color:
// 'add' = green (user additions), default = gray.
// ─────────────────────────────────────────────────────────────────────────────
function ChipInput({ label, items, onChange, placeholder, tone }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(''); return; }
    onChange([...items, v]);
    setDraft('');
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  const chipBg = tone === 'add' ? '#ecfdf5' : '#f3f4f6';
  const chipFg = tone === 'add' ? '#065f46' : '#374151';

  return (
    <div>
      {label && <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>{label}</div>}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {items.map((it, i) => (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
              padding: '4px 10px', borderRadius: 14, background: chipBg, color: chipFg,
            }}>
              {it}
              <span onClick={() => remove(i)} style={{ cursor: 'pointer', fontWeight: 700 }}>×</span>
            </span>
          ))}
        </div>
      )}
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
