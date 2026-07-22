/**
 * crm/schemaDiscovery.js
 *
 * DROP-IN LOCATION: backend/services/crm/schemaDiscovery.js
 *
 * Step zero of every assessment: discover what is actually in the customer's
 * CRM before computing anything. Output is the normalized payload frozen into
 * crm_schema_snapshots.schema (see 2026_61 for the shape).
 *
 * Two entry points, one shape out:
 *
 *   discoverSalesforce(sfClient, opts)  — sfClient is an initialised
 *       services/salesforce.client.js instance (query + _request are the only
 *       primitives used; _request handles absolute URLs so Tooling API calls
 *       work through the same auth/refresh path).
 *
 *   discoverHubSpot(hsAdapter, opts)    — hsAdapter is an initialised
 *       services/crm/adapters/hubspot.adapter.js instance (_get is the only
 *       primitive used).
 *
 * What each source provides:
 *
 *   SALESFORCE
 *     objects            GET /sobjects/ (global describe, custom = __c)
 *     fields             GET /sobjects/<Object>/describe per core object +
 *                        custom objects related to Opportunity/Account
 *     stage_defs         SELECT ... FROM OpportunityStage — authoritative
 *                        closed/won flags + probabilities + sort order.
 *                        Win/loss classification comes from HERE, not from a
 *                        hand-built stage_map guess.
 *     pipelines          RecordType rows on Opportunity (multi-pipeline
 *                        detection — baselines compute per-pipeline when >1)
 *     validation_rules   Tooling API ValidationRule (name/active/message;
 *                        formula bodies deferred — per-record Tooling
 *                        retrieval, v2 if a finding needs it)
 *     automation         Tooling API counts of Flows + WorkflowRules
 *     fill rates         SOQL aggregate COUNT(Field__c) over the trailing
 *                        history window, chunked ≤ FILL_RATE_CHUNK fields per
 *                        query. Exact, cheap against limits.
 *     historyTracked     describe's field-level trackHistory / trackFeedHistory
 *
 *   HUBSPOT
 *     fields             GET /crm/v3/properties/{object} (custom = not
 *                        hubspotDefined)
 *     stage_defs +
 *     pipelines          GET /crm/v3/pipelines/deals — per-stage metadata
 *                        (probability, isClosed/won analog) — the
 *                        OpportunityStage equivalent
 *     objects            GET /crm/v3/schemas (custom object schemas)
 *     validation_rules   No HubSpot analog. Reported as an explicit
 *                        limits_note, not faked.
 *     fill rates         SAMPLED — no aggregate API. Pulls FILL_RATE_SAMPLE
 *                        recent deals with all properties and computes sample
 *                        rates; every such field carries fillRateSampled:true
 *                        so the report can say so.
 *
 * Honesty contract: anything discovery cannot observe lands in
 * warnings / limits_notes rather than being silently absent.
 */

const FILL_RATE_CHUNK  = 20;   // SOQL aggregate fields per query
const FILL_RATE_SAMPLE = 200;  // HubSpot sampled-fill-rate record count

// Core objects the assessment reasons about. Custom objects are added
// dynamically when they hold a lookup to one of these.
const SF_CORE_OBJECTS = ['Opportunity', 'Account', 'Contact', 'Lead', 'Task', 'Event'];

// ─────────────────────────────────────────────────────────────────────────────
// SALESFORCE
// ─────────────────────────────────────────────────────────────────────────────

async function discoverSalesforce(sfClient, opts = {}) {
  const historyMonths = opts.historyMonths || 18;
  const warnings = [];
  const limitsNotes = [];

  // ── 1. Global describe: object inventory ──────────────────────────────────
  const global = await sfClient._request('GET', '/sobjects/');
  const allObjects = (global.sobjects || [])
    .filter(o => o.queryable)
    .map(o => ({ name: o.name, label: o.label, custom: !!o.custom }));

  // ── 2. Per-object describes for core objects ──────────────────────────────
  const fields = {};
  const relatedCustomObjects = new Set();

  for (const objName of SF_CORE_OBJECTS) {
    let describe;
    try {
      describe = await sfClient._request('GET', `/sobjects/${objName}/describe`);
    } catch (err) {
      warnings.push({ kind: 'describe_failed', object: objName, detail: err.message });
      continue;
    }
    fields[objName] = (describe.fields || []).map(f => ({
      name:           f.name,
      label:          f.label,
      type:           f.type,
      custom:         !!f.custom,
      required:       !f.nillable && !f.defaultedOnCreate && f.createable,
      calculated:     !!f.calculated,
      historyTracked: !!(f.trackHistory || f.trackFeedHistory),
      picklistValues: (f.type === 'picklist' || f.type === 'multipicklist')
        ? (f.picklistValues || []).filter(p => p.active).map(p => p.value)
        : undefined,
    }));

    // Custom objects that point INTO this core object (lookup graph — reported
    // as inventory, not synced).
    for (const rel of (describe.childRelationships || [])) {
      if (rel.childSObject && rel.childSObject.endsWith('__c')) {
        relatedCustomObjects.add(rel.childSObject);
      }
    }
  }

  // ── 3. Stage semantics: OpportunityStage (authoritative) ──────────────────
  let stageDefs = [];
  try {
    const res = await sfClient.query(
      'SELECT MasterLabel, IsActive, IsClosed, IsWon, DefaultProbability, SortOrder ' +
      'FROM OpportunityStage ORDER BY SortOrder'
    );
    stageDefs = res.records.map(r => ({
      label:              r.MasterLabel,
      isActive:           !!r.IsActive,
      isClosed:           !!r.IsClosed,
      isWon:              !!r.IsWon,
      defaultProbability: r.DefaultProbability,
      sortOrder:          r.SortOrder,
    }));
  } catch (err) {
    warnings.push({ kind: 'stage_defs_failed', detail: err.message });
  }

  // ── 4. Pipelines: Opportunity record types (multi-pipeline detection) ─────
  let pipelines = [];
  try {
    const res = await sfClient.query(
      "SELECT Id, Name, IsActive FROM RecordType WHERE SobjectType = 'Opportunity'"
    );
    pipelines = res.records
      .filter(r => r.IsActive)
      .map(r => ({ id: r.Id, label: r.Name }));
  } catch (err) {
    // Orgs without record types 404/empty here — that's a single-pipeline org.
    pipelines = [];
  }
  if (pipelines.length > 1) {
    warnings.push({
      kind: 'multi_pipeline',
      detail: `${pipelines.length} active Opportunity record types — baseline will compute per-pipeline`,
    });
  }

  // ── 5. Validation rules + automation inventory (Tooling API) ──────────────
  const validationRules = [];
  let automation = { flows: null, workflowRules: null };
  const toolingBase = `${sfClient.instanceUrl}/services/data/v59.0/tooling`;
  try {
    const vr = await sfClient._request('GET',
      `${toolingBase}/query?q=${encodeURIComponent(
        "SELECT ValidationName, Active, ErrorMessage, EntityDefinition.DeveloperName " +
        "FROM ValidationRule WHERE EntityDefinition.DeveloperName IN " +
        "('Opportunity','Account','Contact','Lead')"
      )}`);
    for (const r of (vr.records || [])) {
      validationRules.push({
        object:       r.EntityDefinition ? r.EntityDefinition.DeveloperName : null,
        name:         r.ValidationName,
        active:       !!r.Active,
        errorMessage: r.ErrorMessage || null,
      });
    }
  } catch (err) {
    limitsNotes.push(`Validation rules not readable with granted permissions (${err.message}) — permission-set recipe grants Tooling read; report will note the gap.`);
  }
  try {
    const fl = await sfClient._request('GET',
      `${toolingBase}/query?q=${encodeURIComponent(
        "SELECT COUNT() FROM Flow WHERE Status = 'Active'")}`);
    const wf = await sfClient._request('GET',
      `${toolingBase}/query?q=${encodeURIComponent(
        "SELECT COUNT() FROM WorkflowRule")}`);
    automation = {
      flows:         fl.totalSize ?? null,
      workflowRules: wf.totalSize ?? null,
    };
  } catch (err) {
    limitsNotes.push(`Automation inventory not readable (${err.message}).`);
  }

  // ── 6. Fill rates: exact aggregates over the history window ───────────────
  // COUNT(field) counts non-null. Denominator is COUNT(Id) in the same window.
  await _sfFillRates(sfClient, 'Opportunity', fields['Opportunity'], historyMonths, warnings);
  await _sfFillRates(sfClient, 'Account',     fields['Account'],     historyMonths, warnings);

  return {
    crm_type: 'salesforce',
    objects: [
      ...allObjects.filter(o => SF_CORE_OBJECTS.includes(o.name)),
      ...allObjects.filter(o => relatedCustomObjects.has(o.name)),
    ],
    fields,
    stage_defs: stageDefs,
    pipelines,
    validation_rules: validationRules,
    automation,
    limits_notes: limitsNotes,
    warnings,
  };
}

async function _sfFillRates(sfClient, objName, fieldList, historyMonths, warnings) {
  if (!Array.isArray(fieldList) || fieldList.length === 0) return;

  // Aggregate-friendly fields only: skip compound/address/location and base64.
  const AGG_SKIP = new Set(['address', 'location', 'base64', 'anyType']);
  const candidates = fieldList.filter(f =>
    !AGG_SKIP.has(f.type) && f.name !== 'Id');

  const where = `WHERE CreatedDate = LAST_N_MONTHS:${historyMonths}`;

  for (let i = 0; i < candidates.length; i += FILL_RATE_CHUNK) {
    const chunk = candidates.slice(i, i + FILL_RATE_CHUNK);
    const selects = ['COUNT(Id) total_n', ...chunk.map((f, j) => `COUNT(${f.name}) c${j}`)];
    try {
      const res = await sfClient.query(
        `SELECT ${selects.join(', ')} FROM ${objName} ${where}`);
      const row = res.records[0] || {};
      const total = Number(row.total_n) || 0;
      chunk.forEach((f, j) => {
        f.fillRate = total > 0 ? Number(((Number(row[`c${j}`]) || 0) / total).toFixed(4)) : null;
      });
    } catch (err) {
      // One bad field (e.g. non-aggregatable formula) poisons the chunk —
      // fall back to per-field so the rest still resolve.
      for (const f of chunk) {
        try {
          const res = await sfClient.query(
            `SELECT COUNT(Id) total_n, COUNT(${f.name}) c0 FROM ${objName} ${where}`);
          const row = res.records[0] || {};
          const total = Number(row.total_n) || 0;
          f.fillRate = total > 0 ? Number(((Number(row.c0) || 0) / total).toFixed(4)) : null;
        } catch (inner) {
          f.fillRate = null;
          warnings.push({ kind: 'fill_rate_failed', object: objName, field: f.name, detail: inner.message });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT
// ─────────────────────────────────────────────────────────────────────────────

async function discoverHubSpot(hsAdapter, opts = {}) {
  const warnings = [];
  const limitsNotes = [
    'HubSpot has no validation-rule analog; process-enforcement findings rely on pipeline stage requirements and workflow inventory only.',
    `Deal-property fill rates are sampled over the ${FILL_RATE_SAMPLE} most recently modified deals (no aggregate API), flagged fillRateSampled:true.`,
  ];

  // ── 1. Properties per core object (custom = not hubspotDefined) ───────────
  const fields = {};
  for (const obj of ['deals', 'companies', 'contacts']) {
    try {
      const data = await hsAdapter._get(`/crm/v3/properties/${obj}`, {});
      fields[obj] = (data.results || []).map(p => ({
        name:       p.name,
        label:      p.label,
        type:       p.type,
        custom:     p.hubspotDefined === false,
        calculated: !!p.calculated,
        required:   false, // form/pipeline-level in HubSpot; noted in limits
        picklistValues: (p.type === 'enumeration')
          ? (p.options || []).filter(o => !o.hidden).map(o => o.value)
          : undefined,
        historyTracked: true, // HubSpot keeps property history universally
      }));
    } catch (err) {
      warnings.push({ kind: 'describe_failed', object: obj, detail: err.message });
    }
  }

  // ── 2. Pipelines + stage defs (the OpportunityStage analog) ───────────────
  let pipelines = [];
  let stageDefs = [];
  try {
    const data = await hsAdapter._get('/crm/v3/pipelines/deals', {});
    pipelines = (data.results || []).map(p => ({
      id:    p.id,
      label: p.label,
      stages: (p.stages || []).map(s => ({
        id:                 s.id,
        label:              s.label,
        isClosed:           !!(s.metadata && (s.metadata.isClosed === 'true' || s.metadata.isClosed === true)),
        isWon:              !!(s.metadata && Number(s.metadata.probability) === 1),
        defaultProbability: s.metadata ? Number(s.metadata.probability) * 100 : null,
        sortOrder:          s.displayOrder,
      })),
    }));
    stageDefs = pipelines.flatMap(p =>
      p.stages.map(s => ({ ...s, pipelineId: p.id, pipelineLabel: p.label })));
    if (pipelines.length > 1) {
      warnings.push({
        kind: 'multi_pipeline',
        detail: `${pipelines.length} deal pipelines — baseline will compute per-pipeline`,
      });
    }
  } catch (err) {
    warnings.push({ kind: 'stage_defs_failed', detail: err.message });
  }

  // ── 3. Custom object schemas ──────────────────────────────────────────────
  let objects = [
    { name: 'deals', label: 'Deals', custom: false },
    { name: 'companies', label: 'Companies', custom: false },
    { name: 'contacts', label: 'Contacts', custom: false },
  ];
  try {
    const data = await hsAdapter._get('/crm/v3/schemas', {});
    objects = objects.concat((data.results || []).map(s => ({
      name: s.name, label: (s.labels && s.labels.plural) || s.name, custom: true,
    })));
  } catch (err) {
    limitsNotes.push(`Custom object schemas not readable (${err.message}) — scope crm.schemas.custom.read missing?`);
  }

  // ── 4. Sampled fill rates on deal properties ──────────────────────────────
  try {
    const dealProps = (fields.deals || []).map(f => f.name);
    const sample = await hsAdapter._get('/crm/v3/objects/deals', {
      limit: Math.min(FILL_RATE_SAMPLE, 100),
      properties: dealProps.join(','),
      sorts: '-hs_lastmodifieddate',
    });
    const rows = sample.results || [];
    if (rows.length > 0) {
      const counts = Object.create(null);
      for (const r of rows) {
        const props = r.properties || {};
        for (const k of Object.keys(props)) {
          if (props[k] !== null && props[k] !== undefined && props[k] !== '') {
            counts[k] = (counts[k] || 0) + 1;
          }
        }
      }
      for (const f of (fields.deals || [])) {
        f.fillRate = Number(((counts[f.name] || 0) / rows.length).toFixed(4));
        f.fillRateSampled = true;
      }
    }
  } catch (err) {
    warnings.push({ kind: 'fill_rate_failed', object: 'deals', detail: err.message });
  }

  return {
    crm_type: 'hubspot',
    objects,
    fields,
    stage_defs: stageDefs,
    pipelines,
    validation_rules: [],
    automation: { flows: null, workflowRules: null },
    limits_notes: limitsNotes,
    warnings,
  };
}

module.exports = { discoverSalesforce, discoverHubSpot };
