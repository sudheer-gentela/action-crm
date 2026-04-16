/**
 * salesforce.client.js
 *
 * DROP-IN LOCATION: backend/services/salesforce.client.js
 *
 * Salesforce REST API wrapper.
 * Handles:
 *   - Auto-token refresh via salesforce.auth.js
 *   - SOQL query execution with 1500-record cursor pagination
 *   - SF object describe (for field mapping UI)
 *   - Task creation for write-back (Phase 3)
 *   - API call counting per sync run (safety valve)
 *
 * All methods accept orgId — they resolve the token internally.
 */

const axios    = require('axios');
const sfAuth   = require('./salesforce.auth');

const SF_API_VERSION = 'v59.0';
const MAX_RECORDS_PER_QUERY = 1500;  // Hard limit — see architecture decision in plan
const MAX_API_CALLS_PER_RUN = 5000;  // Safety valve — SF orgs typically have 100k-1M/day

// ── SalesforceClient class ────────────────────────────────────────────────────

class SalesforceClient {
  constructor(orgId) {
    this.orgId        = orgId;
    this.accessToken  = null;
    this.instanceUrl  = null;
    this.apiCallCount = 0;
  }

  // ── Initialise (call once per sync run) ─────────────────────────────────────

  async init() {
    const { accessToken, instanceUrl } = await sfAuth.getValidToken(this.orgId);
    this.accessToken = accessToken;
    this.instanceUrl = instanceUrl;
    this.apiBaseUrl  = `${instanceUrl}/services/data/${SF_API_VERSION}`;
    this.apiCallCount = 0;
  }

  // ── Core HTTP helper ─────────────────────────────────────────────────────────

  async _request(method, path, data = null) {
    if (this.apiCallCount >= MAX_API_CALLS_PER_RUN) {
      throw new Error(`SF API call limit reached (${MAX_API_CALLS_PER_RUN}) for org ${this.orgId} this run`);
    }
    this.apiCallCount++;

    const url = path.startsWith('http') ? path : `${this.apiBaseUrl}${path}`;

    try {
      const res = await axios({
        method,
        url,
        data,
        headers: {
          Authorization:  `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      return res.data;
    } catch (err) {
      // Auto-refresh on 401 and retry once
      if (err.response?.status === 401) {
        console.log(`🔄 SF 401 — refreshing token for org ${this.orgId}`);
        const refreshed = await sfAuth.getValidToken(this.orgId);
        this.accessToken = refreshed.accessToken;

        const retryRes = await axios({
          method, url, data,
          headers: {
            Authorization:  `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        });
        return retryRes.data;
      }

      const sfErrors = err.response?.data;
      const msg = Array.isArray(sfErrors)
        ? sfErrors.map(e => `${e.errorCode}: ${e.message}`).join('; ')
        : err.message;
      throw new Error(`Salesforce API error on ${method} ${path}: ${msg}`);
    }
  }

  // ── SOQL query with cursor pagination ────────────────────────────────────────

  /**
   * Execute a SOQL query, returning up to MAX_RECORDS_PER_QUERY records.
   * Uses LastModifiedDate cursor so subsequent runs pick up where the last left off.
   *
   * @param {string} soql  - Full SOQL query (should include ORDER BY LastModifiedDate ASC)
   * @returns {{ records: object[], done: boolean, totalSize: number }}
   */
  async query(soql) {
    const encoded = encodeURIComponent(soql);
    const result  = await this._request('GET', `/query?q=${encoded}`);
    return {
      records:   result.records   || [],
      done:      result.done      ?? true,
      totalSize: result.totalSize ?? 0,
      nextRecordsUrl: result.nextRecordsUrl || null,
    };
  }

  /**
   * Build a standard incremental SOQL query for a given SF object.
   * Used by the sync service to fetch changed records since last cursor.
   *
   * @param {string}   sfObject   - 'Contact' | 'Account' | 'Opportunity' | 'Lead'
   * @param {string[]} fields     - SF field names to fetch
   * @param {string|null} cursor  - ISO datetime string (LastModifiedDate >= cursor)
   * @returns {string} SOQL query
   */
  buildIncrementalQuery(sfObject, fields, cursor) {
    const fieldList = ['Id', 'LastModifiedDate', ...fields].join(', ');
    const where     = cursor
      ? `WHERE LastModifiedDate >= ${cursor} AND IsDeleted = false`
      : `WHERE IsDeleted = false`;
    return `SELECT ${fieldList} FROM ${sfObject} ${where} ORDER BY LastModifiedDate ASC LIMIT ${MAX_RECORDS_PER_QUERY}`;
  }

  // ── Object describe (for field mapping UI) ────────────────────────────────────

  /**
   * Fetch all fields for a SF object.
   * Used by the field mapping UI so Org Admins can pick SF fields dynamically.
   *
   * @param {string} sfObject - 'Contact' | 'Account' | 'Opportunity' | 'Lead'
   * @returns {{ name, label, type, custom }[]}
   */
  async describeObject(sfObject) {
    const result = await this._request('GET', `/sobjects/${sfObject}/describe`);
    return (result.fields || []).map(f => ({
      name:   f.name,
      label:  f.label,
      type:   f.type,
      custom: f.custom || false,
    }));
  }

  // ── Record CRUD ──────────────────────────────────────────────────────────────

  /**
   * Create a SF Task (used by write-back in Phase 3).
   * Returns the new SF Task ID.
   */
  async createTask(taskData) {
    const result = await this._request('POST', '/sobjects/Task', taskData);
    return result.id;  // SF 18-char ID
  }

  /**
   * Update an existing SF record.
   * Used for write-back when the SF record already exists.
   */
  async updateRecord(sfObject, sfId, data) {
    // SF PATCH returns 204 No Content on success
    await this._request('PATCH', `/sobjects/${sfObject}/${sfId}`, data);
  }

  /**
   * Get a single SF record by ID.
   * Used for Lead conversion detection.
   */
  async getRecord(sfObject, sfId, fields = ['Id', 'LastModifiedDate']) {
    const fieldList = fields.join(',');
    return this._request('GET', `/sobjects/${sfObject}/${sfId}?fields=${fieldList}`);
  }

  // ── Custom object / field provisioning ───────────────────────────────────────

  /**
   * Ensure the GoWarm_Source__c custom field exists on SF Task.
   * Called once on org connect — idempotent, safe to re-run.
   *
   * GoWarm_Source__c is a Text(20) field used as an echo-loop prevention flag.
   * Write-back sets it to 'GoWarm'; inbound sync skips Tasks where it's set.
   *
   * Uses the SF Tooling API (available on all SF orgs without managed package).
   * Falls back silently if the org doesn't allow metadata writes (sandboxes are fine;
   * some read-only Connected App permission sets may block this — non-fatal).
   *
   * @returns {{ created: boolean, alreadyExists: boolean }}
   */
  async ensureCustomObjects() {
    try {
      // Check if GoWarm_Source__c already exists on Task
      const existing = await this._request(
        'GET',
        `/tooling/query?q=${encodeURIComponent(
          "SELECT Id FROM CustomField WHERE TableEnumOrId = 'Task' AND DeveloperName = 'GoWarm_Source'"
        )}`
      );

      if (existing.records && existing.records.length > 0) {
        console.log(`  ✓ [SF Setup] GoWarm_Source__c already exists on Task`);
        return { created: false, alreadyExists: true };
      }

      // Field doesn't exist — create it via Tooling API
      // First we need the Task CustomObject Id
      const taskMeta = await this._request(
        'GET',
        `/tooling/query?q=${encodeURIComponent(
          "SELECT Id FROM CustomObject WHERE DeveloperName = 'Task'"
        )}`
      );

      // Task is a standard object — use TableEnumOrId directly
      await this._request('POST', '/tooling/sobjects/CustomField', {
        FullName:    'Task.GoWarm_Source__c',
        Metadata: {
          type:      'Text',
          length:    20,
          label:     'GoWarm Source',
          fullName:  'GoWarm_Source__c',
          trackHistory: false,
          required:  false,
          defaultValue: null,
          description: 'Set to "GoWarm" by write-back sync to prevent echo loops',
        },
      });

      // Deploy the field (Tooling API requires a metadata deployment for standard objects)
      console.log(`  ✓ [SF Setup] Created GoWarm_Source__c on Task`);
      return { created: true, alreadyExists: false };

    } catch (err) {
      // Non-fatal — write-back will still work, just without echo-loop prevention
      // until the field is manually created or permissions are updated
      console.warn(`  ⚠️  [SF Setup] Could not ensure GoWarm_Source__c: ${err.message}`);
      console.warn(`  ⚠️  [SF Setup] Write-back will work but echo-loop prevention may be incomplete`);
      return { created: false, alreadyExists: false, error: err.message };
    }
  }

  // ── Limits check ─────────────────────────────────────────────────────────────

  /**
   * Check remaining SF API calls for this org's SF instance.
   * Returns { remaining, max } — log a warning if remaining < 10% of max.
   */
  async checkApiLimits() {
    const result = await this._request('GET', '/limits');
    const daily  = result.DailyApiRequests;
    if (!daily) return null;
    return { remaining: daily.Remaining, max: daily.Max };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create and initialise a SalesforceClient for an org.
 * Always call this rather than constructing directly — it handles token init.
 */
async function createClient(orgId) {
  const client = new SalesforceClient(orgId);
  await client.init();
  return client;
}

module.exports = { SalesforceClient, createClient };
