// prospecting/CampaignConfigPanel.js
//
// Slice 1: Campaign-level prospecting_config override editor. Rendered as a
// section inside CampaignDetailDrawer for owners/admins.
//
// Backend:
//   GET    /api/prospecting-campaigns/:id/config
//   PUT    /api/prospecting-campaigns/:id/config
//   DELETE /api/prospecting-campaigns/:id/config
//
// Editor semantics: for each field, the user either "inherits from org" (the
// default — empty array stored on the campaign means inherit) or "overrides
// for this campaign" (non-empty array stored on the campaign replaces org).
// The toggle just hides/shows the editor block — empty arrays inherit either
// way. Guardrails are additive — the toggle wording reflects that.
//
// Schema v2 (this revision):
//   - Products are now structured {name, one_liner} objects, not strings.
//     ProductsSection replaces the generic FieldGroup for that field.
//   - Case studies are now {id, customer, their_problem, what_we_did, outcome}.
//     CaseStudySection takes four content fields instead of one summary.
//     The `summary` field is gone from the schema entirely.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';
import ProspectingFitGateConfig from '../ProspectingFitGateConfig';

const HOOK_CATEGORY_OPTIONS = [
  { value: 'prospect_post',   label: "Prospect's own post / comment" },
  { value: 'account_event',   label: 'Account event (funding, leadership change)' },
  { value: 'tech_stack',      label: 'Tech stack overlap' },
  { value: 'role_curiosity',  label: 'Role + stage curiosity' },
];

export default function CampaignConfigPanel({ campaignId, canEdit, defaultOpen = false }) {
  const [data,    setData]    = useState(null);   // { override, resolved, org_baseline, has_override }
  const [draft,   setDraft]   = useState(null);   // editable copy of override
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [flash,   setFlash]   = useState(null);
  // defaultOpen: the dedicated config screen passes true — when the rep has
  // explicitly navigated to "configuration", a collapsed header is friction.
  const [expanded, setExpanded] = useState(defaultOpen);

  const showFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await apiFetch(`/prospecting-campaigns/${campaignId}/config`);
      setData(r);
      setDraft(JSON.parse(JSON.stringify(r.override)));   // deep clone
    } catch (err) {
      const msg = err.message || '';
      if (/Requires role|Only owners.*can edit|Access denied/i.test(msg)) {
        setData({ readOnly: true });
      } else {
        setError('Failed to load campaign config: ' + (msg || 'unknown'));
      }
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const dirty = data && draft && JSON.stringify(data.override) !== JSON.stringify(draft);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch(`/prospecting-campaigns/${campaignId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ override: draft }),
      });
      await load();
      showFlash('success', 'Campaign config saved');
    } catch (err) {
      showFlash('error', 'Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Clear all campaign overrides? The campaign will inherit org defaults for every field.')) return;
    setSaving(true);
    try {
      await apiFetch(`/prospecting-campaigns/${campaignId}/config`, { method: 'DELETE' });
      await load();
      showFlash('success', 'Campaign config cleared — inheriting org defaults');
    } catch (err) {
      showFlash('error', 'Clear failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraft(JSON.parse(JSON.stringify(data.override)));
  };

  const header = (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', cursor: 'pointer',
        background: '#f9fafb', borderRadius: 8,
        border: '1px solid #e5e7eb',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1A3A5C' }}>
          🛠 Campaign-level outreach config
        </span>
        {data?.has_override ? (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
            background: '#fef3c7', color: '#92400e',
          }}>Override active</span>
        ) : (
          <span style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 10,
            background: '#f1f5f9', color: '#64748b',
          }}>Inheriting org defaults</span>
        )}
      </div>
      <span style={{ fontSize: 13, color: '#9ca3af' }}>{expanded ? '▾' : '▸'}</span>
    </div>
  );

  if (!expanded) return <div style={{ marginTop: 20 }}>{header}</div>;

  if (loading) {
    return (
      <div style={{ marginTop: 20 }}>
        {header}
        <div style={{ padding: 16, fontSize: 13, color: '#6b7280' }}>Loading config…</div>
      </div>
    );
  }

  if (data?.readOnly) {
    return (
      <div style={{ marginTop: 20 }}>
        {header}
        <div style={{ padding: 16, fontSize: 13, color: '#6b7280', fontStyle: 'italic' }}>
          Only owners and admins can view or edit campaign-level outreach config.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ marginTop: 20 }}>
        {header}
        <div style={{ padding: 16, fontSize: 13, color: '#991b1b' }}>{error}</div>
      </div>
    );
  }

  if (!draft || !data) return null;

  const effectiveCanEdit = (typeof data.can_edit === 'boolean') ? data.can_edit : canEdit;

  return (
    <div style={{ marginTop: 20 }}>
      {header}
      <div style={{ padding: '14px 12px', borderLeft: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderRadius: '0 0 8px 8px' }}>

        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px' }}>
          Override the org's outreach config for this campaign. Leave a field empty to inherit from the org.
          Banned phrasings and required disclaimers are <strong>additive</strong> — campaign restrictions
          augment org restrictions, never loosen them.
          {data.access_via === 'campaign_ownership' && (
            <span style={{ display: 'block', marginTop: 4, fontStyle: 'italic', color: '#0F9D8E' }}>
              You can edit this because you own this campaign.
            </span>
          )}
        </p>

        {flash && (
          <div style={{
            padding: '6px 10px', borderRadius: 6, fontSize: 12, marginBottom: 12,
            background: flash.type === 'error' ? '#fef2f2' : '#ecfdf5',
            color:      flash.type === 'error' ? '#991b1b' : '#065f46',
            border: '1px solid ' + (flash.type === 'error' ? '#fecaca' : '#a7f3d0'),
          }}>{flash.msg}</div>
        )}

        {/* Pitch — campaign-level narrative the skill paraphrases as framing */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Pitch</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
            The story for this campaign's audience — what we say and why ("we help X do Y because Z").
            The AI paraphrases this as the email's framing; it never quotes it. Non-empty here REPLACES the org pitch.
            {data.org_baseline.pitch ? (
              <span style={{ display: 'block', marginTop: 4, fontStyle: 'italic' }}>
                Org default: "{data.org_baseline.pitch.length > 140 ? data.org_baseline.pitch.slice(0, 140) + '…' : data.org_baseline.pitch}"
              </span>
            ) : null}
          </div>
          <textarea
            value={draft.pitch || ''}
            onChange={e => setDraft({ ...draft, pitch: e.target.value })}
            disabled={!effectiveCanEdit}
            rows={3}
            maxLength={2000}
            placeholder="Leave empty to inherit the org pitch…"
            style={{
              width: '100%', padding: '8px 11px', borderRadius: 7,
              border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box',
              fontFamily: 'inherit', color: '#111', resize: 'vertical', lineHeight: 1.5,
              background: effectiveCanEdit ? '#fff' : '#f9fafb',
            }}
          />
        </div>

        {/* Value props */}
        <FieldGroup
          title="Value propositions"
          hint="Non-empty here REPLACES the org defaults for this campaign."
          orgItems={data.org_baseline.default_value_props}
          items={draft.default_value_props}
          onChange={v => setDraft({ ...draft, default_value_props: v })}
          placeholder="Add a value prop…"
          canEdit={effectiveCanEdit}
        />

        {/* Target personas */}
        <FieldGroup
          title="Target personas"
          hint="Non-empty here REPLACES the org defaults for this campaign."
          orgItems={data.org_baseline.default_target_personas}
          items={draft.default_target_personas}
          onChange={v => setDraft({ ...draft, default_target_personas: v })}
          placeholder="Add a persona…"
          canEdit={effectiveCanEdit}
        />

        {/* Products — structured {name, one_liner} */}
        <ProductsSection
          title="Products (priority order)"
          hint="Non-empty here REPLACES the org product list. Skill anchors to the first."
          orgItems={data.org_baseline.products}
          items={draft.products}
          onChange={v => setDraft({ ...draft, products: v })}
          canEdit={effectiveCanEdit}
        />

        {/* Hook preferences — ordered category list with a picker */}
        <HookPreferencesEditor
          title="Default hook ordering"
          hint="The skill picks signals in this order. Non-empty REPLACES the org default."
          orgItems={data.org_baseline.hook_preferences?.preferred_categories || []}
          items={draft.hook_preferences?.preferred_categories || []}
          onChange={v => setDraft({
            ...draft,
            hook_preferences: { ...draft.hook_preferences, preferred_categories: v },
          })}
          canEdit={effectiveCanEdit}
        />

        {/* Case studies — structured {customer, their_problem, what_we_did, outcome} */}
        <CaseStudySection
          title="Case studies"
          hint="Non-empty here REPLACES the org case studies for this campaign."
          orgItems={data.org_baseline.default_case_study_summaries}
          items={draft.default_case_study_summaries}
          onChange={v => setDraft({ ...draft, default_case_study_summaries: v })}
          canEdit={effectiveCanEdit}
        />

        {/* Guardrails — additive */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Guardrails (additive — these <strong>add to</strong> org restrictions)
          </div>
          <FieldGroup
            title="Additional banned phrasings"
            orgItems={data.org_baseline.guardrails?.banned_phrasings || []}
            items={draft.guardrails?.banned_phrasings || []}
            onChange={v => setDraft({
              ...draft,
              guardrails: { ...(draft.guardrails || {}), banned_phrasings: v },
            })}
            placeholder="Phrase the skill must avoid…"
            canEdit={effectiveCanEdit}
            danger
            nested
            additive
          />
          <FieldGroup
            title="Additional required disclaimers"
            orgItems={data.org_baseline.guardrails?.required_disclaimers || []}
            items={draft.guardrails?.required_disclaimers || []}
            onChange={v => setDraft({
              ...draft,
              guardrails: { ...(draft.guardrails || {}), required_disclaimers: v },
            })}
            placeholder="Disclaimer the skill must include…"
            canEdit={effectiveCanEdit}
            nested
            additive
          />
        </div>

        {/* Campaign-level fit / classification overrides (campaign > user > org) */}
        {effectiveCanEdit && (
          <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 16, paddingTop: 14 }}>
            <ProspectingFitGateConfig
              fitRules={draft.fit_rules}
              onFitRules={(v) => setDraft({ ...draft, fit_rules: v })}
              titleClassifier={draft.title_classifier}
              onTitleClassifier={(v) => setDraft({ ...draft, title_classifier: v })}
              outreachCaps={draft.outreach_caps}
              onOutreachCaps={(v) => setDraft({ ...draft, outreach_caps: v })}
              hookRecencyDays={draft.hook_recency_days}
              onHookRecencyDays={(v) => setDraft({ ...draft, hook_recency_days: v })}
            />
          </div>
        )}

        {/* Resolved preview — what the skill will actually see */}
        <details style={{ marginTop: 18, fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', color: '#6366f1', fontWeight: 600 }}>
            Show resolved preview (what the skill will see)
          </summary>
          <pre style={{
            background: '#f8fafc', padding: 10, borderRadius: 6, marginTop: 6,
            fontSize: 11, color: '#374151', overflowX: 'auto',
          }}>{JSON.stringify(data.resolved, null, 2)}</pre>
        </details>

        {/* Action bar */}
        {effectiveCanEdit && (
          <div style={{
            marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f5f9',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ flex: 1, fontSize: 11, color: dirty ? '#b45309' : '#9ca3af' }}>
              {dirty ? 'Unsaved changes' : data.has_override ? 'Override saved' : 'No override set'}
            </span>
            {data.has_override && (
              <button onClick={handleClear} disabled={saving} style={btnStyle(false, saving, '#991b1b')}>
                Clear override
              </button>
            )}
            <button onClick={handleDiscard} disabled={!dirty || saving} style={btnStyle(false, !dirty || saving)}>
              Discard
            </button>
            <button onClick={handleSave} disabled={!dirty || saving} style={btnStyle(true, !dirty || saving)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FieldGroup — string-array editor with a "see org defaults" callout.
// `additive` flips the inherit copy from "REPLACES" to "ADDS TO".
// ─────────────────────────────────────────────────────────────────────────────
function FieldGroup({ title, hint, orgItems, items, onChange, placeholder, canEdit, danger, nested, additive }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(''); return; }
    onChange([...items, v]);
    setDraft('');
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  const orgList = Array.isArray(orgItems) ? orgItems : [];

  return (
    <div style={{ marginBottom: nested ? 12 : 16 }}>
      <div style={{ fontSize: nested ? 12 : 13, fontWeight: nested ? 500 : 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      {orgList.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Org default{additive ? ' (always applies)' : items.length === 0 ? ' (in effect — no campaign override)' : ' (will be replaced by campaign list)'}:{' '}
          <span style={{ fontStyle: 'italic' }}>{orgList.join(' · ')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
            {orgList.length === 0 ? 'Nothing set — nothing inherited either' : 'No campaign override — inheriting org'}
          </span>
        )}
        {items.map((it, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
            padding: '4px 10px', borderRadius: 14,
            background: danger ? '#fef2f2' : '#e0e7ff',
            color:      danger ? '#991b1b' : '#3730a3',
          }}>
            {it}
            {canEdit && (
              <span onClick={() => remove(i)} style={{ cursor: 'pointer', fontWeight: 700 }}>×</span>
            )}
          </span>
        ))}
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder={placeholder}
            style={{ flex: 1, fontSize: 12, padding: '5px 9px', border: '1px solid #d1d5db', borderRadius: 5 }}
          />
          <button onClick={add} style={btnStyle(false, false)}>+ Add</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HookPreferencesEditor — ordered list with up/down arrows + a category picker
// ─────────────────────────────────────────────────────────────────────────────
function HookPreferencesEditor({ title, hint, orgItems, items, onChange, canEdit }) {
  const [picker, setPicker] = useState('');
  const orgList = Array.isArray(orgItems) ? orgItems : [];
  const available = HOOK_CATEGORY_OPTIONS.filter(o => !items.includes(o.value));

  const labelFor = (v) => {
    const o = HOOK_CATEGORY_OPTIONS.find(opt => opt.value === v);
    return o ? o.label : v;
  };
  const add = () => {
    if (!picker) return;
    if (items.includes(picker)) { setPicker(''); return; }
    onChange([...items, picker]);
    setPicker('');
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
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      {orgList.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Org default{items.length === 0 ? ' (in effect — no campaign override)' : ' (will be replaced)'}:{' '}
          <span style={{ fontStyle: 'italic' }}>{orgList.map(labelFor).join(' › ')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
            {orgList.length === 0 ? 'Nothing set' : 'No campaign override — inheriting org'}
          </span>
        )}
        {items.map((v, i) => (
          <div key={v} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#f9fafb', borderRadius: 5, padding: '4px 8px',
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, minWidth: 16, textAlign: 'center',
              borderRadius: 3, padding: '1px 3px',
              background: i === 0 ? '#e0e7ff' : '#e5e7eb',
              color:      i === 0 ? '#3730a3' : '#6b7280',
            }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 12 }}>{labelFor(v)}</span>
            {canEdit && (
              <>
                <span onClick={() => move(i, -1)} style={{ cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.3 : 1, fontSize: 12 }}>▲</span>
                <span onClick={() => move(i, 1)}  style={{ cursor: i === items.length - 1 ? 'default' : 'pointer', opacity: i === items.length - 1 ? 0.3 : 1, fontSize: 12 }}>▼</span>
                <span onClick={() => remove(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700, fontSize: 12 }}>×</span>
              </>
            )}
          </div>
        ))}
      </div>

      {canEdit && available.length > 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={picker}
            onChange={e => setPicker(e.target.value)}
            style={{ flex: 1, fontSize: 12, padding: '5px 9px', border: '1px solid #d1d5db', borderRadius: 5 }}
          >
            <option value="">Add a category…</option>
            {available.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={add} disabled={!picker} style={btnStyle(false, !picker)}>+ Add</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProductsSection — structured {name, one_liner} editor (v2 schema).
//
// Each product has:
//   - name:      the human label (e.g. "Aquarient Data Services")
//   - one_liner: the model-facing pitch sentence
//
// Priority is implicit (array order). The skill anchors to products[0] unless
// a later one better matches the prospect — we expose up/down arrows so the
// rep can re-order without rebuilding the list.
//
// New rows save as {name, one_liner}; the backend sanitizer (cleanProductArray)
// strips entries with no name. Legacy string entries from older configs
// (pre-v2) are no longer accepted and will be silently dropped by the
// sanitizer on next save. Migrate by re-entering.
// ─────────────────────────────────────────────────────────────────────────────
function ProductsSection({ title, hint, orgItems, items, onChange, canEdit }) {
  const [addingName,     setAddingName]     = useState('');
  const [addingOneLiner, setAddingOneLiner] = useState('');

  const orgList = (Array.isArray(orgItems) ? orgItems : [])
    // Defensive normalize: if a legacy string snuck through, render its label.
    .map(p => (typeof p === 'string' ? { name: p, one_liner: '' } : p))
    .filter(p => p && p.name);

  const addProduct = () => {
    const name = addingName.trim();
    const oneLiner = addingOneLiner.trim();
    if (!name) return;   // name is required; one_liner can be empty
    if (items.some(p => p && p.name && p.name.toLowerCase() === name.toLowerCase())) {
      setAddingName(''); setAddingOneLiner('');
      return;
    }
    onChange([...items, { name, one_liner: oneLiner }]);
    setAddingName(''); setAddingOneLiner('');
  };
  const removeProduct = (i) => onChange(items.filter((_, idx) => idx !== i));
  const editProduct = (i, field, value) => {
    const next = items.slice();
    next[i] = { ...next[i], [field]: value };
    onChange(next);
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      {orgList.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Org default{items.length === 0 ? ' (in effect — no campaign override)' : ' (will be replaced by campaign list)'}:{' '}
          <span style={{ fontStyle: 'italic' }}>{orgList.map(p => p.name).join(' · ')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
            {orgList.length === 0 ? 'Nothing set — nothing inherited either' : 'No campaign override — inheriting org'}
          </span>
        )}
        {items.map((p, i) => (
          <div key={`p-${i}`} style={{
            border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, background: '#fff',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, minWidth: 18, textAlign: 'center',
                borderRadius: 3, padding: '1px 4px',
                background: i === 0 ? '#e0e7ff' : '#e5e7eb',
                color:      i === 0 ? '#3730a3' : '#6b7280',
              }}>{i + 1}</span>
              <input
                value={(p && p.name) || ''}
                onChange={e => editProduct(i, 'name', e.target.value)}
                placeholder="Product name"
                disabled={!canEdit}
                style={{ flex: 1, fontSize: 12, fontWeight: 600, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4 }}
              />
              {canEdit && (
                <>
                  <span onClick={() => move(i, -1)} style={{ cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.3 : 1, fontSize: 13 }}>▲</span>
                  <span onClick={() => move(i, 1)}  style={{ cursor: i === items.length - 1 ? 'default' : 'pointer', opacity: i === items.length - 1 ? 0.3 : 1, fontSize: 13 }}>▼</span>
                  <span onClick={() => removeProduct(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700, fontSize: 14 }}>×</span>
                </>
              )}
            </div>
            <textarea
              value={(p && p.one_liner) || ''}
              onChange={e => editProduct(i, 'one_liner', e.target.value)}
              placeholder="One-liner the skill can paraphrase into outreach (e.g. what the product does, in one sentence)"
              rows={2}
              disabled={!canEdit}
              style={{ width: '100%', fontSize: 11, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4, resize: 'vertical' }}
            />
          </div>
        ))}
      </div>

      {canEdit && (
        <div style={{ border: '1px dashed #d1d5db', borderRadius: 6, padding: 8 }}>
          <input
            value={addingName}
            onChange={e => setAddingName(e.target.value)}
            placeholder="New product — name"
            style={{ width: '100%', fontSize: 12, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4, marginBottom: 5 }}
          />
          <textarea
            value={addingOneLiner}
            onChange={e => setAddingOneLiner(e.target.value)}
            placeholder="One-liner (optional but recommended)…"
            rows={2}
            style={{ width: '100%', fontSize: 11, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4, resize: 'vertical', marginBottom: 5 }}
          />
          <button onClick={addProduct} disabled={!addingName.trim()} style={btnStyle(false, !addingName.trim())}>
            + Add product
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CaseStudySection — structured case study editor (v2 schema).
//
// Each case study has:
//   - id            opaque, minted server-side on save; preserved across edits
//   - customer      human label (anonymized OK — e.g. "an energy management firm")
//   - their_problem what was broken before
//   - what_we_did   the concrete work
//   - outcome       the result (qualitative is fine — don't invent numbers)
//
// The legacy `summary` field is gone. Case studies that only had a customer
// + summary in v1 will be dropped by the sanitizer on next save — there is
// no automatic migration. Re-enter affected entries with the new fields.
// ─────────────────────────────────────────────────────────────────────────────
function CaseStudySection({ title, hint, orgItems, items, onChange, canEdit }) {
  const [adding, setAdding] = useState({
    customer: '', their_problem: '', what_we_did: '', outcome: '',
  });

  const orgList = Array.isArray(orgItems) ? orgItems : [];

  const addCase = () => {
    const customer     = (adding.customer      || '').trim();
    const theirProblem = (adding.their_problem || '').trim();
    const whatWeDid    = (adding.what_we_did   || '').trim();
    const outcome      = (adding.outcome       || '').trim();
    // Must have at least one of the three content fields. A customer name
    // alone is not enough — the skill has nothing to reference. This mirrors
    // the backend sanitizer in prospectingConfigSchema.cleanCaseStudy.
    if (!theirProblem && !whatWeDid && !outcome) return;
    onChange([...items, { customer, their_problem: theirProblem, what_we_did: whatWeDid, outcome }]);
    setAdding({ customer: '', their_problem: '', what_we_did: '', outcome: '' });
  };
  const removeCase = (i) => onChange(items.filter((_, idx) => idx !== i));
  const editCase = (i, field, value) => {
    const next = items.slice();
    next[i] = { ...next[i], [field]: value };
    onChange(next);
  };

  const inputStyle  = { width: '100%', fontSize: 12, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4 };
  const textareaStyle = { ...inputStyle, fontSize: 11, resize: 'vertical' };
  const labelStyle = { fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 3 };

  const renderFieldEditor = (cs, i, field, placeholder, rows = 2) => (
    <div style={{ marginTop: 6 }}>
      <div style={labelStyle}>{field === 'their_problem' ? 'Their problem' : field === 'what_we_did' ? 'What we did' : 'Outcome'}</div>
      <textarea
        value={(cs && cs[field]) || ''}
        onChange={e => editCase(i, field, e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={!canEdit}
        style={textareaStyle}
      />
    </div>
  );

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      {orgList.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Org case studies{items.length === 0 ? ' (in effect)' : ' (will be replaced)'}:{' '}
          <span style={{ fontStyle: 'italic' }}>{orgList.map(cs => cs.customer).filter(Boolean).join(' · ')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
            No campaign override — inheriting org case studies
          </span>
        )}
        {items.map((cs, i) => (
          <div key={cs.id || `new-${i}`} style={{
            border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, background: '#fff',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <input
                value={cs.customer || ''}
                onChange={e => editCase(i, 'customer', e.target.value)}
                placeholder="Customer name (anonymized OK)"
                disabled={!canEdit}
                style={{ ...inputStyle, fontWeight: 600 }}
              />
              {canEdit && (
                <span onClick={() => removeCase(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700, fontSize: 14 }}>×</span>
              )}
            </div>
            {renderFieldEditor(cs, i, 'their_problem', 'What was broken before — be specific and concrete', 2)}
            {renderFieldEditor(cs, i, 'what_we_did',   'The concrete work — what did we build, fix, or run', 2)}
            {renderFieldEditor(cs, i, 'outcome',       'The result — qualitative is fine, don\'t invent numbers', 2)}
            {cs.id && (
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 5 }}>
                ref: {cs.id} — used as the exclusion key
              </div>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div style={{ border: '1px dashed #d1d5db', borderRadius: 6, padding: 10 }}>
          <input
            value={adding.customer}
            onChange={e => setAdding(a => ({ ...a, customer: e.target.value }))}
            placeholder="New case study — customer name"
            style={{ ...inputStyle, fontWeight: 600, marginBottom: 6 }}
          />
          <div style={labelStyle}>Their problem</div>
          <textarea
            value={adding.their_problem}
            onChange={e => setAdding(a => ({ ...a, their_problem: e.target.value }))}
            placeholder="What was broken before — be specific"
            rows={2}
            style={{ ...textareaStyle, marginBottom: 6 }}
          />
          <div style={labelStyle}>What we did</div>
          <textarea
            value={adding.what_we_did}
            onChange={e => setAdding(a => ({ ...a, what_we_did: e.target.value }))}
            placeholder="The concrete work"
            rows={2}
            style={{ ...textareaStyle, marginBottom: 6 }}
          />
          <div style={labelStyle}>Outcome</div>
          <textarea
            value={adding.outcome}
            onChange={e => setAdding(a => ({ ...a, outcome: e.target.value }))}
            placeholder="The result — qualitative is fine"
            rows={2}
            style={{ ...textareaStyle, marginBottom: 6 }}
          />
          <button
            onClick={addCase}
            disabled={!adding.their_problem.trim() && !adding.what_we_did.trim() && !adding.outcome.trim()}
            style={btnStyle(false, !adding.their_problem.trim() && !adding.what_we_did.trim() && !adding.outcome.trim())}
          >
            + Add case study
          </button>
        </div>
      )}
    </div>
  );
}

function btnStyle(primary, disabled, customColor) {
  const baseColor = customColor || '#6366f1';
  return {
    padding: '5px 12px', fontSize: 12, borderRadius: 5,
    cursor: disabled ? 'default' : 'pointer',
    fontWeight: 600, opacity: disabled ? 0.5 : 1,
    border: '1px solid ' + (primary ? baseColor : '#d1d5db'),
    background: primary ? baseColor : '#fff',
    color: primary ? '#fff' : (customColor || '#374151'),
  };
}
