/* Extracted from OrgAdminView.js — Phase 2 refactor (2026-06).
 * Verbatim move; no logic changes.
 * Panel: OAIcpScoring. Includes co-located single-consumer constants/helpers. */
import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../../apiService';

const CAT_COLORS = ['#7c3aed','#2563eb','#059669','#d97706','#dc2626','#0891b2','#4f46e5','#c026d3','#ea580c','#16a34a'];

function catColor(idx) { return CAT_COLORS[idx % CAT_COLORS.length]; }

export default function OAIcpScoring() {
  const [config, setConfig]         = useState(null);
  const [draft, setDraft]           = useState(null);
  const [fieldDefs, setFieldDefs]   = useState({ fields: [], matchTypes: [] });
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [scoring, setScoring]       = useState(false);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');
  const [dirty, setDirty]           = useState(false);
  const [expandedCat, setExpandedCat] = useState(null);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 3000); };

  // ── Load config + field definitions ─────────────────────────────────

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [cfgRes, fieldsRes] = await Promise.all([
        apiService.prospects.getIcpConfig(),
        apiService.prospects.getIcpFields(),
      ]);
      const cfg = cfgRes.data.config || { categories: [] };
      setConfig(cfg);
      setDraft(JSON.parse(JSON.stringify(cfg)));
      setFieldDefs(fieldsRes.data || { fields: [], matchTypes: [] });
      setDirty(false);
    } catch (err) {
      setError('Failed to load ICP config');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Draft helpers ───────────────────────────────────────────────────

  const updateCategories = (fn) => {
    setDraft(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      fn(next.categories);
      return next;
    });
    setDirty(true);
  };

  const updateCategory = (catIdx, field, value) => {
    updateCategories(cats => { cats[catIdx][field] = value; });
  };

  const updateRule = (catIdx, ruleIdx, field, value) => {
    updateCategories(cats => { cats[catIdx].rules[ruleIdx][field] = value; });
  };

  // ── Category CRUD ───────────────────────────────────────────────────

  const addCategory = () => {
    const newKey = 'custom_' + Date.now();
    updateCategories(cats => {
      cats.push({
        key: newKey,
        label: 'New Category',
        enabled: true,
        weight: 10,
        baseline_score: 50,
        rules: [],
      });
    });
    setExpandedCat((draft?.categories?.length || 0));
  };

  const removeCategory = (idx) => {
    const cat = draft.categories[idx];
    if (!window.confirm(`Delete category "${cat.label}"? This cannot be undone.`)) return;
    updateCategories(cats => cats.splice(idx, 1));
    if (expandedCat === idx) setExpandedCat(null);
    else if (expandedCat > idx) setExpandedCat(expandedCat - 1);
  };

  const moveCategory = (idx, dir) => {
    const to = idx + dir;
    if (to < 0 || to >= draft.categories.length) return;
    updateCategories(cats => {
      const tmp = cats[idx]; cats[idx] = cats[to]; cats[to] = tmp;
    });
    setExpandedCat(to);
  };

  // ── Rule CRUD ───────────────────────────────────────────────────────

  const addRule = (catIdx) => {
    updateCategories(cats => {
      cats[catIdx].rules.push({
        field: 'title',
        match_type: 'contains_text',
        target_values: [],
        points_if_match: 10,
        points_if_no_match: 0,
        points_if_empty: 0,
        label: 'New rule',
      });
    });
  };

  const removeRule = (catIdx, ruleIdx) => {
    updateCategories(cats => cats[catIdx].rules.splice(ruleIdx, 1));
  };

  // ── Save / Reset / Score All ────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const r = await apiService.prospects.updateIcpConfig(draft);
      setConfig(r.data.config || draft);
      setDraft(JSON.parse(JSON.stringify(r.data.config || draft)));
      setDirty(false);
      flash('ICP config saved');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleReset = () => {
    setDraft(JSON.parse(JSON.stringify(config)));
    setDirty(false);
    setExpandedCat(null);
  };

  const handleResetDefaults = async () => {
    if (!window.confirm('Reset to factory defaults? All custom categories and rules will be lost.')) return;
    try {
      const r = await apiService.prospects.getIcpDefaults();
      const defaultCfg = { categories: r.data.categories };
      setDraft(defaultCfg);
      setDirty(true);
      flash('Defaults loaded — save to apply');
    } catch (err) {
      setError('Failed to load defaults');
    }
  };

  const handleBulkScore = async () => {
    if (!window.confirm('Re-score all unscored prospects? This may take a moment.')) return;
    setScoring(true); setError('');
    try {
      const r = await apiService.prospects.scoreAllIcp();
      flash(r.data.message || 'Scoring complete');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Scoring failed');
    } finally { setScoring(false); }
  };

  // ── Loading state ──────────────────────────────────────────────────

  if (loading || !draft) return <div className="oa-loading">Loading ICP config…</div>;

  const categories = draft.categories || [];
  const enabledCats = categories.filter(c => c.enabled);
  const totalWeight = enabledCats.reduce((s, c) => s + (c.weight || 0), 0);

  // ── Helpers for field lookups ──────────────────────────────────────

  const getField = (key) => fieldDefs.fields.find(f => f.key === key);
  const getMatchTypesFor = (fieldKey) => {
    const f = getField(fieldKey);
    if (!f) return fieldDefs.matchTypes;
    return fieldDefs.matchTypes.filter(m => m.for_types.includes(f.type));
  };
  const groupedFields = fieldDefs.fields.reduce((acc, f) => {
    (acc[f.group] = acc[f.group] || []).push(f); return acc;
  }, {});

  // ── TagInput sub-component ────────────────────────────────────────

  const TagInput = ({ values, onChange, placeholder, color }) => {
    const [input, setInput] = useState('');
    const add = () => {
      const v = input.trim();
      if (v && !values.includes(v)) onChange([...values, v]);
      setInput('');
    };
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
        {values.map((v, i) => (
          <span key={i} style={{ padding: '1px 6px', borderRadius: 3, fontSize: 10, background: (color || '#6b7280') + '15', color: color || '#6b7280', border: `1px solid ${(color || '#6b7280')}30`, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            {v}
            <button onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 10, padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
        <input
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={values.length === 0 ? (placeholder || 'Type + Enter') : ''}
          style={{ flex: 1, minWidth: 80, padding: '2px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, outline: 'none' }}
        />
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div>
      {error && <div className="oa-error">{error} <button onClick={() => setError('')}>×</button></div>}
      {success && <div className="oa-success">{success}</div>}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
          Define scoring categories and rules. Each prospect is scored 0–100 based on the weighted categories below.
        </p>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={handleBulkScore} disabled={scoring}
            style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 500, background: '#f3f4f6', border: '1px solid #d1d5db', cursor: 'pointer', color: '#374151' }}>
            {scoring ? 'Scoring…' : '⚡ Score Unscored'}
          </button>
          <button onClick={handleResetDefaults}
            style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#f3f4f6', border: '1px solid #d1d5db', cursor: 'pointer', color: '#6b7280' }}>
            Reset Defaults
          </button>
          {dirty && (
            <button onClick={handleReset}
              style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#fef2f2', border: '1px solid #fca5a5', cursor: 'pointer', color: '#dc2626' }}>
              Discard
            </button>
          )}
          <button onClick={handleSave} disabled={!dirty || saving}
            style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: dirty ? '#111827' : '#e5e7eb', color: '#fff', border: 'none', cursor: dirty ? 'pointer' : 'default' }}>
            {saving ? 'Saving…' : 'Save Config'}
          </button>
        </div>
      </div>

      {/* Weight summary bar */}
      <div style={{ padding: 12, borderRadius: 8, background: '#fff', border: '1px solid #e5e7eb', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Weight Distribution</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: totalWeight === 100 ? '#059669' : '#dc2626' }}>
            Total: {totalWeight}% {totalWeight !== 100 && '(should be 100%)'}
          </span>
        </div>
        {/* Stacked bar */}
        <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', background: '#f3f4f6' }}>
          {enabledCats.map((cat, i) => {
            const ci = categories.indexOf(cat);
            const pct = totalWeight > 0 ? (cat.weight / totalWeight) * 100 : 0;
            return pct > 0 ? (
              <div key={cat.key} style={{ width: pct + '%', background: catColor(ci), display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'width 0.3s' }}>
                <span style={{ fontSize: 9, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  {cat.weight >= 8 ? `${cat.label} ${cat.weight}%` : `${cat.weight}%`}
                </span>
              </div>
            ) : null;
          })}
        </div>
      </div>

      {/* Category list */}
      {categories.map((cat, ci) => {
        const color = catColor(ci);
        const isExpanded = expandedCat === ci;

        return (
          <div key={cat.key} style={{ marginBottom: 10, borderRadius: 8, border: `1px solid ${isExpanded ? color + '40' : '#e5e7eb'}`, background: '#fff', overflow: 'hidden', transition: 'border-color 0.2s' }}>

            {/* Category header */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', background: isExpanded ? color + '06' : 'transparent' }}
              onClick={() => setExpandedCat(isExpanded ? null : ci)}
            >
              <span style={{ fontSize: 12, color: '#9ca3af', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>

              {/* Enabled toggle */}
              <button
                onClick={e => { e.stopPropagation(); updateCategory(ci, 'enabled', !cat.enabled); }}
                style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${cat.enabled ? color : '#d1d5db'}`, background: cat.enabled ? color : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 10, color: '#fff', padding: 0, flexShrink: 0 }}
              >{cat.enabled ? '✓' : ''}</button>

              <span style={{ fontSize: 13, fontWeight: 600, color: cat.enabled ? '#111827' : '#9ca3af', flex: 1, textDecoration: cat.enabled ? 'none' : 'line-through' }}>
                {cat.label}
              </span>

              <span style={{ fontSize: 10, color: '#9ca3af' }}>
                {(cat.rules || []).length} rule{(cat.rules || []).length !== 1 ? 's' : ''}
              </span>

              {/* Weight badge */}
              <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: cat.enabled ? color + '15' : '#f3f4f6', color: cat.enabled ? color : '#9ca3af' }}>
                {cat.weight}%
              </span>

              {/* Move / Delete */}
              <div style={{ display: 'flex', gap: 2 }} onClick={e => e.stopPropagation()}>
                <button onClick={() => moveCategory(ci, -1)} disabled={ci === 0} style={{ background: 'none', border: 'none', cursor: ci === 0 ? 'default' : 'pointer', fontSize: 10, color: ci === 0 ? '#d1d5db' : '#6b7280', padding: '2px 4px' }}>▲</button>
                <button onClick={() => moveCategory(ci, 1)} disabled={ci === categories.length - 1} style={{ background: 'none', border: 'none', cursor: ci === categories.length - 1 ? 'default' : 'pointer', fontSize: 10, color: ci === categories.length - 1 ? '#d1d5db' : '#6b7280', padding: '2px 4px' }}>▼</button>
                <button onClick={() => removeCategory(ci)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#dc2626', padding: '2px 4px' }}>🗑</button>
              </div>
            </div>

            {/* Expanded: settings + rules */}
            {isExpanded && (
              <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${color}15` }}>

                {/* Category settings row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px', gap: 12, marginTop: 12, marginBottom: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Label</label>
                    <input
                      value={cat.label} onChange={e => updateCategory(ci, 'label', e.target.value)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Weight (%)</label>
                    <input
                      type="number" min={0} max={100} value={cat.weight}
                      onChange={e => updateCategory(ci, 'weight', parseInt(e.target.value) || 0)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'center' }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Baseline Score</label>
                    <input
                      type="number" min={0} max={100} value={cat.baseline_score ?? 50}
                      onChange={e => updateCategory(ci, 'baseline_score', parseInt(e.target.value) || 0)}
                      style={{ width: '100%', padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'center' }}
                    />
                  </div>
                </div>

                {/* Rules header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>Scoring Rules</span>
                  <button onClick={() => addRule(ci)}
                    style={{ padding: '3px 10px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: color + '10', color, border: `1px solid ${color}30`, cursor: 'pointer' }}>
                    + Add Rule
                  </button>
                </div>

                {/* Rules table */}
                {(cat.rules || []).length === 0 && (
                  <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 11, fontStyle: 'italic', background: '#fafafa', borderRadius: 6 }}>
                    No rules yet. Add a rule to start scoring this category.
                  </div>
                )}

                {(cat.rules || []).map((rule, ri) => {
                  const validMatchTypes = getMatchTypesFor(rule.field);
                  const needsTargetValues = !['exists'].includes(rule.match_type);
                  const isSingleValue = ['greater_than', 'less_than'].includes(rule.match_type);

                  return (
                    <div key={ri} style={{ padding: 10, marginBottom: 6, borderRadius: 6, background: '#fafafa', border: '1px solid #f0f0f0' }}>
                      {/* Row 1: Label + Field + Match Type + Delete */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 140px 28px', gap: 8, marginBottom: 6, alignItems: 'end' }}>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Label</label>
                          <input
                            value={rule.label || ''} onChange={e => updateRule(ci, ri, 'label', e.target.value)}
                            placeholder="Rule label"
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Field</label>
                          <select
                            value={rule.field} onChange={e => {
                              updateRule(ci, ri, 'field', e.target.value);
                              // Auto-fix match type if incompatible
                              const newFieldDef = getField(e.target.value);
                              const curMatch = rule.match_type;
                              const compatible = fieldDefs.matchTypes.filter(m => m.for_types.includes(newFieldDef?.type));
                              if (!compatible.find(m => m.key === curMatch)) {
                                updateRule(ci, ri, 'match_type', compatible[0]?.key || 'exists');
                              }
                            }}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, background: '#fff' }}
                          >
                            {Object.entries(groupedFields).map(([group, fields]) => (
                              <optgroup key={group} label={group}>
                                {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                              </optgroup>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Match</label>
                          <select
                            value={rule.match_type} onChange={e => updateRule(ci, ri, 'match_type', e.target.value)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, background: '#fff' }}
                          >
                            {validMatchTypes.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                          </select>
                        </div>
                        <button onClick={() => removeRule(ci, ri)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 13, padding: 4, alignSelf: 'end' }}>×</button>
                      </div>

                      {/* Row 2: Target Values + Points */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px', gap: 8, alignItems: 'end' }}>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>
                            {needsTargetValues ? (isSingleValue ? 'Threshold' : 'Target Values') : 'Match type needs no values'}
                          </label>
                          {needsTargetValues ? (
                            isSingleValue ? (
                              <input
                                type="number" value={rule.target_values?.[0] ?? ''} step="any"
                                onChange={e => updateRule(ci, ri, 'target_values', e.target.value !== '' ? [parseFloat(e.target.value)] : [])}
                                style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11 }}
                              />
                            ) : (
                              <TagInput
                                values={rule.target_values || []}
                                onChange={v => updateRule(ci, ri, 'target_values', v)}
                                placeholder="Type + Enter"
                                color={color}
                              />
                            )
                          ) : (
                            <span style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic' }}>—</span>
                          )}
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#059669', display: 'block', marginBottom: 2 }}>If match</label>
                          <input
                            type="number" value={rule.points_if_match ?? 0}
                            onChange={e => updateRule(ci, ri, 'points_if_match', parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, textAlign: 'center', color: (rule.points_if_match || 0) >= 0 ? '#059669' : '#dc2626' }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#dc2626', display: 'block', marginBottom: 2 }}>If no match</label>
                          <input
                            type="number" value={rule.points_if_no_match ?? 0}
                            onChange={e => updateRule(ci, ri, 'points_if_no_match', parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, textAlign: 'center', color: (rule.points_if_no_match || 0) >= 0 ? '#059669' : '#dc2626' }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 9, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 }}>If empty</label>
                          <input
                            type="number" value={rule.points_if_empty ?? 0}
                            onChange={e => updateRule(ci, ri, 'points_if_empty', parseInt(e.target.value) || 0)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #e5e7eb', borderRadius: 3, fontSize: 11, textAlign: 'center', color: (rule.points_if_empty || 0) >= 0 ? '#059669' : '#dc2626' }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Add category button */}
      <button onClick={addCategory}
        style={{ width: '100%', padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 600, background: '#fafafa', border: '2px dashed #d1d5db', cursor: 'pointer', color: '#6b7280', marginBottom: 16 }}>
        + Add Category
      </button>

      {/* How scoring works */}
      <details style={{ padding: 14, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
        <summary style={{ fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
          How ICP scoring works
        </summary>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 10, lineHeight: 1.7 }}>
          Each prospect is scored across all <strong>enabled categories</strong>. Within a category, the score starts at the <strong>baseline</strong> and
          each rule adds or subtracts points based on whether the prospect's field matches the target values.
          Category scores are clamped to 0–100.
          <br /><br />
          The composite score (0–100) is the <strong>weighted average</strong> of all enabled category scores.
          Disabled categories are excluded from the calculation.
          <br /><br />
          <strong>Rule fields</strong> can be direct prospect columns (title, industry, location…) or
          derived values (response rate, days since created, account deal status) that are computed at scoring time.
          <br /><br />
          <strong>Match types:</strong> "Is any of" checks exact match against a list. "Contains text" checks substring match.
          "Greater/Less than" compares a numeric value against a threshold.
          "Has value / Is true" checks that a field is non-empty or truthy.
          "Has any tag" checks the prospect's tags array.
        </div>
      </details>
    </div>
  );
}
