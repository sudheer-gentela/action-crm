/**
 * salesforce.mapper.js
 *
 * DROP-IN LOCATION: backend/services/salesforce.mapper.js
 *
 * Bidirectional mapping between Salesforce objects and GoWarm schema.
 *
 * Two layers:
 *   1. HARDCODED_MAP — structural field mappings that always apply
 *      (SF field name → GoWarm column, with optional transform function)
 *   2. Dynamic field_map from org_integrations.settings.field_map
 *      Applied on top of hardcoded mappings. Org Admin configures these
 *      in Settings → Salesforce → Field Mapping.
 *
 * Stage mapping is always dynamic (stored in settings.stage_map).
 * No default stage map — orgs must configure their own via the UI.
 */

// ── Hardcoded structural maps ─────────────────────────────────────────────────
// These are the canonical GoWarm columns each SF object maps to.
// Transform functions normalise SF values to GoWarm-expected formats.

const HARDCODED_MAP = {

  Contact: {
    gwTable:    'contacts',
    gwEntity:   'contact',
    sfIdField:  'Id',
    fields: [
      { sf: 'FirstName',    gw: 'first_name' },
      { sf: 'LastName',     gw: 'last_name' },
      { sf: 'Email',        gw: 'email',         transform: v => v?.toLowerCase()?.trim() || null },
      { sf: 'Phone',        gw: 'phone' },
      { sf: 'Title',        gw: 'title' },
      { sf: 'MailingCity',  gw: 'location',       transform: (v, rec) => _buildLocation(rec, 'Mailing') },
      { sf: 'LinkedInUrl__c', gw: 'linkedin_url' }, // common custom field
    ],
    // Fields used for identity resolution (fuzzy match)
    identityFields: ['Email', 'FirstName', 'LastName'],
  },

  Account: {
    gwTable:    'accounts',
    gwEntity:   'account',
    sfIdField:  'Id',
    fields: [
      { sf: 'Name',         gw: 'name' },
      { sf: 'Website',      gw: 'domain',       transform: v => _extractDomain(v) },
      { sf: 'Industry',     gw: 'industry' },
      { sf: 'NumberOfEmployees', gw: 'size',    transform: v => _employeesToSize(v) },
      { sf: 'BillingCity',  gw: 'location',     transform: (v, rec) => _buildLocation(rec, 'Billing') },
      { sf: 'Description',  gw: 'description' },
    ],
    identityFields: ['Name', 'Website'],
  },

  Opportunity: {
    gwTable:    'deals',
    gwEntity:   'deal',
    sfIdField:  'Id',
    fields: [
      { sf: 'Name',               gw: 'name' },
      { sf: 'Amount',             gw: 'value',               transform: v => parseFloat(v) || 0 },
      { sf: 'CloseDate',          gw: 'expected_close_date', transform: v => v ? new Date(v) : null },
      { sf: 'Probability',        gw: 'probability',         transform: v => Math.round(parseFloat(v) || 0) },
      { sf: 'Description',        gw: 'notes' },
      // Stage is handled separately via stage_map (not here)
    ],
    // Relationships resolved separately by sync service
    relationships: {
      AccountId: { gwColumn: 'account_id', lookupTable: 'accounts' },
    },
    identityFields: ['Name', 'AccountId'],
  },

  Lead: {
    gwTable:    'prospects',
    gwEntity:   'prospect',
    sfIdField:  'Id',
    fields: [
      { sf: 'FirstName',    gw: 'first_name' },
      { sf: 'LastName',     gw: 'last_name' },
      { sf: 'Email',        gw: 'email',           transform: v => v?.toLowerCase()?.trim() || null },
      { sf: 'Phone',        gw: 'phone' },
      { sf: 'Title',        gw: 'title' },
      { sf: 'Company',      gw: 'company_name' },
      { sf: 'Website',      gw: 'company_domain',  transform: v => _extractDomain(v) },
      { sf: 'Industry',     gw: 'company_industry' },
      { sf: 'NumberOfEmployees', gw: 'company_size', transform: v => _employeesToSize(v) },
      { sf: 'City',         gw: 'location',         transform: (v, rec) => _buildLocation(rec, '') },
      { sf: 'LinkedIn_URL__c', gw: 'linkedin_url' }, // common custom field name variant
      { sf: 'LeadSource',   gw: 'source' },
      { sf: 'Rating',       gw: 'icp_score',        transform: v => _ratingToScore(v) },
      // IsConverted handled separately — triggers Lead conversion flow
    ],
    identityFields: ['Email', 'FirstName', 'LastName', 'Company'],
  },

  // SF Tasks → GoWarm actions (Phase 2 signal reading)
  Task: {
    gwTable:   'actions',
    gwEntity:  'action',
    sfIdField: 'Id',
    fields: [
      { sf: 'Subject',          gw: 'title' },
      { sf: 'Description',      gw: 'description' },
      { sf: 'ActivityDate',     gw: 'due_date',     transform: v => v ? new Date(v) : null },
      { sf: 'Status',           gw: 'completed',    transform: v => v === 'Completed' },
      { sf: 'Priority',         gw: 'priority',     transform: v => _sfPriorityToGw(v) },
    ],
    // Relationships
    relationships: {
      WhoId:  { gwColumn: 'contact_id',  lookupTable: 'contacts',  sfTypes: ['Contact', 'Lead'] },
      WhatId: { gwColumn: 'deal_id',     lookupTable: 'deals',     sfTypes: ['Opportunity'] },
    },
  },
};

// ── SF field lists to SOQL SELECT (used by sync service) ─────────────────────

/**
 * Return the SF field names needed for a SOQL SELECT for a given object.
 * Merges hardcoded fields + any additional fields from the org's field_map.
 */
function getSoqlFields(sfObject, orgFieldMap = []) {
  const map     = HARDCODED_MAP[sfObject];
  if (!map) throw new Error(`Unknown SF object: ${sfObject}`);

  const baseFields = map.fields.map(f => f.sf);

  // Add relationship fields
  if (map.relationships) {
    Object.keys(map.relationships).forEach(k => baseFields.push(k));
  }

  // Add identity fields
  if (map.identityFields) {
    map.identityFields.forEach(f => { if (!baseFields.includes(f)) baseFields.push(f); });
  }

  // Add Lead-specific fields
  if (sfObject === 'Lead') {
    baseFields.push('IsConverted', 'ConvertedContactId', 'ConvertedAccountId', 'ConvertedOpportunityId');
  }

  // Add custom fields from org field_map
  const customSfFields = orgFieldMap
    .filter(m => m.sf_object === sfObject && !baseFields.includes(m.sf_field))
    .map(m => m.sf_field);

  return [...new Set([...baseFields, ...customSfFields])];
}

// ── sfRecordToGwData ──────────────────────────────────────────────────────────

/**
 * Convert a SF API record to a GoWarm DB upsert payload.
 * Applies hardcoded transforms + org-specific field_map on top.
 *
 * @param {string}   sfObject    - 'Contact' | 'Account' | 'Opportunity' | 'Lead'
 * @param {object}   sfRecord    - raw SF API response record
 * @param {object}   settings    - org_integrations.settings
 * @returns {{ gwData: object, sfId: string }}
 */
function sfRecordToGwData(sfObject, sfRecord, settings = {}) {
  const map    = HARDCODED_MAP[sfObject];
  if (!map) throw new Error(`Unknown SF object: ${sfObject}`);

  const gwData = {};

  // Apply hardcoded field mappings
  for (const fieldDef of map.fields) {
    const rawVal = sfRecord[fieldDef.sf];
    if (rawVal === undefined) continue; // SF field not in response (not selected)
    gwData[fieldDef.gw] = fieldDef.transform
      ? fieldDef.transform(rawVal, sfRecord)
      : (rawVal ?? null);
  }

  // Apply stage mapping (Opportunity / Lead only)
  if (sfObject === 'Opportunity' && sfRecord.StageName) {
    const stageMap = settings.stage_map || {};
    gwData.stage   = stageMap[sfRecord.StageName] || null;
    // null stage means "unmapped" — sync service handles this gracefully
  }

  if (sfObject === 'Lead' && sfRecord.Status) {
    const stageMap = settings.stage_map || {};
    gwData.stage   = stageMap[sfRecord.Status] || 'target'; // default to target
  }

  // Apply org-specific dynamic field_map
  const orgFieldMap = settings.field_map || [];
  for (const mapping of orgFieldMap) {
    if (mapping.sf_object !== sfObject) continue;
    if (mapping.direction === 'gw_to_sf') continue; // skip write-back mappings here
    const rawVal = sfRecord[mapping.sf_field];
    if (rawVal === undefined) continue;
    gwData[mapping.gw_field] = rawVal ?? null;
  }

  // Always update external_refs with SF ID and sync timestamp
  gwData.external_refs = {
    salesforce: {
      id:            sfRecord.Id,
      synced_at:     new Date().toISOString(),
      object_type:   sfObject,
      last_modified: sfRecord.LastModifiedDate,
    },
  };

  return { gwData, sfId: sfRecord.Id };
}

// ── gwActionToSfTask ──────────────────────────────────────────────────────────

/**
 * Convert a GoWarm action to a Salesforce Task payload for write-back.
 * Only called when write_back_enabled = true.
 *
 * @param {object} action     - GoWarm actions row
 * @param {object} settings   - org_integrations.settings
 * @returns {object} SF Task body for POST /sobjects/Task
 */
function gwActionToSfTask(action, settings = {}) {
  const sfTask = {
    Subject:           action.title || 'GoWarm Action',
    Description:       action.description || action.context || '',
    ActivityDate:      action.due_date ? new Date(action.due_date).toISOString().split('T')[0] : null,
    Status:            action.completed ? 'Completed' : 'Not Started',
    Priority:          _gwPriorityToSf(action.priority),
    GoWarm_Source__c:  true,   // Custom field — marks this as GoWarm-originated for dedup
    GoWarm_Action_ID__c: String(action.id),
  };

  // Link to the SF Opportunity if the deal has a SF ID
  if (action.deal_external_refs?.salesforce?.id) {
    sfTask.WhatId = action.deal_external_refs.salesforce.id;
  }

  // Link to the SF Contact if the contact has a SF ID
  if (action.contact_external_refs?.salesforce?.id) {
    sfTask.WhoId = action.contact_external_refs.salesforce.id;
  }

  return sfTask;
}

// ── Identity matching helpers ─────────────────────────────────────────────────

/**
 * Calculate match confidence between a SF record and a GoWarm record.
 * Returns 0.0–1.0.
 * 1.0 = confirmed (same SF ID already in external_refs)
 * 0.9 = email exact match
 * 0.7–0.8 = name + company fuzzy match
 * < 0.7 = not reliable enough for auto-link
 */
function calculateMatchConfidence(sfRecord, gwRecord, sfObject) {
  // Already linked via external_refs
  if (gwRecord.external_refs?.salesforce?.id === sfRecord.Id) return 1.0;

  const map = HARDCODED_MAP[sfObject];
  if (!map) return 0;

  let score = 0;
  let checks = 0;

  if (sfObject === 'Contact' || sfObject === 'Lead') {
    const sfEmail = sfRecord.Email?.toLowerCase()?.trim();
    const gwEmail = gwRecord.email?.toLowerCase()?.trim();
    if (sfEmail && gwEmail) {
      checks++;
      if (sfEmail === gwEmail) score += 0.9;
    }

    const sfName = `${sfRecord.FirstName || ''} ${sfRecord.LastName || ''}`.toLowerCase().trim();
    const gwName = `${gwRecord.first_name || ''} ${gwRecord.last_name || ''}`.toLowerCase().trim();
    if (sfName && gwName) {
      checks++;
      if (sfName === gwName) score += 0.3;
      else if (_fuzzyNameMatch(sfName, gwName)) score += 0.15;
    }
  }

  if (sfObject === 'Account') {
    const sfDomain = _extractDomain(sfRecord.Website);
    const gwDomain = gwRecord.domain;
    if (sfDomain && gwDomain && sfDomain === gwDomain) return 0.95;

    const sfName = (sfRecord.Name || '').toLowerCase().trim();
    const gwName = (gwRecord.name || '').toLowerCase().trim();
    if (sfName && gwName) {
      checks++;
      if (sfName === gwName) score += 0.85;
      else if (_fuzzyNameMatch(sfName, gwName)) score += 0.5;
    }
  }

  return checks > 0 ? Math.min(score, 1.0) : 0;
}

// ── Private transform helpers ─────────────────────────────────────────────────

function _extractDomain(url) {
  if (!url) return null;
  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function _employeesToSize(n) {
  if (!n) return null;
  if (n < 10)   return '1-10';
  if (n < 50)   return '11-50';
  if (n < 200)  return '51-200';
  if (n < 1000) return '201-1000';
  return '1000+';
}

function _buildLocation(rec, prefix) {
  const parts = [
    rec[`${prefix}City`],
    rec[`${prefix}State`],
    rec[`${prefix}Country`],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function _ratingToScore(rating) {
  const map = { Hot: 90, Warm: 65, Cold: 30 };
  return map[rating] ?? null;
}

function _sfPriorityToGw(sfPriority) {
  const map = { High: 'high', Normal: 'medium', Low: 'low' };
  return map[sfPriority] || 'medium';
}

function _gwPriorityToSf(gwPriority) {
  const map = { high: 'High', medium: 'Normal', low: 'Low' };
  return map[gwPriority] || 'Normal';
}

function _fuzzyNameMatch(a, b) {
  // Simple Jaccard similarity on word sets
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

module.exports = {
  HARDCODED_MAP,
  getSoqlFields,
  sfRecordToGwData,
  gwActionToSfTask,
  calculateMatchConfidence,
};
