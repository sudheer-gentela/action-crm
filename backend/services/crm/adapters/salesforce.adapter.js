/**
 * crm/adapters/salesforce.adapter.js
 *
 * DROP-IN LOCATION: backend/services/crm/adapters/salesforce.adapter.js
 *
 * Salesforce-specific CRM adapter.
 * Implements the GoWarm CRM adapter interface using the Salesforce REST API.
 *
 * Responsibilities:
 *   - All SF API calls (SOQL, object describe, record CRUD)
 *   - Translate SF field names and values → NormalizedShape
 *   - SF-specific concerns: compound address fields, picklist values,
 *     OpportunityContactRoles, OpportunityLineItems, UserRole hierarchy
 *
 * Does NOT:
 *   - Write to the GoWarm DB (orchestrator's job)
 *   - Know about GoWarm IDs (orchestrator resolves those)
 *   - Handle OAuth (salesforce.auth.js handles that)
 *
 * Sync record limits per run:
 *   1500 records per object per run (cursor-based incremental)
 *   This keeps each sync run under 60s and SF API calls manageable.
 *   For initial full loads on large orgs, the cursor advances each run
 *   until all records are consumed.
 */

const { createClient }  = require('../../salesforce.client');
const {
  extractDomain,
  employeesToSize,
  normalizeProductType,
  normalizeHierarchyRole,
  buildExternalRefs,
} = require('../mapper');

const CRM_TYPE = 'salesforce';
const MAX_RECORDS = 1500;

class SalesforceAdapter {
  /**
   * @param {number} orgId
   */
  constructor(orgId) {
    this.orgId  = orgId;
    this.client = null; // initialised in init()
  }

  async init() {
    this.client = await createClient(this.orgId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ACCOUNTS  (SF Account → NormalizedAccount)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch Accounts modified since cursor.
   * @param {string|null} cursor  ISO datetime
   * @returns {{ records: NormalizedAccount[], nextCursor: string|null }}
   */
  async getAccounts(cursor = null) {
    const fields = [
      'Id', 'Name', 'Website', 'Industry', 'NumberOfEmployees',
      'BillingCity', 'BillingState', 'BillingCountry',
      'Description', 'OwnerId', 'Owner.Email', 'LastModifiedDate',
    ];

    const soql    = this._buildIncrementalQuery('Account', fields, cursor);
    const result  = await this.client.query(soql);
    const records = result.records.map(r => this._normalizeAccount(r));

    return {
      records,
      nextCursor: result.records.length > 0
        ? result.records[result.records.length - 1].LastModifiedDate
        : null,
    };
  }

  _normalizeAccount(r) {
    return {
      crmId:        r.Id,
      name:         r.Name || 'Unknown Account',
      domain:       extractDomain(r.Website),
      industry:     r.Industry || null,
      size:         employeesToSize(r.NumberOfEmployees),
      location:     _buildLocation(r, 'Billing'),
      description:  r.Description || null,
      ownerEmail:   r.Owner?.Email || null,
      lastModified: r.LastModifiedDate,
      externalRefs: buildExternalRefs(CRM_TYPE, r.Id, 'Account', r.LastModifiedDate),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONTACTS  (SF Contact → NormalizedContact)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {string|null} cursor
   * @returns {{ records: NormalizedContact[], nextCursor: string|null }}
   */
  async getContacts(cursor = null) {
    const fields = [
      'Id', 'AccountId', 'FirstName', 'LastName', 'Email', 'Phone',
      'Title', 'MailingCity', 'MailingState', 'MailingCountry',
      // Common custom fields — adapter tries to fetch, ignores if missing
      'LinkedIn_URL__c', 'LinkedInUrl__c',
      'ReportsToId',
      'OwnerId', 'Owner.Email',
      'LastModifiedDate',
    ];

    const soql   = this._buildIncrementalQuery('Contact', fields, cursor);
    const result = await this.client.query(soql);
    const records = result.records.map(r => this._normalizeContact(r));

    return {
      records,
      nextCursor: result.records.length > 0
        ? result.records[result.records.length - 1].LastModifiedDate
        : null,
    };
  }

  _normalizeContact(r) {
    return {
      crmId:                 r.Id,
      accountCrmId:          r.AccountId || null,
      firstName:             r.FirstName || 'Unknown',
      lastName:              r.LastName  || 'Unknown',
      email:                 r.Email?.toLowerCase().trim() || null,
      phone:                 r.Phone || null,
      title:                 r.Title || null,
      location:              _buildLocation(r, 'Mailing'),
      linkedinUrl:           r.LinkedIn_URL__c || r.LinkedInUrl__c || null,
      reportsToContactCrmId: r.ReportsToId || null,
      ownerEmail:            r.Owner?.Email || null,
      lastModified:          r.LastModifiedDate,
      externalRefs:          buildExternalRefs(CRM_TYPE, r.Id, 'Contact', r.LastModifiedDate),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEALS  (SF Opportunity → NormalizedDeal)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {string|null} cursor
   * @returns {{ records: NormalizedDeal[], nextCursor: string|null }}
   */
  async getDeals(cursor = null) {
    const fields = [
      'Id', 'Name', 'AccountId', 'StageName', 'Amount', 'CloseDate',
      'Probability', 'Description', 'OwnerId', 'Owner.Email',
      'LastModifiedDate',
    ];

    const soql   = this._buildIncrementalQuery('Opportunity', fields, cursor);
    const result = await this.client.query(soql);
    const records = result.records.map(r => this._normalizeDeal(r));

    return {
      records,
      nextCursor: result.records.length > 0
        ? result.records[result.records.length - 1].LastModifiedDate
        : null,
    };
  }

  _normalizeDeal(r) {
    return {
      crmId:             r.Id,
      accountCrmId:      r.AccountId || null,
      ownerEmail:        r.Owner?.Email || null,
      name:              r.Name || 'Unnamed Deal',
      value:             parseFloat(r.Amount) || 0,
      stageCrmKey:       r.StageName || null,
      expectedCloseDate: r.CloseDate || null,
      probability:       r.Probability != null ? Math.round(parseFloat(r.Probability)) : 50,
      notes:             r.Description || null,
      lastModified:      r.LastModifiedDate,
      externalRefs:      buildExternalRefs(CRM_TYPE, r.Id, 'Opportunity', r.LastModifiedDate),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEADS  (SF Lead → NormalizedProspect)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {string|null} cursor
   * @returns {{ records: NormalizedProspect[], nextCursor: string|null }}
   */
  async getLeads(cursor = null) {
    const fields = [
      'Id', 'FirstName', 'LastName', 'Email', 'Phone', 'Title',
      'Company', 'Website', 'Industry', 'NumberOfEmployees',
      'City', 'State', 'Country',
      'LinkedIn_URL__c', 'LinkedInUrl__c',
      'LeadSource', 'Rating',
      'OwnerId', 'Owner.Email',
      'IsConverted',
      'ConvertedContactId', 'ConvertedAccountId', 'ConvertedOpportunityId',
      'LastModifiedDate',
    ];

    const soql   = this._buildIncrementalQuery('Lead', fields, cursor);
    const result = await this.client.query(soql);
    const records = result.records.map(r => this._normalizeLead(r));

    return {
      records,
      nextCursor: result.records.length > 0
        ? result.records[result.records.length - 1].LastModifiedDate
        : null,
    };
  }

  _normalizeLead(r) {
    return {
      crmId:              r.Id,
      firstName:          r.FirstName || 'Unknown',
      lastName:           r.LastName  || 'Unknown',
      email:              r.Email?.toLowerCase().trim() || null,
      phone:              r.Phone || null,
      title:              r.Title || null,
      location:           _buildLeadLocation(r),
      linkedinUrl:        r.LinkedIn_URL__c || r.LinkedInUrl__c || null,
      companyName:        r.Company || 'Unknown',
      companyDomain:      extractDomain(r.Website),
      companySize:        employeesToSize(r.NumberOfEmployees),
      companyIndustry:    r.Industry || null,
      source:             r.LeadSource || null,
      icpScore:           _ratingToScore(r.Rating),
      ownerEmail:         r.Owner?.Email || null,
      isConverted:        r.IsConverted === true,
      convertedContactId: r.ConvertedContactId || null,
      convertedAccountId: r.ConvertedAccountId || null,
      convertedDealId:    r.ConvertedOpportunityId || null,
      lastModified:       r.LastModifiedDate,
      externalRefs:       buildExternalRefs(CRM_TYPE, r.Id, 'Lead', r.LastModifiedDate),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL CONTACTS  (SF OpportunityContactRole)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all Contact→Deal relationships for a given Opportunity.
   * SF stores these in OpportunityContactRole — requires a separate query.
   *
   * @param {string} dealCrmId  - SF Opportunity Id
   * @returns {NormalizedDealContact[]}
   */
  async getDealContacts(dealCrmId) {
    const soql = `
      SELECT Id, ContactId, Role, IsPrimary
      FROM OpportunityContactRole
      WHERE OpportunityId = '${dealCrmId}'
    `;

    try {
      const result = await this.client.query(soql);
      return result.records.map(r => ({
        dealCrmId:   dealCrmId,
        contactCrmId: r.ContactId,
        role:         r.Role || null,
        isPrimary:    r.IsPrimary === true,
      }));
    } catch (err) {
      // OpportunityContactRole might not be enabled on the SF org
      console.warn(`  ⚠️  [SF] getDealContacts for ${dealCrmId}: ${err.message} — skipping`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEAL PRODUCTS  (SF OpportunityLineItem)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all product line items for a given Opportunity.
   * Returns empty array if Products are not enabled on this SF org.
   *
   * @param {string} dealCrmId  - SF Opportunity Id
   * @returns {NormalizedLineItem[]}
   */
  async getDealProducts(dealCrmId) {
    const soql = `
      SELECT Id, Name, Quantity, UnitPrice, TotalPrice,
             Discount, ProductCode,
             PricebookEntry.Product2.Name,
             PricebookEntry.Product2.Description,
             PricebookEntry.Product2.ProductCode,
             PricebookEntry.Product2.Family,
             ServiceDate, Description
      FROM OpportunityLineItem
      WHERE OpportunityId = '${dealCrmId}'
    `;

    try {
      const result = await this.client.query(soql);
      return result.records.map(r => this._normalizeLineItem(r));
    } catch (err) {
      // Products might not be enabled on this SF org
      console.warn(`  ⚠️  [SF] getDealProducts for ${dealCrmId}: ${err.message} — skipping`);
      return [];
    }
  }

  _normalizeLineItem(r) {
    const product   = r.PricebookEntry?.Product2;
    const name      = product?.Name || r.Name || 'Unknown Product';
    const sku       = product?.ProductCode || r.ProductCode || null;
    const family    = product?.Family || null;
    const unitPrice = parseFloat(r.UnitPrice) || 0;
    const discount  = parseFloat(r.Discount) || 0;

    // SF Family field often maps to our product_type distinction
    const { productType, billingFrequency } = normalizeProductType(family);

    return {
      crmId:            r.Id,
      name,
      sku,
      quantity:         parseFloat(r.Quantity) || 1,
      unitPrice,
      discountPct:      discount,
      productType,
      billingFrequency,
      contractTerm:     null,   // SF doesn't have a standard contract_term field
      effectiveDate:    r.ServiceDate || null,
      renewalDate:      null,
      categoryName:     family || null,
      description:      product?.Description || r.Description || null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // USERS + HIERARCHY  (SF User + UserRole)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch all active SF Users with their role and manager chain.
   * Used to populate org_hierarchy and team_memberships.
   *
   * @returns {NormalizedUser[]}
   */
  async getUsers() {
    // Fetch active Users with their UserRole
    const soql = `
      SELECT Id, Email, Name, IsActive,
             UserRole.Id, UserRole.Name, UserRole.ParentRoleId,
             ManagerId, Manager.Email,
             Title, Department
      FROM User
      WHERE IsActive = true
        AND UserType = 'Standard'
      LIMIT 500
    `;

    try {
      const result = await this.client.query(soql);
      return result.records.map(r => ({
        crmId:         r.Id,
        email:         r.Email?.toLowerCase().trim() || null,
        name:          r.Name || null,
        managerEmail:  r.Manager?.Email?.toLowerCase().trim() || null,
        hierarchyRole: normalizeHierarchyRole(r.UserRole?.Name || r.Title || ''),
        teamName:      r.Department || r.UserRole?.Name || null,
        roleName:      r.UserRole?.Name || r.Title || null,
        isActive:      r.IsActive === true,
      }));
    } catch (err) {
      console.warn(`  ⚠️  [SF] getUsers: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch the SF UserRole hierarchy tree.
   * Used to understand team groupings (e.g. "West Region > AE Team").
   *
   * @returns {{ crmId, name, parentCrmId }[]}
   */
  async getRoleHierarchy() {
    const soql = `
      SELECT Id, Name, ParentRoleId, DeveloperName
      FROM UserRole
      ORDER BY Name ASC
    `;

    try {
      const result = await this.client.query(soql);
      return result.records.map(r => ({
        crmId:       r.Id,
        name:        r.Name,
        parentCrmId: r.ParentRoleId || null,
      }));
    } catch (err) {
      console.warn(`  ⚠️  [SF] getRoleHierarchy: ${err.message}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STAGE PICKLIST  (for stage mapping UI)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Return the list of Opportunity stage values from this SF org.
   * Used in Settings → Integration → Stage Mapping UI so the admin
   * can see all SF stages and map each to a GoWarm pipeline_stage.
   *
   * @returns {{ value: string, label: string, isWon: boolean, isClosed: boolean }[]}
   */
  async getOpportunityStages() {
    try {
      const result = await this.client.describeObject('Opportunity');
      const stageField = result.find(f => f.name === 'StageName');
      if (!stageField?.picklistValues) return [];
      return stageField.picklistValues
        .filter(v => v.active)
        .map(v => ({
          value:    v.value,
          label:    v.label || v.value,
          isWon:    false,   // SF doesn't expose this via describe directly
          isClosed: false,
        }));
    } catch (err) {
      console.warn(`  ⚠️  [SF] getOpportunityStages: ${err.message}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SOQL BUILDER (internal)
  // ─────────────────────────────────────────────────────────────────────────

  _buildIncrementalQuery(sfObject, fields, cursor) {
    // De-duplicate fields and always include Id + LastModifiedDate
    const fieldSet  = new Set(['Id', 'LastModifiedDate', ...fields]);
    const fieldList = [...fieldSet].join(', ');
    const where     = cursor
      ? `WHERE LastModifiedDate >= ${cursor} AND IsDeleted = false`
      : `WHERE IsDeleted = false`;
    return `SELECT ${fieldList} FROM ${sfObject} ${where} ORDER BY LastModifiedDate ASC LIMIT ${MAX_RECORDS}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _buildLocation(rec, prefix) {
  const parts = [
    rec[`${prefix}City`],
    rec[`${prefix}State`],
    rec[`${prefix}Country`],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function _buildLeadLocation(rec) {
  const parts = [rec.City, rec.State, rec.Country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function _ratingToScore(rating) {
  const map = { Hot: 90, Warm: 65, Cold: 30 };
  return map[rating] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an initialised SalesforceAdapter for an org.
 * Always use this factory — it handles token init.
 *
 * @param {number} orgId
 * @returns {SalesforceAdapter}
 */
async function createSalesforceAdapter(orgId) {
  const adapter = new SalesforceAdapter(orgId);
  await adapter.init();
  return adapter;
}

module.exports = { SalesforceAdapter, createSalesforceAdapter };
