/**
 * StorageProviderFactory.js
 * Resolves the correct storage provider per request.
 * Only file that imports concrete provider implementations.
 */

const OneDriveProvider = require('./OneDriveProvider');
// const GoogleDriveProvider = require('./GoogleDriveProvider'); // uncomment when ready

// Explicit metadata array — id/displayName never depend on base class property assignment
const REGISTERED_PROVIDERS = [
  { id: 'onedrive', displayName: 'OneDrive', instance: new OneDriveProvider() },
  // { id: 'googledrive', displayName: 'Google Drive', instance: new GoogleDriveProvider() },
];

function getProvider(providerId) {
  const entry = REGISTERED_PROVIDERS.find((p) => p.id === providerId);
  if (!entry) {
    const available = REGISTERED_PROVIDERS.map((p) => p.id).join(', ');
    throw new Error(`Unknown storage provider "${providerId}". Available: ${available}`);
  }
  return entry.instance;
}

function listProviders() {
  return REGISTERED_PROVIDERS.map(({ id, displayName }) => ({ id, displayName }));
}

async function checkAllConnections(userId) {
  const results = await Promise.allSettled(
    REGISTERED_PROVIDERS.map(async ({ id, displayName, instance }) => {
      const status = await instance.checkConnection(userId);
      return { id, displayName, ...status };
    })
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          id: REGISTERED_PROVIDERS[i].id,
          displayName: REGISTERED_PROVIDERS[i].displayName,
          connected: false,
          message: r.reason && r.reason.message,
        }
  );
}

module.exports = { getProvider, listProviders, checkAllConnections };
