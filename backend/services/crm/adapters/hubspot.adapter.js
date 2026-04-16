/**
 * crm/adapters/hubspot.adapter.js
 *
 * DROP-IN LOCATION: backend/services/crm/adapters/hubspot.adapter.js
 *
 * HubSpot CRM adapter — implements the same interface as salesforce.adapter.js.
 * The orchestrator calls these methods identically regardless of CRM type.
 *
 * HubSpot API v3 mapping:
 *   Companies  → NormalizedAccount   (GET /crm/v3/objects/companies)
 *   Contacts   → NormalizedContact   (GET /crm/v3/objects/contacts)
 *   Deals      → NormalizedDeal      (GET /crm/v3/objects/deals)
 *   Contacts (lifecycle=lead/subscriber/other) → NormalizedProspect
 *   Associations API → NormalizedDealContact
 *   Pipelines  → stage picklist      (GET /crm/v3/pipelines/deals)
 *   Owners     → NormalizedUser      (GET /crm/v3/owners)
 *
 * Cursor strategy:
 *   HubSpot uses `after` (page token) pagination, not timestamp cursors.
 *   We store the last `after` token in sync_cursors.{objectType}.
 *   On initial sync: no cursor = fetch from beginning.
 *   On incremental: pass stored after token.
 *   HubSpot also supports lastmodifieddate filter — we use both for efficiency.
 *
 * Key differences from Salesforce:
 *   - No SOQL — properties listed explicitly in query params
 *   - Associations are separate API calls (not sub-selects)
 *   - lifecycle_stage determines contact vs prospect split
 *   - No native org hierarchy — getUsers/getRoleHierarchy return what's available
 *   - Products (line items) available via /crm/v3/objects/line_items
 */

const axios    = require('axios');
const {
  extractDomain,
  employeesToSize,
  normalizeProductType,
  normalizeHierarchyRole,
  buildExternalRefs,
} = require('../mapper');
const { getCustomFieldMappings } = require('../customFieldSync');

const CRM_TYPE   = 'hubspot';
const HS_API     = 'https://api.hubapi.com';
const MAX_RECORDS = 100; // HubSpot max per page is 100

// Lifecycle stages that map to GoWarm "contact" (vs "prospect")
const CONTACT_LIFECYCLE_STAGES = new Set([
  'customer', 'evangelist', 'opportunity', 'salesqualifiedlead',
]);

// ─────────────────────────────────────────────────────────────────────────────

class HubSpotAdapter {
  constructor(orgId) {
    this.orgId       = orgId;
    this.accessToken = null;
    this.fieldMap    = [];
    this._customFields = {};
  }

  async init() {
    const { getValidToken } = require('../../hubspot.auth');
    const { pool }          = require('../../../config/database');

    const { accessToken } = await getValidToken(this.orgId);
    this.accessToken = accessToken;

    const intRes = await pool.query(
      `SELECT settings FROM org_integrations WHERE org_id = $1 AND integration_type = 'hubspot'`,
      [this.orgId]
    );
    this.fieldMap = intRes.rows[0]?.settings?.field_map || [];

    // Pre-compute custom field lookups (same pattern as SF adapter)
    this._customFields = {
      Company: _buildCustomLookup(getCustomFieldMappings(this.fieldMap, 'Company',  'account')),
      Contact: _buildCustomLookup(getCustomFieldMappings(this.fieldMap, 'Contact',  'contact')),
      Deal:    _buildCustomLookup(getCustomFieldMappings(this.fieldMap, 'Deal',     'deal')),
      Lead:    _buildCustomLookup(getCustomFieldMappings(this.fieldMap, 'Lead',     'prospect')),
    };
  }

  // ── Core HTTP helper ──────────────────────────────────────────────────────

  async _get(path, params = {}) {
    try {
      const res = await axios.get(`${HS_API}${path}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        params,
      });
      return res.data;
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      throw new Error(`HubSpot GET ${path}: ${detail}`);
    }
  }

  // ── ACCOUNTS (HubSpot Company → NormalizedAccount) ────────────────────────

  async getAccounts(cursor = null) {
    const baseProps = [
      'name', 'domain', 'industry', 'numberofemployees',
      'city', 'state', 'country', 'description', 'hubspot_owner_id',
      'hs_lastmodifieddate',
    ];

    const customProps = this.fieldMap
      .filter(m => m.sf_object === 'Company' && m.direction !== 'gw_to_sf')
      .map(m => m.sf_field);

    const properties = [...new Set([...baseProps, ...customProps])];

    const params = {
      limit:      MAX_RECORDS,
      properties: properties.join(','),
      ...(cursor ? { after: cursor } : {}),
    };

    // Use search endpoint with lastmodifieddate filter for incremental syncs
    const data = await this._get('/crm/v3/objects/companies', params);

    const ownerIds = [...new Set(
      data.results.map(r => r.properties.hubspot_owner_id).filter(Boolean)
    )];
    const ownerMap = ownerIds.length > 0
      ? await this._resolveOwnerEmails(ownerIds)
      : new Map();

    const records = data.results.map(r =>
      this._normalizeCompany(r, ownerMap)
    );

    return {
      records,
      nextCursor: data.paging?.next?.after || null,
    };
  }

  _normalizeCompany(r, ownerMap) {
    const p = r.properties;
    const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;

    return {
      crmId:        r.id,
      name:         p.name || 'Unknown Company',
      domain:       extractDomain(p.domain),
      industry:     this._resolveField(p, 'Company', 'account.industry') || p.industry || null,
      size:         employeesToSize(
                      this._resolveField(p, 'Company', 'account.size') || p.numberofemployees
                    ),
      location,
      description:  this._resolveField(p, 'Company', 'account.description') || p.description || null,
      ownerEmail:   ownerMap.get(p.hubspot_owner_id) || null,
      lastModified: p.hs_lastmodifieddate,
      externalRefs: buildExternalRefs(CRM_TYPE, r.id, 'Company', p.hs_lastmodifieddate),
      customFieldValues: _collectCustomValues(p, this._customFields.Company),
    };
  }

  // ── CONTACTS (HubSpot Contact → NormalizedContact) ────────────────────────

  async getContacts(cursor = null) {
    const baseProps = [
      'firstname', 'lastname', 'email', 'phone', 'jobtitle',
      'city', 'state', 'country', 'linkedin_bio',
      'associatedcompanyid', 'hubspot_owner_id',
      'hs_lead_status', 'lifecyclestage',
      'hs_lastmodifieddate',
    ];

    const customProps = this.fieldMap
      .filter(m => m.sf_object === 'Contact' && m.direction !== 'gw_to_sf')
      .map(m => m.sf_field);

    const properties = [...new Set([...baseProps, ...customProps])];

    const params = {
      limit:      MAX_RECORDS,
      properties: properties.join(','),
      ...(cursor ? { after: cursor } : {}),
    };

    const data = await this._get('/crm/v3/objects/contacts', params);

    const ownerIds = [...new Set(
      data.results.map(r => r.properties.hubspot_owner_id).filter(Boolean)
    )];
    const ownerMap = ownerIds.length > 0
      ? await this._resolveOwnerEmails(ownerIds)
      : new Map();

    // Split into contacts (customer/opportunity/SQL) vs prospects (lead/subscriber/etc.)
    // Both go through this method — orchestrator routes based on lifecycle stage
    // We filter to CONTACT_LIFECYCLE_STAGES here; leads handled by getLeads()
    const records = data.results
      .filter(r => CONTACT_LIFECYCLE_STAGES.has(r.properties.lifecyclestage?.toLowerCase()))
      .map(r => this._normalizeContact(r, ownerMap));

    return {
      records,
      nextCursor: data.paging?.next?.after || null,
    };
  }

  _normalizeContact(r, ownerMap) {
    const p = r.properties;
    const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;

    return {
      crmId:                 r.id,
      accountCrmId:          p.associatedcompanyid || null,
      firstName:             p.firstname || 'Unknown',
      lastName:              p.lastname  || 'Unknown',
      email:                 p.email?.toLowerCase().trim() || null,
      phone:                 p.phone || null,
      title:                 this._resolveField(p, 'Contact', 'contact.title') || p.jobtitle || null,
      location,
      linkedinUrl:           this._resolveField(p, 'Contact', 'contact.linkedin_url') || p.linkedin_bio || null,
      reportsToContactCrmId: null, // HubSpot has no native reports-to
      ownerEmail:            ownerMap.get(p.hubspot_owner_id) || null,
      lastModified:          p.hs_lastmodifieddate,
      externalRefs:          buildExternalRefs(CRM_TYPE, r.id, 'Contact', p.hs_lastmodifieddate),
      customFieldValues:     _collectCustomValues(p, this._customFields.Contact),
    };
  }

  // ── DEALS (HubSpot Deal → NormalizedDeal) ─────────────────────────────────

  async getDeals(cursor = null) {
    const properties = [
      'dealname', 'amount', 'dealstage', 'closedate', 'hs_deal_stage_probability',
      'description', 'hubspot_owner_id', 'associatedcompanyid',
      'hs_lastmodifieddate',
    ];

    const params = {
      limit:      MAX_RECORDS,
      properties: properties.join(','),
      associations: 'companies',
      ...(cursor ? { after: cursor } : {}),
    };

    const data = await this._get('/crm/v3/objects/deals', params);

    const ownerIds = [...new Set(
      data.results.map(r => r.properties.hubspot_owner_id).filter(Boolean)
    )];
    const ownerMap = ownerIds.length > 0
      ? await this._resolveOwnerEmails(ownerIds)
      : new Map();

    const records = data.results.map(r => this._normalizeDeal(r, ownerMap));

    return {
      records,
      nextCursor: data.paging?.next?.after || null,
    };
  }

  _normalizeDeal(r, ownerMap) {
    const p = r.properties;

    // Company association: HubSpot returns associations as array
    const companyCrmId =
      r.associations?.companies?.results?.[0]?.id ||
      p.associatedcompanyid ||
      null;

    return {
      crmId:             r.id,
      accountCrmId:      companyCrmId,
      ownerEmail:        ownerMap.get(p.hubspot_owner_id) || null,
      name:              p.dealname || 'Unnamed Deal',
      value:             parseFloat(p.amount) || 0,
      stageCrmKey:       p.dealstage || null,
      expectedCloseDate: p.closedate || null,
      probability:       p.hs_deal_stage_probability != null
                           ? Math.round(parseFloat(p.hs_deal_stage_probability) * 100)
                           : 50,
      notes:             p.description || null,
      lastModified:      p.hs_lastmodifieddate,
      externalRefs:      buildExternalRefs(CRM_TYPE, r.id, 'Deal', p.hs_lastmodifieddate),
      customFieldValues: _collectCustomValues(p, this._customFields.Deal),
    };
  }

  // ── LEADS (HubSpot Contact with non-customer lifecycle → NormalizedProspect) ─

  async getLeads(cursor = null) {
    const baseProps = [
      'firstname', 'lastname', 'email', 'phone', 'jobtitle',
      'city', 'state', 'country', 'linkedin_bio',
      'company', 'website', 'industry', 'numberofemployees',
      'hs_lead_status', 'lifecyclestage', 'leadsource',
      'hubspot_owner_id', 'associatedcompanyid',
      'hs_lastmodifieddate',
    ];

    const customProps = this.fieldMap
      .filter(m => m.sf_object === 'Lead' && m.direction !== 'gw_to_sf')
      .map(m => m.sf_field);

    const properties = [...new Set([...baseProps, ...customProps])];

    const params = {
      limit:      MAX_RECORDS,
      properties: properties.join(','),
      ...(cursor ? { after: cursor } : {}),
    };

    const data = await this._get('/crm/v3/objects/contacts', params);

    const ownerIds = [...new Set(
      data.results.map(r => r.properties.hubspot_owner_id).filter(Boolean)
    )];
    const ownerMap = ownerIds.length > 0
      ? await this._resolveOwnerEmails(ownerIds)
      : new Map();

    // Filter to non-customer lifecycle stages (leads/prospects)
    const records = data.results
      .filter(r => !CONTACT_LIFECYCLE_STAGES.has(r.properties.lifecyclestage?.toLowerCase()))
      .map(r => this._normalizeLead(r, ownerMap));

    return {
      records,
      nextCursor: data.paging?.next?.after || null,
    };
  }

  _normalizeLead(r, ownerMap) {
    const p = r.properties;
    const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;

    return {
      crmId:              r.id,
      firstName:          p.firstname || 'Unknown',
      lastName:           p.lastname  || 'Unknown',
      email:              p.email?.toLowerCase().trim() || null,
      phone:              p.phone || null,
      title:              this._resolveField(p, 'Lead', 'prospect.title') || p.jobtitle || null,
      location,
      linkedinUrl:        this._resolveField(p, 'Lead', 'prospect.linkedin_url') || p.linkedin_bio || null,
      companyName:        p.company || 'Unknown',
      companyDomain:      extractDomain(p.website),
      companySize:        employeesToSize(p.numberofemployees),
      companyIndustry:    p.industry || null,
      source:             p.leadsource || null,
      icpScore:           _leadStatusToScore(p.hs_lead_status),
      ownerEmail:         ownerMap.get(p.hubspot_owner_id) || null,
      isConverted:        false, // HubSpot doesn't have Lead conversion — contacts stay as contacts
      convertedContactId: null,
      convertedAccountId: null,
      convertedDealId:    null,
      lastModified:       p.hs_lastmodifieddate,
      externalRefs:       buildExternalRefs(CRM_TYPE, r.id, 'Lead', p.hs_lastmodifieddate),
      customFieldValues:  _collectCustomValues(p, this._customFields.Lead),
    };
  }

  // ── DEAL CONTACTS (HubSpot Associations API) ──────────────────────────────

  async getDealContacts(dealCrmId) {
    try {
      const data = await this._get(
        `/crm/v3/objects/deals/${dealCrmId}/associations/contacts`
      );

      return (data.results || []).map((assoc, idx) => ({
        dealCrmId,
        contactCrmId: assoc.id,
        role:         null,      // HubSpot association labels not enabled by default
        isPrimary:    idx === 0, // First association treated as primary
      }));
    } catch (err) {
      console.warn(`  ⚠️  [HS] getDealContacts for ${dealCrmId}: ${err.message} — skipping`);
      return [];
    }
  }

  // ── DEAL PRODUCTS (HubSpot Line Items) ───────────────────────────────────

  async getDealProducts(dealCrmId) {
    try {
      // Get line item IDs associated with this deal
      const assocData = await this._get(
        `/crm/v3/objects/deals/${dealCrmId}/associations/line_items`
      );

      const lineItemIds = (assocData.results || []).map(a => a.id);
      if (lineItemIds.length === 0) return [];

      // Batch-fetch line item details
      const batchRes = await axios.post(
        `${HS_API}/crm/v3/objects/line_items/batch/read`,
        {
          inputs:     lineItemIds.map(id => ({ id })),
          properties: ['name', 'quantity', 'price', 'discount', 'hs_product_id',
                       'recurringbillingfrequency', 'hs_recurring_billing_period'],
        },
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );

      return (batchRes.data.results || []).map(item =>
        this._normalizeLineItem(item)
      );
    } catch (err) {
      console.warn(`  ⚠️  [HS] getDealProducts for ${dealCrmId}: ${err.message} — skipping`);
      return [];
    }
  }

  _normalizeLineItem(item) {
    const p = item.properties;
    const billingFreq = _normalizeBillingFrequency(p.recurringbillingfrequency);
    const { productType } = normalizeProductType(billingFreq || p.recurringbillingfrequency || '');

    return {
      crmId:            item.id,
      name:             p.name || 'Unknown Product',
      sku:              p.hs_product_id || null,
      quantity:         parseFloat(p.quantity) || 1,
      unitPrice:        parseFloat(p.price) || 0,
      discountPct:      parseFloat(p.discount) || 0,
      productType,
      billingFrequency: billingFreq,
      contractTerm:     _billingPeriodToMonths(p.hs_recurring_billing_period),
      effectiveDate:    null,
      renewalDate:      null,
      categoryName:     null,
      description:      null,
    };
  }

  // ── USERS (HubSpot Owners → NormalizedUser) ───────────────────────────────

  async getUsers() {
    try {
      const data = await this._get('/crm/v3/owners', { limit: 500 });

      return (data.results || []).map(owner => ({
        crmId:         String(owner.id),
        email:         owner.email?.toLowerCase().trim() || null,
        name:          [owner.firstName, owner.lastName].filter(Boolean).join(' ') || null,
        managerEmail:  null,       // HubSpot Owners have no manager relationship
        hierarchyRole: 'rep',      // No role data available without Sales Hub Enterprise
        teamName:      owner.teams?.[0]?.name || null,
        roleName:      null,
        isActive:      !owner.archived,
      }));
    } catch (err) {
      console.warn(`  ⚠️  [HS] getUsers: ${err.message}`);
      return [];
    }
  }

  // ── ROLE HIERARCHY ────────────────────────────────────────────────────────

  /**
   * HubSpot has no native role hierarchy outside Sales Hub Enterprise.
   * Return empty — the orchestrator handles this gracefully.
   */
  async getRoleHierarchy() {
    return [];
  }

  // ── STAGE PICKLIST ────────────────────────────────────────────────────────

  /**
   * Return Deal pipeline stage values for the default pipeline.
   * Used by the Stage Mapping tab (same UI as Salesforce).
   */
  async getOpportunityStages() {
    try {
      const data = await this._get('/crm/v3/pipelines/deals');
      const pipeline = data.results?.[0]; // Default pipeline
      if (!pipeline?.stages) return [];

      return pipeline.stages.map(s => ({
        value:    s.id,
        label:    s.label,
        isWon:    s.metadata?.isClosed === 'true' && s.metadata?.probability === '1.0',
        isClosed: s.metadata?.isClosed === 'true',
      }));
    } catch (err) {
      console.warn(`  ⚠️  [HS] getOpportunityStages: ${err.message}`);
      return [];
    }
  }

  // ── OWNER RESOLUTION ──────────────────────────────────────────────────────

  /**
   * Batch-resolve HubSpot owner IDs to email addresses.
   * Returns Map<ownerId, email>.
   */
  async _resolveOwnerEmails(ownerIds) {
    const map = new Map();
    try {
      // HubSpot owners endpoint — fetch all and index by id
      const data = await this._get('/crm/v3/owners', { limit: 500 });
      for (const owner of (data.results || [])) {
        if (owner.email) map.set(String(owner.id), owner.email.toLowerCase().trim());
      }
    } catch (err) {
      console.warn(`  ⚠️  [HS] _resolveOwnerEmails: ${err.message}`);
    }
    return map;
  }

  // ── FIELD MAP RESOLVER ────────────────────────────────────────────────────

  /**
   * Look up a field value from HubSpot properties using field_map config.
   * Same stripping logic as SF adapter — handles 'entity.field' prefixes.
   */
  _resolveField(props, hsObject, gwField) {
    const bareField = gwField.includes('.')
      ? gwField.split('.').slice(1).join('.')
      : gwField;

    const mapping = this.fieldMap.find(
      m => m.sf_object === hsObject && (
        m.gw_field === bareField ||
        m.gw_field === gwField
      )
    );
    if (!mapping) return null;
    return props[mapping.sf_field] ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map HubSpot hs_lead_status to a GoWarm icp_score number.
 */
function _leadStatusToScore(status) {
  const map = {
    'new':            60,
    'open':           50,
    'in_progress':    70,
    'open_deal':      80,
    'unqualified':    20,
    'attempted_to_contact': 40,
    'connected':      65,
    'bad_timing':     30,
  };
  return map[status?.toLowerCase()] ?? null;
}

/**
 * Normalise HubSpot recurring billing frequency string to GoWarm enum.
 */
function _normalizeBillingFrequency(hsFreq) {
  if (!hsFreq) return null;
  const lower = hsFreq.toLowerCase();
  if (lower.includes('month'))   return 'monthly';
  if (lower.includes('quarter')) return 'quarterly';
  if (lower.includes('annual') || lower.includes('year')) return 'annual';
  return null;
}

/**
 * Convert HubSpot hs_recurring_billing_period (e.g. 'P12M') to months integer.
 */
function _billingPeriodToMonths(period) {
  if (!period) return null;
  const match = period.match(/P(\d+)M/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Build a Map<sfField, gwField> lookup for fast custom value collection.
 * Identical to SF adapter helper — shared pattern.
 */
function _buildCustomLookup(customMappings) {
  const map = new Map();
  for (const m of customMappings) map.set(m.sf_field, m.gw_field);
  return map;
}

/**
 * Collect custom field values from a HubSpot properties object.
 * Identical to SF adapter helper — shared pattern.
 */
function _collectCustomValues(props, customLookup) {
  if (!customLookup || customLookup.size === 0) return {};
  const result = {};
  for (const [hsField, gwField] of customLookup) {
    if (Object.prototype.hasOwnProperty.call(props, hsField)) {
      result[gwField] = props[hsField] ?? null;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an initialised HubSpotAdapter for an org.
 * Always use this factory.
 *
 * @param {number} orgId
 * @returns {HubSpotAdapter}
 */
async function createHubSpotAdapter(orgId) {
  const adapter = new HubSpotAdapter(orgId);
  await adapter.init();
  return adapter;
}

module.exports = { HubSpotAdapter, createHubSpotAdapter };
