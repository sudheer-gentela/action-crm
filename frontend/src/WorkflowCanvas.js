import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from './apiService';
import RuleBuilder from './RuleBuilder';

// ═══════════════════════════════════════════════════════════════════
// WorkflowCanvas.js
// Full workflow management UI for the ActionCRM Workflow Engine.
//
// Renders two panels side-by-side:
//   Left  — workflow list (create, toggle active, delete)
//   Right — step list for selected workflow + per-step rule management
//           + inline RuleBuilder for creating/editing rules
//
// Props:
//   scope     — 'org' | 'super'  (determines which apiService namespace to use)
//   entity    — pre-filter entity (optional); if omitted, shows entity selector
// ═══════════════════════════════════════════════════════════════════

const ENTITIES  = ['deal', 'contact', 'account'];
const TRIGGERS  = ['create', 'update', 'stage_change', 'audit'];
const STEP_TYPES = ['rule', 'branch', 'action'];
const EXEC_MODES = ['sync', 'async'];

const ENTITY_ICONS  = { deal: '🤝', contact: '👤', account: '🏢' };
const TRIGGER_LABELS = { create: 'On Create', update: 'On Update', stage_change: 'Stage Change', audit: 'Audit' };
const STEP_TYPE_META = {
  rule:   { icon: '✅', color: '#059669', label: 'Rule'   },
  branch: { icon: '🔀', color: '#d97706', label: 'Branch' },
  action: { icon: '⚡', color: '#6366f1', label: 'Action' },
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ active, locked }) {
  if (locked) return <span style={badge('#9ca3af','#f9fafb')}>🔒 Platform</span>;
  return active
    ? <span style={badge('#059669','#f0fdf4')}>Active</span>
    : <span style={badge('#9ca3af','#f3f4f6')}>Inactive</span>;
}

function badge(color, bg) {
  return { fontSize: 11, fontWeight: 700, color, background: bg, borderRadius: 5, padding: '2px 7px' };
}

// ─── Workflow list item ────────────────────────────────────────────────────────

function WorkflowItem({ wf, isSelected, onSelect, onToggle, onDelete, canEdit }) {
  return (
    <div
      style={{
        ...wfStyles.wfItem,
        ...(isSelected ? wfStyles.wfItemSelected : {}),
      }}
      onClick={() => onSelect(wf)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 18 }}>{ENTITY_ICONS[wf.entity] || '📋'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {wf.name}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {TRIGGER_LABELS[wf.trigger] || wf.trigger} · {wf.entity}
          </div>
        </div>
        <StatusBadge active={wf.is_active} locked={wf.is_locked} />
      </div>

      {isSelected && canEdit && !wf.is_locked && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={e => e.stopPropagation()}>
          <button
            style={{ ...wfStyles.smallBtn, color: wf.is_active ? '#9ca3af' : '#059669' }}
            onClick={() => onToggle(wf)}
          >
            {wf.is_active ? 'Deactivate' : 'Activate'}
          </button>
          <button
            style={{ ...wfStyles.smallBtn, color: '#dc2626' }}
            onClick={() => onDelete(wf)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ─── New workflow form ─────────────────────────────────────────────────────────

function NewWorkflowForm({ scope, onCreated, onCancel }) {
  const [form, setForm]   = useState({ name: '', entity: 'deal', trigger: 'create', description: '' });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true); setError('');
    try {
      await api.createWorkflow({ ...form, name: form.name.trim() });
      onCreated();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to create workflow');
    } finally { setSaving(false); }
  };

  return (
    <div style={wfStyles.newForm}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 12 }}>New Workflow</div>
      {error && <div style={wfStyles.errLine}>{error}</div>}

      <input
        autoFocus
        style={wfStyles.input}
        placeholder="Workflow name *"
        value={form.name}
        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <select style={wfStyles.select} value={form.entity} onChange={e => setForm(f => ({ ...f, entity: e.target.value }))}>
          {ENTITIES.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <select style={wfStyles.select} value={form.trigger} onChange={e => setForm(f => ({ ...f, trigger: e.target.value }))}>
          {TRIGGERS.map(t => <option key={t} value={t}>{TRIGGER_LABELS[t]}</option>)}
        </select>
      </div>
      <input
        style={{ ...wfStyles.input, marginTop: 8 }}
        placeholder="Description (optional)"
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button style={wfStyles.saveBtn} onClick={handleCreate} disabled={saving}>
          {saving ? 'Creating…' : 'Create'}
        </button>
        <button style={wfStyles.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function StepRow({ step, wf, scope, onUpdated, onDeleted }) {
  const [expanded, setExpanded]         = useState(false);
  const [rules,    setRules]            = useState([]);
  const [rulesLoaded, setRulesLoaded]   = useState(false);
  const [addingRule, setAddingRule]     = useState(false);
  const [editingRule, setEditingRule]   = useState(null);
  const [error, setError]               = useState('');
  const [deleting, setDeleting]         = useState(false);

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;

  const loadRules = useCallback(async () => {
    // Rules for a step are embedded in the step's step_rules property OR
    // loaded via the rules endpoint filtered by step_id.
    // Since the GET /workflows/:id/steps endpoint returns step rows,
    // we use the standalone rules endpoint with a step_id param.
    try {
      const r = await api.getRules({ step_id: step.id });
      setRules(r.data.rules || []);
      setRulesLoaded(true);
    } catch (e) {
      setError('Failed to load rules for this step');
    }
  }, [step.id, api]);

  const handleExpand = () => {
    setExpanded(e => {
      if (!e && !rulesLoaded) loadRules();
      return !e;
    });
  };

  const handleDeleteStep = async () => {
    if (!window.confirm(`Delete step "${step.name}"? Rules attached to this step will also be deleted.`)) return;
    setDeleting(true);
    try {
      await api.deleteWorkflowStep(wf.id, step.id);
      onDeleted(step.id);
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to delete step');
    } finally { setDeleting(false); }
  };

  const handleSaveRule = async (rulePayload) => {
    try {
      const payload = { ...rulePayload, entity: wf.entity, trigger: wf.trigger, step_id: step.id };
      if (editingRule && editingRule !== 'new') {
        await api.updateRule(editingRule.id, payload);
      } else {
        await api.createRule(payload);
      }
      setAddingRule(false);
      setEditingRule(null);
      loadRules();
    } catch (e) {
      throw e; // Let RuleBuilder catch and display
    }
  };

  const handleDeleteRule = async (ruleId) => {
    if (!window.confirm('Delete this rule?')) return;
    try {
      await api.deleteRule(ruleId);
      loadRules();
    } catch (e) {
      setError('Failed to delete rule');
    }
  };

  const meta = STEP_TYPE_META[step.step_type] || STEP_TYPE_META.rule;

  return (
    <div style={wfStyles.stepCard}>
      {/* Step header */}
      <div style={wfStyles.stepHeader} onClick={handleExpand}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ ...wfStyles.stepTypeChip, background: meta.color + '18', color: meta.color }}>
            {meta.icon} {meta.label}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{step.name}</div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>
              #{step.sort_order} · {step.exec_mode}
              {step.depends_on?.length > 0 && ` · depends on: [${step.depends_on.join(', ')}]`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!wf.is_locked && (
            <button
              style={{ ...wfStyles.smallBtn, color: '#dc2626' }}
              onClick={e => { e.stopPropagation(); handleDeleteStep(); }}
              disabled={deleting}
            >
              {deleting ? '…' : 'Delete step'}
            </button>
          )}
          <span style={{ fontSize: 14, color: '#9ca3af' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {error && <div style={wfStyles.errLine}>{error}</div>}

      {/* Expanded: rules for this step */}
      {expanded && (
        <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12, marginTop: 4 }}>
          {!rulesLoaded ? (
            <div style={{ fontSize: 12, color: '#9ca3af', padding: '4px 0' }}>Loading rules…</div>
          ) : (
            <>
              {/* Inline RuleBuilder */}
              {(addingRule || editingRule) && (
                <div style={{ marginBottom: 16 }}>
                  <RuleBuilder
                    entity={wf.entity}
                    initialRule={editingRule && editingRule !== 'new' ? editingRule : null}
                    onSave={handleSaveRule}
                    onCancel={() => { setAddingRule(false); setEditingRule(null); }}
                    isLocked={false}
                    scopeLabel={scope === 'super' ? 'Platform rule' : 'Org rule'}
                  />
                </div>
              )}

              {/* Rule list */}
              {rules.length === 0 && !addingRule && !editingRule && (
                <div style={{ fontSize: 12, color: '#9ca3af', padding: '4px 0 8px' }}>
                  No rules attached to this step.
                </div>
              )}
              {rules.map(rule => (
                <div key={rule.id} style={wfStyles.ruleRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>{rule.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                      {rule.rule_type} ·{' '}
                      <span style={{ color: rule.severity === 'block' ? '#dc2626' : '#d97706', fontWeight: 600 }}>
                        {rule.severity}
                      </span>
                      {rule.is_locked && ' · 🔒 locked'}
                    </div>
                  </div>
                  {!rule.is_locked && !wf.is_locked && (
                    <div style={{ display: 'flex', gap: 5 }}>
                      <button style={wfStyles.smallBtn} onClick={() => { setEditingRule(rule); setAddingRule(false); }}>Edit</button>
                      <button style={{ ...wfStyles.smallBtn, color: '#dc2626' }} onClick={() => handleDeleteRule(rule.id)}>Delete</button>
                    </div>
                  )}
                  {(rule.is_locked || wf.is_locked) && (
                    <button style={wfStyles.smallBtn} onClick={() => { setEditingRule(rule); setAddingRule(false); }}>View</button>
                  )}
                </div>
              ))}

              {!addingRule && !editingRule && !wf.is_locked && (
                <button
                  style={wfStyles.addRuleBtn}
                  onClick={() => { setAddingRule(true); setEditingRule(null); }}
                >
                  + Add rule to step
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── New step form ─────────────────────────────────────────────────────────────

function NewStepForm({ wf, scope, onCreated, onCancel }) {
  const [form, setForm]   = useState({ name: '', step_type: 'rule', exec_mode: 'sync', sort_order: 0 });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Step name is required'); return; }
    setSaving(true); setError('');
    try {
      await api.createWorkflowStep(wf.id, { ...form, name: form.name.trim(), sort_order: parseInt(form.sort_order) || 0 });
      onCreated();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to create step');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ ...wfStyles.newForm, marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10 }}>New Step</div>
      {error && <div style={wfStyles.errLine}>{error}</div>}
      <input
        autoFocus
        style={wfStyles.input}
        placeholder="Step name *"
        value={form.name}
        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: 8, marginTop: 8 }}>
        <select style={wfStyles.select} value={form.step_type} onChange={e => setForm(f => ({ ...f, step_type: e.target.value }))}>
          {STEP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select style={wfStyles.select} value={form.exec_mode} onChange={e => setForm(f => ({ ...f, exec_mode: e.target.value }))}>
          {EXEC_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          type="number"
          style={wfStyles.input}
          placeholder="Order"
          value={form.sort_order}
          onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={wfStyles.saveBtn} onClick={handleCreate} disabled={saving}>{saving ? 'Adding…' : 'Add Step'}</button>
        <button style={wfStyles.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Standalone rules panel (step_id IS NULL) ─────────────────────────────────

function StandaloneRulesPanel({ entity, scope, triggerFilter }) {
  const [rules,      setRules]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [adding,     setAdding]     = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [error,      setError]      = useState('');

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { entity };
      if (triggerFilter) params.trigger = triggerFilter;
      const r = await api.getRules(params);
      // Show only standalone rules (step_id IS NULL) in this panel
      setRules((r.data.rules || []).filter(r => !r.step_id));
    } catch { setError('Failed to load rules'); }
    finally { setLoading(false); }
  }, [entity, triggerFilter, api]);

  useEffect(() => { load(); }, [load]);

  const handleSaveRule = async (payload) => {
    try {
      if (editing && editing !== 'new') {
        await api.updateRule(editing.id, { ...payload, entity });
      } else {
        await api.createRule({ ...payload, entity });
      }
      setAdding(false); setEditing(null);
      load();
    } catch (e) {
      throw e;
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this rule?')) return;
    try { await api.deleteRule(id); load(); }
    catch { setError('Failed to delete rule'); }
  };

  if (loading) return <div style={{ fontSize: 12, color: '#9ca3af', padding: 8 }}>Loading standalone rules…</div>;

  return (
    <div>
      {error && <div style={wfStyles.errLine}>{error}</div>}

      {(adding || editing) && (
        <div style={{ marginBottom: 16 }}>
          <RuleBuilder
            entity={entity}
            initialRule={editing && editing !== 'new' ? editing : null}
            onSave={handleSaveRule}
            onCancel={() => { setAdding(false); setEditing(null); }}
            isLocked={false}
            scopeLabel={scope === 'super' ? 'Platform rule' : 'Org rule'}
          />
        </div>
      )}

      {rules.length === 0 && !adding && !editing && (
        <div style={{ fontSize: 12, color: '#9ca3af', padding: '6px 0 8px' }}>
          No standalone rules for {entity}s.
        </div>
      )}
      {rules.map(rule => (
        <div key={rule.id} style={wfStyles.ruleRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{rule.name}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
              {rule.rule_type} · {TRIGGER_LABELS[rule.trigger] || rule.trigger} ·{' '}
              <span style={{ color: rule.severity === 'block' ? '#dc2626' : '#d97706', fontWeight: 600 }}>
                {rule.severity}
              </span>
              {rule.is_locked && ' · 🔒 platform'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
            <button style={wfStyles.smallBtn} onClick={() => { setEditing(rule); setAdding(false); }}>
              {rule.is_locked ? 'View' : 'Edit'}
            </button>
            {!rule.is_locked && (
              <button style={{ ...wfStyles.smallBtn, color: '#dc2626' }} onClick={() => handleDelete(rule.id)}>Delete</button>
            )}
          </div>
        </div>
      ))}

      {!adding && !editing && (
        <button style={wfStyles.addRuleBtn} onClick={() => { setAdding(true); setEditing(null); }}>
          + New standalone rule
        </button>
      )}
    </div>
  );
}

// ─── Right panel: workflow detail ─────────────────────────────────────────────

function WorkflowDetail({ wf, scope, onRefreshList }) {
  const [steps,      setSteps]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [addingStep, setAddingStep] = useState(false);
  const [error,      setError]      = useState('');

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;

  const loadSteps = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getWorkflowSteps(wf.id);
      setSteps((r.data.steps || []).sort((a, b) => a.sort_order - b.sort_order));
    } catch { setError('Failed to load steps'); }
    finally { setLoading(false); }
  }, [wf.id, api]);

  useEffect(() => { loadSteps(); }, [loadSteps]);

  const handleStepDeleted = (stepId) => {
    setSteps(s => s.filter(x => x.id !== stepId));
  };

  return (
    <div style={wfStyles.detailPanel}>
      {/* Workflow header */}
      <div style={wfStyles.detailHeader}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 22 }}>{ENTITY_ICONS[wf.entity] || '📋'}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{wf.name}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                {wf.entity} · {TRIGGER_LABELS[wf.trigger] || wf.trigger} · {wf.scope}
              </div>
            </div>
          </div>
          {wf.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{wf.description}</div>}
        </div>
        <StatusBadge active={wf.is_active} locked={wf.is_locked} />
      </div>

      {error && <div style={wfStyles.errLine}>{error}</div>}

      {/* Steps */}
      <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '16px 0 10px' }}>
        Steps
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading steps…</div>
      ) : (
        <>
          {steps.length === 0 && !addingStep && (
            <div style={{ fontSize: 12, color: '#9ca3af', padding: '4px 0 8px' }}>
              No steps yet. Add a step to start building this workflow.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map(step => (
              <StepRow
                key={step.id}
                step={step}
                wf={wf}
                scope={scope}
                onUpdated={loadSteps}
                onDeleted={handleStepDeleted}
              />
            ))}
          </div>

          {addingStep ? (
            <NewStepForm
              wf={wf}
              scope={scope}
              onCreated={() => { setAddingStep(false); loadSteps(); }}
              onCancel={() => setAddingStep(false)}
            />
          ) : (
            !wf.is_locked && (
              <button style={{ ...wfStyles.addRuleBtn, marginTop: 10 }} onClick={() => setAddingStep(true)}>
                + Add step
              </button>
            )
          )}
        </>
      )}
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────

export default function WorkflowCanvas({ scope = 'org', entity: defaultEntity }) {
  const [workflows,    setWorkflows]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [selected,     setSelected]     = useState(null);  // selected workflow
  const [creating,     setCreating]     = useState(false);
  const [entityFilter, setEntityFilter] = useState(defaultEntity || 'deal');
  const [viewMode,     setViewMode]     = useState('workflows'); // 'workflows' | 'standalone'
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState('');

  const api = scope === 'super' ? apiService.superAdmin : apiService.orgAdmin;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getWorkflows();
      const all = r.data.workflows || [];
      // Filter by entity if provided
      setWorkflows(defaultEntity ? all.filter(w => w.entity === defaultEntity) : all);
    } catch { setError('Failed to load workflows'); }
    finally { setLoading(false); }
  }, [api, defaultEntity]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (wf) => {
    try {
      await api.updateWorkflow(wf.id, { is_active: !wf.is_active });
      setSuccess(`${wf.name} ${wf.is_active ? 'deactivated' : 'activated'}`);
      setTimeout(() => setSuccess(''), 2000);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to update workflow');
    }
  };

  const handleDelete = async (wf) => {
    if (!window.confirm(`Delete workflow "${wf.name}"? All steps and rules will be deleted.`)) return;
    try {
      await api.deleteWorkflow(wf.id);
      if (selected?.id === wf.id) setSelected(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Failed to delete workflow');
    }
  };

  // Filter workflows by entity
  const filteredWfs = workflows.filter(w => !entityFilter || w.entity === entityFilter);

  return (
    <div style={wfStyles.canvas}>
      {/* ── Toolbar ── */}
      <div style={wfStyles.toolbar}>
        {/* View mode toggle */}
        <div style={wfStyles.modeToggle}>
          {['workflows', 'standalone'].map(mode => (
            <button
              key={mode}
              style={{ ...wfStyles.modeBtn, ...(viewMode === mode ? wfStyles.modeBtnActive : {}) }}
              onClick={() => { setViewMode(mode); setSelected(null); }}
            >
              {mode === 'workflows' ? '🔗 Workflows' : '📋 Standalone Rules'}
            </button>
          ))}
        </div>

        {/* Entity filter (only if no defaultEntity) */}
        {!defaultEntity && (
          <div style={{ display: 'flex', gap: 4 }}>
            {ENTITIES.map(e => (
              <button
                key={e}
                style={{ ...wfStyles.entityBtn, ...(entityFilter === e ? wfStyles.entityBtnActive : {}) }}
                onClick={() => setEntityFilter(e)}
              >
                {ENTITY_ICONS[e]} {e}
              </button>
            ))}
          </div>
        )}

        {viewMode === 'workflows' && (
          <button style={wfStyles.newWfBtn} onClick={() => setCreating(true)}>
            + New Workflow
          </button>
        )}
      </div>

      {error   && <div style={{ ...wfStyles.errLine, marginBottom: 12 }}>⚠️ {error}<button style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setError('')}>✕</button></div>}
      {success && <div style={{ ...wfStyles.successLine, marginBottom: 12 }}>✅ {success}</div>}

      {viewMode === 'standalone' ? (
        /* ── Standalone rules view ── */
        <div style={wfStyles.standaloneWrap}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
            Standalone rules run on every entity write independently of any workflow. They are evaluated before workflow-attached rules.
          </div>
          <StandaloneRulesPanel
            entity={entityFilter}
            scope={scope}
          />
        </div>
      ) : (
        /* ── Workflow split view ── */
        <div style={wfStyles.splitView}>
          {/* Left: list */}
          <div style={wfStyles.leftPanel}>
            {creating && (
              <NewWorkflowForm
                scope={scope}
                onCreated={() => { setCreating(false); load(); }}
                onCancel={() => setCreating(false)}
              />
            )}

            {loading ? (
              <div style={{ fontSize: 12, color: '#9ca3af', padding: 8 }}>Loading…</div>
            ) : filteredWfs.length === 0 ? (
              <div style={wfStyles.emptyList}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🔗</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>No workflows</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                  Create a workflow to group rules into sequential steps.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {filteredWfs.map(wf => (
                  <WorkflowItem
                    key={wf.id}
                    wf={wf}
                    isSelected={selected?.id === wf.id}
                    onSelect={setSelected}
                    onToggle={handleToggle}
                    onDelete={handleDelete}
                    canEdit={scope === 'super' || !wf.is_locked}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Right: detail */}
          <div style={wfStyles.rightPanel}>
            {selected ? (
              <WorkflowDetail
                wf={selected}
                scope={scope}
                onRefreshList={load}
              />
            ) : (
              <div style={wfStyles.emptyDetail}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>↖</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>Select a workflow</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                  Click a workflow on the left to view and edit its steps and rules.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const wfStyles = {
  canvas: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    height: '100%',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  modeToggle: {
    display: 'flex',
    gap: 4,
    background: '#f3f4f6',
    borderRadius: 8,
    padding: 3,
  },
  modeBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    fontSize: 12,
    fontWeight: 600,
    color: '#6b7280',
    cursor: 'pointer',
  },
  modeBtnActive: {
    background: '#fff',
    color: '#111827',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  entityBtn: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 12,
    color: '#6b7280',
    cursor: 'pointer',
  },
  entityBtnActive: {
    background: '#eef2ff',
    borderColor: '#6366f1',
    color: '#6366f1',
    fontWeight: 600,
  },
  newWfBtn: {
    marginLeft: 'auto',
    padding: '6px 16px',
    borderRadius: 7,
    border: 'none',
    background: '#6366f1',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  splitView: {
    display: 'grid',
    gridTemplateColumns: '280px 1fr',
    gap: 16,
    minHeight: 400,
  },
  leftPanel: {
    background: '#f8fafc',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: 12,
    overflowY: 'auto',
    maxHeight: 680,
  },
  rightPanel: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    overflowY: 'auto',
    maxHeight: 680,
  },
  emptyList: {
    padding: 24,
    textAlign: 'center',
    color: '#9ca3af',
  },
  emptyDetail: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#9ca3af',
    padding: 40,
    textAlign: 'center',
  },
  standaloneWrap: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: 20,
  },
  // Workflow list item
  wfItem: {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid transparent',
    cursor: 'pointer',
    transition: 'background 0.12s',
  },
  wfItemSelected: {
    background: '#eef2ff',
    border: '1px solid #c7d2fe',
  },
  // Step card
  stepCard: {
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 9,
    padding: '12px 14px',
  },
  stepHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
  },
  stepTypeChip: {
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 5,
    padding: '2px 7px',
    flexShrink: 0,
  },
  // Rule row
  ruleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: '#fff',
    border: '1px solid #f3f4f6',
    borderRadius: 7,
    marginBottom: 5,
  },
  addRuleBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px dashed #c7d2fe',
    background: '#fff',
    fontSize: 12,
    color: '#6366f1',
    cursor: 'pointer',
    marginTop: 6,
  },
  // Detail panel
  detailPanel: {
    padding: 20,
  },
  detailHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingBottom: 16,
    borderBottom: '1px solid #f3f4f6',
  },
  // Forms
  newForm: {
    background: '#f8fafc',
    border: '1px solid #c7d2fe',
    borderRadius: 9,
    padding: '14px 16px',
    marginBottom: 12,
  },
  input: {
    padding: '7px 10px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 12,
    width: '100%',
    boxSizing: 'border-box',
  },
  select: {
    padding: '7px 8px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 12,
    width: '100%',
    background: '#fff',
  },
  saveBtn: {
    padding: '6px 16px',
    borderRadius: 7,
    border: 'none',
    background: '#6366f1',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '6px 12px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    background: '#fff',
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
  },
  smallBtn: {
    padding: '3px 9px',
    borderRadius: 5,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 11,
    color: '#374151',
    cursor: 'pointer',
    flexShrink: 0,
  },
  errLine: {
    fontSize: 12,
    color: '#dc2626',
    background: '#fef2f2',
    borderRadius: 6,
    padding: '5px 10px',
    marginBottom: 8,
  },
  successLine: {
    fontSize: 12,
    color: '#059669',
    background: '#f0fdf4',
    borderRadius: 6,
    padding: '5px 10px',
  },
};
