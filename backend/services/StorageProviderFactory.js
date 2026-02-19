/**
 * StorageProviderFactory.js
 * Resolves the correct storage provider per request.
 * Only file that imports concrete provider implementations.
 */

const OneDriveProvider = require('./OneDriveProvider');
// const GoogleDriveProvider = require('./GoogleDriveProvider'); // uncomment when ready

const REGISTERED_PROVIDERS = {
  onedrive: new OneDriveProvider(),
  // googledrive: new GoogleDriveProvider(),
};

function getProvider(providerId) {
  const provider = REGISTERED_PROVIDERS[providerId];
  if (!provider) {
    const available = Object.keys(REGISTERED_PROVIDERS).join(', ');
    throw new Error(`Unknown storage provider "${providerId}". Available: ${available}`);
  }
  return provider;
}

function listProviders() {
  return Object.values(REGISTERED_PROVIDERS).map((p) => ({
    id: p.providerId,
    displayName: p.displayName,
  }));
}

async function checkAllConnections(userId) {
  const providers = Object.values(REGISTERED_PROVIDERS);
  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const status = await provider.checkConnection(userId);
      return { id: provider.providerId, displayName: provider.displayName, ...status };
    })
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          id: providers[i].providerId,
          displayName: providers[i].displayName,
          connected: false,
          message: r.reason && r.reason.message,
        }
  );
}

module.exports = { getProvider, listProviders, checkAllConnections };
