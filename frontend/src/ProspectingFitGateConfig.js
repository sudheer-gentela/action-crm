// ProspectingFitGateConfig.js
//
// Editor sections for the org-configurable enforcement surfaces that feed the
// fit gate + title classifier + outreach caps + hook recency. Designed to be
// embedded inside the existing prospecting_config editors:
//   ORG      → OAProspectingSkillConfig.js   (primary)
//   USER     → MyOutreachStyleSettings.js    (user overrides)
//   CAMPAIGN → prospecting/CampaignConfigPanel.js
//
// The PARENT owns config state + load/save; this component is controlled —
// it renders editors and calls the onChange callbacks. The values map 1:1 to
// prospecting_config.{fit_rules, title_classifier, outreach_caps, hook_recency_days}.
//
// The Title classifier editor includes a LIVE PREVIEW that calls
// POST /api/skills/classify/preview with the current draft, so an operator can
// type sample titles, see how their keywords classify (and the regex each
// keyword compiled to), and correct the keywords before saving.

import React, { useState } from 'react';

const API = process.env.REACT_APP_API_URL;
function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

const FUNCTION_VALUES  = ['revenue', 'sales', 'marketing', 'exec_founder', 'ops', 'product', 'other'];
const SENIORITY_VALUES = ['c_level', 'vp', 'director', 'manager', 'ic'];
const FIT_FIELDS       = ['function', 'seniority', 'industry', 'size', 'location', 'title', 'decision_maker'];
const FIT_MATCH        = ['one_of', 'contains_any', 'contains_text'];
const FIT_REQ          = ['must', 'should', 'exclude'];
const EMAIL_INTENTS    = ['first_touch', 'follow_up', 'breakup', 'default'];
const LINKEDIN_INTENTS = ['connection_request', 'post_accept', 'nurture_dm', 'default'];

// Read-only mirror of the backend built-ins (FitGate.DEFAULT_FIT_RULES and the
// ProspectClassifier default maps) — shown so admins can SEE what they inherit
// when a section is left empty. Keep in sync with the backend constants.
const DEFAULT_FIT_RULES = [
  { field: 'function',  requirement: 'must',    match: 'one_of',       values: ['revenue', 'sales', 'exec_founder'],                            label: 'Revenue/sales/founder function' },
  { field: 'seniority', requirement: 'must',    match: 'one_of',       values: ['c_level', 'vp', 'director'],                                   label: 'Decision-maker seniority' },
  { field: 'industry',  requirement: 'should',  match: 'contains_any', values: ['SaaS', 'Software', 'B2B', 'Technology'],                       label: 'B2B SaaS industry' },
  { field: 'size',      requirement: 'should',  match: 'one_of',       values: ['1-10', '11-50', '51-200'],                                     label: 'Small company' },
  { field: 'industry',  requirement: 'exclude', match: 'contains_any', values: ['Banking', 'Fintech', 'Staffing', 'Consulting', 'IT Services'], label: 'Out-of-ICP industry' },
];
const DEFAULT_FUNCTION_SUMMARY = [
  ['exec_founder', 'founder, co-founder, owner, CEO, president, managing director'],
  ['revenue', 'CRO, chief revenue / commercial / customer, "revenue"'],
  ['sales', 'sales, AE, SDR, BDR, business development, growth'],
  ['marketing', 'CMO, marketing, demand gen, brand, content'],
  ['product', 'CPO, product, PM'],
  ['ops', 'COO, operations, revops, sales ops'],
  ['other', 'CTO/CIO, engineering, CFO/finance, HR, legal, IT, data/design/support'],
];
const DEFAULT_SENIORITY_SUMMARY = [
  ['c_level', 'chief, any CxO, founder/owner/president, managing director'],
  ['vp', 'VP, SVP, EVP, vice president'],
  ['director', 'director, head of'],
  ['manager', 'manager, mgr'],
  ['ic', 'any other recognized title'],
];
const REQ_COLOR = { must: { bg: '#eef2ff', fg: '#3730a3' }, should: { bg: '#f3f4f6', fg: '#6b7280' }, exclude: { bg: '#fef2f2', fg: '#991b1b' } };

// shared styles (kept inline to match OAProspectingSkillConfig.js)
const S = {
  section:  { marginBottom: 22 },
  h:        { fontSize: 14, fontWeight: 600, marginBottom: 2 },
  hint:     { fontSize: 12, color: '#9ca3af', marginBottom: 6 },
  card:     { border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, background: '#fff', marginBottom: 8 },
  input:    { fontSize: 13, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 },
  select:   { fontSize: 13, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' },
  x:        { cursor: 'pointer', color: '#9ca3af', fontWeight: 700, fontSize: 16, marginLeft: 4 },
  chip:     { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px', borderRadius: 14, background: '#f3f4f6', color: '#374151' },
  addDash:  { border: '1px dashed #d1d5db', borderRadius: 6, padding: 10 },
};
function btn(primary, disabled) {
  return {
    padding: '7px 16px', fontSize: 13, borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
    fontWeight: 600, opacity: disabled ? 0.5 : 1,
    border: '1px solid ' + (primary ? '#6366f1' : '#d1d5db'),
    background: primary ? '#6366f1' : '#fff', color: primary ? '#fff' : '#374151',
  };
}

// ── KeywordChips — chip list with an add input (keywords, not regex) ──────────
function KeywordChips({ items, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const list = Array.isArray(items) ? items : [];
  const add = () => {
    const v = draft.trim();
    if (!v || list.includes(v)) { setDraft(''); return; }
    onChange([...list, v]); setDraft('');
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {list.length === 0 && <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No keywords</span>}
        {list.map((it, i) => (
          <span key={i} style={S.chip}>
            {it}
            <span onClick={() => onChange(list.filter((_, idx) => idx !== i))} style={{ cursor: 'pointer', fontWeight: 700 }}>×</span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder || 'Add a keyword…'}
          style={{ ...S.input, flex: 1 }}
        />
        <button onClick={add} style={btn(false, false)}>+ Add</button>
      </div>
    </div>
  );
}

function Select({ value, options, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={S.select}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// ── Read-only "what you inherit" views ────────────────────────────────────────
function InheritedFitRules() {
  return (
    <details style={{ ...S.card, background: '#f9fafb', marginBottom: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#6366f1' }}>
        Inherited defaults — active unless you override the same field + requirement
      </summary>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {DEFAULT_FIT_RULES.map((r, i) => {
          const c = REQ_COLOR[r.requirement] || REQ_COLOR.should;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: '#374151', minWidth: 64 }}>{r.field}</span>
              <span style={{ background: c.bg, color: c.fg, borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{r.requirement}</span>
              <span style={{ color: '#6b7280' }}>{r.match}</span>
              <span style={{ color: '#374151' }}>{r.values.join(', ')}</span>
              <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>· {r.label}</span>
            </div>
          );
        })}
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          must fails or exclude matches → disqualified · should fails or any unknown field → weak · else strong
        </div>
      </div>
    </details>
  );
}

function InheritedClassifier() {
  const Row = ([value, kws]) => (
    <div key={value} style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 2 }}>
      <span style={{ fontWeight: 600, color: '#374151', minWidth: 92 }}>{value}</span>
      <span style={{ color: '#6b7280' }}>{kws}</span>
    </div>
  );
  return (
    <details style={{ ...S.card, background: '#f9fafb', marginBottom: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#6366f1' }}>
        Built-in defaults — tried after your rules (first match wins)
      </summary>
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', margin: '2px 0 4px' }}>Function</div>
        {DEFAULT_FUNCTION_SUMMARY.map(Row)}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', margin: '8px 0 4px' }}>Seniority</div>
        {DEFAULT_SENIORITY_SUMMARY.map(Row)}
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
          Decision-maker default: c_level, vp, director, or exec_founder. Unmatched title → unknown.
        </div>
      </div>
    </details>
  );
}

// ── Title classifier rules (function / seniority) ─────────────────────────────
function ClassifierRuleList({ label, rules, values, onChange }) {
  const list = Array.isArray(rules) ? rules : [];
  const edit = (i, patch) => { const n = list.slice(); n[i] = { ...n[i], ...patch }; onChange(n); };
  const remove = (i) => onChange(list.filter((_, idx) => idx !== i));
  const addRule = () => onChange([...list, { patterns: [], value: values[0], match: 'word' }]);

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{label}</div>
      {list.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 6 }}>No overrides — built-in defaults apply.</div>}
      {list.map((r, i) => (
        <div key={i} style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>classify as</span>
            <Select value={r.value} options={values} onChange={(v) => edit(i, { value: v })} />
            <span style={{ fontSize: 12, color: '#6b7280' }}>match</span>
            <Select value={r.match || 'word'} options={['word', 'substring']} onChange={(v) => edit(i, { match: v })} />
            <span style={{ flex: 1 }} />
            <span onClick={() => remove(i)} style={S.x}>×</span>
          </div>
          <KeywordChips items={r.patterns} onChange={(p) => edit(i, { patterns: p })} placeholder="keyword or phrase (e.g. head of growth)" />
        </div>
      ))}
      <button onClick={addRule} style={btn(false, false)}>+ Add rule</button>
    </div>
  );
}

// ── Live preview — type titles, see classification + compiled regex ───────────
function ClassifierPreview({ classifier }) {
  const [titlesText, setTitlesText] = useState('Chief Revenue Officer\nHead of Growth\nFounder & CEO\nSenior Account Executive');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    const titles = titlesText.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 50);
    if (titles.length === 0) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API}/skills/classify/preview`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ titles, classifier }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || 'Preview failed');
      setResults(data.results || []);
    } catch (e) {
      setErr(e.message || 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...S.card, background: '#f9fafb' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Preview — does it classify the way you expect?</div>
      <div style={S.hint}>One title per line. Runs your unsaved keywords (after the same validation a save applies).</div>
      <textarea
        value={titlesText}
        onChange={(e) => setTitlesText(e.target.value)}
        rows={4}
        style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical', marginBottom: 6 }}
      />
      <button onClick={run} disabled={busy} style={btn(true, busy)}>{busy ? 'Classifying…' : 'Preview classification'}</button>
      {err && <div style={{ fontSize: 12, color: '#991b1b', marginTop: 6 }}>{err}</div>}
      {results && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280' }}>
              <th style={{ padding: '4px 6px' }}>Title</th>
              <th style={{ padding: '4px 6px' }}>Function</th>
              <th style={{ padding: '4px 6px' }}>Seniority</th>
              <th style={{ padding: '4px 6px' }}>Decision maker</th>
              <th style={{ padding: '4px 6px' }}>Matched on</th>
            </tr>
          </thead>
          <tbody>
            {results.map((res, i) => {
              const ft = res.trace && res.trace.function;
              const matched = ft && ft.source === 'config'
                ? `“${ft.keyword}” → /${ft.regex}/`
                : (ft && ft.source === 'default' ? 'built-in default' : '—');
              return (
                <tr key={i} style={{ borderTop: '1px solid #e5e7eb' }}>
                  <td style={{ padding: '4px 6px' }}>{res.title}</td>
                  <td style={{ padding: '4px 6px' }}>{res.function}</td>
                  <td style={{ padding: '4px 6px' }}>{res.seniority}</td>
                  <td style={{ padding: '4px 6px' }}>{res.decision_maker ? 'yes' : 'no'}</td>
                  <td style={{ padding: '4px 6px', color: '#6b7280' }}>{matched}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function TitleClassifierEditor({ value, onChange }) {
  const tc = value || { function_rules: [], seniority_rules: [], decision_maker: { seniorities: [], functions: [] } };
  const dm = tc.decision_maker || { seniorities: [], functions: [] };
  const set = (patch) => onChange({ ...tc, ...patch });
  const setDm = (patch) => set({ decision_maker: { ...dm, ...patch } });
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);

  return (
    <div style={S.section}>
      <div style={S.h}>Title classifier</div>
      <div style={S.hint}>
        Keywords (not regex) that map a prospect's title to a function / seniority. Your rules are tried first, in order;
        anything unmatched falls back to the built-in defaults. User-level rules win over org rules.
      </div>

      <InheritedClassifier />

      <ClassifierRuleList label="Function rules" rules={tc.function_rules} values={FUNCTION_VALUES} onChange={(r) => set({ function_rules: r })} />
      <ClassifierRuleList label="Seniority rules" rules={tc.seniority_rules} values={SENIORITY_VALUES} onChange={(r) => set({ seniority_rules: r })} />

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Decision-maker definition</div>
        <div style={S.hint}>Which seniorities / functions count as a decision maker. Leave empty to inherit the default (c_level, vp, director, exec_founder).</div>
        <div style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: '#6b7280', marginRight: 8 }}>Seniorities:</span>
          {SENIORITY_VALUES.map(s => (
            <label key={s} style={{ fontSize: 12, marginRight: 10 }}>
              <input type="checkbox" checked={(dm.seniorities || []).includes(s)} onChange={() => setDm({ seniorities: toggle(dm.seniorities || [], s) })} /> {s}
            </label>
          ))}
        </div>
        <div>
          <span style={{ fontSize: 12, color: '#6b7280', marginRight: 8 }}>Functions:</span>
          {FUNCTION_VALUES.map(f => (
            <label key={f} style={{ fontSize: 12, marginRight: 10 }}>
              <input type="checkbox" checked={(dm.functions || []).includes(f)} onChange={() => setDm({ functions: toggle(dm.functions || [], f) })} /> {f}
            </label>
          ))}
        </div>
      </div>

      <ClassifierPreview classifier={tc} />
    </div>
  );
}

// ── Fit rules editor ──────────────────────────────────────────────────────────
export function FitRulesEditor({ value, onChange }) {
  const rules = Array.isArray(value) ? value : [];
  const edit = (i, patch) => { const n = rules.slice(); n[i] = { ...n[i], ...patch }; onChange(n); };
  const remove = (i) => onChange(rules.filter((_, idx) => idx !== i));
  const add = () => onChange([...rules, { field: 'industry', match: 'contains_any', requirement: 'should', values: [], label: '' }]);

  return (
    <div style={S.section}>
      <div style={S.h}>Fit rules</div>
      <div style={S.hint}>
        Hard pass/fail gate before any draft is generated. You only declare what you change or add — the default ICP rules
        (revenue/sales/founder function, decision-maker seniority, out-of-ICP industry exclude) are inherited unless you override
        the same field + requirement. <strong>must</strong> fails → disqualified; <strong>exclude</strong> matches → disqualified;
        <strong> should</strong> or any unknown field → weak (manual review).
      </div>
      <InheritedFitRules />
      {rules.length === 0 && <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 6 }}>No overrides — default ICP rules apply.</div>}
      {rules.map((r, i) => (
        <div key={i} style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <Select value={r.field} options={FIT_FIELDS} onChange={(v) => edit(i, { field: v })} />
            <Select value={r.match} options={FIT_MATCH} onChange={(v) => edit(i, { match: v })} />
            <Select value={r.requirement} options={FIT_REQ} onChange={(v) => edit(i, { requirement: v })} />
            <input
              value={r.label || ''}
              onChange={(e) => edit(i, { label: e.target.value })}
              placeholder="label (shown in reasons)"
              style={{ ...S.input, flex: 1, minWidth: 140 }}
            />
            <span onClick={() => remove(i)} style={S.x}>×</span>
          </div>
          <KeywordChips items={r.values} onChange={(v) => edit(i, { values: v })} placeholder="value (e.g. SaaS, 11-50, Fintech)" />
        </div>
      ))}
      <button onClick={add} style={btn(false, false)}>+ Add rule</button>
    </div>
  );
}

// ── Outreach caps + recency (compact) ─────────────────────────────────────────
export function OutreachCapsEditor({ value, onChange }) {
  const caps = value || { email: {}, linkedin: {} };
  const email = caps.email || {};
  const linkedin = caps.linkedin || {};
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const setEmail = (intent, field, v) => {
    const next = { ...email, [intent]: { ...(email[intent] || {}) } };
    const n = num(v);
    if (n == null) delete next[intent][field]; else next[intent][field] = n;
    if (Object.keys(next[intent]).length === 0) delete next[intent];
    onChange({ ...caps, email: next });
  };
  const setLi = (intent, v) => {
    const next = { ...linkedin }; const n = num(v);
    if (n == null) delete next[intent]; else next[intent] = n;
    onChange({ ...caps, linkedin: next });
  };

  return (
    <div style={S.section}>
      <div style={S.h}>Outreach length caps</div>
      <div style={S.hint}>Blank = inherit the built-in cap. Email caps are word counts; LinkedIn caps are character counts.</div>
      <div style={{ fontSize: 13, fontWeight: 500, margin: '6px 0 4px' }}>Email (body words)</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {EMAIL_INTENTS.map(intent => (
          <label key={intent} style={{ fontSize: 12, color: '#6b7280' }}>
            {intent}<br />
            <input type="number" min="1" value={(email[intent] && email[intent].bodyWords) || ''} onChange={(e) => setEmail(intent, 'bodyWords', e.target.value)} style={{ ...S.input, width: 80 }} />
          </label>
        ))}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, margin: '6px 0 4px' }}>LinkedIn (characters)</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {LINKEDIN_INTENTS.map(intent => (
          <label key={intent} style={{ fontSize: 12, color: '#6b7280' }}>
            {intent}<br />
            <input type="number" min="1" value={linkedin[intent] || ''} onChange={(e) => setLi(intent, e.target.value)} style={{ ...S.input, width: 90 }} />
          </label>
        ))}
      </div>
    </div>
  );
}

export function RecencyEditor({ value, onChange }) {
  return (
    <div style={S.section}>
      <div style={S.h}>Hook recency window</div>
      <div style={S.hint}>How many days back a prospect's own post stays eligible as a hook. Blank = default (14).</div>
      <input
        type="number" min="1" max="365"
        value={value == null ? '' : value}
        onChange={(e) => { const n = parseInt(e.target.value, 10); onChange(Number.isFinite(n) && n > 0 ? Math.min(n, 365) : null); }}
        style={{ ...S.input, width: 100 }}
      />
      <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 8 }}>days</span>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function ProspectingFitGateConfig({
  fitRules, onFitRules,
  titleClassifier, onTitleClassifier,
  outreachCaps, onOutreachCaps,
  hookRecencyDays, onHookRecencyDays,
}) {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, margin: '8px 0 4px' }}>Fit &amp; classification</div>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
        Who counts as in-ICP, how titles map to function/seniority, and the length limits the skills must respect.
        Everything here is optional — leave a section empty to use the built-in defaults.
      </p>
      <TitleClassifierEditor value={titleClassifier} onChange={onTitleClassifier} />
      <FitRulesEditor value={fitRules} onChange={onFitRules} />
      <OutreachCapsEditor value={outreachCaps} onChange={onOutreachCaps} />
      <RecencyEditor value={hookRecencyDays} onChange={onHookRecencyDays} />
    </div>
  );
}
