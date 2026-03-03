import React, { useState, useEffect, useCallback } from 'react';
import './CalendarSyncStatus.css';

/**
 * CalendarSyncStatus.js (REPLACEMENT)
 *
 * DROP-IN LOCATION: frontend/src/CalendarSyncStatus.js
 *
 * Key changes from original:
 *   - Detects which calendar providers are connected (Outlook and/or Google)
 *   - Shows provider-aware sync button(s)
 *   - Passes 'provider' in sync request body
 *   - Error messages reference the correct provider
 *   - Supports syncing both providers if both are connected
 */

function CalendarSyncStatus({ userId }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [connectedProviders, setConnectedProviders] = useState([]);
  const [syncingProvider, setSyncingProvider] = useState(null);

  const detectConnectedProviders = useCallback(async () => {
    const providers = [];
    const apiBase = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

    try {
      // Check Outlook
      const outlookRes = await fetch(`${apiBase}/outlook/status?userId=${userId}`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (outlookRes.ok) {
        const data = await outlookRes.json();
        if (data.connected) providers.push({ id: 'outlook', label: 'Outlook', icon: '📧' });
      }
    } catch (e) { /* Outlook status endpoint may not exist */ }

    try {
      // Check Google
      const googleRes = await fetch(`${apiBase}/google/status?userId=${userId}`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (googleRes.ok) {
        const data = await googleRes.json();
        if (data.connected) providers.push({ id: 'google', label: 'Google', icon: '📅' });
      }
    } catch (e) { /* Google status endpoint may not exist */ }

    setConnectedProviders(providers);
  }, [userId]);

  useEffect(() => {
    if (userId) {
      fetchSyncStatus();
      detectConnectedProviders();
    }
  }, [userId, detectConnectedProviders]);

  const fetchSyncStatus = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/calendar/sync/status`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data.lastSyncs && result.data.lastSyncs.length > 0) {
          setLastSync(result.data.lastSyncs[0]);
        }
      }
    } catch (error) {
      console.error('Error fetching calendar sync status:', error);
    }
  };

  const handleSync = async (provider) => {
    const providerLabel = provider === 'google' ? 'Google Calendar' : 'Outlook Calendar';

    try {
      setSyncing(true);
      setSyncingProvider(provider);

      const token = localStorage.getItem('token');
      const response = await fetch(
        `${process.env.REACT_APP_API_URL || 'http://localhost:3001/api'}/calendar/sync`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            provider,
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
          })
        }
      );

      const result = await response.json();

      if (!result.success) {
        alert(`⚠️ ${result.message || providerLabel + ' sync failed'}`);
        return;
      }

      const data = result.data || {};
      const found = data.found || 0;
      const stored = data.stored || 0;
      const skipped = data.skipped || 0;
      const failed = data.failed || 0;

      let message = `✅ ${providerLabel} sync completed!\n\n`;
      message += `📅 Found: ${found} events\n`;
      message += `💾 Stored: ${stored}\n`;
      message += `⏭️ Skipped: ${skipped} (already synced)\n`;

      if (failed > 0) {
        message += `❌ Failed: ${failed}\n`;
      }

      alert(message);

      await fetchSyncStatus();

      if (window.location.reload) {
        window.location.reload();
      }

    } catch (error) {
      console.error('Error:', error);

      if (error.message.includes('not connected') || error.message.includes('No tokens found')) {
        alert(`⚠️ ${providerLabel} not connected. Please connect your ${provider === 'google' ? 'Google' : 'Outlook'} account first.`);
      } else {
        alert(`❌ Sync failed: ${error.message}`);
      }
    } finally {
      setSyncing(false);
      setSyncingProvider(null);
    }
  };

  const handleSyncAll = async () => {
    for (const provider of connectedProviders) {
      await handleSync(provider.id);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';

    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });
    } catch (error) {
      return 'Unknown';
    }
  };

  // No providers connected
  if (connectedProviders.length === 0) {
    return (
      <div className="calendar-sync-status">
        <span className="sync-info" style={{ fontSize: '0.85em', opacity: 0.7 }}>
          No calendar connected
        </span>
      </div>
    );
  }

  // Single provider — show simple button (like original)
  if (connectedProviders.length === 1) {
    const provider = connectedProviders[0];
    return (
      <div className="calendar-sync-status">
        <button
          onClick={() => handleSync(provider.id)}
          disabled={syncing}
          className="btn btn-small btn-primary"
          title={`Sync ${provider.label} Calendar events`}
        >
          {syncing ? '⟳ Syncing...' : `🔄 Sync ${provider.label} Calendar`}
        </button>

        {lastSync && (
          <div className="sync-info">
            <span className="sync-label">Last sync:</span>
            <span className="sync-time">{formatDate(lastSync.created_at)}</span>
            {lastSync.items_processed !== undefined && (
              <span className="sync-count">
                ({lastSync.items_processed} events)
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // Multiple providers — show sync all + individual options
  return (
    <div className="calendar-sync-status">
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button
          onClick={handleSyncAll}
          disabled={syncing}
          className="btn btn-small btn-primary"
          title="Sync all connected calendars"
        >
          {syncing ? '⟳ Syncing...' : '🔄 Sync Calendars'}
        </button>

        {connectedProviders.map(p => (
          <button
            key={p.id}
            onClick={() => handleSync(p.id)}
            disabled={syncing}
            className="btn btn-small"
            title={`Sync ${p.label} Calendar only`}
            style={{ fontSize: '0.85em', padding: '4px 8px' }}
          >
            {syncingProvider === p.id ? '⟳' : p.icon}
          </button>
        ))}
      </div>

      {lastSync && (
        <div className="sync-info">
          <span className="sync-label">Last sync:</span>
          <span className="sync-time">{formatDate(lastSync.created_at)}</span>
          {lastSync.items_processed !== undefined && (
            <span className="sync-count">
              ({lastSync.items_processed} events)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default CalendarSyncStatus;
