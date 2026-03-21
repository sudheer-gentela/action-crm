import React, { useState, useCallback } from 'react';

// ═══════════════════════════════════════════════════════════════════
// RuleBuilder.js
// Standalone rule authoring component for the ActionCRM Workflow Engine.
// Builds the conditions JSONB tree and action JSONB that workflow_rules stores.
//
// Props:
//   entity       — 'deal' | 'contact' | 'account'
//   initialRule  — existing workflow_rules row (optional, for edit mode)
//   onSave       — (rulePayload) => void
//   onCancel     — () => void
//   isLocked     — bool (platform rule — read-only mode)
//   scopeLabel   — 'Platform rule' | 'Org rule' (display only)
// ═══════════════════════════════════════════════════════════════════

// ─── Field registry (mirrors ruleEvaluator.service.js FIELD_REGISTRY) ──────────

const FIELD_REGISTRY = {
  deal: [
    { key: 'name',               label: 'Name',               type: 'string' },
    { key: 'value',              label: 'Value',              type: 'number' },
    { key: 'stage',              label: 'Stage',              type: 'string' },
    { key: 'stage_type',         label: 'Stage Type',         type: 'string' },
    { key: 'health',             label: 'Health',             type: 'string' },
    { key: 'expected_close_date',label: 'Expected Close Date',type: 'date'   },
    { key: 'close_date',         label: 'Close Date',         type: 'date'   },
    { key: 'probability',        label: 'Probability',        type: 'number' },
    { key: 'owner_id',           label: 'Owner',              type: 'integer'},
    { key: 'account_id',         label: 'Account',            type: 'integer'},
    { key: 'playbook_id',        label: 'Playbook',           type: 'integer'},
  ],
  contact: [
    { key: 'first_name',         label: 'First Name',         type: 'string' },
    { key: 'last_name',          label: 'Last Name',          type: 'string' },
    { key: 'email',              label: 'Email',              type: 'string' },
    { key: 'phone',              label: 'Phone',              type: 'string' },
    { key: 'title',              label: 'Title',              type: 'string' },
    { key: 'role_type',          label: 'Role Type',          type: 'string' },
    { key: 'engagement_level',   label: 'Engagement Level',   type: 'string' },
    { key: 'account_id',         label: 'Account',            type: 'integer'},
    { key: 'owner_id',           label: 'Owner (user_id)',    type: 'integer'},
  ],
  account: [
    { key: 'name',               label: 'Name',               type: 'string' },
    { key: 'domain',             label: 'Domain',             type: 'string' },
    { key: 'industry',           label: 'Industry',           type: 'string' },
    { key: 'size',               label: 'Size',               type: 'string' },
    { key: 'owner_id',           label: 'Owner',              type: 'integer'},
    { key: 'account_disposition',label: 'Disposition',        type: 'string' },
    { key: 'sla_tier_id',        label: 'SLA Tier',           type: 'integer'},
  ],
};

// Operators available per field type
const OPERATORS_BY_TYPE = {
  string: [
    { op: 'is_empty',          label: 'is empty',          unary: true  },
    { op: 'is_not_empty',      label: 'is not empty',      unary: true  },
    { op: 'equals',            label: 'equals'                          },
    { op: 'not_equals',        label: 'does not equal'                  },
    { op: 'contains',          label: 'contains'                        },
    { op: 'not_contains',      label: 'does not contain'                },
    { op: 'in_list',           label: 'is one of',         list: true   },
    { op: 'not_in_list',       label: 'is not one of',     list: true   },
    { op: 'changed_to',        label: 'changes to'                      },
    { op: 'changed_from',      label: 'changes from'                    },
    { op: 'regex_match',       label: 'matches regex'                   },
  ],
  number: [
    { op: 'is_empty',          label: 'is empty',          unary: true  },
    { op: 'is_not_empty',      label: 'is not empty',      unary: true  },
    { op: 'equals',            label: 'equals'                          },
    { op: 'not_equals',        label: 'does not equal'                  },
    { op: 'gt',                label: 'greater than'                    },
    { op: 'gte',               label: 'greater than or equal'           },
    { op: 'lt',                label: 'less than'                       },
    { op: 'lte',               label: 'less than or equal'              },
  ],
  date: [
    { op: 'is_empty',          label: 'is empty',          unary: true  },
    { op: 'is_not_empty',      label: 'is not empty',      unary: true  },
    { op: 'equals',            label: 'equals (date)'                   },
    { op: 'gt',                label: 'is after'                        },
    { op: 'lt',                label: 'is before'                       },
    { op: 'gte',               label: 'is on or after'                  },
    { op: 'lte',               label: 'is on or before'                 },
    { op: 'changed_to',        label: 'changes to'                      },
  ],
  integer: [
    { op: 'is_empty',               label: 'is empty (not set)',          unary: true  },
    { op: 'is_not_empty',           label: 'is set',                      unary: true  },
    { op: 'equals',                 label: 'equals (ID)'                               },
    { op: 'not_equals',             label: 'does not equal (ID)'                       },
    { op: 'is_relationship_empty',  label: 'relationship is empty',       unary: true  },
  ],
};

// Rule type metadata
const RULE_TYPES = [
  { value: 'required_field',       label: 'Required Field',        desc: 'Field must not be empty' },
  { value: 'conditional_required', label: 'Conditional Required',  desc: 'Field required when conditions are met' },
  { value: 'stage_gate',           label: 'Stage Gate',            desc: 'Block stage advance unless conditions pass' },
  { value: 'auto_set',             label: 'Auto Set',              desc: 'Automatically set a field value' },
  { value: 'transform',            label: 'Transform',             desc: 'Normalise a field value' },
  { value: 'audit',                label: 'Audit',                 desc: 'Flag record in nightly audit scan' },
];

const TRIGGERS = [
  { value: 'create',        label: 'On Create'        },
  { value: 'update',        label: 'On Update'        },
  { value: 'stage_change',  label: 'On Stage Change'  },
  { value: 'audit',         label: 'Nightly Audit'    },
];

const SEVERITIES = [
  { value: 'block', label: 'Block (rejects write)',    color: '#dc2626' },
  { value: 'warn',  label: 'Warn (allows with notice)',color: '#d97706' },
];

const TRANSFORM_FNS = [
  { value: 'title_case',      label: 'Title Case'      },
  { value: 'upper_case',      label: 'UPPER CASE'      },
  { value: 'lower_case',      label: 'lower case'      },
  { value: 'trim',            label: 'Trim whitespace' },
  { value: 'trim_whitespace', label: 'Trim all spaces' },
];

const STAGE_OPTIONS = ['proposal', 'negotiation', 'demo', 'qualified', 'closed_won', 'closed_lost'];

// ─── Utility helpers ───────────────────────────────────────────────────────────

function newLeaf() {
  return { field: '', op: 'is_empty', value: null };
}

function newGroup() {
  return { operator: 'AND', conditions: [newLeaf()] };
}

function newConditionsTree() {
  return { operator: 'AND', groups: [newGroup()] };
}

function getOpsForField(entity, fieldKey) {
  const fields = FIELD_REGISTRY[entity] || [];
  const field  = fields.find(f => f.key === fieldKey);
  if (!field) return OPERATORS_BY_TYPE.string;
  return OPERATORS_BY_TYPE[field.type] || OPERATORS_BY_TYPE.string;
}

function isUnary(entity, fieldKey, op) {
  const ops = getOpsForField(entity, fieldKey);
  return ops.find(o => o.op === op)?.unary === true;
}

function isList(entity, fieldKey, op) {
  const ops = getOpsForField(entity, fieldKey);
  return ops.find(o => o.op === op)?.list === true;
}

function getFieldType(entity, fieldKey) {
  const fields = FIELD_REGISTRY[entity] || [];
  return fields.find(f => f.key === fieldKey)?.type || 'string';
}

// ─── Leaf condition row ────────────────────────────────────────────────────────

function LeafConditionRow({ entity, condition, onChange, onRemove, canRemove }) {
  const fields  = FIELD_REGISTRY[entity] || [];
  const ops     = getOpsForField(entity, condition.field);
  const unary   = isUnary(entity, condition.field, condition.op);
  const list    = isList(entity, condition.field, condition.op);
  const ftype   = getFieldType(entity, condition.field);

  const handleFieldChange = (field) => {
    const newOps    = getOpsForField(entity, field);
    const firstOp  = newOps[0]?.op || 'is_empty';
    onChange({ field, op: firstOp, value: null });
  };

  const handleOpChange = (op) => {
    onChange({ ...condition, op, value: null });
  };

  const handleValueChange = (val) => {
    onChange({ ...condition, value: val });
  };

  return (
    <div style={styles.leafRow}>
      {/* Field picker */}
      <select
        style={styles.leafSelect}
        value={condition.field}
        onChange={e => handleFieldChange(e.target.value)}
      >
        <option value="">— field —</option>
        {fields.map(f => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>

      {/* Operator picker */}
      <select
        style={styles.leafSelectMed}
        value={condition.op}
        onChange={e => handleOpChange(e.target.value)}
        disabled={!condition.field}
      >
        {ops.map(o => (
          <option key={o.op} value={o.op}>{o.label}</option>
        ))}
      </select>

      {/* Value input — hidden for unary ops */}
      {!unary && (
        list ? (
          <input
            style={styles.leafInput}
            placeholder="value1, value2, …"
            value={Array.isArray(condition.value) ? condition.value.join(', ') : (condition.value || '')}
            onChange={e => handleValueChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          />
        ) : ftype === 'date' ? (
          <input
            type="date"
            style={styles.leafInput}
            value={condition.value || ''}
            onChange={e => handleValueChange(e.target.value || null)}
          />
        ) : ftype === 'number' ? (
          <input
            type="number"
            style={styles.leafInput}
            placeholder="value"
            value={condition.value ?? ''}
            onChange={e => handleValueChange(e.target.value === '' ? null : parseFloat(e.target.value))}
          />
        ) : (
          <input
            style={styles.leafInput}
            placeholder="value"
            value={condition.value ?? ''}
            onChange={e => handleValueChange(e.target.value || null)}
          />
        )
      )}
      {unary && <div style={{ flex: 1 }} />}

      {canRemove && (
        <button style={styles.iconBtn} onClick={onRemove} title="Remove condition">✕</button>
      )}
    </div>
  );
}

// ─── Group (AND/OR group of leaf conditions) ───────────────────────────────────

function ConditionGroup({ entity, group, onChange, onRemove, canRemove }) {
  const updateOp = (op) => onChange({ ...group, operator: op });

  const updateLeaf = (idx, updated) => {
    const conditions = group.conditions.map((c, i) => i === idx ? updated : c);
    onChange({ ...group, conditions });
  };

  const removeLeaf = (idx) => {
    const conditions = group.conditions.filter((_, i) => i !== idx);
    onChange({ ...group, conditions });
  };

  const addLeaf = () => {
    onChange({ ...group, conditions: [...group.conditions, newLeaf()] });
  };

  return (
    <div style={styles.groupBox}>
      <div style={styles.groupHeader}>
        <div style={styles.groupOpRow}>
          {['AND', 'OR'].map(op => (
            <button
              key={op}
              style={{ ...styles.opToggle, ...(group.operator === op ? styles.opToggleActive : {}) }}
              onClick={() => updateOp(op)}
            >
              {op}
            </button>
          ))}
          <span style={styles.groupHint}>all conditions in this group must match</span>
        </div>
        {canRemove && (
          <button style={styles.iconBtnSm} onClick={onRemove} title="Remove group">Remove group</button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {group.conditions.map((cond, idx) => (
          <LeafConditionRow
            key={idx}
            entity={entity}
            condition={cond}
            onChange={updated => updateLeaf(idx, updated)}
            onRemove={() => removeLeaf(idx)}
            canRemove={group.conditions.length > 1}
          />
        ))}
      </div>

      <button style={styles.addConditionBtn} onClick={addLeaf}>
        + Add condition
      </button>
    </div>
  );
}

// ─── Conditions tree builder ───────────────────────────────────────────────────

function ConditionsBuilder({ entity, tree, onChange }) {
  const updateRootOp = (op) => onChange({ ...tree, operator: op });

  const updateGroup = (idx, updated) => {
    const groups = tree.groups.map((g, i) => i === idx ? updated : g);
    onChange({ ...tree, groups });
  };

  const removeGroup = (idx) => {
    const groups = tree.groups.filter((_, i) => i !== idx);
    onChange({ ...tree, groups });
  };

  const addGroup = () => {
    onChange({ ...tree, groups: [...tree.groups, newGroup()] });
  };

  return (
    <div style={styles.conditionsBuilder}>
      {/* Root AND/OR toggle — only shown when multiple groups */}
      {tree.groups.length > 1 && (
        <div style={styles.rootOpRow}>
          <span style={styles.sectionHint}>Groups combine with:</span>
          {['AND', 'OR'].map(op => (
            <button
              key={op}
              style={{ ...styles.opToggle, ...(tree.operator === op ? styles.opToggleActive : {}) }}
              onClick={() => updateRootOp(op)}
            >
              {op}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tree.groups.map((group, idx) => (
          <ConditionGroup
            key={idx}
            entity={entity}
            group={group}
            onChange={updated => updateGroup(idx, updated)}
            onRemove={() => removeGroup(idx)}
            canRemove={tree.groups.length > 1}
          />
        ))}
      </div>

      <button style={styles.addGroupBtn} onClick={addGroup}>
        + Add condition group
      </button>
    </div>
  );
}

// ─── Action builder — varies by rule_type ─────────────────────────────────────

function ActionBuilder({ entity, ruleType, action, onChange }) {
  const fields = FIELD_REGISTRY[entity] || [];

  if (ruleType === 'required_field' || ruleType === 'audit') {
    return (
      <div style={styles.actionBlock}>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Field *</label>
          <select
            style={styles.select}
            value={action.field || ''}
            onChange={e => onChange({ ...action, field: e.target.value })}
          >
            <option value="">— select field —</option>
            {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Error Message *</label>
          <input
            style={styles.input}
            placeholder={`e.g. ${ruleType === 'audit' ? 'Contact is missing an email address' : 'Close date is required'}`}
            value={action.message || ''}
            onChange={e => onChange({ ...action, message: e.target.value })}
          />
        </div>
      </div>
    );
  }

  if (ruleType === 'conditional_required') {
    return (
      <div style={styles.actionBlock}>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Required Field *</label>
          <select
            style={styles.select}
            value={action.field || ''}
            onChange={e => onChange({ ...action, field: e.target.value })}
          >
            <option value="">— select field —</option>
            {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Error Message *</label>
          <input
            style={styles.input}
            placeholder="e.g. Close date required when stage is Proposal"
            value={action.message || ''}
            onChange={e => onChange({ ...action, message: e.target.value })}
          />
        </div>
      </div>
    );
  }

  if (ruleType === 'stage_gate') {
    const blockedList = Array.isArray(action.blocked_stages) ? action.blocked_stages : [];
    return (
      <div style={styles.actionBlock}>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Blocked Stages *</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {STAGE_OPTIONS.map(s => (
              <label key={s} style={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={blockedList.includes(s)}
                  onChange={e => {
                    const next = e.target.checked
                      ? [...blockedList, s]
                      : blockedList.filter(x => x !== s);
                    onChange({ ...action, blocked_stages: next });
                  }}
                />
                {s}
              </label>
            ))}
          </div>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Error Message *</label>
          <input
            style={styles.input}
            placeholder="e.g. Deal value must be set before advancing"
            value={action.message || ''}
            onChange={e => onChange({ ...action, message: e.target.value })}
          />
        </div>
      </div>
    );
  }

  if (ruleType === 'auto_set') {
    const sourceType = action.value !== undefined ? 'literal' : action.value_from ? (action.value_from.startsWith('context.') ? 'context' : 'field_path') : 'literal';

    return (
      <div style={styles.actionBlock}>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Set Field *</label>
          <select
            style={styles.select}
            value={action.field || ''}
            onChange={e => onChange({ ...action, field: e.target.value })}
          >
            <option value="">— select field —</option>
            {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Value Source</label>
          <select
            style={styles.select}
            value={sourceType}
            onChange={e => {
              const type = e.target.value;
              if (type === 'literal')    onChange({ field: action.field, value: '' });
              if (type === 'context')    onChange({ field: action.field, value_from: 'context.userId' });
              if (type === 'field_path') onChange({ field: action.field, value_from: 'account.owner_id' });
            }}
          >
            <option value="literal">Literal value</option>
            <option value="context">From context (userId, orgId)</option>
            <option value="field_path">From related record (dot-path)</option>
          </select>
        </div>
        {sourceType === 'literal' && (
          <div style={styles.fieldRow}>
            <label style={styles.label}>Value *</label>
            <input
              style={styles.input}
              placeholder="e.g. 42 or open"
              value={action.value ?? ''}
              onChange={e => onChange({ ...action, value: e.target.value })}
            />
          </div>
        )}
        {sourceType === 'context' && (
          <div style={styles.fieldRow}>
            <label style={styles.label}>Context Path</label>
            <select
              style={styles.select}
              value={action.value_from || 'context.userId'}
              onChange={e => onChange({ ...action, value_from: e.target.value })}
            >
              <option value="context.userId">context.userId</option>
              <option value="context.orgId">context.orgId</option>
            </select>
          </div>
        )}
        {sourceType === 'field_path' && (
          <div style={styles.fieldRow}>
            <label style={styles.label}>Dot-path</label>
            <input
              style={styles.input}
              placeholder="e.g. account.owner_id"
              value={action.value_from || ''}
              onChange={e => onChange({ ...action, value_from: e.target.value })}
            />
          </div>
        )}
      </div>
    );
  }

  if (ruleType === 'transform') {
    return (
      <div style={styles.actionBlock}>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Field to Transform *</label>
          <select
            style={styles.select}
            value={action.field || ''}
            onChange={e => onChange({ ...action, field: e.target.value })}
          >
            <option value="">— select field —</option>
            {fields.filter(f => f.type === 'string').map(f => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Transform Function *</label>
          <select
            style={styles.select}
            value={action.fn || ''}
            onChange={e => onChange({ ...action, fn: e.target.value })}
          >
            <option value="">— select function —</option>
            {TRANSFORM_FNS.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>
      Select a rule type to configure the action.
    </div>
  );
}

// ─── Validation helper ─────────────────────────────────────────────────────────

function validateRule(rule) {
  const errors = [];
  if (!rule.name?.trim())        errors.push('Rule name is required');
  if (!rule.trigger)             errors.push('Trigger is required');
  if (!rule.rule_type)           errors.push('Rule type is required');

  const a = rule.action || {};
  if (['required_field', 'conditional_required', 'audit'].includes(rule.rule_type)) {
    if (!a.field)   errors.push('Action field is required');
    if (!a.message) errors.push('Error message is required');
  }
  if (rule.rule_type === 'stage_gate') {
    if (!a.blocked_stages?.length) errors.push('At least one blocked stage is required');
    if (!a.message)                 errors.push('Error message is required');
  }
  if (rule.rule_type === 'auto_set') {
    if (!a.field)                   errors.push('Field to set is required');
    if (a.value === undefined && !a.value_from) errors.push('Value source is required');
  }
  if (rule.rule_type === 'transform') {
    if (!a.field) errors.push('Field to transform is required');
    if (!a.fn)    errors.push('Transform function is required');
  }
  return errors;
}

// ─── Main export ───────────────────────────────────────────────────────────────

export default function RuleBuilder({
  entity        = 'deal',
  initialRule   = null,
  onSave,
  onCancel,
  isLocked      = false,
  scopeLabel    = 'Org rule',
}) {
  const defaultConditions = initialRule?.conditions || newConditionsTree();
  const defaultAction     = initialRule?.action     || {};

  const [name,       setName]       = useState(initialRule?.name        || '');
  const [description,setDesc]       = useState(initialRule?.description || '');
  const [ruleType,   setRuleType]   = useState(initialRule?.rule_type   || '');
  const [trigger,    setTrigger]    = useState(initialRule?.trigger     || 'create');
  const [severity,   setSeverity]   = useState(initialRule?.severity    || 'block');
  const [conditions, setConditions] = useState(defaultConditions);
  const [action,     setAction]     = useState(defaultAction);
  const [sortOrder,  setSortOrder]  = useState(initialRule?.sort_order  ?? 0);
  const [errors,     setErrors]     = useState([]);
  const [saving,     setSaving]     = useState(false);

  // Reset action JSONB when rule_type changes — different shapes
  const handleRuleTypeChange = useCallback((newType) => {
    setRuleType(newType);
    setAction({});
  }, []);

  const handleSave = async () => {
    const payload = { name: name.trim(), description, rule_type: ruleType, trigger, severity, conditions, action, sort_order: parseInt(sortOrder) || 0 };
    const errs = validateRule(payload);
    if (errs.length) { setErrors(errs); return; }
    setErrors([]);
    setSaving(true);
    try {
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  // Derived
  const ruleTypeMeta = RULE_TYPES.find(r => r.value === ruleType);
  const locked       = isLocked;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.scopeBadge}>{scopeLabel}</div>
          <h3 style={styles.title}>{initialRule ? 'Edit Rule' : 'New Rule'}</h3>
        </div>
        {locked && (
          <div style={styles.lockedBanner}>
            🔒 Platform rule — read only
          </div>
        )}
      </div>

      {errors.length > 0 && (
        <div style={styles.errorBox}>
          {errors.map((e, i) => <div key={i}>• {e}</div>)}
        </div>
      )}

      {/* ── Identity ── */}
      <section style={styles.section}>
        <div style={styles.sectionTitle}>Identity</div>
        <div style={styles.twoCol}>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Rule Name *</label>
            <input
              style={styles.input}
              placeholder="e.g. Close date required for Proposal"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={locked}
            />
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Sort Order</label>
            <input
              type="number"
              min="0"
              style={{ ...styles.input, width: 80 }}
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value)}
              disabled={locked}
            />
          </div>
        </div>
        <div style={styles.fieldRow}>
          <label style={styles.label}>Description</label>
          <input
            style={styles.input}
            placeholder="Optional — explain what this rule enforces"
            value={description}
            onChange={e => setDesc(e.target.value)}
            disabled={locked}
          />
        </div>
      </section>

      {/* ── Trigger + type ── */}
      <section style={styles.section}>
        <div style={styles.sectionTitle}>Configuration</div>
        <div style={styles.threeCol}>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Fires On *</label>
            <select style={styles.select} value={trigger} onChange={e => setTrigger(e.target.value)} disabled={locked}>
              {TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Rule Type *</label>
            <select style={styles.select} value={ruleType} onChange={e => handleRuleTypeChange(e.target.value)} disabled={locked}>
              <option value="">— select type —</option>
              {RULE_TYPES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            {ruleTypeMeta && <div style={styles.hint}>{ruleTypeMeta.desc}</div>}
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Severity</label>
            {SEVERITIES.map(s => (
              <label key={s.value} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 13, cursor: locked ? 'not-allowed' : 'pointer' }}>
                <input
                  type="radio"
                  name="severity"
                  value={s.value}
                  checked={severity === s.value}
                  onChange={() => !locked && setSeverity(s.value)}
                  disabled={locked}
                />
                <span style={{ color: s.color, fontWeight: 600 }}>{s.value.toUpperCase()}</span>
                <span style={{ color: '#6b7280' }}>— {s.label.split('(')[1]?.replace(')', '')}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      {/* ── Conditions ── */}
      <section style={styles.section}>
        <div style={styles.sectionTitleRow}>
          <div style={styles.sectionTitle}>
            Conditions
            <span style={styles.sectionHint}>
              {trigger === 'audit'
                ? ' — when these match, the record is flagged as a violation'
                : ' — rule fires only when these conditions are true'}
            </span>
          </div>
        </div>
        <ConditionsBuilder
          entity={entity}
          tree={conditions}
          onChange={locked ? undefined : setConditions}
        />
        {locked && <div style={styles.lockedOverlay} />}
      </section>

      {/* ── Action ── */}
      {ruleType && (
        <section style={styles.section}>
          <div style={styles.sectionTitle}>Action</div>
          <ActionBuilder
            entity={entity}
            ruleType={ruleType}
            action={action}
            onChange={locked ? () => {} : setAction}
          />
        </section>
      )}

      {/* ── Footer ── */}
      {!locked && (
        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : initialRule ? 'Save Changes' : 'Create Rule'}
          </button>
        </div>
      )}
      {locked && (
        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onCancel}>Close</button>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  container: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
  },
  scopeBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    color: '#6366f1',
    background: '#eef2ff',
    borderRadius: 6,
    padding: '2px 8px',
    marginBottom: 6,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: '#111827',
  },
  lockedBanner: {
    fontSize: 12,
    color: '#9ca3af',
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 7,
    padding: '5px 12px',
  },
  errorBox: {
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 13,
    color: '#dc2626',
    marginBottom: 16,
    lineHeight: 1.7,
  },
  section: {
    borderTop: '1px solid #f3f4f6',
    paddingTop: 18,
    marginTop: 18,
    position: 'relative',
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: '#6b7280',
    marginBottom: 12,
  },
  sectionTitleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionHint: {
    fontSize: 11,
    fontWeight: 400,
    textTransform: 'none',
    letterSpacing: 0,
    color: '#9ca3af',
  },
  twoCol: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 12,
    alignItems: 'start',
    marginBottom: 8,
  },
  threeCol: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 16,
    alignItems: 'start',
  },
  fieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 10,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: '#374151',
  },
  hint: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 3,
  },
  input: {
    padding: '7px 10px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 13,
    color: '#111827',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  select: {
    padding: '7px 10px',
    borderRadius: 7,
    border: '1px solid #d1d5db',
    fontSize: 13,
    color: '#111827',
    background: '#fff',
    width: '100%',
    boxSizing: 'border-box',
  },
  checkLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
    padding: '3px 8px',
    borderRadius: 5,
    border: '1px solid #e5e7eb',
    background: '#f9fafb',
  },
  // ── Condition builder ──
  conditionsBuilder: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  rootOpRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    fontSize: 12,
    color: '#6b7280',
  },
  groupBox: {
    background: '#f8fafc',
    border: '1px solid #e5e7eb',
    borderRadius: 9,
    padding: '12px 14px',
  },
  groupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  groupOpRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  groupHint: {
    fontSize: 11,
    color: '#9ca3af',
    marginLeft: 6,
  },
  opToggle: {
    padding: '3px 10px',
    borderRadius: 5,
    border: '1px solid #d1d5db',
    background: '#fff',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    color: '#6b7280',
  },
  opToggleActive: {
    background: '#6366f1',
    borderColor: '#6366f1',
    color: '#fff',
  },
  leafRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  leafSelect: {
    flex: '0 0 160px',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    background: '#fff',
  },
  leafSelectMed: {
    flex: '0 0 170px',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    background: '#fff',
  },
  leafInput: {
    flex: 1,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    minWidth: 0,
  },
  iconBtn: {
    padding: '4px 8px',
    borderRadius: 5,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 11,
    color: '#9ca3af',
    cursor: 'pointer',
    flexShrink: 0,
  },
  iconBtnSm: {
    padding: '3px 8px',
    borderRadius: 5,
    border: '1px solid #e5e7eb',
    background: '#fff',
    fontSize: 11,
    color: '#dc2626',
    cursor: 'pointer',
  },
  addConditionBtn: {
    marginTop: 8,
    padding: '4px 10px',
    borderRadius: 5,
    border: '1px dashed #d1d5db',
    background: '#fff',
    fontSize: 12,
    color: '#6b7280',
    cursor: 'pointer',
  },
  addGroupBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    border: '1px dashed #c7d2fe',
    background: '#fff',
    fontSize: 12,
    color: '#6366f1',
    cursor: 'pointer',
    marginTop: 4,
  },
  // ── Action block ──
  actionBlock: {
    background: '#f8fafc',
    border: '1px solid #e5e7eb',
    borderRadius: 9,
    padding: '14px 16px',
  },
  lockedOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(255,255,255,0.5)',
    borderRadius: 8,
    cursor: 'not-allowed',
    pointerEvents: 'all',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    borderTop: '1px solid #f3f4f6',
    paddingTop: 18,
    marginTop: 18,
  },
  cancelBtn: {
    padding: '8px 18px',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    background: '#fff',
    fontSize: 13,
    color: '#374151',
    cursor: 'pointer',
    fontWeight: 500,
  },
  saveBtn: {
    padding: '8px 22px',
    borderRadius: 8,
    border: 'none',
    background: '#6366f1',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
