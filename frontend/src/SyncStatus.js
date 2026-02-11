import React, { useState, useEffect, useCallback } from 'react';
import './SyncStatus.css';
import { syncAPI } from './apiService';

function SyncStatus({ userId }) {
  const [syncHistory, setSyncHistory] = useState([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const data = await syncAPI.getStatus(userId);
      setSyncHistory(data.data);
    } catch (error) {
      console.error('Error fetching sync status:', error);
    }
  }, [userId]);

  useEffect(() => {
    fetchSyncStatus();
  }, [fetchSyncStatus]);

  const handleManualSync = async () => {
    try {
      setIsSyncing(true);
      const result = await syncAPI.triggerSync(userId);
      alert(`Found ${result.data.emailsFound} new emails`);
      await fetchSyncStatus();
    } catch (error) {
      alert('Sync failed');
      console.error('Error:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  const lastSync = syncHistory[0];
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="sync-status">
      <div className="sync-header">
        <h4>Email Sync</h4>
        <button
          onClick={handleManualSync}
          disabled={isSyncing}
          className="btn btn-small"
        >
          {isSyncing ? '⏳ Syncing...' : '🔄 Sync Now'}
        </button>
      </div>

      {lastSync && (
        <div className="last-sync">
          <div className={`sync-status-badge ${lastSync.status}`}>
            {lastSync.status === 'success' ? '✓' : '✗'}
          </div>
          <div className="sync-details">
            <p className="sync-time">
              Last synced: {formatDate(lastSync.created_at)}
            </p>
            <p className="sync-items">
              {lastSync.items_processed} items processed
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default SyncStatus;
