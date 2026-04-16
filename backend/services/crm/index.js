/**
 * crm/index.js
 *
 * DROP-IN LOCATION: backend/services/crm/index.js
 *
 * Public entry point for all CRM sync operations.
 * Import this instead of the old salesforce.sync.service.js.
 *
 * Usage:
 *   const crmSync = require('./crm');
 *   await crmSync.runSyncForOrg(orgId, 'salesforce');
 *   const orgIds = await crmSync.getConnectedOrgs('salesforce');
 *
 * Adding a new CRM adapter (e.g. HubSpot):
 *   1. Create backend/services/crm/adapters/hubspot.adapter.js
 *      implementing the same interface as salesforce.adapter.js
 *   2. Add 'hubspot' case to _createAdapter() below
 *   3. No other changes needed — orchestrator handles the rest
 */

const { runSyncForOrg: _runSyncForOrg, getConnectedOrgs } = require('./orchestrator');
const { createSalesforceAdapter } = require('./adapters/salesforce.adapter');
const { createHubSpotAdapter }    = require('./adapters/hubspot.adapter');

/**
 * Adapter factory — returns an initialised adapter for a given CRM type.
 *
 * @param {number} orgId
 * @param {string} crmType  - 'salesforce' | 'hubspot'
 * @returns {object}  Initialised adapter instance
 */
async function _createAdapter(orgId, crmType) {
  switch (crmType) {
    case 'salesforce':
      return createSalesforceAdapter(orgId);

    case 'hubspot':
      return createHubSpotAdapter(orgId);

    default:
      throw new Error(`Unknown CRM type: ${crmType}. Supported: salesforce, hubspot`);
  }
}

/**
 * Run a full sync for one org.
 * Creates the appropriate adapter, then runs the orchestrator.
 *
 * @param {number} orgId
 * @param {string} [crmType='salesforce']
 * @returns {{ results: object, errors: string[] }}
 */
async function runSyncForOrg(orgId, crmType = 'salesforce') {
  const adapter = await _createAdapter(orgId, crmType);
  return _runSyncForOrg(orgId, crmType, adapter);
}

module.exports = {
  runSyncForOrg,
  getConnectedOrgs,
};
