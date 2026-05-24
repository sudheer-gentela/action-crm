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

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from './prospectingShared';

const HOOK_CATEGORY_OPTIONS = [
  { value: 'prospect_post',   label: "Prospect's own post / comment" },
  { value: 'account_event',   label: 'Account event (funding, leadership change)' },
  { value: 'tech_stack',      label: 'Tech stack overlap' },
  { value: 'role_curiosity',  label: 'Role + stage curiosity' },
];

export default function CampaignConfigPanel({ campaignId, canEdit }) {
  const [data,    setData]    = useState(null);   // { override, resolved, org_baseline, has_override }
  const [draft,   setDraft]   = useState(null);   // editable copy of override
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [flash,   setFlash]   = useState(null);
  const [expanded, setExpanded] = useState(false);

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
      // 403 here means the current user isn't owner/admin — render a read-only
      // placeholder rather than an error.
      if (/Requires role/i.test(err.message || '')) {
        setData({ readOnly: true });
      } else {
        setError('Failed to load campaign config: ' + (err.message || 'unknown'));
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
      // Reload to refresh the resolved view + org_baseline alongside the new override.
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

  // Header row — always visible. Click to expand.
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

  return (
    <div style={{ marginTop: 20 }}>
      {header}
      <div style={{ padding: '14px 12px', borderLeft: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', borderRadius: '0 0 8px 8px' }}>

        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px' }}>
          Override the org's outreach config for this campaign. Leave a field empty to inherit from the org.
          Banned phrasings and required disclaimers are <strong>additive</strong> — campaign restrictions
          augment org restrictions, never loosen them.
        </p>

        {flash && (
          <div style={{
            padding: '6px 10px', borderRadius: 6, fontSize: 12, marginBottom: 12,
            background: flash.type === 'error' ? '#fef2f2' : '#ecfdf5',
            color:      flash.type === 'error' ? '#991b1b' : '#065f46',
            border: '1px solid ' + (flash.type === 'error' ? '#fecaca' : '#a7f3d0'),
          }}>{flash.msg}</div>
        )}

        {/* Value props */}
        <FieldGroup
          title="Value propositions"
          hint="Non-empty here REPLACES the org defaults for this campaign."
          orgItems={data.org_baseline.default_value_props}
          items={draft.default_value_props}
          onChange={v => setDraft({ ...draft, default_value_props: v })}
          placeholder="Add a value prop…"
          canEdit={canEdit}
        />

        {/* Target personas */}
        <FieldGroup
          title="Target personas"
          hint="Non-empty here REPLACES the org defaults for this campaign."
          orgItems={data.org_baseline.default_target_personas}
          items={draft.default_target_personas}
          onChange={v => setDraft({ ...draft, default_target_personas: v })}
          placeholder="Add a persona…"
          canEdit={canEdit}
        />

        {/* Products */}
        <FieldGroup
          title="Products (priority order)"
          hint="Non-empty here REPLACES the org product list. Skill anchors to the first."
          orgItems={data.org_baseline.products}
          items={draft.products}
          onChange={v => setDraft({ ...draft, products: v })}
          placeholder="Add a product…"
          canEdit={canEdit}
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
          canEdit={canEdit}
        />

        {/* Case studies — structured */}
        <CaseStudySection
          title="Case studies"
          hint="Non-empty here REPLACES the org case studies for this campaign."
          orgItems={data.org_baseline.default_case_study_summaries}
          items={draft.default_case_study_summaries}
          onChange={v => setDraft({ ...draft, default_case_study_summaries: v })}
          canEdit={canEdit}
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
            canEdit={canEdit}
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
            canEdit={canEdit}
            nested
            additive
          />
        </div>

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
        {canEdit && (
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

      {/* Org defaults reminder — read-only */}
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
// dropdown. Categories cannot duplicate.
// ─────────────────────────────────────────────────────────────────────────────
function HookPreferencesEditor({ title, hint, orgItems, items, onChange, canEdit }) {
  const [pick, setPick] = useState('');

  const add = () => {
    if (!pick || items.includes(pick)) return;
    onChange([...items, pick]);
    setPick('');
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const labelOf = (v) => HOOK_CATEGORY_OPTIONS.find(o => o.value === v)?.label || v;
  const available = HOOK_CATEGORY_OPTIONS.filter(o => !items.includes(o.value));
  const orgList = Array.isArray(orgItems) ? orgItems : [];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      {orgList.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Org default order{items.length === 0 ? ' (in effect)' : ' (will be replaced)'}:{' '}
          <span style={{ fontStyle: 'italic' }}>{orgList.map(labelOf).join(' → ')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
            {orgList.length === 0 ? 'No ordering set — skill picks automatically' : 'No campaign override — inheriting org'}
          </span>
        )}
        {items.map((it, i) => (
          <div key={it} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#f9fafb', borderRadius: 6, padding: '5px 9px',
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, minWidth: 16, textAlign: 'center',
              borderRadius: 3, padding: '1px 4px',
              background: i === 0 ? '#e0e7ff' : '#e5e7eb',
              color:      i === 0 ? '#3730a3' : '#6b7280',
            }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 12 }}>{labelOf(it)}</span>
            {canEdit && (
              <>
                <span onClick={() => move(i, -1)} style={{ cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.3 : 1, fontSize: 11 }}>▲</span>
                <span onClick={() => move(i, 1)}  style={{ cursor: i === items.length - 1 ? 'default' : 'pointer', opacity: i === items.length - 1 ? 0.3 : 1, fontSize: 11 }}>▼</span>
                <span onClick={() => remove(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700 }}>×</span>
              </>
            )}
          </div>
        ))}
      </div>

      {canEdit && available.length > 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={pick}
            onChange={e => setPick(e.target.value)}
            style={{ flex: 1, fontSize: 12, padding: '5px 9px', border: '1px solid #d1d5db', borderRadius: 5 }}
          >
            <option value="">— Pick a category to add —</option>
            {available.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button onClick={add} disabled={!pick} style={btnStyle(false, !pick)}>+ Add</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CaseStudySection — structured {id, customer, summary}. New rows omit id;
// the backend mints one on save.
// ─────────────────────────────────────────────────────────────────────────────
function CaseStudySection({ title, hint, orgItems, items, onChange, canEdit }) {
  const [addingCustomer, setAddingCustomer] = useState('');
  const [addingSummary,  setAddingSummary]  = useState('');

  const orgList = Array.isArray(orgItems) ? orgItems : [];

  const addCase = () => {
    const customer = addingCustomer.trim();
    const summary  = addingSummary.trim();
    if (!customer && !summary) return;
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
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {hint && <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>{hint}</div>}

      {orgList.length > 0 && (
        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
          Org case studies{items.length === 0 ? ' (in effect)' : ' (will be replaced)'}:{' '}
          <span style={{ fontStyle: 'italic' }}>{orgList.map(cs => cs.customer).filter(Boolean).join(' · ')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {items.length === 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
            No campaign override — inheriting org case studies
          </span>
        )}
        {items.map((cs, i) => (
          <div key={cs.id || `new-${i}`} style={{
            border: '1px solid #e5e7eb', borderRadius: 6, padding: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <input
                value={cs.customer || ''}
                onChange={e => editCase(i, 'customer', e.target.value)}
                placeholder="Customer name"
                disabled={!canEdit}
                style={{ flex: 1, fontSize: 12, fontWeight: 600, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4 }}
              />
              {canEdit && (
                <span onClick={() => removeCase(i)} style={{ cursor: 'pointer', color: '#9ca3af', fontWeight: 700, fontSize: 14 }}>×</span>
              )}
            </div>
            <textarea
              value={cs.summary || ''}
              onChange={e => editCase(i, 'summary', e.target.value)}
              placeholder="One-line outcome the skill can reference"
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
            value={addingCustomer}
            onChange={e => setAddingCustomer(e.target.value)}
            placeholder="New case study — customer name"
            style={{ width: '100%', fontSize: 12, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4, marginBottom: 5 }}
          />
          <textarea
            value={addingSummary}
            onChange={e => setAddingSummary(e.target.value)}
            placeholder="One-line outcome…"
            rows={2}
            style={{ width: '100%', fontSize: 11, padding: '4px 7px', border: '1px solid #d1d5db', borderRadius: 4, resize: 'vertical', marginBottom: 5 }}
          />
          <button onClick={addCase} style={btnStyle(false, false)}>+ Add case study</button>
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
