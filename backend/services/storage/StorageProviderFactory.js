/**
 * StorageProviderFactory.js
 *
 * Resolves the correct storage provider instance for a given request.
 *
 * This is the ONLY file that imports concrete provider implementations.
 * Everything else (routes, processor, frontend API calls) is provider-agnostic.
 *
 * ADDING A NEW PROVIDER (e.g. Dropbox):
 *   1. Build DropboxProvider extending StorageProviderBase
 *   2. Add 'dropbox' to REGISTERED_PROVIDERS below
 *   3. Done.
 */

const OneDriveProvider  = require('./OneDriveProvider');
// Uncomment when Google auth is implemented:
// const GoogleDriveProvider = require('./GoogleDriveProvider');

/**
 * All registered provider instances (singletons — providers are stateless).
 * Key = providerId string used in API requests and DB records.
 */
const REGISTERED_PROVIDERS = {
  onedrive:    new OneDriveProvider(),
  // googledrive: new GoogleDriveProvider(),   // ← uncomment to activate
};

/**
 * Get a provider instance by ID.
 * Throws a clear error for unrecognised providers.
 *
 * @param {string} providerId - e.g. 'onedrive' | 'googledrive'
 * @returns {StorageProviderBase}
 */
function getProvider(providerId) {
  const provider = REGISTERED_PROVIDERS[providerId];
  if (!provider) {
    const available = Object.keys(REGISTERED_PROVIDERS).join(', ');
    throw new Error(
      `Unknown storage provider "${providerId}". Available providers: ${available}`
    );
  }
  return provider;
}

/**
 * Get all registered provider IDs and display names.
 * Used by the frontend to render the provider switcher.
 *
 * @returns {Array<{ id: string, displayName: string }>}
 */
function listProviders() {
  return Object.values(REGISTERED_PROVIDERS).map((p) => ({
    id: p.providerId,
    displayName: p.displayName,
  }));
}

/**
 * Check connection status for all registered providers for a user.
 * Used by the Settings screen to show connected/disconnected state for each.
 *
 * @param {string} userId
 * @returns {Promise<Array<{ id, displayName, connected, requiresReauth?, reauthUrl?, message }>>}
 */
async function checkAllConnections(userId) {
  const results = await Promise.allSettled(
    Object.values(REGISTERED_PROVIDERS).map(async (provider) => {
      const status = await provider.checkConnection(userId);
      return { id: provider.providerId, displayName: provider.displayName, ...status };
    })
  );

  return results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { connected: false, message: r.reason?.message || 'Unknown error' }
  );
}

module.exports = { getProvider, listProviders, checkAllConnections };
