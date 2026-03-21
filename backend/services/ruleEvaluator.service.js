// =============================================================================
// ruleEvaluator.service.js
// =============================================================================
// Pure rule evaluation — no side effects, minimal async (only play_completed
// operators hit the DB). All other evaluation is synchronous.
//
// Exports:
//   evaluateRule(rule, payload, context)
//   evaluateConditionTree(conditionTree, payload, context)
//   evaluateLeafCondition(condition, payload, context)       [sync]
//   evaluateLeafConditionAsync(condition, payload, context)  [async — play ops]
//   applyMutationRules(rules, payload, context)
// =============================================================================

const db = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Field registry
// Maps field keys (used in conditions/actions JSONB) to the actual DB column
// name on each entity. This is the only place field→column mapping lives.
//
// To add a new entity: add a block here. No migration needed.
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_REGISTRY = {
  deal: {
    name:                'name',
    value:               'value',
    expected_close_date: 'expected_close_date',
    close_date:          'close_date',
    stage:               'stage',
    stage_type:          'stage_type',
    health:              'health',
    probability:         'probability',
    owner_id:            'owner_id',
    account_id:          'account_id',
    playbook_id:         'playbook_id',
  },
  contact: {
    first_name:       'first_name',
    last_name:        'last_name',
    email:            'email',
    phone:            'phone',
    title:            'title',
    role_type:        'role_type',
    engagement_level: 'engagement_level',
    account_id:       'account_id',
    // contacts uses user_id as the owner FK — exposed as owner_id in rule conditions
    owner_id:         'user_id',
  },
  account: {
    name:                'name',
    domain:              'domain',
    industry:            'industry',
    size:                'size',
    owner_id:            'owner_id',
    account_disposition: 'account_disposition',
    sla_tier_id:         'sla_tier_id',
  },
};

// Special field keys that are NOT DB columns — handled separately in the evaluator
const SPECIAL_FIELDS = new Set(['play_completed', 'play_not_completed']);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a field value from the payload, falling back to the existing record.
 * Handles the contacts owner_id → user_id alias transparently.
 *
 * @param {string} entity
 * @param {string} fieldKey
 * @param {Object} payload        — incoming write payload (camelCase or snake_case keys)
 * @param {Object} existingRecord — current DB row (snake_case keys)
 * @returns {*}
 */
function resolveFieldValue(entity, fieldKey, payload, existingRecord) {
  const registry = FIELD_REGISTRY[entity] || {};
  const dbCol    = registry[fieldKey] || fieldKey; // fall through for unknown keys

  // Payload may arrive in camelCase (from req.body) or snake_case (from DB row).
  // We check both forms so the evaluator works regardless of which side sends it.
  const camel = toCamelCase(fieldKey);
  const snake = fieldKey;
  const dbCamel = toCamelCase(dbCol);

  // Prefer payload values; fall back to existing record
  const fromPayload =
    payload[snake]   !== undefined ? payload[snake]   :
    payload[camel]   !== undefined ? payload[camel]   :
    payload[dbCol]   !== undefined ? payload[dbCol]   :
    payload[dbCamel] !== undefined ? payload[dbCamel] :
    undefined;

  if (fromPayload !== undefined) return fromPayload;

  // Fall back to existing record (always snake_case from DB)
  if (existingRecord) {
    if (existingRecord[dbCol]   !== undefined) return existingRecord[dbCol];
    if (existingRecord[dbCamel] !== undefined) return existingRecord[dbCamel];
    if (existingRecord[snake]   !== undefined) return existingRecord[snake];
  }

  return undefined;
}

function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * isEmpty — null, undefined, empty string, or 0 for numbers
 */
function isEmpty(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (typeof val === 'number' && val === 0) return true;
  return false;
}

function toComparable(val) {
  // Dates: coerce strings to timestamps for gt/lt/gte/lte
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
    const d = new Date(val);
    if (!isNaN(d)) return d;
  }
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLeafCondition (sync — no DB access)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates a single leaf condition synchronously.
 * Returns null for async operators (play_completed / play_not_completed) —
 * those are handled by evaluateLeafConditionAsync.
 *
 * @param {{ field: string, op: string, value: any }} condition
 * @param {Object} payload
 * @param {Object} context  — { entity, orgId, userId, trigger, existingRecord, stageChangingTo? }
 * @returns {boolean|null}  — null means "needs async evaluation"
 */
function evaluateLeafCondition(condition, payload, context) {
  const { field, op, value } = condition;
  const { entity, existingRecord } = context;

  // Async operators — signal to caller
  if (SPECIAL_FIELDS.has(field)) return null;

  const actual = resolveFieldValue(entity, field, payload, existingRecord);

  switch (op) {
    case 'is_empty':
      return isEmpty(actual);

    case 'is_not_empty':
      return !isEmpty(actual);

    case 'is_relationship_empty':
      return actual === null || actual === undefined;

    case 'equals':
      // eslint-disable-next-line eqeqeq
      return actual == value; // loose equality handles numeric string vs number

    case 'not_equals':
      // eslint-disable-next-line eqeqeq
      return actual != value;

    case 'contains':
      if (actual == null) return false;
      return String(actual).toLowerCase().includes(String(value).toLowerCase());

    case 'not_contains':
      if (actual == null) return true;
      return !String(actual).toLowerCase().includes(String(value).toLowerCase());

    case 'gt':
      return toComparable(actual) > toComparable(value);

    case 'lt':
      return toComparable(actual) < toComparable(value);

    case 'gte':
      return toComparable(actual) >= toComparable(value);

    case 'lte':
      return toComparable(actual) <= toComparable(value);

    case 'in_list':
      if (!Array.isArray(value)) return false;
      // eslint-disable-next-line eqeqeq
      return value.some(v => v == actual);

    case 'not_in_list':
      if (!Array.isArray(value)) return true;
      // eslint-disable-next-line eqeqeq
      return !value.some(v => v == actual);

    case 'changed_to': {
      const existing = existingRecord
        ? resolveFieldValue(entity, field, {}, existingRecord)
        : undefined;
      const incoming = resolveFieldValue(entity, field, payload, {});
      // eslint-disable-next-line eqeqeq
      return incoming != null && incoming == value && existing != value;
    }

    case 'changed_from': {
      const existing = existingRecord
        ? resolveFieldValue(entity, field, {}, existingRecord)
        : undefined;
      // eslint-disable-next-line eqeqeq
      return existing != null && existing == value;
    }

    case 'regex_match': {
      if (actual == null) return false;
      try {
        return new RegExp(value).test(String(actual));
      } catch {
        return false;
      }
    }

    default:
      console.warn(`[ruleEvaluator] Unknown operator: "${op}" — treating as false`);
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLeafConditionAsync — handles play_completed / play_not_completed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Async wrapper. For sync operators, delegates to evaluateLeafCondition.
 * For play operators, performs a DB lookup (feature-flagged by caller).
 */
async function evaluateLeafConditionAsync(condition, payload, context) {
  const { field, value } = condition;
  const { entity, orgId, existingRecord } = context;

  if (field === 'play_completed' || field === 'play_not_completed') {
    // Requires entity = 'deal' and an existing deal id
    if (entity !== 'deal') return false;
    const dealId = existingRecord?.id || payload?.id;
    if (!dealId || !value) return false;

    try {
      const result = await db.query(
        `SELECT 1 FROM deal_play_instances
         WHERE deal_id = $1 AND play_id = $2 AND org_id = $3
           AND play_id IS NOT NULL AND status = 'completed'
         LIMIT 1`,
        [dealId, value, orgId]
      );
      const completed = result.rows.length > 0;
      return field === 'play_completed' ? completed : !completed;
    } catch (err) {
      console.error('[ruleEvaluator] play_completed DB query failed:', err);
      return false;
    }
  }

  // Sync path
  return evaluateLeafCondition(condition, payload, context) ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateConditionTree
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walks a conditions JSONB tree and returns true/false.
 * Tree shape: { operator: 'AND'|'OR', groups: [ { operator, conditions: [...] } ] }
 *
 * Empty conditions tree → true (no conditions = always fires)
 *
 * @param {Object} conditionTree
 * @param {Object} payload
 * @param {Object} context
 * @returns {Promise<boolean>}
 */
async function evaluateConditionTree(conditionTree, payload, context) {
  // Empty / missing tree → always passes (rule fires unconditionally)
  if (!conditionTree || !conditionTree.groups || conditionTree.groups.length === 0) {
    return true;
  }

  const rootOp = (conditionTree.operator || 'AND').toUpperCase();
  const groupResults = await Promise.all(
    conditionTree.groups.map(group => evaluateGroup(group, payload, context))
  );

  return rootOp === 'OR'
    ? groupResults.some(Boolean)
    : groupResults.every(Boolean);
}

async function evaluateGroup(group, payload, context) {
  const groupOp = (group.operator || 'AND').toUpperCase();
  const conditions = group.conditions || [];

  if (conditions.length === 0) return true;

  const results = await Promise.all(
    conditions.map(c => evaluateLeafConditionAsync(c, payload, context))
  );

  return groupOp === 'OR'
    ? results.some(Boolean)
    : results.every(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateRule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates a single rule against a payload.
 *
 * @param {Object} rule     — row from workflow_rules
 * @param {Object} payload  — entity fields being written
 * @param {Object} context  — { entity, orgId, userId, trigger, existingRecord, stageChangingTo? }
 * @returns {Promise<{ passed: boolean, violations: Array<{ field, message, severity }> }>}
 */
async function evaluateRule(rule, payload, context) {
  const violations = [];

  // Check feature flag for play operators (org settings)
  // We trust the middleware to have passed the right context — no extra DB call here.
  const conditionsMet = await evaluateConditionTree(rule.conditions, payload, context);

  if (!conditionsMet) {
    // Conditions not met → rule does not apply → passed (no violation)
    return { passed: true, violations };
  }

  // Conditions ARE met — now apply the rule_type logic
  switch (rule.rule_type) {
    case 'required_field': {
      const field   = rule.action?.field;
      const message = rule.action?.message || `${field} is required`;
      const val     = resolveFieldValue(context.entity, field, payload, context.existingRecord);
      if (isEmpty(val)) {
        violations.push({ field, message, severity: rule.severity });
      }
      break;
    }

    case 'conditional_required': {
      // Conditions tree already confirmed the condition is met — check field presence
      const field   = rule.action?.field;
      const message = rule.action?.message || `${field} is required`;
      const val     = resolveFieldValue(context.entity, field, payload, context.existingRecord);
      if (isEmpty(val)) {
        violations.push({ field, message, severity: rule.severity });
      }
      break;
    }

    case 'stage_gate': {
      // Only fires on stage_change trigger. Block if incoming stage is in blocked_stages.
      const blockedStages = rule.action?.blocked_stages || [];
      const message       = rule.action?.message || 'Stage advance blocked by workflow rule';
      const incomingStage = context.stageChangingTo
        || resolveFieldValue(context.entity, 'stage', payload, null);

      if (incomingStage && blockedStages.includes(incomingStage)) {
        violations.push({ field: 'stage', message, severity: rule.severity });
      }
      break;
    }

    case 'auto_set':
    case 'transform':
      // Mutation rules — no violations, handled by applyMutationRules
      break;

    case 'audit':
      // Audit rules fire in the nightly worker, not in middleware — skip
      break;

    default:
      console.warn(`[ruleEvaluator] Unknown rule_type: "${rule.rule_type}"`);
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// applyMutationRules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies auto_set and transform rules to a payload copy.
 * Called AFTER validation passes. Pure — does not mutate the original payload.
 *
 * auto_set value_from sources:
 *   "context.userId"      → context.userId
 *   "account.owner_id"    → looked up from accounts table (async)
 *   literal value field   → rule.action.value
 *
 * transform fns: title_case | upper_case | lower_case | trim | trim_whitespace
 *
 * @param {Array<Object>} rules   — workflow_rules rows with rule_type in ['auto_set','transform']
 * @param {Object}        payload
 * @param {Object}        context — { entity, orgId, userId, existingRecord }
 * @returns {Promise<Object>}     — new payload copy with mutations applied
 */
async function applyMutationRules(rules, payload, context) {
  let mutated = { ...payload };

  for (const rule of rules) {
    try {
      if (rule.rule_type === 'auto_set') {
        mutated = await applyAutoSet(rule.action, mutated, context);
      } else if (rule.rule_type === 'transform') {
        mutated = applyTransform(rule.action, mutated, context);
      }
    } catch (err) {
      // Mutation errors must never block the request — log and continue
      console.error(`[ruleEvaluator] Mutation rule "${rule.name}" failed:`, err);
    }
  }

  return mutated;
}

async function applyAutoSet(action, payload, context) {
  const { field, value, value_from } = action;
  if (!field) return payload;

  let resolvedValue;

  if (value_from) {
    if (value_from === 'context.userId') {
      resolvedValue = context.userId;
    } else if (value_from.startsWith('account.')) {
      // e.g. "account.owner_id" — look up from the account record
      const accountField = value_from.split('.')[1];
      const accountId =
        resolveFieldValue(context.entity, 'account_id', payload, context.existingRecord);
      if (accountId) {
        try {
          const result = await db.query(
            `SELECT owner_id, name FROM accounts WHERE id = $1 LIMIT 1`,
            [accountId]
          );
          if (result.rows[0]) {
            resolvedValue = result.rows[0][accountField];
          }
        } catch (err) {
          console.error('[ruleEvaluator] auto_set account lookup failed:', err);
        }
      }
    } else {
      resolvedValue = value_from; // unknown dot-path — pass through as literal
    }
  } else {
    resolvedValue = value;
  }

  if (resolvedValue === undefined) return payload;

  return { ...payload, [field]: resolvedValue };
}

function applyTransform(action, payload, context) {
  const { field, fn } = action;
  if (!field || !fn) return payload;

  const current = resolveFieldValue(context.entity, field, payload, context.existingRecord);
  if (current == null || typeof current !== 'string') return payload;

  let transformed;
  switch (fn) {
    case 'title_case':
      transformed = current
        .toLowerCase()
        .replace(/(?:^|\s)\S/g, c => c.toUpperCase());
      break;
    case 'upper_case':
      transformed = current.toUpperCase();
      break;
    case 'lower_case':
      transformed = current.toLowerCase();
      break;
    case 'trim':
    case 'trim_whitespace':
      transformed = current.trim();
      break;
    default:
      console.warn(`[ruleEvaluator] Unknown transform fn: "${fn}"`);
      return payload;
  }

  return { ...payload, [field]: transformed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  evaluateRule,
  evaluateConditionTree,
  evaluateLeafCondition,
  evaluateLeafConditionAsync,
  applyMutationRules,
  FIELD_REGISTRY, // exported for route validation and UI field pickers
};
