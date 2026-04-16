/**
 * crm/mapper.js
 *
 * DROP-IN LOCATION: backend/services/crm/mapper.js
 *
 * Canonical normalized shapes returned by every CRM adapter.
 * The orchestrator works exclusively with these shapes — it never
 * knows whether data came from Salesforce, HubSpot, or anywhere else.
 *
 * Each shape documents:
 *   - What fields are required
 *   - What fields are optional
 *   - How they map to GoWarm DB columns
 *
 * Adapters are responsible for transforming CRM-specific payloads
 * into these shapes. The orchestrator handles all DB writes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZED SHAPES (documentation + validation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NormalizedAccount
 *
 * CRM source  → GoWarm column
 * ─────────────────────────────
 * crmId       → accounts.external_refs.{crmType}.id
 * name        → accounts.name
 * domain      → accounts.domain
 * industry    → accounts.industry
 * size        → accounts.size  (must be one of: '1-10','11-50','51-200','201-1000','1000+')
 * location    → accounts.location
 * description → accounts.description
 * ownerEmail  → accounts.owner_id  (resolved via users.email)
 * externalRefs → accounts.external_refs  (merged, not replaced)
 *
 * @typedef {Object} NormalizedAccount
 * @property {string}      crmId        - CRM native ID (required)
 * @property {string}      name         - Account name (required)
 * @property {string|null} domain       - Website domain (e.g. 'acme.com')
 * @property {string|null} industry
 * @property {string|null} size         - Employee band
 * @property {string|null} location     - City, State, Country
 * @property {string|null} description
 * @property {string|null} ownerEmail   - CRM owner email → GoWarm user
 * @property {string|null} lastModified - ISO datetime for cursor tracking
 */

/**
 * NormalizedContact
 *
 * CRM source             → GoWarm column
 * ───────────────────────────────────────
 * crmId                  → contacts.external_refs.{crmType}.id
 * accountCrmId           → contacts.account_id  (resolved via external_refs)
 * firstName              → contacts.first_name
 * lastName               → contacts.last_name
 * email                  → contacts.email
 * phone                  → contacts.phone
 * title                  → contacts.title
 * location               → contacts.location
 * linkedinUrl            → contacts.linkedin_url
 * reportsToContactCrmId  → contacts.reports_to_contact_id  (resolved via external_refs)
 * ownerEmail             → contacts.user_id  (resolved via users.email)
 *
 * @typedef {Object} NormalizedContact
 * @property {string}      crmId
 * @property {string|null} accountCrmId
 * @property {string}      firstName  (required)
 * @property {string}      lastName   (required)
 * @property {string|null} email
 * @property {string|null} phone
 * @property {string|null} title
 * @property {string|null} location
 * @property {string|null} linkedinUrl
 * @property {string|null} reportsToContactCrmId
 * @property {string|null} ownerEmail
 * @property {string|null} lastModified
 */

/**
 * NormalizedDeal
 *
 * CRM source       → GoWarm column
 * ────────────────────────────────
 * crmId            → deals.external_refs.{crmType}.id
 *                    deals.external_crm_type (backcompat)
 *                    deals.external_crm_deal_id (backcompat)
 * accountCrmId     → deals.account_id  (resolved via external_refs)
 * ownerEmail       → deals.owner_id / deals.user_id  (resolved via users.email)
 * name             → deals.name
 * value            → deals.value
 * stageCrmKey      → deals.stage  (resolved via stage_map in settings)
 * expectedCloseDate → deals.expected_close_date
 *                     deals.external_crm_close_date (backcompat)
 * probability      → deals.probability
 * notes            → deals.notes
 *
 * @typedef {Object} NormalizedDeal
 * @property {string}      crmId
 * @property {string|null} accountCrmId
 * @property {string|null} ownerEmail
 * @property {string}      name   (required)
 * @property {number}      value
 * @property {string|null} stageCrmKey   - CRM stage label (e.g. 'Prospecting')
 * @property {string|null} expectedCloseDate - ISO date string
 * @property {number|null} probability   - 0-100
 * @property {string|null} notes
 * @property {string|null} lastModified
 */

/**
 * NormalizedDealContact
 * Represents a Contact→Deal relationship (OpportunityContactRole in SF)
 *
 * @typedef {Object} NormalizedDealContact
 * @property {string}      dealCrmId
 * @property {string}      contactCrmId
 * @property {string|null} role       - e.g. 'Decision Maker', 'Champion'
 * @property {boolean}     isPrimary
 */

/**
 * NormalizedLineItem
 * Represents a product line on a deal (OpportunityLineItem in SF)
 *
 * CRM source        → GoWarm column
 * ────────────────────────────────────────
 * crmId             → deal_products.external_refs  (stored in notes for now)
 * name              → deal_products.product_name
 *                     product_catalog.name (upserted)
 * sku               → product_catalog.sku
 * quantity          → deal_products.quantity
 * unitPrice         → deal_products.unit_price
 *                     product_catalog.list_price (if new)
 * discountPct       → deal_products.discount_pct
 * productType       → deal_products.revenue_type + product_catalog.product_type
 *                     ('one_time' | 'recurring')
 * billingFrequency  → product_catalog.billing_frequency
 *                     ('monthly' | 'quarterly' | 'annual' | 'multi_year')
 * contractTerm      → deal_products.contract_term  (months)
 * effectiveDate     → deal_products.effective_date
 * renewalDate       → deal_products.renewal_date
 * categoryName      → deal_products.category_name
 *
 * @typedef {Object} NormalizedLineItem
 * @property {string}      crmId
 * @property {string}      name   (required)
 * @property {string|null} sku
 * @property {number}      quantity
 * @property {number}      unitPrice
 * @property {number}      discountPct
 * @property {string}      productType   ('one_time' | 'recurring')
 * @property {string|null} billingFrequency
 * @property {number|null} contractTerm
 * @property {string|null} effectiveDate
 * @property {string|null} renewalDate
 * @property {string|null} categoryName
 */

/**
 * NormalizedUser
 * Represents a CRM user for hierarchy + team sync
 *
 * CRM source      → GoWarm table
 * ────────────────────────────────────────────────────────────
 * email           → users.email  (join key — must already exist in GoWarm)
 * managerEmail    → org_hierarchy.reports_to  (resolved via users.email)
 * hierarchyRole   → org_hierarchy.hierarchy_role
 *                   ('rep' | 'manager' | 'director' | 'vp' | 'cro')
 * teamName        → teams.name  (upserted with dimension='sales')
 * roleName        → org_hierarchy.hierarchy_role (label form)
 *
 * @typedef {Object} NormalizedUser
 * @property {string}      crmId
 * @property {string}      email   (required — join key)
 * @property {string|null} name
 * @property {string|null} managerEmail
 * @property {string|null} hierarchyRole
 * @property {string|null} teamName
 * @property {string|null} roleName
 * @property {boolean}     isActive
 */

// ─────────────────────────────────────────────────────────────────────────────
// FIELD TRANSFORMS (shared utilities used by adapters)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a clean domain from a URL or bare domain string.
 * Returns null if no valid domain found.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
function extractDomain(url) {
  if (!url) return null;
  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Map a headcount number to GoWarm's employee band enum.
 *
 * @param {number|null} n
 * @returns {string|null}
 */
function employeesToSize(n) {
  if (n == null || isNaN(n)) return null;
  const num = parseInt(n, 10);
  if (num < 10)    return '1-10';
  if (num < 50)    return '11-50';
  if (num < 200)   return '51-200';
  if (num < 1000)  return '201-1000';
  return '1000+';
}

/**
 * Normalise a stage key from the CRM via the org's configured stage_map.
 * Returns null if unmapped (orchestrator will handle gracefully).
 *
 * @param {string}      stageCrmKey  - Raw CRM stage label
 * @param {Object}      stageMap     - settings.stage_map  { 'CRM Label': 'gowarm_key' }
 * @returns {string|null}
 */
function resolveStage(stageCrmKey, stageMap = {}) {
  if (!stageCrmKey) return null;
  return stageMap[stageCrmKey] || null;
}

/**
 * Build an external_refs JSONB payload for a CRM record.
 * Designed to be merged (||) into existing external_refs, not overwrite.
 *
 * @param {string} crmType    - 'salesforce' | 'hubspot' | 'pipedrive'
 * @param {string} crmId      - CRM native record ID
 * @param {string} objectType - 'Account' | 'Contact' | 'Opportunity' etc.
 * @param {string|null} lastModified
 * @returns {Object}
 */
function buildExternalRefs(crmType, crmId, objectType, lastModified = null) {
  return {
    [crmType]: {
      id:            crmId,
      object_type:   objectType,
      synced_at:     new Date().toISOString(),
      last_modified: lastModified || null,
    },
  };
}

/**
 * Map a CRM billing/product type string to GoWarm's enum values.
 *
 * @param {string|null} crmType
 * @returns {{ productType: 'one_time'|'recurring', billingFrequency: string|null }}
 */
function normalizeProductType(crmType) {
  if (!crmType) return { productType: 'one_time', billingFrequency: null };
  const lower = crmType.toLowerCase();

  if (lower.includes('recurring') || lower.includes('subscription') || lower.includes('annual')
      || lower.includes('monthly') || lower.includes('saas')) {
    let billingFrequency = null;
    if (lower.includes('month')) billingFrequency = 'monthly';
    else if (lower.includes('quarter')) billingFrequency = 'quarterly';
    else if (lower.includes('annual') || lower.includes('year')) billingFrequency = 'annual';
    else if (lower.includes('multi')) billingFrequency = 'multi_year';
    return { productType: 'recurring', billingFrequency };
  }

  return { productType: 'one_time', billingFrequency: null };
}

/**
 * Map a CRM hierarchy role title to GoWarm's hierarchy_role enum.
 * Falls back to 'rep'.
 *
 * @param {string|null} roleTitle
 * @returns {'rep'|'manager'|'director'|'vp'|'cro'}
 */
function normalizeHierarchyRole(roleTitle) {
  if (!roleTitle) return 'rep';
  const lower = roleTitle.toLowerCase();
  if (lower.includes('cro') || lower.includes('chief revenue')) return 'cro';
  if (lower.includes('vp') || lower.includes('vice president'))   return 'vp';
  if (lower.includes('director'))                                  return 'director';
  if (lower.includes('manager') || lower.includes('mgr'))         return 'manager';
  return 'rep';
}

module.exports = {
  // Transform utilities for adapters
  extractDomain,
  employeesToSize,
  resolveStage,
  buildExternalRefs,
  normalizeProductType,
  normalizeHierarchyRole,
};
